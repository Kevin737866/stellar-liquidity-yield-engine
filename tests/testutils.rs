use soroban_sdk::{Address, Env, Symbol, Vec as SorobanVec};

pub fn setup_rebalance_engine(env: &Env) -> (RebalanceEngineClient, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register_contract(None, stellar_liquidity_yield_engine::RebalanceEngine);
    let client = RebalanceEngineClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin)
}

pub fn create_strategy(
    env: &Env,
    client: &RebalanceEngineClient,
    admin: &Address,
) -> u32 {
    let token_a = Address::generate(env);
    let token_b = Address::generate(env);
    let mut allocations = SorobanVec::new(env);
    allocations.push_back(stellar_liquidity_yield_engine::PoolAllocation {
        pool_id: Address::generate(env),
        token_a: token_a.clone(),
        token_b: token_b.clone(),
        allocation_percent: 5000,
        target_apy: 2000,
        current_apy: 1500,
        impermanent_loss_risk: 100,
    });

    client.create_strategy(
        admin,
        Symbol::new(env, "TestStrategy"),
        2,
        200,
        100,
        86400,
        allocations,
    )
}
