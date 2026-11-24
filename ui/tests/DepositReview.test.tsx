import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DepositReview } from '@/components/DepositReview';
import { parseDepositAmount, validateDepositAmounts } from '@/lib/depositReview';

const baseProps = {
  vaultName: 'Alpha Vault',
  vaultAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
  network: 'testnet',
  walletAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
  amountA: '1000',
  amountB: '2000',
  minShares: 0n,
  feeRateBps: 100,
  paused: false,
  submitting: false,
  onConfirm: jest.fn(),
  onBack: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DepositReview', () => {
  it('shows the deposit details and waits for confirmation', () => {
    render(<DepositReview {...baseProps} />);

    const review = screen.getByRole('region', { name: /deposit review/i });
    expect(review).toBeInTheDocument();
    expect(screen.getByText('Alpha Vault')).toBeInTheDocument();
    expect(screen.getByText('testnet')).toBeInTheDocument();
    expect(screen.getByText(/^1000/)).toBeInTheDocument();
    expect(screen.getByText(/^2000/)).toBeInTheDocument();
    expect(screen.getByText('1.00%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm deposit/i })).toBeEnabled();
    // Nothing has been submitted yet.
    expect(baseProps.onConfirm).not.toHaveBeenCalled();
  });

  it('reports the missing slippage floor', () => {
    render(<DepositReview {...baseProps} />);

    expect(screen.getByText(/no minimum shares are set/i)).toBeInTheDocument();
  });

  it('confirms and cancels through the callbacks', async () => {
    const user = userEvent.setup();
    render(<DepositReview {...baseProps} />);

    await user.click(screen.getByRole('button', { name: /confirm deposit/i }));
    expect(baseProps.onConfirm).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /^back$/i }));
    expect(baseProps.onBack).toHaveBeenCalledTimes(1);
  });

  it('blocks confirmation while the vault is paused', () => {
    render(<DepositReview {...baseProps} paused />);

    expect(screen.getByRole('alert')).toHaveTextContent(/vault is paused/i);
    expect(screen.getByRole('button', { name: /confirm deposit/i })).toBeDisabled();
  });

  it('blocks confirmation while a transaction is in flight', () => {
    render(<DepositReview {...baseProps} submitting />);

    expect(screen.getByRole('button', { name: /processing/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDisabled();
  });
});

describe('deposit amount validation', () => {
  it('accepts positive whole base-unit amounts', () => {
    const result = validateDepositAmounts('1000', '002000');

    expect(result.ok).toBe(true);
    expect(result.amountA).toBe(1000n);
    expect(result.amountB).toBe(2000n);
    expect(result.errors).toEqual([]);
  });

  it.each([
    ['', /enter a token a amount/i],
    ['0', /greater than zero/i],
    ['1.5', /whole number/i],
    ['-10', /whole number/i],
    ['1e6', /whole number/i],
  ])('rejects %p', (input, message) => {
    const result = parseDepositAmount(input, 'Token A');

    expect(result.ok).toBe(false);
    expect(result.value).toBe(0n);
    expect(result.error).toMatch(message);
  });

  it('collects the error for both sides of the deposit', () => {
    const result = validateDepositAmounts('', '0');

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});
