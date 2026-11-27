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

const NAVIGATION_KEYS = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];

export function RadioGroup({
  name,
  value,
  onValueChange,
  className,
  children,
  onKeyDown,
  ...props
}: RadioGroupProps) {
  const generatedName = React.useId();
  const groupName = name ?? generatedName;
  const groupRef = React.useRef<HTMLDivElement>(null);

  /**
   * Roving focus for the radio group.
   *
   * A radio group is one tab stop, but arrow keys move the selection between
   * its options (WAI-ARIA radio group pattern). Selection follows focus, so
   * the caller's `onValueChange` runs on the same key press that moves focus.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (!NAVIGATION_KEYS.includes(event.key)) return;

    const items = Array.from(
      groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;

    const current = (event.target as HTMLElement).closest<HTMLElement>('[role="radio"]');
    const index = current ? items.indexOf(current as HTMLButtonElement) : -1;

    let nextIndex: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        nextIndex = index < 0 ? 0 : (index + 1) % items.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIndex = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      default: // End
        nextIndex = items.length - 1;
        break;
    }

    event.preventDefault();
    const next = items[nextIndex];
    next.focus();
    const nextValue = next.dataset.value;
    if (nextValue !== undefined) onValueChange?.(nextValue);
  };

  return (
    <RadioGroupContext.Provider value={{ name: groupName, value, onValueChange }}>
      <div
        ref={groupRef}
        role="radiogroup"
        className={['grid gap-2', className].filter(Boolean).join(' ')}
        onKeyDown={handleKeyDown}
        {...props}
      >
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
        data-value={value}
        // One tab stop per group: the checked option, or every option while
        // nothing is selected yet (the first one becomes the entry point).
        tabIndex={props.tabIndex ?? (checked || context?.value === undefined ? 0 : -1)}
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
