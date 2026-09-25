import { useState, useEffect, useCallback, useMemo } from 'react';
import { VaultClient, VaultInfo, VaultMetrics, UserPosition, NetworkConfig } from 'stellar-liquidity-yield-engine-sdk';
import {
  createFreighterSigner,
  getFreighterPublicKey,
  isFreighterAvailable,
  isFreighterConnected,
} from '../lib/freighter';

interface UseYieldVaultOptions {
  vaultAddress: string;
  userAddress: string;
  network?: 'testnet' | 'mainnet';
  autoRefresh?: boolean;
  refreshInterval?: number;
  signer?: any;
  keypair?: any;
}

interface UseYieldVaultReturn {
  vaultInfo: VaultInfo | null;
  vaultMetrics: VaultMetrics | null;
  userPosition: UserPosition | null;
  isPaused: boolean;
  loading: boolean;
  error: string | null;
  metricsLoading: boolean;
  positionLoading: boolean;
  metricsError: string | null;
  positionError: string | null;
  refresh: () => Promise<void>;
  deposit: (amountA: bigint, amountB: bigint, minShares: bigint) => Promise<any>;
  withdraw: (shares: bigint, minAmountA: bigint, minAmountB: bigint) => Promise<any>;
  harvest: () => Promise<any>;
  getAPY: () => Promise<number>;
  getTVL: () => Promise<bigint>;
  walletAddress: string | null;
  walletConnected: boolean;
  connecting: boolean;
  connect: () => Promise<string | null>;
  disconnect: () => void;
}

const networkConfigFor = (network: 'testnet' | 'mainnet'): NetworkConfig =>
  ({
    network,
    horizonUrl:
      network === 'mainnet'
        ? 'https://horizon.stellar.org'
        : 'https://horizon-testnet.stellar.org',
    sorobanRpcUrl:
      network === 'mainnet'
        ? 'https://soroban.stellar.org'
        : 'https://soroban-testnet.stellar.org',
    contracts: {
      yieldEngine: '',
      rewardDistributor: '',
      rebalanceEngine: '',
      strategyRegistry: '',
    },
  } as NetworkConfig);

export const useYieldVault = ({
  vaultAddress,
  userAddress,
  network = 'testnet',
  autoRefresh = false,
  refreshInterval = 30000, // 30 seconds
  signer,
  keypair,
}: UseYieldVaultOptions): UseYieldVaultReturn => {
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null);
  const [vaultMetrics, setVaultMetrics] = useState<VaultMetrics | null>(null);
  const [userPosition, setUserPosition] = useState<UserPosition | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [positionLoading, setPositionLoading] = useState(true);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [positionError, setPositionError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  const vaultClient = useMemo(
    () => new VaultClient(vaultAddress, networkConfigFor(network)),
    [vaultAddress, network]
  );

  // Active signer: explicit signer prop, or keypair prop, or Freighter wallet
  const activeSigner = useMemo(() => {
    if (signer) return signer;
    if (keypair) return keypair;
    if (walletAddress) return createFreighterSigner(network);
    return null;
  }, [signer, keypair, walletAddress, network]);

  // Derive resolved address: walletAddress, or keypair publicKey, or passed userAddress
  const resolvedAddress = useMemo(() => {
    if (walletAddress) return walletAddress;
    if (keypair && typeof keypair.publicKey === 'function') {
      try {
        return keypair.publicKey();
      } catch {
        // fallback
      }
    }
    return userAddress;
  }, [walletAddress, keypair, userAddress]);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setMetricsLoading(true);
      setPositionLoading(true);
      setError(null);
      setMetricsError(null);
      setPositionError(null);

      const results = await Promise.allSettled([
        vaultClient.getVaultInfo(),
        vaultClient.getMetrics(),
        vaultClient.getUserPosition(resolvedAddress),
        vaultClient.isPaused()
      ]);

      const errors: string[] = [];

      if (results[0].status === 'fulfilled') {
        setVaultInfo(results[0].value);
      } else {
        const msg = results[0].reason?.message || 'Failed to fetch vault info';
        errors.push(`Vault info: ${msg}`);
      }

      if (results[1].status === 'fulfilled') {
        setVaultMetrics(results[1].value);
      } else {
        const msg = results[1].reason?.message || 'Failed to fetch vault metrics (APY/TVL)';
        setMetricsError(msg);
        errors.push(`Metrics: ${msg}`);
      }

      if (results[2].status === 'fulfilled') {
        setUserPosition(results[2].value);
      } else {
        const msg = results[2].reason?.message || 'Failed to fetch user position';
        setPositionError(msg);
        errors.push(`Position: ${msg}`);
      }

      if (results[3].status === 'fulfilled') {
        setIsPaused(results[3].value);
      } else {
        const msg = results[3].reason?.message || 'Failed to check paused status';
        errors.push(`State: ${msg}`);
      }

      if (errors.length > 0) {
        setError(errors.join('. '));
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch vault data');
    } finally {
      setLoading(false);
      setMetricsLoading(false);
      setPositionLoading(false);
    }
  }, [vaultClient, resolvedAddress]);

  const connect = useCallback(async (): Promise<string | null> => {
    if (connecting) return walletAddress;

    if (!isFreighterAvailable()) {
      setError('Freighter wallet not found. Install the Freighter extension and try again.');
      return null;
    }

    setConnecting(true);
    setError(null);
    try {
      const publicKey = await getFreighterPublicKey();
      setWalletAddress(publicKey);
      await refresh();
      return publicKey;
    } catch (err: any) {
      setError(err.message || 'Failed to connect to Freighter');
      return null;
    } finally {
      setConnecting(false);
    }
  }, [connecting, walletAddress, refresh]);

  const disconnect = useCallback(() => {
    setWalletAddress(null);
  }, []);

  // Reflect Freighter's persisted connection state on mount.
  useEffect(() => {
    let cancelled = false;
    isFreighterConnected()
      .then(async (connected) => {
        if (connected && !cancelled) {
          const publicKey = await getFreighterPublicKey().catch(() => null);
          if (publicKey && !cancelled) {
            setWalletAddress(publicKey);
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const deposit = useCallback(async (
    amountA: bigint,
    amountB: bigint,
    minShares: bigint
  ) => {
    try {
      setError(null);

      if (!activeSigner) {
        throw new Error('Connect a Freighter wallet or provide a keypair before depositing.');
      }

      // Sign and submit a real deposit transaction through the active wallet/keypair signer.
      const result = await vaultClient.deposit(activeSigner, {
        amountA,
        amountB,
        minShares
      });

      // Refresh data after successful deposit
      await refresh();

      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [vaultClient, refresh, activeSigner]);

  const withdraw = useCallback(async (
    shares: bigint,
    minAmountA: bigint,
    minAmountB: bigint
  ) => {
    try {
      setError(null);

      if (!activeSigner) {
        throw new Error('Connect a Freighter wallet or provide a keypair before withdrawing.');
      }

      // Sign and submit a real withdrawal transaction through the active wallet/keypair signer.
      const result = await vaultClient.withdraw(activeSigner, {
        shares,
        minAmountA,
        minAmountB
      });

      // Refresh data after successful withdrawal
      await refresh();

      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [vaultClient, refresh, activeSigner]);

  const harvest = useCallback(async () => {
    try {
      setError(null);

      if (!activeSigner) {
        throw new Error('Connect a Freighter wallet or provide a keypair before harvesting.');
      }

      // Sign and submit a real harvest transaction through the active wallet/keypair signer.
      const result = await vaultClient.harvest(activeSigner);

      // Refresh data after successful harvest
      await refresh();

      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [vaultClient, refresh, activeSigner]);

  const getAPY = useCallback(async () => {
    try {
      setError(null);
      return await vaultClient.getAPY();
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [vaultClient]);

  const getTVL = useCallback(async () => {
    try {
      setError(null);
      return await vaultClient.getTVL();
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [vaultClient]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto refresh
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      refresh();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, refresh]);

  return {
    vaultInfo,
    vaultMetrics,
    userPosition,
    isPaused,
    loading,
    error,
    metricsLoading,
    positionLoading,
    metricsError,
    positionError,
    refresh,
    deposit,
    withdraw,
    harvest,
    getAPY,
    getTVL,
    walletAddress: resolvedAddress,
    walletConnected: !!activeSigner || !!walletAddress,
    connecting,
    connect,
    disconnect
  };
};

// Additional hook for multiple vaults
interface UseMultipleVaultsOptions {
  vaultAddresses: string[];
  userAddress: string;
  network?: 'testnet' | 'mainnet';
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export const useMultipleVaults = ({
  vaultAddresses,
  userAddress,
  network = 'testnet',
  autoRefresh = false,
  refreshInterval = 30000
}: UseMultipleVaultsOptions) => {
  const [vaultsData, setVaultsData] = useState<Map<string, {
    info: VaultInfo | null;
    metrics: VaultMetrics | null;
    position: UserPosition | null;
    isPaused: boolean;
    loading: boolean;
    error: string | null;
  }>>(new Map());

  const [overallLoading, setOverallLoading] = useState(true);
  const [overallError, setOverallError] = useState<string | null>(null);

  const refreshVault = useCallback(async (vaultAddress: string) => {
    try {
      const vaultClient = new VaultClient(vaultAddress, networkConfigFor(network));
      
      const results = await Promise.allSettled([
        vaultClient.getVaultInfo(),
        vaultClient.getMetrics(),
        vaultClient.getUserPosition(userAddress),
        vaultClient.isPaused()
      ]);

      const errors: string[] = [];
      const info = results[0].status === 'fulfilled' ? results[0].value : null;
      if (results[0].status === 'rejected') errors.push(`Vault Info: ${results[0].reason?.message || 'Failed'}`);

      const metrics = results[1].status === 'fulfilled' ? results[1].value : null;
      if (results[1].status === 'rejected') errors.push(`Metrics: ${results[1].reason?.message || 'Failed'}`);

      const position = results[2].status === 'fulfilled' ? results[2].value : null;
      if (results[2].status === 'rejected') errors.push(`Position: ${results[2].reason?.message || 'Failed'}`);

      const paused = results[3].status === 'fulfilled' ? results[3].value : false;
      if (results[3].status === 'rejected') errors.push(`State: ${results[3].reason?.message || 'Failed'}`);

      setVaultsData(prev => new Map(prev.set(vaultAddress, {
        info,
        metrics,
        position,
        isPaused: paused,
        loading: false,
        error: errors.length > 0 ? errors.join('. ') : null
      })));
    } catch (err: any) {
      setVaultsData(prev => new Map(prev.set(vaultAddress, {
        info: null,
        metrics: null,
        position: null,
        isPaused: false,
        loading: false,
        error: err.message
      })));
    }
  }, [network, userAddress]);

  const refreshAll = useCallback(async () => {
    setOverallLoading(true);
    setOverallError(null);

    try {
      await Promise.all(vaultAddresses.map(refreshVault));
    } catch (err: any) {
      setOverallError(err.message);
    } finally {
      setOverallLoading(false);
    }
  }, [vaultAddresses, refreshVault]);

  // Initial load
  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Auto refresh
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      refreshAll();
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, refreshAll]);

  const getTotalTVL = useCallback(() => {
    let total = 0n;
    vaultsData.forEach(data => {
      if (data.metrics) {
        total += data.metrics.tvl;
      }
    });
    return total;
  }, [vaultsData]);

  const getTotalUserValue = useCallback(() => {
    let total = 0n;
    vaultsData.forEach(data => {
      if (data.position && data.metrics && data.metrics.totalShares > 0n) {
        const userValue = (Number(data.position.shares) / Number(data.metrics.totalShares)) * Number(data.metrics.tvl);
        total += BigInt(userValue);
      }
    });
    return total;
  }, [vaultsData]);

  const getWeightedAPY = useCallback(() => {
    let totalWeightedApy = 0;
    let totalWeight = 0;
    
    vaultsData.forEach(data => {
      if (data.metrics && data.metrics.tvl > 0n) {
        const tvl = Number(data.metrics.tvl);
        totalWeightedApy += data.metrics.apy * tvl;
        totalWeight += tvl;
      }
    });
    
    return totalWeight > 0 ? totalWeightedApy / totalWeight : 0;
  }, [vaultsData]);

  return {
    vaultsData,
    overallLoading,
    overallError,
    refreshAll,
    refreshVault,
    getTotalTVL,
    getTotalUserValue,
    getWeightedAPY
  };
};

// Hook for vault performance tracking
export const useVaultPerformance = (vaultAddress: string, network: 'testnet' | 'mainnet' = 'testnet') => {
  const [performanceData, setPerformanceData] = useState<{
    apyHistory: number[];
    tvlHistory: bigint[];
    timestamps: number[];
  }>({
    apyHistory: [],
    tvlHistory: [],
    timestamps: []
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vaultClient = new VaultClient(vaultAddress, networkConfigFor(network));

  const trackPerformance = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [apyRes, tvlRes] = await Promise.allSettled([
        vaultClient.getAPY(),
        vaultClient.getTVL()
      ]);

      let apy = 0;
      let tvl = 0n;
      const errors: string[] = [];

      if (apyRes.status === 'fulfilled') {
        apy = apyRes.value;
      } else {
        errors.push(`APY: ${apyRes.reason?.message || 'Failed'}`);
      }

      if (tvlRes.status === 'fulfilled') {
        tvl = tvlRes.value;
      } else {
        errors.push(`TVL: ${tvlRes.reason?.message || 'Failed'}`);
      }

      if (errors.length > 0) {
        setError(errors.join('. '));
      }

      const timestamp = Date.now();

      setPerformanceData(prev => ({
        apyHistory: [...prev.apyHistory.slice(-29), apy], // Keep last 30 data points
        tvlHistory: [...prev.tvlHistory.slice(-29), tvl],
        timestamps: [...prev.timestamps.slice(-29), timestamp]
      }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [vaultClient]);

  const getAverageAPY = useCallback(() => {
    if (performanceData.apyHistory.length === 0) return 0;
    const sum = performanceData.apyHistory.reduce((acc, apy) => acc + apy, 0);
    return sum / performanceData.apyHistory.length;
  }, [performanceData]);

  const getAPYTrend = useCallback(() => {
    if (performanceData.apyHistory.length < 2) return 'stable';
    const recent = performanceData.apyHistory.slice(-7);
    const older = performanceData.apyHistory.slice(-14, -7);
    
    if (recent.length === 0 || older.length === 0) return 'stable';
    
    const recentAvg = recent.reduce((acc, apy) => acc + apy, 0) / recent.length;
    const olderAvg = older.reduce((acc, apy) => acc + apy, 0) / older.length;
    
    const change = (recentAvg - olderAvg) / olderAvg;
    
    if (change > 0.05) return 'increasing';
    if (change < -0.05) return 'decreasing';
    return 'stable';
  }, [performanceData]);

  const getTVLGrowth = useCallback(() => {
    if (performanceData.tvlHistory.length < 2) return 0;
    const first = performanceData.tvlHistory[0];
    const last = performanceData.tvlHistory[performanceData.tvlHistory.length - 1];
    
    if (first === 0n) return 0;
    return Number((last - first) * 100n / first);
  }, [performanceData]);

  return {
    performanceData,
    loading,
    error,
    trackPerformance,
    getAverageAPY,
    getAPYTrend,
    getTVLGrowth
  };
};
