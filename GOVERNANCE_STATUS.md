# Governance Module Status

**Status: not functional. Do not deploy or integrate against this module.**

`src/governance.rs` is an early sketch of a governance and protocol
fee-sharing system (a governance token, a staking contract, a fee
distributor, a governor, a voting-escrow lock, and an emergency multisig).
The crate deliberately excludes this file from `src/lib.rs`; it is not part
of the compiled or deployed contracts. If re-enabled, it currently does not
compile or work.

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

These errors are currently isolated because `src/lib.rs` does not include
`governance.rs`. The module's embedded tests are also not compiled or run.

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
6. Add contract tests and get the governor compiling and passing under the CI
   workflow. The deterministic tests in
   [`src/governance_transition_tests.rs`](src/governance_transition_tests.rs)
   cover the intended timestamp boundaries as a test-only reference model;
   they do not exercise this disabled contract or establish that it is safe to
   deploy. Run them with
   `rustc --edition=2021 --test src/governance_transition_tests.rs -o target/governance_transition_tests`
   followed by `target/governance_transition_tests`.
7. Only after the above: update `README.md` to describe governance and fee
   sharing as a shipped feature, and fill in the governance addresses in
   `.env.example`.

Until then, treat every function in `src/governance.rs` and the
corresponding `sdk/src/governance.ts` client as **design scaffolding, not a
working feature**.

## SDK proposal history pagination

The read-only SDK surface does expose a bounded view of whatever proposal
history a configured deployment returns: `paginateProposals(proposals, page,
pageSize)` and `GovernanceSDK.getProposalPage(page, pageSize, maxProposals?)`.
Pages are 1-based, default to 25 proposals, cap the page size at 100, and clamp
out-of-range pages to the last page. `getAllProposals()` and all state-filter
helpers keep their existing signatures, so this is additive. It does not make
the on-chain governance module deployable; it only keeps the history reader
usable for keepers and UI callers without probing unbounded IDs per page.

## SDK governance participation summary

The read-only SDK surface also answers "how has this account participated?"
with `summarizeGovernanceParticipation(account, proposals)` and
`GovernanceSDK.getParticipationSummary(account, { proposals?, maxProposals? })`.
The summary reports the proposals examined, how many reached a voting window
(`Pending` proposals are excluded because they cannot be voted on yet), how
many the account voted on, the for/against split, the total voting power
committed, authored proposal count, the voted proposal IDs, and a
participation rate (percentage with one decimal, 0 when nothing is eligible).

The pure helper accepts the voter maps either as a JS `Map` or a plain object,
treats a missing `null` map or absent account as "did not vote", and treats a
malformed weight as a zero-weight vote instead of failing the report. An empty
account or a non-array history raises a `TypeError`; the SDK method validates
its arguments before any RPC call, and passes read failures through rather than
reporting a fabricated summary. Callers that already hold a proposal list (the
UI's governance panel does) can pass `proposals` to skip the extra RPC sweep.

The UI surfaces this as the `ParticipationSummary` card above the proposal
list. It is reporting only: it does not change what the (still incomplete)
governing contracts do.
