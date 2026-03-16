import React, { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts';
import { TrendingDown, TrendingUp, Calculator, Activity } from 'lucide-react';
import { YieldCalculator } from 'stellar-liquidity-yield-engine-sdk';

interface ImpermanentLossChartProps {
  initialPriceRatio?: number;
  currentPriceRatio?: number;
  timeElapsed?: number;
}

export const ImpermanentLossChart: React.FC<ImpermanentLossChartProps> = ({
  initialPriceRatio = 1.0,
  currentPriceRatio = 1.0,
  timeElapsed = 0
}) => {
  const [priceRatio, setPriceRatio] = useState(currentPriceRatio.toString());
  const [initialRatio, setInitialRatio] = useState(initialPriceRatio.toString());
  const [volatility, setVolatility] = useState('20');
  const [timePeriod, setTimePeriod] = useState('30');
  const [simulations, setSimulations] = useState(1000);
  const [simulationData, setSimulationData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  // Calculate current IL
  const currentIL = useMemo(() => {
    const ratio = parseFloat(priceRatio) || 1.0;
    const initial = parseFloat(initialRatio) || 1.0;
    return YieldCalculator.calculateImpermanentLoss(initial, ratio, timeElapsed);
  }, [priceRatio, initialRatio, timeElapsed]);

  // Generate chart data for different price ratios
  const chartData = useMemo(() => {
    const data = [];
    const initial = parseFloat(initialRatio) || 1.0;
    
    for (let ratio = 0.2; ratio <= 3.0; ratio += 0.1) {
      const il = YieldCalculator.calculateImpermanentLoss(initial, ratio, 0);
      data.push({
        priceRatio: ratio,
        impermanentLoss: il.ilPercent,
        holdValue: 100, // Hold strategy value
        lpValue: 100 * (1 + il.ilPercent / 100) // LP value with IL
      });
    }
    
    return data;
  }, [initialRatio]);

  // Generate time series data
  const timeSeriesData = useMemo(() => {
    const data = [];
    const initial = parseFloat(initialRatio) || 1.0;
    const current = parseFloat(priceRatio) || 1.0;
    
    for (let day = 0; day <= 365; day += 7) {
      const ratio = initial + (current - initial) * (day / 365);
      const il = YieldCalculator.calculateImpermanentLoss(initial, ratio, day);
      data.push({
        day,
        priceRatio: ratio,
        impermanentLoss: il.ilPercent,
        cumulativeLoss: il.ilPercent * (day / 365) // Simplified cumulative effect
      });
    }
    
    return data;
  }, [priceRatio, initialRatio]);

  const runSimulation = async () => {
    try {
      setLoading(true);
      
      const initial = parseFloat(initialRatio) || 1.0;
      const vol = parseFloat(volatility) || 20;
      const period = parseInt(timePeriod) || 30;
      const sims = parseInt(simulations) || 1000;
      
      const result = YieldCalculator.simulateImpermanentLoss(
        initial,
        vol,
        period,
        sims
      );
      
      setSimulationData(result);
    } catch (error) {
      console.error('Simulation failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatPercent = (value: number) => `${value.toFixed(2)}%`;
  const formatRatio = (value: number) => value.toFixed(2);

  return (
    <Card className="w-full max-w-6xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingDown className="h-6 w-6" />
          Impermanent Loss Analysis
        </CardTitle>
      </CardHeader>
      
      <CardContent>
        <Tabs defaultValue="current" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="current">Current IL</TabsTrigger>
            <TabsTrigger value="chart">IL Chart</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="simulation">Monte Carlo</TabsTrigger>
          </TabsList>

          <TabsContent value="current" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div>
                  <Label htmlFor="initial-ratio">Initial Price Ratio</Label>
                  <Input
                    id="initial-ratio"
                    type="number"
                    step="0.1"
                    value={initialRatio}
                    onChange={(e) => setInitialRatio(e.target.value)}
                  />
                </div>
                
                <div>
                  <Label htmlFor="current-ratio">Current Price Ratio</Label>
                  <Input
                    id="current-ratio"
                    type="number"
                    step="0.1"
                    value={priceRatio}
                    onChange={(e) => setPriceRatio(e.target.value)}
                  />
                </div>
                
                <div>
                  <Label htmlFor="time-elapsed">Time Elapsed (days)</Label>
                  <Input
                    id="time-elapsed"
                    type="number"
                    value={timeElapsed}
                    onChange={(e) => setTimeElapsed(parseInt(e.target.value) || 0)}
                  />
                </div>
              </div>
              
              <div className="space-y-4">
                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-lg font-semibold mb-2">Current Impermanent Loss</h3>
                    <div className={`text-3xl font-bold ${currentIL.ilPercent < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {formatPercent(currentIL.ilPercent)}
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      {currentIL.ilPercent < 0 ? 'Loss' : 'Gain'} compared to hold strategy
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-lg font-semibold mb-2">Price Change</h3>
                    <div className="text-2xl font-bold">
                      {formatRatio(currentIL.currentPriceRatio / currentIL.initialPriceRatio)}x
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      From {formatRatio(currentIL.initialPriceRatio)} to {formatRatio(currentIL.currentPriceRatio)}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="chart" className="space-y-4">
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="priceRatio" 
                    label={{ value: 'Price Ratio', position: 'insideBottom', offset: -5 }}
                  />
                  <YAxis 
                    label={{ value: 'Value / Loss (%)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip 
                    formatter={(value: number) => formatPercent(value)}
                    labelFormatter={(label) => `Price Ratio: ${formatRatio(label)}`}
                  />
                  <Legend />
                  <Line 
                    type="monotone" 
                    dataKey="impermanentLoss" 
                    stroke="#ef4444" 
                    strokeWidth={2}
                    name="Impermanent Loss"
                  />
                  <Line 
                    type="monotone" 
                    dataKey="lpValue" 
                    stroke="#3b82f6" 
                    strokeWidth={2}
                    name="LP Position Value"
                  />
                  <Line 
                    type="monotone" 
                    dataKey="holdValue" 
                    stroke="#10b981" 
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    name="Hold Strategy"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            
            <div className="text-sm text-gray-600">
              <p>This chart shows impermanent loss across different price ratios.</p>
              <p>The red line represents the loss percentage, while the blue line shows the LP position value relative to holding.</p>
            </div>
          </TabsContent>

          <TabsContent value="timeline" className="space-y-4">
            <div className="h-96">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeSeriesData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis 
                    dataKey="day" 
                    label={{ value: 'Days', position: 'insideBottom', offset: -5 }}
                  />
                  <YAxis 
                    label={{ value: 'Loss (%)', angle: -90, position: 'insideLeft' }}
                  />
                  <Tooltip 
                    formatter={(value: number) => formatPercent(value)}
                    labelFormatter={(label) => `Day ${label}`}
                  />
                  <Legend />
                  <Area 
                    type="monotone" 
                    dataKey="impermanentLoss" 
                    stroke="#ef4444" 
                    fill="#ef4444"
                    fillOpacity={0.3}
                    name="Impermanent Loss"
                  />
                  <Area 
                    type="monotone" 
                    dataKey="cumulativeLoss" 
                    stroke="#f59e0b" 
                    fill="#f59e0b"
                    fillOpacity={0.3}
                    name="Cumulative Effect"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            
            <div className="text-sm text-gray-600">
              <p>This chart shows how impermanent loss evolves over time based on the current price trajectory.</p>
            </div>
          </TabsContent>

          <TabsContent value="simulation" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <Label htmlFor="volatility">Volatility (%)</Label>
                <Input
                  id="volatility"
                  type="number"
                  value={volatility}
                  onChange={(e) => setVolatility(e.target.value)}
                />
              </div>
              
              <div>
                <Label htmlFor="time-period">Time Period (days)</Label>
                <Input
                  id="time-period"
                  type="number"
                  value={timePeriod}
                  onChange={(e) => setTimePeriod(e.target.value)}
                />
              </div>
              
              <div>
                <Label htmlFor="simulations">Simulations</Label>
                <Input
                  id="simulations"
                  type="number"
                  value={simulations}
                  onChange={(e) => setSimulations(e.target.value)}
                />
              </div>
              
              <div className="flex items-end">
                <Button 
                  onClick={runSimulation}
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? (
                    <>
                      <Activity className="h-4 w-4 mr-2 animate-spin" />
                      Running...
                    </>
                  ) : (
                    <>
                      <Calculator className="h-4 w-4 mr-2" />
                      Run Simulation
                    </>
                  )}
                </Button>
              </div>
            </div>
            
            {simulationData && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-lg font-semibold mb-2">Average IL</h3>
                    <div className="text-2xl font-bold text-yellow-600">
                      {formatPercent(simulationData.averageIl)}
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-lg font-semibold mb-2">Worst Case IL</h3>
                    <div className="text-2xl font-bold text-red-600">
                      {formatPercent(simulationData.worstCaseIl)}
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-lg font-semibold mb-2">Best Case IL</h3>
                    <div className="text-2xl font-bold text-green-600">
                      {formatPercent(simulationData.bestCaseIl)}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
};
