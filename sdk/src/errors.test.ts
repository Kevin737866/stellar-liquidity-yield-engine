import {
  SdkBoundaryError,
  normalizeSdkError,
  normalizeHorizonError,
  normalizeSorobanRpcError,
  isSdkBoundaryError,
  isRetryableSdkError,
  withNormalizedBoundaryError,
} from './errors';
import { withRetry } from './utils/retry';
import { RetryRpcServer } from './utils/retryRpc';

describe('Horizon and Soroban RPC error normalization', () => {
  describe('Horizon errors (RFC 7807)', () => {
    it('normalizes Horizon transaction_failed with result_codes', () => {
      const raw = {
        response: {
          status: 400,
          data: {
            type: 'https://stellar.org/horizon-errors/transaction_failed',
            title: 'Transaction Failed',
            status: 400,
            detail: 'The transaction failed when submitted to the stellar network.',
            extras: {
              result_codes: {
                transaction: 'tx_failed',
                operations: ['op_underfunded'],
              },
            },
          },
        },
      };

      const err = normalizeHorizonError(raw, 'submitTransaction');
      expect(err).toBeInstanceOf(SdkBoundaryError);
      expect(err.source).toBe('horizon');
      expect(err.category).toBe('transaction_failed');
      expect(err.code).toBe('HORIZON_TX_FAILED');
      expect(err.retryable).toBe(false);
      expect(err.httpStatus).toBe(400);
      expect(err.horizonType).toBe('https://stellar.org/horizon-errors/transaction_failed');
      expect(err.horizonResultCodes).toEqual({
        transaction: 'tx_failed',
        operations: ['op_underfunded'],
      });
      expect(err.operation).toBe('submitTransaction');
      expect(err.cause).toBe(raw);
    });

    it('normalizes Horizon 404 not found', () => {
      const raw = {
        response: {
          status: 404,
          data: {
            type: 'https://stellar.org/horizon-errors/not_found',
            title: 'Resource Missing',
            status: 404,
            detail: 'The resource at the url requested was not found.',
          },
        },
      };

      const err = normalizeSdkError(raw);
      expect(err.source).toBe('horizon');
      expect(err.category).toBe('not_found');
      expect(err.code).toBe('HORIZON_NOT_FOUND');
      expect(err.retryable).toBe(false);
      expect(err.httpStatus).toBe(404);
    });

    it('normalizes Horizon 410 before_history as cursor_expired', () => {
      const raw = {
        response: {
          status: 410,
          data: {
            type: 'https://stellar.org/horizon-errors/before_history',
            title: 'Data Requested Is Before Recorded History',
            status: 410,
          },
        },
      };

      const err = normalizeSdkError(raw);
      expect(err.source).toBe('horizon');
      expect(err.category).toBe('cursor_expired');
      expect(err.code).toBe('HORIZON_BEFORE_HISTORY');
      expect(err.retryable).toBe(false);
      expect(err.httpStatus).toBe(410);
    });

    it('normalizes Horizon 429 rate limit with numeric Retry-After header', () => {
      const raw = {
        response: {
          status: 429,
          headers: { 'Retry-After': '15' },
          data: {
            type: 'https://stellar.org/horizon-errors/rate_limit_exceeded',
            title: 'Rate Limit Exceeded',
            status: 429,
            detail: 'The rate limit for the requesting IP address is over its alloted limit.',
          },
        },
      };

      const err = normalizeHorizonError(raw);
      expect(err.source).toBe('horizon');
      expect(err.category).toBe('rate_limit');
      expect(err.code).toBe('HORIZON_RATE_LIMITED');
      expect(err.retryable).toBe(true);
      expect(err.httpStatus).toBe(429);
      expect(err.retryAfterMs).toBe(15_000);
    });

    it('normalizes Horizon 503 server error as retryable', () => {
      const raw = {
        response: {
          status: 503,
          data: {
            title: 'Service Unavailable',
            status: 503,
          },
        },
      };

      const err = normalizeHorizonError(raw);
      expect(err.source).toBe('horizon');
      expect(err.category).toBe('server_error');
      expect(err.code).toBe('HORIZON_SERVER_ERROR');
      expect(err.retryable).toBe(true);
      expect(err.httpStatus).toBe(503);
    });

    it('normalizes Horizon 401/403 as unauthorized and non-retryable', () => {
      const raw = { response: { status: 403, data: { title: 'Forbidden', status: 403 } } };
      const err = normalizeHorizonError(raw);
      expect(err.category).toBe('unauthorized');
      expect(err.code).toBe('HORIZON_UNAUTHORIZED');
      expect(err.retryable).toBe(false);
    });
  });

  describe('Soroban RPC errors', () => {
    it('normalizes JSON-RPC -32602 invalid params as non-retryable', () => {
      const raw = Object.assign(new Error('Invalid params: missing ledger'), { code: -32602 });
      const err = normalizeSorobanRpcError(raw, 'getEvents');
      expect(err.source).toBe('soroban_rpc');
      expect(err.category).toBe('invalid_request');
      expect(err.code).toBe('SOROBAN_RPC_INVALID_PARAMS');
      expect(err.rpcCode).toBe(-32602);
      expect(err.retryable).toBe(false);
      expect(err.operation).toBe('getEvents');
    });

    it('normalizes JSON-RPC -32603 internal error as retryable', () => {
      const raw = { response: { status: 200, data: { error: { code: -32603, message: 'Internal error' } } } };
      const err = normalizeSdkError(raw);
      expect(err.source).toBe('soroban_rpc');
      expect(err.category).toBe('server_error');
      expect(err.code).toBe('SOROBAN_RPC_INTERNAL_ERROR');
      expect(err.rpcCode).toBe(-32603);
      expect(err.retryable).toBe(true);
    });

    it('normalizes JSON-RPC cursor out of range as cursor_expired', () => {
      const raw = Object.assign(new Error('startLedger is out of range'), { code: -32600 });
      const err = normalizeSorobanRpcError(raw, 'getEvents');
      expect(err.category).toBe('cursor_expired');
      expect(err.code).toBe('SOROBAN_RPC_CURSOR_EXPIRED');
      expect(err.retryable).toBe(false);
    });

    it('normalizes SimulateTransactionErrorResponse objects', () => {
      const simErr = {
        id: '1',
        latestLedger: 123456,
        error: 'HostError: Error(Contract, #4)',
      };
      const err = normalizeSorobanRpcError(simErr, 'simulateTransaction');
      expect(err.source).toBe('soroban_rpc');
      expect(err.category).toBe('simulation_failed');
      expect(err.code).toBe('SOROBAN_RPC_SIMULATION_FAILED');
      expect(err.message).toBe('HostError: Error(Contract, #4)');
      expect(err.retryable).toBe(false);
    });

    it('normalizes SendTransactionResponse TRY_AGAIN_LATER as retryable', () => {
      const sendErr = { status: 'TRY_AGAIN_LATER', hash: 'abc', latestLedger: 100 };
      const err = normalizeSorobanRpcError(sendErr, 'sendTransaction');
      expect(err.source).toBe('soroban_rpc');
      expect(err.category).toBe('server_error');
      expect(err.code).toBe('SOROBAN_RPC_TRY_AGAIN_LATER');
      expect(err.retryable).toBe(true);
    });

    it('normalizes SendTransactionResponse ERROR as non-retryable transaction_failed', () => {
      const sendErr = { status: 'ERROR', hash: 'abc', latestLedger: 100 };
      const err = normalizeSorobanRpcError(sendErr, 'sendTransaction');
      expect(err.source).toBe('soroban_rpc');
      expect(err.category).toBe('transaction_failed');
      expect(err.code).toBe('SOROBAN_RPC_TX_FAILED');
      expect(err.retryable).toBe(false);
    });

    it('normalizes Soroban RPC HTTP 504 gateway timeout as retryable timeout', () => {
      const raw = { response: { status: 504 }, message: 'Gateway Timeout' };
      const err = normalizeSorobanRpcError(raw);
      expect(err.source).toBe('soroban_rpc');
      expect(err.category).toBe('timeout');
      expect(err.code).toBe('SOROBAN_RPC_GATEWAY_TIMEOUT');
      expect(err.retryable).toBe(true);
      expect(err.httpStatus).toBe(504);
    });
  });

  describe('Network and boundary edge cases', () => {
    it('normalizes ECONNRESET as retryable network error', () => {
      const raw = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      const err = normalizeSdkError(raw);
      expect(err.source).toBe('network');
      expect(err.category).toBe('network');
      expect(err.code).toBe('NETWORK_ECONNRESET');
      expect(err.retryable).toBe(true);
    });

    it('normalizes ETIMEDOUT and AbortError as retryable timeout', () => {
      const raw = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      const err = normalizeSdkError(raw);
      expect(err.category).toBe('timeout');
      expect(err.code).toBe('NETWORK_ETIMEDOUT');
      expect(err.retryable).toBe(true);

      const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      const err2 = normalizeSdkError(abortErr);
      expect(err2.category).toBe('timeout');
      expect(err2.retryable).toBe(true);
    });

    it('is idempotent when given an existing SdkBoundaryError', () => {
      const first = normalizeHorizonError({ response: { status: 404 } });
      const second = normalizeSdkError(first);
      expect(second).toBe(first);

      const withOp = normalizeSdkError(first, { operation: 'loadAccount' });
      expect(withOp).toBeInstanceOf(SdkBoundaryError);
      expect(withOp.operation).toBe('loadAccount');
      expect(withOp.code).toBe(first.code);
    });

    it('handles non-Error values (string, null, undefined) safely', () => {
      const strErr = normalizeSdkError('raw failure string');
      expect(strErr.category).toBe('unknown');
      expect(strErr.code).toBe('SDK_UNKNOWN_ERROR');
      expect(strErr.message).toBe('raw failure string');
      expect(strErr.retryable).toBe(false);

      const nullErr = normalizeSdkError(null);
      expect(nullErr.message).toBe('Unknown SDK error');
      expect(isSdkBoundaryError(nullErr)).toBe(true);
      expect(isRetryableSdkError(nullErr)).toBe(false);
    });

    it('serializes cleanly with toJSON()', () => {
      const err = normalizeHorizonError(
        { response: { status: 429, headers: { 'retry-after': '5' } } },
        'fetchPools',
      );
      expect(err.toJSON()).toEqual({
        name: 'SdkBoundaryError',
        source: 'horizon',
        category: 'rate_limit',
        code: 'HORIZON_RATE_LIMITED',
        message: 'Horizon HTTP 429',
        retryable: true,
        httpStatus: 429,
        retryAfterMs: 5000,
        operation: 'fetchPools',
      });
    });

    it('withNormalizedBoundaryError returns value on success and normalizes on failure', async () => {
      const ok = await withNormalizedBoundaryError(async () => 42, { source: 'horizon' });
      expect(ok).toBe(42);

      await expect(
        withNormalizedBoundaryError(
          async () => {
            throw { response: { status: 404 } };
          },
          { source: 'horizon', operation: 'getPool' },
        ),
      ).rejects.toMatchObject({
        name: 'SdkBoundaryError',
        source: 'horizon',
        category: 'not_found',
        code: 'HORIZON_NOT_FOUND',
        operation: 'getPool',
      });
    });
  });

  describe('Integration with retry utilities', () => {
    it('withRetry retries retryable SdkBoundaryError and does not retry non-retryable ones', async () => {
      let attempts = 0;
      const res = await withRetry(
        async () => {
          attempts++;
          if (attempts < 2) {
            throw normalizeHorizonError({ response: { status: 429 } });
          }
          return 'ok';
        },
        { maxRetries: 2, initialDelayMs: 1, jitter: false },
      );
      expect(res.result).toBe('ok');
      expect(res.attempts).toBe(2);

      let nonRetryAttempts = 0;
      await expect(
        withRetry(
          async () => {
            nonRetryAttempts++;
            throw normalizeHorizonError({ response: { status: 404 } });
          },
          { maxRetries: 2, initialDelayMs: 1, jitter: false },
        ),
      ).rejects.toBeInstanceOf(SdkBoundaryError);
      expect(nonRetryAttempts).toBe(1);
    });

    it('RetryRpcServer normalizes errors when normalizeErrors is enabled', async () => {
      const fakeServer = {
        getAccount: jest.fn().mockRejectedValue(
          Object.assign(new Error('Invalid params'), { code: -32602 }),
        ),
      } as any;

      const client = new RetryRpcServer(fakeServer, {
        maxRetries: 0,
        normalizeErrors: true,
      });

      await expect(client.getAccount('GABC')).rejects.toMatchObject({
        name: 'SdkBoundaryError',
        source: 'soroban_rpc',
        category: 'invalid_request',
        code: 'SOROBAN_RPC_INVALID_PARAMS',
        rpcCode: -32602,
        operation: 'getAccount',
      });
    });
  });
});
