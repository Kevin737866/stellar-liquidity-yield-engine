/**
 * Staged validation for contract upgrades.
 *
 * A Soroban upgrade is a single host call, but it is not a single decision.
 * Before the production contract's code is replaced, an operator has to be able
 * to answer: is the wasm installed, did the invocation simulate, has this exact
 * wasm already run against a non-production copy of the contract with the same
 * storage, are the required approvals collected, and — after promotion — does
 * the live contract report the target schema and answer its entrypoints?
 *
 * `docs/STAGED_UPGRADE_VALIDATION.md` is the operator procedure. This module is
 * its machine-checkable part: {@link planStagedUpgrade} takes the evidence
 * gathered so far and returns the seven stages of the upgrade with each one
 * marked `complete`, `ready`, `pending`, `blocked` or `skipped`, the single
 * stage that can run next, and every reason promotion is not allowed yet.
 *
 * ```ts
 * const plan = planStagedUpgrade({
 *   wasmHash: NEW_WASM_HASH,
 *   previousWasmHash: LIVE_WASM_HASH,
 *   adminKeyAvailable: true,
 *   wasmInstalled: true,
 *   simulationPassed: true,
 *   liveStorageVersion: 1,
 *   targetStorageVersion: 2,
 *   migrationRequired: true,
 *   migrationIdempotent: true,
 *   stagingContractId: STAGING_CONTRACT_ID,
 *   stagingVerified: true,
 *   smokeChecksPassed: true,
 *   snapshotTaken: true,
 *   rollbackPlan: 'Re-install and upgrade back to the previous hash; restore the snapshot.',
 *   production: true,
 * });
 *
 * plan.canPromote; // true — every pre-promotion stage is complete
 * plan.nextStage;  // 'promote'
 * ```
 *
 * The planner never signs, installs or upgrades anything: it validates evidence
 * an operator or CI job has already collected, so a gate cannot be passed by
 * claiming it in a different order.
 */

/** The ordered stages of a validated upgrade. */
export type StagedUpgradeStageId =
  /** Static checks: hash format, versions, snapshot, rollback, approvals policy. */
  | 'preflight'
  /** `contract install` of the new wasm; nothing on-chain changes. */
  | 'install'
  /** `simulateTransaction` of the upgrade invocation. */
  | 'simulate'
  /** The same wasm upgraded on a non-production contract, then smoke-checked. */
  | 'staging'
  /** The production `upgrade` invocation. */
  | 'promote'
  /** Live code and schema verified; migration completed when required. */
  | 'verify'
  /** Keepers resumed from their checkpoints and monitoring confirmed. */
  | 'closeout';

/** Where a stage stands given the evidence supplied. */
export type StagedUpgradeStageStatus =
  /** Exit criteria met. */
  | 'complete'
  /** Prerequisites met; this is the stage to run now. */
  | 'ready'
  /** Prerequisites are not met yet. */
  | 'pending'
  /** A condition makes running this stage unsafe. */
  | 'blocked'
  /** Deliberately not required (staging, for a non-production contract). */
  | 'skipped';

/**
 * Evidence collected so far. Every field is optional: the planner treats
 * missing evidence as "not done", never as "fine".
 */
export interface StagedUpgradeEvidence {
  /** Contract being upgraded, for reporting. */
  contractId?: string;
  /** Whether the target contract is production. Defaults to `false`. */
  production?: boolean;
  /** Wasm hash returned by `contract install` for the new build. */
  wasmHash?: string;
  /** Wasm hash the live contract runs today; the rollback target. */
  previousWasmHash?: string;
  /** Whether the admin key can sign `install`/`upgrade` (present, funded, sequence known). */
  adminKeyAvailable?: boolean;
  /** Whether the new wasm is installed on the network. */
  wasmInstalled?: boolean;
  /** `get_storage_version()` of the contract being upgraded. */
  liveStorageVersion?: number;
  /** `STORAGE_VERSION` of the build that contains `wasmHash`. */
  targetStorageVersion?: number;
  /** Whether the change alters stored shapes (needs `migrate`). */
  migrationRequired?: boolean;
  /** Whether the migration work is safe to re-run. */
  migrationIdempotent?: boolean;
  /** Whether `simulateTransaction` for the upgrade invocation succeeded. */
  simulationPassed?: boolean;
  /** A non-production contract address that received the same wasm. */
  stagingContractId?: string;
  /** The staging contract answered on the new code and stored the target schema. */
  stagingVerified?: boolean;
  /** Read/write smoke checks passed on the staging contract. */
  smokeChecksPassed?: boolean;
  /** Pre-change state (values and the stored entries the change affects) captured. */
  snapshotTaken?: boolean;
  /** What to do if promotion must be undone. */
  rollbackPlan?: string;
  /** Approvals collected for the promotion. Defaults to `0`. */
  approvals?: number;
  /** Approvals required. Defaults to 2 for production, 1 otherwise. */
  requiredApprovals?: number;
  /** Whether the production `upgrade` transaction landed. */
  promoted?: boolean;
  /** Whether the live contract was re-read after promotion (version + entrypoints). */
  postUpgradeVerified?: boolean;
  /** Whether `migrate` ran and the stored version equals the target. */
  migrationCompleted?: boolean;
  /** Whether keepers were resumed from their checkpoints after verification. */
  keepersResumed?: boolean;
}

/** One stage of the plan. */
export interface StagedUpgradeStage {
  id: StagedUpgradeStageId;
  title: string;
  status: StagedUpgradeStageStatus;
  /** Whether the stage needs the admin key to sign. */
  requiresAdmin: boolean;
  /** What to run or check in this stage. */
  checks: string[];
  /** What makes the stage complete. */
  exitCriteria: string;
  /** Why the stage cannot run, when it is blocked. */
  blockers: string[];
}

/** The plan for one staged upgrade. */
export interface StagedUpgradePlan {
  contract: string;
  production: boolean;
  fromStorageVersion: number;
  targetStorageVersion: number;
  stages: StagedUpgradeStage[];
  /** First stage that is not complete or deliberately skipped, or `null` when done. */
  nextStage: StagedUpgradeStageId | null;
  /** True only when the promotion stage is `ready` right now. */
  canPromote: boolean;
  /** Whether `migrate` must run after promotion. */
  migrationRequired: boolean;
  approvals: { collected: number; required: number };
  /** Every blocker in the plan, deduplicated, in stage order. */
  blockers: string[];
  /** Safe but easy to get wrong. */
  warnings: string[];
}

/** Soroban wasm hashes are 32 bytes, rendered as 64 hex characters. */
export const WASM_HASH_PATTERN = /^[0-9A-Fa-f]{64}$/;

/**
 * Build the staged plan for an upgrade from the evidence gathered so far.
 *
 * Never throws: an unusable evidence field becomes a blocker, because a CI job
 * or an on-call script needs the reason in the plan, not an exception.
 */
export function planStagedUpgrade(evidence: StagedUpgradeEvidence): StagedUpgradePlan {
  const production = evidence?.production === true;
  const contract =
    typeof evidence?.contractId === 'string' && evidence.contractId.trim().length > 0
      ? evidence.contractId
      : '(unnamed contract)';
  const liveStorageVersion = readVersion(evidence?.liveStorageVersion);
  const targetStorageVersion = readVersion(evidence?.targetStorageVersion);

  const approvals =
    evidence?.approvals === undefined ? 0 : readCount(evidence.approvals);
  const requiredApprovals = readCount(
    evidence?.requiredApprovals === undefined
      ? production
        ? 2
        : 1
      : evidence.requiredApprovals,
  );

  const warnings: string[] = [];
  const preflightBlockers: string[] = [];

  // ---- preflight ----
  const wasmHash = typeof evidence?.wasmHash === 'string' ? evidence.wasmHash.trim() : '';
  if (wasmHash.length === 0) {
    preflightBlockers.push(
      'no target wasm hash: run `contract install --wasm <new build>` and record the hash it prints',
    );
  } else if (!WASM_HASH_PATTERN.test(wasmHash)) {
    preflightBlockers.push(
      `the target wasm hash must be 32 bytes of hex (64 characters); received ${wasmHash.length} character(s)`,
    );
  }

  const previousWasmHash =
    typeof evidence?.previousWasmHash === 'string' ? evidence.previousWasmHash.trim() : '';
  if (previousWasmHash.length === 0) {
    const message =
      'no previous wasm hash: keep the hash the live contract runs, it is the only rollback target';
    if (production) preflightBlockers.push(message);
    else warnings.push(message);
  } else if (!WASM_HASH_PATTERN.test(previousWasmHash)) {
    preflightBlockers.push('the previous wasm hash must be 32 bytes of hex (64 characters)');
  } else if (previousWasmHash.toLowerCase() === wasmHash.toLowerCase()) {
    preflightBlockers.push(
      'the previous and target wasm hashes are the same: there is no new code to promote',
    );
  }

  if (evidence?.adminKeyAvailable !== true) {
    preflightBlockers.push(
      'the admin key is not available: `install`, `upgrade` and `migrate` are admin-only',
    );
  }

  if (liveStorageVersion === null) {
    preflightBlockers.push(
      'the live schema version is missing: read `get_storage_version()` before choosing the target build',
    );
  }
  if (targetStorageVersion === null) {
    preflightBlockers.push(
      'the target schema version is missing: it is `STORAGE_VERSION` in src/upgrade.rs for the build being installed',
    );
  }
  if (liveStorageVersion !== null && targetStorageVersion !== null) {
    if (targetStorageVersion < liveStorageVersion) {
      preflightBlockers.push(
        `the target schema version ${targetStorageVersion} is older than the live one ${liveStorageVersion}: ` +
          'migrations only move forward, restore the snapshot instead of downgrading in place',
      );
    } else if (targetStorageVersion === liveStorageVersion) {
      if (evidence?.migrationRequired === true) {
        preflightBlockers.push(
          `the target schema version equals the live one (${liveStorageVersion}) but the change needs a migration: ` +
            'bump STORAGE_VERSION in the same change or drop the migration step',
        );
      } else {
        warnings.push(
          `code-only upgrade: the schema stays at ${liveStorageVersion}, so no migrate call is needed`,
        );
      }
    }
  }
  if (evidence?.migrationRequired === true && evidence?.migrationIdempotent !== true) {
    preflightBlockers.push(
      'the migration is not declared idempotent: `migrate` is retried after timeouts, so replaying it must not apply work twice',
    );
  }

  if (evidence?.snapshotTaken !== true) {
    preflightBlockers.push(
      'no pre-change snapshot: capture the getters and the stored entries the change touches before promoting',
    );
  }
  if (typeof evidence?.rollbackPlan !== 'string' || evidence.rollbackPlan.trim().length === 0) {
    preflightBlockers.push(
      'no rollback plan: state the wasm hash and stored data to restore if promotion must be undone',
    );
  }

  if (approvals === null) {
    preflightBlockers.push('approvals must be a non-negative integer');
  }
  if (requiredApprovals === null || requiredApprovals === 0) {
    preflightBlockers.push(
      'requiredApprovals must be a positive integer (production defaults to 2, other environments to 1)',
    );
  }

  const stagingContractId =
    typeof evidence?.stagingContractId === 'string' ? evidence.stagingContractId.trim() : '';
  const stagingIsProductionAddress =
    stagingContractId.length > 0 &&
    typeof evidence?.contractId === 'string' &&
    stagingContractId === evidence.contractId;

  const stagingBlockers: string[] = [];
  if (stagingIsProductionAddress) {
    stagingBlockers.push(
      'the staging contract id is the contract being upgraded: staging must be a separate address',
    );
  }

  const preflightComplete = preflightBlockers.length === 0;
  const installComplete = evidence?.wasmInstalled === true;
  const simulateComplete = installComplete && evidence?.simulationPassed === true;
  const stagingSkipped = !production;
  const stagingComplete = stagingCompleteCheck(evidence, stagingContractId, production);

  const collected = approvals ?? 0;
  const promotionPrerequisites =
    preflightComplete &&
    simulateComplete &&
    stagingBlockers.length === 0 &&
    (stagingSkipped || stagingComplete);

  const promotionBlockers: string[] = [];
  if (!promotionPrerequisites && evidence?.promoted === true) {
    promotionBlockers.push(
      'the upgrade is recorded as promoted but its prerequisites are not complete: stop, verify the live code and storage, and treat this as an incident',
    );
  } else if (promotionPrerequisites && collected < (requiredApprovals ?? 0)) {
    promotionBlockers.push(
      `promotion needs ${requiredApprovals} approval(s); ${collected} collected`,
    );
  }

  const promoted = evidence?.promoted === true;
  const verifyBlockers: string[] = [];
  if (promoted && evidence?.postUpgradeVerified === true && evidence?.migrationRequired === true && evidence?.migrationCompleted !== true) {
    verifyBlockers.push(
      'the new code is live and answers, but the stored schema was not migrated: keep user flows frozen and call `migrate(admin)` before resuming',
    );
  }

  const verifyComplete =
    promoted &&
    evidence?.postUpgradeVerified === true &&
    (evidence?.migrationRequired !== true || evidence?.migrationCompleted === true);
  const closeoutComplete = verifyComplete && evidence?.keepersResumed === true;

  if (evidence?.keepersResumed === true && !verifyComplete) {
    warnings.push(
      'keepers were resumed before post-upgrade verification: they may read a half-migrated contract, so re-check their first ticks',
    );
  }

  const stages: StagedUpgradeStage[] = [
    {
      id: 'preflight',
      title: 'Preflight: hashes, versions, snapshot, rollback',
      status: preflightComplete ? 'complete' : 'blocked',
      requiresAdmin: false,
      checks: [
        'read `get_storage_version()` on the live contract',
        'read `STORAGE_VERSION` from the build that produced the new wasm',
        'keep the previous wasm hash (the rollback target)',
        'capture the pre-change snapshot and write the rollback plan',
      ],
      exitCriteria: 'hashes are well-formed, versions are forward-only, snapshot and rollback plan exist',
      blockers: preflightBlockers,
    },
    {
      id: 'install',
      title: 'Install the new wasm',
      status: installComplete ? 'complete' : preflightComplete ? 'ready' : 'pending',
      requiresAdmin: true,
      checks: ['`contract install --wasm <new build> --source <admin>`', 'record the hash the CLI prints'],
      exitCriteria: 'the wasm is installed and its hash matches the reviewed build',
      blockers: [],
    },
    {
      id: 'simulate',
      title: 'Simulate the upgrade invocation',
      status: simulateComplete ? 'complete' : installComplete ? 'ready' : 'pending',
      requiresAdmin: true,
      checks: [
        'build `upgrade(admin, new_wasm_hash)` and run `simulateTransaction`',
        'confirm the simulation succeeds and its footprint is plausible',
      ],
      exitCriteria: 'simulation succeeds against the live contract',
      blockers: [],
    },
    {
      id: 'staging',
      title: 'Upgrade and smoke-check a staging contract',
      status: stagingBlockers.length > 0
        ? 'blocked'
        : stagingSkipped
          ? 'skipped'
          : simulateComplete && stagingComplete
            ? 'complete'
            : simulateComplete
              ? 'ready'
              : 'pending',
      requiresAdmin: true,
      checks: [
        'upgrade a non-production contract that holds a copy of the live storage',
        'read `get_storage_version()` and call `migrate(admin)` there',
        'run the read/write smoke checks (positions, fees, admin getters)',
      ],
      exitCriteria: 'the staging contract answers on the new code and stores the target schema',
      blockers: stagingBlockers,
    },
    {
      id: 'promote',
      title: 'Promote to the target contract',
      status: promoted
        ? promotionBlockers.length > 0
          ? 'blocked'
          : 'complete'
        : promotionBlockers.length > 0
          ? 'blocked'
          : promotionPrerequisites
            ? 'ready'
            : 'pending',
      requiresAdmin: true,
      checks: [
        'confirm the approvals recorded in the plan are collected',
        'submit `upgrade(admin, new_wasm_hash)` from the admin key',
        'remember the swap takes effect on the next invocation',
      ],
      exitCriteria: 'the production upgrade transaction is included in a ledger',
      blockers: promotionBlockers,
    },
    {
      id: 'verify',
      title: 'Verify the live code and schema',
      status: verifyBlockers.length > 0
        ? 'blocked'
        : verifyComplete
          ? 'complete'
          : promoted
            ? 'ready'
            : 'pending',
      requiresAdmin: false,
      checks: [
        're-read `get_storage_version()` and compare it with the target',
        'call each entrypoint group once (read and one small write on staging/mainnet as policy allows)',
        'confirm the `contract_upgraded` event carries the expected hash',
      ],
      exitCriteria: 'the live contract runs the new code and reports the target schema',
      blockers: verifyBlockers,
    },
    {
      id: 'closeout',
      title: 'Close out: resume keepers and watch',
      status: closeoutComplete ? 'complete' : verifyComplete ? 'ready' : 'pending',
      requiresAdmin: false,
      checks: [
        'restart keepers from their checkpoints (docs/KEEPER_RECOVERY.md)',
        'watch the first ticks for duplicated or skipped work',
        'keep the snapshot and rollback plan until the next review',
      ],
      exitCriteria: 'keepers are running on the new schema without replaying or dropping work',
      blockers: [],
    },
  ];

  const blockers = dedupe(stages.flatMap((stage) => stage.blockers));
  const nextStage =
    stages.find((stage) => stage.status !== 'complete' && stage.status !== 'skipped')?.id ?? null;

  return {
    contract,
    production,
    fromStorageVersion: liveStorageVersion ?? Number.NaN,
    targetStorageVersion: targetStorageVersion ?? Number.NaN,
    stages,
    nextStage,
    canPromote: stages.find((stage) => stage.id === 'promote')?.status === 'ready',
    migrationRequired: evidence?.migrationRequired === true,
    approvals: { collected, required: requiredApprovals ?? 0 },
    blockers,
    warnings,
  };
}

/**
 * Throw when the evidence does not support promotion, for CI use.
 *
 * ```ts
 * assertStagedUpgradeReady(evidence); // fails the job if a gate is unmet
 * ```
 */
export function assertStagedUpgradeReady(evidence: StagedUpgradeEvidence): StagedUpgradePlan {
  const plan = planStagedUpgrade(evidence);
  if (!plan.canPromote) {
    throw new StagedUpgradeValidationError(plan);
  }
  return plan;
}

/** Raised by {@link assertStagedUpgradeReady}; the message lists the blockers. */
export class StagedUpgradeValidationError extends Error {
  readonly plan: StagedUpgradePlan;

  constructor(plan: StagedUpgradePlan) {
    const stage = plan.stages.find((candidate) => candidate.status === 'blocked');
    super(
      `staged upgrade for ${plan.contract} is not ready to promote` +
        (stage ? ` (blocked at ${stage.id})` : '') +
        (plan.blockers.length > 0
          ? `:\n${plan.blockers.map((blocker) => `- ${blocker}`).join('\n')}`
          : `; next stage is ${plan.nextStage}`),
    );
    this.name = 'StagedUpgradeValidationError';
    this.plan = plan;
  }
}

/** Render a plan for a CI log or an operator report. */
export function formatStagedUpgradePlan(plan: StagedUpgradePlan): string {
  const lines = [
    `staged upgrade: ${plan.contract}${plan.production ? ' (production)' : ''}`,
    `schema: v${plan.fromStorageVersion} → v${plan.targetStorageVersion}` +
      (plan.migrationRequired ? ' (migration required)' : ''),
    `approvals: ${plan.approvals.collected}/${plan.approvals.required}`,
    `promote now: ${plan.canPromote ? 'yes' : 'no'}`,
    `next stage: ${plan.nextStage ?? 'none — upgrade complete'}`,
    'stages:',
  ];

  for (const stage of plan.stages) {
    lines.push(
      `  ${stage.id.padEnd(8)} ${stage.status}${stage.requiresAdmin ? ' [admin]' : ''} — ${stage.title}`,
    );
    for (const blocker of stage.blockers) lines.push(`    blocked: ${blocker}`);
  }

  if (plan.warnings.length > 0) {
    lines.push('warnings:');
    for (const warning of plan.warnings) lines.push(`  - ${warning}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stagingCompleteCheck(
  evidence: StagedUpgradeEvidence,
  stagingContractId: string,
  production: boolean,
): boolean {
  if (!production) return false;
  return (
    stagingContractId.length > 0 &&
    evidence?.stagingVerified === true &&
    evidence?.smokeChecksPassed === true
  );
}

function readVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
