//! Release artifact checksum and provenance tests (Issue #513).
//!
//! Every contract exposes the same pair of entrypoints:
//!
//! * `record_release(admin, wasm_hash, artifact_checksum, release_version,
//!   source_commit)` — stores the checksum and provenance of the release
//!   artifact the contract runs (admin only).
//! * `get_release_record()` — returns that record, or `None` before the first
//!   one is written.
//!
//! The tests drive the generated clients rather than the helpers directly:
//! authorization and storage access both live behind the contract entrypoints.

use soroban_sdk::testutils::{Address as _, Events, Ledger as _};
use soroban_sdk::{Address, BytesN, Env, String, Symbol, TryFromVal};
use stellar_liquidity_yield_engine::upgrade::{ReleaseError, ReleaseRecord};
use stellar_liquidity_yield_engine::{
    Actuary, ActuaryClient, ILInsurance, ILInsuranceClient, MultiRewardDistributor,
    MultiRewardDistributorClient, RebalanceEngine, RebalanceEngineClient,
    StellarLiquidityYieldEngine, StellarLiquidityYieldEngineClient, StrategyRegistry,
    StrategyRegistryClient, YieldVault, YieldVaultClient,
};

const RELEASE_VERSION: &str = "v0.1.0";
const SOURCE_COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn checksum(env: &Env, fill: u8) -> BytesN<32> {
    BytesN::from_array(env, &[fill; 32])
}

fn version(env: &Env) -> String {
    String::from_str(env, RELEASE_VERSION)
}

fn commit(env: &Env) -> String {
    String::from_str(env, SOURCE_COMMIT)
}

// ==================== Fixtures ====================

fn with_engine(env: &Env) -> (StellarLiquidityYieldEngineClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(StellarLiquidityYieldEngine, ());
    let client = StellarLiquidityYieldEngineClient::new(env, &contract_id);
    client.initialize(&admin, &Address::generate(env), &Address::generate(env));
    (client, admin)
}

fn with_vault(env: &Env) -> (YieldVaultClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(YieldVault, ());
    let client = YieldVaultClient::new(env, &contract_id);
    client.initialize(
        &admin,
        &Symbol::new(env, "ReleaseVault"),
        &Address::generate(env),
        &Address::generate(env),
        &Address::generate(env),
        &1,
        &100,
        &50,
        &25,
        &Address::generate(env),
    );
    (client, admin)
}

fn with_distributor(env: &Env) -> (MultiRewardDistributorClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(MultiRewardDistributor, ());
    let client = MultiRewardDistributorClient::new(env, &contract_id);
    client.initialize(&admin, &Address::generate(env), &Address::generate(env));
    (client, admin)
}

fn with_rebalance_engine(env: &Env) -> (RebalanceEngineClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(RebalanceEngine, ());
    let client = RebalanceEngineClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin)
}

fn with_registry(env: &Env) -> (StrategyRegistryClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(StrategyRegistry, ());
    let client = StrategyRegistryClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin)
}

fn with_insurance(env: &Env) -> (ILInsuranceClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(ILInsurance, ());
    let client = ILInsuranceClient::new(env, &contract_id);
    client.initialize(&admin, &Address::generate(env));
    (client, admin)
}

fn with_actuary(env: &Env) -> (ActuaryClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(Actuary, ());
    let client = ActuaryClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin)
}

fn assert_record(
    env: &Env,
    record: &ReleaseRecord,
    admin: &Address,
    wasm_hash: &BytesN<32>,
    artifact_checksum: &BytesN<32>,
    expected_storage_version: u32,
) {
    assert_eq!(&record.wasm_hash, wasm_hash);
    assert_eq!(&record.artifact_checksum, artifact_checksum);
    assert_eq!(record.release_version, version(env));
    assert_eq!(record.source_commit, commit(env));
    assert_eq!(record.recorded_by, *admin);
    assert_eq!(record.storage_version, expected_storage_version);
}

// ==================== Recording across every contract ====================

#[test]
fn test_every_contract_records_release_checksum_and_provenance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let wasm_hash = checksum(&env, 1);
    let artifact_checksum = checksum(&env, 2);

    let (engine, engine_admin) = with_engine(&env);
    let (vault, vault_admin) = with_vault(&env);
    let (distributor, distributor_admin) = with_distributor(&env);
    let (rebalance, rebalance_admin) = with_rebalance_engine(&env);
    let (registry, registry_admin) = with_registry(&env);
    let (insurance, insurance_admin) = with_insurance(&env);
    let (actuary, actuary_admin) = with_actuary(&env);

    let record_release = || {
        (
            wasm_hash.clone(),
            artifact_checksum.clone(),
            version(&env),
            commit(&env),
        )
    };

    let (w, c, v, s) = record_release();
    let engine_record = engine.record_release(&engine_admin, &w, &c, &v, &s);
    assert_record(
        &env,
        &engine_record,
        &engine_admin,
        &wasm_hash,
        &artifact_checksum,
        1,
    );
    assert_eq!(engine.get_release_record().unwrap(), engine_record);

    let (w, c, v, s) = record_release();
    assert_record(
        &env,
        &vault.record_release(&vault_admin, &w, &c, &v, &s),
        &vault_admin,
        &wasm_hash,
        &artifact_checksum,
        1,
    );

    let (w, c, v, s) = record_release();
    assert_record(
        &env,
        &distributor.record_release(&distributor_admin, &w, &c, &v, &s),
        &distributor_admin,
        &wasm_hash,
        &artifact_checksum,
        1,
    );

    let (w, c, v, s) = record_release();
    assert_record(
        &env,
        &rebalance.record_release(&rebalance_admin, &w, &c, &v, &s),
        &rebalance_admin,
        &wasm_hash,
        &artifact_checksum,
        1,
    );

    let (w, c, v, s) = record_release();
    assert_record(
        &env,
        &registry.record_release(&registry_admin, &w, &c, &v, &s),
        &registry_admin,
        &wasm_hash,
        &artifact_checksum,
        1,
    );

    let (w, c, v, s) = record_release();
    assert_record(
        &env,
        &insurance.record_release(&insurance_admin, &w, &c, &v, &s),
        &insurance_admin,
        &wasm_hash,
        &artifact_checksum,
        1,
    );

    let (w, c, v, s) = record_release();
    assert_record(
        &env,
        &actuary.record_release(&actuary_admin, &w, &c, &v, &s),
        &actuary_admin,
        &wasm_hash,
        &artifact_checksum,
        1,
    );
}

// ==================== Empty state ====================

#[test]
fn test_release_record_is_none_until_it_is_recorded() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (engine, _) = with_engine(&env);
    let (vault, _) = with_vault(&env);
    let (distributor, _) = with_distributor(&env);
    let (rebalance, _) = with_rebalance_engine(&env);
    let (registry, _) = with_registry(&env);
    let (insurance, _) = with_insurance(&env);
    let (actuary, _) = with_actuary(&env);

    assert!(engine.get_release_record().is_none());
    assert!(vault.get_release_record().is_none());
    assert!(distributor.get_release_record().is_none());
    assert!(rebalance.get_release_record().is_none());
    assert!(registry.get_release_record().is_none());
    assert!(insurance.get_release_record().is_none());
    assert!(actuary.get_release_record().is_none());
}

// ==================== Authorization ====================

#[test]
fn test_record_release_is_admin_only() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let stranger = Address::generate(&env);
    let wasm_hash = checksum(&env, 1);
    let artifact_checksum = checksum(&env, 2);

    let (engine, ..) = with_engine(&env);
    let (vault, ..) = with_vault(&env);
    let (distributor, ..) = with_distributor(&env);
    let (rebalance, ..) = with_rebalance_engine(&env);
    let (registry, ..) = with_registry(&env);
    let (insurance, ..) = with_insurance(&env);
    let (actuary, ..) = with_actuary(&env);

    assert!(engine
        .try_record_release(
            &stranger,
            &wasm_hash,
            &artifact_checksum,
            &version(&env),
            &commit(&env)
        )
        .is_err());
    assert!(vault
        .try_record_release(
            &stranger,
            &wasm_hash,
            &artifact_checksum,
            &version(&env),
            &commit(&env)
        )
        .is_err());
    assert!(distributor
        .try_record_release(
            &stranger,
            &wasm_hash,
            &artifact_checksum,
            &version(&env),
            &commit(&env)
        )
        .is_err());
    assert!(rebalance
        .try_record_release(
            &stranger,
            &wasm_hash,
            &artifact_checksum,
            &version(&env),
            &commit(&env)
        )
        .is_err());
    assert!(registry
        .try_record_release(
            &stranger,
            &wasm_hash,
            &artifact_checksum,
            &version(&env),
            &commit(&env)
        )
        .is_err());
    assert!(insurance
        .try_record_release(
            &stranger,
            &wasm_hash,
            &artifact_checksum,
            &version(&env),
            &commit(&env)
        )
        .is_err());
    assert!(actuary
        .try_record_release(
            &stranger,
            &wasm_hash,
            &artifact_checksum,
            &version(&env),
            &commit(&env)
        )
        .is_err());

    // A rejected record writes nothing.
    assert!(engine.get_release_record().is_none());
    assert!(vault.get_release_record().is_none());
    assert!(distributor.get_release_record().is_none());
    assert!(rebalance.get_release_record().is_none());
    assert!(registry.get_release_record().is_none());
    assert!(insurance.get_release_record().is_none());
    assert!(actuary.get_release_record().is_none());
}

// ==================== Boundary and failure behaviour ====================

#[test]
fn test_record_release_rejects_empty_release_version() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (engine, admin) = with_engine(&env);

    let err = engine
        .try_record_release(
            &admin,
            &checksum(&env, 1),
            &checksum(&env, 2),
            &String::from_str(&env, ""),
            &commit(&env),
        )
        .unwrap_err()
        .unwrap();

    assert_eq!(err, ReleaseError::EmptyReleaseVersion.into());
    assert!(engine.get_release_record().is_none());
}

#[test]
fn test_record_release_rejects_empty_source_commit() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (engine, admin) = with_engine(&env);

    let err = engine
        .try_record_release(
            &admin,
            &checksum(&env, 1),
            &checksum(&env, 2),
            &version(&env),
            &String::from_str(&env, ""),
        )
        .unwrap_err()
        .unwrap();

    assert_eq!(err, ReleaseError::EmptySourceCommit.into());
    assert!(engine.get_release_record().is_none());
}

#[test]
fn test_record_release_rejects_zero_artifact_checksum() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (engine, admin) = with_engine(&env);

    let err = engine
        .try_record_release(
            &admin,
            &checksum(&env, 1),
            &checksum(&env, 0),
            &version(&env),
            &commit(&env),
        )
        .unwrap_err()
        .unwrap();

    assert_eq!(err, ReleaseError::ZeroArtifactChecksum.into());
    assert!(engine.get_release_record().is_none());
}

#[test]
fn test_record_release_rejects_zero_wasm_hash() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (engine, admin) = with_engine(&env);

    let err = engine
        .try_record_release(
            &admin,
            &checksum(&env, 0),
            &checksum(&env, 2),
            &version(&env),
            &commit(&env),
        )
        .unwrap_err()
        .unwrap();

    assert_eq!(err, ReleaseError::ZeroWasmHash.into());
    assert!(engine.get_release_record().is_none());
}

// ==================== Re-recording and metadata ====================

#[test]
fn test_recording_a_new_release_replaces_the_previous_record() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, admin) = with_vault(&env);

    let first_checksum = checksum(&env, 2);
    let first = vault.record_release(
        &admin,
        &checksum(&env, 1),
        &first_checksum,
        &String::from_str(&env, "v0.1.0"),
        &commit(&env),
    );
    assert_eq!(first.release_version, String::from_str(&env, "v0.1.0"));

    let second_checksum = checksum(&env, 3);
    let second = vault.record_release(
        &admin,
        &checksum(&env, 4),
        &second_checksum,
        &String::from_str(&env, "v0.2.0"),
        &String::from_str(&env, "fedcba9876543210fedcba9876543210fedcba98"),
    );

    assert_eq!(vault.get_release_record().unwrap(), second);
    assert_ne!(first.artifact_checksum, second.artifact_checksum);
    assert_eq!(second.artifact_checksum, second_checksum);
    assert_eq!(
        second.source_commit,
        String::from_str(&env, "fedcba9876543210fedcba9876543210fedcba98")
    );
}

#[test]
fn test_release_record_captures_ledger_and_recording_build() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().set_sequence_number(42);
    env.ledger().set_timestamp(1_700_000_000);

    let (engine, admin) = with_engine(&env);
    let record = engine.record_release(
        &admin,
        &checksum(&env, 1),
        &checksum(&env, 2),
        &version(&env),
        &commit(&env),
    );

    assert_eq!(record.ledger, 42);
    assert_eq!(record.recorded_at, 1_700_000_000);
    // `initialize` records the schema version of the deploying build.
    assert_eq!(record.storage_version, engine.get_storage_version());
}

#[test]
fn test_recording_a_release_publishes_an_event() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (engine, admin) = with_engine(&env);

    let wasm_hash = checksum(&env, 1);
    let artifact_checksum = checksum(&env, 2);
    engine.record_release(
        &admin,
        &wasm_hash,
        &artifact_checksum,
        &version(&env),
        &commit(&env),
    );

    let events = env.events().all();
    let (_, topics, data) = events.last().unwrap();

    let topic: Symbol = Symbol::try_from_val(&env, &topics.get(0).unwrap()).unwrap();
    assert_eq!(topic, Symbol::new(&env, "release_recorded"));

    let (published_admin, published_wasm_hash, published_checksum, published_version): (
        Address,
        BytesN<32>,
        BytesN<32>,
        String,
    ) = <(Address, BytesN<32>, BytesN<32>, String)>::try_from_val(&env, &data).unwrap();

    assert_eq!(published_admin, admin);
    assert_eq!(published_wasm_hash, wasm_hash);
    assert_eq!(published_checksum, artifact_checksum);
    assert_eq!(published_version, version(&env));
}
