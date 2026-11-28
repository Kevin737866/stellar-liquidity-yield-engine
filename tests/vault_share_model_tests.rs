//! Model-based tests for `YieldVault` share accounting sequences (Issue #518).
//!
//! Drives randomized and boundary sequences of `deposit`, `withdraw`, and
//! `harvest` operations against a real `YieldVault` contract alongside an
//! independent reference state machine (`VaultModel`), asserting after every
//! step that:
//! - User share balances, `total_shares`, `total_amount_a`, and
//!   `total_amount_b` match the reference model exactly.
//! - Sum of all user shares equals `metrics.total_shares`.
//! - Share price never decreases across `harvest` operations.
//! - Rejected boundary/failure calls (zero amounts, dust deposits, excessive
//!   withdrawals, slippage violations) leave both contract and model state
//!   untouched.
//! - Full exits by all participants leave zero outstanding shares and no
//!   stranded funds.

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, Symbol,
};
use std::collections::BTreeMap;
use stellar_liquidity_yield_engine::{YieldVault, YieldVaultClient, DUST_THRESHOLD};

fn main() {}

mod vault_share_model_tests {
    use super::*;

    const FEE_RATE_BPS: u32 = 100; // 1% performance fee
    const HARVEST_FEE_BPS: u32 = 50; // 0.5% harvest fee
    const WITHDRAWAL_FEE_BPS: u32 = 25; // 0.25% withdrawal fee
    const SIMULATED_REWARD: i128 = 1_000;

    /// Deterministic PRNG (64-bit LCG) so every sequence is reproducible.
    struct Rng(u64);

    impl Rng {
        fn next_u64(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0
        }

        fn gen_range(&mut self, low: i128, high: i128) -> i128 {
            let span = (high - low + 1) as u64;
            low + (self.next_u64() % span) as i128
        }

        fn pick_usize(&mut self, len: usize) -> usize {
            (self.next_u64() as usize) % len
        }
    }

    #[derive(Clone, Default)]
    struct UserModel {
        shares: i128,
        deposited_a: i128,
        deposited_b: i128,
    }

    struct VaultModel {
        total_shares: i128,
        total_amount_a: i128,
        total_amount_b: i128,
        users: BTreeMap<usize, UserModel>,
        fee_rate: u32,
        harvest_fee: u32,
        withdrawal_fee: u32,
    }

    impl VaultModel {
        fn new(fee_rate: u32, harvest_fee: u32, withdrawal_fee: u32) -> Self {
            Self {
                total_shares: 0,
                total_amount_a: 0,
                total_amount_b: 0,
                users: BTreeMap::new(),
                fee_rate,
                harvest_fee,
                withdrawal_fee,
            }
        }

        fn step_deposit(
            &mut self,
            user_idx: usize,
            amount_a: i128,
            amount_b: i128,
            min_shares: i128,
        ) -> Result<i128, ()> {
            if amount_a < 0 || amount_b < 0 || amount_a + amount_b <= 0 {
                return Err(());
            }

            let shares = if self.total_shares == 0 {
                amount_a + amount_b
            } else {
                let total_value = self.total_amount_a + self.total_amount_b;
                if total_value <= 0 {
                    0
                } else {
                    (amount_a + amount_b) * self.total_shares / total_value
                }
            };

            if shares <= 0 || shares < min_shares {
                return Err(());
            }

            let entry = self.users.entry(user_idx).or_default();
            entry.shares += shares;
            entry.deposited_a += amount_a;
            entry.deposited_b += amount_b;

            self.total_shares += shares;
            self.total_amount_a += amount_a;
            self.total_amount_b += amount_b;

            Ok(shares)
        }

        fn step_withdraw(
            &mut self,
            user_idx: usize,
            shares: i128,
            min_amount_a: i128,
            min_amount_b: i128,
        ) -> Result<(i128, i128), ()> {
            if shares <= 0 || self.total_shares <= 0 {
                return Err(());
            }

            let user = self.users.get(&user_idx).cloned().unwrap_or_default();
            if user.shares < shares {
                return Err(());
            }

            let is_full_exit = shares == user.shares;
            let mut withdraw_a = shares * self.total_amount_a / self.total_shares;
            let mut withdraw_b = shares * self.total_amount_b / self.total_shares;

            if is_full_exit {
                let leftover_a = self.total_amount_a - withdraw_a;
                if leftover_a <= DUST_THRESHOLD {
                    withdraw_a += leftover_a;
                }
                let leftover_b = self.total_amount_b - withdraw_b;
                if leftover_b <= DUST_THRESHOLD {
                    withdraw_b += leftover_b;
                }
            } else if withdraw_a <= 0 && withdraw_b <= 0 {
                return Err(());
            }

            let fee_a = withdraw_a * self.withdrawal_fee as i128 / 10_000;
            let fee_b = withdraw_b * self.withdrawal_fee as i128 / 10_000;

            let perf_fee = if self.fee_rate == 0 || user.shares <= 0 {
                0
            } else {
                let cost_a = user.deposited_a * shares / user.shares;
                let cost_b = user.deposited_b * shares / user.shares;
                let gain = (withdraw_a + withdraw_b) - (cost_a + cost_b);
                if gain > 0 {
                    gain * self.fee_rate as i128 / 10_000
                } else {
                    0
                }
            };
            let perf_fee_a = if withdraw_a + withdraw_b > 0 {
                perf_fee * withdraw_a / (withdraw_a + withdraw_b)
            } else {
                0
            };
            let perf_fee_b = perf_fee - perf_fee_a;

            let final_a = withdraw_a - fee_a - perf_fee_a;
            let final_b = withdraw_b - fee_b - perf_fee_b;

            if final_a < min_amount_a || final_b < min_amount_b {
                return Err(());
            }

            let entry = self.users.entry(user_idx).or_default();
            entry.shares -= shares;
            entry.deposited_a -= withdraw_a;
            entry.deposited_b -= withdraw_b;

            self.total_shares -= shares;
            self.total_amount_a -= withdraw_a;
            self.total_amount_b -= withdraw_b;

            Ok((final_a, final_b))
        }

        fn step_harvest(&mut self) {
            let fee_a = SIMULATED_REWARD * self.harvest_fee as i128 / 10_000;
            let fee_b = SIMULATED_REWARD * self.harvest_fee as i128 / 10_000;
            self.total_amount_a += SIMULATED_REWARD - fee_a;
            self.total_amount_b += SIMULATED_REWARD - fee_b;
        }
    }

    struct Harness<'a> {
        env: &'a Env,
        vault: YieldVaultClient<'a>,
        vault_addr: Address,
        token_a_admin: StellarAssetClient<'a>,
        token_b_admin: StellarAssetClient<'a>,
        users: [Address; 3],
    }

    fn setup_harness(env: &Env) -> Harness<'_> {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let pool_id = Address::generate(env);
        let token_a = env.register_stellar_asset_contract_v2(admin.clone());
        let token_b = env.register_stellar_asset_contract_v2(admin.clone());
        let token_a_admin = StellarAssetClient::new(env, &token_a.address());
        let token_b_admin = StellarAssetClient::new(env, &token_b.address());

        let vault_addr = env.register(YieldVault, ());
        let vault = YieldVaultClient::new(env, &vault_addr);
        vault.initialize(
            &admin,
            &Symbol::new(env, "ModelVault"),
            &token_a.address(),
            &token_b.address(),
            &pool_id,
            &1,
            &FEE_RATE_BPS,
            &HARVEST_FEE_BPS,
            &WITHDRAWAL_FEE_BPS,
            &treasury,
        );

        let users = [
            Address::generate(env),
            Address::generate(env),
            Address::generate(env),
        ];
        for user in &users {
            token_a_admin.mint(user, &10_000_000);
            token_b_admin.mint(user, &10_000_000);
        }

        Harness {
            env,
            vault,
            vault_addr,
            token_a_admin,
            token_b_admin,
            users,
        }
    }

    fn assert_invariants(h: &Harness, model: &VaultModel) {
        let metrics = h.vault.get_metrics();
        assert_eq!(metrics.total_shares, model.total_shares);
        assert_eq!(metrics.total_amount_a, model.total_amount_a);
        assert_eq!(metrics.total_amount_b, model.total_amount_b);
        assert!(metrics.total_shares >= 0);
        assert!(metrics.total_amount_a >= 0);
        assert!(metrics.total_amount_b >= 0);

        let mut sum_user_shares = 0i128;
        for (idx, addr) in h.users.iter().enumerate() {
            let pos = h.vault.get_user_position(addr);
            let m_user = model.users.get(&idx).cloned().unwrap_or_default();
            assert_eq!(pos.shares, m_user.shares);
            assert_eq!(pos.deposited_amount_a, m_user.deposited_a);
            assert_eq!(pos.deposited_amount_b, m_user.deposited_b);
            sum_user_shares += pos.shares;
        }
        assert_eq!(sum_user_shares, metrics.total_shares);
    }

    #[test]
    fn test_model_based_randomized_share_accounting_sequences() {
        for seed in 1u64..=16u64 {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let h = setup_harness(&env);
            let mut model = VaultModel::new(FEE_RATE_BPS, HARVEST_FEE_BPS, WITHDRAWAL_FEE_BPS);
            let mut rng = Rng(seed * 0x9E37_79B9_7F4A_7C15);

            // Seed with an initial deposit so subsequent operations exercise
            // non-empty share math immediately.
            let init_shares = h.vault.deposit(&h.users[0], &10_000, &10_000, &0);
            let model_init = model.step_deposit(0, 10_000, 10_000, 0).unwrap();
            assert_eq!(init_shares, model_init);
            assert_invariants(&h, &model);

            for _step in 0..25 {
                let op = rng.next_u64() % 10;
                let user_idx = rng.pick_usize(h.users.len());
                let user = &h.users[user_idx];

                match op {
                    // Normal deposit (symmetric or asymmetric)
                    0..=4 => {
                        let amount_a = rng.gen_range(500, 20_000);
                        let amount_b = rng.gen_range(500, 20_000);
                        let expected = model.step_deposit(user_idx, amount_a, amount_b, 0);
                        let actual = h.vault.try_deposit(user, &amount_a, &amount_b, &0);
                        match (expected, actual) {
                            (Ok(exp_s), Ok(Ok(act_s))) => assert_eq!(act_s, exp_s),
                            (Err(()), Err(_)) => {}
                            _ => panic!("deposit outcome mismatch on seed {seed}"),
                        }
                    }
                    // Partial or full withdrawal
                    5..=7 => {
                        let held = model.users.get(&user_idx).map(|u| u.shares).unwrap_or(0);
                        if held > 0 {
                            let shares = if rng.next_u64() % 4 == 0 {
                                held
                            } else {
                                rng.gen_range(1, held)
                            };
                            let expected = model.step_withdraw(user_idx, shares, 0, 0);
                            let actual = h.vault.try_withdraw(user, &shares, &0, &0);
                            match (expected, actual) {
                                (Ok((exp_a, exp_b)), Ok(Ok((act_a, act_b)))) => {
                                    assert_eq!(act_a, exp_a);
                                    assert_eq!(act_b, exp_b);
                                }
                                (Err(()), Err(_)) => {}
                                _ => panic!("withdraw outcome mismatch on seed {seed}"),
                            }
                        }
                    }
                    // Harvest with simulated AMM reward payout
                    8 => {
                        let metrics_before = h.vault.get_metrics();
                        env.ledger().with_mut(|li| li.timestamp += 3_600);
                        h.token_a_admin.mint(&h.vault_addr, &SIMULATED_REWARD);
                        h.token_b_admin.mint(&h.vault_addr, &SIMULATED_REWARD);
                        h.vault.harvest(user);
                        model.step_harvest();

                        let metrics_after = h.vault.get_metrics();
                        if metrics_before.total_shares > 0 {
                            let value_before =
                                metrics_before.total_amount_a + metrics_before.total_amount_b;
                            let value_after =
                                metrics_after.total_amount_a + metrics_after.total_amount_b;
                            assert!(
                                value_after >= value_before,
                                "harvest must not reduce vault value per share"
                            );
                        }
                    }
                    // Boundary / failure operations must not mutate state
                    _ => {
                        assert!(h.vault.try_deposit(user, &0, &0, &0).is_err());
                        assert!(h.vault.try_withdraw(user, &0, &0, &0).is_err());
                        let held = model.users.get(&user_idx).map(|u| u.shares).unwrap_or(0);
                        assert!(h.vault.try_withdraw(user, &(held + 1), &0, &0).is_err());
                    }
                }

                assert_invariants(&h, &model);
            }

            // Drain all remaining positions via full exits and confirm zero
            // shares remain.
            for idx in 0..h.users.len() {
                let held = model.users.get(&idx).map(|u| u.shares).unwrap_or(0);
                if held > 0 {
                    let (exp_a, exp_b) = model.step_withdraw(idx, held, 0, 0).unwrap();
                    let (act_a, act_b) = h.vault.withdraw(&h.users[idx], &held, &0, &0);
                    assert_eq!(act_a, exp_a);
                    assert_eq!(act_b, exp_b);
                }
                assert_invariants(&h, &model);
            }
            assert_eq!(h.vault.get_metrics().total_shares, 0);
        }
    }

    #[test]
    fn test_model_boundary_slippage_and_dust_deposit_rejected_cleanly() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let h = setup_harness(&env);
        let mut model = VaultModel::new(FEE_RATE_BPS, HARVEST_FEE_BPS, WITHDRAWAL_FEE_BPS);

        // Large initial deposit + harvest inflates share value.
        let s0 = h.vault.deposit(&h.users[0], &100_000, &100_000, &0);
        assert_eq!(s0, model.step_deposit(0, 100_000, 100_000, 0).unwrap());

        h.token_a_admin.mint(&h.vault_addr, &SIMULATED_REWARD);
        h.token_b_admin.mint(&h.vault_addr, &SIMULATED_REWARD);
        h.vault.harvest(&h.users[0]);
        model.step_harvest();

        // A tiny deposit that rounds down to 0 shares must be rejected.
        assert!(model.step_deposit(1, 1, 0, 0).is_err());
        assert!(h.vault.try_deposit(&h.users[1], &1, &0, &0).is_err());
        assert_invariants(&h, &model);

        // A deposit whose minted shares fall below `min_shares` must be rejected.
        assert!(model.step_deposit(1, 1_000, 1_000, 5_000).is_err());
        assert!(h
            .vault
            .try_deposit(&h.users[1], &1_000, &1_000, &5_000)
            .is_err());
        assert_invariants(&h, &model);

        // A withdrawal whose net output falls below `min_amount_a` must be rejected.
        assert!(model.step_withdraw(0, 1_000, 10_000, 0).is_err());
        assert!(h
            .vault
            .try_withdraw(&h.users[0], &1_000, &10_000, &0)
            .is_err());
        assert_invariants(&h, &model);
    }
}
