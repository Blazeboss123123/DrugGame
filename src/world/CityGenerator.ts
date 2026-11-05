import { Rng, smoothstep } from '../core/math';
import { PROPERTY_LOTS } from '../properties/PropertyDefs';
import { BAY, type FacadeStyle } from './Textures';
import { ROAD, WORLD_HALF, X_LINES, Z_LINES, districtAt, riverCarve, roadDistance, type District } from './CityPlan';
import type { Pad } from './Heightmap';

/**
 * Lays out the city's lots block by block. Output is pure data (positions, sizes, styles); heights
 * are resolved later once plots have been levelled into the terrain.
 */

export type Facing = 'n' | 's' | 'e' | 'w';
export type BuildingKind = 'tower' | 'apartment' | 'house' | 'terrace' | 'retail' | 'bigbox' | 'warehouse' | 'barn' | 'cabin';

export interface BuildingSpec {
  kind: BuildingKind;
  x: number;
  z: number;
  w: number;
  d: number;
  height: number;
  style: FacadeStyle;
  roof: 'flat' | 'gable';
  facing: Facing;
  shopfront: boolean;
  sign: number;
  tint: [number, number, number];
  pad: Pad;
  /** Optional narrower upper section for towers. */
  setback?: { w: number; d: number; height: number };
  chimney?: boolean;
  dock?: boolean;
  stack?: boolean;
  /** Rendered with a MegaKit model instead of procedural geometry. */
  kit?: string;
}

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface FenceSeg {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  kind: 'picket' | 'chain';
}

export interface TreeSpot {
  x: number;
  z: number;
  type: 'broad' | 'pine';
  scale: number;
  /** Explicit base height (for raised surfaces); defaults to the terrain. */
  y?: number;
}

export interface Spot {
  x: number;
  z: number;
  yaw: number;
  y?: number;
}

export interface CarSpot extends Spot {
  color: number;
}

export interface ParkingLot extends Rect {
  pad: Pad;
  stallsAlong: 'x' | 'z';
}

export interface ContainerSpot extends Spot {
  len: number;
  level: number;
  color: number;
}

export interface CityContent {
  buildings: BuildingSpec[];
  pads: Pad[];
  fences: FenceSeg[];
  trees: TreeSpot[];
  benches: Spot[];
  bins: Spot[];
  cars: CarSpot[];
  lots: ParkingLot[];
  containers: ContainerSpot[];
  parks: Rect[];
  reserved: Rect[];
  propFree: Rect[];
}

export const STARTER = {
  lot: { x0: -65, z0: -109, x1: -45, z1: -85 },
  house: { x: -55, z: -95, w: 12, d: 10 },
  plaza: { x0: 10, z0: -65, x1: 65, z1: -10 },
};

const CAR_COLORS = [0x8f2b2b, 0x2b3f63, 0xd7d4cc, 0x1d1f22, 0x5f6a70, 0x30503f, 0x9a7a3c, 0xb6b9bd, 0x6b2f4a, 0x2f6b7a];
const CONTAINER_COLORS = [0x8e3b2d, 0x2e5a7a, 0x4f6b3a, 0xa8742c, 0x6a6f74, 0x7a2f4b];
const HOUSE_TINTS: [number, number, number][] = [
  [0.82, 0.88, 0.95],
  [0.98, 0.93, 0.8],
  [0.82, 0.9, 0.82],
  [0.92, 0.9, 0.88],
  [0.98, 0.88, 0.78],
  [0.75, 0.8, 0.86],
  [1, 1, 1],
];

const snap = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);
const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0;

export function generateCity(seed = 1337): CityContent {
  const rng = new Rng(seed);
  const out: CityContent = {
    buildings: [],
    pads: [],
    fences: [],
    trees: [],
    benches: [],
    bins: [],
    cars: [],
    lots: [],
    containers: [],
    parks: [],
    reserved: [STARTER.lot, STARTER.plaza, ...PROPERTY_LOTS],
    propFree: [
      { x0: -54.5, z0: -86, x1: -47.5, z1: -70 }, // starter driveway approach
      { x0: -59.5, z0: -86, x1: -55.5, z1: -78 }, // starter front path
    ],
  };
  const inset = 10;

  const riverHits = (r: Rect) => {
    for (const [x, z] of [
      [r.x0, r.z0],
      [r.x1, r.z0],
      [r.x0, r.z1],
      [r.x1, r.z1],
      [(r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2],
    ])
      if (riverCarve(x, z) > 0 || Math.abs(x - riverXApprox(z)) < 36) return true;
    return false;
  };
  const isReserved = (r: Rect) => out.reserved.some((q) => overlaps(q, r));

  const addBuilding = (b: Omit<BuildingSpec, 'pad'> & { padMargin?: number; padBlend?: number }) => {
    const m = b.padMargin ?? 1.5;
    const pad: Pad = { x0: b.x - b.w / 2 - m, z0: b.z - b.d / 2 - m, x1: b.x + b.w / 2 + m, z1: b.z + b.d / 2 + m, blend: b.padBlend ?? 3 };
    out.pads.push(pad);
    out.buildings.push({ ...b, pad });
  };

  for (let xi = 0; xi < X_LINES.length - 1; xi++) {
    for (let zi = 0; zi < Z_LINES.length - 1; zi++) {
      const r: Rect = { x0: X_LINES[xi] + inset, x1: X_LINES[xi + 1] - inset, z0: Z_LINES[zi] + inset, z1: Z_LINES[zi + 1] - inset };
      const cx = (r.x0 + r.x1) / 2;
      const cz = (r.z0 + r.z1) / 2;
      const district = districtAt(cx, cz);
      if (r.x0 === STARTER.plaza.x0 && r.z0 === STARTER.plaza.z0) continue; // plaza is hand-built
      if (PROPERTY_LOTS.some((l) => overlaps(l, r))) continue; // purchasable properties are hand-built
      switch (district) {
        case 'residential':
          residentialBlock(r);
          break;
        case 'downtown':
          downtownBlock(r);
          break;
        case 'commercial':
          commercialBlock(r);
          break;
        case 'industrial':
          industrialBlock(r);
          break;
        default:
          break;
      }
    }
  }
  outskirts();
  riverTrees();
  return out;

  // ---------------------------------------------------------------- residential
  function residentialBlock(r: Rect) {
    const roll = rng.next();
    const wide = r.x1 - r.x0 > 100; // west-bank blocks straddle the river
    if (!wide && roll < 0.12 && !isReserved(r)) return park(r);
    if (!wide && roll < 0.27 && !isReserved(r)) return apartments(r);
    const terrace = !wide && rng.chance(0.16) && !isReserved(r);
    const rows: { z0: number; z1: number; facing: Facing }[] = [
      { z0: r.z0, z1: r.z0 + 24, facing: 'n' },
      { z0: r.z1 - 24, z1: r.z1, facing: 's' },
    ];
    for (const row of rows) {
      if (terrace) {
        terraceRow(r, row);
        continue;
      }
      let x = r.x0;
      while (x + 15 <= r.x1 + 0.1) {
        const lotW = Math.min(rng.range(15, 18.5), r.x1 - x);
        if (lotW < 14) break;
        const lot: Rect = { x0: x, x1: x + lotW, z0: row.z0, z1: row.z1 };
        x += lotW;
        if (riverHits(lot) || isReserved(lot)) continue;
        house(lot, row.facing);
      }
    }
  }

  function house(lot: Rect, facing: Facing) {
    const twoStorey = rng.chance(0.45);
    const w = snap(rng.range(8.5, 11.5), 1.5);
    const d = snap(rng.range(8, 10), 1);
    const setback = rng.range(4, 6.5);
    const cx = (lot.x0 + lot.x1) / 2 + rng.range(-1, 1);
    const cz = facing === 's' ? lot.z1 - setback - d / 2 : lot.z0 + setback + d / 2;
    addBuilding({
      kind: 'house',
      x: cx,
      z: cz,
      w,
      d,
      height: twoStorey ? 6 : 3.2,
      style: 'siding',
      roof: 'gable',
      facing,
      shopfront: false,
      sign: -1,
      tint: rng.pick(HOUSE_TINTS),
      chimney: rng.chance(0.4),
      padMargin: 2,
      padBlend: 3,
    });
    // Side and back fences.
    const front = facing === 's' ? lot.z1 - 2 : lot.z0 + 2;
    const back = facing === 's' ? lot.z0 : lot.z1;
    out.fences.push({ x0: lot.x0, z0: front, x1: lot.x0, z1: back, kind: 'picket' });
    out.fences.push({ x0: lot.x0, z0: back, x1: lot.x1, z1: back, kind: 'picket' });
    if (rng.chance(0.6)) {
      const tz = facing === 's' ? lot.z0 + rng.range(2, 5) : lot.z1 - rng.range(2, 5);
      out.trees.push({ x: rng.range(lot.x0 + 2, lot.x1 - 2), z: tz, type: rng.chance(0.25) ? 'pine' : 'broad', scale: rng.range(0.8, 1.25) });
    }
    if (rng.chance(0.35)) {
      const fz = facing === 's' ? lot.z1 - rng.range(1, 2.5) : lot.z0 + rng.range(1, 2.5);
      out.trees.push({ x: rng.chance(0.5) ? lot.x0 + 2 : lot.x1 - 2, z: fz, type: 'broad', scale: rng.range(0.55, 0.8) });
    }
  }

  function terraceRow(r: Rect, row: { z0: number; z1: number; facing: Facing }) {
    const unit = 6;
    const d = 11;
    const len = Math.floor((r.x1 - r.x0 - 4) / unit) * unit;
    let x = r.x0 + 2;
    const cz = row.facing === 's' ? row.z1 - 3 - d / 2 : row.z0 + 3 + d / 2;
    // Split the terrace into runs of 3-5 units so it steps with the hillside.
    while (x + unit * 3 <= r.x0 + 2 + len) {
      const n = Math.min(rng.int(3, 5), Math.floor((r.x0 + 2 + len - x) / unit));
      const w = n * unit;
      const lot: Rect = { x0: x, x1: x + w, z0: row.z0, z1: row.z1 };
      if (!riverHits(lot) && !isReserved(lot))
        addBuilding({
          kind: 'terrace',
          x: x + w / 2,
          z: cz,
          w,
          d,
          height: 6.4,
          style: 'brick',
          roof: 'flat',
          facing: row.facing,
          shopfront: false,
          sign: -1,
          tint: [rng.range(0.85, 1), rng.range(0.85, 1), rng.range(0.85, 1)],
          padMargin: 1,
        });
      x += w + 1;
    }
  }

  function apartments(r: Rect) {
    const n = rng.chance(0.5) ? 1 : 2;
    const style: FacadeStyle = rng.chance(0.5) ? 'brick' : 'stucco';
    for (let k = 0; k < n; k++) {
      const w = snap(n === 1 ? rng.range(30, 40) : rng.range(18, 24), 3);
      const d = snap(rng.range(14, 18), 3);
      const cx = n === 1 ? (r.x0 + r.x1) / 2 : k === 0 ? r.x0 + w / 2 + 3 : r.x1 - w / 2 - 3;
      const cz = (r.z0 + r.z1) / 2 + rng.range(-6, 6);
      const lot = { x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 };
      if (riverHits(lot)) continue;
      addBuilding({
        kind: 'apartment',
        x: cx,
        z: cz,
        w,
        d,
        height: BAY[style].h * rng.int(4, 6),
        style,
        roof: 'flat',
        facing: rng.chance(0.5) ? 's' : 'n',
        shopfront: false,
        sign: -1,
        tint: [rng.range(0.9, 1), rng.range(0.88, 1), rng.range(0.85, 1)],
      });
    }
    for (let i = 0; i < 6; i++) out.trees.push({ x: rng.range(r.x0 + 2, r.x1 - 2), z: rng.chance(0.5) ? r.z0 + 3 : r.z1 - 3, type: 'broad', scale: rng.range(0.8, 1.2) });
  }

  function park(r: Rect) {
    out.parks.push(r);
    const n = rng.int(14, 22);
    for (let i = 0; i < n; i++)
      out.trees.push({ x: rng.range(r.x0 + 2, r.x1 - 2), z: rng.range(r.z0 + 2, r.z1 - 2), type: rng.chance(0.3) ? 'pine' : 'broad', scale: rng.range(0.9, 1.5) });
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      out.benches.push({ x: cx + Math.cos(a) * 9, z: cz + Math.sin(a) * 9, yaw: Math.atan2(-Math.cos(a), -Math.sin(a)) });
    }
    out.bins.push({ x: cx + 11, z: cz, yaw: 0 });
  }

  // ---------------------------------------------------------------- downtown
  function downtownBlock(r: Rect) {
    const cx = (r.x0 + r.x1) / 2;
    const cz = (r.z0 + r.z1) / 2;
    const distC = Math.hypot(cx - 20, cz - 30);
    const tall = 1 - smoothstep(30, 200, distC);
    const layout = rng.pick(['one', 'two', 'four', 'four', 'two']);
    const cells: Rect[] = [];
    const mx = (r.x0 + r.x1) / 2;
    const mz = (r.z0 + r.z1) / 2;
    if (layout === 'one') cells.push(r);
    else if (layout === 'two') {
      if (rng.chance(0.5)) cells.push({ ...r, x1: mx - 1.5 }, { ...r, x0: mx + 1.5 });
      else cells.push({ ...r, z1: mz - 1.5 }, { ...r, z0: mz + 1.5 });
    } else
      cells.push(
        { x0: r.x0, z0: r.z0, x1: mx - 1.5, z1: mz - 1.5 },
        { x0: mx + 1.5, z0: r.z0, x1: r.x1, z1: mz - 1.5 },
        { x0: r.x0, z0: mz + 1.5, x1: mx - 1.5, z1: r.z1 },
        { x0: mx + 1.5, z0: mz + 1.5, x1: r.x1, z1: r.z1 },
      );
    for (const c of cells) {
      const style: FacadeStyle = rng.pick(tall > 0.5 ? ['glass', 'glass', 'concrete'] : ['concrete', 'brick', 'stucco', 'glass']);
      const bay = BAY[style];
      const w = snap((c.x1 - c.x0) * rng.range(0.78, 0.95), bay.w);
      const d = snap((c.z1 - c.z0) * rng.range(0.78, 0.95), bay.w);
      const floors = Math.max(3, Math.round((4 + tall * 20) * rng.range(0.6, 1.25)));
      const x = (c.x0 + c.x1) / 2;
      const z = (c.z0 + c.z1) / 2;
      const facing: Facing = Math.abs(z - r.z0) < Math.abs(z - r.z1) ? 'n' : 's';
      const hasSetback = floors > 12 && rng.chance(0.5);
      addBuilding({
        kind: 'tower',
        x,
        z,
        w,
        d,
        height: 4.2 + floors * bay.h,
        style,
        roof: 'flat',
        facing,
        shopfront: rng.chance(0.65),
        sign: rng.int(0, 15),
        tint: [rng.range(0.88, 1), rng.range(0.9, 1), rng.range(0.92, 1)],
        setback: hasSetback ? { w: snap(w * 0.65, bay.w), d: snap(d * 0.65, bay.w), height: rng.int(3, 8) * bay.h } : undefined,
      });
    }
    // Street trees in planters along the block edge.
    for (let x = r.x0 + 6; x < r.x1 - 4; x += 14) {
      out.trees.push({ x, z: r.z0 - 1.5, type: "broad", scale: 0.75 });
      out.trees.push({ x, z: r.z1 + 1.5, type: "broad", scale: 0.75 });
    }
    out.bins.push({ x: r.x0 + 2, z: r.z0 - 4.5, yaw: 0 }, { x: r.x1 - 2, z: r.z1 + 4.5, yaw: 0 });
    out.benches.push({ x: (r.x0 + r.x1) / 2 + 7, z: r.z1 + 4.6, yaw: Math.PI }, { x: (r.x0 + r.x1) / 2 - 7, z: r.z0 - 4.6, yaw: 0 });
  }

  // ---------------------------------------------------------------- commercial
  function commercialBlock(r: Rect) {
    if (rng.chance(0.3)) {
      const w = snap(48, 4);
      const d = snap(32, 4);
      const x = (r.x0 + r.x1) / 2;
      const z = r.z0 + d / 2 + 2;
      addBuilding({ kind: 'bigbox', x, z, w, d, height: 9, style: 'corrugated', roof: 'flat', facing: 's', shopfront: true, sign: rng.int(0, 15), tint: [0.95, 0.93, 0.9] });
      lot({ x0: r.x0 + 2, x1: r.x1 - 2, z0: z + d / 2 + 4, z1: r.z1 - 1 }, 'x');
      return;
    }
    // Shop row along the south side, parking behind (north).
    let x = r.x0;
    while (x < r.x1 - 14) {
      const w = snap(Math.min(rng.range(16, 26), r.x1 - x), 4);
      if (w < 12) break;
      const d = snap(rng.range(14, 18), 3);
      const style: FacadeStyle = rng.pick(['brick', 'stucco', 'concrete']);
      addBuilding({
        kind: 'retail',
        x: x + w / 2,
        z: r.z1 - d / 2 - 1,
        w,
        d,
        height: 4.2 + BAY[style].h * rng.int(0, 2),
        style,
        roof: 'flat',
        facing: 's',
        shopfront: true,
        sign: rng.int(0, 15),
        tint: [rng.range(0.85, 1), rng.range(0.85, 1), rng.range(0.85, 1)],
      });
      x += w + 2;
    }
    lot({ x0: r.x0 + 2, x1: r.x1 - 2, z0: r.z0 + 1, z1: r.z1 - 22 }, 'x');
  }

  function lot(r: Rect, along: 'x' | 'z') {
    if (r.z1 - r.z0 < 10) return;
    const pad: Pad = { ...r, blend: 3 };
    out.pads.push(pad);
    out.lots.push({ ...r, pad, stallsAlong: along });
    // Cars in stalls: two rows facing each other.
    const rowsZ = [r.z0 + 3, r.z0 + 9.5].filter((z) => z + 2.5 < r.z1);
    for (const z of rowsZ)
      for (let x = r.x0 + 2; x < r.x1 - 2; x += 2.8)
        if (rng.chance(0.45)) out.cars.push({ x: x + 1.4, z, yaw: Math.PI / 2 + (rng.chance(0.5) ? Math.PI : 0), color: rng.pick(CAR_COLORS) });
    out.trees.push({ x: r.x0 + 1, z: r.z0 + 1, type: 'broad', scale: 0.8 }, { x: r.x1 - 1, z: r.z1 - 1, type: 'broad', scale: 0.8 });
  }

  // ---------------------------------------------------------------- industrial
  function industrialBlock(r: Rect) {
    if (r.x1 - r.x0 > 100) r = { ...r, x1: -284 }; // west-bank block: keep clear of the river valley
    const w = snap(Math.min(rng.range(34, 46), r.x1 - r.x0 - 8), 4);
    const d = snap(rng.range(24, 32), 4);
    const left = rng.chance(0.5);
    const x = left ? r.x0 + w / 2 + 2 : r.x1 - w / 2 - 2;
    const z = r.z0 + d / 2 + 3;
    addBuilding({
      kind: 'warehouse',
      x,
      z,
      w,
      d,
      height: rng.pick([9, 10, 12, 14]),
      style: 'corrugated',
      roof: 'flat',
      facing: 's',
      shopfront: false,
      sign: -1,
      tint: rng.pick<[number, number, number]>([
        [1, 1, 1],
        [0.85, 0.9, 1],
        [1, 0.92, 0.82],
        [0.86, 0.95, 0.88],
      ]),
      dock: true,
      stack: rng.chance(0.35),
    });
    // Yard: pad, containers, chain-link fence with a gate on the south road.
    const yard: Rect = { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 };
    void yard;
    const yx0 = left ? x + w / 2 + 4 : r.x0 + 3;
    const yx1 = left ? r.x1 - 3 : x - w / 2 - 4;
    for (let zz = r.z0 + 4; zz < r.z1 - 8; zz += 3.2) {
      if (!rng.chance(0.55) || yx1 - yx0 < 7) continue;
      const len = rng.chance(0.5) ? 12 : 6;
      const cx = rng.range(yx0 + len / 2, Math.max(yx0 + len / 2, yx1 - len / 2));
      const color = rng.pick(CONTAINER_COLORS);
      out.containers.push({ x: cx, z: zz, yaw: 0, len, level: 0, color });
      if (rng.chance(0.35)) out.containers.push({ x: cx, z: zz, yaw: 0, len, level: 1, color: rng.pick(CONTAINER_COLORS) });
    }
    const gx = (r.x0 + r.x1) / 2;
    out.fences.push({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z0, kind: 'chain' });
    out.fences.push({ x0: r.x0, z0: r.z0, x1: r.x0, z1: r.z1, kind: 'chain' });
    out.fences.push({ x0: r.x1, z0: r.z0, x1: r.x1, z1: r.z1, kind: 'chain' });
    out.fences.push({ x0: r.x0, z0: r.z1, x1: gx - 5, z1: r.z1, kind: 'chain' });
    out.fences.push({ x0: gx + 5, z0: r.z1, x1: r.x1, z1: r.z1, kind: 'chain' });
    // Trucks/cars parked in the yard.
    for (let i = 0; i < 3; i++) if (rng.chance(0.6)) out.cars.push({ x: rng.range(r.x0 + 4, r.x1 - 4), z: r.z1 - 4, yaw: 0, color: rng.pick(CAR_COLORS) });
  }

  // ---------------------------------------------------------------- outskirts
  function outskirts() {
    let placed = 0;
    let tries = 0;
    while (placed < 26 && tries < 600) {
      tries++;
      const x = rng.range(-WORLD_HALF + 30, WORLD_HALF - 30);
      const z = rng.range(-WORLD_HALF + 30, WORLD_HALF - 30);
      if (districtAt(x, z) !== 'outskirts' || roadDistance(x, z) < 30) continue;
      if (riverCarve(x, z) > 0 || Math.abs(x - riverXApprox(z)) < 45) continue;
      const barn = rng.chance(0.35);
      const w = barn ? 16 : snap(rng.range(10, 14), 1.5);
      const d = barn ? 12 : snap(rng.range(9, 12), 1);
      const lotR = { x0: x - w, x1: x + w, z0: z - d, z1: z + d };
      if (out.buildings.some((b) => overlaps(lotR, { x0: b.x - b.w, x1: b.x + b.w, z0: b.z - b.d, z1: b.z + b.d }))) continue;
      if (isReserved(lotR)) continue;
      addBuilding({
        kind: barn ? 'barn' : 'cabin',
        x,
        z,
        w,
        d,
        height: barn ? 6 : rng.chance(0.4) ? 6 : 3.2,
        style: barn ? 'barn' : 'siding',
        roof: 'gable',
        facing: rng.pick(['n', 's'] as Facing[]),
        shopfront: false,
        sign: -1,
        tint: barn ? [1, 1, 1] : rng.pick(HOUSE_TINTS),
        chimney: !barn && rng.chance(0.6),
        padMargin: 3,
        padBlend: 6,
      });
      placed++;
    }
    // Forests on the ridges.
    let trees = 0;
    tries = 0;
    while (trees < 1400 && tries < 9000) {
      tries++;
      const x = rng.range(-WORLD_HALF + 4, WORLD_HALF - 4);
      const z = rng.range(-WORLD_HALF + 4, WORLD_HALF - 4);
      if (districtAt(x, z) !== 'outskirts' || roadDistance(x, z) < ROAD.sidewalkHalf + 6) continue;
      if (Math.abs(x - riverXApprox(z)) < 18) continue;
      const cluster = 0.5 + 0.5 * Math.sin(x * 0.021 + Math.cos(z * 0.017) * 3);
      if (rng.next() > 0.35 + cluster * 0.6) continue;
      if (out.buildings.some((b) => Math.abs(b.x - x) < b.w / 2 + 4 && Math.abs(b.z - z) < b.d / 2 + 4)) continue;
      if (isReserved({ x0: x - 3, x1: x + 3, z0: z - 3, z1: z + 3 })) continue;
      out.trees.push({ x, z, type: rng.chance(0.55) ? 'pine' : 'broad', scale: rng.range(0.9, 1.7) });
      trees++;
    }
  }

  function riverTrees() {
    for (let z = -WORLD_HALF + 10; z < WORLD_HALF - 10; z += 9) {
      for (const side of [-1, 1]) {
        if (!rng.chance(0.55)) continue;
        const x = riverXApprox(z) + side * rng.range(31, 40);
        if (roadDistance(x, z) < 12) continue;
        out.trees.push({ x, z: z + rng.range(-3, 3), type: rng.chance(0.4) ? 'pine' : 'broad', scale: rng.range(0.9, 1.4) });
      }
    }
  }
}

function riverXApprox(z: number) {
  return -215 + 22 * Math.sin(z / 110) + 5 * Math.sin(z / 41 + 1.3);
}

export type { District };
