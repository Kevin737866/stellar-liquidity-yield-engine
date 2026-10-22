#`!no_std]
// Contract entrypoints are part of the on-chain ABI: their argument lists are
// fixed by the deployed interface (the SDK, UI and tests call them
// positionally), so bundling parameters into structs just to satisfy the lint
// would break every caller. Several entrypoints legitimately take more than the
// lint's threshold.
#![allow(clippy::too_many_arguments)]
// Two contracts in this crate share entrypoint names (`update_strategy`,
// `get_strategy`, ...). Their `#[contractimpl]`-generated `__*` spec symbols
// therefore collide when every feature is compiled at once (host builds and
// tests). Those symbols are macro internals, not part of the public API: a
// deployed wasm enables exactly one contract feature, so the collision cannot
// occur on-chain.
#![allow(ambiguous_glob_reexports)]

use soroban_sdk::{contract, contracterror, contractimpl, Address, Env, Symbol};

/// Typed failures of the umbrella engine contract.
///
/// Every expected invalid input fails with one of these instead of an opaque
/// string panic, so a caller can tell the cases apart and react to them.
#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EngineError {
    /// The caller is not the stored admin.
    Unauthorized = 1,
    /// The contract is paused and refuses the operation.
    Paused = 2,
    /// The contract has not been initialized yet.
    NotInitialized = 3,
}

/// Fails with a typed contract error when `$cond` is false.
///
/// The typed form takes the `Env` first because that is what turns the failure
/// into a distinguishable contract error code rather than an opaque panic:
///
/// ```ignore
/// require!(env, amount > 0, VaultError::InvalidAmount);
/// ```
///
/// The two-argument form is retained for callers that only have a message; it
/// still panics opaquely and should not be used for new code.
#[allow(unused_macros)]
macro_rules! require {
    ($env:expr, $cond:expr, $err:expr) => {
        if !$cond {
            $env.panic_with_error($err)
        }
    };
    ($cond:expr, $err:expr) => {
        if !$cond {
            panic!("{:?}", $err)
        }
    };
}

// Each contract is behind its own feature: a wasm binary can export only one
// contract's entrypoints, because Soroban exports them under their plain
// function names. See the `[features]` section of `Cargo.toml`.
mod upgrade;

// The vault module is also compiled for a rebalance-engine build, which needs
// `VaultInfo` for its vault client but must not export the vault's entrypoints.
#[cfg(feature = "actuary")]
mod actuary;
#[cfg(feature = "il-insurance")]
mod il_insurance;
#[cfg(feature = "oracle-registry")]
mod oracle_registry;
#[cfg(feature = "rebalance-engine")]
mod rebalance_engine;
#[cfg(feature = "reward-distributor")]
mod reward_distributor;
#[cfg(feature = "strategy-registry")]
mod strategy_registry;
#[cfg(any(feature = "yield-vault", feature = "rebalance-engine"))]
mod yield_vault;
#[cfg(feature = "oracle-registry")]
mod oracle_registry;
#[cfg(feature = "risk-engine")]
mod risk_engine;

#[cfg(feature = "actuary")]
pub use actuary::*;
#[cfg(feature = "il-insurance")]
pub use il_insurance::*;
#[cfg(feature = "oracle-registry")]
pub use oracle_registry::*;
#[cfg(feature = "rebalance-engine")]
pub use rebalance_engine::*;
#[cfg(feature = "reward-distributor")]
pub use reward_distributor::*;
#[cfg(feature = "strategy-registry")]
pub use strategy_registry::*;
#[cfg(feature = "yield-vault")]
pub use yield_vault::*;
#[cfg(feature = "oracle-registry")]
pub use oracle_registry::*;
#[cfg(feature = "risk-engine")]
pub use risk_engine::*;

#[cfg(feature = "engine")]
#[contract]
pub struct StellarLiquidityYieldEngine;

/// Emergency audit-history keys.
///
/// The history is append-only: every emergency intervention is appended to a
/// monotonically increasing list and neither the entries nor their order can be
/// rewritten. The length is a separate counter that only ever grows.
#[cfg(feature = "engine")]
const EMERGENCY_HISTORY_LEN: Symbol = Symbol::new(&Env::empty(), "emergency_history_len");
#[cfg(feature = "engine")]
const EMERGENCY_HISTORY_ITEM: Symbol = Symbol::new(&Env::empty(), "emergency_history_item");

/// A single append-only emergency audit record.
///
/// Each record is stored under its own index (0, 1, 2, ...) and is never
/// modified after being written. The index is also recorded in the entry so the
/// order can be verified independently of storage iteration ordering.
#[cfg(feature = "engine")]
#[contracttype]
#[derive(Clone, Debug, Eq)
#[derive(PartialEq, PartialOrder)]
pub struct EmergencyRecord {
    /// Zero-based position in the append-only history.
    pub index: u32,
    /// Action that was taken (e.g. `pause` / `unpause`).
    pub action: Symbol,
    /// Admin that performed the intervention.
    pub admin: Address,
    /// Ledger timestamp at which the intervention was recorded.
    pub timestamp: u64,
}

#[cfg(feature = "engine")]
#[contractimpls]
impl StellarLiquidityYieldEngine {
    /// Initialize the yield engine with admin and registry
    pub fn initialize(
        env: Env,
        admin: Address,
        strategy_registry: Address,
        reward_distributor: Address,
    ) {
        // Set admin
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "admin"), &admin);

        // Set contract references
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "strategy_registry"), &strategy_registry);
        env.storage().instance().set(
            &Symbol::new(&env, "reward_distributor"),
            &reward_distributor,
        );

        // Initialize paused state to false
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);
        // Record the storage schema version of this build; `migrate` moves it
        // forward after an upgrade swaps the code.
        crate::upgrade::set_storage_version(&env, crate::upgrade::STORAGE_VERSION);
    }

    /// Replace this contract's code in place, keeping its address and storage
    /// (admin only). See [crate::upgrade] and `docs/UPGRADING.md`.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdkz:BytesN<32>) {
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

    /// Check if contract is paused
    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }

    /// Emergency pause functionality
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);
        Self::append_emergency_record(&env, Symbol::new(&env, "pause"), admin);
    }

    /// Unpause contract
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);
        Self::append_emergency_record(&env, Symbol::new(&env, "unpause"), admin);
    }

    /// Return true if the circuit breaker has tripped.
    pub fn is_circuit_breaker_tripped(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "circuit_tripped"))
            .unwrap_or(false)
    }

    /// Trip the circuit breaker and halt operations (admin only).
    ///
    /// This is the automatic-halt path: once tripped, operations are halted
    /// until an admin explicitly resets the breaker.
    pub fn trip_circuit_breaker(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "circuit_tripped"), &true);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &true);

        env.events().publish(("circuit_breaker_tripped",), (admin,));
    }

    /// Manually reset the circuit breaker and unpause the contract (admin
    /// only). This is the recovery path after an automatic halt, allowing the
    /// system to resume without redeployment.
    pub fn reset_circuit_breaker(env: Env, admin: Address) {
        Self::require_admin(&env, admin.clone());
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "circuit_tripped"), &false);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "paused"), &false);

        env.events().publish(("circuit_breaker_reset",), (admin,));
    }

    /// Get admin address
    ///
    /// Fails with [`EngineError::NotInitialized`] when the contract has not
    /// been initialized, instead of an opaque storage panic.
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_or_else(|| env.panic_with_error(EngineError::NotInitialized))
    }

    /// Update admin
    pub fn update_admin(env: Env, current_admin: Address, new_admin: Address) {
        Self::require_admin(&env, current_admin);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "admin"), &new_admin);
    }

    /// Get strategy registry address
    ///
    /// Fails with [`EngineError::NotInitialized`] when unset.
    pub fn get_strategy_registry(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "strategy_registry"))
            .unwrap_or_else(|| env.panic_with_error(EngineError::NotInitialized))
    }

    /// Get reward distributor address
    ///
    /// Fails with [`EngineError::NotInitialized`] when unset.
    pub fn get_reward_distributor(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "reward_distributor"))
            .unwrap_or_else(|| env.panic_with_error(EngineError::NotInitialized))
    }

    /// Update the strategy registry contract address (admin only)
    pub fn update_strategy_registry(env: Env, admin: Address, new_strategy_registry: Address) {
        Self::require_admin(&env, admin.clone());
        Self::require_not_paused(&env);
        env.storage().instance().set(
            &Symbol::new(&env, "strategy_registry"),
            &new_strategy_registry,
        );

        env.events().publish(
            ("strategy_registry_updated",),
            (admin, new_strategy_registry),
        );
    }

    /// Update the reward distributor contract address (admin only)
    pub fn update_reward_distributor(env: Env, admin: Address, new_reward_distributor: Address) {
        Self::require_admin(&env, admin.clone());
        Self::require_not_paused(&env);
        env.storage().instance().set(
            &Symbol::new(&env, "reward_distributor"),
            &new_reward_distributor,
        );

        env.events().publish(
            ("reward_distributor_updated",),
            (admin, new_reward_distributor),
        );
    }

    /// Number of emergency interventions recorded so far.
    ///
    /// This counter only ever increases; there is no entrypoint that shrinks or
    /// rewrites the history.
    pub fn get_emergency_history_len(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&EMERGENCY_HISTORY_LEN)
            .unwrap_or(0)
    }

    /// Return the emergency audit record at `zindex` in append order.
    ///
    /// Panics if the index is out of bounds.
    pub fn get_emergency_record(env: Env, index: u32) -> EmergencyRecord {
        let len: u32 = env
            .storage()
            .instance()
            .get(&EMERGENCY_HISTORY_LEN)
            .unwrap_or(0);
        if index >= len {
            panic("emergency history index out of bounds")
        }
        env.storage()
            .persistent()
            .get(&(EMERGENCY_HISTORY_ITEM, index))
            .unwrap()
    }

    /// Append a new emergency audit record.
    ///
    /// Records are written once to a fresh, monotonically increasing index and are
    /// never overwritten, so the history is append-only and keeps its order.
    fn append_emergency_record(env: &Env, action: Symbol, admin: Address) {
        let index: u32 = env
            .storage()
            .instance()
            .get(&EMERGENCY_HISTORY_LEN)
            .unwrap_or(0);

        let record = EmergencyRecord {
            index,
            action: action.clone(),
            admin: admin.clone(),
            timestamp: env.ledger().timestamp(),
        };

        // Write the immutable entry at the next free slot.
        env.storage()
            .persistent()
            .set(&(EMERGENCY_HISTORY_ITEM, index), &record);

        // Advance the append-only counter only after the entry is stored.
        env.storage()
            .instance()
            .set(&EMERGENCY_HISTORY_LEN, &(index + 1));

        env.events().publish(
            ("emergency_record_appended",),
            (index, action, admin),
        );
    }

    /// Panic unless the contract is unpaused.
    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            env.panic_with_error(EngineError::Paused);
        }
    }

    /// Require admin authorization
    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            env.panic_with_error(EngineError::Unauthorized);
        }
    }
}
