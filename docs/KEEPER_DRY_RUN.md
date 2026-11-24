# Keeper Dry-Run Mode

## Overview

`AutoRebalancer` can evaluate a full keeper tick — cooldown, RPC lag check,
opportunity scan, profitability gate and rebalance simulation — without signing
or submitting anything. Use it to validate a strategy, a configuration change,
or a freshly restored keeper before letting it write to the chain.

A dry run is **state-neutral**:

- it never calls `executeArbitrage` (so no key is required),
- it never consumes the cooldown slot or writes a checkpoint, which means a
  live run in the same window still executes,
- it never sends Telegram/Discord notifications.

## Usage

Enable it for one run:

```ts
const keeper = new AutoRebalancer(config);
const results = await keeper.run({ dryRun: true });
```

Or for every run, e.g. from an environment flag:

```ts
const keeper = new AutoRebalancer({
  ...config,
  dryRun: process.env.KEEPER_DRY_RUN === '1',
});
```

`run({ dryRun })` overrides the keeper-level default.

## Reading the result

Every `RebalanceResult` produced by a dry run carries `dryRun: true`. When the
keeper reached the point where a live run would have submitted, the result also
has:

| Field | Meaning |
| --- | --- |
| `wouldExecute` | `true` when a live run would have signed and sent the rebalance. |
| `success` | Always `false` for dry runs — nothing was submitted. |
| `opportunity` | The opportunity the keeper selected. |
| `profit` | Net profit (strops) the live run would have earned. |
| `message` | `Dry run: would execute rebalance into <pool>. No transaction submitted.` |

Decision gates that stop a live run also stop a dry run and are reported the
same way, tagged with `dryRun: true`: `cooldown`, `rpc_lag`, `no_opportunities`,
`no_eligible_opportunities`, `not_profitable`, `no_cost_estimate`,
`simulation_negative`, `simulation_no_cost_estimate`.

```ts
for (const result of results) {
  if (result.wouldExecute) {
    console.log(`would rebalance into ${result.opportunity?.pool_id}`);
  } else {
    console.log(`skipped: ${result.message}`);
  }
}
```

## Tests

`sdk/src/bots/autoRebalancer.test.ts` covers the no-submission guarantee, the
untouched cooldown/checkpoint state, the keeper-level default and dry-run
tagging of decision-gate results.
