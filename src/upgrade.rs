//! In-place contract upgrades.
//!
//! Soroban has no proxy contract: `Env::deployer().update_current_contract_wasm`
//! replaces the *executing* contract's code while keeping its address, its
//! storage and its balance. That single host call is the whole upgrade
//! mechanism, and every contract in this crate exposes it through an
//! admin-only `upgrade` entrypoint that ends up here.
//!
//! Because the code is replaced under existing storage, a build whose stored
//! shapes changed has to migrate that storage itself. Each contract exposes an
//! admin-only `migrate` entrypoint for that, keyed on [`STORAGE_VERSION`]:
//!
//! 1. `initialize` records the [`STORAGE_VERSION`] of the deploying build.
//! 2. A later build that changes stored types bumps [`STORAGE_VERSION`] and
//!    extends its own `migrate` with the work the change needs.
//! 3. After `upgrade` swaps the code, the admin calls `migrate` once. It
//!    records the new version and is safe to call again, so a retry after a
//!    failed transaction cannot double-apply anything (as long as the migration
//!    work itself is written idempotently).
//!
//! Read-only configuration is exposed through [`UpgradeConfig`] and
//! [`upgrade_config`], which report the storage version recorded in the
//! instance, the version this build expects, and whether a migration is
//! pending. They never mutate state and return zero/`false` defaults for
//! contracts deployed before this module existed.
//!
//! Role rotation during an upgrade is handled by [`rotate_admin`], which is
//! the only sanctioned way to change the admin that authorizes `upgrade` and
//! `migrate`. It rejects rotation to the current admin (a no-op that would
//! hide operator mistakes) and emits an event recording both parties, so the
//! handover is auditable. Rotation must be performed *before* `upgrade` if the
//! new admin should authorize the upgrade itself.
//!
//! See `docs/UPGRADING.md` for the operational flow and the role rotation
//! procedure.

use soroban_sdk::{contracttype, Address, BytesN, Env, Symbol};

/// Storage schema version this build expects.
///
/// Bump this in the same change that alters a stored type, and add the matching
/// work to that contract's `migrate`.
pub const STORAGE_VERSION: u32 = 1;

/// Read-only snapshot of a contract instance's upgrade configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UpgradeConfig {
    /// Storage schema version recorded in this instance (`0` if never recorded).
    pub recorded_version: u32,
    /// Storage schema version this build expects.
    pub expected_version: u32,
    /// `true` when `recorded_version` is behind `expected_version`, meaning
    /// `migrate` must run after the code is upgraded.
    pub migration_pending: bool,
}

/// The recorded storage schema version of a contract's data.
///
/// `0` means "never recorded", which is what a contract deployed before this
/// module existed reads as.
pub fn storage_version(env: &Env) -> u32 {
    env.storage().instance().get(&version_key(env)).unwrap_or(0)
}

/// Read-only view of the upgrade configuration for this contract instance.
///
/// Boundary behavior: a `recorded_version` greater than `expected_version`
/// (a downgrade of the code under existing data) is reported as-is with
/// `migration_pending == false`, since no forward migration is owed; callers
/// should treat that state as an operator alert rather than a pending step.
pub fn upgrade_config(env: &Env) -> UpgradeConfig {
    let recorded_version = storage_version(env);
    UpgradeConfig {
        recorded_version,
        expected_version: STORAGE_VERSION,
        migration_pending: recorded_version < STORAGE_VERSION,
    }
}

/// Record the storage schema version of the data currently in storage.
pub fn set_storage_version(env: &Env, version: u32) {
    env.storage().instance().set(&version_key(env), &version);
}

/// Replace the current contract's code with the wasm at `new_wasm_hash`.
///
/// The new code takes effect on the *next* invocation; the call that performs
/// the upgrade finishes on the old code.
pub fn update_wasm(env: &Env, admin: &Address, new_wasm_hash: BytesN<32>) {
    env.deployer()
        .update_current_contract_wasm(new_wasm_hash.clone());

    env.events().publish(
        (Symbol::new(env, "contract_upgraded"),),
        (admin.clone(), new_wasm_hash),
    );
}

/// Adopt the schema version of this build, returning the version replaced.
pub fn mark_migrated(env: &Env, admin: &Address) -> u32 {
    let previous = storage_version(env);
    set_storage_version(env, STORAGE_VERSION);

    env.events().publish(
        (Symbol::new(env, "contract_migrated"),),
        (admin.clone(), previous, STORAGE_VERSION),
    );

    previous
}

/// Hand the admin role from `current` to `next`.
///
/// The caller must already have been authenticated as `current` by the
/// contract entrypoint. Returns an error without touching storage if `next`
/// equals `current`, so a no-op rotation cannot silently mask an operator
/// mistake (for example pasting the existing admin address into a rotation
/// script). On success the new admin is written to the instance storage under
/// the admin key, and a `admin_rotated` event records `(previous, next)`.
pub fn rotate_admin(env: &Env, current: &Address, next: &Address) -> Result<(), RotationError> {
    if current == next {
        return Err(RotationError::SameAdmin);
    }

    env.storage().instance().set(&admin_key(env), next);

    env.events().publish(
        (Symbol::new(env, "admin_rotated"),),
        (current.clone(), next.clone()),
    );

    Ok(())
}

/// The admin currently recorded in storage, if any.
pub fn current_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&admin_key(env))
}

/// Errors returned by [`rotate_admin`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RotationError {
    /// The proposed new admin is the same as the current admin.
    SameAdmin,
}

fn version_key(env: &Env) -> Symbol {
    Symbol::new(env, "storage_version")
}

fn admin_key(env: &Env) -> Symbol {
    Symbol::new(env, "admin")
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{contract, contractimpl, Env};

    #[contract]
    struct Probe;

    #[contractimpl]
    impl Probe {}

    fn with_instance<T>(f: impl FnOnce(&Env) -> T) -> T {
        let env = Env::default();
        let id = env.register(Probe, ());
        env.as_contract(&id, || f(&env))
    }

    fn set_admin(env: &Env, admin: &Address) {
        env.storage().instance().set(&admin_key(env), admin);
    }

    #[test]
    fn never_recorded_reports_pending_migration() {
        with_instance(|env| {
            let cfg = upgrade_config(env);
            assert_eq!(cfg.recorded_version, 0);
            assert_eq!(cfg.expected_version, STORAGE_VERSION);
            assert!(cfg.migration_pending);
        });
    }

    #[test]
    fn rotate_admin_hands_over_role() {
        with_instance(|env| {
            let a = Address::generate(env);
            let b = Address::generate(env);
            set_admin(env, &a);
            assert_eq!(rotate_admin(env, &a, &b), Ok(()));
            assert_eq!(current_admin(env), Some(b));
        });
    }

    #[test]
    fn rotate_admin_rejects_same_admin() {
        with_instance(|env| {
            let a = Address::generate(env);
            set_admin(env, &a);
            assert_eq!(rotate_admin(env, &a, &a), Err(RotationError::SameAdmin));
            assert_eq!(current_admin(env), Some(a));
        });
    }

    #[test]
    fn current_admin_is_none_before_set() {
        with_instance(|env| {
            assert_eq!(current_admin(env), None);
        });
    }

    #[test]
    fn storage_version_defaults_to_zero_and_round_trips() {
        with_instance(|env| {
            assert_eq!(storage_version(env), 0);
            set_storage_version(env, STORAGE_VERSION);
            assert_eq!(storage_version(env), STORAGE_VERSION);
        });
    }

    #[test]
    fn current_version_has_no_pending_migration() {
        with_instance(|env| {
            set_storage_version(env, STORAGE_VERSION);
            let cfg = upgrade_config(env);
            assert_eq!(cfg.recorded_version, STORAGE_VERSION);
            assert!(!cfg.migration_pending);
        });
    }

    #[test]
    fn newer_recorded_version_is_not_reported_as_pending() {
        with_instance(|env| {
            set_storage_version(env, STORAGE_VERSION + 1);
            let cfg = upgrade_config(env);
            assert_eq!(cfg.recorded_version, STORAGE_VERSION + 1);
            assert!(!cfg.migration_pending);
        });
    }

    #[test]
    fn mark_migrated_is_idempotent() {
        with_instance(|env| {
            let admin = Address::generate(env);
            assert_eq!(mark_migrated(env, &admin), 0);
            assert_eq!(mark_migrated(env, &admin), STORAGE_VERSION);
            assert_eq!(storage_version(env), STORAGE_VERSION);
        });
    }

    #[test]
    fn upgrade_config_is_read_only() {
        with_instance(|env| {
            let before = storage_version(env);
            let _ = upgrade_config(env);
            let _ = upgrade_config(env);
            assert_eq!(storage_version(env), before);
        });
    }
}