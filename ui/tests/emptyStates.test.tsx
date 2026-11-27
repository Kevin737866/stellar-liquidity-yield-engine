import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dashboard } from '@/components/Dashboard';
import { EmptyState } from '@/components/EmptyState';
import { RewardDashboard } from '@/components/RewardDashboard';
import { YieldVaultCard } from '@/components/YieldVaultCard';

// react-icons is not an installed dependency of the UI package; stub the icons used by RewardDashboard.
jest.mock(
  'react-icons/fa',
  () =>
    new Proxy(
      {},
      {
        get: (_target, name) =>
          name === '__esModule' ? true : (props: Record<string, unknown>) => <svg data-icon={String(name)} {...props} />,
      },
    ),
  { virtual: true },
);

// recharts needs ResizeObserver, which jsdom lacks; the chart itself is not under test.
jest.mock('recharts', () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Stub,
    PieChart: Stub,
    Pie: Stub,
    Cell: () => null,
    Tooltip: () => null,
    Legend: () => null,
  };
});

const mockUseYieldVault = jest.fn();
jest.mock('@/hooks/useYieldVault', () => ({
  useYieldVault: (...args: unknown[]) => mockUseYieldVault(...args),
}));
jest.mock('@/hooks/useTxStatus', () => ({
  useTxStatus: () => ({
    txStatus: 'idle',
    txHash: null,
    txError: null,
    runTx: jest.fn(),
    resetTx: jest.fn(),
  }),
}));
jest.mock('@/lib/freighter', () => ({ shortenAddress: (a: string) => a }));

const rewardProps = {
  user: 'GUSER',
  vault: 'CVAULT',
  rewardStreams: [],
  onClaim: jest.fn(),
  onSetAutoCompound: jest.fn(),
  onClaimAndConvert: jest.fn(),
  onEmergencyWithdraw: jest.fn(),
  horizonServer: {},
  networkPassphrase: 'Test',
};
const oneReward = {
  token: 'CUSDC',
  tokenSymbol: 'USDC',
  amount: '100',
  amountNormalized: 100,
  usdValue: 100,
  priceUsd: 1,
};

const hookState = (overrides: Record<string, unknown> = {}) => ({
  vaultInfo: null,
  vaultMetrics: null,
  userPosition: null,
  isPaused: false,
  loading: false,
  error: null,
  metricsLoading: false,
  positionLoading: false,
  metricsError: null,
  positionError: null,
  refresh: jest.fn(),
  deposit: jest.fn(),
  withdraw: jest.fn(),
  harvest: jest.fn(),
  walletAddress: null,
  walletConnected: false,
  connecting: false,
  connect: jest.fn(),
  disconnect: jest.fn(),
  ...overrides,
});

describe('EmptyState', () => {
  it('announces an empty state politely and hides the decorative icon', () => {
    render(<EmptyState title="Nothing here" description="Add one." icon={<svg data-testid="icon" />} />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Nothing here');
    expect(screen.getByTestId('icon').parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('announces a failure as an alert and calls the retry handler', async () => {
    const onAction = jest.fn();
    render(<EmptyState variant="error" title="Failed" description="Network down" actionLabel="Retry now" onAction={onAction} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Network down');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('shows no retry button when no handler is given', () => {
    render(<EmptyState variant="error" title="Failed" actionLabel="Retry now" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('Dashboard positions panel', () => {
  it('normal: shows the table and no empty state with default data', () => {
    render(<Dashboard />);
    expect(screen.getByRole('table', { name: /active liquidity positions/i })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('boundary: undefined positions keep the default data', () => {
    render(<Dashboard positions={undefined} />);
    expect(screen.getByRole('table', { name: /active liquidity positions/i })).toBeInTheDocument();
  });

  it('boundary: an empty array shows the empty state instead of the table', () => {
    render(<Dashboard positions={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent(/no active positions/i);
    expect(screen.queryByRole('table', { name: /active liquidity positions/i })).not.toBeInTheDocument();
  });

  it('boundary: no empty state while loading', () => {
    render(<Dashboard positions={[]} positionsLoading />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading positions/i);
    expect(screen.queryByText(/no active positions/i)).not.toBeInTheDocument();
  });

  it('failure: shows an alert with the message and retries on click', async () => {
    const onRetry = jest.fn();
    render(<Dashboard positions={[]} positionsError="RPC timeout" onRetryPositions={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('RPC timeout');
    await userEvent.setup().click(screen.getByRole('button', { name: /retry loading positions/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('failure: omits the retry button when no handler is given', () => {
    render(<Dashboard positionsError="RPC timeout" />);
    expect(screen.getByRole('alert')).toHaveTextContent('RPC timeout');
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});

describe('RewardDashboard rewards panel', () => {
  it('normal: lists rewards with no empty or error state', () => {
    render(<RewardDashboard {...rewardProps} pendingRewards={[oneReward]} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['an empty array', []],
    ['undefined', undefined],
  ])('boundary: %s shows the empty state', (_label, pendingRewards) => {
    render(<RewardDashboard {...rewardProps} pendingRewards={pendingRewards} />);
    expect(screen.getByRole('status')).toHaveTextContent(/no pending rewards/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('boundary: no empty state while loading', () => {
    render(<RewardDashboard {...rewardProps} pendingRewards={[]} rewardsLoading />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading rewards/i);
    expect(screen.queryByText(/no pending rewards/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('failure: shows an alert with the message and retries on click', async () => {
    const onRetryRewards = jest.fn();
    render(
      <RewardDashboard {...rewardProps} pendingRewards={[]} rewardsError="Horizon unreachable" onRetryRewards={onRetryRewards} />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Horizon unreachable');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /retry loading rewards/i }));
    expect(onRetryRewards).toHaveBeenCalledTimes(1);
  });

  it('failure: omits the retry button when no handler is given', () => {
    render(<RewardDashboard {...rewardProps} pendingRewards={[]} rewardsError="Horizon unreachable" />);
    expect(screen.queryByRole('button', { name: /retry loading rewards/i })).not.toBeInTheDocument();
  });
});

describe('YieldVaultCard vault panel', () => {
  beforeEach(() => mockUseYieldVault.mockReset());

  it('boundary: an empty vault address shows the empty state', () => {
    mockUseYieldVault.mockReturnValue(hookState());
    render(<YieldVaultCard vaultAddress="" userAddress="GUSER" />);
    expect(screen.getByRole('status')).toHaveTextContent(/no vault selected/i);
  });

  it('failure: a failed load shows an alert and retry calls refresh', async () => {
    const refresh = jest.fn();
    mockUseYieldVault.mockReturnValue(hookState({ error: 'RPC down', refresh }));
    render(<YieldVaultCard vaultAddress="CVAULT" userAddress="GUSER" />);

    expect(screen.getByRole('alert')).toHaveTextContent('RPC down');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('normal: loaded vault data shows no empty state', () => {
    mockUseYieldVault.mockReturnValue(
      hookState({
        vaultInfo: { feeRate: 100 },
        vaultMetrics: { apy: 500, tvl: 5000000n, totalShares: 1000n },
      }),
    );
    render(<YieldVaultCard vaultAddress="CVAULT" userAddress="GUSER" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
