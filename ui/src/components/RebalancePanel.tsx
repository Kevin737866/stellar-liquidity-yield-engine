import React, { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  ArrowRightLeft, 
  TrendingUp, 
  Activity,
  CheckCircle,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Loader2
} from 'lucide-react';
import { RebalancerClient, RebalanceStrategy, RebalanceHistory, PoolAllocation, RebalanceProposal, NetworkConfig } from 'stellar-liquidity-yield-engine-sdk';
import { useTxStatus } from '../hooks/useTxStatus';

interface RebalancePanelProps {
  network?: 'testnet' | 'mainnet';
}

/** Build a minimal `NetworkConfig` from a network string. */
function networkConfigFor(network: 'testnet' | 'mainnet'): NetworkConfig {
  return {
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
  } as NetworkConfig;
}

export const RebalancePanel: React.FC<RebalancePanelProps> = ({
  network = 'testnet'
}) => {
  const [strategies, setStrategies] = useState<RebalanceStrategy[]>([]);
  const [history, setHistory] = useState<RebalanceHistory[]>([]);
  const [proposals, setProposals] = useState<RebalanceProposal[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<RebalanceStrategy | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { txStatus, txHash, txError, runTx, resetTx } = useTxStatus();

  // Fix: RebalancerClient takes NetworkConfig, not a plain string.
  const rebalancerClient = useMemo(
    () => new RebalancerClient(networkConfigFor(network)),
    [network]
  );

  useEffect(() => {
    loadData();
  }, [network]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      const [strategiesData, historyData] = await Promise.all([
        rebalancerClient.getStrategies(),
        rebalancerClient.getHistory(50)
      ]);

      setStrategies(strategiesData);
      setHistory(historyData);
      
      if (strategiesData.length > 0) {
        setSelectedStrategy(strategiesData[0]);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAnalyzeOpportunities = async () => {
    if (!selectedStrategy) return;

    try {
      setAnalyzing(true);
      setError(null);
      
      const result = await rebalancerClient.analyzeRebalanceOpportunities(selectedStrategy.strategyId);
      setProposals(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleExecuteRebalance = async (proposal: RebalanceProposal) => {
    resetTx();
    setError(null);

    await runTx(async () => {
      // executeRebalance requires a keypair/signer. In a real deployment
      // this would be a Freighter signer. We pass a placeholder here so the
      // call reaches the SDK and returns a TransactionResult with a hash.
      // Replace `null` with `createFreighterSigner(network)` when a wallet
      // is wired in.
      const result = await rebalancerClient.executeRebalance(null as any, proposal);
      await loadData();
      return {
        hash: result.hash,
        success: result.success,
        error: result.error
      };
    });
  };

  const getRiskLevelColor = (riskLevel: number) => {
    switch (riskLevel) {
      case 1: return 'bg-green-100 text-green-800';
      case 2: return 'bg-yellow-100 text-yellow-800';
      case 3: return 'bg-red-100 text-red-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getRiskLevelText = (riskLevel: number) => {
    switch (riskLevel) {
      case 1: return 'Conservative';
      case 2: return 'Balanced';
      case 3: return 'Aggressive';
      default: return 'Unknown';
    }
  };

  const isTxInFlight = txStatus === 'submitting' || txStatus === 'pending';

  if (loading) {
    return (
      <Card className="w-full max-w-4xl mx-auto">
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-32">
            <Activity className="h-8 w-8 animate-spin" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-4xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowRightLeft className="h-6 w-6" />
          Rebalance Engine
        </CardTitle>
      </CardHeader>
      
      <CardContent>
        <Tabs defaultValue="strategies" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="strategies">Strategies</TabsTrigger>
            <TabsTrigger value="allocations">Allocations</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="strategies" className="space-y-4">
            <div className="grid gap-4">
              {strategies.map((strategy) => (
                <Card key={strategy.strategyId} className="cursor-pointer hover:shadow-md transition-shadow"
                      onClick={() => setSelectedStrategy(strategy)}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-lg font-semibold">{strategy.name}</h3>
                      <div className="flex items-center gap-2">
                        <Badge className={getRiskLevelColor(strategy.riskLevel)}>
                          {getRiskLevelText(strategy.riskLevel)}
                        </Badge>
                        {selectedStrategy?.strategyId === strategy.strategyId && (
                          <Badge variant="outline">Selected</Badge>
                        )}
                      </div>
                    </div>
                    
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <div className="text-gray-500">Min APY</div>
                        <div className="font-semibold">{(strategy.minApyThreshold / 100).toFixed(2)}%</div>
                      </div>
                      <div>
                        <div className="text-gray-500">Max IL Risk</div>
                        <div className="font-semibold">{(strategy.maxIlRisk / 100).toFixed(2)}%</div>
                      </div>
                      <div>
                        <div className="text-gray-500">Rebalance Freq</div>
                        <div className="font-semibold">{Math.floor(strategy.rebalanceFrequency / 3600)}h</div>
                      </div>
                      <div>
                        <div className="text-gray-500">Pools</div>
                        <div className="font-semibold">{strategy.allocations.length}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {selectedStrategy && (
              <div className="space-y-4">
                <div className="flex gap-3">
                  <Button 
                    onClick={handleAnalyzeOpportunities}
                    disabled={analyzing || isTxInFlight}
                    className="flex-1"
                  >
                    {analyzing ? (
                      <>
                        <Activity className="h-4 w-4 mr-2 animate-spin" />
                        Analyzing...
                      </>
                    ) : (
                      <>
                        <TrendingUp className="h-4 w-4 mr-2" />
                        Analyze Opportunities
                      </>
                    )}
                  </Button>
                  <Button onClick={loadData} variant="outline" disabled={isTxInFlight}>
                    Refresh
                  </Button>
                </div>

                {/* Rebalance proposals */}
                {proposals.length > 0 && (
                  <div className="space-y-3">
                    <h4 className="font-semibold text-sm text-gray-700">
                      {proposals.length} rebalance proposal{proposals.length !== 1 ? 's' : ''} found
                    </h4>
                    {proposals.map((proposal, idx) => (
                      <Card key={idx} className="border-blue-200">
                        <CardContent className="p-4">
                          <div className="flex items-center justify-between">
                            <div className="text-sm space-y-1">
                              <div>
                                <span className="text-gray-500">Expected APY improvement: </span>
                                <span className="font-semibold text-green-600">
                                  +{(proposal.expectedApyImprovement / 100).toFixed(2)}%
                                </span>
                              </div>
                              <div>
                                <span className="text-gray-500">Est. gas: </span>
                                <span className="font-semibold">
                                  {Number(proposal.estimatedGasCost).toLocaleString()}
                                </span>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              onClick={() => handleExecuteRebalance(proposal)}
                              disabled={isTxInFlight}
                            >
                              {isTxInFlight ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                'Execute'
                              )}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="allocations" className="space-y-4">
            {selectedStrategy ? (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Current Allocations</h3>
                {selectedStrategy.allocations.map((allocation, index) => (
                  <Card key={index}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className="font-medium">Pool #{index + 1}</div>
                          <div className="text-sm text-gray-500">
                            {allocation.allocationPercent / 100}% allocation
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="font-semibold">
                            Target: {(allocation.targetApy / 100).toFixed(2)}%
                          </div>
                          <div className="text-sm text-gray-500">
                            Current: {(allocation.currentApy / 100).toFixed(2)}%
                          </div>
                        </div>
                      </div>
                      
                      <div className="space-y-2">
                        <div className="flex justify-between text-sm">
                          <span>Allocation Progress</span>
                          <span>{allocation.allocationPercent / 100}%</span>
                        </div>
                        <Progress value={allocation.allocationPercent / 100} />
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4 mt-3 text-sm">
                        <div>
                          <span className="text-gray-500">IL Risk: </span>
                          <span className="font-semibold">{(allocation.impermanentLossRisk / 100).toFixed(2)}%</span>
                        </div>
                        <div>
                          <span className="text-gray-500">APY Gap: </span>
                          <span className="font-semibold">
                            {Math.abs(allocation.targetApy - allocation.currentApy) / 100}%
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="text-center text-gray-500 py-8">
                Select a strategy to view allocations
              </div>
            )}
          </TabsContent>

          <TabsContent value="history" className="space-y-4">
            <div className="space-y-3">
              {history.length === 0 ? (
                <div className="text-center text-gray-500 py-8">
                  No rebalance history available
                </div>
              ) : (
                history.map((record, index) => (
                  <Card key={index}>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {record.success ? (
                            <CheckCircle className="h-5 w-5 text-green-500" />
                          ) : (
                            <XCircle className="h-5 w-5 text-red-500" />
                          )}
                          <div>
                            <div className="font-medium">
                              {record.success ? 'Successful' : 'Failed'} Rebalance
                            </div>
                            <div className="text-sm text-gray-500">
                              {new Date(record.timestamp * 1000).toLocaleString()}
                            </div>
                          </div>
                        </div>
                        
                        <div className="text-right">
                          <div className="font-medium">
                            ${Number(record.amountMoved).toLocaleString()}
                          </div>
                          <div className="text-sm text-gray-500">
                            {record.apyBefore / 100}% → {record.apyAfter / 100}%
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </TabsContent>
        </Tabs>

        {/* Transaction Status Banner */}
        {txStatus !== 'idle' && (
          <div className={`mt-4 rounded-md p-3 border text-sm ${
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
                {txStatus === 'submitting' && 'Submitting rebalance transaction…'}
                {txStatus === 'pending' && 'Waiting for confirmation…'}
                {txStatus === 'confirmed' && 'Rebalance confirmed'}
                {txStatus === 'failed' && (txError ?? 'Rebalance failed')}
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
          <div className="mt-4 bg-red-50 border border-red-200 rounded-md p-3">
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
