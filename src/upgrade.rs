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
//! See `docs/UPGRADING.md` for the operational flow.

use soroban_sdk::{Address, BytesN, Env, Symbol};

/// Storage schema version this build expects.
///
/// Bump this in the same change that alters a stored type, and add the matching
/// work to that contract's `migrate`.
pub const STORAGE_VERSION: u32 = 1;

/// The recorded storage schema version of a contract's data.
///
/// `0` means "never recorded", which is what a contract deployed before this
/// module existed reads as.
pub fn storage_version(env: &Env) -> u32 {
    env.storage().instance().get(&version_key(env)).unwrap_or(0)
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

fn version_key(env: &Env) -> Symbol {
    Symbol::new(env, "storage_version")
}
