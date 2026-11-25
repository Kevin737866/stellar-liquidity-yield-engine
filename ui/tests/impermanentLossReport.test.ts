import { formatIlPercent, formatPriceRatio, parsePriceRatioList } from '@/lib/impermanentLossReport';

describe('parsePriceRatioList', () => {
  it('parses comma-separated positive ratios', () => {
    expect(parsePriceRatioList('4, 1,0.5')).toEqual({
      values: [4, 1, 0.5],
      invalidEntries: [],
    });
  });

  it('ignores blank entries', () => {
    expect(parsePriceRatioList('')).toEqual({ values: [], invalidEntries: [] });
    expect(parsePriceRatioList(' , 2 , ')).toEqual({ values: [2], invalidEntries: [] });
  });

  it('reports non-numeric, zero, negative, and non-finite entries', () => {
    expect(parsePriceRatioList('abc, 0, -1, Infinity, 2')).toEqual({
      values: [2],
      invalidEntries: ['abc', '0', '-1', 'Infinity'],
    });
  });
});

describe('impermanent loss formatting', () => {
  it('formats finite values with two decimal places', () => {
    expect(formatIlPercent(-20)).toBe('-20.00%');
    expect(formatPriceRatio(1.234)).toBe('1.23');
  });

  it('does not render non-finite values as numbers', () => {
    expect(formatIlPercent(Number.NaN)).toBe('Unavailable');
    expect(formatPriceRatio(Number.POSITIVE_INFINITY)).toBe('Unavailable');
  });
});
