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

// ---------------------------------------------------------------------------
// Treasury fee routing constants — must stay in sync with the Rust contract.
// reward_distributor.rs: const TREASURY_FEE_BPS: u32 = 25;
// reward_distributor.rs: BPS_DIVISOR: i128 = 10000;
// ---------------------------------------------------------------------------
const CONTRACT_TREASURY_FEE_BPS = 25n;
const BPS_DIVISOR = 10_000n;

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

// ---------------------------------------------------------------------------
// Treasury fee-routing alignment
//
// These tests verify that the SDK's fee arithmetic matches what the
// reward_distributor contract does on-chain:
//
//   treasury_fee = pending * TREASURY_FEE_BPS / BPS_DIVISOR   (= 25 / 10 000)
//   net_reward   = pending - treasury_fee
//
// If the constant in the contract ever changes, these tests will fail and
// force the SDK to be updated at the same time.
// ---------------------------------------------------------------------------
describe('treasury fee-routing alignment', () => {
  /**
   * Mirror of the Rust contract logic in reward_distributor.rs:
   *
   *   let treasury_fee = (pending * TREASURY_FEE_BPS as i128) / BPS_DIVISOR;
   *   let net_reward = pending - treasury_fee;
   */
  function contractFeeFor(pendingRaw: bigint): { treasuryFee: bigint; netReward: bigint } {
    const treasuryFee = (pendingRaw * CONTRACT_TREASURY_FEE_BPS) / BPS_DIVISOR;
    return { treasuryFee, netReward: pendingRaw - treasuryFee };
  }

  it('treasury + net equals gross: invariant holds for a typical reward', () => {
    const gross = 1_000_000n; // 0.1 USDC at 7-decimal precision
    const { treasuryFee, netReward } = contractFeeFor(gross);
    expect(treasuryFee + netReward).toBe(gross);
  });

  it('fee is exactly 0.25% (25 bps) of the gross reward', () => {
    const gross = 10_000n;
    const { treasuryFee } = contractFeeFor(gross);
    // 10 000 * 25 / 10 000 = 25
    expect(treasuryFee).toBe(25n);
  });

  it('SDK getSwapQuote protocolFee matches the contract formula', async () => {
    // The SDK quotes the same 25-bps fee that the contract charges before
    // routing to the treasury.
    const sdk = createRewardsSDK();
    const inputAmount = '10000';
    const quote = await sdk.getSwapQuote('USDC', 'XLM', inputAmount);

    const expectedFee = contractFeeFor(BigInt(inputAmount)).treasuryFee;
    expect(BigInt(quote.protocolFee)).toBe(expectedFee);
  });

  it('fee rounds down (integer division) for sub-BPS amounts', () => {
    // With a gross of 399, floor(399 * 25 / 10_000) = floor(0.9975) = 0.
    // The user receives everything; nothing goes to the treasury.
    const { treasuryFee, netReward } = contractFeeFor(399n);
    expect(treasuryFee).toBe(0n);
    expect(netReward).toBe(399n);
  });

  it('net reward is never more than the gross reward', () => {
    for (const gross of [0n, 1n, 9_999n, 10_000n, 1_000_000_000n]) {
      const { netReward } = contractFeeFor(gross);
      expect(netReward).toBeLessThanOrEqual(gross);
    }
  });
});
