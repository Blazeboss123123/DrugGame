import * as THREE from 'three';

type V3 = [number, number, number];

/**
 * Accumulates triangles for one material, then builds a single merged BufferGeometry.
 * Used for buildings, roads and interiors so the whole city renders in a handful of draw calls.
 */
export class GeoBatch {
  private pos: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private color: [number, number, number] = [1, 1, 1];

  get vertexCount() {
    return this.pos.length / 3;
  }

  setColor(c: THREE.Color | [number, number, number]): this {
    this.color = Array.isArray(c) ? c : [c.r, c.g, c.b];
    return this;
  }

  private vert(p: V3, u: number, v: number): number {
    this.pos.push(p[0], p[1], p[2]);
    this.uv.push(u, v);
    this.col.push(this.color[0], this.color[1], this.color[2]);
    return this.vertexCount - 1;
  }

  /** Quad from bottom-left, bottom-right, top-right, top-left (counter-clockwise seen from the front). */
  quad(bl: V3, br: V3, tr: V3, tl: V3, uv: [number, number, number, number] = [0, 0, 1, 1]): void {
    const [u0, v0, u1, v1] = uv;
    const a = this.vert(bl, u0, v0);
    const b = this.vert(br, u1, v0);
    const c = this.vert(tr, u1, v1);
    const d = this.vert(tl, u0, v1);
    this.idx.push(a, b, c, a, c, d);
  }

  /** Same as quad() but flips the winding if needed so the face points along `want`. */
  quadFacing(bl: V3, br: V3, tr: V3, tl: V3, want: V3, uv?: [number, number, number, number]): void {
    const ex = [br[0] - bl[0], br[1] - bl[1], br[2] - bl[2]];
    const ey = [tl[0] - bl[0], tl[1] - bl[1], tl[2] - bl[2]];
    const n = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
    if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] >= 0) this.quad(bl, br, tr, tl, uv);
    else this.quad(br, bl, tl, tr, uv ? [uv[2], uv[1], uv[0], uv[3]] : undefined);
  }

  tri(a: V3, b: V3, c: V3, uva: [number, number], uvb: [number, number], uvc: [number, number]): void {
    const i = this.vert(a, uva[0], uva[1]);
    const j = this.vert(b, uvb[0], uvb[1]);
    const k = this.vert(c, uvc[0], uvc[1]);
    this.idx.push(i, j, k);
  }

  /**
   * Upward-facing surface grid. `at(r, c)` returns [x, y, z, u, v] for row r (0..rows) and column c (0..cols).
   * Winding is chosen automatically so the surface faces +y.
   */
  grid(rows: number, cols: number, at: (r: number, c: number) => [number, number, number, number, number]): void {
    const start = this.vertexCount;
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c <= cols; c++) {
        const [x, y, z, u, v] = at(r, c);
        this.vert([x, y, z], u, v);
      }
    const W = cols + 1;
    const p = this.pos;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const a = start + r * W + c;
        const b = a + 1;
        const d = a + W;
        const e = d + 1;
        // Decide winding from the first triangle's normal.
        const ax = p[a * 3], az = p[a * 3 + 2];
        const bx = p[b * 3] - ax, bz = p[b * 3 + 2] - az;
        const dx = p[d * 3] - ax, dz = p[d * 3 + 2] - az;
        const ny = dz * bx - dx * bz; // y of (d-a) x (b-a)
        if (ny >= 0) this.idx.push(a, d, b, b, d, e);
        else this.idx.push(a, b, d, b, e, d);
      }
  }

  /** Axis-aligned box: four walls plus top and (optionally) bottom, with world-scaled UVs. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, uvScale = 1, bottom = false): void {
    const s = 1 / uvScale;
    const w = (x1 - x0) * s;
    const d = (z1 - z0) * s;
    const h = (y1 - y0) * s;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, w, h]);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, w, h]);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [0, 0, d, h]);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [0, 0, d, h]);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 0, w, d]);
    if (bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, 0, w, d]);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  /** Builds a mesh if the batch has anything in it. */
  mesh(material: THREE.Material, shadows = true): THREE.Mesh | null {
    if (this.vertexCount === 0) return null;
    const m = new THREE.Mesh(this.build(), material);
    m.castShadow = shadows;
    m.receiveShadow = true;
    return m;
  }
}

/** Converts an sRGB hex colour to the linear values used by vertex colours. */
export function linearColor(hex: number | string): THREE.Color {
  return new THREE.Color(hex);
}
