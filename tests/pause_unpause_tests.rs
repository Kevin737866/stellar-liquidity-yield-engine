//! Comprehensive pause and unpause behavior tests for every mutating contract
//! entrypoint across the protocol (Issue #520).
//!
//! For each pausable contract, these tests verify:
//! - Normal operation succeeds before pause.
//! - Pausing blocks every pause-gated mutating entrypoint and leaves state
//!   untouched.
//! - Unpausing restores normal mutating operations.
//! - Boundary cases: idempotent pause/unpause, non-admin authorization
//!   failures, multisig emergency pause/unpause cross-recovery, circuit breaker
//!   reset, and intentionally exempt safety/governance entrypoints.

use soroban_sdk::{
    testutils::Address as _,
    token::StellarAssetClient,
    Address, Env, Symbol, Vec as SorobanVec,
};
use stellar_liquidity_yield_engine::{
    ArbitrageOpportunity, FeeStructure, MultiRewardDistributor, MultiRewardDistributorClient,
    PoolAllocation, RebalanceEngine, RebalanceEngineClient, RebalanceProposal,
    StellarLiquidityYieldEngine, StellarLiquidityYieldEngineClient, StrategyParameters,
    StrategyRegistry, StrategyRegistryClient, SwapRouter, SwapRouterClient, YieldVault,
    YieldVaultClient,
};

fn main() {}

mod pause_unpause_tests {
    use super::*;

    // ==================== Helpers ====================

    fn setup_engine(env: &Env) -> (StellarLiquidityYieldEngineClient<'_>, Address) {
        let admin = Address::generate(env);
        let strategy_registry = Address::generate(env);
        let reward_distributor = Address::generate(env);
        let id = env.register(StellarLiquidityYieldEngine, ());
        let client = StellarLiquidityYieldEngineClient::new(env, &id);
        client.initialize(&admin, &strategy_registry, &reward_distributor);
        (client, admin)
    }

    struct VaultSetup<'a> {
        vault: YieldVaultClient<'a>,
        token_a_admin: StellarAssetClient<'a>,
        token_b_admin: StellarAssetClient<'a>,
        user: Address,
        admin: Address,
    }

    fn setup_vault(env: &Env) -> VaultSetup<'_> {
        let admin = Address::generate(env);
        let user = Address::generate(env);
        let treasury = Address::generate(env);
        let token_a = env.register_stellar_asset_contract_v2(admin.clone());
        let token_b = env.register_stellar_asset_contract_v2(admin.clone());
        let pool_id = Address::generate(env);

        let vault_id = env.register(YieldVault, ());
        let vault = YieldVaultClient::new(env, &vault_id);
        vault.initialize(
            &admin,
            &Symbol::new(env, "PauseTest"),
            &token_a.address(),
            &token_b.address(),
            &pool_id,
            &1,
            &100,
            &50,
            &25,
            &treasury,
        );

        let token_a_admin = StellarAssetClient::new(env, &token_a.address());
        let token_b_admin = StellarAssetClient::new(env, &token_b.address());
        token_a_admin.mint(&user, &100_000);
        token_b_admin.mint(&user, &100_000);

        VaultSetup {
            vault,
            token_a_admin,
            token_b_admin,
            user,
            admin,
        }
    }

    fn setup_rebalance_engine(env: &Env) -> (RebalanceEngineClient<'_>, Address) {
        let admin = Address::generate(env);
        let id = env.register(RebalanceEngine, ());
        let client = RebalanceEngineClient::new(env, &id);
        client.initialize(&admin);
        (client, admin)
    }

    fn sample_allocations(env: &Env) -> SorobanVec<PoolAllocation> {
        let mut allocations = SorobanVec::new(env);
        allocations.push_back(PoolAllocation {
            pool_id: Address::generate(env),
            token_a: Address::generate(env),
            token_b: Address::generate(env),
            allocation_percent: 5000,
            target_apy: 2000,
            current_apy: 1500,
            impermanent_loss_risk: 100,
        });
        allocations
    }

    fn setup_strategy_registry(env: &Env) -> (StrategyRegistryClient<'_>, Address) {
        let admin = Address::generate(env);
        let id = env.register(StrategyRegistry, ());
        let client = StrategyRegistryClient::new(env, &id);
        client.initialize(&admin);
        (client, admin)
    }

    fn sample_fee_structure() -> FeeStructure {
        FeeStructure {
            management_fee: 100,
            performance_fee: 500,
            deposit_fee: 0,
            withdrawal_fee: 0,
        }
    }

    fn sample_strategy_params(env: &Env) -> StrategyParameters {
        let mut target_tokens = SorobanVec::new(env);
        target_tokens.push_back(Address::generate(env));
        let mut allocation_weights = SorobanVec::new(env);
        allocation_weights.push_back(10_000);
        StrategyParameters {
            target_tokens,
            allocation_weights,
            rebalance_threshold: 500,
            impermanent_loss_limit: 1000,
            min_apy_target: 500,
        }
    }

    fn setup_reward_distributor(env: &Env) -> (MultiRewardDistributorClient<'_>, Address, Address) {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let swap_router = Address::generate(env);
        let id = env.register(MultiRewardDistributor, ());
        let client = MultiRewardDistributorClient::new(env, &id);
        client.initialize(&admin, &treasury, &swap_router);
        (client, admin, treasury)
    }

    fn setup_swap_router(env: &Env) -> (SwapRouterClient<'_>, Address) {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let xlm_token = Address::generate(env);
        let id = env.register(SwapRouter, ());
        let client = SwapRouterClient::new(env, &id);
        client.initialize(&admin, &treasury, &xlm_token);
        (client, admin)
    }

    // ==================== StellarLiquidityYieldEngine ====================

    #[test]
    fn test_engine_pause_unpause_all_mutating_entrypoints() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = setup_engine(&env);

        assert!(!client.is_paused());

        // Pause blocks mutating configuration entrypoints.
        client.pause(&admin);
        assert!(client.is_paused());

        let new_registry = Address::generate(&env);
        let new_distributor = Address::generate(&env);
        assert!(
            client
                .try_update_strategy_registry(&admin, &new_registry)
                .is_err(),
            "update_strategy_registry must fail while paused"
        );
        assert!(
            client
                .try_update_reward_distributor(&admin, &new_distributor)
                .is_err(),
            "update_reward_distributor must fail while paused"
        );
        assert_ne!(client.get_strategy_registry(), new_registry);
        assert_ne!(client.get_reward_distributor(), new_distributor);

        // Unpause restores all mutating entrypoints.
        client.unpause(&admin);
        assert!(!client.is_paused());

        client.update_strategy_registry(&admin, &new_registry);
        client.update_reward_distributor(&admin, &new_distributor);
        assert_eq!(client.get_strategy_registry(), new_registry);
        assert_eq!(client.get_reward_distributor(), new_distributor);
    }

    #[test]
    fn test_engine_pause_idempotency_circuit_breaker_and_auth_boundaries() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = setup_engine(&env);
        let non_admin = Address::generate(&env);

        // Non-admin cannot pause or unpause.
        assert!(client.try_pause(&non_admin).is_err());
        assert!(!client.is_paused());

        // Idempotent pause & unpause.
        client.pause(&admin);
        client.pause(&admin);
        assert!(client.is_paused());
        assert!(client.try_unpause(&non_admin).is_err());
        assert!(client.is_paused());

        client.unpause(&admin);
        client.unpause(&admin);
        assert!(!client.is_paused());

        // Circuit breaker trips pause and reset restores operations.
        client.trip_circuit_breaker(&admin);
        assert!(client.is_paused());
        assert!(client.is_circuit_breaker_tripped());
        assert!(client
            .try_update_strategy_registry(&admin, &Address::generate(&env))
            .is_err());

        client.reset_circuit_breaker(&admin);
        assert!(!client.is_paused());
        assert!(!client.is_circuit_breaker_tripped());
        let updated = Address::generate(&env);
        client.update_strategy_registry(&admin, &updated);
        assert_eq!(client.get_strategy_registry(), updated);
    }

    // ==================== YieldVault ====================

    #[test]
    fn test_yield_vault_pause_unpause_all_mutating_entrypoints() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = setup_vault(&env);

        // Initial deposit succeeds before pause.
        let minted = f.vault.deposit(&f.user, &10_000, &10_000, &0);
        assert!(minted > 0);

        // Pause blocks deposit, withdraw, and harvest.
        f.vault.pause(&f.admin);
        assert!(f.vault.is_paused());

        let metrics_before = f.vault.get_metrics();
        assert!(
            f.vault.try_deposit(&f.user, &1_000, &1_000, &0).is_err(),
            "deposit must fail while paused"
        );
        assert!(
            f.vault.try_withdraw(&f.user, &1_000, &0, &0).is_err(),
            "withdraw must fail while paused"
        );
        assert!(
            f.vault.try_harvest(&f.user).is_err(),
            "harvest must fail while paused"
        );
        assert_eq!(f.vault.get_metrics(), metrics_before);

        // Unpause restores deposit, harvest, and withdraw.
        f.vault.unpause(&f.admin);
        assert!(!f.vault.is_paused());

        let minted_after = f.vault.deposit(&f.user, &1_000, &1_000, &0);
        assert!(minted_after > 0);
        f.vault.harvest(&f.user);
        let (out_a, out_b) = f.vault.withdraw(&f.user, &1_000, &0, &0);
        assert!(out_a > 0 && out_b > 0);
    }

    #[test]
    fn test_yield_vault_emergency_multisig_and_cross_recovery() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = setup_vault(&env);

        f.vault.deposit(&f.user, &5_000, &5_000, &0);

        let mut signers = SorobanVec::new(&env);
        signers.push_back(Address::generate(&env));
        signers.push_back(Address::generate(&env));
        signers.push_back(Address::generate(&env));
        f.vault.set_emergency_signers(&f.admin, &signers);
        f.vault.set_emergency_threshold(&f.admin, &2);

        // Insufficient signers must fail.
        let mut one_signer = SorobanVec::new(&env);
        one_signer.push_back(signers.get(0).unwrap());
        assert!(f.vault.try_emergency_pause(&one_signer).is_err());
        assert!(!f.vault.is_paused());

        // Multisig emergency pause blocks mutating entrypoints; admin unpause recovers.
        f.vault.emergency_pause(&signers);
        assert!(f.vault.is_paused());
        assert!(f.vault.try_deposit(&f.user, &500, &500, &0).is_err());
        assert!(f.vault.try_withdraw(&f.user, &500, &0, &0).is_err());
        assert!(f.vault.try_harvest(&f.user).is_err());

        f.vault.unpause(&f.admin);
        assert!(!f.vault.is_paused());

        // Admin pause can be lifted by multisig emergency_unpause.
        f.vault.pause(&f.admin);
        assert!(f.vault.is_paused());
        f.vault.emergency_unpause(&signers);
        assert!(!f.vault.is_paused());

        let (out_a, out_b) = f.vault.withdraw(&f.user, &500, &0, &0);
        assert!(out_a > 0 && out_b > 0);
    }

    // ==================== RebalanceEngine ====================

    #[test]
    fn test_rebalance_engine_pause_unpause_all_mutating_entrypoints() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = setup_rebalance_engine(&env);
        let caller = Address::generate(&env);
        let pool_a = Address::generate(&env);
        let pool_b = Address::generate(&env);
        let allocations = sample_allocations(&env);

        let strategy_id = client.create_strategy(
            &admin,
            &Symbol::new(&env, "Strat1"),
            &2,
            &200,
            &100,
            &86400,
            &allocations,
        );

        let proposal = RebalanceProposal {
            from_pool: pool_a.clone(),
            to_pool: pool_b.clone(),
            amount_a: 1_000,
            amount_b: 1_000,
            expected_apy_improvement: 200,
            estimated_gas_cost: 10,
            timestamp: env.ledger().timestamp(),
            min_output: 1_900,
        };

        let opportunity = ArbitrageOpportunity {
            pool_id: pool_b.clone(),
            current_apy: 1000,
            projected_apy: 1500,
            il_risk: 50,
            net_profit: 100,
            apy_delta: 500,
            recommended: true,
        };

        // Pause blocks every pause-gated mutating entrypoint.
        client.pause(&admin);
        assert!(client.is_paused());

        assert!(client
            .try_create_strategy(
                &admin,
                &Symbol::new(&env, "Strat2"),
                &2,
                &200,
                &100,
                &86400,
                &allocations,
            )
            .is_err());
        assert!(client
            .try_update_strategy(
                &admin,
                &strategy_id,
                &Symbol::new(&env, "Strat1Up"),
                &2,
                &250,
                &150,
                &86400,
                &allocations,
            )
            .is_err());
        assert!(client
            .try_analyze_rebalance_opportunities(&strategy_id)
            .is_err());
        assert!(client.try_execute_rebalance(&caller, &proposal).is_err());
        assert!(client.try_update_pool_apy(&admin, &pool_a, &1500).is_err());
        assert!(client
            .try_record_feed_validation_failure(&pool_a)
            .is_err());
        assert!(client
            .try_record_feed_validation_success(&pool_a)
            .is_err());
        assert!(client
            .try_scan_opportunities(&pool_a, &1000, &allocations)
            .is_err());
        let fake_vault = Address::generate(&env);
        assert!(client
            .try_execute_flash_rebalance(&caller, &fake_vault, &opportunity, &1_000)
            .is_err());

        // Unpause restores operations.
        client.unpause(&admin);
        assert!(!client.is_paused());

        client.update_strategy(
            &admin,
            &strategy_id,
            &Symbol::new(&env, "Strat1Up"),
            &2,
            &250,
            &150,
            &86400,
            &allocations,
        );
        client.update_pool_apy(&admin, &pool_a, &1500);
        client.record_feed_validation_failure(&pool_a);
        client.record_feed_validation_success(&pool_a);
        let _ = client.analyze_rebalance_opportunities(&strategy_id);
        let _ = client.scan_opportunities(&pool_a, &1000, &allocations);
        assert!(client.execute_rebalance(&caller, &proposal));
    }

    // ==================== StrategyRegistry ====================

    #[test]
    fn test_strategy_registry_pause_unpause_all_mutating_entrypoints() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = setup_strategy_registry(&env);
        let creator = Address::generate(&env);
        let fees = sample_fee_structure();
        let params = sample_strategy_params(&env);

        let strategy_id = client.register_strategy(
            &creator,
            &Symbol::new(&env, "Alpha"),
            &Symbol::new(&env, "Desc"),
            &2,
            &100,
            &10_000,
            &fees,
            &params,
        );

        // Pause blocks register_strategy, update_strategy, and record_performance.
        client.pause(&admin);
        assert!(client.is_paused_view());

        assert!(client
            .try_register_strategy(
                &creator,
                &Symbol::new(&env, "Beta"),
                &Symbol::new(&env, "Desc"),
                &2,
                &100,
                &10_000,
                &fees,
                &params,
            )
            .is_err());
        assert!(client
            .try_update_strategy(
                &creator,
                &strategy_id,
                &Symbol::new(&env, "AlphaV2"),
                &Symbol::new(&env, "Desc"),
                &2,
                &100,
                &10_000,
                &fees,
                &params,
            )
            .is_err());
        assert!(client
            .try_record_performance(&strategy_id, &5_000, &1200, &200, &150)
            .is_err());

        // Admin governance actions remain available while paused.
        client.approve_strategy(&admin, &strategy_id, &Symbol::new(&env, "ok"));
        assert!(client.get_strategy(&strategy_id).is_active);
        client.deactivate_strategy(&admin, &strategy_id);
        assert!(!client.get_strategy(&strategy_id).is_active);

        // Unpause restores user/keeper mutating entrypoints.
        client.unpause(&admin);
        assert!(!client.is_paused_view());

        client.update_strategy(
            &creator,
            &strategy_id,
            &Symbol::new(&env, "AlphaV2"),
            &Symbol::new(&env, "Desc"),
            &2,
            &100,
            &10_000,
            &fees,
            &params,
        );
        client.record_performance(&strategy_id, &5_000, &1200, &200, &150);
    }

    // ==================== MultiRewardDistributor ====================

    #[test]
    fn test_reward_distributor_pause_unpause_all_mutating_entrypoints() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin, _treasury) = setup_reward_distributor(&env);
        let user = Address::generate(&env);
        let vault = Address::generate(&env);
        let reward_token = env.register_stellar_asset_contract_v2(admin.clone());

        let stream_idx = client.add_reward_stream(&admin, &reward_token.address(), &10, &7, &0);
        let mut indices = SorobanVec::new(&env);
        indices.push_back(stream_idx);

        // Pause blocks add_reward_stream and claim_rewards.
        client.pause(&admin);
        let (paused, _, _, _) = client.get_state();
        assert!(paused);

        assert!(client
            .try_add_reward_stream(&admin, &reward_token.address(), &20, &7, &0)
            .is_err());
        assert!(client
            .try_claim_rewards(&user, &vault, &indices, &None)
            .is_err());

        // Safety exit remains available while paused.
        client.emergency_withdraw(&user, &vault, &1_000);

        // Unpause restores add_reward_stream and claim_rewards.
        client.unpause(&admin);
        let (paused_after, _, _, _) = client.get_state();
        assert!(!paused_after);

        let stream_idx_2 = client.add_reward_stream(&admin, &reward_token.address(), &20, &7, &0);
        assert_eq!(stream_idx_2, 1);
        let claimed = client.claim_rewards(&user, &vault, &indices, &None);
        assert_eq!(claimed.len(), 0);
    }

    // ==================== SwapRouter ====================

    #[test]
    fn test_swap_router_oracle_pause_unpause_mutating_entrypoints() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = setup_swap_router(&env);
        let pool = Address::generate(&env);
        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        client.add_pool(&admin, &pool, &token_a, &token_b, &30, &false);

        // Oracle pause blocks update_pool_reserves; unpause restores it.
        client.pause_oracle(&admin);
        assert!(client.is_oracle_paused());
        assert!(client
            .try_update_pool_reserves(&pool, &10_000, &20_000)
            .is_err());

        client.unpause_oracle(&admin);
        assert!(!client.is_oracle_paused());
        client.update_pool_reserves(&pool, &10_000, &20_000);

        let pool_info = client.get_pool(&pool).unwrap();
        assert_eq!(pool_info.reserve_a, 10_000);
        assert_eq!(pool_info.reserve_b, 20_000);
    }
}
