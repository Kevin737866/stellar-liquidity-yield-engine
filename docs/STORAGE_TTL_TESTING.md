# Storage TTL tests for repeated operations

Issue: [#521](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/521).

This document describes `tests/ttl_repeated_operations_tests.rs`, the contract
test target for TTL maintenance across a sequence of writes. It complements
`tests/upgrade_tests.rs`, which pins the single-entry expiration boundary, and
`docs/UPGRADING.md`, which covers the operator flow for code swaps.

## Why a separate target

Most state in this crate is instance data, so a single write followed by a TTL
check does not exercise the case that matters in production: a keeper or user
writing new persistent entries on every operation while a maintenance job
renews TTLs in between. `ILInsurance` is used as the fixture because every
`purchase_insurance` call writes a new policy under a `u64` key and updates
instance counters, giving the test two independent lifetimes to manage.

The test ledger uses explicit short TTLs so the assertions do not depend on
host defaults:

| Setting | Value |
| --- | --- |
| `min_persistent_entry_ttl` | 64 ledgers |
| `min_temp_entry_ttl` | 8 ledgers |
| `max_entry_ttl` | 1,000 ledgers |
| renewal threshold / floor | 100 / 200 ledgers |
| ledgers per simulated operation | 20 |

Six purchases advance the ledger by 120 ledgers, well past the first policy's
original 63-ledger lifetime. No configuration file or contract change is
needed; adjust the constants at the top of the test file when exercising a
different maintenance policy.

## Expected behavior

The target covers three cases:

1. **Normal.** After each purchase the test renews the instance and the new
   policy key. All policies remain readable at the end, the instance TTL stays
   above the threshold, and the reserve counter records every operation.
2. **Boundary.** Renewal is a floor: repeated passes while the entry is well
   above the threshold leave the TTL unchanged. Once the TTL drops below the
   threshold, one pass restores the floor and later passes do not stack
   additional ledgers on top of it.
3. **Failure.** With the instance kept alive but the policy key not renewed,
   every subsequent read of that policy fails after the key's lifetime ends,
   while an instance-only read still succeeds. This isolates the missing
   persistent-entry renewal as the cause. The test host cannot perform an
   on-chain restore of an archived key, so recovery is an operator action
   (`stellar contract restore`) rather than part of this target.

## Running the checks

Run from the repository root with the same dependency pin used by Rust CI:

```sh
cargo generate-lockfile
cargo update -p ed25519-dalek@3.0.0 --precise 2.2.0
cargo test --all-features --test ttl_repeated_operations_tests
cargo clippy --test ttl_repeated_operations_tests --all-features -- -D warnings
```

The target is wired into `.github/workflows/ci.yml` as its own job, so a TTL
regression is reported separately from the library and upgrade suites. A plain
`cargo test` also picks it up; the explicit `--test` invocation is useful when
investigating a single failure.

## Operator interpretation

A passing run means that, for the configured threshold and floor:

- instance renewal must accompany repeated writes, not just the first one;
- every persistent key written by an operation needs its own renewal — the
  contract instance's TTL does not cover persistent data;
- maintenance may run more often than needed, but it cannot extend a healthy
  entry past the floor;
- missing a renewal is visible as a failed read of that key, not as a failed
  read of the whole contract.

The tests do not add TTL entrypoints or change the deployed ABI. Renewal
remains an off-chain maintenance operation performed through the host/CLI.
