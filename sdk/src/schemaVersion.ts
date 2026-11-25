/**
 * Contract storage schema version reporting (Issue #499).
 *
 * Every contract in this crate stores its schema version under the
 * `"storage_version"` instance-storage key (see `src/upgrade.rs`).  The
 * on-chain entrypoint `get_storage_version()` reads that key and returns `0`
 * when the key is absent — which is the case for contracts deployed before
 * schema-version tracking was introduced.
 *
 * This module provides the TypeScript SDK side of that reporting:
 *
 * - {@link ContractKind} — the seven contract roles in this crate.
 * - {@link SchemaVersionReport} — a single contract's version result.
 * - {@link SchemaVersionBatchReport} — results for every contract in a
 *   deployment.
 * - {@link SchemaVersionReporter} — reads versions via the Soroban RPC and
 *   assembles batch reports.
 * - {@link KNOWN_STORAGE_VERSION} — the version the current SDK build expects;
 *   use it to flag contracts whose on-chain version differs from the
 *   compiled-in constant.
 *
 * ## Usage
 *
 * ```ts
 * import { SchemaVersionReporter, KNOWN_STORAGE_VERSION } from './schemaVersion';
 *
 * const reporter = new SchemaVersionReporter(sorobanRpcUrl, networkPassphrase);
 *
 * const report = await reporter.fetchAll({
 *   yieldEngine:        process.env.YIELD_ENGINE_CONTRACT_ID!,
 *   yieldVault:         process.env.YIELD_VAULT_CONTRACT_ID!,
 *   rebalanceEngine:    process.env.REBALANCE_ENGINE_CONTRACT_ID!,
 *   rewardDistributor:  process.env.REWARD_DISTRIBUTOR_CONTRACT_ID!,
 *   strategyRegistry:   process.env.STRATEGY_REGISTRY_CONTRACT_ID!,
 *   ilInsurance:        process.env.IL_INSURANCE_CONTRACT_ID!,
 *   actuary:            process.env.ACTUARY_CONTRACT_ID!,
 * });
 *
 * for (const entry of report.entries) {
 *   if (entry.mismatch) {
 *     console.warn(`${entry.kind}: on-chain=${entry.version}, expected=${KNOWN_STORAGE_VERSION}`);
 *   }
 * }
 * ```
 */

import { SorobanRpc, Contract, Networks, xdr, scValToNative } from 'stellar-sdk';

/**
 * The schema version the current SDK build was compiled against.
 *
 * Mirrors `upgrade::STORAGE_VERSION` in `src/upgrade.rs`.  A deployed contract
 * whose `get_storage_version()` returns a different value either predates
 * schema-version tracking (`0`) or was compiled from a newer build (> 1) and
 * may need migration attention.
 */
export const KNOWN_STORAGE_VERSION = 1;

/**
 * The seven contract roles in this deployment.
 */
export type ContractKind =
  | 'yieldEngine'
  | 'yieldVault'
  | 'rebalanceEngine'
  | 'rewardDistributor'
  | 'strategyRegistry'
  | 'ilInsurance'
  | 'actuary';

/** All contract kinds in a stable order. */
export const CONTRACT_KINDS: ContractKind[] = [
  'yieldEngine',
  'yieldVault',
  'rebalanceEngine',
  'rewardDistributor',
  'strategyRegistry',
  'ilInsurance',
  'actuary',
];

/**
 * A map of contract kind → deployed contract ID.
 *
 * Partial maps are accepted by {@link SchemaVersionReporter.fetchSome}; a full
 * map covering all seven kinds is required by {@link SchemaVersionReporter.fetchAll}.
 */
export type ContractAddressMap = Record<ContractKind, string>;

/**
 * The schema version result for a single contract.
 */
export interface SchemaVersionReport {
  /** The contract's role in the deployment. */
  kind: ContractKind;
  /** The deployed contract's address. */
  contractId: string;
  /**
   * The schema version recorded in the contract's instance storage.
   *
   * `0` means the key is absent — either the contract predates schema-version
   * tracking or `initialize` was not called.  Values greater than
   * {@link KNOWN_STORAGE_VERSION} come from a newer build that this SDK has not
   * been updated to match.
   */
  version: number;
  /**
   * `true` when `version` differs from {@link KNOWN_STORAGE_VERSION}.
   *
   * `false` does **not** mean the contract is healthy; it only means the
   * stored version matches what this SDK build expects.  A version of `0`
   * still sets `mismatch: true`.
   */
  mismatch: boolean;
  /**
   * Human-readable description of the mismatch, or `null` when `version ===
   * {@link KNOWN_STORAGE_VERSION}`.
   */
  mismatchReason: string | null;
  /**
   * The error thrown when the RPC call failed, or `null` on success.
   *
   * When non-null, `version` is `0` and `mismatch` is `true`.
   */
  error: Error | null;
}

/**
 * Schema version results for a set of contracts.
 */
export interface SchemaVersionBatchReport {
  /** Individual result per contract, in {@link CONTRACT_KINDS} order. */
  entries: SchemaVersionReport[];
  /** The number of entries whose `mismatch` is `true`. */
  mismatchCount: number;
  /** `true` when every entry has `mismatch: false`. */
  allMatch: boolean;
  /** Wall-clock time (ms since the epoch) the report was produced. */
  fetchedAt: number;
}

/** Raised when {@link SchemaVersionReporter.fetchAll} detects missing contract IDs. */
export class SchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaVersionError';
  }
}

/**
 * Builds a human-readable mismatch reason for a given version.
 *
 * @internal
 */
function mismatchReason(version: number): string | null {
  if (version === KNOWN_STORAGE_VERSION) return null;
  if (version === 0) {
    return `version 0: contract predates schema-version tracking or was not initialized; run migrate(admin) to advance to ${KNOWN_STORAGE_VERSION}`;
  }
  if (version < KNOWN_STORAGE_VERSION) {
    return `version ${version} is behind expected ${KNOWN_STORAGE_VERSION}; run migrate(admin) after upgrading the contract code`;
  }
  return `version ${version} is ahead of expected ${KNOWN_STORAGE_VERSION}; update the SDK to a build that understands this schema`;
}

/**
 * Reads `get_storage_version()` from one or more deployed contracts via the
 * Soroban RPC.
 *
 * The reporter never submits transactions; every call uses `simulateTransaction`
 * on a read-only invocation, which requires no signing key.
 */
export class SchemaVersionReporter {
  private server: SorobanRpc.Server;
  private networkPassphrase: string;

  constructor(sorobanRpcUrl: string, networkPassphrase: string = Networks.TESTNET) {
    this.server = new SorobanRpc.Server(sorobanRpcUrl);
    this.networkPassphrase = networkPassphrase;
  }

  /**
   * Fetch the schema version for a single contract.
   *
   * Never throws: RPC errors are captured inside the returned report.
   */
  async fetchOne(kind: ContractKind, contractId: string): Promise<SchemaVersionReport> {
    try {
      const version = await this.readStorageVersion(contractId);
      const reason = mismatchReason(version);
      return {
        kind,
        contractId,
        version,
        mismatch: reason !== null,
        mismatchReason: reason,
        error: null,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const reason = `RPC error reading get_storage_version: ${error.message}`;
      return {
        kind,
        contractId,
        version: 0,
        mismatch: true,
        mismatchReason: reason,
        error,
      };
    }
  }

  /**
   * Fetch schema versions for a subset of contracts concurrently.
   *
   * Entries in the result follow {@link CONTRACT_KINDS} order for the kinds
   * that were supplied; kinds absent from `addresses` are omitted.
   */
  async fetchSome(
    addresses: Partial<ContractAddressMap>,
  ): Promise<SchemaVersionBatchReport> {
    const pairs = CONTRACT_KINDS
      .filter((k): k is ContractKind => k in addresses)
      .map((k) => ({ kind: k, contractId: (addresses as ContractAddressMap)[k] }));

    const entries = await Promise.all(
      pairs.map(({ kind, contractId }) => this.fetchOne(kind, contractId)),
    );

    return buildBatchReport(entries);
  }

  /**
   * Fetch schema versions for all seven contracts.
   *
   * @throws {SchemaVersionError} when any contract ID in `addresses` is empty
   *   or missing, so the caller gets a clear error rather than a silent
   *   RPC failure on an unusable address.
   */
  async fetchAll(addresses: ContractAddressMap): Promise<SchemaVersionBatchReport> {
    for (const kind of CONTRACT_KINDS) {
      const id = addresses[kind];
      if (!id || id.trim() === '') {
        throw new SchemaVersionError(
          `Missing contract address for '${kind}'; supply all seven addresses to fetchAll()`,
        );
      }
    }
    return this.fetchSome(addresses);
  }

  /**
   * Simulate a `get_storage_version()` call and extract the returned `u32`.
   *
   * @internal
   */
  private async readStorageVersion(contractId: string): Promise<number> {
    const contract = new Contract(contractId);
    const operation = contract.call('get_storage_version');

    // Build a minimal transaction envelope for simulation. No source account
    // is needed for a read-only simulate; we use a well-known funded testnet
    // account as a placeholder. On mainnet the placeholder is not funded, but
    // simulation only needs the envelope to be structurally valid.
    const { TransactionBuilder, Account, BASE_FEE } = await import('stellar-sdk');
    const dummyAccount = new Account(
      'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      '0',
    );

    const tx = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);

    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new Error(result.error);
    }
    if (!SorobanRpc.Api.isSimulationSuccess(result)) {
      throw new Error('Unexpected simulation response type');
    }

    const returnVal = result.result?.retval;
    if (!returnVal) {
      throw new Error('Simulation returned no value');
    }

    const native = scValToNative(returnVal);
    if (typeof native !== 'number' && typeof native !== 'bigint') {
      throw new Error(`Unexpected return type from get_storage_version: ${typeof native}`);
    }

    return Number(native);
  }
}

/** @internal */
function buildBatchReport(entries: SchemaVersionReport[]): SchemaVersionBatchReport {
  const mismatchCount = entries.filter((e) => e.mismatch).length;
  return {
    entries,
    mismatchCount,
    allMatch: mismatchCount === 0,
    fetchedAt: Date.now(),
  };
}
