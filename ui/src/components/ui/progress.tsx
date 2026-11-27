import * as React from 'react';

export interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  max?: number;
  label?: string;
}

export function Progress({ value = 0, max = 100, label, className, ...props }: ProgressProps) {
  const safeMax = max > 0 ? max : 100;
  const clamped = Math.min(Math.max(value, 0), safeMax);
  const percent = Math.round((clamped / safeMax) * 100);

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={clamped}
      aria-valuetext={label ? `${label}: ${percent}%` : `${percent}%`}
      aria-label={label}
      className={['h-2 w-full overflow-hidden rounded-full bg-slate-200', className]
        .filter(Boolean)
        .join(' ')}
      {...props}
    >
      <div className="h-full bg-slate-900 transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}
