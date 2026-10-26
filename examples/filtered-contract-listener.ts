/**
 * Example: Address-filtered contract event listener
 *
 * Operators running multiple contracts against a single Soroban RPC endpoint
 * are often flooded with events from unrelated contracts. This example shows
 * how to use `ContractEventListener` to restrict event delivery to only the
 * contracts you care about, dramatically reducing log noise.
 *
 * ## What this demonstrates
 *
 * 1. Creating a listener scoped to two specific vault addresses.
 * 2. Registering typed handlers for vault, rebalance, and reward events.
 * 3. Registering a raw (catch-all) handler for custom / unknown event types.
 * 4. Wiring up an error handler so network hiccups are logged, not silently swallowed.
 * 5. Graceful start / stop lifecycle.
 *
 * ## Running
 *
 * ```bash
 * # Set the vault addresses you want to watch (comma-separated contract IDs)
 * export VAULT_ADDRESSES="CAAAA...,CBBBB..."
 * # Optionally point at a real RPC node (default: testnet)
 * export SOROBAN_RPC_URL="https://soroban-testnet.stellar.org"
 *
 * npx ts-node examples/filtered-contract-listener.ts
 * ```
 *
 * If VAULT_ADDRESSES is not set, the example runs in "watch all" mode and
 * logs every contract event from the network — useful for discovery but
 * noisy in production.
 */

import { SorobanRpc } from 'stellar-sdk';
import {
  ContractEventListener,
  type ListenerConfig,
  type FilteredVaultEvent,
  type FilteredRebalanceEvent,
  type FilteredRewardEvent,
  type UnknownContractEvent,
  type ListenerErrorEvent,
} from '../sdk/src/eventListener';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

/**
 * Comma-separated list of contract addresses to watch.
 * Leave empty (or unset) to watch ALL contracts — useful for first-time
 * discovery, but produces a lot of log output in production.
 */
const RAW_ADDRESSES = process.env.VAULT_ADDRESSES ?? '';
const CONTRACT_ADDRESSES: string[] = RAW_ADDRESSES
  ? RAW_ADDRESSES.split(',').map((a) => a.trim()).filter(Boolean)
  : [];

/**
 * How often (ms) to poll the RPC for new events.
 * Stellar closes a ledger ~every 5 s; polling faster is unnecessary.
 */
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10);

// ---------------------------------------------------------------------------
// Structured logging for skipped / aborted actions
// ---------------------------------------------------------------------------

/**
 * Log an action that was attempted but never submitted to the chain.
 * Each entry carries enough context (action, contract, reason, ledger) to
 * debug why a decision never reached the chain.
 */
function logSkippedAction(action: string, details: Record<string, unknown>): void {
  console.warn(`[SKIPPED] action=${action} ${JSON.stringify(details)}`);
}

// ---------------------------------------------------------------------------
// Set up the RPC server and listener
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const server = new SorobanRpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });

  // Discover the current ledger so we only see *new* events from this point
  // forward. For a replay use case, replace this with a stored checkpoint.
  const { sequence: startLedger } = await server.getLatestLedger();

  const config: ListenerConfig = {
    startLedger,
    /**
     * ✅ The core feature: restrict the listener to these contract addresses.
     *    Events from any other contract are silently discarded both at the RPC
     *    layer (fewer bytes over the wire) and again in the SDK layer as a
     *    belt-and-suspenders check.
     *
     *    If CONTRACT_ADDRESSES is empty the listener operates in pass-all mode.
     */
    contractAddresses: CONTRACT_ADDRESSES.length > 0 ? CONTRACT_ADDRESSES : undefined,
    pageSize: 200,
  };

  const listener = new ContractEventListener(server, config);

  // -------------------------------------------------------------------------
  // Register typed event handlers
  // -------------------------------------------------------------------------

  // --- Vault events (deposit / withdraw / harvest / pause / unpause) -------

  listener.on('deposit', (evt: FilteredVaultEvent) => {
    console.log(`[DEPOSIT]  contract=${evt.contractId}  ts=${evt.timestamp}`, evt.data ?? '');
  });

  listener.on('withdraw', (evt: FilteredVaultEvent) => {
    console.log(`[WITHDRAW] contract=${evt.contractId}  ts=${evt.timestamp}`, evt.data ?? '');
  });

  listener.on('harvest', (evt: FilteredVaultEvent) => {
    console.log(`[HARVEST]  contract=${evt.contractId}  ts=${evt.timestamp}`, evt.data ?? '');
  });

  listener.on('pause', (evt: FilteredVaultEvent) => {
    console.warn(`[PAUSE ⚠️] contract=${evt.contractId}  ts=${evt.timestamp}`);
  });

  listener.on('unpause', (evt: FilteredVaultEvent) => {
    console.log(`[UNPAUSE]  contract=${evt.contractId}  ts=${evt.timestamp}`);
  });

  // --- Rebalance events (proposal / execution / failure) -------------------

  listener.on('proposal', (evt: FilteredRebalanceEvent) => {
    console.log(`[PROPOSAL] contract=${evt.contractId}  strategy=${evt.strategy}`, evt.data ?? '');
  });

  listener.on('execution', (evt: FilteredRebalanceEvent) => {
    console.log(`[EXECUTE]  contract=${evt.contractId}  strategy=${evt.strategy}`, evt.data ?? '');
  });

  listener.on('failure', (evt: FilteredRebalanceEvent) => {
    console.error(`[FAILURE ❌] contract=${evt.contractId}  strategy=${evt.strategy}`, evt.data ?? '');
  });

  // --- Reward events (distribution / claim / expiry) -----------------------

  listener.on('distribution', (evt: FilteredRewardEvent) => {
    console.log(`[DISTRIB]  contract=${evt.contractId}  ts=${evt.timestamp}`, evt.data ?? '');
  });

  listener.on('claim', (evt: FilteredRewardEvent) => {
    console.log(`[CLAIM]    contract=${evt.contractId}  ts=${evt.timestamp}`, evt.data ?? '');
  });

  listener.on('expiry', (evt: FilteredRewardEvent) => {
    console.warn(`[EXPIRY ⚠️] contract=${evt.contractId}  ts=${evt.timestamp}`);
  });

  // -------------------------------------------------------------------------
  // Raw (catch-all) handler — useful for custom / protocol-specific events
  // -------------------------------------------------------------------------

  listener.onRaw((evt: UnknownContractEvent) => {
    // This fires for *every* event that passes the address filter, including
    // the ones already handled above. Use it to forward to a message bus,
    // write to a DB, or debug unknown event shapes.
    const topicStr = Array.isArray(evt.topic) ? evt.topic[0] : '?';
    // Only log truly unknown event shapes here to avoid double-printing known ones.
    const known = [
      'deposit','withdraw','harvest','pause','unpause',
      'proposal','execution','failure',
      'distribution','claim','expiry',
    ];
    if (!known.includes(String(topicStr))) {
      console.log(`[UNKNOWN]  contract=${evt.contractId}  topic[0]=${topicStr}  ledger=${evt.ledger}`);
    }

    // Example: an unknown event shape may indicate an action we chose not to
    // submit. Log it with structured context so it can be traced later.
    if (!known.includes(String(topicStr))) {
      logSkippedAction('unknown-event', {
        contractId: evt.contractId,
        topic: topicStr,
        ledger: evt.ledger,
      });
    }
  });

  // -------------------------------------------------------------------------
  // Error handler — keeps the loop running even when the RPC is flaky
  // -------------------------------------------------------------------------

  listener.onError((err: ListenerErrorEvent) => {
    console.error(
      `[ERROR] poll failed at ledger ${err.ledger}: ${err.error.message}`,
    );
    logSkippedAction('poll-error', {
      ledger: err.ledger,
      reason: err.error.message,
    });
    // The listener does NOT stop itself on error; the next poll will retry
    // automatically. Add alerting logic here if needed.
  });

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  const filterSummary =
    CONTRACT_ADDRESSES.length > 0
      ? `filtering to ${CONTRACT_ADDRESSES.length} contract(s): ${CONTRACT_ADDRESSES.join(', ')}`
      : 'watching ALL contracts (no address filter)';

  console.log(`\n🔭  Starting filtered event listener`);
  console.log(`    RPC:      ${RPC_URL}`);
  console.log(`    Ledger:   starting from ${startLedger}`);
  console.log(`    Filter:   ${filterSummary}`);
  console.log(`    Interval: ${POLL_INTERVAL_MS} ms\n`);

  // Log interpretation guide:
  //   [SKIPPED] action=<name> {...}  — an action was attempted but not submitted.
  //     - action=unknown-event: event shape not recognized; inspect topic/ledger.
  //     - action=poll-error:    RPC poll failed; reason contains the error message.
  //   [ERROR] poll failed at ledger N: ...  — raw poll failure (see SKIPPED above).
  //   [UNKNOWN] contract=... topic[0]=... ledger=...  — unrecognized event shape.
  console.log('    Log guide: [SKIPPED] = attempted-but-not-submitted; [ERROR] = poll failure; [UNKNOWN] = unrecognized event\n');

  listener.start(POLL_INTERVAL_MS);

  // -------------------------------------------------------------------------
  // Graceful shutdown on SIGINT / SIGTERM
  // -------------------------------------------------------------------------

  function shutdown(signal: string): void {
    console.log(`\nReceived ${signal}, shutting down listener…`);
    listener.stop();
    console.log(`Stopped at ledger ${listener.currentLedger}`);
    process.exit(0);
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// ---------------------------------------------------------------------------
// Entrypoint guard — prevents accidental execution when imported as a module
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

export { main };
