# Router randomized regression tests

Run from the repository root using the same dependency resolution as Rust CI:

```sh
cargo generate-lockfile
cargo update -p ed25519-dalek@3.0.0 --precise 2.2.0
cargo test --test swap_router_fuzz
```

The pin is needed only if resolution selects ed25519-dalek 3.0.0; the existing
Soroban host requires the 2.x API. No fuzzing dependencies were added.

The target includes `src/swap_router.rs` directly. That module is not in the
deployable library's feature set: this makes its real path and quote code
testable without exporting its unfinished execution entrypoints in a contract.
Rust CI runs this target alongside the existing library and upgrade tests.

## Reproduction and coverage

The deterministic xorshift generator uses four fixed seeds and 32 cases per
seed by default. Failure output reports the seed and case. To replay or run a
larger local corpus (POSIX shell syntax):

```sh
ROUTER_FUZZ_SEED=328 ROUTER_FUZZ_CASES=2048 cargo test --test swap_router_fuzz
```

This is bounded randomized property testing, not coverage-guided libFuzzer.
It exercises:

- Empty/disconnected pool sets, self-edges, cycles, parallel pools, direct,
  XLM and up-to-three-edge routes. An independent reachability oracle checks
  route availability for generated valid graphs.
- Path endpoints, no repeated tokens, one pool per edge, pool/token
  correspondence, and quote output recomputed from the exact selected pools.
- Both reserve orientations against an independent constant-product formula,
  integer rounding, directional price impact, fees, and slippage boundaries.
- Negative/zero/extreme signed amounts and reserves, invalid fees, and unrelated
  input tokens. Invalid or unrepresentable pool quotes return `None` rather
  than divide by zero or overflow.

## Findings and scope

The initial compile-repaired router failed all four new test functions:
division by zero, signed multiplication overflow, choosing an invalid-fee pool,
and constructing ten tokens for a three-pool path. Fixes validate quote inputs,
use checked arithmetic, skip unusable candidates, preserve the recursive path
once, and recompute quotes using their selected pool IDs. Direct quotes now use
the same depth-based candidate selection as routed direct paths. Reverse quotes
use the correctly oriented reserves for price impact.

Compiling this previously dormant module also required Soroban SDK API repairs
(vector environments, owned map keys, contract error conversion, borrows, and
the direct-path helper's mismatched types). Its four existing oracle-pause tests
now run inside a registered contract storage frame; they retain their pause and
authorization assertions.

Known limitations remain explicit:

- Constant-product intermediates must fit `i128`. Inputs beyond that range are
  rejected, even if their mathematical quotient would fit. Depth ranking assigns
  zero to reserve products beyond `i128`; arbitrary-precision routing is not
  implemented. Fee and minimum-output scaling do not overflow positive `i128`.
- Routing preserves the existing direct-first, then XLM, then depth-prioritized
  search policy. It does not promise the globally highest-output route.
- `get_quote` rejects invalid inputs or missing routes using the existing panic
  contract; `get_direct_quote` returns `None` for unusable input/pools. Zero-output
  candidates are not selected. General routed price impact is still a placeholder.
- Execution still contains simulated pool calls and token-only pool lookup;
  this PR does not make the router deployable, prove settlement correctness,
  or implement stable-swap pricing. Other dormant integration targets are not
  repaired by this test target.
