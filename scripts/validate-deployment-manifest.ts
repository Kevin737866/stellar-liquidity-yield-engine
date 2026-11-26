import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateDeploymentManifest } from '../sdk/src/deploymentManifest';

function usage(): string {
  return 'Usage: npm run validate:deployment-manifest -- <path-to-manifest.json>';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage());
    return;
  }

  if (args.length !== 1) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const manifestPath = resolve(args[0]);
  let manifest: unknown;

  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    console.error(`Unable to read deployment manifest ${manifestPath}: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }

  const result = validateDeploymentManifest(manifest);
  if (!result.valid) {
    for (const item of result.issues) {
      console.error(`${item.path}: ${item.message} (${item.code})`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Validated ${Object.keys(result.contractIds).length} contract ID(s) in ${manifestPath}`);
  for (const [name, contractId] of Object.entries(result.contractIds)) {
    console.log(`  ${name}: ${contractId}`);
  }
}

main();
