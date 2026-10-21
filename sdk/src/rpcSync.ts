/**
 * RPC synchronization lag detection.
 *
 * A keeper acts on ledger state, so when the RPC node it reads from is behind
 * the network head those decisions are made on stale data. This module
 * measures the gap between the newest ledger the process has observed and the
 * ledger head the node reports, and classifies it so operators can be warned
 * before staleness affects keeper decisions.
 */

/** Stellar closes a ledger roughly every 5 seconds. */
export const LEDGER_CLOSE_TIME_SECONDS = 5;

/** Lag in ledgers at or above which a node is considered a warning. */
export const DEFAULT_WARNING_LEDGERS = 5;

/** Lag in ledgers at or above which a node is considered critical. */
export const DEFAULT_CRITICAL_LEDGERS = 20;

export type LagSeverity = 'ok' | 'warning' | 'critical';

/**
 * The slice of the Soroban RPC server this module needs. Declaring it
 * structurally keeps the lag check testable without a network: `SorobanRpc.Server`
 * satisfies it, and so does a stub in a test.
 */
export interface LedgerHeadSource {
  getLatestLedger(): Promise<{ sequence: number }>;
}

export interface RpcLagThresholds {
  /** Lag in ledgers at or above which the node is a warning. Default 5. */
  warningLedgers?: number;
  /** Lag in ledgers at or above which the node is critical. Default 20. */
  criticalLedgers?: number;
}

export interface RpcLagOptions extends RpcLagThresholds {
  /** Ledger close time used to estimate wall-clock lag, in seconds. Default 5. */
  ledgerCloseTimeSeconds?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RpcLagReport {
  /** Highest ledger this process has processed locally. */
  processedLedger: number;
  /** Ledger head reported by the RPC node. */
  headLedger: number;
  /** `headLedger - processedLedger`, clamped at zero. */
  lagLedgers: number;
  /** Estimated wall-clock lag, derived from the ledger close time. */
  lagSeconds: number;
  severity: LagSeverity;
  /** Human-readable summary, suitable for logs and alerts. */
  message: string;
  /** When the check ran, in milliseconds since the epoch. */
  checkedAt: number;
}

/**
 * Ledgers the node's head is ahead of the last locally processed ledger.
 *
 * Clamped at zero: a head behind the local ledger means the process is already
 * current (or ahead of a lagging read replica), which is not staleness.
 */
export function computeLedgerLag(processedLedger: number, headLedger: number): number {
  if (!Number.isFinite(processedLedger) || !Number.isFinite(headLedger)) {
    throw new Error('ledger sequences must be finite numbers');
  }
  return Math.max(0, Math.floor(headLedger) - Math.floor(processedLedger));
}

/** Classify a ledger lag against the configured thresholds. */
export function classifyLag(lagLedgers: number, thresholds: RpcLagThresholds = {}): LagSeverity {
  const warning = thresholds.warningLedgers ?? DEFAULT_WARNING_LEDGERS;
  const critical = thresholds.criticalLedgers ?? DEFAULT_CRITICAL_LEDGERS;

  if (warning < 0 || critical < 0) {
    throw new Error('lag thresholds must be non-negative');
  }
  if (critical < warning) {
    throw new Error('criticalLedgers must be greater than or equal to warningLedgers');
  }

  if (lagLedgers >= critical) {
    return 'critical';
  }
  if (lagLedgers >= warning) {
    return 'warning';
  }
  return 'ok';
}

/** Build the human-readable summary for a report. */
export function formatLagMessage(report: Omit<RpcLagReport, 'message'>): string {
  const { processedLedger, headLedger, lagLedgers, lagSeconds, severity } = report;
  const base =
    `RPC node head is ${lagLedgers} ledger(s) (~${lagSeconds}s) ahead of the ` +
    `last processed ledger (processed=${processedLedger}, head=${headLedger})`;

  if (severity === 'ok') {
    return `${base}; within tolerance`;
  }
  if (severity === 'warning') {
    return `${base}; node is noticeably behind`;
  }
  return `${base}; node is critically behind, keeper decisions may be stale`;
}

/** Measure the lag between a locally processed ledger and the node's head. */
export async function checkRpcLag(
  source: LedgerHeadSource,
  processedLedger: number,
  options: RpcLagOptions = {},
): Promise<RpcLagReport> {
  const now = options.now ?? Date.now;
  const head = await source.getLatestLedger();
  const headLedger = head.sequence;
  const lagLedgers = computeLedgerLag(processedLedger, headLedger);
  const severity = classifyLag(lagLedgers, options);
  const lagSeconds = lagLedgers * (options.ledgerCloseTimeSeconds ?? LEDGER_CLOSE_TIME_SECONDS);

  const report: Omit<RpcLagReport, 'message'> = {
    processedLedger,
    headLedger,
    lagLedgers,
    lagSeconds,
    severity,
    checkedAt: now(),
  };

  return { ...report, message: formatLagMessage(report) };
}

export type RpcLagWarnHandler = (report: RpcLagReport) => void;

/**
 * Health metrics for a keeper's RPC synchronization loop, suitable for
 * exposing to ops tooling (Prometheus, logs, health endpoints).
 */
export interface KeeperHealthMetrics {
  /** When the last successful run completed, in ms since the epoch (0 if none). */
  lastSuccessfulRunMs: number;
  /** Total number of failed runs observed. */
  errorCount: number;
  /** Number of items currently waiting to be processed. */
  queueDepth: number;
  /** Severity of the most recent lag check, if one has run. */
  lastSeverity?: LagSeverity;
}

/**
 * Collects keeper health signals (last successful run, error count, queue
 * depth) so they can be emitted to monitoring. All methods are cheap and
 * synchronous, making this safe to call from hot paths.
 */
export class KeeperHealthTracker {
  private lastSuccessfulRunMs = 0;
  private errorCount = 0;
  private queueDepth = 0;
  private lastSeverity?: LagSeverity;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Record a successful run, stamping the current time. */
  recordSuccess(): void {
    this.lastSuccessfulRunMs = this.now();
  }

  /** Record a failed run. */
  recordError(): void {
    this.errorCount += 1;
  }

  /** Set the current queue depth (clamped at zero). */
  setQueueDepth(depth: number): void {
    if (!Number.isFinite(depth)) {
      throw new Error('queue depth must be a finite number');
    }
    this.queueDepth = Math.max(0, Math.floor(depth));
  }

  /** Record the severity from a lag check. */
  recordSeverity(severity: LagSeverity): void {
    this.lastSeverity = severity;
  }

  /** Snapshot the current health metrics. */
  getMetrics(): KeeperHealthMetrics {
    const metrics: KeeperHealthMetrics = {
      lastSuccessfulRunMs: this.lastSuccessfulRunMs,
      errorCount: this.errorCount,
      queueDepth: this.queueDepth,
    };
    if (this.lastSeverity !== undefined) {
      metrics.lastSeverity = this.lastSeverity;
    }
    return metrics;
  }
}

function defaultWarnHandler(report: RpcLagReport): void {
  // eslint-disable-next-line no-console
  console.warn(`[rpc-lag] ${report.message}`);
}

/**
 * Tracks the highest ledger this process has processed and warns when the RPC
 * node's head has moved far enough ahead that keeper decisions risk staleness.
 */
export class RpcLagMonitor {
  private readonly source: LedgerHeadSource;
  private readonly options: RpcLagOptions;
  private readonly onWarn: RpcLagWarnHandler;
  private processedLedger = 0;

  constructor(
    source: LedgerHeadSource,
    options: RpcLagOptions = {},
    onWarn: RpcLagWarnHandler = defaultWarnHandler,
  ) {
    this.source = source;
    this.options = options;
    this.onWarn = onWarn;
  }

  /** Record a locally processed ledger. Never moves the marker backwards. */
  recordProcessedLedger(sequence: number): void {
    if (!Number.isFinite(sequence)) {
      throw new Error('ledger sequence must be a finite number');
    }
    if (sequence > this.processedLedger) {
      this.processedLedger = sequence;
    }
  }

  /** The highest ledger recorded so far (0 before anything is processed). */
  getProcessedLedger(): number {
    return this.processedLedger;
  }

  /** Check the node's head against the locally processed ledger. */
  async check(): Promise<RpcLagReport> {
    const report = await checkRpcLag(this.source, this.processedLedger, this.options);
    if (report.severity !== 'ok') {
      this.onWarn(report);
    }
    return report;
  }

  /**
   * Run a check and feed the outcome into a health tracker: a successful check
   * stamps the last-successful-run time and records severity, while a thrown
   * error increments the error count before being re-thrown.
   */
  async checkWithHealth(tracker: KeeperHealthTracker): Promise<RpcLagReport> {
    try {
      const report = await this.check();
      tracker.recordSuccess();
      tracker.recordSeverity(report.severity);
      return report;
    } catch (err) {
      tracker.recordError();
      throw err;
    }
  }
}
