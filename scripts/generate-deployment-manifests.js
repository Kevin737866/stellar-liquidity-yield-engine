#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const WASM_PATH =
  'target/wasm32-unknown-unknown/release/stellar_liquidity_yield_engine.wasm';

const CONTRACTS = {
  engine: ['admin', 'strategy_registry', 'reward_distributor'],
  'yield-vault': [
    'admin',
    'name',
    'token_a',
    'token_b',
    'pool_id',
    'strategy_id',
    'fee_rate',
    'harvest_fee',
    'withdrawal_fee',
    'treasury',
  ],
  'rebalance-engine': ['admin'],
  'reward-distributor': ['admin', 'treasury', 'swap_router'],
  'strategy-registry': ['admin'],
  'il-insurance': ['admin', 'reserve_token'],
  actuary: ['admin'],
  'oracle-registry': ['admin'],
  'risk-engine': ['admin'],
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(
      `${label} must contain exactly: ${wanted.join(', ')}`,
    );
  }
}

function validateSchema(schema) {
  assertExactKeys(schema, ['schemaVersion', 'networks', 'contracts'], 'schema');
  if (schema.schemaVersion !== 1) {
    throw new Error('schema.schemaVersion must be 1');
  }
  if (!isRecord(schema.networks) || Object.keys(schema.networks).length === 0) {
    throw new Error('schema.networks must be a non-empty object');
  }
  if (!Array.isArray(schema.contracts) || schema.contracts.length === 0) {
    throw new Error('schema.contracts must be a non-empty array');
  }

  for (const [name, network] of Object.entries(schema.networks)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new Error(`invalid network name: ${name}`);
    }
    assertExactKeys(
      network,
      ['cliNetwork', 'rpcUrl', 'horizonUrl', 'networkPassphrase'],
      `network ${name}`,
    );
    if (!['testnet', 'mainnet'].includes(network.cliNetwork)) {
      throw new Error(`network ${name}.cliNetwork must be testnet or mainnet`);
    }
    for (const field of ['rpcUrl', 'horizonUrl']) {
      let url;
      try {
        url = new URL(network[field]);
      } catch {
        throw new Error(`network ${name}.${field} must be a valid HTTPS URL`);
      }
      if (url.protocol !== 'https:') {
        throw new Error(`network ${name}.${field} must be a valid HTTPS URL`);
      }
    }
    if (
      typeof network.networkPassphrase !== 'string' ||
      network.networkPassphrase.trim() === ''
    ) {
      throw new Error(`network ${name}.networkPassphrase must be a non-empty string`);
    }
  }

  const seenContracts = new Set();
  for (const contract of schema.contracts) {
    assertExactKeys(contract, ['name', 'initialize'], 'contract');
    if (typeof contract.name !== 'string' || !Object.hasOwn(CONTRACTS, contract.name)) {
      throw new Error(`unsupported contract: ${contract.name}`);
    }
    if (seenContracts.has(contract.name)) {
      throw new Error(`duplicate contract: ${contract.name}`);
    }
    seenContracts.add(contract.name);

    assertExactKeys(contract.initialize, CONTRACTS[contract.name], `${contract.name}.initialize`);
    for (const [argument, value] of Object.entries(contract.initialize)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${contract.name}.initialize.${argument} must be a non-empty string`);
      }
    }
  }
}

function generateManifests(schema) {
  validateSchema(schema);
  const manifests = {};

  for (const [name, network] of Object.entries(schema.networks)) {
    manifests[name] = {
      schemaVersion: schema.schemaVersion,
      network: name,
      ...network,
      contracts: schema.contracts.map(({ name: contractName, initialize }) => ({
        name: contractName,
        build: {
          feature: contractName,
          wasmPath: WASM_PATH,
        },
        initialize: {
          method: 'initialize',
          arguments: initialize,
        },
      })),
    };
  }

  return manifests;
}

function parseArgs(args) {
  const options = {
    schemaPath: 'deployments/schema.json',
    outputDir: 'deployments/manifests',
  };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option !== '--schema' && option !== '--output-dir') {
      throw new Error(`unknown argument: ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${option} requires a path`);
    }
    options[option === '--schema' ? 'schemaPath' : 'outputDir'] = value;
    index += 1;
  }
  return options;
}

function main(args) {
  const options = parseArgs(args);
  const schemaPath = path.resolve(process.cwd(), options.schemaPath);
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const manifests = generateManifests(schema);
  const outputDir = path.resolve(process.cwd(), options.outputDir);

  fs.mkdirSync(outputDir, { recursive: true });
  for (const [network, manifest] of Object.entries(manifests)) {
    fs.writeFileSync(
      path.join(outputDir, `${network}.json`),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  console.log(`Generated ${Object.keys(manifests).length} deployment manifests in ${outputDir}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Unable to generate deployment manifests: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { generateManifests, validateSchema };
