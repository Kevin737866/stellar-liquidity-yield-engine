import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransactionHistory } from '@/components/TransactionHistory';
import { sampleTransactions } from '@/lib/sampleTransactions';

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
