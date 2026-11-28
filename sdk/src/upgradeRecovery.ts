/**
 * Recovery planning after a failed contract upgrade.
 *
 * A Soroban upgrade is a single host call
 * (`Env::deployer().update_current_contract_wasm`). It either replaces the
 * contract's code — keeping its address, storage and balance — or the whole
 * invocation fails and nothing changes. That binary outcome is what makes a
 * recovery runbook possible: before anything else an operator has to answer
 * *"did the code change?"* and *"does the live schema match the live code?"*.
 *
 * `docs/RUNBOOK_FAILED_UPGRADE.md` is the operator procedure; this module is
 * the machine-checkable part of its triage step. Given what a keeper or an
 * on-call script can observe after a failure, {@link planUpgradeRecovery}
 * returns a deterministic plan:
 *
 * - an {@link UpgradeRecoveryOutcome} — retry, roll back, finish forward,
 *   re-deploy, or stop and escalate;
 * - ordered {@link RecoveryStep}s, flagged when they need the admin key;
 * - `blockers` — conditions that make the plan unsafe to execute (a missing
 *   previous wasm hash, an unreadable storage version, a lost admin key);
 * - `warnings` — things that are safe but easy to get wrong.
 *
 * The planner never guesses. Anything it cannot establish from the
 * observation becomes a blocker or a `manual_review`, because acting on a
 * wrong assumption mid-incident is how storage gets corrupted.
 *
 * ```ts
 * const plan = planUpgradeRecovery({
 *   phase: 'migration',
 *   liveCode: 'new',
 *   expectedStorageVersion: 2,
 *   storageVersion: 1,
 *   adminKeyAvailable: true,
 * });
 * // plan.outcome === 'forward_fix', plan.safeToRetry === false
 * console.log(formatUpgradeRecoveryPlan(plan));
 * ```
 */

/** Where in the upgrade flow the failure was observed. */
export type UpgradeFailurePhase =
  /** Before any transaction: the change was rejected in review or by validation. */
  | 'preflight'
  /** Uploading the new wasm (`contract install`). Nothing on-chain changed. */
  | 'wasm_install'
  /** Building/signing/submitting the `upgrade` transaction. */
  | 'upgrade_submission'
  /** The `upgrade` invocation itself failed on-chain. */
  | 'upgrade_execution'
  /** The swap was submitted but post-upgrade checks disagree. */
  | 'post_upgrade_verification'
  /** The new code is live but `migrate` failed or is incomplete. */
  | 'migration';

/** Which code answers at the contract address now. */
export type LiveContractCode = 'old' | 'new' | 'unknown';

/** What the operator should do next. */
export type UpgradeRecoveryOutcome =
  /** Nothing changed on-chain; fix the cause and run the same upgrade again. */
  | 'retry'
  /** New code is live but unusable with the stored data; put the old wasm back. */
  | 'rollback'
  /** New code is live and wanted; finish it (migration, verification, unpause). */
  | 'forward_fix'
  /** In-place recovery is not appropriate (e.g. admin key compromised). */
  | 'redeploy'
  /** Not enough is known to act safely; freeze the contract and escalate. */
  | 'manual_review';

/** How urgent the situation is. `critical` means user funds or state are at risk. */
export type RecoverySeverity = 'none' | 'info' | 'warning' | 'critical';

/**
 * What an operator (or an on-call script) can observe after a failed upgrade.
 *
 * Everything that determines the plan is explicit here — the planner reads no
 * network and no environment — so the same observation always produces the
 * same plan, and the plan can be tested and reviewed before it is executed.
 */
export interface UpgradeRecoveryObservation {
  /** Where the failure happened. */
  phase: UpgradeFailurePhase;
  /** Which code is live at the contract address right now. */
  liveCode: LiveContractCode;
  /** Schema version the build you were deploying expects. */
  expectedStorageVersion: number;
  /**
   * Schema version `get_storage_version` returned after the failure.
   * `undefined` and `null` both mean "could not be read".
   */
  storageVersion?: number | null;
  /** Hash of the wasm the failed upgrade targeted, when known. */
  targetWasmHash?: string;
  /**
   * Hash of the wasm that was live before the attempt. Required for a
   * rollback: without it there is nothing to point `upgrade` at.
   */
  previousWasmHash?: string;
  /**
   * Whether the failed attempt is known to have reverted. A reverted Soroban
   * invocation changes nothing, code included.
   */
  reverted?: boolean;
  /**
   * Whether the attempt might already have written storage (for example a
   * migration that failed halfway). Defaults to `false`, which is correct for
   * any failure before the new code ran.
   */
  mayHaveWrittenStorage?: boolean;
  /** Whether the admin signer can still authorize an admin entrypoint. Defaults to `true`. */
  adminKeyAvailable?: boolean;
  /**
   * Whether the admin key is believed compromised. This outranks every other
   * observation: an attacker with the key can upgrade anyway, so the contract
   * must move to a new address instead of being recovered in place.
   */
  adminKeyCompromised?: boolean;
  /** Whether the contract is paused right now. Defaults to `false`. */
  paused?: boolean;
}

/** One operator action in the plan. */
export interface RecoveryStep {
  /** Stable identifier, safe to use in logs and incident notes. */
  id: string;
  /** Imperative one-liner. */
  action: string;
  /** What "done" looks like, and what to watch out for. */
  detail: string;
  /** Whether the step needs the stored admin key / admin signer. */
  requiresAdmin?: boolean;
}

/** The decision plus the steps that implement it. */
export interface UpgradeRecoveryPlan {
  outcome: UpgradeRecoveryOutcome;
  severity: RecoverySeverity;
  /** One sentence an operator can read out in an incident channel. */
  headline: string;
  /**
   * True only for `retry`, where the failed attempt provably changed nothing.
   * Every other outcome requires an explicit decision before another upgrade.
   */
  safeToRetry: boolean;
  /** True when at least one step needs the admin key. */
  requiresAdmin: boolean;
  steps: RecoveryStep[];
  /** Conditions that make the plan unsafe to execute as written. */
  blockers: string[];
  warnings: string[];
}

/** Thrown for an observation that cannot describe a real post-failure state. */
export class UpgradeRecoveryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeRecoveryInputError';
  }
}

const WASM_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

const PHASES: readonly UpgradeFailurePhase[] = [
  'preflight',
  'wasm_install',
  'upgrade_submission',
  'upgrade_execution',
  'post_upgrade_verification',
  'migration',
];

const LIVE_CODE: readonly LiveContractCode[] = ['old', 'new', 'unknown'];

/**
 * Turn a post-failure observation into an ordered recovery plan.
 *
 * Throws {@link UpgradeRecoveryInputError} when the observation itself is
 * malformed (an unknown phase, a negative schema version, a wasm hash that is
 * not 32 bytes of hex), because a typo in an incident script must not be read
 * as a valid plan.
 */
export function planUpgradeRecovery(
  observation: UpgradeRecoveryObservation,
): UpgradeRecoveryPlan {
  validateObservation(observation);

  const adminKeyAvailable = observation.adminKeyAvailable ?? true;
  const paused = observation.paused ?? false;

  // A compromised key outranks the on-chain state: recovery in place would
  // hand the attacker another upgrade. Move the protocol to a new address.
  if (observation.adminKeyCompromised) {
    return redeployPlan(paused, adminKeyAvailable);
  }

  // A reverted upgrade that nevertheless reports new code means the operator
  // is looking at a different contract or network than the one they upgraded.
  if (observation.reverted === true && observation.liveCode === 'new') {
    return manualReviewPlan({
      headline:
        'The upgrade reverted but new code answers at the address: the observation is inconsistent.',
      blockers: [
        'Confirm the contract ID and network of the address you inspected — a reverted invocation cannot have changed code.',
      ],
      steps: [
        pauseStep(paused),
        {
          id: 'recheck-address',
          action: 'Re-read the contract ID, wasm hash and storage version from the intended network.',
          detail:
            'Compare them with the deploy records. Do not upgrade or migrate until the address is confirmed.',
        },
      ],
      warnings: [],
      severity: 'critical',
    });
  }

  switch (observation.liveCode) {
    case 'unknown':
      return manualReviewPlan({
        headline:
          'Cannot tell which code is live at the contract address; freeze and establish that first.',
        blockers: [
          'Read `get_storage_version` and a known read entrypoint from at least two RPC endpoints, or inspect the contract instance in the ledger.',
        ],
        steps: [
          pauseStep(paused),
          {
            id: 'identify-code',
            action: 'Identify the live wasm before doing anything else.',
            detail:
              'A failed call can also be a failed *read*. Retry the read on another RPC before concluding the contract is bricked.',
          },
        ],
        warnings: [],
        severity: 'critical',
      });

    case 'old':
      return retryPlan(observation, adminKeyAvailable, paused);

    case 'new':
      return newCodeLivePlan(observation, adminKeyAvailable, paused);
  }
}

/**
 * Render a plan as the block an operator pastes into an incident channel.
 * Deterministic, so it can be asserted in tests and diffed between runs.
 */
export function formatUpgradeRecoveryPlan(plan: UpgradeRecoveryPlan): string {
  const lines: string[] = [
    `Upgrade recovery: ${plan.outcome} (${plan.severity})`,
    plan.headline,
    `Safe to retry without review: ${plan.safeToRetry ? 'yes' : 'no'}`,
    `Admin key required: ${plan.requiresAdmin ? 'yes' : 'no'}`,
  ];

  if (plan.blockers.length > 0) {
    lines.push('Blockers:');
    plan.blockers.forEach((blocker) => lines.push(`  - ${blocker}`));
  }

  lines.push('Steps:');
  plan.steps.forEach((step, index) => {
    const admin = step.requiresAdmin ? ' [admin]' : '';
    lines.push(`  ${index + 1}. ${step.action}${admin}`);
    lines.push(`     ${step.detail}`);
  });

  if (plan.warnings.length > 0) {
    lines.push('Warnings:');
    plan.warnings.forEach((warning) => lines.push(`  - ${warning}`));
  }

  return lines.join('\n');
}

function retryPlan(
  observation: UpgradeRecoveryObservation,
  adminKeyAvailable: boolean,
  paused: boolean,
): UpgradeRecoveryPlan {
  const warnings: string[] = [];

  if (observation.reverted === false) {
    warnings.push(
      'The submission was reported as successful but the old code is live; confirm the contract ID and network before retrying.',
    );
  }
  if (observation.mayHaveWrittenStorage) {
    warnings.push(
      'The failed attempt may have written storage; diff the affected entries against the pre-change snapshot before retrying.',
    );
  }
  if (!observation.targetWasmHash) {
    warnings.push(
      'The target wasm hash is unrecorded; `contract install` prints the hash, so record it this time.',
    );
  }

  const steps: RecoveryStep[] = [
    {
      id: 'confirm-reverted',
      action: 'Confirm the `upgrade` invocation reverted and no `contract_upgraded` event was emitted.',
      detail:
        'A reverted Soroban invocation changes nothing, code included. If the transaction is still pending, wait for a final status before acting.',
    },
    {
      id: 'confirm-artifact',
      action: 'Confirm the new wasm is installed and the hash matches the reviewed build.',
      detail:
        'Install the build again if the hash is unknown; the install step is what makes the hash resolvable by the host.',
    },
    {
      id: 'confirm-target',
      action: 'Confirm the contract ID and network are the ones you mean to upgrade.',
      detail:
        'An upgrade is addressed by contract ID. A typo upgrades a different contract and leaves the intended one untouched.',
    },
    {
      id: 'verify-old-healthy',
      action: 'Verify the old code still serves reads and is not paused unexpectedly.',
      detail:
        '`get_storage_version` and one read entrypoint are enough to prove the address is healthy before you try again.',
    },
  ];

  if (!adminKeyAvailable) {
    return manualReviewPlan({
      headline:
        'The upgrade did not land, but the admin signer is unavailable, so it cannot be retried or rolled back right now.',
      blockers: [
        'Admin key unavailable: hand the signed `upgrade` call to the governance/emergency signers.',
      ],
      steps: [...steps, pauseStepIfNeeded(paused)],
      warnings,
      severity: 'warning',
    });
  }

  steps.push({
    id: 'retry-upgrade',
    action: 'Fix the cause and re-invoke `upgrade(admin, new_wasm_hash)`.',
    detail:
      'Re-running is safe: the previous attempt reverted, so no state was written. Verify `get_storage_version` immediately afterwards.',
    requiresAdmin: true,
  });

  return {
    outcome: 'retry',
    severity: 'warning',
    headline:
      'The upgrade did not take effect; fix the cause and retry the same call.',
    safeToRetry: true,
    requiresAdmin: true,
    steps,
    blockers: [],
    warnings,
  };
}

function newCodeLivePlan(
  observation: UpgradeRecoveryObservation,
  adminKeyAvailable: boolean,
  paused: boolean,
): UpgradeRecoveryPlan {
  const storageVersion = observation.storageVersion;

  if (storageVersion === undefined || storageVersion === null) {
    return manualReviewPlan({
      headline:
        'New code is live but its schema version could not be read; do not let it serve traffic.',
      blockers: [
        'Read `get_storage_version` (retry on another RPC, or inspect instance storage) before any write reaches the contract.',
      ],
      steps: [
        pauseStep(paused),
        {
          id: 'resolve-version',
          action: 'Resolve the stored schema version through a second RPC or ledger inspection.',
          detail:
            'An unreadable version can be a transport problem or a decode failure in the new code. Those need different fixes.',
        },
      ],
      warnings: [],
      severity: 'critical',
    });
  }

  if (storageVersion > observation.expectedStorageVersion) {
    return rollbackPlan(observation, adminKeyAvailable, paused, storageVersion);
  }

  if (storageVersion < observation.expectedStorageVersion) {
    const warnings: string[] = [];
    if (observation.mayHaveWrittenStorage) {
      warnings.push(
        'The failed migration may have written storage before it failed; re-run `migrate` (it must be idempotent) and verify the affected entries.',
      );
    }

    if (!adminKeyAvailable) {
      return manualReviewPlan({
        headline:
          'New code is live on the old schema and `migrate` needs the admin signer, which is unavailable.',
        blockers: [
          'Admin key unavailable: the contract must stay paused until a signer can call `migrate`.',
        ],
        steps: [pauseStep(paused)],
        warnings,
        severity: 'critical',
      });
    }

    return {
      outcome: 'forward_fix',
      severity: 'warning',
      headline:
        'The code swap landed; run `migrate` to adopt the new schema, then verify.',
      safeToRetry: false,
      requiresAdmin: true,
      steps: [
        pauseStepIfNeeded(paused),
        {
          id: 'run-migrate',
          action: 'Call `migrate(admin)` once and record the returned previous version.',
          detail:
            'It returns the version it replaced and publishes `contract_migrated (admin, from, to)`. Re-running is safe only if the migration work is idempotent — confirm that in the build before retrying a failed call.',
          requiresAdmin: true,
        },
        {
          id: 'verify-schema',
          action: 'Verify `get_storage_version` equals the expected version.',
          detail:
            'Read it back from the same network. A mismatch means the wrong build or the wrong contract.',
        },
        {
          id: 'smoke-reads',
          action: 'Run the read-side smoke checks for the changed structures.',
          detail:
            'Compare a handful of known entries with the pre-change snapshot; do not rely on a single aggregate number.',
        },
        unpauseStep(paused),
      ],
      blockers: [],
      warnings,
    };
  }

  const warnings: string[] = [];
  if (observation.phase === 'migration' || observation.mayHaveWrittenStorage) {
    warnings.push(
      'The recorded version already matches, but a failed migration may have written partial data; re-run the idempotent migration or verify invariants before unpausing.',
    );
  }

  return {
    outcome: 'forward_fix',
    severity: 'info',
    headline:
      'Code and schema are current; finish verification and resume traffic deliberately.',
    safeToRetry: false,
    requiresAdmin: paused && adminKeyAvailable,
    steps: [
      {
        id: 'smoke-reads',
        action: 'Run the read-side smoke checks against the new code.',
        detail:
          'Exercise the entrypoints whose behaviour was supposed to change, plus one user position/policy read.',
      },
      {
        id: 'check-events',
        action: 'Confirm `contract_upgraded` and `contract_migrated` were emitted exactly once.',
        detail:
          'Duplicate or missing events point at a retried submission or the wrong contract ID.',
      },
      unpauseStep(paused),
      {
        id: 'resume-keepers',
        action: 'Resume keepers from their checkpoints and watch the first few ticks.',
        detail:
          'See docs/KEEPER_RECOVERY.md. A keeper that resumes from a stale cursor replays old events; one that starts fresh can double-execute a rebalance.',
      },
    ],
    blockers: [],
    warnings,
  };
}

function rollbackPlan(
  observation: UpgradeRecoveryObservation,
  adminKeyAvailable: boolean,
  paused: boolean,
  storageVersion: number,
): UpgradeRecoveryPlan {
  const mismatch =
    `Stored schema version ${storageVersion} is newer than the deployed build expects ` +
    `(${observation.expectedStorageVersion}); the live code can misread the data.`;

  if (!observation.previousWasmHash) {
    return manualReviewPlan({
      headline: `${mismatch} A rollback cannot be targeted because the previous wasm hash was not recorded.`,
      blockers: [
        'Previous wasm hash unknown: recover it from deploy records or rebuild the exact previous release, then install it to obtain the hash.',
      ],
      steps: [pauseStep(paused)],
      warnings: [],
      severity: 'critical',
    });
  }

  if (!adminKeyAvailable) {
    return manualReviewPlan({
      headline: `${mismatch} The rollback needs the admin signer, which is unavailable.`,
      blockers: [
        'Admin key unavailable: keep the contract paused and hand the signed rollback to the governance/emergency signers.',
      ],
      steps: [pauseStep(paused)],
      warnings: [],
      severity: 'critical',
    });
  }

  const warnings: string[] = [];
  if (observation.mayHaveWrittenStorage || observation.phase === 'migration') {
    warnings.push(
      'Rolling the code back does not undo storage written by the newer migration. If the migration wrote data, forward-fix or restore from a snapshot instead.',
    );
  }

  return {
    outcome: 'rollback',
    severity: 'critical',
    headline: `${mismatch} Roll back to the previous wasm and keep the contract paused until it is verified.`,
    safeToRetry: false,
    requiresAdmin: true,
    steps: [
      pauseStep(paused),
      {
        id: 'install-previous',
        action: 'Install the previous wasm (if the host no longer has it) and confirm its hash.',
        detail:
          `Expected previous hash: ${observation.previousWasmHash}. Install must reproduce that exact hash, or you are rolling back to a different build.`,
      },
      {
        id: 'rollback-upgrade',
        action: 'Call `upgrade(admin, previous_wasm_hash)` to put the old code back.',
        detail:
          'The swap takes effect on the next invocation. The address, storage and balance are unchanged.',
        requiresAdmin: true,
      },
      {
        id: 'verify-rollback',
        action: 'Verify `get_storage_version` and the read entrypoints return values the old code understands.',
        detail:
          'If the newer migration rewrote stored shapes, the old code may still fail here; that is the moment to choose forward-fix or re-deploy instead.',
      },
      unpauseStep(paused),
      {
        id: 'preserve-artifacts',
        action: 'Preserve the target wasm hash, transaction hashes and storage snapshot for the post-mortem.',
        detail:
          'The next upgrade attempt should start from a corrected build, not from the one that caused the incident.',
      },
    ],
    blockers: [],
    warnings,
  };
}

function redeployPlan(paused: boolean, adminKeyAvailable: boolean): UpgradeRecoveryPlan {
  const blockers = adminKeyAvailable
    ? []
    : ['Admin key unavailable: a re-deployment needs a signer for the new contract, not the old one.'];

  return {
    outcome: 'redeploy',
    severity: 'critical',
    headline:
      'The admin key is believed compromised; recover by re-deploying at a new address instead of upgrading in place.',
    safeToRetry: false,
    requiresAdmin: false,
    steps: [
      pauseStep(paused),
      {
        id: 'rotate-admin',
        action: 'Move admin authority to a new key and freeze the existing contract.',
        detail:
          'An upgrade is only as strong as the admin key, so any in-place recovery would repeat the compromise.',
      },
      {
        id: 'deploy-new-address',
        action: 'Deploy the reviewed build to a new address and migrate state deliberately.',
        detail:
          'See docs/UPGRADING.md Flow B: re-point the engine, vault treasury, distributor oracle and rebalance keeper, then replay user positions from the old contract.',
      },
      {
        id: 'verify-cutover',
        action: 'Verify the new address before switching traffic, then pause the old contract permanently.',
        detail:
          'Keep the old contract readable for reconciliation; do not unpause it.',
      },
    ],
    blockers,
    warnings: [
      'Assume the attacker can still call `upgrade` on the old address until its admin is rotated or it is frozen.',
    ],
  };
}

function manualReviewPlan(input: {
  headline: string;
  blockers: string[];
  steps: RecoveryStep[];
  warnings: string[];
  severity: RecoverySeverity;
}): UpgradeRecoveryPlan {
  return {
    outcome: 'manual_review',
    severity: input.severity,
    headline: input.headline,
    safeToRetry: false,
    requiresAdmin: input.steps.some((step) => step.requiresAdmin === true),
    steps: input.steps,
    blockers: input.blockers,
    warnings: input.warnings,
  };
}

function pauseStep(paused: boolean): RecoveryStep {
  return {
    id: 'pause',
    action: paused
      ? 'Keep the contract paused while the failure is investigated.'
      : 'Pause the contract with a maintenance reason before investigating.',
    detail:
      'Pausing stops user flows while leaving admin recovery entrypoints (unpause, upgrade, migrate) available.',
    requiresAdmin: !paused,
  };
}

function pauseStepIfNeeded(paused: boolean): RecoveryStep {
  return {
    id: 'pause-if-needed',
    action: paused
      ? 'Keep the contract paused until the recovery is verified.'
      : 'Pause the contract if user flows could hit the half-migrated state.',
    detail:
      'A code swap alone is safe to leave running; a schema change is not.',
    requiresAdmin: !paused,
  };
}

function unpauseStep(paused: boolean): RecoveryStep {
  return {
    id: 'unpause',
    action: paused
      ? 'Unpause only after every check above passes.'
      : 'Confirm the contract is unpaused before resuming traffic.',
    detail:
      'Unpausing is a separate decision from upgrading: a healthy code swap can still serve a bad configuration.',
    requiresAdmin: paused,
  };
}

function validateObservation(observation: UpgradeRecoveryObservation): void {
  if (observation === null || typeof observation !== 'object') {
    throw new UpgradeRecoveryInputError('an upgrade recovery observation is required');
  }
  if (!PHASES.includes(observation.phase)) {
    throw new UpgradeRecoveryInputError(
      `unknown upgrade failure phase: ${String(observation.phase)}`,
    );
  }
  if (!LIVE_CODE.includes(observation.liveCode)) {
    throw new UpgradeRecoveryInputError(
      `liveCode must be one of ${LIVE_CODE.join(', ')}`,
    );
  }

  assertVersion('expectedStorageVersion', observation.expectedStorageVersion, false);
  if (observation.storageVersion !== undefined && observation.storageVersion !== null) {
    assertVersion('storageVersion', observation.storageVersion, false);
  }

  assertWasmHash('targetWasmHash', observation.targetWasmHash);
  assertWasmHash('previousWasmHash', observation.previousWasmHash);
}

function assertVersion(name: string, value: number, allowNegative: boolean): void {
  if (!Number.isInteger(value) || (!allowNegative && value < 0)) {
    throw new UpgradeRecoveryInputError(
      `${name} must be a non-negative integer, received ${String(value)}`,
    );
  }
}

function assertWasmHash(name: string, value: string | undefined): void {
  if (value !== undefined && !WASM_HASH_PATTERN.test(value)) {
    throw new UpgradeRecoveryInputError(
      `${name} must be a 32-byte hex wasm hash, received ${String(value)}`,
    );
  }
}
