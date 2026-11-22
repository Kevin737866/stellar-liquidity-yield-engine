use soroban_sdk::{testutils::Address as _, Address, Env};
use stellar_liquidity_yield_engine::{
    EngineError, RebalanceEngine, RebalanceEngineClient, StellarLiquidityYieldEngine,
    StellarLiquidityYieldEngineClient,
};

fn setup_engine<'a>(
    env: &'a Env,
    admin: &Address,
) -> StellarLiquidityYieldEngineClient<'a> {
    let contract_id = env.register_contract(None, StellarLiquidityYieldEngine);
    let client = StellarLiquidityYieldEngineClient::new(env, &contract_id);
    client.initialize(admin, &Address::generate(env), &Address::generate(env));
    client
}

fn setup_rebalance_engine<'a>(env: &'a Env, admin: &Address) -> RebalanceEngineClient<'a> {
    let contract_id = env.register_contract(None, RebalanceEngine);
    let client = RebalanceEngineClient::new(env, &contract_id);
    client.initialize(admin);
    client
}

#[test]
fn admin_handoff_updates_only_the_target_contract_role() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let former_admin = Address::generate(&env);
    let successor = Address::generate(&env);
    let engine = setup_engine(&env, &former_admin);
    let rebalance = setup_rebalance_engine(&env, &former_admin);

    engine.update_admin(&former_admin, &successor);
    assert_eq!(engine.get_admin(), successor);

    assert_eq!(
        engine.try_pause(&former_admin).unwrap_err().unwrap(),
        EngineError::Unauthorized.into()
    );
    engine.pause(&successor);
    assert!(engine.is_paused());

    // Each contract stores its admin independently; rotating the engine's
    // admin must neither transfer nor revoke the rebalance engine's role.
    assert_eq!(
        rebalance.try_pause(&successor).unwrap_err().unwrap(),
        stellar_liquidity_yield_engine::RebalanceError::Unauthorized.into()
    );
    rebalance.pause(&former_admin);
    assert!(rebalance.is_paused());
}

#[test]
fn unauthorized_admin_change_preserves_the_current_role() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let unauthorized = Address::generate(&env);
    let attempted_successor = Address::generate(&env);
    let engine = setup_engine(&env, &admin);

    assert_eq!(
        engine
            .try_update_admin(&unauthorized, &attempted_successor)
            .unwrap_err()
            .unwrap(),
        EngineError::Unauthorized.into()
    );
    assert_eq!(engine.get_admin(), admin);
    engine.pause(&admin);
    assert!(engine.is_paused());
}

#[test]
fn transferring_admin_role_to_itself_preserves_access() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let admin = Address::generate(&env);
    let other = Address::generate(&env);
    let engine = setup_engine(&env, &admin);

    engine.update_admin(&admin, &admin);

    assert_eq!(engine.get_admin(), admin);
    assert_eq!(
        engine.try_pause(&other).unwrap_err().unwrap(),
        EngineError::Unauthorized.into()
    );
    engine.pause(&admin);
    assert!(engine.is_paused());
}
