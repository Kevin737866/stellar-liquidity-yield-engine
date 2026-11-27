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
| `get_storage_version()` | none | The schema version recorded in the contract's storage. |

`upgrade` publishes a `contract_upgraded` event carrying `(admin, wasm_hash)`;
`migrate` publishes `contract_migrated` with `(admin, from, to)`. An off-chain
monitor should watch `contract_upgraded` — it is the only signal that the code
behind an address changed without the address changing.

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

An example of a change that needs both a bump and migration work: adding
`RewardStream::claim_deadline` ([#121](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/121))
changes the encoding of the stored stream list, so a build containing it must
migrate the stored `streams` vector rather than decode it as-is.

## Post-deployment smoke checks (Issue #511)

Run these after every `upgrade` + `migrate` sequence, before directing any live
traffic at the updated contracts. The checks call read-only entrypoints only —
no tokens are moved and no admin-only calls are made.

### CLI (quick)

```bash
# For each upgraded contract, confirm it answers and reports the right version.
soroban contract invoke --id "$CONTRACT_ID" --network testnet -- get_storage_version
soroban contract invoke --id "$CONTRACT_ID" --network testnet -- is_paused
```

Both calls must succeed without error. `get_storage_version` must equal the
`STORAGE_VERSION` constant from `src/upgrade.rs` (currently **1**). `is_paused`
returns a boolean; `true` is valid if the contract was deliberately paused
before the upgrade (unpause it afterwards with `unpause`).

### SDK (`runSmokeChecks`)

The SDK provides `runSmokeChecks` from `sdk/src/smokeCheck.ts` for scripted
post-deployment validation:

```ts
import { runSmokeChecks, formatSmokeCheckReport } from '@stellar-liquidity-yield-engine/sdk';
import { Networks } from 'stellar-sdk';

const report = await runSmokeChecks({
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET,
  contracts: {
    yieldEngine:        process.env.YIELD_ENGINE_CONTRACT_ID,
    yieldVault:         process.env.YIELD_VAULT_CONTRACT_ID,
    rebalanceEngine:    process.env.REBALANCE_ENGINE_CONTRACT_ID,
    rewardDistributor:  process.env.REWARD_DISTRIBUTOR_CONTRACT_ID,
    strategyRegistry:   process.env.STRATEGY_REGISTRY_CONTRACT_ID,
    ilInsurance:        process.env.IL_INSURANCE_CONTRACT_ID,
    actuary:            process.env.ACTUARY_CONTRACT_ID,
  },
  expectedStorageVersion: 1,  // must equal upgrade::STORAGE_VERSION
});

console.log(formatSmokeCheckReport(report));

if (!report.passed) {
  console.error('Smoke checks failed — do not direct traffic here.');
  process.exit(1);
}
```

Omit any contract key to skip that contract. Omit `expectedStorageVersion` to
skip the version assertion (useful when probing contracts at different schema
versions during a staged rollout).

### What is checked

| Probe | Entrypoint | Expected behaviour |
| --- | --- | --- |
| Storage version | `get_storage_version()` | Returns an integer equal to `expectedStorageVersion` when supplied |
| Liveness | `is_paused()` | Call succeeds without error; return value is not asserted |

A failed probe means the contract cannot serve normal calls and no live traffic
should be routed to it. `runSmokeChecks` runs all probes even when earlier ones
fail so a single report shows the full picture.

### Smoke check in the upgrade sequence

Insert the smoke-check step between migration and traffic cut-over:

```
upgrade (swap code)
  → migrate (adopt new schema version)
    → smoke check (confirm all entrypoints live)   ← new step
      → unpause (if paused before upgrade)
        → cut over traffic
```

If any check fails at the smoke-check step, do not unpause and do not cut over.
Diagnose the failure, roll back with `upgrade` pointing at the previous wasm
hash, and re-run the smoke check before attempting the upgrade again.

## Testing an upgrade

- `tests/upgrade_tests.rs` covers all seven contracts: version recorded at
  `initialize`, `migrate` reporting and idempotency, non-admin rejection of both
  admin entrypoints, rejection of an unknown wasm hash, and a real code swap
  through the host deployer (the contract's entrypoints stop existing, while the
  address and storage survive).
- The same file covers rollback readiness, persistent-storage expiration
  boundaries, and the **post-deployment smoke-check probes** (`get_storage_version`
  and `is_paused` on fresh, migrated, and paused contracts; detection of a
  missing migration by version mismatch).
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
