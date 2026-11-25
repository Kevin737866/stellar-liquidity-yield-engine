export type ChartSummaryFormat = (value: number) => string;

export interface ChartSeriesInput {
  label: string;
  values: Array<number | null | undefined>;
  format?: ChartSummaryFormat;
}

export interface ChartSummaryInput {
  title: string;
  categoryLabel: string;
  categories: Array<string | number>;
  series: ChartSeriesInput[];
}

export interface ChartSummaryRow {
  category: string;
  cells: string[];
}

export interface ChartSummaryData {
  accessibleLabel: string;
  tableCaption: string;
  headers: string[];
  rows: ChartSummaryRow[];
}

const UNAVAILABLE = 'Unavailable';

function isValidValue(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatValue(value: number, format?: ChartSummaryFormat): string {
  return (format ?? ((input: number) => input.toFixed(2)))(value);
}

function describeSeries(
  series: ChartSeriesInput,
  categories: Array<string | number>,
): string {
  const points = categories
    .map((category, index) => ({ category: String(category), value: series.values[index] }))
    .filter((point): point is { category: string; value: number } => isValidValue(point.value));

  if (points.length === 0) {
    return `${series.label}: no valid values.`;
  }

  const format = (value: number) => formatValue(value, series.format);
  if (points.length === 1) {
    return `${series.label}: ${format(points[0].value)} at ${points[0].category}.`;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const direction =
    first.value === last.value ? 'was unchanged' : last.value > first.value ? 'increased' : 'decreased';
  const values = points.map((point) => point.value);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);

  return `${series.label}: ${format(first.value)} at ${first.category}, ${direction} to ${format(last.value)} at ${last.category}; range ${format(minimum)} to ${format(maximum)}.`;
}

export function buildChartSummary(input: ChartSummaryInput): ChartSummaryData {
  const { title, categoryLabel, categories, series } = input;
  const headers = [categoryLabel, ...series.map((item) => item.label)];
  const rows = categories.map((category, index) => ({
    category: String(category),
    cells: series.map((item) => {
      const value = item.values[index];
      return isValidValue(value) ? formatValue(value, item.format) : UNAVAILABLE;
    }),
  }));

  const descriptions = series.map((item) => describeSeries(item, categories));
  const accessibleLabel = rows.length === 0
    ? `${title}. No data available.`
    : `${title}. ${descriptions.join(' ')}`.trim();

  return {
    accessibleLabel,
    tableCaption: `${title} data`,
    headers,
    rows,
  };
}
