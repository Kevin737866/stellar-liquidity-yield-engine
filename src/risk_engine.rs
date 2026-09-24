use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec,
    unwrap::UnwrapOptimized
};

/// Risk management engine for liquidity arbitrage
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskAssessment {
    pub pool_id: Address,
    pub impermanent_loss_risk: u32, // Basis points
    pub estimated_slippage: u32, // Basis points
    pub volatility_score: u32, // 0-100
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
        // Adjustment factor: 10000 = full position, scales down with volatility
        // Incorporate both 24h and 7d volatility for a blended adjustment
        let volatility_average = (volatility_metrics.volatility_24h as i128 + volatility_metrics.volatility_7d as i128) / 2;
        
        // Position multiplier: 10000 * (1 - volatility_avg/50000)
        // If volatility is 50% (5000 bp), reduce position to 50%
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
        let volatility_adjustment = Self::volatility_adjustment(&env, volatility_metrics);
        let circuit_breaker = Self::circuit_breaker_check(&env, pool_id.clone(), gas_price_surge, pool_imbalance, recent_losses);

        // Overall volatility score: average of IL and slippage adjusted by volatility
        let combined_risk = ((il_risk as u64 + slippage as u64) / 2) as u32;
        let volatility_score = ((volatility_metrics.volatility_24h as u64 + volatility_metrics.volatility_7d as u64) / 2 / 50) as u32;
        let final_score = ((combined_risk as u64 + volatility_score as u64) / 2).min(100) as u32;

        RiskAssessment {
            pool_id,
            impermanent_loss_risk: il_risk,
            estimated_slippage: slippage,
            volatility_score: final_score,
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
}
