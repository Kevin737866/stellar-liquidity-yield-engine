import {
  checkRpcLag,
  classifyLag,
  computeLedgerLag,
  formatLagMessage,
  RpcLagMonitor,
  RpcLagReport,
  DEFAULT_WARNING_LEDGERS,
  DEFAULT_CRITICAL_LEDGERS,
  LEDGER_CLOSE_TIME_SECONDS,
} from './rpcSync';

/** A ledger head source that returns a fixed head, or a queue of heads. */
function headSource(...sequences: number[]) {
  let call = 0;
  return {
    calls: () => call,
    getLatestLedger: async () => {
      const sequence = sequences[Math.min(call, sequences.length - 1)];
      call += 1;
      return { sequence };
    },
  };
}

describe('computeLedgerLag', () => {
  it('reports the gap between the processed ledger and the head', () => {
    expect(computeLedgerLag(1000, 1012)).toBe(12);
  });

  it('clamps at zero when the local ledger is at or ahead of the head', () => {
    expect(computeLedgerLag(1000, 1000)).toBe(0);
    expect(computeLedgerLag(1005, 1000)).toBe(0);
  });

  it('rejects non-finite sequences instead of returning NaN', () => {
    expect(() => computeLedgerLag(Number.NaN, 10)).toThrow(/finite/);
    expect(() => computeLedgerLag(10, Infinity)).toThrow(/finite/);
  });
});

describe('classifyLag', () => {
  it('uses the documented defaults', () => {
    expect(DEFAULT_WARNING_LEDGERS).toBe(5);
    expect(DEFAULT_CRITICAL_LEDGERS).toBe(20);
  });

  it('classifies below the warning threshold as ok', () => {
    expect(classifyLag(0)).toBe('ok');
    expect(classifyLag(4)).toBe('ok');
  });

  it('classifies at or above the warning threshold as warning', () => {
    expect(classifyLag(5)).toBe('warning');
    expect(classifyLag(19)).toBe('warning');
  });

  it('classifies at or above the critical threshold as critical', () => {
    expect(classifyLag(20)).toBe('critical');
    expect(classifyLag(500)).toBe('critical');
  });

  it('honours custom thresholds', () => {
    expect(classifyLag(3, { warningLedgers: 2, criticalLedgers: 10 })).toBe('warning');
    expect(classifyLag(10, { warningLedgers: 2, criticalLedgers: 10 })).toBe('critical');
  });

  it('rejects a critical threshold below the warning threshold', () => {
    expect(() => classifyLag(1, { warningLedgers: 10, criticalLedgers: 2 })).toThrow(
      /criticalLedgers/,
    );
  });

  it('rejects negative thresholds', () => {
    expect(() => classifyLag(1, { warningLedgers: -1 })).toThrow(/non-negative/);
  });
});

describe('checkRpcLag', () => {
  it('produces a report carrying both ledgers and the estimated wall-clock lag', async () => {
    const report = await checkRpcLag(headSource(1012), 1000, { now: () => 12345 });

    expect(report.processedLedger).toBe(1000);
    expect(report.headLedger).toBe(1012);
    expect(report.lagLedgers).toBe(12);
    expect(report.lagSeconds).toBe(12 * LEDGER_CLOSE_TIME_SECONDS);
    expect(report.severity).toBe('warning');
    expect(report.checkedAt).toBe(12345);
  });

  it('flags a noticeably-behind node as warning and a badly-behind node as critical', async () => {
    const warning = await checkRpcLag(headSource(1006), 1000);
    const critical = await checkRpcLag(headSource(1100), 1000);

    expect(warning.severity).toBe('warning');
    expect(critical.severity).toBe('critical');
  });

  it('reports ok when the local ledger is current', async () => {
    const report = await checkRpcLag(headSource(1000), 1000);
    expect(report.severity).toBe('ok');
    expect(report.lagLedgers).toBe(0);
  });

  it('names the node as behind in the message, with both ledger values', async () => {
    const report = await checkRpcLag(headSource(1006), 1000);
    expect(report.message).toMatch(/noticeably behind/);
    expect(report.message).toContain('processed=1000');
    expect(report.message).toContain('head=1006');
  });
});

describe('formatLagMessage', () => {
  const base = {
    processedLedger: 10,
    headLedger: 15,
    lagLedgers: 5,
    lagSeconds: 25,
    checkedAt: 0,
  };

  it('summarises an ok report without alarm language', () => {
    const message = formatLagMessage({ ...base, lagLedgers: 0, severity: 'ok' });
    expect(message).toMatch(/within tolerance/);
    expect(message).not.toMatch(/critically/);
  });

  it('escalates the wording for critical', () => {
    expect(formatLagMessage({ ...base, severity: 'critical' })).toMatch(/critically behind/);
  });
});

describe('RpcLagMonitor', () => {
  it('starts at zero and records the highest processed ledger seen', () => {
    const monitor = new RpcLagMonitor(headSource(1));

    expect(monitor.getProcessedLedger()).toBe(0);
    monitor.recordProcessedLedger(100);
    monitor.recordProcessedLedger(90); // must not move backwards
    monitor.recordProcessedLedger(120);

    expect(monitor.getProcessedLedger()).toBe(120);
  });

  it('warns through the handler only when the node is behind', async () => {
    const warnings: RpcLagReport[] = [];
    const monitor = new RpcLagMonitor(headSource(1004, 1030), {}, (r) => warnings.push(r));

    monitor.recordProcessedLedger(1000);
    const ok = await monitor.check();
    const warning = await monitor.check();

    expect(ok.severity).toBe('ok');
    expect(warning.severity).toBe('critical');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].lagLedgers).toBe(30);
  });

  it('does not warn when the head is behind the local ledger', async () => {
    const warnings: RpcLagReport[] = [];
    const monitor = new RpcLagMonitor(headSource(900), {}, (r) => warnings.push(r));

    monitor.recordProcessedLedger(1000);
    const report = await monitor.check();

    expect(report.severity).toBe('ok');
    expect(warnings).toHaveLength(0);
  });

  it('rejects a non-finite processed ledger', () => {
    const monitor = new RpcLagMonitor(headSource(1));
    expect(() => monitor.recordProcessedLedger(Number.NaN)).toThrow(/finite/);
  });
});
