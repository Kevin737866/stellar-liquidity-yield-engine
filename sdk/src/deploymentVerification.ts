/**
 * Verify that what is deployed matches what was released.
 *
 * The upgrade entrypoints documented in `docs/UPGRADING.md` prove *that* a
 * contract's code was replaced; they do not prove *which* release was
 * installed. An operator who deploys, upgrades, or rolls back needs to close
 * that gap before announcing a release:
 *
 * 1. The release manifest records the SHA-256 of every wasm artifact shipped
 *    for that version.
 * 2. The deployed contract's wasm is read back from Soroban RPC and hashed.
 * 3. The two hashes must be byte-for-byte equal. If they are not, the address
 *    is running code that is not the artifact the release promised.
 *
 * Verification is deliberately **byte-exact**. Building from the same commit
 * is not enough: a different compiler, features, or `soroban contract optimize`
 * run changes the bytes, and therefore the deployed wasm hash. The artifact in
 * the manifest must be the exact file that was installed.
 *
 * ## Usage
 *
 * ```ts
 * import { SorobanRpc } from 'stellar-sdk';
 * import { verifyReleaseManifest } from './deploymentVerification';
 *
 * const report = await verifyReleaseManifest({
 *   manifest: JSON.parse(await readFile('release-manifest.json', 'utf8')),
 *   contractIds: { 'yield-vault': YIELD_VAULT_ID },
 *   source: new SorobanRpc.Server(TESTNET_RPC_URL),
 *   artifactDir: process.cwd(),
 * });
 *
 * if (!report.matchesAll) process.exitCode = 1;
 * ```
 *
 * ## Failure behavior
 *
 * A mismatch is *not* an exception: it is a successful verification whose
 * result is `matches: false`, so a caller can report every mismatched contract
 * in one run. Problems that make a comparison impossible — an unreadable wasm
 * file, a malformed manifest or hash, a contract that has no deployed wasm, or
 * an RPC failure — throw a {@link DeploymentVerificationError} with a
 * machine-readable `code`.
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

/** A Stellar contract ID is a 56-character StrKey starting with `C`. */
export const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** SHA-256 digests are compared as lowercase hex. */
export const WASM_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Every wasm module starts with the magic number `\0asm`. */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

export type DeploymentVerificationErrorCode =
  /** The contract ID is not a valid Stellar contract StrKey. */
  | 'invalid_contract_id'
  /** A hash is not a 32-byte SHA-256 digest in hex. */
  | 'invalid_hash'
  /** The release manifest is not usable (bad JSON, missing fields, duplicates). */
  | 'invalid_manifest'
  /** Bytes that should be wasm are missing the wasm magic number. */
  | 'invalid_wasm'
  /** The local release artifact is missing or cannot be read. */
  | 'artifact_unreadable'
  /** The contract has no deployed wasm (not deployed, or not a wasm contract). */
  | 'deployed_wasm_unavailable'
  /** The RPC request failed for a reason other than "not found". */
  | 'rpc_error'
  /** The manifest names an artifact with no deployed address to check. */
  | 'missing_contract_id'
  /** The operator asked to verify a different network than the manifest names. */
  | 'network_mismatch';

/** Raised when a deployment cannot be verified. */
export class DeploymentVerificationError extends Error {
  readonly code: DeploymentVerificationErrorCode;

  constructor(
    code: DeploymentVerificationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'DeploymentVerificationError';
    this.code = code;
    if (options && 'cause' in options) {
      // `cause` is not in the ES2020 lib this package targets.
      (this as unknown as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** One wasm artifact in a release manifest. */
export interface ReleaseArtifact {
  /** Contract name used to look up its deployed address, e.g. `yield-vault`. */
  name: string;
  /** SHA-256 of the exact wasm bytes installed on-chain. */
  wasmHash: string;
  /** Optional path to the release artifact, relative to the manifest. */
  wasmPath?: string;
}

/** The artifacts shipped by one release. */
export interface ReleaseManifest {
  /** Release version this manifest describes. */
  version: string;
  /** Network the artifacts are intended for, when the release records it. */
  network?: string;
  artifacts: ReleaseArtifact[];
}

/**
 * The slice of the Soroban RPC this module needs.
 *
 * `SorobanRpc.Server` satisfies it structurally (`getContractWasmByContractId`
 * returns the deployed wasm bytes), and so does a stub in a test.
 */
export interface DeployedWasmSource {
  getContractWasmByContractId(contractId: string): Promise<Uint8Array>;
}

export interface WasmHashComparison {
  expectedWasmHash: string;
  deployedWasmHash: string;
  matches: boolean;
}

/** A local release artifact that was hashed during verification. */
export interface VerifiedArtifact {
  /** Absolute path of the file that was read. */
  path: string;
  /** SHA-256 of the file's bytes. */
  wasmHash: string;
  /** Whether the file matches the hash recorded in the manifest. */
  matches: boolean;
}

export interface DeploymentVerificationResult extends WasmHashComparison {
  contractId: string;
  /** Artifact name from the manifest, when verification came from one. */
  contractName?: string;
  /** Present when a local release artifact was also checked. */
  artifact?: VerifiedArtifact;
  /** When the check ran, in milliseconds since the epoch. */
  checkedAt: number;
  /** Human-readable outcome, suitable for logs and a CI summary. */
  message: string;
}

export interface VerifyDeploymentOptions {
  /** RPC source used to read the deployed wasm. */
  source: DeployedWasmSource;
  /** Address of the deployed contract to verify. */
  contractId: string;
  /** SHA-256 recorded by the release for this contract. */
  expectedWasmHash: string;
  /** Contract name used in log messages. */
  contractName?: string;
  /**
   * Local release artifact to hash as well. When provided, the result only
   * matches if both the artifact and the deployed wasm match the release hash.
   */
  artifactPath?: string;
  /** Base directory for a relative `artifactPath`. Defaults to `process.cwd()`. */
  artifactDir?: string;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface VerifyReleaseOptions {
  /** Parsed manifest, or its raw JSON text. */
  manifest: ReleaseManifest | string | unknown;
  /** Deployed contract ID per artifact name. Extra keys are ignored. */
  contractIds: Record<string, string>;
  source: DeployedWasmSource;
  /** Base directory for relative `wasmPath` entries. */
  artifactDir?: string;
  /**
   * Hash each artifact's `wasmPath` and require it to match the manifest.
   * Defaults to `true`; artifacts without a `wasmPath` are skipped.
   */
  verifyArtifacts?: boolean;
  /**
   * Network the operator believes is being verified. When both this and
   * `manifest.network` are set, a mismatch is rejected so a testnet manifest
   * cannot be checked against mainnet.
   */
  network?: string;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface ReleaseVerificationReport {
  manifestVersion: string;
  network?: string;
  checkedAt: number;
  /** `true` only when every artifact's deployed wasm matched the release. */
  matchesAll: boolean;
  results: DeploymentVerificationResult[];
}

/**
 * Validate and normalise a SHA-256 hash.
 *
 * Accepts an optional `0x` prefix and any letter case, and returns the
 * canonical lowercase hex form. Anything that is not a 32-byte digest is
 * rejected rather than compared loosely.
 */
export function normalizeWasmHash(value: unknown, label = 'wasm hash'): string {
  if (typeof value !== 'string') {
    throw new DeploymentVerificationError(
      'invalid_hash',
      `${label} must be a 64-character hex string`,
    );
  }

  const normalized = value.trim().replace(/^0x/i, '').toLowerCase();
  if (!WASM_HASH_PATTERN.test(normalized)) {
    throw new DeploymentVerificationError(
      'invalid_hash',
      `${label} must be a 64-character hex string, got "${value}"`,
    );
  }
  return normalized;
}

/** SHA-256 of `bytes`, as lowercase hex. */
export function sha256Hex(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) {
    throw new DeploymentVerificationError(
      'invalid_wasm',
      'wasm bytes must be a Uint8Array',
    );
  }
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** Whether `bytes` starts with the wasm magic number. */
export function isWasmModule(bytes: Uint8Array): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length < WASM_MAGIC.length) {
    return false;
  }
  return WASM_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** Whether `value` is a valid Stellar contract StrKey. */
export function isValidContractId(value: unknown): value is string {
  return typeof value === 'string' && CONTRACT_ID_PATTERN.test(value);
}

/**
 * Validate a release manifest.
 *
 * Unknown fields are tolerated so a newer release pipeline can add metadata
 * without breaking older verifiers. Duplicate artifact names are rejected:
 * they would make `contractIds[name]` ambiguous.
 *
 * @throws {DeploymentVerificationError} with code `invalid_manifest`,
 *   `invalid_hash`, or `missing_contract_id` for an unusable manifest.
 */
export function parseReleaseManifest(raw: unknown): ReleaseManifest {
  let payload = raw;

  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      throw new DeploymentVerificationError(
        'invalid_manifest',
        'release manifest is not valid JSON',
        { cause: err },
      );
    }
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new DeploymentVerificationError(
      'invalid_manifest',
      'release manifest must be a JSON object',
    );
  }

  const candidate = payload as Record<string, unknown>;

  if (typeof candidate.version !== 'string' || candidate.version.trim() === '') {
    throw new DeploymentVerificationError(
      'invalid_manifest',
      'release manifest must have a non-empty version',
    );
  }

  let network: string | undefined;
  if (candidate.network !== undefined) {
    if (typeof candidate.network !== 'string' || candidate.network.trim() === '') {
      throw new DeploymentVerificationError(
        'invalid_manifest',
        'release manifest network must be a non-empty string when set',
      );
    }
    network = candidate.network.trim();
  }

  if (!Array.isArray(candidate.artifacts) || candidate.artifacts.length === 0) {
    throw new DeploymentVerificationError(
      'invalid_manifest',
      'release manifest must list at least one artifact',
    );
  }

  const names = new Set<string>();
  const artifacts = candidate.artifacts.map((rawArtifact, index) => {
    if (
      typeof rawArtifact !== 'object' ||
      rawArtifact === null ||
      Array.isArray(rawArtifact)
    ) {
      throw new DeploymentVerificationError(
        'invalid_manifest',
        `artifacts[${index}] must be an object`,
      );
    }

    const artifact = rawArtifact as Record<string, unknown>;
    if (typeof artifact.name !== 'string' || artifact.name.trim() === '') {
      throw new DeploymentVerificationError(
        'invalid_manifest',
        `artifacts[${index}].name must be a non-empty string`,
      );
    }

    const name = artifact.name.trim();
    if (names.has(name)) {
      throw new DeploymentVerificationError(
        'invalid_manifest',
        `release manifest lists artifact "${name}" more than once`,
      );
    }
    names.add(name);

    let wasmPath: string | undefined;
    if (artifact.wasmPath !== undefined) {
      if (typeof artifact.wasmPath !== 'string' || artifact.wasmPath.trim() === '') {
        throw new DeploymentVerificationError(
          'invalid_manifest',
          `artifacts[${index}].wasmPath must be a non-empty string when set`,
        );
      }
      wasmPath = artifact.wasmPath.trim();
    }

    return {
      name,
      wasmHash: normalizeWasmHash(
        artifact.wasmHash,
        `artifacts[${index}].wasmHash`,
      ),
      ...(wasmPath ? { wasmPath } : {}),
    };
  });

  return {
    version: candidate.version.trim(),
    ...(network ? { network } : {}),
    artifacts,
  };
}

export interface HashedWasmArtifact {
  /** Absolute path of the file that was read. */
  path: string;
  wasmHash: string;
  size: number;
}

/**
 * Read a local wasm release artifact and hash it.
 *
 * The file must exist and start with the wasm magic number; a text file or an
 * empty file is reported as `invalid_wasm` instead of producing a meaningless
 * hash that can never match.
 *
 * @throws {DeploymentVerificationError} with code `artifact_unreadable` or
 *   `invalid_wasm`.
 */
export async function readWasmArtifact(
  filePath: string,
  baseDir: string = process.cwd(),
): Promise<HashedWasmArtifact> {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new DeploymentVerificationError(
      'artifact_unreadable',
      'release artifact path must be a non-empty string',
    );
  }

  const resolved = path.resolve(baseDir, filePath);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolved);
  } catch (err) {
    throw new DeploymentVerificationError(
      'artifact_unreadable',
      `unable to read release artifact at ${resolved}`,
      { cause: err },
    );
  }

  if (!isWasmModule(bytes)) {
    throw new DeploymentVerificationError(
      'invalid_wasm',
      `release artifact ${resolved} is not a wasm module`,
    );
  }

  return { path: resolved, wasmHash: sha256Hex(bytes), size: bytes.length };
}

function isContractNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === 404) return true;
  const text =
    typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return /not found|could not obtain contract hash|does not exist/.test(text);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Read the wasm currently installed behind `contractId` and hash it.
 *
 * Soroban RPC resolves the contract instance's executable and returns the wasm
 * bytes; hashing those bytes proves exactly what code is live. A contract that
 * is not deployed, or whose executable is not a wasm module (for example a
 * Stellar Asset Contract), is reported as `deployed_wasm_unavailable`.
 *
 * @throws {DeploymentVerificationError} with code `invalid_contract_id`,
 *   `deployed_wasm_unavailable`, `invalid_wasm`, or `rpc_error`.
 */
export async function fetchDeployedWasmHash(
  source: DeployedWasmSource,
  contractId: string,
): Promise<string> {
  if (!isValidContractId(contractId)) {
    throw new DeploymentVerificationError(
      'invalid_contract_id',
      `"${contractId}" is not a valid Stellar contract ID`,
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await source.getContractWasmByContractId(contractId);
  } catch (err) {
    if (isContractNotFound(err)) {
      throw new DeploymentVerificationError(
        'deployed_wasm_unavailable',
        `no deployed wasm was found for contract ${contractId}`,
        { cause: err },
      );
    }
    throw new DeploymentVerificationError(
      'rpc_error',
      `unable to read the deployed wasm for contract ${contractId}: ${errorMessage(err)}`,
      { cause: err },
    );
  }

  if (!isWasmModule(bytes)) {
    throw new DeploymentVerificationError(
      'invalid_wasm',
      `the deployed code for contract ${contractId} is not a wasm module`,
    );
  }

  return sha256Hex(bytes);
}

/** Compare an expected release hash with a deployed hash. */
export function compareWasmHashes(
  expected: unknown,
  deployed: unknown,
): WasmHashComparison {
  const expectedWasmHash = normalizeWasmHash(expected, 'expected wasm hash');
  const deployedWasmHash = normalizeWasmHash(deployed, 'deployed wasm hash');
  return {
    expectedWasmHash,
    deployedWasmHash,
    matches: expectedWasmHash === deployedWasmHash,
  };
}

function formatDeploymentMessage(result: Omit<DeploymentVerificationResult, 'message'>): string {
  const target = result.contractName
    ? `${result.contractName} (${result.contractId})`
    : result.contractId;

  if (result.matches) {
    return `deployed wasm matches the release for ${target}`;
  }

  const reasons: string[] = [];
  if (result.expectedWasmHash !== result.deployedWasmHash) {
    reasons.push(
      `release expects ${result.expectedWasmHash} but the deployed wasm is ${result.deployedWasmHash}`,
    );
  }
  if (result.artifact && !result.artifact.matches) {
    reasons.push(
      `local artifact ${result.artifact.path} hashes to ${result.artifact.wasmHash}, not the release hash`,
    );
  }

  return `deployment verification failed for ${target}: ${reasons.join('; ')}`;
}

/**
 * Verify one deployed contract against a release hash.
 *
 * When `artifactPath` is supplied the local artifact is checked too, so a
 * mismatched deployment and a tampered release file are both caught in one
 * call. A mismatch is returned as `matches: false` rather than thrown.
 *
 * @throws {DeploymentVerificationError} when the comparison cannot be made.
 */
export async function verifyDeployment(
  options: VerifyDeploymentOptions,
): Promise<DeploymentVerificationResult> {
  const now = options.now ?? Date.now;
  const expectedWasmHash = normalizeWasmHash(
    options.expectedWasmHash,
    'expected wasm hash',
  );
  const deployedWasmHash = await fetchDeployedWasmHash(
    options.source,
    options.contractId,
  );

  let artifact: VerifiedArtifact | undefined;
  if (options.artifactPath !== undefined) {
    const hashed = await readWasmArtifact(
      options.artifactPath,
      options.artifactDir,
    );
    artifact = {
      path: hashed.path,
      wasmHash: hashed.wasmHash,
      matches: hashed.wasmHash === expectedWasmHash,
    };
  }

  const base: Omit<DeploymentVerificationResult, 'message'> = {
    contractId: options.contractId,
    ...(options.contractName !== undefined
      ? { contractName: options.contractName }
      : {}),
    expectedWasmHash,
    deployedWasmHash,
    matches:
      expectedWasmHash === deployedWasmHash && (artifact ? artifact.matches : true),
    ...(artifact ? { artifact } : {}),
    checkedAt: now(),
  };

  return { ...base, message: formatDeploymentMessage(base) };
}

/**
 * Verify every artifact in a release manifest against its deployed contract.
 *
 * The manifest is validated first, then each artifact is resolved through
 * `contractIds`. All artifacts are checked even if an earlier one mismatches,
 * so the report covers the whole release. Extra keys in `contractIds` are
 * ignored, which lets one address map serve several manifests.
 *
 * @throws {DeploymentVerificationError} with code `missing_contract_id` when
 *   an artifact has no deployed address, `invalid_manifest` for an unusable
 *   manifest, `network_mismatch` when the networks disagree, or any of the
 *   per-contract errors from {@link verifyDeployment}.
 */
export async function verifyReleaseManifest(
  options: VerifyReleaseOptions,
): Promise<ReleaseVerificationReport> {
  const manifest = parseReleaseManifest(options.manifest);

  if (
    manifest.network !== undefined &&
    options.network !== undefined &&
    manifest.network.toLowerCase() !== options.network.trim().toLowerCase()
  ) {
    throw new DeploymentVerificationError(
      'network_mismatch',
      `release manifest is for ${manifest.network} but verification was requested for ${options.network}`,
    );
  }

  const now = options.now ?? Date.now;
  const contractIds = options.contractIds ?? {};
  const results: DeploymentVerificationResult[] = [];

  for (const artifact of manifest.artifacts) {
    const contractId = contractIds[artifact.name];
    if (typeof contractId !== 'string' || contractId.trim() === '') {
      throw new DeploymentVerificationError(
        'missing_contract_id',
        `no deployed contract ID was provided for release artifact "${artifact.name}"`,
      );
    }

    results.push(
      await verifyDeployment({
        source: options.source,
        contractId: contractId.trim(),
        expectedWasmHash: artifact.wasmHash,
        contractName: artifact.name,
        artifactPath:
          options.verifyArtifacts === false ? undefined : artifact.wasmPath,
        artifactDir: options.artifactDir,
        now,
      }),
    );
  }

  return {
    manifestVersion: manifest.version,
    ...(manifest.network !== undefined ? { network: manifest.network } : {}),
    checkedAt: now(),
    matchesAll: results.every((result) => result.matches),
    results,
  };
}
