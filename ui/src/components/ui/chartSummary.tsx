import type { ChartSummaryData } from '@/lib/chartSummary';

interface ChartSummaryProps {
  summary: ChartSummaryData;
  announce?: boolean;
  className?: string;
}

export function ChartSummary({ summary, announce = false, className }: ChartSummaryProps) {
  return (
    <div className={className}>
      <p className="text-sm text-slate-600" aria-live={announce ? 'polite' : undefined}>
        {summary.accessibleLabel}
      </p>
      <table className="sr-only">
        <caption>{summary.tableCaption}</caption>
        <thead>
          <tr>
            {summary.headers.map((header) => (
              <th key={header} scope="col">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {summary.rows.map((row, rowIndex) => (
            <tr key={`${row.category}-${rowIndex}`}>
              <th scope="row">{row.category}</th>
              {row.cells.map((cell, cellIndex) => (
                <td key={`${row.category}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
