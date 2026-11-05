import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { noiseTexture, woodFloorTexture } from '../world/Textures';

/**
 * Detailed furniture built from rounded shapes. Every piece is a THREE.Group in the house's local
 * frame (y = floor) with an optional collision box, so whole rooms can be cleared out later.
 */

export interface Piece {
  group: THREE.Group;
  /** Collision box in local coordinates: [x0, y0, z0, x1, y1, z1]. */
  box?: [number, number, number, number, number, number];
}

const M = {
  wood: () => new THREE.MeshStandardMaterial({ map: woodFloorTexture(), color: 0x8a5f3c, roughness: 0.55 }),
};

let cache: Record<string, THREE.Material> | null = null;
function mats() {
  if (cache) return cache;
  const fabric = noiseTexture(401, '#b9b4ad', '#ffffff', '#555', 9000, 1.5);
  fabric.repeat.set(3, 3);
  cache = {
    wood: M.wood(),
    darkWood: new THREE.MeshStandardMaterial({ map: woodFloorTexture(), color: 0x5a3e2b, roughness: 0.5 }),
    sofa: new THREE.MeshStandardMaterial({ map: fabric, color: 0x3f5a6e, roughness: 0.95 }),
    cushion: new THREE.MeshStandardMaterial({ map: fabric, color: 0xc8823e, roughness: 0.95 }),
    linen: new THREE.MeshStandardMaterial({ map: fabric, color: 0xece6da, roughness: 1 }),
    blanket: new THREE.MeshStandardMaterial({ map: fabric, color: 0x7a2f3a, roughness: 0.95 }),
    white: new THREE.MeshStandardMaterial({ color: 0xeeebe4, roughness: 0.35 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb9bec2, roughness: 0.25, metalness: 0.85 }),
    black: new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.35 }),
    screen: new THREE.MeshStandardMaterial({ color: 0x0b1015, roughness: 0.1, metalness: 0.4, emissive: 0x2a4a66, emissiveIntensity: 0.25 }),
    counter: new THREE.MeshStandardMaterial({ map: noiseTexture(402, '#2a2a2c', '#666', '#000', 6000, 2), roughness: 0.25, metalness: 0.1 }),
    cabinet: new THREE.MeshStandardMaterial({ color: 0x4b6455, roughness: 0.6 }),
    rug: new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 1 }),
    lampShade: new THREE.MeshStandardMaterial({ color: 0xf3e6c8, emissive: 0xffd9a0, emissiveIntensity: 0.6, roughness: 0.9, side: THREE.DoubleSide }),
    pot: new THREE.MeshStandardMaterial({ color: 0xb2603f, roughness: 0.8 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.8, flatShading: true }),
    frame: new THREE.MeshStandardMaterial({ color: 0x2a2520, roughness: 0.5 }),
  };
  return cache;
}

function rugTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#7b3d33';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#d8b479';
  g.lineWidth = 8;
  g.strokeRect(14, 14, 228, 228);
  g.lineWidth = 3;
  g.strokeRect(30, 30, 196, 196);
  g.fillStyle = '#2f4a5e';
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    g.moveTo(128, 60 + i * 34);
    g.lineTo(158, 77 + i * 34);
    g.lineTo(128, 94 + i * 34);
    g.lineTo(98, 77 + i * 34);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function paintingTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 192);
  sky.addColorStop(0, seed % 2 ? '#f2a85a' : '#7aa6c8');
  sky.addColorStop(1, seed % 2 ? '#c4536a' : '#e7dcc4');
  g.fillStyle = sky;
  g.fillRect(0, 0, 256, 192);
  g.fillStyle = seed % 2 ? '#3b2a3a' : '#3d5a3a';
  g.beginPath();
  g.moveTo(0, 150);
  for (let x = 0; x <= 256; x += 16) g.lineTo(x, 120 + Math.sin(x / 30 + seed) * 22);
  g.lineTo(256, 192);
  g.lineTo(0, 192);
  g.fill();
  g.fillStyle = 'rgba(255,240,200,0.8)';
  g.beginPath();
  g.arc(180, 60, 18, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const rb = (w: number, h: number, d: number, r = 0.04) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));

function add(g: THREE.Group, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.y = ry;
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function place(g: THREE.Group, x: number, z: number, ry = 0): THREE.Group {
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  return g;
}

/** Sofa facing +x (seat along z). */
export function sofa(x: number, z: number, len = 1.9): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(0.85, 0.22, len, 0.06), m.sofa, 0, 0.3, 0);
  for (const s of [-1, 1]) add(g, rb(0.6, 0.18, len / 2 - 0.06, 0.07), m.sofa, 0.06, 0.48, (s * len) / 4);
  add(g, rb(0.22, 0.55, len, 0.08), m.sofa, -0.32, 0.62, 0);
  for (const s of [-1, 1]) add(g, rb(0.85, 0.42, 0.2, 0.08), m.sofa, 0, 0.52, s * (len / 2 + 0.06));
  add(g, rb(0.14, 0.32, 0.36, 0.08), m.cushion, -0.18, 0.72, -len / 4).rotation.z = -0.2;
  for (const sx of [-0.35, 0.35]) for (const sz of [-1, 1]) add(g, new THREE.CylinderGeometry(0.025, 0.02, 0.2, 8), m.darkWood, sx, 0.1, sz * (len / 2 - 0.05));
  return { group: place(g, x, z), box: [x - 0.45, 0, z - len / 2 - 0.16, x + 0.45, 0.55, z + len / 2 + 0.16] };
}

export function coffeeTable(x: number, z: number): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(0.6, 0.05, 1.0, 0.02), m.wood, 0, 0.42, 0);
  add(g, rb(0.5, 0.03, 0.9, 0.01), m.darkWood, 0, 0.15, 0);
  for (const sx of [-0.26, 0.26]) for (const sz of [-0.45, 0.45]) add(g, rb(0.04, 0.42, 0.04, 0.01), m.darkWood, sx, 0.21, sz);
  add(g, rb(0.18, 0.04, 0.24, 0.01), m.cushion, 0.05, 0.47, -0.2);
  add(g, new THREE.CylinderGeometry(0.04, 0.035, 0.1, 12), m.white, -0.1, 0.5, 0.25);
  return { group: place(g, x, z), box: [x - 0.3, 0, z - 0.5, x + 0.3, 0.45, z + 0.5] };
}

/** TV unit against the +x wall, screen facing -x. */
export function tvUnit(x: number, z: number): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(0.45, 0.45, 1.6, 0.02), m.darkWood, 0, 0.225, 0);
  for (const s of [-0.4, 0.4]) add(g, rb(0.02, 0.3, 0.7, 0.01), m.wood, -0.23, 0.22, s);
  add(g, rb(0.06, 0.62, 1.15, 0.015), m.black, 0.05, 0.86, 0);
  const scr = add(g, new THREE.PlaneGeometry(1.08, 0.56), m.screen, 0.018, 0.86, 0, -Math.PI / 2);
  scr.castShadow = false;
  add(g, rb(0.18, 0.04, 0.3, 0.01), m.black, 0.05, 0.47, 0);
  return { group: place(g, x, z), box: [x - 0.23, 0, z - 0.8, x + 0.23, 1.2, z + 0.8] };
}

export function rug(x: number, z: number, w: number, d: number): Piece {
  const g = new THREE.Group();
  const r = add(g, new THREE.BoxGeometry(w, 0.012, d), mats().rug, 0, 0.006, 0);
  r.castShadow = false;
  return { group: place(g, x, z) };
}

export function diningSet(x: number, z: number): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(0.9, 0.05, 0.9, 0.02), m.wood, 0, 0.75, 0);
  for (const sx of [-0.4, 0.4]) for (const sz of [-0.4, 0.4]) add(g, rb(0.05, 0.75, 0.05, 0.015), m.darkWood, sx, 0.375, sz);
  for (const [cx, ry] of [
    [-0.62, 0],
    [0.62, Math.PI],
  ] as const) {
    const c = new THREE.Group();
    add(c, rb(0.42, 0.04, 0.42, 0.015), m.wood, 0, 0.46, 0);
    add(c, rb(0.04, 0.5, 0.42, 0.015), m.darkWood, -0.19, 0.72, 0);
    for (const sx of [-0.17, 0.17]) for (const sz of [-0.17, 0.17]) add(c, rb(0.035, 0.46, 0.035, 0.01), m.darkWood, sx, 0.23, sz);
    c.position.set(cx, 0, 0);
    c.rotation.y = ry;
    g.add(c);
  }
  add(g, new THREE.CylinderGeometry(0.09, 0.06, 0.16, 14), m.white, 0, 0.86, 0);
  add(g, new THREE.IcosahedronGeometry(0.13, 0), m.leaf, 0, 1.0, 0);
  return { group: place(g, x, z), box: [x - 0.85, 0, z - 0.45, x + 0.85, 0.78, z + 0.45] };
}

/** Bed with headboard at -z. */
export function bed(x: number, z: number): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(1.7, 0.3, 2.05, 0.04), m.darkWood, 0, 0.2, 0);
  add(g, rb(1.6, 0.2, 1.95, 0.08), m.linen, 0, 0.45, 0);
  add(g, rb(1.64, 0.08, 1.25, 0.04), m.blanket, 0, 0.56, 0.33);
  for (const s of [-0.38, 0.38]) add(g, rb(0.62, 0.14, 0.36, 0.07), m.white, s, 0.62, -0.72);
  add(g, rb(1.8, 1.0, 0.08, 0.03), m.darkWood, 0, 0.55, -1.03);
  return { group: place(g, x, z), box: [x - 0.85, 0, z - 1.07, x + 0.85, 0.5, z + 1.03] };
}

export function nightstand(x: number, z: number): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(0.48, 0.52, 0.42, 0.02), m.darkWood, 0, 0.26, 0);
  add(g, rb(0.4, 0.16, 0.02, 0.005), m.wood, 0, 0.36, 0.21);
  add(g, new THREE.CylinderGeometry(0.06, 0.08, 0.04, 14), m.steel, 0, 0.54, 0);
  add(g, new THREE.CylinderGeometry(0.01, 0.01, 0.22, 6), m.steel, 0, 0.66, 0);
  add(g, new THREE.CylinderGeometry(0.09, 0.13, 0.15, 16, 1, true), m.lampShade, 0, 0.8, 0);
  return { group: place(g, x, z), box: [x - 0.24, 0, z - 0.21, x + 0.24, 0.55, z + 0.21] };
}

export function desk(x: number, z: number): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(1.7, 0.05, 0.65, 0.015), m.wood, 0, 0.74, 0);
  add(g, rb(0.45, 0.7, 0.6, 0.02), m.darkWood, 0.6, 0.35, 0);
  for (let i = 0; i < 3; i++) add(g, rb(0.4, 0.18, 0.02, 0.005), m.wood, 0.6, 0.15 + i * 0.22, 0.31);
  add(g, rb(0.04, 0.72, 0.6, 0.01), m.darkWood, -0.82, 0.36, 0);
  // Office chair.
  const c = new THREE.Group();
  add(c, rb(0.48, 0.08, 0.46, 0.04), m.black, 0, 0.48, 0);
  add(c, rb(0.46, 0.55, 0.06, 0.04), m.black, 0, 0.8, 0.22);
  add(c, new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), m.steel, 0, 0.25, 0);
  for (let i = 0; i < 5; i++) {
    const leg = add(c, rb(0.3, 0.03, 0.04, 0.01), m.steel, Math.cos((i / 5) * Math.PI * 2) * 0.15, 0.05, Math.sin((i / 5) * Math.PI * 2) * 0.15);
    leg.rotation.y = -(i / 5) * Math.PI * 2;
  }
  c.position.set(-0.15, 0, 0.75);
  g.add(c);
  return { group: place(g, x, z), box: [x - 0.85, 0, z - 0.33, x + 0.85, 0.77, z + 0.33] };
}

export function wardrobe(x: number, z: number): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(0.6, 2.0, 1.9, 0.02), m.darkWood, 0, 1.0, 0);
  for (const s of [-0.47, 0.47]) {
    add(g, rb(0.02, 1.85, 0.9, 0.005), m.wood, -0.31, 1.0, s);
    add(g, rb(0.03, 0.3, 0.03, 0.01), m.steel, -0.33, 1.05, s * 0.12);
  }
  return { group: place(g, x, z), box: [x - 0.3, 0, z - 0.95, x + 0.3, 2.0, z + 0.95] };
}

export function bookshelf(x: number, z: number, ry = 0): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(0.32, 1.8, 0.9, 0.015), m.darkWood, 0, 0.9, 0);
  const colors = [0x8e3b35, 0x2f4f6f, 0xd8cfbd, 0x3e5e44, 0xc48a3a, 0x6b4f7a];
  for (let shelf = 0; shelf < 4; shelf++) {
    add(g, rb(0.3, 0.025, 0.86, 0.005), m.wood, 0.01, 0.2 + shelf * 0.42, 0);
    let pz = -0.38;
    let k = shelf * 7;
    while (pz < 0.36) {
      const w = 0.04 + ((k * 37) % 5) * 0.012;
      const h = 0.24 + ((k * 13) % 4) * 0.03;
      add(g, new THREE.BoxGeometry(0.22, h, w), new THREE.MeshStandardMaterial({ color: colors[k % colors.length], roughness: 0.8 }), 0.03, 0.22 + shelf * 0.42 + h / 2, pz + w / 2);
      pz += w + 0.008;
      k++;
    }
  }
  const p = place(g, x, z, ry);
  const turned = Math.abs(Math.sin(ry)) > 0.7;
  const hx = turned ? 0.46 : 0.18;
  const hz = turned ? 0.18 : 0.46;
  return { group: p, box: [x - hx, 0, z - hz, x + hx, 1.8, z + hz] };
}

export function floorLamp(x: number, z: number): Piece & { light: THREE.PointLight } {
  const m = mats();
  const g = new THREE.Group();
  add(g, new THREE.CylinderGeometry(0.16, 0.18, 0.04, 18), m.black, 0, 0.02, 0);
  add(g, new THREE.CylinderGeometry(0.015, 0.015, 1.5, 8), m.steel, 0, 0.77, 0);
  add(g, new THREE.CylinderGeometry(0.17, 0.25, 0.3, 20, 1, true), m.lampShade, 0, 1.55, 0).castShadow = false;
  const light = new THREE.PointLight(0xffc98a, 0, 5, 2);
  light.position.set(0, 1.45, 0);
  g.add(light);
  return { group: place(g, x, z), box: [x - 0.15, 0, z - 0.15, x + 0.15, 1.6, z + 0.15], light };
}

export function plant(x: number, z: number, s = 1): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, new THREE.CylinderGeometry(0.17 * s, 0.13 * s, 0.32 * s, 16), m.pot, 0, 0.16 * s, 0);
  for (let i = 0; i < 6; i++) {
    const l = add(g, new THREE.ConeGeometry(0.07 * s, 0.6 * s, 4), m.leaf, Math.cos(i) * 0.06 * s, 0.55 * s, Math.sin(i) * 0.06 * s);
    l.rotation.set(Math.cos(i * 2) * 0.4, 0, Math.sin(i * 2) * 0.4);
  }
  return { group: place(g, x, z), box: [x - 0.17 * s, 0, z - 0.17 * s, x + 0.17 * s, 0.6 * s, z + 0.17 * s] };
}

/** Kitchen run along the -x wall: fridge, base cabinets, worktop, sink, hob and wall cabinets. */
export function kitchen(x: number, z0: number, z1: number): Piece {
  const m = mats();
  const g = new THREE.Group();
  const len = z1 - z0;
  const cz = (z0 + z1) / 2;
  // Fridge at the z0 end.
  add(g, rb(0.66, 1.85, 0.68, 0.04), m.white, 0, 0.925, z0 + 0.34 - cz);
  add(g, rb(0.02, 0.01, 0.6, 0.002), m.black, 0.335, 1.25, z0 + 0.34 - cz);
  add(g, rb(0.03, 0.5, 0.03, 0.01), m.steel, 0.35, 1.5, z0 + 0.6 - cz);
  add(g, rb(0.03, 0.3, 0.03, 0.01), m.steel, 0.35, 0.9, z0 + 0.6 - cz);
  const runStart = z0 + 0.7;
  const runLen = z1 - runStart;
  const runC = (runStart + z1) / 2 - cz;
  add(g, rb(0.6, 0.86, runLen, 0.01), m.cabinet, -0.02, 0.43, runC);
  add(g, rb(0.66, 0.04, runLen + 0.02, 0.01), m.counter, 0, 0.88, runC);
  const doors = Math.max(1, Math.floor(runLen / 0.5));
  for (let i = 0; i < doors; i++) {
    const dz = runStart + ((i + 0.5) * runLen) / doors - cz;
    add(g, rb(0.02, 0.7, runLen / doors - 0.04, 0.005), m.cabinet, 0.29, 0.43, dz);
    add(g, rb(0.03, 0.14, 0.02, 0.005), m.steel, 0.31, 0.68, dz + runLen / doors / 2 - 0.08);
  }
  add(g, rb(0.4, 0.02, 0.5, 0.01), m.steel, 0.02, 0.905, runC - runLen / 4);
  add(g, new THREE.CylinderGeometry(0.015, 0.015, 0.25, 8), m.steel, -0.2, 1.02, runC - runLen / 4);
  for (const dz of [-0.13, 0.13]) for (const dx of [-0.12, 0.12]) add(g, new THREE.CylinderGeometry(0.09, 0.09, 0.012, 18), m.black, dx, 0.905, runC + runLen / 4 + dz);
  add(g, rb(0.35, 0.6, runLen, 0.01), m.cabinet, -0.14, 1.85, runC);
  return { group: place(g, x, cz), box: [x - 0.33, 0, z0, x + 0.33, 1.85, z1] };
}

export function painting(x: number, y: number, z: number, ry: number, seed: number, w = 0.9, h = 0.65): Piece {
  const m = mats();
  const g = new THREE.Group();
  add(g, rb(w + 0.08, h + 0.08, 0.04, 0.01), m.frame, 0, 0, 0);
  const art = add(g, new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: paintingTexture(seed), roughness: 0.6 }), 0, 0, 0.021);
  art.castShadow = false;
  g.position.set(x, y, z);
  g.rotation.y = ry;
  return { group: g };
}

export function curtains(x: number, y: number, z: number, ry: number, w: number, color = 0x7a6a8a): Piece {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, side: THREE.DoubleSide });
  for (const s of [-1, 1]) {
    const geo = new THREE.PlaneGeometry(w * 0.28, 1.5, 8, 1);
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 40) * 0.025);
    geo.computeVertexNormals();
    add(g, geo, mat, s * w * 0.4, 0, 0);
  }
  add(g, new THREE.CylinderGeometry(0.012, 0.012, w + 0.2, 8).rotateZ(Math.PI / 2), mats().steel, 0, 0.78, 0);
  g.position.set(x, y, z);
  g.rotation.y = ry;
  return { group: g };
}
