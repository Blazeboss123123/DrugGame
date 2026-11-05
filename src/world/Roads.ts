import * as THREE from 'three';
import type { Physics } from '../physics/Physics';
import { GeoBatch } from './GeoBatch';
import { RIVER, ROAD, WORLD_HALF, X_LINES, Z_LINES, bridgeSpan, districtAt, riverBed, riverX } from './CityPlan';
import type { Heightmap } from './Heightmap';
import { asphaltTexture, intersectionTexture, noiseTexture, sidewalkTexture } from './Textures';

const ROAD_Y = 0.06;
const WALK_Y = ROAD.curb + 0.06;

interface Batches {
  road: GeoBatch;
  walk: GeoBatch;
  xPlain: GeoBatch;
  xZebra: GeoBatch;
  concrete: GeoBatch;
}

/** Roads follow the terrain: every vertex samples the levelled heightmap. */
export function buildRoads(hm: Heightmap, physics: Physics): THREE.Group {
  const b: Batches = { road: new GeoBatch(), walk: new GeoBatch(), xPlain: new GeoBatch(), xZebra: new GeoBatch(), concrete: new GeoBatch() };
  const spans = Z_LINES.map((z) => bridgeSpan(z));

  // Avenues (constant x) between intersections.
  for (const x0 of X_LINES)
    for (let k = 0; k < Z_LINES.length - 1; k++) strip(b, hm, 'z', x0, Z_LINES[k] + ROAD.sidewalkHalf, Z_LINES[k + 1] - ROAD.sidewalkHalf);

  // Streets (constant z), split around bridge spans.
  Z_LINES.forEach((z0, zi) => {
    const sp = spans[zi];
    for (let k = 0; k < X_LINES.length - 1; k++) {
      const a = X_LINES[k] + ROAD.sidewalkHalf;
      const c = X_LINES[k + 1] - ROAD.sidewalkHalf;
      if (sp.xb <= a || sp.xa >= c) strip(b, hm, 'x', z0, a, c);
      else {
        if (sp.xa > a + 1) strip(b, hm, 'x', z0, a, sp.xa);
        if (sp.xb < c - 1) strip(b, hm, 'x', z0, sp.xb, c);
      }
    }
  });

  for (const x0 of X_LINES) for (const z0 of Z_LINES) intersection(b, hm, x0, z0);

  const group = new THREE.Group();
  group.name = 'roads';
  const roadMat = new THREE.MeshStandardMaterial({ map: asphaltTexture('road'), roughness: 0.92 });
  const walkMat = new THREE.MeshStandardMaterial({ map: sidewalkTexture(), roughness: 0.9 });
  const xPlain = new THREE.MeshStandardMaterial({ map: intersectionTexture(false), roughness: 0.92 });
  const xZebra = new THREE.MeshStandardMaterial({ map: intersectionTexture(true), roughness: 0.92 });
  const concrete = new THREE.MeshStandardMaterial({ map: noiseTexture(51, '#9a968e', '#fff', '#333', 8000, 2), roughness: 0.88 });
  for (const [batch, mat] of [
    [b.road, roadMat],
    [b.walk, walkMat],
    [b.xPlain, xPlain],
    [b.xZebra, xZebra],
  ] as const) {
    const m = batch.mesh(mat, false);
    if (m) group.add(m);
  }

  // Bridges over the river.
  Z_LINES.forEach((z0, zi) => bridge(b.concrete, group, hm, physics, z0, spans[zi], roadMat, walkMat));
  const cm = b.concrete.mesh(concrete, true);
  if (cm) group.add(cm);

  group.add(river(hm));
  return group;
}

/** One road segment: asphalt, two raised sidewalks with curb faces and an outer skirt. */
function strip(b: Batches, hm: Heightmap, along: 'x' | 'z', line: number, s0: number, s1: number) {
  if (s1 - s0 < 0.5) return;
  const n = Math.max(1, Math.ceil((s1 - s0) / 2));
  const P = (s: number, o: number): [number, number] => (along === 'z' ? [line + o, s] : [s, line + o]);
  const lat = [-4.5, -2.25, 0, 2.25, 4.5];
  b.road.grid(n, lat.length - 1, (r, c) => {
    const s = s0 + ((s1 - s0) * r) / n;
    const [x, z] = P(s, lat[c]);
    return [x, hm.get(x, z) + ROAD_Y, z, (lat[c] + 4.5) / 9, s / 8];
  });
  for (const side of [-1, 1]) {
    const o0 = side * ROAD.asphaltHalf;
    const o1 = side * ROAD.sidewalkHalf;
    const latW = [o0, (o0 + o1) / 2, o1];
    b.walk.grid(n, 2, (r, c) => {
      const s = s0 + ((s1 - s0) * r) / n;
      const [x, z] = P(s, latW[c]);
      return [x, hm.get(x, z) + WALK_Y, z, x / 1.5, z / 1.5];
    });
    // Curb face (toward road) and outer skirt (away from road).
    for (let r = 0; r < n; r++) {
      const sa = s0 + ((s1 - s0) * r) / n;
      const sb = s0 + ((s1 - s0) * (r + 1)) / n;
      const [ax, az] = P(sa, o0);
      const [bx, bz] = P(sb, o0);
      const want: [number, number, number] = along === 'z' ? [-side, 0, 0] : [0, 0, -side];
      const ha = hm.get(ax, az);
      const hb = hm.get(bx, bz);
      b.walk.quadFacing([ax, ha + ROAD_Y - 0.02, az], [bx, hb + ROAD_Y - 0.02, bz], [bx, hb + WALK_Y, bz], [ax, ha + WALK_Y, az], want, [sa / 1.5, 0, sb / 1.5, 0.1]);
      const [cx, cz] = P(sa, o1);
      const [dx, dz] = P(sb, o1);
      const hc = hm.get(cx, cz);
      const hd = hm.get(dx, dz);
      const out: [number, number, number] = [-want[0], 0, -want[2]];
      b.walk.quadFacing([cx, hc - 1.6, cz], [dx, hd - 1.6, dz], [dx, hd + WALK_Y, dz], [cx, hc + WALK_Y, cz], out, [sa / 1.5, 0, sb / 1.5, 0.4]);
    }
  }
}

function intersection(b: Batches, hm: Heightmap, x0: number, z0: number) {
  const zebra = ['downtown', 'commercial'].includes(districtAt(x0 + 1, z0 + 1));
  const H = ROAD.sidewalkHalf;
  const n = 7;
  (zebra ? b.xZebra : b.xPlain).grid(n, n, (r, c) => {
    const x = x0 - H + (2 * H * c) / n;
    const z = z0 - H + (2 * H * r) / n;
    return [x, hm.get(x, z) + ROAD_Y, z, (x - x0 + H) / (2 * H), (z - z0 + H) / (2 * H)];
  });
  // Raised sidewalk corners.
  const A = ROAD.asphaltHalf;
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const xa = x0 + sx * A;
      const xb = x0 + sx * H;
      const za = z0 + sz * A;
      const zb = z0 + sz * H;
      b.walk.grid(1, 1, (r, c) => {
        const x = c ? xb : xa;
        const z = r ? zb : za;
        return [x, hm.get(x, z) + WALK_Y, z, x / 1.5, z / 1.5];
      });
      // Curb faces on the two inner edges.
      const y = (x: number, z: number) => hm.get(x, z);
      b.walk.quadFacing([xa, y(xa, za) + ROAD_Y, za], [xa, y(xa, zb) + ROAD_Y, zb], [xa, y(xa, zb) + WALK_Y, zb], [xa, y(xa, za) + WALK_Y, za], [-sx, 0, 0], [0, 0, 1, 0.1]);
      b.walk.quadFacing([xa, y(xa, za) + ROAD_Y, za], [xb, y(xb, za) + ROAD_Y, za], [xb, y(xb, za) + WALK_Y, za], [xa, y(xa, za) + WALK_Y, za], [0, 0, -sz], [0, 0, 1, 0.1]);
    }
}

/** A sloped concrete deck between the two banks, with walkways, railings and piers. */
function bridge(concrete: GeoBatch, group: THREE.Group, hm: Heightmap, physics: Physics, z0: number, sp: { xa: number; xb: number }, roadMat: THREE.Material, walkMat: THREE.Material) {
  const ha = hm.get(sp.xa, z0);
  const hb = hm.get(sp.xb, z0);
  const L = sp.xb - sp.xa;
  const yAt = (x: number) => ha + ((hb - ha) * (x - sp.xa)) / L;
  const n = Math.ceil(L / 2);
  const deck = new GeoBatch();
  const walk = new GeoBatch();
  const lat = [-4.5, -2.25, 0, 2.25, 4.5];
  deck.grid(n, 4, (r, c) => {
    const x = sp.xa + (L * r) / n;
    return [x, yAt(x) + ROAD_Y, z0 + lat[c], (lat[c] + 4.5) / 9, x / 8];
  });
  for (const side of [-1, 1]) {
    const o0 = side * 4.5;
    const o1 = side * 7;
    walk.grid(n, 1, (r, c) => {
      const x = sp.xa + (L * r) / n;
      const z = z0 + (c ? o1 : o0);
      return [x, yAt(x) + WALK_Y, z, x / 1.5, z / 1.5];
    });
    for (let r = 0; r < n; r++) {
      const xa = sp.xa + (L * r) / n;
      const xb = sp.xa + (L * (r + 1)) / n;
      walk.quadFacing([xa, yAt(xa) + ROAD_Y, z0 + o0], [xb, yAt(xb) + ROAD_Y, z0 + o0], [xb, yAt(xb) + WALK_Y, z0 + o0], [xa, yAt(xa) + WALK_Y, z0 + o0], [0, 0, -side], [xa / 1.5, 0, xb / 1.5, 0.1]);
    }
  }
  const dm = deck.mesh(roadMat, false);
  const wm = walk.mesh(walkMat, false);
  if (dm) group.add(dm);
  if (wm) group.add(wm);

  // Deck body: side faces, underside, parapets.
  const T = 1.1;
  for (let r = 0; r < n; r++) {
    const xa = sp.xa + (L * r) / n;
    const xb = sp.xa + (L * (r + 1)) / n;
    const ya = yAt(xa);
    const yb = yAt(xb);
    for (const side of [-1, 1]) {
      const z = z0 + side * 7.4;
      concrete.quadFacing([xa, ya - T, z], [xb, yb - T, z], [xb, yb + 1.1, z], [xa, ya + 1.1, z], [0, 0, side], [xa / 3, 0, xb / 3, 0.7]);
      const zi = z0 + side * 7;
      concrete.quadFacing([xa, ya + WALK_Y, zi], [xb, yb + WALK_Y, zi], [xb, yb + 1.1, zi], [xa, ya + 1.1, zi], [0, 0, -side], [xa / 3, 0, xb / 3, 0.3]);
    }
    concrete.quadFacing([xa, ya - T, z0 - 7.4], [xb, yb - T, z0 - 7.4], [xb, yb - T, z0 + 7.4], [xa, ya - T, z0 + 7.4], [0, -1, 0], [xa / 3, 0, xb / 3, 5]);
    // Parapet tops.
    for (const side of [-1, 1]) {
      const zA = z0 + side * 7;
      const zB = z0 + side * 7.4;
      concrete.grid(1, 1, (rr, cc) => {
        const x = rr ? xb : xa;
        return [x, yAt(x) + 1.1, cc ? zB : zA, x / 3, cc * 0.2];
      });
    }
  }
  // Piers down to the riverbed.
  for (const t of [0.34, 0.66]) {
    const x = sp.xa + L * t;
    const top = yAt(x) - T;
    const bed = Math.min(hm.get(x, z0), riverBed(z0)) - 1;
    concrete.box(x - 1.2, bed, z0 - 5.5, x + 1.2, top, z0 + 5.5, 3);
    physics.box(x, (top + bed) / 2, z0, 1.2, (top - bed) / 2, 5.5);
  }

  // Colliders: one inclined deck slab and two parapets.
  const ang = Math.atan2(hb - ha, L);
  const q = { x: 0, y: 0, z: Math.sin(ang / 2), w: Math.cos(ang / 2) };
  const cx = (sp.xa + sp.xb) / 2;
  const cy = (ha + hb) / 2 + ROAD_Y;
  const len = Math.hypot(L, hb - ha) / 2 + 1.5;
  const nx = -Math.sin(ang);
  const ny = Math.cos(ang);
  physics.boxQuat(cx + nx * -0.5, cy + ny * -0.5, z0, len, 0.5, 7.4, q, 'concrete');
  for (const side of [-1, 1]) physics.boxQuat(cx + nx * 0.6, cy + ny * 0.6, z0 + side * 7.2, len, 0.6, 0.2, q, 'concrete');
}

function river(hm: Heightmap): THREE.Mesh {
  const g = new GeoBatch();
  const n = Math.ceil((WORLD_HALF * 2) / 4);
  const W = RIVER.waterHalf;
  g.grid(n, 4, (r, c) => {
    const z = -WORLD_HALF + (WORLD_HALF * 2 * r) / n;
    const x = riverX(z) - W + (2 * W * c) / 4;
    return [x, riverBed(z) + 1.25, z, c / 4, z / 20];
  });
  const mat = new THREE.MeshStandardMaterial({ color: 0x2e4a52, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.86 });
  const m = g.mesh(mat, false)!;
  m.receiveShadow = true;
  m.name = 'river';
  void hm;
  return m;
}
