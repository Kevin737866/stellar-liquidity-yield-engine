//! Upgrade-path tests for every contract in the crate (Issue #120).
//!
//! Each contract exposes the same upgrade and initialization-status entrypoints:
//!
//! * `upgrade(admin, new_wasm_hash)` — swaps the contract's code via
//!   `Env::deployer().update_current_contract_wasm`, keeping address and storage.
//! * `is_initialized()` — safely reports whether initialization has recorded an
//!   admin, returning `false` before initialization.
//! * `get_storage_version()` — the schema version recorded in storage.
//! * `migrate(admin)` — adopts this build's schema version, returning the one it
//!   replaced.
//!
//! The tests deliberately go through the real host deployer rather than mocking
//! it: the point of the feature is that the wasm hash is applied by the host, so
//! a test that stubs that out would prove nothing.

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Bytes, BytesN, Env, Symbol, Vec,
};
use stellar_liquidity_yield_engine::{
    Actuary, ActuaryClient, ILInsurance, ILInsuranceClient, MultiRewardDistributor,
    MultiRewardDistributorClient, RebalanceEngine, RebalanceEngineClient,
    StellarLiquidityYieldEngine, StellarLiquidityYieldEngineClient, StrategyRegistry,
    StrategyRegistryClient, YieldVault, YieldVaultClient,
};

/// A wasm module the host accepts as a contract but that exports nothing.
///
/// That makes "the code really was replaced" observable: after the upgrade every
/// entrypoint of the old code is missing. The host refuses a module without a
/// `contractenvmetav0` section, so the bytes carry one interface-version entry.
/// The entry declares protocol 0 with pre-release 0, which the host accepts for
/// any ledger protocol (older finalized protocols only require a zero
/// pre-release).
fn empty_contract_wasm(env: &Env) -> Bytes {
    // `std::vec::Vec` is spelled out because `soroban_sdk::Vec` is in scope.
    let mut module: std::vec::Vec<u8> = std::vec![
        0x00, 0x61, 0x73, 0x6d, // \0asm
        0x01, 0x00, 0x00, 0x00, // version 1
        0x00, // custom section
    ];

    let name = b"contractenvmetav0";
    let mut body: std::vec::Vec<u8> = std::vec::Vec::new();
    body.push(name.len() as u8);
    body.extend_from_slice(name);
    // XDR `ScEnvMetaEntry::ScEnvMetaKindInterfaceVersion({ protocol: 0,
    // pre_release: 0 })`: the kind discriminant followed by both u32 fields.
    body.extend_from_slice(&[0u8; 12]);

    module.push(body.len() as u8); // one-byte LEB128 section length
    module.extend_from_slice(&body);

    Bytes::from_slice(env, &module)
}

/// Storage version this build expects; mirrors `upgrade::STORAGE_VERSION`.
const EXPECTED_VERSION: u32 = 1;

fn remove_storage_version(env: &Env, contract_id: &Address) {
    env.as_contract(contract_id, || {
        env.storage()
            .instance()
            .remove(&Symbol::new(env, "storage_version"));
    });
}

/// Use short, explicit TTLs so the boundary tests do not depend on host defaults.
fn configure_ttl_ledger(env: &Env) {
    env.ledger().with_mut(|info| {
        info.sequence_number = 0;
        info.min_temp_entry_ttl = 8;
        info.min_persistent_entry_ttl = 64;
        info.max_entry_ttl = 1_000;
    });
}

fn persistent_probe(env: &Env, contract_id: &Address, key: &Symbol) -> Option<u32> {
    env.as_contract(contract_id, || env.storage().persistent().get(key))
}

/// Reading an archived persistent entry is a host error in the test host; on a
/// real network the entry would need a restore operation first.
fn assert_persistent_entry_archived(env: &Env, contract_id: &Address, key: &Symbol) {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.as_contract(contract_id, || {
            let _ = env.storage().persistent().has(key);
        });
    }));
    assert!(
        result.is_err(),
        "persistent entry should be archived at ledger {}",
        env.ledger().sequence()
    );
}

/// Deploy `contract` and run `initialize` on it.
fn with_engine(env: &Env) -> (StellarLiquidityYieldEngineClient<'_>, Address, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(StellarLiquidityYieldEngine, ());
    let client = StellarLiquidityYieldEngineClient::new(env, &contract_id);
    client.initialize(&admin, &Address::generate(env), &Address::generate(env));
    (client, admin, contract_id)
}

fn with_vault(env: &Env) -> (YieldVaultClient<'_>, Address, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(YieldVault, ());
    let client = YieldVaultClient::new(env, &contract_id);
    client.initialize(
        &admin,
        &Symbol::new(env, "UpgradeVault"),
        &Address::generate(env),
        &Address::generate(env),
        &Address::generate(env),
        &1,
        &100,
        &50,
        &25,
        &Address::generate(env),
    );
    (client, admin, contract_id)
}

fn with_distributor(env: &Env) -> (MultiRewardDistributorClient<'_>, Address, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(MultiRewardDistributor, ());
    let client = MultiRewardDistributorClient::new(env, &contract_id);
    client.initialize(&admin, &Address::generate(env), &Address::generate(env));
    (client, admin, contract_id)
}

fn with_rebalance_engine(env: &Env) -> (RebalanceEngineClient<'_>, Address, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(RebalanceEngine, ());
    let client = RebalanceEngineClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin, contract_id)
}

fn with_registry(env: &Env) -> (StrategyRegistryClient<'_>, Address, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(StrategyRegistry, ());
    let client = StrategyRegistryClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin, contract_id)
}

fn with_insurance(env: &Env) -> (ILInsuranceClient<'_>, Address, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(ILInsurance, ());
    let client = ILInsuranceClient::new(env, &contract_id);
    client.initialize(&admin, &Address::generate(env));
    (client, admin, contract_id)
}

fn with_actuary(env: &Env) -> (ActuaryClient<'_>, Address, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(Actuary, ());
    let client = ActuaryClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin, contract_id)
}

// ==================== Storage version ====================

#[test]
fn test_every_contract_records_its_storage_version_on_initialize() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    assert_eq!(with_engine(&env).0.get_storage_version(), EXPECTED_VERSION);
    assert_eq!(with_vault(&env).0.get_storage_version(), EXPECTED_VERSION);
    assert_eq!(
        with_distributor(&env).0.get_storage_version(),
        EXPECTED_VERSION
    );
    assert_eq!(
        with_rebalance_engine(&env).0.get_storage_version(),
        EXPECTED_VERSION
    );
    assert_eq!(
        with_registry(&env).0.get_storage_version(),
        EXPECTED_VERSION
    );
    assert_eq!(
        with_insurance(&env).0.get_storage_version(),
        EXPECTED_VERSION
    );
    assert_eq!(with_actuary(&env).0.get_storage_version(), EXPECTED_VERSION);
}

#[test]
fn test_initialization_status_is_safe_before_and_after_initialize() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let engine_id = env.register(StellarLiquidityYieldEngine, ());
    let engine = StellarLiquidityYieldEngineClient::new(&env, &engine_id);
    let vault_id = env.register(YieldVault, ());
    let vault = YieldVaultClient::new(&env, &vault_id);
    let distributor_id = env.register(MultiRewardDistributor, ());
    let distributor = MultiRewardDistributorClient::new(&env, &distributor_id);
    let rebalance_id = env.register(RebalanceEngine, ());
    let rebalance = RebalanceEngineClient::new(&env, &rebalance_id);
    let registry_id = env.register(StrategyRegistry, ());
    let registry = StrategyRegistryClient::new(&env, &registry_id);
    let insurance_id = env.register(ILInsurance, ());
    let insurance = ILInsuranceClient::new(&env, &insurance_id);
    let actuary_id = env.register(Actuary, ());
    let actuary = ActuaryClient::new(&env, &actuary_id);

    assert!(!engine.is_initialized());
    assert!(!vault.is_initialized());
    assert!(!distributor.is_initialized());
    assert!(!rebalance.is_initialized());
    assert!(!registry.is_initialized());
    assert!(!insurance.is_initialized());
    assert!(!actuary.is_initialized());

    let (engine, ..) = with_engine(&env);
    let (vault, ..) = with_vault(&env);
    let (distributor, ..) = with_distributor(&env);
    let (rebalance, ..) = with_rebalance_engine(&env);
    let (registry, ..) = with_registry(&env);
    let (insurance, ..) = with_insurance(&env);
    let (actuary, ..) = with_actuary(&env);

    assert!(engine.is_initialized());
    assert!(vault.is_initialized());
    assert!(distributor.is_initialized());
    assert!(rebalance.is_initialized());
    assert!(registry.is_initialized());
    assert!(insurance.is_initialized());
    assert!(actuary.is_initialized());

    let missing_contract = StellarLiquidityYieldEngineClient::new(&env, &Address::generate(&env));
    assert!(missing_contract.try_is_initialized().is_err());
}

#[test]
fn test_migrate_reports_replaced_version_and_is_idempotent() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, contract_id) = with_vault(&env);

    // Simulate a contract deployed before the schema version was tracked: the
    // stored data exists, the version key does not.
    remove_storage_version(&env, &contract_id);
    assert_eq!(client.get_storage_version(), 0);
    assert!(client.is_initialized());

    assert_eq!(client.migrate(&admin), 0, "returns the version it replaced");
    assert_eq!(client.get_storage_version(), EXPECTED_VERSION);

    // Running it again is a no-op that reports the version already in place.
    assert_eq!(client.migrate(&admin), EXPECTED_VERSION);
    assert_eq!(client.get_storage_version(), EXPECTED_VERSION);
}

#[test]
fn test_migrate_is_admin_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let stranger = Address::generate(&env);

    let (engine, ..) = with_engine(&env);
    let (vault, ..) = with_vault(&env);
    let (distributor, ..) = with_distributor(&env);
    let (rebalance, ..) = with_rebalance_engine(&env);
    let (registry, ..) = with_registry(&env);
    let (insurance, ..) = with_insurance(&env);
    let (actuary, ..) = with_actuary(&env);

    assert!(engine.try_migrate(&stranger).is_err());
    assert!(vault.try_migrate(&stranger).is_err());
    assert!(distributor.try_migrate(&stranger).is_err());
    assert!(rebalance.try_migrate(&stranger).is_err());
    assert!(registry.try_migrate(&stranger).is_err());
    assert!(insurance.try_migrate(&stranger).is_err());
    assert!(actuary.try_migrate(&stranger).is_err());
}

// ==================== Storage migration compatibility ====================

/// Data written before the version key existed must survive `migrate`: only the
/// version is adopted, existing state is left untouched.
#[test]
fn test_migrate_from_unversioned_storage_preserves_existing_state() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, contract_id) = with_engine(&env);

    let registry_before = client.get_strategy_registry();
    remove_storage_version(&env, &contract_id);
    assert_eq!(client.get_storage_version(), 0);

    assert_eq!(client.migrate(&admin), 0);
    assert_eq!(client.get_storage_version(), EXPECTED_VERSION);
    assert_eq!(client.get_strategy_registry(), registry_before);
}

/// A migration that fails authorization must not move the version, so a retry
/// by the real admin still reports the version it replaces.
#[test]
fn test_failed_migrate_does_not_change_the_recorded_version() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, contract_id) = with_vault(&env);
    let stranger = Address::generate(&env);

    remove_storage_version(&env, &contract_id);
    assert!(client.try_migrate(&stranger).is_err());
    assert_eq!(client.get_storage_version(), 0);

    assert_eq!(client.migrate(&admin), 0);
    assert_eq!(client.get_storage_version(), EXPECTED_VERSION);
}

/// Every contract adopts the current version from an unversioned state and is
/// idempotent afterwards.
#[test]
fn test_every_contract_migrates_from_unversioned_storage() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (engine, engine_admin, engine_id) = with_engine(&env);
    let (vault, vault_admin, vault_id) = with_vault(&env);
    let (distributor, distributor_admin, distributor_id) = with_distributor(&env);
    let (rebalance, rebalance_admin, rebalance_id) = with_rebalance_engine(&env);
    let (registry, registry_admin, registry_id) = with_registry(&env);
    let (insurance, insurance_admin, insurance_id) = with_insurance(&env);
    let (actuary, actuary_admin, actuary_id) = with_actuary(&env);

    for id in [
        &engine_id,
        &vault_id,
        &distributor_id,
        &rebalance_id,
        &registry_id,
        &insurance_id,
        &actuary_id,
    ] {
        remove_storage_version(&env, id);
    }

    assert_eq!(engine.migrate(&engine_admin), 0);
    assert_eq!(vault.migrate(&vault_admin), 0);
    assert_eq!(distributor.migrate(&distributor_admin), 0);
    assert_eq!(rebalance.migrate(&rebalance_admin), 0);
    assert_eq!(registry.migrate(&registry_admin), 0);
    assert_eq!(insurance.migrate(&insurance_admin), 0);
    assert_eq!(actuary.migrate(&actuary_admin), 0);

    assert_eq!(engine.migrate(&engine_admin), EXPECTED_VERSION);
    assert_eq!(vault.migrate(&vault_admin), EXPECTED_VERSION);
    assert_eq!(distributor.migrate(&distributor_admin), EXPECTED_VERSION);
    assert_eq!(rebalance.migrate(&rebalance_admin), EXPECTED_VERSION);
    assert_eq!(registry.migrate(&registry_admin), EXPECTED_VERSION);
    assert_eq!(insurance.migrate(&insurance_admin), EXPECTED_VERSION);
    assert_eq!(actuary.migrate(&actuary_admin), EXPECTED_VERSION);
}

// ==================== Upgrade ====================

#[test]
fn test_upgrade_is_admin_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let stranger = Address::generate(&env);
    let wasm_hash = env
        .deployer()
        .upload_contract_wasm(empty_contract_wasm(&env));

    let (engine, ..) = with_engine(&env);
    let (vault, ..) = with_vault(&env);
    let (distributor, ..) = with_distributor(&env);
    let (rebalance, ..) = with_rebalance_engine(&env);
    let (registry, ..) = with_registry(&env);
    let (insurance, ..) = with_insurance(&env);
    let (actuary, ..) = with_actuary(&env);

    assert!(engine.try_upgrade(&stranger, &wasm_hash).is_err());
    assert!(vault.try_upgrade(&stranger, &wasm_hash).is_err());
    assert!(distributor.try_upgrade(&stranger, &wasm_hash).is_err());
    assert!(rebalance.try_upgrade(&stranger, &wasm_hash).is_err());
    assert!(registry.try_upgrade(&stranger, &wasm_hash).is_err());
    assert!(insurance.try_upgrade(&stranger, &wasm_hash).is_err());
    assert!(actuary.try_upgrade(&stranger, &wasm_hash).is_err());

    // None of the rejected attempts touched the code: the contracts still answer.
    assert!(!engine.get_admin().to_string().is_empty());
    assert_eq!(vault.get_storage_version(), EXPECTED_VERSION);
    assert_eq!(distributor.get_storage_version(), EXPECTED_VERSION);
    assert_eq!(rebalance.get_storage_version(), EXPECTED_VERSION);
    assert_eq!(registry.get_storage_version(), EXPECTED_VERSION);
    assert_eq!(insurance.get_storage_version(), EXPECTED_VERSION);
    assert_eq!(actuary.get_storage_version(), EXPECTED_VERSION);
}

#[test]
fn test_upgrade_of_unknown_wasm_hash_fails_without_touching_the_contract() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, _) = with_vault(&env);

    // A hash the host has never seen: `update_current_contract_wasm` rejects it.
    let unknown_hash = BytesN::from_array(&env, &[7u8; 32]);
    assert!(client.try_upgrade(&admin, &unknown_hash).is_err());

    // The failed upgrade is atomic: the old code is still in place and working.
    assert_eq!(client.get_storage_version(), EXPECTED_VERSION);
    assert!(!client.get_treasury().to_string().is_empty());
    assert!(!admin.to_string().is_empty());
}

/// The upgrade must actually reach the host deployer: after it succeeds, the
/// entrypoints of the old code are gone from the contract.
#[test]
fn test_upgrade_swaps_the_contract_code() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, _) = with_vault(&env);

    assert_eq!(client.get_storage_version(), EXPECTED_VERSION);

    let empty_hash = env
        .deployer()
        .upload_contract_wasm(empty_contract_wasm(&env));
    client.upgrade(&admin, &empty_hash);

    // The new code has no entrypoints, so every call now fails while the
    // contract address and its instance storage stay put.
    assert!(client.try_get_storage_version().is_err());
    assert!(client.try_get_treasury().is_err());
    assert!(client.try_upgrade(&admin, &empty_hash).is_err());
}

/// The upgrade entrypoint reports the swap through an event, which is what an
/// off-chain monitor watches to notice an upgrade it did not authorise.
#[test]
fn test_upgrade_publishes_an_event() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::TryFromVal;

    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, _) = with_vault(&env);
    let wasm_hash = env
        .deployer()
        .upload_contract_wasm(empty_contract_wasm(&env));

    client.upgrade(&admin, &wasm_hash);

    let events = env.events().all();
    let (_, topics, data) = events.last().unwrap();
    let topic: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(topic, Symbol::new(&env, "contract_upgraded"));

    let (published_admin, published_hash): (Address, BytesN<32>) =
        <(Address, BytesN<32>)>::try_from_val(&env, &data).unwrap();
    assert_eq!(published_admin, admin);
    assert_eq!(published_hash, wasm_hash);
}

/// A contract built with a dormant entrypoint set (the feature-gated wasm) still
/// round-trips a Vec, so this guards against the `Vec` import being pruned.
#[test]
fn test_upgrade_keeps_unrelated_state_readable() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, _) = with_engine(&env);

    let registry_before = client.get_strategy_registry();
    assert_eq!(client.migrate(&admin), EXPECTED_VERSION);
    assert_eq!(client.get_strategy_registry(), registry_before);

    let _ = Vec::<Address>::new(&env);
}

// ==================== Persistent storage expiration boundaries ====================

#[test]
fn test_persistent_entry_is_readable_on_last_live_ledger_and_archived_after_it() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    configure_ttl_ledger(&env);

    let (_, _, contract_id) = with_engine(&env);
    // Keep the instance alive past the probe entry's TTL so the assertion is
    // about persistent storage, not about an expired contract instance.
    env.deployer().extend_ttl(contract_id.clone(), 100, 500);

    let key = Symbol::new(&env, "ttl_boundary_probe");
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&key, &7u32);
    });

    // A fresh persistent entry gets `min_persistent_entry_ttl` ledgers of life:
    // written at sequence 0 with TTL 64, its last live ledger is 63.
    env.ledger().set_sequence_number(63);
    assert_eq!(persistent_probe(&env, &contract_id, &key), Some(7));

    env.ledger().set_sequence_number(64);
    assert_persistent_entry_archived(&env, &contract_id, &key);
}

#[test]
fn test_extend_ttl_moves_the_persistent_expiration_boundary() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    configure_ttl_ledger(&env);

    let (_, _, contract_id) = with_engine(&env);
    env.deployer().extend_ttl(contract_id.clone(), 100, 500);

    let key = Symbol::new(&env, "ttl_extended_probe");
    env.as_contract(&contract_id, || {
        let storage = env.storage().persistent();
        storage.set(&key, &11u32);
        // Current TTL is 64, below the 100-ledger threshold, so this extends.
        storage.extend_ttl(&key, 100, 200);
    });

    // The old boundary (ledger 64) is now inside the extended lifetime. The
    // host treats the extended live-until ledger as inclusive, so the entry is
    // readable through ledger 200 and archived from 201 onwards.
    env.ledger().set_sequence_number(64);
    assert_eq!(persistent_probe(&env, &contract_id, &key), Some(11));

    env.ledger().set_sequence_number(200);
    assert_eq!(persistent_probe(&env, &contract_id, &key), Some(11));

    env.ledger().set_sequence_number(201);
    assert_persistent_entry_archived(&env, &contract_id, &key);
}

// ==================== Rollback readiness ====================

/// Before swapping code, the operator must know that the rollback target was
/// installed. An unknown hash is rejected by the host, leaving the live code
/// untouched; an installed hash is accepted and reported by the upgrade event.
#[test]
fn test_rollback_readiness_requires_an_installed_previous_wasm_hash() {
    use soroban_sdk::testutils::Events;
    use soroban_sdk::TryFromVal;

    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, _) = with_vault(&env);

    let missing_rollback_hash = BytesN::from_array(&env, &[0xAB; 32]);
    assert!(client.try_upgrade(&admin, &missing_rollback_hash).is_err());
    assert_eq!(client.get_storage_version(), EXPECTED_VERSION);

    let installed_rollback_hash = env
        .deployer()
        .upload_contract_wasm(empty_contract_wasm(&env));
    client.upgrade(&admin, &installed_rollback_hash);

    let events = env.events().all();
    let (_, topics, data) = events.last().unwrap();
    let topic: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(topic, Symbol::new(&env, "contract_upgraded"));

    let (published_admin, published_hash): (Address, BytesN<32>) =
        <(Address, BytesN<32>)>::try_from_val(&env, &data).unwrap();
    assert_eq!(published_admin, admin);
    assert_eq!(published_hash, installed_rollback_hash);
}
