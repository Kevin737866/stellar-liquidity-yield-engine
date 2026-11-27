# Event Listener Operations

`ContractEventListener` (`sdk/src/eventListener.ts`) polls Soroban RPC for
contract events and dispatches them to registered handlers. This page covers
the three operational APIs that sit beside polling:

- [Payload size validation](#payload-size-validation) — drop oversized events
  before they are decoded.
- [Bounded replay](#bounded-replay) — re-run a ledger range without moving the
  live cursor.
- [Subscription health](#subscription-health) — expose status and counters to
  operators.

## Payload size validation

Every raw event's `topic` and `value` is measured **before** the listener
extracts an event name or hands anything to a handler. Events larger than the
configured ceiling are dropped and logged with `reason: "payload_too_large"`.

```ts
const listener = new ContractEventListener(server, {
  startLedger: currentLedger,
  maxEventPayloadBytes: 16 * 1024, // optional; default 64 KiB
});
```

| Setting | Default | Behaviour |
| --- | --- | --- |
| `maxEventPayloadBytes` | `DEFAULT_MAX_EVENT_PAYLOAD_BYTES` (65 536) | Inclusive limit in UTF-8 bytes. `0` rejects any non-empty payload. Must be a non-negative integer. |

Details worth knowing:

- Size is measured over the JSON representation of `topic` + `value`, the same
  structures a decoder would walk. JSON overhead is counted, so the limit is
  slightly conservative.
- Serialization cannot throw: `BigInt` values are measured as strings and
  cycles are replaced with a placeholder.
- A dropped event still advances the cursor. Otherwise a single oversized
  event would be re-fetched on every poll and stall the subscription.
- `eventPayloadSizeBytes(event)` is exported if a caller wants to check the
  measurement itself.

## Bounded replay

`replay()` re-delivers a closed ledger range through the registered typed and
raw handlers. It is intended for backfills, verification after a deployment,
and recovering a window after an outage.

```ts
const result = await listener.replay({
  fromLedger: 1_200_000,
  toLedger: 1_200_500,
  pageSize: 100,       // optional, defaults to the listener's pageSize
  contractAddresses: [VAULT_A], // optional, defaults to listener config
});

console.log(result.eventsProcessed, result.completed);
```

Both bounds are inclusive. Replay is serialized with `poll()`: a replay waits
for an in-flight poll and a poll waits for a replay, so handlers never see two
interleaved streams.

Replay **does not** move the listener's live cursor, paging token, or durable
checkpoint. A replay can therefore run beside a running keeper.

Boundary behaviour:

| Input | Result |
| --- | --- |
| `fromLedger === toLedger` | Valid single-ledger replay. |
| `toLedger < fromLedger`, non-integer, or negative `fromLedger` | `ReplayRangeError` with `code: "invalid_range"`, no RPC call. |
| Span wider than `MAX_REPLAY_LEDGERS` (10 000) | `ReplayRangeError` with `code: "range_too_large"`, no truncation. |
| `maxEvents` reached | Resolves with `completed: false`; the range was not fully scanned. |
| Aborted `signal` | Rejects with `ReplayRangeError` code `"aborted"` between pages. |
| Oversized event in range | Skipped, counted in `eventsOversized`; never dispatched. |

`ReplayResult` reports `pages`, `eventsProcessed`, `eventsDispatched`,
`eventsSkipped`, `eventsOversized`, `lastLedger`, and `completed`.

## Subscription health

`getHealth()` returns a JSON-serializable snapshot without touching the RPC —
suitable for a `/health` endpoint, a metrics exporter, or a dashboard.

```ts
listener.start(5_000);

setInterval(() => {
  const health = listener.getHealth();
  if (health.status !== 'healthy') {
    console.warn('event subscription', health.status, health.lastError);
  }
}, 30_000);
```

| Status | Meaning |
| --- | --- |
| `idle` | No poll has run yet. |
| `healthy` | Running, and the most recent poll succeeded. |
| `degraded` | Running, but the most recent poll failed. The listener keeps retrying; the next success clears the state. |
| `stopped` | Polling was stopped after at least one poll. |

The snapshot also includes:

- `cursor`, `lastProcessedLedger`, `pagingCursor` — current position.
- `lastPollAt`, `lastSuccessAt`, `lastErrorAt`, `lastError`,
  `consecutiveFailures` — recent poll outcomes.
- `polls` — `attempted`, `succeeded`, `failed`.
- `events` — `processed`, `dispatched`, `skipped`, `oversized`.
- `maxEventPayloadBytes`, `persistent`, `restoredFromLedger`.

A rejected cursor (`CursorExpiredError`, `pollWithResult()` status
`cursor_expired`) counts as a failed poll; the listener drops the paging token
and resumes from its ledger position.
