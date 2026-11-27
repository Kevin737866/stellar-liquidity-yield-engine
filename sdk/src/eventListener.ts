
/**
 * Address-filtered contract event listener.
 *
 * Operators running multiple contracts often share a single polling loop
 * against the Soroban RPC. Without filtering, every poll returns every
 * contract event on the network, flooding logs with noise from unrelated
 * contracts.  This module lets a listener declare exactly which contract
 * addresses it cares about; events from every other address are silently
 * discarded before reaching registered handlers.
 *
 * ## Surviving an outage
 *
 * A keeper that keeps its cursor in memory alone loses its place whenever the
 * process dies: after a crash or a deploy it either replays the whole
 * history or starts from scratch.  Passing a {@link CheckpointStore} makes the
 * position durable — the listener restores the cursor from the checkpoint
 * before its first poll and writes a fresh checkpoint after every poll, so a
 * restart during an outage resumes at exactly the ledger it left off.
 *
 * ```ts
 * const listener = new ContractEventListener(rpcServer, {
 *   contractAddresses: [VAULT_A, VAULT_B],
 *   startLedger: 0,
 *   store: new FileCheckpointStore('./state/keeper.json'),
 * });
 * ```
 *
 * ## Usage
 *
 * ```ts
 * const listener = new ContractEventListener(rpcServer, {
 *   contractAddresses: [VAULT_A, VAULT_B],
 *   startLedger: currentLedger,
 * });
 *
 * listener.on('deposit', (evt) => console.log('deposit on', evt.contractId));
 * listener.on('harvest', (evt) => console.log('harvest on', evt.contractId));
 *
 * listener.start(5_000); // poll every 5 s
 * // ...later:
 * listener.stop();
 * ```
 */

import type { VaultEvent, RebalanceEvent, RewardEvent } from './types';
import { CONTRACT_EVENT_ORIGIN } from './eventOrigin';
import type { EventOrigin } from './eventOrigin';
import {
  createCheckpoint,
  type CheckpointStore,
  type KeeperCheckpoint,
} from './persistence';

/**
 * Default number of events requested per poll.
 *
 * Kept well below Soroban's 10 000 ceiling so a single poll stays cheap, but
 * high enough that a keeper catching up after an outage needs only a handful
 * of polls to drain the backlog.
 */
export const DEFAULT_PAGE_SIZE = 200;

/**
 * Default maximum size, in UTF-8 bytes, of a single event's `topic` + `value`
 * payload.
 *
 * Soroban RPC limits how much data one event can carry, so a payload much
 * larger than this is not a legitimate contract event: it is either a
 * corrupted response or a misconfigured node. Validating the size *before*
 * decoding keeps an oversized payload from reaching handlers or an ABI
 * decoder, which is where an unbounded payload would otherwise do its damage.
 */
export const DEFAULT_MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

/**
 * Largest ledger span a single `replay()` accepts.
 *
 * Matches the RPC's bounded event-retention window: a wider replay is almost
 * always a mistake (a wrong `toLedger`, or an attempt to re-index history the
 * node no longer holds) and would silently return a truncated result. Callers
 * that genuinely need more are expected to issue several bounded replays.
 */
export const MAX_REPLAY_LEDGERS = 10_000;

/** Checkpoint metadata key holding the RPC paging cursor mid-ledger. */
export const EVENT_CURSOR_KEY = 'eventCursor';

// ---------------------------------------------------------------------------
// Payload size validation
// ---------------------------------------------------------------------------

/** Serialize a value without throwing on cycles or BigInts, which events use. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, item) => {
        if (typeof item === 'bigint') return item.toString();
        if (typeof item === 'object' && item !== null) {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
        }
        return item;
      }) ?? ''
    );
  } catch {
    // A non-serializable payload still has to be measured; fall back to the
    // string form so the guard remains fail-closed.
    return String(value);
  }
}

/** UTF-8 byte length of a string. */
function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  // `TextEncoder` is available in every supported runtime (Node 18+, all
  // modern browsers); this fallback only exists for exotic embeddings.
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * Measure the decoded payload of a raw event in UTF-8 bytes.
 *
 * The size is the JSON representation of `topic` and `value` — the same
 * structures a decoder would walk — so JSON overhead (quotes, commas) is
 * counted. That makes the measurement slightly conservative, which is the
 * safe direction for a limit: an event just under the threshold cannot be
 * rejected by surprise.
 */
export function eventPayloadSizeBytes(event: Pick<RawContractEvent, 'topic' | 'value'>): number {
  return utf8ByteLength(safeJson(event.topic)) + utf8ByteLength(safeJson(event.value));
}

// ---------------------------------------------------------------------------
// Soroban RPC surface
// ---------------------------------------------------------------------------

/**
 * A single raw contract event as returned by `getEvents`. Only the fields
 * this module reads are declared; `SorobanRpc.Api.EventRecord` satisfies
 * this interface, and so does a stub in tests.
 */
export interface RawContractEvent {
  /** Bech32-encoded or C-strA address of the emitting contract. */
  contractId: string;
  /** Ledger sequence in which the event was emitted. */
  ledger: number;
  /** Ledger-close timestamp (Unix seconds) of the emitting ledger. */
  ledgerClosedAt: string;
  /**
   * The opaque event topic/value fields. Handlers that understand the specific
   * contract ABI can interpret them; the listener itself treats them as
   * pass-through data.
   */
  topic?: unknown[];
  value?: unknown;
  /** Raw ID string from the RPC, used for deduplication. */
  id?: string;
}

/**
 * Minimal structural interface for the Soroban `getEvents` call.
 * `SorobanRpc.Server` satisfies it, and so does any hand-rolled stub.
 */
export interface EventSource {
  getEvents(request: GetEventsRequest): Promise<GetEventsResponse>;
}

export interface GetEventsFilter {
  type?: 'contract' | 'system' | 'diagnostic' | 'all';
  contractIds?: string[];
  topics?: string[][];
}

export interface GetEventsRequest {
  /** First ledger to scan. Omitted when {@link cursor} is set. */
  startLedger?: number;
  /**
   * Resume strictly after the event with this paging token. Soroban RPC
   * rejects requests that set both `cursor` and `startLedger`.
   */
  cursor?: string;
  endLedger?: number;
  filters?: GetEventsFilter[];
  limit?: number;
}

export interface GetEventsResponse {
  events: RawContractEvent[];
  latestLedger: number;
}

// ---------------------------------------------------------------------------
// Typed SDK events — enrich raw RPC events with the contract address
// ---------------------------------------------------------------------------

/** A VaultEvent enriched with the contract address that emitted it. */
export type FilteredVaultEvent = VaultEvent & { contractId: string };

/** A RebalanceEvent enriched with the contract address that emitted it. */
export type FilteredRebalanceEvent = RebalanceEvent & { contractId: string };

/** A RewardEvent enriched with the contract address that emitted it. */
export type FilteredRewardEvent = RewardEvent & { contractId: string };

/**
 * Catch-all for events whose type is not one of the well-known SDK event
 * shapes. Handlers receive the raw RPC payload.
 */
export interface UnknownContractEvent {
  /** Always `contract`: distinguishes these from Horizon-style ledger events. */
  origin: EventOrigin;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  topic?: unknown[];
  value?: unknown;
}

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

/** All typed event names recognised by the listener. */
export type KnownEventName =
  | VaultEvent['type']        // 'deposit' | 'withdraw' | 'harvest' | 'pause' | 'unpause'
  | RebalanceEvent['type']    // 'proposal' | 'execution' | 'failure'
  | RewardEvent['type'];      // 'distribution' | 'claim' | 'expiry'

/** Map from event name to its handler payload type. */
export interface EventHandlerMap {
  deposit: FilteredVaultEvent;
  withdraw: FilteredVaultEvent;
  harvest: FilteredVaultEvent;
  pause: FilteredVaultEvent;
  unpause: FilteredVaultEvent;
  proposal: FilteredRebalanceEvent;
  execution: FilteredRebalanceEvent;
  failure: FilteredRebalanceEvent;
  distribution: FilteredRewardEvent;
  claim: FilteredRewardEvent;
  expiry: FilteredRewardEvent;
}

export type EventHandler<K extends KnownEventName> = (event: EventHandlerMap[K]) => void;

/** Handler called for every raw event that passes the address filter. */
export type RawEventHandler = (event: UnknownContractEvent) => void;

// ---------------------------------------------------------------------------
// Listener configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for `ContractEventListener`.
 *
 * The only required field is `startLedger`; everything else has a sensible
 * default.
 */
export interface ListenerConfig {
  /**
   * Restrict event delivery to this set of contract addresses. When provided
   * and non-empty, any event from a contract **not** in this list is silently
   * dropped before reaching handlers. When omitted or empty, events from all
   * contracts are forwarded.
   *
   * Addresses should be in the same format returned by the RPC (bech32 / StrKey
   * C-address). Comparison is case-insensitive.
   */
  contractAddresses?: string[];

  /**
   * Ledger sequence to start reading from. The listener advances its internal
   * cursor forward as ledgers are consumed so restarts do not re-process old
   * events.
   *
   * When a {@link ListenerConfig.store} is configured this is only a
   * fallback: the restored checkpoint takes precedence unless it points
   * further back than `startLedger`.
   */
  startLedger: number;

  /**
   * Maximum number of events to request per poll. Soroban's default ceiling is
   * 10 000; the listener defaults to 200 to keep individual payloads small.
   */
  pageSize?: number;

  /**
   * Additional RPC-level event filter (e.g. event type or topic). The
   * `contractIds` inside this filter is merged with (or overridden by)
   * `contractAddresses` — do **not** set both; use `contractAddresses`.
   */
  rpcFilter?: Omit<GetEventsFilter, 'contractIds'>;

  /**
   * Durable store for the listener's position.
   *
   * When set, the listener restores its cursor from the store before the
   * first poll and writes a fresh checkpoint after every successful poll. A
   * restart after an outage then resumes at the ledger it left off instead of
   * replaying (or skipping) history.
   */
  store?: CheckpointStore;

  /**
   * Restore the cursor from {@link ListenerConfig.store} automatically before
   * the first poll. Defaults to `true` whenever a store is configured.
   *
   * The restore happens on the first poll no matter how the listener is
   * driven — `start()`, a manual `poll()`, or a script — so there is no way
   * to accidentally poll from the wrong position after a restart.
   */
  autoRestore?: boolean;

  /**
   * Write a checkpoint after every successful poll. Defaults to `true` when a
   * store is configured. Disable only when the caller persists the position
   * itself.
   */
  persistOnPoll?: boolean;

  /**
   * Extra counters stored alongside the position in the checkpoint. Useful
   * for operators that want to inspect how much work a keeper has done.
   */
  checkpointMetadata?: Record<string, string | number | boolean>;

  /**
   * Maximum size, in UTF-8 bytes, of a single event's `topic` + `value`
   * payload. Events larger than this are dropped before any decoding or
   * handler dispatch and counted in {@link ContractEventListener.getHealth}.
   *
   * Defaults to {@link DEFAULT_MAX_EVENT_PAYLOAD_BYTES} (64 KiB). Set `0` to
   * reject any non-empty payload; the limit is inclusive, so a payload of
   * exactly this many bytes is accepted.
   */
  maxEventPayloadBytes?: number;

  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Error event
// ---------------------------------------------------------------------------

export interface ListenerErrorEvent {
  error: Error;
  /** Current cursor (ledger) at the time of the error. */
  ledger: number;
}

// ---------------------------------------------------------------------------
// Cursor expiration
// ---------------------------------------------------------------------------

/** Why the RPC stopped accepting the listener's saved cursor. */
export type CursorExpirationReason = 'expired' | 'pruned' | 'invalid';

/**
 * Typed error raised when the RPC rejects a saved cursor.
 *
 * Soroban RPC keeps event history for a bounded window. A paging cursor that
 * points into a ledger older than that window is rejected, which is a
 * different failure from a network outage: retrying the same cursor will keep
 * failing, so the listener drops it and resumes from its ledger position.
 */
export class CursorExpiredError extends Error {
  /** The cursor the RPC rejected (a paging token, or a ledger number). */
  readonly cursor: string | number;
  /** Ledger the listener will resume from on the next poll. */
  readonly resumeFromLedger: number;
  /** Best-effort classification of the RPC rejection. */
  readonly reason: CursorExpirationReason;
  /** The original RPC error, kept for logging. */
  readonly originalError: Error;

  constructor(
    cursor: string | number,
    resumeFromLedger: number,
    reason: CursorExpirationReason,
    originalError: Error,
  ) {
    super(
      `RPC cursor ${String(cursor)} is no longer usable (${reason}); ` +
        `resuming from ledger ${resumeFromLedger}`,
    );
    this.name = 'CursorExpiredError';
    this.cursor = cursor;
    this.resumeFromLedger = resumeFromLedger;
    this.reason = reason;
    this.originalError = originalError;
  }
}

/** Flatten an unknown thrown value into searchable text. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const extra = error as Error & {
      code?: unknown;
      details?: unknown;
      response?: { data?: unknown };
    };
    return [error.message, extra.code, extra.details, extra.response?.data]
      .filter((part) => part !== undefined && part !== null)
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
      .join(' ');
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Whether an RPC failure means the saved cursor can no longer be used.
 *
 * Detection is message-based because Soroban RPC does not expose a stable
 * machine-readable code for this condition. The check deliberately requires
 * both a cursor mention and an expiration-like word so an unrelated error that
 * happens to contain "cursor" is not misclassified.
 */
export function isCursorExpiredError(error: unknown): boolean {
  const text = errorText(error).toLowerCase();
  if (!text.includes('cursor')) return false;
  return /(expir|too old|stale|invalid|not found|unknown|pruned|out of range|outside)/.test(
    text,
  );
}

/** Classify a cursor-expiration error for the typed result. */
export function classifyCursorExpiration(error: unknown): CursorExpirationReason {
  const text = errorText(error).toLowerCase();
  if (text.includes('prun')) return 'pruned';
  if (text.includes('invalid') || text.includes('not found') || text.includes('unknown')) {
    return 'invalid';
  }
  return 'expired';
}

/** Outcome of a single poll. */
export type PollResult =
  | {
      /** The poll completed and the listener advanced. */
      status: 'ok';
      /** Number of raw events returned by the RPC in this poll. */
      eventsProcessed: number;
      /** Ledger the next poll will start from. */
      nextLedger: number;
    }
  | {
      /** The saved cursor was rejected; the listener dropped it. */
      status: 'cursor_expired';
      /** Cursor the RPC rejected. */
      cursor: string | number;
      /** Ledger the next poll will resume from. */
      resumeFromLedger: number;
      /** Typed error also delivered through the error handler. */
      error: CursorExpiredError;
    }
  | {
      /** Any other poll failure (network, checkpoint, ...). */
      status: 'error';
      /** Ledger at the time of the failure. */
      ledger: number;
      /** The underlying error. */
      error: Error;
    };

// ---------------------------------------------------------------------------
// Bounded replay
// ---------------------------------------------------------------------------

/** Why a bounded replay request was rejected. */
export type ReplayErrorCode = 'invalid_range' | 'range_too_large' | 'aborted';

/**
 * Raised when a {@link ContractEventListener.replay} request cannot run.
 *
 * Replay failures are configuration/programming mistakes, so they reject the
 * call rather than going through the poll error handler — a range that can
 * never be served should not be retried by a poll loop.
 */
export class ReplayRangeError extends Error {
  readonly code: ReplayErrorCode;

  constructor(code: ReplayErrorCode, message: string) {
    super(message);
    this.name = 'ReplayRangeError';
    this.code = code;
  }
}

/** A bounded ledger range to replay through the registered handlers. */
export interface ReplayOptions {
  /** First ledger to replay (inclusive). */
  fromLedger: number;
  /** Last ledger to replay (inclusive). */
  toLedger: number;
  /** Events requested per page. Defaults to the listener's `pageSize`. */
  pageSize?: number;
  /**
   * Contract addresses to deliver events from. Defaults to the listener's
   * `contractAddresses`; pass an empty array to replay every contract.
   */
  contractAddresses?: string[];
  /** Stop after this many events have been considered. Defaults to no cap. */
  maxEvents?: number;
  /** Abort the replay between pages. */
  signal?: AbortSignal;
}

/** Outcome of a bounded replay. */
export interface ReplayResult {
  /** First ledger replayed (inclusive). */
  fromLedger: number;
  /** Last ledger replayed (inclusive). */
  toLedger: number;
  /** RPC pages fetched. */
  pages: number;
  /** Events that passed the address filter and were considered. */
  eventsProcessed: number;
  /** Events that reached at least one typed handler. */
  eventsDispatched: number;
  /** Events that were filtered, oversized, unknown, or had no handler. */
  eventsSkipped: number;
  /** Events dropped for exceeding `maxEventPayloadBytes`. */
  eventsOversized: number;
  /** Highest ledger consumed during the replay (`fromLedger - 1` when empty). */
  lastLedger: number;
  /**
   * Whether the whole range was scanned. `false` when `maxEvents` cut the
   * replay short.
   */
  completed: boolean;
}

/** Normalized, validated replay options used internally. */
interface NormalizedReplayOptions {
  fromLedger: number;
  toLedger: number;
  pageSize: number;
  contractAddresses?: string[];
  maxEvents?: number;
  signal?: AbortSignal;
}

/** Per-page dispatch counts, shared by polling and replay. */
interface DispatchSummary {
  highestLedger: number;
  processed: number;
  dispatched: number;
  skipped: number;
  oversized: number;
}

// ---------------------------------------------------------------------------
// Health status
// ---------------------------------------------------------------------------

/**
 * Overall state of an event subscription.
 *
 * - `idle`: no poll has run yet.
 * - `healthy`: the subscription is running and its most recent poll succeeded.
 * - `degraded`: the subscription is running, but its most recent poll failed
 *   (the listener keeps retrying; the next success clears the state).
 * - `stopped`: polling was stopped after at least one poll.
 */
export type SubscriptionHealthStatus = 'idle' | 'healthy' | 'degraded' | 'stopped';

/** A point-in-time snapshot of an event subscription's health. */
export interface EventSubscriptionHealth {
  /** Coarse status derived from the counters below. */
  status: SubscriptionHealthStatus;
  /** Whether `start()` is active. */
  running: boolean;
  /** Whether a checkpoint store is configured. */
  persistent: boolean;
  /** Ledger the next poll will start from. */
  cursor: number;
  /** Highest ledger fully consumed (`-1` when none). */
  lastProcessedLedger: number;
  /** RPC paging token carried between polls, if any. */
  pagingCursor: string | null;
  /** Wall-clock time of the most recent poll attempt (ms), if any. */
  lastPollAt: number | null;
  /** Wall-clock time of the most recent successful poll (ms), if any. */
  lastSuccessAt: number | null;
  /** Wall-clock time of the most recent failed poll (ms), if any. */
  lastErrorAt: number | null;
  /** Most recent poll error, or `null` when the last poll succeeded. */
  lastError: { message: string; ledger: number } | null;
  /** Failures since the last successful poll. */
  consecutiveFailures: number;
  /** Poll counters. */
  polls: { attempted: number; succeeded: number; failed: number };
  /** Event counters since the listener was constructed. */
  events: {
    /** Events that passed the address filter and were considered. */
    processed: number;
    /** Events that reached at least one typed handler. */
    dispatched: number;
    /** Events filtered as noise, oversized, unknown, or unhandled. */
    skipped: number;
    /** Events dropped for exceeding `maxEventPayloadBytes`. */
    oversized: number;
  };
  /** Configured payload ceiling, in UTF-8 bytes. */
  maxEventPayloadBytes: number;
  /** Ledger restored from durable state, or `null` when none was restored. */
  restoredFromLedger: number | null;
}

// ---------------------------------------------------------------------------
// ContractEventListener
// ---------------------------------------------------------------------------

/**
 * Polls the Soroban RPC for contract events and dispatches them to registered
 * handlers, optionally restricting delivery to a declared set of contract
 * addresses.
 *
 * ### Filtering
 *
 * Address filtering happens at two levels:
 *
 * 1. **RPC level** (preferred): When `contractAddresses` is provided, the
 *    addresses are forwarded to the RPC `getEvents` filter so the node itself
 *    narrows the result set before any bytes travel over the wire.
 * 2. **SDK level** (belt-and-suspenders): Before dispatching, the listener
 *    checks `event.contractId` against the canonical (lower-cased) allow-list
 *    and drops any event that slips through.
 *
 * ### Event dispatch
 *
 * The listener inspects each raw event's first topic element for a string that
 * matches a known SDK event name (`deposit`, `harvest`, `proposal`, …) and
 * calls the corresponding typed handler. If the topic does not map to a known
 * name the `raw` handler is called instead, giving callers the full payload.
 *
 * ### Error handling
 *
 * Poll errors are delivered through the `error` handler if one is registered.
 * If no error handler is registered, errors are logged to `console.error` and
 * the poll loop continues. The listener never stops itself on error.
 *
 * ### Durable state
 *
 * When a {@link CheckpointStore} is configured the listener restores its
 * cursor before the first poll and writes a checkpoint after every successful
 * poll. A restart after an outage therefore resumes at the ledger the keeper
 * left off — catching up on everything that happened while it was down
 * without replaying what it had already handled.
 */
export class ContractEventListener {
  private readonly source: EventSource;
  private readonly config: ListenerConfig;

  /** Lower-cased canonical address allow-list (empty ⟹ pass-all). */
  private readonly allowedAddresses: Set<string>;

  /** Latest ledger the listener has consumed (exclusive lower bound). */
  private cursor: number;
  /** Tail of the serialized poll queue; keeps polls from overlapping. */
  private pollChain: Promise<void> = Promise.resolve();

  /**
   * RPC paging token of the last event received when a page came back full.
   * While set, the next request resumes strictly after that event instead of
   * at {@link cursor}, so a page that ends mid-ledger loses nothing.
   */
  private pagingCursor: string | null = null;

  /** Durable store for the listener's position (optional). */
  private readonly store?: CheckpointStore;

  /** Clock used to stamp checkpoints. */
  private readonly now: () => number;

  /** The checkpoint restored on start, if any. */
  private restoredCheckpoint: KeeperCheckpoint | null = null;

  /** Whether the durable position was already restored for this process. */
  private restoreAttempted = false;

  /** Ledger the listener resumed from after a restore. */
  private resumedFromLedger: number | null = null;

  /** Typed-event handler registry. */
  private readonly handlers = new Map<KnownEventName, Set<EventHandler<KnownEventName>>>();

  /** Catch-all handler for events whose name is unknown. */
  private rawHandlers: Set<RawEventHandler> = new Set();

  /** Error handlers. */
  private errorHandlers: Set<(e: ListenerErrorEvent) => void> = new Set();

  /** Timer handle returned by `setInterval`, null when stopped. */
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Payload ceiling applied before decoding each event. */
  private readonly maxEventPayloadBytes: number;

  /** Poll and event counters backing {@link getHealth}. */
  private readonly stats = {
    pollsAttempted: 0,
    pollsSucceeded: 0,
    pollsFailed: 0,
    eventsProcessed: 0,
    eventsDispatched: 0,
    eventsSkipped: 0,
    eventsOversized: 0,
  };

  /** Timestamps and failure state backing {@link getHealth}. */
  private lastPollAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastErrorAt: number | null = null;
  private lastErrorInfo: { message: string; ledger: number } | null = null;
  private consecutiveFailures = 0;

  /**
   * Structured logger used for skipped/aborted action diagnostics.
   *
   * Emits a single-line JSON record so operators can grep/parse logs. A
   * skipped action is any event that was fetched but never dispatched to a
   * handler (address-filtered, unknown topic, or no registered handler).
   *
   * Example log interpretation guide:
   *
   *   {"component":"ContractEventListener","event":"action_skipped",
   *    "reason":"address_filtered","contractId":"C...","ledger":123,
   *    "cursor":120,"eventName":null}
   *     -> Event came from a contract not in `contractAddresses`; expected
   *        noise from a shared RPC. Safe to ignore.
   *
   *   {"component":"ContractEventListener","event":"action_skipped",
   *    "reason":"unknown_topic","contractId":"C...","ledger":124,
   *    "cursor":120,"eventName":null}
   *     -> Event passed the address filter but its first topic was not a
   *        known SDK event name. Attach an `onRaw` handler to inspect it.
   *
   *   {"component":"ContractEventListener","event":"action_skipped",
   *    "reason":"no_handler","contractId":"C...","ledger":125,
   *    "cursor":120,"eventName":"deposit"}
   *     -> A typed event was recognised but no handler was registered for
   *        it. Register `listener.on('deposit', ...)` to consume it.
   */
  private logSkipped(
    reason: string,
    raw: RawContractEvent,
    eventName: KnownEventName | null,
    detail?: Record<string, unknown>,
  ): void {
    // eslint-disable-next-line no-console
    console.debug(JSON.stringify({
      component: 'ContractEventListener',
      event: 'action_skipped',
      reason,
      contractId: raw.contractId,
      ledger: raw.ledger,
      cursor: this.cursor,
      eventName,
      ...detail,
    }));
  }

  constructor(source: EventSource, config: ListenerConfig) {
    this.source = source;
    this.config = config;
    this.cursor = config.startLedger;
    this.store = config.store;
    this.now = config.now ?? Date.now;

    const maxPayloadBytes = config.maxEventPayloadBytes ?? DEFAULT_MAX_EVENT_PAYLOAD_BYTES;
    if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes < 0) {
      throw new Error('maxEventPayloadBytes must be a non-negative integer');
    }
    this.maxEventPayloadBytes = maxPayloadBytes;

    // Normalise addresses once for O(1) look-ups at event time.
    this.allowedAddresses = new Set(
      (config.contractAddresses ?? []).map((a) => a.toLowerCase()),
    );
  }

  // -------------------------------------------------------------------------
  // Handler registration
  // -------------------------------------------------------------------------

  /**
   * Register a handler for a specific typed event name.
   *
   * Multiple handlers for the same name are all called in registration order.
   * Returns `this` for chaining.
   */
  on<K extends KnownEventName>(name: K, handler: EventHandler<K>): this {
    if (!this.handlers.has(name)) {
      this.handlers.set(name, new Set());
    }
    (this.handlers.get(name) as Set<EventHandler<K>>).add(handler);
    return this;
  }

  /**
   * Remove a previously registered handler.  If `handler` was not registered,
   * this is a no-op. Returns `this` for chaining.
   */
  off<K extends KnownEventName>(name: K, handler: EventHandler<K>): this {
    (this.handlers.get(name) as Set<EventHandler<K>> | undefined)?.delete(handler);
    return this;
  }

  /**
   * Register a catch-all handler that receives every event that passes the
   * address filter, regardless of whether its name is a known SDK event.
   */
  onRaw(handler: RawEventHandler): this {
    this.rawHandlers.add(handler);
    return this;
  }

  /** Remove a raw handler. */
  offRaw(handler: RawEventHandler): this {
    this.rawHandlers.delete(handler);
    return this;
  }

  /**
   * Register an error handler. Multiple handlers are all called.
   * If no handler is registered, errors fall through to `console.error`.
   */
  onError(handler: (e: ListenerErrorEvent) => void): this {
    this.errorHandlers.add(handler);
    return this;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start polling the Soroban RPC at the given interval.
   *
   * When a {@link CheckpointStore} is configured the cursor is restored from
   * it *before* the first poll, so a restarted keeper continues from the
   * ledger it left off instead of starting over. A checkpoint that cannot be
   * read is reported through the `error` handler and the listener falls back
   * to the configured `startLedger`.
   *
   * @param intervalMs Milliseconds between polls (default: 5000 ms / 1 ledger).
   */
  start(intervalMs = 5_000): void {
    if (this.intervalHandle !== null) return; // already running
    this.intervalHandle = setInterval(() => void this.poll(), intervalMs);
    // Poll immediately on start (the first poll restores the durable
    // position first); it runs in the background so `start()` stays
    // synchronous.
    void this.poll();
  }

  /** Stop polling. In-flight polls complete normally. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Whether the listener is currently polling. */
  get isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  /** The ledger the listener will start from on the next poll. */
  get currentLedger(): number {
    return this.cursor;
  }

  /** The highest ledger the listener has fully consumed (`-1` when none). */
  get lastProcessedLedger(): number {
    return this.cursor - 1;
  }

  // -------------------------------------------------------------------------
  // Durable state
  // -------------------------------------------------------------------------

  /**
   * Restore the cursor from the configured store.
   *
   * The checkpoint wins over the configured `startLedger` unless the operator
   * moved `startLedger` further ahead, in which case the listener honours the
   * newer position. Returns `true` when a checkpoint was applied.
   *
   * The first poll restores automatically (unless
   * {@link ListenerConfig.autoRestore} is `false`), so calling this by hand
   * is only needed when the caller wants to inspect the restored position
   * before the first poll.
   *
   * @throws {CheckpointError} when the store holds an unreadable checkpoint.
   *   Callers that prefer a best-effort restart should catch the error and
   *   continue from the configured `startLedger`.
   */
  async restore(): Promise<boolean> {
    this.restoreAttempted = true;
    if (!this.store) return false;

    const checkpoint = await this.store.load();
    if (!checkpoint) return false;

    this.cursor = Math.max(this.config.startLedger, checkpoint.nextLedger);
    // The paging cursor only applies while the checkpoint's position wins.
    const eventCursor = checkpoint.metadata?.[EVENT_CURSOR_KEY];
    this.pagingCursor =
      typeof eventCursor === 'string' && checkpoint.nextLedger >= this.config.startLedger
        ? eventCursor
        : null;
    this.restoredCheckpoint = checkpoint;
    this.resumedFromLedger = this.cursor;
    return true;
  }

  /**
   * Write the listener's current position to the configured store.
   *
   * @returns The checkpoint that was written, or `null` when no store is
   *   configured.
   */
  async persist(): Promise<KeeperCheckpoint | null> {
    if (!this.store) return null;

    const metadata = this.pagingCursor !== null
      ? { ...this.config.checkpointMetadata, [EVENT_CURSOR_KEY]: this.pagingCursor }
      : this.config.checkpointMetadata;
    const checkpoint = createCheckpoint(this.cursor, this.now(), metadata);
    await this.store.save(checkpoint);
    return checkpoint;
  }

  /**
   * The checkpoint that was restored on start, or `null` when the listener
   * started without durable state (or the store was empty).
   */
  get restoredState(): KeeperCheckpoint | null {
    return this.restoredCheckpoint;
  }

  /**
   * The ledger the listener resumed from after a restore, or `null` when no
   * checkpoint was restored.
   */
  get resumeLedger(): number | null {
    return this.resumedFromLedger;
  }

  /** Whether durable state is configured for this listener. */
  get isPersistent(): boolean {
    return this.store !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  /**
   * Snapshot of the subscription's health for operators and dashboards.
   *
   * Returns a plain, JSON-serializable object — safe to log, expose from a
   * `/health` endpoint, or feed into a metrics exporter. Calling it does not
   * touch the RPC.
   */
  getHealth(): EventSubscriptionHealth {
    const status: SubscriptionHealthStatus =
      this.stats.pollsAttempted === 0
        ? 'idle'
        : !this.isRunning
          ? 'stopped'
          : this.consecutiveFailures > 0
            ? 'degraded'
            : 'healthy';

    return {
      status,
      running: this.isRunning,
      persistent: this.isPersistent,
      cursor: this.cursor,
      lastProcessedLedger: this.lastProcessedLedger,
      pagingCursor: this.pagingCursor,
      lastPollAt: this.lastPollAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastErrorInfo ? { ...this.lastErrorInfo } : null,
      consecutiveFailures: this.consecutiveFailures,
      polls: {
        attempted: this.stats.pollsAttempted,
        succeeded: this.stats.pollsSucceeded,
        failed: this.stats.pollsFailed,
      },
      events: {
        processed: this.stats.eventsProcessed,
        dispatched: this.stats.eventsDispatched,
        skipped: this.stats.eventsSkipped,
        oversized: this.stats.eventsOversized,
      },
      maxEventPayloadBytes: this.maxEventPayloadBytes,
      restoredFromLedger: this.resumedFromLedger,
    };
  }

  // ---------------------------------------------------------------------------
  // Bounded replay
  // ---------------------------------------------------------------------------

  /**
   * Replay a bounded ledger range through the registered handlers.
   *
   * Replay is for backfilling and verification — recovering a window after a
   * keeper outage, re-running handlers against a known range, or checking that
   * a deployment produces the events a consumer expects. It is deliberately
   * separate from the live cursor: the listener's checkpoint and `poll()`
   * position are **not** modified, so a replay can run beside a running keeper
   * without dragging it backwards or forwards.
   *
   * Both `fromLedger` and `toLedger` are inclusive. Replay is serialized with
   * polling — a replay waits for an in-flight poll, and a poll waits for the
   * replay — so handlers never observe the two streams interleaved out of
   * order and never run concurrently for the same listener.
   *
   * Boundary behaviour:
   * - A ledger range of a single ledger (`fromLedger === toLedger`) is valid.
   * - A reverse or non-integer range is rejected with `invalid_range`.
   * - A span wider than {@link MAX_REPLAY_LEDGERS} is rejected with
   *   `range_too_large` rather than silently truncated.
   * - An aborted `signal` rejects with `aborted` between pages; events already
   *   dispatched have been delivered.
   *
   * Oversized and unknown events inside the range follow the same rules as a
   * live poll: they are skipped and counted, never handed to a decoder.
   *
   * @throws {ReplayRangeError} when the requested range is not replayable.
   */
  async replay(options: ReplayOptions): Promise<ReplayResult> {
    const range = this.normalizeReplayOptions(options);

    // Reuse the poll chain so replay and polling never overlap.
    const run = this.pollChain.then(
      () => this.runReplay(range),
      () => this.runReplay(range),
    );
    this.pollChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Validate replay options once, before entering the polling chain. */
  private normalizeReplayOptions(options: ReplayOptions): NormalizedReplayOptions {
    const { fromLedger, toLedger } = options;
    if (!Number.isInteger(fromLedger) || !Number.isInteger(toLedger)) {
      throw new ReplayRangeError('invalid_range', 'replay ledgers must be integers');
    }
    if (fromLedger < 0) {
      throw new ReplayRangeError('invalid_range', 'fromLedger must be non-negative');
    }
    if (toLedger < fromLedger) {
      throw new ReplayRangeError(
        'invalid_range',
        `toLedger (${toLedger}) must be at or after fromLedger (${fromLedger})`,
      );
    }
    if (toLedger - fromLedger + 1 > MAX_REPLAY_LEDGERS) {
      throw new ReplayRangeError(
        'range_too_large',
        `replay range spans ${toLedger - fromLedger + 1} ledgers; the maximum is ${MAX_REPLAY_LEDGERS}`,
      );
    }

    const pageSize = options.pageSize ?? this.config.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new ReplayRangeError('invalid_range', 'pageSize must be a positive integer');
    }

    if (
      options.maxEvents !== undefined &&
      (!Number.isInteger(options.maxEvents) || options.maxEvents <= 0)
    ) {
      throw new ReplayRangeError('invalid_range', 'maxEvents must be a positive integer');
    }

    return {
      fromLedger,
      toLedger,
      pageSize,
      contractAddresses: options.contractAddresses,
      maxEvents: options.maxEvents,
      signal: options.signal,
    };
  }

  /** Fetch and dispatch a bounded range without touching live cursor state. */
  private async runReplay(range: NormalizedReplayOptions): Promise<ReplayResult> {
    const addresses = range.contractAddresses ?? this.config.contractAddresses;
    const allowed = new Set((addresses ?? []).map((address) => address.toLowerCase()));

    let pagingCursor: string | null = null;
    let startLedger = range.fromLedger;
    let pages = 0;
    let eventsProcessed = 0;
    let eventsDispatched = 0;
    let eventsSkipped = 0;
    let eventsOversized = 0;
    let lastLedger = range.fromLedger - 1;
    let completed = false;
    let previousLastId: string | undefined;
    let previousLastLedger = -1;

    while (true) {
      if (range.signal?.aborted) {
        throw new ReplayRangeError('aborted', 'replay aborted by signal');
      }

      const request: GetEventsRequest = {
        ...(pagingCursor !== null ? { cursor: pagingCursor } : { startLedger }),
        endLedger: range.toLedger,
        filters: [this.buildFilter(allowed)],
        limit: range.pageSize,
      };

      const response = await this.source.getEvents(request);
      pages += 1;

      const summary = this.dispatchEvents(response.events, allowed);
      eventsProcessed += summary.processed;
      eventsDispatched += summary.dispatched;
      eventsSkipped += summary.skipped;
      eventsOversized += summary.oversized;
      lastLedger = Math.max(lastLedger, summary.highestLedger);

      if (response.events.length < range.pageSize) {
        completed = true;
        break;
      }

      if (range.maxEvents !== undefined && eventsProcessed >= range.maxEvents) {
        break;
      }

      const last = response.events[response.events.length - 1];

      // A full page with no forward movement would repeat forever. This is an
      // RPC anomaly, so fail loudly instead of spinning.
      if (last?.id === previousLastId && last?.ledger === previousLastLedger) {
        throw new Error('replay made no progress: RPC returned the same page twice');
      }
      previousLastId = last?.id;
      previousLastLedger = last?.ledger ?? previousLastLedger;

      if (last?.id) {
        pagingCursor = last.id;
      } else {
        // No paging token: resume at the next ledger after the last one seen.
        const nextStart = Math.max(last?.ledger ?? startLedger, startLedger) + 1;
        if (nextStart > range.toLedger) {
          completed = true;
          break;
        }
        startLedger = nextStart;
        pagingCursor = null;
      }
    }

    return {
      fromLedger: range.fromLedger,
      toLedger: range.toLedger,
      pages,
      eventsProcessed,
      eventsDispatched,
      eventsSkipped,
      eventsOversized,
      lastLedger,
      completed,
    };
  }

  // -------------------------------------------------------------------------
  // Core polling logic
  // -------------------------------------------------------------------------

  /**
   * Perform a single poll against the RPC and dispatch resulting events.
   *
   * This is public so it can be called manually in tests or scripts that
   * manage their own timing. Polls never overlap: a call made while another
   * poll is in flight waits for it to finish.
   */
  poll(): Promise<void> {
    return this.pollWithResult().then(() => undefined);
  }

  /**
   * Perform a single poll and return a typed outcome.
   *
   * Unlike {@link poll}, this distinguishes a rejected cursor from any other
   * failure. A cursor the RPC has aged out is not retryable with the same
   * position, so the listener drops the paging token and reports
   * `cursor_expired` with the ledger it will resume from.
   *
   * Polls never overlap: a call made while another poll is in flight waits for
   * it to finish.
   */
  pollWithResult(): Promise<PollResult> {
    // Chain onto the previous poll. Both arms run the next poll so a rejection
    // can never stall the loop permanently.
    const run = this.pollChain.then(
      () => this.runPoll(),
      () => this.runPoll(),
    );
    this.pollChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Run a single poll: restore the durable position (first poll only),
   * fetch, dispatch and persist.
   */
  private async runPoll(): Promise<PollResult> {
    this.stats.pollsAttempted += 1;
    this.lastPollAt = this.now();

    try {
      await this.restoreIfNeeded();
      const request = this.buildRequest();
      const response = await this.source.getEvents(request);
      const eventsProcessed = response.events.length;
      this.processResponse(response);
      await this.persistIfEnabled();

      this.stats.pollsSucceeded += 1;
      this.consecutiveFailures = 0;
      this.lastSuccessAt = this.now();
      this.lastErrorInfo = null;

      return { status: 'ok', eventsProcessed, nextLedger: this.cursor };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordFailure(error);

      if (isCursorExpiredError(error)) {
        const cursor = this.pagingCursor ?? this.cursor;
        const resumeFromLedger = this.cursor;
        const expired = new CursorExpiredError(
          cursor,
          resumeFromLedger,
          classifyCursorExpiration(error),
          error,
        );
        // The token is unusable. Dropping it makes the next poll fall back to
        // the ledger position, which may replay part of the last ledger but
        // never skips an event.
        this.pagingCursor = null;
        this.lastErrorInfo = { message: expired.message, ledger: this.cursor };
        this.emitError(expired);
        return { status: 'cursor_expired', cursor, resumeFromLedger, error: expired };
      }

      this.emitError(error);
      return { status: 'error', ledger: this.cursor, error };
    }
  }

  /** Record a failed poll for {@link getHealth}. */
  private recordFailure(error: Error): void {
    this.stats.pollsFailed += 1;
    this.consecutiveFailures += 1;
    this.lastErrorAt = this.now();
    this.lastErrorInfo = { message: error.message, ledger: this.cursor };
  }

  /**
   * Restore the durable position before the very first poll.
   *
   * A checkpoint that cannot be read is reported through the error handler and
   * the listener falls back to the configured `startLedger` — a keeper that
   * cannot read its state still comes back up and says so.
   */
  private async restoreIfNeeded(): Promise<void> {
    if (!this.store) return;
    if (this.restoreAttempted) return;
    if (this.config.autoRestore === false) return;

    try {
      await this.restore();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitError(error);
    }
  }

  private async persistIfEnabled(): Promise<void> {
    if (!this.store) return;
    if (this.config.persistOnPoll === false) return;

    try {
      await this.persist();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitError(error);
    }
  }

  private emitError(error: Error): void {
    const event: ListenerErrorEvent = { error, ledger: this.cursor };
    if (this.errorHandlers.size > 0) {
      this.errorHandlers.forEach((h) => {
        try {
          h(event);
        } catch {
          // A broken error handler must not take the keeper down.
        }
      });
    } else {
      // eslint-disable-next-line no-console
      console.error(`[ContractEventListener] poll error at ledger ${this.cursor}:`, error.message);
    }
  }

  /** Build the RPC filter shared by polling and replay. */
  private buildFilter(allowed: Set<string> = this.allowedAddresses): GetEventsFilter {
    const filter: GetEventsFilter = {
      ...(this.config.rpcFilter ?? {}),
      type: (this.config.rpcFilter as GetEventsFilter | undefined)?.type ?? 'contract',
    };

    // Push address filtering down to the RPC layer when we have an allow-list.
    if (allowed.size > 0) {
      filter.contractIds = [...allowed];
    }

    return filter;
  }

  private buildRequest(): GetEventsRequest {
    const position = this.pagingCursor !== null
      ? { cursor: this.pagingCursor }
      : { startLedger: this.cursor };

    return {
      ...position,
      filters: [this.buildFilter()],
      limit: this.config.pageSize ?? DEFAULT_PAGE_SIZE,
    };
  }

  private processResponse(response: GetEventsResponse): void {
    const { events, latestLedger } = response;
    const summary = this.dispatchEvents(events);

    this.stats.eventsProcessed += summary.processed;
    this.stats.eventsDispatched += summary.dispatched;
    this.stats.eventsSkipped += summary.skipped;
    this.stats.eventsOversized += summary.oversized;

    this.advanceCursor(events, summary.highestLedger, latestLedger);
  }

  /**
   * Filter, size-check and dispatch a batch of raw events.
   *
   * The payload size check deliberately runs **before** `extractEventName` and
   * before any handler sees the event: an oversized payload is dropped while
   * it is still opaque bytes, so neither this listener nor an ABI decoder
   * downstream ever has to trust it.
   *
   * The ledger position still advances past skipped events (their ledgers are
   * folded into `highestLedger`) — otherwise a single oversized event would be
   * re-fetched on every poll and stall the subscription forever.
   */
  private dispatchEvents(
    events: RawContractEvent[],
    allowed: Set<string> = this.allowedAddresses,
  ): DispatchSummary {
    let highestLedger = -1;
    let processed = 0;
    let dispatched = 0;
    let skipped = 0;
    let oversized = 0;

    for (const raw of events) {
      if (raw.ledger > highestLedger) highestLedger = raw.ledger;

      // SDK-level guard: drop events not in the allow-list.
      if (!this.isAllowed(raw.contractId, allowed)) {
        this.logSkipped('address_filtered', raw, null);
        skipped += 1;
        continue;
      }

      processed += 1;

      // Size guard: reject an oversized payload before decoding it.
      const payloadBytes = eventPayloadSizeBytes(raw);
      if (payloadBytes > this.maxEventPayloadBytes) {
        oversized += 1;
        skipped += 1;
        this.logSkipped('payload_too_large', raw, this.extractEventName(raw), {
          payloadBytes,
          maxPayloadBytes: this.maxEventPayloadBytes,
        });
        continue;
      }

      const unknown: UnknownContractEvent = {
        origin: CONTRACT_EVENT_ORIGIN,
        contractId: raw.contractId,
        ledger: raw.ledger,
        ledgerClosedAt: raw.ledgerClosedAt,
        topic: raw.topic,
        value: raw.value,
      };

      // Deliver to raw handlers unconditionally (all passing events).
      this.rawHandlers.forEach((h) => h(unknown));

      // Attempt typed dispatch.
      const name = this.extractEventName(raw);
      if (name !== null) {
        const delivered = this.dispatchTyped(name, raw);
        if (delivered) {
          dispatched += 1;
        } else {
          skipped += 1;
          this.logSkipped('no_handler', raw, name);
        }
      } else {
        skipped += 1;
        this.logSkipped('unknown_topic', raw, null);
      }
    }

    return { highestLedger, processed, dispatched, skipped, oversized };
  }

  /**
   * Move the cursor forward to the first ledger that has not been consumed.
   *
   * Two cases matter:
   *
   * - **Drained** (`events.length < limit`): the RPC had nothing left to
   *   return, so everything up to the node's head has been consumed and the
   *   cursor jumps to `latestLedger + 1`.
   * - **Truncated** (`events.length === limit`): the page was full, so more
   *   events may still be waiting. The cursor therefore only advances to the
   *   ledger after the highest event actually consumed. Jumping to the head
   *   here would silently skip the events that did not fit on the page —
   *   exactly the events a keeper misses when it comes back from a long
   *   outage. When the RPC supplied event ids, the listener also keeps the
   *   last id as a paging cursor and continues strictly after it, because
   *   the rest of the last ledger's events may not have fit on the page
   *   either.
   *
   * The cursor never moves backwards.
   */
  private advanceCursor(
    events: RawContractEvent[],
    highestEventLedger: number,
    latestLedger: number,
  ): void {
    const limit = this.config.pageSize ?? DEFAULT_PAGE_SIZE;
    const drained = events.length < limit;

    const last = events[events.length - 1];
    this.pagingCursor = !drained && last?.id ? last.id : null;

    // When the page was full we only know about the events we consumed; when
    // it was not, the node's head is the authoritative end of the range.
    const consumedThrough = drained
      ? Math.max(highestEventLedger, latestLedger)
      : highestEventLedger;

    if (consumedThrough < 0) return;

    const next = consumedThrough + 1;
    if (next > this.cursor) {
      this.cursor = next;
    }
  }

  /**
   * Returns true when:
   * - no allow-list is configured (pass-all mode), or
   * - the event's contract address is in the allow-list.
   */
  private isAllowed(
    contractId: string,
    allowed: Set<string> = this.allowedAddresses,
  ): boolean {
    if (allowed.size === 0) return true;
    return allowed.has(contractId.toLowerCase());
  }

  /**
   * Extract the SDK event name from the first element of the event's topic
   * array. Returns `null` when no match can be made.
   *
   * Soroban contract events encode their "event name" as the first topic
   * element (a Symbol or String XDR value). The stellar-sdk decodes it to a
   * plain JS string, which is what we compare here.
   */
  private extractEventName(raw: RawContractEvent): KnownEventName | null {
    const topic = raw.topic;
    if (!Array.isArray(topic) || topic.length === 0) return null;

    const first = topic[0];
    if (typeof first !== 'string') return null;

    const known: KnownEventName[] = [
      'deposit', 'withdraw', 'harvest', 'pause', 'unpause',
      'proposal', 'execution', 'failure',
      'distribution', 'claim', 'expiry',
    ];

    return (known as string[]).includes(first) ? (first as KnownEventName) : null;
  }

  /**
   * Build a typed SDK event from the raw RPC event and call all registered
   * handlers for the given name.
   *
   * Returns `true` when at least one handler was invoked, `false` when the
   * event was recognised but no handler was registered (caller logs the skip).
   */
  private dispatchTyped(name: KnownEventName, raw: RawContractEvent): boolean {
    const set = this.handlers.get(name);
    if (!set || set.size === 0) return false;

    const base = {
      contractId: raw.contractId,
      timestamp: Math.floor(new Date(raw.ledgerClosedAt).getTime() / 1000),
      data: raw.value,
    };

    // Build the narrowest typed event we can without a full ABI decoder.
    // For the purposes of filtering and routing, the contractId + timestamp +
    // raw data are sufficient; callers that need decoded fields should attach
    // a raw handler and decode themselves.
    const vaultNames: KnownEventName[] = ['deposit', 'withdraw', 'harvest', 'pause', 'unpause'];
    const rebalanceNames: KnownEventName[] = ['proposal', 'execution', 'failure'];
    const rewardNames: KnownEventName[] = ['distribution', 'claim', 'expiry'];

    let evt: EventHandlerMap[KnownEventName];

    if ((vaultNames as string[]).includes(name)) {
      evt = {
        type: name as VaultEvent['type'],
        vault: raw.contractId as unknown as import('stellar-sdk').Address,
        timestamp: base.timestamp,
        data: base.data,
        contractId: raw.contractId,
      } satisfies FilteredVaultEvent;
    } else if ((rebalanceNames as string[]).includes(name)) {
      evt = {
        type: name as RebalanceEvent['type'],
        strategy: 0, // decoded by a full ABI consumer; we provide the raw data
        timestamp: base.timestamp,
        data: base.data,
        contractId: raw.contractId,
      } satisfies FilteredRebalanceEvent;
    } else {
      // rewardNames
      evt = {
        type: name as RewardEvent['type'],
        vault: raw.contractId as unknown as import('stellar-sdk').Address,
        timestamp: base.timestamp,
        data: base.data,
        contractId: raw.contractId,
      } satisfies FilteredRewardEvent;
    }

    set.forEach((h) => (h as (e: typeof evt) => void)(evt));
    return true;
  }
}
