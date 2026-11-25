/**
 * Tests for contract storage schema version reporting (Issue #499).
 *
 * These tests cover the TypeScript SDK layer. The on-chain contract side
 * (get_storage_version, migrate) is exercised by `tests/upgrade_tests.rs`.
 */

import {
  SchemaVersionReporter,
  SchemaVersionError,
  KNOWN_STORAGE_VERSION,
  CONTRACT_KINDS,
  ContractKind,
  ContractAddressMap,
} from './schemaVersion';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a full ContractAddressMap where every entry is a distinct fake ID. */
function allAddresses(overrides: Partial<ContractAddressMap> = {}): ContractAddressMap {
  const base = Object.fromEntries(
    CONTRACT_KINDS.map((k) => [k, `C${k.toUpperCase()}_FAKE_ID`]),
  ) as ContractAddressMap;
  return { ...base, ...overrides };
}

/** Returns the number held in an XDR ScVal Uint32 buffer without depending on stellar-sdk. */
function uint32ScVal(value: number): { _switch: { value: 6 }; _value: number } {
  // We mock `scValToNative` anyway, so the exact shape does not matter
  // as long as it is not null/undefined.
  return { _switch: { value: 6 }, _value: value };
}

type MockServer = {
  simulateTransaction: jest.Mock;
};

/** Create a reporter whose internal server is fully replaced by a mock. */
function reporterWithMock(mockServer: MockServer): SchemaVersionReporter {
  const reporter = new SchemaVersionReporter('https://soroban-testnet.stellar.org');
  // Replace the private server without exposing it in the public API.
  (reporter as unknown as { server: MockServer }).server = mockServer;
  return reporter;
}

/** Build a successful simulation response that returns `version` from the contract. */
function successResult(version: number) {
  return {
    result: { retval: version },   // scValToNative is mocked to return the number directly
    error: undefined,
  };
}

// Mock stellar-sdk at module scope so individual tests can override per-call.
jest.mock('stellar-sdk', () => {
  const actual = jest.requireActual('stellar-sdk') as Record<string, unknown>;
  return {
    ...actual,
    SorobanRpc: {
      ...((actual.SorobanRpc as Record<string, unknown>) ?? {}),
      Server: jest.fn().mockImplementation(() => ({
        simulateTransaction: jest.fn(),
      })),
      Api: {
        isSimulationError: (r: unknown) =>
          typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>).error === 'string',
        isSimulationSuccess: (r: unknown) =>
          typeof r === 'object' &&
          r !== null &&
          (r as Record<string, unknown>).result !== undefined,
      },
    },
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue({ type: 'invokeHostFunction' }),
    })),
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({}),
    })),
    Account: jest.fn().mockImplementation(() => ({})),
    BASE_FEE: '100',
    Networks: actual.Networks,
    scValToNative: jest.fn((val: unknown) => val), // identity — tests store numbers directly
  };
});

// ---------------------------------------------------------------------------
// KNOWN_STORAGE_VERSION
// ---------------------------------------------------------------------------

describe('KNOWN_STORAGE_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(KNOWN_STORAGE_VERSION)).toBe(true);
    expect(KNOWN_STORAGE_VERSION).toBeGreaterThan(0);
  });

  it('equals 1, mirroring src/upgrade.rs STORAGE_VERSION', () => {
    expect(KNOWN_STORAGE_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CONTRACT_KINDS
// ---------------------------------------------------------------------------

describe('CONTRACT_KINDS', () => {
  it('contains all seven contract roles', () => {
    expect(CONTRACT_KINDS).toHaveLength(7);
    expect(CONTRACT_KINDS).toEqual(
      expect.arrayContaining([
        'yieldEngine',
        'yieldVault',
        'rebalanceEngine',
        'rewardDistributor',
        'strategyRegistry',
        'ilInsurance',
        'actuary',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// SchemaVersionReporter.fetchOne
// ---------------------------------------------------------------------------

describe('SchemaVersionReporter.fetchOne', () => {
  it('returns mismatch:false and correct version when version matches expected', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(KNOWN_STORAGE_VERSION)),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchOne('yieldVault', 'CVAULT123');

    expect(report.kind).toBe('yieldVault');
    expect(report.contractId).toBe('CVAULT123');
    expect(report.version).toBe(KNOWN_STORAGE_VERSION);
    expect(report.mismatch).toBe(false);
    expect(report.mismatchReason).toBeNull();
    expect(report.error).toBeNull();
  });

  it('returns mismatch:true for version 0 (pre-tracking deployment)', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(0)),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchOne('actuary', 'CACTUARY_OLD');

    expect(report.version).toBe(0);
    expect(report.mismatch).toBe(true);
    expect(report.mismatchReason).toMatch(/version 0/);
    expect(report.mismatchReason).toMatch(/migrate\(admin\)/);
    expect(report.error).toBeNull();
  });

  it('returns mismatch:true for version behind expected', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(KNOWN_STORAGE_VERSION - 1)),
    };
    const reporter = reporterWithMock(mockServer);

    // Only meaningful when KNOWN_STORAGE_VERSION > 1; skip gracefully otherwise.
    if (KNOWN_STORAGE_VERSION <= 1) {
      return;
    }

    const report = await reporter.fetchOne('rebalanceEngine', 'CREBALANCE');

    expect(report.mismatch).toBe(true);
    expect(report.mismatchReason).toMatch(/behind expected/);
  });

  it('returns mismatch:true for version ahead of expected', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(KNOWN_STORAGE_VERSION + 1)),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchOne('yieldEngine', 'CENGINE_FUTURE');

    expect(report.version).toBe(KNOWN_STORAGE_VERSION + 1);
    expect(report.mismatch).toBe(true);
    expect(report.mismatchReason).toMatch(/ahead of expected/);
    expect(report.mismatchReason).toMatch(/update the SDK/);
    expect(report.error).toBeNull();
  });

  it('captures RPC errors inside the report without throwing', async () => {
    const rpcError = new Error('connection refused');
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockRejectedValue(rpcError),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchOne('ilInsurance', 'CINSURANCE');

    expect(report.version).toBe(0);
    expect(report.mismatch).toBe(true);
    expect(report.error).toBe(rpcError);
    expect(report.mismatchReason).toMatch(/RPC error/);
  });

  it('wraps non-Error throws in a proper Error', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockRejectedValue('string thrown'),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchOne('strategyRegistry', 'CREG');

    expect(report.error).toBeInstanceOf(Error);
    expect(report.error!.message).toContain('string thrown');
  });

  it('reports an error when the simulation returns an error response', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue({ error: 'HostError: some error' }),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchOne('yieldVault', 'CVAULT');

    expect(report.mismatch).toBe(true);
    expect(report.error).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// SchemaVersionReporter.fetchSome
// ---------------------------------------------------------------------------

describe('SchemaVersionReporter.fetchSome', () => {
  it('returns only the requested kinds in CONTRACT_KINDS order', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(KNOWN_STORAGE_VERSION)),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchSome({
      yieldVault: 'CVAULT',
      actuary: 'CACTUARY',
    });

    // yieldVault comes before actuary in CONTRACT_KINDS
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0].kind).toBe('yieldVault');
    expect(report.entries[1].kind).toBe('actuary');
  });

  it('reports allMatch:true when all queried versions match', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(KNOWN_STORAGE_VERSION)),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchSome({
      yieldEngine: 'CENGINE',
      yieldVault: 'CVAULT',
    });

    expect(report.allMatch).toBe(true);
    expect(report.mismatchCount).toBe(0);
  });

  it('counts mismatches correctly', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest
        .fn()
        .mockResolvedValueOnce(successResult(0))               // yieldEngine: mismatch
        .mockResolvedValueOnce(successResult(KNOWN_STORAGE_VERSION)), // yieldVault: ok
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchSome({
      yieldEngine: 'CENGINE',
      yieldVault: 'CVAULT',
    });

    expect(report.mismatchCount).toBe(1);
    expect(report.allMatch).toBe(false);
  });

  it('reports fetchedAt as a recent timestamp', async () => {
    const before = Date.now();
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(KNOWN_STORAGE_VERSION)),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchSome({ yieldVault: 'CVAULT' });

    expect(report.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(report.fetchedAt).toBeLessThanOrEqual(Date.now());
  });

  it('handles an empty map without throwing', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn(),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchSome({});

    expect(report.entries).toHaveLength(0);
    expect(report.allMatch).toBe(true);
    expect(report.mismatchCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SchemaVersionReporter.fetchAll
// ---------------------------------------------------------------------------

describe('SchemaVersionReporter.fetchAll', () => {
  it('returns a report for all seven contracts', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(KNOWN_STORAGE_VERSION)),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchAll(allAddresses());

    expect(report.entries).toHaveLength(7);
    expect(report.allMatch).toBe(true);
  });

  it('throws SchemaVersionError when any contract address is empty', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn(),
    };
    const reporter = reporterWithMock(mockServer);

    await expect(
      reporter.fetchAll(allAddresses({ yieldVault: '' })),
    ).rejects.toBeInstanceOf(SchemaVersionError);
  });

  it('throws SchemaVersionError when any address is whitespace-only', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn(),
    };
    const reporter = reporterWithMock(mockServer);

    await expect(
      reporter.fetchAll(allAddresses({ strategyRegistry: '   ' })),
    ).rejects.toBeInstanceOf(SchemaVersionError);
  });

  it('error message names the missing contract kind', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn(),
    };
    const reporter = reporterWithMock(mockServer);

    await expect(
      reporter.fetchAll(allAddresses({ ilInsurance: '' })),
    ).rejects.toThrow(/ilInsurance/);
  });

  it('issues one RPC call per contract', async () => {
    const mockServer: MockServer = {
      simulateTransaction: jest.fn().mockResolvedValue(successResult(KNOWN_STORAGE_VERSION)),
    };
    const reporter = reporterWithMock(mockServer);

    await reporter.fetchAll(allAddresses());

    expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(7);
  });

  it('allMatch:false when at least one contract is at version 0', async () => {
    // First call returns 0, the rest return KNOWN_STORAGE_VERSION.
    const mockServer: MockServer = {
      simulateTransaction: jest
        .fn()
        .mockResolvedValueOnce(successResult(0))
        .mockResolvedValue(successResult(KNOWN_STORAGE_VERSION)),
    };
    const reporter = reporterWithMock(mockServer);

    const report = await reporter.fetchAll(allAddresses());

    expect(report.allMatch).toBe(false);
    expect(report.mismatchCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// SchemaVersionError
// ---------------------------------------------------------------------------

describe('SchemaVersionError', () => {
  it('has name SchemaVersionError', () => {
    const err = new SchemaVersionError('test');
    expect(err.name).toBe('SchemaVersionError');
  });

  it('is an instance of Error', () => {
    expect(new SchemaVersionError('test')).toBeInstanceOf(Error);
  });
});
