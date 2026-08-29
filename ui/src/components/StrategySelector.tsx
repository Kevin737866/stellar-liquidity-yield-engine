import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Shield, Zap, Target, TrendingUp, AlertTriangle, CheckCircle } from 'lucide-react';
import { YieldStrategy, RiskLevel } from 'stellar-liquidity-yield-engine-sdk';
import { StrategyRegistryClient } from 'stellar-liquidity-yield-engine-sdk';

interface StrategySelectorProps {
  onStrategySelect?: (strategy: YieldStrategy) => void;
  selectedStrategy?: YieldStrategy | null;
  network?: 'testnet' | 'mainnet';
}

/** Build a minimal NetworkConfig for the registry client from a network string. */
function networkConfigFor(network: 'testnet' | 'mainnet') {
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
  };
}

export const StrategySelector: React.FC<StrategySelectorProps> = ({
  onStrategySelect,
  selectedStrategy,
  network = 'testnet'
}) => {
  const [strategies, setStrategies] = useState<YieldStrategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadStrategies();
  }, [network]);

  /**
   * Fetch active strategies from the strategy registry via the SDK.
   *
   * `StrategyRegistryClient.fetchActiveStrategies()` attempts a real contract
   * call first and falls back to built-in defaults when the contract is not
   * yet deployed — so this always returns data without hard-coding anything
   * in the component.
   */
  const loadStrategies = async () => {
    try {
      setLoading(true);
      setError(null);

      const registryClient = new StrategyRegistryClient(networkConfigFor(network));
      const activeStrategies = await registryClient.fetchActiveStrategies();
      setStrategies(activeStrategies);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load strategies');
    } finally {
      setLoading(false);
    }
  };

  const handleStrategySelect = (strategyId: string) => {
    const strategy = strategies.find(s => s.strategyId.toString() === strategyId);
    if (strategy && onStrategySelect) {
      onStrategySelect(strategy);
    }
  };

  const getRiskIcon = (riskLevel: number) => {
    switch (riskLevel) {
      case 1: return <Shield className="h-5 w-5" />;
      case 2: return <Target className="h-5 w-5" />;
      case 3: return <Zap className="h-5 w-5" />;
      default: return <Shield className="h-5 w-5" />;
    }
  };

  const getRiskColor = (riskLevel: number) => {
    switch (riskLevel) {
      case 1: return 'bg-green-100 text-green-800 border-green-200';
      case 2: return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 3: return 'bg-red-100 text-red-800 border-red-200';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getRiskText = (riskLevel: number) => {
    switch (riskLevel) {
      case 1: return 'Conservative';
      case 2: return 'Balanced';
      case 3: return 'Aggressive';
      default: return 'Unknown';
    }
  };

  const getLatestPerformance = (strategy: YieldStrategy) => {
    return strategy.performanceHistory.length > 0 
      ? strategy.performanceHistory[strategy.performanceHistory.length - 1]
      : null;
  };

  if (loading) {
    return (
      <Card className="w-full max-w-4xl mx-auto">
        <CardContent className="p-6">
          <div className="flex items-center justify-center h-32 gap-3">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
            <span className="text-gray-500">Loading strategies…</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-4xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-6 w-6" />
          Select Yield Strategy
        </CardTitle>
      </CardHeader>
      
      <CardContent className="space-y-6">
        {strategies.length === 0 && !error ? (
          <div className="text-center text-gray-500 py-8">
            No active strategies found.
          </div>
        ) : (
          <RadioGroup 
            value={selectedStrategy?.strategyId.toString() || ''}
            onValueChange={handleStrategySelect}
          >
            <div className="space-y-4">
              {strategies.map((strategy) => {
                const latestPerformance = getLatestPerformance(strategy);
                const isSelected = selectedStrategy?.strategyId === strategy.strategyId;
                
                return (
                  <div key={strategy.strategyId} className="relative">
                    <RadioGroupItem
                      value={strategy.strategyId.toString()}
                      id={`strategy-${strategy.strategyId}`}
                      className="sr-only"
                    />
                    <Label
                      htmlFor={`strategy-${strategy.strategyId}`}
                      className={`cursor-pointer block p-4 border-2 rounded-lg transition-all ${
                        isSelected 
                          ? 'border-blue-500 bg-blue-50' 
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-full ${getRiskColor(strategy.riskLevel)}`}>
                            {getRiskIcon(strategy.riskLevel)}
                          </div>
                          <div>
                            <h3 className="text-lg font-semibold">{strategy.name}</h3>
                            <p className="text-sm text-gray-600 mt-1">{strategy.description}</p>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          <Badge className={getRiskColor(strategy.riskLevel)}>
                            {getRiskText(strategy.riskLevel)}
                          </Badge>
                          {isSelected && (
                            <CheckCircle className="h-5 w-5 text-blue-500" />
                          )}
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                          <div className="text-sm text-gray-500">Current APY</div>
                          <div className="text-lg font-semibold text-green-600">
                            {latestPerformance ? (latestPerformance.netApy / 100).toFixed(2) : '0.00'}%
                          </div>
                        </div>
                        
                        <div>
                          <div className="text-sm text-gray-500">Volatility</div>
                          <div className="text-lg font-semibold">
                            {latestPerformance ? (latestPerformance.volatility / 100).toFixed(2) : '0.00'}%
                          </div>
                        </div>
                        
                        <div>
                          <div className="text-sm text-gray-500">Min Investment</div>
                          <div className="text-lg font-semibold">
                            ${(Number(strategy.minInvestment) / 1000000).toFixed(0)}
                          </div>
                        </div>
                        
                        <div>
                          <div className="text-sm text-gray-500">Management Fee</div>
                          <div className="text-lg font-semibold">
                            {(strategy.feeStructure.managementFee / 100).toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      
                      {latestPerformance && (
                        <div className="mt-4 pt-4 border-t">
                          <div className="flex items-center justify-between text-sm">
                            <div className="flex items-center gap-4">
                              <span className="text-gray-500">Sharpe Ratio:</span>
                              <span className="font-semibold">{(latestPerformance.sharpeRatio / 10000).toFixed(2)}</span>
                            </div>
                            <div className="flex items-center gap-4">
                              <span className="text-gray-500">TVL:</span>
                              <span className="font-semibold">
                                ${(Number(latestPerformance.totalValue) / 1000000).toFixed(0)}M
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <TrendingUp className="h-4 w-4 text-green-500" />
                              <span className="text-green-600 font-semibold">
                                Active
                              </span>
                            </div>
                          </div>
                        </div>
                      )}
                    </Label>
                  </div>
                );
              })}
            </div>
          </RadioGroup>
        )}

        {selectedStrategy && (
          <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <h4 className="font-semibold text-blue-900 mb-2">Selected Strategy Summary</h4>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div>
                <span className="text-blue-700">Strategy:</span>
                <span className="ml-2 font-medium">{selectedStrategy.name}</span>
              </div>
              <div>
                <span className="text-blue-700">Risk Level:</span>
                <span className="ml-2 font-medium">{getRiskText(selectedStrategy.riskLevel)}</span>
              </div>
              <div>
                <span className="text-blue-700">Expected APY:</span>
                <span className="ml-2 font-medium">
                  {getLatestPerformance(selectedStrategy) 
                    ? `${(getLatestPerformance(selectedStrategy)!.netApy / 100).toFixed(2)}%`
                    : 'N/A'
                  }
                </span>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3">
            <div className="flex items-center gap-2 text-sm text-red-600">
              <AlertTriangle className="h-4 w-4" />
              {error}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
