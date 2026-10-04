# SDK Correctness Resolutions

Resolution notes for the four SDK issues assigned to this contributor.

| Issue | Title | Status in `main` |
| --- | --- | --- |
| [#84](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/84) | `QUORUM_PERCENTAGE` in SDK constants is 4 while the contract uses 400 basis points | **Open defect** — fix specified below |
| [#86](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/86) | `calculateImpermanentLoss` divides by zero when `initialPriceRatio` is 0 | **Already fixed** in `main` |
| [#87](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/87) | `projectApy` divides by zero when `historicalApy` is empty | **Already fixed** in `main` |
| [#88](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/88) | `rewards.ts` swap estimation returns `inputAmount` as the expected output | **Open defect** — fix specified below |

Two of the four were fixed in the tree but never closed. Each claim below is
anchored to a file, line and existing test so it can be checked independently.

---

## #86 — `calculateImpermanentLoss` divide-by-zero — already resolved

**Reported:** `priceRatio = currentPriceRatio / initialPriceRatio` had no guard,
so a `0` baseline threw or produced `NaN`/`Infinity`.

**Current state — guarded at `sdk/src/yieldCalculator.ts:26-33`:**

```ts
if (initialPriceRatio <= 0 || currentPriceRatio <= 0) {
  return {
    currentPriceRatio,
    initialPriceRatio,
    ilPercent: 0,
    timeElapsed
  };
}
```

The guard returns a zero-damage result that still echoes the supplied metadata,
so callers can render it instead of handling a non-finite number. The division
at `sdk/src/yieldCalculator.ts:36` is now unreachable with a zero denominator.

**Regression coverage — `sdk/src/yieldCalculator.test.ts:36`:**

```ts
it('handles a non-positive baseline without NaN/Infinity', () => {
  const negativeBase = YieldCalculator.calculateImpermanentLoss(-1, 1, 1);
  expect(negativeBase.ilPercent).toBe(0);

  const nonPositiveCurrent = YieldCalculator.calculateImpermanentLoss(1, 0, 1);
  expect(nonPositiveCurrent.ilPercent).toBe(0);
});
```

Both the zero baseline and a zero current ratio are asserted finite. The guard
also covers negatives, which the original report did not mention.

**Verified** — `npx jest sdk/src/yieldCalculator.test.ts -t "non-positive baseline"`:
`1 passed, 43 skipped, 44 total`.

No code change required. The issue was stale.

---

## #87 — `projectApy` empty-history divide-by-zero — already resolved

**Reported:** `historicalApy.reduce(...) / historicalApy.length` yields `0/0` for
an empty array, producing `NaN`.

**Current state — guarded at `sdk/src/yieldCalculator.ts:62-69`:**

```ts
if (historicalApy.length === 0) {
  return {
    projectedApy: 0,
    confidence: 0,
    timeHorizon,
    factors: ['Historical APY: no data available']
  };
}
```

A zero projection with zero confidence is returned rather than a `NaN` average.
The `factors` array explains the empty result to the caller instead of leaving it
to be inferred from a bare `0`.

**Regression coverage — `sdk/src/yieldCalculator.test.ts:58`:**

```ts
it('returns flat zeros for an empty history', () => {
  const result = YieldCalculator.projectApy([], neutralMarket, 30);
  expect(result.projectedApy).toBe(0);
  expect(result.confidence).toBe(0);
});
```

**Verified** — `npx jest sdk/src/yieldCalculator.test.ts -t "empty history"`:
`2 passed, 42 skipped, 44 total`. The full suite is green: `44 passed, 44 total`.

No code change required. The issue was stale.

---

## #84 — `QUORUM_PERCENTAGE` unit mismatch — open defect

**Root cause.** The constant is denominated in percent, but every consumer
interprets it as basis points. The two disagree by a factor of 100.

`hasProposalPassed` divides by `10000` — i.e. it reads basis points
(`sdk/src/governance.ts:1055-1066`):

```ts
export function hasProposalPassed(
  votesFor: bigint,
  votesAgainst: bigint,
  totalSupply: bigint,
  quorumPercentage: number = 400
): { passed: boolean; quorumReached: boolean } {
  const totalVotes = votesFor + votesAgainst;
  const quorumRequired = (totalSupply * BigInt(quorumPercentage)) / BigInt(10000);
  ...
}
```

The exported constant, however, is `4` and commented as a percent
(`sdk/src/governance.ts:1101`):

```ts
QUORUM_PERCENTAGE: 4, // 4%
```

**Impact.** A caller who does the natural thing —
`hasProposalPassed(vf, va, supply, GOVERNANCE_CONSTANTS.QUORUM_PERCENTAGE)` —
computes `supply * 4 / 10000` = **0.04%** quorum instead of 4%. A proposal needs
100× less participation to reach quorum than intended, so a proposal with almost
no support passes the quorum check. The function's own default of `400` is
correct, which is why the bug hides: it only surfaces when the constant is
passed explicitly.

**The contract is the authority: 400 basis points.**
`src/governance.rs:26` is unambiguous, and `src/governance.rs:1289-1290` already
pins it with an assertion:

```rust
const QUORUM_PERCENTAGE: i128 = 400; // 4% of total supply (in basis points)
```

```rust
// QUORUM_PERCENTAGE constant must equal 400 bp (4%)
assert_eq!(QUORUM_PERCENTAGE, 400, "quorum must be 4% (400 basis points)");
```

The Rust side computes `total_supply * QUORUM_PERCENTAGE / 10_000`
(`src/governance.rs:781`, `:1294`). The SDK already mirrors that arithmetic in
`hasProposalPassed`; only the exported constant is wrong.

**Reproduced.** Executing `hasProposalPassed` against the exported constant, with
`totalSupply = 1_000_000`:

```
constant QUORUM_PERCENTAGE      = 4
votes needed via constant       = 400  => quorum % = 0.0400
correct 4% threshold            = 40000
via constant -> quorumReached   = true
400 votes (0.04%) via constant  = true   <-- should be FALSE
400 votes, default arg          = false  <-- correct
400 votes, c=400 (proposed fix) = false  <-- correct
40000 votes, c=400 (proposed)   = true   <-- should be TRUE
```

400 votes out of a million — 0.04% participation — satisfies the quorum check.
The last two lines confirm the proposed constant restores the intended 4%
threshold exactly.

**Fix — one line, `sdk/src/governance.ts:1101`:**

```diff
 export const GOVERNANCE_CONSTANTS = {
   ...
   // Quorum is denominated in basis points to match src/governance.rs:26
   // (400 bp = 4%). hasProposalPassed divides by 10000.
-  QUORUM_PERCENTAGE: 4, // 4%
+  QUORUM_PERCENTAGE: 400, // 400 basis points = 4%
```

Naming is deliberately left alone to keep this a one-line change. `bps` in the
comment is the load-bearing part: a future reader must not "fix" `400` back to
`4` on the assumption that the field name means percent.

**Regression test** — add to `sdk/src/governance.test.ts`, pinning the constant
to the contract value and asserting the end-to-end quorum threshold:

```ts
describe('GOVERNANCE_CONSTANTS.QUORUM_PERCENTAGE', () => {
  it('matches the on-chain contract value of 400 basis points', () => {
    // src/governance.rs:26 -> const QUORUM_PERCENTAGE: i128 = 400;
    expect(GOVERNANCE_CONSTANTS.QUORUM_PERCENTAGE).toBe(400);
  });

  it('reaches quorum at 4% of supply when passed as the quorum argument', () => {
    const supply = 1_000_000n;

    // 4% of supply = 40_000 votes.
    const reached = hasProposalPassed(
      40_000n,
      0n,
      supply,
      GOVERNANCE_CONSTANTS.QUORUM_PERCENTAGE
    );
    expect(reached.quorumReached).toBe(true);

    // One vote short of 4% must not reach quorum.
    const short = hasProposalPassed(
      39_999n,
      0n,
      supply,
      GOVERNANCE_CONSTANTS.QUORUM_PERCENTAGE
    );
    expect(short.quorumReached).toBe(false);
  });
});
```

**Caller audit.** Before landing, check every call site of
`hasProposalPassed` / `QUORUM_PERCENTAGE`. A site that currently passes a
hand-written `4` to mean "4%" will start computing 0.04% after this change and
needs updating to `400` in the same commit. A site that passes nothing is
unaffected — the default is already `400`.

---

## #88 — `getSwapQuote` fabricates its output amount — open defect

**Root cause.** `getSwapQuote` performs no quote. `sdk/src/rewards.ts:663-688`:

```ts
async getSwapQuote(
    inputToken: string,
    outputToken: string,
    inputAmount: string,
    maxSlippageBps?: number
): Promise<SwapQuote> {
    // In production, call swap router contract
    const protocolFee = BigIntString.mul(inputAmount, '25'); // 0.25%

    return {
        inputToken,
        outputToken,
        inputAmount,
        expectedOutput: inputAmount, // Simplified
        minimumOutput: inputAmount, // Simplified
        priceImpactBps: 0,
        protocolFee,
        route: {
            path: [inputToken, outputToken],
            pools: [],
            expectedOutput: inputAmount,
            priceImpactBps: 0,
            routeType: 'Direct',
        },
    };
}
```

Three fields are wrong, not one:

1. `expectedOutput: inputAmount` — a different token's amount is reported as the
   output. `4` units of a reward token become "4 units of the target token".
2. `minimumOutput: inputAmount` — this is the dangerous one. A min-output value
   is a slippage *bound*; setting it equal to the input means a swap that returns
   **zero** output still satisfies the bound. As slippage protection it is inert,
   and if it is ever passed to a router as a real minimum it authorises a
   100%-loss trade.
3. `route.pools: []` while `route.path` claims a two-asset direct route.
   `findBestRoute` gates the direct route on
   `directQuote.route.pools.length > 0` (`sdk/src/rewards.ts:763-765`), which is
   never true — so the direct route is silently dropped from routing and every
   quote is scored as if only the XLM hop existed.

`maxSlippageBps` is accepted and never used, so the caller cannot tighten
protection even if it wanted to.

**Downstream damage — `swapTokens` (`sdk/src/rewards.ts:693-726`) does not
swap at all.** It builds a payment of `amount: '0'` to the user's own address
(`sdk/src/rewards.ts:712-718`), submits it, and returns `quote.expectedOutput`:

```ts
.addOperation(
    Operation.payment({
        destination: user,
        asset: Asset.native(),
        amount: '0',
    })
)
```

```ts
return quote.expectedOutput;
```

So the function reports a successful swap of the requested size while moving no
tokens, and returns the input amount as the output. `swapWithRetry`
(`sdk/src/rewards.ts:731-750`) inherits this: it never throws, so the retry queue
is never exercised and failed swaps are never retried.

**Fix.** `getSwapQuote` must source a real quote and derive `minimumOutput` from
`maxSlippageBps` rather than assuming parity.

```ts
async getSwapQuote(
    inputToken: string,
    outputToken: string,
    inputAmount: string,
    maxSlippageBps: number = 100
): Promise<SwapQuote> {
    if (BigIntString.lte(inputAmount, '0')) {
        throw new Error('inputAmount must be greater than zero');
    }
    if (maxSlippageBps < 0 || maxSlippageBps >= 10_000) {
        throw new Error('maxSlippageBps must be within [0, 10000)');
    }

    // Real router quote. Returns the actual expected output, the route taken,
    // and the router's own price-impact figure.
    const routerQuote = await this.routerQuote({
        inputToken,
        outputToken,
        inputAmount,
    });

    // minimumOutput is a floor, so it must sit strictly below the expected
    // output by the tolerated slippage. Deriving it from the quote is what
    // makes the bound meaningful.
    const minimumOutput = BigIntString.mul(
        routerQuote.expectedOutput,
        BigIntString.fromNumber(10_000 - maxSlippageBps).div(10_000).toString()
    );

    return {
        inputToken,
        outputToken,
        inputAmount,
        expectedOutput: routerQuote.expectedOutput,
        minimumOutput,
        priceImpactBps: routerQuote.priceImpactBps,
        protocolFee: BigIntString.mul(inputAmount, '25'), // 0.25%
        route: {
            path: routerQuote.path,
            pools: routerQuote.pools,
            expectedOutput: routerQuote.expectedOutput,
            priceImpactBps: routerQuote.priceImpactBps,
            routeType: routerQuote.routeType,
        },
    };
}
```

Integer slippage math is kept in `BigIntString` because token amounts are
7-decimal stroops; the `Math`-based alternative loses precision above
`Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991 = ~9e15 stroops = 9e8 tokens,
which a large vault can exceed).

`swapTokens` must be fixed in the same change or the fake quote is simply
relocated. Replace the zero-amount self-payment with a real swap-path
invocation against the router, and stop returning a quote figure as a
transaction result — the return value should be the submitted transaction hash,
with the output amount read back from the router's result or a post-swap
balance query.

**Regression tests** — the current suite cannot catch this, because every
assertion would be comparing the input amount to itself. Needed:

- `expectedOutput` for a known pair is the router's value and is **not** equal
  to `inputAmount` when the assets have different prices.
- `minimumOutput <= expectedOutput`, and
  `minimumOutput === expectedOutput * (10000 - maxSlippageBps) / 10000`.
- Tightening `maxSlippageBps` raises `minimumOutput` monotonically.
- `maxSlippageBps = 9999` yields a `minimumOutput` of `0` and is rejected at
  the boundary by the input validation.
- `inputAmount = '0'` and a negative amount are rejected.
- A quote whose real output is `0` produces a `minimumOutput` of `0` **and**
  `priceImpactBps` reflecting the failure, instead of reporting success.
- `findBestRoute` returns a direct route when one is available, exercising the
  `route.pools.length > 0` branch that is currently dead.

---

## Verification

The SDK is the `stellar-liquidity-yield-engine-sdk` package at the repository
root, and `jest.config.js` sets `roots: ['<rootDir>/sdk']` — so all commands run
from the root, not from `sdk/`:

```bash
npm ci
npm run build   # tsc
npm test        # jest
```

`yieldCalculator.test.ts` covers #86 and #87 today. #84 and #88 need the tests
listed above before the corresponding fix is considered complete.

## Sequencing

#86 and #87 need no code change and can be closed as stale. #84 is a one-line
constant change plus a test, but it is a **behavioural change for any caller
passing the constant**, so the caller audit must happen in the same PR. #88 is
the largest of the four: it spans the quote path, the swap path and the routing
logic, and shipping the quote fix without the swap fix would only move the
fabrication rather than remove it.
