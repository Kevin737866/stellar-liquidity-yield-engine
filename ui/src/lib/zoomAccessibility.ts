/**
 * Dashboard zoom accessibility helpers (WCAG 2.1 SC 1.4.4 & SC 1.4.10).
 *
 * Provides viewport-reflow math and static component layout checks for browser
 * zoom levels up to 200%.
 */

export const MIN_SUPPORTED_ZOOM_PERCENT = 50;
export const MAX_SUPPORTED_ZOOM_PERCENT = 200;
export const SUPPORTED_ZOOM_LEVELS = [100, 125, 150, 175, 200] as const;

/** Minimum effective CSS width (px) at 200% zoom on a 1280px desktop viewport. */
export const DESKTOP_200_ZOOM_WIDTH_PX = 640;

export interface ZoomLayoutIssue {
  rule:
    | 'viewport-zoom-lockout'
    | 'oversized-fixed-width'
    | 'clipped-table-container'
    | 'non-responsive-chart'
    | 'non-scrollable-modal';
  detail: string;
}

/**
 * Validate that a zoom percentage is finite and within [50, 200].
 * Throws an Error for invalid or unsupported zoom percentages.
 */
export function validateZoomLevel(zoomPercent: number): number {
  if (!Number.isFinite(zoomPercent)) {
    throw new Error(`Zoom percentage must be a finite number, received ${zoomPercent}`);
  }
  if (zoomPercent < MIN_SUPPORTED_ZOOM_PERCENT || zoomPercent > MAX_SUPPORTED_ZOOM_PERCENT) {
    throw new Error(
      `Zoom percentage ${zoomPercent}% is outside supported range [${MIN_SUPPORTED_ZOOM_PERCENT}%, ${MAX_SUPPORTED_ZOOM_PERCENT}%]`
    );
  }
  return zoomPercent;
}

/**
 * Compute the effective CSS viewport width in pixels when the browser applies
 * `zoomPercent`% zoom to a physical viewport of `viewportWidthPx` pixels.
 */
export function computeEffectiveViewportWidth(
  viewportWidthPx: number,
  zoomPercent: number
): number {
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx <= 0) {
    throw new Error(`Viewport width must be a positive finite number, received ${viewportWidthPx}`);
  }
  validateZoomLevel(zoomPercent);
  return Math.floor((viewportWidthPx * 100) / zoomPercent);
}

/**
 * Audit a dashboard TSX component source string for common 200%-zoom reflow
 * and clipping regressions.
 */
export function auditComponentZoomSafety(
  componentName: string,
  source: string
): ZoomLayoutIssue[] {
  const issues: ZoomLayoutIssue[] = [];

  if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?/i.test(source)) {
    issues.push({
      rule: 'viewport-zoom-lockout',
      detail: `${componentName} disables user pinch/browser zoom via viewport meta directives.`,
    });
  }

  // Flag arbitrary Tailwind fixed widths wider than a 200%-zoomed 1280px viewport (640px).
  const fixedWidthMatches = source.match(/\bw-\[(\d+)px\]/g) ?? [];
  for (const match of fixedWidthMatches) {
    const px = Number(match.slice(3, -3));
    if (px > DESKTOP_200_ZOOM_WIDTH_PX) {
      issues.push({
        rule: 'oversized-fixed-width',
        detail: `${componentName} uses fixed width ${match} (> ${DESKTOP_200_ZOOM_WIDTH_PX}px at 200% zoom).`,
      });
    }
  }

  // Tables wrapped in overflow-hidden clip columns/actions when zoomed to 200%.
  if (/<table\b/i.test(source) && /overflow-hidden[^"]*">\s*<table\b/i.test(source)) {
    issues.push({
      rule: 'clipped-table-container',
      detail: `${componentName} wraps a <table> in overflow-hidden instead of overflow-x-auto.`,
    });
  }

  // Recharts charts must use ResponsiveContainer with percentage width.
  if (/<(LineChart|AreaChart|PieChart|BarChart)\b/.test(source)) {
    if (!/<ResponsiveContainer[^>]*width=["']100%["']/.test(source)) {
      issues.push({
        rule: 'non-responsive-chart',
        detail: `${componentName} renders a Recharts chart without <ResponsiveContainer width="100%">.`,
      });
    }
  }

  // Modal overlays must bound height and allow vertical scrolling at 200% zoom.
  if (/fixed inset-0/.test(source) && !/overflow-y-auto/.test(source)) {
    issues.push({
      rule: 'non-scrollable-modal',
      detail: `${componentName} renders a fixed modal without overflow-y-auto for 200% zoom.`,
    });
  }

  return issues;
}
