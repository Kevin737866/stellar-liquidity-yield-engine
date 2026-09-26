use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec,
    unwrap::UnwrapOptimized
};
use soroban_sdk::token::TokenClient;

use crate::YieldVaultClient;

/// Upper bound accepted for an oracle APY observation: 1,000,000 bps = 10,000%.
/// Guards against a misconfigured feed pushing nonsense into rebalance maths.
pub const MAX_APY_BPS: u32 = 1_000_000;

/// Default age after which an APY observation is considered stale: 24 hours.
pub const DEFAULT_MAX_APY_AGE: u64 = 86_400;

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

/// Arbitrage opportunity structure
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArbitrageOpportunity {
    pub pool_id: Address,
    pub current_apy: u32, // Basis points
    pub projected_apy: u32, // Basis points after rebalance
    pub il_risk: u32, // Basis points
    pub net_profit: i128, // In native token units
    pub apy_delta: u32, // Difference in basis points
    pub recommended: bool,
}

/// Arbitrage rebalance threshold configuration
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArbitrageThresholds {
    pub min_apy_delta: u32, // Minimum APY difference to trigger rebalance (basis points)
    pub max_il_tolerance: u32, // Maximum acceptable IL (basis points)
    pub cooldown_period: u64, // Seconds between rebalances per vault
    pub last_rebalance_time: u64, // Timestamp of last rebalance
}

/// One oracle observation for a pool (Issue #105)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolApyRecord {
    pub apy_bps: u32, // Observed APY in basis points (10000 = 100%)
    pub updated_at: u64, // Ledger timestamp the feed was refreshed
    pub updated_by: Address, // Admin or keeper that pushed the observation
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
        
        // Initialize empty strategy registry as Map for O(1) access (Issue #108)
        let strategies: Map<u32, RebalanceStrategy> = Map::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);
        
        // Initialize empty history
        let history: Vec<RebalanceHistory> = Vec::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "history"), &history);

        // Initialize the APY registry, the keeper set and the staleness bound
        // (Issue #105).
        let apy_registry: Map<Address, PoolApyRecord> = Map::new(&env);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pool_apy"), &apy_registry);
        let keepers: Vec<Address> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "apy_keepers"), &keepers);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "max_apy_age"), &DEFAULT_MAX_APY_AGE);
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
        Self::require_admin(&env, admin.clone());
        Self::require_not_paused(&env);
        Self::validate_allocations(&allocations);

        let strategy_id = Self::get_next_strategy_id(&env);
        
        let strategy = RebalanceStrategy {
            strategy_id,
            name: name.clone(),
            risk_level,
            min_apy_threshold,
            max_il_risk,
            rebalance_frequency,
            allocations,
        };

        let mut strategies = Self::get_strategies_map(env.clone());
        require!(risk_level >= 1 && risk_level <= 3, "risk_level must be 1-3");
        strategies.set(strategy_id, strategy.clone());
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);

        env.events().publish(
            (Symbol::new(&env, "rebalance_strategy_created"), strategy_id),
            (admin, name, risk_level),
        );

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
        Self::require_admin(&env, admin.clone());
        Self::require_not_paused(&env);
        Self::validate_allocations(&allocations);
        require!(risk_level >= 1 && risk_level <= 3, "risk_level must be 1-3");

        let mut strategies = Self::get_strategies_map(env.clone());
        if strategies.get(strategy_id).is_none() {
            panic!("strategy not found");
        }
        let updated_strategy = RebalanceStrategy {
            strategy_id,
            name: name.clone(),
            risk_level,
            min_apy_threshold,
            max_il_risk,
            rebalance_frequency,
            allocations,
        };
        strategies.set(strategy_id, updated_strategy);
        env.storage().instance().set(&Symbol::new(&env, "strategies"), &strategies);

        env.events().publish(
            (Symbol::new(&env, "rebalance_strategy_updated"), strategy_id),
            (admin, name, risk_level),
        );
    }

    /// Analyze current pool conditions and generate rebalance proposals
    pub fn analyze_rebalance_opportunities(
        env: Env,
        strategy_id: u32,
    ) -> Vec<RebalanceProposal> {
        Self::require_not_paused(&env);

        let strategy = Self::get_strategy(env.clone(), strategy_id);
        let mut proposals: Vec<RebalanceProposal> = Vec::new(&env);

        // Analyze each allocation in the strategy
        for allocation in strategy.allocations.iter() {
            // Prefer the live oracle value over the APY snapshot stored in the
            // strategy, falling back to the snapshot when no fresh feed exists.
            let current_apy = Self::resolve_apy(&env, &allocation.pool_id, allocation.current_apy);
            let target_apy = allocation.target_apy;

            // Check if rebalancing is needed
            if current_apy < target_apy - strategy.min_apy_threshold {
                // Find better pools
                let better_pools = Self::find_better_pools(&env, &allocation, &strategy, current_apy);
                
                for better_pool in better_pools {
                    let proposal = RebalanceProposal {
                        from_pool: allocation.pool_id.clone(),
                        to_pool: better_pool.pool_id,
                        amount_a: allocation.allocation_percent as i128,
                        amount_b: allocation.allocation_percent as i128,
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

        let apy_before = Self::get_pool_current_apy(env.clone(), proposal.from_pool.clone());
        let mut success = false;

        // Execute the rebalance (simplified - would integrate with AMM contracts)
        if Self::perform_rebalance(&env, &proposal) {
            success = true;
        }

        let apy_after = if success {
            Self::get_pool_current_apy(env.clone(), proposal.to_pool.clone())
        } else {
            apy_before
        };

        // Record in history
        let history_entry = RebalanceHistory {
            timestamp: env.ledger().timestamp(),
            from_pool: proposal.from_pool,
            to_pool: proposal.to_pool,
            amount_moved: proposal.amount_a + proposal.amount_b,
            apy_before,
            apy_after,
            success,
        };

        Self::add_to_history(&env, history_entry);

        success
    }

    /// Validate that allocations are non-empty, each within bounds (<= 10000 bps),
    /// and that the percentages sum to exactly 10000 bps (100%).
    fn validate_allocations(allocations: &Vec<PoolAllocation>) {
        require!(!allocations.is_empty(), "allocations must not be empty");

        let mut total_bps: u64 = 0;
        for allocation in allocations.iter() {
            require!(
                allocation.allocation_percent <= 10000,
                "allocation_percent must not exceed 10000 bps (100%)"
            );
            total_bps += allocation.allocation_percent as u64;
        }

        require!(
            total_bps == 10000,
            "allocations must sum to exactly 10000 bps (100%)"
        );
    }

    /// Internal: get strategies Map for O(1) access
    pub fn get_strategies_map(env: Env) -> Map<u32, RebalanceStrategy> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "strategies"))
            .unwrap_optimized()
    }

    /// Get all strategies as Vec (materialized from Map)
    pub fn get_strategies(env: Env) -> Vec<RebalanceStrategy> {
        let map = Self::get_strategies_map(env.clone());
        let mut v: Vec<RebalanceStrategy> = Vec::new(&env);
        for (_, strat) in map.iter() {
            v.push_back(strat);
        }
        v
    }

    /// Get specific strategy - O(1)
    pub fn get_strategy(env: Env, strategy_id: u32) -> RebalanceStrategy {
        Self::get_strategies_map(env)
            .get(strategy_id)
            .unwrap_or_else(|| panic!("strategy not found"))
    }

    /// Paginated strategy listing (Issue #107)
    pub fn get_strategies_paginated(env: Env, limit: u32, offset: u32) -> Vec<RebalanceStrategy> {
        let all = Self::get_strategies(env.clone());
        if limit == 0 || offset >= all.len() {
            return Vec::new(&env);
        }
        let mut out: Vec<RebalanceStrategy> = Vec::new(&env);
        let end = (offset + limit).min(all.len());
        for i in offset..end {
            out.push_back(all.get(i).unwrap());
        }
        out
    }

    pub fn get_strategy_count(env: Env) -> u32 {
        Self::get_strategies_map(env).len()
    }

    /// Get rebalance history - most recent `limit` entries (backward compat)
    pub fn get_history(env: Env, limit: u32) -> Vec<RebalanceHistory> {
        // A limit of 0 means no results should be returned
        if limit == 0 {
            return Vec::new(&env);
        }

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

    /// Paginated history with limit/offset for bounded reads (Issue #107)
    pub fn get_history_paginated(env: Env, limit: u32, offset: u32) -> Vec<RebalanceHistory> {
        let history: Vec<RebalanceHistory> = env.storage()
            .instance()
            .get(&Symbol::new(&env, "history"))
            .unwrap_optimized();
        if limit == 0 || offset >= history.len() {
            return Vec::new(&env);
        }
        let mut out: Vec<RebalanceHistory> = Vec::new(&env);
        let end = (offset + limit).min(history.len());
        for i in offset..end {
            out.push_back(history.get(i).unwrap());
        }
        out
    }

    pub fn get_history_count(env: Env) -> u32 {
        let h: Vec<RebalanceHistory> = env.storage()
            .instance()
            .get(&Symbol::new(&env, "history"))
            .unwrap_optimized();
        h.len()
    }

    /// Get current allocations for a strategy
    pub fn get_current_allocations(env: Env, strategy_id: u32) -> Vec<PoolAllocation> {
        let strategy = Self::get_strategy(env, strategy_id);
        strategy.allocations
    }

    // ============ APY ORACLE REGISTRY (Issue #105) ============

    /// Publish an APY observation for a pool (admin or APY keeper).
    ///
    /// This replaces the previous hardcoded APY. Rebalance analysis and
    /// `get_pool_current_apy` now read this registry, so a keeper (or the admin)
    /// feeding real numbers is what drives rebalance decisions.
    pub fn update_pool_apy(env: Env, caller: Address, pool_id: Address, apy_bps: u32) {
        Self::require_not_paused(&env);
        Self::require_admin_or_apy_keeper(&env, caller.clone());
        require!(apy_bps <= MAX_APY_BPS, "apy_bps exceeds maximum");

        let record = PoolApyRecord {
            apy_bps,
            updated_at: env.ledger().timestamp(),
            updated_by: caller.clone(),
        };

        let mut registry = Self::get_apy_registry(env.clone());
        registry.set(pool_id.clone(), record);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pool_apy"), &registry);

        env.events().publish(
            (Symbol::new(&env, "pool_apy_updated"), pool_id),
            (caller, apy_bps),
        );
    }

    /// Current APY of a pool from the oracle registry, in basis points.
    ///
    /// Returns 0 when no feed has been published for `pool_id`; 0 means
    /// "unknown" and is deliberately not a fabricated rate.
    pub fn get_pool_current_apy(env: Env, pool_id: Address) -> u32 {
        Self::get_apy_registry(env.clone())
            .get(pool_id)
            .map(|record| record.apy_bps)
            .unwrap_or(0u32)
    }

    /// Full oracle record for a pool, if a feed exists.
    pub fn get_pool_apy_record(env: Env, pool_id: Address) -> Option<PoolApyRecord> {
        Self::get_apy_registry(env).get(pool_id)
    }

    /// Age in seconds after which an APY observation is rejected as stale.
    pub fn get_max_apy_age(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "max_apy_age"))
            .unwrap_or(DEFAULT_MAX_APY_AGE)
    }

    /// Set the maximum age of a usable APY observation (admin only).
    pub fn set_max_apy_age(env: Env, admin: Address, max_age: u64) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "max_apy_age"), &max_age);

        env.events().publish(
            (Symbol::new(&env, "max_apy_age_updated"),),
            (admin, max_age),
        );
    }

    /// True when the pool has an observation that is still within the
    /// configured maximum age.
    pub fn is_apy_fresh(env: Env, pool_id: Address) -> bool {
        match Self::get_apy_registry(env.clone()).get(pool_id) {
            Some(record) => {
                let age = env.ledger().timestamp().saturating_sub(record.updated_at);
                age <= Self::get_max_apy_age(env)
            }
            None => false,
        }
    }

    /// Replace the set of addresses allowed to push APY observations (admin only).
    /// The admin can always update feeds and does not need to be listed.
    pub fn set_apy_keepers(env: Env, admin: Address, keepers: Vec<Address>) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "apy_keepers"), &keepers);

        env.events().publish(
            (Symbol::new(&env, "apy_keepers_updated"),),
            (admin, keepers),
        );
    }

    /// Current APY keeper set
    pub fn get_apy_keepers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "apy_keepers"))
            .unwrap_or(Vec::new(&env))
    }

    /// Calculate impermanent loss for a pool using the standard formula
    /// `IL = 1 - 2 * sqrt(r) / (1 + r)`, where `r = current_price / entry_price`.
    /// Returns the loss as basis points, capped at 10000 (100%).
    ///
    /// All arithmetic is scaled and multiplies-before-dividing so that the
    /// integer division never truncates intermediate terms (avoiding the
    /// discontinuous results of the previous `diff^2 / initial^2` approximation).
    pub fn calculate_impermanent_loss(
        env: Env,
        pool_id: Address,
        price_ratio: i128, // Current price ratio * 10000
        initial_price_ratio: i128, // Initial price ratio * 10000
    ) -> u32 {
        if price_ratio <= 0 || initial_price_ratio <= 0 {
            return 0;
        }

        // r scaled by 10000: (current / entry) * 10000
        let r_scaled = (price_ratio as i128 * 10000) / initial_price_ratio;

        // sqrt(r) scaled by 10000 = sqrt(r_scaled * 10000)
        let sqrt_r_scaled = Self::isqrt((r_scaled as u128) * 10000);

        // term = (2 * sqrt(r) / (1 + r)) * 10000
        let denominator = r_scaled as u128 + 10000;
        let two_sqrt = sqrt_r_scaled * 2;
        let term = (two_sqrt * 10000) / denominator;

        // By AM-GM, 1 + r >= 2 * sqrt(r), so term <= 10000 always and
        // `10000 - term` can never underflow. IL rises as the price diverges.
        let il_bp = if term >= 10000 { 0 } else { 10000 - term };
        il_bp.min(10000) as u32
    }

    /// Integer square root (Babylonian), returns floor(sqrt(n)).
    fn isqrt(n: u128) -> u128 {
        if n <= 1 {
            return n;
        }
        let mut x = n;
        let mut y = (x + 1) / 2;
        while y < x {
            x = y;
            y = (x + n / x) / 2;
        }
        x
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

    /// Internal: the APY oracle registry, keyed by pool address.
    fn get_apy_registry(env: Env) -> Map<Address, PoolApyRecord> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "pool_apy"))
            .unwrap_or(Map::new(&env))
    }

    /// Internal: resolve the APY to use for a pool.
    ///
    /// A fresh oracle observation always wins. Without a feed - or once the feed
    /// is older than `max_apy_age` - the APY snapshot stored in the strategy is
    /// used so an existing configuration keeps working without a keeper.
    fn resolve_apy(env: &Env, pool_id: &Address, fallback: u32) -> u32 {
        let registry = Self::get_apy_registry(env.clone());
        let record = match registry.get(pool_id.clone()) {
            Some(record) => record,
            None => return fallback,
        };

        let age = env.ledger().timestamp().saturating_sub(record.updated_at);
        if age > Self::get_max_apy_age(env.clone()) {
            fallback
        } else {
            record.apy_bps
        }
    }

    fn find_better_pools(
        env: &Env,
        current_allocation: &PoolAllocation,
        strategy: &RebalanceStrategy,
        current_apy: u32,
    ) -> Vec<PoolAllocation> {
        let mut better_pools: Vec<PoolAllocation> = Vec::new(env);
        
        // Only return pools already registered in the strategy allocations.
        // Each candidate APY is resolved through the oracle first so a stale
        // snapshot in the strategy cannot hide (or invent) an opportunity.
        for mut candidate in strategy.allocations.iter() {
            let candidate_apy = Self::resolve_apy(env, &candidate.pool_id, candidate.current_apy);
            if candidate.pool_id != current_allocation.pool_id
                && candidate_apy > current_apy
                && candidate_apy - current_apy >= strategy.min_apy_threshold
                && candidate.impermanent_loss_risk <= strategy.max_il_risk
            {
                // Report the oracle-resolved APY so callers price the move correctly.
                candidate.current_apy = candidate_apy;
                better_pools.push_back(candidate);
            }
        }

        better_pools
    }

    fn estimate_rebalance_amount(_env: &Env, _pool_id: &Address) -> i128 {
        0
    }

    fn estimate_gas_cost(env: &Env) -> i128 {
        // Estimate gas cost for rebalance transaction
        50000i128
    }

    fn perform_rebalance(env: &Env, proposal: &RebalanceProposal) -> bool {
        // Reject malformed proposals instead of silently reporting success.
        if proposal.amount_a <= 0 || proposal.amount_b <= 0 {
            return false;
        }

        // 1. Withdraw the position from the source pool.
        let from_token = TokenClient::new(env, &proposal.from_pool);
        from_token.transfer(
            &proposal.from_pool,
            &env.current_contract_address(),
            &proposal.amount_a,
        );

        // 2. Swap: in a full deployment this leg is routed through the registered
        //    swap router. Here the withdrawn position is moved directly to the
        //    target pool as the deposit leg.
        // 3. Deposit the position into the target pool.
        let to_token = TokenClient::new(env, &proposal.to_pool);
        to_token.transfer(
            &env.current_contract_address(),
            &proposal.to_pool,
            &proposal.amount_b,
        );

        env.events().publish(
            ("rebalance_executed",),
            (
                &proposal.from_pool,
                &proposal.to_pool,
                proposal.amount_a,
                proposal.amount_b,
            ),
        );

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

    /// Allow the admin or any configured APY keeper to push oracle data.
    fn require_admin_or_apy_keeper(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        if caller == admin {
            return;
        }

        let keepers: Vec<Address> = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "apy_keepers"))
            .unwrap_or(Vec::new(env));

        for keeper in keepers.iter() {
            if keeper == caller {
                return;
            }
        }

        panic!("unauthorized: admin or apy keeper required");
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
        Self::require_admin(&env, admin.clone());
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
        env.events()
            .publish((Symbol::new(&env, "rebalance_paused"),), (admin,));
    }

    /// Unpause rebalance engine (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
        env.events()
            .publish((Symbol::new(&env, "rebalance_unpaused"),), (admin,));
    }

    // ============ ARBITRAGE STRATEGY METHODS ============

    /// Set rebalance thresholds for arbitrage strategy
    pub fn set_rebalance_thresholds(
        env: Env,
        admin: Address,
        min_apy_delta: u32,
        max_il_tolerance: u32,
        cooldown_period: u64,
    ) {
        Self::require_admin(&env, admin.clone());
        
        let thresholds = ArbitrageThresholds {
            min_apy_delta,
            max_il_tolerance,
            cooldown_period,
            last_rebalance_time: 0u64,
        };
        
        env.storage().instance().set(&Symbol::new(&env, "arbitrage_thresholds"), &thresholds);

        env.events().publish(
            (Symbol::new(&env, "thresholds_updated"),),
            (admin, min_apy_delta, max_il_tolerance, cooldown_period),
        );
    }

    /// Get current arbitrage thresholds
    pub fn get_arbitrage_thresholds(env: Env) -> ArbitrageThresholds {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "arbitrage_thresholds"))
            .unwrap_or(ArbitrageThresholds {
                min_apy_delta: 200u32, // Default 2%
                max_il_tolerance: 100u32, // Default 1%
                cooldown_period: 86400u64, // Default 24 hours
                last_rebalance_time: 0u64,
            })
    }

    /// Scan available pools and identify arbitrage opportunities
    /// Monitors up to 50+ Stellar AMM pools for yield discrepancies
    pub fn scan_opportunities(
        env: Env,
        vault_pool_id: Address,
        vault_current_apy: u32,
        available_pools: Vec<PoolAllocation>, // List of all available pools
    ) -> Vec<ArbitrageOpportunity> {
        Self::require_not_paused(&env);
        
        let thresholds = Self::get_arbitrage_thresholds(env.clone());
        let mut opportunities: Vec<ArbitrageOpportunity> = Vec::new(&env);

        // A fresh oracle feed for the vault's own pool overrides the APY the
        // caller passed in, so a stale off-chain value cannot hide an arbitrage.
        let vault_apy = Self::resolve_apy(&env, &vault_pool_id, vault_current_apy);

        // Scan each available pool
        for pool in available_pools {
            // Same for the candidate pool: the registry wins over the snapshot.
            let pool_apy = Self::resolve_apy(&env, &pool.pool_id, pool.current_apy);
            let apy_delta = pool_apy.saturating_sub(vault_apy);

            // Check if opportunity meets minimum APY delta threshold
            if apy_delta >= thresholds.min_apy_delta && pool.impermanent_loss_risk <= thresholds.max_il_tolerance {
                // Estimated net profit = APY improvement - IL risk - slippage (simplified)
                let net_profit_estimate = ((apy_delta as i128 - pool.impermanent_loss_risk as i128) * 1000000) / 10000;

                let opportunity = ArbitrageOpportunity {
                    pool_id: pool.pool_id,
                    current_apy: vault_apy,
                    projected_apy: pool_apy,
                    il_risk: pool.impermanent_loss_risk,
                    net_profit: net_profit_estimate,
                    apy_delta,
                    recommended: apy_delta >= thresholds.min_apy_delta * 2, // Strongly recommend if delta is 2x threshold
                };

                opportunities.push_back(opportunity);
            }
        }

        opportunities
    }

    /// Calculate the total cost of rebalancing including all fees and return a
    /// clear profitability decision.
    ///
    /// Returns `(total_cost, net_profit, is_profitable)` where `net_profit` is
    /// `expected_profit - total_cost` and `is_profitable` is true when the net
    /// profit is strictly greater than zero.
    pub fn calculate_rebalance_cost(
        env: Env,
        from_pool: Address,
        to_pool: Address,
        amount: i128,
        gas_estimate: i128,
        il_basis_points: u32,
        entry_fee_basis_points: u32,
        expected_profit: i128,
    ) -> (i128, i128, bool) {
        // IL cost in absolute terms
        let il_cost = (amount * il_basis_points as i128) / 10000;
        
        // Entry fee cost
        let entry_cost = (amount * entry_fee_basis_points as i128) / 10000;
        
        // Total cost = gas + IL + entry fees (slippage estimated at 10 bp)
        let slippage_cost = (amount * 10i128) / 10000;
        let total_cost = gas_estimate + il_cost + entry_cost + slippage_cost;

        // Profitability threshold: net profit must exceed 0.
        let net_profit = expected_profit - total_cost;
        let is_profitable = net_profit > 0;

        (total_cost, net_profit, is_profitable)
    }

    /// Execute atomic flash rebalance: withdraw → swap → deposit in single transaction
    /// Cooldown is tracked per vault so one vault's rebalance does not block others.
    pub fn execute_flash_rebalance(
        env: Env,
        caller: Address,
        vault_id: Address,
        opportunity: ArbitrageOpportunity,
        amount: i128,
    ) -> bool {
        Self::require_not_paused(&env);

        // Check per-vault cooldown
        let thresholds = Self::get_arbitrage_thresholds(env.clone());
        let last_rebalance_times: Map<Address, u64> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "vault_last_rebalance_times"))
            .unwrap_or(Map::new(&env));

        let vault_last_time = last_rebalance_times.get(vault_id.clone()).unwrap_or(0u64);
        let time_since_last = env.ledger().timestamp() - vault_last_time;

        // Enforce cooldown per vault to prevent churn
        if time_since_last < thresholds.cooldown_period {
            return false;
        }

        // The vault's real current pool, queried from the vault contract itself
        // rather than fabricated - see #154.
        let current_pool = YieldVaultClient::new(&env, &vault_id).get_vault_info().pool_id;

        // 1. Withdraw from current pool (atomic operation 1)
        let withdrawn = Self::perform_rebalance(
            &env,
            &RebalanceProposal {
                from_pool: current_pool.clone(),
                to_pool: current_pool.clone(),
                amount_a: amount,
                amount_b: amount,
                expected_apy_improvement: opportunity.apy_delta,
                estimated_gas_cost: 30000,
                timestamp: env.ledger().timestamp(),
            },
        );

        if !withdrawn {
            return false;
        }

        // 2. Deposit to new pool if needed (atomic operation 2)
        let deposited = Self::perform_rebalance(
            &env,
            &RebalanceProposal {
                from_pool: current_pool,
                to_pool: opportunity.pool_id,
                amount_a: amount,
                amount_b: amount,
                expected_apy_improvement: opportunity.apy_delta,
                estimated_gas_cost: 30000,
                timestamp: env.ledger().timestamp(),
            },
        );

        if deposited {
            // Update per-vault last rebalance timestamp
            let mut times = last_rebalance_times;
            times.set(vault_id, env.ledger().timestamp());
            env.storage().instance().set(&Symbol::new(&env, "vault_last_rebalance_times"), &times);
        }

        deposited
    }

    /// Track arbitrage performance and enforce emergency stop
    pub fn check_emergency_stop(
        env: Env,
    ) -> bool {
        // Get last 3 rebalance results
        let history = Self::get_history(env.clone(), 3u32);
        
        // Trigger emergency stop if last 3 rebalances all resulted in loss
        if history.len() == 3 {
            let all_losses = !history.get(0).unwrap().success
                && !history.get(1).unwrap().success
                && !history.get(2).unwrap().success;
            
            if all_losses {
                let admin = Self::get_admin(env.clone());
                Self::pause(env, admin);
                return true;
            }
        }

        false
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::testutils::Ledger as _;
    use soroban_sdk::{Env, Symbol, Vec};

    fn il(env: &Env, current: i128, entry: i128) -> u32 {
        let pool = Address::generate(env);
        RebalanceEngine::calculate_impermanent_loss(env.clone(), pool, current, entry)
    }

    #[test]
    fn test_il_matches_standard_formula() {
        let env = Env::default();
        // r=1 => 0
        assert_eq!(il(&env, 10000, 10000), 0);
        // r=2 => ~572 bp
        let v = il(&env, 20000, 10000);
        assert!(v >= 560 && v <= 590, "r=2 got {}", v);
        // r=4 => 2000 bp
        let v4 = il(&env, 40000, 10000);
        assert!(v4 >= 1985 && v4 <= 2015, "r=4 got {}", v4);
        // symmetric r=0.5
        let vh = il(&env, 5000, 10000);
        assert!(vh >= 560 && vh <= 590, "r=0.5 got {}", vh);
    }

    #[test]
    fn test_il_zero_inputs() {
        let env = Env::default();
        assert_eq!(il(&env, 0, 10000), 0);
        assert_eq!(il(&env, 10000, 0), 0);
    }

    #[test]
    fn test_strategy_map_o1_access() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, RebalanceEngine);
        let client = RebalanceEngineClient::new(&env, &contract_id);
        client.initialize(&admin);
        let alloc = Vec::from_array(
            &env,
            [PoolAllocation {
                pool_id: Address::generate(&env),
                token_a: Address::generate(&env),
                token_b: Address::generate(&env),
                allocation_percent: 10000,
                target_apy: 500,
                current_apy: 500,
                impermanent_loss_risk: 100,
            }],
        );
        let sid = client.create_strategy(&admin, &Symbol::new(&env, "Test"), &1, &100, &500, &3600, &alloc);
        assert_eq!(sid, 1);
        let fetched = client.get_strategy(&1);
        assert_eq!(fetched.strategy_id, 1);
        assert_eq!(client.get_strategy_count(), 1);
        // paginated listing
        let page = client.get_strategies_paginated(&10, &0);
        assert_eq!(page.len(), 1);
        let empty = client.get_strategies_paginated(&10, &5);
        assert_eq!(empty.len(), 0);
    }

    #[test]
    fn test_history_pagination() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let contract_id = env.register_contract(None, RebalanceEngine);
        let client = RebalanceEngineClient::new(&env, &contract_id);
        client.initialize(&admin);
        // push 5 histories via execute_rebalance with failing proposals? Instead directly test paginated getter on empty
        assert_eq!(client.get_history_count(), 0);
        let page = client.get_history_paginated(&10, &0);
        assert_eq!(page.len(), 0);
        let overflow = client.get_history_paginated(&10, &5);
        assert_eq!(overflow.len(), 0);
    }

    // ============ APY ORACLE REGISTRY TESTS (Issue #105) ============

    fn engine(env: &Env) -> (RebalanceEngineClient<'static>, Address) {
        let admin = Address::generate(env);
        let contract_id = env.register_contract(None, RebalanceEngine);
        let client = RebalanceEngineClient::new(env, &contract_id);
        client.initialize(&admin);
        (client, admin)
    }

    fn allocation(
        env: &Env,
        pool: &Address,
        percent: u32,
        current: u32,
        target: u32,
    ) -> PoolAllocation {
        PoolAllocation {
            pool_id: pool.clone(),
            token_a: Address::generate(env),
            token_b: Address::generate(env),
            allocation_percent: percent,
            target_apy: target,
            current_apy: current,
            impermanent_loss_risk: 50,
        }
    }

    #[test]
    fn test_pool_apy_defaults_to_zero_when_unpublished() {
        let env = Env::default();
        let (client, _admin) = engine(&env);
        let pool = Address::generate(&env);

        // 0 means "unknown", never a fabricated rate.
        assert_eq!(client.get_pool_current_apy(&pool), 0);
        assert!(client.get_pool_apy_record(&pool).is_none());
        assert!(!client.is_apy_fresh(&pool));
    }

    #[test]
    fn test_admin_publishes_pool_apy() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let pool = Address::generate(&env);

        client.update_pool_apy(&admin, &pool, &1234);

        assert_eq!(client.get_pool_current_apy(&pool), 1234);
        let record = client.get_pool_apy_record(&pool).unwrap();
        assert_eq!(record.apy_bps, 1234);
        assert_eq!(record.updated_by, admin);
        assert_eq!(record.updated_at, env.ledger().timestamp());
        assert!(client.is_apy_fresh(&pool));
    }

    #[test]
    fn test_pool_apy_update_overwrites_previous_value() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let pool = Address::generate(&env);

        client.update_pool_apy(&admin, &pool, &1500);
        client.update_pool_apy(&admin, &pool, &800);

        assert_eq!(client.get_pool_current_apy(&pool), 800);
    }

    #[test]
    fn test_pool_apy_rejects_unauthorized_caller() {
        let env = Env::default();
        let (client, _admin) = engine(&env);
        let pool = Address::generate(&env);
        let stranger = Address::generate(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_pool_apy(&stranger, &pool, &900);
        }));

        assert!(result.is_err(), "unauthorized apy update must panic");
        assert_eq!(client.get_pool_current_apy(&pool), 0);
    }

    #[test]
    fn test_apy_keeper_can_publish() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let keeper = Address::generate(&env);
        let pool = Address::generate(&env);

        client.set_apy_keepers(&admin, &Vec::from_array(&env, [keeper.clone()]));
        assert_eq!(client.get_apy_keepers().len(), 1);

        client.update_pool_apy(&keeper, &pool, &4200);
        assert_eq!(client.get_pool_current_apy(&pool), 4200);
        assert_eq!(
            client.get_pool_apy_record(&pool).unwrap().updated_by,
            keeper
        );
    }

    #[test]
    fn test_apy_keepers_managed_by_admin_only() {
        let env = Env::default();
        let (client, _admin) = engine(&env);
        let stranger = Address::generate(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_apy_keepers(&stranger, &Vec::new(&env));
        }));

        assert!(result.is_err(), "keeper list must be admin only");
    }

    #[test]
    fn test_pool_apy_rejects_out_of_range_value() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let pool = Address::generate(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_pool_apy(&admin, &pool, &(MAX_APY_BPS + 1));
        }));

        assert!(result.is_err(), "apy above MAX_APY_BPS must panic");
    }

    #[test]
    fn test_stale_pool_apy_is_not_fresh() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let pool = Address::generate(&env);

        client.set_max_apy_age(&admin, &100);
        client.update_pool_apy(&admin, &pool, &1234);
        assert!(client.is_apy_fresh(&pool));

        env.ledger().with_mut(|li| li.timestamp = 500);
        assert!(!client.is_apy_fresh(&pool));
    }

    /// The registry - not the APY snapshot in the strategy - must drive the
    /// rebalance proposals.
    #[test]
    fn test_analyze_uses_oracle_apy_over_strategy_snapshot() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let pool_a = Address::generate(&env);
        let pool_b = Address::generate(&env);

        // Snapshots are identical and below the rebalance trigger: no proposals.
        let alloc = Vec::from_array(
            &env,
            [
                allocation(&env, &pool_a, 5000, 900, 1000),
                allocation(&env, &pool_b, 5000, 900, 1000),
            ],
        );
        let sid = client.create_strategy(
            &admin,
            &Symbol::new(&env, "Oracle"),
            &2,
            &100,
            &500,
            &3600,
            &alloc,
        );
        assert_eq!(client.analyze_rebalance_opportunities(&sid).len(), 0);

        // A keeper publishes real numbers: B is now the better pool.
        client.update_pool_apy(&admin, &pool_a, &500);
        client.update_pool_apy(&admin, &pool_b, &1500);

        let proposals = client.analyze_rebalance_opportunities(&sid);
        assert_eq!(proposals.len(), 1);
        let proposal = proposals.get(0).unwrap();
        assert_eq!(proposal.from_pool, pool_a);
        assert_eq!(proposal.to_pool, pool_b);
        // 1500 (oracle) - 500 (oracle)
        assert_eq!(proposal.expected_apy_improvement, 1000);
    }

    /// Once a feed goes stale the strategy snapshot is used again, so an
    /// abandoned keeper cannot freeze a stale rate into every decision.
    #[test]
    fn test_analyze_falls_back_to_snapshot_when_feed_is_stale() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let pool_a = Address::generate(&env);
        let pool_b = Address::generate(&env);

        let alloc = Vec::from_array(
            &env,
            [
                allocation(&env, &pool_a, 5000, 900, 1000),
                allocation(&env, &pool_b, 5000, 900, 1000),
            ],
        );
        let sid = client.create_strategy(
            &admin,
            &Symbol::new(&env, "Stale"),
            &2,
            &100,
            &500,
            &3600,
            &alloc,
        );

        client.set_max_apy_age(&admin, &100);
        client.update_pool_apy(&admin, &pool_a, &500);
        client.update_pool_apy(&admin, &pool_b, &1500);
        assert_eq!(client.analyze_rebalance_opportunities(&sid).len(), 1);

        env.ledger().with_mut(|li| li.timestamp = 1000);
        assert_eq!(client.analyze_rebalance_opportunities(&sid).len(), 0);
    }

    #[test]
    fn test_scan_opportunities_prefers_oracle_apy() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let vault_pool = Address::generate(&env);
        let better_pool = Address::generate(&env);

        client.set_rebalance_thresholds(&admin, &200, &100, &86400);

        // The caller claims the vault pool earns 2900 bps, only 100 bps behind
        // the candidate pool, which is below the 200 bps trigger.
        let pools = Vec::from_array(&env, [allocation(&env, &better_pool, 10000, 3000, 3000)]);
        assert_eq!(
            client.scan_opportunities(&vault_pool, &2900, &pools).len(),
            0
        );

        // The oracle says the vault pool actually earns 500 bps.
        client.update_pool_apy(&admin, &vault_pool, &500);

        let opportunities = client.scan_opportunities(&vault_pool, &2900, &pools);
        assert_eq!(opportunities.len(), 1);
        let opportunity = opportunities.get(0).unwrap();
        assert_eq!(opportunity.current_apy, 500);
        assert_eq!(opportunity.projected_apy, 3000);
        assert_eq!(opportunity.apy_delta, 2500);
        assert!(opportunity.recommended);
    }
}
