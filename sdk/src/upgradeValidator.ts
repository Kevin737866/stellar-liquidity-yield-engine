// Staged contract upgrade validation (issue #501).
//
// Runs the pre-flight checks from `docs/UPGRADING.md` as ordered stages and
// stops at the first stage that fails, so an operator never swaps code that
// cannot be reversed. The tool is pure: callers read the on-chain facts
// (storage version, stored admin, installed hashes) and pass them in, which
// keeps it testable and usable from any keeper script.
//
// Stages, in order:
//  1. inputs     - both wasm hashes are well formed and differ
//  2. admin      - the signing key is the contract's stored admin
//  3. version    - the recorded storage version is readable and not newer than the build
//  4. migration  - a reversible migration, or an explicit acknowledgement that it is not
//  5. rollback   - the previous and new wasm hashes are installed on the network

export type UpgradeStage = 'inputs' | 'admin' | 'version' | 'migration' | 'rollback';

export const UPGRADE_STAGES: readonly UpgradeStage[] = [
  'inputs',
  'admin',
  'version',
  'migration',
  'rollback',
];

export interface UpgradeValidationInput {
  // Hash of the wasm currently live (the rollback target).
  oldWasmHash: string;
  // Hash of the wasm about to be installed.
  newWasmHash: string;
  // Address of the key that will sign `upgrade`.
  signerAddress: string;
  // Admin address read from the contract.
  storedAdmin: string | null | undefined;
  // `get_storage_version()` of the live contract; null when it could not be read.
  currentStorageVersion: number | null | undefined;
  // `STORAGE_VERSION` of the build being installed.
  targetStorageVersion: number;
  // Whether `migrate` for this release can be undone by the old code.
  migrationReversible: boolean;
  // Hashes known to be installed on the target network.
  installedWasmHashes: readonly string[];
  // Operator accepts that this release cannot be rolled back in place (Flow B).
  acceptIrreversible?: boolean;
}

export interface StageResult {
  stage: UpgradeStage;
  passed: boolean;
  message: string;
}

export interface UpgradeValidationReport {
  // True only when every stage ran and passed.
  ok: boolean;
  // Stage that stopped the run, if any.
  failedStage?: UpgradeStage;
  // Stages that ran, in order; later stages are not evaluated after a failure.
  results: StageResult[];
  // True when the storage version has to move forward via `migrate`.
  migrationRequired: boolean;
}

const WASM_HASH = /^[0-9a-fA-F]{64}$/;

const normalize = (hash: string): string => hash.trim().toLowerCase();

type StageCheck = (input: UpgradeValidationInput) => { passed: boolean; message: string };

const CHECKS: Record<UpgradeStage, StageCheck> = {
  inputs: (i) => {
    if (!WASM_HASH.test(i.oldWasmHash ?? '')) {
      return { passed: false, message: 'oldWasmHash is missing or is not a 64-character hex hash' };
    }
    if (!WASM_HASH.test(i.newWasmHash ?? '')) {
      return { passed: false, message: 'newWasmHash is missing or is not a 64-character hex hash' };
    }
    if (normalize(i.oldWasmHash) === normalize(i.newWasmHash)) {
      return { passed: false, message: 'old and new wasm hashes are identical, nothing to upgrade' };
    }
    return { passed: true, message: 'wasm hashes are well formed and differ' };
  },

  admin: (i) => {
    if (!i.storedAdmin) {
      return { passed: false, message: 'the contract admin could not be read' };
    }
    if (!i.signerAddress) {
      return { passed: false, message: 'the signing key is not available' };
    }
    if (i.signerAddress !== i.storedAdmin) {
      return {
        passed: false,
        message: 'the signing key is not the stored admin, upgrade would be rejected',
      };
    }
    return { passed: true, message: 'signer matches the stored admin' };
  },

  version: (i) => {
    const current = i.currentStorageVersion;
    if (current === null || current === undefined || !Number.isInteger(current) || current < 0) {
      return { passed: false, message: 'the current storage version could not be read' };
    }
    if (!Number.isInteger(i.targetStorageVersion) || i.targetStorageVersion < 0) {
      return { passed: false, message: 'the target storage version is invalid' };
    }
    if (current > i.targetStorageVersion) {
      return {
        passed: false,
        message: `stored version ${current} is newer than the target build's ${i.targetStorageVersion}; this would be a downgrade`,
      };
    }
    return {
      passed: true,
      message:
        current === i.targetStorageVersion
          ? `storage version ${current} already matches the target, no migrate needed`
          : `storage version ${current} will move to ${i.targetStorageVersion} via migrate`,
    };
  },

  migration: (i) => {
    const needsMigration = (i.currentStorageVersion ?? 0) < i.targetStorageVersion;
    if (!needsMigration || i.migrationReversible) {
      return { passed: true, message: 'no irreversible migration involved' };
    }
    if (i.acceptIrreversible) {
      return {
        passed: true,
        message: 'irreversible migration explicitly acknowledged; rollback needs Flow B',
      };
    }
    return {
      passed: false,
      message: 'migration is not reversible; acknowledge it explicitly or use the re-deploy flow',
    };
  },

  rollback: (i) => {
    const installed = new Set(i.installedWasmHashes.map(normalize));
    if (!installed.has(normalize(i.oldWasmHash))) {
      return {
        passed: false,
        message: 'the previous wasm hash is not installed on the network, a rollback would fail',
      };
    }
    if (!installed.has(normalize(i.newWasmHash))) {
      return {
        passed: false,
        message: 'the new wasm hash is not installed on the network, upgrade would revert',
      };
    }
    return { passed: true, message: 'both the rollback and the new wasm are installed' };
  },
};

// Run every stage in order and stop at the first failure.
export function validateUpgrade(input: UpgradeValidationInput): UpgradeValidationReport {
  const results: StageResult[] = [];
  const migrationRequired =
    typeof input.currentStorageVersion === 'number' &&
    input.currentStorageVersion < input.targetStorageVersion;

  for (const stage of UPGRADE_STAGES) {
    const outcome = CHECKS[stage](input);
    results.push({ stage, ...outcome });
    if (!outcome.passed) {
      return { ok: false, failedStage: stage, results, migrationRequired };
    }
  }
  return { ok: true, results, migrationRequired };
}

// One line per stage, for logs and CLI output.
export function formatUpgradeReport(report: UpgradeValidationReport): string {
  const lines = report.results.map((r) => `${r.passed ? 'PASS' : 'FAIL'} ${r.stage}: ${r.message}`);
  lines.push(
    report.ok ? 'READY: safe to upgrade' : `BLOCKED at stage "${report.failedStage}": do not upgrade`,
  );
  return lines.join('\n');
}
