/**
 * Unit tests for explicit listener error and recovery state transitions.
 */

import {
  ContractEventListener,
  CursorExpiredError,
  type EventSource,
  type GetEventsRequest,
  type GetEventsResponse,
  type ListenerStateTransition,
  type RawContractEvent,
} from './eventListener';
import type { CheckpointStore, KeeperCheckpoint } from './persistence';

function makeRaw(id: string, ledger = 100): RawContractEvent {
  return {
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
    topic: ['deposit'],
    ledger,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    value: null,
    id,
  };
}

class ScriptedSource implements EventSource {
  private readonly steps: Array<GetEventsResponse | Error | (() => Promise<GetEventsResponse>)>;

  constructor(steps: Array<GetEventsResponse | Error | (() => Promise<GetEventsResponse>)>) {
    this.steps = [...steps];
  }

  async getEvents(_request: GetEventsRequest): Promise<GetEventsResponse> {
    const step = this.steps.shift();
    if (step === undefined) return { events: [], latestLedger: 100 };
    if (typeof step === 'function') return step();
    if (step instanceof Error) throw step;
    return step;
  }
}

describe('ContractEventListener explicit state transitions', () => {
  it('starts in idle state with zero errors and no prior transition', () => {
    const listener = new ContractEventListener(new ScriptedSource([]), {
      startLedger: 100,
    });

    expect(listener.state).toBe('idle');
    expect(listener.consecutiveErrors).toBe(0);
    expect(listener.lastError).toBeNull();
    expect(listener.lastTransition).toBeNull();
  });

  it('transitions idle -> running -> stopped -> running and ignores redundant start/stop', () => {
    let clock = 1_000;
    const listener = new ContractEventListener(new ScriptedSource([]), {
      startLedger: 100,
      now: () => (clock += 100),
    });
    const transitions: ListenerStateTransition[] = [];
    listener.onStateChange((t) => transitions.push(t));

    // Redundant stop while idle is a no-op
    listener.stop();
    expect(listener.state).toBe('idle');
    expect(transitions).toHaveLength(0);

    listener.start(60_000);
    listener.start(60_000); // idempotent
    expect(listener.state).toBe('running');

    listener.stop();
    listener.stop(); // idempotent
    expect(listener.state).toBe('stopped');

    listener.start(60_000);
    expect(listener.state).toBe('running');
    listener.stop();

    expect(transitions.map((t) => `${t.from}->${t.to}:${t.reason}`)).toEqual([
      'idle->running:started',
      'running->stopped:stopped',
      'stopped->running:started',
      'running->stopped:stopped',
    ]);
    expect(transitions[0].timestamp).toBe(1_100);
    expect(listener.lastTransition).toEqual(transitions[transitions.length - 1]);
  });

  it('transitions running -> error -> recovering -> running on poll error and recovery', async () => {
    let clock = 10_000;
    const rpcErr = new Error('RPC 503 unavailable');
    const source = new ScriptedSource([
      { events: [], latestLedger: 100 }, // initial poll from start()
      rpcErr,
      { events: [], latestLedger: 105 },
    ]);
    const listener = new ContractEventListener(source, {
      startLedger: 100,
      now: () => (clock += 1_000),
    });
    const transitions: ListenerStateTransition[] = [];
    listener.onStateChange((t) => transitions.push(t));
    listener.onError(() => {});

    listener.start(60_000);
    // Drain the initial poll triggered by start()
    await listener.pollWithResult(); // fails with rpcErr
    expect(listener.state).toBe('error');
    expect(listener.consecutiveErrors).toBe(1);
    expect(listener.lastError).toBe(rpcErr);

    const recovered = await listener.pollWithResult();
    expect(recovered.status).toBe('ok');
    expect(listener.state).toBe('running');
    expect(listener.consecutiveErrors).toBe(0);
    expect(listener.lastError).toBeNull();

    listener.stop();

    expect(transitions.map((t) => `${t.from}->${t.to}:${t.reason}`)).toEqual([
      'idle->running:started',
      'running->error:poll_error',
      'error->recovering:recovery_attempt',
      'recovering->running:recovered',
      'running->stopped:stopped',
    ]);
    expect(transitions[1].error).toBe(rpcErr);
    expect(transitions[1].consecutiveErrors).toBe(1);
    expect(transitions[3].consecutiveErrors).toBe(0);
  });

  it('tracks consecutive errors across failed recovery attempts until a poll succeeds', async () => {
    const err1 = new Error('timeout 1');
    const err2 = new Error('timeout 2');
    const source = new ScriptedSource([
      err1,
      err2,
      { events: [], latestLedger: 110 },
    ]);
    const listener = new ContractEventListener(source, { startLedger: 100 });
    const transitions: ListenerStateTransition[] = [];
    listener.onStateChange((t) => transitions.push(t));
    listener.onError(() => {});

    await listener.pollWithResult();
    expect(listener.state).toBe('error');
    expect(listener.consecutiveErrors).toBe(1);

    await listener.pollWithResult();
    expect(listener.state).toBe('error');
    expect(listener.consecutiveErrors).toBe(2);
    expect(listener.lastError).toBe(err2);

    await listener.pollWithResult();
    expect(listener.state).toBe('idle');
    expect(listener.consecutiveErrors).toBe(0);
    expect(listener.lastError).toBeNull();

    expect(transitions.map((t) => `${t.from}->${t.to}:${t.reason}`)).toEqual([
      'idle->error:poll_error',
      'error->recovering:recovery_attempt',
      'recovering->error:poll_error',
      'error->recovering:recovery_attempt',
      'recovering->idle:recovered',
    ]);
  });

  it('records cursor_expired transition reason and recovers on next poll', async () => {
    const source = new ScriptedSource([
      { events: [makeRaw('evt-1', 100)], latestLedger: 100 },
      new Error('cursor evt-1 has expired'),
      { events: [], latestLedger: 105 },
    ]);
    const listener = new ContractEventListener(source, { startLedger: 100, pageSize: 1 });
    const transitions: ListenerStateTransition[] = [];
    listener.onStateChange((t) => transitions.push(t));
    listener.onError(() => {});

    await listener.pollWithResult();
    expect(listener.state).toBe('idle');
    expect(transitions).toHaveLength(0);

    const expired = await listener.pollWithResult();
    expect(expired.status).toBe('cursor_expired');
    expect(listener.state).toBe('error');
    expect(listener.lastError).toBeInstanceOf(CursorExpiredError);

    const ok = await listener.pollWithResult();
    expect(ok.status).toBe('ok');
    expect(listener.state).toBe('idle');

    expect(transitions.map((t) => `${t.from}->${t.to}:${t.reason}`)).toEqual([
      'idle->error:cursor_expired',
      'error->recovering:recovery_attempt',
      'recovering->idle:recovered',
    ]);
  });

  it('records restore_error and persist_error transitions from CheckpointStore failures', async () => {
    let failSave = true;
    const flakyStore: CheckpointStore = {
      async load(): Promise<KeeperCheckpoint | null> {
        throw new Error('corrupt checkpoint file');
      },
      async save(): Promise<void> {
        if (failSave) throw new Error('disk full');
      },
    };

    const source = new ScriptedSource([
      { events: [], latestLedger: 105 },
      { events: [], latestLedger: 106 },
    ]);
    const listener = new ContractEventListener(source, {
      startLedger: 100,
      store: flakyStore,
    });
    const transitions: ListenerStateTransition[] = [];
    listener.onStateChange((t) => transitions.push(t));
    listener.onError(() => {});

    // First poll: restore fails (enters error), persist fails (remains error)
    await listener.pollWithResult();
    expect(listener.state).toBe('error');
    expect(listener.consecutiveErrors).toBe(2);

    // Second poll: persist succeeds -> recovers
    failSave = false;
    await listener.pollWithResult();
    expect(listener.state).toBe('idle');
    expect(listener.consecutiveErrors).toBe(0);

    expect(transitions.map((t) => `${t.from}->${t.to}:${t.reason}`)).toEqual([
      'idle->error:restore_error',
      'error->recovering:recovery_attempt',
      'recovering->idle:recovered',
    ]);
  });

  it('does not overwrite stopped state when an in-flight poll finishes or fails', async () => {
    let rejectPoll!: (err: Error) => void;
    const source = new ScriptedSource([
      () =>
        new Promise<GetEventsResponse>((_resolve, reject) => {
          rejectPoll = reject;
        }),
    ]);
    const listener = new ContractEventListener(source, { startLedger: 100 });
    const transitions: ListenerStateTransition[] = [];
    listener.onStateChange((t) => transitions.push(t));
    listener.onError(() => {});

    listener.start(60_000);
    // Let pollChain schedule runPoll() so getEvents() is in flight
    await new Promise((resolve) => setImmediate(resolve));
    // Stop while the initial poll is still in flight
    listener.stop();
    expect(listener.state).toBe('stopped');

    rejectPoll(new Error('aborted'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(listener.state).toBe('stopped');
    expect(transitions.map((t) => `${t.from}->${t.to}:${t.reason}`)).toEqual([
      'idle->running:started',
      'running->stopped:stopped',
    ]);
  });

  it('isolates throwing state observers and supports offStateChange / offError', async () => {
    const source = new ScriptedSource([new Error('boom'), { events: [], latestLedger: 102 }]);
    const listener = new ContractEventListener(source, { startLedger: 100 });
    const observed: ListenerStateTransition[] = [];
    const errors: Error[] = [];

    const badObserver = () => {
      throw new Error('observer bug');
    };
    const goodObserver = (t: ListenerStateTransition) => observed.push(t);
    const errHandler = (e: { error: Error }) => errors.push(e.error);

    listener.onStateChange(badObserver).onStateChange(goodObserver).onError(errHandler);

    await listener.pollWithResult();
    expect(observed).toHaveLength(1);
    expect(errors).toHaveLength(1);

    listener.offStateChange(goodObserver).offError(errHandler);
    await listener.pollWithResult();
    // goodObserver was unregistered, so it does not receive recovery transitions
    expect(observed).toHaveLength(1);
  });
});
