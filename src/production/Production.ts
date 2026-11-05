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
  /** Local placement inside the site (for saves and moving). */
  lx = 0;
  lz = 0;
  lyaw = 0;
  readonly collider: import('../physics/Physics').Collider;
  readonly half: [number, number, number];

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
    this.half = halfExtents;
    const c = svc.physics.box(pos.x, pos.y + halfExtents[1], pos.z, halfExtents[0], halfExtents[1], halfExtents[2], yaw, 'metal');
    svc.physics.tag(c, { interactable: this });
    this.collider = c;
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
  /** True when the station is empty and can be picked up to move. */
  canPickUp(): boolean {
    return true;
  }
  secondaryPrompt(): string | null {
    return this.canPickUp() ? 'Pick up to move' : null;
  }
  secondary() {
    this.svc.production.pickUp(this);
  }
  dispose() {
    this.svc.scene.remove(this.group);
    this.svc.physics.world.removeCollider(this.collider, false);
    const i = this.svc.interaction.items.indexOf(this);
    if (i >= 0) this.svc.interaction.items.splice(i, 1);
  }
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

  override canPickUp() {
    return !this.soil && !this.seed;
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
    const units = 8 + (this.fertilized ? 4 : 0) + (s.upgrades?.has('yield') ? 4 : 0);
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
    const units = 8 + (this.fertilized ? 4 : 0) + (s.upgrades?.has('yield') ? 4 : 0);
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
    const lamp = this.svc.production.sites.get(this.site)?.lampBoost(this.group.position) ?? 1;
    const fast = this.svc.upgrades?.has('fastgrow') ? 1 / 0.65 : 1;
    this.growth = Math.min(1, this.growth + (wetMinutes * lamp * fast) / GrowPot.GROW_MINUTES);
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

  override canPickUp() {
    return !this.job && !this.output;
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
    const mins = n * (this.svc.upgrades?.has('mixer2') ? 1 : 2);
    this.start({ remaining: mins, total: mins, output: { id: 'prod', qty: n, v: res.variant.key }, label: `${n} × ${res.variant.name}` });
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

export class DryingRack extends JobStation {
  readonly kind = 'rack';
  readonly title = 'Drying rack';
  private trays: THREE.Mesh[] = [];
  constructor(svc: Services, id: string, slot: number, pos: THREE.Vector3, yaw = 0) {
    super(svc, id, slot, pos, [0.5, 0.75, 0.3], yaw);
    const wood = mat(0xb08a5a, { roughness: 0.8 });
    for (const x of [-0.48, 0.48]) for (const z of [-0.27, 0.27]) this.group.add(mesh(new THREE.BoxGeometry(0.05, 1.5, 0.05), wood, x, 0.75, z));
    for (let i = 0; i < 4; i++) {
      const tray = mesh(new THREE.BoxGeometry(0.95, 0.03, 0.55), mat(0xe8e2d0, { roughness: 0.9 }), 0, 0.25 + i * 0.36, 0);
      this.group.add(tray);
      const leaves = mesh(new THREE.BoxGeometry(0.8, 0.05, 0.42), mat(0x5c8a3e, { roughness: 1 }), 0, 0.29 + i * 0.36, 0);
      leaves.visible = false;
      this.group.add(leaves);
      this.trays.push(leaves);
    }
    this.highlight.push(this.hl(mesh(new THREE.BoxGeometry(1.0, 0.04, 0.6), wood, 0, 1.5, 0)));
    this.addLight(0.45, 1.45, 0.3);
    this.setStatus('idle');
  }
  protected open() {
    this.svc.ui.panels.openRack(this);
  }
  override frame() {
    const on = !!this.job || !!this.output;
    this.trays.forEach((t, i) => (t.visible = on && i < 3));
  }
}

export class GrowLamp extends Station {
  readonly kind = 'lamp';
  on = true;
  private bulb: THREE.MeshStandardMaterial;
  private glow: THREE.PointLight;
  constructor(svc: Services, id: string, slot: number, pos: THREE.Vector3, yaw = 0) {
    super(svc, id, slot, pos, [0.22, 0.9, 0.22], yaw);
    const steel = mat(0x3a3f46, { metalness: 0.6, roughness: 0.4 });
    this.group.add(mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.05, 16), steel, 0, 0.025, 0));
    this.group.add(mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.8, 8), steel, 0, 0.9, 0));
    const head = this.hl(mesh(new THREE.BoxGeometry(0.7, 0.06, 0.35), steel, 0, 1.82, 0));
    this.bulb = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xd080ff, emissiveIntensity: 3 });
    const panel = mesh(new THREE.BoxGeometry(0.62, 0.02, 0.28), this.bulb, 0, 1.785, 0);
    panel.castShadow = false;
    this.group.add(head, panel);
    this.glow = new THREE.PointLight(0xd08aff, 6, 4, 2);
    this.glow.position.set(0, 1.6, 0);
    this.group.add(this.glow);
  }
  prompt() {
    return this.on ? 'Switch grow lamp off' : 'Switch grow lamp on';
  }
  interact() {
    this.on = !this.on;
    this.bulb.emissiveIntensity = this.on ? 3 : 0;
    this.glow.intensity = this.on ? 6 : 0;
    this.svc.audio.play('switch');
  }
  advance() {}
  save() {
    return { on: this.on };
  }
  load(d: Record<string, unknown>) {
    const on = d.on !== false;
    if (on !== this.on) {
      this.on = on;
      this.bulb.emissiveIntensity = on ? 3 : 0;
      this.glow.intensity = on ? 6 : 0;
    }
  }
}

export class StorageRack extends Station {
  readonly kind = 'storage';
  readonly box: Container;
  constructor(svc: Services, id: string, slot: number, pos: THREE.Vector3, yaw = 0) {
    super(svc, id, slot, pos, [0.6, 0.9, 0.3], yaw);
    this.box = new Container('Storage rack', 12 + (svc.upgrades?.has('shelves') ? 6 : 0));
    const steel = mat(0x5a6068, { metalness: 0.5, roughness: 0.5 });
    for (const x of [-0.58, 0.58]) for (const z of [-0.27, 0.27]) this.group.add(mesh(new THREE.BoxGeometry(0.04, 1.8, 0.04), steel, x, 0.9, z));
    for (let i = 0; i < 4; i++) this.group.add(mesh(new THREE.BoxGeometry(1.2, 0.03, 0.58), steel, 0, 0.1 + i * 0.55, 0));
    this.highlight.push(this.hl(mesh(new THREE.BoxGeometry(1.2, 0.03, 0.58), steel, 0, 1.75, 0)));
    // A few boxes so it never looks empty.
    const card = mat(0xb58b5c, { roughness: 0.9 });
    for (let i = 0; i < 3; i++) this.group.add(mesh(new THREE.BoxGeometry(0.34, 0.26, 0.3), card, -0.35 + i * 0.36, 0.25 + (i % 2) * 0.55, 0));
  }
  prompt() {
    const n = this.box.slots.filter(Boolean).length;
    return `Open storage rack${n ? ` (${n} stacks)` : ''}`;
  }
  interact() {
    this.svc.audio.play('paper');
    this.svc.ui.openInventory(this.box, 'Storage rack');
  }
  override canPickUp() {
    return this.box.slots.every((s) => !s);
  }
  advance() {}
  save() {
    return { box: this.box.toJSON() };
  }
  load(d: Record<string, unknown>) {
    this.box.load(d.box as Stack[]);
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
export interface Zone {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Upgrade that must be owned for this zone to be usable. */
  needs?: string;
}
export interface SiteLayout {
  pots: [number, number][];
  mixer: Slot[];
  packager: Slot[];
  kettle: Slot[];
  press: Slot[];
  rest: [number, number];
  storage: [number, number];
  /** Floor areas where equipment can be placed (local coordinates). */
  zones?: Zone[];
  /** Areas that must stay clear (door swings, walkways). */
  keepClear?: Zone[];
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
  zones: [
    { x0: 2.15, z0: -4.3, x1: 5.9, z1: 4.6 },
    { x0: -3.85, z0: -4.15, x1: 1.85, z1: -1.15, needs: 'home_back' },
    { x0: -5.15, z0: -0.85, x1: 1.85, z1: 4.85, needs: 'home_front' },
  ],
  keepClear: [
    { x0: 2.0, z0: 2.3, x1: 3.2, z1: 3.8 },
    { x0: 2.3, z0: 4.0, x1: 5.7, z1: 5.2 },
    { x0: -3.4, z0: 3.6, x1: -1.6, z1: 5.2 },
    { x0: -3.9, z0: -1.4, x1: -2.4, z1: 0.3 },
  ],
};

export const FOOTPRINT: Record<string, [number, number]> = {
  pot: [0.36, 0.36],
  mixer: [0.45, 0.6],
  packager: [0.45, 0.65],
  kettle: [0.45, 0.45],
  press: [0.42, 0.42],
  rack: [0.52, 0.32],
  lamp: [0.26, 0.26],
  storage: [0.62, 0.32],
};
export const PLACEABLE = Object.keys(FOOTPRINT);

/** One property's production floor: stations placed freely, a storage shelf and a delivery box. */
export class Site {
  readonly stations: Station[] = [];
  readonly storage: Container;
  readonly delivery: Container;
  delivered = false;
  private n = 0;

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

  get origin() {
    return this.L(0, 0, 0);
  }

  get pots() {
    return this.stations.filter((s): s is GrowPot => s instanceof GrowPot);
  }

  count(kind: string) {
    return this.stations.filter((s) => s.kind === kind).length;
  }

  /** Legacy fixed-slot capacity (used for included equipment). */
  capacity(kind: string) {
    if (kind === 'pot') return this.layout.pots.length;
    return (this.layout as unknown as Record<string, Slot[] | undefined>)[kind]?.length ?? 0;
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

  /** Placement zones currently usable (upgrades unlock more of the house). */
  zones(): Zone[] {
    const base = this.layout.zones ?? [];
    return base.filter((z) => !z.needs || this.svc.upgrades?.has(z.needs));
  }

  /** Can a station of this kind stand at local (x, z) with this yaw? Returns a reason if not. */
  canPlace(kind: string, x: number, z: number, yaw: number, ignore?: Station): string | null {
    const [hx, hz] = FOOTPRINT[kind] ?? [0.4, 0.4];
    const c = Math.abs(Math.cos(yaw));
    const sn = Math.abs(Math.sin(yaw));
    const ex = hx * c + hz * sn;
    const ez = hx * sn + hz * c;
    const inside = this.zones().some((zn) => x - ex >= zn.x0 && x + ex <= zn.x1 && z - ez >= zn.z0 && z + ez <= zn.z1);
    if (!inside) return this.layout.zones?.some((zn) => zn.needs && !this.svc.upgrades?.has(zn.needs) && x > zn.x0 && x < zn.x1 && z > zn.z0 && z < zn.z1) ? 'Convert this room first (phone → Upgrades)' : 'Place it inside your workspace';
    for (const k of this.layout.keepClear ?? []) if (x + ex > k.x0 && x - ex < k.x1 && z + ez > k.z0 && z - ez < k.z1) return 'Keep doorways clear';
    for (const st of this.stations) {
      if (st === ignore) continue;
      const [ox, oz] = FOOTPRINT[st.kind] ?? [0.4, 0.4];
      const oc = Math.abs(Math.cos(st.lyaw));
      const os = Math.abs(Math.sin(st.lyaw));
      const oex = ox * oc + oz * os;
      const oez = ox * os + oz * oc;
      if (Math.abs(st.lx - x) < ex + oex + 0.05 && Math.abs(st.lz - z) < ez + oez + 0.05) return 'Too close to other equipment';
    }
    if (this.id === 'home') {
      // Fixed garage shelving and the storage shelf area.
      const sx = this.layout.storage[0];
      const sz = this.layout.storage[1];
      if (Math.abs(x - sx) < 1.3 + ex && Math.abs(z - sz) < 0.4 + ez) return 'Too close to the shelves';
    }
    return null;
  }

  /** Builds a station at local (x, z, yaw). */
  place(kind: string, x: number, z: number, yaw: number): Station | null {
    const pos = this.L(x, 0, z);
    const id = `${this.id}:${kind}-${this.n++}`;
    const slot = this.count(kind);
    let st: Station;
    switch (kind) {
      case 'pot':
        st = new GrowPot(this.svc, id, slot, pos);
        break;
      case 'mixer':
        st = new MixingStation(this.svc, id, slot, pos, yaw);
        break;
      case 'packager':
        st = new PackagingBench(this.svc, id, slot, pos, yaw);
        break;
      case 'kettle':
        st = new Kettle(this.svc, id, slot, pos, yaw);
        break;
      case 'press':
        st = new NeonPress(this.svc, id, slot, pos, yaw);
        break;
      case 'rack':
        st = new DryingRack(this.svc, id, slot, pos, yaw);
        break;
      case 'lamp':
        st = new GrowLamp(this.svc, id, slot, pos, yaw);
        break;
      case 'storage':
        st = new StorageRack(this.svc, id, slot, pos, yaw);
        break;
      default:
        return null;
    }
    st.site = this.id;
    st.lx = x;
    st.lz = z;
    st.lyaw = yaw;
    this.stations.push(st);
    this.svc.interaction.register(st);
    return st;
  }

  /** Installs equipment in the next free fixed slot (included equipment and staff-friendly defaults). */
  install(kind: string): boolean {
    const n = this.count(kind);
    if (kind === 'pot') {
      const free = this.layout.pots.find(([x, z]) => !this.canPlace('pot', x, z, 0)) ?? this.layout.pots.find(([x, z]) => !this.stations.some((s) => Math.hypot(s.lx - x, s.lz - z) < 0.5));
      if (!free) return false;
      return !!this.place('pot', free[0], free[1], 0);
    }
    const slots = (this.layout as unknown as Record<string, Slot[] | undefined>)[kind] ?? [];
    const slot = slots.find(([x, z]) => !this.stations.some((s) => Math.hypot(s.lx - x, s.lz - z) < 0.6)) ?? slots[n];
    if (!slot) return false;
    return !!this.place(kind, slot[0], slot[1], slot[2]);
  }

  remove(st: Station) {
    const i = this.stations.indexOf(st);
    if (i >= 0) this.stations.splice(i, 1);
    st.dispose();
  }

  /** Growth multiplier from switched-on grow lamps near a world position. */
  lampBoost(p: THREE.Vector3): number {
    for (const st of this.stations) if (st instanceof GrowLamp && st.on && st.group.position.distanceTo(p) < 2.5) return 1.6;
    return 1;
  }

  /** Extra shelf space from the shelving upgrade. */
  grow(extra: number) {
    for (let i = 0; i < extra; i++) (this.storage.slots as (Stack | null)[]).push(null);
    this.storage.changed();
  }

  save() {
    return {
      stations: this.stations.map((s) => ({ kind: s.kind, slot: s.slot, x: s.lx, z: s.lz, yaw: s.lyaw, data: s.save() })),
      storage: this.storage.toJSON(),
      delivery: this.delivery.toJSON(),
      delivered: this.delivered,
    };
  }

  load(d: { stations: { kind: string; slot: number; x?: number; z?: number; yaw?: number; data: Record<string, unknown> }[]; storage: unknown; delivery: unknown; delivered: boolean }) {
    for (const st of [...this.stations]) this.remove(st);
    for (const st of d.stations) {
      const made = st.x !== undefined ? this.place(st.kind, st.x, st.z!, st.yaw ?? 0) : this.install(st.kind) ? this.stations[this.stations.length - 1] : null;
      made?.load(st.data);
    }
    while (this.storage.slots.length < ((d.storage as unknown[]) ?? []).length) (this.storage.slots as (Stack | null)[]).push(null);
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

  addSite(id: string, name: string, L: (x: number, y: number, z: number) => THREE.Vector3, layout: SiteLayout, storageSize: number): Site {
    const site = new Site(this.svc, id, name, L, layout, storageSize);
    this.sites.set(id, site);
    if (id === 'home') this.home = site;
    return site;
  }

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

  /** Puts an empty station back into the player's inventory so it can be placed elsewhere. */
  pickUp(st: Station) {
    if (!st.canPickUp()) {
      this.svc.ui.toast('Empty it first (finish or collect what is inside).', 'warn');
      return;
    }
    if (this.svc.inventory.add(st.kind, 1) > 0) {
      this.svc.ui.toast('No room in your inventory.', 'warn');
      return;
    }
    this.sites.get(st.site)?.remove(st);
    this.svc.audio.play('pickup');
    this.svc.ui.toast('Picked up. Select it in your hotbar and press E to place it.', 'info');
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
      this.home.load({ stations: d.stations, storage: d.shelf as never, delivery: d.porch as never, delivered: !!d.delivered });
    }
  }
}

export { JobStation, Station, setHighlight, tmp };
export type FamilyT = Family;
