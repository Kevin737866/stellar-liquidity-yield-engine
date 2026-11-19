import { Keypair, Networks } from 'stellar-sdk';
import {
  MAX_SLIPPAGE_BPS,
  RewardsSDK,
  isClaimDeadlinePassed,
  type RewardsSDKConfig,
  validateMaxSlippageBps,
} from './rewards';
import { VaultClient } from './vaultClient';
import { type UserPosition } from './types';

const vaultAddress = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const userAddress = Keypair.random().publicKey();
const rewardDistributor = Keypair.random().publicKey();
const swapRouter = Keypair.random().publicKey();

function createRewardsSDK(): RewardsSDK {
  const config: RewardsSDKConfig = {
    horizonServer: {} as RewardsSDKConfig['horizonServer'],
    networkPassphrase: Networks.TESTNET,
    rewardDistributor,
    swapRouter,
    networkConfig: {
      network: 'testnet',
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    },
  };

  return new RewardsSDK(config);
}

function userPosition(shares: bigint): UserPosition {
  return {
    shares,
    lastHarvest: 0,
    depositedAmountA: 0n,
    depositedAmountB: 0n,
  };
}

describe('RewardsSDK vault shares', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('uses exact on-chain shares when calculating pending rewards', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);

    const shares = 9_007_199_254_740_993n;
    const getUserPosition = jest
      .spyOn(VaultClient.prototype, 'getUserPosition')
      .mockResolvedValue(userPosition(shares));
    const rewardsSDK = createRewardsSDK();
    jest.spyOn(rewardsSDK, 'getAllStreams').mockResolvedValue([
      {
        index: 0,
        token: 'USDC',
        tokenSymbol: 'USDC',
        ratePerSecond: '1',
        totalDistributed: '0',
        lastUpdate: 0,
        isActive: true,
        decimals: 7,
        claimDeadline: 0,
      },
    ]);

    const pending = await rewardsSDK.getPendingRewards(userAddress, vaultAddress);

    expect(getUserPosition).toHaveBeenCalledTimes(1);
    expect(getUserPosition.mock.calls[0][0].toString()).toBe(userAddress);
    expect(pending.totalByToken.get('USDC')).toBe((shares * 10n).toString());
  });

  it('returns no rewards for an on-chain position with zero shares', async () => {
    jest
      .spyOn(VaultClient.prototype, 'getUserPosition')
      .mockResolvedValue(userPosition(0n));
    const rewardsSDK = createRewardsSDK();
    const getAllStreams = jest.spyOn(rewardsSDK, 'getAllStreams');

    const pending = await rewardsSDK.getPendingRewards(userAddress, vaultAddress);

    expect(pending.streams.size).toBe(0);
    expect(pending.totalByToken.size).toBe(0);
    expect(pending.totalUsd).toBe(0);
    expect(getAllStreams).not.toHaveBeenCalled();
  });

  it('propagates vault position lookup failures without using mock shares', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(VaultClient.prototype, 'getUserPosition')
      .mockRejectedValue(new Error('RPC unavailable'));
    const rewardsSDK = createRewardsSDK();

    await expect(
      rewardsSDK.getPendingRewards(userAddress, vaultAddress)
    ).rejects.toThrow('RPC unavailable');
  });
});

describe('isClaimDeadlinePassed', () => {
  it('treats a zero deadline as "never expires"', () => {
    expect(isClaimDeadlinePassed({ claimDeadline: 0 }, 4_000_000_000)).toBe(false);
  });

  it('allows a claim exactly at the deadline but not after it', () => {
    expect(isClaimDeadlinePassed({ claimDeadline: 5_000 }, 5_000)).toBe(false);
    expect(isClaimDeadlinePassed({ claimDeadline: 5_000 }, 5_001)).toBe(true);
  });
});

describe('slippage tolerance validation', () => {
  it.each([0, MAX_SLIPPAGE_BPS - 1, MAX_SLIPPAGE_BPS])(
    'accepts %s bps',
    (slippageBps) => {
      expect(() => validateMaxSlippageBps(slippageBps)).not.toThrow();
    }
  );

  it.each([-1, MAX_SLIPPAGE_BPS + 1, Number.MAX_SAFE_INTEGER, NaN, Infinity, 0.5])(
    'rejects invalid value %s',
    (slippageBps) => {
      expect(() => validateMaxSlippageBps(slippageBps)).toThrow(/maxSlippageBps/);
    }
  );

  it('rejects an invalid runtime value before requesting a quote', async () => {
    const rewardsSDK = createRewardsSDK();

    await expect(
      rewardsSDK.getSwapQuote('USDC', 'XLM', '1000', MAX_SLIPPAGE_BPS + 1)
    ).rejects.toThrow(/maxSlippageBps/);
  });
});

// ===== Fee-routing alignment: SDK quote matches contract constant =====
//
// The swap_router contract uses PROTOCOL_TREASURY_FEE_BPS = 25 (0.25%).
// The fee is computed as: expected_output * 25 / 10_000.
// The SDK must reproduce the same arithmetic so callers see accurate quotes.
//
// Fee-routing flow (from contract source):
//   SwapRouter.swap  →  transfers fee to the treasury address stored in the
//                       router's own state.
//   Treasury account →  calls FeeDistributor.collect_fees(caller, amount)
//                       to register the week's fees (only the treasury may
//                       call this — any other caller panics).
//   Stakers          ←  call FeeDistributor.claim_week(user, week) to
//                       receive their proportional share of that week's fees.
describe('getSwapQuote fee-routing alignment', () => {
  it('computes protocolFee as amount * 25 / 10_000, matching PROTOCOL_TREASURY_FEE_BPS = 25', async () => {
    const rewardsSDK = createRewardsSDK();
    const inputAmount = '10000'; // 10 000 stroops

    const quote = await rewardsSDK.getSwapQuote('USDC', 'XLM', inputAmount);

    // 10 000 * 25 / 10 000 = 25
    expect(quote.protocolFee).toBe('25');
  });

  it('rounds down (integer division) for amounts that do not divide evenly', async () => {
    const rewardsSDK = createRewardsSDK();
    // 1 stroop * 25 / 10_000 = 0 (truncated)
    expect((await rewardsSDK.getSwapQuote('USDC', 'XLM', '1')).protocolFee).toBe('0');

    // 399 * 25 / 10_000 = 0  (< 1 after truncation)
    expect((await rewardsSDK.getSwapQuote('USDC', 'XLM', '399')).protocolFee).toBe('0');

    // 400 * 25 / 10_000 = 1
    expect((await rewardsSDK.getSwapQuote('USDC', 'XLM', '400')).protocolFee).toBe('1');
  });

  it('scales linearly for large amounts', async () => {
    const rewardsSDK = createRewardsSDK();
    // 1_000_000 * 25 / 10_000 = 2_500
    const quote = await rewardsSDK.getSwapQuote('USDC', 'XLM', '1000000');
    expect(quote.protocolFee).toBe('2500');
  });
});

describe('RewardsSDK claim deadlines', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('refuses to claim a stream whose deadline has passed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(20_000);
    jest
      .spyOn(VaultClient.prototype, 'getUserPosition')
      .mockResolvedValue(userPosition(1_000n));
    const rewardsSDK = createRewardsSDK();
    jest.spyOn(rewardsSDK, 'getAllStreams').mockResolvedValue([
      {
        index: 0,
        token: 'USDC',
        tokenSymbol: 'USDC',
        ratePerSecond: '1',
        totalDistributed: '0',
        lastUpdate: 0,
        isActive: true,
        decimals: 7,
        claimDeadline: 5, // long past: the ledger is at t=20
      },
    ]);

    await expect(
      rewardsSDK.claimRewards(Keypair.random(), vaultAddress, { streams: [0] })
    ).rejects.toThrow(/stream 0 expired at 5/);
  });
});
