use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Symbol,
    token::TokenClient, unwrap::UnwrapOptimized,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultInfo {
    pub name: Symbol,
    pub token_a: Address,
    pub token_b: Address,
    pub pool_id: Address,
    pub strategy_id: u32,
    pub fee_rate: u32, // Basis points (100 = 1%) - performance fee on realized gains
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
        treasury: Address,
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
        env.storage().instance().set(&Symbol::new(&env, "treasury"), &treasury);
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

        let vault_info = Self::get_vault_info(env.clone());
        let mut metrics = Self::get_metrics(env.clone());

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

        if shares < min_shares {
            panic!("insufficient shares received");
        }

        // Update user position
        let mut position = Self::get_user_position(env.clone(), user.clone());
        position.shares += shares;
        position.deposited_amount_a += amount_a;
        position.deposited_amount_b += amount_b;
        position.last_harvest = env.ledger().timestamp();

        env.storage().instance().set(&user, &position);

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

        let vault_info = Self::get_vault_info(env.clone());
        let mut metrics = Self::get_metrics(env.clone());
        let mut position = Self::get_user_position(env.clone(), user.clone());

        if position.shares < shares {
            panic!("insufficient shares");
        }

        // Calculate withdrawal amounts
        let withdraw_amount_a = shares * metrics.total_amount_a / metrics.total_shares;
        let withdraw_amount_b = shares * metrics.total_amount_b / metrics.total_shares;

        // Apply withdrawal fee
        let fee_amount_a = withdraw_amount_a * vault_info.withdrawal_fee as i128 / 10000;
        let fee_amount_b = withdraw_amount_b * vault_info.withdrawal_fee as i128 / 10000;

        // Apply performance fee (fee_rate) on the realized gain, split
        // proportionally between the two tokens
        let perf_fee = Self::calculate_performance_fee(
            &vault_info,
            &position,
            withdraw_amount_a,
            withdraw_amount_b,
            shares,
        );
        let perf_fee_a = if withdraw_amount_a + withdraw_amount_b > 0 {
            perf_fee * withdraw_amount_a / (withdraw_amount_a + withdraw_amount_b)
        } else {
            0
        };
        let perf_fee_b = perf_fee - perf_fee_a;

        let final_amount_a = withdraw_amount_a - fee_amount_a - perf_fee_a;
        let final_amount_b = withdraw_amount_b - fee_amount_b - perf_fee_b;

        if final_amount_a < min_amount_a {
            panic!("insufficient amount A");
        }
        if final_amount_b < min_amount_b {
            panic!("insufficient amount B");
        }

        // Update user position
        position.shares -= shares;
        position.deposited_amount_a -= withdraw_amount_a;
        position.deposited_amount_b -= withdraw_amount_b;
        env.storage().instance().set(&user, &position);

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

        // Route the performance fee to the treasury
        if perf_fee_a > 0 || perf_fee_b > 0 {
            let treasury = Self::get_treasury(env.clone());
            if perf_fee_a > 0 {
                token_a_client.transfer(&env.current_contract_address(), &treasury, &perf_fee_a);
            }
            if perf_fee_b > 0 {
                token_b_client.transfer(&env.current_contract_address(), &treasury, &perf_fee_b);
            }
        }

        (final_amount_a, final_amount_b)
    }

    /// Auto-compound harvest and reinvestment
    pub fn harvest(env: Env, caller: Address) {
        Self::require_not_paused(&env);

        let vault_info = Self::get_vault_info(env.clone());
        let mut metrics = Self::get_metrics(env.clone());

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

            // Transfer fees to treasury
            if fee_a > 0 || fee_b > 0 {
                let treasury = Self::get_treasury(env.clone());
                let token_a_client = TokenClient::new(&env, &vault_info.token_a);
                let token_b_client = TokenClient::new(&env, &vault_info.token_b);

                if fee_a > 0 {
                    token_a_client.transfer(&env.current_contract_address(), &treasury, &fee_a);
                }
                if fee_b > 0 {
                    token_b_client.transfer(&env.current_contract_address(), &treasury, &fee_b);
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
            .get(&user)
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

    /// Get treasury address that receives protocol fees
    pub fn get_treasury(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "treasury"))
            .unwrap_optimized()
    }

    /// Calculate the performance fee (`fee_rate`, in basis points) on the
    /// realized gain of a withdrawal. The gain is the redeemed value minus the
    /// user's proportional cost basis (their historical deposits). Only gains
    /// are charged; a withdrawal at or below cost pays no performance fee.
    fn calculate_performance_fee(
        vault_info: &VaultInfo,
        position: &UserPosition,
        withdraw_amount_a: i128,
        withdraw_amount_b: i128,
        shares: i128,
    ) -> i128 {
        if vault_info.fee_rate == 0 || position.shares <= 0 {
            return 0;
        }
        let cost_a = position.deposited_amount_a * shares / position.shares;
        let cost_b = position.deposited_amount_b * shares / position.shares;
        let gain = (withdraw_amount_a + withdraw_amount_b) - (cost_a + cost_b);
        if gain > 0 {
            gain * vault_info.fee_rate as i128 / 10000
        } else {
            0
        }
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
        if admin != current_admin {
            panic!("unauthorized");
        }
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause vault (admin only)
    pub fn unpause(env: Env, admin: Address) {
        let current_admin = Self::get_admin(env.clone());
        if admin != current_admin {
            panic!("unauthorized");
        }
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Events};
    use soroban_sdk::{Env, IntoVal, Symbol, token::{StellarAssetClient, TokenClient}};

    fn setup(
        env: &Env,
        fee_rate: u32,
        harvest_fee: u32,
        withdrawal_fee: u32,
    ) -> (
        YieldVaultClient,
        Address,
        TokenClient,
        TokenClient,
        StellarAssetClient,
        StellarAssetClient,
        Address,
        Address,
    ) {
        let admin = Address::generate(env);
        let user = Address::generate(env);
        let treasury = Address::generate(env);
        let token_a = env.register_stellar_asset_contract_v2(admin.clone());
        let token_b = env.register_stellar_asset_contract_v2(admin.clone());
        let token_a_client = TokenClient::new(env, &token_a.address());
        let token_b_client = TokenClient::new(env, &token_b.address());
        let token_a_admin = StellarAssetClient::new(env, &token_a.address());
        let token_b_admin = StellarAssetClient::new(env, &token_b.address());
        let pool_id = Address::generate(env);

        let vault_id = env.register_contract(None, YieldVault);
        let vault = YieldVaultClient::new(env, &vault_id);

        vault.initialize(
            &admin,
            &Symbol::new(env, "TestVault"),
            &token_a.address(),
            &token_b.address(),
            &pool_id,
            &1,
            &fee_rate,
            &harvest_fee,
            &withdrawal_fee,
            &treasury,
        );

        (vault, vault_id, token_a_client, token_b_client, token_a_admin, token_b_admin, user, treasury)
    }

    #[test]
    fn test_performance_fee_applied_on_gains() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        // 1% performance fee, no harvest/withdrawal fees
        let (vault, vault_id, token_a_client, token_b_client, token_a_admin, token_b_admin, user, treasury) =
            setup(&env, 100, 0, 0);

        // Deposit 1000 + 1000 -> 1000 shares (first deposit, min of both)
        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        // Simulate vault growth: mint "rewards" to the contract, then harvest
        // (rewards are simulated as 1000 per token, harvest_fee = 0)
        token_a_admin.mint(&vault_id, &1000);
        token_b_admin.mint(&vault_id, &1000);
        vault.harvest(&user);
        // metrics now: total_amount_a = 2000, total_amount_b = 2000

        // Withdraw everything: 1000 shares redeem 2000 + 2000
        // cost basis = 1000 + 1000 -> gain = 2000, perf fee = 1% = 20 (10 + 10)
        let (out_a, out_b) = vault.withdraw(&user, &1000, &0, &0);

        assert_eq!(out_a, 1990);
        assert_eq!(out_b, 1990);
        assert_eq!(token_a_client.balance(&treasury), 10);
        assert_eq!(token_b_client.balance(&treasury), 10);
    }

    #[test]
    fn test_no_performance_fee_without_gain() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, vault_id, token_a_client, token_b_client, token_a_admin, token_b_admin, user, treasury) =
            setup(&env, 100, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        // Withdraw half immediately: 500 shares redeem 500 + 500, no gain
        let (out_a, out_b) = vault.withdraw(&user, &500, &0, &0);

        assert_eq!(out_a, 500);
        assert_eq!(out_b, 500);
        assert_eq!(token_a_client.balance(&treasury), 0);
        assert_eq!(token_b_client.balance(&treasury), 0);
    }

    #[test]
    fn test_zero_fee_rate_charges_no_performance_fee() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, vault_id, token_a_client, token_b_client, token_a_admin, token_b_admin, user, treasury) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        token_a_admin.mint(&vault_id, &1000);
        token_b_admin.mint(&vault_id, &1000);
        vault.harvest(&user);

        let (out_a, out_b) = vault.withdraw(&user, &1000, &0, &0);

        assert_eq!(out_a, 2000);
        assert_eq!(out_b, 2000);
        assert_eq!(token_a_client.balance(&treasury), 0);
        assert_eq!(token_b_client.balance(&treasury), 0);
    }

    #[test]
    fn test_withdrawal_fee_still_applied() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        // 1% withdrawal fee, no performance fee
        let (vault, vault_id, token_a_client, token_b_client, token_a_admin, token_b_admin, user, treasury) =
            setup(&env, 0, 0, 100);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        // Withdraw everything: 1000 shares redeem 1000 + 1000, 1% fee = 10 + 10
        let (out_a, out_b) = vault.withdraw(&user, &1000, &0, &0);

        assert_eq!(out_a, 990);
        assert_eq!(out_b, 990);
        // Performance fee is 0 (no gain); withdrawal fee stays in the vault
        assert_eq!(token_a_client.balance(&treasury), 0);
        assert_eq!(token_b_client.balance(&treasury), 0);
    }
}
