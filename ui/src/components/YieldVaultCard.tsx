import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, DollarSign, Activity, Lock, Unlock } from 'lucide-react';
import { VaultClient, VaultInfo, VaultMetrics, UserPosition } from 'stellar-liquidity-yield-engine-sdk';

interface YieldVaultCardProps {
  vaultAddress: string;
  userAddress: string;
  network?: 'testnet' | 'mainnet';
}

export const YieldVaultCard: React.FC<YieldVaultCardProps> = ({
  vaultAddress,
  userAddress,
  network = 'testnet'
}) => {
  const [vaultInfo, setVaultInfo] = useState<VaultInfo | null>(null);
  const [vaultMetrics, setVaultMetrics] = useState<VaultMetrics | null>(null);
  const [userPosition, setUserPosition] = useState<UserPosition | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [depositAmountA, setDepositAmountA] = useState('');
  const [depositAmountB, setDepositAmountB] = useState('');
  const [withdrawShares, setWithdrawShares] = useState('');
  const [error, setError] = useState<string | null>(null);

  const vaultClient = new VaultClient(vaultAddress, network === 'testnet' ? 'testnet' : 'mainnet');

  useEffect(() => {
    loadVaultData();
  }, [vaultAddress, userAddress]);

  const loadVaultData = async () => {
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
  };

  const handleDeposit = async () => {
    if (!depositAmountA || !depositAmountB) return;

    try {
      setError(null);
      // This would need user's keypair - simplified for demo
      // await vaultClient.deposit(userKeyPair, {
      //   amountA: BigInt(depositAmountA),
      //   amountB: BigInt(depositAmountB),
      //   minShares: BigInt(0)
      // });
      
      // Refresh data after successful deposit
      await loadVaultData();
      setDepositAmountA('');
      setDepositAmountB('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawShares) return;

    try {
      setError(null);
      // This would need user's keypair - simplified for demo
      // await vaultClient.withdraw(userKeyPair, {
      //   shares: BigInt(withdrawShares),
      //   minAmountA: BigInt(0),
      //   minAmountB: BigInt(0)
      // });
      
      // Refresh data after successful withdrawal
      await loadVaultData();
      setWithdrawShares('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleHarvest = async () => {
    try {
      setError(null);
      // This would need user's keypair - simplified for demo
      // await vaultClient.harvest(userKeyPair);
      
      // Refresh data after successful harvest
      await loadVaultData();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-32">
            <Activity className="h-8 w-8 animate-spin" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!vaultInfo || !vaultMetrics) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardContent className="p-6">
          <div className="text-center text-gray-500">
            Failed to load vault information
          </div>
        </CardContent>
      </Card>
    );
  }

  const apy = vaultMetrics.apy / 100; // Convert from basis points
  const tvl = Number(vaultMetrics.tvl) / 1000000; // Convert to millions (assuming 6 decimals)
  const userShares = userPosition?.shares || 0n;
  const userValue = userShares > 0n && vaultMetrics.totalShares > 0n 
    ? (Number(userShares) / Number(vaultMetrics.totalShares)) * Number(vaultMetrics.tvl)
    : 0;

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl font-bold">{vaultInfo.name}</CardTitle>
          <div className="flex items-center gap-2">
            {isPaused ? (
              <Badge variant="destructive" className="flex items-center gap-1">
                <Lock className="h-3 w-3" />
                Paused
              </Badge>
            ) : (
              <Badge variant="default" className="flex items-center gap-1">
                <Unlock className="h-3 w-3" />
                Active
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-6">
        {/* Vault Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-2xl font-bold text-green-600">
              {apy > 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
              {apy.toFixed(2)}%
            </div>
            <div className="text-sm text-gray-500">APY</div>
          </div>
          
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 text-2xl font-bold">
              <DollarSign className="h-5 w-5" />
              ${tvl.toFixed(2)}M
            </div>
            <div className="text-sm text-gray-500">TVL</div>
          </div>
          
          <div className="text-center">
            <div className="text-2xl font-bold">
              {Number(vaultMetrics.totalShares).toLocaleString()}
            </div>
            <div className="text-sm text-gray-500">Total Shares</div>
          </div>
          
          <div className="text-center">
            <div className="text-2xl font-bold">
              {vaultInfo.feeRate / 100}%
            </div>
            <div className="text-sm text-gray-500">Fee Rate</div>
          </div>
        </div>

        {/* User Position */}
        <div className="border-t pt-4">
          <h3 className="text-lg font-semibold mb-3">Your Position</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-sm text-gray-500">Shares</div>
              <div className="text-xl font-bold">{Number(userShares).toLocaleString()}</div>
            </div>
            <div>
              <div className="text-sm text-gray-500">Value</div>
              <div className="text-xl font-bold">${(userValue / 1000000).toFixed(2)}</div>
            </div>
          </div>
        </div>

        {/* Deposit Section */}
        <div className="border-t pt-4">
          <h3 className="text-lg font-semibold mb-3">Deposit</h3>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-gray-500">Token A Amount</label>
                <Input
                  type="number"
                  placeholder="0"
                  value={depositAmountA}
                  onChange={(e) => setDepositAmountA(e.target.value)}
                  disabled={isPaused}
                />
              </div>
              <div>
                <label className="text-sm text-gray-500">Token B Amount</label>
                <Input
                  type="number"
                  placeholder="0"
                  value={depositAmountB}
                  onChange={(e) => setDepositAmountB(e.target.value)}
                  disabled={isPaused}
                />
              </div>
            </div>
            <Button 
              onClick={handleDeposit} 
              disabled={!depositAmountA || !depositAmountB || isPaused}
              className="w-full"
            >
              Deposit
            </Button>
          </div>
        </div>

        {/* Withdraw Section */}
        <div className="border-t pt-4">
          <h3 className="text-lg font-semibold mb-3">Withdraw</h3>
          <div className="space-y-3">
            <div>
              <label className="text-sm text-gray-500">Shares to Withdraw</label>
              <Input
                type="number"
                placeholder="0"
                value={withdrawShares}
                onChange={(e) => setWithdrawShares(e.target.value)}
                disabled={isPaused || userShares === 0n}
              />
            </div>
            <Button 
              onClick={handleWithdraw} 
              disabled={!withdrawShares || isPaused || userShares === 0n}
              variant="outline"
              className="w-full"
            >
              Withdraw
            </Button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button 
            onClick={handleHarvest} 
            disabled={isPaused}
            variant="secondary"
            className="flex-1"
          >
            Harvest Rewards
          </Button>
          <Button 
            onClick={loadVaultData}
            variant="outline"
            className="flex-1"
          >
            Refresh
          </Button>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <div className="text-sm text-red-600">{error}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
