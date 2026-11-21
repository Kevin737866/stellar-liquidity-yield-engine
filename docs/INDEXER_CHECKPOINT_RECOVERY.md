# Indexer Checkpoint Recovery Runbook

This runbook covers operational recovery of a `ContractEventListener` that
stores its position with `FileCheckpointStore`. It applies to the indexer/event
listener position, not to the separate RPC lag-monitor or auto-rebalancer
checkpoints.

## What the checkpoint means

The JSON checkpoint's `nextLedger` is the first ledger the listener has not
consumed. `lastProcessedLedger` is derived as `nextLedger - 1`; do not edit the
two values independently. If a page ends partway through a ledger, the
checkpoint can also contain `metadata.eventCursor`, the Soroban RPC paging
token needed to continue within that ledger.

For a valid checkpoint, startup resumes at
`max(configured startLedger, checkpoint.nextLedger)`. Thus, raising
`startLedger` can intentionally skip events, while lowering it does not rewind
a valid checkpoint. To rewind, stop the writer and move the checkpoint out of
the way before starting from a verified earlier ledger.

Checkpointing prevents gaps while replaying events available from the RPC,
but does **not** make external handler effects exactly-once. If a handler
completes an external action and the process dies before the corresponding
checkpoint is saved, that event can be delivered again. Make handlers
idempotent or deduplicate by a stable event identifier (for example the RPC
event ID) in the same durable system as the side effect.

## Normal startup and health checks

1. Configure a stable checkpoint path on persistent storage, for example
   `./state/indexer.json`. The directory is created on save. Do not use
   `MemoryCheckpointStore` when position must survive a restart.
2. Keep `autoRestore` and `persistOnPoll` enabled (their defaults when a store
   is configured). Use one writer per checkpoint file and register an `error`
   handler that alerts on both restore and persistence failures.
3. On startup, confirm that the restore did not report an error. When
   instrumenting the listener, `resumeLedger` reports the restored position
   and `currentLedger` reports the next ledger it will request.
4. Confirm the checkpoint advances after successful polls. A full event page
   can require multiple polls to catch up; a saved `metadata.eventCursor`
   means the listener is still paging within a ledger.
5. During catch-up, compare the listener position with the RPC head and check
   for an increasing backlog or repeated persistence/RPC errors. Do not
   interpret a healthy RPC lag report as proof that all event history was
   available.

The focused recovery and persistence regression tests can be run from the
repository root:

```bash
npm test -- --runInBand sdk/src/recovery.test.ts sdk/src/persistence.test.ts
```

## Recovery procedure

1. **Stop the indexer** and disable automatic restarts while investigating.
   Ensure no other process is writing the same checkpoint.
2. **Preserve evidence before changing anything.** Copy the checkpoint, any
   sibling `.tmp` file, the relevant service logs, and the effective
   `startLedger`, filters, and checkpoint path. For example:

   ```bash
   cp -a state/indexer.json "state/indexer.json.$(date -u +%Y%m%dT%H%M%SZ).bak"
   ```

   If the checkpoint is missing, do not create an empty file as a recovery
   action; a missing or empty file is treated as no saved position.
3. **Inspect the checkpoint read-only.**

   ```bash
   cat state/indexer.json
   ```

   Check that `version` is supported, `nextLedger` is a non-negative integer,
   and `updatedAt` is a finite timestamp. Treat `lastProcessedLedger` as
   `nextLedger - 1`, regardless of what the stored field says. Preserve
   `metadata.eventCursor` unless performing a deliberate rewind.
4. **Choose the recovery point deliberately.**
   - If the JSON is valid and events remain available from the stored position,
     keep the checkpoint and restart with the same or a lower `startLedger`.
   - To intentionally skip forward, set `startLedger` to a verified ledger
     after review. The higher configured value wins on restore.
   - To intentionally replay from an earlier ledger, first stop the writer and
     move the checkpoint to a backup name on the same persistent volume. Set
     `startLedger` to the verified replay ledger, then restart. Expect
     previously handled events to be delivered again and make handlers
     idempotent.
   - If the checkpoint is corrupt, structurally invalid, or from a newer
     unsupported format, do not delete it or guess a resume point. Restore a
     known-good backup or select a `startLedger` from trusted operational
     records. The listener reports a restore error and falls back to
     `startLedger`; once a poll succeeds it may replace the bad checkpoint.
     Therefore, preserve the original before allowing the fallback to run.
5. **Restart and observe.** Watch the listener's error handler/logs, verify
   that `currentLedger` matches the chosen resume point, and confirm the new
   checkpoint is valid and advances as polling succeeds. A missing checkpoint
   or empty file returns `null` without a restore error and starts from
   `startLedger`.
6. **Verify catch-up before closing the incident.** Confirm the RPC has the
   required event range, the paging cursor is eventually cleared, the
   listener reaches the expected head, and downstream records/actions have
   been reconciled. Keep the backup until application-level reconciliation is
   complete.

## Failure and boundary cases

| Symptom | Meaning and response |
| --- | --- |
| Missing or zero-byte checkpoint | Treated as no checkpoint. Starts from configured `startLedger`; confirm that this is a safe position before restarting. |
| Invalid JSON, malformed payload, unsupported future version, or file access error | Restore reports an error. Automatic listener startup falls back to configured `startLedger`; preserve the file and choose a trusted recovery point before allowing a poll to overwrite it. |
| Checkpoint save error | The in-memory listener may have advanced, but disk may still contain the prior checkpoint. Alert and investigate storage permissions/availability. A process restart can replay events since that older checkpoint. |
| Full page / saved `eventCursor` | More events may remain, including in the same ledger. Let polling continue; do not remove the cursor to force progress. |
| RPC cursor rejected or required ledger range unavailable | Verify the RPC provider, retention/archive availability, and checkpoint age. Do not silently jump to the current head; use an archive or reconcile missing events before advancing. |
| Checkpoint behind configured `startLedger` | The higher configured value wins and may skip events. Lowering `startLedger` alone does not rewind; preserve and move the checkpoint only for an intentional, reviewed replay. |

Soroban RPC providers may prune historical events. If the checkpoint is older
than the provider's retained event range, restarting from it cannot recover
events the provider no longer serves. Use an archive or a trusted application
snapshot, reconcile the missing range, and only then advance the indexer.

## Related documentation

- [Keeper recovery model](./KEEPER_RECOVERY.md)
- [Restart-during-outage example](../examples/restart-during-outage.ts)
- [Checkpoint implementation](../sdk/src/persistence.ts)
- [Event listener implementation](../sdk/src/eventListener.ts)
