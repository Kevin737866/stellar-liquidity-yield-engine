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

    // ─── Insurance Integration ────────────────────────────────────────────────

    /// One-click deposit + insurance purchase.
    ///
    /// Deposits tokens into the vault and simultaneously purchases an insurance
    /// policy covering the deposit against impermanent loss.
    /// Returns (shares_minted, policy_id).
    pub fn deposit_with_insurance(
        env: Env,
        user: Address,
        amount_a: i128,
        amount_b: i128,
        min_shares: i128,
        coverage_period: u64,
        current_price_ratio_scaled: i128,
        historical_volatility_bps: u32,
        pool_correlation_bps: u32,
        auto_renew: bool,
        insurance_contract: Address,
        reserve_token: Address,
    ) -> (i128, u64) {
        Self::require_not_paused(&env);

        // Step 1: Standard deposit
        let shares = Self::deposit(
            env.clone(),
            user.clone(),
            amount_a,
            amount_b,
            min_shares,
        );

        // Step 2: Purchase insurance covering deposit amount_a as proxy for coverage
        // The coverage amount is the value of token_a deposited (simplified)
        use crate::il_insurance::ILInsurance;
        let policy_id = ILInsurance::purchase_insurance(
            env.clone(),
            user.clone(),
            amount_a,
            coverage_period,
            current_price_ratio_scaled,
            historical_volatility_bps,
            pool_correlation_bps,
            auto_renew,
            reserve_token,
        );

        env.events().publish(
            (Symbol::new(&env, "insured_deposit"), user),
            (shares, policy_id, amount_a, coverage_period),
        );

        (shares, policy_id)
    }

    /// Returns the effective APY net of insurance premium cost.
    ///
    /// insured_apy = vault_apy - annualised_premium_cost_bps
    /// where annualised_premium_cost = (premium_bps / coverage_days) * 365
    pub fn get_insured_apy(
        env: Env,
        coverage_period_days: u32,
        premium_bps: u32,
    ) -> i32 {
        let metrics = Self::get_metrics(env);
        let vault_apy = metrics.apy as i32;

        if coverage_period_days == 0 {
            return vault_apy;
        }

        // Annualise the premium: (premium_bps / coverage_days) * 365
        let annualised_premium_bps = (premium_bps as i32 * 365) / coverage_period_days as i32;

        vault_apy - annualised_premium_bps
    }

    /// Check if a policy is eligible for auto-renewal and return the renewal premium.
    /// Auto-renewal extends coverage using harvested yield from the user's position.
    /// Returns (eligible, estimated_premium) – both zero if not eligible.
    pub fn check_auto_renewal_eligibility(
        env: Env,
        user: Address,
        min_yield_threshold: i128,
    ) -> (bool, i128) {
        let position = Self::get_user_position(env.clone(), user.clone());
        let metrics = Self::get_metrics(env);

        // Estimate accrued yield for the user's share of the vault
        if metrics.total_shares == 0 {
            return (false, 0);
        }
        let user_share_of_total = position.shares * 10000 / metrics.total_shares;
        let estimated_yield_a =
            metrics.total_amount_a * user_share_of_total / 10000 - position.deposited_amount_a;

        if estimated_yield_a >= min_yield_threshold {
            // Estimated premium for 30-day renewal at base rate (0.5%)
            let renewal_premium = position.deposited_amount_a * 50 / 10000;
            (true, renewal_premium)
        } else {
            (false, 0)
        }
    }
}
