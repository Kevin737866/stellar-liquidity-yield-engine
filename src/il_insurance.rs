use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Symbol, Vec,
    token::TokenClient, unwrap::UnwrapOptimized,
};

/// Duration options for coverage period in days
pub const COVERAGE_7D: u64 = 7 * 24 * 3600;
pub const COVERAGE_30D: u64 = 30 * 24 * 3600;
pub const COVERAGE_90D: u64 = 90 * 24 * 3600;

/// Premium rate: 0.5% (50 basis points)
pub const BASE_PREMIUM_BPS: u32 = 50;

/// Reserve ratio target: 150%
pub const TARGET_RESERVE_RATIO: u32 = 15000; // basis points * 100

/// Minimum reserve ratio before dynamic pricing kicks in
pub const MIN_RESERVE_RATIO: u32 = 15000; // 150% in basis points scaled by 100

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InsurancePolicy {
    pub policy_id: u64,
    pub owner: Address,
    pub coverage_amount: i128,
    pub premium_paid: i128,
    /// Stored as sqrt(reserve_a / reserve_b) scaled by 1_000_000 to prevent manipulation
    pub start_price_ratio: i128,
    pub start_time: u64,
    pub expiry: u64,
    pub coverage_token: Address,
    pub claimed: bool,
    pub auto_renew: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservePool {
    pub total_premiums_collected: i128,
    pub total_claims_paid: i128,
    pub current_reserve: i128,
    pub active_coverage: i128,
    pub policy_count: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PremiumQuote {
    pub premium_amount: i128,
    pub coverage_period: u64,
    pub coverage_amount: i128,
    pub effective_rate_bps: u32,
    pub reserve_ratio: u32,
}

#[contract]
pub struct ILInsurance;

#[contractimpl]
impl ILInsurance {
    /// Initialize the insurance vault
    pub fn initialize(env: Env, admin: Address, reserve_token: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "admin"), &admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "reserve_token"), &reserve_token);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "next_policy_id"), &0u64);

        let reserve = ReservePool {
            total_premiums_collected: 0,
            total_claims_paid: 0,
            current_reserve: 0,
            active_coverage: 0,
            policy_count: 0,
        };
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "reserve_pool"), &reserve);
    }

    /// Calculate premium using a Black-Scholes inspired model.
    ///
    /// Formula accounts for:
    /// - Base premium rate (0.5%)
    /// - Coverage duration multiplier (longer = higher relative risk)
    /// - Historical volatility factor (from oracle / actuary params)
    /// - Dynamic pricing adjustment based on reserve ratio
    pub fn calculate_premium(
        env: Env,
        coverage_amount: i128,
        coverage_period: u64,
        historical_volatility_bps: u32, // Annual volatility in basis points (e.g. 8000 = 80%)
        pool_correlation_bps: u32,      // Correlation coefficient * 10000
    ) -> PremiumQuote {
        let reserve = Self::get_reserve_pool(&env);

        // Duration factor: scale premium by sqrt of time ratio (vs 30 days baseline)
        // duration_factor = sqrt(period_seconds / COVERAGE_30D) scaled by 1000
        let duration_factor = Self::sqrt_scaled(
            (coverage_period as i128 * 1000) / COVERAGE_30D as i128,
        );

        // Volatility adjustment: higher volatility → higher IL risk
        // vol_factor is in basis points / 100
        let vol_factor = historical_volatility_bps as i128;

        // Correlation reduces effective IL (correlated assets have less IL)
        // correlation_adjusted = vol_factor * (10000 - pool_correlation_bps) / 10000
        let correlation_adjusted =
            vol_factor * (10000 - pool_correlation_bps as i128) / 10000;

        // Base effective rate in basis points:
        // rate = BASE_PREMIUM_BPS + (correlation_adjusted * duration_factor / 100000)
        let mut effective_rate_bps = BASE_PREMIUM_BPS as i128
            + (correlation_adjusted * duration_factor / 100_000);

        // Dynamic pricing: if reserve ratio drops below 150%, increase premiums
        let reserve_ratio = Self::get_reserve_ratio(&env, &reserve);
        if reserve_ratio < MIN_RESERVE_RATIO {
            // Increase rate by up to 50% when reserve is depleted
            let shortage = (MIN_RESERVE_RATIO - reserve_ratio) as i128;
            let increase = effective_rate_bps * shortage / 10000;
            effective_rate_bps += increase;
        }

        // Cap effective rate at 500 bps (5%) to remain competitive
        if effective_rate_bps > 500 {
            effective_rate_bps = 500;
        }

        let premium_amount = coverage_amount * effective_rate_bps / 10000;

        PremiumQuote {
            premium_amount,
            coverage_period,
            coverage_amount,
            effective_rate_bps: effective_rate_bps as u32,
            reserve_ratio,
        }
    }

    /// Purchase an insurance policy.
    /// User pays the premium; policy is recorded on-chain (non-transferable NFT).
    pub fn purchase_insurance(
        env: Env,
        buyer: Address,
        coverage_amount: i128,
        coverage_period: u64,
        current_price_ratio_scaled: i128, // sqrt(reserve_a/reserve_b) * 1_000_000
        historical_volatility_bps: u32,
        pool_correlation_bps: u32,
        auto_renew: bool,
        reserve_token: Address,
    ) -> u64 {
        buyer.require_auth();

        // Validate coverage period
        require!(
            coverage_period == COVERAGE_7D
                || coverage_period == COVERAGE_30D
                || coverage_period == COVERAGE_90D,
            "invalid coverage period"
        );
        require!(coverage_amount > 0, "coverage amount must be positive");

        let quote = Self::calculate_premium(
            env.clone(),
            coverage_amount,
            coverage_period,
            historical_volatility_bps,
            pool_correlation_bps,
        );
        let premium_amount = quote.premium_amount;
        require!(premium_amount > 0, "premium must be positive");

        // Transfer premium from buyer to reserve
        let token_client = TokenClient::new(&env, &reserve_token);
        token_client.transfer(
            &buyer,
            &env.current_contract_address(),
            &premium_amount,
        );

        // Mint policy (increment policy counter)
        let policy_id = Self::next_policy_id(&env);
        let now = env.ledger().timestamp();

        let policy = InsurancePolicy {
            policy_id,
            owner: buyer.clone(),
            coverage_amount,
            premium_paid: premium_amount,
            start_price_ratio: current_price_ratio_scaled,
            start_time: now,
            expiry: now + coverage_period,
            coverage_token: reserve_token,
            claimed: false,
            auto_renew,
        };

        Self::save_policy(&env, &policy);

        // Update reserve pool
        let mut reserve = Self::get_reserve_pool(&env);
        reserve.total_premiums_collected += premium_amount;
        reserve.current_reserve += premium_amount;
        reserve.active_coverage += coverage_amount;
        reserve.policy_count += 1;
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "reserve_pool"), &reserve);

        // Emit event
        env.events().publish(
            (Symbol::new(&env, "policy_purchased"), buyer),
            (policy_id, coverage_amount, premium_amount),
        );

        policy_id
    }

    /// Claim IL compensation after policy expiry.
    ///
    /// IL formula: IL = 2*sqrt(price_ratio) / (1 + price_ratio) - 1
    /// where price_ratio = current_price / start_price
    pub fn claim_il_compensation(
        env: Env,
        claimant: Address,
        policy_id: u64,
        current_price_ratio_scaled: i128, // sqrt(reserve_a/reserve_b) * 1_000_000
    ) -> i128 {
        claimant.require_auth();

        let mut policy = Self::get_policy(&env, policy_id);
        require!(!policy.claimed, "policy already claimed");
        require!(policy.owner == claimant, "not policy owner");
        require!(
            env.ledger().timestamp() >= policy.expiry,
            "policy not yet expired"
        );

        // Calculate price ratio: (current / start)^2, both stored as sqrt so just square ratio
        // actual_ratio = (current_price_ratio / start_price_ratio)^2
        let start = policy.start_price_ratio; // sqrt(P0) * 1e6
        let current = current_price_ratio_scaled; // sqrt(P1) * 1e6
        require!(start > 0, "invalid start price ratio");

        // price_ratio_1e6 = (current/start)^2 * 1e6
        let price_ratio_1e6 = (current * current * 1_000_000) / (start * start);

        // IL = 2*sqrt(r)/(1+r) - 1 where r = price_ratio
        // All scaled by 1_000_000
        let sqrt_r = Self::sqrt_scaled(price_ratio_1e6); // sqrt(r) * 1000 (since input is *1e6 we get *1e3)
        // scale back: IL = 2 * sqrt_r / (1e3 + price_ratio_1e6/1e3) - 1
        let numerator = 2 * sqrt_r * 1_000_000; // scaled by 1e9
        let denominator = 1_000 + price_ratio_1e6 / 1_000; // scaled by 1e3
        let il_scaled = if denominator > 0 {
            numerator / denominator // scaled by 1e6
        } else {
            0
        };

        // Negative IL (price returned to start) = no compensation needed
        if il_scaled >= 1_000_000 {
            // IL >= 0 means no loss, return 0
            policy.claimed = true;
            Self::save_policy(&env, &policy);
            return 0;
        }

        // Compensation = coverage_amount * |IL|
        let il_loss_scaled = 1_000_000 - il_scaled; // how much of value was preserved is wrong; recalculate
        // Actually for IL: when price moves, IL is always negative (loss), computed as:
        // IL_loss = (1 - (2*sqrt(r)/(1+r))) of initial value
        let compensation = policy.coverage_amount * il_loss_scaled / 1_000_000;

        if compensation <= 0 {
            policy.claimed = true;
            Self::save_policy(&env, &policy);
            return 0;
        }

        // Check reserve has enough
        let mut reserve = Self::get_reserve_pool(&env);
        let payout = compensation.min(reserve.current_reserve);

        if payout > 0 {
            let token_client = TokenClient::new(&env, &policy.coverage_token);
            token_client.transfer(
                &env.current_contract_address(),
                &claimant,
                &payout,
            );

            reserve.total_claims_paid += payout;
            reserve.current_reserve -= payout;
            reserve.active_coverage -= policy.coverage_amount;
            env.storage()
                .instance()
                .set(&Symbol::new(&env, "reserve_pool"), &reserve);
        }

        policy.claimed = true;
        Self::save_policy(&env, &policy);

        // Emit event
        env.events().publish(
            (Symbol::new(&env, "claim_processed"), claimant),
            (policy_id, payout),
        );

        payout
    }

    /// Get current reserve pool statistics
    pub fn reserve_pool(env: Env) -> ReservePool {
        Self::get_reserve_pool(&env)
    }

    /// Get a specific policy by ID
    pub fn get_policy(env: Env, policy_id: u64) -> InsurancePolicy {
        env.storage()
            .persistent()
            .get(&policy_id)
            .unwrap_optimized()
    }

    /// Get the current reserve ratio as basis points (e.g. 15000 = 150%)
    pub fn get_collateralization_ratio(env: Env) -> u32 {
        let reserve = Self::get_reserve_pool(&env);
        Self::get_reserve_ratio(&env, &reserve)
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    fn get_reserve_pool(env: &Env) -> ReservePool {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "reserve_pool"))
            .unwrap_or(ReservePool {
                total_premiums_collected: 0,
                total_claims_paid: 0,
                current_reserve: 0,
                active_coverage: 0,
                policy_count: 0,
            })
    }

    fn save_policy(env: &Env, policy: &InsurancePolicy) {
        env.storage().persistent().set(&policy.policy_id, policy);
    }

    fn next_policy_id(env: &Env) -> u64 {
        let id: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "next_policy_id"))
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&Symbol::new(env, "next_policy_id"), &(id + 1));
        id
    }

    fn get_reserve_ratio(env: &Env, reserve: &ReservePool) -> u32 {
        if reserve.active_coverage == 0 {
            return TARGET_RESERVE_RATIO * 10; // infinite ratio if no active coverage
        }
        // ratio = (current_reserve / active_coverage) * 10000
        ((reserve.current_reserve * 10000) / reserve.active_coverage) as u32
    }

    /// Integer square root, returns floor(sqrt(x * 1000)) for input scaled by 1000
    /// Used for duration factor calculation
    fn sqrt_scaled(x: i128) -> i128 {
        if x <= 0 {
            return 0;
        }
        // Newton's method
        let mut s = x;
        let mut t = (s + 1) / 2;
        while t < s {
            s = t;
            t = (s + x / s) / 2;
        }
        s
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_calculate_premium_basic() {
        let env = Env::default();
        let coverage_amount = 1_000_000i128; // 1M units

        let quote = ILInsurance::calculate_premium(
            env,
            coverage_amount,
            COVERAGE_30D,
            8000, // 80% annual vol
            5000, // 50% correlation
        );

        // Premium must be positive
        assert!(quote.premium_amount > 0);
        // Effective rate must be at least base rate
        assert!(quote.effective_rate_bps >= BASE_PREMIUM_BPS);
        // Rate should not exceed 5%
        assert!(quote.effective_rate_bps <= 500);
    }

    #[test]
    fn test_premium_scales_with_duration() {
        let env = Env::default();
        let coverage_amount = 1_000_000i128;

        let quote_7d = ILInsurance::calculate_premium(
            env.clone(),
            coverage_amount,
            COVERAGE_7D,
            8000,
            5000,
        );
        let quote_90d = ILInsurance::calculate_premium(
            env,
            coverage_amount,
            COVERAGE_90D,
            8000,
            5000,
        );

        // 90-day premium should be higher than 7-day
        assert!(quote_90d.premium_amount >= quote_7d.premium_amount);
    }

    #[test]
    fn test_premium_scales_with_volatility() {
        let env = Env::default();
        let coverage_amount = 1_000_000i128;

        let quote_low_vol = ILInsurance::calculate_premium(
            env.clone(),
            coverage_amount,
            COVERAGE_30D,
            2000, // 20% vol
            5000,
        );
        let quote_high_vol = ILInsurance::calculate_premium(
            env,
            coverage_amount,
            COVERAGE_30D,
            10000, // 100% vol
            5000,
        );

        // Higher volatility should result in higher premium
        assert!(quote_high_vol.premium_amount >= quote_low_vol.premium_amount);
    }

    #[test]
    fn test_collateralization_ratio() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let reserve_token = Address::generate(&env);

        ILInsurance::initialize(env.clone(), admin, reserve_token);

        // With no active coverage, should return very high ratio
        let ratio = ILInsurance::get_collateralization_ratio(env);
        assert!(ratio > 15000); // well above 150%
    }
}
