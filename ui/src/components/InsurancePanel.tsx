import React, { useState, useCallback, useMemo } from "react";
import { getClaimableAmount } from "../../../sdk/src/insurance";
import type {
  InsurancePolicy,
  PremiumQuote,
  ReserveStats,
  CoverageDuration,
} from "../../../sdk/src/insurance";

// ─── Mock data for standalone demo ───────────────────────────────────────────
// In production, these values come from the SDK / on-chain calls.

const MOCK_RESERVE_STATS: ReserveStats = {
  totalPremiumsCollected: 58_320_000n,
  totalClaimsPaid: 12_450_000n,
  currentReserve: 45_870_000n,
  activeCoverage: 28_500_000n,
  policyCount: 312n,
  collateralizationRatioBps: 16_095, // ~161%
};

const MOCK_ACTIVE_POLICY: InsurancePolicy = {
  policyId: 42n,
  owner: "GABC...XYZ",
  coverageAmount: 5_000_000n,
  premiumPaid: 25_000n,
  startPriceRatio: 1_000_000n, // sqrt(1.0) * 1e6
  startTime: Math.floor(Date.now() / 1000) - 10 * 24 * 3600,
  expiry: Math.floor(Date.now() / 1000) + 20 * 24 * 3600,
  claimed: false,
  autoRenew: true,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DURATION_DAYS: Record<CoverageDuration, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(2) + "%";
}

function formatAmount(val: bigint, decimals = 7): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = val / divisor;
  const frac = (val % divisor).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole.toLocaleString()}.${frac}`;
}

function daysRemaining(expiry: number): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, Math.ceil((expiry - now) / 86400));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface SectionCardProps {
  title: string;
  children: React.ReactNode;
  className?: string;
}

const SectionCard: React.FC<SectionCardProps> = ({ title, children, className = "" }) => (
  <div className={`insurance-card ${className}`}>
    <h3 className="insurance-card__title">{title}</h3>
    {children}
  </div>
);

// ─── Premium Calculator ───────────────────────────────────────────────────────

interface PremiumCalculatorProps {
  onQuoteGenerated?: (quote: PremiumQuote) => void;
}

const PremiumCalculator: React.FC<PremiumCalculatorProps> = ({ onQuoteGenerated }) => {
  const [coverageAmount, setCoverageAmount] = useState<string>("1000");
  const [duration, setDuration] = useState<CoverageDuration>("30d");
  const [volatilityBps, setVolatilityBps] = useState<number>(8000);
  const [correlationBps, setCorrelationBps] = useState<number>(5000);

  // Compute quote client-side using the SDK formula (matches on-chain logic)
  const quote = useMemo<PremiumQuote | null>(() => {
    const amount = parseFloat(coverageAmount);
    if (isNaN(amount) || amount <= 0) return null;

    const coverageAmountUnits = BigInt(Math.round(amount * 1e7));
    const coveragePeriodSecs = DURATION_DAYS[duration] * 86400;

    // Duration factor: sqrt(period / 30d_baseline) * 1000
    const durationFactor = Math.sqrt(coveragePeriodSecs / (30 * 86400)) * 1000;

    // Volatility * (1 - correlation)
    const corrAdjusted = volatilityBps * (1 - correlationBps / 10000);

    // Effective rate in bps
    let effectiveRate = 50 + Math.round((corrAdjusted * durationFactor) / 100_000);
    effectiveRate = Math.min(effectiveRate, 500);

    const premiumAmount = (coverageAmountUnits * BigInt(effectiveRate)) / 10000n;

    const q: PremiumQuote = {
      premiumAmount,
      coveragePeriod: coveragePeriodSecs,
      coverageAmount: coverageAmountUnits,
      effectiveRateBps: effectiveRate,
      reserveRatio: MOCK_RESERVE_STATS.collateralizationRatioBps,
    };
    return q;
  }, [coverageAmount, duration, volatilityBps, correlationBps]);

  return (
    <SectionCard title="💰 Premium Calculator">
      <div className="calc-grid">
        <label className="calc-label">
          Coverage Amount (XLM)
          <input
            className="calc-input"
            type="number"
            min="1"
            value={coverageAmount}
            onChange={(e) => setCoverageAmount(e.target.value)}
          />
        </label>

        <label className="calc-label">
          Coverage Duration
          <div className="duration-tabs">
            {(["7d", "30d", "90d"] as CoverageDuration[]).map((d) => (
              <button
                key={d}
                className={`duration-tab ${duration === d ? "active" : ""}`}
                onClick={() => setDuration(d)}
              >
                {d}
              </button>
            ))}
          </div>
        </label>

        <label className="calc-label">
          Pool Volatility (annual)
          <div className="slider-row">
            <input
              type="range"
              min={1000}
              max={20000}
              step={500}
              value={volatilityBps}
              onChange={(e) => setVolatilityBps(Number(e.target.value))}
            />
            <span className="slider-val">{bpsToPercent(volatilityBps)}</span>
          </div>
        </label>

        <label className="calc-label">
          Asset Correlation
          <div className="slider-row">
            <input
              type="range"
              min={0}
              max={10000}
              step={500}
              value={correlationBps}
              onChange={(e) => setCorrelationBps(Number(e.target.value))}
            />
            <span className="slider-val">{bpsToPercent(correlationBps)}</span>
          </div>
        </label>
      </div>

      {quote && (
        <div className="quote-result">
          <div className="quote-row">
            <span>Premium Rate</span>
            <strong>{bpsToPercent(quote.effectiveRateBps)}</strong>
          </div>
          <div className="quote-row">
            <span>Premium Amount</span>
            <strong>{formatAmount(quote.premiumAmount)} XLM</strong>
          </div>
          <div className="quote-row">
            <span>Coverage Amount</span>
            <strong>{formatAmount(quote.coverageAmount)} XLM</strong>
          </div>
          <div className="quote-row">
            <span>Duration</span>
            <strong>{DURATION_DAYS[duration]} days</strong>
          </div>
          <button
            className="buy-btn"
            onClick={() => onQuoteGenerated?.(quote)}
          >
            🛡️ Purchase Policy
          </button>
        </div>
      )}
    </SectionCard>
  );
};

// ─── Policy Management ────────────────────────────────────────────────────────

interface PolicyManagementProps {
  policy: InsurancePolicy;
  currentPriceRatioScaled: bigint;
}

const PolicyManagement: React.FC<PolicyManagementProps> = ({
  policy,
  currentPriceRatioScaled,
}) => {
  const claimable = getClaimableAmount(policy, currentPriceRatioScaled);
  const days = daysRemaining(policy.expiry);
  const isExpired = days === 0;

  return (
    <SectionCard title="📋 Active Policy">
      <div className="policy-header">
        <span className="policy-id">Policy #{policy.policyId.toString()}</span>
        <span className={`policy-status ${isExpired ? "expired" : "active"}`}>
          {isExpired ? "Expired" : `${days}d remaining`}
        </span>
        {policy.autoRenew && <span className="auto-renew-badge">Auto-Renew ✓</span>}
      </div>

      <div className="policy-grid">
        <div className="policy-stat">
          <span>Coverage</span>
          <strong>{formatAmount(policy.coverageAmount)} XLM</strong>
        </div>
        <div className="policy-stat">
          <span>Premium Paid</span>
          <strong>{formatAmount(policy.premiumPaid)} XLM</strong>
        </div>
        <div className="policy-stat">
          <span>Claimable IL</span>
          <strong className={claimable > 0n ? "claimable-positive" : ""}>
            {claimable > 0n ? `+${formatAmount(claimable)} XLM` : "—"}
          </strong>
        </div>
      </div>

      <div className="policy-actions">
        {isExpired && claimable > 0n && (
          <button className="claim-btn">💸 Claim {formatAmount(claimable)} XLM</button>
        )}
        {!isExpired && (
          <button className="renew-btn">🔄 Renew Policy</button>
        )}
      </div>
    </SectionCard>
  );
};

// ─── Reserve Pool Transparency ────────────────────────────────────────────────

const ReservePoolPanel: React.FC<{ stats: ReserveStats }> = ({ stats }) => {
  const utilizationPct = stats.activeCoverage > 0n
    ? Number((stats.activeCoverage * 100n) / (stats.currentReserve > 0n ? stats.currentReserve : 1n))
    : 0;

  const collateralPct = (stats.collateralizationRatioBps / 100).toFixed(1);
  const isHealthy = stats.collateralizationRatioBps >= 15000;

  return (
    <SectionCard title="🏦 Reserve Pool">
      <div className="reserve-grid">
        <div className="reserve-stat">
          <span>Total Reserve</span>
          <strong>{formatAmount(stats.currentReserve)} XLM</strong>
        </div>
        <div className="reserve-stat">
          <span>Active Coverage</span>
          <strong>{formatAmount(stats.activeCoverage)} XLM</strong>
        </div>
        <div className="reserve-stat">
          <span>Total Premiums</span>
          <strong>{formatAmount(stats.totalPremiumsCollected)} XLM</strong>
        </div>
        <div className="reserve-stat">
          <span>Claims Paid</span>
          <strong>{formatAmount(stats.totalClaimsPaid)} XLM</strong>
        </div>
        <div className="reserve-stat">
          <span>Active Policies</span>
          <strong>{stats.policyCount.toString()}</strong>
        </div>
        <div className="reserve-stat">
          <span>Collateralization</span>
          <strong className={isHealthy ? "health-good" : "health-warn"}>
            {collateralPct}% {isHealthy ? "✅" : "⚠️"}
          </strong>
        </div>
      </div>

      <div className="utilization-bar-wrap">
        <div className="utilization-label">
          <span>Reserve Utilization</span>
          <span>{Math.min(utilizationPct, 100).toFixed(1)}%</span>
        </div>
        <div className="utilization-bar">
          <div
            className={`utilization-fill ${utilizationPct > 80 ? "warn" : "ok"}`}
            style={{ width: `${Math.min(utilizationPct, 100)}%` }}
          />
        </div>
      </div>
    </SectionCard>
  );
};

// ─── IL Estimation Tool ───────────────────────────────────────────────────────

const ILEstimator: React.FC = () => {
  const [priceChangePct, setPriceChangePct] = useState<number>(20);

  // IL = 2*sqrt(r)/(1+r) - 1 where r = (1 + pct/100)
  const ilPct = useMemo(() => {
    const r = 1 + priceChangePct / 100;
    const il = (2 * Math.sqrt(r)) / (1 + r) - 1;
    return Math.abs(il * 100);
  }, [priceChangePct]);

  return (
    <SectionCard title="📉 IL Estimation Tool">
      <p className="il-desc">
        Estimate your impermanent loss based on expected price movement.
      </p>
      <label className="calc-label">
        Price change: <strong>{priceChangePct > 0 ? "+" : ""}{priceChangePct}%</strong>
        <div className="slider-row">
          <input
            type="range"
            min={-90}
            max={500}
            step={5}
            value={priceChangePct}
            onChange={(e) => setPriceChangePct(Number(e.target.value))}
          />
        </div>
      </label>
      <div className="il-result">
        <span>Estimated IL</span>
        <strong className="il-loss">−{ilPct.toFixed(2)}%</strong>
      </div>
    </SectionCard>
  );
};

// ─── Main InsurancePanel Component ───────────────────────────────────────────

export interface InsurancePanelProps {
  reserveStats?: ReserveStats;
  activePolicy?: InsurancePolicy;
  currentPriceRatioScaled?: bigint;
}

const InsurancePanel: React.FC<InsurancePanelProps> = ({
  reserveStats = MOCK_RESERVE_STATS,
  activePolicy = MOCK_ACTIVE_POLICY,
  currentPriceRatioScaled = 1_050_000n, // ~5% price increase example
}) => {
  const [purchasedQuote, setPurchasedQuote] = useState<PremiumQuote | null>(null);

  const handleQuoteGenerated = useCallback((quote: PremiumQuote) => {
    setPurchasedQuote(quote);
    // In production: trigger wallet signature flow via purchasePolicy() SDK call
    console.info("Policy purchase initiated:", quote);
  }, []);

  return (
    <div className="insurance-panel">
      <div className="insurance-panel__header">
        <h2>🛡️ IL Insurance Vault</h2>
        <p>Protect your liquidity position against impermanent loss with a small premium.</p>
      </div>

      <div className="insurance-panel__grid">
        <PremiumCalculator onQuoteGenerated={handleQuoteGenerated} />
        <PolicyManagement
          policy={activePolicy}
          currentPriceRatioScaled={currentPriceRatioScaled}
        />
        <ReservePoolPanel stats={reserveStats} />
        <ILEstimator />
      </div>

      {purchasedQuote && (
        <div className="toast-notification">
          ✅ Policy purchase initiated — please sign the transaction in your wallet.
        </div>
      )}

      <style>{`
        .insurance-panel {
          font-family: 'Inter', sans-serif;
          max-width: 1100px;
          margin: 0 auto;
          padding: 24px;
          background: #0d0f1a;
          border-radius: 16px;
          color: #e2e8f0;
        }
        .insurance-panel__header { margin-bottom: 24px; }
        .insurance-panel__header h2 { font-size: 1.8rem; margin: 0 0 4px; }
        .insurance-panel__header p { color: #94a3b8; margin: 0; }
        .insurance-panel__grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(480px, 1fr));
          gap: 20px;
        }
        .insurance-card {
          background: #131726;
          border: 1px solid #1e2a3a;
          border-radius: 12px;
          padding: 20px;
        }
        .insurance-card__title { font-size: 1rem; font-weight: 600; margin: 0 0 16px; color: #7dd3fc; }
        .calc-grid { display: flex; flex-direction: column; gap: 14px; }
        .calc-label { display: flex; flex-direction: column; gap: 6px; font-size: 0.85rem; color: #94a3b8; }
        .calc-input {
          background: #1e2a3a; border: 1px solid #2d3f5a; border-radius: 8px;
          color: #e2e8f0; padding: 8px 12px; font-size: 1rem; outline: none;
        }
        .duration-tabs { display: flex; gap: 8px; }
        .duration-tab {
          flex: 1; padding: 8px; border-radius: 8px; border: 1px solid #2d3f5a;
          background: #1a2133; color: #94a3b8; cursor: pointer; font-size: 0.9rem; transition: all 0.2s;
        }
        .duration-tab.active { background: #1e40af; border-color: #3b82f6; color: #fff; }
        .slider-row { display: flex; align-items: center; gap: 12px; }
        .slider-row input[type=range] { flex: 1; accent-color: #3b82f6; }
        .slider-val { min-width: 52px; text-align: right; color: #e2e8f0; font-weight: 600; }
        .quote-result {
          margin-top: 20px; background: #0f172a; border-radius: 10px; padding: 16px;
          border: 1px solid #1e3a5f;
        }
        .quote-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 0.9rem; border-bottom: 1px solid #1e2a3a; }
        .quote-row:last-of-type { border-bottom: none; }
        .buy-btn {
          margin-top: 14px; width: 100%; padding: 12px; border-radius: 10px; border: none;
          background: linear-gradient(135deg, #1d4ed8, #7c3aed); color: #fff; font-size: 1rem;
          font-weight: 600; cursor: pointer; transition: opacity 0.2s;
        }
        .buy-btn:hover { opacity: 0.85; }
        .policy-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
        .policy-id { font-weight: 600; color: #7dd3fc; }
        .policy-status { padding: 4px 10px; border-radius: 20px; font-size: 0.78rem; font-weight: 600; }
        .policy-status.active { background: #14532d; color: #4ade80; }
        .policy-status.expired { background: #7f1d1d; color: #f87171; }
        .auto-renew-badge { background: #1e3a5f; color: #93c5fd; border-radius: 20px; padding: 4px 10px; font-size: 0.78rem; }
        .policy-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .policy-stat { background: #0f172a; border-radius: 8px; padding: 12px; }
        .policy-stat span { font-size: 0.78rem; color: #64748b; display: block; margin-bottom: 4px; }
        .policy-stat strong { font-size: 0.95rem; }
        .claimable-positive { color: #4ade80; }
        .policy-actions { display: flex; gap: 10px; margin-top: 14px; }
        .claim-btn, .renew-btn {
          flex: 1; padding: 10px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; font-size: 0.9rem;
        }
        .claim-btn { background: #14532d; color: #4ade80; }
        .renew-btn { background: #1e3a5f; color: #93c5fd; }
        .reserve-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
        .reserve-stat { background: #0f172a; border-radius: 8px; padding: 12px; }
        .reserve-stat span { font-size: 0.78rem; color: #64748b; display: block; margin-bottom: 4px; }
        .health-good { color: #4ade80; }
        .health-warn { color: #fbbf24; }
        .utilization-bar-wrap { margin-top: 16px; }
        .utilization-label { display: flex; justify-content: space-between; font-size: 0.82rem; color: #94a3b8; margin-bottom: 6px; }
        .utilization-bar { height: 8px; background: #1e2a3a; border-radius: 4px; overflow: hidden; }
        .utilization-fill { height: 100%; border-radius: 4px; transition: width 0.4s ease; }
        .utilization-fill.ok { background: linear-gradient(90deg, #22c55e, #16a34a); }
        .utilization-fill.warn { background: linear-gradient(90deg, #f59e0b, #dc2626); }
        .il-desc { font-size: 0.85rem; color: #64748b; margin: 0 0 14px; }
        .il-result { display: flex; justify-content: space-between; align-items: center; background: #0f172a; border-radius: 8px; padding: 14px; margin-top: 14px; }
        .il-loss { color: #f87171; font-size: 1.4rem; }
        .toast-notification {
          margin-top: 20px; background: #14532d; border: 1px solid #16a34a; color: #4ade80;
          padding: 14px 20px; border-radius: 10px; font-weight: 600; text-align: center;
          animation: fadeIn 0.3s ease;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
};

export default InsurancePanel;
