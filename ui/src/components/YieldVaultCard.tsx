import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, DollarSign, Activity, Lock, Unlock, Wallet, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { useYieldVault } from '../hooks/useYieldVault';
import { useTxStatus } from '../hooks/useTxStatus';
import { shortenAddress } from '../lib/freighter';

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
  const [depositAmountA, setDepositAmountA] = useState('');
  const [depositAmountB, setDepositAmountB] = useState('');
  const [withdrawShares, setWithdrawShares] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { txStatus, txHash, txError, runTx, resetTx } = useTxStatus();

  const {
    vaultInfo,
    vaultMetrics,
    userPosition,
    isPaused,
    loading,
    error: hookError,
    refresh,
    deposit,
    withdraw,
    harvest,
    walletAddress,
    walletConnected,
    connecting,
    connect,
    disconnect,
  } = useYieldVault({
    vaultAddress,
    userAddress,
    network,
    autoRefresh: true,
    refreshInterval: 30000,
  });

  React.useEffect(() => {
    setError(hookError);
  }, [hookError]);

  const handleDeposit = async () => {
    if (!depositAmountA || !depositAmountB) return;
    resetTx();
    setError(null);

    await runTx(async () => {
      const result = await deposit(BigInt(depositAmountA), BigInt(depositAmountB), 0n);
      setDepositAmountA('');
      setDepositAmountB('');
      return result;
    });
  };

  const handleWithdraw = async () => {
    if (!withdrawShares) return;
    resetTx();
    setError(null);

    await runTx(async () => {
      const result = await withdraw(BigInt(withdrawShares), 0n, 0n);
      setWithdrawShares('');
      return result;
    });
  };

  const handleHarvest = async () => {
    resetTx();
    setError(null);

    await runTx(async () => {
      const result = await harvest();
      return result;
    });
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

  const isTxInFlight = txStatus === 'submitting' || txStatus === 'pending';

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

        {/* Freighter wallet connection */}
        <div className="flex items-center justify-between border-t pt-3">
          {walletConnected ? (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="flex items-center gap-1">
                <Wallet className="h-3 w-3" />
                {shortenAddress(walletAddress || '')}
              </Badge>
              <Button variant="ghost" size="sm" onClick={disconnect}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button
              onClick={connect}
              disabled={connecting}
              variant="outline"
              size="sm"
              className="gap-1"
            >
              <Wallet className="h-4 w-4" />
              {connecting ? 'Connecting…' : 'Connect Freighter'}
            </Button>
          )}
          <div className="text-xs text-gray-500">
            {walletConnected
              ? 'Transactions signed via Freighter'
              : 'Connect to deposit, withdraw and harvest'}
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
                  disabled={isPaused || isTxInFlight}
                />
              </div>
              <div>
                <label className="text-sm text-gray-500">Token B Amount</label>
                <Input
                  type="number"
                  placeholder="0"
                  value={depositAmountB}
                  onChange={(e) => setDepositAmountB(e.target.value)}
                  disabled={isPaused || isTxInFlight}
                />
              </div>
            </div>
            <Button 
              onClick={handleDeposit} 
              disabled={!depositAmountA || !depositAmountB || isPaused || !walletConnected || isTxInFlight}
              className="w-full"
            >
              {isTxInFlight ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing…</>
              ) : 'Deposit'}
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
                disabled={isPaused || userShares === 0n || isTxInFlight}
              />
            </div>
            <Button 
              onClick={handleWithdraw} 
              disabled={!withdrawShares || isPaused || userShares === 0n || !walletConnected || isTxInFlight}
              variant="outline"
              className="w-full"
            >
              {isTxInFlight ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing…</>
              ) : 'Withdraw'}
            </Button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button 
            onClick={handleHarvest} 
            disabled={isPaused || !walletConnected || isTxInFlight}
            variant="secondary"
            className="flex-1"
          >
            {isTxInFlight ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing…</>
            ) : 'Harvest Rewards'}
          </Button>
          <Button 
            onClick={refresh}
            variant="outline"
            className="flex-1"
            disabled={isTxInFlight}
          >
            Refresh
          </Button>
        </div>

        {/* Transaction Status Banner */}
        {txStatus !== 'idle' && (
          <div className={`rounded-md p-3 border text-sm ${
            txStatus === 'confirmed'
              ? 'bg-green-50 border-green-200 text-green-700'
              : txStatus === 'failed'
              ? 'bg-red-50 border-red-200 text-red-600'
              : 'bg-blue-50 border-blue-200 text-blue-700'
          }`}>
            <div className="flex items-center gap-2">
              {(txStatus === 'submitting' || txStatus === 'pending') && (
                <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />
              )}
              {txStatus === 'confirmed' && (
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
              )}
              {txStatus === 'failed' && (
                <XCircle className="h-4 w-4 flex-shrink-0" />
              )}

              <span className="font-medium">
                {txStatus === 'submitting' && 'Submitting transaction…'}
                {txStatus === 'pending' && 'Waiting for confirmation…'}
                {txStatus === 'confirmed' && 'Transaction confirmed'}
                {txStatus === 'failed' && (txError ?? 'Transaction failed')}
              </span>

              {txHash && (
                <span className="ml-auto font-mono text-xs truncate max-w-[160px]" title={txHash}>
                  {txHash.slice(0, 8)}…{txHash.slice(-6)}
                </span>
              )}

              {(txStatus === 'confirmed' || txStatus === 'failed') && (
                <button
                  onClick={resetTx}
                  className="ml-2 underline text-xs opacity-70 hover:opacity-100"
                  type="button"
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        )}

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
