import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransactionHistory } from '@/components/TransactionHistory';
import { sampleTransactions } from '@/lib/sampleTransactions';
import type { TransactionRecord } from '@/lib/transactionFilters';

describe('TransactionHistory filters', () => {
  it('shows every transaction before filtering', () => {
    render(<TransactionHistory transactions={sampleTransactions} />);

    expect(screen.getByText(/showing 5 of 5 transactions/i)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /filtered transaction history/i });
    expect(within(table).getAllByRole('row')).toHaveLength(6);
  });

  it('filters by status and updates the visible rows', async () => {
    const user = userEvent.setup();
    render(<TransactionHistory transactions={sampleTransactions} />);

    await user.selectOptions(screen.getByLabelText('Status'), 'failed');

    expect(screen.getByText(/showing 1 of 5 transactions/i)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /filtered transaction history/i });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Withdraw')).toBeInTheDocument();
  });

  it('filters by operation and combines it with status', async () => {
    const user = userEvent.setup();
    render(<TransactionHistory transactions={sampleTransactions} />);

    await user.selectOptions(screen.getByLabelText('Operation'), 'deposit');
    expect(screen.getByText(/showing 1 of 5 transactions/i)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'failed');
    expect(screen.getByText(/showing 0 of 5 transactions/i)).toBeInTheDocument();
    expect(
      screen.getByText(/no transactions match the selected filters/i),
    ).toBeInTheDocument();
  });

  it('filters by start and end dates and clears them with the other filters', async () => {
    const user = userEvent.setup();
    render(<TransactionHistory transactions={sampleTransactions} />);

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-11-20' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-11-20' } });

    expect(screen.getByText(/showing 2 of 5 transactions/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear filters/i }));
    expect(screen.getByText(/showing 5 of 5 transactions/i)).toBeInTheDocument();
  });

  it('clears filters when the clear button is used', async () => {
    const user = userEvent.setup();
    render(<TransactionHistory transactions={sampleTransactions} />);

    const clearButton = screen.getByRole('button', { name: /clear filters/i });
    expect(clearButton).toBeDisabled();

    await user.selectOptions(screen.getByLabelText('Status'), 'pending');
    expect(clearButton).toBeEnabled();
    expect(screen.getByText(/showing 1 of 5 transactions/i)).toBeInTheDocument();

    await user.click(clearButton);
    expect(screen.getByText(/showing 5 of 5 transactions/i)).toBeInTheDocument();
    expect(clearButton).toBeDisabled();
  });
});

describe('TransactionHistory confirmation details', () => {
  it('shows the selected vault and pool when details are opened', async () => {
    const user = userEvent.setup();
    render(<TransactionHistory transactions={sampleTransactions} />);

    const toggle = screen.getByRole('button', {
      name: /view confirmation details for deposit on 2026-11-21 14:32/i,
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('group', { name: /transaction confirmation details/i }),
    ).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByRole('group', {
      name: /transaction confirmation details/i,
    });
    expect(within(details).getByText('Vault')).toBeInTheDocument();
    expect(within(details).getByText('Stable Growth Vault')).toBeInTheDocument();
    expect(within(details).getByText('Pool')).toBeInTheDocument();
    expect(within(details).getByText('XLM / USDC')).toBeInTheDocument();
    expect(toggle).toHaveAttribute(
      'aria-controls',
      document.querySelector('[role="group"]')?.parentElement?.id,
    );
  });

  it('collapses the details when the toggle is used again', async () => {
    const user = userEvent.setup();
    render(<TransactionHistory transactions={sampleTransactions} />);

    await user.click(
      screen.getByRole('button', {
        name: /view confirmation details for deposit on 2026-11-21 14:32/i,
      }),
    );
    expect(
      screen.getByRole('group', { name: /transaction confirmation details/i }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: /hide confirmation details for deposit on 2026-11-21 14:32/i,
      }),
    );
    expect(
      screen.queryByRole('group', { name: /transaction confirmation details/i }),
    ).not.toBeInTheDocument();
  });

  it('shows an explicit fallback for records without a vault or pool', async () => {
    const user = userEvent.setup();
    const legacyTransactions: TransactionRecord[] = [
      {
        id: 'legacy',
        status: 'confirmed',
        operation: 'deposit',
        amount: '1,000.00',
        asset: 'USDC',
        timestamp: '2026-01-01 09:00',
      },
    ];

    render(<TransactionHistory transactions={legacyTransactions} />);
    await user.click(screen.getByRole('button', { name: /view confirmation details/i }));

    const details = screen.getByRole('group', {
      name: /transaction confirmation details/i,
    });
    expect(within(details).getAllByText('Not recorded')).toHaveLength(2);
  });

  it('treats blank and malformed values as missing', async () => {
    const user = userEvent.setup();
    const malformedTransactions = [
      {
        id: 'malformed',
        status: 'confirmed',
        operation: 'withdraw',
        amount: '10.00',
        asset: 'XLM',
        timestamp: '2026-01-02 10:00',
        vault: '   ',
        pool: 123,
      },
    ] as unknown as TransactionRecord[];

    render(<TransactionHistory transactions={malformedTransactions} />);
    await user.click(screen.getByRole('button', { name: /view confirmation details/i }));

    const details = screen.getByRole('group', {
      name: /transaction confirmation details/i,
    });
    expect(within(details).getAllByText('Not recorded')).toHaveLength(2);
  });

  it('keeps the details in sync with the active filters', async () => {
    const user = userEvent.setup();
    render(<TransactionHistory transactions={sampleTransactions} />);

    await user.selectOptions(screen.getByLabelText('Operation'), 'rebalance');
    await user.click(screen.getByRole('button', { name: /view confirmation details/i }));

    const details = screen.getByRole('group', {
      name: /transaction confirmation details/i,
    });
    expect(within(details).getByText('Balanced Yield Vault')).toBeInTheDocument();
    expect(within(details).getByText('XLM / EURC')).toBeInTheDocument();
    expect(within(details).queryByText('Stable Growth Vault')).not.toBeInTheDocument();
  });

  it('shows details for only one transaction at a time', async () => {
    const user = userEvent.setup();
    render(<TransactionHistory transactions={sampleTransactions} />);

    await user.click(
      screen.getByRole('button', {
        name: /view confirmation details for deposit on 2026-11-21 14:32/i,
      }),
    );
    await user.click(
      screen.getByRole('button', {
        name: /view confirmation details for harvest on 2026-11-20 09:15/i,
      }),
    );

    const groups = screen.getAllByRole('group', {
      name: /transaction confirmation details/i,
    });
    expect(groups).toHaveLength(1);
    expect(within(groups[0]).getByText('Aqua Incentive Vault')).toBeInTheDocument();
    expect(within(groups[0]).getByText('AQUA / USDC')).toBeInTheDocument();
  });
});
