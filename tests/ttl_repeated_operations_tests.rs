//! Repeated-operation TTL coverage for persistent contract state.
//!
//! `ILInsurance` writes one persistent entry per policy and keeps its mutable
//! counters in instance storage. Buying policies over many ledgers is therefore
//! a realistic stand-in for a keeper that writes state repeatedly: without
//! renewal the first policy and eventually the instance are archived.
//!
//! The tests cover three cases:
//!
//! * normal — renewing after every operation keeps all earlier policies alive;
//! * boundary — repeated renewals never raise TTL beyond the configured floor,
//!   and a pass below the threshold restores that floor;
//! * failure — after TTL expiry, repeated reads of the persistent entry fail
//!   while the still-live instance keeps answering unrelated calls.

use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _,
    },
    token::StellarAssetClient,
    Address, Env,
};
use stellar_liquidity_yield_engine::{ILInsurance, ILInsuranceClient, COVERAGE_30D};

const MIN_PERSISTENT_TTL: u32 = 64;
const THRESHOLD: u32 = 100;
const EXTEND_TO: u32 = 200;
const LEDGERS_PER_OPERATION: u32 = 20;
const OPERATIONS: u64 = 6;

fn ttl_env() -> Env {
    let env = Env::default();
    env.ledger().with_mut(|info| {
        info.sequence_number = 1_000;
        info.min_temp_entry_ttl = 8;
        info.min_persistent_entry_ttl = MIN_PERSISTENT_TTL;
        info.max_entry_ttl = 1_000;
    });
    env
}

struct InsuranceFixture<'a> {
    client: ILInsuranceClient<'a>,
    contract_id: Address,
    token_id: Address,
    buyer: Address,
}

fn setup<'a>(env: &'a Env) -> InsuranceFixture<'a> {
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(env);
    let buyer = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = token.address();
    StellarAssetClient::new(env, &token_id).mint(&buyer, &10_000_000);

    let contract_id = env.register(ILInsurance, ());
    let client = ILInsuranceClient::new(env, &contract_id);
    client.initialize(&admin, &token_id);

    // Keep the token contract alive too: a premium transfer is part of every
    // purchase, so its TTL must outlast the whole sequence of operations.
    env.deployer()
        .extend_ttl(token_id.clone(), THRESHOLD, EXTEND_TO);

    InsuranceFixture {
        client,
        contract_id,
        token_id,
        buyer,
    }
}

fn advance(env: &Env, ledgers: u32) {
    env.ledger()
        .with_mut(|info| info.sequence_number += ledgers);
}

fn purchase(fixture: &InsuranceFixture<'_>) -> u64 {
    fixture.client.purchase_insurance(
        &fixture.buyer,
        &1_000_000,
        &COVERAGE_30D,
        &1_000_000,
        &8_000,
        &5_000,
        &false,
        &fixture.token_id,
    )
}

fn renew_instance(env: &Env, contract_id: &Address) {
    env.as_contract(contract_id, || {
        env.storage().instance().extend_ttl(THRESHOLD, EXTEND_TO);
    });
}

fn renew_policy(env: &Env, contract_id: &Address, policy_id: u64) {
    env.as_contract(contract_id, || {
        env.storage()
            .persistent()
            .extend_ttl(&policy_id, THRESHOLD, EXTEND_TO);
    });
}

fn policy_ttl(env: &Env, contract_id: &Address, policy_id: u64) -> u32 {
    env.as_contract(contract_id, || {
        env.storage().persistent().get_ttl(&policy_id)
    })
}

/// The test host turns an archived entry into either a failed `try_*` call or
/// a panic, depending on where it is hit. Both mean the operation was blocked.
fn invoke_fails<T, E>(call: impl FnOnce() -> Result<T, E>) -> bool {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)) {
        Ok(result) => result.is_err(),
        Err(_) => true,
    }
}

#[test]
fn repeated_purchases_keep_earlier_policies_alive_when_renewed() {
    let env = ttl_env();
    let fixture = setup(&env);
    let mut policy_ids = Vec::new();

    for _ in 0..OPERATIONS {
        advance(&env, LEDGERS_PER_OPERATION);
        renew_instance(&env, &fixture.contract_id);

        let policy_id = purchase(&fixture);
        renew_policy(&env, &fixture.contract_id, policy_id);
        policy_ids.push(policy_id);

        assert_eq!(fixture.client.get_policy(&policy_id).policy_id, policy_id);
        assert!(policy_ttl(&env, &fixture.contract_id, policy_id) >= THRESHOLD);
        let instance_ttl =
            env.as_contract(&fixture.contract_id, || env.storage().instance().get_ttl());
        assert!(instance_ttl >= THRESHOLD);
    }

    // Every step advanced beyond the first policy's original lifetime. Only
    // repeated renewal explains why the whole history is still readable.
    assert!(env.ledger().sequence() - 1_000 > MIN_PERSISTENT_TTL);
    assert_eq!(fixture.client.reserve_pool().policy_count, OPERATIONS);
    for policy_id in policy_ids {
        assert_eq!(fixture.client.get_policy(&policy_id).policy_id, policy_id);
    }
}

#[test]
fn renewal_is_a_floor_across_repeated_calls() {
    let env = ttl_env();
    let fixture = setup(&env);
    let policy_id = purchase(&fixture);

    renew_policy(&env, &fixture.contract_id, policy_id);
    assert_eq!(policy_ttl(&env, &fixture.contract_id, policy_id), EXTEND_TO);

    // While the entry is comfortably above the threshold, a maintenance pass
    // must not extend it further than the configured floor.
    for _ in 0..3 {
        renew_policy(&env, &fixture.contract_id, policy_id);
        assert_eq!(policy_ttl(&env, &fixture.contract_id, policy_id), EXTEND_TO);
    }

    // Once the TTL drops below the threshold, one pass restores the floor and
    // later passes leave that floor untouched.
    let elapsed = EXTEND_TO - THRESHOLD + 1;
    renew_instance(&env, &fixture.contract_id);
    advance(&env, elapsed);
    assert_eq!(
        policy_ttl(&env, &fixture.contract_id, policy_id),
        EXTEND_TO - elapsed
    );
    renew_policy(&env, &fixture.contract_id, policy_id);
    assert_eq!(policy_ttl(&env, &fixture.contract_id, policy_id), EXTEND_TO);
    renew_policy(&env, &fixture.contract_id, policy_id);
    assert_eq!(policy_ttl(&env, &fixture.contract_id, policy_id), EXTEND_TO);
}

#[test]
fn missing_renewal_blocks_repeated_reads_after_the_entry_expires() {
    let env = ttl_env();
    let fixture = setup(&env);
    let policy_id = purchase(&fixture);
    assert!(fixture.client.try_get_policy(&policy_id).is_ok());

    // Only the persistent key is allowed to expire: the instance stays alive
    // so the failure is attributable to the missing data-key renewal.
    renew_instance(&env, &fixture.contract_id);
    advance(&env, MIN_PERSISTENT_TTL + 1);
    for _ in 0..2 {
        assert!(invoke_fails(|| fixture.client.try_get_policy(&policy_id)));
        assert!(fixture.client.try_reserve_pool().is_ok());
    }
}
