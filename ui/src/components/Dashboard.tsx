import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Coins,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';

const yieldTrend = [
  { day: 'Mon', apy: 6.8 },
  { day: 'Tue', apy: 7.1 },
  { day: 'Wed', apy: 7.4 },
  { day: 'Thu', apy: 7.2 },
  { day: 'Fri', apy: 7.9 },
  { day: 'Sat', apy: 8.2 },
  { day: 'Sun', apy: 8.4 },
];

const positions = [
  {
    pool: 'XLM / USDC',
    allocation: 45,
    apy: 8.4,
    status: 'healthy' as const,
    value: '$124,500',
  },
  {
    pool: 'XLM / EURC',
    allocation: 30,
    apy: 7.2,
    status: 'healthy' as const,
    value: '$83,000',
  },
  {
    pool: 'AQUA / USDC',
    allocation: 25,
    apy: 5.9,
    status: 'watch' as const,
    value: '$69,200',
  },
];

const statusVariant = {
  healthy: 'success',
  watch: 'warning',
} as const;

const riskMetrics = [
  { label: 'Impermanent loss exposure', value: 32, detail: 'Moderate' },
  { label: 'Concentration risk', value: 45, detail: 'Moderate' },
  { label: 'Oracle deviation', value: 12, detail: 'Low' },
  { label: 'Liquidity depth', value: 78, detail: 'Strong' },
];

export function Dashboard() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white" role="banner">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-white">
              <Coins aria-hidden="true" className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-medium text-slate-500">Stellar</p>
              <p className="text-lg font-semibold text-slate-900">Liquidity Yield Engine</p>
            </div>
          </div>
          <nav aria-label="Primary">
            <ul className="flex flex-wrap gap-4 text-sm font-medium text-slate-600">
              <li>
                <a className="hover:text-slate-900" href="#overview">
                  Overview
                </a>
              </li>
              <li>
                <a className="hover:text-slate-900" href="#positions">
                  Positions
                </a>
              </li>
              <li>
                <a className="hover:text-slate-900" href="#risk">
                  Risk
                </a>
              </li>
              <li>
                <a className="hover:text-slate-900" href="#activity">
                  Activity
                </a>
              </li>
            </ul>
          </nav>
        </div>
      </header>

      <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-wide text-slate-500">Dashboard</p>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Liquidity overview</h1>
            <p className="mt-1 text-sm text-slate-600">
              Monitor positions, yield, and risk across your Stellar liquidity pools.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-slate-600" aria-live="polite">
            <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden="true" />
            <span>All systems operational</span>
          </div>
        </div>

        <section id="overview" aria-labelledby="overview-heading" className="mt-8">
          <h2 id="overview-heading" className="sr-only">
            Account overview
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-600">
                  <Wallet aria-hidden="true" className="h-4 w-4" />
                  Total value locked
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-slate-900">$276,700</p>
                <p className="mt-1 text-xs text-slate-500">Across 3 active pools</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-600">
                  <Activity aria-hidden="true" className="h-4 w-4" />
                  Net APY
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-slate-900">8.4%</p>
                <p className="mt-1 text-xs text-green-700">+0.6% over 7 days</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-600">
                  <ArrowUpRight aria-hidden="true" className="h-4 w-4" />
                  24h yield
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-slate-900">$63.72</p>
                <p className="mt-1 text-xs text-slate-500">Auto-compounded daily</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-600">
                  <ShieldCheck aria-hidden="true" className="h-4 w-4" />
                  Risk score
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold text-slate-900">Low</p>
                <p className="mt-1 text-xs text-slate-500">Within configured limits</p>
              </CardContent>
            </Card>
          </div>
        </section>

        <div className="mt-8 grid gap-8 lg:grid-cols-[1.5fr_1fr]">
          <section id="positions" aria-labelledby="positions-heading">
            <h2 id="positions-heading" className="text-xl font-semibold text-slate-900">
              Positions
            </h2>
            <Card className="mt-3">
              <CardContent className="p-0">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">
                    Active liquidity positions with allocation, APY, status, and value.
                  </caption>
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Pool
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Allocation
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        APY
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">
                        Value
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {positions.map((position) => (
                      <tr key={position.pool}>
                        <th scope="row" className="px-4 py-3 font-medium text-slate-900">
                          {position.pool}
                        </th>
                        <td className="px-4 py-3 text-slate-600">{position.allocation}%</td>
                        <td className="px-4 py-3 text-slate-600">{position.apy.toFixed(1)}%</td>
                        <td className="px-4 py-3">
                          <Badge variant={statusVariant[position.status]}>
                            {position.status === 'healthy' ? 'Healthy' : 'Watch'}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right text-slate-900">{position.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </section>

          <section id="risk" aria-labelledby="risk-heading">
            <h2 id="risk-heading" className="text-xl font-semibold text-slate-900">
              Risk
            </h2>
            <Card className="mt-3">
              <CardContent className="space-y-5 p-4">
                {riskMetrics.map((metric) => (
                  <div key={metric.label}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-slate-700">{metric.label}</span>
                      <span className="text-slate-500">{metric.detail}</span>
                    </div>
                    <Progress
                      className="mt-2"
                      value={metric.value}
                      label={metric.label}
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        </div>

        <section id="activity" aria-labelledby="activity-heading" className="mt-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 id="activity-heading" className="text-xl font-semibold text-slate-900">
                Yield trend
              </h2>
              <p className="text-sm text-slate-600">Net APY over the last seven days.</p>
            </div>
            <Badge variant="outline">
              <ArrowDownToLine aria-hidden="true" className="mr-1 h-3 w-3" />
              Auto-compound on
            </Badge>
          </div>
          <Card className="mt-3">
            <CardContent className="p-4">
              <div
                className="flex h-64 items-end gap-3"
                role="img"
                aria-label="Bar chart of net APY from 6.8% on Monday to 8.4% on Sunday."
              >
                {yieldTrend.map((point) => {
                  const height = ((point.apy - 6) / 3) * 100;
                  return (
                    <div key={point.day} className="flex h-full flex-1 flex-col justify-end gap-2">
                      <span className="text-center text-xs font-medium text-slate-600">
                        {point.apy}%
                      </span>
                      <div
                        className="w-full rounded-t bg-slate-800"
                        style={{ height: `${Math.max(height, 4)}%` }}
                        aria-hidden="true"
                      />
                      <span className="text-center text-xs text-slate-500">{point.day}</span>
                    </div>
                  );
                })}
              </div>
              <table className="sr-only">
                <caption>Net APY by day</caption>
                <thead>
                  <tr>
                    <th scope="col">Day</th>
                    <th scope="col">Net APY</th>
                  </tr>
                </thead>
                <tbody>
                  {yieldTrend.map((point) => (
                    <tr key={point.day}>
                      <th scope="row">{point.day}</th>
                      <td>{point.apy}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white" role="contentinfo">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <p>Stellar Liquidity Yield Engine</p>
          <p>Built for transparent, auditable liquidity management.</p>
        </div>
      </footer>
    </div>
  );
}
