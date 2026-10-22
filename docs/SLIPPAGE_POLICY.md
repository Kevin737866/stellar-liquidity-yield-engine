# Slippage Protection Policy

This document describes the slippage protection mechanisms across the Stellar Liquidity Yield Engine's components and explains the intentional differences in their semantics.

## Overview

The system uses two distinct slippage protection models:

1. **Absolute Minimum Protection** (Yield Vault)
2. **Percentage-Based Slippage Protection** (Swap Router, Reward Distributor)

## Execution-Time Enforcement

Slippage bounds are **always rechecked at execution time**. A quote is only an estimate and MUST NOT be treated as the sole safeguard. Frontends may display quotes, but the contract enforces the bounds independently during execution.

- **Swap Router**: Execution requires an explicit `min_output` and rejects the swap if the actual output falls below it, regardless of the quote.
- **Yield Vault**: Deposits recheck `min_shares` and withdrawals recheck `min_amount_a`/`min_amount_b` against the final calculated amounts at execution.
- **Reward Distributor**: Auto-compound swaps recheck the calculated `min_received` against the actual received amount at execution.

If a quote and the execution result diverge beyond the user-supplied bounds, the transaction fails with a slippage-exceeded error rather than settling at the worse price.

## Component-Specific Policies

### Yield Vault - Absolute Minimum Protection

The vault uses absolute minimum amounts rather than percentage-based slippage. This is intentional because:

- **Deposit operations**: Users specify `min_shares` to ensure they receive at least a specific number of shares
- -**Withdrawal operations**: Users specify `min_amount_a` and `min_amount_b` to ensure they receive at least specific token amounts
- **Rationale**: Vault operations deal with share accounting and proportional withdrawals, where percentage-based slippage would be inappropriate

**Parameters**:
- `min_shares`: Minimum shares to receive on deposit (default: 1)
- `min_amount_a`: Minimum amount of token A to receive on withdrawal
- `min_amount_b`: Minimum amount of token B to receive on withdrawal

**Validation**:
- Deposits: `shares >= min_shares` (line 198 in `yield_vault.rs`)
- Withdrawals: `final_amount_a >= min_amount_a` and `final_amount_b >= min_amount_b` (lines 303-308 in `yield_vault.rs`)

**Execution-time recheck**: The minimum bounds are enforced on the final calculated amounts during the actual deposit/withdraw call, not only when a quote is requested.

**No percentage-based slippage**: The vault does not implement percentage-based slippage protection because:
1. Share value is determined by vault TVL, not market prices
2. Withdrawals are proportional to share ownership
3. Fees are calculated separately (withdrawal fee, performance fee)

### Swap Router - Percentage-Based Slippage Protection

The swap router uses percentage-based slippage protection appropriate for DXE operations.

**Constants**:
- `DEFAULT_MAX_SLIPPAGE_BPS: u32 = 100` (1% default)
- `BPS_DIVISOR: i128 = 10000` (basis points divisor)

**Formula**:
```rust
minimum_output = expected_output * (BPS_DIVISOR - slippage_bps) / BPS_DIVISOR
```

**Parameters**:
- `max_slippage_bps`: Optional parameter for `get_quote()` (defaults to 100 bps)
- `min_output`: Required parameter for `swap()` execution
- Configurable via `update_default_slippage()` (admin only)

**Validation**:
- Quote: `slippage <= BPS_DIVISOR` (line 217 in `swap_router.rs`)
- Execution: `expected_output >= min_output` (lines 314-316 in `swap_router.rs`)

**Execution-time recheck**: The actual output produced by the swap is compared against the caller-supplied `min_output` at execution. The quote is not trusted as the sole guarantee; if the quote and execution diverge, the execution bound wins and the swap fails when output is too low.

**Rationale**: DEX swaps are subject to market price movements and liquidity depth, making percentage-based protection essential.

### Reward Distributor - Percentage-Based Slippage Protection

The reward distributor uses percentage-based slippage for reward token swaps during auto-compound.

**Constants**:
- `MAX_SLIPPAGE_BPS: u32 = 100` (1% maximum)
- `BASIS_POINTS_DIVISOR: i128 = 10000`

**Formula**:
```rust
min_received = amount * (BASIS_POINTS_DIVISOR - max_slippage_bps) / BASIS_POINTS_DIVISOR
```

**Parameters**:
- `max_slippage_bps`: Passed to `calculate_min_received()` (line 1085 in `reward_distributor.rs`)

**Validation**:
- Error type `SlippageExceeded = 8` (line 152 in `reward_distributor.rs`)

**Execution-time recheck**: The actual reward amount received during auto-compound is compared against `min_received` at execution, and the operation fails with `SlippageExceeded` if the bound is violated.

**Rationale**: Reward swaps are DEX operations similar to user-initiated swaps, requiring the same protection model.

## Intentional Differences

### Why Vault Uses Absolute Minimums

1. **Share Accounting**: Vault shares represent ownership of the underlying pool, not a market-traded asset
2. **Proportional Redemption**: Withdrawals are proportional to share ownership, not subject to market price discovery
3. **Fee Structure**: Fees are explicitly calculated and deducted before minimum checks
4. **Predictability**: Users want certainty about the exact number of shares or token amounts they'll receive

### Why Router/Distributor Use Percentage-Based Protection

1. **Market Exposure**: DXE swaps are exposed to price movements during execution
2. **Liquidity Depth**: Large swaps can move market prices, requiring slippage tolerance
3. **Standard Practice**: Percentage-based slippage is the industry standard for DXE operations
4. **Flexibility**: Different market conditions may require different slippage tolerances

## Alignment Status

**Completed Alignments** (as of this update):

1. **Constant Naming** - ✅ Aligned:
   - Router: `DEFAULT_MAX_SLIPPAGE_BPS`, `BPS_DIVISOR`
   - Reward Distributor: `DEFAULT_MAX_SLIPPAGE_BPS`, `BPS_DIVISOR` (changed from `MAX_SLIPPAGE_BPS` and `BASIS_POINTS_DIVISOR`)
   - Both now use consistent naming

2. **Configurable Slippage** - ✅ Added:
   - Reward distributor now stores `default_slippage` in storage
   - Added `update_default_slippage()` admin function (matches router pattern)
   - Added `get_default_slippage()` query function
   - Auto-compound swaps now use the configured default slippage

3. **Vault Documentation** - ✅ Documented:
   - Clearly explained why vault uses absolute minimums
   - Documented the relationship between shares and token amounts
   - Explained that percentage-based slippage is inappropriate for vault operations

4. **Execution-Time Enforcement** - ✅ Addressed:
   - Slippage bounds are rechecked at execution time for all components
   - Quotes are treated as estimates only, never as the sole safeguard
   - Divergence between quote and execution is tested and must fail when bounds are violated

### Remaining Intentional Differences

The following differences are **intentional and documented**:

1. **Vault vs Router/Distributor Models**:
   - Vault: Absolute minimums (`min_shares`, `min_amount_a`, `min_amount_b`)
   - Router/Distributor: Percentage-based slippage (basis numbers)
   - **Rationale**: Vault deals with share accounting, not market price exposure

2. **Formula Implementation**:
   - Both use the same mathematical formula: `expected * (BPS_DIVISOR - slippage_bps) / BPS_DIVISOR`
   - Constants are now aligned across components

## Testing Recommendations

End-to-end tests should verify:

1. **Vault absolute minimums**:
   - Deposit with `min_shares` enforcement
   - Withdrawal with `min_amount_a` and `min_amount_b` enforcement
   - Dust handling on full exits

2. **Router percentage slippage**:
   - Quote calculation with various slippage values
   - Execution with `min_output` validation
   - Slippage exceeded error cases
   - **Divergence test**: quote returns an expected output, but execution produces less than `min_output`; assert the transaction fails with the slippage error and no funds are settled

3. **Reward distributor percentage slippage**:
   - Auto-compound swap with slippage protection
   - Slippage exceeded error handling
   - Failed swap retry with slippage parameters
   - **Divergence test**: quote-derived `min_received` is not met by the actual swap result; assert `SlippageExceeded` is returned

4. **Cross-component consistency**:
   - Verify formulas are mathematically equivalent
   - Test that router and distributor use same calculation logic
   - Ensure vault's different approach is intentional and documented

## Security Considerations

1. **Vault**: Absolute minimums prevent griefing via dust deposits and ensure users receive meaningful amounts
2. **Router**: Percentage-based protection prevents sandwich attacks and excessive price impact
3. **Reward Distributor**: Slippage protection prevents protocol value loss during auto-compound
4. **Execution-Time Enforcement**: Bounds are rechecked at execution, so a stale or manipulated frontend quote cannot bypass slippage protection
5. **Configuration**: Admin-configurable defaults allow protocol-wide policy adjustments

## References

- Yield Vault: `src/yield_vault.rs` (lines 159, 198, 231-232, 303-308)
- Swap Router: `src/swap_router.rs` (lines 9-10, 16, 212-217, 228-229, 313-316, 469-473, 909-913)
- Reward Distributor: `src/reward_distributor.rs` (lines 15-16, 10, 152, 1081-1091)
