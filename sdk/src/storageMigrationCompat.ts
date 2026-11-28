/**
 * Compatibility checks for contract storage migrations.
 *
 * A Soroban upgrade keeps the contract's storage and replaces its code, so a
 * build that changes a stored shape must migrate what is already on-chain.
 * `migrate(admin)` in `src/upgrade.rs` adopts `STORAGE_VERSION` and each
 * contract extends it with the work its own layout change needs. That work is
 * plain code, so the only way to know it still understands *old* storage is to
 * run it against a captured fixture.
 *
 * This module is the harness for those checks. A test supplies:
 *
 * - a {@link StorageFixture} — stored entries captured at a known schema
 *   version (including `0`, which is what a contract deployed before the
 *   version key existed reads);
 * - a {@link MigrationStep} ladder — the upcasts that carry entries from one
 *   version to the next;
 * - the target version the shipping build expects.
 *
 * and gets back a {@link MigrationCompatibilityResult}: whether the ladder can
 * take the fixture to the target, the entries it would produce, and every
 * blocker it found. Nothing is applied on-chain and nothing is written: the
 * ladder runs on a deep copy, so a failing fix can be iterated in a test
 * instead of against a live contract.
 *
 * The harness refuses the cases an operator cannot recover from cheaply:
 * downgrades (`target < fixture.version`), gaps in the ladder, a step that
 * throws or returns something that is not a list of entries, dropped keys
 * (unless explicitly allowed), and non-idempotent work — a migration that
 * changes data again when re-run, which is what a retried `migrate` after a
 * timeout would do.
 *
 * ```ts
 * const result = checkMigrationCompatibility(
 *   { contract: 'YieldVault', version: 0, entries: capturedEntries },
 *   STORAGE_VERSION,
 *   vaultMigrationLadder,
 * );
 *
 * result.compatible;  // false when a blocker was found
 * result.lostKeys;    // keys the ladder dropped — usually a bug
 * ```
 *
 * The operator procedure is `docs/STORAGE_MIGRATION_COMPATIBILITY.md`; the
 * upgrade flow itself is `docs/UPGRADING.md`.
 */

/** One stored entry, as captured from a contract's storage at one version. */
export interface StoredEntry {
  /** Storage key, e.g. `UserPosition:<address>`. */
  key: string;
  /** JSON-serialisable decoded value. */
  value: unknown;
}

/** Storage captured from one contract at one schema version. */
export interface StorageFixture {
  /** Contract name or address the entries were captured from. */
  contract: string;
  /**
   * Schema version the fixture was captured at. `0` means "never recorded",
   * which is what a contract deployed before `src/upgrade.rs` reads as.
   */
  version: number;
  entries: StoredEntry[];
}

/**
 * One upcast: how entries written by version `from` become version `to`.
 *
 * `migrate` must be pure — read the entries it is given, return new ones — and
 * idempotent, because it is re-run on data it already produced when a
 * transaction is retried.
 */
export interface MigrationStep {
  from: number;
  to: number;
  /** What the step changes, for the failure report. */
  description: string;
  migrate: (entries: readonly StoredEntry[]) => StoredEntry[];
}

/** Options for {@link checkMigrationCompatibility}. */
export interface MigrationCompatibilityOptions {
  /**
   * Whether a step may remove a stored key. Dropping state is legitimate when
   * a layout change deletes a field; it is a bug when it was not intended, so
   * the default is to treat it as a blocker.
   */
  allowKeyRemoval?: boolean;
  /**
   * Whether to run the whole ladder twice and compare. Defaults to `true`;
   * only disable it for a ladder whose steps cannot be replayed (for example
   * one that consumes an external counter).
   */
  checkIdempotency?: boolean;
}

/** Stable identifier for a compatibility finding. */
export type MigrationIssueCode =
  | 'invalid_fixture'
  | 'invalid_target_version'
  | 'invalid_step'
  | 'downgrade'
  | 'missing_step'
  | 'migration_failed'
  | 'data_loss'
  | 'not_idempotent';

/** A finding from a compatibility check. */
export interface MigrationCompatibilityIssue {
  code: MigrationIssueCode;
  /** `blocker` makes the migration unsafe; `warning` is safe but easy to miss. */
  severity: 'blocker' | 'warning';
  message: string;
}

/** The outcome of running a migration ladder against a fixture. */
export interface MigrationCompatibilityResult {
  contract: string;
  fromVersion: number;
  targetVersion: number;
  /** True only when no blocker was found. */
  compatible: boolean;
  /** Steps applied, in order. Empty when the fixture is already at target. */
  appliedSteps: Array<{ from: number; to: number; description: string }>;
  /** Entries after migration, or `null` when the check failed. */
  entries: StoredEntry[] | null;
  /** Keys present before the migration and absent after it. */
  lostKeys: string[];
  /** Keys the migration introduced. */
  addedKeys: string[];
  issues: MigrationCompatibilityIssue[];
}

/** Raised by {@link assertMigrationCompatible}; the message lists the blockers. */
export class MigrationCompatibilityError extends Error {
  readonly issues: MigrationCompatibilityIssue[];

  constructor(result: MigrationCompatibilityResult) {
    const blockers = result.issues.filter((issue) => issue.severity === 'blocker');
    super(
      `storage migration ${result.contract} ${result.fromVersion} → ${result.targetVersion} is not compatible:\n` +
        blockers.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n'),
    );
    this.name = 'MigrationCompatibilityError';
    this.issues = result.issues;
  }
}

/**
 * Check a migration ladder for structural problems before running it.
 *
 * A ladder is valid when every step moves strictly forward (`to > from`), no
 * two steps start at the same version, and every step describes itself. Gaps
 * are only a problem relative to a target, so they are reported by
 * {@link checkMigrationCompatibility} instead.
 */
export function validateMigrationLadder(steps: readonly MigrationStep[]): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!Array.isArray(steps)) {
    return { valid: false, errors: ['the migration ladder must be an array of steps'] };
  }

  const starts = new Set<number>();
  for (const [index, step] of steps.entries()) {
    const label = `step ${index} (${String(step?.from)} → ${String(step?.to)})`;

    if (
      typeof step?.from !== 'number' ||
      !Number.isInteger(step.from) ||
      step.from < 0 ||
      typeof step?.to !== 'number' ||
      !Number.isInteger(step.to) ||
      step.to < 0
    ) {
      errors.push(`${label}: versions must be non-negative integers`);
      continue;
    }
    if (step.to <= step.from) {
      errors.push(`${label}: a migration step must move forward (to > from)`);
    }
    if (typeof step.description !== 'string' || step.description.trim().length === 0) {
      errors.push(`${label}: a step needs a description, it is what the failure report shows`);
    }
    if (typeof step.migrate !== 'function') {
      errors.push(`${label}: migrate must be a function`);
    }
    if (starts.has(step.from)) {
      errors.push(`${label}: two steps start at version ${step.from}; the ladder is ambiguous`);
    }
    starts.add(step.from);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Run a migration ladder against a captured fixture and report whether it
 * reaches `targetVersion` intact.
 *
 * Never throws for bad input or a failing step: the result carries the reason,
 * because an operator reading CI output needs to know *what* is wrong.
 */
export function checkMigrationCompatibility(
  fixture: StorageFixture,
  targetVersion: number,
  steps: readonly MigrationStep[],
  options: MigrationCompatibilityOptions = {},
): MigrationCompatibilityResult {
  const issues: MigrationCompatibilityIssue[] = [];
  const fromVersion = readFixtureVersion(fixture);

  const result: MigrationCompatibilityResult = {
    contract: readContractName(fixture),
    fromVersion,
    targetVersion: typeof targetVersion === 'number' ? targetVersion : Number.NaN,
    compatible: false,
    appliedSteps: [],
    entries: null,
    lostKeys: [],
    addedKeys: [],
    issues,
  };

  if (!isValidTargetVersion(targetVersion)) {
    issues.push({
      code: 'invalid_target_version',
      severity: 'blocker',
      message: 'the target version must be a non-negative integer (the shipping build\'s STORAGE_VERSION)',
    });
    return result;
  }

  if (!validateFixture(fixture, issues)) {
    return result;
  }

  const fixtureVersion = fixture.version;
  result.fromVersion = fixtureVersion;

  if (targetVersion < fixtureVersion) {
    issues.push({
      code: 'downgrade',
      severity: 'blocker',
      message:
        `the fixture is version ${fixtureVersion} but the target is ${targetVersion}: migrations only move forward. ` +
        'Restore the snapshot or ship a build that understands the newer layout instead of downgrading in place',
    });
    return result;
  }

  const ladder = validateMigrationLadder(steps);
  if (!ladder.valid) {
    for (const error of ladder.errors) {
      issues.push({ code: 'invalid_step', severity: 'blocker', message: error });
    }
    return result;
  }

  if (fixtureVersion === targetVersion) {
    issues.push({
      code: 'missing_step',
      severity: 'warning',
      message:
        `the fixture is already at version ${targetVersion}; running migrate is a no-op. ` +
        'Bump STORAGE_VERSION only when a stored shape changed',
    });
    result.compatible = true;
    result.entries = cloneEntries(fixture.entries);
    return result;
  }

  const walk = applyLadder(fixture.entries, fixtureVersion, targetVersion, steps);
  if (!walk.ok) {
    for (const issue of walk.issues) issues.push(issue);
    return result;
  }

  result.appliedSteps = walk.appliedSteps;
  result.entries = walk.entries;

  const originalKeys = new Set(fixture.entries.map((entry) => entry.key));
  const finalKeys = new Set(walk.entries.map((entry) => entry.key));
  result.lostKeys = [...originalKeys].filter((key) => !finalKeys.has(key)).sort();
  result.addedKeys = [...finalKeys].filter((key) => !originalKeys.has(key)).sort();

  if (result.lostKeys.length > 0) {
    if (options.allowKeyRemoval === true) {
      issues.push({
        code: 'data_loss',
        severity: 'warning',
        message: `the migration removes ${result.lostKeys.length} key(s): ${result.lostKeys.join(', ')}`,
      });
    } else {
      issues.push({
        code: 'data_loss',
        severity: 'blocker',
        message:
          `the migration removes stored keys: ${result.lostKeys.join(', ')}. ` +
          'If the layout change really deletes them, pass allowKeyRemoval: true and say so in the migration',
      });
    }
  }

  if (options.checkIdempotency !== false) {
    // Run the ladder again with its own output as the input: this is what a
    // re-run would do if the version gate were bypassed (a reset version key, a
    // manually replayed migration, a retried transaction on a build whose
    // guard is missing). A step that renames or appends without checking what
    // is already there shows up here.
    const replay = applyLadder(walk.entries, fixtureVersion, targetVersion, steps);
    if (!replay.ok || replay.entries === null) {
      issues.push({
        code: 'not_idempotent',
        severity: 'blocker',
        message:
          'the ladder succeeded once but failed when applied to its own output: a retried migrate would fail on data it already produced',
      });
    } else if (canonicalEntries(replay.entries) !== canonicalEntries(walk.entries)) {
      issues.push({
        code: 'not_idempotent',
        severity: 'blocker',
        message:
          'applying the ladder a second time changes the data again: a retried migrate (timeout, operator unsure whether the first call landed) ' +
          'would apply the work twice. Guard each step on the value it produces (e.g. keep a renamed field when the old one is already gone)',
      });
    }
  }

  result.compatible = !issues.some((issue) => issue.severity === 'blocker');
  if (!result.compatible) {
    result.entries = null;
  }
  return result;
}

/**
 * Throw when a fixture is not compatible, for CI use.
 *
 * ```ts
 * assertMigrationCompatible(capturedVaultFixture, STORAGE_VERSION, ladder);
 * ```
 */
export function assertMigrationCompatible(
  fixture: StorageFixture,
  targetVersion: number,
  steps: readonly MigrationStep[],
  options: MigrationCompatibilityOptions = {},
): MigrationCompatibilityResult {
  const result = checkMigrationCompatibility(fixture, targetVersion, steps, options);
  if (!result.compatible) {
    throw new MigrationCompatibilityError(result);
  }
  return result;
}

/** Render a result for a CI log or an operator report. */
export function formatMigrationCompatibilityReport(
  result: MigrationCompatibilityResult,
): string {
  const lines = [
    `storage migration: ${result.contract} v${result.fromVersion} → v${result.targetVersion}`,
    `result: ${result.compatible ? 'compatible' : 'NOT compatible'}`,
  ];

  if (result.appliedSteps.length > 0) {
    lines.push('steps:');
    for (const step of result.appliedSteps) {
      lines.push(`  ${step.from} → ${step.to}: ${step.description}`);
    }
  } else {
    lines.push('steps: none (already at target)');
  }

  if (result.addedKeys.length > 0) {
    lines.push(`added keys (${result.addedKeys.length}): ${result.addedKeys.join(', ')}`);
  }
  if (result.lostKeys.length > 0) {
    lines.push(`removed keys (${result.lostKeys.length}): ${result.lostKeys.join(', ')}`);
  }

  const blockers = result.issues.filter((issue) => issue.severity === 'blocker');
  const warnings = result.issues.filter((issue) => issue.severity === 'warning');
  if (blockers.length > 0) {
    lines.push('blockers:');
    for (const issue of blockers) lines.push(`  - ${issue.message}`);
  }
  if (warnings.length > 0) {
    lines.push('warnings:');
    for (const issue of warnings) lines.push(`  - ${issue.message}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type LadderWalk =
  | {
      ok: true;
      entries: StoredEntry[];
      appliedSteps: Array<{ from: number; to: number; description: string }>;
      issues: MigrationCompatibilityIssue[];
    }
  | {
      ok: false;
      entries: null;
      appliedSteps: Array<{ from: number; to: number; description: string }>;
      issues: MigrationCompatibilityIssue[];
    };

/**
 * Walk the ladder from `from` to `target`, never mutating the input.
 *
 * Each step receives a deep copy, so a step that mutates its argument cannot
 * corrupt the fixture that a replay starts from.
 */
function applyLadder(
  source: readonly StoredEntry[],
  from: number,
  target: number,
  steps: readonly MigrationStep[],
): LadderWalk {
  const issues: MigrationCompatibilityIssue[] = [];
  const appliedSteps: Array<{ from: number; to: number; description: string }> = [];

  let current = from;
  let entries = cloneEntries(source);

  while (current < target) {
    const step = steps.find((candidate) => candidate.from === current);

    if (!step) {
      issues.push({
        code: 'missing_step',
        severity: 'blocker',
        message:
          `no migration step starts at version ${current}: a fixture at ${from} cannot reach ${target}. ` +
          `Add the missing upcast (${current} → ${current + 1})`,
      });
      return { ok: false, entries: null, appliedSteps, issues };
    }

    if (step.to > target) {
      issues.push({
        code: 'missing_step',
        severity: 'blocker',
        message:
          `the ladder jumps from ${step.from} to ${step.to}, past the target ${target}: ` +
          'a step may not skip an intermediate stored layout',
      });
      return { ok: false, entries: null, appliedSteps, issues };
    }

    let migrated: unknown;
    try {
      migrated = step.migrate(cloneEntries(entries));
    } catch (err) {
      issues.push({
        code: 'migration_failed',
        severity: 'blocker',
        message: `step ${step.from} → ${step.to} threw: ${describeError(err)}`,
      });
      return { ok: false, entries: null, appliedSteps, issues };
    }

    const shapeError = describeEntriesProblem(migrated);
    if (shapeError !== null) {
      issues.push({
        code: 'migration_failed',
        severity: 'blocker',
        message: `step ${step.from} → ${step.to} ${shapeError}`,
      });
      return { ok: false, entries: null, appliedSteps, issues };
    }

    entries = cloneEntries(migrated as StoredEntry[]);
    appliedSteps.push({ from: step.from, to: step.to, description: step.description });
    current = step.to;
  }

  return { ok: true, entries, appliedSteps, issues };
}

function validateFixture(
  fixture: StorageFixture,
  issues: MigrationCompatibilityIssue[],
): boolean {
  const before = issues.length;

  if (typeof fixture !== 'object' || fixture === null) {
    issues.push({
      code: 'invalid_fixture',
      severity: 'blocker',
      message: 'the fixture must be an object with contract, version and entries',
    });
    return false;
  }

  if (typeof fixture.contract !== 'string' || fixture.contract.trim().length === 0) {
    issues.push({
      code: 'invalid_fixture',
      severity: 'blocker',
      message: 'the fixture needs the contract name or address the entries came from',
    });
  }

  if (
    typeof fixture.version !== 'number' ||
    !Number.isInteger(fixture.version) ||
    fixture.version < 0
  ) {
    issues.push({
      code: 'invalid_fixture',
      severity: 'blocker',
      message: 'the fixture version must be a non-negative integer (0 for pre-versioning storage)',
    });
  }

  if (!Array.isArray(fixture.entries)) {
    issues.push({
      code: 'invalid_fixture',
      severity: 'blocker',
      message: 'the fixture entries must be an array',
    });
    return false;
  }

  const seen = new Set<string>();
  for (const [index, entry] of fixture.entries.entries()) {
    if (typeof entry !== 'object' || entry === null || typeof entry.key !== 'string' || entry.key.trim().length === 0) {
      issues.push({
        code: 'invalid_fixture',
        severity: 'blocker',
        message: `entry ${index} needs a non-empty string key`,
      });
      continue;
    }
    if (seen.has(entry.key)) {
      issues.push({
        code: 'invalid_fixture',
        severity: 'blocker',
        message: `entry ${entry.key} appears twice; a fixture must be the decoded storage, not a log`,
      });
    }
    seen.add(entry.key);

    if (!isJsonSerialisable(entry.value)) {
      issues.push({
        code: 'invalid_fixture',
        severity: 'blocker',
        message: `entry ${entry.key} has a value that cannot be serialised; decode it to plain data first`,
      });
    }
  }

  return issues.length === before;
}

/** Returns a description of what is wrong with a step's output, or `null`. */
function describeEntriesProblem(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'must return an array of entries';
  }
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null || typeof entry.key !== 'string' || entry.key.trim().length === 0) {
      return `returned an entry without a string key at index ${index}`;
    }
  }
  return null;
}

function isValidTargetVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function readFixtureVersion(fixture: StorageFixture): number {
  return typeof fixture === 'object' && fixture !== null && typeof fixture.version === 'number'
    ? fixture.version
    : Number.NaN;
}

function readContractName(fixture: StorageFixture): string {
  return typeof fixture === 'object' && fixture !== null && typeof fixture.contract === 'string'
    ? fixture.contract
    : '(unnamed contract)';
}

function isJsonSerialisable(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value as number);
  if (type !== 'object') return false;

  const object = value as object;
  if (seen.has(object)) return false;
  seen.add(object);

  const ok = Array.isArray(object)
    ? object.every((item) => isJsonSerialisable(item, seen))
    : Object.values(object as Record<string, unknown>).every((item) =>
        isJsonSerialisable(item, seen),
      );

  seen.delete(object);
  return ok;
}

function cloneEntries(entries: readonly StoredEntry[]): StoredEntry[] {
  return entries.map((entry) => ({ key: entry.key, value: cloneValue(entry.value) }));
}

function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(source)) copy[key] = cloneValue(source[key]);
  return copy;
}

/**
 * Order-independent serialisation, used to compare a run with its replay.
 *
 * Key order is not storage semantics, so it must not make a migration look
 * non-idempotent.
 */
function canonicalEntries(entries: readonly StoredEntry[]): string {
  const normalised = [...entries]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((entry) => [entry.key, canonicalValue(entry.value)]);
  return JSON.stringify(normalised);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalValue(source[key]);
    return out;
  }
  return value;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
