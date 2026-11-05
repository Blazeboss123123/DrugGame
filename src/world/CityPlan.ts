import { smoothstep } from '../core/math';

/**
 * The fixed layout of Harlow: road grid, river, district boundaries and names.
 * Everything else (terrain, buildings, props) is derived from this plan deterministically.
 */
export type District = 'downtown' | 'residential' | 'industrial' | 'commercial' | 'outskirts';

export const DISTRICTS: Record<District, { name: string; kind: string }> = {
  downtown: { name: 'Meridian', kind: 'Downtown' },
  residential: { name: 'Maple Hill', kind: 'Residential' },
  industrial: { name: 'Ironworks', kind: 'Industrial district' },
  commercial: { name: 'Market Row', kind: 'Commercial district' },
  outskirts: { name: 'Cedar Ridge', kind: 'Outskirts' },
};

export const CITY_NAME = 'Harlow';
export const WORLD_HALF = 480;

/** Avenues run north-south (constant x); streets run east-west (constant z). North is -z. */
export const X_LINES = [-330, -150, -75, 0, 75, 150, 225, 300];
export const Z_LINES = [-300, -225, -150, -75, 0, 75, 150, 225, 300];
export const AVENUES = ['Quarry Ave', 'Riverside Dr', 'Ash Ave', 'Central Ave', 'Bell Ave', 'Harbor Ave', 'Lowell Ave', 'Eastgate Ave'];
export const STREETS = ['Summit Rd', 'Elm St', 'Court St', 'Larch St', 'Main St', 'Union St', 'Canal St', 'Dock St', 'Foundry Rd'];
export const GRID = { x0: -330, x1: 300, z0: -300, z1: 300 };

/** Road cross-section, measured from the centre line. */
export const ROAD = { asphaltHalf: 4.5, sidewalkHalf: 7, blend: 4, curb: 0.16 };

export const RIVER = { flatHalf: 8, bankHalf: 30, waterHalf: 15 };
export const riverX = (z: number) => -215 + 22 * Math.sin(z / 110) + 5 * Math.sin(z / 41 + 1.3);
export const riverBed = (z: number) => -7 + z * 0.012;
export const riverCarve = (x: number, z: number) => 1 - smoothstep(RIVER.flatHalf, RIVER.bankHalf, Math.abs(x - riverX(z)));
export const BRIDGE_HALF = 34;
export function bridgeSpan(z0: number): { xa: number; xb: number } {
  const rx = riverX(z0);
  return { xa: rx - BRIDGE_HALF, xb: rx + BRIDGE_HALF };
}

export function inGridX(x: number, pad = 0) {
  return x >= GRID.x0 - pad && x <= GRID.x1 + pad;
}
export function inGridZ(z: number, pad = 0) {
  return z >= GRID.z0 - pad && z <= GRID.z1 + pad;
}

export function districtAt(x: number, z: number): District {
  if (!inGridX(x, 12) || !inGridZ(z, 12)) return 'outskirts';
  if (z > 150) return 'industrial';
  if (z < -75) return 'residential';
  if (x > 150) return 'commercial';
  if (x < -150) return 'residential';
  return 'downtown';
}

export function nearestLine(lines: readonly number[], v: number): { line: number; dist: number; index: number } {
  let index = 0;
  let dist = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const d = Math.abs(v - lines[i]);
    if (d < dist) {
      dist = d;
      index = i;
    }
  }
  return { line: lines[index], dist, index };
}

/** Distance to the nearest road centre line (Infinity if none nearby), honouring bridge spans. */
export function roadDistance(x: number, z: number): number {
  let best = Infinity;
  if (inGridZ(z, 7)) best = Math.min(best, nearestLine(X_LINES, x).dist);
  if (inGridX(x, 7)) {
    const n = nearestLine(Z_LINES, z);
    best = Math.min(best, n.dist);
  }
  return best;
}

export function streetNameAt(x: number, z: number): string | null {
  const nx = nearestLine(X_LINES, x);
  const nz = nearestLine(Z_LINES, z);
  const ax = inGridZ(z, 8) ? nx.dist : Infinity;
  const az = inGridX(x, 8) ? nz.dist : Infinity;
  if (Math.min(ax, az) > 40) return null;
  return ax < az ? AVENUES[nx.index] : STREETS[nz.index];
}

/** True where the ground is a levelled road corridor (bridge spans excluded: there the ground is the valley). */
export function onRoadCorridor(x: number, z: number, half = ROAD.sidewalkHalf + 0.6): boolean {
  if (inGridZ(z, 7) && nearestLine(X_LINES, x).dist <= half) return true;
  if (inGridX(x, 7)) {
    const n = nearestLine(Z_LINES, z);
    if (n.dist <= half) {
      const sp = bridgeSpan(n.line);
      if (x < sp.xa - 1 || x > sp.xb + 1) return true;
    }
  }
  return false;
}
