
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

/** Checkpoint metadata key holding the RPC paging cursor mid-ledger. */
export const EVENT_CURSOR_KEY = 'eventCursor';

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
   * Restrict event delivery to events whose `topic` array starts with at least
   * one of these prefixes. Each prefix is a non-empty array of exact,
   * case-sensitive topic segment strings (e.g. `[['vault', 'deposit'], ['harvest']]`).
   *
   * When omitted or empty (`[]`), events with any topic are forwarded.
   * Passing an empty prefix (`[[]]`) or a blank/non-string segment throws an
   * `Error` when constructing the listener.
   *
   * When set and `rpcFilter.topics` is not explicitly provided, each prefix is
   * also pushed down to the RPC `getEvents` filter with a trailing `'**'`
   * wildcard (`[...prefix, '**']`), and re-checked at the SDK level before
   * dispatching to `onRaw` or typed handlers.
   */
  topicPrefixes?: string[][];

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

  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Error event & listener state transitions
// ---------------------------------------------------------------------------

export interface ListenerErrorEvent {
  error: Error;
  /** Current cursor (ledger) at the time of the error. */
  ledger: number;
}

/**
 * Explicit operational state of a {@link ContractEventListener}.
 *
 * - `'idle'`: Constructed and not yet started (manual `poll()` calls may still run).
 * - `'running'`: Actively polling and healthy.
 * - `'error'`: Most recent poll, restore, or persistence step failed.
 * - `'recovering'`: Attempting a poll after entering `'error'` to verify recovery.
 * - `'stopped'`: Polling was explicitly stopped via `stop()`.
 */
export type ListenerState = 'idle' | 'running' | 'error' | 'recovering' | 'stopped';

/** Reason a {@link ContractEventListener} transitioned between states. */
export type ListenerStateTransitionReason =
  | 'started'
  | 'stopped'
  | 'poll_error'
  | 'cursor_expired'
  | 'restore_error'
  | 'persist_error'
  | 'recovery_attempt'
  | 'recovered';

/** Record emitted whenever a {@link ContractEventListener} changes state. */
export interface ListenerStateTransition {
  /** State before the transition. */
  from: ListenerState;
  /** State after the transition. */
  to: ListenerState;
  /** Why the transition happened. */
  reason: ListenerStateTransitionReason;
  /** Listener cursor (next ledger) at the time of the transition. */
  ledger: number;
  /** Wall-clock timestamp (ms since epoch) from the listener's clock. */
  timestamp: number;
  /** Number of consecutive failed polls at the time of the transition. */
  consecutiveErrors: number;
  /** Underlying error when transitioning into `'error'`. */
  error?: Error;
}

/** Handler invoked whenever the listener transitions to a new state. */
export type ListenerStateHandler = (transition: ListenerStateTransition) => void;

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
// Topic prefix matching & validation
// ---------------------------------------------------------------------------

/**
 * Validate and defensively copy a list of topic prefixes.
 *
 * Each prefix must be a non-empty array of non-empty (non-whitespace) strings.
 * An empty outer array `[]` is valid and represents pass-all mode.
 *
 * @throws {Error} when any prefix is empty or contains a blank/non-string segment.
 */
export function validateTopicPrefixes(
  prefixes: readonly (readonly string[])[],
): string[][] {
  if (!Array.isArray(prefixes)) {
    throw new Error('topicPrefixes must be an array of string arrays');
  }

  return prefixes.map((prefix, prefixIndex) => {
    if (!Array.isArray(prefix) || prefix.length === 0) {
      throw new Error(
        `Invalid topic prefix at index ${prefixIndex}: prefix must be a non-empty array of strings`,
      );
    }

    return prefix.map((segment, segIndex) => {
      if (typeof segment !== 'string' || segment.trim().length === 0) {
        throw new Error(
          `Invalid topic prefix segment at [${prefixIndex}][${segIndex}]: segment must be a non-empty string`,
        );
      }
      return segment;
    });
  });
}

/**
 * Return `true` when `topic` starts with every segment of `prefix` (exact,
 * case-sensitive string comparison).
 *
 * Returns `false` when `prefix` is empty, `topic` is missing/shorter than
 * `prefix`, or any leading topic element is not a matching string.
 */
export function matchesTopicPrefix(
  topic: readonly unknown[] | undefined,
  prefix: readonly string[],
): boolean {
  if (!Array.isArray(topic) || prefix.length === 0 || topic.length < prefix.length) {
    return false;
  }

  for (let i = 0; i < prefix.length; i += 1) {
    if (typeof topic[i] !== 'string' || topic[i] !== prefix[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Return `true` when `prefixes` is empty (pass-all) or `topic` matches at
 * least one prefix in `prefixes`.
 */
export function matchesAnyTopicPrefix(
  topic: readonly unknown[] | undefined,
  prefixes: readonly (readonly string[])[],
): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some((prefix) => matchesTopicPrefix(topic, prefix));
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

  /** Validated topic prefixes (empty ⟹ pass-all). */
  private readonly topicPrefixes: string[][];

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

  /** State transition handlers. */
  private stateHandlers: Set<ListenerStateHandler> = new Set();

  /** Current operational state of the listener. */
  private _state: ListenerState = 'idle';

  /** Number of consecutive poll/restore/persist failures since the last healthy poll. */
  private _consecutiveErrors = 0;

  /** Most recent error observed while in `'error'` or `'recovering'`, or `null` when healthy. */
  private _lastError: Error | null = null;

  /** Most recent state transition record, or `null` before any transition. */
  private _lastTransition: ListenerStateTransition | null = null;

  /** Timer handle returned by `setInterval`, null when stopped. */
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

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
  private logSkipped(reason: string, raw: RawContractEvent, eventName: KnownEventName | null): void {
    // eslint-disable-next-line no-console
    console.debug(JSON.stringify({
      component: 'ContractEventListener',
      event: 'action_skipped',
      reason,
      contractId: raw.contractId,
      ledger: raw.ledger,
      cursor: this.cursor,
      eventName,
    }));
  }

  constructor(source: EventSource, config: ListenerConfig) {
    this.source = source;
    this.config = config;
    this.cursor = config.startLedger;
    this.store = config.store;
    this.now = config.now ?? Date.now;

    // Normalise addresses once for O(1) look-ups at event time.
    this.allowedAddresses = new Set(
      (config.contractAddresses ?? []).map((a) => a.toLowerCase()),
    );

    // Validate and defensively copy topic prefixes up front.
    this.topicPrefixes = validateTopicPrefixes(config.topicPrefixes ?? []);
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

  /** Remove a previously registered error handler. */
  offError(handler: (e: ListenerErrorEvent) => void): this {
    this.errorHandlers.delete(handler);
    return this;
  }

  /**
   * Register a handler that is notified whenever the listener transitions
   * between operational states (e.g. `running -> error -> recovering -> running`).
   */
  onStateChange(handler: ListenerStateHandler): this {
    this.stateHandlers.add(handler);
    return this;
  }

  /** Remove a previously registered state transition handler. */
  offStateChange(handler: ListenerStateHandler): this {
    this.stateHandlers.delete(handler);
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
    this._consecutiveErrors = 0;
    this._lastError = null;
    this.transitionState('running', 'started');
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
    if (this._state !== 'idle' && this._state !== 'stopped') {
      this.transitionState('stopped', 'stopped');
    }
  }

  /** Whether the listener is currently polling. */
  get isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  /** Current operational state of the listener. */
  get state(): ListenerState {
    return this._state;
  }

  /** Number of consecutive failed polls/operations since the last healthy poll. */
  get consecutiveErrors(): number {
    return this._consecutiveErrors;
  }

  /** Most recent error while in `'error'` or `'recovering'`, or `null` when healthy. */
  get lastError(): Error | null {
    return this._lastError;
  }

  /** Most recent state transition record, or `null` before any transition. */
  get lastTransition(): ListenerStateTransition | null {
    return this._lastTransition;
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
    if (this._state === 'error') {
      this.transitionState('recovering', 'recovery_attempt');
    }

    try {
      await this.restoreIfNeeded();
      const request = this.buildRequest();
      const response = await this.source.getEvents(request);
      const eventsProcessed = response.events.length;
      this.processResponse(response);
      const persisted = await this.persistIfEnabled();
      if (persisted && (this._state === 'recovering' || this._state === 'error')) {
        this._consecutiveErrors = 0;
        this._lastError = null;
        this.transitionState(this.isRunning ? 'running' : 'idle', 'recovered');
      }
      return { status: 'ok', eventsProcessed, nextLedger: this.cursor };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

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
        this.recordErrorState(expired, 'cursor_expired');
        this.emitError(expired);
        return { status: 'cursor_expired', cursor, resumeFromLedger, error: expired };
      }

      this.recordErrorState(error, 'poll_error');
      this.emitError(error);
      return { status: 'error', ledger: this.cursor, error };
    }
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
      this.recordErrorState(error, 'restore_error');
      this.emitError(error);
    }
  }

  private async persistIfEnabled(): Promise<boolean> {
    if (!this.store) return true;
    if (this.config.persistOnPoll === false) return true;

    try {
      await this.persist();
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.recordErrorState(error, 'persist_error');
      this.emitError(error);
      return false;
    }
  }

  private recordErrorState(error: Error, reason: ListenerStateTransitionReason): void {
    this._consecutiveErrors += 1;
    this._lastError = error;
    if (this._state !== 'stopped') {
      this.transitionState('error', reason, error);
    }
  }

  private transitionState(
    to: ListenerState,
    reason: ListenerStateTransitionReason,
    error?: Error,
  ): void {
    const from = this._state;
    if (from === to) return;

    this._state = to;
    const transition: ListenerStateTransition = {
      from,
      to,
      reason,
      ledger: this.cursor,
      timestamp: this.now(),
      consecutiveErrors: this._consecutiveErrors,
      ...(error !== undefined ? { error } : {}),
    };
    this._lastTransition = transition;

    this.stateHandlers.forEach((handler) => {
      try {
        handler(transition);
      } catch {
        // A broken state observer must not take the keeper down.
      }
    });
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

  private buildRequest(): GetEventsRequest {
    const filter: GetEventsFilter = {
      ...(this.config.rpcFilter ?? {}),
      type: (this.config.rpcFilter as GetEventsFilter | undefined)?.type ?? 'contract',
    };

    // Push address filtering down to the RPC layer when we have an allow-list.
    if (this.allowedAddresses.size > 0) {
      filter.contractIds = [...this.allowedAddresses];
    }

    // Push topic prefix filtering down to the RPC layer when configured and
    // no explicit rpcFilter.topics override was provided.
    if (this.topicPrefixes.length > 0 && !filter.topics?.length) {
      filter.topics = this.topicPrefixes.map((prefix) => [...prefix, '**']);
    }

    const position = this.pagingCursor !== null
      ? { cursor: this.pagingCursor }
      : { startLedger: this.cursor };

    return {
      ...position,
      filters: [filter],
      limit: this.config.pageSize ?? DEFAULT_PAGE_SIZE,
    };
  }

  private processResponse(response: GetEventsResponse): void {
    const { events, latestLedger } = response;

    // Highest ledger covered by an event we actually consumed.
    let highestEventLedger = -1;

    for (const raw of events) {
      // SDK-level guard: drop events not in the allow-list.
      if (!this.isAllowed(raw.contractId)) {
        this.logSkipped('address_filtered', raw, null);
        continue;
      }

      // SDK-level guard: drop events that do not match any configured topic prefix.
      if (!this.matchesTopicFilter(raw.topic)) {
        this.logSkipped('topic_filtered', raw, null);
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
        const dispatched = this.dispatchTyped(name, raw);
        if (!dispatched) this.logSkipped('no_handler', raw, name);
      } else {
        this.logSkipped('unknown_topic', raw, null);
      }

      if (raw.ledger > highestEventLedger) {
        highestEventLedger = raw.ledger;
      }
    }

    this.advanceCursor(events, highestEventLedger, latestLedger);
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
  private isAllowed(contractId: string): boolean {
    if (this.allowedAddresses.size === 0) return true;
    return this.allowedAddresses.has(contractId.toLowerCase());
  }

  /**
   * Returns true when:
   * - no topic prefixes are configured (pass-all mode), or
   * - the event's topic array starts with at least one configured prefix.
   */
  private matchesTopicFilter(topic: unknown[] | undefined): boolean {
    return matchesAnyTopicPrefix(topic, this.topicPrefixes);
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
