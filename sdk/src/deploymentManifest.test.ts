import { StrKey } from 'stellar-sdk';
import {
  CONTRACT_ID_PATTERN,
  DeploymentManifestError,
  assertValidDeploymentManifest,
  isValidContractId,
  validateDeploymentManifest,
} from './deploymentManifest';

const ID_A = StrKey.encodeContract(Buffer.alloc(32, 1));
const ID_B = StrKey.encodeContract(Buffer.alloc(32, 2));
const BAD_CHECKSUM_ID = `${ID_A.slice(0, -1)}${ID_A.slice(-1) === 'A' ? 'B' : 'A'}`;

describe('isValidContractId', () => {
  it('accepts valid StrKey contract IDs', () => {
    expect(isValidContractId(ID_A)).toBe(true);
    expect(CONTRACT_ID_PATTERN.test(ID_A)).toBe(true);
  });

  it.each([
    undefined,
    null,
    '',
    '   ',
    ID_A.toLowerCase(),
    `C${'A'.repeat(54)}`,
    `C${'A'.repeat(56)}`,
    `C${'0'.repeat(55)}`,
    `${ID_A.slice(0, -1)}${ID_A.slice(-1) === 'A' ? 'B' : 'A'}`,
  ])('rejects %p', (value) => {
    expect(isValidContractId(value)).toBe(false);
  });
});

describe('validateDeploymentManifest', () => {
  it('normalizes contractIds values from an object manifest', () => {
    const result = validateDeploymentManifest({
      network: 'testnet',
      contractIds: {
        yieldEngine: `  ${ID_A}  `,
        rewardDistributor: ID_B,
      },
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.contractIds).toEqual({
      yieldEngine: ID_A,
      rewardDistributor: ID_B,
    });
  });

  it('accepts contracts declared as an object with nested ID fields', () => {
    const result = validateDeploymentManifest({
      contracts: {
        engine: { address: ID_A },
        vault: { id: ID_B },
      },
    });

    expect(result.valid).toBe(true);
    expect(result.contractIds).toEqual({ engine: ID_A, vault: ID_B });
  });

  it('accepts contracts declared as an array', () => {
    const result = validateDeploymentManifest({
      contracts: [
        { name: 'engine', contractId: ID_A },
        { name: 'vault', contractId: ID_B },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.contractIds).toEqual({ engine: ID_A, vault: ID_B });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'manifest'],
  ])('rejects a manifest that is %s', (_label, manifest) => {
    const result = validateDeploymentManifest(manifest);

    expect(result.valid).toBe(false);
    expect(result.contractIds).toEqual({});
    expect(result.issues[0].code).toBe('INVALID_MANIFEST');
  });

  it.each([
    ['missing declarations', {}],
    ['empty object', { contractIds: {} }],
    ['empty array', { contracts: [] }],
  ])('rejects %s', (_label, manifest) => {
    const result = validateDeploymentManifest(manifest);

    expect(result.valid).toBe(false);
    expect(result.issues[0].code).toBe('MISSING_CONTRACT_IDS');
  });

  it.each([
    ['blank ID', { contractIds: { engine: '   ' } }, 'INVALID_CONTRACT_ID'],
    ['non-string ID', { contractIds: { engine: 42 } }, 'INVALID_CONTRACT_ID'],
    ['lowercase ID', { contractIds: { engine: ID_A.toLowerCase() } }, 'INVALID_CONTRACT_ID'],
    ['bad checksum', { contractIds: { engine: BAD_CHECKSUM_ID } }, 'INVALID_CONTRACT_ID'],
    ['duplicate role', { contracts: [{ name: 'engine', contractId: ID_A }, { name: 'engine', contractId: ID_B }] }, 'DUPLICATE_CONTRACT_NAME'],
    ['duplicate ID', { contractIds: { engine: ID_A, vault: ID_A } }, 'DUPLICATE_CONTRACT_ID'],
  ])('rejects %s', (_label, manifest, expectedCode) => {
    const result = validateDeploymentManifest(manifest);

    expect(result.valid).toBe(false);
    expect(result.issues.map((item) => item.code)).toContain(expectedCode);
  });

  it('reports every invalid declaration without throwing', () => {
    const result = validateDeploymentManifest({
      contractIds: {
        engine: 'bad',
        vault: '',
      },
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.every((item) => item.code === 'INVALID_CONTRACT_ID')).toBe(true);
  });
});

describe('assertValidDeploymentManifest', () => {
  it('returns the normalized ID map for a valid manifest', () => {
    expect(assertValidDeploymentManifest({ contracts: { engine: ID_A } })).toEqual({
      engine: ID_A,
    });
  });

  it('throws a typed error carrying all validation issues', () => {
    expect(() => assertValidDeploymentManifest({ contractIds: { engine: 'bad' } })).toThrow(
      DeploymentManifestError,
    );

    try {
      assertValidDeploymentManifest({ contractIds: { engine: 'bad' } });
      throw new Error('expected validation to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentManifestError);
      const typed = error as DeploymentManifestError;
      expect(typed.code).toBe('INVALID_CONTRACT_ID');
      expect(typed.issues).toHaveLength(1);
    }
  });
});
