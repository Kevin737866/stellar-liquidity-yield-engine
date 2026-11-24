import * as React from 'react';
import { Button } from '@/components/ui/button';

export interface EmptyStateProps {
  /** `empty` is announced politely (role="status"); `error` is announced at once (role="alert"). */
  variant?: 'empty' | 'error';
  title: string;
  description?: string;
  /** Decorative icon. It is hidden from assistive technology. */
  icon?: React.ReactNode;
  /** Label for the optional action button. The button renders only when `onAction` is set. */
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  variant = 'empty',
  title,
  description,
  icon,
  actionLabel,
  onAction,
  className,
}) => {
  const isError = variant === 'error';
  const tone = isError
    ? 'border-red-200 bg-red-50 text-red-800'
    : 'border-slate-200 bg-slate-50 text-slate-600';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-testid={isError ? 'error-state' : 'empty-state'}
      className={['flex flex-col items-center gap-2 rounded-lg border p-6 text-center', tone, className]
        .filter(Boolean)
        .join(' ')}
    >
      {icon ? (
        <span aria-hidden="true" className="text-3xl">
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-semibold">{title}</p>
      {description ? <p className="text-xs">{description}</p> : null}
      {onAction ? (
        <Button size="sm" variant="outline" onClick={onAction} className="mt-2">
          {actionLabel ?? 'Retry'}
        </Button>
      ) : null}
    </div>
  );
};

export default EmptyState;
