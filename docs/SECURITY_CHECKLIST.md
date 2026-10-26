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
  - Test: `teststs/yield_vault_integration_tests.rs::test_pause_blocks_deposit_withdraw_harvest`.
- [ ⭐ ] `pause` and `unpause` are restricted to the configured admin.
  - Code: `src/lib.rs` — `pause`, `unpause`, `require_admin`.
  - Test: `teststs/yield_vault_integration_tests.rs::test_non_admin_cannot_pause_or_unpause`, and `teststs/rebalance_engine_tests.rs::test_authorization_non_admin_rejected_from_admin_functions`.
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
  - Test: `teststs/yield_vault_integration_tests.rs`::test_non_admin_cannot_pause_or_unpause`.
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
  - Test: `testst/yield_vault_integration_tests.rs`::test_deposit_withdraw_fees_and_share_math`.
- [ ⭐ ] Harvest fees are transferred to the treasury address supplied at initialization.
  - Code: `src/lib.rs` — `harvest`.
  - Test: `testst/yield_vault_integration_tests.rs`::test_harvest_reinvests_and_pays_treasury_fee`.
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
  - Test: `testst/yield_vault_integration_tests.rs`::test_deposit_withdraw_round_trip_balances`.
- [ ] No external callback into the vault is invoked during a user flow (no flash-loan hooks, no token callbacks).
  - Code: `src/lib.rs` — vault entrypoints only call token contracts.
- [ ] The rebalance engine respects the cooldown before executing a flash rebalance, preventing same-tx loops.
  - Code: `src/rebalance_engine.rs` — `execute_flash_rebalance`.
  - Test: `testst/rebalance_engine_tests.rs`::test_cooldown_prevents_rebalance_within_period`.

## 5. Off-Chain Keepers, Event Listeners & RPC Synchronization

Assumption: off-chain keepers drive rebalance and harvest flows and rely on events to stay in sync with on-chain state.

- [ ⭐ ] Admin configuration changes emit events consumable by listeners.
  - Code: `src/lib.rs` — `update_strategy_registry`, `update_reward_distributor`.
- [ ] Pause & unpause emit events so keepers can stop submitting transactions.
  - Code: `src/lib.rs` — `pause`, `unpause` (currently silent).
  - Test: not yet covered.
- [ ] Rebalance history is capped so listeners can paginate without unbounded storage.
  - Code: `src/rebalance_engine.rs` — get_history cap.
  - Test: `testst/rebalance_engine_tests.rs`::test_rebalance_history_is_capped_at_1000_entries`.
- [ ] Keepers can query `is_paused` and `get_storage_version` to decide whether to submit and to detect schema drift.
  - Code: `src/lib.rs` — `is_paused`, `get_storage_version`.

## 6. Upgrade & Migration

- [ ⭐ ] `upgrade` and `migrate` are admin-only and update the storage version tracker.
  - Code: `src/lib.rs` — `upgrade`, `migrate`, `src/upgrade.rs`.
  - Test: `testst/upgrade_tests.rs`.

## High-Priority Items Verified by Tests

The following tests are required to pass on every change:

1. `test_pause_blocks_deposit_withdraw_harvest` — paused state blocks user flows.
2. `test_non_admin_cannot_pause_or_unpause` — access control on pause controls.
3. `test_authorization_non_admin_rejected_from_admin_functions` — access control on rebalance engine.
4. `test_deposit_withdraw_fees_and_share_math` — fee routing on withdrawal.
5. `test_harvest_reinvests_and_pays_treasury_fee` — fee routing on harvest.
6. `test_deposit_withdraw_round_trip_balances` — checks-effects-interactions on deposit/withdraw.
7. `test_cooldown_prevents_rebalance_within_period` — reentrancy / loop protection on rebalance.

## Open Follow-Ups

Items marked `[ ]` above are not yet covered by tests. They are tracked here so the checklist remains actionable:

- Add a paused-state test for `update_strategy_registry` and `update_reward_distributor`.
- Add a test for `update_admin` rejecting non-current-admin callers.
- Add an event for admin transfer and cover it in a test.
- Add a test asserting the treasury address is stable across harvests.
- Add a negative test for out-of-range fee basis points.
- Add pause / unpause events and cover them in a test.
- # Security Checklist

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
  - Test: `teststs/yield_vault_integration_tests.rs::test_pause_blocks_deposit_withdraw_harvest`.
- [ ⭐ ] `pause` and `unpause` are restricted to the configured admin.
  - Code: `src/lib.rs` — `pause`, `unpause`, `require_admin`.
  - Test: `teststs/yield_vault_integration_tests.rs::test_non_admin_cannot_pause_or_unpause`, and `teststs/rebalance_engine_tests.rs::test_authorization_non_admin_rejected_from_admin_functions`.
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
  - Test: `teststs/yield_vault_integration_tests.rs`::test_non_admin_cannot_pause_or_unpause`.
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
  - Test: `testst/yield_vault_integration_tests.rs`::test_deposit_withdraw_fees_and_share_math`.
- [ ⭐ ] Harvest fees are transferred to the treasury address supplied at initialization.
  - Code: `src/lib.rs` — `harvest`.
  - Test: `testst/yield_vault_integration_tests.rs`::test_harvest_reinvests_and_pays_treasury_fee`.
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
  - Test: `testst/yield_vault_integration_tests.rs`::test_deposit_withdraw_round_trip_balances`.
- [ ] No external callback into the vault is invoked during a user flow (no flash-loan hooks, no token callbacks).
  - Code: `src/lib.rs` — vault entrypoints only call token contracts.
- [ ] The rebalance engine respects the cooldown before executing a flash rebalance, preventing same-tx loops.
  - Code: `src/rebalance_engine.rs` — `execute_flash_rebalance`.
  - Test: `testst/rebalance_engine_tests.rs`::test_cooldown_prevents_rebalance_within_period`.

## 5. Off-Chain Keepers, Event Listeners & RPC Synchronization

Assumption: off-chain keepers drive rebalance and harvest flows and rely on events to stay in sync with on-chain state.

- [ ⭐ ] Admin configuration changes emit events consumable by listeners.
  - Code: `src/lib.rs` — `update_strategy_registry`, `update_reward_distributor`.
- [ ] Pause & unpause emit events so keepers can stop submitting transactions.
  - Code: `src/lib.rs` — `pause`, `unpause` (currently silent).
  - Test: not yet covered.
- [ ] Rebalance history is capped so listeners can paginate without unbounded storage.
  - Code: `src/rebalance_engine.rs` — get_history cap.
  - Test: `testst/rebalance_engine_tests.rs`::test_rebalance_history_is_capped_at_1000_entries`.
- [ ] Keepers can query `is_paused` and `get_storage_version` to decide whether to submit and to detect schema drift.
  - Code: `src/lib.rs` — `is_paused`, `get_storage_version`.

## 6. Upgrade & Migration

- [ ⭐ ] `upgrade` and `migrate` are admin-only and update the storage version tracker.
  - Code: `src/lib.rs` — `upgrade`, `migrate`, `src/upgrade.rs`.
  - Test: `testst/upgrade_tests.rs`.

## High-Priority Items Verified by Tests

The following tests are required to pass on every change:

1. `test_pause_blocks_deposit_withdraw_harvest` — paused state blocks user flows.
2. `test_non_admin_cannot_pause_or_unpause` — access control on pause controls.
3. `test_authorization_non_admin_rejected_from_admin_functions` — access control on rebalance engine.
4. `test_deposit_withdraw_fees_and_share_math` — fee routing on withdrawal.
5. `test_harvest_reinvests_and_pays_treasury_fee` — fee routing on harvest.
6. `test_deposit_withdraw_round_trip_balances` — checks-effects-interactions on deposit/withdraw.
7. `test_cooldown_prevents_rebalance_within_period` — reentrancy / loop protection on rebalance.

## Open Follow-Ups

Items marked `[ ]` above are not yet covered by tests. They are tracked here so the checklist remains actionable:

- Add a paused-state test for `update_strategy_registry` and `update_reward_distributor`.
- Add a test for `update_admin` rejecting non-current-admin callers.
- Add an event for admin transfer and cover it in a test.
- Add a test asserting the treasury address is stable across harvests.
- Add a negative test for out-of-range fee basis points.
- Add pause / unpause events and cover them in a test.
