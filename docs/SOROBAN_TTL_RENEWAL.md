# Soroban TTL renewal operations

Issue: [#505](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/505).

This document covers the operator steps needed to keep deployed contracts alive
across upgrades and re-deployments. It complements
[UPGRADING.md](UPGRADING.md), which covers the code swap and storage migration.

## What has a TTL

Every Soroban ledger entry has a time-to-live (TTL), measured in **ledgers from
the current ledger**. TTL is not a timestamp and it is not reset by `upgrade`.
An upgrade keeps the contract address, instance storage and balance, but the
new Wasm build is a **different code entry with its own TTL**.

| Entry | SDK surface | On expiry |
| --- | --- | --- |
| Contract instance, including all `instance()` data | `env.storage().instance()` | Archived; no entrypoint runs until restored |
| Contract Wasm code | `env.deployer()` / CLI `--wasm-hash` | Archived; the instance can no longer resolve its code |
| Persistent data keys | `env.storage().persistent()` | That key is archived; other keys are unaffected |
| Temporary data keys | `env.storage().temporary()` | Deleted permanently |

Most state in this repo is instance data (admin, pause flags, addresses,
version) or persistent data (emergency audit history, vault positions,
policies, strategies). Instance storage shares its TTL with the contract
instance; persistent keys each have their own TTL and must be renewed
individually.

## Extension semantics

Both storage and CLI renewal set a **floor**, not an exact value:

- `threshold` — extend only when the remaining TTL is **strictly below** this
  value. At or above the threshold the call is a no-op.
- `extend_to` — the minimum remaining TTL after renewal. Repeating an extension
  is harmless because an entry that already lives longer is left alone.
- `max_entry_ttl` — the network cap. `extend_to` above it is clamped on current
  protocols; older protocols reject the operation. Check the live network
  settings rather than assuming a fixed maximum.
- `get_ttl()` excludes the current ledger. An entry created with
  `min_persistent_entry_ttl = 500` reports `499` immediately after it is
  written.

Renewal costs both an inclusion fee and a resource fee. Restore costs rent as
well, so renewing before expiry is cheaper than recovering afterwards.

## In-contract API (reference only)

This crate does **not** add TTL entrypoints: the deployed ABI is unchanged and
existing clients keep working. Operators use the CLI or a transaction built
with an SDK. If a future contract does need self-service renewal, the SDK calls
are:

```rust
# use soroban_sdk::{Address, Env, Symbol};
fn renew(env: &Env, other_contract: &Address, key: &Symbol) {
    // Instance data and this contract's Wasm code.
    env.storage().instance().extend_ttl(1_000, 100_000);
    // One persistent key (repeat for each key that matters).
    env.storage().persistent().extend_ttl(key, 1_000, 100_000);
    // Another contract's instance and code, from a controlling contract.
    env.deployer().extend_ttl(other_contract.clone(), 1_000, 100_000);
}
```

`env.storage().instance().extend_ttl(...)` covers the instance (and therefore
all instance storage) but not arbitrary persistent keys.
`env.deployer().extend_ttl_for_code(...)` and
`extend_ttl_for_contract_instance(...)` are available when only one of the two
needs renewal.

## Operator commands

Set the common values once. `stellar` is the current CLI name; older installs
spell it `soroban` and use `--source` / `--network` in the same positions.

```bash
NETWORK=testnet
SOURCE=deployer
CONTRACT_ID=C...                 # the address being kept alive
WASM_HASH=...                    # hash printed by `contract install` / `deploy`
NEW_WASM_HASH=...                # hash of the build being upgraded to
TTL=535_679                      # example floor; check network limits
```

Renew the contract instance (covers every `instance()` key):

```bash
stellar contract extend \
  --source "$SOURCE" --network "$NETWORK" \
  --id "$CONTRACT_ID" --ledgers-to-extend "$TTL"
```

Renew a specific Wasm code entry — needed for the hash an upgrade will point
at, and again for the new hash after the swap:

```bash
stellar contract extend \
  --source "$SOURCE" --network "$NETWORK" \
  --wasm-hash "$NEW_WASM_HASH" --ledgers-to-extend "$TTL"
```

Renew a persistent data key. Use `--key` for `Symbol` keys and `--key-xdr` for
composite keys such as `(Symbol, u32)`:

```bash
stellar contract extend \
  --source "$SOURCE" --network "$NETWORK" \
  --id "$CONTRACT_ID" --key STORAGE_VERSION \
  --durability persistent --ledgers-to-extend "$TTL"
```

Archived persistent entries are restored automatically when a transaction
touches them in its footprint, but the rent is charged to that transaction and
an archived instance or code entry cannot run an entrypoint at all. Restore
explicitly before an upgrade:

```bash
stellar contract restore \
  --source "$SOURCE" --network "$NETWORK" \
  --id "$CONTRACT_ID" --durability persistent

stellar contract restore \
  --source "$SOURCE" --network "$NETWORK" \
  --wasm-hash "$WASM_HASH"
```

Add `--key KEY` or `--key-xdr XDR` to restore one persistent entry, and
`--ledgers-to-extend "$TTL"` to renew it in the same operation. Temporary
entries cannot be restored; once expired they are gone.

## Required checks around an upgrade

### Before `upgrade`

1. Renew the instance and the **new** wasm hash uploaded for the upgrade.
   Confirm both have more than the intended maintenance window remaining.
2. Renew the persistent keys the new build will read during `migrate`, at
   minimum the schema version key and any audit/history keys it walks.
3. Upload the previous wasm as well and note its hash for rollback. That hash
   needs its own code TTL if a rollback is attempted later.

### After `upgrade` / `migrate`

1. Renew the instance again and the hash now installed on the contract. The
   old hash no longer needs renewal unless it is still shared by another
   instance.
2. Re-read the keys touched by `migrate` and renew them if their TTL is close
   to the threshold.
3. Watch for `contract_upgraded` as described in [UPGRADING.md](UPGRADING.md);
   a missed renewal presents as "entry not found" rather than a TTL error.

### Re-deployment (Flow B in [UPGRADING.md](UPGRADING.md))

A new address starts with fresh instance and code TTLs, but every persistent
entry replayed into it is a new ledger entry with its own minimum TTL. Include
renewal of those keys in the cut-over checklist. If the old contract's audit
history must remain queryable, keep renewing the old instance and history keys
after freezing it; freezing is not archival.

## Automated coverage

`tests/ttl_renewal_tests.rs` pins the behaviour this document relies on:
minimum TTL on creation, strict threshold boundary, `extend_to` as a floor,
recovery of an archived persistent entry, and preservation of instance TTL
across a real code swap. It runs in the same CI job as the upgrade tests:

```bash
cargo test --test ttl_renewal_tests
```
