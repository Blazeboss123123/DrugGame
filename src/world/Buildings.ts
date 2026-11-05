import * as THREE from 'three';
import type { Physics } from '../physics/Physics';
import type { BuildingSpec } from './CityGenerator';
import { GeoBatch } from './GeoBatch';
import { BAY, facadeTexture, noiseTexture, roofFlatTexture, shingleTexture, signAtlas, type FacadeStyle } from './Textures';

type V3 = [number, number, number];

export interface BuildingsResult {
  group: THREE.Group;
  /** Materials whose window glow follows the time of day. */
  nightMaterials: THREE.MeshStandardMaterial[];
  rooftop: { x: number; y: number; z: number; kind: 'ac' | 'tank' | 'vent'; yaw: number }[];
}

const STYLES: FacadeStyle[] = ['glass', 'concrete', 'brick', 'stucco', 'siding', 'corrugated', 'shop', 'barn'];

/** Buildings are merged into one mesh per facade style, which keeps the whole city to a few draw calls. */
export function buildBuildings(specs: BuildingSpec[], physics: Physics): BuildingsResult {
  const walls = new Map<FacadeStyle, GeoBatch>(STYLES.map((s) => [s, new GeoBatch()]));
  const roofFlat = new GeoBatch();
  const roofShingle = new GeoBatch();
  const trim = new GeoBatch();
  const doors = new GeoBatch();
  const signs = new GeoBatch();
  const rooftop: BuildingsResult['rooftop'] = [];
  let seed = 1;

  for (const s of specs) {
    if (s.kit) continue;
    const y0 = s.pad.h!;
    const base = y0 - 1.2;
    const x0 = s.x - s.w / 2;
    const x1 = s.x + s.w / 2;
    const z0 = s.z - s.d / 2;
    const z1 = s.z + s.d / 2;
    const top = y0 + s.height;
    const bay = BAY[s.style];
    const uOff = (seed++ % 4) * 0.25;
    const wb = walls.get(s.style)!.setColor(s.tint);

    if (s.shopfront) {
      const shop = walls.get('shop')!.setColor([1, 1, 1]);
      boxWalls(shop, x0, base, z0, x1, y0 + 4.2, z1, BAY.shop, y0, (seed % 4) * 0.25);
      if (top > y0 + 4.25) boxWalls(wb, x0, y0 + 4.2, z0, x1, top, z1, bay, y0 + 4.2, uOff);
      if (s.sign >= 0) addSign(signs, s, y0 + 4.2);
      // Trim band between shopfront and upper floors.
      trim.setColor([0.75, 0.73, 0.7]).box(x0 - 0.15, y0 + 4.05, z0 - 0.15, x1 + 0.15, y0 + 4.35, z1 + 0.15, 1);
    } else {
      boxWalls(wb, x0, base, z0, x1, top, z1, bay, y0, uOff);
    }

    if (s.roof === 'flat') {
      flatRoof(roofFlat, trim, x0, z0, x1, z1, top);
      if (s.setback) {
        const sx0 = s.x - s.setback.w / 2;
        const sx1 = s.x + s.setback.w / 2;
        const sz0 = s.z - s.setback.d / 2;
        const sz1 = s.z + s.setback.d / 2;
        const st = top + s.setback.height;
        boxWalls(wb, sx0, top, sz0, sx1, st, sz1, bay, y0 + 4.2, uOff);
        flatRoof(roofFlat, trim, sx0, sz0, sx1, sz1, st);
        physics.box(s.x, (top + st) / 2, s.z, s.setback.w / 2, (st - top) / 2, s.setback.d / 2);
        rooftop.push({ x: s.x, y: st, z: s.z, kind: 'tank', yaw: 0 });
      }
      if (s.kind === 'tower' || s.kind === 'apartment' || s.kind === 'retail' || s.kind === 'bigbox' || s.kind === 'warehouse') {
        const n = Math.max(1, Math.floor((s.w * s.d) / 220));
        for (let i = 0; i < n; i++) {
          const fx = ((i * 0.618 + 0.21) % 1) * 0.7 + 0.15;
          const fz = ((i * 0.382 + 0.37) % 1) * 0.7 + 0.15;
          const kind = s.kind === 'warehouse' ? 'vent' : i % 3 === 2 ? 'tank' : 'ac';
          if (s.setback && Math.abs(x0 + s.w * fx - s.x) < s.setback.w / 2 + 2 && Math.abs(z0 + s.d * fz - s.z) < s.setback.d / 2 + 2) continue;
          rooftop.push({ x: x0 + s.w * fx, y: top, z: z0 + s.d * fz, kind, yaw: (i % 2) * Math.PI * 0.5 });
        }
      }
    } else {
      const alongX = s.w >= s.d;
      const rise = Math.min(s.w, s.d) * 0.36;
      gableRoof(roofShingle, wb, x0, z0, x1, z1, top, rise, alongX, bay, y0);
      if (s.chimney) {
        const cx = alongX ? x0 + s.w * 0.25 : s.x + s.w * 0.18;
        const cz = alongX ? s.z + s.d * 0.18 : z0 + s.d * 0.25;
        walls.get('brick')!.setColor([0.9, 0.85, 0.8]).box(cx - 0.45, top, cz - 0.45, cx + 0.45, top + rise + 1, cz + 0.45, 1);
      }
    }

    // Front door on the facing wall.
    const dw = s.kind === 'tower' || s.kind === 'apartment' ? 2.4 : s.kind === 'barn' ? 3.6 : 1.1;
    const dh = s.kind === 'barn' ? 3.4 : s.kind === 'tower' || s.kind === 'apartment' ? 2.8 : 2.15;
    if (!s.shopfront) facadeQuad(doors, s, s.facing, dw, y0, y0 + dh, 0.03, s.kind === 'tower' || s.kind === 'apartment' ? [0.45, 0.55, 0.62] : s.kind === 'barn' ? [0.55, 0.22, 0.17] : [0.32, 0.22, 0.16]);
    if (s.dock) {
      // Loading dock: raised slab along the facing side with roller doors behind it.
      const dz = s.facing === 's' ? z1 : z0;
      const dir = s.facing === 's' ? 1 : -1;
      trim.setColor([0.62, 0.6, 0.57]).box(x0 + 2, y0 - 0.5, Math.min(dz, dz + dir * 3), x1 - 2, y0 + 1.2, Math.max(dz, dz + dir * 3), 1);
      physics.box(s.x, y0 + 0.35, dz + dir * 1.5, s.w / 2 - 2, 0.85, 1.5);
      const nDoors = Math.max(1, Math.floor(s.w / 9));
      for (let i = 0; i < nDoors; i++) {
        const cx = x0 + (s.w * (i + 0.5)) / nDoors;
        const p = dz + dir * 0.04;
        doors.setColor([0.42, 0.44, 0.45]).quadFacing([cx - 1.8, y0 + 1.2, p], [cx + 1.8, y0 + 1.2, p], [cx + 1.8, y0 + 5.2, p], [cx - 1.8, y0 + 5.2, p], [0, 0, dir], [0, 0, 1, 1]);
      }
    }
    if (s.stack) {
      const cx = x0 + 3;
      const cz = z0 + 3;
      walls.get('brick')!.setColor([0.75, 0.7, 0.66]).box(cx - 1.2, top, cz - 1.2, cx + 1.2, top + 18, cz + 1.2, 1);
      physics.box(cx, top + 9, cz, 1.2, 9, 1.2);
    }
    physics.box(s.x, (base + top) / 2, s.z, s.w / 2, (top - base) / 2, s.d / 2, 0, 'concrete');
  }

  const group = new THREE.Group();
  group.name = 'buildings';
  const nightMaterials: THREE.MeshStandardMaterial[] = [];
  STYLES.forEach((style, i) => {
    const batch = walls.get(style)!;
    if (!batch.vertexCount) return;
    const t = facadeTexture(style, 100 + i);
    const mat = new THREE.MeshStandardMaterial({
      map: t.map,
      emissiveMap: t.emissive,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0,
      vertexColors: true,
      roughness: style === 'glass' ? 0.35 : style === 'corrugated' ? 0.55 : 0.85,
      metalness: style === 'glass' ? 0.35 : style === 'corrugated' ? 0.4 : 0,
    });
    nightMaterials.push(mat);
    group.add(batch.mesh(mat)!);
  });
  const roofMat = new THREE.MeshStandardMaterial({ map: roofFlatTexture(), roughness: 0.95, vertexColors: true });
  const shingleMat = new THREE.MeshStandardMaterial({ map: shingleTexture(), roughness: 0.9, side: THREE.DoubleSide, vertexColors: true });
  const trimMat = new THREE.MeshStandardMaterial({ map: noiseTexture(61, '#bcb8b0', '#fff', '#555', 6000, 2), roughness: 0.85, vertexColors: true });
  const doorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.1 });
  const atlas = signAtlas();
  const signMat = new THREE.MeshStandardMaterial({ map: atlas.map, emissiveMap: atlas.emissive, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.6 });
  nightMaterials.push(signMat);
  for (const [b, m] of [
    [roofFlat, roofMat],
    [roofShingle, shingleMat],
    [trim, trimMat],
    [doors, doorMat],
    [signs, signMat],
  ] as const) {
    const mesh = b.mesh(m);
    if (mesh) group.add(mesh);
  }
  return { group, nightMaterials, rooftop };
}

/** Four facade faces with UVs scaled so one texture repeat is a 4 x 4 grid of window bays. */
function boxWalls(b: GeoBatch, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, bay: { w: number; h: number }, yRef: number, uOff: number) {
  const U = (d: number) => d / (bay.w * 4);
  const v0 = (y0 - yRef) / (bay.h * 4);
  const v1 = (y1 - yRef) / (bay.h * 4);
  const w = U(x1 - x0);
  const d = U(z1 - z0);
  b.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [uOff, v0, uOff + w, v1]);
  b.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [uOff + 0.5, v0, uOff + 0.5 + w, v1]);
  b.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [uOff + 0.25, v0, uOff + 0.25 + d, v1]);
  b.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [uOff + 0.75, v0, uOff + 0.75 + d, v1]);
}

function flatRoof(roof: GeoBatch, trim: GeoBatch, x0: number, z0: number, x1: number, z1: number, y: number) {
  roof.setColor([1, 1, 1]).quad([x0, y + 0.02, z1], [x1, y + 0.02, z1], [x1, y + 0.02, z0], [x0, y + 0.02, z0], [x0 / 4, z1 / 4, x1 / 4, z0 / 4]);
  // Low parapet.
  const t = 0.25;
  const h = 0.6;
  trim.setColor([0.8, 0.78, 0.74]);
  trim.box(x0, y, z0, x1, y + h, z0 + t, 1);
  trim.box(x0, y, z1 - t, x1, y + h, z1, 1);
  trim.box(x0, y, z0, x0 + t, y + h, z1, 1);
  trim.box(x1 - t, y, z0, x1, y + h, z1, 1);
}

function gableRoof(roof: GeoBatch, wall: GeoBatch, x0: number, z0: number, x1: number, z1: number, y: number, rise: number, alongX: boolean, bay: { w: number; h: number }, yRef: number) {
  const o = 0.45;
  const yr = y + rise;
  roof.setColor([1, 1, 1]);
  const V = (yy: number) => (yy - yRef) / (bay.h * 4);
  if (alongX) {
    const zm = (z0 + z1) / 2;
    const half = (z1 - z0) / 2;
    const yl = y - (o * rise) / half;
    const sl = Math.hypot(half + o, rise + (o * rise) / half) / 2;
    roof.quad([x0 - o, yl, z1 + o], [x1 + o, yl, z1 + o], [x1 + o, yr, zm], [x0 - o, yr, zm], [0, 0, (x1 - x0 + 2 * o) / 2, sl]);
    roof.quad([x1 + o, yl, z0 - o], [x0 - o, yl, z0 - o], [x0 - o, yr, zm], [x1 + o, yr, zm], [0, 0, (x1 - x0 + 2 * o) / 2, sl]);
    const U = (z: number) => (z - z0) / (bay.w * 4);
    wall.tri([x0, y, z0], [x0, y, z1], [x0, yr, zm], [U(z0), V(y)], [U(z1), V(y)], [U(zm), V(yr)]);
    wall.tri([x1, y, z1], [x1, y, z0], [x1, yr, zm], [U(z1), V(y)], [U(z0), V(y)], [U(zm), V(yr)]);
  } else {
    const xm = (x0 + x1) / 2;
    const half = (x1 - x0) / 2;
    const yl = y - (o * rise) / half;
    const sl = Math.hypot(half + o, rise + (o * rise) / half) / 2;
    roof.quad([x1 + o, yl, z1 + o], [x1 + o, yl, z0 - o], [xm, yr, z0 - o], [xm, yr, z1 + o], [0, 0, (z1 - z0 + 2 * o) / 2, sl]);
    roof.quad([x0 - o, yl, z0 - o], [x0 - o, yl, z1 + o], [xm, yr, z1 + o], [xm, yr, z0 - o], [0, 0, (z1 - z0 + 2 * o) / 2, sl]);
    const U = (x: number) => (x - x0) / (bay.w * 4);
    wall.tri([x0, y, z1], [x1, y, z1], [xm, yr, z1], [U(x0), V(y)], [U(x1), V(y)], [U(xm), V(yr)]);
    wall.tri([x1, y, z0], [x0, y, z0], [xm, yr, z0], [U(x1), V(y)], [U(x0), V(y)], [U(xm), V(yr)]);
  }
}

/** A flat rectangle centred on a building's facing wall (doors, decals). */
function facadeQuad(b: GeoBatch, s: BuildingSpec, facing: string, width: number, y0: number, y1: number, off: number, color: [number, number, number]) {
  b.setColor(color);
  const hw = width / 2;
  let p: V3[];
  let n: V3;
  if (facing === 's') {
    const z = s.z + s.d / 2 + off;
    p = [[s.x - hw, y0, z], [s.x + hw, y0, z], [s.x + hw, y1, z], [s.x - hw, y1, z]];
    n = [0, 0, 1];
  } else if (facing === 'n') {
    const z = s.z - s.d / 2 - off;
    p = [[s.x + hw, y0, z], [s.x - hw, y0, z], [s.x - hw, y1, z], [s.x + hw, y1, z]];
    n = [0, 0, -1];
  } else if (facing === 'e') {
    const x = s.x + s.w / 2 + off;
    p = [[x, y0, s.z + hw], [x, y0, s.z - hw], [x, y1, s.z - hw], [x, y1, s.z + hw]];
    n = [1, 0, 0];
  } else {
    const x = s.x - s.w / 2 - off;
    p = [[x, y0, s.z - hw], [x, y0, s.z + hw], [x, y1, s.z + hw], [x, y1, s.z - hw]];
    n = [-1, 0, 0];
  }
  b.quadFacing(p[0], p[1], p[2], p[3], n, [0, 0, 1, 1]);
}

function addSign(b: GeoBatch, s: BuildingSpec, y: number) {
  const width = Math.min(s.w * 0.7, 9);
  const v0 = s.sign / 16;
  const v1 = (s.sign + 1) / 16;
  b.setColor([1, 1, 1]);
  const off = 0.08;
  const y0 = y + 0.25;
  const y1 = y + 1.35;
  const hw = width / 2;
  if (s.facing === 's') {
    const z = s.z + s.d / 2 + off;
    b.quad([s.x - hw, y0, z], [s.x + hw, y0, z], [s.x + hw, y1, z], [s.x - hw, y1, z], [0, v0, 1, v1]);
  } else {
    const z = s.z - s.d / 2 - off;
    b.quad([s.x + hw, y0, z], [s.x - hw, y0, z], [s.x - hw, y1, z], [s.x + hw, y1, z], [0, v0, 1, v1]);
  }
}
