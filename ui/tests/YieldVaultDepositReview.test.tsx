/**
 * Issue #454: a vault deposit must pass through a review step before the
 * SDK's `deposit` is called.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { YieldVaultCard } from '@/components/YieldVaultCard';
import { useYieldVault } from '../src/hooks/useYieldVault';
import { useTxStatus } from '../src/hooks/useTxStatus';

jest.mock('../src/hooks/useYieldVault', () => ({ useYieldVault: jest.fn() }));
jest.mock('../src/hooks/useTxStatus', () => ({ useTxStatus: jest.fn() }));

const mockUseYieldVault = useYieldVault as unknown as jest.Mock;
const mockUseTxStatus = useTxStatus as unknown as jest.Mock;

const VAULT = 'GVAULTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const USER = 'GUSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

let deposit: jest.Mock;

beforeEach(() => {
  deposit = jest.fn(async () => ({ hash: 'abc123', success: true }));

  mockUseYieldVault.mockReturnValue({
    vaultInfo: {
      name: 'Alpha Vault',
      tokenA: 'GTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      tokenB: 'GTOKENBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      poolId: 'POOL',
      strategyId: 1,
      feeRate: 100,
      harvestFee: 0,
      withdrawalFee: 0,
    },
    vaultMetrics: {
      totalShares: 1000n,
      totalAmountA: 0n,
      totalAmountB: 0n,
      apy: 800,
      tvl: 1_000_000n,
      lastHarvest: 0,
    },
    userPosition: {
      shares: 0n,
      lastHarvest: 0,
      depositedAmountA: 0n,
      depositedAmountB: 0n,
    },
    isPaused: false,
    loading: false,
    error: null,
    metricsLoading: false,
    positionLoading: false,
    metricsError: null,
    positionError: null,
    refresh: jest.fn(),
    deposit,
    withdraw: jest.fn(),
    harvest: jest.fn(),
    walletAddress: USER,
    walletConnected: true,
    connecting: false,
    connect: jest.fn(),
    disconnect: jest.fn(),
  });

  mockUseTxStatus.mockReturnValue({
    txStatus: 'idle',
    txHash: null,
    txError: null,
    runTx: jest.fn(async (action: () => Promise<unknown>) => {
      await action();
    }),
    resetTx: jest.fn(),
    setTxStatus: jest.fn(),
    setTxHash: jest.fn(),
    setTxError: jest.fn(),
  });
});

async function enterDeposit(user: ReturnType<typeof userEvent.setup>, a = '1000', b = '2000') {
  const [inputA, inputB] = screen.getAllByPlaceholderText('0');
  await user.type(inputA, a);
  await user.type(inputB, b);
}

describe('YieldVaultCard deposit review', () => {
  it('does not deposit until the review is confirmed', async () => {
    const user = userEvent.setup();
    render(<YieldVaultCard vaultAddress={VAULT} userAddress={USER} />);

    await enterDeposit(user);
    await user.click(screen.getByRole('button', { name: /review deposit/i }));

    expect(deposit).not.toHaveBeenCalled();
    const review = screen.getByRole('region', { name: /deposit review/i });
    expect(within(review).getByText('Alpha Vault')).toBeInTheDocument();
    expect(within(review).getByText(/^1000/)).toBeInTheDocument();
    expect(within(review).getByText(/^2000/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /confirm deposit/i }));

    expect(deposit).toHaveBeenCalledTimes(1);
    expect(deposit).toHaveBeenCalledWith(1000n, 2000n, 0n);
  });

  it('returns to the form without depositing when the user goes back', async () => {
    const user = userEvent.setup();
    render(<YieldVaultCard vaultAddress={VAULT} userAddress={USER} />);

    await enterDeposit(user);
    await user.click(screen.getByRole('button', { name: /review deposit/i }));
    await user.click(screen.getByRole('button', { name: /^back$/i }));

    expect(deposit).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: /deposit review/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review deposit/i })).toBeInTheDocument();
  });

  it('explains an invalid amount instead of opening the review', async () => {
    const user = userEvent.setup();
    render(<YieldVaultCard vaultAddress={VAULT} userAddress={USER} />);

    await enterDeposit(user, '0', '2000');
    await user.click(screen.getByRole('button', { name: /review deposit/i }));

    expect(deposit).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('region', { name: /deposit review/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/token a must be greater than zero/i);
  });
});
