import * as THREE from 'three';
import type { Surface } from '../core/EventBus';
import type { Physics } from '../physics/Physics';
import { GeoBatch } from '../world/GeoBatch';

export interface Opening {
  /** Start and end along the wall's own axis (local coordinates). */
  a: number;
  b: number;
  bottom: number;
  top: number;
  glass?: boolean;
}

/**
 * Builds interiors in a property's local frame (origin = floor centre). Geometry is batched per
 * material key and every solid piece gets a matching static collider.
 */
export class BuildKit {
  private batches = new Map<string, GeoBatch>();

  constructor(
    readonly origin: THREE.Vector3,
    private physics: Physics,
  ) {}

  batch(key: string): GeoBatch {
    let b = this.batches.get(key);
    if (!b) {
      b = new GeoBatch();
      this.batches.set(key, b);
    }
    return b;
  }

  /** Box in local coordinates. Adds a collider unless `collide` is false. */
  box(key: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, opts: { uv?: number; collide?: boolean; surface?: Surface; bottom?: boolean } = {}): void {
    const o = this.origin;
    this.batch(key).box(o.x + x0, o.y + y0, o.z + z0, o.x + x1, o.y + y1, o.z + z1, opts.uv ?? 1, opts.bottom);
    if (opts.collide !== false) this.collider(x0, y0, z0, x1, y1, z1, opts.surface);
  }

  collider(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, surface: Surface = 'concrete') {
    const o = this.origin;
    return this.physics.box(o.x + (x0 + x1) / 2, o.y + (y0 + y1) / 2, o.z + (z0 + z1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2, 0, surface);
  }

  /**
   * Wall along x at local z, from x0 to x1, with openings. `outside` is +1/-1 for the exterior side
   * (+z / -z) or 0 for an interior wall. Each wall has two skins so interior and exterior differ.
   */
  wallX(z: number, x0: number, x1: number, h: number, openings: Opening[], extKey: string, intKey: string, outside: number, t = 0.2): void {
    this.wall('x', z, x0, x1, h, openings, extKey, intKey, outside, t);
  }

  wallZ(x: number, z0: number, z1: number, h: number, openings: Opening[], extKey: string, intKey: string, outside: number, t = 0.2): void {
    this.wall('z', x, z0, z1, h, openings, extKey, intKey, outside, t);
  }

  private wall(axis: 'x' | 'z', line: number, s0: number, s1: number, h: number, openings: Opening[], extKey: string, intKey: string, outside: number, t: number) {
    const pieces: [number, number, number, number][] = []; // [s0, s1, y0, y1]
    const sorted = [...openings].sort((p, q) => p.a - q.a);
    let s = s0;
    for (const op of sorted) {
      if (op.a > s) pieces.push([s, op.a, 0, h]);
      if (op.bottom > 0) pieces.push([op.a, op.b, 0, op.bottom]);
      if (op.top < h) pieces.push([op.a, op.b, op.top, h]);
      if (op.glass) this.glass(axis, line, op);
      s = op.b;
    }
    if (s < s1) pieces.push([s, s1, 0, h]);
    const half = t / 2;
    for (const [a, b, y0, y1] of pieces) {
      // Two skins: [line - half, line] and [line, line + half].
      const negKey = outside < 0 ? extKey : intKey;
      const posKey = outside > 0 ? extKey : intKey;
      if (axis === 'x') {
        this.box(negKey, a, y0, line - half, b, y1, line, { collide: false, uv: 1 });
        this.box(posKey, a, y0, line, b, y1, line + half, { collide: false, uv: 1 });
        this.collider(a, y0, line - half, b, y1, line + half, 'concrete');
      } else {
        this.box(negKey, line - half, y0, a, line, y1, b, { collide: false, uv: 1 });
        this.box(posKey, line, y0, a, line + half, y1, b, { collide: false, uv: 1 });
        this.collider(line - half, y0, a, line + half, y1, b, 'concrete');
      }
    }
  }

  private glass(axis: 'x' | 'z', line: number, op: Opening) {
    const g = 0.012;
    if (axis === 'x') {
      this.box('glass', op.a, op.bottom, line - g, op.b, op.top, line + g, { collide: false });
      this.collider(op.a, op.bottom, line - 0.05, op.b, op.top, line + 0.05, 'concrete');
      // Frame.
      this.box('frame', op.a - 0.05, op.bottom - 0.06, line - 0.12, op.b + 0.05, op.bottom, line + 0.12, { collide: false });
      this.box('frame', op.a - 0.05, op.top, line - 0.11, op.b + 0.05, op.top + 0.06, line + 0.11, { collide: false });
      this.box('frame', (op.a + op.b) / 2 - 0.025, op.bottom, line - 0.03, (op.a + op.b) / 2 + 0.025, op.top, line + 0.03, { collide: false });
    } else {
      this.box('glass', line - g, op.bottom, op.a, line + g, op.top, op.b, { collide: false });
      this.collider(line - 0.05, op.bottom, op.a, line + 0.05, op.top, op.b, 'concrete');
      this.box('frame', line - 0.12, op.bottom - 0.06, op.a - 0.05, line + 0.12, op.bottom, op.b + 0.05, { collide: false });
      this.box('frame', line - 0.11, op.top, op.a - 0.05, line + 0.11, op.top + 0.06, op.b + 0.05, { collide: false });
      this.box('frame', line - 0.03, op.bottom, (op.a + op.b) / 2 - 0.025, line + 0.03, op.top, (op.a + op.b) / 2 + 0.025, { collide: false });
    }
  }

  /** Builds one mesh per batch using the given materials. */
  build(materials: Record<string, THREE.Material>, group: THREE.Group, noShadow: string[] = []): void {
    for (const [key, b] of this.batches) {
      const mat = materials[key];
      if (!mat) throw new Error(`BuildKit: no material for "${key}"`);
      const mesh = b.mesh(mat, !noShadow.includes(key));
      if (mesh) {
        mesh.name = key;
        group.add(mesh);
      }
    }
  }
}
