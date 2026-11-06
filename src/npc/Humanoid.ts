import * as THREE from 'three';

/**
 * Instanced low-poly people: legs, torso, arms, head with big cartoon eyes, hair/cap, vest and a
 * hand-held item. One renderer draws any number of characters in 11 draw calls.
 */

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Walk cycle phase (radians). */
  phase: number;
  /** Leg/arm swing amplitude (0 = standing). */
  swing: number;
  /** Extra rotation of the right arm around x (negative raises it forward). */
  armR?: number;
  armL?: number;
  /** Head pitch (negative tilts back). */
  head?: number;
  /** Small lateral wobble (jittery effects). */
  shake?: number;
  vest?: boolean;
  item?: boolean;
  /** Uniform scale (kids/large builds). */
  scale?: number;
}

export interface Look {
  skin: number;
  shirt: number;
  pants: number;
  hair: number;
  vest?: number;
  item?: number;
}

const PART = { legL: 0, legR: 1, torso: 2, head: 3, armL: 4, armR: 5, hair: 6, vest: 7, eyes: 8, item: 9 } as const;

function eyesGeometry(): THREE.BufferGeometry {
  // Two white eyeballs with dark pupils, coloured through vertex colours.
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, color: THREE.Color, x: number, y: number, z: number) => {
    g.translate(x, y, z);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([color.r, color.g, color.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const white = new THREE.Color(0xf6f4ee);
  const black = new THREE.Color(0x15171a);
  for (const s of [-1, 1]) {
    // Low-poly: these figures are only used at a distance, where eyes are a few pixels.
    add(new THREE.SphereGeometry(0.042, 7, 5), white, s * 0.045, 0.015, 0.095);
    add(new THREE.SphereGeometry(0.019, 5, 4), black, s * 0.045, 0.012, 0.133);
  }
  return mergeSimple(parts);
}

function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let count = 0;
  for (const g of geos) count += g.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let o = 0;
  for (const g of geos) {
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    nor.set(g.attributes.normal.array as Float32Array, o * 3);
    if (g.attributes.color) col.set(g.attributes.color.array as Float32Array, o * 3);
    else col.fill(1, o * 3, (o + g.attributes.position.count) * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

export class HumanoidRenderer {
  private parts: THREE.InstancedMesh[] = [];
  private base = new THREE.Matrix4();
  private tmp = new THREE.Matrix4();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private c = new THREE.Color();
  private dirty = new Set<number>();
  /** Which slots are showing someone; draws stop after the last one. */
  private shown: Uint8Array;
  readonly group = new THREE.Group();

  constructor(
    scene: THREE.Scene,
    readonly capacity: number,
    castShadow = true,
  ) {
    this.shown = new Uint8Array(capacity);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, vertexColors: true });
    // Leg with a dark shoe baked in through vertex colours (instance colour tints both).
    const shoe = new THREE.BoxGeometry(0.17, 0.09, 0.27).translate(0, -0.86, 0.045).toNonIndexed();
    const sc = new Float32Array(shoe.attributes.position.count * 3).fill(0.16);
    shoe.setAttribute('color', new THREE.BufferAttribute(sc, 3));
    const leg = mergeSimple([new THREE.BoxGeometry(0.15, 0.82, 0.17).translate(0, -0.41, 0).toNonIndexed(), shoe]);
    const legMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, vertexColors: true });
    const arm = new THREE.BoxGeometry(0.1, 0.6, 0.12).translate(0, -0.3, 0);
    const geos: [THREE.BufferGeometry, THREE.Material][] = [
      [leg, legMat],
      [leg, legMat],
      [new THREE.BoxGeometry(0.42, 0.62, 0.25).translate(0, 0.31, 0), mat],
      [new THREE.SphereGeometry(0.14, 10, 8).scale(1, 1.08, 1), mat],
      [arm, mat],
      [arm, mat],
      [new THREE.SphereGeometry(0.148, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 0.015, -0.012), mat],
      [new THREE.BoxGeometry(0.45, 0.4, 0.28).translate(0, 0.36, 0), mat],
      [eyesGeometry(), eyeMat],
      [new THREE.BoxGeometry(0.07, 0.05, 0.1).translate(0, -0.62, 0.05), mat],
    ];
    for (const [g, m] of geos) {
      const im = new THREE.InstancedMesh(g, m, capacity);
      // Eyes are too small to show in a shadow.
      im.castShadow = castShadow && g !== geos[8][0];
      im.receiveShadow = false;
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < capacity; i++) {
        im.setMatrixAt(i, this.hidden);
        im.setColorAt(i, this.c.setHex(0xffffff));
      }
      this.parts.push(im);
      this.group.add(im);
    }
    scene.add(this.group);
  }

  setLook(i: number, look: Look) {
    const set = (p: number, hex: number) => this.parts[p].setColorAt(i, this.c.setHex(hex));
    set(PART.legL, look.pants);
    set(PART.legR, look.pants);
    set(PART.torso, look.shirt);
    set(PART.head, look.skin);
    set(PART.armL, look.shirt);
    set(PART.armR, look.shirt);
    set(PART.hair, look.hair);
    set(PART.vest, look.vest ?? 0x1d1f22);
    set(PART.eyes, 0xffffff);
    set(PART.item, look.item ?? 0xd9e6ea);
    for (const p of this.parts) if (p.instanceColor) p.instanceColor.needsUpdate = true;
  }

  /** Tint the torso (used for product effects such as Glowing). */
  tint(i: number, base: number, toward: number, t: number) {
    this.c.setHex(base).lerp(new THREE.Color(toward), t);
    this.parts[PART.torso].setColorAt(i, this.c);
    this.parts[PART.armL].setColorAt(i, this.c);
    this.parts[PART.armR].setColorAt(i, this.c);
    this.parts[PART.torso].instanceColor!.needsUpdate = true;
    this.parts[PART.armL].instanceColor!.needsUpdate = true;
    this.parts[PART.armR].instanceColor!.needsUpdate = true;
  }

  setItemColor(i: number, hex: number) {
    this.parts[PART.item].setColorAt(i, this.c.setHex(hex));
    this.parts[PART.item].instanceColor!.needsUpdate = true;
  }

  hide(i: number) {
    if (!this.shown[i] && !this.dirty.has(i)) return;
    this.shown[i] = 0;
    for (const p of this.parts) p.setMatrixAt(i, this.hidden);
    this.dirty.add(i);
  }

  pose(i: number, p: Pose) {
    this.shown[i] = 1;
    const sc = p.scale ?? 1;
    const bob = Math.abs(Math.sin(p.phase)) * 0.035 * Math.min(1, p.swing * 2);
    const shake = p.shake ?? 0;
    this.q.setFromAxisAngle(this.v.set(0, 1, 0), p.yaw);
    this.base.compose(this.v.set(p.x + shake, p.y + bob, p.z), this.q, this.s.set(sc, sc, sc));
    const sw = Math.sin(p.phase) * p.swing;
    this.limb(PART.legL, i, -0.1, 0.9, 0, sw);
    this.limb(PART.legR, i, 0.1, 0.9, 0, -sw);
    this.limb(PART.torso, i, 0, 0.9, 0, 0);
    const head = p.head ?? 0;
    this.limb(PART.head, i, 0, 1.68, 0, head);
    this.limb(PART.eyes, i, 0, 1.68, 0, head);
    this.limb(PART.hair, i, 0, 1.68, 0, head);
    const armL = -sw * 0.8 + (p.armL ?? 0);
    const armR = sw * 0.8 + (p.armR ?? 0);
    this.limb(PART.armL, i, -0.27, 1.48, 0, armL);
    this.limb(PART.armR, i, 0.27, 1.48, 0, armR);
    if (p.vest) this.limb(PART.vest, i, 0, 0.9, 0, 0);
    else this.parts[PART.vest].setMatrixAt(i, this.hidden);
    if (p.item) this.limb(PART.item, i, 0.27, 1.48, 0, armR);
    else this.parts[PART.item].setMatrixAt(i, this.hidden);
    this.dirty.add(i);
  }

  private limb(part: number, i: number, x: number, y: number, z: number, rotX: number) {
    this.tmp.makeRotationX(rotX).setPosition(x, y, z);
    this.m.multiplyMatrices(this.base, this.tmp);
    this.parts[part].setMatrixAt(i, this.m);
  }

  commit() {
    if (!this.dirty.size) return;
    // Only draw up to the last slot in use (hidden slots are zero-scaled, but still cost vertices).
    let top = this.capacity - 1;
    while (top >= 0 && !this.shown[top]) top--;
    for (const p of this.parts) {
      p.count = top + 1;
      p.instanceMatrix.needsUpdate = true;
    }
    this.dirty.clear();
  }

  /** World position of the right hand for a pose (for particle effects). */
  handPos(p: Pose, out: THREE.Vector3): THREE.Vector3 {
    const a = (p.armR ?? 0) + Math.sin(p.phase) * p.swing * 0.8;
    const ly = 1.48 - Math.cos(a) * 0.6;
    const lz = -Math.sin(a) * 0.6;
    const s = Math.sin(p.yaw);
    const c = Math.cos(p.yaw);
    return out.set(p.x + 0.27 * c + lz * s, p.y + ly, p.z - 0.27 * s + lz * c);
  }

  facePos(p: Pose, out: THREE.Vector3): THREE.Vector3 {
    return out.set(p.x + Math.sin(p.yaw) * 0.16, p.y + 1.66, p.z + Math.cos(p.yaw) * 0.16);
  }
}

export const SKINS = [0xf1c8a8, 0xd9a47e, 0xb57a52, 0x8a5634, 0x5e3b24, 0xe8b996, 0xf3d2b8];
export const HAIRS = [0x1c1612, 0x3a2617, 0x6b4426, 0xb08a5a, 0x8a8a8a, 0x2b1d14, 0xa8432a, 0xd8c08a];
export const SHIRTS = [0x8e3b35, 0x2f4f6f, 0xd8cfbd, 0x3e5e44, 0x6b4f7a, 0xc48a3a, 0x24272b, 0x6d7a84, 0xa8b8c8, 0x7a2f2f, 0xd16b8a, 0x4a8a7a, 0xe0b84a];
export const PANTS = [0x2a2f3a, 0x3b3530, 0x1d1f22, 0x4a5568, 0x6b5a45, 0x2e3d52, 0x5a3a2e];
