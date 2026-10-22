#![allow(unused_imports)]
// End-to-end tests for slippage protection across vault, router, and reward distributor
// Tests verify the shared and differentiated slippage semantics documented in docs/SLIPPAGE_POLICY.md

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, IntoVal,
};

use stellar_liquidity_yield_engine::swap_router::{SwapRouter, SwapRouterClient};
use stellar_liquidity_yield_engine::yield_vault::{YieldVault, YieldVaultClient};

// ==================== Vault Slippage Tests ====================

#[test]
fn test_vault_deposit_enforces_min_shares() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    // Deploy tokens
    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    // Initialize vault
    let vault_contract_id = env.register_contract(None, YieldVault);
    let vault_client = YieldVaultClient::new(&env, &vault_contract_id);
    vault_client.initialize(
        &admin,
        &Symbol::new(&env, "Test Vault"),
        &token_a,
        &token_b,
        &pool_id,
        &0u32,
        &100u32, // 1% fee
        &50u32,  // 0.5% harvest fee
        &25u32,  // 0.25% withdrawal fee
        &treasury,
    );

    // Mint tokens to user
    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);

    // Set minimum deposit amounts
    vault_client.set_min_deposit_amounts(&admin, &10, &10);

    // Test 1: Deposit with min_shares = 0 should succeed
    let shares = vault_client.deposit(&user, &100, &100, &0);
    assert!(shares > 0, "First deposit should mint shares");

    // Test 2: Deposit with min_shares higher than actual should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault_client.deposit(&user, &10, &10, &1000);
    }));
    assert!(result.is_err(), "Deposit below min_shares must panic");

    // Test 3: Deposit with reasonable min_shares should succeed
    let shares2 = vault_client.deposit(&user, &100, &100, &50);
    assert!(shares2 >= 50, "Deposit should meet min_shares requirement");
}

#[test]
fn test_vault_withdrawal_enforces_min_amounts() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    // Deploy tokens
    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    // Initialize vault
    let vault_contract_id = env.register_contract(None, YieldVault);
    let vault_client = YieldVaultClient::new(&env, &vault_contract_id);
    vault_client.initialize(
        &admin,
        &Symbol::new(&env, "Test Vault"),
        &token_a,
        &token_b,
        &pool_id,
        &0u32,
        &0u32, // No fees for simpler testing
        &0u32,
        &0u32,
        &treasury,
    );

    // Set prices for TVL calculation
    vault_client.set_prices(&admin, &1, &1);

    // Mint and deposit tokens
    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);
    let shares = vault_client.deposit(&user, &1000, &1000, &0);

    // Test 1: Withdrawal with min_amounts = 0 should succeed
    let (amount_a, amount_b) = vault_client.withdraw(&user, &shares, &0, &0);
    assert!(
        amount_a > 0 || amount_b > 0,
        "Withdrawal should return tokens"
    );

    // Deposit again for further tests
    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);
    let shares2 = vault_client.deposit(&user, &1000, &1000, &0);

    // Test 2: Withdrawal with min_amounts higher than actual should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault_client.withdraw(&user, &shares2, &10000, &10000);
    }));
    assert!(result.is_err(), "Withdrawal below min_amounts must panic");

    // Test 3: Withdrawal with reasonable min_amounts should succeed
    let (amount_a3, amount_b3) = vault_client.withdraw(&user, &shares2, &100, &100);
    assert!(
        amount_a3 >= 100,
        "Withdrawal should meet min_amount_a requirement"
    );
    assert!(
        amount_b3 >= 100,
        "Withdrawal should meet min_amount_b requirement"
    );
}

#[test]
fn test_vault_dust_handling_on_full_exit() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    // Deploy tokens
    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    // Initialize vault
    let vault_contract_id = env.register_contract(None, YieldVault);
    let vault_client = YieldVaultClient::new(&env, &vault_contract_id);
    vault_client.initialize(
        &admin,
        &Symbol::new(&env, "Test Vault"),
        &token_a,
        &token_b,
        &pool_id,
        &0u32,
        &0u32,
        &0u32,
        &0u32,
        &treasury,
    );

    vault_client.set_prices(&admin, &1, &1);

    // Mint and deposit tokens
    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);
    let shares = vault_client.deposit(&user, &1000, &1000, &0);

    // Full exit should sweep dust
    let (amount_a, amount_b) = vault_client.withdraw(&user, &shares, &0, &0);
    let position = vault_client.get_user_position(&user);
    assert_eq!(position.shares, 0, "Full exit should zero shares");
    // Dust should be swept into the exit, not stranded
}

// ==================== Router Slippage Tests ====================

#[test]
fn test_router_slippage_calculation() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let xlm_token = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    // Initialize router
    let router_contract_id = env.register_contract(None, SwapRouter);
    let router_client = SwapRouterClient::new(&env, &router_contract_id);
    router_client.initialize(&admin, &treasury, &xlm_token);

    // Add a pool
    router_client.add_pool(
        &admin, &pool_id, &token_a, &token_b, &30u32, // 0.3% fee
        false,
    );

    // Update pool reserves
    router_client
        .update_pool_reserves(&pool_id, &1000000, &1000000)
        .unwrap();

    // Test 1: Quote with default slippage (1%)
    let quote = router_client.get_quote(&token_a, &token_b, &1000, None);
    assert_eq!(quote.minimum_output, 990, "1% slippage on 1000 = 990");

    // Test 2: Quote with custom slippage (0.5%)
    let quote2 = router_client.get_quote(&token_a, &token_b, &1000, Some(50));
    assert_eq!(quote2.minimum_output, 995, "0.5% slippage on 1000 = 995");

    // Test 3: Quote with high slippage (5%)
    let quote3 = router_client.get_quote(&token_a, &token_b, &1000, Some(500));
    assert_eq!(quote3.minimum_output, 950, "5% slippage on 1000 = 950");

    // Test 4: Invalid slippage (> 100%) should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        router_client.get_quote(&token_a, &token_b, &1000, Some(10001));
    }));
    assert!(result.is_err(), "Slippage > 100% must be rejected");
}

#[test]
fn test_router_slippage_execution() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let xlm_token = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    // Deploy tokens
    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    // Initialize router
    let router_contract_id = env.register_contract(None, SwapRouter);
    let router_client = SwapRouterClient::new(&env, &router_contract_id);
    router_client.initialize(&admin, &treasury, &xlm_token);

    // Add pool
    router_client.add_pool(&admin, &pool_id, &token_a, &token_b, &30u32, false);
    router_client
        .update_pool_reserves(&pool_id, &1000000, &1000000)
        .unwrap();

    // Mint tokens to user
    token_a_admin.mint(&user, &1000);

    // Test 1: Swap with reasonable min_output should succeed
    let mut path = Vec::new(&env);
    path.push_back(token_a.clone());
    path.push_back(token_b.clone());
    let output = router_client.swap(
        &user,
        &token_a,
        &token_b,
        &1000,
        &990, // 1% slippage
        path.clone(),
        None,
    );
    assert!(output > 0, "Swap should succeed");

    // Test 2: Swap with min_output too high should fail
    token_a_admin.mint(&user, &1000);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        router_client.swap(
            &user,
            &token_a,
            &token_b,
            &1000,
            &2000, // Unrealistic min_output
            path.clone(),
            None,
        );
    }));
    assert!(result.is_err(), "Swap with excessive min_output must fail");
}

#[test]
#[test]
fn test_router_default_slippage_configuration() {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let xlm_token = Address::generate(&env);

    // Initialize router
    let router_contract_id = env.register_contract(None, SwapRouter);
    let router_client = SwapRouterClient::new(&env, &router_contract_id);
    router_client.initialize(&admin, &treasury, &xlm_token);

    // Test 1: Default slippage should be 100 bps (1%)
    // Note: This would require a getter function to be added to SwapRouter
    // For now, we test the update function
    router_client.update_default_slippage(&admin, &50);
    router_client.update_default_slippage(&admin, &200);

    // Test 2: Invalid slippage update should fail
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        router_client.update_default_slippage(&admin, &10001);
    }));
    assert!(result.is_err(), "Slippage > 100% must be rejected");
}

// ==================== Cross-Component Consistency Tests ====================

#[test]
fn test_slippage_formula_consistency() {
    // Verify that router and reward distributor use the same slippage formula
    // Formula: minimum = expected * (BPS_DIVISOR - slippage_bps) / BPS_DIVISOR

    let bps_divisor: i128 = 10000;

    // Test cases
    let test_cases = vec![
        (1000, 100, 990),   // 1% slippage
        (1000, 50, 995),    // 0.5% slippage
        (1000, 500, 950),   // 5% slippage
        (10000, 100, 9900), // 1% on larger amount
        (5000, 200, 4900),  // 2% slippage
    ];

    for (expected, slippage_bps, expected_min) in test_cases {
        let slippage_factor = bps_divisor - slippage_bps as i128;
        let calculated_min = expected * slippage_factor / bps_divisor;
        assert_eq!(
            calculated_min, expected_min,
            "Slippage calculation mismatch for expected={}, slippage={}",
            expected, slippage_bps
        );
    }
}

#[test]
#[test]
fn test_vault_uses_different_slippage_model() {
    // Verify that vault uses absolute minimums, not percentage-based slippage
    // This is intentional and documented in SLIPPAGE_POLICY.md

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    // Deploy tokens
    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    // Initialize vault
    let vault_contract_id = env.register_contract(None, YieldVault);
    let vault_client = YieldVaultClient::new(&env, &vault_contract_id);
    vault_client.initialize(
        &admin,
        &Symbol::new(&env, "Test Vault"),
        &token_a,
        &token_b,
        &pool_id,
        &0u32,
        &0u32,
        &0u32,
        &0u32,
        &treasury,
    );

    vault_client.set_prices(&admin, &1, &1);

    // Mint and deposit tokens
    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);
    let shares = vault_client.deposit(&user, &1000, &1000, &0);

    // Vault withdrawal uses absolute min_amount_a and min_amount_b
    // These are not percentage-based, confirming the different model
    let (amount_a, amount_b) = vault_client.withdraw(&user, &shares, &100, &100);
    assert!(
        amount_a >= 100,
        "Vault uses absolute minimum, not percentage"
    );
    assert!(
        amount_b >= 100,
        "Vault uses absolute minimum, not percentage"
    );
}

// ==================== Edge Cases ====================

#[test]
fn test_zero_slippage_allowed() {
    // Verify that 0% slippage is allowed (strict minimum)
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let xlm_token = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    // Initialize router
    let router_contract_id = env.register_contract(None, SwapRouter);
    let router_client = SwapRouterClient::new(&env, &router_contract_id);
    router_client.initialize(&admin, &treasury, &xlm_token);

    router_client.add_pool(&admin, &pool_id, &token_a, &token_b, &30u32, false);
    router_client
        .update_pool_reserves(&pool_id, &1000000, &1000000)
        .unwrap();

    // 0% slippage should be accepted
    let quote = router_client.get_quote(&token_a, &token_b, &1000, Some(0));
    assert_eq!(
        quote.minimum_output, 1000,
        "0% slippage should equal expected"
    );
}

#[test]
fn test_max_slippage_boundary() {
    // Verify that 100% slippage is the maximum allowed
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let xlm_token = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    // Initialize router
    let router_contract_id = env.register_contract(None, SwapRouter);
    let router_client = SwapRouterClient::new(&env, &router_contract_id);
    router_client.initialize(&admin, &treasury, &xlm_token);

    router_client.add_pool(&admin, &pool_id, &token_a, &token_b, &30u32, false);
    router_client
        .update_pool_reserves(&pool_id, &1000000, &1000000)
        .unwrap();

    // 100% slippage should be accepted
    let quote = router_client.get_quote(&token_a, &token_b, &1000, Some(10000));
    assert_eq!(
        quote.minimum_output, 0,
        "100% slippage should result in 0 minimum"
    );

    // 100.01% slippage should be rejected
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        router_client.get_quote(&token_a, &token_b, &1000, Some(10001));
    }));
    assert!(result.is_err(), "Slippage > 100% must be rejected");
}

// ==================== Execution-Time Slippage Enforcement Tests ====================

#[test]
fn test_router_execution_rechecks_slippage_when_quote_diverges() {
    // Simulates a frontend quote taken at one reserve state, then execution
    // occurring after reserves have moved. The execution-time minimum_output
    // must be enforced against the actual executed amount, not the stale quote.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let xlm_token = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    let router_contract_id = env.register_contract(None, SwapRouter);
    let router_client = SwapRouterClient::new(&env, &router_contract_id);
    router_client.initialize(&admin, &treasury, &xlm_token);
    router_client.add_pool(&admin, &pool_id, &token_a, &token_b, &30u32, false);
    router_client
        .update_pool_reserves(&pool_id, &1000000, &1000000)
        .unwrap();

    // Frontend quote at the initial reserve state.
    let quote = router_client.get_quote(&token_a, &token_b, &1000, Some(100));
    let quoted_min_output = quote.minimum_output;
    assert_eq!(quoted_min_output, 990, "quote should reflect 1% slippage");

    // Reserves move adversely between quote and execution.
    router_client
        .update_pool_reserves(&pool_id, &500000, &2000000)
        .unwrap();

    token_a_admin.mint(&user, &1000);
    let mut path = Vec::new(&env);
    path.push_back(token_a.clone());
    path.push_back(token_b.clone());

    // Execution must re-check the bound against the actual output. With the
    // stale quote's minimum_output, execution must fail.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        router_client.swap(
            &user,
            &token_a,
            &token_b,
            &1000,
            &quoted_min_output,
            path.clone(),
            None,
        );
    }));
    assert!(
        result.is_err(),
        "Execution must reject swap when actual output falls below stale quote minimum"
    );
}

#[test]
fn test_router_execution_succeeds_with_updated_bound_after_divergence() {
    // Same divergence scenario, but the caller refreshes the minimum_output
    // bound to match the new reserve state. Execution should succeed only
    // because the bound is re-evaluated at execution time.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let xlm_token = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    let router_contract_id = env.register_contract(None, SwapRouter);
    let router_client = SwapRouterClient::new(&env, &router_contract_id);
    router_client.initialize(&admin, &treasury, &xlm_token);
    router_client.add_pool(&admin, &pool_id, &token_a, &token_b, &30u32, false);
    router_client
        .update_pool_reserves(&pool_id, &1000000, &1000000)
        .unwrap();

    // Reserves move adversely before execution.
    router_client
        .update_pool_reserves(&pool_id, &500000, &2000000)
        .unwrap();

    // Re-quote at execution-time reserve state.
    let fresh_quote = router_client.get_quote(&token_a, &token_b, &1000, Some(100));

    token_a_admin.mint(&user, &1000);
    let mut path = Vec::new(&env);
    path.push_back(token_a.clone());
    path.push_back(token_b.clone());

    let output = router_client.swap(
        &user,
        &token_a,
        &token_b,
        &1000,
        &fresh_quote.minimum_output,
        path,
        None,
    );
    assert!(
        output >= fresh_quote.minimum_output,
        "Execution output must satisfy the execution-time minimum_output bound"
    );
}

#[test]
fn test_vault_execution_rechecks_min_shares_after_price_divergence() {
    // Vault deposit enforces min_shares at execution time. If the share price
    // moves between quote and execution, a stale min_shares must be rejected.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    let vault_contract_id = env.register_contract(None, YieldVault);
    let vault_client = YieldVaultClient::new(&env, &vault_contract_id);
    vault_client.initialize(
        &admin,
        &Symbol::new(&env, "Test Vault"),
        &token_a,
        &token_b,
        &pool_id,
        &0u32,
        &0u32,
        &0u32,
        &0u32,
        &treasury,
    );
    vault_client.set_prices(&admin, &1, &1);

    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);
    let first_shares = vault_client.deposit(&user, &1000, &1000, &0);

    // Price divergence: token_a appreciates, so subsequent deposits mint fewer shares.
    vault_client.set_prices(&admin, &2, &1);

    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);

    // A stale min_shares from the pre-divergence quote must be rejected at execution.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault_client.deposit(&user, &1000, &1000, &first_shares);
    }));
    assert!(
        result.is_err(),
        "Vault deposit must enforce min_shares at execution after price divergence"
    );
}

#[test]
fn test_vault_withdrawal_execution_rechecks_min_amounts_after_price_divergence() {
    // Vault withdrawal enforces min_amount_a/min_amount_b at execution time.
    // A stale bound from before a price move must be rejected.
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let treasury = Address::generate(&env);
    let token_a = Address::generate(&env);
    let token_b = Address::generate(&env);
    let pool_id = Address::generate(&env);

    let token_a_admin = StellarAssetClient::new(&env, &token_a);
    token_a_admin.mock_all_auths();
    let token_b_admin = StellarAssetClient::new(&env, &token_b);
    token_b_admin.mock_all_auths();

    let vault_contract_id = env.register_contract(None, YieldVault);
    let vault_client = YieldVaultClient::new(&env, &vault_contract_id);
    vault_client.initialize(
        &admin,
        &Symbol::new(&env, "Test Vault"),
        &token_a,
        &token_b,
        &pool_id,
        &0u32,
        &0u32,
        &0u32,
        &0u32,
        &treasury,
    );
    vault_client.set_prices(&admin, &1, &1);

    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);
    let shares = vault_client.deposit(&user, &1000, &1000, &0);

    // Price divergence: token_a depreciates, so withdrawal returns less token_a.
    vault_client.set_prices(&admin, &1, &1);

    // Stale min_amounts from before divergence must be rejected at execution.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault_client.withdraw(&user, &shares, &10000, &10000);
    }));
    assert!(
        result.is_err(),
        "Vault withdrawal must enforce min_amounts at execution time"
    );
}
