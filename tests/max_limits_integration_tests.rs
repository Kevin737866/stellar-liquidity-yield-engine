//! Integration tests for contract behaviour at maximum configured limits
//! (Issue #514).
//!
//! Each test drives a contract at the largest value its configuration accepts,
//! asserts the resulting behaviour, and then checks that one unit past that
//! boundary is rejected. The limits covered are:
//!
//! * reward distributor: `MAX_REWARD_STREAMS` concurrent streams;
//! * yield vault: 100% withdrawal pacing (`10000` bps) per window;
//! * rebalance engine: `10000` bps slippage cap, `MAX_APY_BPS` oracle input,
//!   and a single allocation of `10000` bps;
//! * actuary: `MAX_PREMIUM_MULTIPLIER_BPS` premium cap and the accepted range
//!   of governance pricing parameters.

use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{Address, Env, Symbol, Vec};

use stellar_liquidity_yield_engine::{
    Actuary, ActuaryClient, ActuaryError, MultiRewardDistributor, MultiRewardDistributorClient,
    PoolAllocation, PricingParams, RebalanceEngine, RebalanceEngineClient, RebalanceError,
    RewardError, YieldVault, YieldVaultClient, MAX_APY_BPS, MAX_PREMIUM_MULTIPLIER_BPS,
    MAX_REWARD_STREAMS,
};

// ==================== Reward distributor: stream limit ====================

fn setup_distributor(env: &Env) -> (MultiRewardDistributorClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(MultiRewardDistributor, ());
    let client = MultiRewardDistributorClient::new(env, &contract_id);
    client.initialize(&admin, &Address::generate(env), &Address::generate(env));
    (client, admin)
}

#[test]
fn test_reward_distributor_accepts_maximum_streams() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin) = setup_distributor(&env);

    // Every slot up to the configured maximum is usable.
    for index in 0..MAX_REWARD_STREAMS {
        let added =
            client.add_reward_stream(&admin, &Address::generate(&env), &1_000i128, &7u32, &0u64);
        assert_eq!(added, index, "streams are indexed in insertion order");
    }

    let streams = client.get_all_streams();
    assert_eq!(streams.len(), MAX_REWARD_STREAMS);
    assert!(streams
        .iter()
        .all(|stream| stream.is_active && stream.rate_per_second == 1_000));
}

#[test]
fn test_reward_distributor_rejects_stream_past_maximum() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin) = setup_distributor(&env);

    for _ in 0..MAX_REWARD_STREAMS {
        client.add_reward_stream(&admin, &Address::generate(&env), &1_000i128, &7u32, &0u64);
    }

    let err = client
        .try_add_reward_stream(&admin, &Address::generate(&env), &1_000i128, &7u32, &0u64)
        .unwrap_err()
        .unwrap();

    assert_eq!(err, RewardError::StreamLimitExceeded.into());
    assert_eq!(client.get_all_streams().len(), MAX_REWARD_STREAMS);
}

// ==================== Yield vault: withdrawal pacing ====================

/// Deploy a vault over two real SAC tokens and return the actors a test needs.
fn setup_vault<'a>(
    env: &'a Env,
) -> (
    YieldVaultClient<'a>,
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
    let token_a_admin = StellarAssetClient::new(env, &token_a.address());
    let token_b_admin = StellarAssetClient::new(env, &token_b.address());

    let contract_id = env.register(YieldVault, ());
    let vault = YieldVaultClient::new(env, &contract_id);
    vault.initialize(
        &admin,
        &Symbol::new(env, "MaxLimitVault"),
        &token_a.address(),
        &token_b.address(),
        &Address::generate(env),
        &1,
        &100,
        &50,
        &25,
        &treasury,
    );

    (vault, token_a_admin, token_b_admin, user, admin)
}

#[test]
fn test_vault_full_withdrawal_pacing_admits_a_complete_exit() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, token_a_admin, token_b_admin, user, admin) = setup_vault(&env);

    // 100% per user and per vault is the largest pacing configuration.
    vault.set_withdraw_pacing(&admin, &10_000, &10_000, &3_600);

    let pacing = vault.get_withdraw_pacing();
    assert_eq!(pacing.user_max_bps, 10_000);
    assert_eq!(pacing.vault_max_bps, 10_000);
    assert_eq!(pacing.window_seconds, 3_600);

    let amount = 1_000i128;
    token_a_admin.mint(&user, &amount);
    token_b_admin.mint(&user, &amount);
    let shares = vault.deposit(&user, &amount, &amount, &0);

    let (received_a, received_b) = vault.withdraw(&user, &shares, &0, &0);

    assert!(
        received_a > 0 && received_b > 0,
        "full exit must pay both legs"
    );
    assert_eq!(vault.get_user_position(&user).shares, 0);
    assert_eq!(vault.get_metrics().total_shares, 0);
}

#[test]
fn test_vault_rejects_pacing_above_maximum() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (vault, _, _, _, admin) = setup_vault(&env);

    // One basis point past 100% is rejected for either limit.
    assert!(vault
        .try_set_withdraw_pacing(&admin, &10_001, &10_000, &3_600)
        .is_err());
    assert!(vault
        .try_set_withdraw_pacing(&admin, &10_000, &10_001, &3_600)
        .is_err());

    // Enabling pacing without a window is also rejected: the limit could never
    // be measured.
    assert!(vault
        .try_set_withdraw_pacing(&admin, &10_000, &10_000, &0)
        .is_err());

    // None of the rejected configurations were stored.
    let pacing = vault.get_withdraw_pacing();
    assert_eq!(pacing.user_max_bps, 0);
    assert_eq!(pacing.vault_max_bps, 0);
    assert_eq!(pacing.window_seconds, 0);
}

// ==================== Rebalance engine: slippage, APY, allocations ====================

fn setup_rebalance_engine(env: &Env) -> (RebalanceEngineClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(RebalanceEngine, ());
    let client = RebalanceEngineClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin)
}

#[test]
fn test_rebalance_slippage_accepts_maximum_and_rejects_over() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin) = setup_rebalance_engine(&env);

    client.set_max_slippage_bps(&admin, &10_000);
    assert_eq!(client.get_max_slippage_bps(), 10_000);

    assert!(client.try_set_max_slippage_bps(&admin, &10_001).is_err());
    assert_eq!(
        client.get_max_slippage_bps(),
        10_000,
        "a rejected update must not change the stored cap"
    );
}

#[test]
fn test_rebalance_apy_accepts_maximum_and_rejects_over() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin) = setup_rebalance_engine(&env);
    let pool = Address::generate(&env);

    client.update_pool_apy(&admin, &pool, &MAX_APY_BPS);
    assert_eq!(client.get_pool_current_apy(&pool), MAX_APY_BPS);

    let err = client
        .try_update_pool_apy(&admin, &pool, &(MAX_APY_BPS + 1))
        .unwrap_err()
        .unwrap();
    assert_eq!(err, RebalanceError::ApyOutOfRange.into());
    assert_eq!(
        client.get_pool_current_apy(&pool),
        MAX_APY_BPS,
        "a rejected observation must not replace the accepted one"
    );
}

#[test]
fn test_rebalance_allocation_accepts_full_weight_and_rejects_over() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin) = setup_rebalance_engine(&env);

    let allocation = |percent: u32| PoolAllocation {
        pool_id: Address::generate(&env),
        token_a: Address::generate(&env),
        token_b: Address::generate(&env),
        allocation_percent: percent,
        target_apy: 2_000,
        current_apy: 1_500,
        impermanent_loss_risk: 500,
    };

    let full = Vec::from_array(&env, [allocation(10_000)]);
    let strategy_id = client.create_strategy(
        &admin,
        &Symbol::new(&env, "FullWeight"),
        &1,
        &100,
        &500,
        &3_600,
        &full,
    );
    assert_eq!(
        client
            .get_current_allocations(&strategy_id)
            .get(0)
            .unwrap()
            .allocation_percent,
        10_000
    );

    let over = Vec::from_array(&env, [allocation(10_001)]);
    let err = client
        .try_create_strategy(
            &admin,
            &Symbol::new(&env, "OverWeight"),
            &1,
            &100,
            &500,
            &3_600,
            &over,
        )
        .unwrap_err()
        .unwrap();
    assert_eq!(err, RebalanceError::AllocationOutOfRange.into());
    assert_eq!(client.get_strategy_count(), 1);
}

// ==================== Actuary: premium cap and parameter bounds ====================

fn setup_actuary(env: &Env) -> (ActuaryClient<'_>, Address) {
    let admin = Address::generate(env);
    let contract_id = env.register(Actuary, ());
    let client = ActuaryClient::new(env, &contract_id);
    client.initialize(&admin);
    (client, admin)
}

#[test]
fn test_actuary_premium_is_capped_at_maximum_multiplier() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, _) = setup_actuary(&env);

    let base_premium_bps = 1_000u32;
    // A fully depleted reserve is the most stressed input the model accepts,
    // and drives the premium into its cap rather than unbounded.
    let premium = client.dynamic_pricing(&base_premium_bps, &0i128, &10_000i128);

    let cap = base_premium_bps * MAX_PREMIUM_MULTIPLIER_BPS / 10_000;
    assert_eq!(premium, cap);
    assert!(
        premium >= base_premium_bps,
        "a stressed reserve raises the premium"
    );
}

#[test]
fn test_actuary_accepts_boundary_pricing_parameters_and_rejects_over() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (client, admin) = setup_actuary(&env);

    // Both upper bounds of the governance-tunable range are inclusive.
    let max_params = PricingParams {
        base_multiplier_bps: 30_000,
        vol_sensitivity_bps: 10_000,
        correlation_discount_bps: 10_000,
        reserve_margin_bps: 5_000,
    };
    client.update_pricing_params(&admin, &max_params);
    assert_eq!(client.get_pricing_params(), max_params);

    let mut over_base = max_params.clone();
    over_base.base_multiplier_bps = 30_001;
    let err = client
        .try_update_pricing_params(&admin, &over_base)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, ActuaryError::BaseMultiplierOutOfRange.into());

    let mut over_margin = max_params.clone();
    over_margin.reserve_margin_bps = 5_001;
    let err = client
        .try_update_pricing_params(&admin, &over_margin)
        .unwrap_err()
        .unwrap();
    assert_eq!(err, ActuaryError::ReserveMarginOutOfRange.into());

    // Rejected updates leave the accepted boundary values in place.
    assert_eq!(client.get_pricing_params(), max_params);
}
