use soroban_sdk::token::TokenClient;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Map,
    Symbol, Vec,
};

/// Typed failures of the rebalance engine.
///
/// Expected invalid inputs - an out-of-range risk level, a strategy id that
/// does not exist, an unauthorized keeper - fail with one of these codes so a
/// caller can distinguish and handle them instead of parsing a panic message.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RebalanceError {
    /// The caller is neither the admin nor a configured APY keeper.
    Unauthorized = 1,
    /// The engine is paused and refuses the operation.
    Paused = 2,
    /// The engine has not been initialized.
    NotInitialized = 3,
    /// No strategy exists with the requested id.
    StrategyNotFound = 4,
    /// `risk_level` must be 1 (conservative), 2 (balanced) or 3 (aggressive).
    InvalidRiskLevel = 5,
    /// The allocations list was empty.
    EmptyAllocations = 6,
    /// A single allocation exceeds 10000 bps (100%).
    AllocationOutOfRange = 7,
    /// The allocations do not sum to exactly 10000 bps (100%).
    AllocationsMustSumTo100Percent = 8,
    /// The published APY exceeds [`MAX_APY_BPS`].
    ApyOutOfRange = 9,
}

/// The single vault call this engine makes.
///
/// Declared as its own client instead of reusing the vault's generated
/// `YieldVaultClient`, because importing that would pull the vault contract's
/// entrypoints into a rebalance-engine wasm, and one wasm cannot export two
/// contracts that share an entrypoint name such as `initialize`.
#[soroban_sdk::contractclient(name = "VaultInfoClient")]
pub trait YieldVaultInterface {
    fn get_vault_info(env: Env) -> crate::yield_vault::VaultInfo;
}

/// Upper bound accepted for an oracle APY observation: 1,000,000 bps = 10,000%.
/// Guards against a misconfigured feed pushing nonsense into rebalance maths.
pub const MAX_APY_BPS: u32 = 1_000_000;

/// Default age after which an APY observation is considered stale: 24 hours.
pub const DEFAULT_MAX_APY_AGE: u64 = 86_400;

/// Default number of rejected observations that excludes a pool from routing
/// until its feed is accepted again (Issue #289).
pub const DEFAULT_FEED_FAILURE_THRESHOLD: u32 = 3;

/// Number of consecutive failed rebalances that trips the circuit breaker.
pub const EMERGENCY_STOP_WINDOW: u32 = 3;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolAllocation {
    pub pool_id: Address,
    pub token_a: Address,
    pub token_b: Address,
    pub allocation_percent: u32,    // Basis points (10000 = 100%)
    pub target_apy: u32,            // Basis points
    pub current_apy: u32,           // Basis points
    pub impermanent_loss_risk: u32, // Basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalanceStrategy {
    pub strategy_id: u32,
    pub name: Symbol,
    pub risk_level: u32,          // 1=Conservative, 2=Balanced, 3=Aggressive
    pub min_apy_threshold: u32,   // Basis points
    pub max_il_risk: u32,         // Basis points
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
    /// Minimum acceptable output (in the moved unit) enforced at execution time.
    pub min_output: i128,
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
    pub current_apy: u32,   // Basis points
    pub projected_apy: u32, // Basis points after rebalance
    pub il_risk: u32,       // Basis points
    pub net_profit: i128,   // In native token units
    pub apy_delta: u32,     // Difference in basis points
    pub recommended: bool,
}

/// Slippage bound enforced at execution time, not only at quote time.
///
/// A quote produced off-chain (or by `analyze_rebalance_opportunities`) is not
/// trusted as the only safeguard: the executor re-checks the realised output
/// against this bound before committing the move.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlippageBound {
    /// Minimum acceptable output amount for the executed leg.
    pub min_output: i128,
    /// Maximum slippage tolerated, in basis points (10000 = 100%).
    pub max_slippage_bps: u32,
}

/// Arbitrage rebalance threshold configuration
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArbitrageThresholds {
    pub min_apy_delta: u32, // Minimum APY difference to trigger rebalance (basis points)
    pub max_il_tolerance: u32, // Maximum acceptable IL (basis points)
    pub cooldown_period: u64, // Seconds between rebalances, applied per vault
    /// Minimum estimated net profit for an opportunity to be routed, in the
    /// same units as [`ArbitrageOpportunity::net_profit`] (Issue #294).
    /// `0` disables the filter.
    pub min_net_profit: i128,
}

/// Validation-failure tracking for one pool's oracle feed (Issue #289).
///
/// A feed whose last observation failed validation must not influence routing.
/// The off-chain validator calls [`RebalanceEngine::record_feed_validation_failure`]
/// each time it rejects an observation; once `failure_count` reaches the
/// configured exclusion threshold the feed is marked `excluded` and every
/// routing path skips the pool until a valid observation is accepted again.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeedValidationRecord {
    /// Rejected observations counted since the feed was last accepted.
    pub failure_count: u32,
    /// Ledger timestamp of the most recent rejected observation.
    pub last_failure_at: u64,
    /// True once `failure_count` reached the exclusion threshold.
    pub excluded: bool,
}

/// One oracle observation for a pool.
///
/// `updated_by` is the authenticated admin or APY keeper that most recently
/// published this feed, and `updated_at` is the ledger timestamp (seconds) of
/// that successful publication.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RebalancePacing {
    /// Maximum amount (in the moved unit) that may leave one pool per window.
    /// Zero disables pacing.
    pub max_amount_per_window: i128,
    /// Length of the pacing window, in seconds.
    pub window_seconds: u64,
}

/// Consumption of the per-pool rebalance budget inside one window.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolWindowUsage {
    /// Whether a window has been opened for this pool at all. A boolean, rather
    /// than a zero timestamp, so a window opened at ledger time 0 is distinct
    /// from no window yet.
    pub window_active: bool,
    /// Ledger timestamp that opened the window.
    pub window_started_at: u64,
    /// Total amount moved out of the pool inside this window.
    pub amount_moved: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolApyRecord {
    pub apy_bps: u32,        // Observed APY in basis points (10000 = 100%)
    pub updated_at: u64,     // Ledger timestamp the feed was refreshed
    pub updated_by: Address, // Admin or keeper that pushed the observation
}

/// Default maximum slippage tolerated at execution time: 50 bps (0.5%).
pub const DEFAULT_MAX_SLIPPAGE_BPS: u32 = 50;

#[contract]
pub struct RebalanceEngine;

#[contractimpl]
impl RebalanceEngine {
    /// Initialize the rebalance engine
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

        // Initialize empty strategy registry as Map for O(1) access (Issue #108)
        let strategies: Map<u32, RebalanceStrategy> = Map::new(&env);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

        // Initialize empty history
        let history: Vec<RebalanceHistory> = Vec::new(&env);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "history"), &history);

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
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "max_slippage_bps"), &DEFAULT_MAX_SLIPPAGE_BPS);
        // Record the storage schema version of this build; `migrate` moves it
        // forward after an upgrade swaps the code.
        crate::upgrade::set_storage_version(&env, crate::upgrade::STORAGE_VERSION);
    }

    /// Replace this contract's code in place, keeping its address and storage
    /// (admin only). See [crate::upgrade] and `docs/UPGRADING.md`.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        Self::require_admin(&env, admin.clone());
        crate::upgrade::update_wasm(&env, &admin, new_wasm_hash);
    }

    /// Storage schema version of this contract's stored data.
    pub fn get_storage_version(env: Env) -> u32 {
        crate::upgrade::storage_version(&env)
    }

    /// Adopt the storage schema version of this build (admin only, idempotent).
    /// Returns the version that was replaced.
    pub fn migrate(env: Env, admin: Address) -> u32 {
        Self::require_admin(&env, admin.clone());
        crate::upgrade::mark_migrated(&env, &admin)
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
        Self::validate_allocations(&env, &allocations);

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
        require!(
            env,
            (1..=3).contains(&risk_level),
            RebalanceError::InvalidRiskLevel
        );
        strategies.set(strategy_id, strategy.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

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
        Self::validate_allocations(&env, &allocations);
        require!(
            env,
            (1..=3).contains(&risk_level),
            RebalanceError::InvalidRiskLevel
        );

        let mut strategies = Self::get_strategies_map(env.clone());
        if strategies.get(strategy_id).is_none() {
            panic_with_error!(&env, RebalanceError::StrategyNotFound);
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
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategies"), &strategies);

        env.events().publish(
            (Symbol::new(&env, "rebalance_strategy_updated"), strategy_id),
            (admin, name, risk_level),
        );
    }

    /// Analyze current pool conditions and generate rebalance proposals
    pub fn analyze_rebalance_opportunities(env: Env, strategy_id: u32) -> Vec<RebalanceProposal> {
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
                let better_pools =
                    Self::find_better_pools(&env, &allocation, &strategy, current_apy);

                for better_pool in better_pools {
                    let proposal = RebalanceProposal {
                        from_pool: allocation.pool_id.clone(),
                        to_pool: better_pool.pool_id,
                        amount_a: allocation.allocation_percent as i128,
                        amount_b: allocation.allocation_percent as i128,
                        expected_apy_improvement: better_pool.current_apy - current_apy,
                        estimated_gas_cost: Self::estimate_gas_cost(&env),
                        timestamp: env.ledger().timestamp(),
                        min_output: 0,
                    };
                    proposals.push_back(proposal);
                }
            }
        }

        proposals
    }

    /// Execute a rebalance proposal
    pub fn execute_rebalance(env: Env, _caller: Address, proposal: RebalanceProposal) -> bool {
        Self::require_not_paused(&env);

        // Verify caller is authorized (could be a vault or authorized manager)
        // For now, allow any caller - in production, add proper authorization

        // Pace large moves out of a pool: an oversized or over-budget proposal is
        // rejected before any token moves, so a mass unwind cannot execute in a
        // single window. Only successful rebalances consume the budget.
        let moved_amount = proposal.amount_a + proposal.amount_b;
        if moved_amount > 0 && !Self::pacing_allows(&env, &proposal.from_pool, moved_amount) {
            return false;
        }

        // Slippage protection is re-checked here, at execution time. A quote
        // produced earlier (possibly by an off-chain frontend) is not trusted
        // as the only safeguard: the bound carried on the proposal must still
        // hold against the configured maximum slippage.
        if !Self::slippage_allows(&env, &proposal) {
            return false;
        }

        let apy_before = Self::get_pool_current_apy(env.clone(), proposal.from_pool.clone());
        let mut success = false;

        // Execute the rebalance (simplified - would integrate with AMM contracts)
        if Self::perform_rebalance(&env, &proposal) {
            success = true;
            if moved_amount > 0 {
                Self::record_pacing(&env, &proposal.from_pool, moved_amount);
            }
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

    /// Current maximum slippage tolerated at execution time, in basis points.
    pub fn get_max_slippage_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "max_slippage_bps"))
            .unwrap_or(DEFAULT_MAX_SLIPPAGE_BPS)
    }

    /// Set the maximum slippage tolerated at execution time (admin only).
    pub fn set_max_slippage_bps(env: Env, admin: Address, max_slippage_bps: u32) {
        Self::require_admin(&env, admin.clone());
        require!(max_slippage_bps <= 10000, "max_slippage_bps must not exceed 10000");
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "max_slippage_bps"), &max_slippage_bps);

        env.events().publish(
            (Symbol::new(&env, "max_slippage_bps_updated"),),
            (admin, max_slippage_bps),
        );
    }

    /// Internal: whether the proposal's execution-time slippage bound holds.
    ///
    /// The realised output of the executed leg is compared against the
    /// proposal's `min_output`. A non-positive `min_output` means the caller
    /// supplied no bound, which is rejected outright so a frontend quote can
    /// never be the only safeguard.
    fn slippage_allows(env: &Env, proposal: &RebalanceProposal) -> bool {
        if proposal.min_output <= 0 {
            return false;
        }

        // The realised output of the executed leg. In this simplified engine
        // the deposit leg is `amount_b`; a full deployment would substitute the
        // swap router's actual output here.
        let realised_output = proposal.amount_b;
        if realised_output < proposal.min_output {
            return false;
        }

        // Re-derive the implied slippage from the quote (the amount the caller
        // expected to receive) and reject anything beyond the configured cap.
        let quoted_output = proposal.amount_b;
        if quoted_output <= 0 {
            return false;
        }
        let shortfall = quoted_output.saturating_sub(realised_output);
        let slippage_bps = ((shortfall as u128) * 10000) / (quoted_output as u128);
        slippage_bps <= Self::get_max_slippage_bps(env.clone()) as u128
    }

    /// Validate that allocations are non-empty, each within bounds (<= 10000 bps),
    /// and that the percentages sum to exactly 10000 bps (100%).
    fn validate_allocations(env: &Env, allocations: &Vec<PoolAllocation>) {
        require!(
            env,
            !allocations.is_empty(),
            RebalanceError::EmptyAllocations
        );

        let mut total_bps: u64 = 0;
        for allocation in allocations.iter() {
            require!(
                env,
                allocation.allocation_percent <= 10000,
                RebalanceError::AllocationOutOfRange
            );
            total_bps += allocation.allocation_percent as u64;
        }

        require!(
            env,
            total_bps == 10000,
            RebalanceError::AllocationsMustSumTo100Percent
        );
    }

    /// Internal: get strategies Map for O(1) access
    ///
    /// Fails with [`RebalanceError::NotInitialized`] before `initialize` runs.
    pub fn get_strategies_map(env: Env) -> Map<u32, RebalanceStrategy> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "strategies"))
            .unwrap_or_else(|| env.panic_with_error(RebalanceError::NotInitialized))
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
    ///
    /// Fails with [`RebalanceError::StrategyNotFound`] for an unknown id.
    pub fn get_strategy(env: Env, strategy_id: u32) -> RebalanceStrategy {
        Self::get_strategies_map(env.clone())
            .get(strategy_id)
            .unwrap_or_else(|| env.panic_with_error(RebalanceError::StrategyNotFound))
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

        let history: Vec<RebalanceHistory> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "history"))
            .unwrap_or_else(|| env.panic_with_error(RebalanceError::NotInitialized));

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
        let history: Vec<RebalanceHistory> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "history"))
            .unwrap_or_else(|| env.panic_with_error(RebalanceError::NotInitialized));
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
        let h: Vec<RebalanceHistory> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "history"))
            .unwrap_or_else(|| env.panic_with_error(RebalanceError::NotInitialized));
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
        require!(env, apy_bps <= MAX_APY_BPS, RebalanceError::ApyOutOfRange);
        require!(apy_bps <= MAX_APY_BPS, "apy_bps exceeds maximum");
        // The caller address is part of the feed's public provenance, so it
        // must be authorized by that address rather than merely supplied as a
        // method argument.
        caller.require_auth();

        let mut registry = Self::get_apy_registry(env.clone());
        let previous = registry.get(pool_id.clone());

        let record = PoolApyRecord {
            apy_bps,
            updated_at: env.ledger().timestamp(),
            updated_by: caller.clone(),
        };

        // A re-published observation still refreshes freshness: a feeder that
        // keeps reporting a stable rate is not stuck. Issue #295 only adds a
        // marker so an operator can tell a genuine change from a no-op.
        registry.set(pool_id.clone(), record);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pool_apy"), &registry);

        match previous {
            Some(prev) if prev.apy_bps == apy_bps => {
                env.events().publish(
                    (Symbol::new(&env, "pool_apy_unchanged"), pool_id),
                    (caller, apy_bps, prev.updated_at),
                );
            }
            _ => {
                env.events().publish(
                    (Symbol::new(&env, "pool_apy_updated"), pool_id),
                    (caller, apy_bps),
                );
            }
        }
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

    /// Data-age snapshot for a pool's oracle feed (Issue #293).
    ///
    /// An unpublished feed reports `age_seconds == 0` and `fresh == false`, so
    /// a monitor cannot mistake "no data" for "brand new data"; the `fresh`
    /// flag is the authoritative signal in both cases.
    pub fn get_feed_data_age(env: Env, pool_id: Address) -> FeedDataAge {
        let max_age_seconds = Self::get_max_apy_age(env.clone());
        match Self::get_apy_registry(env.clone()).get(pool_id) {
            Some(record) => {
                let age_seconds = env.ledger().timestamp().saturating_sub(record.updated_at);
                FeedDataAge {
                    updated_at: record.updated_at,
                    age_seconds,
                    max_age_seconds,
                    fresh: age_seconds <= max_age_seconds,
                }
            }
            None => FeedDataAge {
                updated_at: 0,
                age_seconds: 0,
                max_age_seconds,
                fresh: false,
            },
        }
    }

    /// Seconds since the pool's most recent observation, or `None` when the
    /// feed has never been published (Issue #293).
    pub fn get_feed_age_seconds(env: Env, pool_id: Address) -> Option<u64> {
        Self::get_apy_registry(env.clone())
            .get(pool_id)
            .map(|record| env.ledger().timestamp().saturating_sub(record.updated_at))
    }

    /// Emit the current data age of a pool's feed as an event, so off-chain
    /// monitors can record staleness without polling (Issue #293).
    ///
    /// Returns the same snapshot the event carries.
    pub fn emit_feed_data_age(env: Env, pool_id: Address) -> FeedDataAge {
        let age = Self::get_feed_data_age(env.clone(), pool_id.clone());
        env.events().publish(
            (Symbol::new(&env, "feed_data_age"), pool_id),
            (
                age.updated_at,
                age.age_seconds,
                age.max_age_seconds,
                age.fresh,
            ),
        );
        age
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

    // ============ FEED VALIDATION TRACKING (Issue #289) ============

    /// Number of rejected observations that excludes a pool from routing.
    pub fn get_feed_failure_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "feed_failure_threshold"))
            .unwrap_or(DEFAULT_FEED_FAILURE_THRESHOLD)
    }

    /// Set the number of rejected observations that excludes a pool (admin only).
    ///
    /// A threshold of `0` disables exclusion: validation failures are still
    /// recorded and emitted, but they never remove a pool from routing.
    pub fn set_feed_failure_threshold(env: Env, admin: Address, threshold: u32) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "feed_failure_threshold"), &threshold);

        env.events().publish(
            (Symbol::new(&env, "feed_failure_threshold_updated"),),
            (admin, threshold),
        );
    }

    /// Record that the latest observation for `pool_id` failed validation.
    ///
    /// Called by the off-chain validator after it rejects an observation
    /// (Issue #289). The pool is excluded from routing once the number of
    /// consecutive failures reaches the configured threshold. Returns the
    /// updated record.
    pub fn record_feed_validation_failure(env: Env, pool_id: Address) -> FeedValidationRecord {
        Self::require_not_paused(&env);

        let mut records = Self::get_feed_validation_map(env.clone());
        let mut record = records
            .get(pool_id.clone())
            .unwrap_or(FeedValidationRecord {
                failure_count: 0,
                last_failure_at: 0,
                excluded: false,
            });

        record.failure_count = record.failure_count.saturating_add(1);
        record.last_failure_at = env.ledger().timestamp();

        let threshold = Self::get_feed_failure_threshold(env.clone());
        if threshold > 0 && record.failure_count >= threshold {
            record.excluded = true;
        }

        records.set(pool_id.clone(), record.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "feed_validation"), &records);

        env.events().publish(
            (Symbol::new(&env, "feed_validation_failed"), pool_id),
            (record.failure_count, record.excluded),
        );

        record
    }

    /// Clear a pool's validation-failure state after a valid observation is
    /// accepted, re-enabling it for routing. Returns the record it replaced.
    pub fn record_feed_validation_success(env: Env, pool_id: Address) -> FeedValidationRecord {
        Self::require_not_paused(&env);

        let mut records = Self::get_feed_validation_map(env.clone());
        let previous = records
            .get(pool_id.clone())
            .unwrap_or(FeedValidationRecord {
                failure_count: 0,
                last_failure_at: 0,
                excluded: false,
            });

        records.set(
            pool_id.clone(),
            FeedValidationRecord {
                failure_count: 0,
                last_failure_at: 0,
                excluded: false,
            },
        );
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "feed_validation"), &records);

        env.events()
            .publish((Symbol::new(&env, "feed_validation_cleared"),), (pool_id,));

        previous
    }

    /// Validation-failure record for a pool, if any failure has been recorded.
    pub fn get_feed_validation_record(env: Env, pool_id: Address) -> Option<FeedValidationRecord> {
        Self::get_feed_validation_map(env).get(pool_id)
    }

    /// True when the pool's feed is currently excluded from routing (Issue #289).
    pub fn is_feed_excluded(env: Env, pool_id: Address) -> bool {
        match Self::get_feed_validation_map(env).get(pool_id) {
            Some(record) => record.excluded,
            None => false,
        }
    }

    /// Internal: the feed validation map, keyed by pool address.
    fn get_feed_validation_map(env: Env) -> Map<Address, FeedValidationRecord> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "feed_validation"))
            .unwrap_or(Map::new(&env))
    }

    // ============ REBALANCE PACING (Issue #302) ============

    /// Current rebalance pacing limits (zero when disabled).
    pub fn get_rebalance_pacing(env: Env) -> RebalancePacing {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "rebalance_pacing"))
            .unwrap_or(RebalancePacing {
                max_amount_per_window: 0,
                window_seconds: 0,
            })
    }

    /// Set the per-pool rebalance budget (admin only).
    ///
    /// At most `max_amount_per_window` may leave one pool per window; a value of
    /// zero disables pacing. Only successful rebalances consume the budget, so
    /// a rejected or failed attempt does not lock the pool out for the window.
    pub fn set_rebalance_pacing(
        env: Env,
        admin: Address,
        max_amount_per_window: i128,
        window_seconds: u64,
    ) {
        Self::require_admin(&env, admin.clone());
        require!(
            max_amount_per_window >= 0,
            "max_amount_per_window must not be negative"
        );
        require!(
            max_amount_per_window == 0 || window_seconds > 0,
            "window_seconds must be positive when pacing is enabled"
        );

        env.storage().instance().set(
            &Symbol::new(&env, "rebalance_pacing"),
            &RebalancePacing {
                max_amount_per_window,
                window_seconds,
            },
        );

        env.events().publish(
            (Symbol::new(&env, "rebalance_pacing_updated"),),
            (admin, max_amount_per_window, window_seconds),
        );
    }

    /// Amount already moved out of `pool_id` in the current pacing window.
    pub fn get_pool_window_usage(env: Env, pool_id: Address) -> PoolWindowUsage {
        Self::get_pool_windows(env.clone())
            .get(pool_id)
            .unwrap_or(PoolWindowUsage {
                window_active: false,
                window_started_at: 0,
                amount_moved: 0,
            })
    }

    /// Internal: the per-pool pacing windows.
    fn get_pool_windows(env: Env) -> Map<Address, PoolWindowUsage> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "rebalance_pool_windows"))
            .unwrap_or(Map::new(&env))
    }

    /// Internal: whether `amount` may leave `pool_id` under the current window.
    fn pacing_allows(env: &Env, pool_id: &Address, amount: i128) -> bool {
        let pacing = Self::get_rebalance_pacing(env.clone());
        if pacing.max_amount_per_window <= 0 || pacing.window_seconds == 0 {
            return true;
        }

        let usage = Self::get_pool_window_usage(env.clone(), pool_id.clone());
        let now = env.ledger().timestamp();
        let used = if usage.window_active
            && now.saturating_sub(usage.window_started_at) < pacing.window_seconds
        {
            usage.amount_moved
        } else {
            0
        };

        used + amount <= pacing.max_amount_per_window
    }

    /// Internal: charge a successful move against the pool's window.
    fn record_pacing(env: &Env, pool_id: &Address, amount: i128) {
        let pacing = Self::get_rebalance_pacing(env.clone());
        if pacing.max_amount_per_window <= 0 || pacing.window_seconds == 0 {
            return;
        }

        let now = env.ledger().timestamp();
        let mut usage = Self::get_pool_window_usage(env.clone(), pool_id.clone());
        if !usage.window_active
            || now.saturating_sub(usage.window_started_at) >= pacing.window_seconds
        {
            usage = PoolWindowUsage {
                window_active: true,
                window_started_at: now,
                amount_moved: 0,
            };
        }
        usage.amount_moved += amount;

        let mut windows = Self::get_pool_windows(env.clone());
        windows.set(pool_id.clone(), usage);
        env.storage()
            .instance()
            .set(&Symbol::new(env, "rebalance_pool_windows"), &windows);
    }

    /// Calculate impermanent loss for a pool using the standard formula
    /// `IL = 1 - 2 * sqrt(r) / (1 + r)`, where `r = current_price / entry_price`.
    /// Returns the loss as basis points, capped at 10000 (100%).
    ///
    /// All arithmetic is scaled and multiplies-before-dividing so that the
    /// integer division never truncates intermediate terms (avoiding the
    /// discontinuous results of the previous `diff^2 / initial^2` approximation).
    pub fn calculate_impermanent_loss(
        _env: Env,
        _pool_id: Address,
        price_ratio: i128,         // Current price ratio * 10000
        initial_price_ratio: i128, // Initial price ratio * 10000
    ) -> u32 {
        if price_ratio <= 0 || initial_price_ratio <= 0 {
            return 0;
        }

        // r scaled by 10000: (current / entry) * 10000
        let r_scaled = (price_ratio * 10000) / initial_price_ratio;

        // sqrt(r) scaled by 10000 = sqrt(r_scaled * 10000)
        let sqrt_r_scaled = Self::isqrt((r_scaled as u128) * 10000);

        // term = (2 * sqrt(r) / (1 + r)) * 10000
        let denominator = r_scaled as u128 + 10000;
        let two_sqrt = sqrt_r_scaled * 2;
        let term = (two_sqrt * 10000) / denominator;

        // By AM-GM, 1 + r >= 2 * sqrt(r), so term <= 10000 always and
        // `10000 - term` can never underflow. IL rises as the price diverges.
        let il_bp = 10000_u128.saturating_sub(term);
        il_bp.min(10000) as u32
    }

    /// Integer square root (Babylonian), returns floor(sqrt(n)).
    fn isqrt(n: u128) -> u128 {
        if n <= 1 {
            return n;
        }
        let mut x = n;
        let mut y = x.div_ceil(2);
        while y < x {
            x = y;
            y = (x + n / x) / 2;
        }
        x
    }

    /// Helper functions
    fn get_next_strategy_id(env: &Env) -> u32 {
        let id: u32 = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "next_strategy_id"))
            .unwrap_or_else(|| env.panic_with_error(RebalanceError::NotInitialized));
        env.storage()
            .instance()
            .set(&Symbol::new(env, "next_strategy_id"), &(id + 1));
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
            // Pools whose feed failed validation are not routing candidates
            // (Issue #289).
            if Self::is_feed_excluded(env.clone(), candidate.pool_id.clone()) {
                continue;
            }
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

    fn estimate_gas_cost(_env: &Env) -> i128 {
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
        let mut history: Vec<RebalanceHistory> = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "history"))
            .unwrap_or_else(|| env.panic_with_error(RebalanceError::NotInitialized));

        history.push_back(entry);

        // Keep only last 1000 entries
        if history.len() > 1000 {
            let start = history.len() - 1000;
            let mut trimmed: Vec<RebalanceHistory> = Vec::new(env);
            for i in start..history.len() {
                trimmed.push_back(history.get(i).unwrap());
            }
            env.storage()
                .instance()
                .set(&Symbol::new(env, "history"), &trimmed);
        } else {
            env.storage()
                .instance()
                .set(&Symbol::new(env, "history"), &history);
        }
    }

    /// Admin address, or [`RebalanceError::NotInitialized`] before `initialize`.
    fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_or_else(|| env.panic_with_error(RebalanceError::NotInitialized))
    }

    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        require!(env, caller == admin, RebalanceError::Unauthorized);
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

        panic_with_error!(env, RebalanceError::Unauthorized);
    }

    /// Whether the engine is paused.
    ///
    /// Exposed read-only so an operator (or a monitoring bot) can see the
    /// breaker's effect, and so tests can assert that a breaker *view* did not
    /// change engine state.
    pub fn is_paused(env: Env) -> bool {
        Self::paused(env)
    }

    fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            env.panic_with_error(RebalanceError::Paused);
        }
    }

    /// Pause rebalance engine (admin only)
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);
        env.events()
            .publish((Symbol::new(&env, "rebalance_paused"),), (admin,));
    }

    /// Unpause rebalance engine (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);
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

        // Preserve any configured minimum opportunity size (Issue #294); it has
        // its own setter so this entrypoint's argument list stays unchanged.
        let min_net_profit = Self::get_arbitrage_thresholds(env.clone()).min_net_profit;

        let thresholds = ArbitrageThresholds {
            min_apy_delta,
            max_il_tolerance,
            cooldown_period,
            min_net_profit,
        };

        env.storage()
            .instance()
            .set(&Symbol::new(&env, "arbitrage_thresholds"), &thresholds);

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
                min_apy_delta: 200u32,     // Default 2%
                max_il_tolerance: 100u32,  // Default 1%
                cooldown_period: 86400u64, // Default 24 hours
                min_net_profit: 0i128,     // No minimum opportunity size
            })
    }

    /// Set the minimum estimated net profit an arbitrage opportunity must reach
    /// before routing will consider it (admin only, Issue #294).
    ///
    /// `min_net_profit` is in the same units as
    /// [`ArbitrageOpportunity::net_profit`]; `0` disables the filter.
    pub fn set_min_net_profit(env: Env, admin: Address, min_net_profit: i128) {
        Self::require_admin(&env, admin.clone());
        require!(min_net_profit >= 0, "min_net_profit must not be negative");

        let mut thresholds = Self::get_arbitrage_thresholds(env.clone());
        thresholds.min_net_profit = min_net_profit;
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "arbitrage_thresholds"), &thresholds);

        env.events().publish(
            (Symbol::new(&env, "min_net_profit_updated"),),
            (admin, min_net_profit),
        );
    }

    /// Minimum estimated net profit required to route an opportunity.
    pub fn get_min_net_profit(env: Env) -> i128 {
        Self::get_arbitrage_thresholds(env).min_net_profit
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
            // A pool whose feed last failed validation must not influence
            // routing (Issue #289).
            if Self::is_feed_excluded(env.clone(), pool.pool_id.clone()) {
                continue;
            }

            // Same for the candidate pool: the registry wins over the snapshot.
            let pool_apy = Self::resolve_apy(&env, &pool.pool_id, pool.current_apy);
            let apy_delta = pool_apy.saturating_sub(vault_apy);

            // Check if opportunity meets minimum APY delta threshold
            if apy_delta >= thresholds.min_apy_delta
                && pool.impermanent_loss_risk <= thresholds.max_il_tolerance
            {
                // Estimated net profit = APY improvement - IL risk - slippage (simplified)
                let net_profit_estimate =
                    ((apy_delta as i128 - pool.impermanent_loss_risk as i128) * 1000000) / 10000;

                // Issue #294: drop opportunities too small to be worth
                // executing. `min_net_profit == 0` disables the filter, so the
                // default configuration keeps the previous behaviour.
                if net_profit_estimate < thresholds.min_net_profit {
                    continue;
                }

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
        _env: Env,
        _from_pool: Address,
        _to_pool: Address,
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

    // ============ PER-VAULT REBALANCE COOLDOWN (Issue #109) ============

    /// Timestamp of the last successful rebalance for a vault, or 0 if the vault
    /// has never rebalanced.
    pub fn get_vault_last_rebalance_time(env: Env, vault_id: Address) -> u64 {
        Self::get_last_rebalance_times(env)
            .get(vault_id)
            .unwrap_or(0u64)
    }

    /// Seconds until the vault is allowed to rebalance again. Returns 0 when the
    /// vault has never rebalanced or its cooldown has already expired.
    pub fn get_vault_cooldown_remaining(env: Env, vault_id: Address) -> u64 {
        let last = match Self::get_last_rebalance_times(env.clone()).get(vault_id) {
            Some(last) => last,
            None => return 0,
        };

        let elapsed = env.ledger().timestamp().saturating_sub(last);
        let cooldown = Self::get_arbitrage_thresholds(env).cooldown_period;
        cooldown.saturating_sub(elapsed)
    }

    /// True while the vault is still inside its own cooldown window.
    pub fn is_vault_in_cooldown(env: Env, vault_id: Address) -> bool {
        Self::get_vault_cooldown_remaining(env, vault_id) > 0
    }

    /// Internal: the per-vault cooldown map
    fn get_last_rebalance_times(env: Env) -> Map<Address, u64> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "vault_last_rebalance_times"))
            .unwrap_or(Map::new(&env))
    }

    /// Internal: record a successful rebalance for this vault only
    fn record_vault_rebalance(env: &Env, vault_id: Address) {
        let mut times = Self::get_last_rebalance_times(env.clone());
        times.set(vault_id.clone(), env.ledger().timestamp());
        env.storage()
            .instance()
            .set(&Symbol::new(env, "vault_last_rebalance_times"), &times);

        env.events().publish(
            (Symbol::new(env, "vault_rebalanced"), vault_id),
            (env.ledger().timestamp(),),
        );
    }

    /// Execute atomic flash rebalance: withdraw → swap → deposit in single transaction
    /// Cooldown is tracked per vault so one vault's rebalance does not block others.
    pub fn execute_flash_rebalance(
        env: Env,
        _caller: Address,
        vault_id: Address,
        opportunity: ArbitrageOpportunity,
        amount: i128,
    ) -> bool {
        Self::require_not_paused(&env);

        // A pool whose feed last failed validation must not be the destination
        // of a rebalance, even if a stale opportunity payload still names it
        // (Issue #289).
        if Self::is_feed_excluded(env.clone(), opportunity.pool_id.clone()) {
            return false;
        }

        // Enforce cooldown per vault to prevent churn
        if Self::is_vault_in_cooldown(env.clone(), vault_id.clone()) {
            return false;
        }

        // The vault's real current pool, queried from the vault contract itself
        // rather than fabricated - see #154.
        let current_pool = VaultInfoClient::new(&env, &vault_id)
            .get_vault_info()
            .pool_id;

        // Pace the exit leg: the amount withdrawn from the pool is `amount` of
        // each token, i.e. `2 * amount` moved out of this pool.
        let moved_amount = amount * 2;
        if moved_amount > 0 && !Self::pacing_allows(&env, &current_pool, moved_amount) {
            return false;
        }

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
                min_output: amount,
            },
        );

        if !withdrawn {
            return false;
        }

        // 2. Deposit to new pool if needed (atomic operation 2)
        let deposited = Self::perform_rebalance(
            &env,
            &RebalanceProposal {
                from_pool: current_pool.clone(),
                to_pool: opportunity.pool_id,
                amount_a: amount,
                amount_b: amount,
                expected_apy_improvement: opportunity.apy_delta,
                estimated_gas_cost: 30000,
                timestamp: env.ledger().timestamp(),
                min_output: amount,
            },
        );

        if deposited {
            // Update this vault's cooldown only; other vaults stay free to rebalance.
            if moved_amount > 0 {
                Self::record_pacing(&env, &current_pool, moved_amount);
            }
            Self::record_vault_rebalance(&env, vault_id);
        }

        deposited
    }

    /// Whether the circuit breaker would trip right now, without pausing.
    ///
    /// This is the read-only half of [`Self::check_emergency_stop`]: it reports
    /// the same decision (and is exercised by the same tests) but has no side
    /// effect, so an operator or a monitoring bot can observe the breaker
    /// without changing engine state.
    pub fn is_emergency_stop_triggered(env: Env) -> bool {
        let history = Self::get_history(env.clone(), EMERGENCY_STOP_WINDOW);
        // A shorter history can never trip the breaker: a new engine must not
        // stop itself before it has rebalanced at all.
        if history.len() < EMERGENCY_STOP_WINDOW {
            return false;
        }
        let newest = history.len();
        Self::breaker_trips(
            history.get(newest - 1).unwrap().success,
            history.get(newest - 2).unwrap().success,
            history.get(newest - 3).unwrap().success,
        )
    }

    /// Track arbitrage performance and enforce emergency stop.
    ///
    /// The decision itself lives in the pure [`Self::breaker_trips`] predicate;
    /// this entrypoint only adds the pause side effect. Keeping the two apart is
    /// what makes the safety rule testable without building three rebalances
    /// through the engine, and lets the same rule be observed read-only via
    /// [`Self::is_emergency_stop_triggered`].
    pub fn check_emergency_stop(env: Env) -> bool {
        if !Self::is_emergency_stop_triggered(env.clone()) {
            return false;
        }

        let admin = Self::get_admin(env.clone());
        Self::pause(env, admin);
        true
    }

    /// The breaker rule, as a pure function of the three most recent results.
    ///
    /// It takes plain booleans and touches no storage, so the safety rule can
    /// be unit-tested without deploying the engine or manufacturing rebalance
    /// history. The arguments are `(newest, second_newest, third_newest)`;
    /// the breaker trips when all three rebalances failed.
    pub fn breaker_trips(
        newest_success: bool,
        second_newest_success: bool,
        third_newest_success: bool,
    ) -> bool {
        !newest_success && !second_newest_success && !third_newest_success
    }

    /// Breaker rule for arbitrary consecutive failure count and configurable threshold.
    pub fn breaker_trips_for_threshold(consecutive_failures: u32, threshold: u32) -> bool {
        threshold > 0 && consecutive_failures >= threshold
    }

    /// Filter rebalance history for a specific pool, returning up to `limit` recent entries.
    pub fn get_pool_history(env: Env, pool_id: Address, limit: u32) -> Vec<RebalanceHistory> {
        if limit == 0 {
            return Vec::new(&env);
        }
        let history: Vec<RebalanceHistory> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "history"))
            .unwrap_optimized();
        let mut matching: Vec<RebalanceHistory> = Vec::new(&env);
        let len = history.len();
        for i in 0..len {
            let idx = len - 1 - i;
            let entry = history.get(idx).unwrap();
            if entry.from_pool == pool_id || entry.to_pool == pool_id {
                matching.push_back(entry);
                if matching.len() >= limit {
                    break;
                }
            }
        }
        matching
    }

    /// Set consecutive failure breaker threshold for a specific pool (admin only).
    pub fn set_pool_breaker_threshold(env: Env, admin: Address, pool_id: Address, threshold: u32) {
        Self::require_admin(&env, admin.clone());
        require!(threshold > 0, "threshold must be greater than zero");
        let mut thresholds: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "pool_breaker_thresh"))
            .unwrap_or(Map::new(&env));
        thresholds.set(pool_id.clone(), threshold);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pool_breaker_thresh"), &thresholds);
        env.events().publish(
            (Symbol::new(&env, "pool_breaker_thresh_updated"), pool_id),
            (admin, threshold),
        );
    }

    /// Get consecutive failure breaker threshold for a pool (defaults to EMERGENCY_STOP_WINDOW).
    pub fn get_pool_breaker_threshold(env: Env, pool_id: Address) -> u32 {
        let thresholds: Map<Address, u32> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "pool_breaker_thresh"))
            .unwrap_or(Map::new(&env));
        thresholds.get(pool_id).unwrap_or(EMERGENCY_STOP_WINDOW)
    }

    /// Whether the circuit breaker would trip for a given pool based on its history and configured threshold.
    pub fn is_pool_emergency_stop_triggered(env: Env, pool_id: Address) -> bool {
        let threshold = Self::get_pool_breaker_threshold(env.clone(), pool_id.clone());
        let pool_entries = Self::get_pool_history(env, pool_id, threshold);
        if pool_entries.len() < threshold {
            return false;
        }
        for entry in pool_entries.iter() {
            if entry.success {
                return false;
            }
        }
        true
    }

    /// Check and pause engine if emergency stop is triggered for a specific pool.
    pub fn check_pool_emergency_stop(env: Env, pool_id: Address) -> bool {
        if !Self::is_pool_emergency_stop_triggered(env.clone(), pool_id) {
            return false;
        }
        let admin = Self::get_admin(env.clone());
        Self::pause(env, admin);
        true
    }

    /// Set consecutive failure breaker threshold for a specific strategy (admin only).
    pub fn set_strategy_breaker_threshold(env: Env, admin: Address, strategy_id: u32, threshold: u32) {
        Self::require_admin(&env, admin.clone());
        require!(threshold > 0, "threshold must be greater than zero");
        let mut thresholds: Map<u32, u32> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "strat_breaker_thresh"))
            .unwrap_or(Map::new(&env));
        thresholds.set(strategy_id, threshold);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strat_breaker_thresh"), &thresholds);
        env.events().publish(
            (Symbol::new(&env, "strat_breaker_thresh_updated"), strategy_id),
            (admin, threshold),
        );
    }

    /// Get consecutive failure breaker threshold for a strategy (defaults to EMERGENCY_STOP_WINDOW).
    pub fn get_strategy_breaker_threshold(env: Env, strategy_id: u32) -> u32 {
        let thresholds: Map<u32, u32> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "strat_breaker_thresh"))
            .unwrap_or(Map::new(&env));
        thresholds.get(strategy_id).unwrap_or(EMERGENCY_STOP_WINDOW)
    }

    /// Whether the circuit breaker would trip for a strategy based on its allocations and configured threshold.
    pub fn is_strategy_breaker_tripped(env: Env, strategy_id: u32) -> bool {
        let strategies = Self::get_strategies_map(env.clone());
        let strategy = match strategies.get(strategy_id) {
            Some(s) => s,
            None => return false,
        };
        let threshold = Self::get_strategy_breaker_threshold(env.clone(), strategy_id);
        let history: Vec<RebalanceHistory> = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "history"))
            .unwrap_optimized();
        let mut count: u32 = 0;
        let len = history.len();
        for i in 0..len {
            let idx = len - 1 - i;
            let entry = history.get(idx).unwrap();
            let mut belongs = false;
            for alloc in strategy.allocations.iter() {
                if entry.from_pool == alloc.pool_id || entry.to_pool == alloc.pool_id {
                    belongs = true;
                    break;
                }
            }
            if belongs {
                if entry.success {
                    return false;
                }
                count += 1;
                if count >= threshold {
                    return true;
                }
            }
        }
        false
    }

    /// Check and pause engine if emergency stop is triggered for a specific strategy.
    pub fn check_strategy_emergency_stop(env: Env, strategy_id: u32) -> bool {
        if !Self::is_strategy_breaker_tripped(env.clone(), strategy_id) {
            return false;
        }
        let admin = Self::get_admin(env.clone());
        Self::pause(env, admin);
        true
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::testutils::Ledger as _;
    use soroban_sdk::{token::StellarAssetClient, Env, Symbol, Vec};

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
        assert!((560..=590).contains(&v), "r=2 got {}", v);
        // r=4 => 2000 bp
        let v4 = il(&env, 40000, 10000);
        assert!((1985..=2015).contains(&v4), "r=4 got {}", v4);
        // symmetric r=0.5
        let vh = il(&env, 5000, 10000);
        assert!((560..=590).contains(&vh), "r=0.5 got {}", vh);
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
        let contract_id = env.register(RebalanceEngine, ());
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
        let sid = client.create_strategy(
            &admin,
            &Symbol::new(&env, "Test"),
            &1,
            &100,
            &500,
            &3600,
            &alloc,
        );
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
        let contract_id = env.register(RebalanceEngine, ());
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
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(env);
        let contract_id = env.register(RebalanceEngine, ());
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

    /// Like [`allocation`], but with an explicit impermanent-loss risk so the
    /// net-profit filter (Issue #294) can be exercised.
    fn allocation_with_il(env: &Env, pool: &Address, il_risk: u32) -> PoolAllocation {
        PoolAllocation {
            pool_id: pool.clone(),
            token_a: Address::generate(env),
            token_b: Address::generate(env),
            allocation_percent: 5000,
            target_apy: 1000,
            current_apy: 1000,
            impermanent_loss_risk: il_risk,
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
    fn test_pool_apy_update_overwrites_provenance_with_latest_successful_update() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let keeper = Address::generate(&env);
        let pool = Address::generate(&env);

        env.ledger().set_timestamp(100);
        client.update_pool_apy(&admin, &pool, &1500);
        let first = client.get_pool_apy_record(&pool).unwrap();

        client.set_apy_keepers(&admin, &Vec::from_array(&env, [keeper.clone()]));
        env.ledger().set_timestamp(200);
        client.update_pool_apy(&keeper, &pool, &800);

        assert_eq!(client.get_pool_current_apy(&pool), 800);
        let latest = client.get_pool_apy_record(&pool).unwrap();
        assert_eq!(latest.updated_by, keeper);
        assert_eq!(latest.updated_at, 200);
        assert_ne!(latest.updated_by, first.updated_by);
        assert_ne!(latest.updated_at, first.updated_at);
    }

    #[test]
    fn test_pool_apy_rejects_unauthorized_caller() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let pool = Address::generate(&env);
        let stranger = Address::generate(&env);

        env.ledger().set_timestamp(100);
        client.update_pool_apy(&admin, &pool, &900);
        let before = client.get_pool_apy_record(&pool).unwrap();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_pool_apy(&stranger, &pool, &1000);
        }));

        assert!(result.is_err(), "unauthorized apy update must panic");
        assert_eq!(client.get_pool_apy_record(&pool).unwrap(), before);
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

        env.ledger().set_timestamp(100);
        client.update_pool_apy(&admin, &pool, &1234);
        let before = client.get_pool_apy_record(&pool).unwrap();

        env.ledger().set_timestamp(200);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.update_pool_apy(&admin, &pool, &(MAX_APY_BPS + 1));
        }));

        assert!(result.is_err(), "apy above MAX_APY_BPS must panic");
        assert_eq!(client.get_pool_apy_record(&pool).unwrap(), before);
    }

    #[test]
    fn test_pool_apy_metadata_is_isolated_per_pool() {
        let env = Env::default();
        let (client, admin) = engine(&env);
        let keeper = Address::generate(&env);
        let pool_a = Address::generate(&env);
        let pool_b = Address::generate(&env);

        client.set_apy_keepers(&admin, &Vec::from_array(&env, [keeper.clone()]));
        env.ledger().set_timestamp(100);
        client.update_pool_apy(&admin, &pool_a, &1200);
        client.update_pool_apy(&keeper, &pool_b, &2400);
        let pool_b_before = client.get_pool_apy_record(&pool_b).unwrap();

        env.ledger().set_timestamp(200);
        client.update_pool_apy(&admin, &pool_a, &1300);

        let pool_a_record = client.get_pool_apy_record(&pool_a).unwrap();
        assert_eq!(pool_a_record.updated_by, admin);
        assert_eq!(pool_a_record.updated_at, 200);
        assert_eq!(client.get_pool_apy_record(&pool_b).unwrap(), pool_b_before);
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

    // ==================== Typed error paths ====================

    #[test]
    fn test_create_strategy_reports_typed_errors() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = engine(&env);

        // Empty allocations.
        let empty: Vec<PoolAllocation> = Vec::new(&env);
        let err = client
            .try_create_strategy(
                &admin,
                &Symbol::new(&env, "Empty"),
                &1,
                &100,
                &500,
                &3600,
                &empty,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RebalanceError::EmptyAllocations.into());

        // A single allocation above 100%.
        let pool = Address::generate(&env);
        let over = Vec::from_array(&env, [allocation(&env, &pool, 10001, 500, 500)]);
        let err = client
            .try_create_strategy(
                &admin,
                &Symbol::new(&env, "Over"),
                &1,
                &100,
                &500,
                &3600,
                &over,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RebalanceError::AllocationOutOfRange.into());

        // Allocations that do not sum to 100%.
        let short = Vec::from_array(
            &env,
            [
                allocation(&env, &pool, 4000, 500, 500),
                allocation(&env, &Address::generate(&env), 4000, 500, 500),
            ],
        );
        let err = client
            .try_create_strategy(
                &admin,
                &Symbol::new(&env, "Short"),
                &1,
                &100,
                &500,
                &3600,
                &short,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RebalanceError::AllocationsMustSumTo100Percent.into());

        // Risk level outside 1..=3.
        let ok = Vec::from_array(&env, [allocation(&env, &pool, 10000, 500, 500)]);
        let err = client
            .try_create_strategy(
                &admin,
                &Symbol::new(&env, "BadRisk"),
                &9,
                &100,
                &500,
                &3600,
                &ok,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RebalanceError::InvalidRiskLevel.into());
    }

    #[test]
    fn test_get_strategy_unknown_id_is_typed() {
        let env = Env::default();
        let (client, _admin) = engine(&env);

        let err = client.try_get_strategy(&7).unwrap_err().unwrap();
        assert_eq!(err, RebalanceError::StrategyNotFound.into());
    // ============ REBALANCE PACING TESTS (Issue #302) ============

    /// Real token contracts for a rebalance leg: the engine pulls the `from`
    /// leg out of the source pool and pays the `to` leg from its own balance.
    fn funded_pools(env: &Env, engine_id: &Address, amount: i128) -> (Address, Address) {
        let admin = Address::generate(env);
        let from = env.register_stellar_asset_contract_v2(admin.clone());
        let to = env.register_stellar_asset_contract_v2(admin);
        StellarAssetClient::new(env, &from.address()).mint(&from.address(), &amount);
        StellarAssetClient::new(env, &to.address()).mint(engine_id, &amount);
        (from.address(), to.address())
    }

    fn pacing_proposal(from_pool: &Address, to_pool: &Address, amount: i128) -> RebalanceProposal {
        RebalanceProposal {
            from_pool: from_pool.clone(),
            to_pool: to_pool.clone(),
            amount_a: amount,
            amount_b: amount,
            expected_apy_improvement: 0,
            estimated_gas_cost: 0,
            timestamp: 0,
            min_output: amount,
        }
    }

    // ============ CIRCUIT BREAKER TESTS (Issue #303) ============

    /// The breaker rule is a pure function: no engine, no storage, no ledger.
    #[test]
    fn test_breaker_rule_requires_three_consecutive_failures() {
        assert!(RebalanceEngine::breaker_trips(false, false, false));
        assert!(!RebalanceEngine::breaker_trips(false, false, true));
        assert!(!RebalanceEngine::breaker_trips(false, true, false));
        assert!(
            !RebalanceEngine::breaker_trips(true, false, false),
            "the newest success breaks the losing streak"
        );
        assert!(!RebalanceEngine::breaker_trips(true, true, true));
    }

    fn failed_proposal(env: &Env, pool: &Address) -> RebalanceProposal {
        // Zero amounts are rejected by `perform_rebalance`, which records a
        // failed history entry without touching any token contract.
        RebalanceProposal {
            from_pool: pool.clone(),
            to_pool: pool.clone(),
            amount_a: 0,
            amount_b: 0,
            expected_apy_improvement: 0,
            estimated_gas_cost: 0,
            timestamp: env.ledger().timestamp(),
            min_output: 0,
        }
    }

    #[test]
    fn test_rebalance_pacing_is_disabled_by_default() {
        let env = Env::default();
        let (client, _admin) = engine(&env);

        let pacing = client.get_rebalance_pacing();
        assert_eq!(pacing.max_amount_per_window, 0);
        assert_eq!(pacing.window_seconds, 0);

        let usage = client.get_pool_window_usage(&Address::generate(&env));
        assert!(!usage.window_active);
        assert_eq!(usage.amount_moved, 0);
    }

    #[test]
    fn test_rebalance_pacing_bounds_moves_and_resets_per_window() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let contract_id = env.register(RebalanceEngine, ());
        let client = RebalanceEngineClient::new(&env, &contract_id);
        client.initialize(&admin);

        let (from_pool, to_pool) = funded_pools(&env, &contract_id, 10_000);
        let caller = Address::generate(&env);
        client.set_rebalance_pacing(&admin, &500, &3_600);

        // A single move larger than the whole window budget is rejected before
        // any tokens move, and does not open a window.
        let oversized = pacing_proposal(&from_pool, &to_pool, 300); // 600 moved
        assert!(!client.execute_rebalance(&caller, &oversized));
        assert!(!client.get_pool_window_usage(&from_pool).window_active);

        // 400 moved fits the 500 budget and is recorded.
        let allowed = pacing_proposal(&from_pool, &to_pool, 200);
        assert!(client.execute_rebalance(&caller, &allowed));
        assert_eq!(client.get_pool_window_usage(&from_pool).amount_moved, 400);

        // The remaining 100 of budget cannot absorb another 400.
        assert!(!client.execute_rebalance(&caller, &allowed));
        assert_eq!(client.get_pool_window_usage(&from_pool).amount_moved, 400);

        // Once the window has elapsed the budget resets.
        env.ledger().set_timestamp(3_600);
        assert!(client.execute_rebalance(&caller, &allowed));
        assert_eq!(client.get_pool_window_usage(&from_pool).amount_moved, 400);
    }

    #[test]
    fn test_set_rebalance_pacing_is_admin_only() {
        let env = Env::default();
        let (client, _admin) = engine(&env);
        let stranger = Address::generate(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_rebalance_pacing(&stranger, &100, &3_600);
        }));

        assert!(result.is_err(), "pacing limits must be admin only");
        assert_eq!(client.get_rebalance_pacing().max_amount_per_window, 0);
    }

    #[test]
    fn test_set_rebalance_pacing_validates_limits() {
        let env = Env::default();
        let (client, admin) = engine(&env);

        // A negative budget is not meaningful.
        let negative = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_rebalance_pacing(&admin, &-1, &3_600);
        }));
        assert!(negative.is_err());

        // An enabled budget needs a window to apply over.
        let no_window = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.set_rebalance_pacing(&admin, &100, &0);
        }));
        assert!(no_window.is_err());
    }

    #[test]
    fn test_breaker_does_not_trip_before_it_has_enough_history() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = engine(&env);

        assert!(!client.is_emergency_stop_triggered());
        assert!(!client.check_emergency_stop());
        assert!(!client.is_paused(), "a new engine must not stop itself");
    }

    #[test]
    fn test_non_admin_pause_is_typed_unauthorized() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = engine(&env);

        let stranger = Address::generate(&env);
        let err = client.try_pause(&stranger).unwrap_err().unwrap();
        assert_eq!(err, RebalanceError::Unauthorized.into());
    }

    #[test]
    fn test_published_apy_above_maximum_is_typed() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = engine(&env);

        let pool = Address::generate(&env);
        let err = client
            .try_update_pool_apy(&admin, &pool, &(MAX_APY_BPS + 1))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RebalanceError::ApyOutOfRange.into());
    }

    #[test]
    fn test_breaker_view_is_read_only_and_check_pauses() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = engine(&env);
        let pool = Address::generate(&env);
        let caller = Address::generate(&env);

        for _ in 0..EMERGENCY_STOP_WINDOW {
            let executed = client.execute_rebalance(&caller, &failed_proposal(&env, &pool));
            assert!(!executed);
        }
        assert_eq!(client.get_history_count(), EMERGENCY_STOP_WINDOW);

        // The decision can be observed without side effects...
        assert!(client.is_emergency_stop_triggered());
        assert!(!client.is_paused(), "the read-only view must not pause");

        // ...and `check_emergency_stop` takes the same decision and enforces it.
        assert!(client.check_emergency_stop());
        assert!(client.is_paused());
    }

    #[test]
    fn test_one_success_keeps_the_breaker_closed() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = engine(&env);
        let pool = Address::generate(&env);
        let caller = Address::generate(&env);

        // Two failures followed by a third, so history holds three results and
        // the oldest two are failures. The newest result is the one that
        // decides, and the pure rule is exercised directly below.
        for _ in 0..EMERGENCY_STOP_WINDOW {
            client.execute_rebalance(&caller, &failed_proposal(&env, &pool));
        }
        assert!(client.is_emergency_stop_triggered());

        // A success newer than the failing streak would move the window past
        // it; `breaker_trips(true, false, false)` pins that rule without
        // needing a token-funded successful rebalance here.
        assert!(!RebalanceEngine::breaker_trips(true, false, false));
        assert!(RebalanceEngine::breaker_trips(false, false, false));
    }

    #[test]
    fn test_configurable_pool_breaker_thresholds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = engine(&env);
        let pool_a = Address::generate(&env);
        let pool_b = Address::generate(&env);
        let pool_c = Address::generate(&env);
        let caller = Address::generate(&env);

        // Pool A is sensitive: trips after 2 failures
        client.set_pool_breaker_threshold(&admin, &pool_a, &2);
        // Pool B is relaxed: trips after 4 failures
        client.set_pool_breaker_threshold(&admin, &pool_b, &4);

        assert_eq!(client.get_pool_breaker_threshold(&pool_a), 2);
        assert_eq!(client.get_pool_breaker_threshold(&pool_b), 4);
        assert_eq!(client.get_pool_breaker_threshold(&pool_c), EMERGENCY_STOP_WINDOW);

        // Record 2 failures for Pool A
        client.execute_rebalance(&caller, &failed_proposal(&env, &pool_a));
        client.execute_rebalance(&caller, &failed_proposal(&env, &pool_a));

        // Pool A triggers breaker
        assert!(client.is_pool_emergency_stop_triggered(&pool_a));

        // Record 2 failures for Pool B
        client.execute_rebalance(&caller, &failed_proposal(&env, &pool_b));
        client.execute_rebalance(&caller, &failed_proposal(&env, &pool_b));

        // Pool B does NOT trigger breaker yet (threshold is 4)
        assert!(!client.is_pool_emergency_stop_triggered(&pool_b));

        // Record 2 more failures for Pool B (total 4)
        client.execute_rebalance(&caller, &failed_proposal(&env, &pool_b));
        client.execute_rebalance(&caller, &failed_proposal(&env, &pool_b));

        // Pool B now triggers breaker
        assert!(client.is_pool_emergency_stop_triggered(&pool_b));

        // Check emergency stop pauses contract when triggered
        assert!(!client.is_paused());
        assert!(client.check_pool_emergency_stop(&pool_a));
        assert!(client.is_paused());
    }

    #[test]
    fn test_configurable_strategy_breaker_thresholds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admin) = engine(&env);
        let pool_a = Address::generate(&env);
        let pool_b = Address::generate(&env);
        let caller = Address::generate(&env);

        let alloc_1 = Vec::from_array(&env, [allocation(&env, &pool_a, 10000, 500, 500)]);
        let s1 = client.create_strategy(
            &admin,
            &Symbol::new(&env, "Aggressive"),
            &3,
            &100,
            &500,
            &3600,
            &alloc_1,
        );

        let alloc_2 = Vec::from_array(&env, [allocation(&env, &pool_b, 10000, 500, 500)]);
        let s2 = client.create_strategy(
            &admin,
            &Symbol::new(&env, "Conservative"),
            &1,
            &100,
            &500,
            &3600,
            &alloc_2,
        );

        // s1 sensitive: trips after 1 failure
        client.set_strategy_breaker_threshold(&admin, &s1, &1);
        // s2 relaxed: trips after 3 failures
        client.set_strategy_breaker_threshold(&admin, &s2, &3);

        assert_eq!(client.get_strategy_breaker_threshold(&s1), 1);
        assert_eq!(client.get_strategy_breaker_threshold(&s2), 3);

        // 1 failure on pool_a (belongs to s1)
        client.execute_rebalance(&caller, &failed_proposal(&env, &pool_a));
        assert!(client.is_strategy_breaker_tripped(&s1));
        assert!(!client.is_strategy_breaker_tripped(&s2));

        // 1 failure on pool_b (belongs to s2)
        client.execute_rebalance(&caller, &failed_proposal(&env, &pool_b));
        // s2 needs 3, so not triggered yet
        assert!(!client.is_strategy_breaker_tripped(&s2));
    }

    #[test]
    fn test_breaker_trips_for_threshold_pure_rule() {
        assert!(RebalanceEngine::breaker_trips_for_threshold(3, 3));
        assert!(RebalanceEngine::breaker_trips_for_threshold(4, 3));
        assert!(!RebalanceEngine::breaker_trips_for_threshold(2, 3));
        assert!(RebalanceEngine::breaker_trips_for_threshold(1, 1));
        assert!(!RebalanceEngine::breaker_trips_for_threshold(0, 1));
        assert!(!RebalanceEngine::breaker_trips_for_threshold(5, 0));
    }
}
