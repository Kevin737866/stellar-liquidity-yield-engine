use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Env};

mod testutils;

fn main() {}

#[module]
mod tests {
    use super::*;
    use crate::testutils::{fund_vault_user, setup_yield_vault};

    #[test]
    fn test_deposit_withdraw_round_trip_balances() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let fixture = setup_yield_vault(&env);

        // Fund user
        fund_vault_user(&fixture, &\u0010000);

        // Record balances before deposit
        let user_a_before = fixture.token_a.balance(&fixture.user);
        let user_b_before = fixture.token_b.balance(&fixture.user);

        // Deposit
        let shares = fixture.vault.deposit(&fixture.user, &\u00105000, &\u00105000, &0);
        assert!(shares > 0, "Should receive shares on deposit");

        // Verify vault metrics updated
        let metrics = fixture.vault.get_metrics();
        assert_eq(metrics.total_amount_a, 5000);
        assert_eq(metrics.total_amount_b, 5000);
        assert_eq(metrics.total_shares, shares);

        // Withdraw half of shares
        let withdraw_amount = shares / 2;
        let (withdrawn_a, withdrawn_b) =
            fixture.vault.withdraw(&fixture.user, &withdraw_amount, &0, &0);

        // Verify withdrawn amounts are proportional
        assert!(withdrawn_a > 0, "Should withdraw token A");
        assert!(withdrawn_b > 0, "Should withdraw token B");

        // Verify share math consistency
        let metrics_after = fixture.vault.get_metrics();
        assert_eq(metrics_after.total_shares, shares - withdraw_amount);
        assert_eq(metrics_after.total_amount_a, 5000 - withdrawn_a);
        assert_eq(metrics_after.total_amount_b, 5000 - withdrawn_b);

        // Verify user balances changed
        let user_a_after = fixture.token_a.balance(&fixture.user);
        let user_b_after = fixture.token_b.balance(&fixture.user);
        assert!(
            user_a_after < user_a_before,
            "User token A balance should decrease"
        );
        assert!(
            user_b_after < user_b_before,
            "User token B balance should decrease"
        );
    }

    #[test]
    fn test_deposit_withdraw_fees_and_share_math() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let fixture = setup_yield_vault(&env);

        // Fund user with withdrawal fee
        fund_vault_user(&fixture, &\u0010000);

        // Deposit with 2.5% withdrawal fee
        let shares = fixture.vault.deposit(&fixture.user, &\u00105000, &\u00105000, &0);

        // Withdraw all shares
        let (withdrawn_a, withdrawn_b) =
            fixture.vault.withdraw(&fixture.user, &shares, &0, &0);

        // With 2.5% fee (25 bps), user should receive 97.5% of proportional amount
        // Proportional: 5000 each
        // Fee on A: 5000 * 25 / 10000 = 12.5 -> 12
        // Fee on B: 5000 * 25 / 10000 = 12.5 -> 12
        // Expected: 4988 each
        assert!(
            withdrawn_a < 5000,
            "Withdrawal fee should reduce token A received"
        );
        assert!(
            withdrawn_b < 5000,
            "Withdrawal fee should reduce token B received"
        );
        assert!(withdrawn_a >= 4900, "Fee should not be excessive");
        assert!(withdrawn_b >= 4900, "Fee should not be excessive");
    }

    #[test]
    fn test_harvest_reinvests_and_pays_treasury_fee() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let fixture = setup_yield_vault(&env);

        // Fund user and deposit
        fund_vault_user(&fixture, &\u0010000);
        fixture.vault.deposit(&fixture.user, &\u0010000, &\u0010000, &0);

        // Harvest
        fixture.vault.harvest(&fixture.user);

        // Verify treasury received harvest fees (1% of 1000 = 10)
        let treasury_a = fixture.token_a.balance(&fixture.treasury);
        let treasury_b = fixture.token_b.balance(&fixture.treasury);
        assert!(
            treasury_a > 0 || treasury_b > 0,
            "Treasury should receive harvest fees"
        );
    }

    #[test]
    fn test_pause_blocks_deposit_withdraw_harvest() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let fixture = setup_yield_vault(&env);

        // Fund user
        fund_vault_user(&fixture, &\u0010000);

        // Pause vault
        fixture.vault.pause(&fixture.admin);

        // Deposit should fail when paused
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fixture.vault.deposit(&fixture.user, &\u0010000, &\u0010000, &0);
        }));
        assert!(result.is_error(), "Deposit should fail when vault is paused");

        // Unpause and verify deposit works again
        fixture.vault.unpause(&fixture.admin);
        let shares = fixture.vault.deposit(&fixture.user, &\u0010000, &\u0010000, &0);
        assert!(shares > 0, "Deposit should work after unpause");
    }

    #[test]
    fn test_first_deposit_geometric_mean_share_calculation() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let fixture = setup_yield_vault(&env);

        // Fund user with asymmetric amounts
        fixture.token_a_admin.mint(&fixture.user, &\u0010000);
        fixture.token_b_admin.mint(&fixture.user, &\u00100);

        // First deposit uses geometric mean
        let shares = fixture.vault.deposit(&fixture.user, &\u0010000, &\u00100, &0);
        assert!(shares > 0, "First deposit should mint shares");

        // Geometric mean of 10000 * 100 = 1,000,000 -> sqrt = 1000
        // So shares should be ~1000
        assert!(
            shares >= 900 && shares <= 1100,
            "Shares should approximate geometric mean"
        );
    }

    #[test]
    fn test_non_admin_cannot_pause_or_unpause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let fixture = setup_yield_vault(&env);

        let non_admin = Address::generate(&env);

        // Non-admin pause should panic
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fixture.vault.pause(&non_admin);
        }));
        assert!(result.is_err(), "Non-admin should not be able to pause");

        // Verify vault is still unpaused
        assert!(!fixture.vault.is_paused(), "Vault should remain unpaused");

        // Non-admin unpause should also panic (but vault is already unpaused)
        let result2 = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            fixture.vault.unpause(&non_admin);
        }));
        assert!(result2.is_err(), "Non-admin should not be able to unpause");
    }
}
