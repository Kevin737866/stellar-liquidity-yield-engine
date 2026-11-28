/**
 * Staged upgrade validation tests (Issue #501).
 *
 * Each case supplies the evidence an operator would have at that point in the
 * procedure and asserts which stage is next, which one is blocked and why.
 */

import {
  assertStagedUpgradeReady,
  formatStagedUpgradePlan,
  planStagedUpgrade,
  StagedUpgradeValidationError,
  WASM_HASH_PATTERN,
  type StagedUpgradeEvidence,
  type StagedUpgradeStageId,
} from './stagedUpgrade';

const NEW_HASH = 'a'.repeat(64);
const OLD_HASH = 'b'.repeat(64);

/** A production upgrade with every pre-promotion gate satisfied. */
function ready(overrides: Partial<StagedUpgradeEvidence> = {}): StagedUpgradeEvidence {
  return {
    contractId: 'CPRODUCTION',
    production: true,
    wasmHash: NEW_HASH,
    previousWasmHash: OLD_HASH,
    adminKeyAvailable: true,
    wasmInstalled: true,
    liveStorageVersion: 1,
    targetStorageVersion: 2,
    migrationRequired: true,
    migrationIdempotent: true,
    simulationPassed: true,
    stagingContractId: 'CSTAGING',
    stagingVerified: true,
    smokeChecksPassed: true,
    snapshotTaken: true,
    rollbackPlan: 'Install OLD_HASH and upgrade back to it; restore the snapshot if migrate changed data.',
    approvals: 2,
    ...overrides,
  };
}

function stageStatus(evidence: StagedUpgradeEvidence, id: StagedUpgradeStageId) {
  return planStagedUpgrade(evidence).stages.find((stage) => stage.id === id)?.status;
}

describe('planStagedUpgrade — normal behaviour', () => {
  it('reports every pre-promotion stage complete and promote ready', () => {
    const plan = planStagedUpgrade(ready());

    expect(plan.canPromote).toBe(true);
    expect(plan.nextStage).toBe('promote');
    expect(plan.blockers).toEqual([]);
    expect(plan.stages.map((stage) => [stage.id, stage.status])).toEqual([
      ['preflight', 'complete'],
      ['install', 'complete'],
      ['simulate', 'complete'],
      ['staging', 'complete'],
      ['promote', 'ready'],
      ['verify', 'pending'],
      ['closeout', 'pending'],
    ]);
    expect(plan.approvals).toEqual({ collected: 2, required: 2 });
    expect(plan.migrationRequired).toBe(true);
  });

  it('walks through promotion, verification and closeout', () => {
    const plan = planStagedUpgrade(
      ready({
        promoted: true,
        postUpgradeVerified: true,
        migrationCompleted: true,
        keepersResumed: true,
      }),
    );

    expect(plan.nextStage).toBeNull();
    expect(plan.canPromote).toBe(false);
    expect(plan.stages.every((stage) => stage.status === 'complete')).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it('marks a code-only upgrade as needing no migration', () => {
    const plan = planStagedUpgrade(
      ready({ targetStorageVersion: 1, migrationRequired: false, migrationIdempotent: undefined }),
    );

    expect(plan.migrationRequired).toBe(false);
    expect(plan.canPromote).toBe(true);
    expect(plan.warnings.join('\n')).toContain('code-only upgrade');
  });

  it('skips staging on a non-production contract and needs one approval', () => {
    const plan = planStagedUpgrade(
      ready({ production: false, stagingContractId: undefined, stagingVerified: undefined, smokeChecksPassed: undefined, approvals: undefined }),
    );

    expect(stageStatus(ready({ production: false }), 'staging')).toBe('skipped');
    expect(plan.approvals).toEqual({ collected: 0, required: 1 });
    expect(plan.canPromote).toBe(false);
    expect(plan.nextStage).toBe('promote');
    expect(plan.stages.find((stage) => stage.id === 'promote')?.blockers).toEqual([
      'promotion needs 1 approval(s); 0 collected',
    ]);
  });

  it('allows a non-production promotion once its single approval is collected', () => {
    const plan = planStagedUpgrade(
      ready({
        production: false,
        stagingContractId: undefined,
        stagingVerified: undefined,
        smokeChecksPassed: undefined,
        approvals: 1,
      }),
    );

    expect(plan.canPromote).toBe(true);
    expect(stageStatus(ready({ production: false, approvals: 1 }), 'staging')).toBe('skipped');
  });

  it('does not require a previous hash for a non-production upgrade', () => {
    const plan = planStagedUpgrade(
      ready({
        production: false,
        previousWasmHash: undefined,
        stagingContractId: undefined,
        stagingVerified: undefined,
        smokeChecksPassed: undefined,
        approvals: 1,
      }),
    );

    expect(plan.canPromote).toBe(true);
    expect(plan.warnings.join('\n')).toContain('no previous wasm hash');
  });
});

describe('planStagedUpgrade — boundary behaviour', () => {
  it('starts at install when nothing has been executed yet', () => {
    const plan = planStagedUpgrade(
      ready({ wasmInstalled: false, simulationPassed: false, stagingVerified: false, smokeChecksPassed: false, approvals: 0 }),
    );

    expect(plan.nextStage).toBe('install');
    expect(plan.canPromote).toBe(false);
    expect(stageStatus(ready({ wasmInstalled: false }), 'simulate')).toBe('pending');
    expect(stageStatus(ready({ wasmInstalled: false }), 'staging')).toBe('pending');
  });

  it('accepts exactly the required approvals and rejects one short', () => {
    expect(planStagedUpgrade(ready({ approvals: 2 })).canPromote).toBe(true);

    const short = planStagedUpgrade(ready({ approvals: 1 }));
    expect(short.canPromote).toBe(false);
    expect(short.blockers).toEqual(['promotion needs 2 approval(s); 1 collected']);
  });

  it('accepts more approvals than required', () => {
    const plan = planStagedUpgrade(ready({ approvals: 4 }));

    expect(plan.canPromote).toBe(true);
    expect(plan.approvals).toEqual({ collected: 4, required: 2 });
  });

  it('treats a zero approval requirement as a misconfiguration', () => {
    const plan = planStagedUpgrade(ready({ requiredApprovals: 0 }));

    expect(plan.canPromote).toBe(false);
    expect(plan.blockers.join('\n')).toContain('positive integer');
  });

  it('rejects negative or fractional approval counts', () => {
    expect(planStagedUpgrade(ready({ requiredApprovals: -1 })).blockers.join('\n')).toContain(
      'positive integer',
    );
    expect(planStagedUpgrade(ready({ approvals: 1.5 })).blockers.join('\n')).toContain(
      'approvals must be a non-negative integer',
    );
  });

  it('accepts an uppercase wasm hash and compares hashes case-insensitively', () => {
    const plan = planStagedUpgrade(ready({ wasmHash: NEW_HASH.toUpperCase() }));

    expect(WASM_HASH_PATTERN.test(NEW_HASH.toUpperCase())).toBe(true);
    expect(plan.canPromote).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it('does not require staging evidence when the contract is not production', () => {
    const plan = planStagedUpgrade(
      ready({
        production: false,
        stagingContractId: undefined,
        stagingVerified: undefined,
        smokeChecksPassed: undefined,
        approvals: 1,
      }),
    );

    expect(plan.stages.find((stage) => stage.id === 'staging')?.status).toBe('skipped');
    expect(plan.canPromote).toBe(true);
  });
});

describe('planStagedUpgrade — failure behaviour', () => {
  it('blocks preflight when the target wasm hash is missing', () => {
    const plan = planStagedUpgrade(ready({ wasmHash: undefined }));

    expect(plan.stages[0].status).toBe('blocked');
    expect(plan.blockers[0]).toContain('no target wasm hash');
    expect(plan.nextStage).toBe('preflight');
    expect(plan.canPromote).toBe(false);
  });

  it('blocks a malformed wasm hash', () => {
    const plan = planStagedUpgrade(ready({ wasmHash: 'deadbeef' }));

    expect(plan.blockers.join('\n')).toContain('64 characters');
  });

  it('blocks when the rollback target is the build being promoted', () => {
    const plan = planStagedUpgrade(ready({ previousWasmHash: NEW_HASH.toUpperCase() }));

    expect(plan.blockers.join('\n')).toContain('there is no new code to promote');
  });

  it('blocks a schema downgrade', () => {
    const plan = planStagedUpgrade(ready({ liveStorageVersion: 3, targetStorageVersion: 2 }));

    expect(plan.blockers.join('\n')).toContain('older than the live one');
  });

  it('blocks a migration whose target version does not move', () => {
    const plan = planStagedUpgrade(ready({ liveStorageVersion: 2, targetStorageVersion: 2 }));

    expect(plan.blockers.join('\n')).toContain('bump STORAGE_VERSION');
  });

  it('blocks a migration that is not declared idempotent', () => {
    const plan = planStagedUpgrade(ready({ migrationIdempotent: false }));

    expect(plan.blockers.join('\n')).toContain('not declared idempotent');
  });

  it('blocks a production upgrade without a snapshot or rollback plan', () => {
    const plan = planStagedUpgrade(ready({ snapshotTaken: false, rollbackPlan: '   ' }));

    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no pre-change snapshot'),
        expect.stringContaining('no rollback plan'),
      ]),
    );
  });

  it('blocks when the admin key is unavailable', () => {
    const plan = planStagedUpgrade(ready({ adminKeyAvailable: false }));

    expect(plan.blockers.join('\n')).toContain('admin key is not available');
  });

  it('blocks staging when it points at the production address', () => {
    const plan = planStagedUpgrade(
      ready({ stagingContractId: 'CPRODUCTION', approvals: 2 }),
    );

    const staging = plan.stages.find((stage) => stage.id === 'staging');
    expect(staging?.status).toBe('blocked');
    expect(staging?.blockers.join('\n')).toContain('must be a separate address');
    expect(plan.canPromote).toBe(false);
    expect(plan.nextStage).toBe('staging');
  });

  it('blocks promotion for a production contract until staging is verified', () => {
    const plan = planStagedUpgrade(
      ready({ stagingContractId: undefined, stagingVerified: false, smokeChecksPassed: false }),
    );

    expect(stageStatus(ready({ stagingContractId: undefined, stagingVerified: false }), 'staging')).toBe('ready');
    expect(stageStatus(ready({ stagingContractId: undefined, stagingVerified: false }), 'promote')).toBe('pending');
    expect(plan.canPromote).toBe(false);
    expect(plan.nextStage).toBe('staging');
  });

  it('blocks promotion without smoke checks on staging', () => {
    const plan = planStagedUpgrade(ready({ smokeChecksPassed: false }));

    expect(plan.canPromote).toBe(false);
    expect(plan.nextStage).toBe('staging');
  });

  it('flags a promotion recorded without its prerequisites as an incident', () => {
    const plan = planStagedUpgrade(ready({ promoted: true, simulationPassed: false }));

    const promote = plan.stages.find((stage) => stage.id === 'promote');
    expect(promote?.status).toBe('blocked');
    expect(promote?.blockers.join('\n')).toContain('treat this as an incident');
    expect(plan.blockers.join('\n')).toContain('prerequisites are not complete');
  });

  it('blocks verification when the code is live but the schema was not migrated', () => {
    const plan = planStagedUpgrade(
      ready({ promoted: true, postUpgradeVerified: true, migrationCompleted: false, keepersResumed: false }),
    );

    const verify = plan.stages.find((stage) => stage.id === 'verify');
    expect(verify?.status).toBe('blocked');
    expect(verify?.blockers.join('\n')).toContain('keep user flows frozen');
    expect(plan.nextStage).toBe('verify');
  });

  it('requires migration completion before verification for a layout change', () => {
    const migrated = planStagedUpgrade(
      ready({ promoted: true, postUpgradeVerified: true, migrationCompleted: true }),
    );

    expect(stageStatus(ready({ promoted: true, postUpgradeVerified: true, migrationCompleted: true }), 'verify')).toBe('complete');
    expect(migrated.nextStage).toBe('closeout');
  });

  it('warns when keepers are resumed before verification', () => {
    const plan = planStagedUpgrade(ready({ keepersResumed: true }));

    expect(plan.warnings.join('\n')).toContain('resumed before post-upgrade verification');
    expect(plan.nextStage).toBe('promote');
  });

  it('blocks preflight when a storage version is missing', () => {
    const plan = planStagedUpgrade(ready({ liveStorageVersion: undefined, targetStorageVersion: undefined }));

    expect(plan.blockers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('live schema version is missing'),
        expect.stringContaining('target schema version is missing'),
      ]),
    );
    expect(plan.fromStorageVersion).toBeNaN();
  });

  it('assertStagedUpgradeReady throws with the blockers when a gate is unmet', () => {
    expect(() => assertStagedUpgradeReady(ready({ approvals: 0 }))).toThrow(
      StagedUpgradeValidationError,
    );

    try {
      assertStagedUpgradeReady(ready({ promoted: true, simulationPassed: false }));
      throw new Error('expected the assertion to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(StagedUpgradeValidationError);
      const failure = err as StagedUpgradeValidationError;
      expect(failure.message).toContain('blocked at promote');
      expect(failure.plan.stages.find((stage) => stage.id === 'promote')?.status).toBe('blocked');
    }

    const plan = assertStagedUpgradeReady(ready());
    expect(plan.canPromote).toBe(true);
  });

  it('formats a plan with stage statuses, the next stage and blockers', () => {
    const report = formatStagedUpgradePlan(planStagedUpgrade(ready({ approvals: 0 })));

    expect(report).toContain('staged upgrade: CPRODUCTION (production)');
    expect(report).toContain('schema: v1 → v2 (migration required)');
    expect(report).toContain('promote now: no');
    expect(report).toContain('next stage: promote');
    expect(report).toContain('promote  blocked [admin]');
    expect(report).toContain('promotion needs 2 approval(s); 0 collected');
  });

  it('formats a complete plan without a next stage', () => {
    const report = formatStagedUpgradePlan(
      planStagedUpgrade(
        ready({ promoted: true, postUpgradeVerified: true, migrationCompleted: true, keepersResumed: true }),
      ),
    );

    expect(report).toContain('next stage: none — upgrade complete');
    expect(report).not.toContain('warnings:');
  });
});
