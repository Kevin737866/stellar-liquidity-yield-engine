# SDK Error and Retry API Reference

This reference describes SDK error types, transient retry behavior, and operator-facing failure handling.

## Error types

| Type | Where used | `code` behavior |
|---|---|---|
| `VaultError` | Vault deposit, withdrawal, harvest, reads, and pause operations | Optional stable operation code such as `DEPOSIT_ERROR` or `GET_APY_ERROR` |
| `RebalanceError` | Rebalance, history, strategy, APY, and pause operations | Optional stable code such as `INVALID_PAGINATION` or `FRESHNESS_CHECK_ERROR` |
| `RewardError` | Reward operations | Optional stable operation code |
| `StrategyError` | Strategy registry operations | Optional stable operation code |
| `CheckpointError` | Durable keeper checkpoint validation and file operations | The checkpoint validation or persistence failure is preserved as the message and cause where available |
| `RetryConfigurationError` | `withRetry` and retry wrappers | Raised before the operation for invalid retry settings |

Domain errors extend `Error`, set a descriptive `name`, and may expose a public `code`. Callers should handle unknown future codes by matching the `name` or message, not by assuming every SDK call supplies a code.

```typescript
import { VaultError } from '@stellar/liquidity-yield-engine-sdk';

try {
  await vault.deposit(keypair, params);
} catch (error) {
  if (error instanceof VaultError) {
    console.error(error.name, error.code, error.message);
  } else {
    throw error;
  }
}
```

`instanceof` checks are reliable within the package copy used by the caller. Distributed or duplicated SDK copies should instead compare `error.name` or `error.code`.

## Retry API

`withRetry(fn, options?)` returns:

```typescript
interface RetryResult<T> {
  result: T;
  attempts: number;
}
```

- `attempts` is `1` for a first-attempt success and is `2` or greater after retries.
- The original operation's last error is rethrown after retries are exhausted.
- Non-transient errors are thrown immediately.
- Invalid retry configuration throws `RetryConfigurationError` before `fn` is called.

```typescript
import { withRetry } from '@stellar/liquidity-yield-engine-sdk';

const { result, attempts } = await withRetry(
  () => rpcCall(),
  {
    maxRetries: 3,
    initialDelayMs: 100,
    backoffMultiplier: 2,
    maxDelayMs: 5000,
    jitter: true,
    onRetry: (attempt, error, delayMs) => {
      console.warn({ attempt, delayMs, message: error.message });
    },
  }
);
```

### Retry options

| Option | Default | Boundary behavior |
|---|---:|---|
| `maxRetries` | `3` | Non-negative integer. `0` means one initial attempt and no retries. |
| `initialDelayMs` | `100` | Finite and non-negative. |
| `backoffMultiplier` | `2` | Finite and at least `1`. |
| `maxDelayMs` | `5000` | Finite and at least `initialDelayMs`. |
| `jitter` | `true` | Adds ±25% jitter to each computed delay. |
| `onRetry` | no-op | Called once before each delay; receives retry attempt number, last error, and delay. |

Fractions, negative values, `NaN`, infinite values, and invalid delay combinations are rejected by `RetryConfigurationError`. The operation is not called in this case.

## Transient detection

An error is retried when it has one of these:

- Node network code: `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, or `EPIPE`.
- HTTP status: `408`, `429`, `500`, `502`, `503`, or `504`.
- Message pattern: `network`, `timeout`, `temporary`, `unavailable`, `rate limit`, `too many requests`, or `connection`.

Validation errors, malformed inputs, insufficient funds, invalid signatures, and other application errors are not automatically transient unless they match one of the rules above.

## RPC wrapper

`createRetryRpcServer(server, options?)` and `createRetryRpcServerFromUrl(url, options?)` wrap read and write RPC methods.

- `retryReads` defaults to `true` for account, simulation, transaction, ledger, events, and health reads.
- `retryWrites` defaults to `true` for transaction submission.
- Set `retryReads: false` or `retryWrites: false` to bypass retries for that operation type.
- The wrapper rethrows the final underlying RPC error after retry exhaustion.
- Use `getUnderlyingServer()` when a method not included by the wrapper is required.

Write retries can duplicate a submission if an RPC accepted the write before returning a transient-looking network error. Operators should prefer one submit path, use transaction deduplication/hash checks when possible, and avoid retry writes for a flow that cannot safely tolerate duplicate submission.

## Backoff behavior

For attempt number `n`, the uncapped delay is:

`initialDelayMs * backoffMultiplier^(n - 1)`

The delay is capped at `maxDelayMs`, then jittered by ±25% when enabled. `onRetry` receives the final delay before sleep.

Example defaults:

- First retry: approximately 100 ms
- Second retry: approximately 200 ms
- Third retry: approximately 400 ms
- Maximum attempts: 4 (initial attempt plus 3 retries)

## Operational handling

1. Match domain errors by `name` and optional `code`.
2. Use retry callbacks to emit metrics or warnings; do not log private signing material.
3. Keep write retries disabled or tightly controlled for non-idempotent operations.
4. Add operation-level deadlines so retry delays cannot block a keeper indefinitely.
5. Escalate after retry exhaustion; the SDK returns the last underlying error rather than converting it into a success result.
