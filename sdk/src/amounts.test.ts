import {
  formatAmount,
  formatVotingPower,
  parseStroops,
  isContractConfigured,
  DEFAULT_TOKEN_DECIMALS,
} from './governance';

describe('parseStroops', () => {
  it('uses 7 decimals for governance tokens by default', () => {
    expect(DEFAULT_TOKEN_DECIMALS).toBe(7);
    expect(parseStroops('1')).toBe(10000000n);
    expect(parseStroops('1.5')).toBe(15000000n);
  });

  it('parses exactly, without the float error the old UI code had', () => {
    // The old `BigInt(Math.floor(parseFloat(x) * 1e7))` loses a stroop here:
    // 1.005 is not representable in binary, so 1.005 * 1e7 floors to
    // 10049999 instead of 10050000.
    expect(parseStroops('1.005')).toBe(10050000n);
    expect(BigInt(Math.floor(parseFloat('1.005') * 1e7))).toBe(10049999n);
  });

  it('keeps full precision for amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    // 1 billion tokens in 7-decimal base units is ~1e19, well past 2^53, so
    // any implementation that routes through `Number` corrupts the value.
    const huge = '1000000000.0000001';
    expect(parseStroops(huge).toString()).toBe('10000000000000001');
    expect(parseStroops(huge) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('honours a non-default token decimals value (18-decimal LP tokens)', () => {
    expect(parseStroops('1.5', 18)).toBe(1500000000000000000n);
    expect(parseStroops('0.000000000000000001', 18)).toBe(1n);
  });

  it('truncates excess fractional digits instead of rounding up', () => {
    expect(parseStroops('1.99999999')).toBe(19999999n);
    expect(parseStroops('1.99999999999999999999', 18)).toBe(1999999999999999999n);
  });

  it('treats empty amount input as zero', () => {
    expect(parseStroops('')).toBe(0n);
    expect(parseStroops('.')).toBe(0n);
    expect(parseStroops(null)).toBe(0n);
    expect(parseStroops(undefined)).toBe(0n);
  });

  it('ignores surrounding whitespace and thousands separators', () => {
    expect(parseStroops('  1,234.5  ')).toBe(12345000000n);
  });

  it('rejects negative and non-numeric input', () => {
    expect(() => parseStroops('-1')).toThrow(/non-negative decimal number/);
    expect(() => parseStroops('abc')).toThrow(/non-negative decimal number/);
    expect(() => parseStroops('1.2.3')).toThrow(/non-negative decimal number/);
    expect(() => parseStroops(NaN)).toThrow(/Cannot parse/);
  });

  it('handles numbers, including exponential notation', () => {
    expect(parseStroops(1)).toBe(10000000n);
    expect(parseStroops(0.5)).toBe(5000000n);
    // String(1e-7) === '1e-7'; the parser expands it instead of failing.
    expect(parseStroops(1e-7)).toBe(1n);
    expect(parseStroops(1e21).toString()).toBe('1' + '0'.repeat(28));
  });
});

describe('formatAmount', () => {
  it('trims trailing fractional zeros', () => {
    expect(formatAmount(10000000n)).toBe('1');
    expect(formatAmount(15000000n)).toBe('1.5');
    expect(formatAmount(10000001n)).toBe('1.0000001');
  });

  it('respects the token decimals argument', () => {
    expect(formatAmount(1500000000000000000n, 18)).toBe('1.5');
    expect(formatAmount(1n, 18)).toBe('0.000000000000000001');
  });

  it('formats negatives', () => {
    expect(formatAmount(-15000000n)).toBe('-1.5');
  });

  it('round-trips with parseStroops', () => {
    const cases: Array<[string, number]> = [
      ['0', 7],
      ['1', 7],
      ['12.3456789', 7],
      ['999999.9999999', 7],
      ['0.000000000000000001', 18],
      ['1234.5678', 18],
    ];

    for (const [raw, decimals] of cases) {
      expect(formatAmount(parseStroops(raw, decimals), decimals)).toBe(raw);
    }
  });

  it('agrees with formatVotingPower, which keeps trailing zeros', () => {
    expect(formatVotingPower(15000000n)).toBe('1.5000000');
    expect(formatAmount(15000000n)).toBe('1.5');
  });
});

describe('isContractConfigured', () => {
  it('rejects empty and placeholder IDs', () => {
    expect(isContractConfigured('')).toBe(false);
    expect(isContractConfigured(undefined)).toBe(false);
    expect(isContractConfigured(null)).toBe(false);
    expect(isContractConfigured('UNCONFIGURED')).toBe(false);
  });

  it('accepts a real contract ID', () => {
    expect(
      isContractConfigured('CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE')
    ).toBe(true);
  });
});
