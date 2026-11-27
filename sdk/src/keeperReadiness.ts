// Keeper readiness checks: validates RPC reachability/lag and signer configuration
// before a keeper starts submitting transactions.

export const READINESS_STATUS = {
  PASS: 'pass',
  WARN: 'warn',
  FAIL: 'fail',
} as const;

export type ReadinessStatus = (typeof READINESS_STATUS)[keyof typeof READINESS_STATUS];

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  message: string;
}

export interface KeeperReadinessReport {
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface KeeperReadinessOptions {
  /** Expected signer public key (G...). When set, the signer must match it. */
  expectedPublicKey?: string;
  /** Signer public key actually configured for the keeper. */
  signerPublicKey?: string;
  /** Optional RPC URL; when set it must be a valid http(s) URL. */
  rpcUrl?: string;
  /** Optional latest ledger reported by RPC, paired with the local expectation. */
  ledgerLag?: number;
  /** Maximum tolerated ledger lag before failing. Defaults to 10. */
  maxLedgerLag?: number;
}

const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;

function checkRpc(rpcUrl: string | undefined): ReadinessCheck {
  if (rpcUrl === undefined) {
    return { name: 'rpc', status: READINESS_STATUS.FAIL, message: 'RPC URL is not configured' };
  }
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    return { name: 'rpc', status: READINESS_STATUS.FAIL, message: `RPC URL is not a valid URL: ${rpcUrl}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { name: 'rpc', status: READINESS_STATUS.FAIL, message: 'RPC URL must use http or https' };
  }
  return { name: 'rpc', status: READINESS_STATUS.PASS, message: 'RPC URL is configured' };
}

function checkLag(ledgerLag: number | undefined, maxLedgerLag: number): ReadinessCheck {
  if (ledgerLag === undefined) {
    return { name: 'ledgerLag', status: READINESS_STATUS.WARN, message: 'Ledger lag not provided' };
  }
  if (!Number.isFinite(ledgerLag) || ledgerLag < 0) {
    return { name: 'ledgerLag', status: READINESS_STATUS.FAIL, message: `Invalid ledger lag: ${ledgerLag}` };
  }
  if (ledgerLag > maxLedgerLag) {
    return {
      name: 'ledgerLag',
      status: READINESS_STATUS.FAIL,
      message: `Ledger lag ${ledgerLag} exceeds maximum ${maxLedgerLag}`,
    };
  }
  return { name: 'ledgerLag', status: READINESS_STATUS.PASS, message: `Ledger lag ${ledgerLag} is within limit` };
}

function checkSigner(options: KeeperReadinessOptions): ReadinessCheck {
  const { signerPublicKey, expectedPublicKey } = options;
  if (signerPublicKey === undefined || signerPublicKey === '') {
    return { name: 'signer', status: READINESS_STATUS.FAIL, message: 'Signer public key is not configured' };
  }
  if (!STELLAR_PUBLIC_KEY_PATTERN.test(signerPublicKey)) {
    return { name: 'signer', status: READINESS_STATUS.FAIL, message: 'Signer public key is malformed' };
  }
  if (expectedPublicKey !== undefined && signerPublicKey !== expectedPublicKey) {
    return { name: 'signer', status: READINESS_STATUS.FAIL, message: 'Signer does not match expected public key' };
  }
  return { name: 'signer', status: READINESS_STATUS.PASS, message: 'Signer is configured' };
}

/**
 * Runs all keeper readiness checks and aggregates them into a report.
 * The keeper is ready only when no check has status FAIL.
 */
export function checkKeeperReadiness(options: KeeperReadinessOptions = {}): KeeperReadinessReport {
  const maxLedgerLag = options.maxLedgerLag ?? 10;
  const checks: ReadinessCheck[] = [
    checkRpc(options.rpcUrl),
    checkLag(options.ledgerLag, maxLedgerLag),
    checkSigner(options),
  ];
  const ready = checks.every((check) => check.status !== READINESS_STATUS.FAIL);
  return { ready, checks };
}

/** Formats a readiness report as human-readable lines for operators. */
export function formatReadinessReport(report: KeeperReadinessReport): string {
  const header = report.ready ? 'Keeper readiness: READY' : 'Keeper readiness: NOT READY';
  const lines = report.checks.map(
    (check) => `[${check.status.toUpperCase()}] ${check.name}: ${check.message}`,
  );
  return [header, ...lines].join('\n');
}
