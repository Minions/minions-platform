import { describe, it, expect } from 'vitest';
import { computeDagLayout, computeMultiRootLayout, computeRootScatterLayout, computeRootRadialLayout, computeRootGridLayout, computeRootRegionLayout, computeTidyTreeLayout, fitRadialCamDistance } from './computeDagLayout';
import type { PlanItemRecord } from '@minions/mcp-types';

function item(id: string, children: string[] = [], requires: string[] = []): PlanItemRecord {
  return { id, title: id, type: 'task', parent: null, children, requires };
}

describe('computeDagLayout', () => {
  it('places a single root node at the centre', () => {
    const items = { root: item('root') };
    const pos = computeDagLayout(items, 'root');
    expect(pos['root']).toBeDefined();
    expect(pos['root'].layer).toBe(0);
  });

  it('places children one layer below their parent', () => {
    const items = {
      r: item('r', ['a', 'b']),
      a: item('a'),
      b: item('b'),
    };
    const pos = computeDagLayout(items, 'r');
    expect(pos['r'].layer).toBe(0);
    expect(pos['a'].layer).toBe(1);
    expect(pos['b'].layer).toBe(1);
  });

  it('places grandchildren two layers below root', () => {
    const items = {
      r: item('r', ['a']),
      a: item('a', ['b']),
      b: item('b'),
    };
    const pos = computeDagLayout(items, 'r');
    expect(pos['r'].layer).toBe(0);
    expect(pos['a'].layer).toBe(1);
    expect(pos['b'].layer).toBe(2);
  });

  it('distributes siblings horizontally at distinct x positions', () => {
    const items = {
      r: item('r', ['a', 'b', 'c']),
      a: item('a'),
      b: item('b'),
      c: item('c'),
    };
    const pos = computeDagLayout(items, 'r');
    const xs = ['a', 'b', 'c'].map(id => pos[id].x);
    const unique = new Set(xs);
    expect(unique.size).toBe(3);
  });

  it('returns positions for all items in the subtree', () => {
    const items = {
      r: item('r', ['a', 'b']),
      a: item('a', ['c']),
      b: item('b'),
      c: item('c'),
    };
    const pos = computeDagLayout(items, 'r');
    expect(Object.keys(pos)).toHaveLength(4);
  });

  it('does not include items not reachable from the root', () => {
    const items = {
      r: item('r', ['a']),
      a: item('a'),
      orphan: item('orphan'),
    };
    const pos = computeDagLayout(items, 'r');
    expect(pos['orphan']).toBeUndefined();
  });

  it('handles diamond dependency (shared child) without duplicating positions', () => {
    // r -> a -> c
    // r -> b -> c  (c appears via both paths)
    const items = {
      r: item('r', ['a', 'b']),
      a: item('a', ['c']),
      b: item('b', ['c']),
      c: item('c'),
    };
    const pos = computeDagLayout(items, 'r');
    expect(pos['c']).toBeDefined();
    expect(Object.keys(pos)).toHaveLength(4);
  });
});

describe('computeMultiRootLayout', () => {
  it('returns positions for all nodes across all trees', () => {
    const items = {
      r1: item('r1', ['a']),
      a: item('a'),
      r2: item('r2', ['b']),
      b: item('b'),
    };
    const pos = computeMultiRootLayout(items, ['r1', 'r2']);
    expect(Object.keys(pos)).toHaveLength(4);
  });

  it('places roots at the same vertical level (layer 0)', () => {
    const items = { r1: item('r1'), r2: item('r2'), r3: item('r3') };
    const pos = computeMultiRootLayout(items, ['r1', 'r2', 'r3']);
    expect(pos['r1'].layer).toBe(0);
    expect(pos['r2'].layer).toBe(0);
    expect(pos['r3'].layer).toBe(0);
    expect(pos['r1'].y).toBeCloseTo(pos['r2'].y, 0);
    expect(pos['r2'].y).toBeCloseTo(pos['r3'].y, 0);
  });

  it('keeps each tree in its own horizontal band — root x values are spread across width', () => {
    const items = { r1: item('r1'), r2: item('r2') };
    const pos = computeMultiRootLayout(items, ['r1', 'r2'], { width: 1000, marginX: 0, marginY: 0 });
    // r1 should be in the left half, r2 in the right half
    expect(pos['r1'].x).toBeLessThan(500);
    expect(pos['r2'].x).toBeGreaterThan(500);
  });

  it('assigns children one layer below their root within the same band', () => {
    const items = {
      r1: item('r1', ['a', 'b']),
      a: item('a'),
      b: item('b'),
      r2: item('r2', ['c']),
      c: item('c'),
    };
    const pos = computeMultiRootLayout(items, ['r1', 'r2']);
    expect(pos['r1'].layer).toBe(0);
    expect(pos['a'].layer).toBe(1);
    expect(pos['b'].layer).toBe(1);
    expect(pos['r2'].layer).toBe(0);
    expect(pos['c'].layer).toBe(1);
  });

  it('handles a single root the same as computeDagLayout', () => {
    const items = {
      r: item('r', ['a', 'b']),
      a: item('a'),
      b: item('b'),
    };
    const pos = computeMultiRootLayout(items, ['r']);
    expect(pos['r'].layer).toBe(0);
    expect(pos['a'].layer).toBe(1);
    expect(pos['b'].layer).toBe(1);
  });

  it('returns empty object for no roots', () => {
    const pos = computeMultiRootLayout({}, []);
    expect(Object.keys(pos)).toHaveLength(0);
  });
});

describe('computeRootRadialLayout', () => {
  const W = 1000, H = 600;
  const opts = { width: W, height: H, marginX: 0, marginY: 0 };
  const cx = W / 2, cy = H / 2;

  it('returns empty object for no roots', () => {
    expect(computeRootRadialLayout([])).toEqual({});
  });

  it('places a single root at the canvas centre', () => {
    const pos = computeRootRadialLayout(['r'], opts);
    expect(pos['r'].x).toBeCloseTo(cx);
    expect(pos['r'].y).toBeCloseTo(cy);
    expect(pos['r'].layer).toBe(0);
  });

  it('assigns layer 0 to all roots', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const pos = computeRootRadialLayout(ids, opts);
    for (const id of ids) expect(pos[id].layer).toBe(0);
  });

  it('places the first root at the top of the circle (12 oclock)', () => {
    const pos = computeRootRadialLayout(['top', 'right'], opts);
    // First root at -π/2 → (cx, cy - radius)
    expect(pos['top'].x).toBeCloseTo(cx, 0);
    expect(pos['top'].y).toBeLessThan(cy);
  });

  it('distributes two roots on opposite sides', () => {
    const pos = computeRootRadialLayout(['a', 'b'], opts);
    // They should be symmetric around the centre
    expect(pos['a'].x + pos['b'].x).toBeCloseTo(2 * cx, 0);
    expect(pos['a'].y + pos['b'].y).toBeCloseTo(2 * cy, 0);
  });

  it('distributes four roots at 90° intervals', () => {
    const ids = ['n', 'e', 's', 'w'];
    const pos = computeRootRadialLayout(ids, opts);
    // All equidistant from centre
    const dists = ids.map(id => {
      const dx = pos[id].x - cx;
      const dy = pos[id].y - cy;
      return Math.sqrt(dx * dx + dy * dy);
    });
    const r0 = dists[0];
    for (const d of dists) expect(d).toBeCloseTo(r0, 0);
  });

  it('produces distinct positions for all roots', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const pos = computeRootRadialLayout(ids, opts);
    const points = ids.map(id => `${Math.round(pos[id].x)},${Math.round(pos[id].y)}`);
    expect(new Set(points).size).toBe(ids.length);
  });

  it('increases radius as N grows to avoid overlap', () => {
    const posSmall = computeRootRadialLayout(['a', 'b', 'c'], opts);
    const posLarge = computeRootRadialLayout(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], opts);
    const rSmall = Math.sqrt(Math.pow(posSmall['a'].x - cx, 2) + Math.pow(posSmall['a'].y - cy, 2));
    const rLarge = Math.sqrt(Math.pow(posLarge['a'].x - cx, 2) + Math.pow(posLarge['a'].y - cy, 2));
    expect(rLarge).toBeGreaterThanOrEqual(rSmall);
  });
});

describe('computeTidyTreeLayout', () => {
  const W = 1400, H = 750;
  const SPACING = 200, LEVEL = 240;
  const opts = { width: W, height: H, marginX: 0, marginY: 0, nodeSpacing: SPACING, levelSpacing: LEVEL };
  const cx = W / 2, cy = H / 2;

  // Smallest centre-to-centre distance between any two distinct nodes.
  function minPairDistance(pos: Record<string, { x: number; y: number }>): number {
    const ps = Object.values(pos);
    let min = Infinity;
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const d = Math.hypot(ps[i].x - ps[j].x, ps[i].y - ps[j].y);
        if (d < min) min = d;
      }
    return min;
  }

  it('returns empty object for unknown root', () => {
    expect(computeTidyTreeLayout({}, 'x', opts)).toEqual({});
  });

  it('places a lone root at canvas centre, layer 0', () => {
    const items = { r: item('r') };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    expect(pos['r'].x).toBeCloseTo(cx);
    expect(pos['r'].y).toBeCloseTo(cy);
    expect(pos['r'].layer).toBe(0);
  });

  it('places children one level below the root (vertical orientation)', () => {
    const items = { r: item('r', ['a', 'b']), a: item('a'), b: item('b') };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    expect(pos['a'].layer).toBe(1);
    expect(pos['b'].layer).toBe(1);
    expect(pos['a'].y).toBeCloseTo(pos['b'].y); // same level → same y
    expect(pos['a'].y - pos['r'].y).toBeCloseTo(LEVEL);
  });

  it('spaces adjacent siblings exactly nodeSpacing apart', () => {
    const items = { r: item('r', ['a', 'b', 'c']), a: item('a'), b: item('b'), c: item('c') };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    const xs = ['a', 'b', 'c'].map(id => pos[id].x).sort((p, q) => p - q);
    expect(xs[1] - xs[0]).toBeCloseTo(SPACING);
    expect(xs[2] - xs[1]).toBeCloseTo(SPACING);
  });

  it('centres a parent over its children', () => {
    const items = { r: item('r', ['a', 'b']), a: item('a'), b: item('b') };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    expect(pos['r'].x).toBeCloseTo((pos['a'].x + pos['b'].x) / 2);
  });

  it('positions all nodes in the subtree', () => {
    const items = {
      r: item('r', ['a', 'b']),
      a: item('a', ['c']),
      b: item('b'),
      c: item('c'),
    };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    expect(Object.keys(pos)).toHaveLength(4);
  });

  it('never lets nodes overlap — even cousins from different parents', () => {
    // Two layer-1 nodes each with two children. The classic radial failure case:
    // cousins g2 (under a) and g3 (under b) would collide at a small radius.
    const items = {
      r: item('r', ['a', 'b']),
      a: item('a', ['g1', 'g2']),
      b: item('b', ['g3', 'g4']),
      g1: item('g1'), g2: item('g2'), g3: item('g3'), g4: item('g4'),
    };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    // No two nodes closer than nodeSpacing (minus float epsilon).
    expect(minPairDistance(pos)).toBeGreaterThanOrEqual(SPACING - 0.001);
  });

  it('keeps a deep, lopsided tree overlap-free', () => {
    // A wide subtree next to a deep chain — both stressors at once.
    const items: Record<string, PlanItemRecord> = {
      r: item('r', ['wide', 'deep']),
      wide: item('wide', ['w1', 'w2', 'w3', 'w4']),
      w1: item('w1'), w2: item('w2'), w3: item('w3'), w4: item('w4'),
      deep: item('deep', ['d1']),
      d1: item('d1', ['d2']), d2: item('d2', ['d3']), d3: item('d3'),
    };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    expect(Object.keys(pos)).toHaveLength(Object.keys(items).length);
    expect(minPairDistance(pos)).toBeGreaterThanOrEqual(SPACING - 0.001);
  });

  it('lays out along the x axis in horizontal orientation', () => {
    const items = { r: item('r', ['a']), a: item('a') };
    const pos = computeTidyTreeLayout(items, 'r', { ...opts, orientation: 'horizontal' });
    expect(pos['a'].x - pos['r'].x).toBeCloseTo(LEVEL); // depth grows along x
    expect(pos['a'].y).toBeCloseTo(pos['r'].y);
  });

  it('includes nodes transitively required by descendants', () => {
    const items = {
      r: item('r', ['a']),
      a: item('a', [], ['dep']),
      dep: item('dep'),
    };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    expect(pos['dep']).toBeDefined();
    expect(Object.keys(pos)).toHaveLength(3);
  });

  it('does not infinite-loop on requires cycles', () => {
    const items = {
      r: item('r', ['a']),
      a: item('a', [], ['b']),
      b: item('b', [], ['a']),
    };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    expect(pos['r']).toBeDefined();
    expect(pos['a']).toBeDefined();
    expect(pos['b']).toBeDefined();
  });

  it('positions a shared (diamond) child exactly once', () => {
    const items = {
      r: item('r', ['a', 'b']),
      a: item('a', ['c']),
      b: item('b', ['c']),
      c: item('c'),
    };
    const pos = computeTidyTreeLayout(items, 'r', opts);
    expect(pos['c']).toBeDefined();
    expect(Object.keys(pos)).toHaveLength(4);
  });
});

describe('computeRootScatterLayout', () => {
  const W = 1000, H = 600, MX = 100, MY = 80;
  const opts = { width: W, height: H, marginX: MX, marginY: MY };

  it('returns empty object for no roots', () => {
    expect(computeRootScatterLayout([])).toEqual({});
  });

  it('places a single root at the canvas centre', () => {
    const pos = computeRootScatterLayout(['r1'], opts);
    expect(pos['r1'].x).toBeCloseTo(W / 2);
    expect(pos['r1'].y).toBeCloseTo(H / 2);
    expect(pos['r1'].layer).toBe(0);
  });

  it('assigns layer 0 to all roots', () => {
    const ids = ['a', 'b', 'c'];
    const pos = computeRootScatterLayout(ids, opts);
    for (const id of ids) {
      expect(pos[id].layer).toBe(0);
    }
  });

  it('positions all roots within canvas bounds', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const pos = computeRootScatterLayout(ids, opts);
    for (const id of ids) {
      expect(pos[id].x).toBeGreaterThanOrEqual(MX - 1);
      expect(pos[id].x).toBeLessThanOrEqual(W - MX + 1);
      expect(pos[id].y).toBeGreaterThanOrEqual(MY - 1);
      expect(pos[id].y).toBeLessThanOrEqual(H - MY + 1);
    }
  });

  it('spreads two roots across the full horizontal width', () => {
    const pos = computeRootScatterLayout(['left', 'right'], opts);
    expect(pos['left'].x).toBeCloseTo(MX);
    expect(pos['right'].x).toBeCloseTo(W - MX);
    expect(pos['left'].y).toBeCloseTo(pos['right'].y);
  });

  it('places four roots in a single row at equal y', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const pos = computeRootScatterLayout(ids, opts);
    const ys = ids.map(id => pos[id].y);
    for (const y of ys) expect(y).toBeCloseTo(H / 2);
    // all x values are distinct
    const xs = ids.map(id => pos[id].x);
    expect(new Set(xs).size).toBe(4);
  });

  it('places five roots in two rows, last row centred', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const pos = computeRootScatterLayout(ids, opts);
    // row 0: a,b,c at top; row 1: d,e centred
    expect(pos['a'].y).toBeCloseTo(MY);
    expect(pos['d'].y).toBeCloseTo(H - MY);
    // d and e are symmetric around horizontal centre
    const midX = W / 2;
    expect((pos['d'].x + pos['e'].x) / 2).toBeCloseTo(midX, 0);
  });

  it('produces distinct positions for all roots', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const pos = computeRootScatterLayout(ids, opts);
    const points = ids.map(id => `${pos[id].x},${pos[id].y}`);
    expect(new Set(points).size).toBe(ids.length);
  });
});

describe('computeRootGridLayout', () => {
  const W = 1400, H = 750;
  const opts = { width: W, height: H, marginX: 0, marginY: 0 };
  const cx = W / 2, cy = H / 2;

  it('returns empty object for no roots', () => {
    expect(computeRootGridLayout([], opts)).toEqual({});
  });

  it('places a single root at the canvas centre', () => {
    const pos = computeRootGridLayout(['r'], opts);
    expect(pos['r'].x).toBeCloseTo(cx);
    expect(pos['r'].y).toBeCloseTo(cy);
    expect(pos['r'].layer).toBe(0);
  });

  it('assigns layer 0 to all roots', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const pos = computeRootGridLayout(ids, opts);
    for (const id of ids) expect(pos[id].layer).toBe(0);
  });

  it('produces distinct positions for every root', () => {
    const ids = Array.from({ length: 31 }, (_, i) => `r${i}`);
    const pos = computeRootGridLayout(ids, opts);
    const pts = ids.map(id => `${Math.round(pos[id].x)},${Math.round(pos[id].y)}`);
    expect(new Set(pts).size).toBe(ids.length);
  });

  it('lays roots on multiple rows (not one wide strip) for many roots', () => {
    const ids = Array.from({ length: 31 }, (_, i) => `r${i}`);
    const pos = computeRootGridLayout(ids, opts);
    const rows = new Set(ids.map(id => Math.round(pos[id].y)));
    expect(rows.size).toBeGreaterThan(1);
    const cols = new Set(ids.map(id => Math.round(pos[id].x)));
    expect(cols.size).toBeGreaterThan(1);
  });

  it('centres the grid on the canvas (symmetric x extent)', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const pos = computeRootGridLayout(ids, opts);
    const xs = ids.map(id => pos[id].x);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    expect((minX + maxX) / 2).toBeCloseTo(cx, 0);
  });
});

describe('computeRootRegionLayout', () => {
  const W = 1400, H = 750;
  const opts = { width: W, height: H, marginX: 0, marginY: 0 };

  it('returns empty result for no groups', () => {
    expect(computeRootRegionLayout([], opts)).toEqual({ positions: {}, regions: [] });
  });

  it('drops empty groups but keeps populated ones', () => {
    const res = computeRootRegionLayout([
      { key: 'a', rootIds: ['r1', 'r2'] },
      { key: 'empty', rootIds: [] },
    ], opts);
    expect(res.regions.map(r => r.key)).toEqual(['a']);
    expect(Object.keys(res.positions).sort()).toEqual(['r1', 'r2']);
  });

  it('positions every root across all groups exactly once', () => {
    const res = computeRootRegionLayout([
      { key: 'x', rootIds: ['a', 'b', 'c'] },
      { key: 'y', rootIds: ['d', 'e'] },
      { key: 'z', rootIds: ['f'] },
    ], opts);
    expect(Object.keys(res.positions).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(res.regions).toHaveLength(3);
  });

  it('keeps each group inside its own region boundary', () => {
    const res = computeRootRegionLayout([
      { key: 'x', rootIds: ['a', 'b', 'c', 'd'] },
      { key: 'y', rootIds: ['e', 'f'] },
    ], opts);
    for (const region of res.regions) {
      const group = region.key === 'x' ? ['a', 'b', 'c', 'd'] : ['e', 'f'];
      for (const id of group) {
        const p = res.positions[id];
        expect(Math.abs(p.x - region.cx)).toBeLessThanOrEqual(region.rx + 0.001);
        expect(Math.abs(p.y - region.cy)).toBeLessThanOrEqual(region.ry + 0.001);
      }
    }
  });

  it('separates regions so their centres are distinct', () => {
    const res = computeRootRegionLayout([
      { key: 'x', rootIds: ['a'] },
      { key: 'y', rootIds: ['b'] },
      { key: 'z', rootIds: ['c'] },
    ], opts);
    const centres = res.regions.map(r => `${Math.round(r.cx)},${Math.round(r.cy)}`);
    expect(new Set(centres).size).toBe(3);
  });

  it('produces distinct positions for all roots', () => {
    const res = computeRootRegionLayout([
      { key: 'x', rootIds: ['a', 'b', 'c', 'd', 'e'] },
      { key: 'y', rootIds: ['f', 'g', 'h'] },
    ], opts);
    const pts = Object.values(res.positions).map(p => `${Math.round(p.x)},${Math.round(p.y)}`);
    expect(new Set(pts).size).toBe(8);
  });
});

describe('fitRadialCamDistance', () => {
  // Mirrors the projection + viewport constants used by LivingCosmos.
  const SVG_W = 1400, SVG_H = 750, FOCAL = 900;
  const fitOpts = {
    width: SVG_W, height: SVG_H, focal: FOCAL, tilt: (Math.PI * 22) / 180,
    marginX: 150, marginY: 120, minCamD: 1500,
  };

  // The same perspective projection the component renders with.
  function project(px: number, py: number, camD: number) {
    const sinT = Math.sin(fitOpts.tilt), cosT = Math.cos(fitOpts.tilt);
    const dx = px - SVG_W / 2, dy = py - SVG_H / 2;
    const depth = dy * sinT + camD;
    const s = FOCAL / depth;
    return { x: SVG_W / 2 + dx * s, y: SVG_H / 2 - dy * cosT * s };
  }

  function allOnScreen(ids: string[], camD: number): boolean {
    const pos = computeRootRadialLayout(ids, { width: SVG_W, height: SVG_H, marginX: 0, marginY: 0 });
    return ids.every((id) => {
      const p = project(pos[id].x, pos[id].y, camD);
      return p.x >= 0 && p.x <= SVG_W && p.y >= 0 && p.y <= SVG_H;
    });
  }

  it('never zooms in closer than the minimum distance', () => {
    const pos = computeRootRadialLayout(['a'], { width: SVG_W, height: SVG_H, marginX: 0, marginY: 0 });
    expect(fitRadialCamDistance(pos, fitOpts)).toBe(1500);
  });

  it('keeps a large root ring fully on screen (regression: 31 roots showed nothing)', () => {
    const ids = Array.from({ length: 31 }, (_, i) => `r${i}`);
    const camD = fitRadialCamDistance(
      computeRootRadialLayout(ids, { width: SVG_W, height: SVG_H, marginX: 0, marginY: 0 }),
      fitOpts,
    );
    expect(camD).toBeGreaterThan(1500);
    expect(allOnScreen(ids, camD)).toBe(true);
  });

  it('keeps every node on screen across a wide range of root counts', () => {
    for (const n of [2, 5, 12, 20, 31, 50]) {
      const ids = Array.from({ length: n }, (_, i) => `r${i}`);
      const camD = fitRadialCamDistance(
        computeRootRadialLayout(ids, { width: SVG_W, height: SVG_H, marginX: 0, marginY: 0 }),
        fitOpts,
      );
      expect(allOnScreen(ids, camD)).toBe(true);
    }
  });

  it('grows the required distance as the ring grows', () => {
    const small = fitRadialCamDistance(
      computeRootRadialLayout(['a', 'b', 'c'], { width: SVG_W, height: SVG_H, marginX: 0, marginY: 0 }),
      fitOpts,
    );
    const large = fitRadialCamDistance(
      computeRootRadialLayout(Array.from({ length: 40 }, (_, i) => `r${i}`), { width: SVG_W, height: SVG_H, marginX: 0, marginY: 0 }),
      fitOpts,
    );
    expect(large).toBeGreaterThan(small);
  });
});
