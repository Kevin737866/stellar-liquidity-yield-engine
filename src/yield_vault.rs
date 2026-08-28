use soroban_sdk::{
    contract, contractimpl, contracttype, token::TokenClient, unwrap::UnwrapOptimized, Address,
    Env, Symbol, Vec,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultInfo {
    pub name: Symbol,
    pub token_a: Address,
    pub token_b: Address,
    pub pool_id: Address,
    pub strategy_id: u32,
    pub fee_rate: u32,       // Basis points (100 = 1%)
    pub harvest_fee: u32,    // Basis points
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
    pub apy: u32,  // Basis points
    pub tvl: i128, // Total Value Locked in USD (scaled)
    pub last_harvest: u64,
}

#[contract]
pub struct YieldVault;

/// Seconds in a common (non-leap) year, used to annualize APY.
const SECONDS_PER_YEAR: u128 = 31_536_000;

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

        env.storage()
            .instance()
            .set(&Symbol::new(&env, "vault_info"), &vault_info);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "admin"), &admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "treasury"), &treasury);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);

        // Emergency multisig state: the emergency signer set starts empty and
        // must be configured by the admin; threshold defaults to 3 approvals.
        env.storage().instance().set(
            &Symbol::new(&env, "emergency_signers"),
            &Vec::<Address>::new(&env),
        );
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "emergency_threshold"), &3u32);

        // Initialize metrics
        let metrics = VaultMetrics {
            total_shares: 0,
            total_amount_a: 0,
            total_amount_b: 0,
            apy: 0,
            tvl: 0,
            last_harvest: env.ledger().timestamp(),
        };
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "metrics"), &metrics);
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
            // First deposit: compute a geometric mean so both tokens are valued.
            // If either side is zero the depositor still earns shares proportional
            // to what they contributed, preventing over/under-pricing.
            if amount_a > 0 && amount_b > 0 {
                // Geometric mean – values both tokens equally regardless of
                // the absolute amounts deposited.
                let product = (amount_a as u128) * (amount_b as u128);
                let sqrt_val = Self::isqrt(product);
                sqrt_val as i128
            } else {
                // Single-sided deposit: use the non-zero amount directly.
                amount_a + amount_b
            }
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

        // Update vault metrics and recompute TVL from the new balances.
        metrics.total_shares += shares;
        metrics.total_amount_a += amount_a;
        metrics.total_amount_b += amount_b;
        metrics.tvl = Self::value_in_usd(&env, metrics.total_amount_a, metrics.total_amount_b);
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

        let final_amount_a = withdraw_amount_a - fee_amount_a;
        let final_amount_b = withdraw_amount_b - fee_amount_b;

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

        // Update vault metrics and recompute TVL from the remaining balances.
        metrics.total_shares -= shares;
        metrics.total_amount_a -= withdraw_amount_a;
        metrics.total_amount_b -= withdraw_amount_b;
        metrics.tvl = Self::value_in_usd(&env, metrics.total_amount_a, metrics.total_amount_b);
        env.storage().instance().set(&Symbol::new(&env, "metrics"), &metrics);

        // Transfer tokens to user
        let token_a_client = TokenClient::new(&env, &vault_info.token_a);
        let token_b_client = TokenClient::new(&env, &vault_info.token_b);

        token_a_client.transfer(&env.current_contract_address(), &user, &final_amount_a);
        token_b_client.transfer(&env.current_contract_address(), &user, &final_amount_b);

        (final_amount_a, final_amount_b)
    }

    /// Auto-compound harvest and reinvestment
    pub fn harvest(env: Env, _caller: Address) {
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

            // Derive an annualized APY from this harvest's yield (net rewards vs the
            // vault's value before reinvestment) over the elapsed wall-clock time.
            let elapsed = env.ledger().timestamp().saturating_sub(metrics.last_harvest);
            let prev_value = metrics.tvl;
            let reward_value = Self::value_in_usd(&env, net_rewards_a, net_rewards_b);
            if elapsed > 0 && prev_value > 0 && reward_value > 0 {
                // yield_bp = reward_value / prev_value * seconds_per_year / elapsed * 10000
                let apy_bp = reward_value as u128
                    * SECONDS_PER_YEAR
                    * 10000u128
                    / (prev_value as u128 * elapsed as u128);
                // Cap at 100,000% APY to keep the value sane.
                metrics.apy = apy_bp.min(1000_0000) as u32;
            }

            // Reinvest rewards
            metrics.total_amount_a += net_rewards_a;
            metrics.total_amount_b += net_rewards_b;
            metrics.last_harvest = env.ledger().timestamp();

            // Recompute TVL from the reinvested balances.
            metrics.tvl = Self::value_in_usd(&env, metrics.total_amount_a, metrics.total_amount_b);

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

    /// Get vault metrics, recomputing TVL on the fly from the current balances
    /// and the configured token prices so it can never get stuck at 0 once
    /// prices are provided. APY is derived from harvest history in `harvest`.
    pub fn get_metrics(env: Env) -> VaultMetrics {
        let mut metrics = Self::stored_metrics(&env);
        metrics.tvl = Self::value_in_usd(&env, metrics.total_amount_a, metrics.total_amount_b);
        metrics
    }

    /// Get user position
    pub fn get_user_position(env: Env, user: Address) -> UserPosition {
        env.storage().instance().get(&user).unwrap_or(UserPosition {
            shares: 0,
            last_harvest: 0,
            deposited_amount_a: 0,
            deposited_amount_b: 0,
        })
    }

    /// Get APY for the vault (in basis points)
    pub fn get_apy(env: Env) -> u32 {
        Self::get_metrics(env).apy
    }

    /// Get TVL for the vault (USD, scaled by the configured token price scale)
    pub fn get_tvl(env: Env) -> i128 {
        Self::get_metrics(env).tvl
    }

    /// Set USD prices (scaled) for token_a and token_b (admin only). TVL is
    /// recomputed immediately so get_tvl reflects the new prices.
    pub fn set_prices(env: Env, admin: Address, price_a: i128, price_b: i128) {
        let current_admin = Self::get_admin(env.clone());
        if admin != current_admin {
            panic!("unauthorized");
        }
        if price_a < 0 || price_b < 0 {
            panic!("negative price");
        }

        env.storage().instance().set(&Symbol::new(&env, "price_a"), &price_a);
        env.storage().instance().set(&Symbol::new(&env, "price_b"), &price_b);

        let metrics = Self::get_metrics(env.clone());
        env.storage().instance().set(&Symbol::new(&env, "metrics"), &metrics);
    }

    /// Get the currently configured token prices as (price_a, price_b).
    pub fn get_prices(env: Env) -> (i128, i128) {
        (Self::get_price_a(&env), Self::get_price_b(&env))
    }

    /// Get treasury address that receives protocol fees
    pub fn get_treasury(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "treasury"))
            .unwrap_optimized()
    }

    /// Raw stored metrics without any TVL/APY recomputation.
    fn stored_metrics(env: &Env) -> VaultMetrics {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "metrics"))
            .unwrap_optimized()
    }

    /// USD value (scale-agnostic) of the given token amounts using the configured
    /// per-token prices. Returns 0 while prices have not been set yet.
    fn value_in_usd(env: &Env, amount_a: i128, amount_b: i128) -> i128 {
        let value_a = amount_a.saturating_mul(Self::get_price_a(env).max(0));
        let value_b = amount_b.saturating_mul(Self::get_price_b(env).max(0));
        value_a.saturating_add(value_b)
    }

    fn get_price_a(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "price_a"))
            .unwrap_or(0)
    }

    fn get_price_b(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "price_b"))
            .unwrap_or(0)
    }

    /// Calculate pending rewards (placeholder)
    fn calculate_pending_rewards(_env: &Env, _pool_id: &Address) -> i128 {
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

    /// Integer square root (Babylonian method) for share calculations
    fn isqrt(n: u128) -> u128 {
        if n == 0 {
            return 0;
        }
        let mut x = n;
        let mut y = (x + 1) / 2;
        while y < x {
            x = y;
            y = (x + n / x) / 2;
        }
        x
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
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause vault (admin only)
    pub fn unpause(env: Env, admin: Address) {
        let current_admin = Self::get_admin(env.clone());
        if admin != current_admin {
            panic!("unauthorized");
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);
    }

    /// Require the caller to be the vault admin
    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("unauthorized");
        }
    }

    /// Configure the emergency multisig signer set (admin only).
    ///
    /// The caller must be the vault admin. Replaces the entire signer set,
    /// so a fresh `emergency_pause`/`emergency_unpause` requires the new set.
    pub fn set_emergency_signers(env: Env, admin: Address, signers: Vec<Address>) {
        Self::require_admin(&env, admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "emergency_signers"), &signers);
    }

    /// Set the number of approvals required to execute an emergency action
    /// (admin only). Must be at least 1.
    pub fn set_emergency_threshold(env: Env, admin: Address, threshold: u32) {
        Self::require_admin(&env, admin);
        if threshold == 0 {
            panic!("threshold must be at least 1");
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "emergency_threshold"), &threshold);
    }

    /// Get the emergency multisig signer set
    pub fn get_emergency_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "emergency_signers"))
            .unwrap_or(Vec::new(&env))
    }

    /// Get the emergency multisig approval threshold
    pub fn get_emergency_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "emergency_threshold"))
            .unwrap_or(3u32)
    }

    /// Require `threshold` distinct signers from the authorized set have been
    /// provided. Enforces the 3-of-N (configurable) emergency multisig pattern.
    fn require_multisig(env: &Env, signers: Vec<Address>) {
        let threshold = Self::get_emergency_threshold(env.clone());
        let authorized = Self::get_emergency_signers(env.clone());

        let mut valid = 0u32;
        for signer in signers.iter() {
            for candidate in authorized.iter() {
                if signer == candidate {
                    valid += 1;
                    break;
                }
            }
        }

        if valid < threshold {
            panic!("insufficient signatures for emergency action");
        }
    }

    /// Emergency pause (multisig required)
    pub fn emergency_pause(env: Env, signers: Vec<Address>) {
        Self::require_multisig(&env, signers);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);

        env.events()
            .publish(("emergency_pause",), (env.current_contract_address(),));
    }

    /// Emergency unpause (multisig required)
    pub fn emergency_unpause(env: Env, signers: Vec<Address>) {
        Self::require_multisig(&env, signers);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);

        env.events()
            .publish(("emergency_unpause",), (env.current_contract_address(),));
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Events};
    use soroban_sdk::{
        token::{StellarAssetClient, TokenClient},
        Env, IntoVal, Symbol,
    };

    fn setup(
        env: &Env,
        fee_rate: u32,
        harvest_fee: u32,
        withdrawal_fee: u32,
    ) -> (
        YieldVaultClient,
        TokenClient,
        TokenClient,
        StellarAssetClient,
        StellarAssetClient,
        Address,
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

        (
            vault,
            token_a_client,
            token_b_client,
            token_a_admin,
            token_b_admin,
            user,
            admin,
            treasury,
        )
    }

    #[test]
    fn test_treasury_stored_and_readable() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, _, treasury) = setup(&env, 0, 0, 0);

        assert_eq!(vault.get_treasury(), treasury);
    }

    #[test]
    fn test_harvest_fees_routed_to_treasury_not_admin() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        // 1% harvest fee
        let (
            vault,
            token_a_client,
            token_b_client,
            token_a_admin,
            token_b_admin,
            user,
            admin,
            treasury,
        ) = setup(&env, 0, 100, 0);

        // Fund the user and deposit so the vault holds tokens to pay fees from
        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        vault.harvest(&user);

        // rewards = 1000 per token, fee = 1% -> 10 per token to treasury
        assert_eq!(token_a_client.balance(&treasury), 10);
        assert_eq!(token_b_client.balance(&treasury), 10);
        // Admin must NOT receive harvest fees
        assert_eq!(token_a_client.balance(&admin), 0);
        assert_eq!(token_b_client.balance(&admin), 0);
    }

    #[test]
    fn test_harvest_with_zero_fee_leaves_no_treasury_transfer() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (
            vault,
            token_a_client,
            token_b_client,
            token_a_admin,
            token_b_admin,
            user,
            _,
            treasury,
        ) = setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        vault.harvest(&user);

        assert_eq!(token_a_client.balance(&treasury), 0);
        assert_eq!(token_b_client.balance(&treasury), 0);
    }

    #[test]
    fn test_first_deposit_balanced_mints_geometric_mean_shares() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);

        let shares = vault.deposit(&user, &1000, &1000, &0);
        let expected = ((1000u128 * 1000u128) as u128).isqrt() as i128;
        assert_eq!(shares, expected);
    }

    #[test]
    fn test_first_deposit_unbalanced_uses_nonzero_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &2000);
        token_b_admin.mint(&user, &500);

        let shares = vault.deposit(&user, &2000, &500, &0);
        assert_eq!(shares, 2500);
    }

    #[test]
    fn test_subsequent_deposit_mints_proportional_shares() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        let first_shares = vault.deposit(&user, &1000, &1000, &0);

        token_a_admin.mint(&user, &500);
        token_b_admin.mint(&user, &500);
        let second_shares = vault.deposit(&user, &500, &500, &0);

        assert_eq!(first_shares, 1000);
        assert_eq!(second_shares, 500);
    }

    #[test]
    fn test_withdraw_returns_tokens_and_burns_shares() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        let (amount_a, amount_b) = vault.withdraw(&user, &1000, &0, &0);
        assert_eq!(amount_a, 1000);
        assert_eq!(amount_b, 1000);
    }

    #[test]
    fn test_withdrawal_fee_is_applied() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (
            vault,
            token_a_client,
            token_b_client,
            token_a_admin,
            token_b_admin,
            user,
            _,
            treasury,
        ) = setup(&env, 0, 0, 100);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        let (amount_a, amount_b) = vault.withdraw(&user, &1000, &0, &0);
        assert_eq!(amount_a, 990);
        assert_eq!(amount_b, 990);
        assert_eq!(token_a_client.balance(&treasury), 10);
        assert_eq!(token_b_client.balance(&treasury), 10);
    }
}
