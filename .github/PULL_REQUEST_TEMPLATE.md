## Summary

<!-- Describe the behavior changed and why. -->

## Contract Change

- [ ] This PR does not change contracts or contract-facing build/deployment code.
- [ ] This PR changes one or more contracts or contract-facing build/deployment
      surfaces.

If this is a contract change, complete the
[contract change checklist](docs/CONTRACT_CHANGE_CHECKLIST.md).

### Contract checks

- [ ] Normal behavior and success paths are covered by tests.
- [ ] Boundary values and exact limits are covered explicitly.
- [ ] Invalid input, unauthorized caller, pause, and migration/upgrade failures
      are covered explicitly.
- [ ] Storage compatibility or migration behavior is documented and tested.
- [ ] Authorization, pause, fee, event, and upgrade assumptions are reflected in
      `docs/SECURITY_CHECKLIST.md`.
- [ ] Affected contracts build successfully as individual WASM artifacts.
- [ ] Deployment, upgrade, rollback, or SDK documentation is updated as needed.

## Validation

- [ ] `cargo fmt --all -- --check`
- [ ] Relevant Rust tests
- [ ] Relevant clippy/build checks
- [ ] SDK/UI checks, if affected

## Risk and operations

<!-- Note migration steps, testnet validation, admin actions, and rollback/recovery. -->

## Linked issues

Closes #
