# Governance Action Preview

## Overview

`GovernanceSDK.previewParameterChange()` shows what a protocol-parameter
proposal would change before it is created: the value currently stored on
chain, the proposed value, the delta, and the exact call data the proposal
would execute. The ranges mirror the guards in `src/governance.rs`, so an
invalid proposal is caught before it costs a transaction.

## Usage

```ts
const sdk = createGovernanceClient('testnet', { contracts });

const preview = await sdk.previewParameterChange('performance_fee', 1200);

if (preview.errors.length > 0) {
  console.error(preview.errors);
} else {
  console.log(`${preview.currentFormatted} → ${preview.proposedFormatted} (${preview.deltaFormatted})`);
  // Creates the proposal that executes preview.callData.
  const tx = await sdk.proposeParameterChange('performance_fee', 1200);
}
```

## Governable parameters

Values are basis points, matching `getProtocolParameters()`.

| Parameter | Range | Function |
| --- | --- | --- |
| `performance_fee` | 500–1500 (5%–15%) | `set_performance_fee` |
| `withdrawal_fee` | 10–100 (0.1%–1%) | `set_withdrawal_fee` |
| `rebalance_threshold` | 100–500 (1%–5%) | `set_rebalance_threshold` |
| `insurance_reserve_target` | 10000–20000 (100%–200%) | `set_insurance_reserve_target` |

`GOVERNANCE_PARAMETER_BOUNDS` exports the same table for callers that want to
build their own inputs.

## Result

| Field | Meaning |
| --- | --- |
| `currentValue` / `proposedValue` | Basis points read from the contract and requested. |
| `delta` / `percentChange` | Change, absolute and relative to the current value (`percentChange` is `null` when the current value is 0). |
| `inBounds` | Whether the proposed value is a whole number inside the parameter's range. |
| `changed` | `false` for a no-op proposal. |
| `errors` | Blocking validation problems. Empty when the change is valid. |
| `warnings` | Non-blocking notes, e.g. a no-op change. |
| `callData` / `description` | Exactly what `proposeParameterChange()` puts in a proposal. |

Validation failures are returned in `errors` rather than thrown, so a UI can
render them next to the input. Only a failed on-chain read rejects.

## Tests

`sdk/src/governance.preview.test.ts` covers value mapping, formatted deltas,
both range boundaries, non-integer input, no-op warnings, unknown parameters
and read failures.
