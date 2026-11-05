import { fbm, lerp, smoothstep } from '../core/math';
import { GRID, ROAD, X_LINES, Z_LINES, bridgeSpan, inGridX, inGridZ, nearestLine, riverBed, riverCarve, riverX } from './CityPlan';
import type { Heightmap } from './Heightmap';

/**
 * Large-scale landform of Harlow: a gently rolling basin, a hilly residential north, a flat industrial
 * south, steep wooded ridges around the edge and a river valley along the west.
 */
export function baseHeight(x: number, z: number): number {
  let h = fbm(x / 260 + 11, z / 260 - 4, 4, 3) * 16 - z * 0.022;

  // Ridges around the city edge (outskirts).
  const r = Math.max(Math.abs(x + 15), Math.abs(z));
  const o = smoothstep(330, 440, r);
  h += o * (16 + 34 * (fbm(x / 120, z / 120, 4, 9) * 0.5 + 0.5));

  // Hilly north and west bank.
  const hilly = Math.min(1, smoothstep(-40, -140, z) + smoothstep(-160, -230, x) * 0.6) * (1 - o);
  h += hilly * fbm(x / 85 + 3, z / 85 + 9, 3, 21) * 13 + hilly * 4;

  // Flat industrial south.
  const ind = smoothstep(130, 175, z) * (1 - o);
  h = lerp(h, -1 + fbm(x / 200, z / 200, 2, 5) * 2.5, ind * 0.85);

  // Calmer downtown plateau.
  const dt = smoothstep(-170, -120, x) * smoothstep(170, 120, x) * smoothstep(-100, -60, z) * smoothstep(170, 120, z);
  h = lerp(h, h * 0.45 + 3, dt * 0.6);

  // River valley: raise the banks above water, then carve the channel.
  const d = Math.abs(x - riverX(z));
  const bed = riverBed(z);
  const lift = 1 - smoothstep(30, 75, d);
  h = lerp(h, Math.max(h, bed + 8), lift);
  h = lerp(h, bed, riverCarve(x, z));
  return h;
}

/** Fills the heightmap: base landform, road corridors levelled across their width, then fine detail. */
export function bakeTerrain(hm: Heightmap): void {
  const V = hm.verts;
  const base = new Float32Array(V * V);
  for (let j = 0; j < V; j++) for (let i = 0; i < V; i++) base[j * V + i] = baseHeight(hm.xAt(i), hm.xAt(j));

  const sampleBase = (x: number, z: number) => {
    const fx = (x + hm.half) / hm.step;
    const fz = (z + hm.half) / hm.step;
    const i = Math.max(0, Math.min(hm.n - 1, Math.floor(fx)));
    const j = Math.max(0, Math.min(hm.n - 1, Math.floor(fz)));
    const tx = fx - i;
    const tz = fz - j;
    const a = base[j * V + i];
    const b = base[j * V + i + 1];
    const c = base[(j + 1) * V + i];
    const e = base[(j + 1) * V + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, e, tx), tz);
  };
  const spans = Z_LINES.map((z) => bridgeSpan(z));
  const flat = ROAD.sidewalkHalf;

  for (let j = 0; j < V; j++) {
    const z = hm.xAt(j);
    for (let i = 0; i < V; i++) {
      const x = hm.xAt(i);
      const k = j * V + i;
      const B = base[k];

      let wx = 0;
      let tx = B;
      let x0 = 0;
      let dxRoad = Infinity;
      if (inGridZ(z, 14)) {
        const n = nearestLine(X_LINES, x);
        x0 = n.line;
        dxRoad = n.dist;
        const ends = (1 - smoothstep(GRID.z1 + 7, GRID.z1 + 13, z)) * (1 - smoothstep(-GRID.z0 + 7, -GRID.z0 + 13, -z));
        wx = (1 - smoothstep(flat, flat + ROAD.blend, n.dist)) * ends;
        tx = sampleBase(x0, z);
      }

      let wz = 0;
      let tz = B;
      let z0 = 0;
      let dzRoad = Infinity;
      if (inGridX(x, 14)) {
        const n = nearestLine(Z_LINES, z);
        z0 = n.line;
        const sp = spans[n.index];
        const inSpan = smoothstep(sp.xa - 1, sp.xa + 3, x) * (1 - smoothstep(sp.xb - 3, sp.xb + 1, x));
        const ends = (1 - smoothstep(GRID.x1 + 7, GRID.x1 + 13, x)) * (1 - smoothstep(-GRID.x0 + 7, -GRID.x0 + 13, -x));
        wz = (1 - smoothstep(flat, flat + ROAD.blend, n.dist)) * ends * (1 - inSpan);
        tz = sampleBase(x, z0);
        dzRoad = inSpan > 0.5 ? Infinity : n.dist;
      }

      const tc = wx > 0 && wz > 0 ? sampleBase(x0, z0) : 0;
      let h = B + wx * (tx - B) + wz * (tz - B) + wx * wz * (B - tx - tz + tc);

      // Fine detail away from roads (and gentler in the industrial flats).
      const roadDist = Math.min(dxRoad, dzRoad);
      const m = smoothstep(10, 18, roadDist);
      const ind = 1 - 0.6 * smoothstep(140, 180, z);
      h += m * ind * (fbm(x / 13, z / 13, 3, 77) * 0.6 + fbm(x / 42, z / 42, 2, 91) * 1.3);
      hm.data[k] = h;
    }
  }
}
