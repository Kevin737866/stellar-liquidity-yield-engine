import { ContractEventListener, type EventSource, type UnknownContractEvent } from './eventListener';
import { toLedgerEvent, isLedgerEvent, isContractEvent } from './eventOrigin';

describe('event origin separation', () => {
  it('labels listener events as contract and ledger records as ledger', async () => {
    const source: EventSource = {
      getEvents: async () => ({
        latestLedger: 10,
        events: [{ contractId: 'C1', ledger: 5, ledgerClosedAt: '2024-01-01T00:00:00Z', topic: ['x'] }],
      }),
    } as EventSource;
    const listener = new ContractEventListener(source, { contractAddresses: [], startLedger: 1 });
    const seen: UnknownContractEvent[] = [];
    listener.onRaw((e) => seen.push(e));
    await listener.poll();

    expect(seen).toHaveLength(1);
    expect(seen[0].origin).toBe('contract');
    expect(isContractEvent(seen[0])).toBe(true);
    expect(isLedgerEvent(seen[0])).toBe(false);

    const ledgerEvt = toLedgerEvent({ type: 'payment', ledger: 6 });
    expect(ledgerEvt.origin).toBe('ledger');
    expect(isLedgerEvent(ledgerEvt)).toBe(true);
    expect(isContractEvent(ledgerEvt)).toBe(false);
  });
});
