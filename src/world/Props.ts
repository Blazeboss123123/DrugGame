import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Rng } from '../core/math';
import type { Physics } from '../physics/Physics';
import type { CityContent, FenceSeg, Rect } from './CityGenerator';
import { ROAD, X_LINES, Z_LINES, bridgeSpan, districtAt } from './CityPlan';
import { GeoBatch } from './GeoBatch';
import type { Heightmap } from './Heightmap';
import { asphaltTexture, chainLinkTexture, facadeTexture, letterTexture, noiseTexture } from './Textures';
import { surfaces } from './Surfaces';
import { broadleafGeometry, pineGeometry, treeMaterials } from './Trees';

const WALK = ROAD.curb + 0.06;
const UP = new THREE.Vector3(0, 1, 0);

export interface PropsResult {
  group: THREE.Group;
  nightMaterials: THREE.MeshStandardMaterial[];
  lightPools: THREE.MeshBasicMaterial;
  signals: { ns: THREE.MeshStandardMaterial[]; ew: THREE.MeshStandardMaterial[] };
}

function merge(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const key of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(key)) n.deleteAttribute(key);
    return n;
  });
  const m = mergeGeometries(prepared, false)!;
  m.computeBoundingSphere();
  return m;
}

const at = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) => {
  g.rotateX(rx);
  g.rotateY(ry);
  g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
};

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], colors?: THREE.Color[], castShadow = true): THREE.InstancedMesh | null {
  if (!mats.length) return null;
  const m = new THREE.InstancedMesh(geo, mat, mats.length);
  mats.forEach((mm, i) => m.setMatrixAt(i, mm));
  colors?.forEach((c, i) => m.setColorAt(i, c));
  m.castShadow = castShadow;
  m.receiveShadow = true;
  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
  m.computeBoundingSphere();
  return m;
}

const tmpQ = new THREE.Quaternion();
function mtx(x: number, y: number, z: number, yaw: number, s = 1, sy = s): THREE.Matrix4 {
  tmpQ.setFromAxisAngle(UP, yaw);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), tmpQ, new THREE.Vector3(s, sy, s));
}

const inRect = (r: Rect, x: number, z: number, pad = 0) => x > r.x0 - pad && x < r.x1 + pad && z > r.z0 - pad && z < r.z1 + pad;

/** Street furniture, vegetation, vehicles and yard clutter, all instanced. */
export function buildProps(content: CityContent, hm: Heightmap, physics: Physics): PropsResult {
  const rng = new Rng(4242);
  const group = new THREE.Group();
  group.name = 'props';
  const add = (o: THREE.Object3D | null) => o && group.add(o);
  const blocked = (x: number, z: number) => content.propFree.some((r) => inRect(r, x, z, 0.5)) || content.reserved.some((r) => inRect(r, x, z, -0.5));

  // ------------------------------------------------------------ street lights, trees and parking along roads
  const lights: THREE.Matrix4[] = [];
  const pools: THREE.Matrix4[] = [];
  const hydrants: THREE.Matrix4[] = [];
  const spans = Z_LINES.map((z) => bridgeSpan(z));
  type Seg = { along: 'x' | 'z'; line: number; s0: number; s1: number };
  const segs: Seg[] = [];
  for (const x0 of X_LINES) for (let k = 0; k < Z_LINES.length - 1; k++) segs.push({ along: 'z', line: x0, s0: Z_LINES[k], s1: Z_LINES[k + 1] });
  Z_LINES.forEach((z0, zi) => {
    for (let k = 0; k < X_LINES.length - 1; k++) {
      const a = X_LINES[k];
      const b = X_LINES[k + 1];
      const sp = spans[zi];
      if (sp.xb <= a || sp.xa >= b) segs.push({ along: 'x', line: z0, s0: a, s1: b });
      else {
        segs.push({ along: 'x', line: z0, s0: a, s1: sp.xa - 6 });
        segs.push({ along: 'x', line: z0, s0: sp.xb + 6, s1: b });
      }
    }
  });
  const P = (seg: Seg, s: number, o: number): [number, number] => (seg.along === 'z' ? [seg.line + o, s] : [s, seg.line + o]);

  for (const seg of segs) {
    const len = seg.s1 - seg.s0;
    const mid = P(seg, (seg.s0 + seg.s1) / 2, 0);
    const district = districtAt(mid[0], mid[1]);
    let side = 1;
    for (let s = seg.s0 + 16; s < seg.s1 - 12; s += 32) {
      const [x, z] = P(seg, s, side * 6.75);
      if (!blocked(x, z)) {
        // Arm points toward the road centre.
        // Local +z is the arm; rotate it to point back across the road.
        const yaw = seg.along === 'z' ? (side > 0 ? -Math.PI / 2 : Math.PI / 2) : side > 0 ? Math.PI : 0;
        const y = hm.get(x, z) + WALK;
        lights.push(mtx(x, y, z, yaw));
        physics.cylinder(x, y + 3.6, z, 3.6, 0.12);
        const [px, pz] = P(seg, s, side * 4.6);
        pools.push(mtx(px, hm.get(px, pz) + 0.12, pz, 0, 1));
      }
      side = -side;
    }
    if (district === 'residential' || district === 'commercial') {
      for (let s = seg.s0 + 12; s < seg.s1 - 10; s += 14) {
        for (const sd of [-1, 1]) {
          if (!rng.chance(0.7)) continue;
          const [x, z] = P(seg, s + rng.range(-1, 1), sd * 8.6);
          if (blocked(x, z)) continue;
          content.trees.push({ x, z, type: 'broad', scale: rng.range(0.75, 1.05) });
        }
      }
    }
    if (district !== 'outskirts' && district !== 'industrial') {
      for (let s = seg.s0 + 14; s < seg.s1 - 14; s += 6.6) {
        for (const sd of [-1, 1]) {
          if (!rng.chance(district === 'downtown' ? 0.26 : 0.2)) continue;
          const [x, z] = P(seg, s, sd * 3.25);
          if (blocked(x, z)) continue;
          const yaw = seg.along === 'z' ? (sd > 0 ? 0 : Math.PI) : sd > 0 ? Math.PI / 2 : -Math.PI / 2;
          content.cars.push({ x, z, yaw: yaw + Math.PI / 2, color: rng.pick([0x8f2b2b, 0x2b3f63, 0xd7d4cc, 0x1d1f22, 0x5f6a70, 0x30503f, 0x9a7a3c, 0xb6b9bd]) });
        }
      }
    }
    if (len > 40 && rng.chance(0.6) && district !== 'outskirts') {
      const [x, z] = P(seg, seg.s0 + rng.range(15, len - 15), rng.chance(0.5) ? 6.65 : -6.65);
      if (!blocked(x, z)) {
        const y = hm.get(x, z) + WALK;
        hydrants.push(mtx(x, y, z, 0));
        physics.cylinder(x, y + 0.4, z, 0.4, 0.18);
      }
    }
  }

  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3e42, roughness: 0.6, metalness: 0.5 });
  const poleGeo = merge([
    at(new THREE.CylinderGeometry(0.08, 0.13, 7.4, 8), 0, 3.7, 0),
    at(new THREE.BoxGeometry(0.1, 0.1, 1.9), 0, 7.25, 0.9),
    at(new THREE.CylinderGeometry(0.2, 0.24, 0.5, 8), 0, 0.25, 0),
  ]);
  const lampGeo = merge([at(new THREE.BoxGeometry(0.42, 0.14, 0.75), 0, 7.2, 1.8)]);
  const lampMat = new THREE.MeshStandardMaterial({ color: 0x51565a, emissive: 0xffb45c, emissiveIntensity: 0, roughness: 0.4 });
  // Rotate local +z (arm direction) by each matrix's yaw.
  add(instanced(poleGeo, poleMat, lights));
  add(instanced(lampGeo, lampMat, lights, undefined, false));

  const poolTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,190,110,0.9)');
    grad.addColorStop(0.5, 'rgba(255,170,90,0.3)');
    grad.addColorStop(1, 'rgba(255,160,80,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const poolMat = new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const poolGeo = new THREE.PlaneGeometry(9, 9).rotateX(-Math.PI / 2);
  const poolMesh = instanced(poolGeo, poolMat, pools, undefined, false);
  if (poolMesh) {
    poolMesh.receiveShadow = false;
    poolMesh.renderOrder = 2;
    add(poolMesh);
  }

  const hydrantGeo = merge([
    at(new THREE.CylinderGeometry(0.14, 0.17, 0.7, 10), 0, 0.35, 0),
    at(new THREE.SphereGeometry(0.15, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.7, 0),
    at(new THREE.CylinderGeometry(0.06, 0.06, 0.42, 8), 0, 0.5, 0, 0, 0, Math.PI / 2),
  ]);
  add(instanced(hydrantGeo, new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 0.5 }), hydrants));

  // ------------------------------------------------------------ intersections: traffic signals or stop signs
  const signalPoles: THREE.Matrix4[] = [];
  const heads: { ns: THREE.Matrix4[]; ew: THREE.Matrix4[] } = { ns: [], ew: [] };
  const stops: THREE.Matrix4[] = [];
  for (const x0 of X_LINES)
    for (const z0 of Z_LINES) {
      const d = districtAt(x0 + 1, z0 + 1);
      if (d === 'downtown' || d === 'commercial') {
        for (const [sx, sz] of [
          [1, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
        ]) {
          const x = x0 + sx * 6.3;
          const z = z0 + sz * 6.3;
          const y = hm.get(x, z) + WALK;
          signalPoles.push(mtx(x, y, z, 0));
          physics.cylinder(x, y + 2.6, z, 2.6, 0.12);
          // One head facing traffic on the avenue, one facing the street.
          heads.ns.push(mtx(x, y, z, sz > 0 ? 0 : Math.PI));
          heads.ew.push(mtx(x, y, z, sx > 0 ? Math.PI / 2 : -Math.PI / 2));
        }
      } else if (d === 'residential') {
        for (const [sx, sz, yaw] of [
          [1, 1, 0],
          [-1, -1, Math.PI],
        ]) {
          const x = x0 + sx * 5.6;
          const z = z0 + sz * 5.6;
          const y = hm.get(x, z) + WALK;
          stops.push(mtx(x, y, z, yaw));
          physics.cylinder(x, y + 1.3, z, 1.3, 0.06);
        }
      }
    }
  add(instanced(merge([at(new THREE.CylinderGeometry(0.1, 0.12, 5.2, 8), 0, 2.6, 0)]), poleMat, signalPoles));
  const headGeo = merge([at(new THREE.BoxGeometry(0.34, 1.0, 0.3), 0, 4.3, 0.24)]);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x202224, roughness: 0.5 });
  add(instanced(headGeo, headMat, [...heads.ns, ...heads.ew], undefined, false));
  const bulbColors = [0xff3b30, 0xffb020, 0x3ddc84];
  const signals: PropsResult['signals'] = { ns: [], ew: [] };
  (['ns', 'ew'] as const).forEach((dir) => {
    bulbColors.forEach((c, i) => {
      const g = merge([at(new THREE.CircleGeometry(0.1, 12), 0, 4.62 - i * 0.31, 0.395)]);
      const mat = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: 0.05, roughness: 0.3 });
      signals[dir].push(mat);
      add(instanced(g, mat, heads[dir], undefined, false));
    });
  });
  const stopTex = letterTexture('STOP', '#b3261e', '#ffffff', 128, 128);
  const stopGeo = merge([at(new THREE.CircleGeometry(0.36, 8), 0, 2.3, 0.04, 0, 0, Math.PI / 8)]);
  add(instanced(stopGeo, new THREE.MeshStandardMaterial({ map: stopTex, roughness: 0.5 }), stops, undefined, false));
  add(instanced(merge([at(new THREE.CylinderGeometry(0.035, 0.035, 2.5, 6), 0, 1.25, 0), at(new THREE.CircleGeometry(0.37, 8), 0, 2.3, 0.02, 0, Math.PI, Math.PI / 8)]), poleMat, stops));

  // ------------------------------------------------------------ trees
  const broad: THREE.Matrix4[] = [];
  const broadCol: THREE.Color[] = [];
  const pine: THREE.Matrix4[] = [];
  const pineCol: THREE.Color[] = [];
  const trunks: THREE.Matrix4[] = [];
  for (const t of content.trees) {
    if (t.y === undefined && blocked(t.x, t.z)) continue;
    const y = t.y ?? hm.get(t.x, t.z) - 0.1;
    const yaw = rng.range(0, Math.PI * 2);
    const m = mtx(t.x, y, t.z, yaw, t.scale);
    trunks.push(m);
    const c = surfaces() ? new THREE.Color().setHSL(rng.range(0.2, 0.31), rng.range(0.3, 0.55), rng.range(0.38, 0.5)).multiplyScalar(1.05) : new THREE.Color().setHSL(rng.range(0.22, 0.3), rng.range(0.35, 0.55), rng.range(0.24, 0.34));
    if (t.type === 'broad') {
      broad.push(m);
      broadCol.push(c);
    } else {
      pine.push(m);
      pineCol.push(surfaces() ? c.clone().multiplyScalar(0.85) : c.offsetHSL(0.04, -0.1, -0.06));
    }
    physics.cylinder(t.x, y + 1.5, t.z, 1.5, 0.22 * t.scale, 'wood');
  }
  const surf = surfaces();
  if (surf) {
    // HD trees: several seeded variants of each species, instanced per variant.
    const mats = treeMaterials(surf);
    const VARIANTS = 3;
    const species: [THREE.Matrix4[], THREE.Color[], (s: number, lod?: boolean) => { trunk: THREE.BufferGeometry; foliage: THREE.BufferGeometry }, THREE.Material, THREE.Material, number][] = [
      [broad, broadCol, broadleafGeometry, mats.broadTrunk, mats.leaves, 100],
      [pine, pineCol, pineGeometry, mats.pineTrunk, mats.needles, 200],
    ];
    for (const [list, cols, make, trunkMat, leafMat, seed] of species) {
      for (let v = 0; v < VARIANTS; v++) {
        const ms = list.filter((_, i) => i % VARIANTS === v);
        const cs = cols.filter((_, i) => i % VARIANTS === v);
        if (!ms.length) continue;
        const geo = make(seed + v * 17);
        // A lighter model of the same tree for the distance (picked up by the instance culler).
        const lod = make(seed + v * 17, true);
        const t = instanced(geo.trunk, trunkMat, ms);
        const f = instanced(geo.foliage, leafMat, ms, cs);
        if (t) t.userData.lod = lod.trunk;
        if (f) f.userData.lod = lod.foliage;
        add(t);
        add(f);
      }
    }
  } else {
    const trunkGeo = merge([at(new THREE.CylinderGeometry(0.13, 0.22, 3.2, 7), 0, 1.6, 0)]);
    add(instanced(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 }), trunks));
    const canopy = merge([
      at(new THREE.IcosahedronGeometry(1.9, 1), 0, 4.3, 0),
      at(new THREE.IcosahedronGeometry(1.4, 1), 0.9, 3.7, 0.5),
      at(new THREE.IcosahedronGeometry(1.3, 1), -0.8, 3.9, -0.6),
      at(new THREE.IcosahedronGeometry(1.1, 1), 0.2, 5.4, -0.2),
    ]);
    const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });
    add(instanced(canopy, leafMat, broad, broadCol));
    const pineGeo = merge([
      at(new THREE.ConeGeometry(2.0, 3.0, 8), 0, 3.0, 0),
      at(new THREE.ConeGeometry(1.6, 2.6, 8), 0, 4.6, 0),
      at(new THREE.ConeGeometry(1.1, 2.2, 8), 0, 6.0, 0),
    ]);
    add(instanced(pineGeo, leafMat, pine, pineCol));
  }

  // ------------------------------------------------------------ cars
  const carM: THREE.Matrix4[] = [];
  const carC: THREE.Color[] = [];
  for (const c of content.cars) {
    if (blocked(c.x, c.z)) continue;
    const y = hm.get(c.x, c.z) + (content.lots.some((l) => inRect(l, c.x, c.z)) ? 0.04 : 0.06);
    carM.push(mtx(c.x, y, c.z, c.yaw));
    carC.push(new THREE.Color(c.color));
    physics.box(c.x, y + 0.75, c.z, 2.15, 0.72, 0.9, c.yaw, 'metal');
  }
  const car = carGeometry();
  add(instanced(car.body, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.55 }), carM, carC));
  add(instanced(car.glass, new THREE.MeshStandardMaterial({ color: 0x1a232b, roughness: 0.1, metalness: 0.6 }), carM, undefined, false));
  add(instanced(car.wheels, new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.85 }), carM, undefined, false));
  add(instanced(car.lights, new THREE.MeshStandardMaterial({ color: 0xf2efe4, roughness: 0.3, emissive: 0x000000 }), carM, undefined, false));

  // ------------------------------------------------------------ benches and bins
  const benchM: THREE.Matrix4[] = [];
  for (const b of content.benches) {
    if (b.y === undefined && blocked(b.x, b.z)) continue;
    const y = b.y ?? hm.get(b.x, b.z) + (isOnWalk(b.x, b.z) ? WALK : 0);
    benchM.push(mtx(b.x, y, b.z, b.yaw));
    physics.box(b.x, y + 0.45, b.z, 0.95, 0.45, 0.35, b.yaw, 'wood');
  }
  add(instanced(benchGeometry(), new THREE.MeshStandardMaterial({ color: 0x7a5a3e, roughness: 0.8 }), benchM));
  const binM: THREE.Matrix4[] = [];
  for (const b of content.bins) {
    if (b.y === undefined && blocked(b.x, b.z)) continue;
    const y = b.y ?? hm.get(b.x, b.z) + (isOnWalk(b.x, b.z) ? WALK : 0);
    binM.push(mtx(b.x, y, b.z, 0));
    physics.cylinder(b.x, y + 0.5, b.z, 0.5, 0.3);
  }
  add(instanced(merge([at(new THREE.CylinderGeometry(0.3, 0.26, 1.0, 12, 1, true), 0, 0.5, 0), at(new THREE.CylinderGeometry(0.32, 0.32, 0.06, 12), 0, 1.02, 0)]), new THREE.MeshStandardMaterial({ color: 0x2f4a3a, roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide }), binM));

  // ------------------------------------------------------------ fences
  add(buildFences(content.fences, hm, physics));

  // ------------------------------------------------------------ shipping containers
  const contM: THREE.Matrix4[] = [];
  const contC: THREE.Color[] = [];
  const containerBase = new Map<string, number>();
  for (const c of content.containers) {
    const key = `${c.x.toFixed(1)},${c.z.toFixed(1)}`;
    let y = containerBase.get(key);
    if (y === undefined) {
      y = Math.max(hm.get(c.x - c.len / 2, c.z), hm.get(c.x + c.len / 2, c.z), hm.get(c.x, c.z));
      containerBase.set(key, y);
    }
    const yy = y + c.level * 2.6;
    const m = new THREE.Matrix4().compose(new THREE.Vector3(c.x, yy, c.z), new THREE.Quaternion(), new THREE.Vector3(c.len, 1, 1));
    contM.push(m);
    contC.push(new THREE.Color(c.color));
    physics.box(c.x, yy + 1.3, c.z, c.len / 2, 1.3, 1.22, 0, 'metal');
  }
  const cont = facadeTexture('corrugated', 77);
  add(instanced(merge([at(new THREE.BoxGeometry(1, 2.6, 2.44), 0, 1.3, 0)]), new THREE.MeshStandardMaterial({ color: 0xffffff, map: cont.map, roughness: 0.6, metalness: 0.3 }), contM, contC));

  // ------------------------------------------------------------ parking lots
  const lotB = new GeoBatch();
  const lineB = new GeoBatch();
  for (const l of content.lots) {
    const nx = Math.max(1, Math.ceil((l.x1 - l.x0) / 4));
    const nz = Math.max(1, Math.ceil((l.z1 - l.z0) / 4));
    lotB.grid(nz, nx, (r, c) => {
      const x = l.x0 + ((l.x1 - l.x0) * c) / nx;
      const z = l.z0 + ((l.z1 - l.z0) * r) / nz;
      return [x, hm.get(x, z) + 0.03, z, x / 9, z / 8];
    });
    for (const rowZ of [l.z0 + 3, l.z0 + 9.5]) {
      if (rowZ + 2.5 > l.z1) continue;
      for (let x = l.x0 + 2; x <= l.x1 - 2; x += 2.8) {
        const y = hm.get(x, rowZ) + 0.045;
        lineB.quad([x - 0.06, y, rowZ + 2.4], [x + 0.06, y, rowZ + 2.4], [x + 0.06, y, rowZ - 2.4], [x - 0.06, y, rowZ - 2.4]);
      }
    }
  }
  add(lotB.mesh(new THREE.MeshStandardMaterial({ map: asphaltTexture('plain'), roughness: 0.92 }), false));
  add(lineB.mesh(new THREE.MeshStandardMaterial({ color: 0xdedbd2, roughness: 0.8 }), false));

  return { group, nightMaterials: [lampMat], lightPools: poolMat, signals };

  function isOnWalk(x: number, z: number) {
    const dx = Math.min(...X_LINES.map((l) => Math.abs(l - x)));
    const dz = Math.min(...Z_LINES.map((l) => Math.abs(l - z)));
    return Math.min(dx, dz) <= ROAD.sidewalkHalf;
  }
}

/** Rooftop clutter for flat roofs. */
export function buildRooftop(items: { x: number; y: number; z: number; kind: 'ac' | 'tank' | 'vent'; yaw: number }[]): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9a9ea2, roughness: 0.6, metalness: 0.4 });
  const byKind = { ac: [] as THREE.Matrix4[], tank: [] as THREE.Matrix4[], vent: [] as THREE.Matrix4[] };
  for (const it of items) byKind[it.kind].push(mtx(it.x, it.y, it.z, it.yaw));
  const ac = merge([at(new THREE.BoxGeometry(2.2, 1.2, 1.4), 0, 0.6, 0), at(new THREE.CylinderGeometry(0.5, 0.5, 0.1, 14), 0.4, 1.25, 0)]);
  const tank = merge([
    at(new THREE.CylinderGeometry(1.4, 1.4, 2.6, 14), 0, 3.4, 0),
    at(new THREE.ConeGeometry(1.5, 0.8, 14), 0, 5.1, 0),
    at(new THREE.BoxGeometry(0.15, 2.1, 0.15), 1, 1.05, 1),
    at(new THREE.BoxGeometry(0.15, 2.1, 0.15), -1, 1.05, 1),
    at(new THREE.BoxGeometry(0.15, 2.1, 0.15), 1, 1.05, -1),
    at(new THREE.BoxGeometry(0.15, 2.1, 0.15), -1, 1.05, -1),
  ]);
  const vent = merge([at(new THREE.CylinderGeometry(0.6, 0.7, 1.4, 10), 0, 0.7, 0), at(new THREE.CylinderGeometry(0.9, 0.6, 0.3, 10), 0, 1.55, 0)]);
  for (const [geo, list] of [
    [ac, byKind.ac],
    [tank, byKind.tank],
    [vent, byKind.vent],
  ] as const) {
    const m = instanced(geo, mat, list);
    if (m) g.add(m);
  }
  return g;
}

function buildFences(fences: FenceSeg[], hm: Heightmap, physics: Physics): THREE.Group {
  const g = new THREE.Group();
  const picket = new GeoBatch();
  const chain = new GeoBatch();
  const posts: THREE.Matrix4[] = [];
  const chainPosts: THREE.Matrix4[] = [];
  for (const f of fences) {
    const len = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
    if (len < 0.5) continue;
    const n = Math.max(1, Math.ceil(len / 2));
    const h = f.kind === 'picket' ? 1.05 : 2.2;
    const b = f.kind === 'picket' ? picket : chain;
    const uScale = f.kind === 'picket' ? 1 / 0.9 : 1 / 0.5;
    for (let i = 0; i < n; i++) {
      const t0 = i / n;
      const t1 = (i + 1) / n;
      const ax = f.x0 + (f.x1 - f.x0) * t0;
      const az = f.z0 + (f.z1 - f.z0) * t0;
      const bx = f.x0 + (f.x1 - f.x0) * t1;
      const bz = f.z0 + (f.z1 - f.z0) * t1;
      const ya = hm.get(ax, az) - 0.05;
      const yb = hm.get(bx, bz) - 0.05;
      b.quad([ax, ya, az], [bx, yb, bz], [bx, yb + h, bz], [ax, ya + h, az], [t0 * len * uScale, 0, t1 * len * uScale, f.kind === 'picket' ? 1 : h / 0.5]);
    }
    const posts2 = f.kind === 'picket' ? posts : chainPosts;
    const step = f.kind === 'picket' ? 2.4 : 3;
    const np = Math.max(1, Math.round(len / step));
    for (let i = 0; i <= np; i++) {
      const x = f.x0 + ((f.x1 - f.x0) * i) / np;
      const z = f.z0 + ((f.z1 - f.z0) * i) / np;
      posts2.push(mtx(x, hm.get(x, z) - 0.1, z, 0));
    }
    // One thin collider per fence run, following its average height.
    const cx = (f.x0 + f.x1) / 2;
    const cz = (f.z0 + f.z1) / 2;
    const yaw = Math.atan2(-(f.z1 - f.z0), f.x1 - f.x0);
    const ymid = hm.get(cx, cz);
    const yMin = Math.min(hm.get(f.x0, f.z0), hm.get(f.x1, f.z1), ymid);
    const yMax = Math.max(hm.get(f.x0, f.z0), hm.get(f.x1, f.z1), ymid) + h;
    physics.box(cx, (yMin + yMax) / 2, cz, len / 2, (yMax - yMin) / 2, 0.06, yaw, 'wood');
  }
  const picketTex = (() => {
    const c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const x = c.getContext('2d')!;
    x.fillStyle = '#f1efe9';
    for (let i = 0; i < 6; i++) {
      const px = i * 21 + 4;
      x.beginPath();
      x.moveTo(px, 128);
      x.lineTo(px, 16);
      x.lineTo(px + 6.5, 4);
      x.lineTo(px + 13, 16);
      x.lineTo(px + 13, 128);
      x.fill();
    }
    x.fillRect(0, 34, 128, 9);
    x.fillRect(0, 96, 128, 9);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    return t;
  })();
  const pm = picket.mesh(new THREE.MeshStandardMaterial({ map: picketTex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 }));
  if (pm) g.add(pm);
  const chainTex = chainLinkTexture();
  const cm = chain.mesh(new THREE.MeshStandardMaterial({ map: chainTex, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.6, color: 0xb9bec2 }), false);
  if (cm) g.add(cm);
  const pp = instanced(merge([at(new THREE.BoxGeometry(0.1, 1.25, 0.1), 0, 0.62, 0)]), new THREE.MeshStandardMaterial({ color: 0xece9e2, roughness: 0.8 }), posts);
  if (pp) g.add(pp);
  const cp = instanced(merge([at(new THREE.CylinderGeometry(0.04, 0.04, 2.4, 6), 0, 1.2, 0)]), new THREE.MeshStandardMaterial({ color: 0x8d9296, metalness: 0.6, roughness: 0.4 }), chainPosts);
  if (cp) g.add(cp);
  return g;
}

function carGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-2.15, 0.32);
  shape.lineTo(2.1, 0.32);
  shape.quadraticCurveTo(2.25, 0.34, 2.24, 0.62);
  shape.quadraticCurveTo(2.2, 0.86, 1.95, 0.92);
  shape.lineTo(0.9, 1.0);
  shape.lineTo(-1.85, 1.02);
  shape.quadraticCurveTo(-2.2, 1.0, -2.2, 0.75);
  shape.lineTo(-2.2, 0.45);
  shape.quadraticCurveTo(-2.2, 0.32, -2.15, 0.32);
  const body = new THREE.ExtrudeGeometry(shape, { depth: 1.66, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 2, curveSegments: 6 });
  body.translate(0, 0, -0.83);
  const cab = new THREE.Shape();
  cab.moveTo(0.95, 1.0);
  cab.lineTo(0.25, 1.48);
  cab.lineTo(-1.25, 1.5);
  cab.lineTo(-1.8, 1.02);
  const glass = new THREE.ExtrudeGeometry(cab, { depth: 1.46, bevelEnabled: false });
  glass.translate(0, 0, -0.73);
  const roof = at(new THREE.BoxGeometry(1.42, 0.06, 1.5), -0.5, 1.51, 0);
  const wheels: THREE.BufferGeometry[] = [];
  for (const wx of [1.35, -1.4]) for (const wz of [0.82, -0.82]) wheels.push(at(new THREE.CylinderGeometry(0.34, 0.34, 0.24, 14), wx, 0.34, wz, Math.PI / 2));
  const lights = merge([at(new THREE.BoxGeometry(0.05, 0.12, 0.34), 2.27, 0.72, 0.55), at(new THREE.BoxGeometry(0.05, 0.12, 0.34), 2.27, 0.72, -0.55)]);
  return { body: merge([body, roof]), glass: merge([glass]), wheels: merge(wheels), lights };
}

function benchGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) parts.push(at(new THREE.BoxGeometry(1.8, 0.05, 0.11), 0, 0.46, -0.13 + i * 0.13));
  for (let i = 0; i < 2; i++) parts.push(at(new THREE.BoxGeometry(1.8, 0.11, 0.04), 0, 0.68 + i * 0.16, -0.24, -0.2));
  for (const x of [-0.75, 0.75]) {
    parts.push(at(new THREE.BoxGeometry(0.06, 0.46, 0.4), x, 0.23, 0));
    parts.push(at(new THREE.BoxGeometry(0.06, 0.5, 0.05), x, 0.7, -0.26, -0.2));
  }
  return merge(parts);
}

export { noiseTexture };
