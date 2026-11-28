const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const path = require('node:path');

const uiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(uiRoot, '..');

test('dashboard env example documents every public dashboard variable', () => {
  const example = readFileSync(path.join(uiRoot, '.env.example'), 'utf8');
  const variables = [
    'NEXT_PUBLIC_STELLAR_NETWORK',
    'NEXT_PUBLIC_TESTNET_HORIZON_URL',
    'NEXT_PUBLIC_TESTNET_SOROBAN_RPC_URL',
    'NEXT_PUBLIC_MAINNET_HORIZON_URL',
    'NEXT_PUBLIC_MAINNET_SOROBAN_RPC_URL',
    'NEXT_PUBLIC_TESTNET_NETWORK_PASSPHRASE',
    'NEXT_PUBLIC_MAINNET_NETWORK_PASSPHRASE',
    'NEXT_PUBLIC_YIELD_ENGINE_CONTRACT_ID',
    'NEXT_PUBLIC_REWARD_DISTRIBUTOR_CONTRACT_ID',
    'NEXT_PUBLIC_REBALANCE_ENGINE_CONTRACT_ID',
    'NEXT_PUBLIC_STRATEGY_REGISTRY_CONTRACT_ID',
    'NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID',
    'NEXT_PUBLIC_VOTING_ESCROW_CONTRACT_ID',
    'NEXT_PUBLIC_STAKING_CONTRACT_ID',
    'NEXT_PUBLIC_FEE_DISTRIBUTOR_CONTRACT_ID',
  ];

  for (const variable of variables) {
    assert.match(
      example,
      new RegExp(`^\\s*#?\\s*${variable}=`, 'm'),
      `${variable} missing`
    );
  }
});

test('dashboard documentation describes precedence and public build-time behavior', () => {
  const doc = readFileSync(
    path.join(repoRoot, 'docs', 'DASHBOARD_ENVIRONMENT.md'),
    'utf8'
  );

  assert.match(doc, /existing shell or deployment-platform environment/i);
  assert.match(doc, /ui\/\.env\.local/);
  assert.match(doc, /rebuild or redeploy/i);
  assert.match(doc, /public and are inlined/i);
  assert.match(doc, /Never add `BOT_PRIVATE_KEY`/);
});

test('README links the dashboard environment reference', () => {
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(readme, /\[Dashboard environment variables\]\(docs\/DASHBOARD_ENVIRONMENT\.md\)/);
});
