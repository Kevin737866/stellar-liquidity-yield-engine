/**
 * Tests for post-deployment smoke checks (Issue #511).
 *
 * All RPC calls are mocked via jest.spyOn so no network access is required.
 */

import { SorobanRpc } from 'stellar-sdk';
import {
  runSmokeChecks,
  probeStorageVersion,
  probeLiveness,
  formatSmokeCheckReport,
  extractU32,
  type SmokeCheckOptions,
  type SmokeCheckContracts,
} from './smokeCheck';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';

/** Minimal contract address stubs (56-character C-prefixed strings). */
const CONTRACTS: Required<SmokeCheckContracts> = {
  yieldEngine:       'CENGINEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  yieldVault:        'CVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
  rebalanceEngine:   'CREBALANCEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  rewardDistributor: 'CREWARDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
  strategyRegistry:  'CREGISTRYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
  ilInsurance:       'CINSURANCEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  actuary:           'CACTUARYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
};

/** Build a mock SorobanRpc.Server whose `simulateTransaction` returns a u32 XDR value. */
function makeMockServer(
  storageVersion: number | 'error' = 1,
  isPaused: boolean | 'error' = false,
): SorobanRpc.Server {
  const server = new SorobanRpc.Server(TESTNET_RPC);

  // Mock getAccount (needed for TransactionBuilder)
  jest.spyOn(server, 'getAccount').mockResolvedValue({
    accountId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    sequenceNumber: () => '1',
    sequence: '1',
    subentryCount: 0,
    // minimal AccountRecord fields required by TransactionBuilder
  } as unknown as SorobanRpc.Api.AccountRecord);

  jest.spyOn(server, 'simulateTransaction').mockImplementation(async (tx: unknown) => {
    // Determine which method was called by inspecting the transaction's
    // operation function name. We use the call sequence instead: the first
    // call per contract is get_storage_version, the second is is_paused.
    const mockFn = server.simulateTransaction as jest.Mock;
    const callIndex = mockFn.mock.calls.length - 1;
    const isVersionCall = callIndex % 2 === 0;

    if (isVersionCall && storageVersion === 'error') {
      return {
        error: 'ContractError: get_storage_version simulation failed',
        events: [],
        minResourceFee: '0',
        _parsed: false,
        latestLedger: 100,
      } as unknown as SorobanRpc.Api.SimulateTransactionErrorResponse;
    }

    if (!isVersionCall && isPaused === 'error') {
      return {
        error: 'ContractError: is_paused simulation failed',
        events: [],
        minResourceFee: '0',
        _parsed: false,
        latestLedger: 100,
      } as unknown as SorobanRpc.Api.SimulateTransactionErrorResponse;
    }

    // Return a successful simulation response with an scvU32 or scvBool value.
    const retval = isVersionCall
      ? { _type: 'scvU32', u32: storageVersion as number }
      : { _type: 'scvBool', b: isPaused as boolean };

    return {
      result: { retval, auth: [] },
      events: [],
      transactionData: '',
      minResourceFee: '100',
      latestLedger: 100,
    } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse;
  });

  return server;
}

/** Build a minimal `SmokeCheckOptions` with a custom mock server injected. */
function makeOptions(
  overrides: Partial<SmokeCheckOptions> = {},
  contractSubset: Partial<SmokeCheckContracts> = CONTRACTS,
): SmokeCheckOptions {
  return {
    sorobanRpcUrl: TESTNET_RPC,
    networkPassphrase: TESTNET_PASSPHRASE,
    contracts: contractSubset,
    expectedStorageVersion: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractU32
// ---------------------------------------------------------------------------

describe('extractU32', () => {
  it('returns a plain number directly', () => {
    expect(extractU32(1)).toBe(1);
    expect(extractU32(0)).toBe(0);
  });

  it('converts a BigInt', () => {
    expect(extractU32(BigInt(5))).toBe(5);
  });

  it('extracts from { u32: number } shape', () => {
    expect(extractU32({ u32: 3 })).toBe(3);
  });

  it('extracts from nested { value: { u32: number } } shape', () => {
    expect(extractU32({ value: { u32: 7 } })).toBe(7);
  });

  it('extracts from scvU32 XDR shape', () => {
    expect(extractU32({ _type: 'scvU32', u32: 42 })).toBe(42);
  });

  it('throws for null', () => {
    expect(() => extractU32(null)).toThrow();
  });

  it('throws for a non-numeric string', () => {
    expect(() => extractU32('not-a-number')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// probeStorageVersion
// ---------------------------------------------------------------------------

describe('probeStorageVersion', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes when the returned version matches the expected version', async () => {
    const server = makeMockServer(1);
    const result = await probeStorageVersion(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldVault, 'YieldVault', 1,
    );
    expect(result.passed).toBe(true);
    expect(result.returnValue).toBe(1);
  });

  it('passes when no expected version is provided', async () => {
    const server = makeMockServer(2);
    const result = await probeStorageVersion(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldVault, 'YieldVault',
    );
    expect(result.passed).toBe(true);
    expect(result.returnValue).toBe(2);
  });

  it('fails when the returned version does not match the expected version', async () => {
    const server = makeMockServer(2);
    const result = await probeStorageVersion(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldVault, 'YieldVault', 1,
    );
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/storage version mismatch/);
    expect(result.error).toMatch(/expected 1, got 2/);
  });

  it('fails gracefully when the simulation returns an error', async () => {
    const server = makeMockServer('error');
    const result = await probeStorageVersion(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldVault, 'YieldVault', 1,
    );
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/simulation error/i);
  });

  it('includes the contract address in the result', async () => {
    const server = makeMockServer(1);
    const result = await probeStorageVersion(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldVault, 'YieldVault', 1,
    );
    expect(result.contractAddress).toBe(CONTRACTS.yieldVault);
  });

  it('includes the entrypoint name in the label', async () => {
    const server = makeMockServer(1);
    const result = await probeStorageVersion(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldVault, 'YieldVault',
    );
    expect(result.label).toContain('get_storage_version');
  });
});

// ---------------------------------------------------------------------------
// probeLiveness
// ---------------------------------------------------------------------------

describe('probeLiveness', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes when is_paused call succeeds (false)', async () => {
    const server = makeMockServer(1, false);
    const result = await probeLiveness(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldEngine, 'YieldEngine',
    );
    expect(result.passed).toBe(true);
  });

  it('passes when is_paused returns true (paused is a valid post-deploy state)', async () => {
    const server = makeMockServer(1, true);
    const result = await probeLiveness(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldEngine, 'YieldEngine',
    );
    // liveness probe does not assert the boolean value
    expect(result.passed).toBe(true);
  });

  it('fails gracefully when the simulation returns an error', async () => {
    const server = makeMockServer(1, 'error');
    const result = await probeLiveness(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldEngine, 'YieldEngine',
    );
    expect(result.passed).toBe(false);
    expect(result.error).toMatch(/simulation error/i);
  });

  it('includes "is_paused" in the label', async () => {
    const server = makeMockServer(1, false);
    const result = await probeLiveness(
      server, TESTNET_PASSPHRASE, CONTRACTS.yieldEngine, 'YieldEngine',
    );
    expect(result.label).toContain('is_paused');
  });
});

// ---------------------------------------------------------------------------
// runSmokeChecks — normal path (all pass)
// ---------------------------------------------------------------------------

describe('runSmokeChecks — all pass', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns passed: true when all contracts respond correctly', async () => {
    // Inject mock server by spying on the SorobanRpc.Server constructor.
    const mockServer = makeMockServer(1, false);
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const report = await runSmokeChecks(makeOptions());

    expect(report.passed).toBe(true);
    expect(report.failures).toHaveLength(0);
    expect(report.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('produces two results (version + liveness) per configured contract', async () => {
    const mockServer = makeMockServer(1, false);
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const singleContract: SmokeCheckContracts = { yieldVault: CONTRACTS.yieldVault };
    const report = await runSmokeChecks(makeOptions({}, singleContract));

    expect(report.results).toHaveLength(2);
    expect(report.results[0].label).toContain('get_storage_version');
    expect(report.results[1].label).toContain('is_paused');
  });

  it('runs probes for every contract provided', async () => {
    const mockServer = makeMockServer(1, false);
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const report = await runSmokeChecks(makeOptions());
    // 7 contracts × 2 probes = 14
    expect(report.results).toHaveLength(14);
  });

  it('skips contracts whose address is omitted', async () => {
    const mockServer = makeMockServer(1, false);
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const partial: SmokeCheckContracts = {
      yieldVault: CONTRACTS.yieldVault,
      rebalanceEngine: CONTRACTS.rebalanceEngine,
    };
    const report = await runSmokeChecks(makeOptions({}, partial));
    // 2 contracts × 2 probes = 4
    expect(report.results).toHaveLength(4);
  });

  it('does not assert version when expectedStorageVersion is omitted', async () => {
    // Server returns version 99 — should still pass because we did not pass
    // an expected version.
    const mockServer = makeMockServer(99, false);
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const opts = makeOptions({ expectedStorageVersion: undefined });
    const report = await runSmokeChecks(opts);

    expect(report.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runSmokeChecks — boundary: version mismatch
// ---------------------------------------------------------------------------

describe('runSmokeChecks — version mismatch', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns passed: false when any contract reports a wrong storage version', async () => {
    // version = 2 but expectedStorageVersion = 1 → all version probes fail
    const mockServer = makeMockServer(2, false);
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const report = await runSmokeChecks(makeOptions({ expectedStorageVersion: 1 }));

    expect(report.passed).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.every((f) => f.error?.includes('storage version mismatch'))).toBe(true);
  });

  it('reports the correct expected/got values in the failure message', async () => {
    const mockServer = makeMockServer(3, false);
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const single: SmokeCheckContracts = { yieldVault: CONTRACTS.yieldVault };
    const report = await runSmokeChecks(
      makeOptions({ expectedStorageVersion: 1 }, single),
    );

    expect(report.failures[0].error).toContain('expected 1, got 3');
  });
});

// ---------------------------------------------------------------------------
// runSmokeChecks — failure: RPC errors
// ---------------------------------------------------------------------------

describe('runSmokeChecks — RPC errors', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns passed: false when a simulation returns an error', async () => {
    const mockServer = makeMockServer('error', 'error');
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const report = await runSmokeChecks(makeOptions());

    expect(report.passed).toBe(false);
    expect(report.failures.length).toBeGreaterThan(0);
  });

  it('continues running all probes even when earlier ones fail', async () => {
    const mockServer = makeMockServer('error', 'error');
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const report = await runSmokeChecks(makeOptions());

    // All 7 contracts × 2 probes = 14 results, even though many fail.
    expect(report.results).toHaveLength(14);
  });

  it('records a non-empty error string on each failed result', async () => {
    const mockServer = makeMockServer('error', false);
    jest.spyOn(SorobanRpc, 'Server').mockReturnValue(mockServer as unknown as SorobanRpc.Server);

    const report = await runSmokeChecks(makeOptions());

    for (const failure of report.failures) {
      expect(failure.error).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// runSmokeChecks — failure: no contracts configured
// ---------------------------------------------------------------------------

describe('runSmokeChecks — no contracts', () => {
  it('throws when no contract addresses are provided', async () => {
    await expect(
      runSmokeChecks(makeOptions({}, {})),
    ).rejects.toThrow('at least one contract address');
  });
});

// ---------------------------------------------------------------------------
// formatSmokeCheckReport
// ---------------------------------------------------------------------------

describe('formatSmokeCheckReport', () => {
  it('includes PASSED in the output for a passing report', () => {
    const report = {
      passed: true,
      results: [
        { label: 'YieldVault :: get_storage_version', contractAddress: CONTRACTS.yieldVault, passed: true, returnValue: 1 },
      ],
      failures: [],
      completedAt: '2026-11-25T10:00:00.000Z',
    };
    const text = formatSmokeCheckReport(report);
    expect(text).toContain('PASSED');
    expect(text).not.toContain('FAILED');
  });

  it('includes FAILED and failure count in the output for a failing report', () => {
    const failure = {
      label: 'YieldVault :: get_storage_version',
      contractAddress: CONTRACTS.yieldVault,
      passed: false,
      error: 'storage version mismatch: expected 1, got 2',
    };
    const report = {
      passed: false,
      results: [failure],
      failures: [failure],
      completedAt: '2026-11-25T10:00:00.000Z',
    };
    const text = formatSmokeCheckReport(report);
    expect(text).toContain('FAILED');
    expect(text).toContain('1 check(s) failed');
    expect(text).toContain(failure.error);
  });

  it('includes the completedAt timestamp', () => {
    const report = {
      passed: true,
      results: [],
      failures: [],
      completedAt: '2026-11-25T10:00:00.000Z',
    };
    expect(formatSmokeCheckReport(report)).toContain('2026-11-25T10:00:00.000Z');
  });

  it('marks each passing result with a tick and each failure with a cross', () => {
    const passing = {
      label: 'YieldVault :: is_paused',
      contractAddress: CONTRACTS.yieldVault,
      passed: true,
      returnValue: false,
    };
    const failing = {
      label: 'Actuary :: get_storage_version',
      contractAddress: CONTRACTS.actuary,
      passed: false,
      error: 'timeout',
    };
    const report = {
      passed: false,
      results: [passing, failing],
      failures: [failing],
      completedAt: '2026-11-25T10:00:00.000Z',
    };
    const text = formatSmokeCheckReport(report);
    expect(text).toContain('✓');
    expect(text).toContain('✗');
  });
});
