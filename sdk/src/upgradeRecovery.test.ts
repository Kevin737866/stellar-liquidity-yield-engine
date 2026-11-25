import {
  UpgradeRecoveryInputError,
  formatUpgradeRecoveryPlan,
  planUpgradeRecovery,
  type UpgradeRecoveryObservation,
} from './upgradeRecovery';

const PREVIOUS_HASH = 'a'.repeat(64);
const TARGET_HASH = 'b'.repeat(64);

function observe(
  overrides: Partial<UpgradeRecoveryObservation> = {},
): UpgradeRecoveryObservation {
  return {
    phase: 'upgrade_execution',
    liveCode: 'old',
    expectedStorageVersion: 2,
    ...overrides,
  };
}

describe('planUpgradeRecovery', () => {
  describe('a failed upgrade that changed nothing', () => {
    it('is safe to retry and needs the admin signature', () => {
      const plan = planUpgradeRecovery(
        observe({ reverted: true, storageVersion: 1 }),
      );

      expect(plan.outcome).toBe('retry');
      expect(plan.safeToRetry).toBe(true);
      expect(plan.severity).toBe('warning');
      expect(plan.blockers).toEqual([]);
      expect(plan.requiresAdmin).toBe(true);
      expect(plan.steps.map((step) => step.id)).toContain('retry-upgrade');
    });

    it('points at a wrong contract ID when the submission reported success', () => {
      const plan = planUpgradeRecovery(
        observe({ reverted: false, liveCode: 'old' }),
      );

      expect(plan.outcome).toBe('retry');
      expect(plan.warnings.join(' ')).toMatch(/contract ID and network/i);
    });

    it('records a missing target hash as a warning, not a blocker', () => {
      const plan = planUpgradeRecovery(observe({ targetWasmHash: undefined }));

      expect(plan.outcome).toBe('retry');
      expect(plan.blockers).toEqual([]);
      expect(plan.warnings.join(' ')).toMatch(/target wasm hash is unrecorded/i);
    });

    it('escalates instead of retrying when the admin signer is unavailable', () => {
      const plan = planUpgradeRecovery(
        observe({ reverted: true, adminKeyAvailable: false }),
      );

      expect(plan.outcome).toBe('manual_review');
      expect(plan.safeToRetry).toBe(false);
      expect(plan.blockers.join(' ')).toMatch(/Admin key unavailable/i);
    });
  });

  describe('new code on an older schema', () => {
    it('finishes forward by running migrate', () => {
      const plan = planUpgradeRecovery(
        observe({
          phase: 'migration',
          liveCode: 'new',
          storageVersion: 1,
          expectedStorageVersion: 2,
        }),
      );

      expect(plan.outcome).toBe('forward_fix');
      expect(plan.safeToRetry).toBe(false);
      expect(plan.requiresAdmin).toBe(true);
      expect(plan.steps.map((step) => step.id)).toContain('run-migrate');
      expect(plan.steps.find((step) => step.id === 'run-migrate')?.requiresAdmin).toBe(
        true,
      );
    });

    it('warns that a partially applied migration must be re-run idempotently', () => {
      const plan = planUpgradeRecovery(
        observe({
          phase: 'migration',
          liveCode: 'new',
          storageVersion: 1,
          mayHaveWrittenStorage: true,
        }),
      );

      expect(plan.outcome).toBe('forward_fix');
      expect(plan.warnings.join(' ')).toMatch(/must be idempotent/i);
    });

    it('escalates when migrate cannot be authorized', () => {
      const plan = planUpgradeRecovery(
        observe({
          phase: 'migration',
          liveCode: 'new',
          storageVersion: 1,
          adminKeyAvailable: false,
        }),
      );

      expect(plan.outcome).toBe('manual_review');
      expect(plan.severity).toBe('critical');
      expect(plan.blockers.join(' ')).toMatch(/stay paused/i);
    });
  });

  describe('new code on the expected schema', () => {
    it('ends in verification, not another upgrade', () => {
      const plan = planUpgradeRecovery(
        observe({
          phase: 'post_upgrade_verification',
          liveCode: 'new',
          storageVersion: 2,
        }),
      );

      expect(plan.outcome).toBe('forward_fix');
      expect(plan.severity).toBe('info');
      expect(plan.safeToRetry).toBe(false);
      expect(plan.steps.map((step) => step.id)).toEqual(
        expect.arrayContaining(['smoke-reads', 'resume-keepers']),
      );
    });

    it('warns when a failed migration left the version current anyway', () => {
      const plan = planUpgradeRecovery(
        observe({
          phase: 'migration',
          liveCode: 'new',
          storageVersion: 2,
          mayHaveWrittenStorage: true,
        }),
      );

      expect(plan.warnings.join(' ')).toMatch(/partial data/i);
    });

    it('keeps a paused contract paused until the checks pass', () => {
      const plan = planUpgradeRecovery(
        observe({
          phase: 'post_upgrade_verification',
          liveCode: 'new',
          storageVersion: 2,
          paused: true,
        }),
      );

      const unpause = plan.steps.find((step) => step.id === 'unpause');
      expect(unpause?.requiresAdmin).toBe(true);
      expect(plan.requiresAdmin).toBe(true);
    });
  });

  describe('new code on a newer schema', () => {
    it('rolls back to the recorded previous wasm hash', () => {
      const plan = planUpgradeRecovery(
        observe({
          phase: 'post_upgrade_verification',
          liveCode: 'new',
          storageVersion: 3,
          expectedStorageVersion: 2,
          previousWasmHash: PREVIOUS_HASH,
          targetWasmHash: TARGET_HASH,
        }),
      );

      expect(plan.outcome).toBe('rollback');
      expect(plan.severity).toBe('critical');
      expect(plan.requiresAdmin).toBe(true);
      const install = plan.steps.find((step) => step.id === 'install-previous');
      expect(install?.detail).toContain(PREVIOUS_HASH);
    });

    it('blocks the rollback when the previous hash was never recorded', () => {
      const plan = planUpgradeRecovery(
        observe({
          liveCode: 'new',
          storageVersion: 3,
          expectedStorageVersion: 2,
        }),
      );

      expect(plan.outcome).toBe('manual_review');
      expect(plan.blockers.join(' ')).toMatch(/Previous wasm hash unknown/i);
      expect(plan.steps.map((step) => step.id)).not.toContain('rollback-upgrade');
    });

    it('blocks the rollback when the admin signer is unavailable', () => {
      const plan = planUpgradeRecovery(
        observe({
          liveCode: 'new',
          storageVersion: 3,
          expectedStorageVersion: 2,
          previousWasmHash: PREVIOUS_HASH,
          adminKeyAvailable: false,
        }),
      );

      expect(plan.outcome).toBe('manual_review');
      expect(plan.blockers.join(' ')).toMatch(/signed rollback/i);
    });

    it('warns that code rollback does not undo newer storage writes', () => {
      const plan = planUpgradeRecovery(
        observe({
          phase: 'migration',
          liveCode: 'new',
          storageVersion: 3,
          expectedStorageVersion: 2,
          previousWasmHash: PREVIOUS_HASH,
          mayHaveWrittenStorage: true,
        }),
      );

      expect(plan.outcome).toBe('rollback');
      expect(plan.warnings.join(' ')).toMatch(/does not undo storage/i);
    });
  });

  describe('indeterminate and hazardous states', () => {
    it('refuses to act when the live code is unknown', () => {
      const plan = planUpgradeRecovery(observe({ liveCode: 'unknown' }));

      expect(plan.outcome).toBe('manual_review');
      expect(plan.severity).toBe('critical');
      expect(plan.steps[0].id).toBe('pause');
    });

    it('refuses to act when the schema version cannot be read', () => {
      const unreadable = planUpgradeRecovery(
        observe({ liveCode: 'new', storageVersion: null }),
      );
      const absent = planUpgradeRecovery(
        observe({ liveCode: 'new', storageVersion: undefined }),
      );

      expect(unreadable.outcome).toBe('manual_review');
      expect(absent.outcome).toBe('manual_review');
      expect(unreadable.blockers.join(' ')).toMatch(/get_storage_version/);
    });

    it('treats a reverted upgrade that reports new code as inconsistent', () => {
      const plan = planUpgradeRecovery(
        observe({ reverted: true, liveCode: 'new', storageVersion: 2 }),
      );

      expect(plan.outcome).toBe('manual_review');
      expect(plan.headline).toMatch(/inconsistent/i);
      expect(plan.steps.map((step) => step.id)).toContain('recheck-address');
    });

    it('prefers re-deployment when the admin key is compromised', () => {
      const plan = planUpgradeRecovery(
        observe({
          liveCode: 'new',
          storageVersion: 2,
          adminKeyCompromised: true,
        }),
      );

      expect(plan.outcome).toBe('redeploy');
      expect(plan.severity).toBe('critical');
      expect(plan.steps.map((step) => step.id)).toContain('deploy-new-address');
      expect(plan.warnings.join(' ')).toMatch(/still call `upgrade`/i);
    });
  });

  describe('input validation', () => {
    it('rejects a wasm hash that is not 32 bytes of hex', () => {
      expect(() =>
        planUpgradeRecovery(observe({ previousWasmHash: '0xdeadbeef' })),
      ).toThrow(UpgradeRecoveryInputError);
    });

    it('rejects a storage version that is not a non-negative integer', () => {
      expect(() =>
        planUpgradeRecovery(observe({ storageVersion: 1.5 })),
      ).toThrow(/storageVersion must be a non-negative integer/);
      expect(() =>
        planUpgradeRecovery(observe({ expectedStorageVersion: -1 })),
      ).toThrow(/expectedStorageVersion/);
    });

    it('rejects an unknown phase', () => {
      expect(() =>
        planUpgradeRecovery(
          observe({ phase: 'rollback' as UpgradeRecoveryObservation['phase'] }),
        ),
      ).toThrow(/unknown upgrade failure phase/);
    });
  });
});

describe('formatUpgradeRecoveryPlan', () => {
  it('renders the decision, blockers and numbered steps', () => {
    const plan = planUpgradeRecovery(
      observe({
        liveCode: 'new',
        storageVersion: 3,
        expectedStorageVersion: 2,
      }),
    );

    const text = formatUpgradeRecoveryPlan(plan);

    expect(text).toContain('Upgrade recovery: manual_review (critical)');
    expect(text).toContain('Safe to retry without review: no');
    expect(text).toContain('Blockers:');
    expect(text).toContain('  1. ');
  });

  it('marks admin steps in the rendered output', () => {
    const plan = planUpgradeRecovery(
      observe({ liveCode: 'new', storageVersion: 1 }),
    );

    expect(formatUpgradeRecoveryPlan(plan)).toContain('[admin]');
  });
});
