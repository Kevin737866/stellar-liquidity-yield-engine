/**
 * Unit tests for the typed RPC cursor-expiration result (issue #420).
 *
 * The listener must be able to tell "the node no longer accepts my saved
 * cursor" apart from a retryable failure, and must resume without losing
 * events after the unusable cursor is dropped.
 */

import {
  ContractEventListener,
  CursorExpiredError,
  classifyCursorExpiration,
  isCursorExpiredError,
  type EventSource,
  type GetEventsRequest,
  type GetEventsResponse,
  type ListenerConfig,
  type ListenerErrorEvent,
  type RawContractEvent,
} from './eventListener';

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

/** Event source that replays a script of responses and thrown errors. */
class ScriptedSource implements EventSource {
  readonly requests: GetEventsRequest[] = [];
  private readonly steps: Array<GetEventsResponse | Error>;

  constructor(steps: Array<GetEventsResponse | Error>) {
    this.steps = [...steps];
  }

  async getEvents(request: GetEventsRequest): Promise<GetEventsResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (step === undefined) throw new Error('scripted source exhausted');
    if (step instanceof Error) throw step;
    return step;
  }
}

function makeListener(steps: Array<GetEventsResponse | Error>, pageSize = 1) {
  const source = new ScriptedSource(steps);
  const config: ListenerConfig = { startLedger: 100, pageSize };
  return { listener: new ContractEventListener(source, config), source };
}

describe('isCursorExpiredError', () => {
  it.each([
    'cursor 123 is expired',
    'Invalid cursor',
    'cursor not found',
    'the cursor has been pruned',
    'cursor is out of range',
    'Cursor 999 is too old',
  ])('detects %s', (message) => {
    expect(isCursorExpiredError(new Error(message))).toBe(true);
  });

  it('reads nested RPC error payloads', () => {
    const rpcError = Object.assign(new Error('request rejected'), {
      code: -32602,
      response: { data: { message: 'cursor 42 is invalid' } },
    });
    expect(isCursorExpiredError(rpcError)).toBe(true);
  });

  it.each([
    'network timeout',
    'cursor too far in the future',
    'simulation failed',
    'fetch failed',
  ])('does not classify %s as cursor expiration', (message) => {
    expect(isCursorExpiredError(new Error(message))).toBe(false);
  });
});

describe('classifyCursorExpiration', () => {
  it('distinguishes pruned, invalid and expired cursors', () => {
    expect(classifyCursorExpiration(new Error('cursor was pruned'))).toBe('pruned');
    expect(classifyCursorExpiration(new Error('invalid cursor'))).toBe('invalid');
    expect(classifyCursorExpiration(new Error('cursor expired'))).toBe('expired');
  });
});

describe('ContractEventListener.pollWithResult', () => {
  it('returns cursor_expired and resumes from the ledger position', async () => {
    const { listener, source } = makeListener([
      { events: [makeRaw('evt-1')], latestLedger: 100 },
      new Error('cursor evt-1 has expired'),
      { events: [], latestLedger: 105 },
    ]);
    const errors: ListenerErrorEvent[] = [];
    listener.onError((event) => errors.push(event));

    const first = await listener.pollWithResult();
    expect(first).toEqual({ status: 'ok', eventsProcessed: 1, nextLedger: 101 });

    const expired = await listener.pollWithResult();
    expect(expired.status).toBe('cursor_expired');
    if (expired.status !== 'cursor_expired') throw new Error('unreachable');
    expect(expired.cursor).toBe('evt-1');
    expect(expired.resumeFromLedger).toBe(101);
    expect(expired.error).toBeInstanceOf(CursorExpiredError);
    expect(expired.error.reason).toBe('expired');
    expect(errors).toHaveLength(1);
    expect(errors[0].error).toBe(expired.error);

    // The unusable paging token is dropped: the next request falls back to the
    // ledger cursor instead of replaying the expired token.
    const recovered = await listener.pollWithResult();
    expect(recovered.status).toBe('ok');
    expect(source.requests[2]).toMatchObject({ startLedger: 101 });
    expect(source.requests[2]).not.toHaveProperty('cursor');
  });

  it('reports the ledger cursor when no paging token was in use', async () => {
    const { listener } = makeListener([new Error('cursor 100 is not found')]);

    const result = await listener.pollWithResult();

    expect(result.status).toBe('cursor_expired');
    if (result.status !== 'cursor_expired') throw new Error('unreachable');
    expect(result.cursor).toBe(100);
    expect(result.resumeFromLedger).toBe(100);
    expect(result.error.reason).toBe('invalid');
  });

  it('keeps non-cursor failures as generic errors', async () => {
    const { listener } = makeListener([new Error('network timeout')]);
    const errors: ListenerErrorEvent[] = [];
    listener.onError((event) => errors.push(event));

    const result = await listener.pollWithResult();

    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('unreachable');
    expect(result.ledger).toBe(100);
    expect(result.error.message).toBe('network timeout');
    expect(result.error).not.toBeInstanceOf(CursorExpiredError);
    expect(errors[0].error.message).toBe('network timeout');
  });

  it('keeps poll() resolving to void for backward compatibility', async () => {
    const { listener } = makeListener([new Error('cursor 100 is expired')]);

    await expect(listener.poll()).resolves.toBeUndefined();
  });
});
