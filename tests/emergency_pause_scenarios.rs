//! Scenario tests for emergency pause during an active harvest or rebalance
//! (Issue #331).
//!
//! A single contract invocation cannot be interrupted half way through, so
//! "pausing mid-operation" means the pause lands while a keeper cycle is in
//! flight: the operation already underway finishes, and the *next* step of the
//! cycle — the one that would move funds — must be refused. These tests drive
//! that sequence through the real contract entrypoints and then assert on the
//! state that is left behind, so they prove both halves of the safety control:
//!
//! * the pause prevents the unsafe operation, and
//! * the pause does not corrupt or half-apply state.
//!
//! The vault exposes the multisig `emergency_pause`; the rebalance engine
//! exposes the admin `pause`. Both are exercised where the contract provides
//! them.

use soroban_sdk::{
    testutils::Address as _, token::TokenClient, Address, Env, Symbol, Vec as SorobanVec,
};
use stellar_liquidity_yield_engine::{
    RebalanceEngine, RebalanceEngineClient, RebalanceProposal, YieldVault, YieldVaultClient,
};

fn main() {}

mod tests {
    use super::*;
    use soroban_sdk::token::StellarAssetClient;

    const DEPOSIT: i128 = 10_000;
    const HARVEST_FEE_BPS: u32 = 50;

    struct VaultFixture<'a> {
        vault: YieldVaultClient<'a>,
        token_a: TokenClient<'a>,
        token_b: TokenClient<'a>,
        token_a_admin: StellarAssetClient<'a>,
        token_b_admin: StellarAssetClient<'a>,
        user: Address,
        admin: Address,
        treasury: Address,
    }

    fn setup_vault<'a>(env: &'a Env) -> VaultFixture<'a> {
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
            &Symbol::new(env, "PauseVault"),
            &token_a.address(),
            &token_b.address(),
            &pool_id,
            &1,
            &100,
            &HARVEST_FEE_BPS,
            &25,
            &treasury,
        );

        VaultFixture {
            vault,
            token_a: TokenClient::new(env, &token_a.address()),
            token_b: TokenClient::new(env, &token_b.address()),
            token_a_admin: StellarAssetClient::new(env, &token_a.address()),
            token_b_admin: StellarAssetClient::new(env, &token_b.address()),
            user,
            admin,
            treasury,
        }
    }

    /// Fund the user and deposit, leaving the vault with a live position.
    fn funded_vault<'a>(env: &'a Env) -> VaultFixture<'a> {
        let f = setup_vault(env);
        f.token_a_admin.mint(&f.user, &DEPOSIT);
        f.token_b_admin.mint(&f.user, &DEPOSIT);
        f.vault.deposit(&f.user, &DEPOSIT, &DEPOSIT, &0);
        f
    }

    /// Configure a 3-of-3 emergency multisig and return the signer set.
    fn configure_multisig(env: &Env, f: &VaultFixture) -> SorobanVec<Address> {
        let mut signers = SorobanVec::new(env);
        signers.push_back(Address::generate(env));
        signers.push_back(Address::generate(env));
        signers.push_back(Address::generate(env));

        f.vault.set_emergency_signers(&f.admin, &signers);
        f.vault.set_emergency_threshold(&f.admin, &3);
        signers
    }

    // ==================== Harvest ====================

    /// A pause that lands before the keeper harvests must stop the harvest, and
    /// the vault must be left exactly as it was: no reinvestment, no fee taken.
    #[test]
    fn test_emergency_pause_mid_cycle_blocks_harvest_and_leaves_state_untouched() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = funded_vault(&env);
        let signers = configure_multisig(&env, &f);

        let metrics_before = f.vault.get_metrics();

        // The emergency pause lands while the harvest cycle is in flight.
        f.vault.emergency_pause(&signers);

        // The fund-moving step is refused.
        assert!(
            f.vault.try_harvest(&f.user).is_err(),
            "harvest must be refused while emergency-paused"
        );

        // Post-pause state is consistent: the harvest never applied.
        let metrics_after = f.vault.get_metrics();
        assert_eq!(metrics_after.total_shares, metrics_before.total_shares);
        assert_eq!(metrics_after.total_amount_a, metrics_before.total_amount_a);
        assert_eq!(metrics_after.total_amount_b, metrics_before.total_amount_b);
        assert_eq!(metrics_after.last_harvest, metrics_before.last_harvest);
        assert_eq!(metrics_after.tvl, metrics_before.tvl);

        // No harvest fee was routed to the treasury.
        assert_eq!(f.token_a.balance(&f.treasury), 0);
        assert_eq!(f.token_b.balance(&f.treasury), 0);

        // The other fund-moving entrypoints are refused too, so the pause cannot
        // be sidestepped by depositing or withdrawing instead.
        assert!(f.vault.try_deposit(&f.user, &1, &1, &0).is_err());
        assert!(f.vault.try_withdraw(&f.user, &1, &0, &0).is_err());
    }

    /// A harvest that completes first, followed by a pause, must freeze the
    /// compounded state: the pause prevents a second, unsafe compounding.
    #[test]
    fn test_harvest_completes_then_emergency_pause_freezes_compounded_state() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = funded_vault(&env);
        let signers = configure_multisig(&env, &f);

        // The in-flight harvest runs to completion.
        f.vault.harvest(&f.user);
        let metrics_after_harvest = f.vault.get_metrics();
        assert!(
            metrics_after_harvest.total_amount_a > DEPOSIT,
            "harvest should reinvest rewards"
        );
        assert!(
            f.token_a.balance(&f.treasury) > 0,
            "harvest should pay the treasury fee"
        );

        // The pause lands immediately afterwards.
        f.vault.emergency_pause(&signers);

        assert!(
            f.vault.try_harvest(&f.user).is_err(),
            "a further harvest must be refused while paused"
        );

        // The compounded balances are untouched by the refused harvest.
        let metrics_after_pause = f.vault.get_metrics();
        assert_eq!(
            metrics_after_pause.total_amount_a,
            metrics_after_harvest.total_amount_a
        );
        assert_eq!(
            metrics_after_pause.total_amount_b,
            metrics_after_harvest.total_amount_b
        );
        assert_eq!(
            metrics_after_pause.total_shares,
            metrics_after_harvest.total_shares
        );

        // The user's share balance is intact, so the freeze stranded nothing.
        let position = f.vault.get_user_position(&f.user);
        assert_eq!(position.shares, metrics_after_harvest.total_shares);
    }

    /// Lifting the emergency pause with the same multisig restores the keeper.
    #[test]
    fn test_emergency_unpause_restores_harvest() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = funded_vault(&env);
        let signers = configure_multisig(&env, &f);

        f.vault.emergency_pause(&signers);
        assert!(f.vault.try_harvest(&f.user).is_err());

        f.vault.emergency_unpause(&signers);

        f.vault.harvest(&f.user);
        let metrics = f.vault.get_metrics();
        assert!(
            metrics.total_amount_a > DEPOSIT,
            "harvest should work again after emergency unpause"
        );
    }

    /// The emergency pause cannot be triggered with fewer than the configured
    /// approvals, so a single compromised signer cannot freeze a live harvest.
    #[test]
    fn test_emergency_pause_requires_multisig_and_leaves_harvest_running() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = funded_vault(&env);
        let signers = configure_multisig(&env, &f);

        // Only two of the three required signers: the pause must be rejected.
        let mut short = SorobanVec::new(&env);
        short.push_back(signers.get(0).unwrap());
        short.push_back(signers.get(1).unwrap());

        assert!(
            f.vault.try_emergency_pause(&short).is_err(),
            "emergency pause with insufficient signers must be rejected"
        );

        // The unsafe pause was prevented, so the keeper is still running.
        f.vault.harvest(&f.user);
        assert!(
            f.vault.get_metrics().total_amount_a > DEPOSIT,
            "harvest should be unaffected by a rejected emergency pause"
        );
    }

    // ==================== Rebalance ====================

    struct EngineFixture<'a> {
        engine: RebalanceEngineClient<'a>,
        engine_id: Address,
        admin: Address,
    }

    fn setup_engine<'a>(env: &'a Env) -> EngineFixture<'a> {
        let admin = Address::generate(env);
        let engine_id = env.register(RebalanceEngine, ());
        let engine = RebalanceEngineClient::new(env, &engine_id);
        engine.initialize(&admin);
        EngineFixture {
            engine,
            engine_id,
            admin,
        }
    }

    /// Create a strategy whose snapshot APY sits below its target, so the
    /// analysis step produces real proposals to hand to the execution step.
    fn create_strategy_with_proposals(env: &Env, f: &EngineFixture) -> u32 {
        let mut allocations = SorobanVec::new(env);
        // An underperforming pool: current_apy is below target - threshold, so
        // the analysis step looks for somewhere better to move the position.
        allocations.push_back(stellar_liquidity_yield_engine::PoolAllocation {
            pool_id: Address::generate(env),
            token_a: Address::generate(env),
            token_b: Address::generate(env),
            allocation_percent: 5000,
            target_apy: 2000,
            current_apy: 1500,
            impermanent_loss_risk: 100,
        });
        // A better pool already registered in the strategy, which is what the
        // proposal targets.
        allocations.push_back(stellar_liquidity_yield_engine::PoolAllocation {
            pool_id: Address::generate(env),
            token_a: Address::generate(env),
            token_b: Address::generate(env),
            allocation_percent: 5000,
            target_apy: 2500,
            current_apy: 2500,
            impermanent_loss_risk: 50,
        });

        f.engine.create_strategy(
            &f.admin,
            &Symbol::new(env, "PauseStrategy"),
            &2,
            &200,
            &100,
            &86400,
            &allocations,
        )
    }

    /// A pause that lands between the analysis and execution steps of a keeper
    /// cycle must stop the execution, and no partial rebalance may be recorded.
    #[test]
    fn test_pause_between_analysis_and_execution_blocks_rebalance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = setup_engine(&env);
        let strategy_id = create_strategy_with_proposals(&env, &f);

        // The keeper analyses the strategy and gets a proposal to execute.
        let proposals = f.engine.analyze_rebalance_opportunities(&strategy_id);
        assert!(!proposals.is_empty(), "expected a proposal to be in flight");
        let proposal = proposals.get(0).unwrap();
        let history_before = f.engine.get_history_count();

        // The pause lands before the execution step.
        f.engine.pause(&f.admin);

        // The fund-moving step is refused.
        assert!(
            f.engine.try_execute_rebalance(&f.admin, &proposal).is_err(),
            "execute_rebalance must be refused while paused"
        );

        // Post-pause state is consistent: no partial or failed entry was written.
        assert_eq!(
            f.engine.get_history_count(),
            history_before,
            "a refused rebalance must not be recorded in history"
        );
        // The strategy itself is unchanged.
        assert_eq!(f.engine.get_strategy_count(), 1);
        assert_eq!(
            f.engine.get_current_allocations(&strategy_id).len(),
            2,
            "strategy allocations must be untouched by a refused rebalance"
        );
    }

    /// Emergency history must be append-only: a completed rebalance entry is
    /// retained in order and cannot be overwritten by later activity.
    #[test]
    fn test_emergency_history_is_append_only_and_ordered() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = setup_engine(&env);

        let token_a = env.register_stellar_asset_contract_v2(f.admin.clone());
        let token_b = env.register_stellar_asset_contract_v2(f.admin.clone());
        let from_pool = token_a.address();
        let to_pool = token_b.address();
        StellarAssetClient::new(&env, &from_pool).mint(&from_pool, &1_000);
        StellarAssetClient::new(&env, &to_pool).mint(&f.engine_id, &1_000);

        let proposal = RebalanceProposal {
            from_pool: from_pool.clone(),
            to_pool: to_pool.clone(),
            amount_a: 100,
            amount_b: 100,
            expected_apy_improvement: 500,
            estimated_gas_cost: 10,
            timestamp: env.ledger().timestamp(),
        };

        assert!(f.engine.execute_rebalance(&f.admin, &proposal));
        let count_after_first = f.engine.get_history_count();
        assert_eq!(count_after_first, 1);

        // A pause must not mutate or remove the existing entry.
        f.engine.pause(&f.admin);
        assert_eq!(
            f.engine.get_history_count(),
            count_after_first,
            "pausing must not alter existing emergency history"
        );

        // After unpausing, a further rebalance appends rather than overwrites.
        f.engine.unpause(&f.admin);
        assert!(f.engine.execute_rebalance(&f.admin, &proposal));
        assert_eq!(
            f.engine.get_history_count(),
            count_after_first + 1,
            "new rebalances must append to history, preserving prior entries"
        );
    }

    /// A rebalance that completes first, followed by a pause, must leave the
    /// completed entry intact and refuse the next one.
    #[test]
    fn test_rebalance_completes_then_pause_keeps_history_consistent() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = setup_engine(&env);

        // Real token contracts stand in for the source and target pools so the
        // completed rebalance moves funds through the engine. The engine treats
        // `from_pool` as the token it pulls from and `to_pool` as the token it
        // pushes to, so both legs are funded here.
        let token_a = env.register_stellar_asset_contract_v2(f.admin.clone());
        let token_b = env.register_stellar_asset_contract_v2(f.admin.clone());
        let from_pool = token_a.address();
        let to_pool = token_b.address();
        StellarAssetClient::new(&env, &from_pool).mint(&from_pool, &1_000);
        StellarAssetClient::new(&env, &to_pool).mint(&f.engine_id, &1_000);

        let proposal = RebalanceProposal {
            from_pool: from_pool.clone(),
            to_pool: to_pool.clone(),
            amount_a: 100,
            amount_b: 100,
            expected_apy_improvement: 500,
            estimated_gas_cost: 10,
            timestamp: env.ledger().timestamp(),
        };

        // The in-flight rebalance runs to completion.
        assert!(
            f.engine.execute_rebalance(&f.admin, &proposal),
            "rebalance should succeed before the pause"
        );
        let history_after_rebalance = f.engine.get_history_count();
        assert_eq!(history_after_rebalance, 1);

        // The pause lands immediately afterwards.
        f.engine.pause(&f.admin);

        assert!(
            f.engine.try_execute_rebalance(&f.admin, &proposal).is_err(),
            "the next rebalance must be refused while paused"
        );
        assert_eq!(
            f.engine.get_history_count(),
            history_after_rebalance,
            "the completed rebalance must remain the last recorded entry"
        );
    }

    /// A tripped breaker can be cleared by an authorized admin reset, after
    /// which the keeper cycle resumes without a redeployment.
    #[test]
    fn test_manual_reset_clears_tripped_breaker_and_restores_rebalance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = setup_engine(&env);
        let strategy_id = create_strategy_with_proposals(&env, &f);

        // The breaker trips automatically on a failed execution.
        let bad_proposal = RebalanceProposal {
            from_pool: Address::generate(&env),
            to_pool: Address::generate(&env),
            amount_a: 100,
            amount_b: 100,
            expected_apy_improvement: 500,
            estimated_gas_cost: 10,
            timestamp: env.ledger().timestamp(),
        };
        assert!(
            f.engine.try_execute_rebalance(&f.admin, &bad_proposal).is_err(),
            "an unfunded rebalance must fail and trip the breaker"
        );
        assert!(
            f.engine.try_execute_rebalance(&f.admin, &bad_proposal).is_err(),
            "the tripped breaker must refuse further executions"
        );

        // An authorized admin reset clears the tripped breaker.
        f.engine.reset_circuit_breaker(&f.admin);

        // The keeper cycle can run again without redeployment.
        let proposals = f.engine.analyze_rebalance_opportunities(&strategy_id);
        assert!(
            !proposals.is_empty(),
            "analysis should work again after a manual reset"
        );
    }

    /// The manual reset is admin-gated: a non-admin caller cannot clear a
    /// tripped breaker.
    #[test]
    fn test_manual_reset_requires_admin_authorization() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = setup_engine(&env);

        let bad_proposal = RebalanceProposal {
            from_pool: Address::generate(&env),
            to_pool: Address::generate(&env),
            amount_a: 100,
            amount_b: 100,
            expected_apy_improvement: 500,
            estimated_gas_cost: 10,
            timestamp: env.ledger().timestamp(),
        };
        assert!(f.engine.try_execute_rebalance(&f.admin, &bad_proposal).is_err());

        let intruder = Address::generate(&env);
        assert!(
            f.engine.try_reset_circuit_breaker(&intruder).is_err(),
            "a non-admin must not be able to reset the breaker"
        );
    }

    /// While paused, the read/preparation entrypoints that feed the keeper are
    /// refused as well, so it cannot build a new unsafe cycle.
    #[test]
    fn test_pause_blocks_analysis_and_strategy_mutation() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let f = setup_engine(&env);
        let strategy_id = create_strategy_with_proposals(&env, &f);

        f.engine.pause(&f.admin);

        assert!(
            f.engine
                .try_analyze_rebalance_opportunities(&strategy_id)
                .is_err(),
            "analysis must be refused while paused"
        );
        assert!(
            f.engine
                .try_update_pool_apy(&f.admin, &Address::generate(&env), &2000)
                .is_err(),
            "oracle updates must be refused while paused"
        );

        let mut allocations = SorobanVec::new(&env);
        allocations.push_back(stellar_liquidity_yield_engine::PoolAllocation {
            pool_id: Address::generate(&env),
            token_a: Address::generate(&env),
            token_b: Address::generate(&env),
            allocation_percent: 10000,
            target_apy: 2000,
            current_apy: 1500,
            impermanent_loss_risk: 100,
        });
        assert!(
            f.engine
                .try_create_strategy(
                    &f.admin,
                    &Symbol::new(&env, "Blocked"),
                    &2,
                    &200,
                    &100,
                    &86400,
                    &allocations,
                )
                .is_err(),
            "strategy creation must be refused while paused"
        );
    }
}
