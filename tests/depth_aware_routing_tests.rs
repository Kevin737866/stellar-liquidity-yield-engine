use soroban_sdk::{testutils::Address as _, Address, Env, Symbol, Vec as SorobanVec};
use stellar_liquidity_yield_engine::{SwapRouter, SwapRouterClient};

fn main() {}

mod tests {
    use super::*;

    // ==================== Depth Score Calculation Tests ====================

    #[test]
    fn test_depth_score_balanced_pool() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        // Add a pool with balanced reserves
        let pool_address = Address::generate(&env);
        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        client.add_pool(
            &admin,
            &pool_address,
            &token_a,
            &token_b,
            30, // 0.3% fee
            false,
        );

        // Update reserves to balanced values
        client.update_pool_reserves(&pool_address, 1_000_000, 1_000_000);

        // Get pool info and check depth score
        let pool_info = client.get_pool(&pool_address).unwrap();

        // For balanced pool (1M * 1M), depth score should be sqrt(1M) = 1000
        assert!(pool_info.depth_score > 0, "Depth score should be positive");
        assert!(
            pool_info.depth_score < 2_000_000,
            "Depth score should be reasonable"
        );
    }

    #[test]
    fn test_depth_score_skewed_pool() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        // Add a pool with skewed reserves
        let pool_address = Address::generate(&env);
        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        client.add_pool(&admin, &pool_address, &token_a, &token_b, 30, false);

        // Update reserves to skewed values (10:1 ratio)
        client.update_pool_reserves(&pool_address, 10_000_000, 1_000_000);

        let pool_info = client.get_pool(&pool_address).unwrap();

        // For skewed pool (10M * 1M), depth score should be sqrt(10M) ≈ 3162
        // This is lower than a balanced pool with same total liquidity
        assert!(pool_info.depth_score > 0, "Depth score should be positive");
    }

    #[test]
    fn test_depth_score_zero_reserves() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        let pool_address = Address::generate(&env);
        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        client.add_pool(&admin, &pool_address, &token_a, &token_b, 30, false);

        // Zero reserves
        client.update_pool_reserves(&pool_address, 0, 0);

        let pool_info = client.get_pool(&pool_address).unwrap();
        assert_eq!(
            pool_info.depth_score, 0,
            "Depth score should be zero for empty pool"
        );
    }

    #[test]
    fn test_total_liquidity() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        let pool_address = Address::generate(&env);
        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        client.add_pool(&admin, &pool_address, &token_a, &token_b, 30, false);

        client.update_pool_reserves(&pool_address, 500_000, 750_000);

        let pool_info = client.get_pool(&pool_address).unwrap();
        assert_eq!(
            pool_info.total_liquidity(),
            1_250_000,
            "Total liquidity should be sum of reserves"
        );
    }

    #[test]
    fn test_has_sufficient_liquidity() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        let pool_address = Address::generate(&env);
        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        client.add_pool(&admin, &pool_address, &token_a, &token_b, 30, false);

        client.update_pool_reserves(&pool_address, 1_000_000, 1_000_000);

        let pool_info = client.get_pool(&pool_address).unwrap();

        // Small amount should have sufficient liquidity
        assert!(
            pool_info.has_sufficient_liquidity(10_000),
            "Small amount should have sufficient liquidity"
        );

        // Large amount (100K) should also be OK (10x = 1M)
        assert!(
            pool_info.has_sufficient_liquidity(100_000),
            "100K should have sufficient liquidity"
        );

        // Very large amount (200K) should not have sufficient liquidity (10x = 2M > 1M)
        assert!(
            !pool_info.has_sufficient_liquidity(200_000),
            "200K should not have sufficient liquidity"
        );
    }

    // ==================== Depth-Aware Path Selection Tests ====================

    #[test]
    fn test_direct_path_selects_deepest_pool() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        // Add two pools for the same token pair
        let shallow_pool = Address::generate(&env);
        let deep_pool = Address::generate(&env);

        client.add_pool(&admin, &shallow_pool, &token_a, &token_b, 30, false);
        client.add_pool(&admin, &deep_pool, &token_a, &token_b, 30, false);

        // Set shallow pool reserves
        client.update_pool_reserves(&shallow_pool, 10_000, 10_000);

        // Set deep pool reserves (100x deeper)
        client.update_pool_reserves(&deep_pool, 1_000_000, 1_000_000);

        // Get quote - should select the deeper pool
        let quote = client.get_quote(&token_a, &token_b, 1000, None);

        // Verify the selected pool is the deep one
        let selected_pool = quote.path.pools.get(0).unwrap();
        assert_eq!(*selected_pool, deep_pool, "Should select the deeper pool");
    }

    #[test]
    fn test_xlm_hop_path_selects_deepest_pools() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        // Add shallow and deep pools for token_a -> XLM
        let shallow_pool_a = Address::generate(&env);
        let deep_pool_a = Address::generate(&env);

        client.add_pool(&admin, &shallow_pool_a, &token_a, &xlm_token, 30, false);
        client.add_pool(&admin, &deep_pool_a, &token_a, &xlm_token, 30, false);

        client.update_pool_reserves(&shallow_pool_a, 10_000, 10_000);
        client.update_pool_reserves(&deep_pool_a, 1_000_000, 1_000_000);

        // Add shallow and deep pools for XLM -> token_b
        let shallow_pool_b = Address::generate(&env);
        let deep_pool_b = Address::generate(&env);

        client.add_pool(&admin, &shallow_pool_b, &xlm_token, &token_b, 30, false);
        client.add_pool(&admin, &deep_pool_b, &xlm_token, &token_b, 30, false);

        client.update_pool_reserves(&shallow_pool_b, 10_000, 10_000);
        client.update_pool_reserves(&deep_pool_b, 1_000_000, 1_000_000);

        // Get quote for XLM hop - should select deepest pools for both legs
        let quote = client.get_quote(&token_a, &token_b, 1000, None);

        // Verify both selected pools are the deep ones
        let first_pool = quote.path.pools.get(0).unwrap();
        let second_pool = quote.path.pools.get(1).unwrap();

        assert_eq!(
            *first_pool, deep_pool_a,
            "Should select deeper pool for first leg"
        );
        assert_eq!(
            *second_pool, deep_pool_b,
            "Should select deeper pool for second leg"
        );
    }

    #[test]
    fn test_multi_hop_path_prefers_deeper_pools() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);
        let intermediate = Address::generate(&env);

        // Add shallow and deep pools for token_a -> intermediate
        let shallow_pool_1 = Address::generate(&env);
        let deep_pool_1 = Address::generate(&env);

        client.add_pool(&admin, &shallow_pool_1, &token_a, &intermediate, 30, false);
        client.add_pool(&admin, &deep_pool_1, &token_a, &intermediate, 30, false);

        client.update_pool_reserves(&shallow_pool_1, 10_000, 10_000);
        client.update_pool_reserves(&deep_pool_1, 1_000_000, 1_000_000);

        // Add shallow and deep pools for intermediate -> token_b
        let shallow_pool_2 = Address::generate(&env);
        let deep_pool_2 = Address::generate(&env);

        client.add_pool(&admin, &shallow_pool_2, &intermediate, &token_b, 30, false);
        client.add_pool(&admin, &deep_pool_2, &intermediate, &token_b, 30, false);

        client.update_pool_reserves(&shallow_pool_2, 10_000, 10_000);
        client.update_pool_reserves(&deep_pool_2, 1_000_000, 1_000_000);

        // Get quote - should prefer deeper pools in multi-hop
        let quote = client.get_quote(&token_a, &token_b, 1000, None);

        // Verify selected pools are the deep ones
        let first_pool = quote.path.pools.get(0).unwrap();
        let second_pool = quote.path.pools.get(1).unwrap();

        assert_eq!(
            *first_pool, deep_pool_1,
            "Should select deeper pool for first hop"
        );
        assert_eq!(
            *second_pool, deep_pool_2,
            "Should select deeper pool for second hop"
        );
    }

    #[test]
    fn test_depth_score_comparison_across_pools() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        // Pool 1: Balanced but smaller
        let pool1 = Address::generate(&env);
        client.add_pool(&admin, &pool1, &token_a, &token_b, 30, false);
        client.update_pool_reserves(&pool1, 100_000, 100_000);

        // Pool 2: Skewed but larger total
        let pool2 = Address::generate(&env);
        client.add_pool(&admin, &pool2, &token_a, &token_b, 30, false);
        client.update_pool_reserves(&pool2, 1_000_000, 10_000);

        // Pool 3: Balanced and largest
        let pool3 = Address::generate(&env);
        client.add_pool(&admin, &pool3, &token_a, &token_b, 30, false);
        client.update_pool_reserves(&pool3, 500_000, 500_000);

        let info1 = client.get_pool(&pool1).unwrap();
        let info2 = client.get_pool(&pool2).unwrap();
        let info3 = client.get_pool(&pool3).unwrap();

        // Pool 3 should have highest depth score (balanced + large)
        // Pool 2 should have medium depth score (large but skewed)
        // Pool 1 should have lowest depth score (small)
        assert!(
            info3.depth_score > info2.depth_score,
            "Balanced large pool should score higher than skewed large pool"
        );
        assert!(
            info2.depth_score > info1.depth_score,
            "Skewed large pool should score higher than small balanced pool"
        );

        // Verify routing selects pool3
        let quote = client.get_quote(&token_a, &token_b, 1000, None);
        let selected_pool = quote.path.pools.get(0).unwrap();
        assert_eq!(
            *selected_pool, pool3,
            "Should select pool with highest depth score"
        );
    }

    #[test]
    fn test_stable_swap_preference_with_depth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let xlm_token = Address::generate(&env);

        let contract_id = env.register_contract(None, SwapRouter);
        let client = SwapRouterClient::new(&env, &contract_id);
        client.initialize(&admin, &treasury, &xlm_token);

        let token_a = Address::generate(&env);
        let token_b = Address::generate(&env);

        // Regular pool with high depth
        let regular_pool = Address::generate(&env);
        client.add_pool(&admin, &regular_pool, &token_a, &token_b, 30, false);
        client.update_pool_reserves(&regular_pool, 1_000_000, 1_000_000);

        // Stable swap pool with lower depth (but should still be preferred in some scenarios)
        let stable_pool = Address::generate(&env);
        client.add_pool(&admin, &stable_pool, &token_a, &token_b, 5, true); // Lower fee, stable
        client.update_pool_reserves(&stable_pool, 500_000, 500_000);

        let regular_info = client.get_pool(&regular_pool).unwrap();
        let stable_info = client.get_pool(&stable_pool).unwrap();

        // Regular pool has higher depth score
        assert!(
            regular_info.depth_score > stable_info.depth_score,
            "Regular pool should have higher depth score"
        );

        // Current implementation selects based on depth score only
        // In production, you might want to factor in stable_swap flag as well
        let quote = client.get_quote(&token_a, &token_b, 1000, None);
        let selected_pool = quote.path.pools.get(0).unwrap();
        assert_eq!(
            *selected_pool, regular_pool,
            "Should select pool with higher depth score"
        );
    }
}
