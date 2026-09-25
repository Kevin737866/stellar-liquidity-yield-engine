import React, { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Lock,
  Unlock,
  Wallet,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Key
} from 'lucide-react';
import { useYieldVault } from '../hooks/useYieldVault';
import { useTxStatus } from '../hooks/useTxStatus';
import { shortenAddress } from '../lib/freighter';

interface YieldVaultCardProps {
  vaultAddress: string;
  userAddress: string;
  network?: 'testnet' | 'mainnet';
  keypair?: any;
  signer?: any;
}

export const YieldVaultSkeleton: React.FC = () => {
  return (
    <Card className="w-full max-w-2xl mx-auto animate-pulse" data-testid="yield-vault-skeleton">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="h-6 w-48 bg-gray-200 rounded"></div>
          <div className="h-6 w-16 bg-gray-200 rounded-full"></div>
        </div>
        <div className="flex items-center justify-between border-t pt-3 mt-2">
          <div className="h-8 w-36 bg-gray-200 rounded"></div>
          <div className="h-4 w-44 bg-gray-200 rounded"></div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="text-center p-3 rounded-lg bg-gray-50 border border-gray-100">
              <div className="h-7 w-20 bg-gray-200 rounded mx-auto mb-2"></div>
              <div className="h-4 w-14 bg-gray-200 rounded mx-auto"></div>
            </div>
          ))}
        </div>
        <div className="border-t pt-4">
          <div className="h-5 w-32 bg-gray-200 rounded mb-3"></div>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="h-4 w-16 bg-gray-200 rounded mb-2"></div>
              <div className="h-6 w-24 bg-gray-200 rounded"></div>
            </div>
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="h-4 w-16 bg-gray-200 rounded mb-2"></div>
              <div className="h-6 w-24 bg-gray-200 rounded"></div>
            </div>
          </div>
        </div>
        <div className="border-t pt-4 space-y-3">
          <div className="h-5 w-24 bg-gray-200 rounded"></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="h-10 bg-gray-200 rounded"></div>
            <div className="h-10 bg-gray-200 rounded"></div>
          </div>
          <div className="h-10 bg-gray-200 rounded"></div>
        </div>
      </CardContent>
    </Card>
  );
};

export const YieldVaultCard: React.FC<YieldVaultCardProps> = ({
  vaultAddress,
  userAddress,
  network = 'testnet',
  keypair,
  signer,
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
    metricsLoading,
    positionLoading,
    metricsError,
    positionError,
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
    keypair,
    signer,
  });

  React.useEffect(() => {
    if (hookError) {
      setError(hookError);
    }
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

  if (loading && !vaultInfo && !vaultMetrics) {
    return <YieldVaultSkeleton />;
  }

  if (!vaultInfo && !vaultMetrics) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="text-xl font-bold text-gray-800">Yield Vault</CardTitle>
        </CardHeader>
        <CardContent className="p-6">
          <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-red-800" role="alert">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <h4 className="font-semibold text-red-900">Failed to load vault information</h4>
                <p className="text-sm text-red-700 mt-1">
                  {error || hookError || 'Unable to connect to the Soroban RPC network to retrieve vault state.'}
                </p>
                <div className="mt-4">
                  <Button
                    onClick={() => refresh()}
                    size="sm"
                    variant="outline"
                    className="border-red-300 text-red-800 hover:bg-red-100 gap-1.5"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Retry
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const apy = vaultMetrics ? vaultMetrics.apy / 100 : 0; // Convert from basis points
  const tvl = vaultMetrics ? Number(vaultMetrics.tvl) / 1000000 : 0; // Convert to millions (assuming 6 decimals)
  const userShares = userPosition?.shares || 0n;
  const userValue =
    userShares > 0n && vaultMetrics && vaultMetrics.totalShares > 0n
      ? (Number(userShares) / Number(vaultMetrics.totalShares)) * Number(vaultMetrics.tvl)
      : 0;

  const isTxInFlight = txStatus === 'submitting' || txStatus === 'pending';
  const hasKeypair = Boolean(keypair);

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl font-bold">{vaultInfo?.name || 'Yield Vault'}</CardTitle>
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

        {/* Wallet / Keypair connection */}
        <div className="flex items-center justify-between border-t pt-3">
          {hasKeypair ? (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="flex items-center gap-1">
                <Key className="h-3 w-3" />
                {shortenAddress(walletAddress || userAddress)}
              </Badge>
              <span className="text-xs text-green-700 font-medium">Keypair active</span>
            </div>
          ) : walletConnected ? (
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
            {walletConnected || hasKeypair
              ? 'Transactions signed and sent on-chain'
              : 'Connect wallet to deposit, withdraw and harvest'}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Error Banner */}
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3.5 text-red-800" role="alert">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="font-semibold text-sm text-red-900">Vault Data Error</div>
                <div className="text-xs text-red-700 mt-0.5">{error}</div>
              </div>
              <div className="flex items-center gap-1 ml-auto">
                <Button
                  onClick={() => refresh()}
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs border-red-300 text-red-800 hover:bg-red-100 gap-1"
                >
                  <RefreshCw className="h-3 w-3" />
                  Retry
                </Button>
                <Button
                  onClick={() => setError(null)}
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-red-700 hover:bg-red-100"
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Warning Banner for silent 0s / metrics failure */}
        {!error && (!vaultMetrics || (apy === 0 && tvl === 0)) && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-amber-800" role="alert">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
              <span className="flex-1 text-xs">
                {metricsError
                  ? `Metrics fetch error: ${metricsError}`
                  : 'Vault APY and TVL are currently reporting 0. This may indicate uninitialized contract state or data fetch failure.'}
              </span>
              <Button
                onClick={() => refresh()}
                variant="ghost"
                size="sm"
                className="text-xs text-amber-800 hover:bg-amber-100 h-7 px-2 gap-1"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh
              </Button>
            </div>
          </div>
        )}

        {/* Vault Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="text-center p-3 rounded-lg border bg-gray-50/50">
            {metricsLoading ? (
              <div className="h-8 w-16 bg-gray-200 animate-pulse rounded mx-auto my-1"></div>
            ) : (
              <div className="flex items-center justify-center gap-1 text-2xl font-bold text-green-600">
                {apy > 0 ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}
                {apy.toFixed(2)}%
              </div>
            )}
            <div className="text-sm text-gray-500">APY</div>
          </div>

          <div className="text-center p-3 rounded-lg border bg-gray-50/50">
            {metricsLoading ? (
              <div className="h-8 w-16 bg-gray-200 animate-pulse rounded mx-auto my-1"></div>
            ) : (
              <div className="flex items-center justify-center gap-1 text-2xl font-bold">
                <DollarSign className="h-5 w-5" />
                ${tvl.toFixed(2)}M
              </div>
            )}
            <div className="text-sm text-gray-500">TVL</div>
          </div>

          <div className="text-center p-3 rounded-lg border bg-gray-50/50">
            {metricsLoading ? (
              <div className="h-8 w-16 bg-gray-200 animate-pulse rounded mx-auto my-1"></div>
            ) : (
              <div className="text-2xl font-bold">
                {vaultMetrics ? Number(vaultMetrics.totalShares).toLocaleString() : '0'}
              </div>
            )}
            <div className="text-sm text-gray-500">Total Shares</div>
          </div>

          <div className="text-center p-3 rounded-lg border bg-gray-50/50">
            <div className="text-2xl font-bold">
              {vaultInfo ? vaultInfo.feeRate / 100 : 0}%
            </div>
            <div className="text-sm text-gray-500">Fee Rate</div>
          </div>
        </div>

        {/* User Position */}
        <div className="border-t pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">Your Position</h3>
            {positionError && (
              <span className="text-xs text-amber-600 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Position data unavailable
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-sm text-gray-500">Shares</div>
              {positionLoading ? (
                <div className="h-6 w-20 bg-gray-200 animate-pulse rounded mt-1"></div>
              ) : (
                <div className="text-xl font-bold">{Number(userShares).toLocaleString()}</div>
              )}
            </div>
            <div className="p-3 bg-gray-50 rounded-lg">
              <div className="text-sm text-gray-500">Value</div>
              {positionLoading ? (
                <div className="h-6 w-20 bg-gray-200 animate-pulse rounded mt-1"></div>
              ) : (
                <div className="text-xl font-bold">${(userValue / 1000000).toFixed(2)}</div>
              )}
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
              disabled={!depositAmountA || !depositAmountB || isPaused || (!walletConnected && !hasKeypair) || isTxInFlight}
              className="w-full"
            >
              {isTxInFlight ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing…</>
              ) : (
                'Deposit'
              )}
            </Button>
            {!walletConnected && !hasKeypair && (
              <p className="text-xs text-gray-500 text-center">
                Connect Freighter wallet or configure a keypair to deposit funds.
              </p>
            )}
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
              disabled={!withdrawShares || isPaused || userShares === 0n || (!walletConnected && !hasKeypair) || isTxInFlight}
              variant="outline"
              className="w-full"
            >
              {isTxInFlight ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing…</>
              ) : (
                'Withdraw'
              )}
            </Button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-3">
          <Button
            onClick={handleHarvest}
            disabled={isPaused || (!walletConnected && !hasKeypair) || isTxInFlight}
            variant="secondary"
            className="flex-1"
          >
            {isTxInFlight ? (
              <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Processing…</>
            ) : (
              'Harvest Rewards'
            )}
          </Button>
          <Button
            onClick={() => refresh()}
            variant="outline"
            className="flex-1 gap-1"
            disabled={isTxInFlight}
          >
            <RefreshCw className="h-4 w-4" />
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
      </CardContent>
    </Card>
  );
};
