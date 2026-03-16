import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Shield, Zap, Target, TrendingUp, AlertTriangle, CheckCircle } from 'lucide-react';
import { YieldStrategy, RiskLevel } from 'stellar-liquidity-yield-engine-sdk';

interface StrategySelectorProps {
  onStrategySelect?: (strategy: YieldStrategy) => void;
  selectedStrategy?: YieldStrategy | null;
  network?: 'testnet' | 'mainnet';
}

export const StrategySelector: React.FC<StrategySelectorProps> = ({
  onStrategySelect,
  selectedStrategy,
  network = 'testnet'
}) => {
  const [strategies, setStrategies] = useState<YieldStrategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Mock strategies for demonstration
  const mockStrategies: YieldStrategy[] = [
    {
      strategyId: 1,
      name: 'Conservative Growth',
      description: 'Low-risk strategy focusing on stable pairs with minimal impermanent loss',
      creator: 'GADMIN123456789',
      riskLevel: 1,
      minInvestment: 1000000n, // 1000 USD
      maxInvestment: 100000000n, // 100,000 USD
      feeStructure: {
        managementFee: 500, // 5%
        performanceFee: 1000, // 10%
        depositFee: 50, // 0.5%
        withdrawalFee: 100 // 1%
      },
      performanceHistory: [
        { timestamp: Date.now() - 86400000, totalValue: 1050000n, netApy: 800, volatility: 500, sharpeRatio: 12000 },
        { timestamp: Date.now() - 172800000, totalValue: 1040000n, netApy: 750, volatility: 450, sharpeRatio: 11000 },
        { timestamp: Date.now() - 259200000, totalValue: 1030000n, netApy: 700, volatility: 400, sharpeRatio: 10000 }
      ],
      isActive: true,
      createdAt: Date.now() - 259200000,
      updatedAt: Date.now() - 86400000
    },
    {
      strategyId: 2,
      name: 'Balanced Portfolio',
      description: 'Medium-risk strategy with diversified exposure across multiple pools',
      creator: 'GADMIN123456789',
      riskLevel: 2,
      minInvestment: 500000n, // 500 USD
      maxInvestment: 500000000n, // 500,000 USD
      feeStructure: {
        managementFee: 800, // 8%
        performanceFee: 1500, // 15%
        depositFee: 75, // 0.75%
        withdrawalFee: 150 // 1.5%
      },
      performanceHistory: [
        { timestamp: Date.now() - 86400000, totalValue: 1120000n, netApy: 1500, volatility: 1200, sharpeRatio: 8000 },
        { timestamp: Date.now() - 172800000, totalValue: 1100000n, netApy: 1400, volatility: 1100, sharpeRatio: 7500 },
        { timestamp: Date.now() - 259200000, totalValue: 1080000n, netApy: 1300, volatility: 1000, sharpeRatio: 7000 }
      ],
      isActive: true,
      createdAt: Date.now() - 259200000,
      updatedAt: Date.now() - 86400000
    },
    {
      strategyId: 3,
      name: 'Aggressive Yield',
      description: 'High-risk strategy targeting maximum yields through volatile asset pairs',
      creator: 'GADMIN123456789',
      riskLevel: 3,
      minInvestment: 100000n, // 100 USD
      maxInvestment: 1000000000n, // 1,000,000 USD
      feeStructure: {
        managementFee: 1200, // 12%
        performanceFee: 2000, // 20%
        depositFee: 100, // 1%
        withdrawalFee: 200 // 2%
      },
      performanceHistory: [
        { timestamp: Date.now() - 86400000, totalValue: 1250000n, netApy: 2500, volatility: 2500, sharpeRatio: 6000 },
        { timestamp: Date.now() - 172800000, totalValue: 1200000n, netApy: 2200, volatility: 2300, sharpeRatio: 5500 },
        { timestamp: Date.now() - 259200000, totalValue: 1150000n, netApy: 2000, volatility: 2000, sharpeRatio: 5000 }
      ],
      isActive: true,
      createdAt: Date.now() - 259200000,
      updatedAt: Date.now() - 86400000
    }
  ];

  useEffect(() => {
    loadStrategies();
  }, [network]);

  const loadStrategies = async () => {
    try {
      setLoading(true);
      setError(null);
      
      // In a real implementation, this would fetch from the strategy registry
      // For now, use mock data
      setStrategies(mockStrategies);
    } catch (err: any) {
      setError(err.message);
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
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
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
