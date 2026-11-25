'use client';

import * as React from 'react';

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs(component: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error(`${component} must be used inside <Tabs>`);
  return context;
}

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

export function Tabs({
  defaultValue,
  value: controlledValue,
  onValueChange,
  className,
  children,
  ...props
}: TabsProps) {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue ?? '');
  const value = controlledValue ?? uncontrolled;
  const baseId = React.useId();

  const setValue = React.useCallback(
    (next: string) => {
      if (controlledValue === undefined) setUncontrolled(next);
      onValueChange?.(next);
    },
    [controlledValue, onValueChange],
  );

  return (
    <TabsContext.Provider value={{ value, setValue, baseId }}>
      <div className={className} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={['flex gap-1 rounded-md bg-slate-100 p-1', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ value, className, children, onClick, ...props }, ref) => {
    const tabs = useTabs('TabsTrigger');
    const selected = tabs.value === value;

    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        id={`${tabs.baseId}-tab-${value}`}
        aria-selected={selected}
        aria-controls={`${tabs.baseId}-panel-${value}`}
        tabIndex={selected ? 0 : -1}
        data-state={selected ? 'active' : 'inactive'}
        className={[
          'rounded px-3 py-1.5 text-sm font-medium',
          selected ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) tabs.setValue(value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            const list = event.currentTarget.parentElement;
            const triggers = list
              ? Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
              : [];
            const index = triggers.indexOf(event.currentTarget);
            const delta = event.key === 'ArrowRight' ? 1 : -1;
            const next = triggers[(index + delta + triggers.length) % triggers.length];
            next?.focus();
            next?.click();
          }
        }}
        {...props}
      >
        {children}
      </button>
    );
  },
);
TabsTrigger.displayName = 'TabsTrigger';

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ value, className, children, ...props }: TabsContentProps) {
  const tabs = useTabs('TabsContent');
  if (tabs.value !== value) return null;

  return (
    <div
      role="tabpanel"
      id={`${tabs.baseId}-panel-${value}`}
      aria-labelledby={`${tabs.baseId}-tab-${value}`}
      tabIndex={0}
      className={['focus-visible:outline-none', className].filter(Boolean).join(' ')}
      {...props}
    >
      {children}
    </div>
  );
}
