import { render, screen } from '@testing-library/react';
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
