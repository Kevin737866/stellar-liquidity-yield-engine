use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec,
    token::TokenClient, unwrap::UnwrapOptimized,
};

/// Maximum path length for multi-hop swaps
const MAX_PATH_LENGTH: u32 = 3;

/// Maximum slippage in basis points (default 1%)
const DEFAULT_MAX_SLIPPAGE_BPS: u32 = 100;

/// Treasury fee in basis points (0.25%)
const PROTOCOL_TREASURY_FEE_BPS: u32 = 25;

/// Basis points divisor
const BPS_DIVISOR: i128 = 10000;

/// Swap path entry
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SwapPath {
    pub tokens: Vec<Address>,       // Path: [input, intermediate..., output]
    pub pools: Vec<Address>,         // Corresponding pools
    pub expected_output: i128,       // Expected output amount
    pub price_impact_bps: i128,       // Price impact in basis points
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
    pub fee_bps: u32,                // Trading fee in basis points
    pub is_stable_swap: bool,        // Stable swap pool (lower slippage)
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
    pub route_type: RouteType,       // Direct, XLM_HOP, or MULTI_HOP
}

/// Route types for analytics
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouteType {
    Direct,       // Direct pool swap
    XLMHop,       // Through XLM
    MultiHop,     // Multi-pool path
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

/// Swap router error types
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
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
        xlm_token: Address,      // Wrapped XLM address
    ) {
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage().instance().set(&Symbol::new(&env, "treasury"), &treasury);
        env.storage().instance().set(&Symbol::new(&env, "xlm_token"), &xlm_token);
        env.storage().instance().set(&Symbol::new(&env, "default_slippage"), &DEFAULT_MAX_SLIPPAGE_BPS);
        
        // Initialize swap counter
        env.storage().instance().set(&Symbol::new(&env, "next_swap_id"), &1u64);
        
        // Initialize empty pools map
        let pools: Map<Address, PoolInfo> = Map::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "pools"), &pools);
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
        
        let pool = PoolInfo {
            pool_address: pool_address.clone(),
            token_a: token_a.clone(),
            token_b: token_b.clone(),
            reserve_a: 0,
            reserve_b: 0,
            fee_bps,
            is_stable_swap,
        };
        
        let mut pools = Self::get_pools(&env);
        pools.set(pool_address, pool);
        env.storage().instance().set(&Symbol::new(&env, "pools"), &pools);
        
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
    ) {
        let mut pools = Self::get_pools(&env);
        
        if let Some(mut pool) = pools.get(&pool_address) {
            pool.reserve_a = reserve_a;
            pool.reserve_b = reserve_b;
            pools.set(pool_address, pool);
            env.storage().instance().set(&Symbol::new(&env, "pools"), &pools);
        }
    }

    /// Remove a pool (admin only)
    pub fn remove_pool(env: Env, admin: Address, pool_address: Address) {
        Self::require_admin(&env, admin);
        
        let mut pools = Self::get_pools(&env);
        pools.remove(&pool_address);
        env.storage().instance().set(&Symbol::new(&env, "pools"), &pools);
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
        require!(input_amount > 0, SwapError::InvalidPath);
        
        let slippage = max_slippage_bps.unwrap_or(DEFAULT_MAX_SLIPPAGE_BPS);
        require!(slippage <= BPS_DIVISOR as u32, SwapError::InvalidSlippage);
        
        // Find best path
        let (path, route_type) = Self::find_best_path(&env, &input_token, &output_token, input_amount);
        require!(path.tokens.len() >= 2, SwapError::NoPoolFound);
        
        // Calculate output with price impact
        let expected_output = Self::calculate_output_amount(&env, &path, input_amount);
        
        // Calculate minimum output with slippage protection
        let minimum_output = Self::calculate_minimum_output(expected_output, slippage);
        
        // Calculate protocol fee (0.25% of output)
        let protocol_fee = (expected_output * PROTOCOL_TREASURY_FEE_BPS as i128) / BPS_DIVISOR;
        
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
        let pools = Self::get_pools(&env);
        
        // Find direct pool
        for (_, pool) in pools.iter() {
            if (pool.token_a == input_token && pool.token_b == output_token) ||
               (pool.token_a == output_token && pool.token_b == input_token) {
                
                let (expected_output, price_impact) = Self::calculate_direct_swap(
                    &pool,
                    &input_token,
                    input_amount,
                );
                
                let minimum_output = Self::calculate_minimum_output(expected_output, DEFAULT_MAX_SLIPPAGE_BPS);
                let protocol_fee = (expected_output * PROTOCOL_TREASURY_FEE_BPS as i128) / BPS_DIVISOR;
                
                let path = SwapPath {
                    tokens: vec![&input_token, &output_token],
                    pools: vec![&pool.pool_address],
                    expected_output,
                    price_impact_bps: price_impact,
                };
                
                return Some(SwapQuote {
                    path,
                    input_amount,
                    minimum_output,
                    expected_output,
                    price_impact_bps: price_impact,
                    protocol_fee,
                    route_type: RouteType::Direct,
                });
            }
        }
        
        None
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
        require!(
            expected_output >= min_output,
            SwapError::SlippageExceeded
        );
        
        // Transfer input tokens from user
        let input_token_client = TokenClient::new(&env, &input_token);
        input_token_client.transfer(
            &user,
            &env.current_contract_address(),
            &input_amount,
        );
        
        // Calculate protocol fee
        let protocol_fee = (expected_output * PROTOCOL_TREASURY_FEE_BPS as i128) / BPS_DIVISOR;
        let net_output = expected_output - protocol_fee;
        
        // Execute swaps along the path
        let mut amount = input_amount;
        for i in 0..(path.len() - 1) {
            let from = path.get(i).unwrap();
            let to = path.get(i + 1).unwrap();
            
            amount = Self::execute_pool_swap(
                &env,
                from,
                to,
                amount,
                false, // is_reverse - will be calculated
            );
        }
        
        // Transfer output tokens
        let output_token_client = TokenClient::new(&env, &output_token);
        output_token_client.transfer(
            &env.current_contract_address(),
            &recipient,
            &net_output,
        );
        
        // Transfer protocol fee to treasury
        if protocol_fee > 0 {
            output_token_client.transfer(
                &env.current_contract_address(),
                &treasury,
                &protocol_fee,
            );
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
            (swap_id, &user, &input_token, &output_token, input_amount, net_output),
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
        match Self::try_swap(&env, &user, &input_token, &output_token, input_amount, min_output) {
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
        pools.values().collect()
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
        pools.get(&pool_address)
    }

    /// Get swap history for a user
    pub fn get_user_swaps(env: Env, user: Address, limit: u32) -> Vec<SwapRecord> {
        // In production, query indexed events
        // For now, return empty - history stored in events
        let records: Vec<SwapRecord> = Vec::new(&env);
        records
    }

    /// Get protocol statistics
    pub fn get_protocol_stats(env: Env) -> (u64, i128, i128) {
        let total_swaps: u64 = env.storage()
            .instance()
            .get(&Symbol::new(&env, "total_swaps"))
            .unwrap_or(0);
        let total_volume: i128 = env.storage()
            .instance()
            .get(&Symbol::new(&env, "total_volume"))
            .unwrap_or(0);
        let total_fees: i128 = env.storage()
            .instance()
            .get(&Symbol::new(&env, "total_fees"))
            .unwrap_or(0);
        
        (total_swaps, total_volume, total_fees)
    }

    // ==================== Admin Functions ====================

    /// Update default slippage (admin only)
    pub fn update_default_slippage(env: Env, admin: Address, new_slippage_bps: u32) {
        Self::require_admin(&env, admin);
        require!(new_slippage_bps <= BPS_DIVISOR as u32, SwapError::InvalidSlippage);
        env.storage().instance().set(&Symbol::new(&env, "default_slippage"), &new_slippage_bps);
    }

    /// Update treasury address (admin only)
    pub fn update_treasury(env: Env, admin: Address, new_treasury: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "treasury"), &new_treasury);
    }

    /// Pause swap router (admin only)
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause swap router (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
    }

    /// Retry failed swaps (admin only)
    pub fn retry_failed_swaps(env: Env, admin: Address) -> u32 {
        Self::require_admin(&env, admin);
        
        // In production, iterate through queued swaps
        // For now, return 0
        0
    }

    // ==================== Internal Helpers ====================

    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        require!(caller == admin, SwapError::Unauthorized);
    }

    fn require_not_paused(env: &Env) {
        let paused = env.storage()
            .instance()
            .get::<_, bool>(&Symbol::new(env, "paused"))
            .unwrap_or(false);
        require!(!paused, SwapError::Unauthorized);
    }

    fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap()
    }

    fn get_treasury(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "treasury"))
            .unwrap()
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
        if let Some(direct_path) = Self::find_direct_path(env, input_token, output_token) {
            let output = Self::calculate_direct_swap_output(&direct_path, input_amount);
            if let Some((output_amount, pools)) = output {
                return (
                    SwapPath {
                        tokens: vec![input_token, output_token],
                        pools: vec![&pools[0]],
                        expected_output: output_amount,
                        price_impact_bps: 0,
                    },
                    RouteType::Direct,
                );
            }
        }
        
        // Try XLM hop path: input -> XLM -> output
        if *input_token != xlm && *output_token != xlm {
            if let Some(xlm_path) = Self::find_xlm_hop_path(env, input_token, output_token, input_amount) {
                return (xlm_path, RouteType::XLMHop);
            }
        }
        
        // Try multi-hop paths
        if let Some(multi_path) = Self::find_multi_hop_path(env, input_token, output_token, input_amount) {
            return (multi_path, RouteType::MultiHop);
        }
        
        // No path found - return direct with zero output
        (
            SwapPath {
                tokens: vec![input_token, output_token],
                pools: Vec::new(env),
                expected_output: 0,
                price_impact_bps: 0,
            },
            RouteType::Direct,
        )
    }

    /// Find direct pool path
    fn find_direct_path(env: &Env, token_a: &Address, token_b: &Address) -> Option<PoolInfo> {
        let pools = Self::get_pools(env);
        
        for (_, pool) in pools.iter() {
            if (pool.token_a == *token_a && pool.token_b == *token_b) ||
               (pool.token_a == *token_b && pool.token_b == *token_a) {
                return Some(pool);
            }
        }
        
        None
    }

    /// Find path through XLM
    fn find_xlm_hop_path(
        env: &Env,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
    ) -> Option<SwapPath> {
        let xlm = Self::get_xlm_token(env);
        
        // Find input -> XLM pool
        let input_pool = Self::find_direct_path(env, input_token, &xlm)?;
        
        // Find XLM -> output pool
        let output_pool = Self::find_direct_path(env, &xlm, output_token)?;
        
        // Calculate output through both pools
        let first_output = Self::calculate_direct_swap_output_for_pool(
            &input_pool,
            input_token,
            input_amount,
        )?;
        
        let final_output = Self::calculate_direct_swap_output_for_pool(
            &output_pool,
            &xlm,
            first_output,
        )?;
        
        Some(SwapPath {
            tokens: vec![input_token, &xlm, output_token],
            pools: vec![&input_pool.pool_address, &output_pool.pool_address],
            expected_output: final_output,
            price_impact_bps: 0,
        })
    }

    /// Find multi-hop path (up to 3 tokens)
    fn find_multi_hop_path(
        env: &Env,
        input_token: &Address,
        output_token: &Address,
        input_amount: i128,
    ) -> Option<SwapPath> {
        let pools = Self::get_pools(env);
        let mut visited: Vec<Address> = Vec::new(env);
        visited.push_back(input_token.clone());
        
        // BFS to find path
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

    /// BFS helper for path finding
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
        
        for (_, pool) in pools.iter() {
            let next_token = if pool.token_a == *current {
                Some(pool.token_b.clone())
            } else if pool.token_b == *current {
                Some(pool.token_a.clone())
            } else {
                None
            }?;
            
            // Skip if already visited
            let mut already_visited = false;
            for v in visited.iter() {
                if v == &next_token {
                    already_visited = true;
                    break;
                }
            }
            if already_visited {
                continue;
            }
            
            // Calculate output for this leg
            let output = Self::calculate_direct_swap_output_for_pool(
                &pool,
                current,
                amount,
            )?;
            
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
                Self::bfs_find_path(env, &next_token, target, visited, output, depth + 1) {
                let mut tokens = Vec::new(env);
                for v in visited.iter() {
                    if tokens.len() < visited.len() {
                        tokens.push_back(v);
                    }
                }
                tokens.push_back(next_token);
                final_tokens.iter().skip(1).foreach(|t| tokens.push_back(t));
                
                let mut pools_list = Vec::new(env);
                pools_list.push_back(pool.pool_address);
                for p in final_pools.iter() {
                    pools_list.push_back(p);
                }
                
                return Some((tokens, pools_list, final_output));
            }
            visited.pop_back();
        }
        
        None
    }

    /// Calculate output amount for a path
    fn calculate_output_amount(
        env: &Env,
        path: &SwapPath,
        input_amount: i128,
    ) -> i128 {
        Self::calculate_path_output(env, &path.tokens, input_amount)
    }

    /// Calculate path output
    fn calculate_path_output(
        env: &Env,
        tokens: &Vec<Address>,
        input_amount: i128,
    ) -> i128 {
        let mut amount = input_amount;
        
        for i in 0..(tokens.len() - 1) {
            let from = tokens.get(i).unwrap();
            let to = tokens.get(i + 1).unwrap();
            
            amount = Self::calculate_single_swap_output(env, from, to, amount);
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
            if (pool.token_a == *input_token && pool.token_b == *output_token) ||
               (pool.token_a == *output_token && pool.token_b == *input_token) {
                
                let (output, _) = Self::calculate_direct_swap(&pool, input_token, input_amount);
                return output;
            }
        }
        
        0
    }

    /// Calculate direct swap output
    fn calculate_direct_swap_output(
        path: &SwapPath,
        input_amount: i128,
    ) -> Option<(i128, Vec<Address>)> {
        if path.pools.len() != 1 {
            return None;
        }
        
        // Simplified calculation
        Some((input_amount, path.pools.clone()))
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
        
        // Constant product formula: x * y = k
        // (x + dx) * (y - dy) = k
        // dy = y * dx / (x + dx)
        let fee_multiplier = (BPS_DIVISOR - pool.fee_bps as i128);
        let input_with_fee = input_amount * fee_multiplier;
        
        let numerator = input_with_fee * reserve_out;
        let denominator = reserve_in * BPS_DIVISOR + input_with_fee;
        
        Some(numerator / denominator)
    }

    /// Calculate direct swap with price impact
    fn calculate_direct_swap(
        pool: &PoolInfo,
        input_token: &Address,
        input_amount: i128,
    ) -> (i128, i128) {
        let (output, price_impact) = if let Some(output) = 
            Self::calculate_direct_swap_output_for_pool(pool, input_token, input_amount) {
            
            // Calculate price impact
            let spot_price = pool.reserve_b * BPS_DIVISOR / pool.reserve_a.max(1);
            let execution_price = output * BPS_DIVISOR / input_amount;
            let impact = spot_price - execution_price;
            let impact_bps = impact * BPS_DIVISOR / spot_price.max(1);
            
            (output, impact_bps)
        } else {
            (0, 0)
        };
        
        (output, price_impact)
    }

    /// Calculate minimum output with slippage protection
    fn calculate_minimum_output(expected: i128, slippage_bps: u32) -> i128 {
        let slippage_factor = BPS_DIVISOR - slippage_bps as i128;
        expected * slippage_factor / BPS_DIVISOR
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
        
        let record = SwapRecord {
            swap_id,
            user: user.clone(),
            input_token: input_token.clone(),
            output_token: output_token.clone(),
            input_amount,
            output_amount: 0,
            path: vec![input_token, output_token],
            protocol_fee: 0,
            timestamp: env.ledger().timestamp(),
            success: false,
        };
        
        // Store pending swap
        let key = Symbol::new(env, "pending_swap");
        let mut pending: Map<u64, SwapRecord> = env.storage()
            .instance()
            .get(&key)
            .unwrap_or(Map::new(env));
        
        pending.set(swap_id, record);
        env.storage().instance().set(&key, &pending);
        
        env.events().publish(
            ("swap_queued_for_retry",),
            (swap_id, user, input_token, output_token, input_amount, max_retries),
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
        
        let record = SwapRecord {
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
        let total_swaps: u64 = env.storage()
            .instance()
            .get(&Symbol::new(env, "total_swaps"))
            .unwrap_or(0);
        env.storage().instance().set(
            &Symbol::new(env, "total_swaps"),
            &(total_swaps + 1),
        );
        
        let total_volume: i128 = env.storage()
            .instance()
            .get(&Symbol::new(env, "total_volume"))
            .unwrap_or(0);
        env.storage().instance().set(
            &Symbol::new(env, "total_volume"),
            &(total_volume + input_amount),
        );
        
        let total_fees: i128 = env.storage()
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
        let id: u64 = env.storage()
            .instance()
            .get(&Symbol::new(env, "next_swap_id"))
            .unwrap_or(1);
        env.storage().instance().set(
            &Symbol::new(env, "next_swap_id"),
            &(id + 1),
        );
        id
    }
}
