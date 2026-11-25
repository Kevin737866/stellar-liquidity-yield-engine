/**
 * Migration checklist for protocol configuration changes.
 *
 * Configuration in this protocol is split across layers that fail in different
 * ways: governance-bounded parameters (fees, rebalance threshold, insurance
 * reserve target), stored layouts that a contract build must migrate, and
 * derived state cached off-chain by keepers. A change that is only a parameter
 * edit is reversible with another edit; a stored-layout change is not, and a
 * derived-state change silently desynchronises a keeper that is not restarted.
 *
 * `docs/CONFIG_MIGRATION_CHECKLIST.md` is the operator checklist. This module
 * is its machine-checkable part: {@link buildConfigMigrationChecklist} takes
 * the current values, the intended values and the change scope, and returns
 * `ready` only when nothing is missing — governance approval, a captured
 * snapshot, a written rollback plan and, for a stored-layout change, a schema
 * version bump with idempotent migration work.
 *
 * Bounds mirror the constants in `src/governance.rs`
 * (`MIN_/MAX_PERFORMANCE_FEE`, `MIN_/MAX_WITHDRAWAL_FEE`,
 * `MIN_/MAX_REBALANCE_THRESHOLD`, `MIN_/MAX_INSURANCE_RESERVE`). Bounds are
 * inclusive: exactly at a limit is valid.
 *
 * ```ts
 * const checklist = buildConfigMigrationChecklist({
 *   current: { performanceFee: 1000, withdrawalFee: 10, rebalanceThreshold: 200, insuranceReserveTarget: 15000 },
 *   next: { performanceFee: 1500 },
 *   governanceApproved: true,
 *   snapshotTaken: true,
 *   rollbackPlan: 'Re-apply performanceFee=1000 via the same governance flow.',
 * });
 *
 * checklist.ready;   // true — 1500 is the inclusive upper bound
 * checklist.steps;   // ordered operator steps
 * ```
 */

/** The governable protocol parameters, in basis points. */
export interface ProtocolConfig {
  /** Performance fee: 500–1500 bps (5%–15%). */
  performanceFee: number;
  /** Withdrawal fee: 10–100 bps (0.1%–1%). */
  withdrawalFee: number;
  /** Rebalance threshold: 100–500 bps (1%–5%). */
  rebalanceThreshold: number;
  /** Insurance reserve target: 10000–20000 bps (100%–200%). */
  insuranceReserveTarget: number;
}

export type ProtocolConfigField = keyof ProtocolConfig;

/** Inclusive range for one parameter, in basis points. */
export interface ConfigBound {
  min: number;
  max: number;
  unit: 'bps';
  description: string;
}

/**
 * Inclusive bounds for every governable parameter. Mirrors the constants in
 * `src/governance.rs`; a value outside its range is rejected on-chain and the
 * stored value is left unchanged.
 */
export const PROTOCOL_CONFIG_BOUNDS: Record<ProtocolConfigField, ConfigBound> = {
  performanceFee: {
    min: 500,
    max: 1500,
    unit: 'bps',
    description: 'Performance fee (5%–15%)',
  },
  withdrawalFee: {
    min: 10,
    max: 100,
    unit: 'bps',
    description: 'Withdrawal fee (0.1%–1%)',
  },
  rebalanceThreshold: {
    min: 100,
    max: 500,
    unit: 'bps',
    description: 'Rebalance threshold (1%–5%)',
  },
  insuranceReserveTarget: {
    min: 10000,
    max: 20000,
    unit: 'bps',
    description: 'Insurance reserve target (100%–200%)',
  },
};

/**
 * How far the change reaches. Choosing too narrow a scope is the most common
 * way a configuration migration goes wrong, so the checklist requires the
 * caller to state it.
 */
export type ConfigChangeScope =
  /** Values only: the stored shapes and their meaning are unchanged. */
  | 'parameter_only'
  /** Stored shapes or their encoding change, so the build needs a migration. */
  | 'storage_layout'
  /** Off-chain state derived from the config (keeper schedules, caches) changes. */
  | 'derived_state';

/** A requested configuration change plus the evidence that it is planned. */
export interface ProtocolConfigChangeRequest {
  current: ProtocolConfig;
  /** Fields to change. Omitted fields keep their current value. */
  next: Partial<ProtocolConfig>;
  /** Defaults to `parameter_only`. */
  scope?: ConfigChangeScope;
  /** Schema version live before the change. */
  storageVersion?: number;
  /** Schema version the build shipping the change expects. */
  targetStorageVersion?: number;
  /** Whether the current values and stored state were captured before the change. */
  snapshotTaken?: boolean;
  /** What to re-apply or restore if the change must be undone. */
  rollbackPlan?: string;
  /** Whether the change went through propose → timelock → execute. */
  governanceApproved?: boolean;
  /** Whether keepers holding derived state were told to restart. */
  keepersInformed?: boolean;
  /** Whether the stored-layout migration is written to be safe to re-run. */
  migrationIdempotent?: boolean;
}

/** One field moving from `from` to `to`. */
export interface ConfigValueChange {
  field: ProtocolConfigField;
  from: number;
  to: number;
}

/** The checklist result: whether the change may proceed, and what remains. */
export interface ConfigMigrationChecklist {
  /** True only when there is a change and nothing blocks it. */
  ready: boolean;
  /** True when `next` equals `current`; an empty migration must not be run. */
  noop: boolean;
  changes: ConfigValueChange[];
  /** Whether `STORAGE_VERSION` must be bumped in the same change. */
  requiresStorageVersionBump: boolean;
  /** Whether keepers must be restarted (or have their cached state invalidated). */
  requiresKeeperRestart: boolean;
  /** Conditions that make the change unsafe to execute as specified. */
  blockers: string[];
  /** Safe but easy to get wrong; read them before executing. */
  warnings: string[];
  /** Ordered operator steps for this change. */
  steps: string[];
}

/**
 * Validate a full configuration against the governance bounds.
 *
 * Bounds are inclusive. Non-integers and non-finite numbers are rejected: the
 * contract stores `u32` basis points, and a fractional value cannot be encoded.
 */
export function validateProtocolConfig(config: ProtocolConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  for (const field of Object.keys(PROTOCOL_CONFIG_BOUNDS) as ProtocolConfigField[]) {
    const value = config[field];
    const bound = PROTOCOL_CONFIG_BOUNDS[field];

    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
      errors.push(`${field} must be an integer number of basis points`);
      continue;
    }
    if (value < bound.min || value > bound.max) {
      errors.push(
        `${field} must be between ${bound.min} and ${bound.max} bps (received ${value})`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Build the migration checklist for a configuration change.
 *
 * Never throws: a malformed request surfaces as a blocker, because an operator
 * reading the checklist needs to see *what* is wrong, not an exception from an
 * incident script.
 */
export function buildConfigMigrationChecklist(
  request: ProtocolConfigChangeRequest,
): ConfigMigrationChecklist {
  const scope = request.scope ?? 'parameter_only';
  const blockers: string[] = [];
  const warnings: string[] = [];

  const currentCheck = validateProtocolConfig(request.current);
  blockers.push(...currentCheck.errors.map((error) => `current config: ${error}`));

  const changes = collectChanges(request, blockers);

  for (const change of changes) {
    const bound = PROTOCOL_CONFIG_BOUNDS[change.field];
    if (change.to < bound.min || change.to > bound.max) {
      blockers.push(
        `${change.field} target ${change.to} is outside ${bound.min}–${bound.max} bps; the contract rejects it and keeps the old value`,
      );
    }
  }

  const noop = changes.length === 0;
  const requiresStorageVersionBump = scope === 'storage_layout';
  const requiresKeeperRestart = scope === 'derived_state';

  if (noop) {
    warnings.push('no configuration value changes; there is nothing to migrate');
    return {
      ready: true,
      noop,
      changes,
      requiresStorageVersionBump,
      requiresKeeperRestart,
      blockers,
      warnings,
      steps: [],
    };
  }

  if (request.governanceApproved !== true) {
    blockers.push(
      'the change has not passed governance (propose → timelock → execute); parameter setters are not admin-called directly',
    );
  }
  if (request.snapshotTaken !== true) {
    blockers.push(
      'no pre-change snapshot: capture the current values and the stored entries the change affects before executing',
    );
  }
  if (!request.rollbackPlan || request.rollbackPlan.trim().length === 0) {
    blockers.push(
      'no rollback plan: state the values to re-apply or the snapshot to restore if the change must be undone',
    );
  }

  if (changes.length > 1) {
    warnings.push(
      'more than one parameter changes in this proposal; verify each value against the snapshot instead of a single aggregate',
    );
  }

  if (requiresStorageVersionBump) {
    validateStorageLayoutChange(request, blockers, warnings);
  } else if (
    request.targetStorageVersion !== undefined &&
    request.storageVersion !== undefined &&
    request.targetStorageVersion > request.storageVersion
  ) {
    warnings.push(
      'the target schema version is newer than the live one, but the scope is not `storage_layout`; a bump needs migration work and the storage_layout checklist',
    );
  }

  if (requiresKeeperRestart && request.keepersInformed !== true) {
    blockers.push(
      'keepers that cache derived state have not been informed: restart them from their checkpoints after the change',
    );
  }

  return {
    ready: blockers.length === 0,
    noop,
    changes,
    requiresStorageVersionBump,
    requiresKeeperRestart,
    blockers,
    warnings,
    steps: buildSteps(changes, scope),
  };
}

function collectChanges(
  request: ProtocolConfigChangeRequest,
  blockers: string[],
): ConfigValueChange[] {
  const changes: ConfigValueChange[] = [];
  const next = request.next as Record<string, unknown>;

  for (const key of Object.keys(next)) {
    if (!(key in PROTOCOL_CONFIG_BOUNDS)) {
      blockers.push(`unknown configuration field: ${key}`);
      continue;
    }
    const field = key as ProtocolConfigField;
    const to = next[key];
    if (typeof to !== 'number' || !Number.isFinite(to) || !Number.isInteger(to)) {
      blockers.push(`${field} must be an integer number of basis points`);
      continue;
    }
    if (to !== request.current[field]) {
      changes.push({ field, from: request.current[field], to });
    }
  }

  return changes;
}

function validateStorageLayoutChange(
  request: ProtocolConfigChangeRequest,
  blockers: string[],
  warnings: string[],
): void {
  const live = request.storageVersion;
  const target = request.targetStorageVersion;

  if (live === undefined || !Number.isInteger(live) || live < 0) {
    blockers.push(
      'a storage-layout change needs the live schema version (read `get_storage_version`)',
    );
  }
  if (target === undefined || !Number.isInteger(target) || target < 1) {
    blockers.push(
      'a storage-layout change needs the target schema version from the shipping build',
    );
  }
  if (
    live !== undefined &&
    target !== undefined &&
    Number.isInteger(live) &&
    Number.isInteger(target) &&
    target <= live
  ) {
    blockers.push(
      `bump STORAGE_VERSION in src/upgrade.rs in the same change (target ${target} must be greater than live ${live})`,
    );
  }
  if (request.migrationIdempotent !== true) {
    blockers.push(
      'the stored-layout migration must be safe to re-run: `migrate` is retried after timeouts and by operators who are unsure whether the first call landed',
    );
  }
  warnings.push(
    '`upgrade` only becomes visible on the next invocation; verify with `get_storage_version` before resuming user flows',
  );
}

function buildSteps(
  changes: ConfigValueChange[],
  scope: ConfigChangeScope,
): string[] {
  const summary = changes
    .map((change) => `${change.field}: ${change.from} → ${change.to} bps`)
    .join(', ');

  const steps = [
    `Record the change (${summary}) with its issue link and the block/ledger it targets.`,
    'Capture the pre-change snapshot: current getters plus the stored entries the change affects.',
    'Propose the change through governance and let the timelock elapse.',
  ];

  if (scope === 'storage_layout') {
    steps.push(
      'Build and test the new wasm, install it, then call `upgrade(admin, new_wasm_hash)`.',
      'Call `migrate(admin)` once, record the returned previous version, and re-read `get_storage_version`.',
    );
  }

  steps.push(
    'Execute the parameter change and confirm the getters return the intended values.',
    'Compare one known user position/policy/strategy against the snapshot.',
  );

  if (scope === 'derived_state') {
    steps.push(
      'Restart keepers from their checkpoints and watch the first ticks for duplicated or skipped work (docs/KEEPER_RECOVERY.md).',
    );
  }

  steps.push(
    'Watch the governance/fee events for the expected effect and keep the rollback plan ready until the next review.',
  );

  return steps;
}
