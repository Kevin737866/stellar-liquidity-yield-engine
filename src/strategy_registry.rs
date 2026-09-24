use soroban_sdk::{
    contract, contractimpl, contracttype, unwrap::UnwrapOptimized, Address, Env, Map, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct YieldStrategy {
    pub strategy_id: u32,
    pub name: Symbol,
    pub description: Symbol,
    pub creator: Address,
    pub risk_level: u32, // 1=Conservative, 2=Balanced, 3=Aggressive
    pub min_investment: i128,
    pub max_investment: i128,
    pub fee_structure: FeeStructure,
    pub performance_history: Vec<PerformanceRecord>,
    pub is_active: bool,
    pub created_at: u64,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeStructure {
    pub management_fee: u32,  // Annual fee in basis points
    pub performance_fee: u32, // Performance fee in basis points
    pub deposit_fee: u32,     // Deposit fee in basis points
    pub withdrawal_fee: u32,  // Withdrawal fee in basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PerformanceRecord {
    pub timestamp: u64,
    pub total_value: i128,
    pub net_apy: u32,      // Net APY after fees
    pub volatility: u32,   // Volatility measure in basis points
    pub sharpe_ratio: u32, // Sharpe ratio scaled by 10000
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyParameters {
    pub target_tokens: Vec<Address>,
    pub allocation_weights: Vec<u32>, // Corresponding weights in basis points
    pub rebalance_threshold: u32,     // Rebalance when allocation deviates by this much
    pub impermanent_loss_limit: u32,  // Maximum acceptable IL in basis points
    pub min_apy_target: u32,          // Minimum APY target in basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyApproval {
    pub strategy_id: u32,
    pub approved_by: Address,
    pub approved_at: u64,
    pub approval_type: u32, // 1=Initial, 2=Update, 3=Removal
    pub comments: Symbol,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PerformanceHistoryTrimmed {
    pub strategy_id: u32,
    pub records_trimmed: u32,
    pub records_kept: u32,
    pub timestamp: u64,
}

#[contract]
pub struct StrategyRegistry;

#[contractimpl]
impl StrategyRegistry {
    /// Initialize the strategy registry
    pub fn initialize(env: Env, admin: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "admin"), &admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "next_strategy_id"), &1u32);

        // Strategies stored as Map<u32, YieldStrategy> for O(1) access
        let strategies: Map<u32, YieldStrategy> = Map::new(&env);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

        let approvals: Vec<StrategyApproval> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "approvals"), &approvals);

        let strategy_params: Map<u32, StrategyParameters> = Map::new(&env);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategy_params"), &strategy_params);
    }

    /// Register a new yield strategy
    pub fn register_strategy(
        env: Env,
        creator: Address,
        name: Symbol,
        description: Symbol,
        risk_level: u32,
        min_investment: i128,
        max_investment: i128,
        fee_structure: FeeStructure,
        parameters: StrategyParameters,
    ) -> u32 {
        Self::require_not_paused(&env);
        require!(min_investment > 0, "min investment must be positive");
        require!(max_investment >= min_investment, "max investment must be greater than or equal to min investment");
        
        let strategy_id = Self::get_next_strategy_id(&env);
        let current_time = env.ledger().timestamp();

        let strategy = YieldStrategy {
            strategy_id,
            name: name.clone(),
            description,
            creator: creator.clone(),
            risk_level,
            min_investment,
            max_investment,
            fee_structure,
            performance_history: Vec::new(&env),
            is_active: false, // Requires approval
            created_at: current_time,
            updated_at: current_time,
        };

        // O(1) insert into Map keyed by strategy_id
        let mut strategies = Self::get_strategies_map(&env);
        // Validate risk_level bounds (1-3) per issue #118
        require!(risk_level >= 1 && risk_level <= 3, "risk_level must be 1-3");
        require!(strategies.get(strategy_id).is_none(), "strategy id collision");
        strategies.set(strategy_id, strategy.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

        // Store strategy parameters
        let mut strategy_params = Self::get_strategy_params(&env);
        strategy_params.set(strategy_id, parameters);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategy_params"), &strategy_params);

        // Audit event
        env.events().publish(
            (Symbol::new(&env, "strategy_registered"), strategy_id),
            (creator, name, risk_level),
        );

        strategy_id
    }

    /// Approve a strategy (admin only)
    pub fn approve_strategy(env: Env, admin: Address, strategy_id: u32, comments: Symbol) {
        Self::require_admin(&env, admin.clone());

        let mut strategies = Self::get_strategies_map(&env);
        let mut strategy = strategies
            .get(strategy_id)
            .unwrap_or_else(|| panic!("strategy not found"));
        strategy.is_active = true;
        strategy.updated_at = env.ledger().timestamp();
        strategies.set(strategy_id, strategy);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

        // Audit event
        env.events().publish(
            (Symbol::new(&env, "strategy_approved"), strategy_id),
            (admin.clone(), strategy_id),
        );

        // Record approval
        let approval = StrategyApproval {
            strategy_id,
            approved_by: admin,
            approved_at: env.ledger().timestamp(),
            approval_type: 1, // Initial approval
            comments,
        };

        Self::add_approval(&env, approval);
    }

    /// Update strategy parameters
    pub fn update_strategy(
        env: Env,
        creator: Address,
        strategy_id: u32,
        name: Symbol,
        description: Symbol,
        risk_level: u32,
        min_investment: i128,
        max_investment: i128,
        fee_structure: FeeStructure,
        parameters: StrategyParameters,
    ) {
        Self::require_not_paused(&env);
        require!(min_investment > 0, "min investment must be positive");
        require!(max_investment >= min_investment, "max investment must be greater than or equal to min investment");
        
        let mut strategies = Self::get_strategies_map(&env);
        let strategy = strategies
            .get(strategy_id)
            .unwrap_or_else(|| panic!("strategy not found"));
        if strategy.creator != creator {
            panic!("unauthorized: not strategy creator");
        }
        require!(risk_level >= 1 && risk_level <= 3, "risk_level must be 1-3");

        let updated_strategy = YieldStrategy {
            strategy_id,
            name: name.clone(),
            description,
            creator: creator.clone(),
            risk_level,
            min_investment,
            max_investment,
            fee_structure,
            performance_history: strategy.performance_history,
            is_active: false, // Requires re-approval after update
            created_at: strategy.created_at,
            updated_at: env.ledger().timestamp(),
        };

        strategies.set(strategy_id, updated_strategy);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

        // Update strategy parameters
        let mut strategy_params = Self::get_strategy_params(&env);
        strategy_params.set(strategy_id, parameters);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategy_params"), &strategy_params);

        env.events().publish(
            (Symbol::new(&env, "strategy_updated"), strategy_id),
            (creator, name, risk_level),
        );
    }

    /// Record strategy performance
    pub fn record_performance(
        env: Env,
        strategy_id: u32,
        total_value: i128,
        net_apy: u32,
        volatility: u32,
        sharpe_ratio: u32,
    ) {
        Self::require_not_paused(&env);

        let mut strategies = Self::get_strategies_map(&env);
        let mut strategy = strategies
            .get(strategy_id)
            .unwrap_or_else(|| panic!("strategy not found"));

        let performance_record = PerformanceRecord {
            timestamp: env.ledger().timestamp(),
            total_value,
            net_apy,
            volatility,
            sharpe_ratio,
        };

        strategy.performance_history.push_back(performance_record);
        strategy.updated_at = env.ledger().timestamp();

        // Keep only last 100 performance records
        if strategy.performance_history.len() > 100 {
            let total_records = strategy.performance_history.len();
            let start = total_records - 100;
            let records_trimmed = start as u32;
            let mut trimmed: Vec<PerformanceRecord> = Vec::new(&env);
            for j in start..total_records {
                trimmed.push_back(strategy.performance_history.get(j).unwrap());
            }
            strategy.performance_history = trimmed;

            // Publish event so off-chain analytics can capture dropped records
            let event = PerformanceHistoryTrimmed {
                strategy_id,
                records_trimmed,
                records_kept: 100,
                timestamp: env.ledger().timestamp(),
            };
            env.events().publish(
                (
                    Symbol::new(&env, "performance_history_trimmed"),
                    strategy_id,
                ),
                (event.records_trimmed, event.records_kept, event.timestamp),
            );
        }

        strategies.set(strategy_id, strategy.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

        // Audit event for performance recording
        env.events().publish(
            (Symbol::new(&env, "performance_recorded"), strategy_id),
            (strategy_id, net_apy, total_value),
        );
    }

    /// Deactivate a strategy
    pub fn deactivate_strategy(env: Env, admin: Address, strategy_id: u32) {
        Self::require_admin(&env, admin.clone());

        let mut strategies = Self::get_strategies_map(&env);
        let mut strategy = strategies
            .get(strategy_id)
            .unwrap_or_else(|| panic!("strategy not found"));
        strategy.is_active = false;
        strategy.updated_at = env.ledger().timestamp();
                strategies.set(i, strategy);
                found = true;
                break;
            }
        }

        strategies.set(strategy_id, strategy);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

        env.events().publish(
            (Symbol::new(&env, "strategy_deactivated"), strategy_id),
            (admin.clone(), strategy_id),
        );

        // Record deactivation
        let approval = StrategyApproval {
            strategy_id,
            approved_by: admin,
            approved_at: env.ledger().timestamp(),
            approval_type: 3, // Removal
            comments: Symbol::new(&env, "Deactivated by admin"),
        };

        Self::add_approval(&env, approval);
    }

    /// Get all active strategies
    pub fn get_active_strategies(env: Env) -> Vec<YieldStrategy> {
        let strategies = Self::get_strategies(&env);
        let mut active_strategies: Vec<YieldStrategy> = Vec::new(&env);

        for strategy in strategies {
            if strategy.is_active {
                active_strategies.push_back(strategy);
            }
        }

        active_strategies
    }

    /// Get strategies by risk level
    pub fn get_strategies_by_risk(env: Env, risk_level: u32) -> Vec<YieldStrategy> {
        let strategies = Self::get_strategies(&env);
        let mut filtered_strategies: Vec<YieldStrategy> = Vec::new(&env);

        for strategy in strategies {
            if strategy.risk_level == risk_level && strategy.is_active {
                filtered_strategies.push_back(strategy);
            }
        }

        filtered_strategies
    }

    /// Get strategy details - O(1) via Map
    pub fn get_strategy(env: Env, strategy_id: u32) -> YieldStrategy {
        Self::get_strategies_map(&env)
            .get(strategy_id)
            .unwrap_or_else(|| panic!("strategy not found"))
    }

    // --- Pagination helpers (Issue #107) ---
    /// Get strategies paginated with limit/offset for bounded reads
    pub fn get_strategies_paginated(env: Env, limit: u32, offset: u32) -> Vec<YieldStrategy> {
        let all = Self::get_strategies(&env);
        Self::paginate_vec(env.clone(), all, limit, offset)
    }

    /// Get active strategies paginated
    pub fn get_active_strategies_paginated(env: Env, limit: u32, offset: u32) -> Vec<YieldStrategy> {
        let active = Self::get_active_strategies(env.clone());
        Self::paginate_vec(env.clone(), active, limit, offset)
    }

    /// Get strategies by risk paginated
    pub fn get_strategies_by_risk_paginated(env: Env, risk_level: u32, limit: u32, offset: u32) -> Vec<YieldStrategy> {
        let filtered = Self::get_strategies_by_risk(env.clone(), risk_level);
        Self::paginate_vec(env.clone(), filtered, limit, offset)
    }

    /// Count total strategies (useful for pagination UI)
    pub fn get_strategy_count(env: Env) -> u32 {
        Self::get_strategies_map(&env).len()
    }

    fn paginate_vec(env: Env, vec: Vec<YieldStrategy>, limit: u32, offset: u32) -> Vec<YieldStrategy> {
        if limit == 0 || offset as usize >= vec.len() as usize {
            return Vec::new(&env);
        }
        let mut out: Vec<YieldStrategy> = Vec::new(&env);
        let end = (offset + limit).min(vec.len());
        for i in offset..end {
            out.push_back(vec.get(i).unwrap());
        }
        out
    }

    /// Get strategy parameters
    pub fn get_strategy_parameters(env: Env, strategy_id: u32) -> StrategyParameters {
        let strategy_params = Self::get_strategy_params(&env);
        strategy_params
            .get(strategy_id)
            .unwrap_or_else(|| panic!("strategy parameters not found"))
    }

    /// Get strategy performance history (most recent `limit` entries)
    pub fn get_performance_history(
        env: Env,
        strategy_id: u32,
        limit: u32,
    ) -> Vec<PerformanceRecord> {
        let strategy = Self::get_strategy(env.clone(), strategy_id);
        let mut history: Vec<PerformanceRecord> = Vec::new(&env);

        let start = if strategy.performance_history.len() > limit {
            strategy.performance_history.len() - limit
        } else {
            0
        };

        for i in start..strategy.performance_history.len() {
            history.push_back(strategy.performance_history.get(i).unwrap());
        }

        history
    }

    /// Paginated performance history with offset for bounded reads (Issue #107)
    pub fn get_performance_history_paginated(
        env: Env,
        strategy_id: u32,
        limit: u32,
        offset: u32,
    ) -> Vec<PerformanceRecord> {
        let strategy = Self::get_strategy(env.clone(), strategy_id);
        if limit == 0 || offset >= strategy.performance_history.len() {
            return Vec::new(&env);
        }
        let mut out: Vec<PerformanceRecord> = Vec::new(&env);
        let end = (offset + limit).min(strategy.performance_history.len());
        for i in offset..end {
            out.push_back(strategy.performance_history.get(i).unwrap());
        }
        out
    }

    /// Get approval history
    pub fn get_approval_history(env: Env, strategy_id: u32) -> Vec<StrategyApproval> {
        let approvals = Self::get_approvals(&env);
        let mut strategy_approvals: Vec<StrategyApproval> = Vec::new(&env);

        for approval in approvals {
            if approval.strategy_id == strategy_id {
                strategy_approvals.push_back(approval);
            }
        }

        strategy_approvals
    }

    /// Calculate strategy metrics
    pub fn calculate_strategy_metrics(env: Env, strategy_id: u32) -> (u32, u32, u32) {
        let strategy = Self::get_strategy(env, strategy_id);

        if strategy.performance_history.is_empty() {
            return (0, 0, 0); // No data available
        }

        let mut total_apy = 0u32;
        let mut total_volatility = 0u32;
        let mut total_sharpe = 0u32;
        let count = strategy.performance_history.len() as u32;

        for record in strategy.performance_history {
            total_apy += record.net_apy;
            total_volatility += record.volatility;
            total_sharpe += record.sharpe_ratio;
        }

        let avg_apy = total_apy / count;
        let avg_volatility = total_volatility / count;
        let avg_sharpe = total_sharpe / count;

        (avg_apy, avg_volatility, avg_sharpe)
    }

    /// Helper functions
    fn get_next_strategy_id(env: &Env) -> u32 {
        let id: u32 = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "next_strategy_id"))
            .unwrap_optimized();
        env.storage()
            .instance()
            .set(&Symbol::new(env, "next_strategy_id"), &(id + 1));
        id
    }

    fn get_strategies_map(env: &Env) -> Map<u32, YieldStrategy> {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "strategies"))
            .unwrap_optimized()
    }

    fn get_strategies(env: &Env) -> Vec<YieldStrategy> {
        let map: Map<u32, YieldStrategy> = Self::get_strategies_map(env);
        let mut v: Vec<YieldStrategy> = Vec::new(env);
        for (_, strat) in map.iter() {
            v.push_back(strat);
        }
        v
    }

    fn get_strategy_params(env: &Env) -> Map<u32, StrategyParameters> {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "strategy_params"))
            .unwrap_optimized()
    }

    fn get_approvals(env: &Env) -> Vec<StrategyApproval> {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "approvals"))
            .unwrap_optimized()
    }

    fn add_approval(env: &Env, approval: StrategyApproval) {
        let mut approvals = Self::get_approvals(env);
        approvals.push_back(approval);

        // Keep only last 1000 approvals
        if approvals.len() > 1000 {
            let start = approvals.len() - 1000;
            let mut trimmed: Vec<StrategyApproval> = Vec::new(env);
            for i in start..approvals.len() {
                trimmed.push_back(approvals.get(i).unwrap());
            }
            env.storage()
                .instance()
                .set(&Symbol::new(env, "approvals"), &trimmed);
        } else {
            env.storage()
                .instance()
                .set(&Symbol::new(env, "approvals"), &approvals);
        }
    }

    fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_optimized()
    }

    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("unauthorized: admin required");
        }
    }

    fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            panic!("strategy registry is paused");
        }
    }

    /// Pause strategy registry (admin only)
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);
        env.events()
            .publish((Symbol::new(&env, "registry_paused"),), (admin,));
    }

    /// Unpause strategy registry (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);
        env.events()
            .publish((Symbol::new(&env, "registry_unpaused"),), (admin,));
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{Env, Symbol, Vec};

    fn fee_structure() -> FeeStructure {
        FeeStructure {
            management_fee: 100,
            performance_fee: 200,
            deposit_fee: 50,
            withdrawal_fee: 50,
        }
    }

    fn strategy_parameters(env: &Env) -> StrategyParameters {
        StrategyParameters {
            target_tokens: Vec::from_array(env, [Address::generate(env)]),
            allocation_weights: Vec::from_array(env, [10_000u32]),
            rebalance_threshold: 500,
            impermanent_loss_limit: 1_000,
            min_apy_target: 800,
        }
    }

    fn setup(env: &Env) -> (Address, Address, StrategyRegistryClient) {
        let admin = Address::generate(env);
        let creator = Address::generate(env);
        let contract_id = env.register_contract(None, StrategyRegistry);
        let client = StrategyRegistryClient::new(env, &contract_id);
        client.initialize(&admin);
        (admin, creator, client)
    }

    fn register(env: &Env, client: &StrategyRegistryClient, creator: &Address) -> u32 {
        client.register_strategy(
            creator,
            &Symbol::new(env, "Delta_Neutral"),
            &Symbol::new(env, "Market_neutral_LP_strategy"),
            &2,
            &1_000i128,
            &500_000i128,
            &fee_structure(),
            &strategy_parameters(env),
        )
    }

    fn expect_panic(result: std::thread::Result<()>) {
        std::assert!(result.is_err(), "expected contract invocation to panic");
    }

    #[test]
    fn test_register_creates_inactive_strategy() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, creator, client) = setup(&env);

        let strategy_id = register(&env, &client, &creator);
        assert_eq!(strategy_id, 1u32);

        let strategy = client.get_strategy(&strategy_id);
        assert_eq!(strategy.strategy_id, strategy_id);
        assert_eq!(strategy.name, Symbol::new(&env, "Delta_Neutral"));
        assert_eq!(strategy.risk_level, 2u32);
        assert_eq!(strategy.min_investment, 1_000i128);
        assert_eq!(strategy.max_investment, 500_000i128);
        assert_eq!(strategy.creator, creator);
        assert!(
            !strategy.is_active,
            "strategy must start inactive pending approval"
        );

        let expected_params = strategy_parameters(&env);
        let stored_params = client.get_strategy_parameters(&strategy_id);
        assert_eq!(
            stored_params.target_tokens.len(),
            expected_params.target_tokens.len()
        );
        assert_eq!(
            stored_params.allocation_weights,
            expected_params.allocation_weights
        );
        assert_eq!(
            stored_params.rebalance_threshold,
            expected_params.rebalance_threshold
        );
        assert_eq!(
            stored_params.impermanent_loss_limit,
            expected_params.impermanent_loss_limit
        );
        assert_eq!(stored_params.min_apy_target, expected_params.min_apy_target);
        assert!(client.get_active_strategies().is_empty());
    }

    #[test]
    fn test_admin_can_approve_strategy() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, creator, client) = setup(&env);

        let strategy_id = register(&env, &client, &creator);
        client.approve_strategy(&admin, &strategy_id, &Symbol::new(&env, "Approved"));

        let strategy = client.get_strategy(&strategy_id);
        assert!(strategy.is_active, "approved strategy must be active");

        let active = client.get_active_strategies();
        assert_eq!(active.len(), 1);
        assert_eq!(active.get(0).unwrap().strategy_id, strategy_id);

        let by_risk = client.get_strategies_by_risk(&2);
        assert_eq!(by_risk.len(), 1);
        assert!(client.get_strategies_by_risk(&3).is_empty());
    }

    #[test]
    fn test_update_strategy_requires_reapproval() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, creator, client) = setup(&env);

        let strategy_id = register(&env, &client, &creator);
        client.approve_strategy(&admin, &strategy_id, &Symbol::new(&env, "Approved"));
        assert!(client.get_strategy(&strategy_id).is_active);

        // Updating flips the strategy back to inactive until re-approved.
        client.update_strategy(
            &creator,
            &strategy_id,
            &Symbol::new(&env, "Delta_Neutral_v2"),
            &Symbol::new(&env, "Updated_parameters"),
            &2,
            &2_000i128,
            &600_000i128,
            &fee_structure(),
            &strategy_parameters(&env),
        );
        assert!(!client.get_strategy(&strategy_id).is_active);
        assert!(client.get_active_strategies().is_empty());

        // Re-approval reactivates and records a second approval entry.
        client.approve_strategy(&admin, &strategy_id, &Symbol::new(&env, "Re_approved"));
        assert!(client.get_strategy(&strategy_id).is_active);

        let approvals = client.get_approval_history(&strategy_id);
        assert_eq!(approvals.len(), 2);
        for approval in approvals {
            assert_eq!(approval.strategy_id, strategy_id);
            assert_eq!(approval.approved_by, admin);
            assert_eq!(approval.approval_type, 1);
        }
    }

    #[test]
    fn test_non_admin_cannot_approve() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, creator, client) = setup(&env);
        let attacker = Address::generate(&env);

        let strategy_id = register(&env, &client, &creator);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.approve_strategy(&attacker, &strategy_id, &Symbol::new(&env, "Sneaky"));
        }));
        expect_panic(result);

        assert!(!client.get_strategy(&strategy_id).is_active);
    }

    #[test]
    fn test_non_creator_cannot_update() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, creator, client) = setup(&env);
        let stranger = Address::generate(&env);

        let strategy_id = register(&env, &client, &creator);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_strategy(
                &stranger,
                &strategy_id,
                &Symbol::new(&env, "Hijacked"),
                &Symbol::new(&env, "Hijacked"),
                &2,
                &1_000i128,
                &500_000i128,
                &fee_structure(),
                &strategy_parameters(&env),
            );
        }));
        expect_panic(result);

        assert_eq!(
            client.get_strategy(&strategy_id).name,
            Symbol::new(&env, "Delta_Neutral")
        );
    }

    #[test]
    fn test_approving_missing_strategy_panics() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, _creator, client) = setup(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.approve_strategy(&admin, &99, &Symbol::new(&env, "Nope"));
        }));
        expect_panic(result);
    }

    #[test]
    fn test_updating_missing_strategy_panics() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, creator, client) = setup(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_strategy(
                &creator,
                &99,
                &Symbol::new(&env, "Ghost"),
                &Symbol::new(&env, "Ghost"),
                &2,
                &1_000i128,
                &500_000i128,
                &fee_structure(),
                &strategy_parameters(&env),
            );
        }));
        expect_panic(result);
    }

    #[test]
    fn test_admin_can_deactivate_strategy() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, creator, client) = setup(&env);

        let strategy_id = register(&env, &client, &creator);
        client.approve_strategy(&admin, &strategy_id, &Symbol::new(&env, "Approved"));
        assert!(client.get_strategy(&strategy_id).is_active);

        client.deactivate_strategy(&admin, &strategy_id);

        let strategy = client.get_strategy(&strategy_id);
        assert!(!strategy.is_active, "deactivated strategy must be inactive");
        assert!(client.get_active_strategies().is_empty());

        // Deactivation is recorded as a removal (type 3) approval.
        let approvals = client.get_approval_history(&strategy_id);
        let removal = approvals.get(approvals.len() - 1).unwrap();
        assert_eq!(removal.approval_type, 3);
        assert_eq!(removal.approved_by, admin);
    }

    #[test]
    fn test_only_admin_can_deactivate() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, creator, client) = setup(&env);
        let attacker = Address::generate(&env);

        let strategy_id = register(&env, &client, &creator);
        client.approve_strategy(&admin, &strategy_id, &Symbol::new(&env, "Approved"));

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.deactivate_strategy(&attacker, &strategy_id);
        }));
        expect_panic(result);

        assert!(client.get_strategy(&strategy_id).is_active);
    }

    #[test]
    fn test_pause_blocks_registration() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, creator, client) = setup(&env);

        client.pause(&admin);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            register(&env, &client, &creator);
        }));
        expect_panic(result);

        client.unpause(&admin);
        let strategy_id = register(&env, &client, &creator);
        assert_eq!(strategy_id, 1u32);
    }

    #[test]
    fn test_metrics_with_performance_history() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, creator, client) = setup(&env);

        let strategy_id = register(&env, &client, &creator);
        client.approve_strategy(&admin, &strategy_id, &Symbol::new(&env, "Approved"));

        for (apy, vol, sharpe) in [(1_000, 500, 200), (2_000, 700, 300), (3_000, 900, 400)] {
            client.record_performance(&strategy_id, &10_000i128, &apy, &vol, &sharpe);
        }

        let (avg_apy, avg_vol, avg_sharpe) = client.calculate_strategy_metrics(&strategy_id);
        assert_eq!(avg_apy, 2_000);
        assert_eq!(avg_vol, 700);
        assert_eq!(avg_sharpe, 300);

        let history = client.get_performance_history(&strategy_id, &2);
        assert_eq!(history.len(), 2);
        assert_eq!(history.get(1).unwrap().net_apy, 3_000);
    }
}
