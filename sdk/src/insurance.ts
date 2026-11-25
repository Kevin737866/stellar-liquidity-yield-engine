import { SorobanRpc, TransactionBuilder, Networks, scValToNative } from "@stellar/stellar-sdk";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface InsurancePolicy {
  policyId: bigint;
  owner: string;
  coverageAmount: bigint;
  premiumPaid: bigint;
  startPriceRatio: bigint;
  startTime: number;
  expiry: number;
  claimed: boolean;
  autoRenew: boolean;
}

export interface PremiumQuote {
  premiumAmount: bigint;
  coveragePeriod: number;
  coverageAmount: bigint;
  effectiveRateBps: number;
  reserveRatio: number;
}

export interface ReserveStats {
  totalPremiumsCollected: bigint;
  totalClaimsPaid: bigint;
  currentReserve: bigint;
  activeCoverage: bigint;
  policyCount: bigint;
  collateralizationRatioBps: number;
}

export interface PremiumHistoryEntry {
  policyId: bigint;
  purchasedAt: number;
  coveragePeriod: number;
  coverageAmount: bigint;
  premiumPaid: bigint;
  expiry: number;
  claimed: boolean;
  autoRenew: boolean;
  status: "active" | "expired" | "claimed";
}

export interface CoverageSummary {
  activeCoverage: bigint;
  totalPremiumsPaid: bigint;
  activePolicyCount: number;
  history: PremiumHistoryEntry[];
}

export type CoverageDuration = "7d" | "30d" | "90d";

const DURATION_SECONDS: Record<CoverageDuration, number> = {
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
  "90d": 90 * 24 * 3600,
};

// ─── Premium Quote (read-only, no transaction needed) ─────────────────────────

/**
 * Get an instant premium quote for an insurance policy.
 *
 * @param vault           - Vault info (used for token context)
 * @param coverageAmount  - Amount of token_a to insure (in base units)
 * @param duration        - Coverage duration: "7d" | "30d" | "90d"
 * @param volatilityBps   - Historical annual volatility in basis points (e.g. 8000 = 80%)
 * @param correlationBps  - Pool correlation coefficient * 10000 (e.g. 5000 = 0.5)
 * @param insuranceContractId - Deployed ILInsurance contract ID
 * @param server          - SorobanRpc server to use for simulation
 * @returns PremiumQuote
 */
export async function calculatePremium(
  vault: { poolId: string },
  coverageAmount: bigint,
  duration: CoverageDuration,
  volatilityBps: number,
  correlationBps: number,
  insuranceContractId: string,
  server: SorobanRpc.Server
): Promise<PremiumQuote> {
  const coveragePeriodSecs = DURATION_SECONDS[duration];

  // Simulate the calculate_premium contract call
  const response = await server.simulateTransaction(
    buildSimulationTx("calculate_premium", insuranceContractId, [
      coverageAmount,
      coveragePeriodSecs,
      volatilityBps,
      correlationBps,
    ])
  );

  if (SorobanRpc.Api.isSimulationError(response)) {
    throw new Error(`Premium simulation failed: ${response.error}`);
  }

  const result = (response as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval;
  if (!result) throw new Error("No simulation result returned");

  const native = scValToNative(result) as any;
  return {
    premiumAmount: BigInt(native.premium_amount),
    coveragePeriod: coveragePeriodSecs,
    coverageAmount,
    effectiveRateBps: Number(native.effective_rate_bps),
    reserveRatio: Number(native.reserve_ratio),
  };
}

// ─── Purchase Policy ─────────────────────────────────────────────────────────

/**
 * Build a transaction to purchase an insurance policy.
 *
 * @param vault            - Vault metadata (pool token context)
 * @param coverage         - Coverage configuration
 * @param buyerPublicKey   - Stellar public key of the buyer
 * @param insuranceContractId - Deployed ILInsurance contract ID
 * @param server           - SorobanRpc server
 * @param network          - Stellar network passphrase
 * @returns TransactionBuilder ready to be signed
 */
export async function purchasePolicy(
  vault: { poolId: string; tokenA: string },
  coverage: {
    amount: bigint;
    duration: CoverageDuration;
    currentPriceRatioScaled: bigint;
    volatilityBps: number;
    correlationBps: number;
    autoRenew: boolean;
    reserveToken: string;
  },
  buyerPublicKey: string,
  insuranceContractId: string,
  server: SorobanRpc.Server,
  network: string = Networks.TESTNET
): Promise<TransactionBuilder> {
  const account = await server.getAccount(buyerPublicKey);
  const coveragePeriodSecs = DURATION_SECONDS[coverage.duration];

  const builder = new TransactionBuilder(account, {
    fee: "1000",
    networkPassphrase: network,
  });

  // Build the purchase_insurance invocation
  builder.addOperation(
    buildContractOperation("purchase_insurance", insuranceContractId, [
      buyerPublicKey,
      coverage.amount,
      coveragePeriodSecs,
      coverage.currentPriceRatioScaled,
      coverage.volatilityBps,
      coverage.correlationBps,
      coverage.autoRenew,
      coverage.reserveToken,
    ])
  );

  return builder;
}

// ─── Claimable Amount ────────────────────────────────────────────────────────

/**
 * Calculate the claimable IL compensation for a given policy.
 *
 * Returns the estimated payout based on current price ratio vs. entry ratio.
 * This uses the IL formula: IL = 2*sqrt(r)/(1+r) - 1 where r = currentPrice/entryPrice.
 *
 * @param policy                   - Existing insurance policy
 * @param currentPriceRatioScaled  - Current sqrt(reserve_a/reserve_b) * 1_000_000
 * @returns Estimated claimable amount in coverage token units
 */
export function getClaimableAmount(
  policy: InsurancePolicy,
  currentPriceRatioScaled: bigint
): bigint {
  const startRatio = policy.startPriceRatio; // sqrt(P0) * 1e6
  const currentRatio = currentPriceRatioScaled; // sqrt(P1) * 1e6

  if (startRatio <= 0n) return 0n;

  // priceRatio_1e6 = (current/start)^2 * 1e6
  const priceRatio1e6 = (currentRatio * currentRatio * 1_000_000n) / (startRatio * startRatio);

  // IL = 2*sqrt(r)/(1+r) - 1, all scaled by 1_000_000
  const sqrtR = bigintSqrt(priceRatio1e6 * 1_000_000n); // result scaled by 1e3 (since input is 1e6)
  const numerator = 2n * sqrtR * 1_000_000n; // 1e9
  const denominator = 1_000n + priceRatio1e6 / 1_000n; // 1e3

  const ilScaled = denominator > 0n ? numerator / denominator : 0n;

  // If IL >= 1 (scaled), no loss
  if (ilScaled >= 1_000_000n) return 0n;

  const ilLossScaled = 1_000_000n - ilScaled;
  return (policy.coverageAmount * ilLossScaled) / 1_000_000n;
}

// ─── Reserve Pool Health ─────────────────────────────────────────────────────

/**
 * Fetch live reserve pool statistics including collateralization ratio.
 *
 * @param insuranceContractId - Deployed ILInsurance contract ID
 * @param server              - SorobanRpc server
 * @returns ReserveStats
 */
export async function getReserveStats(
  insuranceContractId: string,
  server: SorobanRpc.Server
): Promise<ReserveStats> {
  const response = await server.simulateTransaction(
    buildSimulationTx("reserve_pool", insuranceContractId, [])
  );

  if (SorobanRpc.Api.isSimulationError(response)) {
    throw new Error(`Reserve stats simulation failed: ${response.error}`);
  }

  const result = (response as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval;
  if (!result) throw new Error("No result returned for reserve_pool");

  const native = scValToNative(result) as any;
  const currentReserve = BigInt(native.current_reserve);
  const activeCoverage = BigInt(native.active_coverage);
  const collateralizationRatioBps =
    activeCoverage > 0n
      ? Number((currentReserve * 10000n) / activeCoverage)
      : 999_999;

  return {
    totalPremiumsCollected: BigInt(native.total_premiums_collected),
    totalClaimsPaid: BigInt(native.total_claims_paid),
    currentReserve,
    activeCoverage,
    policyCount: BigInt(native.policy_count),
    collateralizationRatioBps,
  };
}

// ─── Coverage & Premium History ──────────────────────────────────────────────

/**
 * Build a coverage and premium history view for a set of policies.
 *
 * Entries are sorted by startTime descending (most recent first). Each entry's
 * status is derived from the reference time: "claimed" if claimed, "expired" if
 * expiry <= now, otherwise "active".
 *
 * @param policies - Policies to summarize (e.g. fetched for one owner)
 * @param now      - Reference time in unix seconds (defaults to current time)
 * @returns CoverageSummary with totals and per-policy history
 * @throws Error if a policy has invalid (non-positive or inverted) timing or negative amounts
 */
export function buildCoverageHistory(
  policies: InsurancePolicy[],
  now: number = Math.floor(Date.now() / 1000)
): CoverageSummary {
  const history: PremiumHistoryEntry[] = policies.map((p) => {
    if (p.coverageAmount < 0n || p.premiumPaid < 0n) {
      throw new Error(`Policy ${p.policyId} has negative amounts`);
    }
    if (p.startTime <= 0 || p.expiry < p.startTime) {
      throw new Error(`Policy ${p.policyId} has invalid timing`);
    }
    const status: PremiumHistoryEntry["status"] = p.claimed
      ? "claimed"
      : p.expiry <= now
        ? "expired"
        : "active";
    return {
      policyId: p.policyId,
      purchasedAt: p.startTime,
      coveragePeriod: p.expiry - p.startTime,
      coverageAmount: p.coverageAmount,
      premiumPaid: p.premiumPaid,
      expiry: p.expiry,
      claimed: p.claimed,
      autoRenew: p.autoRenew,
      status,
    };
  });

  history.sort((a, b) => b.purchasedAt - a.purchasedAt);

  let activeCoverage = 0n;
  let totalPremiumsPaid = 0n;
  let activePolicyCount = 0;
  for (const entry of history) {
    totalPremiumsPaid += entry.premiumPaid;
    if (entry.status === "active") {
      activeCoverage += entry.coverageAmount;
      activePolicyCount += 1;
    }
  }

  return { activeCoverage, totalPremiumsPaid, activePolicyCount, history };
}

/**
 * Fetch live coverage and premium history for a set of policies from the
 * insurance contract's reserve statistics, combined with locally supplied
 * policy records.
 *
 * @param insuranceContractId - Deployed ILInsurance contract ID
 * @param server              - SorobanRpc server
 * @param policies            - Policy records to include in the history view
 * @returns CoverageSummary including live reserve totals
 */
export async function getCoverageHistory(
  insuranceContractId: string,
  server: SorobanRpc.Server,
  policies: InsurancePolicy[]
): Promise<CoverageSummary & { reserve: ReserveStats }> {
  const reserve = await getReserveStats(insuranceContractId, server);
  const summary = buildCoverageHistory(policies);
  return { ...summary, reserve };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function buildSimulationTx(method: string, contractId: string, args: any[]): any {
  // Lightweight stub — in production, build full Transaction for simulation
  return { method, contractId, args };
}

function buildContractOperation(method: string, contractId: string, args: any[]): any {
  // Stub for Operation construction — replace with actual soroban-sdk operation builder
  return { method, contractId, args };
}

/** Integer square root (BigInt Newton's method) */
function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("Square root of negative number");
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
