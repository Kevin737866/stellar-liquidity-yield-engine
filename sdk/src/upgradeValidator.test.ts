import {
  UPGRADE_STAGES,
  formatUpgradeReport,
  validateUpgrade,
  type UpgradeValidationInput,
} from './upgradeValidator';

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const ADMIN = 'GADMIN';

function input(overrides: Partial<UpgradeValidationInput> = {}): UpgradeValidationInput {
  return {
    oldWasmHash: OLD,
    newWasmHash: NEW,
    signerAddress: ADMIN,
    storedAdmin: ADMIN,
    currentStorageVersion: 1,
    targetStorageVersion: 1,
    migrationReversible: true,
    installedWasmHashes: [OLD, NEW],
    ...overrides,
  };
}

describe('validateUpgrade', () => {
  it('passes every stage in order for a healthy upgrade', () => {
    const report = validateUpgrade(input());
    expect(report.ok).toBe(true);
    expect(report.results.map((r) => r.stage)).toEqual([...UPGRADE_STAGES]);
    expect(report.migrationRequired).toBe(false);
  });

  it('flags that migrate is needed when the target version is newer', () => {
    const report = validateUpgrade(input({ currentStorageVersion: 0, targetStorageVersion: 1 }));
    expect(report.ok).toBe(true);
    expect(report.migrationRequired).toBe(true);
  });

  it('rejects malformed, missing and identical hashes at the inputs stage', () => {
    expect(validateUpgrade(input({ oldWasmHash: '' })).failedStage).toBe('inputs');
    expect(validateUpgrade(input({ newWasmHash: 'xyz' })).failedStage).toBe('inputs');
    expect(validateUpgrade(input({ newWasmHash: OLD.toUpperCase() })).failedStage).toBe('inputs');
  });

  it('stops at the first failure and does not evaluate later stages', () => {
    const report = validateUpgrade(input({ oldWasmHash: 'bad', signerAddress: 'GOTHER' }));
    expect(report.failedStage).toBe('inputs');
    expect(report.results).toHaveLength(1);
  });

  it('rejects a signer that is not the stored admin, or an unreadable admin', () => {
    expect(validateUpgrade(input({ signerAddress: 'GOTHER' })).failedStage).toBe('admin');
    expect(validateUpgrade(input({ storedAdmin: null })).failedStage).toBe('admin');
    expect(validateUpgrade(input({ signerAddress: '' })).failedStage).toBe('admin');
  });

  it('rejects an unreadable, negative or newer-than-target storage version', () => {
    expect(validateUpgrade(input({ currentStorageVersion: null })).failedStage).toBe('version');
    expect(validateUpgrade(input({ currentStorageVersion: -1 })).failedStage).toBe('version');
    const downgrade = validateUpgrade(input({ currentStorageVersion: 3, targetStorageVersion: 2 }));
    expect(downgrade.failedStage).toBe('version');
    expect(downgrade.results[2].message).toContain('downgrade');
  });

  it('blocks an irreversible migration unless it is acknowledged', () => {
    const base = { currentStorageVersion: 0, targetStorageVersion: 1, migrationReversible: false };
    expect(validateUpgrade(input(base)).failedStage).toBe('migration');
    expect(validateUpgrade(input({ ...base, acceptIrreversible: true })).ok).toBe(true);
  });

  it('does not require reversibility when no migration is needed', () => {
    expect(validateUpgrade(input({ migrationReversible: false })).ok).toBe(true);
  });

  it('requires both the rollback and new hashes to be installed (case-insensitive)', () => {
    expect(validateUpgrade(input({ installedWasmHashes: [NEW] })).failedStage).toBe('rollback');
    expect(validateUpgrade(input({ installedWasmHashes: [OLD] })).failedStage).toBe('rollback');
    expect(
      validateUpgrade(input({ installedWasmHashes: [OLD.toUpperCase(), NEW.toUpperCase()] })).ok,
    ).toBe(true);
  });
});

describe('formatUpgradeReport', () => {
  it('summarises a pass and a block', () => {
    expect(formatUpgradeReport(validateUpgrade(input()))).toContain('READY: safe to upgrade');
    const blocked = formatUpgradeReport(validateUpgrade(input({ signerAddress: 'GOTHER' })));
    expect(blocked).toContain('FAIL admin');
    expect(blocked).toContain('BLOCKED at stage "admin"');
  });
});
