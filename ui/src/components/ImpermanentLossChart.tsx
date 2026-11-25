import React, { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChartSummary } from '@/components/ui/chartSummary';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { buildChartSummary } from '@/lib/chartSummary';
import { formatIlPercent, formatPriceRatio, parsePriceRatioList } from '@/lib/impermanentLossReport';
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
  const [elapsedDays, setElapsedDays] = useState(timeElapsed);
  const [closedRatiosInput, setClosedRatiosInput] = useState('');
  const [volatility, setVolatility] = useState('20');
  const [timePeriod, setTimePeriod] = useState('30');
  const [simulations, setSimulations] = useState('1000');
  const [simulationData, setSimulationData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [historicalData, setHistoricalData] = useState<Array<{ timestamp: number; priceRatio: number; ilPercent: number }>>([]);
  const [useHistorical, setUseHistorical] = useState(false);

  // Calculate current IL
  const currentIL = useMemo(() => {
    return YieldCalculator.calculateImpermanentLoss(Number(initialRatio), Number(priceRatio), elapsedDays);
  }, [priceRatio, initialRatio, elapsedDays]);

  const parsedClosures = useMemo(() => parsePriceRatioList(closedRatiosInput), [closedRatiosInput]);

  const ilBreakdown = useMemo(() => {
    return YieldCalculator.calculateImpermanentLossBreakdown(
      Number(initialRatio),
      Number(priceRatio),
      parsedClosures.values,
      elapsedDays
    );
  }, [priceRatio, initialRatio, parsedClosures.values, elapsedDays]);

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
    if (useHistorical && historicalData.length > 0) {
      return historicalData.map((point) => ({
        day: Math.floor((point.timestamp - (historicalData[0]?.timestamp || point.timestamp)) / (24 * 60 * 60 * 1000)),
        priceRatio: point.priceRatio,
        impermanentLoss: point.ilPercent,
        cumulativeLoss: point.ilPercent,
      }));
    }

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
        cumulativeLoss: il.ilPercent // IL is a one-time deviation, not a linear daily accrual
      });
    }
    
    return data;
  }, [priceRatio, initialRatio, historicalData, useHistorical]);

  const runSimulation = async () => {
    try {
      setLoading(true);
      
      const initial = parseFloat(initialRatio) || 1.0;
      const vol = parseFloat(volatility) || 20;
      const period = parseInt(timePeriod) || 30;
      const sims = parseInt(simulations, 10) || 1000;
      
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

  const fetchHistoricalData = async () => {
    try {
      setLoading(true);
      
      // Issue #133: fetch real price history from an off-chain indexer / API
      // Replace this mock with an actual endpoint once history is indexed.
      const response = await fetch('/api/price-history?pair=TOKEN_A/TOKEN_B&days=365');
      const json = await response.json();
      
      const initial = parseFloat(initialRatio) || 1.0;
      const computed = YieldCalculator.computeHistoricalImpermanentLoss(initial, json.prices);
      setHistoricalData(computed);
      setUseHistorical(true);
    } catch (error) {
      console.error('Failed to fetch historical IL data:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatPercent = (value: number) => formatIlPercent(value);
  const formatRatio = (value: number) => formatPriceRatio(value);

  const priceRatioSummary = buildChartSummary({
    title: 'Impermanent loss by price ratio',
    categoryLabel: 'Price ratio',
    categories: chartData.map((point) => formatRatio(point.priceRatio)),
    series: [
      {
        label: 'Impermanent loss',
        values: chartData.map((point) => point.impermanentLoss),
        format: formatPercent,
      },
      {
        label: 'LP position value',
        values: chartData.map((point) => point.lpValue),
        format: formatRatio,
      },
      {
        label: 'Hold strategy value',
        values: chartData.map((point) => point.holdValue),
        format: formatRatio,
      },
    ],
  });

  const timelineSummary = buildChartSummary({
    title: 'Impermanent loss over time',
    categoryLabel: 'Day',
    categories: timeSeriesData.map((point) => point.day),
    series: [
      {
        label: 'Impermanent loss',
        values: timeSeriesData.map((point) => point.impermanentLoss),
        format: formatPercent,
      },
      {
        label: 'Cumulative effect',
        values: timeSeriesData.map((point) => point.cumulativeLoss),
        format: formatPercent,
      },
    ],
  });

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
                    value={elapsedDays}
                    onChange={(e) => setElapsedDays(parseInt(e.target.value, 10) || 0)}
                  />
                </div>

                <div>
                  <Label htmlFor="closed-ratios">Closed Price Ratios</Label>
                  <Input
                    id="closed-ratios"
                    type="text"
                    placeholder="4, 1"
                    value={closedRatiosInput}
                    onChange={(e) => setClosedRatiosInput(e.target.value)}
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Comma-separated ratios in withdrawal order.
                  </p>
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
                      {Number.isFinite(currentIL.currentPriceRatio / currentIL.initialPriceRatio)
                        ? `${formatRatio(currentIL.currentPriceRatio / currentIL.initialPriceRatio)}x`
                        : 'Unavailable'}
                    </div>
                    <div className="text-sm text-gray-500 mt-1">
                      From {formatRatio(currentIL.initialPriceRatio)} to {formatRatio(currentIL.currentPriceRatio)}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardContent className="p-4">
                    <h3 className="text-lg font-semibold mb-2">Realized vs Unrealized IL</h3>
                    <dl className="grid grid-cols-2 gap-4">
                      <div>
                        <dt className="text-sm text-gray-500">Realized IL</dt>
                        <dd className="text-2xl font-bold">{formatPercent(ilBreakdown.realizedIlPercent)}</dd>
                      </div>
                      <div>
                        <dt className="text-sm text-gray-500">Unrealized IL</dt>
                        <dd className="text-2xl font-bold">{formatPercent(ilBreakdown.unrealizedIlPercent)}</dd>
                      </div>
                    </dl>
                    <p className="text-sm text-gray-500 mt-2">
                      Open position basis: {formatRatio(ilBreakdown.openPriceRatio)}
                    </p>
                    <p className="text-sm text-gray-500 mt-1" aria-live="polite">
                      {ilBreakdown.skippedPriceRatios.length + parsedClosures.invalidEntries.length > 0
                        ? `${ilBreakdown.skippedPriceRatios.length + parsedClosures.invalidEntries.length} invalid price ratio value(s) were ignored.`
                        : 'All price ratio inputs are valid.'}
                    </p>
                  </CardContent>
                </Card>
               </div>
            </div>
          </TabsContent>

          <TabsContent value="chart" className="space-y-4">
            <div className="h-96" role="img" aria-label={priceRatioSummary.accessibleLabel}>
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
            
            <p className="text-sm text-gray-600">
              Every series is identified by name in the legend and in the text summary below.
            </p>
            <ChartSummary summary={priceRatioSummary} announce />
          </TabsContent>

          <TabsContent value="timeline" className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-600">
                <p>This chart shows how impermanent loss evolves over time based on the current price trajectory.</p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant={useHistorical ? "default" : "outline"}
                  size="sm"
                  onClick={fetchHistoricalData}
                  disabled={loading}
                >
                  {loading ? 'Loading...' : 'Fetch Historical IL'}
                </Button>
                <Button
                  variant={!useHistorical ? "default" : "outline"}
                  size="sm"
                  onClick={() => setUseHistorical(false)}
                >
                  Use Simulation
                </Button>
              </div>
            </div>
            <div className="h-96" role="img" aria-label={timelineSummary.accessibleLabel}>
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
            
            <ChartSummary summary={timelineSummary} announce />
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
