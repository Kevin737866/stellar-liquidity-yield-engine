use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::token::{StellarAssetClient, TokenClient};
use soroban_sdk::{Address, Env, Symbol};
use stellar_liquidity_yield_engine::{YieldVault, YieldVaultClient};

mod testutils;

use testutils::setup_yield_vault;

/// Deploy a vault with zero fees so boundary share/amount math can be verified
/// without fee rounding obscuring 1-unit edge cases.
fn setup_zero_fee_vault<'a>(
    env: &'a Env,
) -> (
    YieldVaultClient<'a>,
    TokenClient<'a>,
    TokenClient<'a>,
    StellarAssetClient<'a>,
    StellarAssetClient<'a>,
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
        &Symbol::new(env, "BoundVault"),
        &token_a.address(),
        &token_b.address(),
        &pool_id,
        &1,
        &0,
        &0,
        &0,
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
    )
}

fn advance_past_timelock(env: &Env, vault: &YieldVaultClient) {
    let delay = vault.get_timelock_delay();
    env.ledger().with_mut(|li| {
        li.timestamp = li.timestamp.saturating_add(delay);
    });
}

// ---------------------------------------------------------------------------
// Zero token amount boundaries
// ---------------------------------------------------------------------------

#[test]
fn test_zero_deposit_both_legs_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let fixture = setup_yield_vault(&env);

    let result = fixture.vault.try_deposit(&fixture.user, &0, &0, &0);
    assert!(result.is_err(), "deposit(0, 0) must be rejected");

    let metrics = fixture.vault.get_metrics();
    assert_eq!(metrics.total_shares, 0);
    assert_eq!(metrics.total_amount_a, 0);
    assert_eq!(metrics.total_amount_b, 0);
}

#[test]
fn test_single_leg_zero_deposit_succeeds_with_default_minimum() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let fixture = setup_yield_vault(&env);

    fixture.token_a_admin.mint(&fixture.user, &100);
    fixture.token_b_admin.mint(&fixture.user, &100);

    let shares_b = fixture.vault.deposit(&fixture.user, &0, &100, &0);
    assert_eq!(shares_b, 100);

    let shares_a = fixture.vault.deposit(&fixture.user, &100, &0, &0);
    assert_eq!(shares_a, 100);

    let metrics = fixture.vault.get_metrics();
    assert_eq!(metrics.total_shares, 200);
    assert_eq!(metrics.total_amount_a, 100);
    assert_eq!(metrics.total_amount_b, 100);
}

#[test]
fn test_single_leg_zero_deposit_rejected_when_min_positive() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let fixture = setup_yield_vault(&env);

    let action_id = fixture
        .vault
        .propose_set_min_deposit_amounts(&fixture.admin, &10, &10);
    advance_past_timelock(&env, &fixture.vault);
    fixture
        .vault
        .execute_pending_action(&fixture.admin, &action_id);

    fixture.token_a_admin.mint(&fixture.user, &100);
    fixture.token_b_admin.mint(&fixture.user, &100);

    assert!(
        fixture
            .vault
            .try_deposit(&fixture.user, &0, &100, &0)
            .is_err(),
        "zero token_a leg must fail when min_a > 0"
    );
    assert!(
        fixture
            .vault
            .try_deposit(&fixture.user, &100, &0, &0)
            .is_err(),
        "zero token_b leg must fail when min_b > 0"
    );
    assert_eq!(fixture.token_a.balance(&fixture.user), 100);
    assert_eq!(fixture.token_b.balance(&fixture.user), 100);
}

#[test]
fn test_negative_deposit_amounts_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let fixture = setup_yield_vault(&env);

    fixture.token_a_admin.mint(&fixture.user, &100);
    fixture.token_b_admin.mint(&fixture.user, &100);

    assert!(
        fixture
            .vault
            .try_deposit(&fixture.user, &-1, &100, &0)
            .is_err(),
        "negative amount_a must be rejected"
    );
    assert!(
        fixture
            .vault
            .try_deposit(&fixture.user, &100, &-1, &0)
            .is_err(),
        "negative amount_b must be rejected"
    );
    assert_eq!(fixture.token_a.balance(&fixture.user), 100);
    assert_eq!(fixture.token_b.balance(&fixture.user), 100);
}

#[test]
fn test_zero_withdraw_shares_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let fixture = setup_yield_vault(&env);

    fixture.token_a_admin.mint(&fixture.user, &100);
    fixture.token_b_admin.mint(&fixture.user, &100);
    fixture.vault.deposit(&fixture.user, &100, &100, &0);

    assert!(
        fixture
            .vault
            .try_withdraw(&fixture.user, &0, &0, &0)
            .is_err(),
        "withdraw(0 shares) must be rejected"
    );
    assert_eq!(fixture.vault.get_user_position(&fixture.user).shares, 200);
}

#[test]
fn test_negative_min_deposit_and_zero_min_withdraw_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let fixture = setup_yield_vault(&env);

    assert!(
        fixture
            .vault
            .try_propose_set_min_deposit_amounts(&fixture.admin, &-1, &0)
            .is_err(),
        "negative min_deposit_a must be rejected"
    );
    assert!(
        fixture
            .vault
            .try_propose_set_min_deposit_amounts(&fixture.admin, &0, &-1)
            .is_err(),
        "negative min_deposit_b must be rejected"
    );
    assert!(
        fixture
            .vault
            .try_propose_set_min_withdraw_shares(&fixture.admin, &0)
            .is_err(),
        "zero min_withdraw_shares must be rejected"
    );
}

// ---------------------------------------------------------------------------
// Minimum token amount boundaries
// ---------------------------------------------------------------------------

#[test]
fn test_minimum_one_unit_deposit_and_full_withdraw_round_trip() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, token_a, token_b, token_a_admin, _token_b_admin, user, _admin) =
        setup_zero_fee_vault(&env);

    token_a_admin.mint(&user, &1);
    let shares = vault.deposit(&user, &1, &0, &1);
    assert_eq!(shares, 1);
    assert_eq!(token_a.balance(&user), 0);

    let (withdrawn_a, withdrawn_b) = vault.withdraw(&user, &1, &1, &0);
    assert_eq!(withdrawn_a, 1);
    assert_eq!(withdrawn_b, 0);
    assert_eq!(token_a.balance(&user), 1);
    assert_eq!(token_b.balance(&user), 0);

    let metrics = vault.get_metrics();
    assert_eq!(metrics.total_shares, 0);
    assert_eq!(metrics.total_amount_a, 0);
    assert_eq!(metrics.total_amount_b, 0);
}

#[test]
fn test_configured_min_deposit_exact_boundary() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let fixture = setup_yield_vault(&env);

    let action_id = fixture
        .vault
        .propose_set_min_deposit_amounts(&fixture.admin, &100, &50);
    advance_past_timelock(&env, &fixture.vault);
    fixture
        .vault
        .execute_pending_action(&fixture.admin, &action_id);
    assert_eq!(fixture.vault.get_min_deposit_amounts(), (100, 50));

    fixture.token_a_admin.mint(&fixture.user, &200);
    fixture.token_b_admin.mint(&fixture.user, &200);

    // One unit below either minimum must fail
    assert!(
        fixture
            .vault
            .try_deposit(&fixture.user, &99, &50, &0)
            .is_err(),
        "amount_a == min_a - 1 must fail"
    );
    assert!(
        fixture
            .vault
            .try_deposit(&fixture.user, &100, &49, &0)
            .is_err(),
        "amount_b == min_b - 1 must fail"
    );

    // Exact minimum on both legs succeeds
    let shares = fixture.vault.deposit(&fixture.user, &100, &50, &150);
    assert_eq!(shares, 150);
}

#[test]
fn test_configured_min_withdraw_shares_exact_boundary() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, _token_a, _token_b, token_a_admin, token_b_admin, user, admin) =
        setup_zero_fee_vault(&env);

    let action_id = vault.propose_set_min_withdraw_shares(&admin, &10);
    advance_past_timelock(&env, &vault);
    vault.execute_pending_action(&admin, &action_id);
    assert_eq!(vault.get_min_withdraw_shares(), 10);

    token_a_admin.mint(&user, &100);
    token_b_admin.mint(&user, &100);
    vault.deposit(&user, &100, &100, &0);

    // One share below configured minimum must fail
    assert!(
        vault.try_withdraw(&user, &9, &0, &0).is_err(),
        "shares == min_withdraw_shares - 1 must fail"
    );

    // Exact minimum succeeds
    let (withdrawn_a, withdrawn_b) = vault.withdraw(&user, &10, &0, &0);
    assert_eq!(withdrawn_a, 10);
    assert_eq!(withdrawn_b, 10);
    assert_eq!(vault.get_user_position(&user).shares, 190);
}

#[test]
fn test_partial_withdraw_rounding_to_zero_rejected() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, _token_a, _token_b, token_a_admin, token_b_admin, user, _admin) =
        setup_zero_fee_vault(&env);

    // 1000 A + 1000 B -> 2000 shares.
    // Withdrawing 1 share yields floor(1 * 1000 / 2000) == 0 for both legs.
    token_a_admin.mint(&user, &1000);
    token_b_admin.mint(&user, &1000);
    vault.deposit(&user, &1000, &1000, &0);

    assert!(
        vault.try_withdraw(&user, &1, &0, &0).is_err(),
        "partial withdrawal redeeming 0 tokens must be rejected"
    );
    assert_eq!(vault.get_user_position(&user).shares, 2000);
}

// ---------------------------------------------------------------------------
// Maximum token amount boundaries
// ---------------------------------------------------------------------------

#[test]
fn test_max_i128_single_leg_deposit_and_partial_withdraw_succeed() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, token_a, _token_b, token_a_admin, _token_b_admin, user, _admin) =
        setup_zero_fee_vault(&env);

    token_a_admin.mint(&user, &i128::MAX);
    let shares = vault.deposit(&user, &i128::MAX, &0, &0);
    assert_eq!(shares, i128::MAX);
    assert_eq!(token_a.balance(&user), 0);

    let metrics = vault.get_metrics();
    assert_eq!(metrics.total_shares, i128::MAX);
    assert_eq!(metrics.total_amount_a, i128::MAX);
    assert_eq!(metrics.total_amount_b, 0);
    assert_eq!(metrics.tvl, i128::MAX);

    // Partial withdrawal of 1 share: 1 * i128::MAX / i128::MAX == 1
    let (withdrawn_a, withdrawn_b) = vault.withdraw(&user, &1, &1, &0);
    assert_eq!(withdrawn_a, 1);
    assert_eq!(withdrawn_b, 0);
    assert_eq!(token_a.balance(&user), 1);
    assert_eq!(vault.get_metrics().total_shares, i128::MAX - 1);
}

#[test]
fn test_deposit_combined_exceeding_i128_max_fails_atomically() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, token_a, token_b, token_a_admin, token_b_admin, user, _admin) =
        setup_zero_fee_vault(&env);

    token_a_admin.mint(&user, &i128::MAX);
    token_b_admin.mint(&user, &1);

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.deposit(&user, &i128::MAX, &1, &0);
    }));
    assert!(
        result.is_err(),
        "combined deposit > i128::MAX must panic on overflow"
    );

    // Balances and vault metrics must remain untouched
    assert_eq!(token_a.balance(&user), i128::MAX);
    assert_eq!(token_b.balance(&user), 1);
    assert_eq!(vault.get_metrics().total_shares, 0);
}

#[test]
fn test_deposit_pushing_total_shares_over_i128_max_fails_atomically() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, token_a, _token_b, token_a_admin, _token_b_admin, user1, _admin) =
        setup_zero_fee_vault(&env);
    let user2 = Address::generate(&env);

    token_a_admin.mint(&user1, &i128::MAX);
    vault.deposit(&user1, &i128::MAX, &0, &0);

    token_a_admin.mint(&user2, &1);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.deposit(&user2, &1, &0, &0);
    }));
    assert!(
        result.is_err(),
        "subsequent deposit exceeding i128::MAX total_shares must fail"
    );

    assert_eq!(token_a.balance(&user2), 1);
    assert_eq!(vault.get_metrics().total_shares, i128::MAX);
    assert_eq!(vault.get_user_position(&user2).shares, 0);
}

#[test]
fn test_withdraw_overflow_on_max_shares_fails_atomically() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, token_a, _token_b, token_a_admin, _token_b_admin, user, _admin) =
        setup_zero_fee_vault(&env);

    token_a_admin.mint(&user, &i128::MAX);
    vault.deposit(&user, &i128::MAX, &0, &0);

    // shares * total_amount_a overflows i128 when both are i128::MAX
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        vault.withdraw(&user, &i128::MAX, &0, &0);
    }));
    assert!(
        result.is_err(),
        "withdraw(i128::MAX) when total_amount_a == i128::MAX must fail cleanly"
    );

    assert_eq!(token_a.balance(&user), 0);
    assert_eq!(vault.get_metrics().total_shares, i128::MAX);
}
