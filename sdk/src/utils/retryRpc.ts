/**
 * Retry wrapper for SorobanRpc.Server.
 *
 * Wraps key RPC methods with retry logic for transient errors.
 */

import { SorobanRpc } from 'stellar-sdk';
import { withRetry, RetryOptions, DEFAULT_RETRY_OPTIONS } from './retry';

/**
 * Retry options specifically for RPC calls.
 */
export interface RpcRetryOptions extends RetryOptions {
  /** Whether to retry read operations (getAccount, simulateTransaction). Defaults to true. */
  retryReads?: boolean;
  /** Whether to retry write operations (sendTransaction). Defaults to true. */
  retryWrites?: boolean;
}

const DEFAULT_RPC_RETRY_OPTIONS: Required<RpcRetryOptions> = {
  ...DEFAULT_RETRY_OPTIONS,
  retryReads: true,
  retryWrites: true,
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

  /**
   * Get account with retry for transient errors.
   */
  async getAccount(address: string): Promise<SorobanRpc.Api.AccountResponse> {
    if (!this.options.retryReads) {
      return this.server.getAccount(address);
    }

    const { result } = await withRetry(
      () => this.server.getAccount(address),
      this.options
    );
    return result;
  }

  /**
   * Simulate transaction with retry for transient errors.
   */
  async simulateTransaction(
    transaction: SorobanRpc.Api.SimulateTransactionRequest
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    if (!this.options.retryReads) {
      return this.server.simulateTransaction(transaction);
    }

    const { result } = await withRetry(
      () => this.server.simulateTransaction(transaction),
      this.options
    );
    return result;
  }

  /**
   * Send transaction with retry for transient errors.
   */
  async sendTransaction(
    transaction: SorobanRpc.Api.SendTransactionRequest
  ): Promise<SorobanRpc.Api.SendTransactionResponse> {
    if (!this.options.retryWrites) {
      return this.server.sendTransaction(transaction);
    }

    const { result } = await withRetry(
      () => this.server.sendTransaction(transaction),
      this.options
    );
    return result;
  }

  /**
   * Get transaction with retry for transient errors.
   */
  async getTransaction(
    hash: string
  ): Promise<SorobanRpc.GetTransactionResponse> {
    if (!this.options.retryReads) {
      return this.server.getTransaction(hash);
    }

    const { result } = await withRetry(
      () => this.server.getTransaction(hash),
      this.options
    );
    return result;
  }

  /**
   * Get latest ledger with retry for transient errors.
   */
  async getLatestLedger(): Promise<SorobanRpc.Api.LedgerSequenceResponse> {
    if (!this.options.retryReads) {
      return this.server.getLatestLedger();
    }

    const { result } = await withRetry(
      () => this.server.getLatestLedger(),
      this.options
    );
    return result;
  }

  /**
   * Get events with retry for transient errors.
   */
  async getEvents(
    request: SorobanRpc.Api.GetEventsRequest
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    if (!this.options.retryReads) {
      return this.server.getEvents(request);
    }

    const { result } = await withRetry(
      () => this.server.getEvents(request),
      this.options
    );
    return result;
  }

  /**
   * Get health with retry for transient errors.
   */
  async getHealth(): Promise<SorobanRpc.Api.GetHealthResponse> {
    if (!this.options.retryReads) {
      return this.server.getHealth();
    }

    const { result } = await withRetry(
      () => this.server.getHealth(),
      this.options
    );
    return result;
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
