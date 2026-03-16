#![no_std]
use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Vec};

mod yield_vault;
mod rebalance_engine;
mod reward_distributor;
mod strategy_registry;

pub use yield_vault::*;
pub use rebalance_engine::*;
pub use reward_distributor::*;
pub use strategy_registry::*;

#[contract]
pub struct StellarLiquidityYieldEngine;

#[contractimpl]
impl StellarLiquidityYieldEngine {
    /// Initialize the yield engine with admin and registry
    pub fn initialize(
        env: Env,
        admin: Address,
        strategy_registry: Address,
        reward_distributor: Address,
    ) {
        // Set admin
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        
        // Set contract references
        env.storage().instance().set(
            &Symbol::new(&env, "strategy_registry"),
            &strategy_registry,
        );
        env.storage().instance().set(
            &Symbol::new(&env, "reward_distributor"),
            &reward_distributor,
        );
        
        // Initialize paused state to false
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
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
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause contract
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
    }

    /// Get admin address
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap()
    }

    /// Update admin
    pub fn update_admin(env: Env, current_admin: Address, new_admin: Address) {
        Self::require_admin(&env, current_admin);
        env.storage().instance().set(&Symbol::new(&env, "admin"), &new_admin);
    }

    /// Get strategy registry address
    pub fn get_strategy_registry(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "strategy_registry"))
            .unwrap()
    }

    /// Get reward distributor address
    pub fn get_reward_distributor(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "reward_distributor"))
            .unwrap()
    }

    /// Require admin authorization
    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("unauthorized: admin required");
        }
    }

    /// Require contract not paused
    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            panic!("contract is paused");
        }
    }
}
