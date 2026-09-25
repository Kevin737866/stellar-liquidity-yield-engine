import { Keypair, Networks } from 'stellar-sdk';
import { RewardsSDK, type RewardsSDKConfig } from './rewards';
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
