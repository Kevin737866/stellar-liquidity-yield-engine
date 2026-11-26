# Verifying deployed wasm against release artifacts

Issue: [#503](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/503).

`upgrade` and the `contract_upgraded` event prove **that** a contract's code
changed. They do not prove **which release** is now live. This document covers
the off-chain check that closes that gap: compare the wasm hash installed behind
each contract address with the hash recorded in the release manifest.

The implementation lives in:

| File | Responsibility |
| --- | --- |
| `sdk/src/deploymentVerification.ts` | Manifest parsing, artifact hashing, RPC hash lookup, and the comparison report. |
| `sdk/src/deploymentVerification.test.ts` | Normal, boundary, and failure cases. |
| `examples/verify-deployment.ts` | Operator CLI for verifying a whole release. |

## Why byte-exact hashes

Soroban identifies wasm by the SHA-256 of the **installed bytes**. Building from
the same commit is not enough:

- a different compiler or Rust target changes the bytes;
- Cargo features change which entrypoints exist and therefore the bytes;
- `soroban contract optimize` rewrites the module;
- stripping or debug settings change the bytes.

The release artifact in the manifest must be the exact file that was used with
`soroban contract install`. Verify before deploys and upgrades, and record the
same hash in the release notes for audit.

## Release manifest

A manifest is a JSON object with the release version, an optional network, and
one entry per artifact:

```json
{
  "version": "0.1.0",
  "network": "testnet",
  "artifacts": [
    {
      "name": "yield-vault",
      "wasmHash": "9f2c...64 lowercase hex characters",
      "wasmPath": "yield-vault.wasm"
    },
    {
      "name": "reward-distributor",
      "wasmHash": "1ab4...64 lowercase hex characters"
    }
  ]
}
```

- `version` — required, non-empty.
- `network` — optional. When both the manifest and `verifyReleaseManifest`
  specify a network they must agree; a testnet manifest cannot be checked
  against mainnet.
- `name` — required, unique within the manifest. It is the key used to look up
  the deployed contract ID.
- `wasmHash` — required SHA-256 digest, 64 hex characters. `0x` prefixes and
  uppercase letters are accepted and normalised to lowercase.
- `wasmPath` — optional path to the release artifact, relative to the manifest
  directory. When present, the file is hashed and must match `wasmHash` too.
  Artifacts without a path are checked on-chain only.

Unknown fields are ignored so newer release tooling can add metadata without
breaking older verifiers.

Generate the hashes from the exact files you ship:

```bash
sha256sum yield-vault.wasm reward-distributor.wasm
```

## Operator CLI

```bash
npx ts-node examples/verify-deployment.ts \
  --manifest ./release-manifest.json \
  --network testnet \
  --contract yield-vault=CDLZ... \
  --contract reward-distributor=CB4X...
```

Options:

| Flag | Meaning |
| --- | --- |
| `--manifest <path>` | Release manifest JSON. Required. |
| `--network <testnet\|mainnet>` | Network to verify. Defaults to `testnet`. |
| `--contract <name=address>` | Deployed contract ID for one artifact. Repeat for each artifact. |
| `--artifact-dir <path>` | Base directory for `wasmPath`. Defaults to the manifest's directory. |
| `--skip-artifacts` | Check only the on-chain wasm, not local release files. |

`soroban` (newer CLIs: `stellar`) prints a contract address as `C...`. Pass the
same address that is in `.env` / the deployment record. The RPC endpoint defaults
to the public testnet/mainnet endpoint and can be overridden with
`SOROBAN_RPC_URL`.

The command exits `0` only when every deployed wasm matches the release. A
mismatch prints the expected and deployed hashes and exits `1`.

## Programmatic use

```ts
import { SorobanRpc } from 'stellar-sdk';
import {
  verifyDeployment,
  verifyReleaseManifest,
} from 'stellar-liquidity-yield-engine-sdk';

// One contract
const single = await verifyDeployment({
  source: new SorobanRpc.Server(TESTNET_CONFIG.sorobanRpcUrl),
  contractId: YIELD_VAULT_ID,
  contractName: 'yield-vault',
  expectedWasmHash: release.artifacts[0].wasmHash,
  artifactPath: 'artifacts/yield-vault.wasm',
});

// A whole release
const report = await verifyReleaseManifest({
  manifest,
  contractIds: {
    'yield-vault': YIELD_VAULT_ID,
    'reward-distributor': REWARD_DISTRIBUTOR_ID,
  },
  source: new SorobanRpc.Server(TESTNET_CONFIG.sorobanRpcUrl),
  artifactDir: 'artifacts',
  network: 'testnet',
});

if (!report.matchesAll) {
  for (const result of report.results.filter((r) => !r.matches)) {
    console.error(result.message);
  }
  process.exitCode = 1;
}
```

Every `DeploymentVerificationResult` carries:

- `expectedWasmHash` — from the manifest;
- `deployedWasmHash` — read back from Soroban RPC;
- `artifact` — present when a local file was checked;
- `matches` — `true` only when the deployed hash (and the artifact, if any)
  equals the release hash;
- `message` — one-line explanation suitable for logs and CI output.

## Behaviour

| Situation | Result |
| --- | --- |
| Deployed wasm equals the release hash | `matches: true`, exit `0` |
| Deployed wasm differs | `matches: false`, exit `1`; both hashes are reported |
| Local artifact differs from the manifest hash | `matches: false` even if the deployed wasm matches |
| Artifact has no `wasmPath` | On-chain check only |
| Manifest has an artifact with no `--contract` address | `missing_contract_id` error, exit `1` |
| Manifest network and `--network` differ | `network_mismatch` error, exit `1` |
| Contract has no deployed wasm, or is not a wasm contract | `deployed_wasm_unavailable` error |
| RPC failure other than "not found" | `rpc_error` error |
| Malformed manifest, duplicate artifact name, bad hash | `invalid_manifest` / `invalid_hash` error |
| Missing, unreadable, empty, or non-wasm artifact file | `artifact_unreadable` / `invalid_wasm` error |

A hash mismatch is a **successful verification with a negative result**, not an
exception: the caller gets every result and can report all mismatched contracts
in one run. Errors are reserved for cases where a comparison is impossible.

## Release / upgrade checklist

1. Build each contract's wasm as described in the README (one feature per
   wasm).
2. Record `sha256sum` for every artifact in the release manifest.
3. Publish the manifest and artifacts together.
4. After `soroban contract install` / `deploy` / `upgrade` and `migrate`, run
   the verification CLI against the deployed addresses.
5. Archive the successful report with the release notes. If a mismatch is
   reported, treat the deployment as failed and follow the rollback flow in
   [UPGRADING.md](UPGRADING.md); do not announce the release.

The check is read-only: it needs no keys and changes no on-chain state. It is
safe to run from CI, a release job, or an operator workstation.

## Relationship to upgrades

- `get_storage_version()` describes the **storage layout**, not the build.
  Two builds with the same storage version can differ.
- `contract_upgraded` records the **new wasm hash** as seen by the chain, which
  is useful for monitoring. The release manifest is the independent expected
  value; comparing the two is what proves the release was installed.
- Roll back with `upgrade(admin, OLD_WASM_HASH)` as documented in
  [UPGRADING.md](UPGRADING.md), then re-run this verification against the
  rollback manifest/hash.

## Testing

```bash
npx jest sdk/src/deploymentVerification.test.ts --runInBand
```

The tests cover the matching path, mismatching deployed bytes, tampered local
artifacts, missing and malformed manifests, duplicate names, invalid hashes and
contract IDs, missing deployed wasm, RPC failures, missing contract IDs, and
network mismatches.
