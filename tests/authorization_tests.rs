use soroban_sdk::{Address, Env, Symbol, Vec as SorobanVec, testutils::Address as _};
use stellar_liquidity_yield_engine::{
    RebalanceEngine, RebalanceEngineClient,
    YieldVault, YieldVaultClient,
    StrategyRegistry, StrategyRegistryClient,
    SwapRouter, SwapRouterClient,
    MultiRewardDistributor, MultiRewardDistributorClient,
    StellarLiquidityYieldEngine, StellarLiquidityYieldEngineClient,
};

fn main() {}

mod tests {
    use super::*;
    use soroban_sdk::token::{StellarAssetClient, TokenClient};

    // ==================== RebalanceEngine Authorization ====================

    #[test]
    fn test_rebalance_engine_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, RebalanceEngine);
        let client = RebalanceEngineClient::new(&env, &contract_id);
        client.initialize(&admin);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.pause(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to pause rebalance engine");
        assert!(!client.is_paused(), "Engine should remain unpaused");
    }

    #[test]
    fn test_rebalance_engine_non_admin_cannot_unpause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, RebalanceEngine);
        let client = RebalanceEngineClient::new(&env, &contract_id);
        client.initialize(&admin);

        client.pause(&admin);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.unpause(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to unpause rebalance engine");
        assert!(client.is_paused(), "Engine should remain paused");
    }

    #[test]
    fn test_rebalance_engine_non_admin_cannot_set_thresholds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, RebalanceEngine);
        let client = RebalanceEngineClient::new(&env, &contract_id);
        client.initialize(&admin);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_rebalance_thresholds(&non_admin, 300, 150, 43200);
        }));
        assert!(result.is_err(), "Non-admin should not be able to set rebalance thresholds");
    }

    // ==================== YieldVault Authorization ====================

    #[test]
    fn test_yield_vault_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let user = Address::generate(&env);
        let token_a = env.register_stellar_asset_contract_v2(admin.clone());
        let token_b = env.register_stellar_asset_contract_v2(admin.clone());
        let pool_id = Address::generate(&env);

        let vault_id = env.register_contract(None, YieldVault);
        let vault = YieldVaultClient::new(&env, &vault_id);
        vault.initialize(
            &admin,
            &Symbol::new(&env, "TestVault"),
            &token_a.address(),
            &token_b.address(),
            &pool_id,
            &1,
            &100,
            &50,
            &25,
            &non_admin, // treasury
        );

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.pause(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to pause yield vault");
    }

    #[test]
    fn test_yield_vault_non_admin_cannot_unpause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let token_a = env.register_stellar_asset_contract_v2(admin.clone());
        let token_b = env.register_stellar_asset_contract_v2(admin.clone());
        let pool_id = Address::generate(&env);

        let vault_id = env.register_contract(None, YieldVault);
        let vault = YieldVaultClient::new(&env, &vault_id);
        vault.initialize(
            &admin,
            &Symbol::new(&env, "TestVault"),
            &token_a.address(),
            &token_b.address(),
            &pool_id,
            &1,
            &100,
            &50,
            &25,
            &non_admin,
        );

        vault.pause(&admin);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.unpause(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to unpause yield vault");
        assert!(vault.is_paused(), "Vault should remain paused");
    }

    // ==================== StrategyRegistry Authorization ====================

    #[test]
    fn test_strategy_registry_non_admin_cannot_approve_strategy() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, StrategyRegistry);
        let client = StrategyRegistryClient::new(&env, &contract_id);
        client.initialize(&admin);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.approve_strategy(&non_admin, &1, &Symbol::new(&env, "No"));
        }));
        assert!(result.is_err(), "Non-admin should not be able to approve strategies");
    }

    #[test]
    fn test_strategy_registry_non_admin_cannot_deactivate_strategy() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, StrategyRegistry);
        let client = StrategyRegistryClient::new(&env, &contract_id);
        client.initialize(&admin);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.deactivate_strategy(&non_admin, &1);
        }));
        assert!(result.is_err(), "Non-admin should not be able to deactivate strategies");
    }

    #[test]
    fn test_strategy_registry_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, StrategyRegistry);
        let client = StrategyRegistryClient::new(&env, &contract_id);
        client.initialize(&admin);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.pause(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to pause strategy registry");
    }

    // ==================== SwapRouter Authorization ====================

    #[test]
    fn test_swap_router_non_admin_cannot_add_pool() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        let treasury = Address::generate(&env);
        let xlm = Address::generate(&env);
        client.initialize(&admin, &treasury, &xlm);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.add_pool(&non_admin, &Address::generate(&env), &Address::generate(&env), &Address::generate(&env), &100, &false);
        }));
        assert!(result.is_err(), "Non-admin should not be able to add pools");
    }

    #[test]
    fn test_swap_router_non_admin_cannot_remove_pool() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        let treasury = Address::generate(&env);
        let xlm = Address::generate(&env);
        client.initialize(&admin, &treasury, &xlm);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.remove_pool(&non_admin, &Address::generate(&env));
        }));
        assert!(result.is_err(), "Non-admin should not be able to remove pools");
    }

    #[test]
    fn test_swap_router_non_admin_cannot_update_treasury() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        let treasury = Address::generate(&env);
        let xlm = Address::generate(&env);
        client.initialize(&admin, &treasury, &xlm);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_treasury(&non_admin, &Address::generate(&env));
        }));
        assert!(result.is_err(), "Non-admin should not be able to update treasury");
    }

    // ==================== MultiRewardDistributor Authorization ====================

    #[test]
    fn test_reward_distributor_non_admin_cannot_add_stream() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, MultiRewardDistributor);
        let client = MultiRewardDistributorClient::new(&env, &contract_id);
        let treasury = Address::generate(&env);
        let swap_router = Address::generate(&env);
        client.initialize(&admin, &treasury, &swap_router);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.add_reward_stream(&non_admin, &Address::generate(&env), &1000, &7);
        }));
        assert!(result.is_err(), "Non-admin should not be able to add reward streams");
    }

    #[test]
    fn test_reward_distributor_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, MultiRewardDistributor);
        let client = MultiRewardDistributorClient::new(&env, &contract_id);
        let treasury = Address::generate(&env);
        let swap_router = Address::generate(&env);
        client.initialize(&admin, &treasury, &swap_router);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.pause(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to pause reward distributor");
    }

    #[test]
    fn test_reward_distributor_non_admin_cannot_enable_emergency_mode() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let contract_id = env.register_contract(None, MultiRewardDistributor);
        let client = MultiRewardDistributorClient::new(&env, &contract_id);
        let treasury = Address::generate(&env);
        let swap_router = Address::generate(&env);
        client.initialize(&admin, &treasury, &swap_router);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.enable_emergency_mode(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to enable emergency mode");
    }

    // ==================== StellarLiquidityYieldEngine Authorization ====================

    #[test]
    fn test_main_engine_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let strategy_registry = Address::generate(&env);
        let reward_distributor = Address::generate(&env);
        let contract_id = env.register_contract(None, StellarLiquidityYieldEngine);
        let client = StellarLiquidityYieldEngineClient::new(&env, &contract_id);
        client.initialize(&admin, &strategy_registry, &reward_distributor);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.pause(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to pause main engine");
    }

    #[test]
    fn test_main_engine_non_admin_cannot_update_admin() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let strategy_registry = Address::generate(&env);
        let reward_distributor = Address::generate(&env);
        let contract_id = env.register_contract(None, StellarLiquidityYieldEngine);
        let client = StellarLiquidityYieldEngineClient::new(&env, &contract_id);
        client.initialize(&admin, &strategy_registry, &reward_distributor);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_admin(&non_admin, &new_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to update admin");
    }

    // ==================== Governance Authorization ====================

    #[test]
    fn test_protocol_governor_non_admin_cannot_set_fees() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let timelock = Address::generate(&env);
        let mut emergency_multisig = SorobanVec::new(&env);
        for _ in 0..5 {
            emergency_multisig.push_back(Address::generate(&env));
        }
        let contract_id = env.register_contract(None, stellar_liquidity_yield_engine::ProtocolGovernor);
        let client = stellar_liquidity_yield_engine::ProtocolGovernorClient::new(&env, &contract_id);
        client.initialize(&timelock, &admin, &emergency_multisig);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_performance_fee(&non_admin, &1000);
        }));
        assert!(result.is_err(), "Non-admin should not be able to set performance fee");
    }

    #[test]
    fn test_protocol_governor_non_admin_cannot_set_rebalance_threshold() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let timelock = Address::generate(&env);
        let mut emergency_multisig = SorobanVec::new(&env);
        for _ in 0..5 {
            emergency_multisig.push_back(Address::generate(&env));
        }
        let contract_id = env.register_contract(None, stellar_liquidity_yield_engine::ProtocolGovernor);
        let client = stellar_liquidity_yield_engine::ProtocolGovernorClient::new(&env, &contract_id);
        client.initialize(&timelock, &admin, &emergency_multisig);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_rebalance_threshold(&non_admin, &300);
        }));
        assert!(result.is_err(), "Non-admin should not be able to set rebalance threshold");
    }

    #[test]
    fn test_protocol_governor_non_admin_cannot_emergency_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let timelock = Address::generate(&env);
        let mut emergency_multisig = SorobanVec::new(&env);
        for _ in 0..5 {
            emergency_multisig.push_back(Address::generate(&env));
        }
        let contract_id = env.register_contract(None, stellar_liquidity_yield_engine::ProtocolGovernor);
        let client = stellar_liquidity_yield_engine::ProtocolGovernorClient::new(&env, &contract_id);
        client.initialize(&timelock, &admin, &emergency_multisig);

        let mut signers = SorobanVec::new(&env);
        signers.push_back(non_admin.clone());
        
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.emergency_pause(&signers);
        }));
        assert!(result.is_err(), "Non-admin should not be able to trigger emergency pause");
    }
}
