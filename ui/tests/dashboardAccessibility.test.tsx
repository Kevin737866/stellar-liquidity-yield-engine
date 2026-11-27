import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dashboard } from '@/components/Dashboard';
import { SkipLink } from '@/components/SkipLink';

describe('dashboard accessibility structure', () => {
  it('provides a skip link that targets the main content region', () => {
    render(
      <>
        <SkipLink />
        <Dashboard />
      </>,
    );

    const skipLink = screen.getByRole('link', { name: /skip to main content/i });
    expect(skipLink).toHaveAttribute('href', '#main-content');

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('exposes banner, navigation, main, and contentinfo landmarks', () => {
    render(<Dashboard />);

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
  });

  it('lets keyboard users move between vaults and select one', async () => {
    const user = userEvent.setup();
    render(<Dashboard />);

    const vaultRows = screen
      .getAllByRole('row')
      .filter((row) => row.hasAttribute('tabindex'));
    expect(vaultRows).toHaveLength(3);

    // One tab stop, on the currently selected vault.
    expect(vaultRows[0]).toHaveAttribute('tabindex', '0');
    expect(vaultRows[1]).toHaveAttribute('tabindex', '-1');

    vaultRows[0].focus();
    await user.keyboard('{ArrowDown}');
    expect(vaultRows[1]).toHaveFocus();
    expect(vaultRows[1]).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('XLM / EURC');

    await user.keyboard('{End}');
    expect(vaultRows[2]).toHaveFocus();
    expect(vaultRows[2]).toHaveAttribute('aria-current', 'true');

    await user.keyboard('{Home}{ArrowUp}');
    expect(vaultRows[0]).toHaveFocus();
    expect(vaultRows[0]).toHaveAttribute('aria-current', 'true');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(vaultRows[1]).toHaveAttribute('aria-current', 'true');
    expect(vaultRows[0]).not.toHaveAttribute('aria-current');
  });

  it('labels the page heading and data regions', () => {
    render(<Dashboard />);

    expect(
      screen.getByRole('heading', { level: 1, name: /liquidity overview/i }),
    ).toBeInTheDocument();

    expect(
      screen.getByRole('table', { name: /active liquidity positions/i }),
    ).toBeInTheDocument();

    const progressBars = screen.getAllByRole('progressbar');
    expect(progressBars).toHaveLength(4);
    for (const progressBar of progressBars) {
      expect(progressBar).toHaveAccessibleName();
      expect(progressBar).toHaveAttribute('aria-valuenow');
    }
  });
});
