# Keeper Recovery After Downtime

## Overview

An off-chain keeper is only useful if it is *continuous*. It polls the RPC,
decides what to do, and acts — and it must not miss on-chain events. A process
restart, a deploy, or an extended network outage breaks that continuity unless
the keeper's position survives the restart. Checkpoint recovery can replay an
event if its handler's external side effect completed but its checkpoint was
not saved, so handlers that cause side effects should be idempotent.

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
| `sdk/src/cursorExpiration.test.ts` | Typed cursor-expiration results and resume behaviour. |
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

`nextLedger` is the *first ledger that has not been processed yet*. Resuming
from it avoids gaps or replay of previously checkpointed ledger ranges, as long
as the RPC still serves the events and the checkpoint save succeeded.

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

A keeper catching up after an outage therefore drains the available backlog
page by page without losing events to page truncation. This does not restore
history pruned by the RPC provider.

## Typed cursor expiration

An RPC node keeps only a bounded window of event history. A paging cursor that
points before that window is rejected, and retrying it will keep failing. That
is a different failure from a network outage, so the listener exposes it as a
typed result:

```ts
const result = await listener.pollWithResult();

switch (result.status) {
  case 'ok':
    console.log(`processed ${result.eventsProcessed} events, next ledger ${result.nextLedger}`);
    break;
  case 'cursor_expired':
    console.warn(
      `cursor ${result.cursor} is ${result.error.reason}; resuming from ledger ${result.resumeFromLedger}`,
    );
    break;
  case 'error':
    console.error(`poll failed at ledger ${result.ledger}:`, result.error.message);
    break;
}
```

- `cursor_expired` carries a `CursorExpiredError` with the rejected `cursor`, a
  `reason` (`expired`, `pruned`, or `invalid`), and the ledger the next poll
  resumes from. The unusable paging token is dropped, so the following poll
  falls back to the ledger position.
- `error` covers every other failure, including network and checkpoint errors.
- `poll()` keeps its original `Promise<void>` contract. Use
  `pollWithResult()` when the caller must distinguish cursor expiration from a
  retryable failure.
- `isCursorExpiredError(error)` and `classifyCursorExpiration(error)` are
  exported for callers that inspect an RPC error directly.

Recovery may replay part of the last ledger, but it never skips an event.
Because the RPC cannot expose a stable machine-readable code for this
condition, detection is message-based and requires both a cursor mention and
an expiration-like word.

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
4. It resumes at the ledger after the last checkpointed position and catches
   up on everything the RPC still serves from that point. A crash between an
   event handler's side effect and checkpoint persistence can cause redelivery;
   applications should make side effects idempotent.
5. The lag monitor restores its marker and reports an accurate lag instead of
   a false critical one.

The successful-persistence test asserts both directions: **no gaps** (every
missed event is handled) and **no duplicates** (no pre-outage event is
re-delivered). A failure-boundary test also demonstrates redelivery when event
handling succeeds but checkpoint persistence fails. The suite covers
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
- **Recovery procedure.** See [INDEXER_CHECKPOINT_RECOVERY.md](./INDEXER_CHECKPOINT_RECOVERY.md)
  for the on-call runbook and failure decision table.


## Durable backoff after consecutive failures

A keeper that keeps failing (for example during an RPC outage) backs off instead of retrying on every tick.

- After `startAfterFailures` consecutive failures (default 2) the keeper waits `baseMs * factor^(failures - startAfterFailures)`, capped at `maxMs` (defaults: 5s base, factor 2, 5 min cap). Jitter only shortens a delay, so `maxMs` is a hard ceiling.
- While waiting, ticks are skipped: no RPC call is made and no extra failure is counted.
- One success resets the counter and the wait.
- The state (`consecutiveFailures`, `nextAttemptAt`) is saved through the keeper's store, so a restart during an outage resumes the remaining wait instead of hammering the RPC again. A wait that is implausibly far in the future (for example after the clock moved backwards) is clamped to `maxMs`.
- If the store cannot be read or written, the keeper keeps running with in-memory backoff.
- # Keeper Recovery After Downtime

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
| `sdk/src/cursorExpiration.test.ts` | Typed cursor-expiration results and resume behaviour. |
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

## Filtering by topic prefix

`ContractEventListener` supports filtering contract events by leading topic
segments via `topicPrefixes`:

```ts
const listener = new ContractEventListener(server, {
  contractAddresses: [VAULT_A],
  topicPrefixes: [['deposit', 'pool_1'], ['harvest']],
  startLedger: 0,
  store: new FileCheckpointStore('./state/keeper.json'),
});
```

- **Matching semantics**: Each entry in `topicPrefixes` is a non-empty array of
  exact, case-sensitive topic segment strings. An event matches when its
  `topic` array starts with **any** configured prefix (OR across prefixes).
  When combined with `contractAddresses`, an event must match both (AND).
- **Backward compatibility**: Omitting `topicPrefixes` or passing `[]` keeps
  pass-all behavior.
- **RPC pushdown + SDK guard**: Unless `rpcFilter.topics` is explicitly set,
  each prefix is sent to Soroban RPC as `[...prefix, '**']`, and re-checked at
  the SDK level before dispatching to `onRaw` or typed handlers. Filtered
  events are logged with `reason: "topic_filtered"` and still allow the ledger
  cursor to advance normally.
- **Validation**: Passing an empty prefix (`[[]]`) or a blank/non-string
  segment throws an `Error` at listener construction time.

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

## Typed cursor expiration

An RPC node keeps only a bounded window of event history. A paging cursor that
points before that window is rejected, and retrying it will keep failing. That
is a different failure from a network outage, so the listener exposes it as a
typed result:

```ts
const result = await listener.pollWithResult();

switch (result.status) {
  case 'ok':
    console.log(`processed ${result.eventsProcessed} events, next ledger ${result.nextLedger}`);
    break;
  case 'cursor_expired':
    console.warn(
      `cursor ${result.cursor} is ${result.error.reason}; resuming from ledger ${result.resumeFromLedger}`,
    );
    break;
  case 'error':
    console.error(`poll failed at ledger ${result.ledger}:`, result.error.message);
    break;
}
```

- `cursor_expired` carries a `CursorExpiredError` with the rejected `cursor`, a
  `reason` (`expired`, `pruned`, or `invalid`), and the ledger the next poll
  resumes from. The unusable paging token is dropped, so the following poll
  falls back to the ledger position.
- `error` covers every other failure, including network and checkpoint errors.
- `poll()` keeps its original `Promise<void>` contract. Use
  `pollWithResult()` when the caller must distinguish cursor expiration from a
  retryable failure.
- `isCursorExpiredError(error)` and `classifyCursorExpiration(error)` are
  exported for callers that inspect an RPC error directly.

Recovery may replay part of the last ledger, but it never skips an event.
Because the RPC cannot expose a stable machine-readable code for this
condition, detection is message-based and requires both a cursor mention and
an expiration-like word.

## Explicit error and recovery state transitions

`ContractEventListener` tracks an explicit operational state machine so
operators, health checks, and alerting hooks can distinguish healthy polling,
active failures, recovery attempts, and intentional shutdown:

- `idle` — constructed and not yet started (manual `poll()` calls may still run).
- `running` — actively polling and healthy.
- `error` — the most recent poll, checkpoint restore, or checkpoint persist failed.
- `recovering` — attempting a subsequent poll after entering `error`.
- `stopped` — explicitly stopped via `stop()`.

Subscribe to transitions with `onStateChange` (and unsubscribe with
`offStateChange`), or inspect `listener.state`, `listener.consecutiveErrors`,
`listener.lastError`, and `listener.lastTransition`:

```ts
listener.onStateChange((transition) => {
  console.log(
    `[listener] ${transition.from} -> ${transition.to} (${transition.reason})` +
      ` at ledger ${transition.ledger} (consecutiveErrors=${transition.consecutiveErrors})`,
  );
});
```

Typical failure and recovery sequence:

1. `idle -> running` (`started`) when `start()` is called.
2. `running -> error` (`poll_error`, `cursor_expired`, `restore_error`, or `persist_error`) on failure.
3. `error -> recovering` (`recovery_attempt`) when the next poll begins.
4. `recovering -> running` (`recovered`) once a poll completes and persists cleanly (resetting `consecutiveErrors` to `0` and `lastError` to `null`), or `recovering -> error` if the recovery attempt also fails.
5. `running | error | recovering -> stopped` (`stopped`) when `stop()` is called; in-flight polls that finish after `stop()` do not overwrite the `stopped` state.

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

## On-chain inventory view for active strategy registrations

The keeper and governance operations surfaces expose a read-only inventory of
active strategy registrations, so operators can see which strategies the
engine is currently allowed to route capital to without scanning raw events.

- **Normal behaviour.** The inventory is built by replaying strategy
  registration and deregistration events in ledger order and keeping only the
  strategies that are still active at the head ledger. Results are returned
  sorted by strategy identifier so repeated reads are stable.
- **Boundary behaviour.** A strategy registered and deregistered within the
  same ledger does not appear. A re-registration after deregistration appears
  once, with the newest registration ledger. An empty registry yields an empty
  inventory rather than an error.
- **Failure behaviour.** If the event history cannot be read, the view reports
  the failure as an error and never returns a partial inventory. A cursor that
  has expired is surfaced through the same typed `cursor_expired` path used by
  the event listener, and the caller is expected to resume the read from the
  reported ledger.
- **Compatibility.** The view is additive; existing listener and rebalancer
  integrations are unchanged.
- **Configuration.** No new configuration is required. Operators can
  checkpoint the inventory cursor with the same `FileCheckpointStore` used by
  the other keeper components, using a dedicated file such as
  `state/inventory.json`.
- **Verification.** Coverage for the normal, boundary, and failure cases lives
  alongside the recovery tests. Run `npm test` to execute the inventory checks
  together with the rest of the SDK suite.
- **Build note.** The duplicate function implementations reported by the
  TypeScript check in `sdk/src/governance.ts` (TS2393 at lines 933 and 962) must
  be resolved by keeping a single declaration of each identifier and deleting
  the duplicate; the file itself should not be rewritten. The unterminated
  comment reported in `sdk/src/types.ts` (TS1010 at line 461) must likewise be
  closed with `*/` before the inventory view is considered compiled.

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


## Durable backoff after consecutive failures

A keeper that keeps failing (for example during an RPC outage) backs off instead of retrying on every tick.

- After `startAfterFailures` consecutive failures (default 2) the keeper waits `baseMs * factor^(failures - startAfterFailures)`, capped at `maxMs` (defaults: 5s base, factor 2, 5 min cap). Jitter only shortens a delay, so `maxMs` is a hard ceiling.
- While waiting, ticks are skipped: no RPC call is made and no extra failure is counted.
- One success resets the counter and the wait.
- The state (`consecutiveFailures`, `nextAttemptAt`) is saved through the keeper's store, so a restart during an outage resumes the remaining wait instead of hammering the RPC again. A wait that is implausibly far in the future (for example after the clock moved backwards) is clamped to `maxMs`.
- If the store cannot be read or written, the keeper keeps running with in-memory backoff.

See `sdk/src/keeperBackoff.ts` (`KeeperBackoff`, `BackoffPolicy`).

See `sdk/src/keeperBackoff.ts` (`KeeperBackoff`, `BackoffPolicy`).
