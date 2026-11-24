import { isTimestampInDateRange } from '@/lib/dateRange';

describe('isTimestampInDateRange', () => {
  it('includes both selected calendar dates and the full end date', () => {
    const start = new Date(2026, 0, 2, 0, 0).getTime();
    const end = new Date(2026, 0, 3, 23, 59, 59, 999).getTime();

    expect(
      isTimestampInDateRange(start, { startDate: '2026-01-02', endDate: '2026-01-03' }),
    ).toBe(true);
    expect(
      isTimestampInDateRange(end, { startDate: '2026-01-02', endDate: '2026-01-03' }),
    ).toBe(true);
    expect(
      isTimestampInDateRange(new Date(2026, 0, 4).getTime(), {
        startDate: '2026-01-02',
        endDate: '2026-01-03',
      }),
    ).toBe(false);
  });

  it('supports open-ended ranges and rejects invalid or reversed dates', () => {
    expect(isTimestampInDateRange('2026-01-02 12:00', { startDate: '2026-01-02' })).toBe(true);
    expect(isTimestampInDateRange('not a date', {})).toBe(false);
    expect(
      isTimestampInDateRange('2026-01-02', {
        startDate: '2026-01-03',
        endDate: '2026-01-01',
      }),
    ).toBe(false);
  });
});
