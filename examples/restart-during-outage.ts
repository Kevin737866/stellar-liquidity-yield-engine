/**
 * Example: a keeper that survives an extended outage
 *
 * This example walks a keeper through the exact scenario the recovery support
 * was built for:
 *
 * 1. The keeper starts, consumes events and checkpoints its position.
 * 2. The process dies. The chain keeps moving — a lot.
 * 3. A brand-new process starts with the same checkpoint file.
 * 4. The new process resumes at the ledger the old one left off, catches up
 *    on everything that happened while it was down, and repeats nothing.
 *
 * The chain is simulated in memory so the example is deterministic and needs
 * no network access.
 *
 * ## Running
 *
 * ```bash
 * npx ts-node examples/restart-during-outage.ts
 * ```
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ContractEventListener,
  type EventSource,
  type GetEventsRequest,
  type GetEventsResponse,
  type RawContractEvent,
} from '../sdk/src/eventListener';
import { FileCheckpointStore } from '../sdk/src/persistence';
import { RpcLagMonitor } from '../sdk/src/rpcSync';

const VAULT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

/**
 * A deterministic in-memory chain. Events are appended ledger by ledger and
 * served from `startLedger` up, capped by `limit` — the same paging contract
 * the Soroban RPC offers.
 */
class SimulatedChain {
  head = 0;
  private readonly events: RawContractEvent[] = [];

  append(ledger: number): void {
    this.events.push({
      contractId: VAULT,
      ledger,
      ledgerClosedAt: new Date(ledger * 5_000).toISOString(),
      topic: ['deposit'],
      value: { ledger },
      id: `${VAULT}-${ledger}`,
    });
    this.head = Math.max(this.head, ledger);
  }

  appendRange(fromLedger: number, count: number): void {
    for (let i = 0; i < count; i += 1) {
      this.append(fromLedger + i);
    }
  }

  source(): EventSource {
    return {
      getEvents: async (request: GetEventsRequest): Promise<GetEventsResponse> => {
        const limit = request.limit ?? 200;
        return {
          events: this.events.filter((e) => e.ledger >= request.startLedger).slice(0, limit),
          latestLedger: this.head,
        };
      },
    };
  }
}

function section(title: string): void {
  console.log(`\n${'─'.repeat(64)}\n${title}\n${'─'.repeat(64)}`);
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keeper-outage-'));
  const checkpointFile = path.join(dir, 'keeper.json');

  try {
    const chain = new SimulatedChain();

    // -----------------------------------------------------------------------
    // 1. The keeper is running normally.
    // -----------------------------------------------------------------------
    section('1. Keeper running (before the outage)');
    chain.appendRange(1_000, 5);
    console.log(`Chain head: ${chain.head}`);

    const before = new ContractEventListener(chain.source(), {
      startLedger: 1_000,
      store: new FileCheckpointStore(checkpointFile),
    });

    const beforeLedgers: number[] = [];
    before.onRaw((event) => beforeLedgers.push(event.ledger));
    await before.poll();

    console.log(`Handled ledgers: ${beforeLedgers.join(', ')}`);
    console.log(`Cursor: ${before.currentLedger}`);
    console.log(`Checkpoint on disk: ${JSON.stringify(
      JSON.parse(await fs.readFile(checkpointFile, 'utf8')),
    )}`);

    // -----------------------------------------------------------------------
    // 2. The process dies while the chain keeps moving.
    // -----------------------------------------------------------------------
    section('2. Outage — the process is gone, the chain is not');
    before.stop();

    const outageLedgers = 20;
    chain.appendRange(1_005, outageLedgers);
    console.log(`${outageLedgers} more ledgers happened during the outage.`);
    console.log(`Chain head is now: ${chain.head}`);

    // -----------------------------------------------------------------------
    // 3. A fresh process comes back with the same checkpoint file.
    // -----------------------------------------------------------------------
    section('3. Restart — a brand-new process reads the checkpoint');
    const restarted = new ContractEventListener(chain.source(), {
      // The configured start ledger is only a fallback: the checkpoint wins.
      startLedger: 1_000,
      store: new FileCheckpointStore(checkpointFile),
    });

    const monitor = new RpcLagMonitor(
      { getLatestLedger: async () => ({ sequence: chain.head }) },
      { store: new FileCheckpointStore(path.join(dir, 'lag.json')) },
    );

    const afterLedgers: number[] = [];
    restarted.onRaw((event) => afterLedgers.push(event.ledger));

    await restarted.poll();
    monitor.recordProcessedLedger(restarted.lastProcessedLedger);

    console.log(`Resumed at ledger: ${restarted.resumeLedger}`);
    console.log(`Caught up on ledgers: ${afterLedgers[0]}..${afterLedgers[afterLedgers.length - 1]}`);
    console.log(`Cursor is now: ${restarted.currentLedger}`);
    console.log(`Lag report: ${(await monitor.check()).message}`);

    // -----------------------------------------------------------------------
    // 4. Verify the recovery guarantees.
    // -----------------------------------------------------------------------
    section('4. Recovery check');
    const all = [...beforeLedgers, ...afterLedgers];
    const duplicates = all.length - new Set(all).size;
    const missedBeforeOutage = beforeLedgers.length;
    const caughtUp = afterLedgers.length === outageLedgers;

    console.log(`Events handled before outage : ${missedBeforeOutage}`);
    console.log(`Events caught up after restart: ${afterLedgers.length}`);
    console.log(`Duplicates re-delivered      : ${duplicates}`);
    console.log(`Full backlog drained         : ${caughtUp}`);
    console.log(
      `\n${duplicates === 0 && caughtUp
        ? '✅ Recovery succeeded — the keeper resumed exactly where it left off.'
        : '❌ Recovery failed.'}`,
    );

    if (duplicates !== 0 || !caughtUp) {
      process.exitCode = 1;
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
