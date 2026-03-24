import React, { useState, useEffect } from 'react';
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Legend, ComposedChart, Area
} from 'recharts';
import { ApyHistoryTracker, ApyDataPoint } from '../../../sdk/src/apyHistory'; // Adjusted path if necessary

interface APYHistoryChartProps {
  vaultId: string;
  competitorVaultId?: string;
  rpcUrl?: string; // e.g. "https://soroban-testnet.stellar.org"
}

type Timeframe = '7D' | '30D' | '90D';

export const APYHistoryChart: React.FC<APYHistoryChartProps> = ({
  vaultId,
  competitorVaultId,
  rpcUrl = "https://soroban-testnet.stellar.org"
}) => {
  const [timeframe, setTimeframe] = useState<Timeframe>('30D');
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [metrics, setMetrics] = useState<{ avg: number, vol: number } | null>(null);

  useEffect(() => {
    let active = true;
    const fetchData = async () => {
      setLoading(true);
      try {
        const tracker = new ApyHistoryTracker(rpcUrl);
        const days = timeframe === '7D' ? 7 : (timeframe === '30D' ? 30 : 90);

        let primaryData: ApyDataPoint[] = [];
        let compData: ApyDataPoint[] = [];
        let vol = 0;
        let avg = 0;

        if (competitorVaultId) {
          const compResult = await tracker.compareVaults(vaultId, competitorVaultId, days);
          primaryData = compResult.vaultA.history;
          compData = compResult.vaultB.history;
          avg = compResult.vaultA.averageApy;
          vol = compResult.vaultA.volatility;
        } else {
          primaryData = await tracker.getHistoricalAPY(vaultId, days);
          vol = await tracker.getAPYVolatility(vaultId);
          // Calculate approx avg
          avg = primaryData.reduce((acc, curr) => acc + curr.apyBps, 0) / (primaryData.length || 1) / 100;
        }

        if (!active) return;

        // Merge data for rechart, including confidence intervals
        const merged = primaryData.map((d, i) => {
          const apyPercent = d.apyBps / 100;
          const point: any = {
            time: new Date(d.timestamp * 1000).toLocaleDateString() + ' ' + new Date(d.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            APY: apyPercent,
            // Confidence Bands (Simulated via +- Volatility)
            // Simplified using pre-calculated annualized volatility
            lowerBand: Math.max(0, apyPercent - vol),
            upperBand: apyPercent + vol,
          };
          if (compData.length > i) {
            point.CompetitorAPY = compData[i].apyBps / 100;
          }
          return point;
        });

        setData(merged);
        setMetrics({ avg, vol });
      } catch (err) {
        console.error("Failed to load historical APY", err);
      } finally {
        if (active) setLoading(false);
      }
    };
    fetchData();
    return () => { active = false; };
  }, [vaultId, competitorVaultId, timeframe, rpcUrl]);

  return (
    <div className="flex flex-col w-full h-full p-6 bg-gray-900 rounded-xl shadow-lg text-white">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Dynamic APY Oracle</h2>
          <p className="text-sm text-gray-400">On-Chain Historical Tracking</p>
        </div>
        <div className="flex bg-gray-800 rounded-lg p-1">
          {['7D', '30D', '90D'].map((t) => (
            <button
              key={t}
              onClick={() => setTimeframe(t as Timeframe)}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${timeframe === t ? 'bg-indigo-600 text-white shadow-sm' : 'text-gray-400 hover:text-white'
                }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {metrics && (
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div className="bg-gray-800 rounded-lg p-4">
            <p className="text-gray-400 text-sm">Average APY ({timeframe})</p>
            <p className="text-2xl font-bold text-green-400">{metrics.avg.toFixed(2)}%</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-4">
            <p className="text-gray-400 text-sm">Volatility / Risk</p>
            <p className="text-2xl font-bold text-yellow-500">±{metrics.vol.toFixed(2)}%</p>
          </div>
        </div>
      )}

      <div className="w-full h-80">
        {loading ? (
          <div className="w-full h-full flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500"></div>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorBand" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
              <XAxis
                dataKey="time"
                stroke="#9ca3af"
                tick={{ fill: '#9ca3af', fontSize: 12 }}
                tickFormatter={(val) => {
                  const parts = val.split(' ');
                  return timeframe === '7D' ? parts[1] : parts[0];
                }}
              />
              <YAxis
                stroke="#9ca3af"
                tick={{ fill: '#9ca3af', fontSize: 12 }}
                domain={['auto', 'auto']}
                tickFormatter={(val) => `${val}%`}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#1f2937', border: 'none', borderRadius: '8px', color: '#fff' }}
                itemStyle={{ color: '#e5e7eb' }}
              />
              <Legend verticalAlign="top" height={36} />

              {/* Confidence interval band */}
              <Area
                type="monotone"
                dataKey="upperBand"
                stroke="none"
                fill="url(#colorBand)"
                activeDot={false}
              />
              <Area
                type="monotone"
                dataKey="lowerBand"
                stroke="none"
                fill="#1f2937"
                activeDot={false}
              />

              <Line
                type="monotone"
                name={`Vault APY`}
                dataKey="APY"
                stroke="#818cf8"
                strokeWidth={3}
                dot={false}
                activeDot={{ r: 6, fill: '#818cf8', stroke: '#fff', strokeWidth: 2 }}
              />

              {competitorVaultId && (
                <Line
                  type="monotone"
                  name="Competitor APY"
                  dataKey="CompetitorAPY"
                  stroke="#fbbf24"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  dot={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};
