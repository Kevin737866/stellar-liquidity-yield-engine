const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateManifests } = require('./generate-deployment-manifests');

const root = path.resolve(__dirname, '..');
const schemaPath = path.join(root, 'deployments/schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

describe('deployment manifest generator', () => {
  test('generates network-specific plans with the configured contracts and initializer arguments', () => {
    const manifests = generateManifests(schema);

    expect(Object.keys(manifests)).toEqual(['testnet', 'mainnet']);
    expect(manifests.testnet.rpcUrl).not.toBe(manifests.mainnet.rpcUrl);
    expect(manifests.testnet.networkPassphrase).not.toBe(manifests.mainnet.networkPassphrase);
    expect(manifests.testnet.contracts).toHaveLength(schema.contracts.length);
    expect(manifests.testnet.contracts[0]).toMatchObject({
      name: 'strategy-registry',
      build: {
        feature: 'strategy-registry',
        wasmPath: 'target/wasm32-unknown-unknown/release/stellar_liquidity_yield_engine.wasm',
      },
      initialize: {
        method: 'initialize',
        arguments: { admin: '${ADMIN_ADDRESS}' },
      },
    });
    expect(manifests.testnet.contracts.at(-1).name).toBe('engine');
  });

  test('rejects unknown contracts and incomplete initializer arguments', () => {
    const unknownContractSchema = structuredClone(schema);
    unknownContractSchema.contracts[0].name = 'governance';
    expect(() => generateManifests(unknownContractSchema)).toThrow('unsupported contract');

    const incompleteSchema = structuredClone(schema);
    delete incompleteSchema.contracts[0].initialize.admin;
    expect(() => generateManifests(incompleteSchema)).toThrow(
      'strategy-registry.initialize must contain exactly: admin',
    );
  });

  test('rejects invalid networks and duplicate contracts', () => {
    const insecureNetworkSchema = structuredClone(schema);
    insecureNetworkSchema.networks.testnet.rpcUrl = 'http://example.test';
    expect(() => generateManifests(insecureNetworkSchema)).toThrow(
      'network testnet.rpcUrl must be a valid HTTPS URL',
    );

    const duplicateContractSchema = structuredClone(schema);
    duplicateContractSchema.contracts.push(structuredClone(schema.contracts[0]));
    expect(() => generateManifests(duplicateContractSchema)).toThrow(
      'duplicate contract: strategy-registry',
    );
  });

  test('CLI writes stable JSON manifests to the requested directory', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-manifests-'));
    try {
      execFileSync(
        process.execPath,
        [path.join(__dirname, 'generate-deployment-manifests.js'), '--output-dir', outputDir],
        { cwd: root, stdio: 'pipe' },
      );

      for (const network of ['testnet', 'mainnet']) {
        const contents = fs.readFileSync(path.join(outputDir, `${network}.json`), 'utf8');
        expect(JSON.parse(contents)).toEqual(generateManifests(schema)[network]);
        expect(contents.endsWith('\n')).toBe(true);
      }
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('CLI rejects invalid schemas without creating an output directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invalid-deployment-schema-'));
    const invalidSchemaPath = path.join(tempDir, 'schema.json');
    const outputDir = path.join(tempDir, 'manifests');
    try {
      fs.writeFileSync(
        invalidSchemaPath,
        JSON.stringify({ ...schema, schemaVersion: 2 }),
      );
      expect(() =>
        execFileSync(
          process.execPath,
          [
            path.join(__dirname, 'generate-deployment-manifests.js'),
            '--schema',
            invalidSchemaPath,
            '--output-dir',
            outputDir,
          ],
          { cwd: root, stdio: 'pipe' },
        ),
      ).toThrow();
      expect(fs.existsSync(outputDir)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
