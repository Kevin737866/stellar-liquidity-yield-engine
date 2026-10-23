/**
 * Event origin labels.
 *
 * Two different kinds of "events" reach a keeper:
 *
 * - `contract`: Soroban contract events (from RPC `getEvents`), emitted by
 *   contract code and addressed by contract id.
 * - `ledger`: Horizon-style ledger-level records (operations, effects,
 *   transactions), produced by the network itself and not by contract code.
 *
 * Tagging each event with its origin lets consumers tell them apart.
 */

export type EventOrigin = 'contract' | 'ledger';

export const CONTRACT_EVENT_ORIGIN: EventOrigin = 'contract';
export const LEDGER_EVENT_ORIGIN: EventOrigin = 'ledger';

/** A Horizon-style ledger-level event (operation/effect record). */
export interface LedgerEvent {
  origin: 'ledger';
  /** Horizon record type, e.g. `payment` or `account_credited`. */
  type: string;
  ledger: number;
  id?: string;
  data?: unknown;
}

/** Wrap a Horizon-style record, labelling it as ledger-level. */
export function toLedgerEvent(record: {
  type: string;
  ledger: number;
  id?: string;
  data?: unknown;
}): LedgerEvent {
  return { origin: LEDGER_EVENT_ORIGIN, ...record };
}

/** Type guard: true when the event came from the ledger, not a contract. */
export function isLedgerEvent(e: { origin?: EventOrigin }): e is LedgerEvent {
  return e.origin === LEDGER_EVENT_ORIGIN;
}

/** Type guard: true when the event was emitted by a contract. */
export function isContractEvent(e: { origin?: EventOrigin }): boolean {
  return e.origin === CONTRACT_EVENT_ORIGIN;
}
