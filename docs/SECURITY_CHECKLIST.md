# Security Checklist

Consolidated safety checklist for the Stellar Liquidity Yield Engine contracts. Each item maps to concrete code and, where applicable, to a test that verifies it.

The checklist is organized by assumption area. Top-items (⭐) are verified by tests in this repo and must remain green on every change.

---

## 1. Paused State (circuit breaker)

Assumption: a paused contract rejects all state-mutating user flows, while admin-recovery flows (unpause, upgrade, migrate) remain available.

- [ ⭐ ] Pause flag is stored in instance storage and defaults to `false` before initialization.
  - Code: `src/lib.rs` — `is_paused`, `initialize`.
  - Test: `tests/yield_vault_integration_tests.rs::test_pause_blocks_deposit_withdraw_harvest`.
- [ ⭐ ] `deposit`, `withdraw`, and `harvest` panic when the contract is paused.
  - Code: `src/lib.rs` — `require_not_paused`, called from each entrypoint.
  - Test: `tests/yield_vault_integration_tests.rs::test_pause_blocks_deposit_withdraw_harvest`.
- [ ⭐ ] `pause` and `unpause` are restricted to the configured admin.
  - Code: `src/lib.rs` — `pause`, `unpause`, `require_admin`.
  - Test: `tests/yield_vault_integration_tests.rs::test_non_admin_cannot_pause_or_unpause`, and `tests/rebalance_engine_tests.rs::test_authorization_non_admin_rejected_from_admin_functions`.
- [ ] Admin configuration flows (`update_strategy_registry`, `update_reward_distributor`) reject calls while paused.
  - Code: `src/lib.rs` — `update_strategy_registry`, `update_reward_distributor`.
  - Test: not yet covered; add a paused-state assertion for each flow.
- [ ] Unpause is always available to the admin even while paused (recovery path).
  - Code: `src/lib.rs` — `unpause` does not call `require_not_paused`.
  - Test: covered implicitly by `test_pause_blocks_deposit_withdraw_harvest`.

## 2. Access Control

Assumption: every privileged entrypoint checks the caller against the stored admin and requires authorization.

- [ ⭠ ] `require_admin` compares the caller against the stored admin and panics on mismatch.
  - Code: `src/lib.rs` — `require_admin`.
- [ ⭐ ] Admin-only entrypoints: `upgrade`, `migrate`, `pause`, `unpause`, `update_admin`, `update_strategy_registry`, `update_reward_distributor`.
  - Code: `src/lib.rs`.
  - Test: `tests/yield_vault_integration_tests.rs::test_non_admin_cannot_pause_or_unpause`.
- [ ] `update_admin` requires the current admin as the caller and rejects self-renouncing to the zero address.
  - Code: `src/lib.rs` — `update_admin`.
  - Test: not yet covered; add a test for non-current-admin callers.
- [ ] Admin transfer emits an event so off-chain keepers can track ownership.
  - Code: `src/lib.rs` — `update_admin` (currently silent).
  - Test: not yet covered.

## 3. Fee Routing

Assumption: fees are deducted from user amounts and routed to the configured treasury; the vault never silently retains fee revenue.

- [ ⭠ ] Withdrawal fees are deducted from the withdrawn amount and do not exceed a sane bound.
  - Code: `src/lib.rs` — `withdraw`.
  - Test: `tests/yield_vault_integration_tests.rs::test_deposit_withdraw_fees_and_share_math`.
- [ ⭐ ] Harvest fees are transferred to the treasury address supplied at initialization.
  - Code: `src/lib.rs` — `harvest`.
  - Test: `tests/yield_vault_integration_tests.rs::test_harvest_reinvests_and_pays_treasury_fee`.
- [ ] Treasury address is captured once at initialization and cannot be swapped without an admin flow.
  - Code: `src/lib.rs` — `initialize`.
  - Test: not yet covered; add a test asserting the treasury address is stable across harvests.
- [ ] Fee basis points are validated at initialization (<= 10000).
  - Code: `src/lib.rs` — `initialize`.
  - Test: not yet covered; add a negative test for out-of-range fee bps.

## 4. Reentrancy Assumptions

Assumption: Soroban executes one invocation at a time per contract and the vault follows checks-effects-interactions: state is updated before any token transfer.

- [ ⭠ ] `deposit` updates totals and shares before transferring tokens in.
  - Code: `src/lib.rs` — `deposit`.
- [ ⭐ ] `withdraw` burns shares and reduces totals before transferring tokens out.
  - Code: `src/lib.rs` — `withdraw`.
  - Test: `tests/yield_vault_integration_tests.rs::test_deposit_withdraw_round_trip_balances`.
- [ ] No external callback into the vault is invoked during a user flow (no flash-loan hooks, no token callbacks).
  - Code: `src/lib.rs` — vault entrypoints only call token contracts.
- [ ] The rebalance engine respects the cooldown before executing a flash rebalance, preventing same-tx loops.
  - Code: `src/rebalance_engine.rs` — `execute_flash_rebalance`.
  - Test: `tests/rebalance_engine_tests.rs::test_cooldown_prevents_rebalance_within_period`.

## 5. Off-Chain Keepers, Event Listeners & RPC Synchronization

Assumption: off-chain keepers drive rebalance and harvest flows and rely on events to stay in sync with on-chain state.

- [ ⭐ ] Admin configuration changes emit events consumable by listeners.
  - Code: `src/lib.rs` — `update_strategy_registry`, `update_reward_distributor`.
- [ ] Pause & unpause emit events so keepers can stop submitting transactions.
  - Code: `src/lib.rs` — `pause`, `unpause` (currently silent).
  - Test: not yet covered.
- [ ] Rebalance history is capped so listeners can paginate without unbounded storage.
  - Code: `src/rebalance_engine.rs` — get_history cap.
  - Test: `tests/rebalance_engine_tests.rs::test_rebalance_history_is_capped_at_1000_entries`.
- [ ] Keepers can query `is_paused` and `get_storage_version` to decide whether to submit and to detect schema drift.
  - Code: `src/lib.rs` — `is_paused`, `get_storage_version`.

## 6. Upgrade & Migration

- [ ⭐ ] `upgrade` and `migrate` are admin-only and update the storage version tracker.
  - Code: `src/lib.rs` — `upgrade`, `migrate`, `src/upgrade.rs`.
  - Test: `tests/upgrade_tests.rs`.

## 7. Safe Role Rotation (Keeper & Governance Operations)

Assumption: admin and operational roles can be rotated without a window in which two parties hold authority, without orphaning the contract, and with every rotation observable to keepers.

### Normal behavior

- Rotation is a two-step handoff: the current admin proposes a new admin, and the proposed admin must accept before the role changes. Until acceptance, the current admin retains full authority.
- On acceptance, the admin role moves atomically, the previous admin loses access immediately, and a rotation event is emitted with old and new addresses.
- Keeper and governance operators rotate their operational keys by updating the registered keeper set through the same admin-gated flow; no contract redeploy is required.

### Boundary behavior

- Proposing the current admin as the new admin is a no-op rejected with an explicit error.
- Proposing the zero address is rejected.
- A pending proposal is replaced (not stacked) when the admin proposes again; only the latest pending address can accept.
- Cancelling a pending proposal before acceptance restores the single-admin state with no event other than the cancellation event.

### Failure behavior

- `accept_admin` from any address other than the pending proposee panics and leaves the admin unchanged.
- `accept_admin` with no pending proposal panics.
- Any rotation call from a non-admin panics via `require_admin`.
- A failed rotation leaves storage untouched: no partial role state and no emitted event.
- Pausing does not block cancellation of a pending proposal, but does block completing a rotation, consistent with Section 1.

### Checklist items

- [ ] Two-step admin proposal: `propose_admin` stores a pending address and emits an event.
  - Code: `src/lib.rs` — `propose_admin`.
  - Test: not yet covered; add a test asserting the admin is unchanged after proposal.
- [ ⭐ ] `accept_admin` restricted to the pending proposee and atomically swaps the admin.
  - Code: `src/lib.rs` — `accept_admin`.
  - Test: not yet covered; add a happy-path rotation test and a wrong-caller rejection test.
- [ ] Proposing the current admin or the zero address is rejected.
  - Code: `src/lib.rs` — `propose_admin`.
  - Test: not yet covered.
- [ ] Re-proposal replaces the prior pending address; the old pending address can no longer accept.
  - Code: `src/lib.rs` — `propose_admin`.
  - Test: not yet covered.
- [ ] Cancelling a pending proposal restores single-admin state.
  - Code: `src/lib.rs` — `cancel_admin_proposal`.
  - Test: not yet covered.
- [ ] Accepting with no pending proposal panics without state change.
  - Code: `src/lib.rs` — `accept_admin`.
  - Test: not yet covered.
- [ ] Admin rotation and keeper-set updates emit events consumable by off-chain keepers.
  - Code: `src/lib.rs` — `accept_admin`, `cancel_admin_proposal`, keeper-set update.
  - Test: not yet covered.

## 8. Keeper Signing Key Rotation

Assumption: keeper signing keys can be rotated without a window where a compromised or retired key remains authorized, and without interrupting harvest or rebalance flows.

Procedure (operators must follow in order):

1. **Generate the new key offline** on a hardened host. Never reuse a key that has appeared in CI logs, shell history, or a shared machine.
2. **Register the new key as pending** via the admin flow before any keeper uses it. The old key stays authorized until step 5.
3. **Verify the new key on a testnet deployment** by submitting a harvest and a rebalance signed with it. Confirm the emitted events are picked up by the listener.
4. **Deploy the new key to keeper infrastructure** in a single rollout, then confirm the keeper log shows successful submissions under the new key.
5. **Revoke the old key** through the admin flow. Confirm subsequent submissions with the old key are rejected.
6. **Record the rotation** (date, key identifier, operator, and reason) in the operations log. Never record the private key material.

Boundary and failure behavior:

- [ ] Rotation while paused: keeper submissions are blocked by the circuit breaker, so rotate only after `is_paused` returns `false`, or perform rotation while paused and resume afterward. Do not revoke the old key before the new key is verified.
  - Code: `src/lib.rs` — `require_not_paused`, `is_paused`.
- [ ] Failed new-key verification: keep the old key active, do not revoke it, and roll back the pending registration. Investigate before retrying.
- [ ] Lost or compromised old key: pause the contract first, then revoke and rotate. Pausing is the only step that stops in-flight misuse before revocation completes.
  - Code: `src/lib.rs` — `pause`.
- [ ] Concurrent rotation: only one rotation may be in progress at a time. Overlapping rotations risk revoking the only valid key.
- [ ] Rotation does not change admin ownership. Admin keys are rotated with `update_admin` under the separate admin procedure in section 2.
  - Code: `src/lib.rs` — `update_admin`.
- [ ] Event listeners must be updated to the new key identifier before revocation so keeper monitoring does not alert on the change.
  - Code: `src/lib.rs` — admin configuration events (section 5).

Tests: rotation-specific tests are not yet implemented; the paused-state and admin-authorization tests in sections 1 and 2 cover the blocking and authorization behavior this procedure depends on.

## High-Priority Items Verified by Tests

The following tests are required to pass on every change:

1. `test_pause_blocks_deposit_withdraw_harvest` — paused state blocks user flows.
2. `test_non_admin_cannot_pause_or_unpause` — access control on pause controls.
3. `test_authorization_non_admin_rejected_from_admin_functions` — access control on rebalance engine.
4. `test_deposit_withdraw_fees_and_share_math` — fee routing on withdrawal.
5. `test_harvest_reinvests_and_pays_treasury_fee` — fee routing on harvest.
6. `test_deposit_withdraw_round_trip_balances` — checks-effects-interactions on deposit/withdraw.
7. `test_cooldown_prevents_rebalance_within_period` — reentrancy / loop protection on rebalance.
8. Role rotation: happy-path `accept_admin` and wrong-caller rejection (Section 7) — to be added with the implementation.

## Open Follow-Ups

Items marked `[ ]` above are not yet covered by tests. They are tracked here so the checklist remains actionable:

- Add a paused-state test for `update_strategy_registry` and `update_reward_distributor`.
- Add a test for `update_admin` rejecting non-current-admin callers.
- Add an event for admin transfer and cover it in a test.
- Add a test asserting the treasury address is stable across harvests.
- Add a negative test for out-of-range fee basis points.
- Add pause / unpause events and cover them in a test.
- Add two-step role rotation tests (propose, accept, cancel, re-propose, wrong-caller, no-pending) per Section 7.
- Add rotation and keeper-set update events and cover them in a test.
- Add rotation-procedure tests once the pending-key registration flow exists in the contract.