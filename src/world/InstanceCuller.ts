import * as THREE from 'three';

/**
 * Trees, street furniture and MegaKit buildings are instanced across the whole city, and an
 * InstancedMesh is drawn all-or-nothing: every instance, every frame, in the camera pass AND the
 * shadow pass, even the ones behind you or a kilometre away.
 *
 * This keeps each instanced mesh's full placement list and, as the camera moves or turns, rewrites
 * the GPU instance list with just the instances that matter:
 * - "near" (inside the sun's shadow box): drawn and casting shadows, even just behind you;
 * - "far": only when inside a slightly widened view frustum, and without shadows.
 * Small props (bins, hydrants, bollards) also drop out beyond a distance where they'd be a pixel or two.
 */

interface Source {
  near: THREE.InstancedMesh;
  /** Full-detail, no shadows (only when the mesh has a lighter far model). */
  mid: THREE.InstancedMesh | null;
  far: THREE.InstancedMesh;
  /** All placements: 16 floats each. */
  mats: Float32Array;
  cols: Float32Array | null;
  cx: Float32Array;
  cy: Float32Array;
  cz: Float32Array;
  r: Float32Array;
  n: number;
  shadows: boolean;
  /** Placement lists shared between meshes (a tree's trunk and leaves) are culled once. */
  key: string;
  /** Preallocated selection buffers (no garbage per pass). */
  sel: { near: Int32Array; mid: Int32Array; far: Int32Array; all: Int32Array; d: Float32Array; nn: number; nm: number; nf: number; stamp: number };
}

const SHADOW_RADIUS = 82; // sun shadow camera covers ±75 m around the player
/** Beyond this, meshes with a lighter model (trees) switch to it. */
const LOD_DISTANCE = 150;

export class InstanceCuller {
  private list: Source[] = [];
  private frustum = new THREE.Frustum();
  private proj = new THREE.Matrix4();
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private pass = 0;
  private timer = 0;
  viewDistance = 650;
  /** Last selection, for the stats readout. */
  drawn = 0;
  total = 0;

  /** Takes over every static InstancedMesh under `root`. */
  manage(root: THREE.Object3D) {
    const found: THREE.InstancedMesh[] = [];
    root.traverse((o) => {
      const m = o as THREE.InstancedMesh;
      if (m.isInstancedMesh && !m.userData.culled && m.count > 0) found.push(m);
    });
    for (const m of found) this.add(m);
  }

  private add(src: THREE.InstancedMesh) {
    const n = src.count;
    const mats = new Float32Array(src.instanceMatrix.array.slice(0, n * 16));
    const cols = src.instanceColor ? new Float32Array(src.instanceColor.array.slice(0, n * 3)) : null;
    const geo = src.geometry;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const bs = geo.boundingSphere!;
    const cx = new Float32Array(n);
    const cy = new Float32Array(n);
    const cz = new Float32Array(n);
    const r = new Float32Array(n);
    const m4 = new THREE.Matrix4();
    const c = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      m4.fromArray(mats, i * 16);
      c.copy(bs.center).applyMatrix4(m4);
      cx[i] = c.x;
      cy[i] = c.y;
      cz[i] = c.z;
      r[i] = bs.radius * m4.getMaxScaleOnAxis();
    }
    // The original mesh becomes the "near" one (with shadows); twins draw the rest without shadows,
    // the farthest using the lighter model when there is one.
    const near = src;
    near.userData.culled = true;
    near.frustumCulled = false;
    near.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const twin = (geo: THREE.BufferGeometry, tag: string) => {
      const t = new THREE.InstancedMesh(geo, src.material, n);
      t.userData.culled = true;
      t.name = `${src.name || 'inst'}-${tag}`;
      t.frustumCulled = false;
      t.castShadow = false;
      t.receiveShadow = src.receiveShadow;
      t.renderOrder = src.renderOrder;
      if (cols) t.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      t.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      t.count = 0;
      src.parent?.add(t);
      return t;
    };
    const lod = src.userData.lod as THREE.BufferGeometry | undefined;
    const mid = lod ? twin(src.geometry, 'mid') : null;
    const far = twin(lod ?? src.geometry, 'far');
    const key = `${n}:${mats[12].toFixed(1)},${mats[14].toFixed(1)}:${mats[(n - 1) * 16 + 12].toFixed(1)},${mats[(n - 1) * 16 + 14].toFixed(1)}`;
    // Parts sharing placements (trunk + leaves) are culled together, using the larger radius.
    for (const o of this.list)
      if (o.key === key)
        for (let i = 0; i < n; i++) {
          const m = Math.max(o.r[i], r[i]);
          o.r[i] = m;
          r[i] = m;
        }
    const sel = { near: new Int32Array(n), mid: new Int32Array(n), far: new Int32Array(n), all: new Int32Array(n), d: new Float32Array(n), nn: 0, nm: 0, nf: 0, stamp: -1 };
    this.list.push({ near, mid, far, mats, cols, cx, cy, cz, r, n, shadows: src.castShadow, key, sel });
    this.total += n;
  }

  /** Re-selects instances when the camera has moved or turned enough (and twice a second regardless). */
  update(dt: number, camera: THREE.PerspectiveCamera, player: THREE.Vector3) {
    if (!this.list.length) return;
    this.timer -= dt;
    camera.getWorldDirection(this.dir);
    const moved = camera.position.distanceToSquared(this.lastPos) > 4 * 4;
    const turned = this.dir.dot(this.lastDir) < 0.97; // ~14° (the selection frustum has ~25° spare)
    if (!moved && !turned && this.timer > 0) return;
    this.timer = 0.5;
    this.lastPos.copy(camera.position);
    this.lastDir.copy(this.dir);
    // A frustum ~25° wider than the view on every side, so quick turns don't reveal gaps before the next pass.
    const fov = Math.min(170, camera.fov + 50);
    this.proj.makePerspective(
      -Math.tan(THREE.MathUtils.degToRad(fov / 2)) * camera.near * camera.aspect * 1.35,
      Math.tan(THREE.MathUtils.degToRad(fov / 2)) * camera.near * camera.aspect * 1.35,
      Math.tan(THREE.MathUtils.degToRad(fov / 2)) * camera.near,
      -Math.tan(THREE.MathUtils.degToRad(fov / 2)) * camera.near,
      camera.near,
      camera.far,
    );
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(this.proj.multiply(camera.matrixWorldInverse));
    const planes = this.frustum.planes;
    const px = camera.position.x;
    const py = camera.position.y;
    const pz = camera.position.z;
    const sx = player.x;
    const sz = player.z;
    const maxD = this.viewDistance * 1.15;
    // Meshes sharing a placement list reuse the first one's selection.
    const shared = new Map<string, Source['sel']>();
    const pass = ++this.pass;
    let drawn = 0;
    for (const s of this.list) {
      const key = s.shadows ? s.key + 's' : s.key;
      let sel = shared.get(key);
      if (!sel || sel.stamp !== pass) {
        sel = s.sel;
        const { near: nearIdx, mid: midIdx, far: farIdx, d: midD } = sel;
        let nn = 0;
        let nm = 0;
        let nf = 0;
        for (let i = 0; i < s.n; i++) {
          const x = s.cx[i];
          const y = s.cy[i];
          const z = s.cz[i];
          const r = s.r[i];
          const dx = x - px;
          const dy = y - py;
          const dz = z - pz;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
          // Small things vanish where they'd be a few pixels; big ones go out to the view distance.
          const limit = r < 2.5 ? 45 + r * 70 : maxD;
          if (d > limit) continue;
          const ex = x - sx;
          const ez = z - sz;
          if (s.shadows && ex * ex + ez * ez < (SHADOW_RADIUS + r) * (SHADOW_RADIUS + r)) {
            nearIdx[nn++] = i;
            continue;
          }
          let inView = true;
          for (let p = 0; p < 6; p++) {
            const pl = planes[p];
            if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -r) {
              inView = false;
              break;
            }
          }
          if (!inView) continue;
          if (d < LOD_DISTANCE) midIdx[nm++] = i;
          else {
            midD[nf] = d;
            farIdx[nf++] = i;
          }
        }
        sel.nn = nn;
        sel.nm = nm;
        sel.nf = nf;
        sel.stamp = pass;
        shared.set(key, sel);
      }
      this.write(s, s.near, sel.near, sel.nn);
      if (s.mid) {
        this.write(s, s.mid, sel.mid, sel.nm);
        this.write(s, s.far, sel.far, sel.nf);
      } else {
        // No lighter model: everything in view goes in the one shadowless twin.
        const all = s.sel.all;
        for (let k = 0; k < sel.nm; k++) all[k] = sel.mid[k];
        for (let k = 0; k < sel.nf; k++) all[sel.nm + k] = sel.far[k];
        this.write(s, s.far, all, sel.nm + sel.nf);
      }
      drawn += sel.nn + sel.nm + sel.nf;
    }
    this.drawn = drawn;
  }

  private write(s: Source, m: THREE.InstancedMesh, idx: Int32Array, count: number) {
    const dst = m.instanceMatrix.array as Float32Array;
    const src = s.mats;
    for (let k = 0; k < count; k++) {
      const a = idx[k] * 16;
      const b = k * 16;
      for (let e = 0; e < 16; e++) dst[b + e] = src[a + e];
    }
    m.count = count;
    m.instanceMatrix.clearUpdateRanges();
    m.instanceMatrix.addUpdateRange(0, Math.max(16, count * 16));
    m.instanceMatrix.needsUpdate = true;
    if (s.cols && m.instanceColor) {
      const dc = m.instanceColor.array as Float32Array;
      const sc = s.cols;
      for (let k = 0; k < count; k++) {
        const a = idx[k] * 3;
        dc[k * 3] = sc[a];
        dc[k * 3 + 1] = sc[a + 1];
        dc[k * 3 + 2] = sc[a + 2];
      }
      m.instanceColor.clearUpdateRanges();
      m.instanceColor.addUpdateRange(0, Math.max(3, count * 3));
      m.instanceColor.needsUpdate = true;
    }
    // The twin follows the original mesh's on/off state (some code hides whole prop sets).
    if (m !== s.near) m.visible = s.near.visible;
  }
}
