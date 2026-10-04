# Assigned Issue Resolutions

Analysis of the four issues currently assigned to this contributor, with root causes
confirmed against the source at commit `5d80503` (`main`).

| Issue | Subject | Area | Fix |
| --- | --- | --- | --- |
| [#69](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/69) | `propose()` validates description length against an empty string | `src/governance.rs` | Specified below — not yet implemented |
| [#62](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/62) | `assess_arbitrage_risk` discards `volatility_adjustment` | `src/risk_engine.rs` | Specified below — not yet implemented |
| [#83](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/83) | `calculateBoostMultiplier` caps below its own base | `sdk/src/governance.ts` | [PR #206](https://github.com/Kevin737866/stellar-liquidity-yield-engine/pull/206) |
| [#82](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/82) | Contract addresses default to placeholder strings | `sdk/src/governance.ts` | [PR #207](https://github.com/Kevin737866/stellar-liquidity-yield-engine/pull/207) |

#69 and #62 are contract bugs with no open implementation. Both are specified here
precisely enough to apply, including the two defects that block verifying either fix.

---

## #69 — `propose()` validates description length against an empty string

### Reported

`ProtocolGovernor::propose` builds `String::from_str(&e, "")` and checks the length of
that, so the 280-character limit is never enforced against the real `description`.

### Confirmed

`src/governance.rs:658-662`:

```rust
// Validate description length
let desc_str = String::from_str(&e, "");
if desc_str.len() > MAX_PROPOSAL_DESCRIPTION_LENGTH as u32 {
    return Err("Proposal description too long");
}
```

`String::from_str(&e, "")` allocates a fresh empty `String` and `desc_str.len()` is
always `0`. The comparison is `0 > 280`, which is never true, so the guard cannot
reject anything. `description` is moved straight into `GovernanceProposal::new` at
`src/governance.rs:671` without ever being inspected.

`String::from_str` appears exactly once in `src/`, so this line is the only place a
description is length-checked, and it is the only reason `MAX_PROPOSAL_DESCRIPTION_LENGTH`
(`src/governance.rs:30`) is referenced at all. The constant is otherwise dead.

### Fix

`description` is already a `soroban_sdk::String`, so it carries its own length. The
whole block collapses to the parameter:

```rust
// Validate description length
if description.len() > MAX_PROPOSAL_DESCRIPTION_LENGTH {
    return Err("Proposal description too long");
}
```

Two details worth being deliberate about:

- **Drop the `as u32`.** `MAX_PROPOSAL_DESCRIPTION_LENGTH` is already declared `u32`
  (`src/governance.rs:30`), so the cast was only ever there to paper over the fact that
  the left side was a throwaway variable.
- **This is a byte length, not a character count.** `soroban_sdk::String::len()` is
  `env().string_len()`, which returns the length of the UTF-8 buffer. A 280-byte limit
  admits 280 ASCII characters but only 140 two-byte characters, so a description
  written in an accented or non-Latin script is rejected at roughly half the
  advertised length.

  That is almost certainly not what a 280-character proposal limit is meant to
  express. The honest options are to accept byte semantics and say so in a comment,
  or to count characters properly. A true character count is not cheap on-chain —
  there is no host function for it, so it means iterating the buffer, which costs
  inside a governance entrypoint. Recommendation: apply the one-line fix, document
  byte semantics on `MAX_PROPOSAL_DESCRIPTION_LENGTH`, and treat a genuine character
  limit as a separate change with its own gas measurement. Do not paper over it with
  `> MAX * 4`, which would admit 1120 bytes and over-enforce by 4x for ASCII.

### Blocking defect: `propose()` cannot succeed today

The description check is unreachable, because the function returns one line earlier.
`src/governance.rs:650-656`:

```rust
// Verify proposer has enough tokens
let voter = VotingEscrow::new(&e, &Address::random(&e)); // Would be passed in
let voting_power = voter.get_voting_power(proposer.clone());

if voting_power < BigInt::from_u32(&e, PROPOSAL_THRESHOLD) {
    return Err("Insufficient voting power to propose");
}
```

`VotingEscrow` is a client type, so `VotingEscrow::new(&e, addr)` binds it to a
contract at `addr`. That address is `Address::random(&e)` — a fresh pseudo-random
address, carrying the in-source admission "Would be passed in". It is not the
deployed escrow, so the storage keys `get_voting_power` reads
(`src/governance.rs:1146-1148`, `key_locked_amount` / `key_lock_start` /
`key_lock_end`) belong to a contract with no state. The call returns `0`.

`PROPOSAL_THRESHOLD` is `100_000_000` (`src/governance.rs:29`), and `0 < 100_000_000`
is true, so **every** call to `propose()` returns `Err("Insufficient voting power to
propose")`. No proposal has ever been created through this entrypoint, by anyone.

This has two consequences for #69:

1. **The fix is unobservable on its own.** A test asserting that a 300-character
   description is rejected will fail on the threshold check, not the length check,
   and the failure message will point at the wrong thing. Verifying #69 requires
   fixing this first, or driving the length check through a test that bypasses the
   threshold.
2. **It is the more serious of the two defects.** #69 is a validation that does not
   validate. This is a governance entrypoint that rejects 100% of proposals, so
   proposals cannot be created, queued, or executed through the contract at all. It
   deserves its own issue rather than being folded into #69.

There is no test directory in this repository (`tests/` does not exist), so nothing
currently exercises `propose()` and nothing would have caught this.

The real fix is to thread an actual escrow address into the governor — a constructor
parameter or an admin-settable key, the same way `init` already stores `timelock` and
`admin` at `src/governance.rs:631-632` — and drop the `Address::random` placeholder.
Until that lands, the threshold check cannot be trusted to mean anything.

### Test plan

`tests/governance_proposal_tests.rs`, which does not exist yet:

- description of exactly 280 bytes is accepted; 281 is rejected with
  `"Proposal description too long"`.
- a multi-byte description is measured in bytes, pinned deliberately so the choice is
  visible if it is ever revisited.
- an empty description is accepted, if that is intended — the current guard does not
  forbid it and neither should the fix.
- the threshold check is exercised against a real escrow address, otherwise these tests
  are testing the wrong line.

### Verification

```
cargo test -p stellar-yield-engine --test governance_proposal_tests
```

Not run: this is a documentation-only change, and the repository has no test
infrastructure to run against (see above).

---

## #62 — `assess_arbitrage_risk` discards `volatility_adjustment`

### Reported

`RiskEngine::assess_arbitrage_risk` computes `volatility_adjustment` but the returned
`RiskAssessment` never includes it, so position-sizing advice is calculated and
thrown away.

### Confirmed

`src/risk_engine.rs:158-176`:

```rust
let il_risk = Self::calculate_impermanent_loss(&env, current_price_ratio, entry_price_ratio);
let slippage = Self::estimate_slippage(&env, pool_id.clone(), amount, pool_liquidity);
let volatility_adjustment = Self::volatility_adjustment(&env, volatility_metrics);   // computed
let circuit_breaker = Self::circuit_breaker_check(&env, pool_id.clone(), gas_price_surge, pool_imbalance, recent_losses);

let combined_risk = ((il_risk as u64 + slippage as u64) / 2) as u32;
let volatility_score = ((volatility_metrics.volatility_24h as u64 + volatility_metrics.volatility_7d as u64) / 2 / 50) as u32;
let final_score = ((combined_risk as u64 + volatility_score as u64) / 2).min(100) as u32;

RiskAssessment {
    pool_id,
    impermanent_loss_risk: il_risk,
    estimated_slippage: slippage,
    volatility_score: final_score,
    circuit_breaker_triggered: circuit_breaker,
    timestamp: env.ledger().timestamp(),
}
```

`volatility_adjustment` is bound at line 160 and never read again. Rust does not warn
on an unused function result that is bound to a named local, so this compiles clean
and survives CI.

`volatility_score` is *not* derived from it. Line 165 recomputes volatility directly
from `volatility_metrics`, so the adjustment has no path into the returned struct even
indirectly. `RiskAssessment` (`src/risk_engine.rs:9-16`) has no field that could carry
it.

### What the value actually means

`volatility_adjustment` (`src/risk_engine.rs:95-110`) returns a **position-size
multiplier in basis points**, not a risk score:

```rust
let adjustment = 10000 - (volatility_average.min(5000) as u32);
```

Zero volatility yields `10000` (full size); the `min(5000)` floor means 50% volatility
or worse yields `5000` (half size) and no less. That is a size advice, and it is the
reason it does not belong folded into the 0-100 `volatility_score` — the two have
opposite polarity, since a *smaller* multiplier is the *safer* outcome while a
*larger* risk score is the *less* safe one. Dividing the score by the multiplier, or
averaging them, would invert the meaning of one of the two.

So the issue's first option, "return the adjustment", is the right one.

### Fix

Add the field and populate it:

```rust
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskAssessment {
    pub pool_id: Address,
    pub impermanent_loss_risk: u32,       // Basis points
    pub estimated_slippage: u32,           // Basis points
    pub volatility_score: u32,             // 0-100
    pub position_size_multiplier_bps: u32, // 5000-10000; 10000 = full size
    pub circuit_breaker_triggered: bool,
    pub timestamp: u64,
}
```

```rust
RiskAssessment {
    pool_id,
    impermanent_loss_risk: il_risk,
    estimated_slippage: slippage,
    volatility_score: final_score,
    position_size_multiplier_bps: volatility_adjustment,
    circuit_breaker_triggered: circuit_breaker,
    timestamp: env.ledger().timestamp(),
}
```

Notes on the change:

- **`RiskAssessment` has exactly one construction site**, `src/risk_engine.rs:168`, so
  this is the only line that needs to change in the crate. `grep` confirms no other
  `RiskAssessment` literal exists in `src/`.
- **Adding a field changes the SCALE encoding of the type.** Anything that decodes a
  `RiskAssessment` returned by a previously deployed build will fail to decode against
  a new one. There is no contract ID in the repository, so this is pre-deployment and
  the change is safe to make now — but it stops being free the moment a build is
  deployed, which is the argument for landing it before deployment rather than after.
- **`sdk/src/types.ts:220` declares a separate `RiskAssessment` interface** used by
  `sdk/src/rebalancer.ts:606`. It is not generated from the Rust type, so it will not
  fail to compile when this lands — it will silently omit the new field. Update it in
  the same change or the SDK keeps reporting a different risk surface than the
  contract does.
- **`volatility_adjustment` takes an `env: Env` it never uses** (`src/risk_engine.rs:96`).
  Rust does not warn on unused function parameters, so this is invisible. Drop the
  parameter and update the call site, or the next reader will assume it reads ledger
  state.
- **The doc comment contradicts the code.** `src/risk_engine.rs:105` says
  `10000 * (1 - volatility_avg/50000)`, which at 5000 bp gives `9000`. The code gives
  `5000`, matching the sentence on the next line ("If volatility is 50% (5000 bp),
  reduce position to 50%"). The code is right and the comment is wrong; correct the
  comment to `10000 - min(avg_bp, 5000)` so the next reader does not "fix" the working
  formula to match the broken comment.

### Two different quantities share the name `volatility_score`

Within this one function, `volatility_score` means two different things:

| Name | Line | Range | Meaning |
| --- | --- | --- | --- |
| `volatility_score` (local) | 165 | unbounded | raw mean of 24h/7d volatility, `/ 50` |
| `volatility_score` (field) | 172 | 0-100 | `final_score`, the blend with IL and slippage |

The local can exceed 100 on its own — 20000 bp mean volatility gives `400` — and is
only bounded because `.min(100)` is applied to `final_score` at line 166, not to the
local. The field's `// 0-100` comment is currently accurate, but only as a consequence
of a clamp that is attached to a different value. Renaming the local to
`raw_volatility_score` makes the guarantee local to the thing that provides it.

### Test plan

`tests/risk_engine_property_tests.rs` is listed in the #62-adjacent change set on
[#206](https://github.com/Kevin737866/stellar-liquidity-yield-engine/pull/206)'s branch
but does not exist on `main`; add to it or create `tests/risk_engine_tests.rs`.

- the returned `position_size_multiplier_bps` equals a direct
  `volatility_adjustment(volatility_metrics)` call, for zero, mid, and extreme
  volatility.
- the multiplier is monotonic non-increasing in `volatility_24h` and in `volatility_7d`.
- the multiplier never leaves `[5000, 10000]`, including for volatility values far
  above the 5000 bp clamp.
- `volatility_score` stays within `0..=100` for volatility inputs well past 100%.
- the multiplier is not folded into `volatility_score`: holding `volatility_24h` and
  `volatility_7d` fixed while varying IL risk and slippage moves the score but leaves
  the multiplier untouched, and vice versa.

### Verification

```
cargo test -p stellar-yield-engine --test risk_engine_tests
```

Not run: documentation-only change, and `tests/` does not exist on `main`.

---

## #83 — `calculateBoostMultiplier` capped below its own base

Fixed in [PR #206](https://github.com/Kevin737866/stellar-liquidity-yield-engine/pull/206).

`calculateBoostMultiplier` built `10000 + (durationFactor * 1500 / 10000)` and then
returned `Math.min(boost, 2500)`. The base is `10000`, the cap was `2500`, so `Math.min`
selected the cap for every input and the function was the constant `2500` regardless of
lock duration — voting-escrow boost carried no signal.

The fix derives the cap from the constant that already documents the intended ceiling,
`GOVERNANCE_CONSTANTS.MAX_BOOST_MULTIPLIER` (2.5x, `sdk/src/governance.ts:1084`),
giving `25000`, and names the base `BOOST_BASE_BPS = 10_000`.

### The invariant worth keeping

> A cap applied to a boost expressed against a 1.0x base must sit at or above that
> base. If `cap <= base` the result is constant and the function is dead.

Deriving the cap from `MAX_BOOST_MULTIPLIER` rather than inlining `25000` is what makes
the invariant structural — a future edit to the weighting can no longer silently push
the base above the cap. The bare literal `10000` was also replaced with a named
constant for the same reason.

Note for reviewers: the formula's own ceiling is `11500` (1.15x) at exactly
`maxDuration`, so the `25000` cap only binds for lock durations beyond `maxDuration`.
Making a maximum lock earn the full 2.5x would mean widening the `1500` weighting,
which changes the reward curve rather than fixing a bug. Left out of the bug fix
deliberately; worth a follow-up if 2.5x-at-maximum is the intent.

---

## #82 — Contract addresses defaulted to placeholder strings

Fixed in [PR #207](https://github.com/Kevin737866/stellar-liquidity-yield-engine/pull/207).

`sdk/src/governance.ts` fell back to `'GOV_TOKEN_CONTRACT_ADDRESS'`,
`'VE_TOKEN_CONTRACT_ADDRESS'`, `'STAKING_CONTRACT_ADDRESS'` and
`'FEE_DISTRIBUTOR_ADDRESS'` when the matching environment variable was unset. None is a
deployable Stellar ID, so every call built against a default fails during signature
verification.

Three properties made that worse than a prompt crash:

1. **Late.** It failed inside `simulateCall` / `buildTransaction`, after a keypair check
   and a network round trip, rather than at configuration time.
2. **Opaque.** The error named neither the missing variable nor the fact that the value
   was never configured, so it read as a contract bug.
3. **Silent at the type level.** `Contract` accepts any `string`, so a placeholder
   type-checked and the defect existed only on-chain.

The fix replaces the four module-level constants with a `GOVERNANCE_CONTRACTS` table
that drives resolution, validation and error messages together, resolves addresses per
instance (constructor argument, else environment variable), and routes all 35 call
sites through one `requireContractAddress(role)` accessor. Validation is
`/^[GC][A-Z2-7]{55}$/`, with whitespace trimmed.

Two distinct failure modes, because they are different mistakes:

- **configured but invalid** — rejected at construction, since a present-and-wrong
  value is always a typo and there is no reason to wait for the first call;
- **not configured** — reported by the call that needs it, naming the variable, so a
  client that only reads governance state is not forced to configure the staking and
  fee-distributor IDs.

### The invariant worth keeping

> A configuration default must be a value that works, or it must not exist. A
> placeholder that is guaranteed to fail is worse than an absent default, because it
> converts a startup misconfiguration into a runtime cryptographic failure that names
> neither the cause nor the fix.

Making addresses per-instance rather than module-level constants additionally means a
client constructed before the environment is populated no longer captures stale values.
