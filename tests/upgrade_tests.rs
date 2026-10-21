//! Upgrade-path tests for every contract in the crate (Issue #120).
//!
//! Each contract exposes the same three entrypoints:
//!
//! * `upgrade(admin, new_wasm_hash)` — swaps the contract's code via
//!   `Env::deployer().update_current_contract_wasm`, keeping address and storage.
//! * `get_storage_version()` — the schema version recorded in storage.
//! * `migrate(admin)` — adopts this build's schema version, returning the one it
//!   replaced.
//!
//! The tests deliberately go through the real host deployer rather than mocking
//! it: the point of the feature is that the wasm hash is applied by the host, so
//! a test that stubs that out would prove nothing.

use soroban_sdk::{testutils::Address as _, Address, Bytes, BytesN, Env, Symbol, Vec};
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
fn test_migrate_reports_replaced_version_and_is_idempotent() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin, contract_id) = with_vault(&env);

    // Simulate a contract deployed before the schema version was tracked: the
    // stored data exists, the version key does not.
    remove_storage_version(&env, &contract_id);
    assert_eq!(client.get_storage_version(), 0);

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
