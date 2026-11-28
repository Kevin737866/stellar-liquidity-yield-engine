import * as React from 'react';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'outline';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-slate-100 text-slate-800',
  success: 'bg-green-100 text-green-800',
  warning: 'bg-amber-100 text-amber-900',
  danger: 'bg-red-100 text-red-800',
  outline: 'border border-slate-300 text-slate-700',
};

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        variantClasses[variant],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...props}
    />
  );
}
