use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec, 
    unwrap::UnwrapOptimized
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolAllocation {
    pub pool_id: Address,
    pub token_a: Address,
    pub token_b: Address,
    pub allocation_percent: u32, // Basis points (10000 = 100%)
    pub target_apy: u32, // Basis points
    pub current_apy: u32, // Basis points
    pub impermanent_loss_risk: u32, // Basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalanceStrategy {
    pub strategy_id: u32,
    pub name: Symbol,
    pub risk_level: u32, // 1=Conservative, 2=Balanced, 3=Aggressive
    pub min_apy_threshold: u32, // Basis points
    pub max_il_risk: u32, // Basis points
    pub rebalance_frequency: u64, // Seconds
    pub allocations: Vec<PoolAllocation>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalanceProposal {
    pub from_pool: Address,
    pub to_pool: Address,
    pub amount_a: i128,
    pub amount_b: i128,
    pub expected_apy_improvement: u32, // Basis points
    pub estimated_gas_cost: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalanceHistory {
    pub timestamp: u64,
    pub from_pool: Address,
    pub to_pool: Address,
    pub amount_moved: i128,
    pub apy_before: u32,
    pub apy_after: u32,
    pub success: bool,
}

#[contract]
pub struct RebalanceEngine;

#[contractimpl]
impl RebalanceEngine {
    /// Initialize the rebalance engine
    pub fn initialize(env: Env, admin: Address) {
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
        env.storage().instance().set(&Symbol::new(&env, "next_strategy_id"), &1u32);
        
        // Initialize empty strategy registry
        let strategies: Vec<RebalanceStrategy> = Vec::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
        
        // Initialize empty history
        let history: Vec<RebalanceHistory> = Vec::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "history"), &history);
    }

    /// Create a new rebalance strategy
    pub fn create_strategy(
        env: Env,
        admin: Address,
        name: Symbol,
        risk_level: u32,
        min_apy_threshold: u32,
        max_il_risk: u32,
        rebalance_frequency: u64,
        allocations: Vec<PoolAllocation>,
    ) -> u32 {
        Self::require_admin(&env, admin);
        Self::require_not_paused(&env);

        let strategy_id = Self::get_next_strategy_id(&env);
        
        let strategy = RebalanceStrategy {
            strategy_id,
            name,
            risk_level,
            min_apy_threshold,
            max_il_risk,
            rebalance_frequency,
            allocations,
        };

        let mut strategies = Self::get_strategies(&env);
        strategies.push_back(strategy);
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);

        strategy_id
    }

    /// Update an existing strategy
    pub fn update_strategy(
        env: Env,
        admin: Address,
        strategy_id: u32,
        name: Symbol,
        risk_level: u32,
        min_apy_threshold: u32,
        max_il_risk: u32,
        rebalance_frequency: u64,
        allocations: Vec<PoolAllocation>,
    ) {
        Self::require_admin(&env, admin);
        Self::require_not_paused(&env);

        let mut strategies = Self::get_strategies(&env);
        let mut found = false;

        for i in 0..strategies.len() {
            if strategies.get(i).unwrap().strategy_id == strategy_id {
                let updated_strategy = RebalanceStrategy {
                    strategy_id,
                    name,
                    risk_level,
                    min_apy_threshold,
                    max_il_risk,
                    rebalance_frequency,
                    allocations,
                };
                strategies.set(i, updated_strategy);
                found = true;
                break;
            }
        }

        require!(found, "strategy not found");
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
    }

    /// Analyze current pool conditions and generate rebalance proposals
    pub fn analyze_rebalance_opportunities(
        env: Env,
        strategy_id: u32,
    ) -> Vec<RebalanceProposal> {
        Self::require_not_paused(&env);

        let strategy = Self::get_strategy(&env, strategy_id);
        let mut proposals: Vec<RebalanceProposal> = Vec::new(&env);

        // Analyze each allocation in the strategy
        for allocation in strategy.allocations {
            let current_apy = Self::get_pool_current_apy(&env, &allocation.pool_id);
            let target_apy = allocation.target_apy;

            // Check if rebalancing is needed
            if current_apy < target_apy - strategy.min_apy_threshold {
                // Find better pools
                let better_pools = Self::find_better_pools(&env, &allocation, &strategy);
                
                for better_pool in better_pools {
                    let proposal = RebalanceProposal {
                        from_pool: allocation.pool_id.clone(),
                        to_pool: better_pool.pool_id,
                        amount_a: Self::estimate_rebalance_amount(&env, &allocation.pool_id),
                        amount_b: Self::estimate_rebalance_amount(&env, &allocation.pool_id),
                        expected_apy_improvement: better_pool.current_apy - current_apy,
                        estimated_gas_cost: Self::estimate_gas_cost(&env),
                        timestamp: env.ledger().timestamp(),
                    };
                    proposals.push_back(proposal);
                }
            }
        }

        proposals
    }

    /// Execute a rebalance proposal
    pub fn execute_rebalance(
        env: Env,
        caller: Address,
        proposal: RebalanceProposal,
    ) -> bool {
        Self::require_not_paused(&env);

        // Verify caller is authorized (could be a vault or authorized manager)
        // For now, allow any caller - in production, add proper authorization

        let apy_before = Self::get_pool_current_apy(&env, &proposal.from_pool);
        let mut success = false;

        // Execute the rebalance (simplified - would integrate with AMM contracts)
        if Self::perform_rebalance(&env, &proposal) {
            success = true;
        }

        // Record in history
        let history_entry = RebalanceHistory {
            timestamp: env.ledger().timestamp(),
            from_pool: proposal.from_pool,
            to_pool: proposal.to_pool,
            amount_moved: proposal.amount_a + proposal.amount_b,
            apy_before,
            apy_after: if success { 
                Self::get_pool_current_apy(&env, &proposal.to_pool) 
            } else { 
                apy_before 
            },
            success,
        };

        Self::add_to_history(&env, history_entry);

        success
    }

    /// Get all strategies
    pub fn get_strategies(env: Env) -> Vec<RebalanceStrategy> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "strategies"))
            .unwrap_optimized()
    }

    /// Get specific strategy
    pub fn get_strategy(env: Env, strategy_id: u32) -> RebalanceStrategy {
        let strategies = Self::get_strategies(env);
        for strategy in strategies {
            if strategy.strategy_id == strategy_id {
                return strategy;
            }
        }
        panic!("strategy not found");
    }

    /// Get rebalance history
    pub fn get_history(env: Env, limit: u32) -> Vec<RebalanceHistory> {
        let history: Vec<RebalanceHistory> = env.storage()
            .instance()
            .get(&Symbol::new(&env, "history"))
            .unwrap_optimized();

        let mut result: Vec<RebalanceHistory> = Vec::new(&env);
        let start = if history.len() > limit {
            history.len() - limit
        } else {
            0
        };

        for i in start..history.len() {
            result.push_back(history.get(i).unwrap());
        }

        result
    }

    /// Get current allocations for a strategy
    pub fn get_current_allocations(env: Env, strategy_id: u32) -> Vec<PoolAllocation> {
        let strategy = Self::get_strategy(env, strategy_id);
        strategy.allocations
    }

    /// Calculate impermanent loss for a pool
    pub fn calculate_impermanent_loss(
        env: Env,
        pool_id: Address,
        price_ratio: i128, // Current price ratio * 10000
        initial_price_ratio: i128, // Initial price ratio * 10000
    ) -> u32 {
        // IL formula: 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
        // Simplified calculation for demonstration
        let ratio_diff = (price_ratio - initial_price_ratio).abs();
        let il_percent = (ratio_diff * ratio_diff) / (initial_price_ratio * initial_price_ratio / 10000);
        
        // Cap at 100% and convert to basis points
        if il_percent > 10000 {
            10000
        } else {
            il_percent as u32
        }
    }

    /// Helper functions
    fn get_next_strategy_id(env: &Env) -> u32 {
        let id: u32 = env.storage()
            .instance()
            .get(&Symbol::new(env, "next_strategy_id"))
            .unwrap_optimized();
        env.storage().instance().set(&Symbol::new(env, "next_strategy_id"), &(id + 1));
        id
    }

    fn get_pool_current_apy(env: &Env, pool_id: &Address) -> u32 {
        // This would integrate with Stellar AMM to get real APY
        // For demonstration, return a simulated value
        1500 // 15% APY
    }

    fn find_better_pools(
        env: &Env,
        current_allocation: &PoolAllocation,
        strategy: &RebalanceStrategy,
    ) -> Vec<PoolAllocation> {
        let mut better_pools: Vec<PoolAllocation> = Vec::new(env);
        
        // In production, this would query all available pools
        // For demonstration, return a simulated better pool
        if current_allocation.current_apy < strategy.min_apy_threshold {
            better_pools.push_back(PoolAllocation {
                pool_id: Address::generate(env),
                token_a: current_allocation.token_a.clone(),
                token_b: current_allocation.token_b.clone(),
                allocation_percent: current_allocation.allocation_percent,
                target_apy: current_allocation.target_apy + 500, // 5% higher
                current_apy: current_allocation.current_apy + 600, // 6% higher
                impermanent_loss_risk: current_allocation.impermanent_loss_risk,
            });
        }

        better_pools
    }

    fn estimate_rebalance_amount(env: &Env, pool_id: &Address) -> i128 {
        // This would calculate the actual amount in the pool
        // For demonstration, return a simulated value
        1000000i128
    }

    fn estimate_gas_cost(env: &Env) -> i128 {
        // Estimate gas cost for rebalance transaction
        50000i128
    }

    fn perform_rebalance(env: &Env, proposal: &RebalanceProposal) -> bool {
        // This would execute the actual rebalance through AMM contracts
        // For demonstration, return true
        true
    }

    fn add_to_history(env: &Env, entry: RebalanceHistory) {
        let mut history: Vec<RebalanceHistory> = env.storage()
            .instance()
            .get(&Symbol::new(env, "history"))
            .unwrap_optimized();
        
        history.push_back(entry);
        
        // Keep only last 1000 entries
        if history.len() > 1000 {
            let start = history.len() - 1000;
            let mut trimmed: Vec<RebalanceHistory> = Vec::new(env);
            for i in start..history.len() {
                trimmed.push_back(history.get(i).unwrap());
            }
            env.storage().instance().set(&Symbol::new(env, "history"), &trimmed);
        } else {
            env.storage().instance().set(&Symbol::new(env, "history"), &history);
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
        require!(caller == admin, "unauthorized: admin required");
    }

    fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            panic!("rebalance engine is paused");
        }
    }

    /// Pause rebalance engine (admin only)
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause rebalance engine (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
    }
}
