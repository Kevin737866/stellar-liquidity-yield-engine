# Contributing to Stellar Liquidity and Yield Optimization Engine

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Table of Contents
- [Development Workflow](#development-workflow)
- [Contract Change Checklist](#contract-change-checklist)
- [Code Standards](#code-standards)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)
- [Keeper Signing Key Rotation](#keeper-signing-key-rotation)
- [Community](#community)

## Development Workflow

### 1. Fork & Clone
```bash
git clone https://github.com/Kevin737866/stellar-liquidity-yield-engine.git
cd stellar-liquidity-yield-engine
```

### 2. Create a Feature Branch
Always branch off `main`:
```bash
git checkout main
git pull origin main
git checkout -b feat/your-feature-name
```

Branch naming conventions:
- `feat/` — new features
- `fix/` — bug fixes
- `docs/` — documentation updates
- `test/` — test additions or fixes
- `chore/` — maintenance tasks

### 3. Prerequisites
- Rust 1.70+ with `wasm32-unknown-unknown` target
- Node.js 18+
- TypeScript 5+
- Soroban CLI

```bash
# Install Rust target
rustup target add wasm32-unknown-unknown

# Install Soroban CLI
cargo install soroban-cli

# Install SDK dependencies
cd sdk && npm install

# Install UI dependencies
cd ui && npm install
```

### 4. Make Your Changes
- Write clean, well-documented code
- Add tests for any new functionality
- Keep commits small and focused

### 5. Build & Test Locally
```bash
# Check Rust contracts compile
cargo check

# Run Rust tests
cargo test

# Format and lint Rust code
cargo fmt
cargo clippy

# Run SDK tests
cd sdk && npm test

# Run UI tests
cd ui && npm test
```

### 6. Commit Your Changes
Use clear, descriptive commit messages following [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add auto-compound threshold configuration
fix: correct impermanent loss calculation for asymmetric pools
docs: update deployment instructions for testnet
test: add governance quorum edge case tests
```

### 7. Push & Open a PR
```bash
git push -u origin feat/your-feature-name
```
Then open a Pull Request against `main` on GitHub.

For SDK releases, follow
[docs/SDK_RELEASE_AND_SEMVER.md](docs/SDK_RELEASE_AND_SEMVER.md). Do not publish
or create a release tag from a feature branch.

## Code Standards

### Rust (Smart Contracts)
- Format with `cargo fmt` before committing
- Pass `cargo clippy` with no warnings
- Document public functions with `///` doc comments
- Follow Soroban contract patterns and naming conventions
- Avoid `unwrap()` in contract code — use proper error handling

### TypeScript (SDK)
- Lint with ESLint: `npm run lint`
- Format with Prettier: `npm run format`
- Use strict TypeScript — no implicit `any`
- Export types alongside implementations

### React (UI)
- Test components with Jest + React Testing Library
- Keep components small and single-purpose
- Use the existing hook patterns (`useYieldVault`, etc.)
- Ensure accessibility (ARIA labels, keyboard nav)

### Documentation
- Update README.md when adding or changing features
- Add JSDoc comments to all exported SDK functions
- Keep code examples in docs accurate and runnable
- When adding or changing wallet provider support, update the "Supported Wallet Providers" table below with each provider's supported operations and required permissions

### Supported Wallet Providers

| Provider | Status | Permissions Required | Notes |
|----------|--------|----------------------|-------|
| Freighter | Supported | Read account address, sign transactions | Primary browser extension wallet |
| Albedo | Supported | Read account address, sign transactions | Web-based signing flow, no extension install |
| xBull | Supported | Read account address, sign transactions | Browser extension wallet |
| Manual secret key (SDK/CLI only) | Supported (non-browser) | Full key access | Never use in browser UIs; intended for scripts and tests |

**Permission boundaries:**
- Read-only operations (balances, vault positions) must not request signing permissions.
- Transaction signing requires explicit user approval through the wallet provider UI.
- Providers that are unreachable or unauthorized should fail with a clear error and must not fall back to a different provider silently.

**Failure behavior:** If a wallet provider is not installed, the UI should prompt installation; if the user rejects a permission request, no transaction is submitted.

## Pull Request Process

1. **Title**: Keep it under 70 characters and use the conventional commit format (e.g. `feat: add governance voting UI`)
2. **Description**: Fill out the PR template — summary of changes, what was tested, any known limitations
3. **Linked Issues**: Reference the issue(s) your PR closes with `Closes #123`
4. **CI Checks**: All CI checks must pass before merge
5. **Review**: At least one approving review is required
6. **Squash & Merge**: PRs are merged using squash commits to keep history clean

### PR Checklist
- [ ] Code follows the project style guidelines
- [ ] `cargo fmt` and `cargo clippy` pass (for Rust changes)
- [ ] ESLint and Prettier pass (for TypeScript/React changes)
- [ ] New and existing tests pass
- [ ] Documentation updated where needed
- [ ] No unrelated files included in the PR

## Issue Reporting

Found a bug or have a feature request? Please [open an issue](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues) and include:

- A clear title and description
- Steps to reproduce (for bugs)
- Expected vs. actual behavior
- Environment details (OS, Rust version, Node version)
- Relevant logs or screenshots

## Security

Do **not** open public issues for security vulnerabilities. Instead, email **support@stellar-yield.com** with details. See the README for our bug bounty program.

## Keeper Signing Key Rotation

Keeper signing keys authorize automated vault operations (harvests, rebalances, auto-compounding). Rotate them on a regular schedule and immediately after any suspected exposure. Follow this procedure to rotate safely.

### 1. Prepare the New Key
- Generate the new keypair on an offline or hardware-backed machine. Never store it in the repository, CI logs, or shared chat.
- Fund the new account with the minimum XLM needed for keeper transaction fees.
- Record the new public key in your operations inventory before proceeding.

### 2. Register the New Key in Parallel
- Add the new public key as an authorized keeper **while the old key remains active**. This avoids a window where no keeper can operate.
- Confirm the new key is listed as authorized on-chain before continuing.

### 3. Switch Keeper Configuration
- Update the keeper secret in your secret manager (e.g. environment variable or vault), not in source files.
- Restart the keeper service and verify it signs a no-op or low-risk operation successfully with the new key.
- Expected result: keeper logs show the new public key as the signer, and no signature-verification errors occur.

### 4. Revoke the Old Key
- Once the new key is confirmed working, remove the old public key from the authorized keeper set.
- Confirm on-chain that the old key can no longer authorize operations.
- Securely destroy any local copies of the old secret and rotate any backups that contained it.

### Boundary and Failure Handling
- **New key not yet authorized**: Do not swap the keeper secret. Keep the old key running and retry registration.
- **New key fails to sign**: Roll back the keeper configuration to the old key, which is still authorized, and investigate. Do not revoke the old key.
- **Old key revocation fails**: Keep both keys in a known state, treat the old key as still active, and escalate before further changes.
- **Suspected compromise**: Skip the parallel window. Revoke the compromised key immediately, pause keeper-dependent operations if needed, and follow the security process below.
- **Partial rotation across multiple keepers**: Track each keeper's status in your inventory and complete the rotation per instance; never revoke a key that another live keeper still uses.

### Operational Checklist
- [ ] New key generated offline and stored in a secret manager
- [ ] New key funded and authorized on-chain
- [ ] Keeper restarted and verified with the new key
- [ ] Old key revoked on-chain and local/backup copies destroyed
- [ ] Rotation date and key identifiers recorded

## Community

- **Issues**: [GitHub Issues](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues)
- **Discord**: [Stellar Yield Community](https://discord.gg/stellar-yield)

---

**Thank you for helping make this project better!**
