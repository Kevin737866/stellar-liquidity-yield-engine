# Dashboard Browser Zoom Accessibility (Up to 200%)

This document describes how the Stellar Liquidity Yield Engine dashboard (`ui/`) supports browser zoom up to **200%** in accordance with WCAG 2.1 SC 1.4.4 (Resize Text) and SC 1.4.10 (Reflow).

## Effective Viewport Widths at 200% Zoom

| Physical Viewport | Zoom Level | Effective CSS Width |
|---|---|---|
| 1440 x 900 | 200% | 720px |
| 1280 x 720 | 200% | 640px |
| 1024 x 768 | 200% | 512px |

## Implemented Safeguards

- **Responsive Charts**: `ImpermanentLossChart.tsx` and `RewardDashboard.tsx` wrap Recharts visualizations in `<ResponsiveContainer width="100%" ...>` so charts scale smoothly at 200% zoom.
- **Scrollable Tables**: `FeeShareClaim.tsx` wraps its 6-column weekly fee-distribution table in `overflow-x-auto` rather than `overflow-hidden`, ensuring the `Status` and `Action` (Claim) columns remain reachable at 200% zoom.
- **Scrollable Modals**: `StakingModal.tsx` constrains modal height with `max-h-[90vh] overflow-y-auto` so form controls and submit buttons remain reachable when zoomed to 200%.
- **No Zoom Lockouts**: No viewport directives disable pinch or browser zoom (`user-scalable=no` / `maximum-scale=1`).

## Automated Verification

Run the zoom-to-200% accessibility test suite from the repository root:

```bash
npm test -- ui/tests/dashboardZoom200.test.ts
```

## Manual Browser Verification Checklist

1. Open the dashboard at `1280x720` and `1440x900`.
2. Step browser zoom through `100%`, `125%`, `150%`, `175%`, and `200%`.
3. Confirm no text or action buttons are clipped, `StakingModal` scrolls cleanly, charts resize without overflowing, and `FeeShareClaim` remains operable.
