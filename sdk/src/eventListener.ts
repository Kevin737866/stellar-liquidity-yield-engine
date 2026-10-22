import * as fs from 'fs';
import * as path from 'path';

/** A contract event as returned by an RPC `getEvents` style call. */
export interface ListenerEvent {
  id: string;
  ledger: number;
  [key: string]: unknown;
}

export interface EventPage {
  events: ListenerEvent[];
  /** Highest ledger the RPC has scanned; lets the cursor advance over empty ranges. */
  latestLedger?: number;
}

/** Fetches events with ledger >= startLedger. */
export type EventFetcher = (startLedger: number) => Promise<EventPage>;

export interface CursorStore {
  load(): number | undefined;
  save(ledger: number): void;
}

/** Persists the last fully processed ledger in a JSON file. */
export class FileCursorStore implements CursorStore {
  constructor(private readonly filePath: string) {}

  load(): number | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return Number.isInteger(parsed.lastProcessedLedger) && parsed.lastProcessedLedger >= 0
        ? parsed.lastProcessedLedger
        : undefined;
    } catch {
      return undefined;
    }
  }

  save(ledger: number): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Write-then-rename so a crash never leaves a truncated cursor file.
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastProcessedLedger: ledger }));
    fs.renameSync(tmp, this.filePath);
  }
}

export class MemoryCursorStore implements CursorStore {
  constructor(private ledger?: number) {}
  load() {
    return this.ledger;
  }
  save(ledger: number) {
    this.ledger = ledger;
  }
}

export interface EventListenerOptions {
  fetchEvents: EventFetcher;
  handler: (event: ListenerEvent) => Promise<void> | void;
  store: CursorStore;
  /** Ledger to start from when no cursor has been persisted. */
  startLedger?: number;
}

export class EventListener {
  constructor(private readonly opts: EventListenerOptions) {}

  /** Ledger the next poll starts from: one past the last fully processed ledger. */
  get nextLedger(): number {
    const saved = this.opts.store.load();
    return saved !== undefined ? saved + 1 : this.opts.startLedger ?? 0;
  }

  /**
   * Poll once. Events are handled in ledger order and the cursor is persisted
   * after every ledger is fully handled, so a restart resumes right after it
   * (at-least-once: a crash mid-ledger replays only that ledger).
   * Returns the number of events handled.
   */
  async poll(): Promise<number> {
    const start = this.nextLedger;
    const page = await this.opts.fetchEvents(start);
    const events = page.events
      .filter((e) => e.ledger >= start)
      .sort((a, b) => a.ledger - b.ledger);
    let handled = 0;

    for (let i = 0; i < events.length; i++) {
      await this.opts.handler(events[i]);
      handled++;
      const next = events[i + 1];
      if (!next || next.ledger !== events[i].ledger) {
        this.opts.store.save(events[i].ledger);
      }
    }

    // Advance over ledgers with no events so restarts don't rescan them.
    const last = events.length ? events[events.length - 1].ledger : start - 1;
    if (page.latestLedger !== undefined && page.latestLedger > last) {
      this.opts.store.save(page.latestLedger);
    }
    return handled;
  }
}
