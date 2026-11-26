import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { YieldVaultCard } from '@/components/YieldVaultCard';
import { useYieldVault } from '@/hooks/useYieldVault';
import { useTxStatus } from '@/hooks/useTxStatus';
import VotingPanel from '@/components/VotingPanel';
import StakingModal from '@/components/StakingModal';
import { ProposalState } from '../../sdk/src/governance';

// Mock useYieldVault to control wallet state and contract interaction callbacks
jest.mock('@/hooks/useYieldVault', () => ({
  useYieldVault: jest.fn(),
}));

const mockedUseYieldVault = useYieldVault as jest.MockedFunction<typeof useYieldVault>;

interface MockYieldVaultOptions {
  walletConnected?: boolean;
  walletAddress?: string | null;
  depositMock?: jest.Mock;
  withdrawMock?: jest.Mock;
  harvestMock?: jest.Mock;
  connectMock?: jest.Mock;
  disconnectMock?: jest.Mock;
  refreshMock?: jest.Mock;
  isPaused?: boolean;
  userShares?: bigint;
}

function createYieldVaultMock(options: MockYieldVaultOptions = {}) {
  const {
    walletConnected = true,
    walletAddress = 'GBOJEST001WALLETADDRESS777777777777777777777777777777777777',
    depositMock = jest.fn().mockResolvedValue({ hash: '0xabc123', success: true }),
    withdrawMock = jest.fn().mockResolvedValue({ hash: '0xdef456', success: true }),
    harvestMock = jest.fn().mockResolvedValue({ hash: '0x789ghi', success: true }),
    connectMock = jest.fn().mockResolvedValue('GBOJEST001WALLETADDRESS777777777777777777777777777777777777'),
    disconnectMock = jest.fn(),
    refreshMock = jest.fn().mockResolvedValue(undefined),
    isPaused = false,
    userShares = 5000n,
  } = options;

  return {
    vaultInfo: {
      name: 'USDC-XLM Yield Vault',
      feeRate: 30,
      paused: isPaused,
      tokenA: 'USDC',
      tokenB: 'XLM',
      totalShares: 1000000n,
    },
    vaultMetrics: {
      apy: 1450, // 14.50%
      tvl: 4500000000000n, // $4.5M
      totalShares: 1000000n,
    },
    userPosition: {
      shares: userShares,
    },
    isPaused,
    loading: false,
    error: null,
    metricsLoading: false,
    positionLoading: false,
    metricsError: null,
    positionError: null,
    refresh: refreshMock,
    deposit: depositMock,
    withdraw: withdrawMock,
    harvest: harvestMock,
    walletAddress,
    walletConnected,
    connecting: false,
    connect: connectMock,
    disconnect: disconnectMock,
  };
}

describe('UI component tests for wallet disconnection during submission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('YieldVaultCard - Wallet disconnection and flight guarding', () => {
    it('guards the disconnect button and inputs while a deposit submission is in flight', async () => {
      let resolveDeposit: (value: any) => void = () => {};
      const pendingDepositPromise = new Promise((resolve) => {
        resolveDeposit = resolve;
      });
      const depositMock = jest.fn().mockReturnValue(pendingDepositPromise);

      mockedUseYieldVault.mockReturnValue(
        createYieldVaultMock({ depositMock }) as any
      );

      const user = userEvent.setup();
      render(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress="GBOJEST001WALLETADDRESS777777777777777777777777777777777777"
        />
      );

      const disconnectBtn = screen.getByRole('button', { name: /disconnect/i });
      expect(disconnectBtn).toBeEnabled();

      const inputA = screen.getByLabelText('Token A Amount');
      const inputB = screen.getByLabelText('Token B Amount');
      const depositBtn = screen.getByRole('button', { name: /^deposit$/i });

      await user.type(inputA, '150');
      await user.type(inputB, '300');
      await user.click(depositBtn);

      // Submission is in flight
      expect(depositMock).toHaveBeenCalledWith(150n, 300n, 0n);
      expect(screen.getByText(/processing…/i)).toBeInTheDocument();
      expect(depositBtn).toBeDisabled();
      expect(inputA).toBeDisabled();
      expect(inputB).toBeDisabled();

      // Crucial: Disconnect control is disabled to guard against race conditions during flight
      expect(disconnectBtn).toBeDisabled();

      // Resolve flight
      await act(async () => {
        resolveDeposit({ hash: '0x123', success: true });
      });

      await waitFor(() => {
        expect(screen.getByText(/transaction confirmed/i)).toBeInTheDocument();
      });
      expect(disconnectBtn).toBeEnabled();
    });

    it('handles wallet disconnection during deposit submission and preserves user input', async () => {
      const disconnectionError = new Error('Wallet disconnected during transaction submission');
      const depositMock = jest.fn().mockRejectedValue(disconnectionError);

      mockedUseYieldVault.mockReturnValue(
        createYieldVaultMock({ depositMock }) as any
      );

      const user = userEvent.setup();
      const { rerender } = render(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress="GBOJEST001WALLETADDRESS777777777777777777777777777777777777"
        />
      );

      const inputA = screen.getByLabelText('Token A Amount');
      const inputB = screen.getByLabelText('Token B Amount');
      const depositBtn = screen.getByRole('button', { name: /^deposit$/i });

      await user.type(inputA, '250');
      await user.type(inputB, '500');
      await user.click(depositBtn);

      // Verify the component captured the disconnection error
      await waitFor(() => {
        expect(
          screen.getByText(/wallet disconnected during transaction submission/i)
        ).toBeInTheDocument();
      });

      // Form values are preserved so the user does not lose their typed amounts
      expect(inputA).toHaveValue(250);
      expect(inputB).toHaveValue(500);

      // Submission flight state is cleared
      expect(screen.queryByText(/processing…/i)).not.toBeInTheDocument();

      // Simulate hook reporting disconnected state post-disconnection
      mockedUseYieldVault.mockReturnValue(
        createYieldVaultMock({
          walletConnected: false,
          walletAddress: null,
          depositMock,
        }) as any
      );

      rerender(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress=""
        />
      );

      // Connect button is rendered in place of Disconnect button
      expect(screen.getByRole('button', { name: /connect freighter/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();

      // Deposit button is disabled because wallet is not connected
      expect(screen.getByRole('button', { name: /^deposit$/i })).toBeDisabled();
      expect(
        screen.getByText(/connect freighter wallet or configure a keypair to deposit funds/i)
      ).toBeInTheDocument();

      // Dismiss the error banner
      const dismissBtn = screen.getByRole('button', { name: /dismiss/i });
      await user.click(dismissBtn);
      expect(
        screen.queryByText(/wallet disconnected during transaction submission/i)
      ).not.toBeInTheDocument();
    });

    it('handles wallet disconnection during withdraw submission', async () => {
      const disconnectionError = new Error('Freighter wallet disconnected during withdrawal');
      const withdrawMock = jest.fn().mockRejectedValue(disconnectionError);

      mockedUseYieldVault.mockReturnValue(
        createYieldVaultMock({ withdrawMock, userShares: 1000n }) as any
      );

      const user = userEvent.setup();
      render(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress="GBOJEST001WALLETADDRESS777777777777777777777777777777777777"
        />
      );

      const sharesInput = screen.getByLabelText('Shares to Withdraw');
      const withdrawBtn = screen.getByRole('button', { name: /^withdraw$/i });

      await user.type(sharesInput, '200');
      await user.click(withdrawBtn);

      await waitFor(() => {
        expect(
          screen.getByText(/freighter wallet disconnected during withdrawal/i)
        ).toBeInTheDocument();
      });

      // Entered shares are preserved
      expect(sharesInput).toHaveValue(200);
      expect(screen.queryByText(/processing…/i)).not.toBeInTheDocument();
    });

    it('handles wallet disconnection during harvest rewards submission', async () => {
      const disconnectionError = new Error('Wallet connection dropped while signing harvest transaction');
      const harvestMock = jest.fn().mockRejectedValue(disconnectionError);

      mockedUseYieldVault.mockReturnValue(
        createYieldVaultMock({ harvestMock }) as any
      );

      const user = userEvent.setup();
      render(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress="GBOJEST001WALLETADDRESS777777777777777777777777777777777777"
        />
      );

      const harvestBtn = screen.getByRole('button', { name: /harvest rewards/i });
      await user.click(harvestBtn);

      await waitFor(() => {
        expect(
          screen.getByText(/wallet connection dropped while signing harvest transaction/i)
        ).toBeInTheDocument();
      });

      // Flight is reset
      expect(screen.queryByText(/processing…/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /harvest rewards/i })).toBeInTheDocument();
    });

    it('retains transaction hash when wallet disconnects during confirmation phase', async () => {
      const depositMock = jest.fn().mockResolvedValue({
        hash: '0x998877665544332211aabbccddeeff',
        success: false,
        error: 'Wallet disconnected while awaiting ledger confirmation',
      });

      mockedUseYieldVault.mockReturnValue(
        createYieldVaultMock({ depositMock }) as any
      );

      const user = userEvent.setup();
      render(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress="GBOJEST001WALLETADDRESS777777777777777777777777777777777777"
        />
      );

      const inputA = screen.getByLabelText('Token A Amount');
      const inputB = screen.getByLabelText('Token B Amount');
      const depositBtn = screen.getByRole('button', { name: /^deposit$/i });

      await user.type(inputA, '100');
      await user.type(inputB, '100');
      await user.click(depositBtn);

      await waitFor(() => {
        expect(
          screen.getByText(/wallet disconnected while awaiting ledger confirmation/i)
        ).toBeInTheDocument();
      });

      // Truncated hash remains visible so operators can inspect on-chain status
      expect(screen.getByTitle('0x998877665544332211aabbccddeeff')).toBeInTheDocument();
    });

    it('disables submission actions and prompts for connection when wallet starts disconnected', () => {
      mockedUseYieldVault.mockReturnValue(
        createYieldVaultMock({
          walletConnected: false,
          walletAddress: null,
        }) as any
      );

      render(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress=""
        />
      );

      expect(screen.getByRole('button', { name: /^deposit$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /^withdraw$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /harvest rewards/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /connect freighter/i })).toBeEnabled();
    });

    it('enables seamless re-submission after wallet reconnects', async () => {
      const depositMock = jest
        .fn()
        .mockRejectedValueOnce(new Error('Wallet disconnected'))
        .mockResolvedValueOnce({ hash: '0xfinalhash', success: true });

      mockedUseYieldVault.mockReturnValue(
        createYieldVaultMock({ depositMock }) as any
      );

      const user = userEvent.setup();
      const { rerender } = render(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress="GBOJEST001WALLETADDRESS777777777777777777777777777777777777"
        />
      );

      const inputA = screen.getByLabelText('Token A Amount');
      const inputB = screen.getByLabelText('Token B Amount');
      const depositBtn = screen.getByRole('button', { name: /^deposit$/i });

      await user.type(inputA, '75');
      await user.type(inputB, '150');
      await user.click(depositBtn);

      await waitFor(() => {
        expect(screen.getByText(/wallet disconnected/i)).toBeInTheDocument();
      });

      // Dismiss failure banner
      await user.click(screen.getByRole('button', { name: /dismiss/i }));

      // Simulate wallet reconnection while keeping form inputs populated
      rerender(
        <YieldVaultCard
          vaultAddress="CA_VAULT_TEST_ADDRESS"
          userAddress="GBOJEST001WALLETADDRESS777777777777777777777777777777777777"
        />
      );

      expect(inputA).toHaveValue(75);
      expect(inputB).toHaveValue(150);
      expect(depositBtn).toBeEnabled();

      // Retry submission succeeds
      await user.click(depositBtn);
      await waitFor(() => {
        expect(screen.getByText(/transaction confirmed/i)).toBeInTheDocument();
      });
      expect(depositMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('useTxStatus hook - Lifecycle failure transitions on wallet disconnection', () => {
    function TestTxHarness({ action }: { action: () => Promise<any> }) {
      const { txStatus, txHash, txError, runTx, resetTx } = useTxStatus();

      return (
        <div>
          <span data-testid="status">{txStatus}</span>
          <span data-testid="hash">{txHash ?? ''}</span>
          <span data-testid="error">{txError ?? ''}</span>
          <button onClick={() => runTx(action)}>Submit</button>
          <button onClick={resetTx}>Reset</button>
        </div>
      );
    }

    it('transitions from submitting to failed when an in-flight wallet action throws', async () => {
      const user = userEvent.setup();
      const throwingAction = jest.fn().mockRejectedValue(new Error('Freighter session terminated'));

      render(<TestTxHarness action={throwingAction} />);

      expect(screen.getByTestId('status')).toHaveTextContent('idle');
      await user.click(screen.getByRole('button', { name: /submit/i }));

      await waitFor(() => {
        expect(screen.getByTestId('status')).toHaveTextContent('failed');
      });
      expect(screen.getByTestId('error')).toHaveTextContent('Freighter session terminated');

      await user.click(screen.getByRole('button', { name: /reset/i }));
      expect(screen.getByTestId('status')).toHaveTextContent('idle');
      expect(screen.getByTestId('error')).toHaveTextContent('');
    });
  });

  describe('VotingPanel & StakingModal - Disconnection resilience', () => {
    const mockProposal = {
      id: 42,
      proposer: 'GBOJEST001PROPOSER777777777777777777777777777777777777',
      description: 'Upgrade dynamic liquidity reallocation parameters',
      callData: [],
      votesFor: 50000n,
      votesAgainst: 10000n,
      eta: 0,
      startTime: Math.floor(Date.now() / 1000) - 3600,
      endTime: Math.floor(Date.now() / 1000) + 86400,
      snapshotBlock: 100,
      state: ProposalState.Active,
      forVoters: {},
      againstVoters: {},
      quorumReached: true,
      passed: true,
    };

    it('VotingPanel recovers from wallet disconnection during vote submission without locking UI', async () => {
      const user = userEvent.setup();
      const onVoteMock = jest.fn().mockRejectedValue(new Error('Wallet disconnected during vote'));

      render(
        <VotingPanel
          proposal={mockProposal as any}
          userAddress="GBOJEST001VOTER77777777777777777777777777777777777777"
          userVotingPower={1000n}
          totalSupply={1000000n}
          hasVoted={false}
          votedFor={null}
          onVote={onVoteMock}
          onClose={jest.fn()}
        />
      );

      // Select 'Vote For'
      const voteForBtn = screen.getByRole('button', { name: /vote for/i });
      await user.click(voteForBtn);

      const submitVoteBtn = screen.getByRole('button', { name: /submit for vote/i });
      await user.click(submitVoteBtn);

      // Flight should complete and revert from "Submitting..." back to actionable state
      await waitFor(() => {
        expect(onVoteMock).toHaveBeenCalled();
      });
      expect(screen.queryByText(/submitting\.\.\./i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /submit for vote/i })).toBeEnabled();
    });

    it('StakingModal recovers from wallet disconnection during lock creation without losing entered amount', async () => {
      const user = userEvent.setup();
      const onCreateLockMock = jest.fn().mockRejectedValue(new Error('Wallet disconnected during lock creation'));

      render(
        <StakingModal
          isOpen={true}
          onClose={jest.fn()}
          tokenBalance={10000n}
          onCreateLock={onCreateLockMock}
          onIncreaseLock={jest.fn()}
          onExtendLock={jest.fn()}
          onWithdraw={jest.fn()}
        />
      );

      const amountInput = screen.getByPlaceholderText('0.00');
      await user.type(amountInput, '500');

      const createLockBtn = screen.getByRole('button', { name: /create lock/i });
      await user.click(createLockBtn);

      await waitFor(() => {
        expect(onCreateLockMock).toHaveBeenCalled();
      });

      // Submit state is reset and entered amount is preserved
      expect(screen.queryByText(/processing\.\.\./i)).not.toBeInTheDocument();
      expect(amountInput).toHaveValue('500');
      expect(screen.getByRole('button', { name: /create lock/i })).toBeEnabled();
    });
  });
});
