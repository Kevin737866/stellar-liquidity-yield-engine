use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec, 
    unwrap::UnwrapOptimized
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
    pub management_fee: u32, // Annual fee in basis points
    pub performance_fee: u32, // Performance fee in basis points
    pub deposit_fee: u32, // Deposit fee in basis points
    pub withdrawal_fee: u32, // Withdrawal fee in basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PerformanceRecord {
    pub timestamp: u64,
    pub total_value: i128,
    pub net_apy: u32, // Net APY after fees
    pub volatility: u32, // Volatility measure in basis points
    pub sharpe_ratio: u32, // Sharpe ratio scaled by 10000
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyParameters {
    pub target_tokens: Vec<Address>,
    pub allocation_weights: Vec<u32>, // Corresponding weights in basis points
    pub rebalance_threshold: u32, // Rebalance when allocation deviates by this much
    pub impermanent_loss_limit: u32, // Maximum acceptable IL in basis points
    pub min_apy_target: u32, // Minimum APY target in basis points
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

#[contract]
pub struct StrategyRegistry;

#[contractimpl]
impl StrategyRegistry {
    /// Initialize the strategy registry
    pub fn initialize(env: Env, admin: Address) {
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
        env.storage().instance().set(&Symbol::new(&env, "next_strategy_id"), &1u32);
        
        // Initialize empty collections
        let strategies: Vec<YieldStrategy> = Vec::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
        
        let approvals: Vec<StrategyApproval> = Vec::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "approvals"), &approvals);
        
        let strategy_params: Map<u32, StrategyParameters> = Map::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "strategy_params"), &strategy_params);
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
        
        let mut strategies = Self::get_strategies(&env);
        strategies.push_back(strategy);
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
        
        // Store strategy parameters
        let mut strategy_params = Self::get_strategy_params(&env);
        strategy_params.set(strategy_id, parameters);
        env.storage().instance().set(&Symbol::new(&env, "strategy_params"), &strategy_params);
        
        strategy_id
    }

    /// Approve a strategy (admin only)
    pub fn approve_strategy(
        env: Env,
        admin: Address,
        strategy_id: u32,
        comments: Symbol,
    ) {
        Self::require_admin(&env, admin);
        
        let mut strategies = Self::get_strategies(&env);
        let mut found = false;
        
        for i in 0..strategies.len() {
            if strategies.get(i).unwrap().strategy_id == strategy_id {
                let mut strategy = strategies.get(i).unwrap();
                strategy.is_active = true;
                strategy.updated_at = env.ledger().timestamp();
                strategies.set(i, strategy);
                found = true;
                break;
            }
        }
        
        require!(found, "strategy not found");
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
        
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
        
        let mut strategies = Self::get_strategies(&env);
        let mut found = false;
        
        for i in 0..strategies.len() {
            if strategies.get(i).unwrap().strategy_id == strategy_id {
                let strategy = strategies.get(i).unwrap();
                require!(strategy.creator == creator, "unauthorized: not strategy creator");
                
                let updated_strategy = YieldStrategy {
                    strategy_id,
                    name,
                    description,
                    creator,
                    risk_level,
                    min_investment,
                    max_investment,
                    fee_structure,
                    performance_history: strategy.performance_history,
                    is_active: false, // Requires re-approval after update
                    created_at: strategy.created_at,
                    updated_at: env.ledger().timestamp(),
                };
                
                strategies.set(i, updated_strategy);
                found = true;
                break;
            }
        }
        
        require!(found, "strategy not found");
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
        
        // Update strategy parameters
        let mut strategy_params = Self::get_strategy_params(&env);
        strategy_params.set(strategy_id, parameters);
        env.storage().instance().set(&Symbol::new(&env, "strategy_params"), &strategy_params);
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
        
        let mut strategies = Self::get_strategies(&env);
        let mut found = false;
        
        for i in 0..strategies.len() {
            if strategies.get(i).unwrap().strategy_id == strategy_id {
                let mut strategy = strategies.get(i).unwrap();
                
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
                    let start = strategy.performance_history.len() - 100;
                    let mut trimmed: Vec<PerformanceRecord> = Vec::new(&env);
                    for j in start..strategy.performance_history.len() {
                        trimmed.push_back(strategy.performance_history.get(j).unwrap());
                    }
                    strategy.performance_history = trimmed;
                }
                
                strategies.set(i, strategy);
                found = true;
                break;
            }
        }
        
        require!(found, "strategy not found");
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
    }

    /// Deactivate a strategy
    pub fn deactivate_strategy(env: Env, admin: Address, strategy_id: u32) {
        Self::require_admin(&env, admin);
        
        let mut strategies = Self::get_strategies(&env);
        let mut found = false;
        
        for i in 0..strategies.len() {
            if strategies.get(i).unwrap().strategy_id == strategy_id {
                let mut strategy = strategies.get(i).unwrap();
                strategy.is_active = false;
                strategy.updated_at = env.ledger().timestamp();
                strategies.set(i, strategy);
                found = true;
                break;
            }
        }
        
        require!(found, "strategy not found");
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
        
        // Record deactivation
        let approval = StrategyApproval {
            strategy_id,
            approved_by: admin,
            approved_at: env.ledger().timestamp(),
            approval_type: 3, // Removal
            Symbol::new(&env, "Deactivated by admin"),
        };
        
        Self::add_approval(&env, approval);
    }

    /// Get all active strategies
    pub fn get_active_strategies(env: Env) -> Vec<YieldStrategy> {
        let strategies = Self::get_strategies(env);
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
        let strategies = Self::get_strategies(env);
        let mut filtered_strategies: Vec<YieldStrategy> = Vec::new(&env);
        
        for strategy in strategies {
            if strategy.risk_level == risk_level && strategy.is_active {
                filtered_strategies.push_back(strategy);
            }
        }
        
        filtered_strategies
    }

    /// Get strategy details
    pub fn get_strategy(env: Env, strategy_id: u32) -> YieldStrategy {
        let strategies = Self::get_strategies(env);
        for strategy in strategies {
            if strategy.strategy_id == strategy_id {
                return strategy;
            }
        }
        panic!("strategy not found");
    }

    /// Get strategy parameters
    pub fn get_strategy_parameters(env: Env, strategy_id: u32) -> StrategyParameters {
        let strategy_params = Self::get_strategy_params(&env);
        strategy_params
            .get(strategy_id)
            .unwrap_or_else(|| panic!("strategy parameters not found"))
    }

    /// Get strategy performance history
    pub fn get_performance_history(env: Env, strategy_id: u32, limit: u32) -> Vec<PerformanceRecord> {
        let strategy = Self::get_strategy(env, strategy_id);
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
        let id: u32 = env.storage()
            .instance()
            .get(&Symbol::new(env, "next_strategy_id"))
            .unwrap_optimized();
        env.storage().instance().set(&Symbol::new(env, "next_strategy_id"), &(id + 1));
        id
    }

    fn get_strategies(env: Env) -> Vec<YieldStrategy> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "strategies"))
            .unwrap_optimized()
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
            env.storage().instance().set(&Symbol::new(env, "approvals"), &trimmed);
        } else {
            env.storage().instance().set(&Symbol::new(env, "approvals"), &approvals);
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
            panic!("strategy registry is paused");
        }
    }

    /// Pause strategy registry (admin only)
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause strategy registry (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
    }
}
