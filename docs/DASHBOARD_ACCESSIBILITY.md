# Dashboard accessibility: empty, loading and failure states

The dashboard panels use the shared `EmptyState` component (`ui/src/components/EmptyState.tsx`) so screen readers and keyboard users get the same information as sighted users.

## Behavior

| State | Role | Announced | Shown when |
|-------|------|-----------|------------|
| Loading | `status` (`aria-busy="true"`) | Politely | `positionsLoading` / `rewardsLoading` is true and the list is empty. No empty state is shown while loading. |
| Empty | `status` (`aria-live="polite"`) | Politely | The list is `[]` (or `pendingRewards` is omitted), not loading, no error. |
| Failure | `alert` (`aria-live="assertive"`) | At once | An error message is set. The failure state replaces the empty and loading states, so `status` and `alert` never show together for one panel. |

Decorative icons are `aria-hidden`. The retry button appears only when a retry callback is given, and has an accessible name.

## Panels and props (all new props are optional)

| Panel | Component | Props |
|-------|-----------|-------|
| Positions (vault list) | `Dashboard` | `positions`, `positionsLoading`, `positionsError`, `onRetryPositions`. Omitting `positions` keeps the built-in sample data. |
| Rewards | `RewardDashboard` | `pendingRewards` (now optional), `rewardsLoading`, `rewardsError`, `onRetryRewards` |
| Single vault | `YieldVaultCard` | An empty `vaultAddress` shows "No vault selected". A failed load shows the failure state with Retry (calls `refresh`). |

No new configuration or dependencies. Tests: `ui/tests/emptyStates.test.tsx` (run `npm test -- --runInBand` in `ui/`).
