use soroban_sdk::{Address, Env, Symbol, testutils::Address as _};
use stellar_liquidity_yield_engine::{RiskEngine, RiskEngineClient};

fn main() {}

mod tests {
    use super::*;

    fn setup_risk_engine(env: &Env) -> RiskEngineClient {
        let contract_id = env.register_contract(None, RiskEngine);
        RiskEngineClient::new(env, &contract_id)
    }

    #[test]
    fn test_impermanent_loss_bounded_range() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        // Test across full range of price ratios
        for entry in [100, 500, 1000, 5000, 10000, 50000, 100000].iter() {
            for current in [100, 500, 1000, 5000, 10000, 50000, 100000].iter() {
                let il = client.calculate_impermanent_loss(&pool_id, &(*current as i128), &(*entry as i128));
                assert!(il <= 10000, "IL must be <= 100% (10000 bps) for entry={}, current={}", entry, current);
            }
        }
    }

    #[test]
    fn test_impermanent_loss_no_panic_on_zero_inputs() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        // Zero entry price
        let il_zero_entry = client.calculate_impermanent_loss(&pool_id, &10000, &0);
        assert_eq!(il_zero_entry, 0, "Zero entry price should return 0 IL");

        // Zero current price
        let il_zero_current = client.calculate_impermanent_loss(&pool_id, &0, &10000);
        assert_eq!(il_zero_current, 0, "Zero current price should return 0 IL");

        // Both zero
        let il_both_zero = client.calculate_impermanent_loss(&pool_id, &0, &0);
        assert_eq!(il_both_zero, 0, "Both zero should return 0 IL");
    }

    #[test]
    fn test_impermanent_loss_monotonicity() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        let entry_price = 10000i128;
        let mut prev_il = 0;

        // As price moves away from entry, IL should generally increase
        for current in [11000, 12000, 15000, 20000, 50000].iter() {
            let il = client.calculate_impermanent_loss(&pool_id, current, &entry_price);
            assert!(il >= prev_il || *current == 11000, 
                "IL should generally increase with price divergence: prev={}, curr={}", prev_il, il);
            prev_il = il;
        }
    }

    #[test]
    fn test_slippage_bounded_range() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        // Slippage should always be <= 100% (10000 bps)
        for amount in [1, 100, 1000, 10000, 1000000].iter() {
            for liquidity in [1000, 10000, 100000, 1000000].iter() {
                let slippage = client.estimate_slippage(&pool_id, *amount, *liquidity);
                assert!(slippage <= 10000, "Slippage must be <= 100% for amount={}, liquidity={}", amount, liquidity);
            }
        }
    }

    #[test]
    fn test_slippage_zero_when_amount_zero() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        let slippage = client.estimate_slippage(&pool_id, 0, 100000);
        assert_eq!(slippage, 0, "Zero amount should have zero slippage");
    }

    #[test]
    fn test_slippage_100_percent_when_no_liquidity() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        let slippage = client.estimate_slippage(&pool_id, 1000, 0);
        assert_eq!(slippage, 10000, "Zero liquidity should return 100% slippage");
    }

    #[test]
    fn test_slippage_increases_with_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);
        let liquidity = 100000i128;

        let mut prev_slippage = 0;
        for amount in [100, 1000, 10000, 50000].iter() {
            let slippage = client.estimate_slippage(&pool_id, *amount, liquidity);
            assert!(slippage >= prev_slippage, 
                "Slippage should increase with amount: prev={}, curr={}", prev_slippage, slippage);
            prev_slippage = slippage;
        }
    }

    #[test]
    fn test_volatility_adjustment_bounded() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);

        // Adjustment should be between 5000 and 10000 (50% to 100% position)
        let metrics = stellar_liquidity_yield_engine::VolatilityMetrics {
            price_correlation: 5000,
            volatility_24h: 2500,
            volatility_7d: 2500,
        };
        let adjustment = client.volatility_adjustment(&metrics);
        assert!(adjustment >= 5000, "Adjustment should be at least 50% for moderate volatility");
        assert!(adjustment <= 10000, "Adjustment should not exceed 100%");

        // High volatility
        let high_vol = stellar_liquidity_yield_engine::VolatilityMetrics {
            price_correlation: -10000,
            volatility_24h: 10000,
            volatility_7d: 10000,
        };
        let adjustment_high = client.volatility_adjustment(&high_vol);
        assert!(adjustment_high <= 10000, "High volatility should cap at 100%");
        assert!(adjustment_high >= 5000, "Adjustment should not go below 50%");
    }

    #[test]
    fn test_circuit_breaker_triggers_on_gas_surge() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        let result = client.circuit_breaker_check(&pool_id, &true, &50, &SorobanVec::new(&env));
        assert!(result, "Circuit breaker should trigger on gas surge");
    }

    #[test]
    fn test_circuit_breaker_triggers_on_pool_imbalance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        let result = client.circuit_breaker_check(&pool_id, &false, &85, &SorobanVec::new(&env));
        assert!(result, "Circuit breaker should trigger on pool imbalance > 80");
    }

    #[test]
    fn test_circuit_breaker_triggers_on_three_consecutive_losses() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        let mut losses = SorobanVec::new(&env);
        losses.push_back(false);
        losses.push_back(false);
        losses.push_back(false);

        let result = client.circuit_breaker_check(&pool_id, &false, &50, &losses);
        assert!(result, "Circuit breaker should trigger on 3 consecutive losses");
    }

    #[test]
    fn test_circuit_breaker_no_trigger_on_normal_conditions() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        let result = client.circuit_breaker_check(&pool_id, &false, &30, &SorobanVec::new(&env));
        assert!(!result, "Circuit breaker should NOT trigger under normal conditions");
    }

    #[test]
    fn test_assess_arbitrage_risk_returns_valid_assessment() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);
        let pool_id = Address::generate(&env);

        let metrics = stellar_liquidity_yield_engine::VolatilityMetrics {
            price_correlation: 5000,
            volatility_24h: 500,
            volatility_7d: 500,
        };

        let assessment = client.assess_arbitrage_risk(
            &pool_id,
            11000,
            10000,
            1000000,
            10000,
            metrics,
            false,
            30,
            SorobanVec::new(&env),
        );

        assert!(assessment.impermanent_loss_risk <= 10000, "IL risk should be capped");
        assert!(assessment.estimated_slippage <= 10000, "Slippage should be capped");
        assert!(assessment.volatility_score <= 100, "Volatility score should be 0-100");
        assert!(!assessment.circuit_breaker_triggered, "Should not trigger under normal conditions");
    }

    #[test]
    fn test_total_rebalance_cost_formula() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let client = setup_risk_engine(&env);

        let (total_cost, total_fee_bp) = client.calculate_total_rebalance_cost(
            &50000,
            &100, // 1% IL
            &50,  // 0.5% slippage
            &25,  // 0.25% entry fee
            &1000000,
        );

        assert!(total_cost > 0, "Total cost should be positive");
        assert!(total_fee_bp > 0, "Total fee basis points should be positive");
        // Total fee = 100 + 50 + 25 + 50 (overhead) = 225 bps
        assert_eq!(total_fee_bp, 225, "Total fee should be 225 bps");
    }
}
