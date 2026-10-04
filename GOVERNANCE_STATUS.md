# Governance Module Status

**Status: not functional. Do not deploy or integrate against this module.**

`src/governance.rs` is an early sketch of a governance and protocol
fee-sharing system (a governance token, a staking contract, a fee
distributor, a governor, a voting-escrow lock, and an emergency multisig).
None of it works today, and the crate does not compile while this file is
included in the build.

## Why it doesn't compile

- **~44 `todo!()` storage-key functions.** Every `key_*` helper (e.g.
  `key_balance`, `key_stake_balance`, `key_proposal`, `key_locked_amount`) is
  an unimplemented stub. Calling any public function that touches storage
  panics immediately via `todo!()`.
- **APIs that don't exist in `soroban-sdk` 22** (the version pinned in
  `Cargo.toml`):
  - `BigInt` is not a type in this SDK version (Soroban uses `i128`/`I256`/
    `U256`).
  - `Env::current()` is not a thing — a contract only ever gets an `Env` via
    its function parameters.
  - `env.extension_state()` does not exist on `Env`.
  - Contract structs (e.g. `VotingEscrow::new(&e, &address)`,
    `StakingContract::new(&e, &staking)`) are being constructed directly and
    called as if they were client objects. Cross-contract calls in Soroban
    go through a generated `*Client` type, not the contract struct itself.

Because `src/lib.rs` includes this file unconditionally (`mod governance;`),
these errors currently break `cargo build`/`cargo test` for the **whole**
crate, not just governance — see the CI workflow, which is expected to fail
on this until it's fixed.

## What else is missing, beyond compiling

Even with the storage layer and API usage fixed, the module has no real
economic logic wired in:

- No real token transfers for minting/staking/reward distribution — several
  functions have the transfer call commented out (e.g.
  `VotingEscrow::create_lock`, `increase_lock`, `withdraw`) or only move
  internal bookkeeping numbers.
- `ProtocolGovernor::propose` constructs a throwaway `VotingEscrow` client
  against a random address (`Address::random(&e)`) instead of a configured
  one — voting power can never be read correctly.
- `FeeDistributor::claim_week` computes a claimable share but never actually
  transfers it (the transfer line is commented out).
- `pending_rewards` in `StakingContract` uses a placeholder reward formula
  (`stake_balance * time_elapsed * reward_per_token`, with `reward_per_token`
  always zero since nothing ever sets it).
- `ProtocolGovernor::execute` doesn't execute proposal call data — the loop
  that would invoke the target contracts is commented out.

## What must land before this is usable

1. Implement the storage-key helpers using real `Env::storage()` calls
   (instance/persistent/temporary as appropriate), matching the pattern
   already used in `src/yield_vault.rs` and `src/reward_distributor.rs`.
2. Replace `BigInt`/`Env::current()`/`extension_state()` with real
   `soroban-sdk` 22 APIs (`i128`, `env.storage()`, function-parameter `Env`).
3. Replace direct struct construction with generated `Client` types for
   cross-contract calls (governor → voting escrow, staking → fee
   distributor, etc.), and pass real configured addresses instead of
   `Address::random(&e)`.
4. Wire up actual token transfers everywhere a transfer is currently
   commented out or missing.
5. Implement real proposal execution (`ProtocolGovernor::execute`) and a real
   reward-accrual formula for staking.
6. Add contract tests (there are currently only four placeholder
   `#[test]` functions that check constant values, not behavior) and get the
   crate compiling and passing under the CI workflow.
7. Only after the above: update `README.md` to describe governance and fee
   sharing as a shipped feature, and fill in the governance addresses in
   `.env.example`.

Until then, treat every function in `src/governance.rs` and the
corresponding `sdk/src/governance.ts` client as **design scaffolding, not a
working feature**.
