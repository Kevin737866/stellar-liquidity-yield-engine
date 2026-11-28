use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _,
    },
    Address, Bytes, Env, Symbol,
};
use stellar_liquidity_yield_engine::{
    StellarLiquidityYieldEngine, StellarLiquidityYieldEngineClient,
};

const MIN_PERSISTENT_TTL: u32 = 500;
const THRESHOLD: u32 = 1_000;
const EXTEND_TO: u32 = 5_000;

fn ttl_env() -> Env {
    let env = Env::default();
    env.ledger().with_mut(|li| {
        li.sequence_number = 100_000;
        li.min_persistent_entry_ttl = MIN_PERSISTENT_TTL;
        li.max_entry_ttl = 10_000;
    });
    env
}

fn key(env: &Env) -> Symbol {
    Symbol::new(env, "ttl_probe")
}

fn with_persistent_entry(env: &Env) -> Address {
    let contract_id = env.register(StellarLiquidityYieldEngine, ());
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&key(env), &1u32);
    });
    contract_id
}

fn advance(env: &Env, ledgers: u64) {
    env.ledger().with_mut(|li| li.sequence_number += ledgers);
}

fn renew(env: &Env, contract_id: &Address) {
    env.as_contract(contract_id, || {
        env.storage().instance().extend_ttl(THRESHOLD, EXTEND_TO);
        env.storage()
            .persistent()
            .extend_ttl(&key(env), THRESHOLD, EXTEND_TO);
    });
}

fn ttls(env: &Env, contract_id: &Address) -> (u32, u32) {
    env.as_contract(contract_id, || {
        (
            env.storage().instance().get_ttl(),
            env.storage().persistent().get_ttl(&key(env)),
        )
    })
}

#[test]
fn entries_start_with_the_network_minimum_ttl() {
    let env = ttl_env();
    let contract_id = with_persistent_entry(&env);

    let (instance, persistent) = ttls(&env, &contract_id);
    assert_eq!(instance, MIN_PERSISTENT_TTL - 1);
    assert_eq!(persistent, MIN_PERSISTENT_TTL - 1);
}

#[test]
fn renewal_is_a_floor_and_the_threshold_is_strict() {
    let env = ttl_env();
    let contract_id = with_persistent_entry(&env);

    renew(&env, &contract_id);
    assert_eq!(ttls(&env, &contract_id), (EXTEND_TO, EXTEND_TO));

    advance(&env, u64::from(EXTEND_TO - THRESHOLD));
    assert_eq!(ttls(&env, &contract_id), (THRESHOLD, THRESHOLD));

    renew(&env, &contract_id);
    assert_eq!(ttls(&env, &contract_id), (THRESHOLD, THRESHOLD));

    advance(&env, 1);
    renew(&env, &contract_id);
    assert_eq!(ttls(&env, &contract_id), (EXTEND_TO, EXTEND_TO));
}

#[test]
fn archived_persistent_entry_can_be_restored_by_renewal() {
    let env = ttl_env();
    let contract_id = with_persistent_entry(&env);

    advance(&env, u64::from(MIN_PERSISTENT_TTL));

    env.as_contract(&contract_id, || {
        assert_eq!(env.storage().persistent().get_ttl(&key(&env)), 0);
        env.storage()
            .persistent()
            .extend_ttl(&key(&env), THRESHOLD, EXTEND_TO);
        assert_eq!(env.storage().persistent().get_ttl(&key(&env)), EXTEND_TO);
    });
}

fn empty_contract_wasm(env: &Env) -> Bytes {
    let mut module: std::vec::Vec<u8> =
        std::vec![0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00,];

    let name = b"contractenvmetav0";
    let mut body: std::vec::Vec<u8> = std::vec::Vec::new();
    body.push(name.len() as u8);
    body.extend_from_slice(name);
    body.extend_from_slice(&[0u8; 12]);

    module.push(body.len() as u8);
    module.extend_from_slice(&body);

    Bytes::from_slice(env, &module)
}

#[test]
fn upgrade_preserves_instance_ttl_and_allows_renewal() {
    let env = ttl_env();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let contract_id = env.register(StellarLiquidityYieldEngine, ());
    let client = StellarLiquidityYieldEngineClient::new(&env, &contract_id);
    client.initialize(&admin, &Address::generate(&env), &Address::generate(&env));
    env.as_contract(&contract_id, || {
        env.storage().persistent().set(&key(&env), &1u32);
    });

    let before = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    let hash = env
        .deployer()
        .upload_contract_wasm(empty_contract_wasm(&env));
    client.upgrade(&admin, &hash);

    let after = env.as_contract(&contract_id, || env.storage().instance().get_ttl());
    assert_eq!(after, before);

    renew(&env, &contract_id);
    assert_eq!(
        env.as_contract(&contract_id, || { env.storage().instance().get_ttl() }),
        EXTEND_TO
    );
}
