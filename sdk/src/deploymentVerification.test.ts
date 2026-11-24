import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DeploymentVerificationError,
  compareWasmHashes,
  fetchDeployedWasmHash,
  isWasmModule,
  isValidContractId,
  normalizeWasmHash,
  parseReleaseManifest,
  readWasmArtifact,
  sha256Hex,
  verifyDeployment,
  verifyReleaseManifest,
  type DeployedWasmSource,
  type ReleaseManifest,
} from './deploymentVerification';

const CONTRACT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
const CONTRACT_B = `C${'B'.repeat(55)}`;
const MINIMAL_WASM = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MINIMAL_WASM_HASH =
  '93a44bbb96c751218e4c00d479e4c14358122a389acca16205b1e4d0dc5f9476';
const OTHER_HASH =
  '0000000000000000000000000000000000000000000000000000000000000001';

/** A deployed-wasm source that serves fixed bytes, or throws a fixed error. */
function deployedSource(
  bytes: Uint8Array | unknown,
  options: { reject?: boolean } = {},
): DeployedWasmSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getContractWasmByContractId: async (contractId: string) => {
      calls.push(contractId);
      if (options.reject) throw bytes;
      return bytes as Uint8Array;
    },
  };
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wasm-verification-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('normalizeWasmHash', () => {
  it('accepts lowercase, uppercase and 0x-prefixed digests', () => {
    expect(normalizeWasmHash(MINIMAL_WASM_HASH)).toBe(MINIMAL_WASM_HASH);
    expect(normalizeWasmHash(`  ${MINIMAL_WASM_HASH.toUpperCase()}  `)).toBe(
      MINIMAL_WASM_HASH,
    );
    expect(normalizeWasmHash(`0x${MINIMAL_WASM_HASH.toUpperCase()}`)).toBe(
      MINIMAL_WASM_HASH,
    );
  });

  it('rejects a hash with the wrong length', () => {
    expect(() => normalizeWasmHash(MINIMAL_WASM_HASH.slice(0, 63))).toThrow(
      /64-character hex/,
    );
    expect(() => normalizeWasmHash(`${MINIMAL_WASM_HASH}00`)).toThrow(
      /64-character hex/,
    );
  });

  it('rejects non-hex values and non-strings', () => {
    expect(() => normalizeWasmHash('z'.repeat(64))).toThrow(/64-character hex/);
    expect(() => normalizeWasmHash(null)).toThrow(/64-character hex/);
  });
});

describe('sha256Hex and isWasmModule', () => {
  it('hashes bytes with SHA-256', () => {
    expect(sha256Hex(MINIMAL_WASM)).toBe(MINIMAL_WASM_HASH);
    expect(sha256Hex(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('rejects non-Uint8Array input', () => {
    expect(() => sha256Hex('hello' as unknown as Uint8Array)).toThrow(
      /Uint8Array/,
    );
  });

  it('recognises the wasm magic number at the boundary', () => {
    expect(isWasmModule(MINIMAL_WASM)).toBe(true);
    expect(isWasmModule(Buffer.from([0x00, 0x61, 0x73]))).toBe(false);
    expect(isWasmModule(Buffer.from('not wasm'))).toBe(false);
  });
});

describe('isValidContractId', () => {
  it('accepts a contract StrKey and rejects other addresses', () => {
    expect(isValidContractId(CONTRACT_A)).toBe(true);
    expect(isValidContractId(CONTRACT_B)).toBe(true);
    expect(isValidContractId(CONTRACT_A.toLowerCase())).toBe(false);
    expect(isValidContractId(`G${CONTRACT_A.slice(1)}`)).toBe(false);
    expect(isValidContractId('')).toBe(false);
    expect(isValidContractId(undefined)).toBe(false);
  });
});

describe('parseReleaseManifest', () => {
  const manifest = {
    version: '0.1.0',
    network: 'testnet',
    artifacts: [
      { name: 'yield-vault', wasmHash: MINIMAL_WASM_HASH, wasmPath: 'vault.wasm' },
    ],
  };

  it('parses an object and canonicalises hashes', () => {
    const parsed = parseReleaseManifest({
      ...manifest,
      artifacts: [
        { ...manifest.artifacts[0], wasmHash: `0x${MINIMAL_WASM_HASH.toUpperCase()}` },
      ],
    });

    expect(parsed).toEqual({
      version: '0.1.0',
      network: 'testnet',
      artifacts: [
        {
          name: 'yield-vault',
          wasmHash: MINIMAL_WASM_HASH,
          wasmPath: 'vault.wasm',
        },
      ],
    });
  });

  it('parses raw JSON text', () => {
    expect(parseReleaseManifest(JSON.stringify(manifest))).toEqual(manifest);
  });

  it('tolerates unknown fields for forward compatibility', () => {
    const parsed = parseReleaseManifest({
      ...manifest,
      generatedAt: '2026-11-24T00:00:00Z',
      artifacts: [
        {
          ...manifest.artifacts[0],
          build: { commit: 'abc123' },
        },
      ],
    });

    expect(parsed.artifacts[0]).toEqual(manifest.artifacts[0]);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseReleaseManifest('{nope')).toThrow(DeploymentVerificationError);
    expect(() => parseReleaseManifest('{nope')).toThrow(/not valid JSON/);
  });

  it('rejects an empty artifact list', () => {
    expect(() => parseReleaseManifest({ ...manifest, artifacts: [] })).toThrow(
      /at least one artifact/,
    );
  });

  it('rejects a malformed version or artifact name', () => {
    expect(() => parseReleaseManifest({ ...manifest, version: '' })).toThrow(
      /non-empty version/,
    );
    expect(() =>
      parseReleaseManifest({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], name: '  ' }],
      }),
    ).toThrow(/name must be a non-empty string/);
  });

  it('rejects duplicate artifact names', () => {
    expect(() =>
      parseReleaseManifest({
        ...manifest,
        artifacts: [manifest.artifacts[0], { ...manifest.artifacts[0] }],
      }),
    ).toThrow(/more than once/);
  });

  it('rejects a malformed artifact hash or path', () => {
    expect(() =>
      parseReleaseManifest({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], wasmHash: 'abc' }],
      }),
    ).toThrow(/artifacts\[0\]\.wasmHash/);

    expect(() =>
      parseReleaseManifest({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], wasmPath: '' }],
      }),
    ).toThrow(/wasmPath must be a non-empty string/);
  });

  it('rejects a non-object manifest', () => {
    expect(() => parseReleaseManifest([])).toThrow(/JSON object/);
    expect(() => parseReleaseManifest(null)).toThrow(/JSON object/);
  });
});

describe('readWasmArtifact', () => {
  it('hashes a wasm file resolved against the base directory', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'vault.wasm'), MINIMAL_WASM);

      const artifact = await readWasmArtifact('vault.wasm', dir);

      expect(artifact.path).toBe(path.join(dir, 'vault.wasm'));
      expect(artifact.wasmHash).toBe(MINIMAL_WASM_HASH);
      expect(artifact.size).toBe(MINIMAL_WASM.length);
    });
  });

  it('reports a missing artifact as artifact_unreadable', async () => {
    await withTempDir(async (dir) => {
      await expect(readWasmArtifact('missing.wasm', dir)).rejects.toMatchObject({
        code: 'artifact_unreadable',
      });
    });
  });

  it('rejects empty and non-wasm files instead of hashing them', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'empty.wasm'), '');
      await fs.writeFile(path.join(dir, 'notes.txt'), 'this is not wasm');

      await expect(readWasmArtifact('empty.wasm', dir)).rejects.toMatchObject({
        code: 'invalid_wasm',
      });
      await expect(readWasmArtifact('notes.txt', dir)).rejects.toMatchObject({
        code: 'invalid_wasm',
      });
    });
  });
});

describe('fetchDeployedWasmHash', () => {
  it('hashes the wasm returned by the RPC', async () => {
    const source = deployedSource(MINIMAL_WASM);

    await expect(fetchDeployedWasmHash(source, CONTRACT_A)).resolves.toBe(
      MINIMAL_WASM_HASH,
    );
    expect(source.calls).toEqual([CONTRACT_A]);
  });

  it('rejects an invalid contract ID before calling the RPC', async () => {
    const source = deployedSource(MINIMAL_WASM);

    await expect(fetchDeployedWasmHash(source, 'not-a-contract')).rejects.toMatchObject({
      code: 'invalid_contract_id',
    });
    expect(source.calls).toEqual([]);
  });

  it('maps a 404 to deployed_wasm_unavailable', async () => {
    const source = deployedSource(
      { code: 404, message: 'Could not obtain contract hash from server' },
      { reject: true },
    );

    await expect(fetchDeployedWasmHash(source, CONTRACT_A)).rejects.toMatchObject({
      code: 'deployed_wasm_unavailable',
    });
  });

  it('maps other RPC failures to rpc_error', async () => {
    const source = deployedSource(new Error('socket hang up'), { reject: true });

    await expect(fetchDeployedWasmHash(source, CONTRACT_A)).rejects.toMatchObject({
      code: 'rpc_error',
    });
  });

  it('rejects bytes that are not a wasm module', async () => {
    const source = deployedSource(Buffer.from('not wasm'));

    await expect(fetchDeployedWasmHash(source, CONTRACT_A)).rejects.toMatchObject({
      code: 'invalid_wasm',
    });
  });
});

describe('compareWasmHashes', () => {
  it('normalises both hashes before comparing', () => {
    expect(compareWasmHashes(MINIMAL_WASM_HASH.toUpperCase(), MINIMAL_WASM_HASH)).toEqual({
      expectedWasmHash: MINIMAL_WASM_HASH,
      deployedWasmHash: MINIMAL_WASM_HASH,
      matches: true,
    });
  });

  it('reports a mismatch instead of throwing', () => {
    expect(compareWasmHashes(MINIMAL_WASM_HASH, OTHER_HASH).matches).toBe(false);
  });
});

describe('verifyDeployment', () => {
  it('reports a match for the exact wasm that was released', async () => {
    const result = await verifyDeployment({
      source: deployedSource(MINIMAL_WASM),
      contractId: CONTRACT_A,
      contractName: 'yield-vault',
      expectedWasmHash: MINIMAL_WASM_HASH,
      now: () => 12345,
    });

    expect(result).toMatchObject({
      contractId: CONTRACT_A,
      contractName: 'yield-vault',
      expectedWasmHash: MINIMAL_WASM_HASH,
      deployedWasmHash: MINIMAL_WASM_HASH,
      matches: true,
      checkedAt: 12345,
    });
    expect(result.message).toMatch(/matches the release/);
  });

  it('reports a mismatch for different deployed bytes', async () => {
    const result = await verifyDeployment({
      source: deployedSource(MINIMAL_WASM),
      contractId: CONTRACT_A,
      expectedWasmHash: OTHER_HASH,
    });

    expect(result.matches).toBe(false);
    expect(result.message).toMatch(/release expects/);
    expect(result.message).toContain(OTHER_HASH);
  });

  it('also checks the local release artifact when one is provided', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'vault.wasm'), MINIMAL_WASM);

      const result = await verifyDeployment({
        source: deployedSource(MINIMAL_WASM),
        contractId: CONTRACT_A,
        expectedWasmHash: MINIMAL_WASM_HASH,
        artifactPath: 'vault.wasm',
        artifactDir: dir,
      });

      expect(result.matches).toBe(true);
      expect(result.artifact).toEqual({
        path: path.join(dir, 'vault.wasm'),
        wasmHash: MINIMAL_WASM_HASH,
        matches: true,
      });
    });
  });

  it('fails when the local artifact is tampered with', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'vault.wasm'),
        Buffer.concat([MINIMAL_WASM, Buffer.from([0])]),
      );

      const result = await verifyDeployment({
        source: deployedSource(MINIMAL_WASM),
        contractId: CONTRACT_A,
        expectedWasmHash: MINIMAL_WASM_HASH,
        artifactPath: 'vault.wasm',
        artifactDir: dir,
      });

      expect(result.deployedWasmHash).toBe(MINIMAL_WASM_HASH);
      expect(result.artifact!.matches).toBe(false);
      expect(result.matches).toBe(false);
      expect(result.message).toMatch(/local artifact/);
    });
  });
});

describe('verifyReleaseManifest', () => {
  const manifest: ReleaseManifest = {
    version: '0.1.0',
    network: 'testnet',
    artifacts: [
      { name: 'yield-vault', wasmHash: MINIMAL_WASM_HASH },
      { name: 'reward-distributor', wasmHash: MINIMAL_WASM_HASH },
    ],
  };

  it('verifies every artifact against its deployed contract', async () => {
    const source = deployedSource(MINIMAL_WASM);

    const report = await verifyReleaseManifest({
      manifest,
      contractIds: { 'yield-vault': CONTRACT_A, 'reward-distributor': CONTRACT_B },
      source,
      network: 'TESTNET',
      now: () => 99,
    });

    expect(report).toMatchObject({
      manifestVersion: '0.1.0',
      network: 'testnet',
      checkedAt: 99,
      matchesAll: true,
    });
    expect(report.results).toHaveLength(2);
    expect(report.results.map((r) => r.contractName)).toEqual([
      'yield-vault',
      'reward-distributor',
    ]);
    expect(source.calls).toEqual([CONTRACT_A, CONTRACT_B]);
  });

  it('reports the whole manifest as failed when one deployment mismatches', async () => {
    const report = await verifyReleaseManifest({
      manifest,
      contractIds: { 'yield-vault': CONTRACT_A, 'reward-distributor': CONTRACT_B },
      source: {
        getContractWasmByContractId: async (contractId: string) =>
          contractId === CONTRACT_A
            ? MINIMAL_WASM
            : Buffer.concat([MINIMAL_WASM, Buffer.from([1])]),
      },
    });

    expect(report.matchesAll).toBe(false);
    expect(report.results.map((r) => r.matches)).toEqual([true, false]);
  });

  it('rejects an artifact with no deployed address', async () => {
    await expect(
      verifyReleaseManifest({
        manifest,
        contractIds: { 'yield-vault': CONTRACT_A },
        source: deployedSource(MINIMAL_WASM),
      }),
    ).rejects.toMatchObject({ code: 'missing_contract_id' });
  });

  it('rejects verifying a testnet manifest against another network', async () => {
    await expect(
      verifyReleaseManifest({
        manifest,
        contractIds: { 'yield-vault': CONTRACT_A, 'reward-distributor': CONTRACT_B },
        source: deployedSource(MINIMAL_WASM),
        network: 'mainnet',
      }),
    ).rejects.toMatchObject({ code: 'network_mismatch' });
  });

  it('verifies artifact files relative to artifactDir', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'vault.wasm'), MINIMAL_WASM);

      const report = await verifyReleaseManifest({
        manifest: {
          version: '0.1.0',
          artifacts: [
            {
              name: 'yield-vault',
              wasmHash: MINIMAL_WASM_HASH,
              wasmPath: 'vault.wasm',
            },
          ],
        },
        contractIds: { 'yield-vault': CONTRACT_A },
        source: deployedSource(MINIMAL_WASM),
        artifactDir: dir,
      });

      expect(report.matchesAll).toBe(true);
      expect(report.results[0].artifact?.path).toBe(path.join(dir, 'vault.wasm'));
    });
  });

  it('can skip artifact files when the operator only wants the on-chain check', async () => {
    const report = await verifyReleaseManifest({
      manifest: {
        version: '0.1.0',
        artifacts: [
          {
            name: 'yield-vault',
            wasmHash: MINIMAL_WASM_HASH,
            wasmPath: 'does-not-exist.wasm',
          },
        ],
      },
      contractIds: { 'yield-vault': CONTRACT_A },
      source: deployedSource(MINIMAL_WASM),
      verifyArtifacts: false,
    });

    expect(report.matchesAll).toBe(true);
    expect(report.results[0].artifact).toBeUndefined();
  });
});
