/**
 * Retry wrapper for SorobanRpc.Server.
 *
 * Wraps key RPC methods with retry logic for transient errors.
 */

import { SorobanRpc } from 'stellar-sdk';
import { withRetry, RetryOptions, DEFAULT_RETRY_OPTIONS } from './retry';
import { normalizeSorobanRpcError } from '../errors';

/**
 * Retry options specifically for RPC calls.
 */
export interface RpcRetryOptions extends RetryOptions {
  /** Whether to retry read operations (getAccount, simulateTransaction). Defaults to true. */
  retryReads?: boolean;
  /** Whether to retry write operations (sendTransaction). Defaults to true. */
  retryWrites?: boolean;
  /**
   * When true, normalize thrown Soroban RPC / transport errors into
   * {@link SdkBoundaryError} at the SDK boundary. Defaults to false for
   * backward compatibility with callers expecting raw errors.
   */
  normalizeErrors?: boolean;
}

const DEFAULT_RPC_RETRY_OPTIONS: Required<RpcRetryOptions> = {
  ...DEFAULT_RETRY_OPTIONS,
  retryReads: true,
  retryWrites: true,
  normalizeErrors: false,
};

/**
 * A SorobanRpc.Server wrapper that retries transient errors.
 */
export class RetryRpcServer {
  private server: SorobanRpc.Server;
  private options: Required<RpcRetryOptions>;

  constructor(server: SorobanRpc.Server, options: RpcRetryOptions = {}) {
    this.server = server;
    this.options = { ...DEFAULT_RPC_RETRY_OPTIONS, ...options };
  }

  private async execute<T>(
    operation: string,
    shouldRetry: boolean,
    fn: () => Promise<T>
  ): Promise<T> {
    try {
      if (!shouldRetry) {
        return await fn();
      }
      const { result } = await withRetry(fn, this.options);
      return result;
    } catch (error) {
      if (this.options.normalizeErrors) {
        throw normalizeSorobanRpcError(error, operation);
      }
      throw error;
    }
  }

  /**
   * Get account with retry for transient errors.
   */
  async getAccount(address: string): Promise<SorobanRpc.Api.AccountResponse> {
    return this.execute('getAccount', this.options.retryReads, () =>
      this.server.getAccount(address)
    );
  }

  /**
   * Simulate transaction with retry for transient errors.
   */
  async simulateTransaction(
    transaction: SorobanRpc.Api.SimulateTransactionRequest
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this.execute('simulateTransaction', this.options.retryReads, () =>
      this.server.simulateTransaction(transaction)
    );
  }

  /**
   * Send transaction with retry for transient errors.
   */
  async sendTransaction(
    transaction: SorobanRpc.Api.SendTransactionRequest
  ): Promise<SorobanRpc.Api.SendTransactionResponse> {
    return this.execute('sendTransaction', this.options.retryWrites, () =>
      this.server.sendTransaction(transaction)
    );
  }

  /**
   * Get transaction with retry for transient errors.
   */
  async getTransaction(
    hash: string
  ): Promise<SorobanRpc.GetTransactionResponse> {
    return this.execute('getTransaction', this.options.retryReads, () =>
      this.server.getTransaction(hash)
    );
  }

  /**
   * Get latest ledger with retry for transient errors.
   */
  async getLatestLedger(): Promise<SorobanRpc.Api.LedgerSequenceResponse> {
    return this.execute('getLatestLedger', this.options.retryReads, () =>
      this.server.getLatestLedger()
    );
  }

  /**
   * Get events with retry for transient errors.
   */
  async getEvents(
    request: SorobanRpc.Api.GetEventsRequest
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    return this.execute('getEvents', this.options.retryReads, () =>
      this.server.getEvents(request)
    );
  }

  /**
   * Get health with retry for transient errors.
   */
  async getHealth(): Promise<SorobanRpc.Api.GetHealthResponse> {
    return this.execute('getHealth', this.options.retryReads, () =>
      this.server.getHealth()
    );
  }

  /**
   * Access the underlying server for methods not wrapped.
   */
  getUnderlyingServer(): SorobanRpc.Server {
    return this.server;
  }

  /**
   * Get the server URL.
   */
  get serverURL(): string {
    return this.server.serverURL;
  }
}

/**
 * Create a RetryRpcServer from a SorobanRpc.Server instance.
 */
export function createRetryRpcServer(
  server: SorobanRpc.Server,
  options?: RpcRetryOptions
): RetryRpcServer {
  return new RetryRpcServer(server, options);
}

/**
 * Create a RetryRpcServer from a URL.
 */
export function createRetryRpcServerFromUrl(
  url: string,
  options?: RpcRetryOptions
): RetryRpcServer {
  const server = new SorobanRpc.Server(url);
  return new RetryRpcServer(server, options);
}
