# Upgrading deployed contracts

Issue: [#120](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/120).

Soroban has **no proxy pattern**. There is no separate "implementation"
contract to point at, and a contract's address is fixed for life. What the host
does provide is
[`Env::deployer().update_current_contract_wasm`](https://docs.rs/soroban-sdk/latest/soroban_sdk/deploy/struct.Deployer.html#method.update_current_contract_wasm),
which replaces the *executing* contract's code while keeping its address, its
storage and its balance. Every contract in this crate exposes that call through
an admin-only `upgrade` entrypoint, so deployed state can be fixed in place.

## The entrypoints

All seven contracts (`StellarLiquidityYieldEngine`, `YieldVault`,
`RebalanceEngine`, `MultiRewardDistributor`, `StrategyRegistry`, `ILInsurance`,
`Actuary`) expose the same three:

| Entrypoint | Auth | Purpose |
| --- | --- | --- |
| `upgrade(admin, new_wasm_hash)` | stored admin | Replace the contract's code. Takes effect on the **next** invocation. |
| `migrate(admin)` | stored admin | Adopt this build's storage schema version. Returns the version it replaced. Idempotent. |
| `is_initialized()` | none | Safely return whether initialization has recorded an admin. Returns `false` before initialization. |
| `get_storage_version()` | none | The schema version recorded in the contract's storage. |

`upgrade` publishes a `contract_upgraded` event carrying `(admin, wasm_hash)`;
`migrate` publishes `contract_migrated` with `(admin, from, to)`. An off-chain
monitor should watch `contract_upgraded` — it is the only signal that the code
behind an address changed without the address changing.

`is_initialized()` does not require authorization and does not panic when the
contract has not been initialized. It checks for the admin key written by each
initializer, so existing initialized deployments remain detectable even if
they predate storage-version tracking. Calls against an invalid or unavailable
contract address still fail at the RPC/host layer; the query only makes the
uninitialized state explicit for a deployed contract.

`initialize` records `upgrade::STORAGE_VERSION` (`src/upgrade.rs`), so a freshly
deployed contract starts at the version of the code that deployed it. A
contract deployed before this existed also reads `0`. Therefore, `0` alone does
not tell an operator whether a deployment is uninitialized or is an initialized
legacy deployment; establish deployment history before choosing a migration.

## Supported paths between releases

The crate currently uses storage schema version `1` for the upgrade-managed
contracts. This number describes stored data, not the package version or wasm
release. Equal version numbers are necessary but not sufficient for
compatibility: check the stored shapes and migration behavior of the specific
contract being upgraded.

| Source storage | Target storage | Supported path |
| --- | --- | --- |
| `1` | `1` | In-place upgrade when the new code preserves the existing stored shapes. Do not call `migrate`; a logic-only upgrade needs no schema transaction. |
| `0` | `1` | In-place only when the target code already understands the source layout. The current migration only records version `1`; it does not convert stored values. |
| `N` | `M`, where `M > N` | In-place only if the target release implements and tests a forward migration from that specific source layout. If it does not, this path is unsupported; redeploy and move state deliberately instead. |
| `M` | `N`, where `N < M` | Not supported by default. A downgrade needs an explicitly tested reverse-compatible wasm and reversible data migration. |

`migrate` currently records the target build's `STORAGE_VERSION` and emits
`contract_migrated`; it does not validate the source version or select a
version-specific migration. Operators must compare the contract's reported
version with the target release's documented source-version support before
calling it. Do not use `migrate` to mark an incompatible layout as compatible.

For each release that changes `STORAGE_VERSION`, its release notes should state
the source schema versions supported by that contract, the migration performed,
whether a redeploy is required, and whether rollback remains safe. Until a
source-to-target path is explicitly documented and tested, treat it as
unsupported for in-place upgrades.

## Flow A — in-place upgrade (storage-compatible change)

Use this when the new build reads and writes the same stored shapes.

```bash
# 0. Build the new code for the contract you are upgrading. One contract per
#    wasm: see the "Contract Deployment" section of the README.
cargo build --target wasm32-unknown-unknown --release \
  --no-default-features --features yield-vault
NEW_WASM=target/wasm32-unknown-unknown/release/stellar_liquidity_yield_engine.wasm

# 1. Install the wasm you are replacing and record its hash for rollback, then
#    install the new wasm. `soroban` is now spelled `stellar` in newer CLIs.
OLD_WASM=path/to/previous/yield_vault.wasm
OLD_WASM_HASH=$(soroban contract install --wasm "$OLD_WASM" --source deployer --network testnet)
NEW_WASM_HASH=$(soroban contract install --wasm "$NEW_WASM" --source deployer --network testnet)

# 2. Run the rollback readiness check below BEFORE swapping the code.

# 3. Swap the code (admin only).
soroban contract invoke --id "$CONTRACT_ID" --source deployer --network testnet -- \
  upgrade \
  --admin "$(soroban keys address deployer)" \
  --new_wasm_hash "$NEW_WASM_HASH"

# 3. Confirm the schema version now stored on the contract.
soroban contract invoke --id "$CONTRACT_ID" --network testnet -- get_storage_version
```

Run `migrate` only if the target release documents a migration from the
reported source version:

```bash
soroban contract invoke --id "$CONTRACT_ID" --source deployer --network testnet -- \
  migrate --admin "$(soroban keys address deployer)"
```

For a `1` to `1` storage-compatible upgrade, stop after checking the version;
calling `migrate` anyway writes the same version and emits an unnecessary
`contract_migrated` event. For a `0` to `1` legacy deployment, run it only after
confirming that the target understands the existing stored layout.

The upgrade is atomic: if the hash was never uploaded, or the admin check
fails, the call reverts and the old code stays live (covered by
`tests/upgrade_tests.rs::test_rollback_readiness_requires_an_installed_previous_wasm_hash`).

### Rollback readiness check

Run this gate **before step 3**. If any check fails, stop and use Flow B; do not
swap code you cannot reverse.

| Check | Why it matters |
| --- | --- |
| `OLD_WASM_HASH` is set and is a 64-character hex hash | The previous wasm must already be installed; an uninstalled hash makes a rollback impossible. |
| `OLD_WASM_HASH != NEW_WASM_HASH` | Otherwise the "rollback" would just re-apply the code you are installing. |
| Current `get_storage_version()` is recorded | Rollback must restore a build that understands that layout. |
| `MIGRATION_REVERSIBLE=true` when this release changes stored shapes | `migrate` only moves forward; old code cannot decode newer data on its own. |
| The deployer key matches the contract's stored admin | Both the upgrade and the rollback are admin-only calls. |

```bash
CURRENT_VERSION=$(soroban contract invoke --id "$CONTRACT_ID" \
  --network testnet -- get_storage_version)
ADMIN_ADDRESS=$(soroban keys address deployer)
MIGRATION_REVERSIBLE=true   # set to false if migrate changed stored shapes

check_rollback_ready() {
  local failed=0
  [[ "$OLD_WASM_HASH" =~ ^[0-9a-fA-F]{64}$ ]] || {
    echo "OLD_WASM_HASH is missing or malformed"; failed=1; }
  [[ "$OLD_WASM_HASH" != "$NEW_WASM_HASH" ]] || {
    echo "rollback hash equals the new hash"; failed=1; }
  [[ "$CURRENT_VERSION" =~ ^[0-9]+$ ]] || {
    echo "current storage version could not be read"; failed=1; }
  [[ "$MIGRATION_REVERSIBLE" == "true" ]] || {
    echo "migration is not reversible; use Flow B"; failed=1; }
  [[ -n "$ADMIN_ADDRESS" ]] || {
    echo "admin key is not available"; failed=1; }
  return "$failed"
}

check_rollback_ready || { echo "Rollback readiness check failed; do not upgrade"; exit 1; }
```

After a rollback, verify the `contract_upgraded` event carries `OLD_WASM_HASH`
and that `get_storage_version()` still matches the value recorded above.

### Validating the stages first

A production promotion goes through seven gates: preflight, install, simulate,
staging on a separate contract, promote, verify and closeout. Build the plan
from the evidence gathered so far with
`planStagedUpgrade()` (`sdk/src/stagedUpgrade.ts`) and refuse to submit
`upgrade` until `plan.canPromote` is true and `plan.nextStage === 'promote'`.
It blocks a promotion with a missing rollback hash, a schema downgrade, a
migration whose version does not move, an unverified staging copy, or too few
approvals — the full procedure is
[docs/STAGED_UPGRADE_VALIDATION.md](STAGED_UPGRADE_VALIDATION.md).

### Rolling back

Point `upgrade` at `OLD_WASM_HASH` from the readiness check. The rollback is
admin-only and takes effect on the next invocation, exactly like the upgrade.
It is only safe if the migration was reversible: `migrate` moves stored data
forward, and the older code may not understand what the newer `migrate` wrote.
Prefer forward fixes, and record what each `migrate` changed.

## Flow B — re-deploy plus migrate (incompatible or urgent)

Re-deploying is the fallback when in-place upgrade is not appropriate for
policy reasons (for example a key compromise: `upgrade` is only as strong as the
admin key) or when a change cannot be expressed as a migration.

1. Deploy the new build, producing a **new contract address**.
2. Move state deliberately. Contracts this repo controls other addresses
   through, so the switch is one admin call each:
   - `StellarLiquidityYieldEngine::update_strategy_registry(admin, addr)`
   - `StellarLiquidityYieldEngine::update_reward_distributor(admin, addr)`
   - `YieldVault::set_treasury(admin, addr)`
   - `RewardDistributor::set_price_oracle(admin, addr)`
   - `RebalanceEngine::update_pool_apy(...)` / keeper set, as configured
3. For state that only lives in the old contract (user positions, policies,
   strategies), read it out and re-write it into the new deployment. There is no
   on-chain migration helper for this: it is an off-chain script that loops over
   `get_user_position` / `get_policy` / `get_strategy` and replays the writes.
4. Freeze the old contract (`pause`, or `enable_emergency_mode` on the reward
   distributor) so it cannot be used after the cut-over.

Budget for step 3 before choosing Flow B — for the vault it means replaying every
holder's `UserPosition`.

## Staged rollout for new strategy versions

New strategy versions should not go live for every pool at once. The staged
rollout procedure moves a new version through explicit stages so the keeper and
governance operators can observe behaviour and halt the rollout at any point.

The rollout is driven by the governance operations surface. Keeper backoff for
failed canary rebalances follows the `sdk/src/keeperBackoff.ts` helper, so the
failure threshold below is evaluated against the same retry accounting the keeper
uses.

1. **Register** the new version with the `StrategyRegistry` as inactive, so it
   cannot be selected by the engine.
2. **Canary**: enable the new version for a small, configured subset of pools
   (the first stage). Keepers only route rebalances to canary pools.
3. **Expand**: after a monitoring window with no failed rebalances and no
   adverse yield deviation, widen the rollout to the next set of pools.
4. **Complete**: enable the version everywhere and retire the previous one.

Boundary behaviour:
- A rollout stage of 0% or of an empty pool set is rejected; the version stays
  inactive.
- Advancing a stage is only allowed when the previous stage is complete; skipping
  stages is rejected by the governance entrypoint.
- Setting a rollout to 100% is equivalent to a full enable and is allowed only
  after the canary stage has been recorded.

Failure behaviour:
- If the keeper reports failures for the canary pools beyond the configured
  threshold, the rollout is automatically halted and the previous version is
  kept active for all pools.
- A halted rollout can only be resumed or rolled back by the governance admin.
  Every stage transition emits an event so operators can audit the rollout.

New configuration: the canary pool set and the failure threshold are supplied
to the governance entrypoint when the rollout is started and should be recorded
in the operations runbook before the rollout begins.

## Version policy

`STORAGE_VERSION` in `src/upgrade.rs` describes the **stored layout**, not the
contract's features.

- Bump it in the same change that alters a stored type, and extend the
  contract's `migrate` with the work that change needs.
- Do not bump it for logic-only changes: a migration that does nothing makes the
  operator run an unnecessary transaction.
- Write the migration work idempotently. `migrate` is safe to call twice, and a
  retried transaction (or an operator who is unsure whether the first call
  landed) must not apply anything twice.
- Record the previous version in the `contract_migrated` event, and log the new
  code's version, so a post-mortem can tell which build ran against which
  storage.

A configuration change that also alters a stored shape is a migration: follow
[docs/CONFIG_MIGRATION_CHECKLIST.md](CONFIG_MIGRATION_CHECKLIST.md) for the
scope classification, bounds, snapshot/rollback and keeper-restart checklists,
and bump `STORAGE_VERSION` here in the same change.

An example of a change that needs both a bump and migration work: adding
`RewardStream::claim_deadline` ([#121](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/121))
changes the encoding of the stored stream list, so a build containing it must
migrate the stored `streams` vector rather than decode it as-is.

## If an upgrade fails

Recovery is a triage problem before it is a transaction problem: a failed
`upgrade` invocation reverts atomically, so the first question is whether the
code changed at all and whether the recorded schema version matches it.
[docs/RUNBOOK_FAILED_UPGRADE.md](RUNBOOK_FAILED_UPGRADE.md) is the operator
procedure — freeze and capture, triage, retry / roll back / finish forward /
re-deploy / escalate, verification, keeper resume, close-out — and lists the
boundary and failure cases (unknown wasm hash, non-admin rejection, schema
version ahead of the build, partial migration, lost admin key).

The same triage is encoded in the SDK, so an on-call script can print the plan
and its blockers instead of reconstructing them by hand:

```ts
import {
  formatUpgradeRecoveryPlan,
  planUpgradeRecovery,
} from 'stellar-liquidity-yield-engine-sdk';

const plan = planUpgradeRecovery({
  phase: 'post_upgrade_verification',
  liveCode: 'new', // what answers at the address now
  expectedStorageVersion: 2,
  storageVersion: 1, // from get_storage_version
  previousWasmHash: PREVIOUS_WASM_HASH,
  paused: true,
});

console.log(formatUpgradeRecoveryPlan(plan));
```

`plan.safeToRetry` is true only when the failed attempt provably changed
nothing; `plan.blockers` lists what must be resolved before the plan can run.
Covered by `sdk/src/upgradeRecovery.test.ts`.
## Safe role rotation

Admin and keeper roles are the only keys that can change code (`upgrade`),
migrate storage (`migrate`), and move funds or configuration. Rotating them is
an operational step that must not leave a contract without a reachable admin.

### Normal rotation

1. Generate the new key and fund it on the target network.
2. Use the current admin to rotate the admin role to the new address (the
   `set_admin`/`transfer_admin` entrypoint on the affected contract). The
   change takes effect immediately and emits an admin-changed event.
3. Verify with a read-only call from the new key before retiring the old key.
4. Rotate keeper roles the same way (`set_keeper` on `RebalanceEngine` and
   related contracts). Keepers are operationally separated from the admin, so
   a keeper rotation never requires admin authority to be shared.
5. Only after both roles are verified on the new keys, revoke the old keys.

### Boundary cases

- **Rotating to the same address** is a no-op and should be treated as a
  successful but unchanged operation; it must not emit a misleading event.
- **Rotating to the zero/invalid address** must be rejected. A contract with no
  admin cannot be upgraded or recovered.
- **Rotating a keeper while it has in-flight rebalances** is safe: the old
  keeper's pending calls revert once the role is revoked, and the operator
  should re-submit them from the new keeper.
- **Multiple contracts** share an operator key in practice. Rotate them in a
  fixed order (registry, distributor, vault, engine) and record each contract's
  new admin before moving on, so a partial rotation is visible.

### Failure behaviour

- If the rotation transaction reverts (wrong caller, bad address), the role
  stays with the previous holder. Nothing is half-applied; retry from step 2.
- If the new key is lost before step 5, the old key must still be held. Do not
  revoke the old key until the new key has demonstrably signed a transaction.
- If the old key is compromised mid-rotation, prefer `upgrade` to a fixed build
  that stores the new admin, or re-deploy (Flow B), rather than racing the
  attacker for the admin entrypoint.

### Tests

Rotation coverage lives alongside the upgrade tests: a rotated admin can call
`upgrade`/`migrate`, the previous admin cannot, rotating to the same address is
a no-op, and a failed rotation leaves the existing admin in place. Run
`cargo test --test upgrade_tests` to exercise these paths.

## Testing an upgrade

- `tests/upgrade_tests.rs` covers all seven contracts: initialization status
  before and after `initialize`, version recorded at `initialize`, `migrate`
  reporting and idempotency, non-admin rejection of both
  admin entrypoints, rejection of an unknown wasm hash, and a real code swap
  through the host deployer (the contract's entrypoints stop existing, while the
  address and storage survive).
- A stored-layout change is also tested against captured state: run a
  `get_storage_version` fixture through the build's migration ladder with
  `checkMigrationCompatibility()` / `assertMigrationCompatible()`
  (`npx jest sdk/src/storageMigrationCompat.test.ts`). It blocks the upgrade on
  ladder gaps, downgrades, dropped keys and non-idempotent migration work before
  any wasm is installed — see
  [docs/STORAGE_MIGRATION_COMPATIBILITY.md](STORAGE_MIGRATION_COMPATIBILITY.md).
- The same file also covers rollback readiness (an uninstalled rollback hash is
  rejected) and persistent-storage expiration boundaries: an entry is readable
  on its last live ledger, archived on the next one, and `extend_ttl` moves that
  boundary without losing the value.
- Run `cargo test --test upgrade_tests`.
- Cross-release SDK API compatibility is guarded by regression tests that pin the
  entrypoint surface (`upgrade`, `migrate`, `get_storage_version`) and the
  `contract_upgraded` / `contract_migrated` event shapes. A new release that
  renames or removes one of these must update the tests deliberately; a change
  that breaks an existing deployed integration fails CI instead of slipping
  through silently. Normal behavior, boundary cases (version `0` from legacy
  deployments, repeated `migrate` calls) and failure cases (non-admin callers,
  unknown wasm hashes) are each covered explicitly.
- The test builds the "replacement" wasm bytes in-process
  (`empty_contract_wasm`), so it needs no build artefact and runs in CI.

## Staged validation tool

`sdk/src/upgradeValidator.ts` runs the pre-upgrade gate as ordered stages and
stops at the first failure. It is pure: read the facts from the network, pass
them in, act on the report.

| Stage | Passes when |
| --- | --- |
| `inputs` | both wasm hashes are 64-character hex and differ |
| `admin` | the signing key equals the contract's stored admin |
| `version` | `get_storage_version()` is readable and not newer than the target build |
| `migration` | no migration is needed, it is reversible, or `acceptIrreversible` is set |
| `rollback` | both the previous and the new wasm hashes are installed on the network |

```ts
import { validateUpgrade, formatUpgradeReport } from './sdk/src/upgradeValidator';

const report = validateUpgrade({
  oldWasmHash, newWasmHash,
  signerAddress, storedAdmin,
  currentStorageVersion, targetStorageVersion: 1,
  migrationReversible: true,
  installedWasmHashes,
});
console.log(formatUpgradeReport(report));
if (!report.ok) process.exit(1);
```

Run `npx jest sdk/src/upgradeValidator` for its tests.

## Runbook: recovering from a failed upgrade

Work top to bottom and stop as soon as the contract is healthy. Every step is
admin-only and takes effect on the next invocation.

1. **Freeze.** Pause the contract (`pause`) so no user transaction runs against
   half-migrated state. Governance: queue the pause through the timelock only if
   the emergency signers cannot act.
2. **Diagnose which step failed.**
   - `upgrade` reverted: the live code is unchanged. Check the wasm hash is
     installed (`rollback` stage above) and the signer is the admin, fix it, retry.
   - `upgrade` succeeded but calls fail: the new code is live. Read
     `get_storage_version()`; if it is missing the contract has no matching
     entrypoints (wrong wasm) and you must roll back.
   - `migrate` failed or was never run: the code is new and the version is old.
     `migrate` is idempotent, so fix the cause and call it again.
3. **Decide rollback or forward fix.**
   - Migration reversible (`MIGRATION_REVERSIBLE=true`): call `upgrade` with
     `OLD_WASM_HASH` recorded before the swap.
   - Migration not reversible: do not roll back in place. Ship a forward-fix wasm,
     or use Flow B (re-deploy and migrate).
4. **Verify.** `get_storage_version()` matches the code now live, read-only
   getters return the values you recorded before the upgrade, and the
   `contract_upgraded` / `contract_migrated` events show the expected hash and
   versions.
5. **Resume.** Unpause, then watch keepers and events for one full cycle. Keepers
   restore their checkpoint on start (see `docs/KEEPER_RECOVERY.md`).
6. **Record.** Write the failed hash, the cause, the rollback hash and the
   transaction ids in the release notes.

## Checklist: protocol configuration changes

Use this for any change to fees, timelock delay, thresholds, strategy
parameters or emergency signers. Copy it into the change ticket.

- [ ] Current values read and recorded (vault `get_timelock_delay`,
      `get_emergency_threshold`, `get_emergency_signers`, registry
      `get_strategy_parameters`).
- [ ] New values stay inside documented bounds; a boundary case (min and max) was
      tried on testnet.
- [ ] Change goes through the timelock or governance proposal, not a direct admin
      call, unless it is an emergency.
- [ ] Storage-shape change? Then `STORAGE_VERSION` is bumped and `migrate` is
      extended; run the staged validation tool first.
- [ ] Keepers and the SDK accept the new values (no hard-coded copies).
- [ ] Rollback values are written down and a rollback transaction is prepared.
- [ ] After execution: getters return the new values and the change event was seen.
- [ ] Docs and the SDK defaults updated in the same change.

## Storage migration compatibility tests

`tests/upgrade_tests.rs` also checks that migrating from an unversioned
(pre-tracking) state keeps existing data, that a failed (unauthorized) `migrate`
leaves the recorded version alone, and that all seven contracts adopt the current
version from an unversioned state and stay idempotent afterwards.
