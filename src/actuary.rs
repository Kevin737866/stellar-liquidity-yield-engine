/// Actuarial Model for IL Insurance Pricing
///
/// Provides:
/// - Monte Carlo price path simulation params (on-chain storage, off-chain execution)
/// - Risk-adjusted pricing: premiums > expected payouts + 10% reserve margin
/// - Dynamic pricing based on reserve pool health
/// - Governance: community-adjustable pricing model coefficients
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Symbol,
};

/// Typed failures of the actuarial pricing contract.
///
/// Governance parameter updates are the only state-changing path, so the
/// anticipated rejections are an unauthorized caller and out-of-range model
/// coefficients. They fail with these codes instead of opaque panics.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActuaryError {
    /// The caller is not the stored admin.
    Unauthorized = 1,
    /// The contract has not been initialized.
    NotInitialized = 2,
    /// The `base_multiplier_bps` coefficient is outside the allowed range.
    BaseMultiplierOutOfRange = 3,
    /// The `reserve_margin_bps` coefficient is outside the allowed range.
    ReserveMarginOutOfRange = 4,
}

/// Target minimum reserve ratio: 150% (in bps * 100)
pub const MIN_RESERVE_RATIO_BPS: u32 = 15000;

/// Dynamic pricing ceiling when reserve is stressed: 200%
pub const MAX_PREMIUM_MULTIPLIER_BPS: u32 = 20000;

/// Reserve margin above expected payouts: 10%
pub const RESERVE_MARGIN_BPS: u32 = 1000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SimulationParams {
    /// Annualised log-volatility of the price ratio, in basis points (e.g. 8000 = 80%)
    pub annual_volatility_bps: u32,
    /// Fraction of simulated paths that exceed the coverage threshold (scaled by 1e6)
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
    /// Community-governable correlation discount (default 10000 = 1.0x)
    pub correlation_discount_bps: u32,
    /// Community-governable reserve margin (default 1000 = 10%)
    pub reserve_margin_bps: u32,
}

fn default_pricing_params() -> PricingParams {
    PricingParams {
        base_multiplier_bps: 10000,
        vol_sensitivity_bps: 10000,
        correlation_discount_bps: 10000,
        reserve_margin_bps: RESERVE_MARGIN_BPS,
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
        let params = default_pricing_params();
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pricing_params"), &params);
        // Record the storage schema version of this build; `migrate` moves it
        // forward after an upgrade swaps the code.
        crate::upgrade::set_storage_version(&env, crate::upgrade::STORAGE_VERSION);
    }

    /// Replace this contract's code in place, keeping its address and storage
    /// (admin only). See [crate::upgrade] and `docs/UPGRADING.md`.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) {
        Self::require_admin(&env, admin.clone());
        crate::upgrade::update_wasm(&env, &admin, new_wasm_hash);
    }

    /// Storage schema version of this contract's stored data.
    pub fn get_storage_version(env: Env) -> u32 {
        crate::upgrade::storage_version(&env)
    }

    /// Adopt the storage schema version of this build (admin only, idempotent).
    /// Returns the version that was replaced.
    pub fn migrate(env: Env, admin: Address) -> u32 {
        Self::require_admin(&env, admin.clone());
        crate::upgrade::mark_migrated(&env, &admin)
    }

    /// Require the caller to be the stored admin.
    fn require_admin(env: &Env, caller: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "admin"))
            .unwrap_or_else(|| env.panic_with_error(ActuaryError::NotInitialized));
        if caller != admin {
            env.panic_with_error(ActuaryError::Unauthorized);
        }
    }

    /// Submit results of off-chain Monte Carlo simulation.
    ///
    /// Off-chain oracle runs 10k GBM price paths and submits the expected
    /// loss rate (fraction triggering IL payout) on-chain.
    pub fn submit_simulation_results(
        env: Env,
        oracle: Address,
        annual_volatility_bps: u32,
        expected_loss_rate_scaled: i128, // fraction * 1_000_000
        paths_count: u32,
    ) {
        oracle.require_auth();
        let fair_premium_bps =
            Self::compute_fair_premium(annual_volatility_bps, expected_loss_rate_scaled);

        let sim = SimulationParams {
            annual_volatility_bps,
            expected_loss_rate_scaled,
            fair_premium_bps,
            paths_count,
            last_updated: env.ledger().timestamp(),
        };

        env.storage()
            .instance()
            .set(&Symbol::new(&env, "sim_params"), &sim);

        env.events().publish(
            (Symbol::new(&env, "simulation_updated"), oracle),
            (
                annual_volatility_bps,
                expected_loss_rate_scaled,
                fair_premium_bps,
            ),
        );
    }

    /// Calculate risk-adjusted pricing: premiums exceed expected payouts + margin.
    ///
    /// fair_premium = coverage_amount * expected_loss_rate * (1 + reserve_margin)
    pub fn risk_adjusted_pricing(env: Env, coverage_amount: i128) -> i128 {
        let sim = Self::get_simulation_params(env.clone());
        let params = Self::get_pricing_params(env);

        // Apply governance multipliers
        let adjusted_loss_rate =
            sim.expected_loss_rate_scaled * params.base_multiplier_bps as i128 / 10000;

        // Add reserve margin
        let with_margin = adjusted_loss_rate * (10000 + params.reserve_margin_bps as i128) / 10000;

        coverage_amount * with_margin / 1_000_000
    }

    /// Dynamic premium adjustment based on current reserve ratio.
    ///
    /// If reserve < 150%, premiums increase to restore health.
    /// Multiplier is capped at 200%.
    pub fn dynamic_pricing(
        env: Env,
        base_premium_bps: u32,
        current_reserve: i128,
        active_coverage: i128,
    ) -> u32 {
        let params = Self::get_pricing_params(env);

        if active_coverage == 0 {
            return base_premium_bps;
        }

        let current_ratio = ((current_reserve * 10000) / active_coverage) as u32;

        if current_ratio >= MIN_RESERVE_RATIO_BPS {
            // Reserve healthy — apply governance multiplier only
            (base_premium_bps as u64 * params.base_multiplier_bps as u64 / 10000) as u32
        } else {
            // Reserve stressed: increase premium proportionally to shortfall
            let shortfall = MIN_RESERVE_RATIO_BPS - current_ratio;
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
                annual_volatility_bps: 8000,
                expected_loss_rate_scaled: 50_000, // 5% default loss rate
                fair_premium_bps: 550,             // 5.5%: 5% loss + 10% margin
                paths_count: 0,
                last_updated: 0,
            })
    }

    /// Get governance pricing parameters
    pub fn get_pricing_params(env: Env) -> PricingParams {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "pricing_params"))
            .unwrap_or(default_pricing_params())
    }

    /// Update governance pricing parameters (admin only).
    /// Community can adjust pricing model coefficients via governance.
    pub fn update_pricing_params(env: Env, admin: Address, new_params: PricingParams) {
        admin.require_auth();
        let stored_admin: Address = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_or_else(|| env.panic_with_error(ActuaryError::NotInitialized));
        if admin != stored_admin {
            panic_with_error!(&env, ActuaryError::Unauthorized);
        }

        // Validate params within reasonable bounds
        if new_params.base_multiplier_bps < 5000 || new_params.base_multiplier_bps > 30000 {
            panic_with_error!(&env, ActuaryError::BaseMultiplierOutOfRange);
        }
        if new_params.reserve_margin_bps < 500 || new_params.reserve_margin_bps > 5000 {
            panic_with_error!(&env, ActuaryError::ReserveMarginOutOfRange);
        }

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
    fn compute_fair_premium(_annual_volatility_bps: u32, expected_loss_rate_scaled: i128) -> u32 {
        // fair_premium_bps = expected_loss_rate * 10000 * (1 + 0.10)
        let with_margin = expected_loss_rate_scaled * 11000 / 10000;
        (with_margin / 100) as u32
    }
}

#[cfg(test)]
mod test {
    // The crate is `no_std`; the test harness needs `std` for `catch_unwind`.
    extern crate std;

    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    /// Deploy the actuary and initialize it, the way production code reaches
    /// it. Storage is only accessible from inside a contract, so entrypoints
    /// must be exercised through the generated client instead of called as
    /// plain functions on `Env::default()`.
    fn setup(env: &Env) -> (ActuaryClient<'_>, Address) {
        let admin = Address::generate(env);
        let contract_id = env.register(Actuary, ());
        let client = ActuaryClient::new(env, &contract_id);
        client.initialize(&admin);
        (client, admin)
    }

    #[test]
    fn test_risk_adjusted_pricing() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = setup(&env);
        let coverage = 1_000_000i128;

        let premium = client.risk_adjusted_pricing(&coverage);
        assert!(premium > 0);
        assert!(premium < coverage / 10); // Should be less than 10% of coverage
    }

    #[test]
    fn test_dynamic_pricing_healthy_reserve() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = setup(&env);

        // 200% collateralized → no stress increase
        let premium = client.dynamic_pricing(&50, &2_000_000, &1_000_000);
        // With default 1.0x governance multiplier → same rate
        assert_eq!(premium, 50);
    }

    #[test]
    fn test_dynamic_pricing_stressed_reserve() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, _admin) = setup(&env);

        // 100% collateralized (below 150% threshold) → premium increases
        let premium = client.dynamic_pricing(&50, &1_000_000, &1_000_000);
        assert!(premium > 50);
    }

    #[test]
    fn test_fair_premium_calculation() {
        // `expected_loss_rate_scaled` is a fraction scaled by 1e6, and the
        // result is basis points: a 5% (50_000 / 1e6) expected loss rate with
        // the 10% reserve margin is 5.5% = 550 bps.
        let fair = Actuary::compute_fair_premium(8000, 50_000);
        assert_eq!(fair, 550, "5% loss + 10% margin must be 550 bps");
    }

    #[test]
    fn test_update_pricing_params_invalid() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        // base_multiplier_bps below the allowed [5000, 30000] range is rejected.
        let bad = PricingParams {
            base_multiplier_bps: 4000,
            vol_sensitivity_bps: 10000,
            correlation_discount_bps: 10000,
            reserve_margin_bps: RESERVE_MARGIN_BPS,
        };
        assert!(client.try_update_pricing_params(&admin, &bad).is_err());

        // The stored parameters are untouched by the rejected update.
        assert_eq!(client.get_pricing_params(), default_pricing_params());
    }

    // ==================== Typed error paths ====================

    fn actuary(env: &Env) -> (Address, ActuaryClient) {
        let admin = Address::generate(env);
        let contract_id = env.register_contract(None, Actuary);
        let client = ActuaryClient::new(env, &contract_id);
        client.initialize(&admin);
        (admin, client)
    }

    fn params(base_multiplier_bps: u32, reserve_margin_bps: u32) -> PricingParams {
        PricingParams {
            base_multiplier_bps,
            vol_sensitivity_bps: 10000,
            correlation_discount_bps: 10000,
            reserve_margin_bps,
        }
    }

    #[test]
    fn test_update_pricing_params_reports_typed_errors() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, client) = actuary(&env);

        // base_multiplier_bps below the allowed floor.
        let err = client
            .try_update_pricing_params(&admin, &params(4_000, 1_000))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ActuaryError::BaseMultiplierOutOfRange.into());

        // base_multiplier_bps above the allowed ceiling.
        let err = client
            .try_update_pricing_params(&admin, &params(30_001, 1_000))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ActuaryError::BaseMultiplierOutOfRange.into());

        // reserve_margin_bps outside its range is a distinct code.
        let err = client
            .try_update_pricing_params(&admin, &params(10_000, 5_001))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ActuaryError::ReserveMarginOutOfRange.into());
    }

    #[test]
    fn test_update_pricing_params_from_non_admin_is_typed_unauthorized() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, client) = actuary(&env);

        let stranger = Address::generate(&env);
        let err = client
            .try_update_pricing_params(&stranger, &params(10_000, 1_000))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, ActuaryError::Unauthorized.into());
    }
}
