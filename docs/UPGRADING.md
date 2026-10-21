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
contract deployed before this existed reads `0`, which is exactly what
`migrate` is for.

## Flow A — in-place upgrade (storage-compatible change)

Use this when the new build reads and writes the same stored shapes.

```bash
# 0. Build the new code for the contract you are upgrading. One contract per
#    wasm: see the "Contract Deployment" section of the README.
cargo build --target wasm32-unknown-unknown --release \
  --no-default-features --features yield-vault
NEW_WASM=target/wasm32-unknown-unknown/release/stellar_liquidity_yield_engine.wasm

# 1. Optional but recommended: keep the wasm you are replacing, so you can roll
#    back. `soroban` is now spelled `stellar` in newer CLIs.
soroban contract install --wasm "$NEW_WASM" --source deployer --network testnet
# -> prints the NEW_WASM_HASH

# 2. Swap the code (admin only).
soroban contract invoke --id "$CONTRACT_ID" --source deployer --network testnet -- \
  upgrade \
  --admin "$(soroban keys address deployer)" \
  --new_wasm_hash "$NEW_WASM_HASH"

# 3. Confirm the new code is live and, if it bumped the schema version, migrate.
soroban contract invoke --id "$CONTRACT_ID" --network testnet -- get_storage_version
soroban contract invoke --id "$CONTRACT_ID" --source deployer --network testnet -- \
  migrate --admin "$(soroban keys address deployer)"
```

The upgrade is atomic: if the hash was never uploaded, or the admin check
fails, the call reverts and the old code stays live (covered by
`tests/upgrade_tests.rs::test_upgrade_of_unknown_wasm_hash_fails_without_touching_the_contract`).

### Rolling back

Upload the previous build and point `upgrade` at it. A rollback is only safe if
the migration was reversible: `migrate` moves stored data forward, and the older
code may not understand what the newer `migrate` wrote. Prefer forward fixes,
and record what each `migrate` changed.

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

## Testing an upgrade

- `tests/upgrade_tests.rs` covers all seven contracts: version recorded at
  `initialize`, `migrate` reporting and idempotency, non-admin rejection of both
  admin entrypoints, rejection of an unknown wasm hash, and a real code swap
  through the host deployer (the contract's entrypoints stop existing, while the
  address and storage survive).
- Run `cargo test --test upgrade_tests`.
- The test builds the "replacement" wasm bytes in-process
  (`empty_contract_wasm`), so it needs no build artefact and runs in CI.
