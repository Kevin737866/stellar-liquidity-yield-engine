const { createHash } = require('node:crypto');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  WASM_MAGIC,
  WasmArtifactError,
  checkReproducibleWasm,
  checkWasmArtifact,
  parseCliArgs,
} = require('./verify-wasm-artifact');

const VALID_WASM = Buffer.from('0061736d01000000', 'hex');
const REBUILT_WASM = Buffer.from('0061736d010000000001', 'hex');

let directory;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wasm-artifact-check-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function writeWasm(name, bytes) {
  const filePath = join(directory, name);
  writeFileSync(filePath, bytes);
  return filePath;
}

function expectedHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('checkWasmArtifact', () => {
  it('returns size and sha256 for a valid artifact', () => {
    const filePath = writeWasm('contract.wasm', VALID_WASM);
    const result = checkWasmArtifact(filePath);

    expect(result.path).toBe(filePath);
    expect(result.size).toBe(VALID_WASM.length);
    expect(result.sha256).toBe(expectedHash(VALID_WASM));
  });

  it('accepts the smallest valid wasm header', () => {
    const header = Buffer.from(WASM_MAGIC, 'hex');

    expect(checkWasmArtifact(writeWasm('header.wasm', header)).size).toBe(4);
  });

  it('rejects a missing artifact', () => {
    expect(() => checkWasmArtifact(join(directory, 'missing.wasm'))).toThrow(
      expect.objectContaining({ code: 'MISSING_ARTIFACT' }),
    );
  });

  it.each([
    ['a file that is too small', Buffer.from('00', 'hex')],
    ['a file with the wrong magic bytes', Buffer.from('0061736e01000000', 'hex')],
  ])('rejects %s', (_label, bytes) => {
    expect(() => checkWasmArtifact(writeWasm('bad.wasm', bytes))).toThrow(
      expect.objectContaining({ code: 'INVALID_WASM' }),
    );
  });
});

describe('checkReproducibleWasm', () => {
  it('accepts byte-identical artifacts', () => {
    const reference = writeWasm('reference.wasm', VALID_WASM);
    const rebuilt = writeWasm('rebuilt.wasm', Buffer.from(VALID_WASM));

    expect(checkReproducibleWasm(reference, rebuilt)).toEqual({
      sha256: expectedHash(VALID_WASM),
      size: VALID_WASM.length,
      reference: expect.objectContaining({ sha256: expectedHash(VALID_WASM) }),
      rebuilt: expect.objectContaining({ sha256: expectedHash(VALID_WASM) }),
    });
  });

  it('rejects artifacts with different hashes', () => {
    const reference = writeWasm('reference.wasm', VALID_WASM);
    const rebuilt = writeWasm('rebuilt.wasm', REBUILT_WASM);

    expect(() => checkReproducibleWasm(reference, rebuilt)).toThrow(WasmArtifactError);
    expect(() => checkReproducibleWasm(reference, rebuilt)).toThrow(
      expect.objectContaining({ code: 'HASH_MISMATCH' }),
    );
  });
});

describe('parseCliArgs', () => {
  it('supports named arguments', () => {
    expect(parseCliArgs(['--first', 'a.wasm', '--second', 'b.wasm'])).toEqual({
      first: 'a.wasm',
      second: 'b.wasm',
    });
  });

  it('supports positional arguments and equals syntax', () => {
    expect(parseCliArgs(['a.wasm', '--second=b.wasm'])).toEqual({
      first: 'a.wasm',
      second: 'b.wasm',
    });
  });

  it('rejects incomplete arguments', () => {
    expect(() => parseCliArgs(['a.wasm'])).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENTS' }),
    );
  });
});
