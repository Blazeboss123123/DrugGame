import * as THREE from 'three';
import type { Services } from '../core/Services';
import { ownMaterial, setHighlight, type Interactable } from '../interaction/Interactable';
import { Container, type Stack } from '../inventory/Inventory';
import { FAMILIES, ITEMS, QUALITY_NAMES, STRAIN_EFFECT, mixEffects, type Family, type Quality, type Variant } from '../products/Catalog';

/**
 * Production equipment. Every station is a physical object in the garage with a collider, a status
 * light and a state that advances with game time (so sleeping lets work finish).
 */

const tmp = new THREE.Vector3();

export interface StationSave {
  kind: string;
  slot: number;
  data: Record<string, unknown>;
}

function mat(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...opts });
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = true;
  o.receiveShadow = true;
  return o;
}

/** Common base: a group placed in the world, a collider, a status light. */
abstract class Station implements Interactable {
  readonly group = new THREE.Group();
  readonly highlight: THREE.Mesh[] = [];
  readonly maxDistance = 2.4;
  protected light: THREE.MeshStandardMaterial;
  abstract readonly kind: string;
  site = 'home';

  constructor(
    protected svc: Services,
    readonly id: string,
    readonly slot: number,
    pos: THREE.Vector3,
    halfExtents: [number, number, number],
    yaw = 0,
  ) {
    this.group.position.copy(pos);
    this.group.rotation.y = yaw;
    svc.scene.add(this.group);
    const c = svc.physics.box(pos.x, pos.y + halfExtents[1], pos.z, halfExtents[0], halfExtents[1], halfExtents[2], yaw, 'metal');
    svc.physics.tag(c, { interactable: this });
    this.light = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x3ddc84, emissiveIntensity: 0.4 });
  }

  protected addLight(x: number, y: number, z: number) {
    this.group.add(mesh(new THREE.SphereGeometry(0.025, 10, 8), this.light, x, y, z));
  }

  protected setStatus(state: 'idle' | 'busy' | 'done' | 'attention') {
    const col = { idle: 0x5a6068, busy: 0xffb020, done: 0x3ddc84, attention: 0xff4a3a }[state];
    this.light.emissive.setHex(col);
    this.light.emissiveIntensity = state === 'idle' ? 0.2 : 2;
  }

  protected hl(m: THREE.Mesh) {
    ownMaterial(m);
    this.highlight.push(m);
    return m;
  }

  abstract prompt(): string | null;
  abstract interact(): void;
  abstract advance(minutes: number): void;
  abstract save(): Record<string, unknown>;
  abstract load(d: Record<string, unknown>): void;
  frame?(dt: number): void;
}

// ---------------------------------------------------------------------- grow pot
export class GrowPot extends Station {
  readonly kind = 'pot';
  soil: 0 | 1 | 2 = 0; // none / standard / rich
  seed: string | null = null;
  growth = 0;
  water = 0;
  fertilized = false;
  private soilMesh: THREE.Mesh;
  private soilMat: THREE.MeshStandardMaterial;
  private plantGroup = new THREE.Group();
  private buds: THREE.Mesh[] = [];
  private budMat = new THREE.MeshStandardMaterial({ color: 0x6d4f9e, roughness: 0.7 });
  static GROW_MINUTES = 300;
  static DRY_MINUTES = 200;

  constructor(svc: Services, id: string, slot: number, pos: THREE.Vector3) {
    super(svc, id, slot, pos, [0.32, 0.24, 0.32]);
    const pot = this.hl(mesh(new THREE.CylinderGeometry(0.32, 0.25, 0.48, 18, 1, true), mat(0xa4553a, { side: THREE.DoubleSide }), 0, 0.24, 0));
    const rim = mesh(new THREE.TorusGeometry(0.32, 0.03, 6, 20), mat(0x8e4630), 0, 0.48, 0);
    rim.rotation.x = Math.PI / 2;
    this.soilMat = mat(0x5a3d24, { roughness: 1 });
    this.soilMesh = mesh(new THREE.CircleGeometry(0.3, 18), this.soilMat, 0, 0.42, 0);
    this.soilMesh.rotation.x = -Math.PI / 2;
    const base = mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.02, 18), mat(0x6e3a26), 0, 0.01, 0);
    this.group.add(pot, rim, this.soilMesh, base, this.plantGroup);
    // Plant: stem plus leaf clusters plus buds, scaled with growth.
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 0.8, flatShading: true });
    this.plantGroup.add(mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.9, 6), mat(0x4d6b33), 0, 0.45, 0));
    for (let i = 0; i < 6; i++) {
      const a = i * 2.1;
      const y = 0.2 + i * 0.13;
      const leaf = mesh(new THREE.IcosahedronGeometry(0.12 - i * 0.008, 0), leafMat, Math.cos(a) * 0.12, y, Math.sin(a) * 0.12);
      leaf.scale.set(1.4, 0.35, 1);
      this.plantGroup.add(leaf);
      const bud = mesh(new THREE.IcosahedronGeometry(0.055, 0), this.budMat, Math.cos(a + 1) * 0.07, y + 0.06, Math.sin(a + 1) * 0.07);
      this.buds.push(bud);
      this.plantGroup.add(bud);
    }
    this.plantGroup.position.y = 0.42;
    this.addLight(0.3, 0.42, 0);
    this.refresh();
  }

  get ready() {
    return !!this.seed && this.growth >= 1;
  }

  prompt(): string | null {
    const held = this.svc.held();
    if (!this.soil) {
      if (held && (held.id === 'soil' || held.id === 'soil_rich')) return `Fill pot with ${ITEMS[held.id].name.toLowerCase()}`;
      return 'Empty grow pot (select soil in your hotbar)';
    }
    if (!this.seed) {
      if (held && ITEMS[held.id]?.kind === 'seed') return `Plant ${ITEMS[held.id].name}`;
      return 'Pot ready for a seed (select a seed)';
    }
    if (this.ready) return `Harvest ${ITEMS[this.seed].name.replace(' seed', '')}`;
    const status = `${Math.floor(this.growth * 100)}% grown · water ${Math.round(this.water * 100)}%`;
    if (held?.id === 'wateringcan') return `Water plant (${status})`;
    if (held?.id === 'fertilizer' && !this.fertilized) return `Add fertilizer (${status})`;
    return this.water <= 0 ? `Needs water! (${status})` : `Growing (${status})`;
  }

  interact(): void {
    const s = this.svc;
    const held = s.held();
    if (!this.soil) {
      if (held && (held.id === 'soil' || held.id === 'soil_rich') && s.inventory.remove(held.id, 1)) {
        this.soil = held.id === 'soil_rich' ? 2 : 1;
        s.audio.play('place', this.group.position);
      } else s.audio.play('denied');
    } else if (!this.seed) {
      if (held && ITEMS[held.id]?.kind === 'seed' && s.inventory.remove(held.id, 1)) {
        this.seed = held.id;
        this.growth = 0;
        this.water = Math.max(this.water, 0);
        s.audio.play('pickup');
        s.bus.emit('objective:signal', { id: 'plant' });
        s.ui.toast('Planted. Water it with the watering can.', 'info');
      } else s.audio.play('denied');
    } else if (this.ready) {
      this.harvest();
    } else if (held?.id === 'wateringcan') {
      this.water = 1;
      s.audio.play('paper', this.group.position);
      s.bus.emit('objective:signal', { id: 'water' });
    } else if (held?.id === 'fertilizer' && !this.fertilized && s.inventory.remove('fertilizer', 1)) {
      this.fertilized = true;
      s.audio.play('place', this.group.position);
      s.ui.toast('Fertilized: this harvest yields 4 extra units.', 'info');
    } else {
      s.ui.toast(this.water <= 0 ? 'The soil is dry. Select the watering can and press E.' : 'Still growing. Keep it watered.', 'info');
    }
    this.refresh();
  }

  /** Harvests into a container (player inventory or site storage). Returns units stored. */
  harvestTo(target: Container, quiet = false): number {
    const s = this.svc;
    if (!this.ready) return 0;
    const effect = STRAIN_EFFECT[this.seed!] ?? 'calming';
    const quality = (this.soil === 2 ? 1 : 0) as Quality;
    const { variant, isNew } = s.variants.get('nightshade', [effect], quality, s.time.day);
    const units = 8 + (this.fertilized ? 4 : 0);
    const left = target.add('prod', units, variant.key);
    if (left === units) return 0;
    if (isNew) s.bus.emit('phone:notify', { app: 'products', text: `New product discovered: ${variant.name}` });
    this.seed = null;
    this.growth = 0;
    this.soil = 0;
    this.fertilized = false;
    if (!quiet) s.audio.play('pickup', this.group.position);
    this.refresh();
    return units - left;
  }

  fill(soil: 1 | 2) {
    this.soil = soil;
    this.refresh();
  }

  plant(seed: string) {
    this.seed = seed;
    this.growth = 0;
    this.refresh();
  }

  waterNow() {
    this.water = 1;
    this.refresh();
  }

  private harvest() {
    const s = this.svc;
    const effect = STRAIN_EFFECT[this.seed!] ?? 'calming';
    const quality = (this.soil === 2 ? 1 : 0) as Quality;
    const { variant, isNew } = s.variants.get('nightshade', [effect], quality, s.time.day);
    const units = 8 + (this.fertilized ? 4 : 0);
    const left = s.inventory.add('prod', units, variant.key);
    if (left === units) {
      s.ui.toast('Your inventory is full. Make space first.', 'warn');
      return;
    }
    if (left > 0) s.ui.toast(`${left} units didn't fit in your inventory and were lost.`, 'warn');
    s.ui.toast(`Harvested ${units - left} × ${variant.name} (${QUALITY_NAMES[quality]})`, 'good');
    if (isNew) s.bus.emit('phone:notify', { app: 'products', text: `New product discovered: ${variant.name}` });
    this.seed = null;
    this.growth = 0;
    this.soil = 0;
    this.fertilized = false;
    s.audio.play('pickup');
    s.bus.emit('objective:signal', { id: 'harvest' });
    this.refresh();
  }

  advance(minutes: number): void {
    if (!this.seed || this.growth >= 1) return;
    // Growth only happens while the soil is wet.
    const wetMinutes = Math.min(minutes, this.water * GrowPot.DRY_MINUTES);
    this.water = Math.max(0, this.water - minutes / GrowPot.DRY_MINUTES);
    const before = this.growth;
    this.growth = Math.min(1, this.growth + wetMinutes / GrowPot.GROW_MINUTES);
    if (before < 1 && this.growth >= 1) this.svc.bus.emit('phone:notify', { app: 'messages', text: 'A plant in your garage is ready to harvest.' });
    this.refresh();
  }

  growNow() {
    if (this.seed) {
      this.growth = 1;
      this.refresh();
    }
  }

  private refresh() {
    this.soilMesh.visible = this.soil > 0;
    this.soilMat.color.setHex(this.soil === 2 ? 0x2e2014 : 0x5a3d24).multiplyScalar(this.water > 0 ? 0.55 : 1);
    this.plantGroup.visible = !!this.seed;
    const g = Math.max(0.08, this.growth);
    this.plantGroup.scale.set(0.5 + g * 0.6, g, 0.5 + g * 0.6);
    this.budMat.color.set(FAMILIES.nightshade.color);
    if (this.seed) this.budMat.color.set(ITEMS[this.seed].color);
    for (const b of this.buds) b.visible = this.growth > 0.6;
    this.setStatus(!this.soil ? 'idle' : !this.seed ? 'idle' : this.ready ? 'done' : this.water <= 0 ? 'attention' : 'busy');
  }

  save() {
    return { soil: this.soil, seed: this.seed, growth: this.growth, water: this.water, fert: this.fertilized };
  }

  load(d: Record<string, unknown>) {
    this.soil = (d.soil as 0 | 1 | 2) ?? 0;
    this.seed = (d.seed as string) ?? null;
    this.growth = (d.growth as number) ?? 0;
    this.water = (d.water as number) ?? 0;
    this.fertilized = !!d.fert;
    this.refresh();
  }
}

// ---------------------------------------------------------------------- timed job stations
export interface Job {
  remaining: number;
  total: number;
  output: Stack;
  label: string;
}

/** A station that runs one job at a time and holds its output until collected. */
abstract class JobStation extends Station {
  job: Job | null = null;
  output: Stack | null = null;

  start(job: Job) {
    this.job = job;
    this.setStatus('busy');
    this.svc.audio.play('switch');
  }

  advance(minutes: number) {
    if (!this.job) return;
    this.job.remaining -= minutes;
    if (this.job.remaining <= 0) {
      this.output = this.job.output;
      this.svc.bus.emit('phone:notify', { app: 'messages', text: `${this.title} finished: ${this.job.label}` });
      this.job = null;
      this.setStatus('done');
    }
  }

  finishNow() {
    if (this.job) this.advance(this.job.remaining + 1);
  }

  abstract readonly title: string;

  get progress() {
    return this.job ? 1 - this.job.remaining / this.job.total : 0;
  }

  /** Moves finished output into a container. Returns true if anything moved. */
  collectTo(target: Container): boolean {
    if (!this.output) return false;
    const o = this.output;
    const left = target.add(o.id, o.qty, o.v);
    if (left === o.qty) return false;
    this.output = left > 0 ? { ...o, qty: left } : null;
    if (!this.output) this.setStatus('idle');
    return true;
  }

  protected collect(): boolean {
    if (!this.output) return false;
    const o = this.output;
    const left = this.svc.inventory.add(o.id, o.qty, o.v);
    if (left === o.qty) {
      this.svc.ui.toast('Your inventory is full.', 'warn');
      return true;
    }
    this.output = left > 0 ? { ...o, qty: left } : null;
    this.svc.audio.play('pickup');
    if (!this.output) this.setStatus('idle');
    return true;
  }

  prompt(): string | null {
    if (this.output) return `Collect ${this.output.qty} × ${this.svc.ui.itemName(this.output)}`;
    if (this.job) return `${this.title}: ${this.job.label} · ${Math.floor(this.progress * 100)}%`;
    return `Use ${this.title.toLowerCase()}`;
  }

  interact(): void {
    if (this.collect()) return;
    if (this.job) {
      this.svc.ui.toast(`${this.job.label}: about ${Math.ceil(this.job.remaining)} game minutes left.`, 'info');
      return;
    }
    this.open();
  }

  protected abstract open(): void;

  save() {
    return { job: this.job, output: this.output };
  }

  load(d: Record<string, unknown>) {
    this.job = (d.job as Job) ?? null;
    this.output = (d.output as Stack) ?? null;
    this.setStatus(this.output ? 'done' : this.job ? 'busy' : 'idle');
  }
}

export class MixingStation extends JobStation {
  readonly kind = 'mixer';
  readonly title = 'Mixing station';
  private bowl: THREE.Mesh;
  private spin = 0;
  constructor(svc: Services, id: string, slot: number, pos: THREE.Vector3, yaw = 0) {
    super(svc, id, slot, pos, [0.42, 0.5, 0.55], yaw);
    const steel = mat(0x9aa1a8, { metalness: 0.7, roughness: 0.35 });
    const top = this.hl(mesh(new THREE.BoxGeometry(0.84, 0.05, 1.1), steel, 0, 0.9, 0));
    for (const [x, z] of [
      [-0.37, -0.5],
      [0.37, -0.5],
      [-0.37, 0.5],
      [0.37, 0.5],
    ])
      this.group.add(mesh(new THREE.BoxGeometry(0.05, 0.9, 0.05), steel, x, 0.45, z));
    this.group.add(mesh(new THREE.BoxGeometry(0.8, 0.03, 1.05), steel, 0, 0.2, 0));
    const base = mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.12, 20), mat(0x2f6b7a), 0, 0.98, -0.1);
    this.bowl = mesh(new THREE.CylinderGeometry(0.26, 0.16, 0.2, 20, 1, true), mat(0xd9dde0, { metalness: 0.6, roughness: 0.25, side: THREE.DoubleSide }), 0, 1.14, -0.1);
    const screen = mesh(new THREE.BoxGeometry(0.3, 0.2, 0.03), mat(0x1a1d21), 0, 1.15, 0.42);
    screen.rotation.x = -0.5;
    const face = mesh(new THREE.PlaneGeometry(0.26, 0.16), new THREE.MeshStandardMaterial({ color: 0x0b1a22, emissive: 0x3d86a8, emissiveIntensity: 0.8 }), 0, 1.152, 0.437);
    face.rotation.x = -0.5;
    face.rotation.y = 0;
    this.group.add(top, base, this.bowl, screen);
    this.group.add(face);
    // The face plane must face the player standing in front (+x in local after yaw); keep it simple.
    face.rotation.set(-0.5, 0, 0);
    face.position.z += 0.001;
    this.addLight(0.3, 0.94, 0.45);
    this.setStatus('idle');
  }
  protected open() {
    this.svc.ui.panels.openMixer(this);
  }
  /** Starts mixing `n` units of a variant with a mixer (inputs already removed by the caller). */
  startMix(v: Variant, mixer: string, n: number) {
    const next = mixEffects(v.effects, mixer);
    const res = this.svc.variants.get(v.family, next, v.quality, this.svc.time.day);
    this.start({ remaining: n * 2, total: n * 2, output: { id: 'prod', qty: n, v: res.variant.key }, label: `${n} × ${res.variant.name}` });
    return res;
  }
  override frame(dt: number) {
    if (this.job) {
      this.spin += dt * 6;
      this.bowl.rotation.y = this.spin;
    }
  }
}

export class PackagingBench extends Station {
  readonly kind = 'packager';
  constructor(svc: Services, id: string, slot: number, pos: THREE.Vector3, yaw = 0) {
    super(svc, id, slot, pos, [0.42, 0.45, 0.6], yaw);
    const wood = mat(0x8a6a4a, { roughness: 0.8 });
    const top = this.hl(mesh(new THREE.BoxGeometry(0.84, 0.06, 1.2), wood, 0, 0.88, 0));
    for (const [x, z] of [
      [-0.36, -0.54],
      [0.36, -0.54],
      [-0.36, 0.54],
      [0.36, 0.54],
    ])
      this.group.add(mesh(new THREE.BoxGeometry(0.06, 0.88, 0.06), wood, x, 0.44, z));
    const scale = mesh(new THREE.BoxGeometry(0.26, 0.05, 0.26), mat(0x2a2d31), 0, 0.94, -0.3);
    const plate = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.01, 16), mat(0xc9cdd1, { metalness: 0.8 }), 0, 0.97, -0.3);
    const bin = mesh(new THREE.BoxGeometry(0.3, 0.14, 0.22), mat(0xd9e6ea, { transparent: true, opacity: 0.6 }), 0, 0.98, 0.25);
    this.group.add(top, scale, plate, bin);
    for (let i = 0; i < 5; i++) {
      const bag = mesh(new THREE.BoxGeometry(0.08, 0.01, 0.1), mat(0xe8f0f2, { transparent: true, opacity: 0.8 }), -0.05 + i * 0.03, 1.0 + i * 0.004, 0.25 + (i % 2) * 0.02);
      this.group.add(bag);
    }
    this.addLight(0.3, 0.92, 0.5);
    this.setStatus('idle');
  }
  prompt() {
    return 'Package product';
  }
  interact() {
    this.svc.ui.panels.openPackager();
  }
  advance() {}
  save() {
    return {};
  }
  load() {}
}

export class Kettle extends JobStation {
  readonly kind = 'kettle';
  readonly title = 'Dreamdust kettle';
  private glow: THREE.MeshStandardMaterial;
  private steam: THREE.Mesh;
  constructor(svc: Services, id: string, slot: number, pos: THREE.Vector3, yaw = 0) {
    super(svc, id, slot, pos, [0.45, 0.6, 0.45], yaw);
    const dark = mat(0x2b3137, { metalness: 0.6, roughness: 0.4 });
    const frame = mat(0x3d5a7a, { metalness: 0.4 });
    this.group.add(mesh(new THREE.BoxGeometry(0.8, 0.5, 0.8), frame, 0, 0.25, 0));
    this.glow = new THREE.MeshStandardMaterial({ color: 0x331100, emissive: 0xff6a1a, emissiveIntensity: 0 });
    const ring = mesh(new THREE.TorusGeometry(0.3, 0.04, 8, 24), this.glow, 0, 0.52, 0);
    ring.rotation.x = Math.PI / 2;
    const pot = this.hl(mesh(new THREE.CylinderGeometry(0.34, 0.28, 0.5, 22), dark, 0, 0.8, 0));
    const lip = mesh(new THREE.TorusGeometry(0.34, 0.03, 6, 22), dark, 0, 1.05, 0);
    lip.rotation.x = Math.PI / 2;
    this.steam = mesh(new THREE.SphereGeometry(0.22, 10, 8), new THREE.MeshBasicMaterial({ color: 0xe8e4f5, transparent: true, opacity: 0 }), 0, 1.3, 0);
    this.steam.castShadow = false;
    this.group.add(ring, pot, lip, this.steam);
    this.addLight(0.36, 0.45, 0.4);
    this.setStatus('idle');
  }
  protected open() {
    this.svc.ui.panels.openKettle(this);
  }
  override frame(dt: number) {
    this.glow.emissiveIntensity = this.job ? 1.6 + Math.sin(performance.now() / 200) * 0.3 : 0;
    const m = this.steam.material as THREE.MeshBasicMaterial;
    m.opacity = this.job ? 0.25 + Math.sin(performance.now() / 500) * 0.1 : 0;
    this.steam.position.y = 1.3 + ((performance.now() / 1500) % 1) * 0.3;
    void dt;
  }
}

export class NeonPress extends JobStation {
  readonly kind = 'press';
  readonly title = 'Neon press';
  private ram: THREE.Mesh;
  constructor(svc: Services, id: string, slot: number, pos: THREE.Vector3, yaw = 0) {
    super(svc, id, slot, pos, [0.4, 0.8, 0.4], yaw);
    const body = mat(0x2f6b7a, { metalness: 0.4 });
    const steel = mat(0xb9bec2, { metalness: 0.8, roughness: 0.3 });
    const base = this.hl(mesh(new THREE.BoxGeometry(0.8, 0.7, 0.8), body, 0, 0.35, 0));
    for (const [x, z] of [
      [-0.3, -0.3],
      [0.3, -0.3],
      [-0.3, 0.3],
      [0.3, 0.3],
    ])
      this.group.add(mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 8), steel, x, 1.1, z));
    this.group.add(mesh(new THREE.BoxGeometry(0.8, 0.12, 0.8), body, 0, 1.5, 0));
    this.ram = mesh(new THREE.BoxGeometry(0.5, 0.1, 0.5), steel, 0, 1.2, 0);
    this.group.add(base, this.ram);
    this.addLight(0.36, 0.6, 0.41);
    this.setStatus('idle');
  }
  protected open() {
    this.svc.ui.panels.openPress(this);
  }
  override frame() {
    this.ram.position.y = this.job ? 0.95 + Math.abs(Math.sin(performance.now() / 400)) * 0.3 : 1.2;
  }
}

/** Storage that opens the two-pane inventory screen. */
export class StorageBox implements Interactable {
  readonly highlight: THREE.Mesh[] = [];
  readonly maxDistance = 2.4;
  constructor(
    private svc: Services,
    readonly id: string,
    readonly container: Container,
    private label: string,
    highlight: THREE.Mesh[] = [],
  ) {
    this.highlight = highlight;
  }
  prompt() {
    const n = this.container.slots.filter(Boolean).length;
    return `Open ${this.label}${n ? ` (${n} stacks)` : ''}`;
  }
  interact() {
    this.svc.audio.play('paper');
    this.svc.ui.openInventory(this.container, this.label);
  }
}

// ---------------------------------------------------------------------- sites
export type Slot = [number, number, number]; // local x, z, yaw
export interface SiteLayout {
  pots: [number, number][];
  mixer: Slot[];
  packager: Slot[];
  kettle: Slot[];
  press: Slot[];
  /** Where staff stand when idle (local x, z). */
  rest: [number, number];
  /** Where the storage shelf is (local x, z) so staff walk to it. */
  storage: [number, number];
}

export const HOME_LAYOUT: SiteLayout = {
  pots: [
    [2.6, -2.7],
    [2.6, -1.75],
    [3.5, -2.7],
    [3.5, -1.75],
    [2.6, -0.8],
    [3.5, -0.8],
  ],
  mixer: [[5.48, -2.95, -Math.PI / 2]],
  packager: [[5.48, -1.35, -Math.PI / 2]],
  kettle: [[5.45, 0.35, -Math.PI / 2]],
  press: [[5.45, 1.6, -Math.PI / 2]],
  rest: [3.0, 1.5],
  storage: [3.65, -4.0],
};

const STATION_KINDS = ['mixer', 'packager', 'kettle', 'press'] as const;

/** One property's production floor: stations in fixed slots, a storage shelf and a delivery box. */
export class Site {
  readonly stations: Station[] = [];
  readonly storage: Container;
  readonly delivery: Container;
  delivered = false;

  constructor(
    private svc: Services,
    readonly id: string,
    readonly name: string,
    readonly L: (x: number, y: number, z: number) => THREE.Vector3,
    readonly layout: SiteLayout,
    storageSize: number,
  ) {
    this.storage = new Container(`${name} storage`, storageSize);
    this.delivery = new Container(`${name} deliveries`, 16);
  }

  get pots() {
    return this.stations.filter((s): s is GrowPot => s instanceof GrowPot);
  }

  count(kind: string) {
    return this.stations.filter((s) => s.kind === kind).length;
  }

  capacity(kind: string) {
    if (kind === 'pot') return this.layout.pots.length;
    return (this.layout as unknown as Record<string, Slot[]>)[kind]?.length ?? 0;
  }

  has(kind: string) {
    return this.count(kind) > 0;
  }

  find<T extends Station>(kind: string): T | undefined {
    return this.stations.find((s) => s.kind === kind) as T | undefined;
  }

  all<T extends Station>(kind: string): T[] {
    return this.stations.filter((s) => s.kind === kind) as T[];
  }

  /** Installs one piece of equipment in the next free slot. */
  install(kind: string): boolean {
    const n = this.count(kind);
    if (n >= this.capacity(kind)) return false;
    let st: Station;
    if (kind === 'pot') {
      const [x, z] = this.layout.pots[n];
      st = new GrowPot(this.svc, `${this.id}:pot-${n}`, n, this.L(x, 0, z));
    } else {
      const [x, z, yaw] = (this.layout as unknown as Record<string, Slot[]>)[kind][n];
      const pos = this.L(x, 0, z);
      const id = `${this.id}:${kind}-${n}`;
      st =
        kind === 'mixer'
          ? new MixingStation(this.svc, id, n, pos, yaw)
          : kind === 'packager'
            ? new PackagingBench(this.svc, id, n, pos, yaw)
            : kind === 'kettle'
              ? new Kettle(this.svc, id, n, pos, yaw)
              : new NeonPress(this.svc, id, n, pos, yaw);
    }
    st.site = this.id;
    this.stations.push(st);
    this.svc.interaction.register(st);
    return true;
  }

  save() {
    return {
      stations: this.stations.map((s) => ({ kind: s.kind, slot: s.slot, data: s.save() })),
      storage: this.storage.toJSON(),
      delivery: this.delivery.toJSON(),
      delivered: this.delivered,
    };
  }

  load(d: ReturnType<Site['save']>) {
    for (const st of d.stations) while (this.count(st.kind) <= st.slot && this.install(st.kind));
    for (const st of d.stations) this.all(st.kind).find((x) => x.slot === st.slot)?.load(st.data);
    this.storage.load(d.storage as Stack[]);
    this.delivery.load(d.delivery as Stack[]);
    this.delivered = d.delivered;
  }
}

/** Owns every site, advances stations with game time and routes installs. */
export class Production {
  readonly sites = new Map<string, Site>();
  home!: Site;

  constructor(private svc: Services) {}

  /** Creates a site. Storage/delivery interactables are registered by the property that owns the building. */
  addSite(id: string, name: string, L: (x: number, y: number, z: number) => THREE.Vector3, layout: SiteLayout, storageSize: number): Site {
    const site = new Site(this.svc, id, name, L, layout, storageSize);
    this.sites.set(id, site);
    if (id === 'home') this.home = site;
    return site;
  }

  /** Home garage setup: starting equipment plus shelf and porch box interactables. */
  init(L: (x: number, y: number, z: number) => THREE.Vector3, shelfMeshes: THREE.Mesh[], porchMeshes: THREE.Mesh[], shelfCollider: () => import('../physics/Physics').Collider, porchCollider: () => import('../physics/Physics').Collider) {
    const home = this.addSite('home', '14 Larch Street', L, HOME_LAYOUT, 20);
    home.install('pot');
    home.install('pot');
    home.install('mixer');
    home.install('packager');
    const shelf = new StorageBox(this.svc, 'shelf', home.storage, 'storage shelf', shelfMeshes);
    this.svc.physics.tag(shelfCollider(), { interactable: shelf });
    this.svc.interaction.register(shelf);
    const porch = new StorageBox(this.svc, 'porch-box', home.delivery, 'delivery box', porchMeshes);
    this.svc.physics.tag(porchCollider(), { interactable: porch });
    this.svc.interaction.register(porch);
    home.delivery.onChange(() => {
      if (home.delivery.slots.every((s) => !s) && home.delivered) this.svc.bus.emit('objective:signal', { id: 'collect' });
    });
  }

  // Home-site shortcuts (kept for the tutorial, market and self-test).
  get shelf() {
    return this.home.storage;
  }
  get porch() {
    return this.home.delivery;
  }
  get pots() {
    return this.home.pots;
  }
  get delivered() {
    return this.home.delivered;
  }
  set delivered(v: boolean) {
    this.home.delivered = v;
  }
  has(kind: string, site = 'home') {
    return this.sites.get(site)?.has(kind) ?? false;
  }
  find<T extends Station>(kind: string, site = 'home'): T | undefined {
    return this.sites.get(site)?.find<T>(kind);
  }
  install(kind: string, site = 'home'): boolean {
    return this.sites.get(site)?.install(kind) ?? false;
  }
  addPot(site = 'home') {
    return this.install('pot', site);
  }

  advance(minutes: number) {
    for (const site of this.sites.values()) for (const s of site.stations) s.advance(minutes);
  }

  frame(dt: number) {
    for (const site of this.sites.values()) for (const s of site.stations) s.frame?.(dt);
  }

  growAll() {
    for (const site of this.sites.values())
      for (const s of site.stations) {
        if (s instanceof GrowPot) s.growNow();
        if (s instanceof JobStation) s.finishNow();
      }
  }

  save() {
    return { sites: [...this.sites].map(([id, s]) => [id, s.save()] as [string, ReturnType<Site['save']>]) };
  }

  load(d: (ReturnType<Production['save']> & { stations?: { kind: string; slot: number; data: Record<string, unknown> }[]; shelf?: unknown; porch?: unknown; delivered?: boolean }) | undefined) {
    if (!d) return;
    if (d.sites) {
      for (const [id, sd] of d.sites) this.sites.get(id)?.load(sd);
    } else if (d.stations) {
      // Version 2 saves: home garage only.
      this.home.load({ stations: d.stations, storage: d.shelf as never, delivery: d.porch as never, delivered: !!d.delivered });
    }
  }
}

export { JobStation, Station, setHighlight, tmp, STATION_KINDS };
export type FamilyT = Family;
