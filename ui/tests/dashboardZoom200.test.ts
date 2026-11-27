import * as fs from 'fs';
import * as path from 'path';
import {
  auditComponentZoomSafety,
  computeEffectiveViewportWidth,
  DESKTOP_200_ZOOM_WIDTH_PX,
  MAX_SUPPORTED_ZOOM_PERCENT,
  SUPPORTED_ZOOM_LEVELS,
  validateZoomLevel,
} from '../src/lib/zoomAccessibility';

const COMPONENTS_DIR = path.resolve(__dirname, '../src/components');

describe('Dashboard 200% Browser Zoom Accessibility', () => {
  describe('Zoom viewport reflow calculations', () => {
    it('supports all standard zoom levels from 100% up to 200%', () => {
      for (const zoom of SUPPORTED_ZOOM_LEVELS) {
        expect(validateZoomLevel(zoom)).toBe(zoom);
      }
      expect(MAX_SUPPORTED_ZOOM_PERCENT).toBe(200);
    });

    it('computes expected effective CSS widths up to 200% zoom', () => {
      expect(computeEffectiveViewportWidth(1280, 100)).toBe(1280);
      expect(computeEffectiveViewportWidth(1280, 150)).toBe(853);
      expect(computeEffectiveViewportWidth(1280, 200)).toBe(DESKTOP_200_ZOOM_WIDTH_PX);
      expect(computeEffectiveViewportWidth(1440, 200)).toBe(720);
      expect(computeEffectiveViewportWidth(1024, 200)).toBe(512);
    });

    it('rejects invalid, zero, negative, non-finite, and >200% zoom boundary inputs', () => {
      expect(() => computeEffectiveViewportWidth(1280, 0)).toThrow();
      expect(() => computeEffectiveViewportWidth(1280, -100)).toThrow();
      expect(() => computeEffectiveViewportWidth(1280, 201)).toThrow();
      expect(() => computeEffectiveViewportWidth(1280, Number.NaN)).toThrow();
      expect(() => computeEffectiveViewportWidth(0, 200)).toThrow();
      expect(() => computeEffectiveViewportWidth(-1280, 200)).toThrow();
    });
  });

  describe('Dashboard component zoom-200% layout invariants', () => {
    const componentFiles = fs
      .readdirSync(COMPONENTS_DIR)
      .filter((file) => file.endsWith('.tsx'))
      .sort();

    it('discovers all dashboard TSX components', () => {
      expect(componentFiles.length).toBeGreaterThanOrEqual(10);
    });

    it.each(componentFiles)(
      '%s passes 200% browser zoom reflow and clipping checks',
      (file) => {
        const source = fs.readFileSync(path.join(COMPONENTS_DIR, file), 'utf8');
        const issues = auditComponentZoomSafety(file, source);
        expect(issues).toEqual([]);
      }
    );

    it('ensures FeeShareClaim table container allows horizontal scroll instead of clipping', () => {
      const source = fs.readFileSync(
        path.join(COMPONENTS_DIR, 'FeeShareClaim.tsx'),
        'utf8'
      );
      expect(source).toContain('overflow-x-auto');
    });

    it('ensures StakingModal bounds height and scrolls vertically at 200% zoom', () => {
      const source = fs.readFileSync(
        path.join(COMPONENTS_DIR, 'StakingModal.tsx'),
        'utf8'
      );
      expect(source).toContain('max-h-[90vh]');
      expect(source).toContain('overflow-y-auto');
    });
  });

  describe('Audit failure detection (negative cases)', () => {
    it('flags oversized fixed widths, clipped tables, non-responsive charts, and zoom lockouts', () => {
      const badSource = `
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <div className="w-[900px]">
          <div className="overflow-hidden"><table className="w-full"></table></div>
          <PieChart width={400} height={300}></PieChart>
          <div className="fixed inset-0"><div>Modal</div></div>
        </div>
      `;
      const issues = auditComponentZoomSafety('BadComponent.tsx', badSource);
      const rules = issues.map((i) => i.rule);

      expect(rules).toContain('viewport-zoom-lockout');
      expect(rules).toContain('oversized-fixed-width');
      expect(rules).toContain('clipped-table-container');
      expect(rules).toContain('non-responsive-chart');
      expect(rules).toContain('non-scrollable-modal');
    });
  });
});
