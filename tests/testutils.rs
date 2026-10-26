use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env, Symbol, Vec as SorobanVec};
use stellar_liquidity_yield_engine::{RebalanceEngineClient, YieldVault, YieldVaultClient};

//// Rebalance engine helpers

pub fn setup_rebalance_engine(env: &Env) -> (RebalanceEngineClient, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register_contract(None, stellar_liquidity_yield_engine::RebalanceEngine);
    let client = RebalanceEngineClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin)
}

pub fn create_strategy(env: &Env, client: &RebalanceEngineClient, admin: &Address) -> u32 {
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

//// Yield vault fixture

//// Bundle of dependencies and actors created by the vault fixture.
//// Keeps the setup in one place so test modules can focus on behavior.
pub struct VaultFixture {
    pub vault: YieldVaultClient,
    pub token_a: TokenClient,
    pub token_b: TokenClient,
    pub token_a_admin: StellarAssetClient,
    pub token_b_admin: StellarAssetClient,
    pub user: Address,
    pub admin: Address,
    pub treasury: Address,
}

//// Deploy and initialize a YieldVault with two real tokens.
//// Uses the same default parameters as the integration tests.
pub fn setup_yield_vault(env: &Env) -> VaultFixture {
    let admin = Address::generate(env);
    let user = Address::generate(env);
    let treasury = Address::generate(env);
    let token_a = env.register_stellar_asset_contract_v2(admin.clone());
    let token_b = env.register_stellar_asset_contract_v2(admin.clone());
    let token_a_client = TokenClient::new(env, &token_a.address());
    let token_b_client = TokenClient::new(env, &token_b.address());
    let token_a_admin = StellarAssetClient::new(env, &token_a.address());
    let token_b_admin = StellarAssetClient::new(env, &token_b.address());
    let pool_id = Address::generate(env);

    let vault_id = env.register_contract(None, YieldVault);
    let vault = YieldVaultClient::new(env, &vault_id);

    vault.initialize(
        &admin,
        &Symbol::new(env, "TestVault"),
        &token_a.address(),
        &token_b.address(),
        &pool_id,
        &1,
        &100,
        &50,
        &25,
        &treasury,
    );

    VaultFixture {
        vault,
        token_a: token_a_client,
        token_b: token_b_client,
        token_a_admin,
        token_b_admin,
        user,
        admin,
        treasury,
    }
}

//// Fund an account with equal amounts of both vault tokens.
pub fn fund_vault_user(fixture: &VaultFixture, amount: &u64) {
    fixture.token_a_admin.mint(&fixture.user, amount);
    fixture.token_b_admin.mint(&fixture.user, amount);
}
