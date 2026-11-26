'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync, statSync } = require('node:fs');
const { resolve } = require('node:path');

const WASM_MAGIC = '0061736d';

class WasmArtifactError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WasmArtifactError';
    this.code = code;
  }
}

function assertWasmFile(filePath, label) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new WasmArtifactError(`${label} was not found: ${filePath}`, 'MISSING_ARTIFACT');
  }
  return statSync(filePath);
}

function checkWasmArtifact(filePath, label = 'wasm artifact') {
  const stats = assertWasmFile(filePath, label);
  if (stats.size < 4) {
    throw new WasmArtifactError(`${label} is too small to be a wasm module: ${filePath}`, 'INVALID_WASM');
  }

  const magic = readFileSync(filePath).subarray(0, 4).toString('hex');
  if (magic !== WASM_MAGIC) {
    throw new WasmArtifactError(
      `${label} is not a valid wasm module (magic bytes: ${magic}): ${filePath}`,
      'INVALID_WASM',
    );
  }

  return {
    path: resolve(filePath),
    size: stats.size,
    sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
  };
}

function checkReproducibleWasm(firstPath, secondPath) {
  const reference = checkWasmArtifact(firstPath, 'reference wasm artifact');
  const rebuilt = checkWasmArtifact(secondPath, 'rebuilt wasm artifact');

  if (reference.sha256 !== rebuilt.sha256) {
    throw new WasmArtifactError(
      `wasm artifacts differ: ${reference.sha256} (${reference.path}) != ${rebuilt.sha256} (${rebuilt.path})`,
      'HASH_MISMATCH',
    );
  }

  return {
    sha256: reference.sha256,
    size: reference.size,
    reference,
    rebuilt,
  };
}

function parseCliArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }

  const args = [...argv];
  let first;
  let second;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--first' || arg === '--second') {
      const value = args.shift();
      if (!value) {
        throw new WasmArtifactError(`${arg} requires a file path`, 'INVALID_ARGUMENTS');
      }
      if (arg === '--first') first = value;
      else second = value;
    } else if (arg.startsWith('--first=')) {
      first = arg.slice('--first='.length);
    } else if (arg.startsWith('--second=')) {
      second = arg.slice('--second='.length);
    } else if (!arg.startsWith('-') && first === undefined) {
      first = arg;
    } else if (!arg.startsWith('-') && second === undefined) {
      second = arg;
    } else {
      throw new WasmArtifactError(`unexpected argument: ${arg}`, 'INVALID_ARGUMENTS');
    }
  }

  if (!first || !second) {
    throw new WasmArtifactError(
      'Usage: npm run check:wasm-artifact -- --first <reference.wasm> --second <rebuilt.wasm>',
      'INVALID_ARGUMENTS',
    );
  }

  return { first, second };
}

function main() {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: npm run check:wasm-artifact -- --first <reference.wasm> --second <rebuilt.wasm>');
      return;
    }

    const result = checkReproducibleWasm(args.first, args.second);
    console.log(`sha256=${result.sha256} size=${result.size} path=${result.rebuilt.path}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  WASM_MAGIC,
  WasmArtifactError,
  checkReproducibleWasm,
  checkWasmArtifact,
  main,
  parseCliArgs,
};
