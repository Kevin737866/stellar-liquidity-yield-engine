import { render, screen, within } from '@testing-library/react';
import { ChartSummary } from '@/components/ui/chartSummary';
import { buildChartSummary } from '@/lib/chartSummary';

describe('buildChartSummary', () => {
  it('summarizes finite values and marks invalid values as unavailable', () => {
    const summary = buildChartSummary({
      title: 'Net APY by day',
      categoryLabel: 'Day',
      categories: ['Mon', 'Tue', 'Wed'],
      series: [
        {
          label: 'Net APY',
          values: [6.8, 7.1, Number.NaN],
          format: (value) => `${value.toFixed(1)}%`,
        },
      ],
    });

    expect(summary.headers).toEqual(['Day', 'Net APY']);
    expect(summary.rows).toEqual([
      { category: 'Mon', cells: ['6.8%'] },
      { category: 'Tue', cells: ['7.1%'] },
      { category: 'Wed', cells: ['Unavailable'] },
    ]);
    expect(summary.accessibleLabel).toContain('6.8% at Mon');
    expect(summary.accessibleLabel).toContain('increased to 7.1% at Tue');
    expect(summary.accessibleLabel).toContain('range 6.8% to 7.1%');
    expect(summary.accessibleLabel).not.toContain('NaN');
  });

  it('handles an empty dataset without inventing a trend', () => {
    const summary = buildChartSummary({
      title: 'Empty chart',
      categoryLabel: 'Day',
      categories: [],
      series: [{ label: 'Value', values: [] }],
    });

    expect(summary.accessibleLabel).toBe('Empty chart. No data available.');
    expect(summary.rows).toEqual([]);
  });

  it('reports a single valid point without a direction', () => {
    const summary = buildChartSummary({
      title: 'Single point',
      categoryLabel: 'Day',
      categories: ['Mon', 'Tue'],
      series: [{ label: 'Value', values: [5, null] }],
    });

    expect(summary.accessibleLabel).toBe('Single point. Value: 5.00 at Mon.');
    expect(summary.rows[1].cells).toEqual(['Unavailable']);
  });

  it('reports a series with no valid values', () => {
    const summary = buildChartSummary({
      title: 'Invalid chart',
      categoryLabel: 'Day',
      categories: ['Mon', 'Tue'],
      series: [{ label: 'Value', values: [Number.NaN, Number.POSITIVE_INFINITY] }],
    });

    expect(summary.accessibleLabel).toContain('Value: no valid values.');
    expect(summary.rows.every((row) => row.cells[0] === 'Unavailable')).toBe(true);
  });
});

describe('ChartSummary', () => {
  const summary = buildChartSummary({
    title: 'Net APY by day',
    categoryLabel: 'Day',
    categories: ['Mon', 'Tue'],
    series: [
      {
        label: 'Net APY',
        values: [6.8, Number.NaN],
        format: (value) => `${value.toFixed(1)}%`,
      },
    ],
  });

  it('renders a visible text summary and an equivalent data table', () => {
    render(<ChartSummary summary={summary} />);

    expect(screen.getByText(summary.accessibleLabel)).toBeInTheDocument();

    const table = screen.getByRole('table', { name: /net apy by day data/i });
    expect(within(table).getByRole('columnheader', { name: 'Day' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Net APY' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Mon' })).toBeInTheDocument();
    expect(within(table).getByText('6.8%')).toBeInTheDocument();
    expect(within(table).getByText('Unavailable')).toBeInTheDocument();
  });

  it('can announce summary updates politely', () => {
    render(<ChartSummary summary={summary} announce />);

    expect(screen.getByText(summary.accessibleLabel)).toHaveAttribute('aria-live', 'polite');
  });
});
