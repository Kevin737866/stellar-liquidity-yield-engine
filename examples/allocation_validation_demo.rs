// This file demonstrates the allocation validation behavior
// It shows concrete examples of valid and invalid allocations

use soroban_sdk::{Address, Env, Symbol, Vec};

/// Example 1: VALID - Two pools splitting 50/50
/// Total: 5000 + 5000 = 10000 ✓
fn example_valid_50_50(env: &Env) -> Vec<PoolAllocation> {
    let mut allocations = Vec::new(env);

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 5000, // 50%
        target_apy: 2000,
        current_apy: 1500,
        impermanent_loss_risk: 100,
    });

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 5000, // 50%
        target_apy: 1800,
        current_apy: 1600,
        impermanent_loss_risk: 80,
    });

    allocations
    // Result: ACCEPTED ✓ (5000 + 5000 = 10000)
}

/// Example 2: VALID - Three pools with different weights
/// Total: 6000 + 3000 + 1000 = 10000 ✓
fn example_valid_60_30_10(env: &Env) -> Vec<PoolAllocation> {
    let mut allocations = Vec::new(env);

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 6000, // 60%
        target_apy: 2500,
        current_apy: 2000,
        impermanent_loss_risk: 150,
    });

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 3000, // 30%
        target_apy: 2000,
        current_apy: 1800,
        impermanent_loss_risk: 100,
    });

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 1000, // 10%
        target_apy: 1500,
        current_apy: 1400,
        impermanent_loss_risk: 50,
    });

    allocations
    // Result: ACCEPTED ✓ (6000 + 3000 + 1000 = 10000)
}

/// Example 3: VALID - Single pool with 100%
/// Total: 10000 = 10000 ✓
fn example_valid_single_100(env: &Env) -> Vec<PoolAllocation> {
    let mut allocations = Vec::new(env);

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 10000, // 100%
        target_apy: 2000,
        current_apy: 1800,
        impermanent_loss_risk: 200,
    });

    allocations
    // Result: ACCEPTED ✓ (10000 = 10000)
}

/// Example 4: INVALID - Empty allocation list
/// Total: 0 ✗
fn example_invalid_empty(env: &Env) -> Vec<PoolAllocation> {
    Vec::new(env)
    // Result: REJECTED ✗
    // Panic: "allocations must not be empty"
}

/// Example 5: INVALID - Sum less than 10000
/// Total: 5000 + 3000 = 8000 ✗
fn example_invalid_sum_too_low(env: &Env) -> Vec<PoolAllocation> {
    let mut allocations = Vec::new(env);

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 5000, // 50%
        target_apy: 2000,
        current_apy: 1500,
        impermanent_loss_risk: 100,
    });

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 3000, // 30%
        target_apy: 1800,
        current_apy: 1600,
        impermanent_loss_risk: 80,
    });

    allocations
    // Result: REJECTED ✗ (5000 + 3000 = 8000 ≠ 10000)
    // Panic: "allocations must sum to exactly 10000 bps (100%)"
}

/// Example 6: INVALID - Sum greater than 10000
/// Total: 6000 + 5000 = 11000 ✗
fn example_invalid_sum_too_high(env: &Env) -> Vec<PoolAllocation> {
    let mut allocations = Vec::new(env);

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 6000, // 60%
        target_apy: 2000,
        current_apy: 1500,
        impermanent_loss_risk: 100,
    });

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 5000, // 50%
        target_apy: 1800,
        current_apy: 1600,
        impermanent_loss_risk: 80,
    });

    allocations
    // Result: REJECTED ✗ (6000 + 5000 = 11000 ≠ 10000)
    // Panic: "allocations must sum to exactly 10000 bps (100%)"
}

/// Example 7: INVALID - Single allocation exceeds 10000
/// Total: 15000 > 10000 ✗
fn example_invalid_single_too_large(env: &Env) -> Vec<PoolAllocation> {
    let mut allocations = Vec::new(env);

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 15000, // 150% - INVALID!
        target_apy: 2000,
        current_apy: 1500,
        impermanent_loss_risk: 100,
    });

    allocations
    // Result: REJECTED ✗ (15000 > 10000)
    // Panic: "allocation_percent must not exceed 10000 bps (100%)"
}

/// Example 8: VALID - Four pools with precise distribution
/// Total: 2500 + 2500 + 2500 + 2500 = 10000 ✓
fn example_valid_four_equal_pools(env: &Env) -> Vec<PoolAllocation> {
    let mut allocations = Vec::new(env);

    for i in 0..4 {
        allocations.push_back(PoolAllocation {
            pool_id: Address::generate(env),
            token_a: Address::generate(env),
            token_b: Address::generate(env),
            allocation_percent: 2500, // 25% each
            target_apy: 2000 + (i * 100),
            current_apy: 1500 + (i * 100),
            impermanent_loss_risk: 100 + (i * 20),
        });
    }

    allocations
    // Result: ACCEPTED ✓ (2500 + 2500 + 2500 + 2500 = 10000)
}

/// Example 9: VALID - Asymmetric distribution
/// Total: 7500 + 1500 + 1000 = 10000 ✓
fn example_valid_asymmetric(env: &Env) -> Vec<PoolAllocation> {
    let mut allocations = Vec::new(env);

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 7500, // 75% - Major allocation
        target_apy: 2500,
        current_apy: 2200,
        impermanent_loss_risk: 200,
    });

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 1500, // 15% - Minor allocation
        target_apy: 2000,
        current_apy: 1800,
        impermanent_loss_risk: 100,
    });

    allocations.push_back(PoolAllocation {
        pool_id: Address::generate(env),
        token_a: Address::generate(env),
        token_b: Address::generate(env),
        allocation_percent: 1000, // 10% - Minimal allocation
        target_apy: 1500,
        current_apy: 1400,
        impermanent_loss_risk: 50,
    });

    allocations
    // Result: ACCEPTED ✓ (7500 + 1500 + 1000 = 10000)
}

// Summary of Validation Rules:
//
// ✓ VALID allocations must meet ALL of these conditions:
// 1. The allocations vector must NOT be empty (at least 1 pool)
// 2. Each individual allocation_percent must be <= 10000
// 3. The SUM of all allocation_percent values must EQUAL exactly 10000
//
// ✗ INVALID allocations will be REJECTED if ANY of these are true:
// 1. The allocations vector is empty
// 2. Any individual allocation_percent exceeds 10000
// 3. The sum of allocation_percent is less than 10000
// 4. The sum of allocation_percent is greater than 10000
//
// Note: 10000 basis points = 100.00%
//       1 basis point = 0.01%
//       Example: 5000 bps = 50.00%
