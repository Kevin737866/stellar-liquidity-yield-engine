/**
 * Example demonstrating retry logic for RPC calls.
 *
 * This example shows how to use the retry utilities to handle transient
 * RPC errors in the Stellar Liquidity Yield Engine SDK.
 */

import { withRetry, createRetryRpcServerFromUrl } from '../sdk/src/utils';

// Example 1: Basic retry with a custom async function
async function exampleBasicRetry() {
  console.log('=== Example 1: Basic Retry ===');

  let attemptCount = 0;

  const fetchData = async () => {
    attemptCount++;
    console.log(`Attempt ${attemptCount}`);

    // Simulate transient error on first attempt
    if (attemptCount === 1) {
      throw new Error('network timeout');
    }

    // Success on second attempt
    return { data: 'success' };
  };

  try {
    const { result, attempts } = await withRetry(fetchData, {
      maxRetries: 3,
      onRetry: (attempt, error, delayMs) => {
        console.log(`  Retrying attempt ${attempt} after ${delayMs}ms: ${error.message}`);
      },
    });

    console.log(`Success after ${attempts} attempts:`, result);
  } catch (error) {
    console.error('Failed after all retries:', error);
  }
}

// Example 2: Retry with custom backoff options
async function exampleCustomBackoff() {
  console.log('\n=== Example 2: Custom Backoff ===');

  let attemptCount = 0;

  const fetchData = async () => {
    attemptCount++;
    console.log(`Attempt ${attemptCount} at ${new Date().toISOString()}`);

    if (attemptCount < 3) {
      throw new Error('service unavailable');
    }

    return { data: 'success' };
  };

  try {
    const { result, attempts } = await withRetry(fetchData, {
      maxRetries: 5,
      initialDelayMs: 50,
      backoffMultiplier: 2,
      maxDelayMs: 200,
      jitter: false, // Disable jitter for predictable timing in this example
      onRetry: (attempt, error, delayMs) => {
        console.log(`  Will retry in ${delayMs}ms`);
      },
    });

    console.log(`Success after ${attempts} attempts:`, result);
  } catch (error) {
    console.error('Failed:', error);
  }
}

// Example 3: Non-transient error (no retry)
async function exampleNonTransientError() {
  console.log('\n=== Example 3: Non-Transient Error (No Retry) ===');

  let attemptCount = 0;

  const fetchData = async () => {
    attemptCount++;
    console.log(`Attempt ${attemptCount}`);

    // This error is not transient, so it won't retry
    throw new Error('invalid signature');
  };

  try {
    await withRetry(fetchData, {
      maxRetries: 3,
      onRetry: (attempt, error, delayMs) => {
        console.log(`  Retrying...`);
      },
    });
  } catch (error) {
    console.log(`Failed immediately without retries (expected): ${error.message}`);
    console.log(`Total attempts: ${attemptCount}`);
  }
}

// Example 4: Using RetryRpcServer (mock example)
async function exampleRetryRpcServer() {
  console.log('\n=== Example 4: RetryRpcServer Usage ===');

  // Note: This is a conceptual example. In production, you would use
  // a real SorobanRpc.Server instance.

  /*
  import { SorobanRpc } from 'stellar-sdk';

  const retryServer = createRetryRpcServerFromUrl(
    'https://soroban-testnet.stellar.org',
    {
      maxRetries: 3,
      retryReads: true,
      retryWrites: true,
      onRetry: (attempt, error, delayMs) => {
        console.log(`RPC retry ${attempt}: ${error.message}`);
      },
    }
  );

  // All RPC calls now have automatic retry
  try {
    const account = await retryServer.getAccount('G...');
    console.log('Account fetched:', account.id);
  } catch (error) {
    console.error('Failed to fetch account:', error);
  }
  */

  console.log('See documentation for actual RPC server usage.');
}

// Example 5: Exhausted retries
async function exampleExhaustedRetries() {
  console.log('\n=== Example 5: Exhausted Retries ===');

  let attemptCount = 0;

  const fetchData = async () => {
    attemptCount++;
    console.log(`Attempt ${attemptCount}`);

    // Always fail with transient error
    throw new Error('network error');
  };

  try {
    await withRetry(fetchData, {
      maxRetries: 2,
      onRetry: (attempt, error, delayMs) => {
        console.log(`  Retrying...`);
      },
    });
  } catch (error) {
    console.log(`Failed after exhausting retries (expected): ${error.message}`);
    console.log(`Total attempts: ${attemptCount} (1 initial + 2 retries)`);
  }
}

// Run all examples
async function runExamples() {
  console.log('RPC Retry Logic Examples\n');

  await exampleBasicRetry();
  await exampleCustomBackoff();
  await exampleNonTransientError();
  await exampleRetryRpcServer();
  await exampleExhaustedRetries();

  console.log('\n=== All Examples Complete ===');
}

// Uncomment to run examples
// runExamples().catch(console.error);

export {
  exampleBasicRetry,
  exampleCustomBackoff,
  exampleNonTransientError,
  exampleRetryRpcServer,
  exampleExhaustedRetries,
  runExamples,
};
