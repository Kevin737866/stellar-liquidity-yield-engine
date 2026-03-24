use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec, i128 as SorobanI128,
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
    /// Calculate impermanent loss given price changes
    /// Formula: 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
    pub fn calculate_impermanent_loss(
        env: Env,
        current_price_ratio: i128, // Scaled by 10000
        entry_price_ratio: i128, // Scaled by 10000
    ) -> u32 {
        if entry_price_ratio == 0 {
            return 0;
        }

        // Avoid division by zero and overflow
        let ratio = if current_price_ratio > 0 {
            (current_price_ratio as i128 * 10000) / entry_price_ratio as i128
        } else {
            0
        };

        if ratio == 0 {
            return 0;
        }

        // Simplified IL calculation: loss increases with price divergence
        // IL% ≈ (sqrt(price_ratio) - 1)^2 / price_ratio
        let ratio_diff = (ratio - 10000).abs();
        let il_basis_points = (ratio_diff * ratio_diff) / (100 * ratio);

        // Cap at 100% (10000 basis points)
        if il_basis_points > 10000 {
            10000
        } else {
            il_basis_points as u32
        }
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
        let base_volatility = volatility_metrics.volatility_24h;
        
        // Reduce position proportionally to 7-day volatility
        let volatility_average = (base_volatility as i128 + volatility_metrics.volatility_7d as i128) / 2;
        
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
