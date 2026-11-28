import {
  PROTOCOL_CONFIG_BOUNDS,
  buildConfigMigrationChecklist,
  validateProtocolConfig,
  type ProtocolConfig,
  type ProtocolConfigChangeRequest,
} from './configMigration';

const CURRENT: ProtocolConfig = {
  performanceFee: 1000,
  withdrawalFee: 10,
  rebalanceThreshold: 200,
  insuranceReserveTarget: 15000,
};

function request(
  overrides: Partial<ProtocolConfigChangeRequest> = {},
): ProtocolConfigChangeRequest {
  return {
    current: CURRENT,
    next: { performanceFee: 1200 },
    governanceApproved: true,
    snapshotTaken: true,
    rollbackPlan: 'Re-apply performanceFee=1000 through the same governance flow.',
    ...overrides,
  };
}

describe('validateProtocolConfig', () => {
  it('accepts values exactly on both inclusive bounds', () => {
    const atMin = validateProtocolConfig({
      performanceFee: PROTOCOL_CONFIG_BOUNDS.performanceFee.min,
      withdrawalFee: PROTOCOL_CONFIG_BOUNDS.withdrawalFee.min,
      rebalanceThreshold: PROTOCOL_CONFIG_BOUNDS.rebalanceThreshold.min,
      insuranceReserveTarget: PROTOCOL_CONFIG_BOUNDS.insuranceReserveTarget.min,
    });
    const atMax = validateProtocolConfig({
      performanceFee: PROTOCOL_CONFIG_BOUNDS.performanceFee.max,
      withdrawalFee: PROTOCOL_CONFIG_BOUNDS.withdrawalFee.max,
      rebalanceThreshold: PROTOCOL_CONFIG_BOUNDS.rebalanceThreshold.max,
      insuranceReserveTarget: PROTOCOL_CONFIG_BOUNDS.insuranceReserveTarget.max,
    });

    expect(atMin).toEqual({ valid: true, errors: [] });
    expect(atMax).toEqual({ valid: true, errors: [] });
  });

  it('rejects one basis point outside each bound and names the field', () => {
    const below = validateProtocolConfig({
      ...CURRENT,
      performanceFee: PROTOCOL_CONFIG_BOUNDS.performanceFee.min - 1,
    });
    const above = validateProtocolConfig({
      ...CURRENT,
      withdrawalFee: PROTOCOL_CONFIG_BOUNDS.withdrawalFee.max + 1,
    });

    expect(below.valid).toBe(false);
    expect(below.errors.join(' ')).toMatch(/performanceFee must be between 500 and 1500/);
    expect(above.valid).toBe(false);
    expect(above.errors.join(' ')).toMatch(/withdrawalFee must be between 10 and 100/);
  });

  it('rejects fractional and non-finite basis points', () => {
    expect(
      validateProtocolConfig({ ...CURRENT, rebalanceThreshold: 200.5 }).errors.join(' '),
    ).toMatch(/rebalanceThreshold must be an integer/);
    expect(
      validateProtocolConfig({ ...CURRENT, insuranceReserveTarget: Number.NaN }).errors
        .join(' '),
    ).toMatch(/insuranceReserveTarget must be an integer/);
  });
});

describe('buildConfigMigrationChecklist', () => {
  it('reports a no-op without demanding approvals', () => {
    const checklist = buildConfigMigrationChecklist({
      current: CURRENT,
      next: { performanceFee: CURRENT.performanceFee },
    });

    expect(checklist.ready).toBe(true);
    expect(checklist.noop).toBe(true);
    expect(checklist.changes).toEqual([]);
    expect(checklist.steps).toEqual([]);
    expect(checklist.warnings.join(' ')).toMatch(/nothing to migrate/);
    expect(checklist.blockers).toEqual([]);
  });

  it('is ready for a fully specified parameter change', () => {
    const checklist = buildConfigMigrationChecklist(request());

    expect(checklist.ready).toBe(true);
    expect(checklist.blockers).toEqual([]);
    expect(checklist.changes).toEqual([
      { field: 'performanceFee', from: 1000, to: 1200 },
    ]);
    expect(checklist.requiresStorageVersionBump).toBe(false);
    expect(checklist.requiresKeeperRestart).toBe(false);
    expect(checklist.steps.join('\n')).toMatch(/Execute the parameter change/);
    expect(checklist.steps.join('\n')).not.toMatch(/migrate/);
  });

  it('blocks a change that skipped governance', () => {
    const checklist = buildConfigMigrationChecklist(
      request({ governanceApproved: false }),
    );

    expect(checklist.ready).toBe(false);
    expect(checklist.blockers.join(' ')).toMatch(/governance/);
  });

  it('blocks a change with no snapshot and no rollback plan', () => {
    const checklist = buildConfigMigrationChecklist(
      request({ snapshotTaken: false, rollbackPlan: '   ' }),
    );

    expect(checklist.ready).toBe(false);
    expect(checklist.blockers.join(' ')).toMatch(/snapshot/);
    expect(checklist.blockers.join(' ')).toMatch(/rollback plan/);
  });

  it('blocks an out-of-range target but still shows the intended change', () => {
    const checklist = buildConfigMigrationChecklist(
      request({ next: { withdrawalFee: 101 } }),
    );

    expect(checklist.ready).toBe(false);
    expect(checklist.changes).toEqual([
      { field: 'withdrawalFee', from: 10, to: 101 },
    ]);
    expect(checklist.blockers.join(' ')).toMatch(/outside 10–100 bps/);
  });

  it('blocks a current configuration that is already out of bounds', () => {
    const checklist = buildConfigMigrationChecklist(
      request({ current: { ...CURRENT, insuranceReserveTarget: 9000 } }),
    );

    expect(checklist.ready).toBe(false);
    expect(checklist.blockers.join(' ')).toMatch(/current config: insuranceReserveTarget/);
  });

  it('rejects unknown fields and fractional targets', () => {
    const unknown = buildConfigMigrationChecklist(
      request({ next: { maxLeverage: 2 } as ProtocolConfigChangeRequest['next'] }),
    );
    const fractional = buildConfigMigrationChecklist(
      request({ next: { performanceFee: 1200.5 } }),
    );

    expect(unknown.blockers.join(' ')).toMatch(/unknown configuration field: maxLeverage/);
    expect(fractional.blockers.join(' ')).toMatch(/performanceFee must be an integer/);
  });

  it('warns when several parameters move in one proposal', () => {
    const checklist = buildConfigMigrationChecklist(
      request({ next: { performanceFee: 1200, withdrawalFee: 20 } }),
    );

    expect(checklist.ready).toBe(true);
    expect(checklist.warnings.join(' ')).toMatch(/more than one parameter/);
  });

  describe('stored-layout changes', () => {
    it('requires a schema version bump and an idempotent migration', () => {
      const checklist = buildConfigMigrationChecklist(
        request({ scope: 'storage_layout' }),
      );

      expect(checklist.ready).toBe(false);
      expect(checklist.requiresStorageVersionBump).toBe(true);
      expect(checklist.blockers.join(' ')).toMatch(/live schema version/);
      expect(checklist.blockers.join(' ')).toMatch(/target schema version/);
      expect(checklist.blockers.join(' ')).toMatch(/safe to re-run/);
    });

    it('rejects a target version that does not move forward', () => {
      const checklist = buildConfigMigrationChecklist(
        request({
          scope: 'storage_layout',
          storageVersion: 2,
          targetStorageVersion: 2,
          migrationIdempotent: true,
        }),
      );

      expect(checklist.ready).toBe(false);
      expect(checklist.blockers.join(' ')).toMatch(/bump STORAGE_VERSION/);
    });

    it('is ready once the version moves and the migration is idempotent', () => {
      const checklist = buildConfigMigrationChecklist(
        request({
          scope: 'storage_layout',
          storageVersion: 1,
          targetStorageVersion: 2,
          migrationIdempotent: true,
        }),
      );

      expect(checklist.ready).toBe(true);
      expect(checklist.requiresStorageVersionBump).toBe(true);
      expect(checklist.steps.join('\n')).toMatch(/`upgrade\(admin, new_wasm_hash\)`/);
      expect(checklist.steps.join('\n')).toMatch(/`migrate\(admin\)`/);
      expect(checklist.warnings.join(' ')).toMatch(/next invocation/);
    });

    it('warns when a parameter-only change ships a newer schema version', () => {
      const checklist = buildConfigMigrationChecklist(
        request({ storageVersion: 1, targetStorageVersion: 2 }),
      );

      expect(checklist.ready).toBe(true);
      expect(checklist.requiresStorageVersionBump).toBe(false);
      expect(checklist.warnings.join(' ')).toMatch(/not `storage_layout`/);
    });
  });

  describe('derived-state changes', () => {
    it('blocks until keepers are informed', () => {
      const checklist = buildConfigMigrationChecklist(
        request({ scope: 'derived_state' }),
      );

      expect(checklist.ready).toBe(false);
      expect(checklist.requiresKeeperRestart).toBe(true);
      expect(checklist.blockers.join(' ')).toMatch(/restart them from their checkpoints/);
    });

    it('adds the keeper restart step once they are informed', () => {
      const checklist = buildConfigMigrationChecklist(
        request({ scope: 'derived_state', keepersInformed: true }),
      );

      expect(checklist.ready).toBe(true);
      expect(checklist.steps.join('\n')).toMatch(/Restart keepers from their checkpoints/);
    });
  });
});
