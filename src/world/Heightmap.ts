import { clamp, lerp, smoothstep } from '../core/math';
import { ROAD, WORLD_HALF, X_LINES, Z_LINES, inGridX, inGridZ, nearestLine, onRoadCorridor } from './CityPlan';

/** A flattened rectangular building plot. The terrain is levelled to `h` inside and blended outside. */
export interface Pad {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  blend: number;
  h?: number;
  /** Fixed height offset added on top of the sampled average (rarely used). */
  raise?: number;
}

/**
 * Baked terrain heights on a regular grid. Sampling uses the exact same triangulation as the render
 * mesh, so anything placed with `get()` sits precisely on the visible ground.
 */
export class Heightmap {
  readonly half = WORLD_HALF;
  readonly step = 2;
  readonly n = (WORLD_HALF * 2) / 2; // cells per side
  readonly verts = this.n + 1;
  readonly data = new Float32Array(this.verts * this.verts);

  xAt(i: number) {
    return -this.half + i * this.step;
  }

  get(x: number, z: number): number {
    const fx = clamp((x + this.half) / this.step, 0, this.n - 1e-6);
    const fz = clamp((z + this.half) / this.step, 0, this.n - 1e-6);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const V = this.verts;
    const d = this.data;
    const a = d[j * V + i];
    const b = d[j * V + i + 1];
    const c = d[(j + 1) * V + i];
    const e = d[(j + 1) * V + i + 1];
    if (tx + tz <= 1) return a + (b - a) * tx + (c - a) * tz;
    return e + (c - e) * (1 - tx) + (b - e) * (1 - tz);
  }

  /** Approximate surface normal's vertical component (1 = flat). */
  flatness(x: number, z: number): number {
    const e = 1.5;
    const dx = (this.get(x + e, z) - this.get(x - e, z)) / (2 * e);
    const dz = (this.get(x, z + e) - this.get(x, z - e)) / (2 * e);
    return 1 / Math.sqrt(1 + dx * dx + dz * dz);
  }

  /**
   * Plot level: the height of the street the plot fronts onto (its nearest road edge), so buildings
   * sit flush with the sidewalk instead of floating above or sinking below it. Plots far from any road
   * use the average ground height.
   */
  padHeight(p: Pad): number {
    const cx = (p.x0 + p.x1) / 2;
    const cz = (p.z0 + p.z1) / 2;
    const edge = ROAD.sidewalkHalf + 0.3;
    let best: [number, number] | null = null;
    let bestDist = 30;
    if (inGridZ(cz, 10)) {
      const n = nearestLine(X_LINES, cx);
      const d = Math.max(0, Math.min(Math.abs(p.x0 - n.line), Math.abs(p.x1 - n.line)));
      if (d < bestDist) {
        bestDist = d;
        best = [n.line + Math.sign(cx - n.line) * edge, Math.max(p.z0, Math.min(p.z1, cz))];
      }
    }
    if (inGridX(cx, 10)) {
      const n = nearestLine(Z_LINES, cz);
      const d = Math.max(0, Math.min(Math.abs(p.z0 - n.line), Math.abs(p.z1 - n.line)));
      if (d < bestDist) {
        bestDist = d;
        best = [Math.max(p.x0, Math.min(p.x1, cx)), n.line + Math.sign(cz - n.line) * edge];
      }
    }
    if (best) return this.get(best[0], best[1]) + 0.12 + (p.raise ?? 0);
    const pts = [
      [p.x0, p.z0],
      [p.x1, p.z0],
      [p.x0, p.z1],
      [p.x1, p.z1],
      [cx, cz],
    ];
    let s = 0;
    for (const [x, z] of pts) s += this.get(x, z);
    return s / pts.length + (p.raise ?? 0);
  }

  /** Levels each pad. Earlier pads win where pads overlap, so register important plots first. */
  applyPads(pads: Pad[]): void {
    const V = this.verts;
    const best = new Float32Array(V * V);
    const target = new Float32Array(V * V);
    for (const p of pads) if (p.h === undefined) p.h = this.padHeight(p);
    for (const p of pads) {
      const i0 = Math.max(0, Math.floor((p.x0 - p.blend + this.half) / this.step));
      const i1 = Math.min(this.n, Math.ceil((p.x1 + p.blend + this.half) / this.step));
      const j0 = Math.max(0, Math.floor((p.z0 - p.blend + this.half) / this.step));
      const j1 = Math.min(this.n, Math.ceil((p.z1 + p.blend + this.half) / this.step));
      for (let j = j0; j <= j1; j++) {
        const z = this.xAt(j);
        const dz = Math.max(p.z0 - z, 0, z - p.z1);
        for (let i = i0; i <= i1; i++) {
          const x = this.xAt(i);
          const dx = Math.max(p.x0 - x, 0, x - p.x1);
          const dist = Math.hypot(dx, dz);
          const w = dist <= 0 ? 1 : 1 - smoothstep(0, p.blend, dist);
          const k = j * V + i;
          if (w > best[k]) {
            best[k] = w;
            target[k] = p.h!;
          }
        }
      }
    }
    // Road surfaces never move: pads only reshape ground outside the road corridors.
    const V2 = this.verts;
    const locked = new Uint8Array(V2 * V2);
    for (let j = 0; j < V2; j++)
      for (let i = 0; i < V2; i++) {
        const k = j * V2 + i;
        const onRoad = onRoadCorridor(this.xAt(i), this.xAt(j));
        if (onRoad) locked[k] = 1;
        else if (best[k] > 0) this.data[k] = lerp(this.data[k], target[k], best[k]);
        if (best[k] >= 1) locked[k] = 1;
      }
    this.limitSlopes(locked);
  }

  /**
   * Keeps every walkable bank climbable: relaxes unlocked cells until no step to a neighbour exceeds
   * the controller's climb limit. Roads and plot interiors stay fixed.
   */
  limitSlopes(locked: Uint8Array, maxAngleDeg = 40, passes = 400): void {
    const V = this.verts;
    const d = Math.tan((maxAngleDeg * Math.PI) / 180) * this.step;
    const h = this.data;
    for (let pass = 0; pass < passes; pass++) {
      let changed = 0;
      for (let j = 1; j < V - 1; j++)
        for (let i = 1; i < V - 1; i++) {
          const k = j * V + i;
          if (locked[k]) continue;
          const a = h[k - 1];
          const b = h[k + 1];
          const c = h[k - V];
          const e = h[k + V];
          const lo = Math.max(a, b, c, e) - d;
          const hi = Math.min(a, b, c, e) + d;
          let v = h[k];
          if (lo > hi) v = (lo + hi) / 2;
          else if (v < lo) v = lo;
          else if (v > hi) v = hi;
          if (Math.abs(v - h[k]) > 1e-3) {
            h[k] = v;
            changed++;
          }
        }
      if (!changed) break;
    }
  }
}
