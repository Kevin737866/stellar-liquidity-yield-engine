# Contributing to Stellar Liquidity and Yield Optimization Engine

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Table of Contents
- [Development Workflow](#development-workflow)
- [Code Standards](#code-standards)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)
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

## Community

- **Issues**: [GitHub Issues](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues)
- **Discord**: [Stellar Yield Community](https://discord.gg/stellar-yield)

---

**Thank you for helping make this project better!**
