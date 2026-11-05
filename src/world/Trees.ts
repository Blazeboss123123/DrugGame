import * as THREE from 'three';
import { Rng } from '../core/math';
import type { SurfaceSet } from './Surfaces';

/** Shared wind clock for all vegetation shaders (seconds). */
export const WIND = { value: 0 };

interface Builder {
  pos: number[];
  nrm: number[];
  uv: number[];
  col: number[];
}
const builder = (): Builder => ({ pos: [], nrm: [], uv: [], col: [] });

function finish(b: Builder): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.computeBoundingSphere();
  return g;
}

type V3 = [number, number, number];
interface Vert {
  p: V3;
  n: V3;
  uv: [number, number];
  c: number;
}

/** Adds a triangle, flipping its winding so the face points along `facing`. */
function tri(b: Builder, a: Vert, c1: Vert, c2: Vert, facing: V3) {
  const ux = c1.p[0] - a.p[0], uy = c1.p[1] - a.p[1], uz = c1.p[2] - a.p[2];
  const vx = c2.p[0] - a.p[0], vy = c2.p[1] - a.p[1], vz = c2.p[2] - a.p[2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  const order = cx * facing[0] + cy * facing[1] + cz * facing[2] >= 0 ? [a, c1, c2] : [a, c2, c1];
  for (const v of order) {
    b.pos.push(...v.p);
    b.nrm.push(...v.n);
    b.uv.push(...v.uv);
    b.col.push(v.c, v.c, v.c);
  }
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Trunk as an open tapered cylinder with bark UVs; `lean` bends it slightly. */
function trunk(b: Builder, h: number, r0: number, r1: number, seg = 8, lean: [number, number] = [0, 0], y0 = -0.3) {
  const rings = 5;
  for (let k = 0; k < rings; k++) {
    for (let s = 0; s < seg; s++) {
      const quad: Vert[] = [];
      for (const [dk, ds] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]) {
        const t = (k + dk) / rings;
        const a = ((s + ds) / seg) * Math.PI * 2;
        const r = r0 + (r1 - r0) * t;
        const ox = lean[0] * t * t * h;
        const oz = lean[1] * t * t * h;
        quad.push({ p: [Math.cos(a) * r + ox, y0 + t * (h - y0), Math.sin(a) * r + oz], n: [Math.cos(a), 0.15, Math.sin(a)], uv: [((s + ds) / seg) * 2, t * h * 0.5], c: 0.55 + 0.45 * t });
      }
      const out: V3 = [quad[0].n[0], 0, quad[0].n[2]];
      tri(b, quad[0], quad[1], quad[2], out);
      tri(b, quad[2], quad[1], quad[3], out);
    }
  }
}

export interface TreeGeo {
  trunk: THREE.BufferGeometry;
  foliage: THREE.BufferGeometry;
}

/** A tall stylised conifer: tiers of drooping, jagged needle skirts around a reddish trunk. */
export function pineGeometry(seed: number): TreeGeo {
  const rng = new Rng(seed);
  const tb = builder();
  const height = rng.range(8.5, 10.5);
  trunk(tb, height, 0.34, 0.07, 9, [rng.range(-0.02, 0.02), rng.range(-0.02, 0.02)]);
  const fb = builder();
  const tiers = rng.int(7, 9);
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const y = 1.9 + t * (height - 2.6);
    const r = (2.5 - t * 2.0) * rng.range(0.9, 1.1);
    const h = 1.35 - t * 0.55;
    const spokes = Math.round(13 - t * 6);
    const rot = rng.range(0, Math.PI * 2);
    const C: Vert = { p: [0, y + h, 0], n: [0, 1, 0], uv: [0.5, 0.05], c: 0.32 };
    const U: Vert = { p: [0, y + h * 0.15, 0], n: [0, -1, 0], uv: [0.5, 0.05], c: 0.18 };
    const tips: Vert[] = [];
    const notches: Vert[] = [];
    for (let s = 0; s < spokes; s++) {
      const a = rot + (s / spokes) * Math.PI * 2 + rng.range(-0.12, 0.12);
      const rr = r * rng.range(0.85, 1.15);
      const droop = rr * rng.range(0.32, 0.5);
      tips.push({ p: [Math.cos(a) * rr, y - droop + h * 0.15, Math.sin(a) * rr], n: norm([Math.cos(a), 0.55, Math.sin(a)]), uv: [s / spokes, 0.98], c: rng.range(0.85, 1.1) });
      const an = a + (Math.PI / spokes) * rng.range(0.8, 1.2);
      const rn = rr * rng.range(0.5, 0.62);
      notches.push({ p: [Math.cos(an) * rn, y + h * 0.42, Math.sin(an) * rn], n: norm([Math.cos(an), 0.9, Math.sin(an)]), uv: [(s + 0.5) / spokes, 0.55], c: 0.6 });
    }
    for (let s = 0; s < spokes; s++) {
      const tip = tips[s];
      const next = tips[(s + 1) % spokes];
      const notch = notches[s];
      const mid: V3 = norm([notch.p[0], 0.8, notch.p[2]]);
      tri(fb, C, tip, notch, mid);
      tri(fb, C, notch, next, mid);
      // Underside, darker, closes the skirt so it reads as solid from below.
      const down: V3 = [notch.p[0] * 0.3, -1, notch.p[2] * 0.3];
      const ut: Vert = { ...tip, n: norm([tip.p[0], -0.4, tip.p[2]]), c: 0.35 };
      const un: Vert = { ...notch, n: norm([notch.p[0], -0.6, notch.p[2]]), c: 0.22 };
      const unx: Vert = { ...next, n: norm([next.p[0], -0.4, next.p[2]]), c: 0.35 };
      tri(fb, U, ut, un, down);
      tri(fb, U, un, unx, down);
    }
  }
  return { trunk: finish(tb), foliage: finish(fb) };
}

/** A broadleaf tree: forked trunk with clusters of alpha-tested leaf cards and soft spherical normals. */
export function broadleafGeometry(seed: number): TreeGeo {
  const rng = new Rng(seed);
  const tb = builder();
  const th = rng.range(2.8, 3.6);
  trunk(tb, th + 0.8, 0.3, 0.14, 8, [rng.range(-0.03, 0.03), rng.range(-0.03, 0.03)]);
  const center: V3 = [0, th + 1.9, 0];
  const clusters: { c: V3; r: number }[] = [{ c: [0, th + 2.2, 0], r: rng.range(1.8, 2.2) }];
  const n = rng.int(4, 6);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const d = rng.range(1.0, 1.6);
    clusters.push({ c: [Math.cos(a) * d, th + rng.range(1.0, 2.8), Math.sin(a) * d], r: rng.range(1.1, 1.5) });
  }
  // Branches from the trunk top to each outer cluster.
  for (const cl of clusters.slice(1)) {
    const seg = 5;
    const sx = 0, sy = th + 0.4, sz = 0;
    const ex = cl.c[0] * 0.8, ey = cl.c[1] - 0.2, ez = cl.c[2] * 0.8;
    const dir = norm([ex - sx, ey - sy, ez - sz]);
    const side = norm([-dir[2], 0, dir[0]]);
    const up = norm([dir[1] * side[2] - dir[2] * side[1], dir[2] * side[0] - dir[0] * side[2], dir[0] * side[1] - dir[1] * side[0]]);
    const len = Math.hypot(ex - sx, ey - sy, ez - sz);
    for (let s = 0; s < seg; s++) {
      const q: Vert[] = [];
      for (const [dt, ds] of [
        [0, 0],
        [0, 1],
        [1, 0],
        [1, 1],
      ]) {
        const a = ((s + ds) / seg) * Math.PI * 2;
        const r = 0.12 * (1 - dt * 0.6);
        const ox = Math.cos(a) * side[0] + Math.sin(a) * up[0];
        const oy = Math.cos(a) * side[1] + Math.sin(a) * up[1];
        const oz = Math.cos(a) * side[2] + Math.sin(a) * up[2];
        q.push({ p: [sx + dir[0] * len * dt + ox * r, sy + dir[1] * len * dt + oy * r, sz + dir[2] * len * dt + oz * r], n: [ox, oy, oz], uv: [(s + ds) / seg, dt * len * 0.5], c: 0.7 });
      }
      tri(tb, q[0], q[1], q[2], q[0].n);
      tri(tb, q[2], q[1], q[3], q[2].n);
    }
  }
  const fb = builder();
  const lo = th + 0.2;
  const hi = th + 4.6;
  for (const cl of clusters) {
    const cards = Math.round(26 * cl.r);
    for (let i = 0; i < cards; i++) {
      // Point on the cluster's surface, biased upward and outward.
      let dx = rng.range(-1, 1), dy = rng.range(-0.6, 1), dz = rng.range(-1, 1);
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l;
      dy /= l;
      dz /= l;
      const rr = cl.r * rng.range(0.55, 0.95);
      const p: V3 = [cl.c[0] + dx * rr, cl.c[1] + dy * rr * 0.8, cl.c[2] + dz * rr];
      const size = rng.range(1.0, 1.5) * (0.8 + cl.r * 0.15);
      // Card faces outward from the cluster with a random roll.
      const f = norm([dx, dy * 0.6 + 0.2, dz]);
      let ax = norm([-f[2], 0, f[0]]);
      if (!isFinite(ax[0])) ax = [1, 0, 0];
      const ay = norm([f[1] * ax[2] - f[2] * ax[1], f[2] * ax[0] - f[0] * ax[2], f[0] * ax[1] - f[1] * ax[0]]);
      const roll = rng.range(0, Math.PI * 2);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const u: V3 = [ax[0] * cr + ay[0] * sr, ax[1] * cr + ay[1] * sr, ax[2] * cr + ay[2] * sr];
      const v: V3 = [-ax[0] * sr + ay[0] * cr, -ax[1] * sr + ay[1] * cr, -ax[2] * sr + ay[2] * cr];
      const corner = (su: number, sv: number): Vert => {
        const q: V3 = [p[0] + (u[0] * su + v[0] * sv) * size * 0.5, p[1] + (u[1] * su + v[1] * sv) * size * 0.5, p[2] + (u[2] * su + v[2] * sv) * size * 0.5];
        // Spherical normals around the crown give soft, volumetric lighting instead of flat cards.
        const sn = norm([q[0] - center[0], (q[1] - center[1]) * 1.2 + 0.4, q[2] - center[2]]);
        const shade = 0.45 + 0.55 * Math.min(1, Math.max(0, (q[1] - lo) / (hi - lo))) * (0.75 + 0.25 * Math.min(1, rr / cl.r));
        return { p: q, n: sn, uv: [(su + 1) / 2, (sv + 1) / 2], c: shade };
      };
      const A = corner(-1, -1), B = corner(1, -1), C = corner(-1, 1), D = corner(1, 1);
      tri(fb, A, B, C, f);
      tri(fb, C, B, D, f);
    }
  }
  return { trunk: finish(tb), foliage: finish(fb) };
}

/** Vertex-shader wind sway for instanced vegetation (amount grows with height above the base). */
function addSway(mat: THREE.Material, key: string, flutter: number) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = WIND;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uWind;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec3 ip = instanceMatrix[3].xyz;
      #else
        vec3 ip = vec3(0.0);
      #endif
      float hgt = max(0.0, transformed.y - 1.2);
      float sway = sin(uWind * 0.9 + ip.x * 0.045 + ip.z * 0.06) * 0.6 + sin(uWind * 2.1 + ip.x * 0.11 - ip.z * 0.05) * 0.25;
      transformed.x += sway * 0.018 * hgt * hgt;
      transformed.z += sway * 0.008 * hgt * hgt;
      transformed += ${flutter.toFixed(3)} * vec3(sin(uWind * 6.0 + position.x * 2.3 + position.y * 1.7), sin(uWind * 5.1 + position.z * 2.9) * 0.6, cos(uWind * 6.7 + position.z * 2.1)) * min(hgt, 1.0);`,
    );
    // Leaf cards: light both faces the same way (no back-face normal flip), with a little translucency.
    if (key.includes('leaves'))
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <normal_fragment_begin>', 'float faceDirection = gl_FrontFacing ? 1.0 : -1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.06;');
  };
  mat.customProgramCacheKey = () => key;
}

export interface TreeMaterials {
  pineTrunk: THREE.MeshStandardMaterial;
  broadTrunk: THREE.MeshStandardMaterial;
  needles: THREE.MeshStandardMaterial;
  leaves: THREE.MeshStandardMaterial;
}

export function treeMaterials(s: SurfaceSet): TreeMaterials {
  const pineTrunk = new THREE.MeshStandardMaterial({ map: s.bark, normalMap: s.barkN, color: 0xc0805c, roughness: 0.9, vertexColors: true });
  const broadTrunk = new THREE.MeshStandardMaterial({ map: s.bark, normalMap: s.barkN, color: 0x9a8a78, roughness: 0.9, vertexColors: true });
  const needles = new THREE.MeshStandardMaterial({ map: s.needles, color: 0xffffff, roughness: 0.85, vertexColors: true });
  const leaves = new THREE.MeshStandardMaterial({ map: s.leaves, alphaTest: 0.42, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.8, vertexColors: true });
  addSway(pineTrunk, 'sway-trunk-pine', 0);
  addSway(broadTrunk, 'sway-trunk-broad', 0);
  addSway(needles, 'sway-needles', 0.015);
  addSway(leaves, 'sway-leaves', 0.04);
  return { pineTrunk, broadTrunk, needles, leaves };
}
