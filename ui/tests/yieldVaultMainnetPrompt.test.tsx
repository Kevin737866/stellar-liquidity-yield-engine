import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { YieldVaultCard } from '@/components/YieldVaultCard';

const mockDeposit = jest.fn().mockResolvedValue({ hash: 'abc123', success: true });
const mockWithdraw = jest.fn().mockResolvedValue({ hash: 'def456', success: true });
const mockHarvest = jest.fn().mockResolvedValue({ hash: 'ghi789', success: true });
const mockResetTx = jest.fn();

jest.mock('../src/hooks/useYieldVault', () => ({
  useYieldVault: () => ({
    vaultInfo: { name: 'Test Vault', feeRate: 0 },
    vaultMetrics: { apy: 0, tvl: 0, totalShares: 0n },
    userPosition: { shares: 10n },
    isPaused: false,
    loading: false,
    error: null,
    metricsLoading: false,
    positionLoading: false,
    metricsError: null,
    positionError: null,
    refresh: jest.fn(),
    deposit: mockDeposit,
    withdraw: mockWithdraw,
    harvest: mockHarvest,
    walletAddress: 'GCUSTOMADDRESS',
    walletConnected: true,
    connecting: false,
    connect: jest.fn(),
    disconnect: jest.fn(),
  }),
}));

jest.mock('../src/hooks/useTxStatus', () => ({
  useTxStatus: () => ({
    txStatus: 'idle',
    txHash: null,
    txError: null,
    setTxStatus: jest.fn(),
    setTxHash: jest.fn(),
    setTxError: jest.fn(),
    runTx: async (action: () => Promise<unknown>) => {
      await action();
    },
    resetTx: mockResetTx,
  }),
}));

async function enterDepositAmounts(user: ReturnType<typeof userEvent.setup>) {
  const amounts = screen.getAllByPlaceholderText('0');
  await user.type(amounts[0], '10');
  await user.type(amounts[1], '20');
}

describe('YieldVaultCard mainnet prompt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeposit.mockResolvedValue({ hash: 'abc123', success: true });
  });

  it('submits testnet deposits immediately', async () => {
    const user = userEvent.setup();
    render(<YieldVaultCard vaultAddress="VAULT" userAddress="USER" network="testnet" />);

    await enterDepositAmounts(user);
    await user.click(screen.getByRole('button', { name: 'Deposit' }));

    await waitFor(() => expect(mockDeposit).toHaveBeenCalledWith(10n, 20n, 0n));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('prompts before a mainnet deposit and cancels without submitting', async () => {
    const user = userEvent.setup();
    render(<YieldVaultCard vaultAddress="VAULT" userAddress="USER" network="mainnet" />);

    await enterDepositAmounts(user);
    await user.click(screen.getByRole('button', { name: 'Deposit' }));

    expect(screen.getByRole('dialog')).toHaveTextContent(/about to deposit on/i);
    expect(mockDeposit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mockDeposit).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('runs the deposit only after the mainnet switch is confirmed', async () => {
    const user = userEvent.setup();
    const onNetworkChange = jest.fn().mockResolvedValue(undefined);
    render(
      <YieldVaultCard
        vaultAddress="VAULT"
        userAddress="USER"
        network="mainnet"
        onNetworkChange={onNetworkChange}
      />
    );

    await enterDepositAmounts(user);
    await user.click(screen.getByRole('button', { name: 'Deposit' }));
    await user.click(screen.getByTestId('confirm-network-switch'));

    await waitFor(() => expect(onNetworkChange).toHaveBeenCalledWith('mainnet'));
    await waitFor(() => expect(mockDeposit).toHaveBeenCalledWith(10n, 20n, 0n));
  });

  it('prompts when mainnet comes from NEXT_PUBLIC_STELLAR_NETWORK', async () => {
    const previous = process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = 'mainnet';
    const user = userEvent.setup();

    try {
      render(<YieldVaultCard vaultAddress="VAULT" userAddress="USER" />);
      await enterDepositAmounts(user);
      await user.click(screen.getByRole('button', { name: 'Deposit' }));

      expect(screen.getByRole('dialog')).toHaveTextContent(/about to deposit on/i);
      expect(mockDeposit).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
      else process.env.NEXT_PUBLIC_STELLAR_NETWORK = previous;
    }
  });

  it('shows switch failures and leaves the deposit unsubmitted', async () => {
    const user = userEvent.setup();
    const onNetworkChange = jest.fn().mockRejectedValue(new Error('wallet locked'));
    render(
      <YieldVaultCard
        vaultAddress="VAULT"
        userAddress="USER"
        network="mainnet"
        onNetworkChange={onNetworkChange}
      />
    );

    await enterDepositAmounts(user);
    await user.click(screen.getByRole('button', { name: 'Deposit' }));
    await user.click(screen.getByTestId('confirm-network-switch'));

    expect(
      await within(screen.getByRole('dialog')).findByRole('alert')
    ).toHaveTextContent(/wallet locked/);
    expect(mockDeposit).not.toHaveBeenCalled();
  });
});
