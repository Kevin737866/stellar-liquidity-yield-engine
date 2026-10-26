# Allocation Validation Guide

## Overview
This guide explains how allocation validation works in the Stellar Liquidity Yield Engine's rebalance strategy system.

## What is Validated?

When creating or updating a rebalance strategy, the allocations must meet strict requirements to ensure portfolio integrity:

### Validation Rules

1. **Non-Empty**: At least one pool allocation must be provided
2. **Individual Limits**: Each allocation cannot exceed 100% (10000 basis points)
3. **Exact Sum**: All allocations must sum to exactly 100% (10000 basis points)

## Why Basis Points?

The system uses **basis points (bps)** for precision:
- 1 basis point = 0.01%
- 100 basis points = 1%
- 10,000 basis points = 100%

This allows for precise allocations like 33.33% (3333 bps) without floating-point errors.

## Examples

### ✅ Valid Allocations

#### Example 1: Equal 50/50 Split
```rust
Pool A: 5000 bps (50%)
Pool B: 5000 bps (50%)
Total:  10000 bps (100%) ✓
```

#### Example 2: Weighted Distribution
```rust
Pool A: 6000 bps (60%)
Pool B: 3000 bps (30%)
Pool C: 1000 bps (10%)
Total:  10000 bps (100%) ✓
```

#### Example 3: Single Pool
```rust
Pool A: 10000 bps (100%)
Total:  10000 bps (100%) ✓
```

#### Example 4: Precise Distribution
```rust
Pool A: 3333 bps (33.33%)
Pool B: 3333 bps (33.33%)
Pool C: 3334 bps (33.34%)
Total:  10000 bps (100%) ✓
```

### ❌ Invalid Allocations

#### Example 1: Empty List
```rust
Allocations: []
Error: "allocations must not be empty"
```

#### Example 2: Under-Allocated
```rust
Pool A: 5000 bps (50%)
Pool B: 3000 bps (30%)
Total:  8000 bps (80%) ✗
Error: "allocations must sum to exactly 10000 bps (100%)"
```

#### Example 3: Over-Allocated
```rust
Pool A: 6000 bps (60%)
Pool B: 5000 bps (50%)
Total:  11000 bps (110%) ✗
Error: "allocations must sum to exactly 10000 bps (100%)"
```

#### Example 4: Individual Limit Exceeded
```rust
Pool A: 15000 bps (150%)
Error: "allocation_percent must not exceed 10000 bps (100%)"
```

## When Validation Occurs

Validation happens in two places:

1. **`create_strategy`** - When creating a new rebalance strategy
2. **`update_strategy`** - When modifying an existing strategy

In both cases, validation occurs **before** any data is stored, ensuring the contract state remains consistent.

## Error Handling

When validation fails, the contract will **panic** with a descriptive error message:

| Condition | Error Message |
|-----------|---------------|
| Empty list | `"allocations must not be empty"` |
| Individual > 10000 | `"allocation_percent must not exceed 10000 bps (100%)"` |
| Sum ≠ 10000 | `"allocations must sum to exactly 10000 bps (100%)"` |

The panic causes the entire transaction to revert, preventing invalid data from being stored.

## Code Location

**File**: `src/rebalance_engine.rs`

### Validation Function (Lines 321-339)
```rust
fn validate_allocations(allocations: &Vec<PoolAllocation>) {
    require!(!allocations.is_empty(), "allocations must not be empty");

    let mut total_bps: u64 = 0;
    for allocation in allocations.iter() {
        require!(
            allocation.allocation_percent <= 10000,
            "allocation_percent must not exceed 10000 bps (100%)"
        );
        total_bps += allocation.allocation_percent as u64;
    }

    require!(
        total_bps == 10000,
        "allocations must sum to exactly 10000 bps (100%)"
    );
}
```

### Usage in create_strategy (Line 173)
```rust
pub fn create_strategy(
    env: Env,
    admin: Address,
    name: Symbol,
    risk_level: u32,
    min_apy_threshold: u32,
    max_il_risk: u32,
    rebalance_frequency: u64,
    allocations: Vec<PoolAllocation>,
) -> u32 {
    Self::require_admin(&env, admin.clone());
    Self::require_not_paused(&env);
    Self::validate_allocations(&allocations);  // ← Validation here
    // ... create strategy
}
```

### Usage in update_strategy (Line 218)
```rust
pub fn update_strategy(
    env: Env,
    admin: Address,
    strategy_id: u32,
    name: Symbol,
    risk_level: u32,
    min_apy_threshold: u32,
    max_il_risk: u32,
    rebalance_frequency: u64,
    allocations: Vec<PoolAllocation>,
) {
    Self::require_admin(&env, admin.clone());
    Self::require_not_paused(&env);
    Self::validate_allocations(&allocations);  // ← Validation here
    // ... update strategy
}
```

## Testing

Comprehensive tests are available in `tests/rebalance_engine_tests.rs`:

### Test Cases
1. `test_create_strategy_rejects_empty_allocations`
2. `test_create_strategy_rejects_allocations_sum_not_10000`
3. `test_create_strategy_accepts_valid_allocations_sum_10000`
4. `test_update_strategy_rejects_empty_allocations`
5. `test_update_strategy_rejects_allocations_sum_not_10000`
6. `test_update_strategy_accepts_valid_allocations_sum_10000`

### Running Tests
```bash
cargo test --test rebalance_engine_tests
```

## Best Practices

### 1. Always Calculate Sum First
Before calling `create_strategy` or `update_strategy`, verify your allocations sum to 10000:

```rust
let mut total = 0u32;
for allocation in allocations.iter() {
    total += allocation.allocation_percent;
}
assert_eq!(total, 10000, "Allocations must sum to 10000");
```

### 2. Handle Rounding Carefully
When dividing 10000 among pools, handle rounding:

```rust
// For 3 equal pools: 10000 / 3 = 3333.33...
let pool_a = 3333;  // 33.33%
let pool_b = 3333;  // 33.33%
let pool_c = 3334;  // 33.34% (gets the extra 1 bps)
// Total: 10000 ✓
```

### 3. Use Builder Pattern
Consider using a builder to ensure valid allocations:

```rust
struct AllocationBuilder {
    allocations: Vec<PoolAllocation>,
    remaining_bps: u32,
}

impl AllocationBuilder {
    fn new(env: &Env) -> Self {
        Self {
            allocations: Vec::new(env),
            remaining_bps: 10000,
        }
    }
    
    fn add_pool(&mut self, pool: PoolAllocation) -> Result<(), &str> {
        if pool.allocation_percent > self.remaining_bps {
            return Err("Exceeds remaining allocation");
        }
        self.remaining_bps -= pool.allocation_percent;
        self.allocations.push_back(pool);
        Ok(())
    }
    
    fn build(self) -> Result<Vec<PoolAllocation>, &str> {
        if self.remaining_bps != 0 {
            return Err("Does not sum to 10000");
        }
        Ok(self.allocations)
    }
}
```

## Common Pitfalls

### Pitfall 1: Forgetting Rounding
```rust
// WRONG: 10000 / 3 = 3333.33... → truncates to 3333
let each = 10000 / 3;  // = 3333
let allocations = vec![each, each, each];  // [3333, 3333, 3333]
// Total: 9999 ✗ (missing 1 bps!)

// CORRECT: Give remainder to last pool
let each = 10000 / 3;
let remainder = 10000 % 3;
let allocations = vec![each, each, each + remainder];  // [3333, 3333, 3334]
// Total: 10000 ✓
```

### Pitfall 2: Using Percentages Instead of Basis Points
```rust
// WRONG: Using percentage values
let allocations = vec![50, 30, 20];  // [50%, 30%, 20%]
// Total: 100 ✗ (should be 10000!)

// CORRECT: Using basis points
let allocations = vec![5000, 3000, 2000];  // [50%, 30%, 20%]
// Total: 10000 ✓
```

### Pitfall 3: Not Validating Before Calling
```rust
// RISKY: Assume allocations are valid
client.create_strategy(&admin, &name, &2, &200, &100, &86400, &allocations);
// If invalid, transaction fails and gas is wasted

// BETTER: Validate locally first
let sum: u32 = allocations.iter().map(|a| a.allocation_percent).sum();
if sum != 10000 {
    return Err("Invalid allocations");  // Fail fast
}
client.create_strategy(&admin, &name, &2, &200, &100, &86400, &allocations);
```

## Security Implications

### Why This Validation Matters

1. **Portfolio Integrity**: Ensures strategies always allocate exactly 100% of funds
2. **No Under-Allocation**: Prevents leaving funds unallocated and idle
3. **No Over-Allocation**: Prevents attempting to allocate more than available
4. **Consistent State**: Contract state remains mathematically sound
5. **Audit Trail**: Clear error messages aid debugging and compliance

### Attack Prevention

This validation prevents several potential issues:

- **Inflation Attack**: Can't allocate >100% to extract more value
- **Lock-Up Attack**: Can't leave funds unallocated (0% pools)
- **Rounding Exploits**: Strict sum check prevents rounding manipulation
- **State Corruption**: Invalid allocations never enter storage

## Summary

✅ **DO**:
- Ensure allocations sum to exactly 10000 bps
- Include at least one pool allocation
- Handle rounding carefully when dividing allocations
- Validate locally before calling contract

❌ **DON'T**:
- Use empty allocation lists
- Use percentage values (use basis points)
- Assume allocations will be rounded automatically
- Exceed 10000 bps per individual allocation

## Further Reading

- See `examples/allocation_validation_demo.rs` for code examples
- See `tests/rebalance_engine_tests.rs` for test cases
- See `ISSUE_RESOLUTION.md` for implementation details
