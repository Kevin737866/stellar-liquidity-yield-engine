# RPC Retry Logic Implementation

## Overview

This implementation adds retry logic for transient RPC errors to reduce spurious failures in the Stellar Liquidity Yield Engine SDK. The retry mechanism is designed to handle temporary network issues, rate limits, and server-side errors that are likely to resolve on retry.

## Features

- **Automatic retry for transient errors**: Network timeouts, connection errors, rate limits, and temporary server failures
- **Exponential backoff**: Delays increase exponentially between retries to avoid overwhelming the server
- **Jitter**: Random variation in retry delays to prevent thundering herd problems
- **Configurable limits**: Maximum retries, initial delay, backoff multiplier, and max delay are all configurable
- **Selective retry**: Can enable/disable retry for read vs write operations independently
- **Comprehensive error detection**: Recognizes transient errors by code, HTTP status, and message patterns

## Usage

### Basic Retry Wrapper

Use the `withRetry` function to add retry logic to any async operation:

```typescript
import { withRetry } from './utils';

const result = await withRetry(
  async () => {
    return await someRpcCall();
  },
  {
    maxRetries: 3,
    initialDelayMs: 100,
    backoffMultiplier: 2,
    maxDelayMs: 5000,
  }
);
```

### Retry RPC Server

Use `RetryRpcServer` to wrap a SorobanRpc.Server instance:

```typescript
import { SorobanRpc } from 'stellar-sdk';
import { createRetryRpcServer } from './utils';

const server = new SorobanRpc.Server('https://soroban-testnet.stellar.org');
const retryServer = createRetryRpcServer(server, {
  maxRetries: 3,
  retryReads: true,
  retryWrites: true,
});

// All RPC calls now have automatic retry
const account = await retryServer.getAccount('G...');
const result = await retryServer.simulateTransaction(tx);
```

### Create from URL

```typescript
import { createRetryRpcServerFromUrl } from './utils';

const retryServer = createRetryRpcServerFromUrl(
  'https://soroban-testnet.stellar.org',
  { maxRetries: 5 }
);
```

### Custom Retry Options

```typescript
const options = {
  maxRetries: 5,              // Maximum retry attempts (default: 3)
  initialDelayMs: 200,        // Initial delay in ms (default: 100)
  backoffMultiplier: 3,       // Exponential backoff factor (default: 2)
  maxDelayMs: 10000,          // Maximum delay cap in ms (default: 5000)
  jitter: true,               // Add random jitter (default: true)
  retryReads: true,           // Retry read operations (default: true)
  retryWrites: true,          // Retry write operations (default: true)
  onRetry: (attempt, error, delayMs) => {
    console.log(`Retry attempt ${attempt} after ${delayMs}ms: ${error.message}`);
  },
};
```

## Transient Error Detection

The retry logic automatically detects transient errors using:

### Error Codes
- `ECONNRESET` - Connection reset by peer
- `ECONNREFUSED` - Connection refused
- `ETIMEDOUT` - Operation timed out
- `ENOTFOUND` - DNS lookup failed
- `EAI_AGAIN` - DNS timeout
- `EPIPE` - Broken pipe

### HTTP Status Codes
- `408` - Request Timeout
- `429` - Too Many Requests (rate limit)
- `500` - Internal Server Error
- `502` - Bad Gateway
- `503` - Service Unavailable
- `504` - Gateway Timeout

### Error Message Patterns
- "network"
- "timeout"
- "temporary"
- "unavailable"
- "rate limit"
- "too many requests"
- "connection"

Non-transient errors (e.g., "invalid signature", "insufficient funds") are not retried and fail immediately.

## Integration with Existing Clients

To integrate retry logic into existing SDK clients:

### VaultClient

```typescript
import { VaultClient, createRetryRpcServer } from './sdk';

const config = TESTNET_CONFIG;
const vaultClient = new VaultClient(vaultAddress, config);

// Replace the server with a retry wrapper
const retryServer = createRetryRpcServer(
  new SorobanRpc.Server(config.sorobanRpcUrl)
);
// Note: This would require modifying VaultClient to accept an injected server
```

### GovernanceSDK

```typescript
import { GovernanceSDK, createRetryRpcServerFromUrl } from './sdk';

const retryServer = createRetryRpcServerFromUrl(
  'https://soroban-testnet.stellar.org'
);
// Note: This would require modifying GovernanceSDK to accept an injected server
```

## Testing

Run the retry tests:

```bash
cd sdk
npm test -- retry.test.ts
npm test -- retryRpc.test.ts
```

The tests cover:
- Successful first attempt
- Retry on transient errors
- No retry on non-transient errors
- Exponential backoff calculation
- Jitter addition
- Max delay capping
- Retry callback invocation
- Custom retry options
- RPC server method wrapping

## Default Configuration

The default retry options are:

```typescript
{
  maxRetries: 3,              // Up to 3 retry attempts
  initialDelayMs: 100,        // Start with 100ms delay
  backoffMultiplier: 2,       // Double delay each retry
  maxDelayMs: 5000,          // Cap at 5 seconds
  jitter: true,               // Add ±25% random variation
  retryReads: true,           // Retry read operations
  retryWrites: true,          // Retry write operations
}
```

With these defaults, the retry delays would be approximately:
- Attempt 1: 100ms (±25% jitter)
- Attempt 2: 200ms (±25% jitter)
- Attempt 3: 400ms (±25% jitter)

Total maximum wait time: ~700ms for 3 retries.

## Best Practices

1. **Use retry for read operations**: Reads are safe to retry as they don't modify state
2. **Be careful with write operations**: Some writes may not be idempotent; consider idempotency before retrying
3. **Monitor retry attempts**: Use the `onRetry` callback to log and alert on excessive retries
4. **Adjust for your use case**: Increase `maxRetries` for critical operations, decrease for latency-sensitive ones
5. **Set appropriate timeouts**: Ensure your operation-level timeouts account for retry delays

## Files Added

- `sdk/src/utils/retry.ts` - Core retry logic with exponential backoff
- `sdk/src/utils/retryRpc.ts` - SorobanRpc.Server wrapper with retry
- `sdk/src/utils/index.ts` - Utility exports
- `sdk/src/utils/retry.test.ts` - Retry logic tests
- `sdk/src/utils/retryRpc.test.ts` - RPC wrapper tests

## Future Enhancements

Potential improvements for future iterations:

1. **Circuit breaker**: Temporarily stop retrying after consecutive failures
2. **Retry budget**: Limit total retries across all operations
3. **Metrics**: Track retry rates and success/failure ratios
4. **Adaptive backoff**: Adjust backoff based on error patterns
5. **Idempotency keys**: Support for idempotent write operations
