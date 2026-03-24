use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec,
    token::TokenClient, unwrap::UnwrapOptimized, conversions::Convert,
};

/// Maximum number of concurrent reward streams supported
const MAX_REWARD_STREAMS: u32 = 10;

/// Basis points divisor (10000 = 100%)
const BASIS_POINTS_DIVISOR: i128 = 10000;

/// Treasury fee in basis points (0.25% = 25 bps)
const TREASURY_FEE_BPS: u32 = 25;

///袁 Maximum slippage in basis points (1% = 100 bps)
const MAX_SLIPPAGE_BPS: u32 = 100;

/// Reward stream configuration
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardStream {
    pub token: Address,
    pub rate_per_second: i128,      // Reward tokens per second for entire pool
    pub total_distributed: i128,    // Total tokens distributed to date
    pub last_update: u64,           // Last timestamp when rewards were updated
    pub is_active: bool,            // Whether stream is currently active
    pub decimals: u32,             // Token decimals (7 for SAC, 18 for Soroban)
}

/// User's reward debt for a specific stream (Synthetix-style)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardDebt {
    pub user: Address,
    pub stream_index: u32,
    pub reward_debt: i128,          // accumulated_reward_per_share * shares
    pub last_claim_timestamp: u64,
    pub pending_rewards: i128,      // Cached pending rewards
}

/// User's auto-compound configuration
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AutoCompoundConfig {
    pub token: Address,
    pub reinvest_percentage: u32,   // 0-10000 (0-100%)
    pub enabled: bool,
}

/// Pending swap in queue (for failed swap handling)
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingSwap {
    pub id: u64,
    pub user: Address,
    pub from_token: Address,
    pub to_token: Address,
    pub amount: i128,
    pub min_received: i128,
    pub timestamp: u64,
    pub retry_count: u32,
    pub status: SwapStatus,
}

/// Swap status enum
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SwapStatus {
    Pending,
    Processing,
    Completed,
    Failed,
    Expired,
}

/// Vault share info for reward calculation
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultShareInfo {
    pub vault: Address,
    pub total_shares: i128,
    pub share_decimals: u32,
}

/// Emergency withdrawal request
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmergencyWithdrawal {
    pub user: Address,
    pub vault: Address,
    pub shares: i128,
    pub requested_at: u64,
    pub completed: bool,
}

/// MultiRewardDistributor contract
#[contract]
pub struct MultiRewardDistributor;

/// Error types for the contract
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RewardError {
    Unauthorized = 1,
    InvalidStream = 2,
    StreamLimitExceeded = 3,
    InsufficientBalance = 4,
    Paused = 5,
    InvalidPercentage = 6,
    SwapFailed = 7,
    SlippageExceeded = 8,
    EmergencyModeActive = 9,
    InvalidVault = 10,
    AlreadyInitialized = 11,
}

#[contractimpl]
impl MultiRewardDistributor {
    /// Initialize the multi-reward distributor
    pub fn initialize(
        env: Env,
        admin: Address,
        treasury: Address,
        swap_router: Address,
    ) {
        // Check if already initialized
        let is_init: bool = env.storage()
            .instance()
            .get(&Symbol::new(&env, "initialized"))
            .unwrap_or(false);
        require!(!is_init, RewardError::AlreadyInitialized);
        
        env.storage().instance().set(&Symbol::new(&env, "initialized"), &true);
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage().instance().set(&Symbol::new(&env, "treasury"), &treasury);
        env.storage().instance().set(&Symbol::new(&env, "swap_router"), &swap_router);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
        env.storage().instance().set(&Symbol::new(&env, "emergency_mode"), &false);
        
        // Initialize empty reward streams
        let streams: Vec<RewardStream> = Vec::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "streams"), &streams);
        
        // Initialize swap queue counter
        env.storage().instance().set(&Symbol::new(&env, "next_swap_id"), &1u64);
    }

    // ==================== Admin Functions ====================

    /// Add a new reward stream (admin only)
    /// Returns the index of the new stream
    pub fn add_reward_stream(
        env: Env,
        admin: Address,
        token: Address,
        rate_per_second: i128,
        decimals: u32,
    ) -> u32 {
        Self::require_admin(&env, admin);
        Self::require_not_paused(&env);
        
        let mut streams = Self::get_streams(&env);
        require!(
            streams.len() < MAX_REWARD_STREAMS,
            RewardError::StreamLimitExceeded
        );
        
        let stream_index = streams.len();
        let current_time = env.ledger().timestamp();
        
        let new_stream = RewardStream {
            token: token.clone(),
            rate_per_second,
            total_distributed: 0,
            last_update: current_time,
            is_active: true,
            decimals,
        };
        
        streams.push_back(new_stream);
        env.storage().instance().set(&Symbol::new(&env, "streams"), &streams);
        
        // Emit event
        env.events().publish(
            ("reward_stream_added", stream_index),
            (&token, rate_per_second),
        );
        
        stream_index
    }

    /// Update reward rate for existing stream (admin only)
    pub fn update_reward_rate(
        env: Env,
        admin: Address,
        stream_index: u32,
        new_rate_per_second: i128,
    ) {
        Self::require_admin(&env, admin);
        
        let mut streams = Self::get_streams(&env);
        require!(
            stream_index < streams.len(),
            RewardError::InvalidStream
        );
        
        // Update the stream at index
        let mut stream = streams.get(stream_index).unwrap();
        stream.rate_per_second = new_rate_per_second;
        stream.last_update = env.ledger().timestamp();
        
        // Replace the stream
        streams.set(stream_index, stream);
        env.storage().instance().set(&Symbol::new(&env, "streams"), &streams);
        
        env.events().publish(
            ("reward_rate_updated", stream_index),
            new_rate_per_second,
        );
    }

    /// Deactivate a reward stream (admin only)
    pub fn deactivate_stream(
        env: Env,
        admin: Address,
        stream_index: u32,
    ) {
        Self::require_admin(&env, admin);
        
        let mut streams = Self::get_streams(&env);
        require!(
            stream_index < streams.len(),
            RewardError::InvalidStream
        );
        
        let mut stream = streams.get(stream_index).unwrap();
        stream.is_active = false;
        stream.last_update = env.ledger().timestamp();
        
        streams.set(stream_index, stream);
        env.storage().instance().set(&Symbol::new(&env, "streams"), &streams);
    }

    // ==================== Core Reward Functions ====================

    /// Update rewards for a user based on vault shares
    /// This implements the Synthetix-style reward accumulation
    /// Uses vault address as key for user shares
    pub fn update_rewards(
        env: Env,
        user: Address,
        vault: Address,
        user_shares: i128,
        vault_share_decimals: u32,
    ) -> Map<u32, i128> {
        Self::require_not_emergency(&env);
        
        let current_time = env.ledger().timestamp();
        let streams = Self::get_streams(&env);
        let mut pending_rewards: Map<u32, i128> = Map::new(&env);
        
        // Get or initialize vault info
        let mut vault_info = Self::get_vault_info(&env, &vault);
        if vault_info.total_shares == 0 {
            vault_info.total_shares = 1; // Prevent division by zero
        }
        vault_info.share_decimals = vault_share_decimals;
        Self::set_vault_info(&env, &vault, &vault_info);
        
        for i in 0..streams.len() {
            let mut stream = streams.get(i).unwrap();
            
            if !stream.is_active {
                continue;
            }
            
            // Calculate time elapsed since last update
            let time_elapsed = current_time - stream.last_update;
            
            if time_elapsed > 0 && vault_info.total_shares > 0 {
                // Calculate reward per share for this time period
                // reward_per_share_delta = rate * time_elapsed / total_shares
                let reward_delta = stream.rate_per_second * time_elapsed as i128;
                
                // Normalize to share decimals (assuming 7 or 18 decimals for tokens)
                let share_multiplier: i128 = 10_i128.pow(stream.decimals.saturating_sub(vault_share_decimals) as u32);
                let normalized_reward = reward_delta * share_multiplier;
                
                // Update stream's total distributed
                let user_share_of_pool = (user_shares * normalized_reward) / vault_info.total_shares;
                stream.total_distributed += user_share_of_pool;
                
                // Update user's reward debt
                let mut reward_debt = Self::get_user_reward_debt(&env, &user, i);
                let accumulated_delta = (vault_info.total_shares * share_multiplier) / vault_info.total_shares;
                reward_debt.reward_debt += user_shares * accumulated_delta;
                reward_debt.last_claim_timestamp = current_time;
                
                // Calculate pending rewards
                let accumulated_per_share = Self::get_accumulated_reward_per_share(&env, i);
                let user_accumulated = user_shares * accumulated_per_share / 10_i128.pow(stream.decimals);
                reward_debt.pending_rewards = user_accumulated - reward_debt.reward_debt;
                
                Self::set_user_reward_debt(&env, &user, i, &reward_debt);
                
                // Update stream
                stream.last_update = current_time;
                streams.set(i, stream);
                
                pending_rewards.set(i, reward_debt.pending_rewards);
            }
        }
        
        env.storage().instance().set(&Symbol::new(&env, "streams"), &streams);
        
        pending_rewards
    }

    /// Claim rewards for specific streams
    /// convert_to: optional token address to swap rewards into (None = claim in original tokens)
    pub fn claim_rewards(
        env: Env,
        user: Address,
        vault: Address,
        stream_indices: Vec<u32>,
        convert_to: Option<Address>,
    ) -> Map<Address, i128> {
        Self::require_not_emergency(&env);
        Self::require_not_paused(&env);
        
        let current_time = env.ledger().timestamp();
        let streams = Self::get_streams(&env);
        let treasury = Self::get_treasury(&env);
        let swap_router = Self::get_swap_router(&env);
        
        let mut claimed_amounts: Map<Address, i128> = Map::new(&env);
        let mut total_by_token: Map<Address, i128> = Map::new(&env);
        
        for idx in 0..stream_indices.len() {
            let stream_index = stream_indices.get(idx).unwrap();
            require!(
                stream_index < streams.len(),
                RewardError::InvalidStream
            );
            
            let stream = streams.get(stream_index).unwrap();
            let mut reward_debt = Self::get_user_reward_debt(&env, &user, stream_index);
            
            let pending = reward_debt.pending_rewards;
            require!(pending > 0, "no pending rewards");
            
            // Calculate treasury fee (0.25%)
            let treasury_fee = (pending * TREASURY_FEE_BPS as i128) / BASIS_POINTS_DIVISOR;
            let net_reward = pending - treasury_fee;
            
            // Transfer net reward to user
            let token_client = TokenClient::new(&env, &stream.token);
            let contract_address = env.current_contract_address();
            
            // Check contract balance
            let contract_balance = token_client.balance(&contract_address);
            require!(
                contract_balance >= pending,
                RewardError::InsufficientBalance
            );
            
            // Transfer to user
            token_client.transfer(&contract_address, &user, &net_reward);
            
            // Transfer treasury fee
            if treasury_fee > 0 {
                token_client.transfer(&contract_address, &treasury, &treasury_fee);
            }
            
            // Update reward debt
            reward_debt.pending_rewards = 0;
            reward_debt.last_claim_timestamp = current_time;
            Self::set_user_reward_debt(&env, &user, stream_index, &reward_debt);
            
            // Handle conversion if requested
            if let Some(target_token) = &convert_to {
                if *target_token != stream.token {
                    // Queue swap via swap router
                    let min_received = Self::calculate_min_received(
                        net_reward,
                        &stream.token,
                        target_token,
                        MAX_SLIPPAGE_BPS,
                    );
                    
                    let swap_success = Self::execute_swap(
                        &env,
                        &swap_router,
                        &user,
                        &stream.token,
                        target_token,
                        net_reward,
                        min_received,
                    );
                    
                    if !swap_success {
                        // Queue failed swap for retry
                        Self::queue_failed_swap(
                            &env,
                            &user,
                            &stream.token,
                            target_token,
                            net_reward,
                            min_received,
                        );
                    }
                }
            }
            
            // Update claimed amounts
            let current = total_by_token.get(&stream.token).unwrap_or(0);
            total_by_token.set(stream.token.clone(), current + net_reward);
        }
        
        claimed_amounts
    }

    /// Emergency withdrawal - allows user to exit vault even if reward contracts are frozen
    /// This is a safety mechanism that bypasses normal reward claims
    pub fn emergency_withdraw(
        env: Env,
        user: Address,
        vault: Address,
        shares: i128,
    ) {
        // Emergency withdrawal works even in emergency mode
        // It does NOT claim any pending rewards
        
        let current_time = env.ledger().timestamp();
        
        let withdrawal = EmergencyWithdrawal {
            user: user.clone(),
            vault: vault.clone(),
            shares,
            requested_at: current_time,
            completed: false,
        };
        
        // Store emergency withdrawal request
        let key = Self::generate_withdrawal_key(&user, &vault);
        env.storage().instance().set(&Symbol::new(&env, &key), &withdrawal);
        
        // Emit emergency withdrawal event
        env.events().publish(
            ("emergency_withdrawal_requested",),
            (&user, &vault, shares),
        );
    }

    /// Complete emergency withdrawal (called by vault)
    pub fn complete_emergency_withdrawal(
        env: Env,
        user: Address,
        vault: Address,
    ) {
        let key = Self::generate_withdrawal_key(&user, &vault);
        let mut withdrawal: EmergencyWithdrawal = env.storage()
            .instance()
            .get(&Symbol::new(&env, &key))
            .unwrap();
        
        require!(!withdrawal.completed, "already completed");
        
        withdrawal.completed = true;
        env.storage().instance().set(&Symbol::new(&env, &key), &withdrawal);
        
        env.events().publish(
            ("emergency_withdrawal_completed",),
            (&user, &vault),
        );
    }

    // ==================== Auto-Compound Functions ====================

    /// Set auto-compound configuration for a user
    pub fn set_auto_compound_config(
        env: Env,
        user: Address,
        token: Address,
        reinvest_percentage: u32,
        enabled: bool,
    ) {
        require!(
            reinvest_percentage <= BASIS_POINTS_DIVISOR as u32,
            RewardError::InvalidPercentage
        );
        
        let config = AutoCompoundConfig {
            token: token.clone(),
            reinvest_percentage,
            enabled,
        };
        
        Self::set_auto_compound_config_for_user(&env, &user, &token, &config);
        
        env.events().publish(
            ("auto_compound_config_updated",),
            (&user, &token, reinvest_percentage, enabled),
        );
    }

    /// Get auto-compound configuration for a user and token
    pub fn get_auto_compound_config(
        env: Env,
        user: Address,
        token: Address,
    ) -> AutoCompoundConfig {
        Self::get_auto_compound_config_for_user(&env, &user, &token)
    }

    /// Execute auto-compound for a user
    /// Reinvests specified percentage, claims rest
    pub fn execute_auto_compound(
        env: Env,
        user: Address,
        vault: Address,
        stream_indices: Vec<u32>,
    ) -> Map<Address, i128> {
        Self::require_not_emergency(&env);
        
        let streams = Self::get_streams(&env);
        let mut reinvest_amounts: Map<Address, i128> = Map::new(&env);
        let mut claim_amounts: Map<Address, i128> = Map::new(&env);
        
        for idx in 0..stream_indices.len() {
            let stream_index = stream_indices.get(idx).unwrap();
            let stream = streams.get(stream_index).unwrap();
            
            let config = Self::get_auto_compound_config_for_user(&env, &user, &stream.token);
            
            if !config.enabled {
                continue;
            }
            
            let reward_debt = Self::get_user_reward_debt(&env, &user, stream_index);
            let pending = reward_debt.pending_rewards;
            
            if pending <= 0 {
                continue;
            }
            
            let to_reinvest = (pending * config.reinvest_percentage as i128) / BASIS_POINTS_DIVISOR;
            let to_claim = pending - to_reinvest;
            
            if to_reinvest > 0 {
                let current = reinvest_amounts.get(&stream.token).unwrap_or(0);
                reinvest_amounts.set(stream.token.clone(), current + to_reinvest);
            }
            
            if to_claim > 0 {
                let current = claim_amounts.get(&stream.token).unwrap_or(0);
                claim_amounts.set(stream.token.clone(), current + to_claim);
            }
        }
        
        // Execute claims for non-reinvested amounts
        if !claim_amounts.is_empty() {
            let indices_to_claim: Vec<u32> = stream_indices;
            Self::claim_rewards(env.clone(), user.clone(), vault.clone(), indices_to_claim, None);
        }
        
        // Return reinvest amounts for vault to handle
        reinvest_amounts
    }

    // ==================== Query Functions ====================

    /// Get all reward streams
    pub fn get_all_streams(env: Env) -> Vec<RewardStream> {
        Self::get_streams(&env)
    }

    /// Get stream info by index
    pub fn get_stream(env: Env, stream_index: u32) -> RewardStream {
        let streams = Self::get_streams(&env);
        require!(
            stream_index < streams.len(),
            RewardError::InvalidStream
        );
        streams.get(stream_index).unwrap()
    }

    /// Get pending rewards for a user
    pub fn get_pending_rewards(
        env: Env,
        user: Address,
        stream_indices: Vec<u32>,
    ) -> Map<u32, i128> {
        let streams = Self::get_streams(&env);
        let mut pending: Map<u32, i128> = Map::new(&env);
        
        for idx in 0..stream_indices.len() {
            let stream_index = stream_indices.get(idx).unwrap();
            if stream_index < streams.len() {
                let reward_debt = Self::get_user_reward_debt(&env, &user, stream_index);
                pending.set(stream_index, reward_debt.pending_rewards);
            }
        }
        
        pending
    }

    /// Get total pending rewards across all streams with USD valuation
    /// Note: USD prices should be provided off-chain or via oracle
    pub fn get_pending_rewards_with_usd(
        env: Env,
        user: Address,
        vault: Address,
        user_shares: i128,
        prices: Map<Address, i128>, // token -> USD price with 8 decimals
    ) -> (Map<Address, i128>, Map<Address, i128>, i128) {
        let streams = Self::get_streams(&env);
        let mut amounts: Map<Address, i128> = Map::new(&env);
        let mut usd_values: Map<Address, i128> = Map::new(&env);
        let mut total_usd: i128 = 0;
        
        for i in 0..streams.len() {
            let stream = streams.get(i).unwrap();
            let reward_debt = Self::get_user_reward_debt(&env, &user, i);
            let pending = reward_debt.pending_rewards;
            
            if pending > 0 {
                amounts.set(stream.token.clone(), pending);
                
                let price = prices.get(&stream.token).unwrap_or(0);
                let usd_value = Self::normalize_usd_value(pending, stream.decimals, price);
                usd_values.set(stream.token.clone(), usd_value);
                total_usd += usd_value;
            }
        }
        
        (amounts, usd_values, total_usd)
    }

    /// Get reward history for a user (stored off-chain in production)
    /// Returns cached summary for on-chain queries
    pub fn get_reward_history_summary(
        env: Env,
        user: Address,
        limit: u32,
    ) -> Vec<(u64, Address, i128)> {
        // In production, this would query off-chain storage
        // For now, return empty vec - history stored in events
        Vec::new(&env)
    }

    // ==================== Admin/Controls ====================

    /// Pause the contract (admin only)
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause the contract (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
    }

    /// Enable emergency mode (admin only)
    pub fn enable_emergency_mode(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "emergency_mode"), &true);
        
        env.events().publish(
            ("emergency_mode_enabled",),
            (),
        );
    }

    /// Disable emergency mode (admin only)
    pub fn disable_emergency_mode(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "emergency_mode"), &false);
        
        env.events().publish(
            ("emergency_mode_disabled",),
            (),
        );
    }

    /// Fund reward pool (deposit tokens for distribution)
    pub fn fund_reward_pool(
        env: Env,
        admin: Address,
        token: Address,
        amount: i128,
    ) {
        Self::require_admin(&env, admin);
        
        // Transfer tokens from admin to contract
        let token_client = TokenClient::new(&env, &token);
        token_client.transfer(&admin, &env.current_contract_address(), &amount);
        
        // Update pool balance
        let key = Symbol::new(&env, "pool_balance");
        let mut pool_balances: Map<Address, i128> = env.storage()
            .instance()
            .get(&key)
            .unwrap_or(Map::new(&env));
        
        let current = pool_balances.get(&token).unwrap_or(0);
        pool_balances.set(token, current + amount);
        env.storage().instance().set(&key, &pool_balances);
    }

    /// Retry failed swaps
    pub fn retry_failed_swaps(env: Env, admin: Address, max_retries: u32) -> u32 {
        Self::require_admin(&env, admin);
        
        let swap_router = Self::get_swap_router(&env);
        let mut retried = 0u32;
        
        // In production, iterate through pending swaps
        // For now, simplified implementation
        let pending_swaps: Vec<PendingSwap> = Vec::new(&env);
        
        for idx in 0..pending_swaps.len() {
            let mut swap = pending_swaps.get(idx).unwrap();
            
            if swap.retry_count >= max_retries {
                continue;
            }
            
            swap.retry_count += 1;
            swap.status = SwapStatus::Processing;
            
            // Attempt swap again
            let success = Self::execute_swap(
                &env,
                &swap_router,
                &swap.user,
                &swap.from_token,
                &swap.to_token,
                swap.amount,
                swap.min_received,
            );
            
            if success {
                swap.status = SwapStatus::Completed;
                retried += 1;
            } else {
                swap.status = SwapStatus::Failed;
            }
        }
        
        retried
    }

    /// Get contract state
    pub fn get_state(env: Env) -> (bool, bool, u32, Address) {
        let paused = Self::is_paused(&env);
        let emergency = Self::is_emergency(&env);
        let streams = Self::get_streams(&env);
        let admin = Self::get_admin(&env);
        
        (paused, emergency, streams.len(), admin)
    }

    // ==================== Internal Helpers ====================

    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        require!(caller == admin, RewardError::Unauthorized);
    }

    fn require_not_paused(env: &Env) {
        require!(!Self::is_paused(env.clone()), RewardError::Paused);
    }

    fn require_not_emergency(env: &Env) {
        require!(!Self::is_emergency(env.clone()), RewardError::EmergencyModeActive);
    }

    fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap()
    }

    fn get_treasury(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "treasury"))
            .unwrap()
    }

    fn get_swap_router(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "swap_router"))
            .unwrap()
    }

    fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }

    fn is_emergency(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "emergency_mode"))
            .unwrap_or(false)
    }

    fn get_streams(env: &Env) -> Vec<RewardStream> {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "streams"))
            .unwrap_or(Vec::new(env))
    }

    fn get_vault_info(env: &Env, vault: &Address) -> VaultShareInfo {
        env.storage()
            .instance()
            .get(&Symbol::new(env, &Self::vault_key(vault)))
            .unwrap_or(VaultShareInfo {
                vault: vault.clone(),
                total_shares: 0,
                share_decimals: 7,
            })
    }

    fn set_vault_info(env: &Env, vault: &Address, info: &VaultShareInfo) {
        env.storage()
            .instance()
            .set(&Symbol::new(env, &Self::vault_key(vault)), info);
    }

    fn vault_key(vault: &Address) -> Vec<u8> {
        let mut key = Vec::new(vault);
        key.extend_from_slice(b"vault_info");
        key
    }

    fn get_user_reward_debt(env: &Env, user: &Address, stream_index: u32) -> UserRewardDebt {
        let key = Self::reward_debt_key(user, stream_index);
        env.storage()
            .instance()
            .get(&Symbol::new(env, &key))
            .unwrap_or(UserRewardDebt {
                user: user.clone(),
                stream_index,
                reward_debt: 0,
                last_claim_timestamp: 0,
                pending_rewards: 0,
            })
    }

    fn set_user_reward_debt(env: &Env, user: &Address, stream_index: u32, debt: &UserRewardDebt) {
        let key = Self::reward_debt_key(user, stream_index);
        env.storage()
            .instance()
            .set(&Symbol::new(env, &key), debt);
    }

    fn reward_debt_key(user: &Address, stream_index: u32) -> Vec<u8> {
        let mut key = Vec::new(user);
        key.extend_from_slice(b"reward_debt_");
        // Add stream index bytes
        let idx_bytes: Vec<u8> = stream_index.to_be_bytes().to_vec();
        key.extend_from_slice(&idx_bytes);
        key
    }

    fn get_accumulated_reward_per_share(env: &Env, stream_index: u32) -> i128 {
        let streams = Self::get_streams(env);
        if stream_index >= streams.len() {
            return 0;
        }
        
        let stream = streams.get(stream_index).unwrap();
        let current_time = env.ledger().timestamp();
        let time_elapsed = current_time.saturating_sub(stream.last_update);
        
        if time_elapsed > 0 && stream.is_active {
            // Return accumulated amount based on rate
            stream.rate_per_second * time_elapsed as i128
        } else {
            stream.total_distributed
        }
    }

    fn get_auto_compound_config_for_user(
        env: &Env,
        user: &Address,
        token: &Address,
    ) -> AutoCompoundConfig {
        let key = Self::auto_compound_key(user, token);
        env.storage()
            .instance()
            .get(&Symbol::new(env, &key))
            .unwrap_or(AutoCompoundConfig {
                token: token.clone(),
                reinvest_percentage: 0,
                enabled: false,
            })
    }

    fn set_auto_compound_config_for_user(
        env: &Env,
        user: &Address,
        token: &Address,
        config: &AutoCompoundConfig,
    ) {
        let key = Self::auto_compound_key(user, token);
        env.storage()
            .instance()
            .set(&Symbol::new(env, &key), config);
    }

    fn auto_compound_key(user: &Address, token: &Address) -> Vec<u8> {
        let mut key = Vec::new(user);
        key.extend_from_slice(b"auto_compound_");
        key.extend_from_slice(&token.to_string().into_bytes());
        key
    }

    fn calculate_min_received(
        amount: i128,
        from_token: &Address,
        to_token: &Address,
        max_slippage_bps: u32,
    ) -> i128 {
        // In production, query DEX for expected output
        // Apply slippage protection
        let slippage_factor = (BASIS_POINTS_DIVISOR - max_slippage_bps as i128) as i128;
        amount * slippage_factor / BASIS_POINTS_DIVISOR
    }

    fn execute_swap(
        env: &Env,
        swap_router: &Address,
        user: &Address,
        from_token: &Address,
        to_token: &Address,
        amount: i128,
        min_received: i128,
    ) -> bool {
        // In production, call swap router contract
        // For now, return true (successful swap)
        // The swap router would:
        // 1. Transfer tokens from this contract to router
        // 2. Execute swap on Stellar DEX
        // 3. Transfer output tokens to user
        // 4. Handle any failures
        
        // Emit swap event
        env.events().publish(
            ("swap_executed",),
            (user, from_token, to_token, amount, min_received),
        );
        
        true
    }

    fn queue_failed_swap(
        env: &Env,
        user: &Address,
        from_token: &Address,
        to_token: &Address,
        amount: i128,
        min_received: i128,
    ) {
        let swap_id = Self::get_next_swap_id(env);
        
        let pending_swap = PendingSwap {
            id: swap_id,
            user: user.clone(),
            from_token: from_token.clone(),
            to_token: to_token.clone(),
            amount,
            min_received,
            timestamp: env.ledger().timestamp(),
            retry_count: 0,
            status: SwapStatus::Failed,
        };
        
        let key = Symbol::new(env, "pending_swap");
        let mut swaps: Map<u64, PendingSwap> = env.storage()
            .instance()
            .get(&key)
            .unwrap_or(Map::new(env));
        
        swaps.set(swap_id, pending_swap);
        env.storage().instance().set(&key, &swaps);
        
        env.events().publish(
            ("swap_queued_for_retry",),
            (swap_id, user, from_token, to_token, amount),
        );
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

    fn normalize_usd_value(amount: i128, decimals: u32, price: i128) -> i128 {
        // amount * price / 10^decimals
        // Example: 1000000 USDC (6 decimals) * $1.00 (8 decimals) / 10^6 = $1.00 * 10^8 / 10^6 = $100
        let divisor: i128 = 10_i128.pow(decimals);
        amount * price / divisor
    }

    fn generate_withdrawal_key(user: &Address, vault: &Address) -> Vec<u8> {
        let mut key = Vec::new(user);
        key.extend_from_slice(b"emergency_");
        key.extend_from_slice(&vault.to_string().into_bytes());
        key
    }
}
