import { useState, useEffect, useCallback } from 'react';
import { VaultClient, VaultInfo, VaultMetrics, UserPosition, NetworkConfig } from 'stellar-liquidity-yield-engine-sdk';

interface UseYieldVaultOptions {
  vaultAddress: string;
  userAddress: string;
  network?: 'testnet' | 'mainnet';
  autoRefresh?: boolean;
  refreshInterval?: number;
}

interface UseYieldVaultReturn {
  vaultInfo: VaultInfo | null;
  vaultMetrics: VaultMetrics | null;
  userPosition: UserPosition | null;
  isPaused: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  deposit: (amountA: bigint, amountB: bigint, minShares: bigint) => Promise<any>;
  withdraw: (shares: bigint, minAmountA: bigint, minAmountB: bigint) => Promise<any>;
  harvest: () => Promise<any>;
  getAPY: () => Promise<number>;
  getTVL: () => Promise<bigint>;
}

export const useYieldVault = ({
  vaultAddress,
  userAddress,
  network = 'testnet',
  autoRefresh = false,
  refreshInterval = 30000 // 30 seconds
}: UseYieldVaultOptions): UseYieldVaultReturn => {
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null);
  const [vaultMetrics, setVaultMetrics] = useState<VaultMetrics | null>(null);
  const [userPosition, setUserPosition] = useState<UserPosition | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const vaultClient = new VaultClient(vaultAddress, network);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [info, metrics, position, paused] = await Promise.all([
        vaultClient.getVaultInfo(),
        vaultClient.getMetrics(),
        vaultClient.getUserPosition(userAddress),
        vaultClient.isPaused()
      ]);

      setVaultInfo(info);
      setVaultMetrics(metrics);
      setUserPosition(position);
      setIsPaused(paused);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [vaultClient, userAddress]);

  const deposit = useCallback(async (
    amountA: bigint,
    amountB: bigint,
    minShares: bigint
  ) => {
    try {
      setError(null);
      
      // This would need user's keypair - simplified for demo
      // const result = await vaultClient.deposit(userKeyPair, {
      //   amountA,
      //   amountB,
      //   minShares
      // });
      
      // For demo purposes, return a mock result
      const result = {
        hash: `deposit_${Date.now()}`,
        success: true,
        gasUsed: 0
      };
      
      // Refresh data after successful deposit
      await refresh();
      
      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [vaultClient, refresh]);

  const withdraw = useCallback(async (
    shares: bigint,
    minAmountA: bigint,
    minAmountB: bigint
  ) => {
    try {
      setError(null);
      
      // This would need user's keypair - simplified for demo
      // const result = await vaultClient.withdraw(userKeyPair, {
      //   shares,
      //   minAmountA,
      //   minAmountB
      // });
      
      // For demo purposes, return a mock result
      const result = {
        hash: `withdraw_${Date.now()}`,
        success: true,
        gasUsed: 0,
        amountA: minAmountA,
        amountB: minAmountB
      };
      
      // Refresh data after successful withdrawal
      await refresh();
      
      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [vaultClient, refresh]);

  const harvest = useCallback(async () => {
    try {
      setError(null);
      
      // This would need user's keypair - simplified for demo
      // const result = await vaultClient.harvest(userKeyPair);
      
      // For demo purposes, return a mock result
      const result = {
        hash: `harvest_${Date.now()}`,
        success: true,
        gasUsed: 0
      };
      
      // Refresh data after successful harvest
      await refresh();
      
      return result;
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [vaultClient, refresh]);

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
    refresh,
    deposit,
    withdraw,
    harvest,
    getAPY,
    getTVL
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
      const vaultClient = new VaultClient(vaultAddress, network);
      
      const [info, metrics, position, paused] = await Promise.all([
        vaultClient.getVaultInfo(),
        vaultClient.getMetrics(),
        vaultClient.getUserPosition(userAddress),
        vaultClient.isPaused()
      ]);

      setVaultsData(prev => new Map(prev.set(vaultAddress, {
        info,
        metrics,
        position,
        isPaused: paused,
        loading: false,
        error: null
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

  const vaultClient = new VaultClient(vaultAddress, network);

  const trackPerformance = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [apy, tvl] = await Promise.all([
        vaultClient.getAPY(),
        vaultClient.getTVL()
      ]);

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
