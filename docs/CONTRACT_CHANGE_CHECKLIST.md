# Contract Change Checklist

Use this checklist for changes to Soroban contracts in `src/`, contract-facing
SDK code, WASM build configuration, or deployed contract operations. It
complements the project-wide
[security checklist](SECURITY_CHECKLIST.md).

## Before implementation

- [ ] Identify every contract feature or WASM artifact affected.
- [ ] Document the intended success behavior, rejected inputs, unauthorized
      callers, paused-state behavior, and upgrade/migration behavior.
- [ ] **Storage compatibility:** check whether existing storage keys or
      serialized values are compatible. Add a versioned migration and document
      a rollback or recovery plan when they are not.
- [ ] Review public entrypoint signatures and SDK bindings for backward
      compatibility.

## Implementation

- [ ] Preserve the existing contract address and storage unless the change
      intentionally replaces or migrates the contract.
- [ ] Keep privileged entrypoints admin-authorized and `require_auth`/admin checks
      consistent with existing patterns.
- [ ] Keep state-mutating entrypoints unavailable while paused unless they are
      explicitly recovery-only (`unpause`, `upgrade`, or `migrate`).
- [ ] Recheck arithmetic overflow, zero values, maximum values, limits, cooldowns,
      fee bounds, and balance conservation in the host and contract code.
- [ ] Use checks-effects-interactions: update contract state before external token
      calls and avoid callback or reentrancy assumptions.
- [ ] Emit or update events for state changes consumed by off-chain services.

## Tests

Add focused tests for all applicable cases:

- [ ] **Normal:** the documented success path and resulting storage/events.
- [ ] **Boundary:** zero, minimum, maximum, exact limit, cooldown, and arithmetic
      edge values.
- [ ] **Failure:** invalid inputs, insufficient balances, unauthorized callers,
      paused state, repeated operations, and unknown WASM hashes or migration
      versions.
- [ ] Tests assert storage and balance changes, not only that an invocation did
      not panic.
- [ ] Upgrade and migration tests cover the affected storage version and confirm
      existing data is retained or migrated.

Run the smallest relevant tests while iterating, then the project checks:

```bash
cargo fmt --all -- --check
cargo clippy --lib --test upgrade_tests --test swap_router_fuzz --all-features -- -D warnings
cargo test --all-features --lib --test upgrade_tests --test swap_router_fuzz
```

For every deployable contract changed or whose ABI/build could be affected,
build its WASM separately:

```bash
cargo build --target wasm32-unknown-unknown --release \
  --no-default-features --features <contract>
```

Contract feature names are listed in `Cargo.toml`: `engine`, `yield-vault`,
`rebalance-engine`, `reward-distributor`, `strategy-registry`, `il-insurance`,
`actuary`, `oracle-registry`, and `risk-engine`.

## Documentation and operations

- [ ] Update directly affected README sections, SDK types/docs, or contract
      deployment and upgrade documentation.
- [ ] Update `docs/SECURITY_CHECKLIST.md` for authorization, pause, fee, event,
      storage, or upgrade assumptions.
- [ ] Document testnet validation, required admin actions, rollout order,
      migration state, and rollback/recovery actions.
- [ ] Confirm no private keys, network credentials, or secrets are added to code
      or CI configuration.
- [ ] In the PR, explain any boundary or failure item that is not applicable.
