'use client';

import * as React from 'react';

interface RadioGroupContextValue {
  name: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

const RadioGroupContext = React.createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  name?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

export function RadioGroup({
  name,
  value,
  onValueChange,
  className,
  children,
  ...props
}: RadioGroupProps) {
  const generatedName = React.useId();
  const groupName = name ?? generatedName;

  return (
    <RadioGroupContext.Provider value={{ name: groupName, value, onValueChange }}>
      <div role="radiogroup" className={['grid gap-2', className].filter(Boolean).join(' ')} {...props}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

export interface RadioGroupItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'onChange'> {
  value: string;
}

export const RadioGroupItem = React.forwardRef<HTMLButtonElement, RadioGroupItemProps>(
  ({ value, className, children, onClick, ...props }, ref) => {
    const context = React.useContext(RadioGroupContext);
    const checked = context?.value === value;

    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={checked}
        data-state={checked ? 'checked' : 'unchecked'}
        className={[
          'inline-flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm',
          checked ? 'border-slate-900 bg-slate-50' : 'border-slate-300 bg-white',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) context?.onValueChange?.(value);
        }}
        {...props}
      >
        <span
          aria-hidden="true"
          className={[
            'flex h-4 w-4 items-center justify-center rounded-full border',
            checked ? 'border-slate-900' : 'border-slate-400',
          ].join(' ')}
        >
          {checked ? <span className="h-2 w-2 rounded-full bg-slate-900" /> : null}
        </span>
        {children ?? value}
      </button>
    );
  },
);
RadioGroupItem.displayName = 'RadioGroupItem';
