# Migration checklist: protocol configuration changes

Audience: governance signers, keepers, and on-call engineers who change
protocol configuration (fees, rebalance threshold, insurance reserve target, or
anything stored alongside them).

Use this before executing a configuration change on a live deployment. For
stored-layout changes it is the companion to
[docs/UPGRADING.md](UPGRADING.md); for a failed upgrade, see
[docs/RUNBOOK_FAILED_UPGRADE.md](RUNBOOK_FAILED_UPGRADE.md).

The machine-checkable part lives in the SDK: `buildConfigMigrationChecklist()`
in `sdk/src/configMigration.ts`, covered by
`sdk/src/configMigration.test.ts`.

---

## 1. Classify the change

Choosing too narrow a scope is the most common way a configuration migration
goes wrong. Pick the widest scope that applies.

| Scope | What changes | Needs a schema bump + `migrate` | Needs a keeper restart |
| --- | --- | --- | --- |
| `parameter_only` | A governable value only (`performanceFee`, `withdrawalFee`, `rebalanceThreshold`, `insuranceReserveTarget`) | No | No |
| `storage_layout` | Stored shapes, encodings, or the meaning of stored fields | **Yes** — bump `STORAGE_VERSION` in `src/upgrade.rs` and extend that contract's `migrate` | Usually |
| `derived_state` | Off-chain state computed from config: keeper schedules, cooldowns, caches | No | **Yes** |

A parameter change that also alters a stored shape is a `storage_layout`
change, not a `parameter_only` one. When in doubt, classify up.

## 2. Bounds (inclusive)

Basis points, mirroring the constants in `src/governance.rs` and
`PROTOCOL_CONFIG_BOUNDS` in the SDK. A value exactly on a limit is valid; one
basis point outside is rejected on-chain and the stored value is left
unchanged.

| Parameter | Min | Max | Meaning |
| --- | --- | --- | --- |
| `performanceFee` | 500 | 1500 | 5% – 15% |
| `withdrawalFee` | 10 | 100 | 0.1% – 1% |
| `rebalanceThreshold` | 100 | 500 | 1% – 5% |
| `insuranceReserveTarget` | 10000 | 20000 | 100% – 200% |

Values are integers: a fractional basis point cannot be encoded and must be
rounded deliberately before it is proposed, not silently by the tooling.

> **Deployment status.** The parameter setters belong to the governor contract
> in `src/governance.rs`, which is still design scaffolding — see
> [GOVERNANCE_STATUS.md](../GOVERNANCE_STATUS.md). Apply the governance steps
> below only on a deployment where that contract is live; the off-chain and
> stored-layout parts of this checklist apply regardless.

## 3. Pre-flight checklist

- [ ] The change has an issue/decision link and a named owner.
- [ ] Scope classified (section 1), and the widest applicable scope is chosen.
- [ ] Every target value is an integer inside its inclusive bound.
- [ ] The current value was read from the network, not from a config file.
- [ ] A pre-change snapshot exists: current getters **and** the stored entries
      the change affects (user positions, policies, strategies, streams).
- [ ] A written rollback plan exists: the exact values to re-apply, or the
      snapshot to restore.
- [ ] For `storage_layout`: `STORAGE_VERSION` is bumped in the same change, the
      contract's `migrate` handles the new shape, and the migration is
      idempotent.
- [ ] For `derived_state`: keepers that cache the derived value are named, and
      their restart (from checkpoints) is scheduled.
- [ ] The change went through propose → timelock → execute. Parameter setters
      are not called directly by an admin key.

Run the same checks from the SDK before proposing:

```ts
import { buildConfigMigrationChecklist } from 'stellar-liquidity-yield-engine-sdk';

const checklist = buildConfigMigrationChecklist({
  current: { performanceFee: 1000, withdrawalFee: 10, rebalanceThreshold: 200, insuranceReserveTarget: 15000 },
  next: { performanceFee: 1200 },
  scope: 'parameter_only',
  governanceApproved: true,
  snapshotTaken: true,
  rollbackPlan: 'Re-apply performanceFee=1000 through the same governance flow.',
});

checklist.ready;     // false while anything is missing
checklist.blockers;  // why it cannot run yet
checklist.steps;     // ordered operator steps
```

`ready` is false for a missing approval, snapshot or rollback plan, for an
out-of-range or fractional value, for an unknown field, and — on
`storage_layout` — for a missing or non-forward schema version and a migration
that is not safe to re-run. An empty change is reported as `noop` and never
executed.

## 4. Execution checklist

- [ ] Propose the change through governance and let the timelock elapse; record
      the proposal ID and timelock expiry.
- [ ] Execute the change; record the transaction hash and ledger.
- [ ] For `storage_layout`, install the wasm, `upgrade(admin, new_wasm_hash)`,
      then `migrate(admin)`. Record the version `migrate` reports and re-read
      `get_storage_version`.
- [ ] Read every changed parameter back from the network.
- [ ] Compare one known user position/policy/strategy with the snapshot.
- [ ] For `derived_state`, restart keepers from their checkpoints and watch the
      first ticks for duplicated or skipped work
      ([docs/KEEPER_RECOVERY.md](KEEPER_RECOVERY.md)).
- [ ] Watch governance/fee events for the expected effect (the fee actually
      being charged, the threshold actually moving).

## 5. Boundary and failure cases

| Case | Expected behaviour | What to do |
| --- | --- | --- |
| Value exactly at min or max | Accepted | None — record it, the next change moves back inside |
| Value one basis point outside | Rejected; stored value unchanged | Fix the value; do not "round" it silently |
| Fractional/non-integer value | Rejected (cannot be encoded as `u32` bps) | Decide the rounded value explicitly and re-propose |
| Unknown field in the change set | Not applied by the checklist; rejected as a blocker | Remove it or extend the bounds table deliberately |
| No values actually change | `noop`; no migration run | Close the request; a no-op transaction only burns fees |
| Several parameters in one proposal | Allowed, but flagged | Verify each value against the snapshot individually |
| Governance not approved | Blocked | Complete propose → timelock → execute |
| Snapshot missing | Blocked | Capture it before executing; there is no on-chain undo |
| Rollback plan missing | Blocked | Write the exact values to re-apply / snapshot to restore |
| Stored-layout change without a version bump | Blocked | Bump `STORAGE_VERSION` and add the migration work |
| `migrate` fails midway | Registered version may lag the writes | Re-run the idempotent migration, or restore the snapshot |
| Keeper not restarted after a derived-state change | Keeper acts on stale values (e.g. skips a rebalance) | Restart from checkpoint; see docs/KEEPER_RECOVERY.md |
| Parameter setter called during a paused contract | Still applied — pause blocks user flows, not governance | Expect it; unpause only after section 6 passes |

## 6. Verification checklist (before close-out)

- [ ] Every changed parameter reads back as intended.
- [ ] One known stored entry matches the snapshot (or the migrated shape, for a
      `storage_layout` change).
- [ ] `get_storage_version` equals the shipping build's expectation.
- [ ] `contract_upgraded` / `contract_migrated` events are present once, if the
      change shipped code.
- [ ] Keepers resumed from checkpoints without duplicated work.
- [ ] The rollback plan is still valid and is filed with the change record.

## 7. Change record

File this with the issue that requested the change:

| Field | Value |
| --- | --- |
| Scope | `parameter_only` / `storage_layout` / `derived_state` |
| Fields and values | e.g. `performanceFee 1000 → 1200` |
| Proposal / timelock | proposal ID, expiry |
| Execution | transaction hash, ledger |
| Schema versions | before → after (storage-layout changes only) |
| Snapshot location | where the pre-change state was captured |
| Rollback plan | values to re-apply, or snapshot to restore |
| Verification | getter reads, keeper ticks, events observed |
| Approver | governance signer / incident commander |

## 8. What "done" means

The change is complete when every verification item passes, the change record
is filed, and the rollback plan is either still valid or deliberately retired.
A configuration change is not done when the transaction succeeded — it is done
when the network, the stored data and the keepers all agree on the new value.
