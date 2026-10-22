use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token::TokenClient,
    Address, Env, Map, Symbol, Vec,
};

/// Typed failures of the yield vault.
///
/// Anticipated invalid inputs - a caller who is not the admin, a deposit below
/// the configured minimum, a withdrawal that would redeem nothing - fail with
/// one of these codes instead of an opaque string panic. A caller (or an
/// off-chain client) can therefore tell the cases apart and handle them.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VaultError {
    /// The caller is not the stored admin.
    Unauthorized = 1,
    /// The vault is paused and refuses state-changing operations.
    Paused = 2,
    /// The vault has not been initialized, so its configuration is missing.
    NotInitialized = 3,
    /// A deposit leg is below the configured minimum.
    AmountBelowMinimum = 4,
    /// Both deposit legs are zero.
    DepositMustBePositive = 5,
    /// The deposit is too small: it would mint zero shares.
    DepositTooSmall = 6,
    /// The deposit minted fewer shares than the caller's `min_shares`.
    InsufficientSharesReceived = 7,
    /// The requested share amount is not positive.
    SharesMustBePositive = 8,
    /// The requested withdrawal is below the configured minimum shares.
    WithdrawalBelowMinimum = 9,
    /// The caller holds fewer shares than the withdrawal asks for.
    InsufficientShares = 10,
    /// The vault has no shares outstanding, so there is nothing to price against.
    NoSharesOutstanding = 11,
    /// A partial withdrawal would redeem zero tokens.
    WithdrawalTooSmall = 12,
    /// The redeemed token A is below the caller's `min_amount_a`.
    InsufficientAmountA = 13,
    /// The redeemed token B is below the caller's `min_amount_b`.
    InsufficientAmountB = 14,
    /// A configured minimum deposit amount is negative.
    NegativeMinimumDeposit = 15,
    /// The configured minimum withdrawal must be positive.
    MinSharesMustBePositive = 16,
    /// A configured token price is negative.
    NegativePrice = 17,
    /// The emergency multisig threshold must be at least 1.
    ThresholdMustBePositive = 18,
    /// Fewer authorized emergency signers than the threshold were supplied.
    InsufficientEmergencySignatures = 19,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultInfo {
    pub name: Symbol,
    pub token_a: Address,
    pub token_b: Address,
    pub pool_id: Address,
    pub strategy_id: u32,
    pub fee_rate: u32, // Basis points (100 = 1%) - performance fee on realized gains
    pub harvest_fee: u32, // Basis points
    pub withdrawal_fee: u32, // Basis points
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserPosition {
    pub shares: i128,
    pub last_harvest: u64,
    pub deposited_amount_a: i128,
    pub deposited_amount_b: i128,
}

/// Pacing limits applied to withdrawals, expressed in basis points of the
/// shares held when the current window opened.
///
/// Both dimensions are off by default (zero), which preserves the historical
/// behaviour; an operator enables pacing for a vault that must not be drained
/// in a single ledger window. Pacing is active when `window_seconds` is
/// positive and at least one of the two limits is non-zero.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawPacing {
    /// Maximum share of one user's position (bps) withdrawable per window.
    pub user_max_bps: u32,
    /// Maximum share of the vault's total shares (bps) withdrawable per window.
    pub vault_max_bps: u32,
    /// Length of the pacing window, in seconds.
    pub window_seconds: u64,
}

/// Withdrawal consumption inside one pacing window.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WithdrawWindow {
    /// Ledger timestamp that opened the window; 0 means no window yet.
    pub window_started_at: u64,
    /// Shares already withdrawn inside this window.
    pub shares_withdrawn: i128,
    /// Shares the measured party held when the window opened.
    pub window_start_shares: i128,
}

/// An economic-parameter change waiting out its time lock.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PendingAdminAction {
    Prices(i128, i128),
    MinDepositAmounts(i128, i128),
    MinWithdrawShares(i128),
    Treasury(Address),
    TimelockDelay(u64),
}

/// A queued change with the timestamp at which it becomes executable.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAction {
    pub id: u64,
    pub action: PendingAdminAction,
    pub proposer: Address,
    pub executable_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultMetrics {
    pub total_shares: i128,
    pub total_amount_a: i128,
    pub total_amount_b: i128,
    pub apy: u32,  // Basis points
    pub tvl: i128, // Total Value Locked in USD (scaled)
    pub last_harvest: u64,
}

#[contract]
pub struct YieldVault;

/// Seconds in a common (non-leap) year, used to annualize APY.
const SECONDS_PER_YEAR: u128 = 31_536_000;

/// Default minimum deposit per leg: 0, because a single-leg deposit is a valid
/// operation. The combined deposit must still be positive, and an admin can
/// raise either leg through the timelocked `propose_set_min_deposit_amounts`.
pub const DEFAULT_MIN_DEPOSIT: i128 = 0;

/// Smallest accepted withdrawal, in shares, when the admin has not configured a
/// minimum: one share.
pub const DEFAULT_MIN_WITHDRAW_SHARES: i128 = 1;

/// A tracked balance at or below this is dust. It is swept into a full exit
/// instead of being stranded in the vault forever.
pub const DUST_THRESHOLD: i128 = 1;

/// Default delay applied to admin changes of economic parameters: 48 hours.
///
/// This gives depositors and integrators a window to see a pending change - and
/// to exit - before it takes effect. The admin can change the delay, but only
/// through the timelock itself, so it cannot be shortened instantly.
pub const DEFAULT_TIMELOCK_DELAY: u64 = 48 * 60 * 60;

// The contract's entrypoints are exported only when the vault itself is the
// contract being deployed. The rebalance engine depends on this module's types
// (and on nothing else here), and a wasm binary cannot export two contracts.
#[cfg(feature = "yield-vault")]
#[contractimpl]
impl YieldVault {
    /// Initialize a new yield vault
    pub fn initialize(
        env: Env,
        admin: Address,
        name: Symbol,
        token_a: Address,
        token_b: Address,
        pool_id: Address,
        strategy_id: u32,
        fee_rate: u32,
        harvest_fee: u32,
        withdrawal_fee: u32,
        treasury: Address,
    ) {
        let vault_info = VaultInfo {
            name: name.clone(),
            token_a: token_a.clone(),
            token_b: token_b.clone(),
            pool_id,
            strategy_id,
            fee_rate,
            harvest_fee,
            withdrawal_fee,
        };

        env.storage()
            .instance()
            .set(&Symbol::new(&env, "vault_info"), &vault_info);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "admin"), &admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "treasury"), &treasury);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);

        // Time lock for economic-parameter changes, and the queue of changes
        // waiting out that delay.
        env.storage().instance().set(
            &Symbol::new(&env, "timelock_delay"),
            &DEFAULT_TIMELOCK_DELAY,
        );
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "next_action_id"), &1u64);

        // Emergency multisig state: the emergency signer set starts empty and
        // must be configured by the admin; threshold defaults to 3 approvals.
        env.storage().instance().set(
            &Symbol::new(&env, "emergency_signers"),
            &Vec::<Address>::new(&env),
        );
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "emergency_threshold"), &3u32);

        // Initialize metrics
        let metrics = VaultMetrics {
            total_shares: 0,
            total_amount_a: 0,
            total_amount_b: 0,
            apy: 0,
            tvl: 0,
            last_harvest: env.ledger().timestamp(),
        };
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "metrics"), &metrics);

        env.events().publish(
            (Symbol::new(&env, "vault_initialized"),),
            (admin, name, token_a, token_b, treasury),
        );
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

    /// Deposit tokens into the vault
    pub fn deposit(
        env: Env,
        user: Address,
        amount_a: i128,
        amount_b: i128,
        min_shares: i128,
    ) -> i128 {
        Self::require_not_paused(&env);

        // Reject sub-unit and zero deposits before any tokens move, so a dust
        // deposit can never be used to grief the vault or other depositors.
        let (min_a, min_b) = Self::get_min_deposit_amounts(env.clone());
        require!(&env, amount_a >= min_a, VaultError::AmountBelowMinimum);
        require!(&env, amount_b >= min_b, VaultError::AmountBelowMinimum);
        require!(
            &env,
            amount_a + amount_b > 0,
            VaultError::DepositMustBePositive
        );

        let vault_info = Self::get_vault_info(env.clone());
        let mut metrics = Self::get_metrics(env.clone());

        // Transfer tokens from user to vault
        let token_a_client = TokenClient::new(&env, &vault_info.token_a);
        let token_b_client = TokenClient::new(&env, &vault_info.token_b);

        token_a_client.transfer(&user, &env.current_contract_address(), &amount_a);
        token_b_client.transfer(&user, &env.current_contract_address(), &amount_b);

        // Calculate shares based on the combined value of both tokens
        let shares = if metrics.total_shares == 0 {
            // First deposit - 1:1 shares per unit of combined deposit value
            amount_a + amount_b
        } else {
            // Proportional to the combined value of both tokens
            let total_value = metrics.total_amount_a + metrics.total_amount_b;
            if total_value <= 0 {
                0
            } else {
                (amount_a + amount_b) * metrics.total_shares / total_value
            }
        };

        // A deposit that rounds down to nothing would be a pure donation, so it
        // is rejected instead of silently credited to existing holders.
        require!(&env, shares > 0, VaultError::DepositTooSmall);

        if shares < min_shares {
            panic_with_error!(&env, VaultError::InsufficientSharesReceived);
        }

        // Update user position
        let mut position = Self::get_user_position(env.clone(), user.clone());
        position.shares += shares;
        position.deposited_amount_a += amount_a;
        position.deposited_amount_b += amount_b;
        position.last_harvest = env.ledger().timestamp();

        env.storage().instance().set(&user, &position);

        // Update vault metrics and recompute TVL from the new balances.
        metrics.total_shares += shares;
        metrics.total_amount_a += amount_a;
        metrics.total_amount_b += amount_b;
        metrics.tvl = Self::value_in_usd(&env, metrics.total_amount_a, metrics.total_amount_b);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "metrics"), &metrics);

        env.events().publish(
            (Symbol::new(&env, "deposit"),),
            (user, amount_a, amount_b, shares),
        );

        shares
    }

    /// Withdraw tokens from the vault
    pub fn withdraw(
        env: Env,
        user: Address,
        shares: i128,
        min_amount_a: i128,
        min_amount_b: i128,
    ) -> (i128, i128) {
        Self::require_not_paused(&env);

        // Reject zero-share and sub-unit withdrawals before any arithmetic, which
        // also removes the divide-by-zero path when no shares are outstanding.
        let min_withdraw_shares = Self::get_min_withdraw_shares(env.clone());
        require!(&env, shares > 0, VaultError::SharesMustBePositive);
        require!(
            &env,
            shares >= min_withdraw_shares,
            VaultError::WithdrawalBelowMinimum
        );

        let vault_info = Self::get_vault_info(env.clone());
        let mut metrics = Self::get_metrics(env.clone());
        let mut position = Self::get_user_position(env.clone(), user.clone());

        if position.shares < shares {
            panic_with_error!(&env, VaultError::InsufficientShares);
        }

        require!(
            &env,
            metrics.total_shares > 0,
            VaultError::NoSharesOutstanding
        );

        // Calculate withdrawal amounts
        let is_full_exit = shares == position.shares;
        let mut withdraw_amount_a = shares * metrics.total_amount_a / metrics.total_shares;
        let mut withdraw_amount_b = shares * metrics.total_amount_b / metrics.total_shares;

        if is_full_exit {
            // Sweep a dust remainder into the exit so a rounding leftover can
            // never be stranded in the vault and can never block a full exit.
            let leftover_a = metrics.total_amount_a - withdraw_amount_a;
            if leftover_a <= DUST_THRESHOLD {
                withdraw_amount_a += leftover_a;
            }
            let leftover_b = metrics.total_amount_b - withdraw_amount_b;
            if leftover_b <= DUST_THRESHOLD {
                withdraw_amount_b += leftover_b;
            }
        } else {
            // A partial exit has to redeem something, otherwise the shares would
            // round-trip to dust.
            require!(
                &env,
                withdraw_amount_a > 0 || withdraw_amount_b > 0,
                VaultError::WithdrawalTooSmall
            );
        }

        // Apply withdrawal fee
        let fee_amount_a = withdraw_amount_a * vault_info.withdrawal_fee as i128 / 10000;
        let fee_amount_b = withdraw_amount_b * vault_info.withdrawal_fee as i128 / 10000;

        // Apply performance fee (fee_rate) on the realized gain, split
        // proportionally between the two tokens
        let perf_fee = Self::calculate_performance_fee(
            &vault_info,
            &position,
            withdraw_amount_a,
            withdraw_amount_b,
            shares,
        );
        let perf_fee_a = if withdraw_amount_a + withdraw_amount_b > 0 {
            perf_fee * withdraw_amount_a / (withdraw_amount_a + withdraw_amount_b)
        } else {
            0
        };
        let perf_fee_b = perf_fee - perf_fee_a;

        let final_amount_a = withdraw_amount_a - fee_amount_a - perf_fee_a;
        let final_amount_b = withdraw_amount_b - fee_amount_b - perf_fee_b;

        if final_amount_a < min_amount_a {
            panic_with_error!(&env, VaultError::InsufficientAmountA);
        }
        if final_amount_b < min_amount_b {
            panic_with_error!(&env, VaultError::InsufficientAmountB);
        }

        // Pace large exits before any tokens move: a failure here rolls the
        // whole call back, including the window charge.
        Self::consume_withdraw_pacing(&env, &user, shares, position.shares, metrics.total_shares);

        // Update user position. Withdrawing retires the part of the user's
        // position that was outstanding, so it is also the moment their pending
        // reward window restarts; record it so the UI can show pending rewards
        // from the user's own last harvest rather than the vault-wide one.
        position.shares -= shares;
        position.deposited_amount_a -= withdraw_amount_a;
        position.deposited_amount_b -= withdraw_amount_b;
        position.last_harvest = env.ledger().timestamp();
        env.storage().instance().set(&user, &position);

        // Update vault metrics and recompute TVL from the remaining balances.
        metrics.total_shares -= shares;
        metrics.total_amount_a -= withdraw_amount_a;
        metrics.total_amount_b -= withdraw_amount_b;
        metrics.tvl = Self::value_in_usd(&env, metrics.total_amount_a, metrics.total_amount_b);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "metrics"), &metrics);

        // Transfer tokens to user
        let token_a_client = TokenClient::new(&env, &vault_info.token_a);
        let token_b_client = TokenClient::new(&env, &vault_info.token_b);

        token_a_client.transfer(&env.current_contract_address(), &user, &final_amount_a);
        token_b_client.transfer(&env.current_contract_address(), &user, &final_amount_b);

        // Route the performance fee to the treasury
        if perf_fee_a > 0 || perf_fee_b > 0 {
            let treasury = Self::get_treasury(env.clone());
            if perf_fee_a > 0 {
                token_a_client.transfer(&env.current_contract_address(), &treasury, &perf_fee_a);
            }
            if perf_fee_b > 0 {
                token_b_client.transfer(&env.current_contract_address(), &treasury, &perf_fee_b);
            }
        }

        // Route the withdrawal fee to the treasury as well, so every fee the
        // vault collects ends up in the fee-sharing system instead of being
        // stranded in the vault's own balance.
        if fee_amount_a > 0 || fee_amount_b > 0 {
            let treasury = Self::get_treasury(env.clone());
            if fee_amount_a > 0 {
                token_a_client.transfer(&env.current_contract_address(), &treasury, &fee_amount_a);
            }
            if fee_amount_b > 0 {
                token_b_client.transfer(&env.current_contract_address(), &treasury, &fee_amount_b);
            }
        }

        env.events().publish(
            (Symbol::new(&env, "withdraw"),),
            (user, shares, final_amount_a, final_amount_b),
        );

        (final_amount_a, final_amount_b)
    }

    /// Auto-compound harvest and reinvestment.
    ///
    /// Harvesting compounds rewards into the vault's balances, which changes the
    /// value backing every share. The vault-wide `metrics.last_harvest` records
    /// the last time that happened; the caller's own `last_harvest` is recorded
    /// too, so a user's pending-reward state is measured from the last harvest
    /// they participated in instead of a timestamp shared by the whole vault.
    pub fn harvest(env: Env, caller: Address) {
        Self::require_not_paused(&env);

        let vault_info = Self::get_vault_info(env.clone());
        let mut metrics = Self::get_metrics(env.clone());

        // Claim rewards from AMM pool (simplified - would call AMM contract)
        // This is a placeholder for actual reward claiming logic
        let rewards_a = Self::calculate_pending_rewards(&env, &vault_info.pool_id);
        let rewards_b = Self::calculate_pending_rewards(&env, &vault_info.pool_id);

        if rewards_a > 0 || rewards_b > 0 {
            // Apply harvest fee
            let fee_a = rewards_a * vault_info.harvest_fee as i128 / 10000;
            let fee_b = rewards_b * vault_info.harvest_fee as i128 / 10000;

            let net_rewards_a = rewards_a - fee_a;
            let net_rewards_b = rewards_b - fee_b;

            // Derive an annualized APY from this harvest's yield (net rewards vs the
            // vault's value before reinvestment) over the elapsed wall-clock time.
            let elapsed = env
                .ledger()
                .timestamp()
                .saturating_sub(metrics.last_harvest);
            let prev_value = metrics.tvl;
            let reward_value = Self::value_in_usd(&env, net_rewards_a, net_rewards_b);
            if elapsed > 0 && prev_value > 0 && reward_value > 0 {
                // yield_bp = reward_value / prev_value * seconds_per_year / elapsed * 10000
                let apy_bp = reward_value as u128 * SECONDS_PER_YEAR * 10000u128
                    / (prev_value as u128 * elapsed as u128);
                // Cap at 100,000% APY to keep the value sane.
                metrics.apy = apy_bp.min(1000_0000) as u32;
            }

            // Reinvest rewards
            metrics.total_amount_a += net_rewards_a;
            metrics.total_amount_b += net_rewards_b;
            metrics.last_harvest = env.ledger().timestamp();

            // Recompute TVL from the reinvested balances.
            metrics.tvl = Self::value_in_usd(&env, metrics.total_amount_a, metrics.total_amount_b);

            env.storage()
                .instance()
                .set(&Symbol::new(&env, "metrics"), &metrics);

            // Transfer fees to treasury
            if fee_a > 0 || fee_b > 0 {
                let treasury = Self::get_treasury(env.clone());
                let token_a_client = TokenClient::new(&env, &vault_info.token_a);
                let token_b_client = TokenClient::new(&env, &vault_info.token_b);

                if fee_a > 0 {
                    token_a_client.transfer(&env.current_contract_address(), &treasury, &fee_a);
                }
                if fee_b > 0 {
                    token_b_client.transfer(&env.current_contract_address(), &treasury, &fee_b);
                }
            }

            env.events().publish(
                (Symbol::new(&env, "harvest"),),
                (caller.clone(), net_rewards_a, net_rewards_b, fee_a, fee_b),
            );
        }

        // Per-user harvest bookkeeping. Only an address that already holds a
        // position is stamped: writing a position for a caller that has none
        // would let anyone create instance-storage entries for arbitrary
        // addresses, and there is no pending reward to reset for them anyway.
        let mut position = Self::get_user_position(env.clone(), caller.clone());
        if position.shares > 0 {
            position.last_harvest = env.ledger().timestamp();
            env.storage().instance().set(&caller, &position);

            env.events().publish(
                (Symbol::new(&env, "user_harvest"),),
                (caller, position.last_harvest),
            );
        }
    }

    /// Minimum accepted deposit amounts as `(min_amount_a, min_amount_b)`
    pub fn get_min_deposit_amounts(env: Env) -> (i128, i128) {
        (
            env.storage()
                .instance()
                .get(&Symbol::new(&env, "min_deposit_a"))
                .unwrap_or(DEFAULT_MIN_DEPOSIT),
            env.storage()
                .instance()
                .get(&Symbol::new(&env, "min_deposit_b"))
                .unwrap_or(DEFAULT_MIN_DEPOSIT),
        )
    }

    /// Queue a change to the minimum accepted deposit per leg (admin only).
    ///
    /// The change is queued rather than applied: it becomes executable once the
    /// timelock delay has elapsed. A minimum of 0 keeps single-leg deposits
    /// open; the combined deposit must be positive either way.
    ///
    /// Returns the id of the queued action.
    pub fn propose_set_min_deposit_amounts(
        env: Env,
        admin: Address,
        min_a: i128,
        min_b: i128,
    ) -> u64 {
        Self::require_admin(&env, admin.clone());
        require!(&env, min_a >= 0, VaultError::NegativeMinimumDeposit);
        require!(&env, min_b >= 0, VaultError::NegativeMinimumDeposit);

        Self::enqueue(
            env,
            admin,
            PendingAdminAction::MinDepositAmounts(min_a, min_b),
        )
    }

    /// Smallest accepted withdrawal, in shares
    pub fn get_min_withdraw_shares(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "min_withdraw_shares"))
            .unwrap_or(DEFAULT_MIN_WITHDRAW_SHARES)
    }

    /// Queue a change to the smallest accepted withdrawal in shares (admin
    /// only). Must be positive so a zero-share withdrawal is always rejected.
    ///
    /// Returns the id of the queued action.
    pub fn propose_set_min_withdraw_shares(env: Env, admin: Address, min_shares: i128) -> u64 {
        Self::require_admin(&env, admin.clone());
        require!(&env, min_shares > 0, VaultError::MinSharesMustBePositive);

        Self::enqueue(
            env,
            admin,
            PendingAdminAction::MinWithdrawShares(min_shares),
        )
    }

    /// Current withdrawal pacing limits (all zero when pacing is disabled).
    pub fn get_withdraw_pacing(env: Env) -> WithdrawPacing {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "withdraw_pacing"))
            .unwrap_or(WithdrawPacing {
                user_max_bps: 0,
                vault_max_bps: 0,
                window_seconds: 0,
            })
    }

    /// Set withdrawal pacing limits (admin only). A zero window, or zero limits,
    /// disables pacing entirely.
    ///
    /// A withdrawal is measured against the position held when the current
    /// window opened, so lowering the limit cannot strand shares that were
    /// withdrawable when the window began.
    pub fn set_withdraw_pacing(
        env: Env,
        admin: Address,
        user_max_bps: u32,
        vault_max_bps: u32,
        window_seconds: u64,
    ) {
        Self::require_admin(&env, admin.clone());

        require!(
            user_max_bps <= 10000,
            "user_max_bps must not exceed 10000 bps"
        );
        require!(
            vault_max_bps <= 10000,
            "vault_max_bps must not exceed 10000 bps"
        );
        let enabled = user_max_bps > 0 || vault_max_bps > 0;
        require!(
            !enabled || window_seconds > 0,
            "window_seconds must be positive when pacing is enabled"
        );

        let pacing = WithdrawPacing {
            user_max_bps,
            vault_max_bps,
            window_seconds,
        };
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "withdraw_pacing"), &pacing);

        env.events().publish(
            (Symbol::new(&env, "withdraw_pacing_updated"),),
            (admin, user_max_bps, vault_max_bps, window_seconds),
        );
    }

    /// One user's withdrawal consumption in the current window.
    pub fn get_user_withdraw_window(env: Env, user: Address) -> WithdrawWindow {
        Self::get_withdraw_windows(env.clone())
            .get(user)
            .unwrap_or(Self::default_withdraw_window())
    }

    /// Vault-wide withdrawal consumption in the current window.
    pub fn get_vault_withdraw_window(env: Env) -> WithdrawWindow {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "vault_withdraw_window"))
            .unwrap_or(Self::default_withdraw_window())
    }

    /// Get vault information
    ///
    /// Fails with [`VaultError::NotInitialized`] before `initialize` has run.
    pub fn get_vault_info(env: Env) -> VaultInfo {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "vault_info"))
            .unwrap_or_else(|| env.panic_with_error(VaultError::NotInitialized))
    }

    /// Get vault metrics, recomputing TVL on the fly from the current balances
    /// and the configured token prices so it can never get stuck at 0 once
    /// prices are provided. APY is derived from harvest history in `harvest`.
    pub fn get_metrics(env: Env) -> VaultMetrics {
        let mut metrics = Self::stored_metrics(&env);
        metrics.tvl = Self::value_in_usd(&env, metrics.total_amount_a, metrics.total_amount_b);
        metrics
    }

    /// Get user position
    pub fn get_user_position(env: Env, user: Address) -> UserPosition {
        env.storage().instance().get(&user).unwrap_or(UserPosition {
            shares: 0,
            last_harvest: 0,
            deposited_amount_a: 0,
            deposited_amount_b: 0,
        })
    }

    /// Get APY for the vault (in basis points)
    pub fn get_apy(env: Env) -> u32 {
        Self::get_metrics(env).apy
    }

    /// Get TVL for the vault (USD, scaled by the configured token price scale)
    pub fn get_tvl(env: Env) -> i128 {
        Self::get_metrics(env).tvl
    }

    /// Set USD prices (scaled) for token_a and token_b (admin only). TVL is
    /// recomputed immediately so get_tvl reflects the new prices.
    pub fn set_prices(env: Env, admin: Address, price_a: i128, price_b: i128) {
        let current_admin = Self::get_admin(env.clone());
        if admin != current_admin {
            panic_with_error!(&env, VaultError::Unauthorized);
        }
        if price_a < 0 || price_b < 0 {
            panic_with_error!(&env, VaultError::NegativePrice);
        }

        env.storage()
            .instance()
            .set(&Symbol::new(&env, "price_a"), &price_a);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "price_b"), &price_b);

        let metrics = Self::get_metrics(env.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "metrics"), &metrics);
    }

    /// Queue a change to the USD prices (scaled) used for TVL (admin only).
    ///
    /// Prices are an economic parameter: they change the value backing every
    /// share, so the change is queued behind the timelock. Returns the id of the
    /// queued action.
    pub fn propose_set_prices(env: Env, admin: Address, price_a: i128, price_b: i128) -> u64 {
        Self::require_admin(&env, admin.clone());
        require!(price_a >= 0 && price_b >= 0, "price must not be negative");

        Self::enqueue(env, admin, PendingAdminAction::Prices(price_a, price_b))
    }

    /// Get the currently configured token prices as (price_a, price_b).
    pub fn get_prices(env: Env) -> (i128, i128) {
        (Self::get_price_a(&env), Self::get_price_b(&env))
    }

    /// Get treasury address that receives protocol fees
    ///
    /// Fails with [`VaultError::NotInitialized`] before `initialize` has run.
    pub fn get_treasury(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "treasury"))
            .unwrap_or_else(|| env.panic_with_error(VaultError::NotInitialized))
    }

    /// Queue a change to the treasury/DAO address that receives protocol fees
    /// (admin only).
    ///
    /// The treasury is set at initialization like `reward_distributor` does, but
    /// it can be rotated so a DAO can move its own treasury without redeploying
    /// the vault. Because fee routing is an economic parameter, the rotation is
    /// queued behind the timelock and only affects fees collected after it is
    /// executed. Returns the id of the queued action.
    pub fn propose_set_treasury(env: Env, admin: Address, treasury: Address) -> u64 {
        Self::require_admin(&env, admin.clone());

        Self::enqueue(env, admin, PendingAdminAction::Treasury(treasury))
    }

    /// Queue a change to the timelock delay itself (admin only).
    ///
    /// The delay can only be changed through the timelock, so a compromised or
    /// impatient admin cannot shorten the notice window and then act on it in
    /// the same ledger. Returns the id of the queued action.
    pub fn propose_set_timelock_delay(env: Env, admin: Address, delay: u64) -> u64 {
        Self::require_admin(&env, admin.clone());
        Self::enqueue(env, admin, PendingAdminAction::TimelockDelay(delay))
    }

    /// Execute a queued action once its timelock has elapsed (admin only).
    ///
    /// Executing early is rejected; the action stays queued, so it can still be
    /// executed after the delay. Executing removes it, so it cannot be replayed.
    pub fn execute_pending_action(env: Env, admin: Address, action_id: u64) {
        Self::require_admin(&env, admin.clone());

        let mut pending = Self::get_pending_actions(env.clone());
        let action = match pending.get(action_id) {
            Some(action) => action,
            None => panic!("no pending action with that id"),
        };
        require!(
            env.ledger().timestamp() >= action.executable_at,
            "action is still timelocked"
        );

        pending.remove(action_id);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pending_actions"), &pending);

        Self::apply_action(&env, &action.action);

        env.events().publish(
            (Symbol::new(&env, "action_executed"), action_id),
            (admin, action.executable_at),
        );
    }

    /// Cancel a queued action (admin only), discarding it without effect.
    pub fn cancel_pending_action(env: Env, admin: Address, action_id: u64) {
        Self::require_admin(&env, admin.clone());

        let mut pending = Self::get_pending_actions(env.clone());
        require!(
            pending.contains_key(action_id),
            "no pending action with that id"
        );
        pending.remove(action_id);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pending_actions"), &pending);

        env.events()
            .publish((Symbol::new(&env, "action_cancelled"), action_id), (admin,));
    }

    /// A queued action by id, if it is still pending.
    pub fn get_pending_action(env: Env, action_id: u64) -> Option<PendingAction> {
        Self::get_pending_actions(env).get(action_id)
    }

    /// The delay applied to economic-parameter changes, in seconds.
    pub fn get_timelock_delay(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "timelock_delay"))
            .unwrap_or(DEFAULT_TIMELOCK_DELAY)
    }

    /// Read the raw stored metrics without recomputing TVL
    fn stored_metrics(env: &Env) -> VaultMetrics {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "metrics"))
            .unwrap_or(VaultMetrics {
                total_shares: 0,
                total_amount_a: 0,
                total_amount_b: 0,
                apy: 0,
                tvl: 0,
                last_harvest: 0,
            })
    }

    /// Configured USD price of token_a, defaulting to 0 when unset
    fn get_price_a(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "price_a"))
            .unwrap_or(0i128)
    }

    /// Configured USD price of token_b, defaulting to 0 when unset
    fn get_price_b(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&Symbol::new(env, "price_b"))
            .unwrap_or(0i128)
    }

    /// Combined USD value of a token_a/token_b position at the configured prices
    fn value_in_usd(env: &Env, amount_a: i128, amount_b: i128) -> i128 {
        amount_a * Self::get_price_a(env) + amount_b * Self::get_price_b(env)
    }

    /// Calculate the performance fee (`fee_rate`, in basis points) on the
    /// realized gain of a withdrawal. The gain is the redeemed value minus the
    /// user's proportional cost basis (their historical deposits). Only gains
    /// are charged; a withdrawal at or below cost pays no performance fee.
    fn calculate_performance_fee(
        vault_info: &VaultInfo,
        position: &UserPosition,
        withdraw_amount_a: i128,
        withdraw_amount_b: i128,
        shares: i128,
    ) -> i128 {
        if vault_info.fee_rate == 0 || position.shares <= 0 {
            return 0;
        }
        let cost_a = position.deposited_amount_a * shares / position.shares;
        let cost_b = position.deposited_amount_b * shares / position.shares;
        let gain = (withdraw_amount_a + withdraw_amount_b) - (cost_a + cost_b);
        if gain > 0 {
            gain * vault_info.fee_rate as i128 / 10000
        } else {
            0
        }
    }

    /// Calculate pending rewards (placeholder)
    fn calculate_pending_rewards(_env: &Env, _pool_id: &Address) -> i128 {
        // This would integrate with Stellar AMM to calculate actual rewards
        // For now, return a simulated value
        1000i128
    }

    /// A zeroed withdrawal window, used when none has been recorded yet.
    fn default_withdraw_window() -> WithdrawWindow {
        WithdrawWindow {
            window_started_at: 0,
            shares_withdrawn: 0,
            window_start_shares: 0,
        }
    }

    /// Per-user withdrawal windows, keyed by user address.
    fn get_withdraw_windows(env: Env) -> Map<Address, WithdrawWindow> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "withdraw_windows"))
            .unwrap_or(Map::new(&env))
    }

    /// Enforce withdrawal pacing and, if the withdrawal is allowed, charge it
    /// against both the user's and the vault's current window.
    ///
    /// `position_shares` and `total_shares` are the balances *before* this
    /// withdrawal; they size the allowances when a window opens. When pacing is
    /// disabled (the default) this is a no-op, so unpaced vaults keep their
    /// previous behaviour.
    fn consume_withdraw_pacing(
        env: &Env,
        user: &Address,
        shares: i128,
        position_shares: i128,
        total_shares: i128,
    ) {
        let pacing = Self::get_withdraw_pacing(env.clone());
        if pacing.window_seconds == 0 || (pacing.user_max_bps == 0 && pacing.vault_max_bps == 0) {
            return;
        }

        let now = env.ledger().timestamp();
        // `window_start_shares` is the "is a window open" flag: it is always
        // positive when one opened (both parties hold shares here), which keeps
        // a window opened at ledger timestamp 0 distinct from "no window yet".
        let window_expired = |window: &WithdrawWindow| {
            window.window_start_shares == 0
                || now.saturating_sub(window.window_started_at) >= pacing.window_seconds
        };

        let mut windows = Self::get_withdraw_windows(env.clone());
        let mut user_window = windows
            .get(user.clone())
            .unwrap_or(Self::default_withdraw_window());
        if window_expired(&user_window) {
            user_window.window_started_at = now;
            user_window.shares_withdrawn = 0;
            user_window.window_start_shares = position_shares;
        }

        let mut vault_window = Self::get_vault_withdraw_window(env.clone());
        if window_expired(&vault_window) {
            vault_window.window_started_at = now;
            vault_window.shares_withdrawn = 0;
            vault_window.window_start_shares = total_shares;
        }

        // Round the allowance up: a limit expressed in bps must never make a
        // positive position completely unwithdrawable at small share counts.
        if pacing.user_max_bps > 0 {
            let allowance =
                (user_window.window_start_shares * pacing.user_max_bps as i128 + 9999) / 10000;
            require!(
                user_window.shares_withdrawn + shares <= allowance,
                "withdrawal exceeds per-user pacing limit"
            );
        }
        if pacing.vault_max_bps > 0 {
            let allowance =
                (vault_window.window_start_shares * pacing.vault_max_bps as i128 + 9999) / 10000;
            require!(
                vault_window.shares_withdrawn + shares <= allowance,
                "withdrawal exceeds vault pacing limit"
            );
        }

        user_window.shares_withdrawn += shares;
        vault_window.shares_withdrawn += shares;
        windows.set(user.clone(), user_window);
        env.storage()
            .instance()
            .set(&Symbol::new(env, "withdraw_windows"), &windows);
        env.storage()
            .instance()
            .set(&Symbol::new(env, "vault_withdraw_window"), &vault_window);
    }

    /// The queued timelocked actions, keyed by action id.
    fn get_pending_actions(env: Env) -> Map<u64, PendingAction> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "pending_actions"))
            .unwrap_or(Map::new(&env))
    }

    /// Allocate the next action id.
    fn next_action_id(env: &Env) -> u64 {
        let id: u64 = env
            .storage()
            .instance()
            .get(&Symbol::new(env, "next_action_id"))
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&Symbol::new(env, "next_action_id"), &(id + 1));
        id
    }

    /// Queue `action` so it becomes executable after the current timelock delay.
    fn enqueue(env: Env, proposer: Address, action: PendingAdminAction) -> u64 {
        let id = Self::next_action_id(&env);
        let executable_at = env
            .ledger()
            .timestamp()
            .saturating_add(Self::get_timelock_delay(env.clone()));

        let mut pending = Self::get_pending_actions(env.clone());
        pending.set(
            id,
            PendingAction {
                id,
                action,
                proposer: proposer.clone(),
                executable_at,
            },
        );
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pending_actions"), &pending);

        env.events().publish(
            (Symbol::new(&env, "action_proposed"), id),
            (proposer, executable_at),
        );

        id
    }

    /// Apply a matured action to storage. Only `execute_pending_action` calls
    /// this, after checking the delay and removing the action from the queue.
    fn apply_action(env: &Env, action: &PendingAdminAction) {
        match action.clone() {
            PendingAdminAction::Prices(price_a, price_b) => {
                env.storage()
                    .instance()
                    .set(&Symbol::new(env, "price_a"), &price_a);
                env.storage()
                    .instance()
                    .set(&Symbol::new(env, "price_b"), &price_b);

                // Recompute TVL so the new prices are reflected immediately.
                let metrics = Self::get_metrics(env.clone());
                env.storage()
                    .instance()
                    .set(&Symbol::new(env, "metrics"), &metrics);

                env.events()
                    .publish((Symbol::new(env, "prices_updated"),), (price_a, price_b));
            }
            PendingAdminAction::MinDepositAmounts(min_a, min_b) => {
                env.storage()
                    .instance()
                    .set(&Symbol::new(env, "min_deposit_a"), &min_a);
                env.storage()
                    .instance()
                    .set(&Symbol::new(env, "min_deposit_b"), &min_b);

                env.events()
                    .publish((Symbol::new(env, "min_deposit_updated"),), (min_a, min_b));
            }
            PendingAdminAction::MinWithdrawShares(min_shares) => {
                env.storage()
                    .instance()
                    .set(&Symbol::new(env, "min_withdraw_shares"), &min_shares);

                env.events().publish(
                    (Symbol::new(env, "min_withdraw_shares_updated"),),
                    (min_shares,),
                );
            }
            PendingAdminAction::Treasury(treasury) => {
                let previous = Self::get_treasury(env.clone());
                env.storage()
                    .instance()
                    .set(&Symbol::new(env, "treasury"), &treasury);

                env.events().publish(
                    (Symbol::new(env, "treasury_updated"),),
                    (previous, treasury),
                );
            }
            PendingAdminAction::TimelockDelay(delay) => {
                env.storage()
                    .instance()
                    .set(&Symbol::new(env, "timelock_delay"), &delay);

                env.events()
                    .publish((Symbol::new(env, "timelock_delay_updated"),), (delay,));
            }
        }
    }

    /// Get admin address
    ///
    /// Fails with [`VaultError::NotInitialized`] before `initialize` has run.
    fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_or_else(|| env.panic_with_error(VaultError::NotInitialized))
    }

    /// Check if vault is paused
    fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }

    /// Require vault not paused
    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            env.panic_with_error(VaultError::Paused);
        }
    }

    /// Pause vault (admin only)
    pub fn pause(env: Env, admin: Address) {
        let current_admin = Self::get_admin(env.clone());
        if admin != current_admin {
            panic_with_error!(&env, VaultError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);
        env.events()
            .publish((Symbol::new(&env, "vault_paused"),), (admin,));
    }

    /// Unpause vault (admin only)
    pub fn unpause(env: Env, admin: Address) {
        let current_admin = Self::get_admin(env.clone());
        if admin != current_admin {
            panic_with_error!(&env, VaultError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);
        env.events()
            .publish((Symbol::new(&env, "vault_unpaused"),), (admin,));
    }

    /// Require the caller to be the vault admin
    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            env.panic_with_error(VaultError::Unauthorized);
        }
    }

    /// Configure the emergency multisig signer set (admin only).
    ///
    /// The caller must be the vault admin. Replaces the entire signer set,
    /// so a fresh `emergency_pause`/`emergency_unpause` requires the new set.
    pub fn set_emergency_signers(env: Env, admin: Address, signers: Vec<Address>) {
        Self::require_admin(&env, admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "emergency_signers"), &signers);
    }

    /// Set the number of approvals required to execute an emergency action
    /// (admin only). Must be at least 1.
    pub fn set_emergency_threshold(env: Env, admin: Address, threshold: u32) {
        Self::require_admin(&env, admin);
        if threshold == 0 {
            panic_with_error!(&env, VaultError::ThresholdMustBePositive);
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "emergency_threshold"), &threshold);
    }

    /// Get the emergency multisig signer set
    pub fn get_emergency_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "emergency_signers"))
            .unwrap_or(Vec::new(&env))
    }

    /// Get the emergency multisig approval threshold
    pub fn get_emergency_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "emergency_threshold"))
            .unwrap_or(3u32)
    }

    /// Require `threshold` distinct signers from the authorized set have been
    /// provided. Enforces the 3-of-N (configurable) emergency multisig pattern.
    fn require_multisig(env: &Env, signers: Vec<Address>) {
        let threshold = Self::get_emergency_threshold(env.clone());
        let authorized = Self::get_emergency_signers(env.clone());

        let mut valid = 0u32;
        for signer in signers.iter() {
            for candidate in authorized.iter() {
                if signer == candidate {
                    valid += 1;
                    break;
                }
            }
        }

        if valid < threshold {
            env.panic_with_error(VaultError::InsufficientEmergencySignatures);
        }
    }

    /// Emergency pause (multisig required)
    pub fn emergency_pause(env: Env, signers: Vec<Address>) {
        Self::require_multisig(&env, signers);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);

        env.events()
            .publish(("emergency_pause",), (env.current_contract_address(),));
    }

    /// Emergency unpause (multisig required)
    pub fn emergency_unpause(env: Env, signers: Vec<Address>) {
        Self::require_multisig(&env, signers);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);

        env.events()
            .publish(("emergency_unpause",), (env.current_contract_address(),));
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{
        token::{StellarAssetClient, TokenClient},
        Env, Symbol,
    };

    fn setup(
        env: &Env,
        fee_rate: u32,
        harvest_fee: u32,
        withdrawal_fee: u32,
    ) -> (
        YieldVaultClient<'_>,
        TokenClient<'_>,
        TokenClient<'_>,
        StellarAssetClient<'_>,
        StellarAssetClient<'_>,
        Address,
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

        let vault_id = env.register(YieldVault, ());
        let vault = YieldVaultClient::new(env, &vault_id);

        vault.initialize(
            &admin,
            &Symbol::new(env, "TestVault"),
            &token_a.address(),
            &token_b.address(),
            &pool_id,
            &1,
            &fee_rate,
            &harvest_fee,
            &withdrawal_fee,
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
            treasury,
        )
    }

    fn mint_pair(
        _token_a_client: &TokenClient,
        _token_b_client: &TokenClient,
        token_a_admin: &StellarAssetClient,
        token_b_admin: &StellarAssetClient,
        to: &Address,
        amount_a: i128,
        amount_b: i128,
    ) {
        token_a_admin.mint(to, &amount_a);
        token_b_admin.mint(to, &amount_b);
    }

    #[test]
    fn test_first_deposit_uses_combined_value() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        // Token-B-only first deposit must still mint shares
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user,
            0,
            100,
        );
        let shares = vault.deposit(&user, &0, &100, &0);

        assert_eq!(shares, 100);
        assert_eq!(vault.get_user_position(&user).shares, 100);
    }

    #[test]
    fn test_subsequent_deposit_pricing_uses_combined_value() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user1, _, _) =
            setup(&env, 0, 0, 0);
        let user2 = Address::generate(&env);
        let user3 = Address::generate(&env);

        // First deposit: 100 A + 100 B -> 200 shares (1:1 combined value)
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user1,
            100,
            100,
        );
        let shares1 = vault.deposit(&user1, &100, &100, &0);
        assert_eq!(shares1, 200);

        // Token-B-only deposit: 100 B out of 200 total value -> 100 shares
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user2,
            0,
            100,
        );
        let shares2 = vault.deposit(&user2, &0, &100, &0);
        assert_eq!(shares2, 100);

        // Mixed deposit: 50 A + 50 B out of 200 total value -> 100 shares
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user3,
            50,
            50,
        );
        let shares3 = vault.deposit(&user3, &50, &50, &0);
        assert_eq!(shares3, 100);

        // Vault state reflects both tokens
        let metrics = vault.get_metrics();
        assert_eq!(metrics.total_shares, 400);
        assert_eq!(metrics.total_amount_a, 150);
        assert_eq!(metrics.total_amount_b, 250);
    }

    #[test]
    fn test_deposit_enforces_min_shares() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user,
            10,
            10,
        );
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.deposit(&user, &10, &10, &100);
        }));

        assert!(result.is_err(), "deposit below min_shares must panic");
    }

    #[test]
    fn test_first_deposit_balanced_mints_combined_value_shares() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _token_a_client, _token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);

        // The shipped share math mints the combined value of both legs, which is
        // what the other deposit tests in this module assert.
        let shares = vault.deposit(&user, &1000, &1000, &0);
        assert_eq!(shares, 2000);
    }

    #[test]
    fn test_first_deposit_unbalanced_uses_nonzero_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _token_a_client, _token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &2000);
        token_b_admin.mint(&user, &500);

        let shares = vault.deposit(&user, &2000, &500, &0);
        assert_eq!(shares, 2500);
    }

    #[test]
    fn test_subsequent_deposit_mints_proportional_shares() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _token_a_client, _token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        let first_shares = vault.deposit(&user, &1000, &1000, &0);

        token_a_admin.mint(&user, &500);
        token_b_admin.mint(&user, &500);
        let second_shares = vault.deposit(&user, &500, &500, &0);

        assert_eq!(first_shares, 2000);
        assert_eq!(second_shares, 1000);
    }

    #[test]
    fn test_withdraw_returns_tokens_and_burns_shares() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _token_a_client, _token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        let (amount_a, amount_b) = vault.withdraw(&user, &2000, &0, &0);
        assert_eq!(amount_a, 1000);
        assert_eq!(amount_b, 1000);
        assert_eq!(vault.get_user_position(&user).shares, 0);
    }

    #[test]
    fn test_withdrawal_fee_is_applied() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (
            vault,
            token_a_client,
            token_b_client,
            token_a_admin,
            token_b_admin,
            user,
            _,
            treasury,
        ) = setup(&env, 0, 0, 100);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        // 1000 + 1000 mints 2000 combined-value shares, so the whole position is
        // 2000 shares and the 1% fee is 10 per token.
        vault.deposit(&user, &1000, &1000, &0);

        let (amount_a, amount_b) = vault.withdraw(&user, &2000, &0, &0);
        assert_eq!(amount_a, 990);
        assert_eq!(amount_b, 990);
        assert_eq!(token_a_client.balance(&treasury), 10);
        assert_eq!(token_b_client.balance(&treasury), 10);
    }

    // ============ TREASURY FEE ROUTING TESTS (Issue #110) ============

    #[test]
    fn test_treasury_is_recorded_at_initialize() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, _, treasury) = setup(&env, 0, 0, 0);

        assert_eq!(vault.get_treasury(), treasury);
    }

    #[test]
    fn test_harvest_fee_routed_to_treasury_not_admin() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        // 1% harvest fee, no withdrawal or performance fee
        let (
            vault,
            token_a_client,
            token_b_client,
            token_a_admin,
            token_b_admin,
            user,
            admin,
            treasury,
        ) = setup(&env, 0, 100, 0);

        // The vault needs a balance to pay the fee out of.
        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);

        vault.harvest(&admin);

        // calculate_pending_rewards returns 1000 per token, so the 1% fee is 10.
        assert_eq!(token_a_client.balance(&treasury), 10);
        assert_eq!(token_b_client.balance(&treasury), 10);
        assert_eq!(token_a_client.balance(&admin), 0);
        assert_eq!(token_b_client.balance(&admin), 0);
    }

    #[test]
    fn test_withdrawal_fee_does_not_reach_the_admin() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (
            vault,
            token_a_client,
            token_b_client,
            token_a_admin,
            token_b_admin,
            user,
            admin,
            treasury,
        ) = setup(&env, 0, 0, 100);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        // 2000 combined-value shares are minted, so the full exit is 2000 shares.
        vault.deposit(&user, &1000, &1000, &0);
        vault.withdraw(&user, &2000, &0, &0);

        assert_eq!(token_a_client.balance(&treasury), 10);
        assert_eq!(token_b_client.balance(&treasury), 10);
        assert_eq!(token_a_client.balance(&admin), 0);
        assert_eq!(token_b_client.balance(&admin), 0);
    }

    // ============ WITHDRAWAL PACING TESTS (Issue #302) ============

    #[test]
    fn test_withdraw_pacing_is_disabled_by_default() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        let pacing = vault.get_withdraw_pacing();
        assert_eq!(pacing.user_max_bps, 0);
        assert_eq!(pacing.vault_max_bps, 0);
        assert_eq!(pacing.window_seconds, 0);

        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user,
            1000,
            1000,
        );
        vault.deposit(&user, &1000, &1000, &0);

        // With pacing off the historical behaviour is unchanged: one call can
        // still close the whole position.
        vault.withdraw(&user, &2000, &0, &0);
        assert_eq!(vault.get_user_position(&user).shares, 0);
    }

    #[test]
    fn test_user_pacing_limits_an_abrupt_exit() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, admin, _) =
            setup(&env, 0, 0, 0);

        env.ledger().set_timestamp(1_000);
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user,
            1000,
            1000,
        );
        vault.deposit(&user, &1000, &1000, &0);

        // At most half of the position may leave per one-hour window.
        vault.set_withdraw_pacing(&admin, &5000, &0, &3600);

        vault.withdraw(&user, &1000, &0, &0);
        assert_eq!(vault.get_user_withdraw_window(&user).shares_withdrawn, 1000);

        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.withdraw(&user, &1000, &0, &0);
        }));
        assert!(
            blocked.is_err(),
            "a second 50% exit in the same window must be rejected"
        );
        assert_eq!(vault.get_user_position(&user).shares, 1000);

        // A fresh window resets the budget: 50% of the remaining 1000 shares.
        env.ledger().set_timestamp(1_000 + 3601);
        vault.withdraw(&user, &500, &0, &0);
        assert_eq!(vault.get_user_position(&user).shares, 500);
    }

    #[test]
    fn test_vault_pacing_caps_a_mass_exit() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, admin, _) =
            setup(&env, 0, 0, 0);
        let other = Address::generate(&env);

        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user,
            1000,
            1000,
        );
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &other,
            1000,
            1000,
        );
        vault.deposit(&user, &1000, &1000, &0); // 2000 shares
        vault.deposit(&other, &1000, &1000, &0); // 4000 shares total

        // At most 30% of the vault's shares may leave per one-hour window.
        vault.set_withdraw_pacing(&admin, &0, &3000, &3600);

        // 25% of the vault leaves with the first user.
        vault.withdraw(&user, &1000, &0, &0);
        assert_eq!(vault.get_vault_withdraw_window().shares_withdrawn, 1000);

        // A second 25% would take the window to 50%: constrained to the 30%.
        let blocked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.withdraw(&other, &1000, &0, &0);
        }));
        assert!(blocked.is_err(), "the vault-wide cap must bound mass exits");

        // 5% more fits exactly inside the remaining 5% of the allowance.
        vault.withdraw(&other, &200, &0, &0);
        assert_eq!(vault.get_vault_withdraw_window().shares_withdrawn, 1200);
    }

    #[test]
    fn test_set_withdraw_pacing_is_admin_only() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, ..) = setup(&env, 0, 0, 0);
        let stranger = Address::generate(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.set_withdraw_pacing(&stranger, &5000, &0, &3600);
        }));

        assert!(result.is_err(), "pacing limits must be admin only");
        assert_eq!(vault.get_withdraw_pacing().user_max_bps, 0);
    }

    #[test]
    fn test_set_withdraw_pacing_validates_limits() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, admin, _) = setup(&env, 0, 0, 0);

        // Above 100% is not a meaningful limit.
        let too_high = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.set_withdraw_pacing(&admin, &10001, &0, &3600);
        }));
        assert!(too_high.is_err());

        // An enabled limit needs a window to apply over.
        let no_window = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.set_withdraw_pacing(&admin, &0, &5000, &0);
        }));
        assert!(no_window.is_err());
    }

    #[test]
    fn test_set_treasury_requires_admin() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, _, treasury) = setup(&env, 0, 0, 0);
        let stranger = Address::generate(&env);
        let new_treasury = Address::generate(&env);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.propose_set_treasury(&stranger, &new_treasury);
        }));

        assert!(result.is_err(), "treasury rotation must be admin only");
        assert_eq!(vault.get_treasury(), treasury);
    }

    #[test]
    fn test_set_treasury_redirects_fees() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (
            vault,
            token_a_client,
            token_b_client,
            token_a_admin,
            token_b_admin,
            user,
            admin,
            treasury,
        ) = setup(&env, 0, 0, 100);
        let new_treasury = Address::generate(&env);

        // Rotation is timelocked: propose, wait out the delay, then execute.
        let action = vault.propose_set_treasury(&admin, &new_treasury);
        env.ledger().set_timestamp(vault.get_timelock_delay() + 1);
        vault.execute_pending_action(&admin, &action);
        assert_eq!(vault.get_treasury(), new_treasury);

        token_a_admin.mint(&user, &1000);
        token_b_admin.mint(&user, &1000);
        vault.deposit(&user, &1000, &1000, &0);
        vault.withdraw(&user, &2000, &0, &0);

        // Fees collected after the rotation go to the new treasury only.
        assert_eq!(token_a_client.balance(&new_treasury), 10);
        assert_eq!(token_b_client.balance(&new_treasury), 10);
        assert_eq!(token_a_client.balance(&treasury), 0);
    }

    // ============ ADMIN TIMELOCK TESTS (Issue #301) ============

    #[test]
    fn test_default_timelock_delay_is_applied_at_initialize() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, ..) = setup(&env, 0, 0, 0);
        assert_eq!(vault.get_timelock_delay(), DEFAULT_TIMELOCK_DELAY);
    }

    #[test]
    fn test_economic_param_change_requires_the_timelock_to_elapse() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, admin, _) = setup(&env, 0, 0, 0);

        let action = vault.propose_set_prices(&admin, &11, &22);

        // Queued, not applied.
        assert_eq!(vault.get_prices(), (0, 0));
        assert_eq!(vault.get_pending_action(&action).unwrap().id, action);

        // Executing early is rejected and leaves the action queued.
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.execute_pending_action(&admin, &action);
        }));
        assert!(early.is_err(), "an unexpired change must be rejected");
        assert_eq!(vault.get_prices(), (0, 0));
        assert!(vault.get_pending_action(&action).is_some());

        // Once the delay has elapsed it applies, and cannot be replayed.
        env.ledger().set_timestamp(DEFAULT_TIMELOCK_DELAY + 1);
        vault.execute_pending_action(&admin, &action);
        assert_eq!(vault.get_prices(), (11, 22));
        assert!(vault.get_pending_action(&action).is_none());

        let replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.execute_pending_action(&admin, &action);
        }));
        assert!(replay.is_err(), "an executed action must not be replayable");
    }

    #[test]
    fn test_pending_action_can_be_cancelled() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, admin, _) = setup(&env, 0, 0, 0);

        let action = vault.propose_set_min_deposit_amounts(&admin, &5, &5);
        assert!(vault.get_pending_action(&action).is_some());

        vault.cancel_pending_action(&admin, &action);
        assert!(vault.get_pending_action(&action).is_none());

        env.ledger().set_timestamp(DEFAULT_TIMELOCK_DELAY + 1);
        let executed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.execute_pending_action(&admin, &action);
        }));
        assert!(executed.is_err(), "a cancelled action must not apply");

        // The previous minimum is untouched.
        assert_eq!(
            vault.get_min_deposit_amounts(),
            (DEFAULT_MIN_DEPOSIT, DEFAULT_MIN_DEPOSIT)
        );
    }

    #[test]
    fn test_each_economic_action_takes_effect_after_the_delay() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, admin, _) = setup(&env, 0, 0, 0);
        let new_treasury = Address::generate(&env);

        let deposits = vault.propose_set_min_deposit_amounts(&admin, &11, &22);
        let withdrawals = vault.propose_set_min_withdraw_shares(&admin, &33);
        let prices = vault.propose_set_prices(&admin, &44, &55);
        let treasury = vault.propose_set_treasury(&admin, &new_treasury);

        env.ledger().set_timestamp(DEFAULT_TIMELOCK_DELAY + 1);
        vault.execute_pending_action(&admin, &deposits);
        vault.execute_pending_action(&admin, &withdrawals);
        vault.execute_pending_action(&admin, &prices);
        vault.execute_pending_action(&admin, &treasury);

        assert_eq!(vault.get_min_deposit_amounts(), (11, 22));
        assert_eq!(vault.get_min_withdraw_shares(), 33);
        assert_eq!(vault.get_prices(), (44, 55));
        assert_eq!(vault.get_treasury(), new_treasury);
    }

    #[test]
    fn test_timelock_delay_can_only_be_changed_through_the_timelock() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, admin, _) = setup(&env, 0, 0, 0);

        // Even setting the delay to zero has to wait out the current delay.
        let change = vault.propose_set_timelock_delay(&admin, &0);
        let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.execute_pending_action(&admin, &change);
        }));
        assert!(early.is_err());
        assert_eq!(vault.get_timelock_delay(), DEFAULT_TIMELOCK_DELAY);

        env.ledger().set_timestamp(DEFAULT_TIMELOCK_DELAY + 1);
        vault.execute_pending_action(&admin, &change);
        assert_eq!(vault.get_timelock_delay(), 0);

        // With a zero delay, propose and execute happen in the same ledger.
        let action = vault.propose_set_prices(&admin, &7, &9);
        vault.execute_pending_action(&admin, &action);
        assert_eq!(vault.get_prices(), (7, 9));
    }

    #[test]
    fn test_timelock_operations_are_admin_only() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, admin, _) = setup(&env, 0, 0, 0);
        let stranger = Address::generate(&env);

        let proposed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.propose_set_prices(&stranger, &1, &1);
        }));
        assert!(proposed.is_err(), "only the admin may queue changes");

        let action = vault.propose_set_prices(&admin, &1, &1);

        let executed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.execute_pending_action(&stranger, &action);
        }));
        assert!(executed.is_err(), "only the admin may execute changes");

        let cancelled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.cancel_pending_action(&stranger, &action);
        }));
        assert!(cancelled.is_err(), "only the admin may cancel changes");
    }

    #[test]
    fn test_invalid_values_are_rejected_when_the_action_is_proposed() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, admin, _) = setup(&env, 0, 0, 0);

        let negative_price = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.propose_set_prices(&admin, &-1, &1);
        }));
        assert!(negative_price.is_err());

        let negative_minimum = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.propose_set_min_deposit_amounts(&admin, &-1, &0);
        }));
        assert!(negative_minimum.is_err());

        let zero_withdraw_minimum = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            vault.propose_set_min_withdraw_shares(&admin, &0);
        }));
        assert!(zero_withdraw_minimum.is_err());
    }

    // ─── Per-user harvest tracking (Issue #116) ───────────────────────────────

    #[test]
    fn test_withdraw_stamps_user_last_harvest() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        env.ledger().set_timestamp(1_000);
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user,
            1000,
            1000,
        );
        vault.deposit(&user, &1000, &1000, &0);
        assert_eq!(vault.get_user_position(&user).last_harvest, 1_000);

        env.ledger().set_timestamp(5_500);
        vault.withdraw(&user, &500, &0, &0);

        let position = vault.get_user_position(&user);
        assert_eq!(
            position.last_harvest, 5_500,
            "withdraw must stamp the withdrawing user's last harvest"
        );
        assert_eq!(
            position.shares, 1500,
            "partial exit keeps the remaining shares"
        );
    }

    #[test]
    fn test_full_exit_stamps_user_last_harvest() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, _, _) =
            setup(&env, 0, 0, 0);

        env.ledger().set_timestamp(1_000);
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user,
            1000,
            1000,
        );
        vault.deposit(&user, &1000, &1000, &0);

        env.ledger().set_timestamp(9_000);
        vault.withdraw(&user, &2000, &0, &0);

        let position = vault.get_user_position(&user);
        assert_eq!(position.shares, 0);
        assert_eq!(position.last_harvest, 9_000);
    }

    #[test]
    fn test_harvest_stamps_only_the_caller() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        // No harvest fee, so the vault needs no token balance to reinvest.
        let (vault, token_a_client, token_b_client, token_a_admin, token_b_admin, user, admin, _) =
            setup(&env, 0, 0, 0);
        let other = Address::generate(&env);

        env.ledger().set_timestamp(1_000);
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &user,
            1000,
            1000,
        );
        mint_pair(
            &token_a_client,
            &token_b_client,
            &token_a_admin,
            &token_b_admin,
            &other,
            100,
            100,
        );
        vault.deposit(&user, &1000, &1000, &0);
        vault.deposit(&other, &100, &100, &0);

        env.ledger().set_timestamp(4_000);
        vault.harvest(&user);

        assert_eq!(
            vault.get_user_position(&user).last_harvest,
            4_000,
            "harvest must stamp the caller's last harvest"
        );
        assert_eq!(
            vault.get_user_position(&other).last_harvest,
            1_000,
            "another holder's last harvest is untouched by someone else's harvest"
        );
        assert_eq!(
            vault.get_metrics().last_harvest,
            4_000,
            "the vault-wide harvest timestamp still advances"
        );
        // The admin never deposited, so harvesting on their behalf must not
        // create a position record for them.
        assert_eq!(vault.get_user_position(&admin).last_harvest, 0);
    }

    #[test]
    fn test_harvest_does_not_create_position_for_non_holder() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _, _, _, _, _, _, _) = setup(&env, 0, 0, 0);
        let stranger = Address::generate(&env);

        env.ledger().set_timestamp(7_000);
        vault.harvest(&stranger);

        let position = vault.get_user_position(&stranger);
        assert_eq!(position.shares, 0);
        assert_eq!(
            position.last_harvest, 0,
            "a caller with no position must not get a harvest timestamp written"
        );
    }

    // ==================== Typed error paths ====================

    #[test]
    fn test_deposit_reports_typed_errors() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _ta, _tb, _ta_admin, _tb_admin, user, admin, _) = setup(&env, 0, 0, 0);

        // Both legs zero.
        let err = vault.try_deposit(&user, &0, &0, &0).unwrap_err().unwrap();
        assert_eq!(err, VaultError::DepositMustBePositive.into());

        // A negative leg trips the per-leg minimum check first.
        let err = vault.try_deposit(&user, &-1, &0, &0).unwrap_err().unwrap();
        assert_eq!(err, VaultError::AmountBelowMinimum.into());

        // A positive deposit below the configured minimum for one leg. The
        // minimum is an economic parameter, so it moves through the timelock.
        let action = vault.propose_set_min_deposit_amounts(&admin, &10, &0);
        env.ledger().set_timestamp(DEFAULT_TIMELOCK_DELAY + 1);
        vault.execute_pending_action(&admin, &action);
        let err = vault.try_deposit(&user, &5, &0, &0).unwrap_err().unwrap();
        assert_eq!(err, VaultError::AmountBelowMinimum.into());
    }

    #[test]
    fn test_withdraw_reports_typed_errors() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _ta, _tb, ta_admin, tb_admin, user, admin, _) = setup(&env, 0, 0, 0);
        ta_admin.mint(&user, &1_000);
        tb_admin.mint(&user, &1_000);
        vault.deposit(&user, &500, &500, &0);

        // Zero shares.
        let err = vault.try_withdraw(&user, &0, &0, &0).unwrap_err().unwrap();
        assert_eq!(err, VaultError::SharesMustBePositive.into());

        // More shares than held.
        let err = vault
            .try_withdraw(&user, &10_000, &0, &0)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, VaultError::InsufficientShares.into());

        // Min shares below the configured withdrawal minimum; same timelock
        // path as every other economic parameter.
        let action = vault.propose_set_min_withdraw_shares(&admin, &100);
        env.ledger().set_timestamp(DEFAULT_TIMELOCK_DELAY + 1);
        vault.execute_pending_action(&admin, &action);
        let err = vault.try_withdraw(&user, &50, &0, &0).unwrap_err().unwrap();
        assert_eq!(err, VaultError::WithdrawalBelowMinimum.into());
    }

    #[test]
    fn test_admin_setters_report_typed_unauthorized() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _ta, _tb, _ta_admin, _tb_admin, _user, _admin, _) = setup(&env, 0, 0, 0);

        let stranger = Address::generate(&env);
        let err = vault
            .try_propose_set_min_deposit_amounts(&stranger, &10, &10)
            .unwrap_err()
            .unwrap();
        assert_eq!(err, VaultError::Unauthorized.into());

        let err = vault.try_pause(&stranger).unwrap_err().unwrap();
        assert_eq!(err, VaultError::Unauthorized.into());
    }

    #[test]
    fn test_set_prices_reports_typed_errors() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _ta, _tb, _ta_admin, _tb_admin, _user, admin, _) = setup(&env, 0, 0, 0);

        let err = vault.try_set_prices(&admin, &-1, &1).unwrap_err().unwrap();
        assert_eq!(err, VaultError::NegativePrice.into());

        let err = vault.try_set_prices(&admin, &1, &-1).unwrap_err().unwrap();
        assert_eq!(err, VaultError::NegativePrice.into());
    }

    #[test]
    fn test_paused_vault_rejects_deposit_with_typed_error() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _ta, _tb, ta_admin, _tb_admin, user, admin, _) = setup(&env, 0, 0, 0);
        ta_admin.mint(&user, &1_000);

        vault.pause(&admin);
        let err = vault.try_deposit(&user, &100, &0, &0).unwrap_err().unwrap();
        assert_eq!(err, VaultError::Paused.into());
    }

    #[test]
    fn test_emergency_unpause_requires_enough_signatures() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (vault, _ta, _tb, _ta_admin, _tb_admin, _user, admin, _) = setup(&env, 0, 0, 0);

        let s1 = Address::generate(&env);
        let s2 = Address::generate(&env);
        vault.set_emergency_signers(&admin, &Vec::from_array(&env, [s1.clone(), s2.clone()]));
        vault.set_emergency_threshold(&admin, &2);
        vault.emergency_pause(&Vec::from_array(&env, [s1.clone(), s2.clone()]));

        // Only one of the two required signers.
        let err = vault
            .try_emergency_unpause(&Vec::from_array(&env, [s1]))
            .unwrap_err()
            .unwrap();
        assert_eq!(err, VaultError::InsufficientEmergencySignatures.into());
    }

    // ─── Insurance Integration ────────────────────────────────────────────────
    //
    // These helpers were written as if they lived inside the contract's
    // `impl YieldVault` block but were placed in the test module, where `Self`
    // does not resolve. Wrapping them in an inherent impl keeps them compiled
    // and callable from tests without exposing them as contract entrypoints.
    impl YieldVault {
        /// One-click deposit + insurance purchase.
        ///
        /// Deposits tokens into the vault and simultaneously purchases an insurance
        /// policy covering the deposit against impermanent loss.
        /// Returns (shares_minted, policy_id).
        pub fn deposit_with_insurance(
            env: Env,
            user: Address,
            amount_a: i128,
            amount_b: i128,
            min_shares: i128,
            coverage_period: u64,
            current_price_ratio_scaled: i128,
            historical_volatility_bps: u32,
            pool_correlation_bps: u32,
            auto_renew: bool,
            _insurance_contract: Address,
            reserve_token: Address,
        ) -> (i128, u64) {
            Self::require_not_paused(&env);

            // Step 1: Standard deposit
            let shares = Self::deposit(env.clone(), user.clone(), amount_a, amount_b, min_shares);

            // Step 2: Purchase insurance covering deposit amount_a as proxy for coverage
            // The coverage amount is the value of token_a deposited (simplified)
            use crate::il_insurance::ILInsurance;
            let policy_id = ILInsurance::purchase_insurance(
                env.clone(),
                user.clone(),
                amount_a,
                coverage_period,
                current_price_ratio_scaled,
                historical_volatility_bps,
                pool_correlation_bps,
                auto_renew,
                reserve_token,
            );

            env.events().publish(
                (Symbol::new(&env, "insured_deposit"), user),
                (shares, policy_id, amount_a, coverage_period),
            );

            (shares, policy_id)
        }

        /// Returns the effective APY net of insurance premium cost.
        ///
        /// insured_apy = vault_apy - annualised_premium_cost_bps
        /// where annualised_premium_cost = (premium_bps / coverage_days) * 365
        pub fn get_insured_apy(env: Env, coverage_period_days: u32, premium_bps: u32) -> i32 {
            let metrics = Self::get_metrics(env);
            let vault_apy = metrics.apy as i32;

            if coverage_period_days == 0 {
                return vault_apy;
            }

            // Annualise the premium: (premium_bps / coverage_days) * 365
            let annualised_premium_bps = (premium_bps as i32 * 365) / coverage_period_days as i32;

            vault_apy - annualised_premium_bps
        }

        /// Check if a policy is eligible for auto-renewal and return the renewal premium.
        /// Auto-renewal extends coverage using harvested yield from the user's position.
        /// Returns (eligible, estimated_premium) – both zero if not eligible.
        pub fn check_auto_renewal_eligibility(
            env: Env,
            user: Address,
            min_yield_threshold: i128,
        ) -> (bool, i128) {
            let position = Self::get_user_position(env.clone(), user.clone());
            let metrics = Self::get_metrics(env);

            // Estimate accrued yield for the user's share of the vault
            if metrics.total_shares == 0 {
                return (false, 0);
            }
            let user_share_of_total = position.shares * 10000 / metrics.total_shares;
            let estimated_yield_a =
                metrics.total_amount_a * user_share_of_total / 10000 - position.deposited_amount_a;

            if estimated_yield_a >= min_yield_threshold {
                // Estimated premium for 30-day renewal at base rate (0.5%)
                let renewal_premium = position.deposited_amount_a * 50 / 10000;
                (true, renewal_premium)
            } else {
                (false, 0)
            }
        }
    }
}
