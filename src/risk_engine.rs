use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec,
    unwrap::UnwrapOptimized
};

/// Risk management engine for liquidity arbitrage
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskAssessment {
    pub pool_id: Address,
    pub impermanent_loss_risk: u32,        // Basis points
    pub estimated_slippage: u32,           // Basis points
    pub volatility_score: u32,             // 0-100
    pub position_size_multiplier_bps: u32, // 5000-10000; 10000 = full size
    pub circuit_breaker_triggered: bool,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VolatilityMetrics {
    pub price_correlation: i128, // -10000 to 10000 (percentage)
    pub volatility_24h: u32, // Basis points
    pub volatility_7d: u32, // Basis points
}

#[contract]
pub struct RiskEngine;

#[contractimpl]
impl RiskEngine {
    /// Calculate impermanent loss given price changes using the standard formula
    /// `IL = 1 - 2 * sqrt(r) / (1 + r)`, where `r = current / entry`.
    /// Returns the loss as basis points, capped at 10000 (100%).
    ///
    /// The arithmetic is scaled and multiplies-before-dividing so intermediate
    /// integer division never truncates (previously the result was discontinuous).
    pub fn calculate_impermanent_loss(
        env: Env,
        current_price_ratio: i128, // Scaled by 10000
        entry_price_ratio: i128, // Scaled by 10000
    ) -> u32 {
        if current_price_ratio <= 0 || entry_price_ratio <= 0 {
            return 0;
        }

        // r scaled by 10000: (current / entry) * 10000
        let r_scaled = (current_price_ratio as i128 * 10000) / entry_price_ratio;

        // sqrt(r) scaled by 10000 = sqrt(r_scaled * 10000)
        let sqrt_r_scaled = Self::isqrt((r_scaled as u128) * 10000);

        // term = (2 * sqrt(r) / (1 + r)) * 10000
        let denominator = r_scaled as u128 + 10000;
        let two_sqrt = sqrt_r_scaled * 2;
        let term = (two_sqrt * 10000) / denominator;

        // By AM-GM, 1 + r >= 2 * sqrt(r), so term <= 10000 and
        // `10000 - term` can never underflow. IL rises as price diverges.
        let il_basis_points = if term >= 10000 { 0 } else { 10000 - term };
        il_basis_points.min(10000) as u32
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

    /// Estimate slippage based on pool depth and trade amount
    /// Uses constant product formula: slippage = amount / (2 * liquidity)
    pub fn estimate_slippage(
        env: Env,
        pool_id: Address,
        amount: i128,
        pool_liquidity: i128, // Total liquidity in pool
    ) -> u32 {
        if pool_liquidity == 0 {
            return 10000; // 100% slippage if no liquidity
        }

        // Conservative estimate: slippage = amount / (1.5 * liquidity)
        let slippage = if amount > 0 {
            (amount as i128 * 10000) / (pool_liquidity as i128 * 15 / 10)
        } else {
            0
        };

        // Cap at 100%
        if slippage > 10000 {
            10000
        } else {
            slippage as u32
        }
    }

    /// Calculate volatility adjustment factor
    /// Reduces position size if assets have high correlation volatility
    pub fn volatility_adjustment(
        env: Env,
        volatility_metrics: VolatilityMetrics,
    ) -> u32 {
        // Position-size multiplier in basis points: 10000 = full size.
        // Formula: 10000 - min(avg_bp, 5000)
        // At zero volatility the multiplier is 10000 (full position).
        // At 5000 bp (50%) volatility or above it floors at 5000 (half position).
        let volatility_average = (volatility_metrics.volatility_24h as i128 + volatility_metrics.volatility_7d as i128) / 2;
        let adjustment = 10000 - (volatility_average.min(5000) as u32);

        adjustment
    }

    /// Circuit breaker: pause rebalancing if conditions are critical
    pub fn circuit_breaker_check(
        env: Env,
        pool_id: Address,
        gas_price_surge: bool, // true if gas is >2x normal
        pool_imbalance: u32, // 0-100 scale, >80 is concerning
        recent_losses: Vec<bool>, // Recent rebalance results
    ) -> bool {
        // Trigger circuit breaker if:
        // 1. Gas prices are spiking (network congestion)
        if gas_price_surge {
            return true;
        }

        // 2. Pool is severely imbalanced
        if pool_imbalance > 80u32 {
            return true;
        }

        // 3. Last 3 rebalances were all losses
        if recent_losses.len() >= 3 {
            let last_three_loss = recent_losses.get(recent_losses.len() - 3).unwrap_or(false)
                && recent_losses.get(recent_losses.len() - 2).unwrap_or(false)
                && recent_losses.get(recent_losses.len() - 1).unwrap_or(false);
            
            if last_three_loss {
                return true;
            }
        }

        false
    }

    /// Create a comprehensive risk assessment for an arbitrage opportunity
    pub fn assess_arbitrage_risk(
        env: Env,
        pool_id: Address,
        current_price_ratio: i128,
        entry_price_ratio: i128,
        pool_liquidity: i128,
        amount: i128,
        volatility_metrics: VolatilityMetrics,
        gas_price_surge: bool,
        pool_imbalance: u32,
        recent_losses: Vec<bool>,
    ) -> RiskAssessment {
        let il_risk = Self::calculate_impermanent_loss(&env, current_price_ratio, entry_price_ratio);
        let slippage = Self::estimate_slippage(&env, pool_id.clone(), amount, pool_liquidity);
        let position_size_multiplier_bps = Self::volatility_adjustment(&env, volatility_metrics);
        let circuit_breaker = Self::circuit_breaker_check(&env, pool_id.clone(), gas_price_surge, pool_imbalance, recent_losses);

        // Overall volatility score: average of IL and slippage adjusted by volatility.
        // The `raw_volatility_score` local is an unbounded intermediate; `.min(100)` is
        // applied to `final_score`, not here, so the 0-100 bound is on `volatility_score`.
        let combined_risk = ((il_risk as u64 + slippage as u64) / 2) as u32;
        let raw_volatility_score = ((volatility_metrics.volatility_24h as u64 + volatility_metrics.volatility_7d as u64) / 2 / 50) as u32;
        let final_score = ((combined_risk as u64 + raw_volatility_score as u64) / 2).min(100) as u32;

        RiskAssessment {
            pool_id,
            impermanent_loss_risk: il_risk,
            estimated_slippage: slippage,
            volatility_score: final_score,
            position_size_multiplier_bps,
            circuit_breaker_triggered: circuit_breaker,
            timestamp: env.ledger().timestamp(),
        }
    }

    /// Calculate total cost of rebalancing
    pub fn calculate_total_rebalance_cost(
        env: Env,
        gas_cost: i128,
        il_cost: u32, // Basis points
        slippage_cost: u32, // Basis points
        entry_fees: i128,
        amount: i128,
    ) -> (i128, u32) {
        // Total fee basis points
        let total_fee_bp = il_cost + slippage_cost + 50; // +50bp operational overhead

        // Calculate total cost in absolute terms
        let fee_amount = (amount * total_fee_bp as i128) / 10000;
        let total_cost = gas_cost + fee_amount + entry_fees;

        (total_cost, total_fee_bp)
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use soroban_sdk::Env;

    fn il(env: &Env, current: i128, entry: i128) -> u32 {
        RiskEngine::calculate_impermanent_loss(env.clone(), current, entry)
    }

    #[test]
    fn test_il_no_change_is_zero() {
        let env = Env::default();
        // r = 1 => IL = 0
        assert_eq!(il(&env, 10000, 10000), 0);
        assert_eq!(il(&env, 20000, 20000), 0);
    }

    #[test]
    fn test_il_standard_values() {
        let env = Env::default();
        // r = 2 => IL = 1 - 2*sqrt(2)/3 = 5.72% => ~572 bp (allow +-15 due to integer sqrt)
        let il_2x = il(&env, 20000, 10000);
        assert!(il_2x >= 560 && il_2x <= 590, "r=2x got {} expected ~572", il_2x);

        // r = 0.5 => symmetric to r=2 => ~572 bp
        let il_half = il(&env, 5000, 10000);
        assert!(il_half >= 560 && il_half <= 590, "r=0.5 got {} expected ~572", il_half);

        // r = 4 => IL = 1 - 2*2/5 = 20% => 2000 bp
        let il_4x = il(&env, 40000, 10000);
        assert!(il_4x >= 1985 && il_4x <= 2015, "r=4x got {} expected 2000", il_4x);

        // r = 1.5 => IL = 1 - 2*sqrt(1.5)/2.5
        // sqrt1.5=1.2247 => 2*1.2247/2.5=0.9798 => IL 2.02% => ~202 bp
        let il_1_5 = il(&env, 15000, 10000);
        assert!(il_1_5 >= 190 && il_1_5 <= 220, "r=1.5 got {} expected ~202", il_1_5);
    }

    #[test]
    fn test_il_zero_or_negative_returns_zero() {
        let env = Env::default();
        assert_eq!(il(&env, 0, 10000), 0);
        assert_eq!(il(&env, 10000, 0), 0);
        assert_eq!(il(&env, -1000, 10000), 0);
    }

    #[test]
    fn test_il_is_monotonic_with_divergence() {
        let env = Env::default();
        let il_small = il(&env, 11000, 10000); // r=1.1
        let il_large = il(&env, 20000, 10000); // r=2
        assert!(il_large > il_small, "IL should increase with price divergence");
    }

    // ---- Tests for position_size_multiplier_bps (issue #62) ----

    fn make_metrics(vol_24h: u32, vol_7d: u32) -> VolatilityMetrics {
        VolatilityMetrics { price_correlation: 0, volatility_24h: vol_24h, volatility_7d: vol_7d }
    }

    #[test]
    fn test_position_multiplier_bounds() {
        let env = Env::default();
        // Zero volatility → full position (10000)
        assert_eq!(RiskEngine::volatility_adjustment(env.clone(), make_metrics(0, 0)), 10000);
        // High volatility → floor at 5000
        assert_eq!(RiskEngine::volatility_adjustment(env.clone(), make_metrics(10000, 10000)), 5000);
        // Mid volatility (2500 bp each → avg 2500) → 10000 - 2500 = 7500
        assert_eq!(RiskEngine::volatility_adjustment(env.clone(), make_metrics(2500, 2500)), 7500);
    }

    #[test]
    fn test_position_multiplier_always_in_range() {
        let env = Env::default();
        for vol in [0u32, 100, 1000, 2500, 5000, 9999, 10000, 50000].iter() {
            let adj = RiskEngine::volatility_adjustment(env.clone(), make_metrics(*vol, *vol));
            assert!(adj >= 5000 && adj <= 10000,
                "multiplier {} out of [5000,10000] for vol={}", adj, vol);
        }
    }

    #[test]
    fn test_position_multiplier_monotonic_non_increasing() {
        let env = Env::default();
        let vols = [0u32, 500, 1000, 2000, 4000, 5000, 8000, 10000];
        let mut prev = 10001u32;
        for vol in vols.iter() {
            let adj = RiskEngine::volatility_adjustment(env.clone(), make_metrics(*vol, *vol));
            assert!(adj <= prev, "multiplier should be non-increasing: {} > {} at vol={}", adj, prev, vol);
            prev = adj;
        }
    }

    #[test]
    fn test_assess_arbitrage_risk_multiplier_equals_standalone() {
        let env = Env::default();
        let pool_id = Address::generate(&env);
        let metrics = make_metrics(1500, 2500);

        let expected_multiplier = RiskEngine::volatility_adjustment(env.clone(), metrics.clone());
        let assessment = RiskEngine::assess_arbitrage_risk(
            env.clone(),
            pool_id,
            10000,
            10000,
            1_000_000,
            10_000,
            metrics,
            false,
            0,
            Vec::new(&env),
        );
        assert_eq!(assessment.position_size_multiplier_bps, expected_multiplier,
            "position_size_multiplier_bps must match standalone volatility_adjustment");
    }

    #[test]
    fn test_position_multiplier_independent_from_il_and_slippage() {
        let env = Env::default();
        let pool_id = Address::generate(&env);
        let metrics = make_metrics(2000, 2000); // avg=2000, multiplier = 8000

        // Vary IL (current_price_ratio) and slippage (amount) while keeping volatility fixed
        let a1 = RiskEngine::assess_arbitrage_risk(
            env.clone(), pool_id.clone(), 10000, 10000, 1_000_000, 10_000, metrics.clone(), false, 0, Vec::new(&env));
        let a2 = RiskEngine::assess_arbitrage_risk(
            env.clone(), pool_id.clone(), 20000, 10000, 1_000_000, 50_000, metrics.clone(), false, 0, Vec::new(&env));

        // volatility_score may differ (it blends IL and slippage), multiplier must not
        assert_eq!(a1.position_size_multiplier_bps, a2.position_size_multiplier_bps,
            "multiplier must not change when only IL/slippage inputs vary");
        assert_eq!(a1.position_size_multiplier_bps, 8000);
    }
}
