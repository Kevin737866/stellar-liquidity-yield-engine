/**
 * Example: verify that deployed wasm matches a release manifest
 *
 * This is the operator-facing check for "what is actually behind this contract
 * address?". It reads the release manifest, fetches the wasm installed for each
 * contract from Soroban RPC, hashes it, and compares the result with the hash
 * the release promised. When an artifact path is present it hashes the local
 * file too, so a corrupted release file is caught before the on-chain check.
 *
 * ## Release manifest
 *
 * ```json
 * {
 *   "version": "0.1.0",
 *   "network": "testnet",
 *   "artifacts": [
 *     {
 *       "name": "yield-vault",
 *       "wasmHash": "<64-character sha256>",
 *       "wasmPath": "yield-vault.wasm"
 *     }
 *   ]
 * }
 * ```
 *
 * `wasmPath` is optional. When present it is resolved relative to
 * `--artifact-dir`, which defaults to the manifest's directory.
 *
 * ## Running
 *
 * ```bash
 * npx ts-node examples/verify-deployment.ts \
 *   --manifest ./release-manifest.json \
 *   --network testnet \
 *   --contract yield-vault=C... \
 *   --contract reward-distributor=C...
 * ```
 *
 * Exit code is `0` only when every deployed wasm matches the release.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { SorobanRpc } from 'stellar-sdk';

import {
  DeploymentVerificationError,
  verifyReleaseManifest,
  type ReleaseVerificationReport,
} from '../sdk/src/deploymentVerification';

const NETWORKS = {
  testnet: {
    rpcUrl: 'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    rpcUrl: 'https://soroban.stellar.org',
  },
} as const;

type Network = keyof typeof NETWORKS;

interface CliOptions {
  manifestPath: string;
  network: Network;
  contractIds: Record<string, string>;
  artifactDir: string;
  verifyArtifacts: boolean;
}

function usage(): string {
  return [
    'Usage:',
    '  npx ts-node examples/verify-deployment.ts --manifest <path> [options]',
    '',
    'Required:',
    '  --manifest <path>          Release manifest JSON',
    '',
    'Options:',
    '  --network <testnet|mainnet>  Network to verify (default: testnet)',
    '  --contract <name=address>    Deployed contract per artifact; repeatable',
    '  --artifact-dir <path>        Base for relative wasmPath (default: manifest dir)',
    '  --skip-artifacts             Only verify on-chain wasm, not local files',
    '  --help                       Show this help',
  ].join('\n');
}

function parseArgs(argv: string[]): CliOptions | null {
  let manifestPath: string | undefined;
  let network: Network = 'testnet';
  let artifactDir: string | undefined;
  let verifyArtifacts = true;
  const contractIds: Record<string, string> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--help':
      case '-h':
        return null;

      case '--manifest': {
        manifestPath = argv[++i];
        break;
      }

      case '--network': {
        const value = argv[++i];
        if (value !== 'testnet' && value !== 'mainnet') {
          throw new Error(`--network must be "testnet" or "mainnet" (got ${value ?? 'nothing'})`);
        }
        network = value;
        break;
      }

      case '--contract': {
        const value = argv[++i];
        if (!value || !value.includes('=')) {
          throw new Error('--contract expects <artifact-name>=<contract-id>');
        }
        const index = value.indexOf('=');
        const name = value.slice(0, index).trim();
        const contractId = value.slice(index + 1).trim();
        if (!name || !contractId) {
          throw new Error('--contract expects <artifact-name>=<contract-id>');
        }
        contractIds[name] = contractId;
        break;
      }

      case '--artifact-dir': {
        artifactDir = argv[++i];
        if (!artifactDir) throw new Error('--artifact-dir expects a path');
        break;
      }

      case '--skip-artifacts': {
        verifyArtifacts = false;
        break;
      }

      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!manifestPath) {
    throw new Error('--manifest is required');
  }

  const resolvedManifest = path.resolve(manifestPath);

  return {
    manifestPath: resolvedManifest,
    network,
    contractIds,
    artifactDir: path.resolve(artifactDir ?? path.dirname(resolvedManifest)),
    verifyArtifacts,
  };
}

function printReport(report: ReleaseVerificationReport): void {
  console.log(`Release ${report.manifestVersion} on ${report.network ?? 'unspecified network'}`);

  for (const result of report.results) {
    const name = result.contractName ?? result.contractId;
    console.log(`\n${result.matches ? '✅' : '❌'} ${name} (${result.contractId})`);
    console.log(`   release : ${result.expectedWasmHash}`);
    console.log(`   deployed: ${result.deployedWasmHash}`);
    if (result.artifact) {
      console.log(
        `   artifact: ${result.artifact.wasmHash} (${result.artifact.matches ? 'matches' : 'MISMATCH'})`,
      );
    }
    console.log(`   ${result.message}`);
  }

  const matched = report.results.filter((result) => result.matches).length;
  console.log(
    `\n${report.matchesAll ? '✅' : '❌'} ${matched}/${report.results.length} deployed ` +
      `contract(s) match the release.`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) {
    console.log(usage());
    return;
  }

  const network = NETWORKS[options.network];
  const rpcUrl = process.env.SOROBAN_RPC_URL || network.rpcUrl;
  const manifest = await fs.readFile(options.manifestPath, 'utf8');

  console.log(`Verifying ${options.manifestPath} against ${rpcUrl}`);

  const report = await verifyReleaseManifest({
    manifest,
    contractIds: options.contractIds,
    source: new SorobanRpc.Server(rpcUrl),
    artifactDir: options.artifactDir,
    verifyArtifacts: options.verifyArtifacts,
    network: options.network,
  });

  printReport(report);
  if (!report.matchesAll) process.exitCode = 1;
}

main().catch((err) => {
  if (err instanceof DeploymentVerificationError) {
    console.error(`Deployment verification failed [${err.code}]: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
