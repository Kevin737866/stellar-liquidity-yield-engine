use soroban_sdk::{
    contract, contractimpl, contracttype, token::TokenClient, vec, Address, Env, Map, Symbol, Vec,
};

/// Maximum path length for multi-hop swaps
const MAX_PATH_LENGTH: u32 = 3;

/// Maximum permitted slippage tolerance in basis points (1% = 100 bps).
///
/// The router's existing default and the reward distributor's fixed tolerance
/// are both 100 bps. Keeping the configurable value at or below that limit
/// ensures a quote always retains at least 99% of its expected output.
const MAX_SLIPPAGE_BPS: u32 = 100;

/// Default slippage tolerance in basis points (1%).
const DEFAULT_MAX_SLIPPAGE_BPS: u32 = MAX_SLIPPAGE_BPS;

/// Treasury fee in basis points (0.25%)
const PROTOCOL_TREASURY_FEE_BPS: u32 = 25;

/// Basis points divisor
const BPS_DIVISOR: i128 = 10000;

/// Swap path entry
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapPath {
    pub tokens: Vec<Address>,   // Path: [input, intermediate..., output]
    pub pools: Vec<Address>,    // Corresponding pools
    pub expected_output: i128,  // Expected output amount
    pub price_impact_bps: i128, // Price impact in basis points
}

/// Pool information
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolInfo {
    pub pool_address: Address,
    pub token_a: Address,
    pub token_b: Address,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub fee_bps: u32,         // Trading fee in basis points
    pub is_stable_swap: bool, // Stable swap pool (lower slippage)
}

impl PoolInfo {
    /// Calculate depth score for pool selection
    /// Higher score indicates better liquidity depth
    /// Uses geometric mean of reserves to account for balanced liquidity
    pub fn depth_score(&self) -> i128 {
        // Use geometric mean: sqrt(reserve_a * reserve_b)
        // This favors pools with balanced liquidity over skewed reserves
        if self.reserve_a <= 0 || self.reserve_b <= 0 || self.fee_bps >= 10_000 {
            return 0;
        }
        // Unsupported magnitudes are excluded rather than overflowing while
        // ranking candidates. See docs/ROUTER_FUZZING.md for numeric limits.
        let Some(product) = self.reserve_a.checked_mul(self.reserve_b) else {
            return 0;
        };

        // Integer square root approximation
        Self::isqrt(product)
    }

    /// Integer square root using binary search
    fn isqrt(n: i128) -> i128 {
        if n <= 1 {
            return n;
        }

        let mut low = 1i128;
        let mut high = n;
        let mut result = 1i128;

        while low <= high {
            let mid = low + (high - low) / 2;
            if mid <= n / mid {
                result = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        result
    }

    /// Get total liquidity (sum of reserves)
    pub fn total_liquidity(&self) -> i128 {
        self.reserve_a.saturating_add(self.reserve_b)
    }

    /// Check if pool has sufficient liquidity for a given amount
    /// Returns true if reserves are at least 10x the input amount
    pub fn has_sufficient_liquidity(&self, input_amount: i128) -> bool {
        let min_reserve = self.reserve_a.min(self.reserve_b);
        input_amount > 0 && min_reserve / 10 >= input_amount
    }
}

/// Swap quote result
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapQuote {
    pub path: SwapPath,
    pub input_amount: i128,
    pub minimum_output: i128,
    pub expected_output: i128,
    pub price_impact_bps: i128,
    pub protocol_fee: i128,
    pub route_type: RouteType, // Direct, XLM_HOP, or MULTI_HOP
}

/// Route types for analytics
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouteType {
    Direct,   // Direct pool swap
    XLMHop,   // Through XLM
    MultiHop, // Multi-pool path
}

/// Completed swap record
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapRecord {
    pub swap_id: u64,
    pub user: Address,
    pub input_token: Address,
    pub output_token: Address,
    pub input_amount: i128,
    pub output_amount: i128,
    pub path: Vec<Address>,
    pub protocol_fee: i128,
    pub timestamp: u64,
    pub success: bool,
}

/// A failed swap queued for retry
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingSwap {
    pub swap_id: u64,
    pub user: Address,
    pub input_token: Address,
    pub output_token: Address,
    pub input_amount: i128,
    pub min_output: i128,
    pub retry_count: u32,
    pub max_retries: u32,
    pub timestamp: u64,
}

/// Swap router error types
#[soroban_sdk::contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SwapError {
    InsufficientBalance = 1,
    InsufficientOutput = 2,
    SlippageExceeded = 3,
    InvalidPath = 4,
    NoPoolFound = 5,
    PoolInsufficientLiquidity = 6,
    InvalidSlippage = 7,
    TransferFailed = 8,
    Unauthorized = 9,
    InvalidToken = 10,
    PoolExists = 11,
    PoolNotFound = 12,
}

/// SwapRouter contract for Stellar DEX integration
#[contract]
pub struct SwapRouter;

#[contractimpl]
impl SwapRouter {
    /// Initialize the swap router
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        xlm_token: Address, // Wrapped XLM address
    ) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "admin"), &admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "treasury"), &treasury);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "xlm_token"), &xlm_token);
        env.storage().instance().set(
            &Symbol::new(&env, "default_slippage"),
            &DEFAULT_MAX_SLIPPAGE_BPS,
        );

        // Initialize swap counter
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "next_swap_id"), &1u64);

        // Initialize empty pools map
        let pools: Map<Address, PoolInfo> = Map::new(&env);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pools"), &pools);

        // Initialize oracle pause state to false
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "oracle_paused"), &false);
    }

    // ==================== Pool Management ====================

    /// Add a new pool (admin only)
    pub fn add_pool(
        env: Env,
        admin: Address,
        pool_address: Address,
        token_a: Address,
        token_b: Address,
        fee_bps: u32,
        is_stable_swap: bool,
    ) {
        Self::require_admin(&env, admin);

        let mut pools = Self::get_pools(&env);
        require!(
            !pools.contains_key(pool_address.clone()),
            SwapError::PoolExists
        );

        let pool = PoolInfo {
            pool_address: pool_address.clone(),
            token_a: token_a.clone(),
            token_b: token_b.clone(),
            reserve_a: 0,
            reserve_b: 0,
            fee_bps,
            is_stable_swap,
        };

        pools.set(pool_address.clone(), pool);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pools"), &pools);

        env.events().publish(
            ("pool_added",),
            (&pool_address, &token_a, &token_b, fee_bps),
        );
    }

    /// Update pool reserves (can be called by authorized oracle)
    pub fn update_pool_reserves(
        env: Env,
        pool_address: Address,
        reserve_a: i128,
        reserve_b: i128,
    ) -> Result<(), SwapError> {
        Self::require_oracle_not_paused(&env);

        let mut pools = Self::get_pools(&env);

        if let Some(mut pool) = pools.get(pool_address.clone()) {
            pool.reserve_a = reserve_a;
            pool.reserve_b = reserve_b;
            pools.set(pool_address, pool);
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "pools"), &pools);
            Ok(())
        } else {
            Err(SwapError::NoPoolFound)
        }
    }

    /// Remove a pool (admin only)
    pub fn remove_pool(env: Env, admin: Address, pool_address: Address) {
        Self::require_admin(&env, admin);

        let mut pools = Self::get_pools(&env);
        require!(
            pools.contains_key(pool_address.clone()),
            SwapError::PoolNotFound
        );
        pools.remove(pool_address);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pools"), &pools);
    }

    // ==================== Quote Functions ====================

    /// Get quote for a swap - calculates best path
    pub fn get_quote(
        env: Env,
        input_token: Address,
        output_token: Address,
        input_amount: i128,
        max_slippage_bps: Option<u32>,
    ) -> SwapQuote {
        require!(
            input_amount > 0 && input_token != output_token,
            SwapError::InvalidPath
        );

        let slippage = max_slippage_bps.unwrap_or_else(|| Self::get_default_slippage(env.clone()));
        Self::require_valid_slippage(slippage);

        // Find best path
        let (path, route_type) =
            Self::find_best_path(&env, &input_token, &output_token, input_amount);
        // find_best_path falls back to a pool-less path when no route exists;
        // tokens.len() is always >= 2 even in that case, so check pools instead.
        require!(!path.pools.is_empty(), SwapError::NoPoolFound);

        // Calculate output with price impact
        let expected_output = Self::calculate_output_amount(&env, &path, input_amount);

        // Calculate minimum output with slippage protection
        let minimum_output = Self::calculate_minimum_output(expected_output, slippage);

        // Calculate protocol fee (0.25% of output)
        let protocol_fee = Self::scale_bps(expected_output, PROTOCOL_TREASURY_FEE_BPS);

        SwapQuote {
            path,
            input_amount,
            minimum_output,
            expected_output,
            price_impact_bps: 0, // Calculate based on reserves
            protocol_fee,
            route_type,
        }
    }

    /// Get quote for direct swap only (no routing)
    pub fn get_direct_quote(
        env: Env,
        input_token: Address,
        output_token: Address,
        input_amount: i128,
    ) -> Option<SwapQuote> {
        if input_amount <= 0 || input_token == output_token {
            return None;
        }
        let pool = Self::find_direct_path(&env, &input_token, &output_token, input_amount)?;
        let (expected_output, price_impact) =
            Self::calculate_direct_swap(&pool, &input_token, input_amount);
        let minimum_output = Self::calculate_minimum_output(
            expected_output,
            Self::get_default_slippage(env.clone()),
        );
        Some(SwapQuote {
            path: SwapPath {
                tokens: vec![&env, input_token, output_token],
                pools: vec![&env, pool.pool_address],
                expected_output,
                price_impact_bps: price_impact,
            },
            input_amount,
            minimum_output,
            expected_output,
            price_impact_bps: price_impact,
            protocol_fee: Self::scale_bps(expected_output, PROTOCOL_TREASURY_FEE_BPS),
            route_type: RouteType::Direct,
        })
    }

    // ==================== Swap Execution ====================

    /// Execute a swap
    pub fn swap(
        env: Env,
        user: Address,
        input_token: Address,
        output_token: Address,
        input_amount: i128,
        min_output: i128,
        path: Vec<Address>,
        recipient: Option<Address>,
    ) -> i128 {
        require!(input_amount > 0, SwapError::InvalidPath);
        require!(min_output > 0, SwapError::InvalidSlippage);
        require!(path.len() >= 2, SwapError::InvalidPath);

        let treasury = Self::get_treasury(&env);
        let recipient = recipient.unwrap_or(user.clone());

        // Calculate output
        let expected_output = Self::calculate_path_output(&env, &path, input_amount);

        // Verify minimum output (slippage protection)
        require!(expected_output >= min_output, SwapError::SlippageExceeded);

        // Transfer input tokens from user
        let input_token_client = TokenClient::new(&env, &input_token);
        input_token_client.transfer(&user, &env.current_contract_address(), &input_amount);

        // Calculate protocol fee
        let protocol_fee = Self::scale_bps(expected_output, PROTOCOL_TREASURY_FEE_BPS);
        let net_output = expected_output - protocol_fee;

        // Execute swaps along the path
        let mut amount = input_amount;
        for i in 0..(path.len() - 1) {
            let from = path.get(i).unwrap();
            let to = path.get(i + 1).unwrap();

            amount = Self::execute_pool_swap(
                &env, &from, &to, amount, false, // is_reverse - will be calculated
            );
        }

        // Transfer output tokens
        let output_token_client = TokenClient::new(&env, &output_token);
        output_token_client.transfer(&env.current_contract_address(), &recipient, &net_output);

        // Transfer protocol fee to treasury
        if protocol_fee > 0 {
            output_token_client.transfer(&env.current_contract_address(), &treasury, &protocol_fee);
        }

        // Record swap
        let swap_id = Self::record_swap(
            &env,
            &user,
            &input_token,
            &output_token,
            input_amount,
            net_output,
            &path,
            protocol_fee,
            true,
        );

        env.events().publish(
            ("swap_completed",),
            (
                swap_id,
                &user,
                &input_token,
                &output_token,
                input_amount,
                net_output,
            ),
        );

        net_output
    }

    /// Swap with retry queue for failed swaps
    pub fn swap_with_retry(
        env: Env,
        user: Address,
        input_token: Address,
        output_token: Address,
        input_amount: i128,
        min_output: i128,
        max_retries: u32,
    ) -> Result<i128, SwapError> {
        // Try immediate swap
        match Self::try_swap(
            &env,
            &user,
            &input_token,
            &output_token,
            input_amount,
            min_output,
        ) {
            Ok(output) => Ok(output),
            Err(_) => {
                // Queue for retry
                Self::queue_swap_for_retry(
                    &env,
                    &user,
                    &input_token,
                    &output_token,
                    input_amount,
                    min_output,
                    max_retries,
                );
                Err(SwapError::TransferFailed)
            }
        }
    }

    // ==================== Query Functions ====================

    /// Get all pools
    pub fn get_all_pools(env: Env) -> Vec<PoolInfo> {
        let pools = Self::get_pools(&env);
        pools.values()
    }

    /// Get pools for a specific token
    pub fn get_token_pools(env: Env, token: Address) -> Vec<PoolInfo> {
        let pools = Self::get_pools(&env);
        let mut result: Vec<PoolInfo> = Vec::new(&env);

        for (_, pool) in pools.iter() {
            if pool.token_a == token || pool.token_b == token {
                result.push_back(pool);
            }
        }

        result
    }

    /// Get pool by address
    pub fn get_pool(env: Env, pool_address: Address) -> Option<PoolInfo> {
        let pools = Self::get_pools(&env);
        pools.get(pool_address.clone())
    }

    /// Get swap history for a user
    pub fn get_user_swaps(env: Env, user: Address, limit: u32) -> Vec<SwapRecord> {
        // In production, query indexed events
        // For now, return empty - history stored in events
        let _ = (user, limit);
        let records: Vec<SwapRecord> = Vec::new(&env);
        records
    }

    /// Get protocol statistics
    pub fn get_protocol_stats(env: Env) -> (u64, i128, i128) {
        let total_swaps: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "total_swaps"))
            .unwrap_or(0);
        let total_volume: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "total_volume"))
            .unwrap_or(0);
        let total_fees: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "total_fees"))
            .unwrap_or(0);

        (total_swaps, total_volume, total_fees)
    }

    // ==================== Admin Functions ====================

    /// Update default slippage (admin only)
    pub fn update_default_slippage(env: Env, admin: Address, new_slippage_bps: u32) {
        Self::require_admin(&env, admin);
        Self::require_valid_slippage(new_slippage_bps);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "default_slippage"), &new_slippage_bps);
    }

    /// Return the configured default slippage tolerance in basis points.
    pub fn get_default_slippage(env: Env) -> u32 {
        let slippage = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "default_slippage"))
            .unwrap_or(DEFAULT_MAX_SLIPPAGE_BPS);
        // Do not let a legacy or corrupted persisted value silently weaken
        // protection when it is consumed by a quote.
        Self::require_valid_slippage(slippage);
        slippage
    }

    /// Update treasury address (admin only)
    pub fn update_treasury(env: Env, admin: Address, new_treasury: Address) {
        Self::require_admin(&env, admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "treasury"), &new_treasury);
    }

    /// Pause swap router (admin only)
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause swap router (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);
    }

    /// Pause oracle ingestion (admin only)
    pub fn pause_oracle(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "oracle_paused"), &true);
        env.events()
            .publish((Symbol::new(&env, "oracle_paused"),), (admin,));
    }

    /// Unpause oracle ingestion (admin only)
    pub fn unpause_oracle(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "oracle_paused"), &false);
        env.events()
            .publish((Symbol::new(&env, "oracle_unpaused"),), (admin,));
    }

    /// Check if oracle ingestion is paused
    pub fn is_oracle_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "oracle_paused"))
            .unwrap_or(false)
    }

    /// Retry failed swaps (admin only)
    pub fn retry_failed_swaps(env: Env, admin: Address) -> u32 {
        Self::require_admin(&env, admin);

        let key = Symbol::new(&env, "pending_swap");
        let pending: Map<u64, PendingSwap> =
            env.storage().instance().get(&key).unwrap_or(Map::new(&env));

        let mut remaining: Map<u64, PendingSwap> = Map::new(&env);
        let mut retried = 0u32;

        for (swap_id, mut pending_swap) in pending.iter() {
            match Self::try_swap(
                &env,
                &pending_swap.user,
                &pending_swap.input_token,
                &pending_swap.output_token,
                pending_swap.input_amount,
                pending_swap.min_output,
            ) {
                Ok(_) => {
                    retried += 1;
                    env.events()
                        .publish(("swap_retry_succeeded",), (swap_id, &pending_swap.user));
                }
                Err(_) => {
                    pending_swap.retry_count += 1;
                    if pending_swap.retry_count < pending_swap.max_retries {
                        remaining.set(swap_id, pending_swap);
                    } else {
                        env.events()
                            .publish(("swap_retry_abandoned",), (swap_id, &pending_swap.user));
                    }
                }
            }
        }

        env.storage().instance().set(&key, &remaining);
        retried
    }

    // ==================== Internal Helpers ====================

    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        require!(caller == admin, SwapError::Unauthorized);
    }

    fn require_valid_slippage(slippage_bps: u32) {
        require!(slippage_bps <= MAX_SLIPPAGE_BPS, SwapError::InvalidSlippage);
    }

    fn require_not_paused(env: &Env) {
        let paused = env
            .storage()
            .instance()
            .get::<_, bool>(&Symbol::new(env, "paused"))
            .unwrap_or(false);
        require!(!paused, SwapError::Unauthorized);
    }

    fn require_oracle_not_paused(env: &Env) {
        let oracle_paused = env
            .storage()
            .instance()
            .get::<_, bool>(&Symbol::new(env, "oracle_paused"))
            .unwrap_or(false);
        require!(!oracle_paused, SwapError::Unauthorized);
    }

    fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_or_else(|| panic!("admin not configured"))
    }

    fn get_treasury(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "treasury"))
            .unwrap_or_else(|| panic!("treasury not configured"))
    }

    fn get_xlm_token(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "xlm_token"))
            .unwrap()
    }

    fn get_pools(env: &Env) -> Map<Address, PoolInfo> {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "pools"))
            .unwrap_or(Map::new(env))
    }

    /// Find the best path for a swap
    fn find_best_path(
        env: &Env,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
    ) -> (SwapPath, RouteType) {
        let xlm = Self::get_xlm_token(env);

        // Try direct path first
        if let Some(direct_path) =
            Self::find_direct_path(env, input_token, output_token, input_amount)
        {
            if let Some(output_amount) =
                Self::calculate_direct_swap_output_for_pool(&direct_path, input_token, input_amount)
            {
                let pools = vec![env, direct_path.pool_address.clone()];
                return (
                    SwapPath {
                        tokens: vec![env, input_token.clone(), output_token.clone()],
                        pools,
                        expected_output: output_amount,
                        price_impact_bps: 0,
                    },
                    RouteType::Direct,
                );
            }
        }

        // Try XLM hop path: input -> XLM -> output
        if *input_token != xlm && *output_token != xlm {
            if let Some(xlm_path) =
                Self::find_xlm_hop_path(env, input_token, output_token, input_amount)
            {
                return (xlm_path, RouteType::XLMHop);
            }
        }

        // Try multi-hop paths
        if let Some(multi_path) =
            Self::find_multi_hop_path(env, input_token, output_token, input_amount)
        {
            return (multi_path, RouteType::MultiHop);
        }

        // No path found - return direct with zero output
        (
            SwapPath {
                tokens: vec![env, input_token.clone(), output_token.clone()],
                pools: Vec::new(env),
                expected_output: 0,
                price_impact_bps: 0,
            },
            RouteType::Direct,
        )
    }

    /// Find direct pool path with depth-aware selection
    /// Returns the pool with the highest depth score for the token pair
    fn find_direct_path(
        env: &Env,
        token_a: &Address,
        token_b: &Address,
        input_amount: i128,
    ) -> Option<PoolInfo> {
        let pools = Self::get_pools(env);
        let mut best_pool: Option<PoolInfo> = None;
        let mut best_depth_score: i128 = 0;

        for (_, pool) in pools.iter() {
            if (pool.token_a == *token_a && pool.token_b == *token_b)
                || (pool.token_a == *token_b && pool.token_b == *token_a)
            {
                let depth_score = pool.depth_score();
                if depth_score > best_depth_score
                    && Self::calculate_direct_swap_output_for_pool(&pool, token_a, input_amount)
                        .is_some_and(|output| output > 0)
                {
                    best_depth_score = depth_score;
                    best_pool = Some(pool);
                }
            }
        }

        best_pool
    }

    /// Find path through XLM with depth-aware selection
    /// Selects pools with highest depth scores for both legs
    fn find_xlm_hop_path(
        env: &Env,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
    ) -> Option<SwapPath> {
        let xlm = Self::get_xlm_token(env);

        // Find input -> XLM pool (already depth-aware via find_direct_path)
        let input_pool = Self::find_direct_path(env, input_token, &xlm, input_amount)?;

        // Calculate output through both pools
        let first_output =
            Self::calculate_direct_swap_output_for_pool(&input_pool, input_token, input_amount)?;

        let output_pool = Self::find_direct_path(env, &xlm, output_token, first_output)?;
        let final_output =
            Self::calculate_direct_swap_output_for_pool(&output_pool, &xlm, first_output)?;

        Some(SwapPath {
            tokens: vec![env, input_token.clone(), xlm.clone(), output_token.clone()],
            pools: vec![
                env,
                input_pool.pool_address.clone(),
                output_pool.pool_address.clone(),
            ],
            expected_output: final_output,
            price_impact_bps: 0,
        })
    }

    /// Find multi-hop path (up to 3 edges)
    fn find_multi_hop_path(
        env: &Env,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
    ) -> Option<SwapPath> {
        let mut visited: Vec<Address> = Vec::new(env);
        visited.push_back(input_token.clone());

        // Depth-first search with backtracking to find a path
        if let Some((path_tokens, path_pools, output)) = Self::bfs_find_path(
            env,
            input_token,
            output_token,
            &mut visited,
            input_amount,
            0,
        ) {
            return Some(SwapPath {
                tokens: path_tokens,
                pools: path_pools,
                expected_output: output,
                price_impact_bps: 0,
            });
        }

        None
    }

    /// Bounded depth-first path finding with depth-aware pool selection
    fn bfs_find_path(
        env: &Env,
        current: &Address,
        target: &Address,
        visited: &mut Vec<Address>,
        amount: i128,
        depth: u32,
    ) -> Option<(Vec<Address>, Vec<Address>, i128)> {
        if depth >= MAX_PATH_LENGTH {
            return None;
        }

        let pools = Self::get_pools(env);

        // Collect all pools that connect to current token with their depth scores
        let mut pool_candidates: Vec<(PoolInfo, Address)> = Vec::new(env);

        for (_, pool) in pools.iter() {
            if let Some(next_token) = if pool.token_a == *current {
                Some(pool.token_b.clone())
            } else if pool.token_b == *current {
                Some(pool.token_a.clone())
            } else {
                None
            } {
                // Skip if already visited
                let mut already_visited = false;
                for v in visited.iter() {
                    if v == next_token {
                        already_visited = true;
                        break;
                    }
                }
                if !already_visited {
                    pool_candidates.push_back((pool, next_token));
                }
            }
        }

        // Sort by depth score (highest first) using simple bubble sort
        // In production, consider using a more efficient sorting algorithm
        let n = pool_candidates.len();
        for i in 0..n {
            for j in 0..(n - i - 1) {
                let (pool_a, _) = pool_candidates.get(j).unwrap();
                let (pool_b, _) = pool_candidates.get(j + 1).unwrap();
                if pool_a.depth_score() < pool_b.depth_score() {
                    // Swap
                    let temp = pool_candidates.get(j).unwrap().clone();
                    pool_candidates.set(j, pool_candidates.get(j + 1).unwrap().clone());
                    pool_candidates.set(j + 1, temp);
                }
            }
        }

        // Try pools in order of depth score (highest first)
        for (pool, next_token) in pool_candidates.iter() {
            // Calculate output for this leg
            let Some(output) = Self::calculate_direct_swap_output_for_pool(&pool, current, amount)
                .filter(|output| *output > 0)
            else {
                // A bad candidate must not hide a viable sibling route.
                continue;
            };

            if next_token == *target {
                // Found target
                let mut tokens = Vec::new(env);
                for v in visited.iter() {
                    tokens.push_back(v);
                }
                tokens.push_back(next_token);

                let mut pools_list = Vec::new(env);
                pools_list.push_back(pool.pool_address);

                return Some((tokens, pools_list, output));
            }

            // Continue BFS
            visited.push_back(next_token.clone());
            if let Some((final_tokens, final_pools, final_output)) =
                Self::bfs_find_path(env, &next_token, target, visited, output, depth + 1)
            {
                let mut pools_list = Vec::new(env);
                pools_list.push_back(pool.pool_address);
                for p in final_pools.iter() {
                    pools_list.push_back(p);
                }

                return Some((final_tokens, pools_list, final_output));
            }
            visited.pop_back();
        }

        None
    }

    /// Calculate output amount for a path
    fn calculate_output_amount(env: &Env, path: &SwapPath, input_amount: i128) -> i128 {
        if path.tokens.len() != path.pools.len() + 1 || path.pools.is_empty() {
            return 0;
        }
        let pools = Self::get_pools(env);
        let mut amount = input_amount;
        for i in 0..path.pools.len() {
            let Some(pool) = pools.get(path.pools.get(i).unwrap()) else {
                return 0;
            };
            let from = path.tokens.get(i).unwrap();
            let to = path.tokens.get(i + 1).unwrap();
            if !((pool.token_a == from && pool.token_b == to)
                || (pool.token_b == from && pool.token_a == to))
            {
                return 0;
            }
            let Some(output) = Self::calculate_direct_swap_output_for_pool(&pool, &from, amount)
            else {
                return 0;
            };
            amount = output;
        }
        amount
    }

    /// Calculate path output
    fn calculate_path_output(env: &Env, tokens: &Vec<Address>, input_amount: i128) -> i128 {
        if tokens.len() < 2 || input_amount <= 0 {
            return 0;
        }
        let mut amount = input_amount;

        for i in 0..(tokens.len() - 1) {
            let from = tokens.get(i).unwrap();
            let to = tokens.get(i + 1).unwrap();

            amount = Self::calculate_single_swap_output(env, &from, &to, amount);
        }

        amount
    }

    /// Calculate single swap output
    fn calculate_single_swap_output(
        env: &Env,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
    ) -> i128 {
        let pools = Self::get_pools(env);

        // Find matching pool
        for (_, pool) in pools.iter() {
            if (pool.token_a == *input_token && pool.token_b == *output_token)
                || (pool.token_a == *output_token && pool.token_b == *input_token)
            {
                let (output, _) = Self::calculate_direct_swap(&pool, input_token, input_amount);
                return output;
            }
        }

        0
    }

    /// Calculate direct swap output for a specific pool
    fn calculate_direct_swap_output_for_pool(
        pool: &PoolInfo,
        input_token: &Address,
        input_amount: i128,
    ) -> Option<i128> {
        let (reserve_in, reserve_out) = if pool.token_a == *input_token {
            (pool.reserve_a, pool.reserve_b)
        } else if pool.token_b == *input_token {
            (pool.reserve_b, pool.reserve_a)
        } else {
            return None;
        };

        if input_amount <= 0
            || reserve_in <= 0
            || reserve_out <= 0
            || pool.token_a == pool.token_b
            || pool.fee_bps >= 10_000
        {
            return None;
        }
        // Constant product formula: x * y = k
        // (x + dx) * (y - dy) = k
        // dy = y * dx / (x + dx)
        let fee_multiplier = BPS_DIVISOR - pool.fee_bps as i128;
        let input_with_fee = input_amount.checked_mul(fee_multiplier)?;

        let numerator = input_with_fee.checked_mul(reserve_out)?;
        let denominator = reserve_in
            .checked_mul(BPS_DIVISOR)?
            .checked_add(input_with_fee)?;

        Some(numerator / denominator)
    }

    /// Calculate direct swap with price impact
    fn calculate_direct_swap(
        pool: &PoolInfo,
        input_token: &Address,
        input_amount: i128,
    ) -> (i128, i128) {
        let (output, price_impact) = if let Some(output) =
            Self::calculate_direct_swap_output_for_pool(pool, input_token, input_amount)
        {
            // Calculate price impact
            let (reserve_in, reserve_out) = if pool.token_a == *input_token {
                (pool.reserve_a, pool.reserve_b)
            } else {
                (pool.reserve_b, pool.reserve_a)
            };
            // Ratio against the directional spot price. Use the SDK's wide
            // integer for this diagnostic so rounding cannot produce a
            // negative impact or overflow intermediate products.
            let env = input_token.env();
            let wide = |value: i128| soroban_sdk::U256::from_u128(env, value as u128);
            let execution = wide(output).mul(&wide(reserve_in)).mul(&wide(BPS_DIVISOR));
            let spot = wide(input_amount).mul(&wide(reserve_out));
            let retained = execution
                .div(&spot)
                .to_u128()
                .unwrap()
                .min(BPS_DIVISOR as u128);
            let impact_bps = BPS_DIVISOR - retained as i128;

            (output, impact_bps)
        } else {
            (0, 0)
        };

        (output, price_impact)
    }

    /// Calculate minimum output with slippage protection
    fn calculate_minimum_output(expected: i128, slippage_bps: u32) -> i128 {
        Self::require_valid_slippage(slippage_bps);
        Self::scale_bps(expected, BPS_DIVISOR as u32 - slippage_bps)
    }

    /// Scale a nonnegative amount by at most 10,000 bps without overflow.
    fn scale_bps(amount: i128, bps: u32) -> i128 {
        (amount / BPS_DIVISOR) * i128::from(bps)
            + (amount % BPS_DIVISOR) * i128::from(bps) / BPS_DIVISOR
    }

    /// Execute pool swap
    fn execute_pool_swap(
        env: &Env,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
        _is_reverse: bool,
    ) -> i128 {
        // In production, call the actual pool contract
        // For now, return calculated amount
        Self::calculate_single_swap_output(env, input_token, output_token, input_amount)
    }

    /// Try swap and return result
    fn try_swap(
        env: &Env,
        user: &Address,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
        min_output: i128,
    ) -> Result<i128, SwapError> {
        // Find best path
        let (path, _) = Self::find_best_path(env, input_token, output_token, input_amount);
        if path.pools.is_empty() {
            return Err(SwapError::NoPoolFound);
        }

        let expected_output = Self::calculate_path_output(env, &path.tokens, input_amount);
        if expected_output < min_output {
            return Err(SwapError::SlippageExceeded);
        }

        // Execute swap
        let output = Self::swap(
            env.clone(),
            user.clone(),
            input_token.clone(),
            output_token.clone(),
            input_amount,
            min_output,
            path.tokens,
            None,
        );

        Ok(output)
    }

    /// Queue failed swap for retry
    fn queue_swap_for_retry(
        env: &Env,
        user: &Address,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
        min_output: i128,
        max_retries: u32,
    ) {
        let swap_id = Self::get_next_swap_id(env);

        let pending_swap = PendingSwap {
            swap_id,
            user: user.clone(),
            input_token: input_token.clone(),
            output_token: output_token.clone(),
            input_amount,
            min_output,
            retry_count: 0,
            max_retries,
            timestamp: env.ledger().timestamp(),
        };

        // Store pending swap
        let key = Symbol::new(env, "pending_swap");
        let mut pending: Map<u64, PendingSwap> =
            env.storage().instance().get(&key).unwrap_or(Map::new(env));

        pending.set(swap_id, pending_swap);
        env.storage().instance().set(&key, &pending);

        env.events().publish(
            ("swap_queued_for_retry",),
            (
                swap_id,
                user,
                input_token,
                output_token,
                input_amount,
                max_retries,
            ),
        );
    }

    /// Record completed swap
    fn record_swap(
        env: &Env,
        user: &Address,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
        output_amount: i128,
        path: &Vec<Address>,
        protocol_fee: i128,
        success: bool,
    ) -> u64 {
        let swap_id = Self::get_next_swap_id(env);

        let _record = SwapRecord {
            swap_id,
            user: user.clone(),
            input_token: input_token.clone(),
            output_token: output_token.clone(),
            input_amount,
            output_amount,
            path: path.clone(),
            protocol_fee,
            timestamp: env.ledger().timestamp(),
            success,
        };

        // Update protocol stats
        let total_swaps: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "total_swaps"))
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&Symbol::new(env, "total_swaps"), &(total_swaps + 1));

        let total_volume: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "total_volume"))
            .unwrap_or(0);
        env.storage().instance().set(
            &Symbol::new(env, "total_volume"),
            &(total_volume + input_amount),
        );

        let total_fees: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "total_fees"))
            .unwrap_or(0);
        env.storage().instance().set(
            &Symbol::new(env, "total_fees"),
            &(total_fees + protocol_fee),
        );

        swap_id
    }

    fn get_next_swap_id(env: &Env) -> u64 {
        let id: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "next_swap_id"))
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&Symbol::new(env, "next_swap_id"), &(id + 1));
        id
    }
}

#[cfg(test)]
#[path = "swap_router_fuzz.rs"]
mod fuzz_tests;

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_oracle_pause_blocks_update_pool_reserves() {
        let env = Env::default();
        let contract = env.register(SwapRouter, ());
        env.as_contract(&contract, || {
            let admin = Address::generate(&env);
            let treasury = Address::generate(&env);
            let xlm_token = Address::generate(&env);

            SwapRouter::initialize(env.clone(), admin.clone(), treasury, xlm_token);

            // Add a pool
            let pool_address = Address::generate(&env);
            let token_a = Address::generate(&env);
            let token_b = Address::generate(&env);
            SwapRouter::add_pool(
                env.clone(),
                admin.clone(),
                pool_address.clone(),
                token_a,
                token_b,
                30, // 0.3% fee
                false,
            );

            // Pause oracle ingestion
            SwapRouter::pause_oracle(env.clone(), admin.clone());

            // Try to update pool reserves - should fail
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                SwapRouter::update_pool_reserves(env.clone(), pool_address.clone(), 1000, 2000)
            }));
            assert!(result.is_err());

            // Unpause oracle ingestion
            SwapRouter::unpause_oracle(env.clone(), admin.clone());

            // Now update should succeed
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                SwapRouter::update_pool_reserves(env.clone(), pool_address.clone(), 1000, 2000)
            }));
            assert!(matches!(result, Ok(Ok(()))));
        });
    }

    #[test]
    fn test_oracle_pause_unpause() {
        let env = Env::default();
        let contract = env.register(SwapRouter, ());
        env.as_contract(&contract, || {
            let admin = Address::generate(&env);
            let treasury = Address::generate(&env);
            let xlm_token = Address::generate(&env);

            SwapRouter::initialize(env.clone(), admin.clone(), treasury, xlm_token);

            // Initially not paused
            assert!(!SwapRouter::is_oracle_paused(env.clone()));

            // Pause oracle
            SwapRouter::pause_oracle(env.clone(), admin.clone());
            assert!(SwapRouter::is_oracle_paused(env.clone()));

            // Unpause oracle
            SwapRouter::unpause_oracle(env.clone(), admin.clone());
            assert!(!SwapRouter::is_oracle_paused(env.clone()));
        });
    }

    #[test]
    fn test_oracle_pause_requires_admin() {
        let env = Env::default();
        let contract = env.register(SwapRouter, ());
        env.as_contract(&contract, || {
            let admin = Address::generate(&env);
            let non_admin = Address::generate(&env);
            let treasury = Address::generate(&env);
            let xlm_token = Address::generate(&env);

            SwapRouter::initialize(env.clone(), admin, treasury, xlm_token);

            // Try to pause with non-admin - should panic
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                SwapRouter::pause_oracle(env.clone(), non_admin.clone());
            }));
            assert!(result.is_err());

            // Try to unpause with non-admin - should panic
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                SwapRouter::unpause_oracle(env.clone(), non_admin.clone());
            }));
            assert!(result.is_err());
        });
    }

    fn assert_panic_contains<F>(f: F, expected: &str)
    where
        F: FnOnce() + std::panic::UnwindSafe,
    {
        let payload = std::panic::catch_unwind(f).expect_err("expected panic");
        let message = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .unwrap_or("");
        assert!(
            message.contains(expected),
            "panic message did not contain {:?}: {:?}",
            expected,
            message
        );
    }

    #[test]
    fn test_uninitialized_admin_and_treasury_are_rejected_with_clear_errors() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let input_token = Address::generate(&env);
        let output_token = Address::generate(&env);
        let path = Vec::from_array(&env, [input_token.clone(), output_token.clone()]);

        assert_panic_contains(
            || SwapRouter::pause_oracle(env.clone(), admin.clone()),
            "admin not configured",
        );

        assert_panic_contains(
            || {
                SwapRouter::swap(
                    env.clone(),
                    user,
                    input_token,
                    output_token,
                    1_000,
                    900,
                    path,
                    None,
                );
            },
            "treasury not configured",
        );
    }

    #[test]
    fn test_oracle_pause_independent_from_global_pause() {
        let env = Env::default();
        let contract = env.register(SwapRouter, ());
        env.as_contract(&contract, || {
            let admin = Address::generate(&env);
            let treasury = Address::generate(&env);
            let xlm_token = Address::generate(&env);

            SwapRouter::initialize(env.clone(), admin.clone(), treasury, xlm_token);

            // Add a pool
            let pool_address = Address::generate(&env);
            let token_a = Address::generate(&env);
            let token_b = Address::generate(&env);
            SwapRouter::add_pool(
                env.clone(),
                admin.clone(),
                pool_address.clone(),
                token_a,
                token_b,
                30,
                false,
            );

            // Pause oracle only
            SwapRouter::pause_oracle(env.clone(), admin.clone());
            assert!(SwapRouter::is_oracle_paused(env.clone()));

            // Oracle update should fail
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                SwapRouter::update_pool_reserves(env.clone(), pool_address.clone(), 1000, 2000)
            }));
            assert!(result.is_err());

            // Unpause oracle
            SwapRouter::unpause_oracle(env.clone(), admin.clone());
            assert!(!SwapRouter::is_oracle_paused(env.clone()));

            // Oracle update should now succeed
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                SwapRouter::update_pool_reserves(env.clone(), pool_address.clone(), 1000, 2000)
            }));
            assert!(matches!(result, Ok(Ok(()))));
        });
    }
}
