# Wallet Disconnection Handling During Submission

## Overview

This document specifies the behavior, boundary conditions, and test coverage for handling wallet disconnections during transaction submission across the Stellar Liquidity & Yield Engine user interface.

## Submission States & Lifecycle

Soroban transactions submitted via the UI transition through the lifecycle managed by `useTxStatus`:

```
idle  ──▶  submitting  ──▶  pending (txHash)  ──▶  confirmed
                 │                 │
                 └──▶ failed ◀─────┘ (disconnection / rejection)
```

1. **`idle`**: No transaction is in flight. Controls and inputs are interactive.
2. **`submitting`**: User triggered an action (e.g. deposit, withdraw, harvest). The SDK/wallet call is active. Inputs and submit buttons are disabled; the button displays `Processing…` with an animated spinner.
3. **`pending`**: The transaction was accepted and assigned a `txHash`. Awaiting final ledger confirmation.
4. **`confirmed`**: Transaction finalized successfully on the Stellar ledger. Form inputs are reset.
5. **`failed`**: The transaction or signing was rejected, aborted, or failed due to wallet disconnection.

---

## Behavior Specifications

### 1. In-Flight Disconnect Control Guarding (Boundary Behavior)

- While an action is in flight (`isTxInFlight === true`), the wallet **Disconnect** button in `YieldVaultCard` is explicitly disabled (`disabled={isTxInFlight}`).
- **Rationale**: Prevents users from accidentally tearing down the wallet connection or signer while a transaction payload is awaiting signature or dispatch.
- When the transaction concludes (`confirmed` or `failed`), the Disconnect button is re-enabled.

### 2. Disconnection During Submission (Failure Behavior)

When a wallet disconnection occurs while an action is in flight (e.g., Freighter extension session expires, browser extension is locked, or connection is revoked):
- The in-flight promise rejects with a disconnection error (e.g. `Wallet disconnected during transaction submission`).
- The transaction runner catches the rejection and transitions `txStatus` to `'failed'`, storing the error message in `txError`.
- **No Stuck Spinners**: `isTxInFlight` is reset to `false`, removing the `Processing…` spinner.
- **Form Input Preservation**: User-entered values (Token A and B amounts, withdrawal shares, or lock amounts) are **not cleared**. Users do not lose their inputs.
- **Visual Feedback**: A red failure alert banner renders the disconnection error message alongside a "Dismiss" action.
- **Fallback Controls**: If the wallet state updates to disconnected (`walletConnected: false`), the UI switches to display the "Connect Freighter" button, disables submission actions, and displays the guidance: `"Connect Freighter wallet or configure a keypair to deposit funds."`.
- **Dismissal**: Clicking "Dismiss" calls `resetTx()`, returning the status banner to `idle`.

### 3. Disconnection After Transaction Hash (Boundary Behavior)

If a transaction payload was successfully broadcast and received a `txHash`, but the wallet or connection drops during the ledger confirmation wait:
- The failure banner renders the disconnection error message.
- The `txHash` is retained and displayed in truncated format with a title tooltip.
- **User Outcome**: Operators and users can copy the transaction hash to inspect its status directly on Stellar ledger explorers (e.g., Stellar Expert).

### 4. Reconnection and Retry (Normal Recovery)

- Following a disconnection failure, once the user clicks "Connect Freighter" and re-authenticates:
  - `walletConnected` becomes `true`.
  - The previously entered amounts remain populated in the inputs.
  - The submit button is re-enabled, allowing immediate resubmission without re-typing.

---

## Component Surfaces Covered

| Component | In-Flight Guarding | Disconnection Handling | Input Retention |
| :--- | :--- | :--- | :--- |
| **`YieldVaultCard`** | Disconnect button & inputs disabled during flight | Captures error, surfaces failure banner, displays connect guidance | Token A/B deposit amounts and withdrawal shares retained |
| **`useTxStatus`** | Tracks `submitting` and `pending` states | Transitions to `failed`, captures `txError`, retains `txHash` | N/A (State hook) |
| **`VotingPanel`** | Vote submit button enters `submitting` state | Resets `isSubmitting` to `false` in `finally`, unlocks UI | Vote percentage and reason retained |
| **`StakingModal`** | Submit button shows `Processing...` | Resets `isSubmitting` to `false` on rejection | Lock amount and duration selection retained |

---

## Automated Test Quality Coverage

The test suite in `ui/tests/walletDisconnectionSubmission.test.tsx` provides automated verification for:

1. **Disconnect Button Guarding**: Asserts the Disconnect button is disabled while deposit submission is in flight.
2. **Deposit Disconnection Failure**: Asserts error banner displays error, inputs are preserved, and disconnected wallet UI prompts for reconnection.
3. **Withdraw Disconnection Failure**: Asserts withdraw flight reset and share input preservation.
4. **Harvest Disconnection Failure**: Asserts harvest flight reset on disconnection.
5. **Confirmation Phase Disconnection**: Asserts transaction hash is preserved and displayed alongside failure message.
6. **Disconnected Initial State**: Asserts action buttons are disabled when unauthenticated.
7. **Reconnection Recovery**: Asserts user can retry submission immediately upon reconnection without re-entering values.
8. **`useTxStatus` Lifecycle**: Asserts direct hook transitions to `failed` and reset back to `idle`.
9. **`VotingPanel` Resilience**: Asserts voting submission unlocks on rejection.
10. **`StakingModal` Resilience**: Asserts staking submission unlocks on rejection while preserving input.

---

## CI / Verification Workflow

The test suite runs automatically under the UI CI workflow (`.github/workflows/ui-ci.yml`):

```bash
cd ui
npm test -- --runInBand
```
