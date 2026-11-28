# Runbook: recovery after a failed contract upgrade

Audience: on-call engineers, keepers, and governance signers who operate the
contracts in this repository.

Use this when an upgrade attempt did **not** go as planned: the `upgrade`
transaction failed, the code swapped but the contract misbehaves, or `migrate`
failed after the swap. For the normal upgrade procedure see
[docs/UPGRADING.md](UPGRADING.md); for keeper restarts see
[docs/KEEPER_RECOVERY.md](KEEPER_RECOVERY.md).

The machine-checkable part of step 2 lives in the SDK:
`planUpgradeRecovery()` in `sdk/src/upgradeRecovery.ts`, covered by
`sdk/src/upgradeRecovery.test.ts`.

---

## Ground rules

1. **Establish what is live before doing anything else.** A Soroban upgrade is
   a single host call (`update_current_contract_wasm`): it either swaps the
   code or the whole invocation reverts and nothing changes. "It failed" is not
   enough — you need to know whether the code changed.
2. **Never re-run an upgrade, a migration, or a deploy from memory.** Two
   operators acting on two different guesses is how storage gets written twice.
   One incident commander, one plan, recorded in the incident channel.
3. **Pause first, unpause last.** Pausing blocks user flows while leaving admin
   recovery entrypoints (`unpause`, `upgrade`, `migrate`) available. Unpausing
   is a separate decision taken only after verification.
4. **Do not unpause because the code is "the new one".** New code against an
   old schema, or old code against a newer schema, can both corrupt user state.
5. **Record every transaction hash, wasm hash and version read.** The
   post-mortem, and the next attempt, depend on them.

---

## Step 1 — Freeze and capture

- [ ] Declare the incident and name one commander.
- [ ] Pause the affected contract(s) with a maintenance reason where the
      entrypoint supports one (`pause`, or `emergency_pause` with the
      multisig). Record the transaction hash.
- [ ] Stop keepers, or let their cooldown expire; do not let an automated
      rebalance or harvest land during triage. Keep their checkpoint files
      (`state/keeper.json`, `state/rebalancer.json`) — they are what makes a
      clean resume possible.
- [ ] Capture the current state before any further write:
  - contract ID and network,
  - what `get_storage_version` returns,
  - the wasm hash from the last known-good deploy record,
  - the `upgrade` / `migrate` transaction hashes and their final statuses,
  - the `contract_upgraded` and `contract_migrated` events (or their absence),
  - a snapshot of the stored entries for the structures the change touches.

If `get_storage_version` cannot be read, say so explicitly — that is itself a
finding, not a blank to fill in later.

## Step 2 — Triage

Answer two questions: **which code is live**, and **does the recorded schema
version match what that code expects?**

| Live code | Schema version | Meaning | Plan |
| --- | --- | --- | --- |
| old | unchanged | The attempt did not land | **Retry** (3A) — nothing to roll back |
| unknown | any | Cannot establish state (bad RPC, wrong ID, decode failure) | **Escalate** (3E) |
| new | equal to expected | The swap landed; verification is incomplete | **Finish forward** (3C) |
| new | lower than expected | Code landed, `migrate` did not complete | **Finish forward** (3C), then `migrate` |
| new | higher than expected | Older build is running against newer data | **Roll back** (3B) |
| new | unreadable | Cannot prove the schema the code sees | **Escalate** (3E) |

The same table is encoded in code:

```ts
import { planUpgradeRecovery, formatUpgradeRecoveryPlan } from 'stellar-liquidity-yield-engine-sdk';

const plan = planUpgradeRecovery({
  phase: 'post_upgrade_verification',
  liveCode: 'new',
  expectedStorageVersion: 2,
  storageVersion: 1,
  previousWasmHash: process.env.PREVIOUS_WASM_HASH,
  paused: true,
});

console.log(formatUpgradeRecoveryPlan(plan));
// Upgrade recovery: forward_fix (warning)
// The code swap landed; run `migrate` to adopt the new schema, then verify.
// Safe to retry without review: no
// ...
```

The planner returns `blockers` when the plan cannot safely run — an
unrecorded previous wasm hash, a lost admin signer, an unreadable version — and
`safeToRetry: true` only for the "nothing changed" case.

## Step 3A — Retry (the upgrade did not land)

Use when the old code is live and the failed invocation reverted. A reverted
invocation wrote nothing, so the same call can be repeated once the cause is
fixed.

- [ ] Confirm the failure: transaction status is `FAILED`, and no
      `contract_upgraded` event was emitted for the contract.
- [ ] Confirm the target wasm is installed and its hash matches the reviewed
      build. Re-run the install if the hash is unknown — installing is what
      makes the hash resolvable by the host:

      soroban contract install --wasm "$NEW_WASM" --source deployer --network testnet

- [ ] Confirm the contract ID and network are the intended ones. A typo
      upgrades a different contract and leaves this one untouched.
- [ ] Confirm the old code is healthy (`get_storage_version` plus one read
      entrypoint) before retrying.
- [ ] Fix the cause, re-invoke `upgrade(admin, new_wasm_hash)`, then verify.
- [ ] Re-run the "did it land" checks from step 2 before unpausing.

## Step 3B — Roll back (the code is live but wrong)

Use when new code is live and cannot be trusted with the stored data — most
often because the recorded storage version is newer than the deployed build
expects. Rolling back is an upgrade to the previous wasm hash: the address and
storage stay put.

- [ ] If the previous wasm hash was not recorded, stop. Recover it from deploy
      records or rebuild the exact previous release and install it; only an
      exact artifact reproduces the hash. Without it a rollback cannot be
      targeted.
- [ ] Keep the contract paused through the whole rollback.
- [ ] Install the previous wasm if the host no longer holds it, and confirm the
      hash matches the recorded one.
- [ ] `upgrade(admin, previous_wasm_hash)`.
- [ ] Verify `get_storage_version` and the read entrypoints return values the
      old code understands.
- [ ] Only then unpause.

**Rollback does not undo storage.** If the newer `migrate` already rewrote
entries, the old code may not understand them either. In that case choose a
forward fix or restore from the pre-change snapshot. Do not assume a rollback
is a rewind.

## Step 3C — Finish forward (the code landed)

The swap is done; the remaining work is the migration and the verification.

- [ ] If the stored version is behind, call `migrate(admin)` **once** and record
      the returned previous version and the `contract_migrated` event.
- [ ] Re-running `migrate` is only safe if the build's migration work is
      idempotent. If a previous attempt failed halfway, check the entries it
      touches against the snapshot before retrying.
- [ ] Read `get_storage_version` back and confirm it equals the expected
      version.
- [ ] Run the read-side smoke checks: the entrypoints whose behaviour changed,
      plus one user position/policy/strategy read compared with the snapshot.
- [ ] Confirm exactly one `contract_upgraded` and one `contract_migrated`
      event. Duplicates suggest a retried submission; absence suggests the
      wrong contract ID.
- [ ] Unpause deliberately, then resume keepers from their checkpoints.

## Step 3D — Re-deploy (do not recover in place)

Use when in-place recovery is inappropriate — notably when the admin key is
believed compromised. An in-place upgrade is only as strong as the admin key,
so the next `upgrade` call must come from a new deployment, not from the
suspect address. Follow [docs/UPGRADING.md](UPGRADING.md) Flow B:

- [ ] Freeze the old contract and rotate admin authority.
- [ ] Deploy the reviewed build at a new address.
- [ ] Re-point the engine, vault treasury, distributor oracle and rebalance
      keeper to the new address.
- [ ] Replay user positions, policies and strategies from the old contract.
- [ ] Verify the new address before switching traffic; keep the old contract
      paused and readable for reconciliation.

## Step 3E — Escalate

Keep the contract paused and hand over when:

- the live code or the stored schema version cannot be established,
- the admin signer is unavailable (governance/emergency signers must produce
  the `upgrade` or `migrate` call),
- the previous wasm hash is unknown and the live code is unusable,
- storage may have been partially written and no pre-change snapshot exists.

Write down what is known, what is assumed, and the next check. An unreadable
value is a concrete finding; "probably fine" is not.

## Step 4 — Verification checklist (before unpausing)

- [ ] `get_storage_version` returns the version the live build expects.
- [ ] Admin and configuration reads (`get_admin`, treasury, registry, oracle)
      return the intended addresses.
- [ ] The read entrypoints touched by the change return plausible values.
- [ ] A known user position/policy/strategy matches the pre-change snapshot.
- [ ] `contract_upgraded` / `contract_migrated` events are present, correct and
      not duplicated.
- [ ] The paused flag is understood: what is paused, why, and what will unpause
      it.

## Step 5 — Resume keepers deliberately

- [ ] Restore each keeper from its checkpoint (`docs/KEEPER_RECOVERY.md`).
      Resuming from a stale cursor replays events; starting fresh can
      double-execute a rebalance.
- [ ] Watch the first ticks: no duplicate harvest/rebalance, lag monitor not
      reporting a false critical lag.
- [ ] If the RPC pruned the outage window, reconcile from an archive or
      snapshot instead of forcing a cursor.

## Step 6 — Close out

- [ ] Record the final state: live wasm hash, storage version, contract ID,
      pause/unpause transactions.
- [ ] Record the timeline: when the upgrade started, what failed, what was
      observed, what was retried, what changed.
- [ ] Note whether the failed attempt wrote anything, and whether the rollback
      or migration was reversible.
- [ ] File follow-ups: add the missing guard (recorded previous hash, dry-run
      check, migration test) to the pre-upgrade checklist.

---

## Boundary and failure cases

| Case | Expected behaviour | Why |
| --- | --- | --- |
| `upgrade` with an uninstalled hash | Transaction fails; old code, address and storage untouched | The host rejects the unknown hash; covered by `tests/upgrade_tests.rs` |
| Non-admin calls `upgrade` / `migrate` | Rejected; nothing changes | Stored-admin check; covered by `tests/upgrade_tests.rs` |
| Two operators retry at once | One lands, one fails; verify the event count | The swap is only visible on the next invocation |
| Upgrade "succeeds" but old entrypoints answer | Wrong contract ID or network; the intended contract was never touched | Addresses, not names, are upgraded |
| Schema version ahead of the build | Roll back or forward-fix; never leave it serving | The older build can misdecode newly written shapes |
| Schema version `0` | Treat as "never recorded" (pre-version contracts) | `initialize` records the version; older contracts read `0` |
| `migrate` retried after a timeout | Safe only if the migration is idempotent; the second call reports the current version | The recorded version is written before the event |
| Migration failed halfway | Re-run idempotent migration or restore the snapshot; a code rollback does not undo writes | Storage is not transactional with the code swap |
| Storage version unreadable | Keep paused; retry the read on another RPC before concluding the contract is broken | A failed read is not a failed contract |
| Admin key lost or compromised | Re-deploy; in-place recovery is not authorized or not trustworthy | `upgrade` is only as strong as the admin key |
| RPC pruned the incident window | Reconcile from an archive/snapshot; do not force an expired cursor | Event retention is bounded |
| Unpause before verification | Do not; a healthy code swap can still serve a bad configuration | Pause is the only guard during triage |

## What "recovered" means

The contract is recovered when all of the following hold, and not before:

1. The live wasm hash is the intended one (the new build, or the previous one
   if you rolled back) and it is recorded.
2. `get_storage_version` matches that build's expectation.
3. Read-side smoke checks and a known stored entry agree with the snapshot.
4. One upgrade event and, if applicable, one migration event are present and
   correct.
5. The paused state is intentional, and keepers have resumed without
   duplicating work.

Only then is the incident closed and the next upgrade allowed to start.
