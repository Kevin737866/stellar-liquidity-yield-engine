/**
 * Normalized Horizon and Soroban RPC error boundary for the SDK.
 *
 * Raw errors from Horizon (RFC 7807 Problem Details via axios / stellar-sdk),
 * Soroban RPC (JSON-RPC 2.0 errors, simulation/send/getTransaction failures),
 * and transport/network layers arrive in heterogeneous shapes. This module
 * normalizes them into a single, predictable {@link SdkBoundaryError} type
 * with a canonical category, machine-readable code, retryability flag, and
 * preserved structured metadata.
 */

export type SdkErrorSource = 'horizon' | 'soroban_rpc' | 'network' | 'unknown';

export type SdkErrorCategory =
  | 'network'
  | 'timeout'
  | 'rate_limit'
  | 'not_found'
  | 'invalid_request'
  | 'unauthorized'
  | 'transaction_failed'
  | 'simulation_failed'
  | 'cursor_expired'
  | 'server_error'
  | 'unknown';

export interface HorizonResultCodes {
  transaction?: string;
  operations?: string[];
}

export interface NormalizeErrorContext {
  /** Hint for which backend produced the error when the payload is ambiguous. */
  source?: SdkErrorSource;
  /** Optional SDK operation name (e.g. 'getAccount', 'simulateTransaction'). */
  operation?: string;
}

export interface NormalizedSdkErrorDetails {
  source: SdkErrorSource;
  category: SdkErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  rpcCode?: number;
  horizonType?: string;
  horizonResultCodes?: HorizonResultCodes;
  retryAfterMs?: number;
  operation?: string;
  cause?: unknown;
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_NETWORK',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNABORTED',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const CURSOR_EXPIRED_PATTERNS = [
  /cursor.*out of.*range/i,
  /startledger.*out of.*range/i,
  /before_history/i,
  /before history/i,
  /ledger.*pruned/i,
  /ledger.*expired/i,
];

/**
 * Canonical error thrown at the SDK boundary for Horizon, Soroban RPC,
 * and transport-level failures.
 */
export class SdkBoundaryError extends Error {
  readonly source: SdkErrorSource;
  readonly category: SdkErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly rpcCode?: number;
  readonly horizonType?: string;
  readonly horizonResultCodes?: HorizonResultCodes;
  readonly retryAfterMs?: number;
  readonly operation?: string;
  readonly cause?: unknown;

  constructor(details: NormalizedSdkErrorDetails) {
    super(details.message);
    this.name = 'SdkBoundaryError';
    this.source = details.source;
    this.category = details.category;
    this.code = details.code;
    this.retryable = details.retryable;
    this.httpStatus = details.httpStatus;
    this.rpcCode = details.rpcCode;
    this.horizonType = details.horizonType;
    this.horizonResultCodes = details.horizonResultCodes;
    this.retryAfterMs = details.retryAfterMs;
    this.operation = details.operation;
    this.cause = details.cause;

    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serialize to a plain JSON-safe object for structured logging and telemetry.
   */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      source: this.source,
      category: this.category,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.httpStatus !== undefined) out.httpStatus = this.httpStatus;
    if (this.rpcCode !== undefined) out.rpcCode = this.rpcCode;
    if (this.horizonType !== undefined) out.horizonType = this.horizonType;
    if (this.horizonResultCodes !== undefined) {
      out.horizonResultCodes = this.horizonResultCodes;
    }
    if (this.retryAfterMs !== undefined) out.retryAfterMs = this.retryAfterMs;
    if (this.operation !== undefined) out.operation = this.operation;
    return out;
  }
}

/**
 * Type guard for {@link SdkBoundaryError}.
 */
export function isSdkBoundaryError(error: unknown): error is SdkBoundaryError {
  return error instanceof SdkBoundaryError;
}

/**
 * Returns true if the given error (raw or normalized) represents a transient
 * failure that is safe to retry.
 */
export function isRetryableSdkError(error: unknown): boolean {
  if (isSdkBoundaryError(error)) {
    return error.retryable;
  }
  return normalizeSdkError(error).retryable;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function parseRetryAfterMs(headers: unknown): number | undefined {
  const rec = asRecord(headers);
  if (!rec) return undefined;

  let raw: unknown;
  for (const key of Object.keys(rec)) {
    if (key.toLowerCase() === 'retry-after') {
      raw = rec[key];
      break;
    }
  }
  if (raw === undefined || raw === null) return undefined;

  const str = String(raw).trim();
  if (!str) return undefined;

  const seconds = Number(str);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }

  const parsedDate = Date.parse(str);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return undefined;
}

function extractHttpStatus(err: Record<string, unknown>): number | undefined {
  const response = asRecord(err.response);
  if (response && typeof response.status === 'number') {
    return response.status;
  }
  if (typeof err.status === 'number') {
    return err.status;
  }
  if (typeof err.statusCode === 'number') {
    return err.statusCode;
  }
  const data = asRecord(response?.data) ?? asRecord(err.data);
  if (data && typeof data.status === 'number') {
    return data.status;
  }
  return undefined;
}

function extractResponseData(err: Record<string, unknown>): Record<string, unknown> | undefined {
  const response = asRecord(err.response);
  return asRecord(response?.data) ?? asRecord(err.data);
}

function extractHorizonResultCodes(
  data: Record<string, unknown> | undefined,
): HorizonResultCodes | undefined {
  const extras = asRecord(data?.extras);
  const rc = asRecord(extras?.result_codes);
  if (!rc) return undefined;

  const transaction = typeof rc.transaction === 'string' ? rc.transaction : undefined;
  const operations = Array.isArray(rc.operations)
    ? rc.operations.filter((op): op is string => typeof op === 'string')
    : undefined;

  if (!transaction && (!operations || operations.length === 0)) {
    return undefined;
  }
  return { transaction, operations };
}

function classifyHttpStatus(status: number): {
  category: SdkErrorCategory;
  codeSuffix: string;
  retryable: boolean;
} {
  if (status === 400 || status === 422) {
    return { category: 'invalid_request', codeSuffix: 'BAD_REQUEST', retryable: false };
  }
  if (status === 401 || status === 403) {
    return { category: 'unauthorized', codeSuffix: 'UNAUTHORIZED', retryable: false };
  }
  if (status === 404) {
    return { category: 'not_found', codeSuffix: 'NOT_FOUND', retryable: false };
  }
  if (status === 408) {
    return { category: 'timeout', codeSuffix: 'TIMEOUT', retryable: true };
  }
  if (status === 410) {
    return { category: 'cursor_expired', codeSuffix: 'BEFORE_HISTORY', retryable: false };
  }
  if (status === 429) {
    return { category: 'rate_limit', codeSuffix: 'RATE_LIMITED', retryable: true };
  }
  if (status === 504) {
    return { category: 'timeout', codeSuffix: 'GATEWAY_TIMEOUT', retryable: true };
  }
  if (status >= 500 && status <= 599) {
    return { category: 'server_error', codeSuffix: 'SERVER_ERROR', retryable: true };
  }
  return { category: 'unknown', codeSuffix: `HTTP_${status}`, retryable: false };
}

function classifyJsonRpcCode(rpcCode: number, message: string): {
  category: SdkErrorCategory;
  code: string;
  retryable: boolean;
} {
  if (CURSOR_EXPIRED_PATTERNS.some((re) => re.test(message))) {
    return {
      category: 'cursor_expired',
      code: 'SOROBAN_RPC_CURSOR_EXPIRED',
      retryable: false,
    };
  }

  switch (rpcCode) {
    case -32700:
      return { category: 'invalid_request', code: 'SOROBAN_RPC_PARSE_ERROR', retryable: false };
    case -32600:
      return { category: 'invalid_request', code: 'SOROBAN_RPC_INVALID_REQUEST', retryable: false };
    case -32601:
      return { category: 'invalid_request', code: 'SOROBAN_RPC_METHOD_NOT_FOUND', retryable: false };
    case -32602:
      return { category: 'invalid_request', code: 'SOROBAN_RPC_INVALID_PARAMS', retryable: false };
    case -32603:
      return { category: 'server_error', code: 'SOROBAN_RPC_INTERNAL_ERROR', retryable: true };
    default:
      if (rpcCode <= -32000 && rpcCode >= -32099) {
        return { category: 'server_error', code: 'SOROBAN_RPC_SERVER_ERROR', retryable: true };
      }
      return { category: 'unknown', code: `SOROBAN_RPC_${rpcCode}`, retryable: false };
  }
}

function isHorizonPayload(data: Record<string, unknown> | undefined): boolean {
  if (!data) return false;
  if (typeof data.type === 'string' && data.type.includes('horizon-errors')) {
    return true;
  }
  if (typeof data.title === 'string' && typeof data.status === 'number') {
    return true;
  }
  if (asRecord(data.extras)?.result_codes) {
    return true;
  }
  return false;
}

function extractRpcCode(
  err: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
): number | undefined {
  if (typeof err.code === 'number') {
    return err.code;
  }
  const rpcError = asRecord(data?.error);
  if (rpcError && typeof rpcError.code === 'number') {
    return rpcError.code;
  }
  return undefined;
}

function extractMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  const rec = asRecord(error);
  if (rec) {
    if (typeof rec.message === 'string' && rec.message.trim()) {
      return rec.message.trim();
    }
    if (typeof rec.error === 'string' && rec.error.trim()) {
      return rec.error.trim();
    }
    const data = extractResponseData(rec);
    if (data) {
      const rpcErr = asRecord(data.error);
      if (rpcErr && typeof rpcErr.message === 'string' && rpcErr.message.trim()) {
        return rpcErr.message.trim();
      }
      if (typeof data.detail === 'string' && data.detail.trim()) {
        return data.detail.trim();
      }
      if (typeof data.title === 'string' && data.title.trim()) {
        return data.title.trim();
      }
    }
  }
  return fallback;
}

/**
 * Normalize an error originating from Horizon, Soroban RPC, or the underlying
 * network transport into an {@link SdkBoundaryError}.
 *
 * Idempotent: if `error` is already an `SdkBoundaryError`, it is returned as-is
 * (or with `operation` attached if not already set).
 */
export function normalizeSdkError(
  error: unknown,
  context: NormalizeErrorContext = {},
): SdkBoundaryError {
  if (isSdkBoundaryError(error)) {
    if (context.operation && !error.operation) {
      return new SdkBoundaryError({
        source: error.source,
        category: error.category,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        httpStatus: error.httpStatus,
        rpcCode: error.rpcCode,
        horizonType: error.horizonType,
        horizonResultCodes: error.horizonResultCodes,
        retryAfterMs: error.retryAfterMs,
        operation: context.operation,
        cause: error.cause,
      });
    }
    return error;
  }

  const rec = asRecord(error);
  const response = asRecord(rec?.response);
  const data = rec ? extractResponseData(rec) : undefined;
  const httpStatus = rec ? extractHttpStatus(rec) : undefined;
  const retryAfterMs = parseRetryAfterMs(response?.headers);
  const rpcCode = rec ? extractRpcCode(rec, data) : undefined;
  const horizonResultCodes = extractHorizonResultCodes(data);
  const horizonType = typeof data?.type === 'string' ? data.type : undefined;

  // 1. Soroban RPC response-object failures (simulation, sendTransaction, getTransaction)
  if (rec) {
    // SimulateTransactionErrorResponse: { error: string, latestLedger?: number }
    if (typeof rec.error === 'string' && rec.error.trim().length > 0 && httpStatus === undefined && rpcCode === undefined) {
      return new SdkBoundaryError({
        source: context.source ?? 'soroban_rpc',
        category: 'simulation_failed',
        code: 'SOROBAN_RPC_SIMULATION_FAILED',
        message: rec.error.trim(),
        retryable: false,
        operation: context.operation,
        cause: error,
      });
    }

    // SendTransactionResponse / GetTransactionResponse status-based failures
    if (typeof rec.status === 'string') {
      const upperStatus = rec.status.toUpperCase();
      if (upperStatus === 'TRY_AGAIN_LATER') {
        return new SdkBoundaryError({
          source: context.source ?? 'soroban_rpc',
          category: 'server_error',
          code: 'SOROBAN_RPC_TRY_AGAIN_LATER',
          message: extractMessage(error, 'Soroban RPC requested retry (TRY_AGAIN_LATER)'),
          retryable: true,
          operation: context.operation,
          cause: error,
        });
      }
      if (upperStatus === 'ERROR' || upperStatus === 'FAILED') {
        return new SdkBoundaryError({
          source: context.source ?? 'soroban_rpc',
          category: 'transaction_failed',
          code: 'SOROBAN_RPC_TX_FAILED',
          message: extractMessage(error, `Soroban transaction failed with status ${upperStatus}`),
          retryable: false,
          operation: context.operation,
          cause: error,
        });
      }
    }
  }

  // 2. JSON-RPC 2.0 error codes (Soroban RPC)
  if (rpcCode !== undefined) {
    const rpcMsg = extractMessage(error, `Soroban RPC error (${rpcCode})`);
    const classified = classifyJsonRpcCode(rpcCode, rpcMsg);
    return new SdkBoundaryError({
      source: context.source ?? 'soroban_rpc',
      category: classified.category,
      code: classified.code,
      message: rpcMsg,
      retryable: classified.retryable,
      httpStatus,
      rpcCode,
      retryAfterMs,
      operation: context.operation,
      cause: error,
    });
  }

  // 3. Horizon RFC 7807 Problem Details
  if (isHorizonPayload(data) || context.source === 'horizon') {
    if (horizonResultCodes || (horizonType && horizonType.endsWith('/transaction_failed'))) {
      const detail =
        typeof data?.detail === 'string' && data.detail.trim()
          ? data.detail.trim()
          : extractMessage(error, 'Horizon transaction failed');
      return new SdkBoundaryError({
        source: 'horizon',
        category: 'transaction_failed',
        code: 'HORIZON_TX_FAILED',
        message: detail,
        retryable: false,
        httpStatus,
        horizonType,
        horizonResultCodes,
        retryAfterMs,
        operation: context.operation,
        cause: error,
      });
    }

    if (horizonType && horizonType.endsWith('/before_history')) {
      return new SdkBoundaryError({
        source: 'horizon',
        category: 'cursor_expired',
        code: 'HORIZON_BEFORE_HISTORY',
        message: extractMessage(error, 'Requested ledger is before Horizon history'),
        retryable: false,
        httpStatus: httpStatus ?? 410,
        horizonType,
        retryAfterMs,
        operation: context.operation,
        cause: error,
      });
    }

    if (httpStatus !== undefined) {
      const classified = classifyHttpStatus(httpStatus);
      const msg =
        (typeof data?.detail === 'string' && data.detail.trim()) ||
        (typeof data?.title === 'string' && data.title.trim()) ||
        extractMessage(error, `Horizon HTTP ${httpStatus}`);
      return new SdkBoundaryError({
        source: 'horizon',
        category: classified.category,
        code: `HORIZON_${classified.codeSuffix}`,
        message: msg,
        retryable: classified.retryable,
        httpStatus,
        horizonType,
        retryAfterMs,
        operation: context.operation,
        cause: error,
      });
    }
  }

  // 4. Generic HTTP status errors (e.g. Soroban RPC HTTP 429/500/503/504)
  if (httpStatus !== undefined) {
    const source: SdkErrorSource = context.source ?? 'soroban_rpc';
    const prefix = source === 'horizon' ? 'HORIZON' : 'SOROBAN_RPC';
    const classified = classifyHttpStatus(httpStatus);
    return new SdkBoundaryError({
      source,
      category: classified.category,
      code: `${prefix}_${classified.codeSuffix}`,
      message: extractMessage(error, `HTTP ${httpStatus} error`),
      retryable: classified.retryable,
      httpStatus,
      retryAfterMs,
      operation: context.operation,
      cause: error,
    });
  }

  // 5. Network / transport errors (Node.js / axios / fetch)
  const strCode = typeof rec?.code === 'string' ? rec.code : undefined;
  const errName = typeof rec?.name === 'string' ? rec.name : undefined;
  const msg = extractMessage(error, 'Unknown SDK error');

  if (
    (strCode && TIMEOUT_ERROR_CODES.has(strCode)) ||
    errName === 'AbortError' ||
    /timeout|timed out/i.test(msg)
  ) {
    return new SdkBoundaryError({
      source: context.source ?? 'network',
      category: 'timeout',
      code: strCode ? `NETWORK_${strCode}` : 'NETWORK_TIMEOUT',
      message: msg,
      retryable: true,
      operation: context.operation,
      cause: error,
    });
  }

  if (
    (strCode && NETWORK_ERROR_CODES.has(strCode)) ||
    /fetch failed|network error|econnreset|econnrefused|enotfound/i.test(msg)
  ) {
    return new SdkBoundaryError({
      source: context.source ?? 'network',
      category: 'network',
      code: strCode ? `NETWORK_${strCode}` : 'NETWORK_ERROR',
      message: msg,
      retryable: true,
      operation: context.operation,
      cause: error,
    });
  }

  // 6. Cursor expiration detected by message alone
  if (CURSOR_EXPIRED_PATTERNS.some((re) => re.test(msg))) {
    const source = context.source ?? 'soroban_rpc';
    return new SdkBoundaryError({
      source,
      category: 'cursor_expired',
      code: source === 'horizon' ? 'HORIZON_BEFORE_HISTORY' : 'SOROBAN_RPC_CURSOR_EXPIRED',
      message: msg,
      retryable: false,
      operation: context.operation,
      cause: error,
    });
  }

  // 7. Fallback: unknown error
  return new SdkBoundaryError({
    source: context.source ?? 'unknown',
    category: 'unknown',
    code: 'SDK_UNKNOWN_ERROR',
    message: msg,
    retryable: false,
    operation: context.operation,
    cause: error,
  });
}

/**
 * Normalize an error from a Horizon client call.
 */
export function normalizeHorizonError(
  error: unknown,
  operation?: string,
): SdkBoundaryError {
  return normalizeSdkError(error, { source: 'horizon', operation });
}

/**
 * Normalize an error from a Soroban RPC client call.
 */
export function normalizeSorobanRpcError(
  error: unknown,
  operation?: string,
): SdkBoundaryError {
  return normalizeSdkError(error, { source: 'soroban_rpc', operation });
}

/**
 * Execute an async boundary call and normalize any thrown error into an
 * {@link SdkBoundaryError}.
 */
export async function withNormalizedBoundaryError<T>(
  fn: () => Promise<T>,
  context: NormalizeErrorContext = {},
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw normalizeSdkError(error, context);
  }
}
