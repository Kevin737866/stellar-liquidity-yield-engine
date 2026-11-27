import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

function Harness() {
  const [value, setValue] = useState('alpha');
  return (
    <RadioGroup value={value} onValueChange={setValue} aria-label="Strategy">
      <RadioGroupItem value="alpha">Alpha</RadioGroupItem>
      <RadioGroupItem value="beta">Beta</RadioGroupItem>
      <RadioGroupItem value="gamma">Gamma</RadioGroupItem>
    </RadioGroup>
  );
}

describe('radio group keyboard navigation', () => {
  it('moves focus and selection with arrow, Home, and End keys', () => {
    render(<Harness />);

    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    const beta = screen.getByRole('radio', { name: 'Beta' });
    const gamma = screen.getByRole('radio', { name: 'Gamma' });

    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowDown' });

    expect(beta).toHaveFocus();
    expect(beta).toHaveAttribute('aria-checked', 'true');
    expect(alpha).toHaveAttribute('aria-checked', 'false');

    fireEvent.keyDown(beta, { key: 'End' });
    expect(gamma).toHaveFocus();
    expect(gamma).toHaveAttribute('aria-checked', 'true');

    // Arrow keys wrap around the group.
    fireEvent.keyDown(gamma, { key: 'ArrowRight' });
    expect(alpha).toHaveFocus();
    expect(alpha).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    expect(gamma).toHaveFocus();
    expect(gamma).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(gamma, { key: 'Home' });
    expect(alpha).toHaveFocus();
    expect(alpha).toHaveAttribute('aria-checked', 'true');
  });

  it('exposes one tab stop while a value is selected', () => {
    render(<Harness />);

    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('radio', { name: 'Gamma' })).toHaveAttribute('tabindex', '-1');
  });

  it('ignores keys that are not navigation keys', () => {
    render(<Harness />);

    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'a' });

    expect(alpha).toHaveFocus();
    expect(alpha).toHaveAttribute('aria-checked', 'true');
  });
});
