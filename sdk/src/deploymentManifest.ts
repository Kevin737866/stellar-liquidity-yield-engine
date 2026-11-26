import { StrKey } from 'stellar-sdk';

export type DeploymentManifestErrorCode =
  | 'INVALID_MANIFEST'
  | 'MISSING_CONTRACT_IDS'
  | 'INVALID_CONTRACT_ID'
  | 'DUPLICATE_CONTRACT_NAME'
  | 'DUPLICATE_CONTRACT_ID';

export interface DeploymentManifestIssue {
  readonly path: string;
  readonly code: DeploymentManifestErrorCode;
  readonly message: string;
}

export interface DeploymentManifestValidationResult {
  readonly valid: boolean;
  readonly contractIds: Readonly<Record<string, string>>;
  readonly issues: readonly DeploymentManifestIssue[];
}

export class DeploymentManifestError extends Error {
  constructor(
    message: string,
    public readonly code: DeploymentManifestErrorCode,
    public readonly issues: readonly DeploymentManifestIssue[] = [],
  ) {
    super(message);
    this.name = 'DeploymentManifestError';
  }
}

export const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

const CONTRACT_ID_FIELDS = ['contractId', 'id', 'address'] as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeContractId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function issue(
  path: string,
  code: DeploymentManifestErrorCode,
  message: string,
): DeploymentManifestIssue {
  return { path, code, message };
}

function extractId(value: unknown): unknown {
  if (!isRecord(value)) return value;
  for (const field of CONTRACT_ID_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      return value[field];
    }
  }
  return undefined;
}

export function isValidContractId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CONTRACT_ID_PATTERN.test(value) &&
    StrKey.isValidContract(value)
  );
}

function acceptContractId(
  name: string,
  rawValue: unknown,
  path: string,
  contractIds: Record<string, string>,
  issues: DeploymentManifestIssue[],
): void {
  const normalized = normalizeContractId(rawValue);

  if (normalized === undefined) {
    issues.push(issue(path, 'INVALID_CONTRACT_ID', 'contract ID is missing or blank.'));
    return;
  }
  if (!isValidContractId(normalized)) {
    issues.push(
      issue(
        path,
        'INVALID_CONTRACT_ID',
        `"${normalized}" is not a valid Stellar contract ID; expected C followed by 55 base32 characters with a valid checksum.`,
      ),
    );
    return;
  }
  if (Object.values(contractIds).includes(normalized)) {
    issues.push(
      issue(path, 'DUPLICATE_CONTRACT_ID', `contract ID "${normalized}" is already assigned to another role.`),
    );
    return;
  }

  contractIds[name] = normalized;
}

function acceptName(
  rawName: unknown,
  path: string,
  contractIds: Record<string, string>,
  issues: DeploymentManifestIssue[],
): string | undefined {
  const name = normalizeName(rawName);
  if (name === undefined) {
    issues.push(issue(path, 'INVALID_MANIFEST', 'contract role name is missing or blank.'));
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(contractIds, name)) {
    issues.push(issue(path, 'DUPLICATE_CONTRACT_NAME', `contract role "${name}" is declared more than once.`));
    return undefined;
  }
  return name;
}

function validateContractsObject(
  contracts: UnknownRecord,
  contractIds: Record<string, string>,
  issues: DeploymentManifestIssue[],
): void {
  for (const [rawName, value] of Object.entries(contracts)) {
    const name = acceptName(rawName, `contracts.${rawName}`, contractIds, issues);
    if (name === undefined) continue;
    acceptContractId(name, extractId(value), `contracts.${rawName}`, contractIds, issues);
  }
}

function validateContractsArray(
  contracts: readonly unknown[],
  contractIds: Record<string, string>,
  issues: DeploymentManifestIssue[],
): void {
  contracts.forEach((entry, index) => {
    if (!isRecord(entry)) {
      issues.push(issue(`contracts[${index}]`, 'INVALID_MANIFEST', 'contract entry must be an object.'));
      return;
    }
    const name = acceptName(entry.name, `contracts[${index}].name`, contractIds, issues);
    if (name === undefined) return;
    acceptContractId(name, extractId(entry), `contracts[${index}].contractId`, contractIds, issues);
  });
}

export function validateDeploymentManifest(manifest: unknown): DeploymentManifestValidationResult {
  const contractIds: Record<string, string> = {};
  const issues: DeploymentManifestIssue[] = [];

  if (!isRecord(manifest)) {
    return {
      valid: false,
      contractIds,
      issues: [issue('manifest', 'INVALID_MANIFEST', 'deployment manifest must be a JSON object.')],
    };
  }

  const declared = manifest.contractIds ?? manifest.contracts;
  if (declared === undefined || declared === null) {
    issues.push(
      issue('manifest', 'MISSING_CONTRACT_IDS', 'deployment manifest must define contractIds or contracts.'),
    );
  } else if (isRecord(declared)) {
    if (Object.keys(declared).length === 0) {
      issues.push(issue('contractIds', 'MISSING_CONTRACT_IDS', 'no contract IDs were declared.'));
    } else {
      validateContractsObject(declared, contractIds, issues);
    }
  } else if (Array.isArray(declared)) {
    if (declared.length === 0) {
      issues.push(issue('contracts', 'MISSING_CONTRACT_IDS', 'no contract IDs were declared.'));
    } else {
      validateContractsArray(declared, contractIds, issues);
    }
  } else {
    issues.push(
      issue('manifest', 'INVALID_MANIFEST', 'contractIds and contracts must be objects or arrays.'),
    );
  }

  return { valid: issues.length === 0, contractIds, issues };
}

export function assertValidDeploymentManifest(manifest: unknown): Record<string, string> {
  const result = validateDeploymentManifest(manifest);
  if (!result.valid) {
    throw new DeploymentManifestError(
      'Deployment manifest contract ID validation failed.',
      result.issues[0].code,
      result.issues,
    );
  }
  return { ...result.contractIds };
}
