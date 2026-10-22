# Keeper Recovery After Downtime

## Overview

An off-chain keeper is only useful if it is *continuous*. It polls the RPC,
decides what to do, and acts — and it must do so exactly once per on-chain
event. A process restart, a deploy, or an extended network outage breaks that
continuity unless the keeper's position survives the restart.

This document describes the durable-state support added to the SDK: how a
keeper checkpoints its position, how it restores it on start-up, and how the
restart-during-outage scenario is demonstrated.

The implementation lives in:

| File | Responsibility |
| --- | --- |
| `sdk/src/persistence.ts` | Checkpoint shape, validation, and `FileCheckpointStore` / `MemoryCheckpointStore`. |
| `sdk/src/eventListener.ts` | Restores and persists the event-listener cursor; gap-free pagination. |
| `sdk/src/rpcSync.ts` | Restores and persists the RPC lag monitor's processed-ledger marker. |
| `sdk/src/bots/autoRebalancer.ts` | Persists the keeper's cooldown so a restart cannot repeat a rebalance. |
| `sdk/src/recovery.test.ts` | Restart-during-outage scenarios. |
| `examples/restart-during-outage.ts` | Runnable end-to-end demonstration. |

## The checkpoint

A `KeeperCheckpoint` is the smallest amount of state a keeper needs to resume
exactly where it stopped:

```ts
interface KeeperCheckpoint {
  version: number;               // format version
  nextLedger: number;            // resume point (exclusive lower bound)
  lastProcessedLedger: number;   // nextLedger - 1
  updatedAt: number;             // wall-clock ms since the epoch
  metadata?: Record<string, string | number | boolean>;
}
```

`nextLedger` is the *first ledger that has not been processed yet*. Resuming is
therefore one rule — start at `nextLedger` — and it can neither skip an event
nor replay one.

Checkpoints are written by `FileCheckpointStore` with a **write-then-rename**:
the payload goes to `keeper.json.tmp` and is then renamed over `keeper.json`.
The rename is atomic on POSIX filesystems, so a crash in the middle of a write
leaves the previous checkpoint intact rather than a half-written file.

## Making a keeper durable

```ts
import { ContractEventListener } from 'stellar-liquidity-yield-engine-sdk';
import { FileCheckpointStore } from 'stellar-liquidity-yield-engine-sdk';

const listener = new ContractEventListener(server, {
  startLedger: 0, // fallback only — the checkpoint wins
  store: new FileCheckpointStore('./state/keeper.json'),
});

listener.on('deposit', handleDeposit);
listener.start(5_000);
```

With a `store` configured:

1. The **first poll** loads the checkpoint and moves the cursor to
   `max(startLedger, checkpoint.nextLedger)`.
2. After **every successful poll** the listener writes a fresh checkpoint.
3. A failed poll writes nothing, so the position never advances past work that
   did not actually happen.
4. If the checkpoint cannot be read, the listener reports the error through
   the `error` handler and continues from the configured `startLedger` — it
   comes back up and says so rather than silently replaying history.

The restore happens on the first poll no matter how the listener is driven
(`start()`, a manual `poll()`, or a script), so there is no entry point that
can poll from the wrong position after a restart. Set
`autoRestore: false` to opt out.

### Restoring explicitly

```ts
await listener.restore();

console.log(listener.currentLedger);   // first ledger to fetch
console.log(listener.lastProcessedLedger);
console.log(listener.resumeLedger);    // ledger the checkpoint resumed from
```

### Persisting explicitly

```ts
const checkpoint = await listener.persist();
// -> { version: 1, nextLedger: ..., lastProcessedLedger: ..., updatedAt: ... }
```

`persistOnPoll: false` disables the automatic write when the caller manages
persistence itself.

## No gaps while catching up

After a long outage the RPC can have far more events than one page
(`pageSize`, default 200) can hold. The old cursor logic jumped straight to
the node's head after every poll, which would silently skip every event that
did not fit on the page. The listener now distinguishes:

- **Page not full** (`events.length < pageSize`): the backlog is drained, so
  the cursor jumps to `latestLedger + 1`.
- **Page full** (`events.length === pageSize`): more events may remain, so the
  cursor only advances to the ledger after the highest event actually
  consumed.

A keeper catching up after an outage therefore drains the backlog page by page
without losing anything.

## The RPC lag monitor

A restarted `RpcLagMonitor` used to start its `processedLedger` marker at zero,
which makes any live network look "critically behind" — a false alarm on every
restart. Pass a store to keep the marker durable:

```ts
const monitor = new RpcLagMonitor(
  server,
  { store: new FileCheckpointStore('./state/lag.json') },
);

await monitor.restore();   // seeds processedLedger from the checkpoint
// ... after processing:
monitor.recordProcessedLedger(listener.lastProcessedLedger);
await monitor.persist();
```

The marker never moves backwards, so a checkpoint that is behind the in-memory
value is ignored.

## The auto-rebalancer

The auto-rebalancer is driven by wall-clock time, not by a ledger position. Its
restart-critical state is *when it last executed*. Without persistence a
restart forgets that a rebalance just happened and can execute a second one
immediately.

Pass a `stateStore` to keep it:

```ts
const keeper = new AutoRebalancer({
  /* ... */
  stateStore: new FileCheckpointStore('./state/rebalancer.json'),
});

await keeper.run(); // restores state on the first run, persists on execution
```

The keeper fails **closed**: if the stored state cannot be read, the run ends
with an error instead of executing a possibly-duplicate rebalance.

## Restart-during-outage scenario

The scenario is covered end-to-end in `sdk/src/recovery.test.ts`:

1. A keeper follows the chain and checkpoints its position.
2. The process dies; the chain advances by dozens of ledgers.
3. A **new** listener instance with a **new** store instance reads the same
   checkpoint file.
4. It resumes at exactly the ledger after the last consumed one, catches up on
   everything that happened during the outage, and delivers every event
   exactly once.
5. The lag monitor restores its marker and reports an accurate lag instead of
   a false critical one.

The test asserts both directions: **no gaps** (every missed event is handled)
and **no duplicates** (no pre-outage event is re-delivered). It also covers
multi-page catch-up, an unreadable checkpoint, and a `startLedger` that is
ahead of the checkpoint.

Run it with:

```bash
npm test -- sdk/src/recovery.test.ts
```

A runnable, network-free demonstration is available as an example:

```bash
npx ts-node examples/restart-during-outage.ts
```

Expected output ends with:

```
Duplicates re-delivered      : 0
Full backlog drained         : true

✅ Recovery succeeded — the keeper resumed exactly where it left off.
```

## Operational notes

- **Checkpoint retention.** Stellar RPC nodes prune historical events. An
  outage longer than the node's event retention window cannot be replayed from
  the chain; restore the cursor and reconcile from an archive or a snapshot.
- **One writer per file.** Give each keeper component its own checkpoint file
  (e.g. `keeper.json`, `lag.json`, `rebalancer.json`), or have a single owner
  persist on behalf of the others.
- **Inspectable state.** Checkpoints are plain JSON, so operators can inspect
  the last position with `cat state/keeper.json`.
- **Ephemeral deployments.** Use `MemoryCheckpointStore` in tests and anywhere
  a restart is expected to start from scratch.
