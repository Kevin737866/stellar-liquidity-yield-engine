use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec, 
    token::TokenClient, unwrap::UnwrapOptimized
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultInfo {
    pub name: Symbol,
    pub token_a: Address,
    pub token_b: Address,
    pub pool_id: Address,
    pub strategy_id: u32,
    pub fee_rate: u32, // Basis points (100 = 1%)
    pub harvest_fee: u32, // Basis points
    pub withdrawal_fee: u32, // Basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserPosition {
    pub shares: i128,
    pub last_harvest: u64,
    pub deposited_amount_a: i128,
    pub deposited_amount_b: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ApyHistory {
    pub data: Vec<u64>,
    pub head: u32,
    pub last_update: u64,
    pub cached_twap_7d: u32,
    pub cached_twap_30d: u32,
    pub cached_twap_90d: u32,
    pub ema_projected: u32,
    pub volatility: u32,
    pub is_frozen: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultMetrics {
    pub total_shares: i128,
    pub total_amount_a: i128,
    pub total_amount_b: i128,
    pub apy: u32, // Basis points
    pub tvl: i128, // Total Value Locked in USD (scaled)
    pub last_harvest: u64,
}

#[contract]
pub struct YieldVault;

#[contractimpl]
impl YieldVault {
    /// Initialize a new yield vault
    pub fn initialize(
        env: Env,
        admin: Address,
        name: Symbol,
        token_a: Address,
        token_b: Address,
        pool_id: Address,
        strategy_id: u32,
        fee_rate: u32,
        harvest_fee: u32,
        withdrawal_fee: u32,
    ) {
        let vault_info = VaultInfo {
            name,
            token_a,
            token_b,
            pool_id,
            strategy_id,
            fee_rate,
            harvest_fee,
            withdrawal_fee,
        };

        env.storage().instance().set(&Symbol::new(&env, "vault_info"), &vault_info);
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);

        // Initialize metrics
        let metrics = VaultMetrics {
            total_shares: 0,
            total_amount_a: 0,
            total_amount_b: 0,
            apy: 0,
            tvl: 0,
            last_harvest: env.ledger().timestamp(),
        };
        env.storage().instance().set(&Symbol::new(&env, "metrics"), &metrics);

        // Initialize APY History
        let apy_history = ApyHistory {
            data: Vec::new(&env),
            head: 0,
            last_update: env.ledger().timestamp(),
            cached_twap_7d: 0,
            cached_twap_30d: 0,
            cached_twap_90d: 0,
            ema_projected: 0,
            volatility: 0,
            is_frozen: false,
        };
        env.storage().instance().set(&Symbol::new(&env, "apy_history"), &apy_history);
    }

    /// Deposit tokens into the vault
    pub fn deposit(
        env: Env,
        user: Address,
        amount_a: i128,
        amount_b: i128,
        min_shares: i128,
    ) -> i128 {
        Self::require_not_paused(&env);
        
        let vault_info = Self::get_vault_info(&env);
        let mut metrics = Self::get_metrics(&env);

        // Transfer tokens from user to vault
        let token_a_client = TokenClient::new(&env, &vault_info.token_a);
        let token_b_client = TokenClient::new(&env, &vault_info.token_b);
        
        token_a_client.transfer(&user, &env.current_contract_address(), &amount_a);
        token_b_client.transfer(&user, &env.current_contract_address(), &amount_b);

        // Calculate shares based on current ratio
        let shares = if metrics.total_shares == 0 {
            // First deposit - 1:1 ratio
            amount_a.min(amount_b)
        } else {
            // Calculate proportional shares
            let share_ratio = amount_a * metrics.total_shares / metrics.total_amount_a;
            share_ratio
        };

        require!(shares >= min_shares, "insufficient shares received");

        // Update user position
        let mut position = Self::get_user_position(&env, &user);
        position.shares += shares;
        position.deposited_amount_a += amount_a;
        position.deposited_amount_b += amount_b;
        position.last_harvest = env.ledger().timestamp();
        
        env.storage().instance().set(&Symbol::new(&env, &user), &position);

        // Update vault metrics
        metrics.total_shares += shares;
        metrics.total_amount_a += amount_a;
        metrics.total_amount_b += amount_b;
        env.storage().instance().set(&Symbol::new(&env, "metrics"), &metrics);

        shares
    }

    /// Withdraw tokens from the vault
    pub fn withdraw(
        env: Env,
        user: Address,
        shares: i128,
        min_amount_a: i128,
        min_amount_b: i128,
    ) -> (i128, i128) {
        Self::require_not_paused(&env);
        
        let vault_info = Self::get_vault_info(&env);
        let mut metrics = Self::get_metrics(&env);
        let mut position = Self::get_user_position(&env, &user);

        require!(position.shares >= shares, "insufficient shares");

        // Calculate withdrawal amounts
        let withdraw_amount_a = shares * metrics.total_amount_a / metrics.total_shares;
        let withdraw_amount_b = shares * metrics.total_amount_b / metrics.total_shares;

        // Apply withdrawal fee
        let fee_amount_a = withdraw_amount_a * vault_info.withdrawal_fee as i128 / 10000;
        let fee_amount_b = withdraw_amount_b * vault_info.withdrawal_fee as i128 / 10000;
        
        let final_amount_a = withdraw_amount_a - fee_amount_a;
        let final_amount_b = withdraw_amount_b - fee_amount_b;

        require!(final_amount_a >= min_amount_a, "insufficient amount A");
        require!(final_amount_b >= min_amount_b, "insufficient amount B");

        // Update user position
        position.shares -= shares;
        position.deposited_amount_a -= withdraw_amount_a;
        position.deposited_amount_b -= withdraw_amount_b;
        env.storage().instance().set(&Symbol::new(&env, &user), &position);

        // Update vault metrics
        metrics.total_shares -= shares;
        metrics.total_amount_a -= withdraw_amount_a;
        metrics.total_amount_b -= withdraw_amount_b;
        env.storage().instance().set(&Symbol::new(&env, "metrics"), &metrics);

        // Transfer tokens to user
        let token_a_client = TokenClient::new(&env, &vault_info.token_a);
        let token_b_client = TokenClient::new(&env, &vault_info.token_b);
        
        token_a_client.transfer(&env.current_contract_address(), &user, &final_amount_a);
        token_b_client.transfer(&env.current_contract_address(), &user, &final_amount_b);

        (final_amount_a, final_amount_b)
    }

    /// Auto-compound harvest and reinvestment
    pub fn harvest(env: Env, caller: Address) {
        Self::require_not_paused(&env);
        
        let vault_info = Self::get_vault_info(&env);
        let mut metrics = Self::get_metrics(&env);

        // Claim rewards from AMM pool (simplified - would call AMM contract)
        // This is a placeholder for actual reward claiming logic
        let rewards_a = Self::calculate_pending_rewards(&env, &vault_info.pool_id);
        let rewards_b = Self::calculate_pending_rewards(&env, &vault_info.pool_id);

        if rewards_a > 0 || rewards_b > 0 {
            // Apply harvest fee
            let fee_a = rewards_a * vault_info.harvest_fee as i128 / 10000;
            let fee_b = rewards_b * vault_info.harvest_fee as i128 / 10000;
            
            let net_rewards_a = rewards_a - fee_a;
            let net_rewards_b = rewards_b - fee_b;

            // Reinvest rewards
            metrics.total_amount_a += net_rewards_a;
            metrics.total_amount_b += net_rewards_b;
            metrics.last_harvest = env.ledger().timestamp();
            
            env.storage().instance().set(&Symbol::new(&env, "metrics"), &metrics);

            // Transfer fees to admin
            if fee_a > 0 || fee_b > 0 {
                let admin = Self::get_admin(&env);
                let token_a_client = TokenClient::new(&env, &vault_info.token_a);
                let token_b_client = TokenClient::new(&env, &vault_info.token_b);
                
                if fee_a > 0 {
                    token_a_client.transfer(&env.current_contract_address(), &admin, &fee_a);
                }
                if fee_b > 0 {
                    token_b_client.transfer(&env.current_contract_address(), &admin, &fee_b);
                }
            }
        }
    }

    /// Get vault information
    pub fn get_vault_info(env: Env) -> VaultInfo {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "vault_info"))
            .unwrap_optimized()
    }

    /// Get vault metrics
    pub fn get_metrics(env: Env) -> VaultMetrics {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "metrics"))
            .unwrap_optimized()
    }

    /// Get user position
    pub fn get_user_position(env: Env, user: Address) -> UserPosition {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, &user))
            .unwrap_or(UserPosition {
                shares: 0,
                last_harvest: 0,
                deposited_amount_a: 0,
                deposited_amount_b: 0,
            })
    }

    /// Get APY for the vault
    pub fn get_apy(env: Env) -> u32 {
        let metrics = Self::get_metrics(env);
        metrics.apy
    }

    /// Get projected annual yield using EMA
    pub fn get_projected_annual_yield(env: Env) -> u32 {
        let history: ApyHistory = env.storage().instance().get(&Symbol::new(&env, "apy_history")).unwrap_optimized();
        history.ema_projected
    }

    /// Update APY history (can be called by keeper or admin)
    pub fn update_apy(env: Env, new_apy_bps: u32, volume: u16) {
        let mut history: ApyHistory = env.storage().instance().get(&Symbol::new(&env, "apy_history")).unwrap_optimized();
        if history.is_frozen {
            panic!("oracle is frozen due to manipulation detection");
        }

        let timestamp = env.ledger().timestamp() as u32;
        
        // Oracle manipulation detection: >50% spike in 1 hour
        let last_apy = history.ema_projected; 
        if last_apy > 0 {
            let max_allowed = last_apy + (last_apy / 2);
            if new_apy_bps > max_allowed {
                history.is_frozen = true;
                env.storage().instance().set(&Symbol::new(&env, "apy_history"), &history);
                panic!("emergency freeze: APY spike > 50%");
            }
        }

        // Pack data
        let timestamp_u64 = (timestamp as u64) << 32;
        let apy_u64 = (new_apy_bps as u64) << 16;
        let volume_u64 = volume as u64;
        let packed = timestamp_u64 | apy_u64 | volume_u64;

        let len = history.data.len();
        if len < 2160 {
            history.data.push_back(packed);
            history.head = history.data.len();
        } else {
            history.data.set(history.head % 2160, packed);
            history.head = (history.head + 1) % 2160;
        }

        history.last_update = timestamp as u64;
        
        Self::recalculate_metrics(&env, &mut history, new_apy_bps);

        env.storage().instance().set(&Symbol::new(&env, "apy_history"), &history);
        
        let mut metrics = Self::get_metrics(env.clone());
        metrics.apy = history.ema_projected;
        env.storage().instance().set(&Symbol::new(&env, "metrics"), &metrics);
    }

    fn recalculate_metrics(_env: &Env, history: &mut ApyHistory, current_apy: u32) {
        let len = history.data.len();
        if len == 0 { return; }

        let mut sum_7d: u128 = 0;
        let mut count_7d: u32 = 0;
        let mut sum_30d: u128 = 0;
        let mut count_30d: u32 = 0;
        let mut sum_90d: u128 = 0;
        let mut count_90d: u32 = 0;

        for i in 0..len {
            let idx = if history.head > i {
                history.head - 1 - i
            } else {
                len - 1 - (i - history.head)
            };
            let val = history.data.get(idx).unwrap();
            let apy = ((val >> 16) & 0xFFFF) as u32;

            if i < 168 { sum_7d += apy as u128; count_7d += 1; }
            if i < 720 { sum_30d += apy as u128; count_30d += 1; }
            if i < 2160 { sum_90d += apy as u128; count_90d += 1; }
        }

        history.cached_twap_7d = if count_7d > 0 { (sum_7d / count_7d as u128) as u32 } else { 0 };
        history.cached_twap_30d = if count_30d > 0 { (sum_30d / count_30d as u128) as u32 } else { 0 };
        history.cached_twap_90d = if count_90d > 0 { (sum_90d / count_90d as u128) as u32 } else { 0 };

        if history.ema_projected == 0 {
            history.ema_projected = current_apy;
        } else {
            let alpha = 200; // 0.02 * 10000 -> N ~ 99 hours
            let new_ema = (current_apy as u128 * alpha + history.ema_projected as u128 * (10000 - alpha)) / 10000;
            history.ema_projected = new_ema as u32;
        }

        let mean = history.cached_twap_7d;
        let mut variance_sum: u128 = 0;
        for i in 0..count_7d {
            let idx = if history.head > i { history.head - 1 - i } else { len - 1 - (i - history.head) };
            let val = history.data.get(idx).unwrap();
            let apy = ((val >> 16) & 0xFFFF) as u32;
            let diff = if apy > mean { apy - mean } else { mean - apy };
            variance_sum += (diff as u128) * (diff as u128);
        }
        
        let variance = if count_7d > 0 { variance_sum / count_7d as u128 } else { 0 };
        history.volatility = Self::integer_sqrt(variance) as u32;
    }

    fn integer_sqrt(mut n: u128) -> u128 {
        if n == 0 { return 0; }
        let mut x0 = n / 2;
        if x0 != 0 {
            let mut x1 = (x0 + n / x0) / 2;
            while x1 < x0 {
                x0 = x1;
                x1 = (x0 + n / x0) / 2;
            }
            x0
        } else {
            n
        }
    }

    /// Get TVL for the vault
    pub fn get_tvl(env: Env) -> i128 {
        let metrics = Self::get_metrics(env);
        metrics.tvl
    }

    /// Calculate pending rewards (placeholder)
    fn calculate_pending_rewards(env: &Env, pool_id: &Address) -> i128 {
        // This would integrate with Stellar AMM to calculate actual rewards
        // For now, return a simulated value
        1000i128
    }

    /// Get admin address
    fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_optimized()
    }

    /// Check if vault is paused
    fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }

    /// Require vault not paused
    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            panic!("vault is paused");
        }
    }

    /// Pause vault (admin only)
    pub fn pause(env: Env, admin: Address) {
        let current_admin = Self::get_admin(env.clone());
        require!(admin == current_admin, "unauthorized");
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause vault (admin only)
    pub fn unpause(env: Env, admin: Address) {
        let current_admin = Self::get_admin(env.clone());
        require!(admin == current_admin, "unauthorized");
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
    }
}
