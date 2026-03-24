/// Actuarial Model for IL Insurance Pricing
///
/// This module provides:
/// - Monte Carlo price path simulation (parameters on-chain, execution off-chain)
/// - Risk-adjusted pricing to ensure premiums > expected payouts + 10% reserve margin
/// - Dynamic pricing based on reserve pool health
///
/// All values are fixed-point integers scaled by 1_000_000 (1e6) unless noted.
use soroban_sdk::{contract, contractimpl, contracttype, Env, Symbol, unwrap::UnwrapOptimized};

/// Number of simulation iterations (off-chain driver should use 10_000).
/// On-chain stores params; simulation runs off-chain and submits results.
pub const SIMULATION_ITERATIONS: u32 = 10_000;

/// Target reserve margin above expected payouts: 10%
pub const RESERVE_MARGIN_BPS: u32 = 1000; // 10%

/// Target minimum reserve ratio: 150%
pub const MIN_RESERVE_RATIO_BPS: u32 = 15000; // basis points * 100

/// Dynamic pricing ceiling when reserve is stressed: 200%
pub const MAX_PREMIUM_MULTIPLIER_BPS: u32 = 20000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SimulationParams {
    /// Annualised log-volatility of the price ratio, in basis points (e.g. 8000 = 80%)
    pub annual_volatility_bps: u32,
    /// Percentage of simulated paths that exceed the coverage threshold (scaled by 1e6)
    pub expected_loss_rate_scaled: i128,
    /// Suggested fair-value premium rate in basis points
    pub fair_premium_bps: u32,
    /// Number of paths simulated
    pub paths_count: u32,
    /// Ledger timestamp of last update
    pub last_updated: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PricingParams {
    /// Community-governable base multiplier (default 10000 = 1.0x)
    pub base_multiplier_bps: u32,
    /// Community-governable volatility sensitivity (default 10000 = 1.0x)
    pub vol_sensitivity_bps: u32,
    /// Community-governable correlation discount multiplier (default 10000 = 1.0x)
    pub correlation_discount_bps: u32,
    /// Community-governable reserve margin (default 1000 = 10%)
    pub reserve_margin_bps: u32,
}

impl Default for PricingParams {
    fn default() -> Self {
        PricingParams {
            base_multiplier_bps: 10000,
            vol_sensitivity_bps: 10000,
            correlation_discount_bps: 10000,
            reserve_margin_bps: RESERVE_MARGIN_BPS,
        }
    }
}

#[contract]
pub struct Actuary;

#[contractimpl]
impl Actuary {
    /// Initialize the actuary with default pricing parameters
    pub fn initialize(env: Env, admin: Address) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "admin"), &admin);
        let default_params = PricingParams::default();
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pricing_params"), &default_params);
    }

    /// Submit results of off-chain Monte Carlo simulation.
    ///
    /// Off-chain oracle runs 10k GBM (Geometric Brownian Motion) price paths
    /// and submits the expected loss rate (fraction of paths triggering IL payout).
    /// Admin/oracle submits this on-chain after each simulation run.
    pub fn submit_simulation_results(
        env: Env,
        oracle: Address,
        annual_volatility_bps: u32,
        expected_loss_rate_scaled: i128, // fraction * 1_000_000
        paths_count: u32,
    ) {
        oracle.require_auth();
        let params = Self::compute_fair_premium(
            annual_volatility_bps,
            expected_loss_rate_scaled,
        );

        let sim = SimulationParams {
            annual_volatility_bps,
            expected_loss_rate_scaled,
            fair_premium_bps: params,
            paths_count,
            last_updated: env.ledger().timestamp(),
        };

        env.storage()
            .instance()
            .set(&Symbol::new(&env, "sim_params"), &sim);

        env.events().publish(
            (Symbol::new(&env, "simulation_updated"), oracle),
            (annual_volatility_bps, expected_loss_rate_scaled, params),
        );
    }

    /// Calculate risk-adjusted pricing to ensure premiums exceed expected payouts + margin.
    ///
    /// fair_premium_bps = expected_loss_rate * (1 + reserve_margin)
    pub fn risk_adjusted_pricing(env: Env, coverage_amount: i128) -> i128 {
        let sim = Self::get_simulation_params(&env);
        let params = Self::get_pricing_params(&env);

        // Apply governance multipliers
        let adjusted_loss_rate = sim.expected_loss_rate_scaled
            * params.base_multiplier_bps as i128
            / 10000;

        // Add reserve margin
        let with_margin = adjusted_loss_rate
            * (10000 + params.reserve_margin_bps as i128)
            / 10000;

        // Calculate fair premium amount
        coverage_amount * with_margin / 1_000_000
    }

    /// Dynamic premium adjustment based on current reserve ratio.
    ///
    /// If reserve < 150%, premiums are increased proportionally to restore health.
    /// Multiplier is capped at 200% to avoid pricing out the market.
    pub fn dynamic_pricing(
        env: Env,
        base_premium_bps: u32,
        current_reserve: i128,
        active_coverage: i128,
    ) -> u32 {
        let params = Self::get_pricing_params(&env);

        if active_coverage == 0 {
            return base_premium_bps;
        }

        let current_ratio = ((current_reserve * 10000) / active_coverage) as u32;

        if current_ratio >= MIN_RESERVE_RATIO_BPS {
            // Reserve healthy, apply only governance multiplier
            (base_premium_bps as u64 * params.base_multiplier_bps as u64 / 10000) as u32
        } else {
            // Reserve stressed: increase premium proportionally
            let shortfall = MIN_RESERVE_RATIO_BPS - current_ratio;
            // Increase by up to 100% based on shortfall
            let increase_bps = (base_premium_bps as u64 * shortfall as u64 / 10000) as u32;
            let stressed_premium = base_premium_bps + increase_bps;

            // Cap at maximum multiplier
            let max_premium = base_premium_bps * MAX_PREMIUM_MULTIPLIER_BPS / 10000;
            stressed_premium.min(max_premium)
        }
    }

    /// Get the last submitted simulation parameters
    pub fn get_simulation_params(env: Env) -> SimulationParams {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "sim_params"))
            .unwrap_or(SimulationParams {
                annual_volatility_bps: 8000,         // Default 80% vol
                expected_loss_rate_scaled: 50_000,    // Default 5% loss rate
                fair_premium_bps: 55,                 // ~0.55%
                paths_count: 0,
                last_updated: 0,
            })
    }

    /// Get governance pricing parameters
    pub fn get_pricing_params(env: Env) -> PricingParams {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "pricing_params"))
            .unwrap_or(PricingParams::default())
    }

    /// Update governance pricing parameters (admin only)
    pub fn update_pricing_params(
        env: Env,
        admin: Address,
        new_params: PricingParams,
    ) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_optimized();
        require!(admin == stored_admin, "unauthorized: admin required");

        // Validate params within reasonable bounds
        require!(
            new_params.base_multiplier_bps >= 5000 && new_params.base_multiplier_bps <= 30000,
            "base_multiplier_bps out of range [5000, 30000]"
        );
        require!(
            new_params.reserve_margin_bps >= 500 && new_params.reserve_margin_bps <= 5000,
            "reserve_margin_bps out of range [500, 5000]"
        );

        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pricing_params"), &new_params);

        env.events().publish(
            (Symbol::new(&env, "params_updated"), admin),
            new_params.base_multiplier_bps,
        );
    }

    // ─── Private helpers ─────────────────────────────────────────────────────

    /// Compute fair premium in bps from expected loss rate
    fn compute_fair_premium(
        _annual_volatility_bps: u32,
        expected_loss_rate_scaled: i128,
    ) -> u32 {
        // Apply 10% reserve margin on top of expected loss rate
        // fair_premium_bps = expected_loss_rate_fraction * 10000 * (1 + 0.10)
        let with_margin = expected_loss_rate_scaled * 11000 / 10000;
        // Convert from 1e6 scale to basis points
        (with_margin / 100) as u32
    }
}

// Required for initialize
use soroban_sdk::Address;

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    #[test]
    fn test_risk_adjusted_pricing() {
        let env = Env::default();
        let coverage = 1_000_000i128;

        // With default params: expected_loss_rate = 5% (50_000 / 1e6)
        // Premium = 1_000_000 * 50_000/1e6 * (1+0.10) = ~55_000 units
        let premium = Actuary::risk_adjusted_pricing(env, coverage);
        assert!(premium > 0);
        assert!(premium < coverage / 10); // Should be less than 10% of coverage
    }

    #[test]
    fn test_dynamic_pricing_healthy_reserve() {
        let env = Env::default();
        // 200% collateralized → no increase
        let premium = Actuary::dynamic_pricing(env, 50, 2_000_000, 1_000_000);
        assert_eq!(premium, 50); // No change when default governance multiplier is 1.0
    }

    #[test]
    fn test_dynamic_pricing_stressed_reserve() {
        let env = Env::default();
        // 100% collateralized (below 150% threshold) → premium increases
        let premium = Actuary::dynamic_pricing(env, 50, 1_000_000, 1_000_000);
        assert!(premium > 50);
    }

    #[test]
    fn test_fair_premium_calculation() {
        // 5% expected loss rate with 10% margin should yield ~55 bps
        let fair = Actuary::compute_fair_premium(8000, 50_000);
        assert!(fair >= 50 && fair <= 60, "Expected ~55 bps, got {}", fair);
    }
}
