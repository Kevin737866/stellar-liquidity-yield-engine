/**
 * Compatibility tests for contract storage migrations (Issue #500).
 *
 * The harness is pure, so these tests are the fixture ladder for the harness
 * itself: one worked case per contract-shaped change, plus every boundary and
 * failure the operator procedure calls out.
 */

import {
  assertMigrationCompatible,
  checkMigrationCompatibility,
  formatMigrationCompatibilityReport,
  MigrationCompatibilityError,
  validateMigrationLadder,
  type MigrationStep,
  type StorageFixture,
  type StoredEntry,
} from './storageMigrationCompat';

const TARGET = 2;

function fixture(version: number, entries: StoredEntry[] = []): StorageFixture {
  return { contract: 'YieldVault', version, entries };
}

/** Captured from a vault deployed before schema versions were recorded. */
const v0Entries: StoredEntry[] = [
  { key: 'Admin', value: 'GADMIN' },
  { key: 'TotalShares', value: 10 },
  { key: 'UserPosition:GA', value: { shares: 6, ledger: 41 } },
  { key: 'UserPosition:GB', value: { shares: 4, ledger: 42 } },
  { key: 'Config', value: { fee_bps: 100, label: 'vault' } },
];

const addClaimLedger: MigrationStep = {
  from: 0,
  to: 1,
  description: 'add UserPosition.last_claim_ledger',
  migrate: (entries) =>
    entries.map((entry) =>
      entry.key.startsWith('UserPosition:')
        ? {
            key: entry.key,
            value: {
              ...(entry.value as Record<string, unknown>),
              last_claim_ledger: (entry.value as Record<string, unknown>).ledger,
            },
          }
        : entry,
    ),
};

const renameFeeField: MigrationStep = {
  from: 1,
  to: 2,
  description: 'rename Config.fee_bps to Config.fee_basis_points',
  migrate: (entries) =>
    entries.map((entry) => {
      if (entry.key !== 'Config') return entry;
      const value = entry.value as Record<string, unknown>;
      // Guarded so the step is safe to replay: the old field is only renamed
      // when it is still there.
      if (!('fee_bps' in value)) return entry;
      const { fee_bps, ...rest } = value;
      return { key: entry.key, value: { ...rest, fee_basis_points: fee_bps } };
    }),
};

const ladder: MigrationStep[] = [addClaimLedger, renameFeeField];

describe('checkMigrationCompatibility — normal behaviour', () => {
  it('migrates a pre-versioning fixture all the way to the target', () => {
    const result = checkMigrationCompatibility(fixture(0, v0Entries), TARGET, ladder);

    expect(result.compatible).toBe(true);
    expect(result.fromVersion).toBe(0);
    expect(result.targetVersion).toBe(2);
    expect(result.appliedSteps).toEqual([
      { from: 0, to: 1, description: 'add UserPosition.last_claim_ledger' },
      { from: 1, to: 2, description: 'rename Config.fee_bps to Config.fee_basis_points' },
    ]);
    expect(result.issues.filter((issue) => issue.severity === 'blocker')).toEqual([]);

    const position = result.entries?.find((entry) => entry.key === 'UserPosition:GA');
    expect(position?.value).toEqual({ shares: 6, ledger: 41, last_claim_ledger: 41 });
    const config = result.entries?.find((entry) => entry.key === 'Config');
    expect(config?.value).toEqual({ fee_basis_points: 100, label: 'vault' });
    expect(result.lostKeys).toEqual([]);
  });

  it('carries entries the ladder does not know about untouched', () => {
    const entries: StoredEntry[] = [
      ...v0Entries,
      { key: 'FutureFlag:beta', value: { enabled: true, rollout: 3 } },
    ];

    const result = checkMigrationCompatibility(fixture(0, entries), TARGET, ladder);

    expect(result.compatible).toBe(true);
    expect(result.entries?.find((entry) => entry.key === 'FutureFlag:beta')?.value).toEqual({
      enabled: true,
      rollout: 3,
    });
  });

  it('reports a fixture already at the target as a compatible no-op', () => {
    const result = checkMigrationCompatibility(fixture(TARGET, v0Entries), TARGET, ladder);

    expect(result.compatible).toBe(true);
    expect(result.appliedSteps).toEqual([]);
    expect(result.entries).toHaveLength(v0Entries.length);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'missing_step', severity: 'warning' }),
    ]);
    expect(result.issues[0].message).toContain('no-op');
  });

  it('tracks keys the migration introduces', () => {
    const withMarker: MigrationStep = {
      from: 0,
      to: 1,
      description: 'record the layout in storage',
      migrate: (entries) =>
        entries.some((entry) => entry.key === 'LayoutVersion')
          ? entries
          : [...entries, { key: 'LayoutVersion', value: 1 }],
    };

    const result = checkMigrationCompatibility(fixture(0, v0Entries), 1, [withMarker]);

    expect(result.compatible).toBe(true);
    expect(result.addedKeys).toEqual(['LayoutVersion']);
    expect(result.lostKeys).toEqual([]);
  });

  it('does not mutate the captured fixture', () => {
    const original = fixture(0, [
      { key: 'Config', value: { fee_bps: 100 } },
    ]);
    const before = JSON.parse(JSON.stringify(original));

    const mutating: MigrationStep = {
      from: 0,
      to: 1,
      description: 'mutates its input (which the harness must copy)',
      migrate: (entries) => {
        (entries[0].value as Record<string, unknown>).mutated = true;
        return entries.map((entry) => entry);
      },
    };

    checkMigrationCompatibility(original, 1, [mutating]);

    expect(original).toEqual(before);
  });

  it('handles an empty fixture (freshly deployed contract)', () => {
    const result = checkMigrationCompatibility(fixture(0), TARGET, ladder);

    expect(result.compatible).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.addedKeys).toEqual([]);
    expect(result.lostKeys).toEqual([]);
  });
});

describe('checkMigrationCompatibility — boundary behaviour', () => {
  it('allows a step that lands exactly on the target', () => {
    const result = checkMigrationCompatibility(fixture(1, v0Entries), TARGET, ladder);

    expect(result.compatible).toBe(true);
    expect(result.appliedSteps).toEqual([ladder[1]].map((step) => ({
      from: step.from,
      to: step.to,
      description: step.description,
    })));
  });

  it('treats a version 0 fixture targeting 0 as compatible', () => {
    const result = checkMigrationCompatibility(fixture(0, v0Entries), 0, ladder);

    expect(result.compatible).toBe(true);
    expect(result.appliedSteps).toEqual([]);
    expect(result.entries).toEqual(v0Entries);
  });

  it('blocks a ladder that jumps past the target', () => {
    const jump: MigrationStep = {
      from: 1,
      to: 3,
      description: 'skips version 2',
      migrate: (entries) => entries,
    };

    const result = checkMigrationCompatibility(fixture(1, v0Entries), 2, [jump]);

    expect(result.compatible).toBe(false);
    expect(result.entries).toBeNull();
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'missing_step', severity: 'blocker' }),
    ]);
    expect(result.issues[0].message).toContain('past the target');
  });

  it('blocks a ladder that has no step at the fixture version', () => {
    const result = checkMigrationCompatibility(fixture(1, v0Entries), 2, [addClaimLedger]);

    expect(result.compatible).toBe(false);
    expect(result.issues[0].code).toBe('missing_step');
    expect(result.issues[0].message).toContain('starts at version 1');
  });

  it('blocks a downgrade instead of reading newer data as older', () => {
    const result = checkMigrationCompatibility(fixture(3, v0Entries), 2, ladder);

    expect(result.compatible).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'downgrade', severity: 'blocker' }),
    ]);
    expect(result.issues[0].message).toContain('only move forward');
  });

  it('blocks a migration that silently drops stored keys by default', () => {
    const dropAdmin: MigrationStep = {
      from: 0,
      to: 1,
      description: 'forget the admin entry',
      migrate: (entries) => entries.filter((entry) => entry.key !== 'Admin'),
    };

    const result = checkMigrationCompatibility(fixture(0, v0Entries), 1, [dropAdmin]);

    expect(result.compatible).toBe(false);
    expect(result.lostKeys).toEqual(['Admin']);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'data_loss', severity: 'blocker' }),
    ]);
  });

  it('allows a declared key removal with a warning', () => {
    const dropAdmin: MigrationStep = {
      from: 0,
      to: 1,
      description: 'remove the admin entry after moving it to a dedicated key',
      migrate: (entries) => entries.filter((entry) => entry.key !== 'Admin'),
    };

    const result = checkMigrationCompatibility(fixture(0, v0Entries), 1, [dropAdmin], {
      allowKeyRemoval: true,
    });

    expect(result.compatible).toBe(true);
    expect(result.entries?.some((entry) => entry.key === 'Admin')).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'data_loss', severity: 'warning' }),
    ]);
  });

  it('rejects a non-integer fixture version', () => {
    const result = checkMigrationCompatibility(fixture(1.5, v0Entries), TARGET, ladder);

    expect(result.compatible).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('invalid_fixture');
  });

  it('rejects a negative target version', () => {
    const result = checkMigrationCompatibility(fixture(0, v0Entries), -1, ladder);

    expect(result.compatible).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'invalid_target_version', severity: 'blocker' }),
    ]);
  });

  it('rejects a fixture with duplicate keys', () => {
    const result = checkMigrationCompatibility(
      fixture(0, [
        { key: 'Config', value: { fee_bps: 100 } },
        { key: 'Config', value: { fee_bps: 200 } },
      ]),
      TARGET,
      ladder,
    );

    expect(result.compatible).toBe(false);
    expect(result.issues[0].code).toBe('invalid_fixture');
    expect(result.issues[0].message).toContain('appears twice');
  });

  it('rejects a fixture with a value that cannot be serialised', () => {
    const result = checkMigrationCompatibility(
      fixture(0, [{ key: 'TotalShares', value: Number.NaN }]),
      TARGET,
      ladder,
    );

    expect(result.compatible).toBe(false);
    expect(result.issues[0].code).toBe('invalid_fixture');
    expect(result.issues[0].message).toContain('cannot be serialised');
  });

  it('rejects a fixture that is not an object', () => {
    const result = checkMigrationCompatibility(
      null as unknown as StorageFixture,
      TARGET,
      ladder,
    );

    expect(result.compatible).toBe(false);
    expect(result.issues[0].code).toBe('invalid_fixture');
    expect(result.contract).toBe('(unnamed contract)');
  });

  it('validates a ladder structurally before walking it', () => {
    const duplicate: MigrationStep = { ...addClaimLedger, to: 1 };
    const nonIncreasing: MigrationStep = {
      from: 1,
      to: 1,
      description: 'does not move',
      migrate: (entries) => entries,
    };
    const blank: MigrationStep = { ...nonIncreasing, from: 2, to: 3, description: '  ' };

    const bad = validateMigrationLadder([addClaimLedger, duplicate, nonIncreasing, blank]);
    expect(bad.valid).toBe(false);
    expect(bad.errors.join('\n')).toContain('ladder is ambiguous');
    expect(bad.errors.join('\n')).toContain('must move forward');
    expect(bad.errors.join('\n')).toContain('needs a description');

    expect(validateMigrationLadder(ladder)).toEqual({ valid: true, errors: [] });
  });

  it('reports a structurally invalid ladder as blockers instead of throwing', () => {
    const result = checkMigrationCompatibility(fixture(0, v0Entries), TARGET, [
      addClaimLedger,
      { ...renameFeeField, from: 0 },
    ]);

    expect(result.compatible).toBe(false);
    expect(result.entries).toBeNull();
    expect(result.issues.every((issue) => issue.code === 'invalid_step')).toBe(true);
  });
});

describe('checkMigrationCompatibility — failure behaviour', () => {
  it('reports a throwing step instead of propagating the exception', () => {
    const throwing: MigrationStep = {
      from: 0,
      to: 1,
      description: 'decodes a layout that does not match the fixture',
      migrate: () => {
        throw new Error('unexpected UserPosition layout');
      },
    };

    const result = checkMigrationCompatibility(fixture(0, v0Entries), 1, [throwing]);

    expect(result.compatible).toBe(false);
    expect(result.entries).toBeNull();
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'migration_failed', severity: 'blocker' }),
    ]);
    expect(result.issues[0].message).toContain('unexpected UserPosition layout');
  });

  it('reports a step that returns something other than a list', () => {
    const badReturn: MigrationStep = {
      from: 0,
      to: 1,
      description: 'returns a map',
      // Deliberately wrong: a migration must return the full entry list.
      migrate: () => ({}) as unknown as StoredEntry[],
    };

    const result = checkMigrationCompatibility(fixture(0, v0Entries), 1, [badReturn]);

    expect(result.compatible).toBe(false);
    expect(result.issues[0].message).toContain('must return an array of entries');
  });

  it('reports a step that returns an entry without a key', () => {
    const badEntry: MigrationStep = {
      from: 0,
      to: 1,
      description: 'returns an anonymous entry',
      migrate: () => [{ value: 1 } as unknown as StoredEntry],
    };

    const result = checkMigrationCompatibility(fixture(0, v0Entries), 1, [badEntry]);

    expect(result.compatible).toBe(false);
    expect(result.issues[0].message).toContain('without a string key');
  });

  it('blocks a migration that changes data again when replayed', () => {
    const increments: MigrationStep = {
      from: 0,
      to: 1,
      description: 'adds one to TotalShares (not idempotent)',
      migrate: (entries) =>
        entries.map((entry) =>
          entry.key === 'TotalShares'
            ? { key: entry.key, value: (entry.value as number) + 1 }
            : entry,
        ),
    };

    const result = checkMigrationCompatibility(fixture(0, v0Entries), 1, [increments]);

    expect(result.compatible).toBe(false);
    expect(result.entries).toBeNull();
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'not_idempotent', severity: 'blocker' }),
    ]);
    expect(result.issues[0].message).toContain('would apply the work twice');
  });

  it('can skip the idempotency replay when a ladder cannot be replayed', () => {
    const increments: MigrationStep = {
      from: 0,
      to: 1,
      description: 'adds one to TotalShares',
      migrate: (entries) =>
        entries.map((entry) =>
          entry.key === 'TotalShares'
            ? { key: entry.key, value: (entry.value as number) + 1 }
            : entry,
        ),
    };

    const result = checkMigrationCompatibility(fixture(0, v0Entries), 1, [increments], {
      checkIdempotency: false,
    });

    expect(result.compatible).toBe(true);
    expect(result.entries?.find((entry) => entry.key === 'TotalShares')?.value).toBe(11);
  });

  it('assertMigrationCompatible throws with every blocker and returns the result otherwise', () => {
    expect(() =>
      assertMigrationCompatible(fixture(3, v0Entries), TARGET, ladder),
    ).toThrow(MigrationCompatibilityError);

    try {
      assertMigrationCompatible(fixture(3, v0Entries), TARGET, ladder);
      throw new Error('expected the assertion to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MigrationCompatibilityError);
      expect((err as MigrationCompatibilityError).message).toContain('downgrade');
      expect((err as MigrationCompatibilityError).issues).toHaveLength(1);
    }

    const result = assertMigrationCompatible(fixture(0, v0Entries), TARGET, ladder);
    expect(result.compatible).toBe(true);
    expect(result.appliedSteps).toHaveLength(2);
  });

  it('formats a failure report that names the step and the blocker', () => {
    const report = formatMigrationCompatibilityReport(
      checkMigrationCompatibility(fixture(0, v0Entries), 1, [
        {
          from: 0,
          to: 1,
          description: 'rename TotalShares to total_shares',
          migrate: () => {
            throw new Error('decode failed at entry 2');
          },
        },
      ]),
    );

    expect(report).toContain('storage migration: YieldVault v0 → v1');
    expect(report).toContain('result: NOT compatible');
    expect(report).toContain('decode failed at entry 2');
    expect(report).toContain('blockers:');
  });

  it('formats a compatible report with its steps and added keys', () => {
    const report = formatMigrationCompatibilityReport(
      checkMigrationCompatibility(fixture(0, v0Entries), TARGET, ladder),
    );

    expect(report).toContain('result: compatible');
    expect(report).toContain('0 → 1: add UserPosition.last_claim_ledger');
    expect(report).toContain('1 → 2: rename Config.fee_bps');
    expect(report).not.toContain('blockers:');
  });
});
