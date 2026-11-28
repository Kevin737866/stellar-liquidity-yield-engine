# Staged contract upgrade validation

Issue: [#501](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/501).

The upgrade entrypoints described in `docs/UPGRADING.md` are a single host call,
but replacing the code behind a live contract should not be a single decision.
`sdk/src/stagedUpgrade.ts` turns the operator procedure into seven gates and
answers, from the evidence collected so far: **which stage can run next, and
what still stops promotion?**

The planner signs nothing and calls no RPC. It validates evidence an operator or
CI job gathered — hashes, versions, approvals, staging results — so a gate
cannot be satisfied by reordering the steps.

## The stages

| # | Stage | Needs admin | Exit criteria |
| --- | --- | --- | --- |
| 1 | `preflight` | no | Wasm hash is 64 hex characters, previous hash differs and is recorded, admin key available, versions forward-only, snapshot taken, rollback plan written, migration declared idempotent |
| 2 | `install` | yes | `contract install` succeeded; recorded hash matches the reviewed build |
| 3 | `simulate` | yes | `simulateTransaction` for `upgrade(admin, new_wasm_hash)` succeeded |
| 4 | `staging` | yes | A **separate** contract address holding a copy of live storage was upgraded, migrated, and passed the read/write smoke checks |
| 5 | `promote` | yes | Approvals collected (2 for production, 1 otherwise by default) and every earlier stage complete |
| 6 | `verify` | no | Live contract reports the target `get_storage_version()` and answers its entrypoints; `migrate` completed when the change needs one |
| 7 | `closeout` | no | Keepers restarted from their checkpoints and watched for duplicated or skipped work |

Each stage is reported as `complete`, `ready` (run this now), `pending`
(prerequisites missing), `blocked` (unsafe as supplied) or `skipped`
(`staging` on a non-production contract).

## Usage

```ts
import { assertStagedUpgradeReady, formatStagedUpgradePlan, planStagedUpgrade } from '../sdk/src';

const plan = planStagedUpgrade({
  contractId: YIELD_ENGINE_CONTRACT_ID,
  production: true,
  wasmHash: NEW_WASM_HASH,
  previousWasmHash: LIVE_WASM_HASH,
  adminKeyAvailable: true,
  wasmInstalled: true,
  simulationPassed: true,
  liveStorageVersion: 1,
  targetStorageVersion: 2,
  migrationRequired: true,
  migrationIdempotent: true,
  stagingContractId: STAGING_CONTRACT_ID,
  stagingVerified: true,
  smokeChecksPassed: true,
  snapshotTaken: true,
  rollbackPlan: 'Install LIVE_WASM_HASH and upgrade back to it; restore the snapshot if migrate ran.',
  approvals: 2,
});

plan.canPromote;   // true
plan.nextStage;    // 'promote'
console.log(formatStagedUpgradePlan(plan));
```

`assertStagedUpgradeReady(evidence)` throws `StagedUpgradeValidationError` when
`canPromote` is false, with the blockers in the message — suitable as the last
step of a release job. The evidence is meant to be assembled by the job from
what it actually ran (CLI output, `get_storage_version`, approval records), not
filled in by hand.

## Normal, boundary and failure behaviour

**Normal.** With every gate satisfied, `preflight` through `staging` are
`complete`, `promote` is `ready` and `nextStage` is `promote`. After promotion
the plan moves to `verify`, then `closeout`, and ends with `nextStage: null`.

**Boundary.**

- A code-only change (`targetStorageVersion === liveStorageVersion` without a
  migration) passes with a warning: no `migrate` call is needed.
- Exactly the required number of approvals passes; one short blocks `promote`.
- Hashes are compared case-insensitively and must be 32 bytes of hex.
- A non-production contract may skip `staging` and needs a single approval; its
  missing previous hash is a warning (rollback target), not a blocker.
- `requiredApprovals: 0` is rejected as a misconfiguration — a gate nobody has
  to clear is not a gate.
- Approvals more than required are fine; they are reported, not capped.

**Failure.** Each of these blocks the plan and names the stage:

| Condition | Stage | Why it stops |
| --- | --- | --- |
| Missing or malformed wasm hash | `preflight` | Nothing to install; a truncated hash fails at submission |
| Previous hash equals the target | `preflight` | No new code to promote; rollback would be a no-op |
| Target schema older than live | `preflight` | Migrations are forward-only; restore the snapshot instead |
| Migration required but version unchanged | `preflight` | `migrate` would be a no-op and hides a stale `STORAGE_VERSION` |
| Migration not declared idempotent | `preflight` | A retried `migrate` would apply work twice |
| No snapshot or rollback plan | `preflight` | No way to restore or undo |
| Admin key unavailable | `preflight` | `install`/`upgrade`/`migrate` reject non-admins |
| Staging id equals the production id | `staging` | Staging on the live contract is the promotion |
| Production without verified staging or smoke checks | `staging` → `promote` | The wasm is unproven against real storage |
| Promotion recorded before its prerequisites | `promote` | Evidence contradicts itself; treat as an incident and verify the live contract |
| Code live but schema not migrated | `verify` | Keep user flows frozen until `migrate` lands |
| Keepers resumed before verification | warning | They can read a half-migrated contract; re-check their first ticks |

## Wiring it into a release

1. Collect evidence in the job that runs the steps, then write it as JSON.
2. Run `planStagedUpgrade` and print `formatStagedUpgradePlan(plan)` in the job
   log, so the gate decision is auditable next to the transaction hash.
3. Call `assertStagedUpgradeReady` immediately before submitting the promotion
   transaction, and require `plan.nextStage === 'promote'`.
4. After promotion, rebuild the plan with `promoted` and the post-upgrade reads;
   the job should not go green until `nextStage` is `null`.

The staged plan validates *evidence*, not the migration code itself. For a
stored-layout change, also run the migration against a captured storage fixture
before the `install` stage: staging proves the wasm behaves on a copy of the
data, but it does not prove the migration can read entries written by the
*previous* build.

A plan is a snapshot of the evidence at one moment. Re-run it after every new
observation rather than editing statuses; a plan that says `canPromote: true`
was built from evidence, not from a flag someone flipped.
