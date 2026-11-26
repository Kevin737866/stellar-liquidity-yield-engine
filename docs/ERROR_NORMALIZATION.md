# Horizon and Soroban RPC Error Normalization

## Overview

Calls crossing the SDK boundary can fail with heterogeneous error shapes:

- **Horizon** returns RFC 7807 Problem Details wrapped in Axios / `stellar-sdk` response errors (`response.status`, `response.data.type`, `response.data.extras.result_codes`, `Retry-After` headers).
- **Soroban RPC** returns JSON-RPC 2.0 error codes (`-32700` to `-32603`, `-32000..-32099`), response-level failure payloads (`SimulateTransactionErrorResponse`, `SendTransactionResponse` with `ERROR` / `TRY_AGAIN_LATER`, `GetTransactionResponse` with `FAILED`), or HTTP-level gateway/rate-limit errors.
- **Network / Transport** layers throw Node.js socket errors (`ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, etc.) or `AbortError`.

`sdk/src/errors.ts` normalizes all of these at the SDK boundary into a single `SdkBoundaryError` class with a stable `source`, `category`, machine-readable `code`, `retryable` flag, and structured metadata.

## Error Model

| Field | Type | Description |
| --- | --- | --- |
| `source` | `'horizon' \| 'soroban_rpc' \| 'network' \| 'unknown'` | Backend or layer that produced the error |
| `category` | `SdkErrorCategory` | Canonical error category (`network`, `timeout`, `rate_limit`, `not_found`, `invalid_request`, `unauthorized`, `transaction_failed`, `simulation_failed`, `cursor_expired`, `server_error`, `unknown`) |
| `code` | `string` | Machine-readable code (e.g. `HORIZON_TX_FAILED`, `SOROBAN_RPC_SIMULATION_FAILED`, `HORIZON_RATE_LIMITED`, `NETWORK_ETIMEDOUT`) |
| `retryable` | `boolean` | Whether the failure is transient and safe to retry |
| `httpStatus` | `number?` | HTTP status code if available |
| `rpcCode` | `number?` | JSON-RPC 2.0 numeric error code if available |
| `horizonType` | `string?` | Horizon RFC 7807 `type` URI if available |
| `horizonResultCodes` | `{ transaction?: string; operations?: string[] }?` | Horizon transaction/operation result codes |
| `retryAfterMs` | `number?` | Parsed `Retry-After` delay in milliseconds |
| `operation` | `string?` | SDK operation name (e.g. `getAccount`, `simulateTransaction`) |
| `cause` | `unknown` | Original raw error preserved for debugging |

## Usage

### Normalizing Horizon or Soroban RPC Errors Directly

```typescript
import {
  normalizeHorizonError,
  normalizeSorobanRpcError,
  withNormalizedBoundaryError,
  isSdkBoundaryError,
} from 'stellar-liquidity-yield-engine-sdk';

try {
  await horizonServer.loadAccount(publicKey);
} catch (err) {
  const normalized = normalizeHorizonError(err, 'loadAccount');
  console.error(normalized.toJSON());
  if (normalized.retryable) {
    // Safe to retry (respect normalized.retryAfterMs if present)
  }
}

// Or wrap any async boundary call:
const events = await withNormalizedBoundaryError(
  () => rpcServer.getEvents(request),
  { source: 'soroban_rpc', operation: 'getEvents' },
);
```

### Enabling Normalized Errors on `RetryRpcServer`

`RetryRpcServer` keeps `normalizeErrors: false` by default for backward compatibility. Opt in via `RpcRetryOptions`:

```typescript
import { createRetryRpcServerFromUrl } from 'stellar-liquidity-yield-engine-sdk';

const rpc = createRetryRpcServerFromUrl('https://soroban-testnet.stellar.org', {
  maxRetries: 3,
  normalizeErrors: true,
});
```

### Retry Integration

`withRetry` automatically respects `SdkBoundaryError.retryable`, retrying transient errors (`rate_limit`, `timeout`, `network`, `server_error`) and failing fast on non-retryable errors (`not_found`, `invalid_request`, `unauthorized`, `transaction_failed`, `simulation_failed`, `cursor_expired`).
