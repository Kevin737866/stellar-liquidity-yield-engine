# Mainnet action prompt (dashboard)

Issue #458 adds an explicit network-switch prompt in front of transaction
actions that target Stellar Mainnet. The goal is to make it impossible to
sign a real-money transaction by accidentally clicking through a dashboard
flow.

## Behavior

| Case | Result |
| --- | --- |
| Action on **testnet** | Runs immediately, exactly as before. No dialog. |
| Action on **mainnet** | The action is held. A modal explains the action, warns that real assets are used, and shows the Mainnet passphrase. |
| User chooses **Cancel**, presses **Escape**, or clicks the backdrop | The pending action is discarded. No transaction is built, signed, or submitted. |
| User chooses **Switch to Mainnet & Continue** | The optional `onNetworkChange('mainnet')` callback runs first; then the action proceeds. |
| `onNetworkChange` throws or rejects | The prompt stays open, an inline error is shown, and the action is not submitted. |
| A second action is requested while a prompt is open | It is ignored; the first decision owns the transaction. |
| Confirm is triggered twice | The guarded action runs at most once. |

The prompt is shown by these dashboard transaction surfaces:

- `YieldVaultCard` — deposit, withdraw, harvest
- `RebalancePanel` — execute rebalance
- `GovernancePanel` — vote, create/increase/extend lock, escrow withdrawal

Each surface also displays a `Mainnet` / `Testnet` badge so the active network
is visible before any action is attempted.

## Integration

`useMainnetActionGuard` is the shared implementation. Components pass the
effective network and an optional host callback:

```tsx
<YieldVaultCard
  vaultAddress={vaultId}
  userAddress={publicKey}
  network="mainnet"
  onNetworkChange={async (network) => {
    // Example: update app context and point Freighter at the right network.
    await walletContext.switchNetwork(network);
  }}
/>
```

`onNetworkChange` is optional. When it is omitted the prompt is a pure
confirmation: the transaction uses the network already selected by
`network` or `NEXT_PUBLIC_STELLAR_NETWORK`. This keeps existing callers
working without any configuration change.

`requestAction(label, run)` returns a promise that settles when `run` settles,
or immediately when the user cancels. Callers that need to know when the
transaction finished can keep awaiting it.

## Accessibility

- `role="dialog"`, `aria-modal="true"`, labelled heading and description.
- Focus moves to **Cancel** when the dialog opens and returns to the previous
  element when it closes.
- `Escape` and backdrop clicks cancel; `Tab` stays inside the dialog.
- Switch errors are announced with `role="alert"`.

## Operations

1. Keep `NEXT_PUBLIC_STELLAR_NETWORK` at `testnet` for development. Mainnet is
   only selected deliberately via configuration or an explicit component prop.
2. If the host app supports runtime switching, implement `onNetworkChange` and
   make sure the wallet is set to Mainnet before resolving it. A rejection is
   surfaced in the prompt and no transaction is submitted.
3. Configure the Mainnet contract IDs and RPC/Horizon endpoints in `ui/.env`
   (see `ui/.env.example`) before enabling Mainnet writes.
4. Run `cd ui && npm test` and `cd ui && npm run build` after changing this
   flow. Prompt behavior is covered in `ui/tests/networkSwitchPrompt.test.tsx`,
   `ui/tests/useMainnetActionGuard.test.ts`, and
   `ui/tests/yieldVaultMainnetPrompt.test.tsx`.
