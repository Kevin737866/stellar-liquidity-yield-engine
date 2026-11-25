/**
 * Post-deployment smoke checks for critical contract entrypoints (Issue #511).
 *
 * After an `upgrade` + optional `migrate` call, an operator should run these
 * checks before directing live traffic at the updated contracts. Each check
 * calls a **read-only** entrypoint against the Soroban RPC and asserts the
 * response is structurally valid. No tokens are moved and no transactions are
 * submitted.
 *
 * Usage:
 *
 * ```ts
 * import { runSmokeChecks } from './smokeCheck';
 *
 * const results = await runSmokeChecks({
 *   sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: Networks.TESTNET,
 *   contracts: {
 *     yieldEngine:        'C...',
 *     yieldVault:         'C...',
 *     rebalanceEngine:    'C...',
 *     rewardDistributor:  'C...',
 *     strategyRegistry:   'C...',
 *     ilInsurance:        'C...',
 *     actuary:            'C...',
 *   },
 *   expectedStorageVersion: 1,  // must equal upgrade::STORAGE_VERSION
 * });
 *
 * if (!results.passed) {
 *   console.error('Smoke checks failed:', results.failures);
 * }
 * ```
 */

import { Contract, SorobanRpc, TransactionBuilder, Networks, BASE_FEE, Keypair } from 'stellar-sdk';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Contracts that expose `get_storage_version` and `get_admin` / `is_paused`. */
export interface SmokeCheckContracts {
  /** `StellarLiquidityYieldEngine` contract address. */
  yieldEngine?: string;
  /** `YieldVault` contract address. */
  yieldVault?: string;
  /** `RebalanceEngine` contract address. */
  rebalanceEngine?: string;
  /** `MultiRewardDistributor` contract address. */
  rewardDistributor?: string;
  /** `StrategyRegistry` contract address. */
  strategyRegistry?: string;
  /** `ILInsurance` contract address. */
  ilInsurance?: string;
  /** `Actuary` contract address. */
  actuary?: string;
}

/** Configuration for a smoke-check run. */
export interface SmokeCheckOptions {
  /** Soroban RPC endpoint for the target network. */
  sorobanRpcUrl: string;
  /** Network passphrase used to build (unsigned) simulation transactions. */
  networkPassphrase: string;
  /** Contract addresses to probe. Any key that is omitted is skipped. */
  contracts: SmokeCheckContracts;
  /**
   * Expected `STORAGE_VERSION` value from `src/upgrade.rs`.
   * When supplied every probed contract must report this exact version.
   * Omit to skip the version assertion.
   */
  expectedStorageVersion?: number;
  /**
   * Maximum milliseconds to wait for each RPC call.
   * Defaults to 15 000 ms.
   */
  timeoutMs?: number;
}

/** Result of one smoke-check probe. */
export interface SmokeCheckResult {
  /** Human-readable name of the contract / entrypoint pair. */
  label: string;
  /** Contract address that was probed. */
  contractAddress: string;
  /** Whether the probe succeeded. */
  passed: boolean;
  /** Error message when `passed` is false. */
  error?: string;
  /** Raw decoded return value (for logging). */
  returnValue?: unknown;
}

/** Aggregate result of a full smoke-check run. */
export interface SmokeCheckReport {
  /** True only when every individual probe passed. */
  passed: boolean;
  /** All probe results, including passed ones. */
  results: SmokeCheckResult[];
  /** Convenience view of only the failed results. */
  failures: SmokeCheckResult[];
  /** ISO-8601 timestamp of when the run completed. */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Minimal public key used as the simulation source account.
 * The host accepts this well-known account as a fee-source for simulations
 * without requiring it to exist on-chain.
 */
const SIMULATION_SOURCE =
  'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Simulate a single read-only contract call and return the decoded scalar
 * return value, or throw if the simulation fails.
 */
async function simulateReadCall(
  server: SorobanRpc.Server,
  networkPassphrase: string,
  contractAddress: string,
  method: string,
): Promise<unknown> {
  const contract = new Contract(contractAddress);
  const account = await server.getAccount(SIMULATION_SOURCE);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(method))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(
      `simulation error for ${contractAddress}::${method}: ${simResult.error}`,
    );
  }

  if (!simResult.result) {
    throw new Error(
      `no result returned from ${contractAddress}::${method}`,
    );
  }

  return simResult.result.retval;
}

/**
 * Run a single labelled probe and return a `SmokeCheckResult`.
 * Never throws — all errors are caught and surfaced as a failed result.
 */
async function probe(
  label: string,
  contractAddress: string,
  fn: () => Promise<unknown>,
): Promise<SmokeCheckResult> {
  try {
    const returnValue = await fn();
    return { label, contractAddress, passed: true, returnValue };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    return { label, contractAddress, passed: false, error };
  }
}

// ---------------------------------------------------------------------------
// Individual entrypoint probes
// ---------------------------------------------------------------------------

/**
 * Probe `get_storage_version` on `contractAddress`.
 * When `expectedVersion` is supplied the returned value must equal it exactly.
 */
export async function probeStorageVersion(
  server: SorobanRpc.Server,
  networkPassphrase: string,
  contractAddress: string,
  label: string,
  expectedVersion?: number,
): Promise<SmokeCheckResult> {
  return probe(`${label} :: get_storage_version`, contractAddress, async () => {
    const raw = await simulateReadCall(
      server,
      networkPassphrase,
      contractAddress,
      'get_storage_version',
    );

    // The XDR return value from a Soroban `u32` is an scVal map; extract the
    // numeric value from whichever shape the SDK returns.
    const version = extractU32(raw);

    if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
      throw new Error(
        `get_storage_version returned a non-integer value: ${JSON.stringify(raw)}`,
      );
    }

    if (expectedVersion !== undefined && version !== expectedVersion) {
      throw new Error(
        `storage version mismatch: expected ${expectedVersion}, got ${version}`,
      );
    }

    return version;
  });
}

/**
 * Probe `get_admin` (or `is_paused`) on `contractAddress` to confirm the
 * contract is live and answers read calls.
 *
 * Uses `is_paused` as the liveness probe because it is cheaper to decode than
 * an Address XDR and is present on every contract in the crate.
 */
export async function probeLiveness(
  server: SorobanRpc.Server,
  networkPassphrase: string,
  contractAddress: string,
  label: string,
): Promise<SmokeCheckResult> {
  return probe(`${label} :: is_paused`, contractAddress, async () => {
    const raw = await simulateReadCall(
      server,
      networkPassphrase,
      contractAddress,
      'is_paused',
    );
    // We only need the call to succeed — the boolean value is not asserted.
    return raw;
  });
}

// ---------------------------------------------------------------------------
// Aggregate runner
// ---------------------------------------------------------------------------

/**
 * Run post-deployment smoke checks against every configured contract and
 * return a full `SmokeCheckReport`.
 *
 * Each probe calls exactly one read-only Soroban entrypoint (`get_storage_version`
 * and `is_paused`). No write transactions are submitted and no tokens are moved.
 *
 * Failure of one probe does not abort the others: the full set of results is
 * always returned so an operator can see every failing contract in a single run.
 */
export async function runSmokeChecks(options: SmokeCheckOptions): Promise<SmokeCheckReport> {
  const {
    sorobanRpcUrl,
    networkPassphrase,
    contracts,
    expectedStorageVersion,
  } = options;

  const server = new SorobanRpc.Server(sorobanRpcUrl);

  // Map of human label → contract address for every configured contract.
  const knownContracts: Array<[string, string]> = [
    ['YieldEngine',       contracts.yieldEngine],
    ['YieldVault',        contracts.yieldVault],
    ['RebalanceEngine',   contracts.rebalanceEngine],
    ['RewardDistributor', contracts.rewardDistributor],
    ['StrategyRegistry',  contracts.strategyRegistry],
    ['ILInsurance',       contracts.ilInsurance],
    ['Actuary',           contracts.actuary],
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);

  if (knownContracts.length === 0) {
    throw new Error(
      'SmokeCheckOptions.contracts must include at least one contract address.',
    );
  }

  // Run all probes concurrently — a failure in one must not block the others.
  const probePromises: Array<Promise<SmokeCheckResult>> = [];

  for (const [label, address] of knownContracts) {
    probePromises.push(
      probeStorageVersion(server, networkPassphrase, address, label, expectedStorageVersion),
    );
    probePromises.push(
      probeLiveness(server, networkPassphrase, address, label),
    );
  }

  const results = await Promise.all(probePromises);
  const failures = results.filter((r) => !r.passed);

  return {
    passed: failures.length === 0,
    results,
    failures,
    completedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (operator-facing)
// ---------------------------------------------------------------------------

/**
 * Format a `SmokeCheckReport` as a human-readable multi-line string suitable
 * for console output or a CI step summary.
 */
export function formatSmokeCheckReport(report: SmokeCheckReport): string {
  const lines: string[] = [];
  const icon = (passed: boolean) => (passed ? '✓' : '✗');

  lines.push(`Smoke checks completed at ${report.completedAt}`);
  lines.push(`Overall: ${report.passed ? 'PASSED' : 'FAILED'}`);
  lines.push('');

  for (const r of report.results) {
    const suffix = r.passed
      ? `${JSON.stringify(r.returnValue)}`
      : `ERROR: ${r.error}`;
    lines.push(`  ${icon(r.passed)} ${r.label}`);
    lines.push(`    contract: ${r.contractAddress}`);
    lines.push(`    result:   ${suffix}`);
  }

  if (!report.passed) {
    lines.push('');
    lines.push(`${report.failures.length} check(s) failed. Do not direct traffic at these contracts.`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// XDR value extraction utilities
// ---------------------------------------------------------------------------

/**
 * Extract a u32 integer from the raw return value of a Soroban simulation.
 *
 * The stellar-sdk may return XDR values in a few shapes depending on the SDK
 * version and RPC serialisation. This helper handles the most common ones and
 * falls back to a direct cast, so the probe works across SDK versions.
 */
export function extractU32(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);

  // stellar-sdk scVal shapes: { _type: 'scvU32', u32: number }
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if ('u32' in obj && typeof obj['u32'] === 'number') return obj['u32'] as number;
    if ('value' in obj) return extractU32(obj['value']);
    // scValToNative may return a plain number for u32
    if ('_type' in obj && obj['_type'] === 'scvU32' && 'u32' in obj) {
      return Number(obj['u32']);
    }
  }

  // Last resort: try numeric coercion
  const n = Number(raw);
  if (!Number.isNaN(n)) return n;

  throw new Error(`Cannot extract u32 from value: ${JSON.stringify(raw)}`);
}
