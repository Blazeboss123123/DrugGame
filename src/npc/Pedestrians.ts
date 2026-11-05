import * as THREE from 'three';
import { Rng } from '../core/math';
import type { Services } from '../core/Services';
import type { Particles } from '../fx/Particles';
import type { Interactable } from '../interaction/Interactable';
import { RAPIER, type Collider, type RigidBody } from '../physics/Physics';
import { EFFECTS } from '../products/Catalog';
import { GANGS, GANG_IDS, type GangId } from '../business/Rivals';
import { CORE, NEIGHBOURHOODS, inHood } from './Neighbourhoods';
import { ROAD, X_LINES, Z_LINES, bridgeSpan, districtAt, inGridX, inGridZ, nearestLine } from '../world/CityPlan';
import type { Heightmap } from '../world/Heightmap';
import { HAIRS, HumanoidRenderer, PANTS, SHIRTS, SKINS, type Pose } from './Humanoid';
import { CIVILIAN_OUTFITS, type CharLook, type CharacterInstance, type CharacterPool, type Outfit } from './Characters';

/**
 * Pedestrians walk a graph of sidewalk corners (along sidewalks, over crosswalks). Some are police,
 * some belong to rival gangs and stay on their turf. Customers visibly use what you sell them and
 * show effect-specific reactions.
 */

const OFF = 5.8;
const CIVILIANS = 100;
const OFFICERS = 12;
const PER_GANG = 6;
const DRAW_DIST = 190;
const NEAR_IN = 48;
const NEAR_OUT = 58;

interface Node {
  x: number;
  z: number;
  links: number[];
}

export type PersonMode = 'walk' | 'wait' | 'chase' | 'use';
export type PersonKind = 'civ' | 'police' | 'gang';

const FIRST = ['Marcy', 'Dev', 'Tomas', 'Ruth', 'Andre', 'Lena', 'Hector', 'Priya', 'Gus', 'Wanda', 'Jamal', 'Ines', 'Carl', 'Nora', 'Vince', 'Yuki', 'Bev', 'Otis', 'Rosa', 'Felix', 'Dana', 'Marco', 'Tess', 'Ike', 'Sal', 'June', 'Ozzie', 'Kara', 'Benny', 'Lou'];
const LAST = ['Pruitt', 'Okafor', 'Reyes', 'Kowalski', 'Haynes', 'Lindqvist', 'Moreau', 'Shah', 'Dunn', 'Castillo', 'Brandt', 'Ferreira', 'Kim', 'Novak', 'Abara', 'Quinn', 'Mercer', 'Tran'];
const GANG_NICK = ['Knuckles', 'Slim', 'Moose', 'Sparks', 'Lefty', 'Ace', 'Tiny', 'Dutch', 'Rook', 'Viper', 'Chains', 'Blue'];

export class Person implements Interactable {
  readonly highlight: THREE.Mesh[] = [];
  readonly maxDistance = 2.6;
  x = 0;
  z = 0;
  y = 0;
  yaw = 0;
  phase = 0;
  speed = 1.3;
  from = 0;
  to = 0;
  pause = 0;
  facePlayer = 0;
  mode: PersonMode = 'walk';
  body!: RigidBody;
  collider!: Collider;
  visible = false;
  nightWalker: boolean;
  lostFor = 0;
  cooldown = 0;
  /** Seconds until this officer can fire their taser again. */
  taserCd = 0;
  // Product use and effects.
  useT = -1;
  useColor = 0xffffff;
  effects: string[] = [];
  effectLeft = 0;
  private fxTimer = 0;
  afterUse: PersonMode = 'walk';
  baseShirt = 0;
  outfit: Outfit = 'Casual_Hoodie';
  look: CharLook = { skin: 0xf1c8a8, hair: 0x1c1612, hue: 0 };
  char: CharacterInstance | null = null;
  /** Index into NEIGHBOURHOODS for civilians who live somewhere (null for police and gangs). */
  hood: number | null = null;
  /** Set each frame: this person is among the closest and should use a rigged model. */
  wantChar = false;
  constructor(
    readonly index: number,
    readonly id: string,
    readonly name: string,
    readonly kind: PersonKind,
    readonly gang: GangId | null,
    private svc: Services,
    rng: Rng,
  ) {
    this.speed = kind === 'civ' ? rng.range(1.05, 1.55) : rng.range(1.2, 1.4);
    this.nightWalker = kind !== 'civ' || rng.chance(0.4);
  }
  get police() {
    return this.kind === 'police';
  }
  prompt() {
    return this.visible ? this.svc.customers.promptFor(this) : null;
  }
  interact() {
    this.svc.customers.interact(this);
  }
  tickFx(dt: number) {
    this.fxTimer -= dt;
    if (this.fxTimer > 0) return false;
    this.fxTimer = 0.22;
    return true;
  }
}

export class Pedestrians {
  readonly nodes: Node[] = [];
  readonly people: Person[] = [];
  readonly renderer: HumanoidRenderer;
  private rng = new Rng(777);
  private ctrl: ReturnType<Services['physics']['world']['createCharacterController']>;
  private pose: Pose = { x: 0, y: 0, z: 0, yaw: 0, phase: 0, swing: 0 };
  private v = new THREE.Vector3();
  private turfNodes = new Map<GangId, Set<number>>();
  /** Street-corner nodes in each neighbourhood (index matches NEIGHBOURHOODS), and the police core. */
  readonly hoodNodes: Set<number>[] = [];
  private coreNodes = new Set<number>();
  onCaught?: (by: Person) => void;
  onLost?: (by: Person) => void;
  onSpotted?: (by: Person, reason: string) => void;
  /** An officer fired a taser; `hit` says whether it connected. */
  onTased?: (by: Person, hit: boolean) => void;
  private beam: THREE.Line | null = null;
  private beamT = 0;

  constructor(
    private svc: Services,
    private hm: Heightmap,
    private fx: Particles,
    private chars: CharacterPool,
  ) {
    this.ctrl = svc.physics.world.createCharacterController(0.03);
    this.ctrl.enableAutostep(0.45, 0.2, false);
    this.ctrl.enableSnapToGround(0.5);
    this.ctrl.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.buildGraph();
    this.renderer = new HumanoidRenderer(svc.scene, CIVILIANS + OFFICERS + PER_GANG * GANG_IDS.length);
    this.spawn();
  }

  get chasing(): Person | undefined {
    return this.people.find((p) => p.mode === 'chase');
  }

  private buildGraph() {
    const idx = new Map<string, number>();
    const key = (i: number, j: number, sx: number, sz: number) => `${i},${j},${sx},${sz}`;
    for (let i = 0; i < X_LINES.length; i++)
      for (let j = 0; j < Z_LINES.length; j++)
        for (const sx of [-1, 1])
          for (const sz of [-1, 1]) {
            idx.set(key(i, j, sx, sz), this.nodes.length);
            this.nodes.push({ x: X_LINES[i] + sx * OFF, z: Z_LINES[j] + sz * OFF, links: [] });
          }
    const link = (a: string, b: string) => {
      const ia = idx.get(a)!;
      const ib = idx.get(b)!;
      this.nodes[ia].links.push(ib);
      this.nodes[ib].links.push(ia);
    };
    for (let i = 0; i < X_LINES.length; i++)
      for (let j = 0; j < Z_LINES.length; j++)
        for (const s of [-1, 1]) {
          if (j < Z_LINES.length - 1) link(key(i, j, s, 1), key(i, j + 1, s, -1));
          if (i < X_LINES.length - 1) {
            const sp = bridgeSpan(Z_LINES[j]);
            if (sp.xb < X_LINES[i] || sp.xa > X_LINES[i + 1]) link(key(i, j, 1, s), key(i + 1, j, -1, s));
          }
          link(key(i, j, s, -1), key(i, j, s, 1));
          link(key(i, j, -1, s), key(i, j, 1, s));
        }
    for (const g of GANG_IDS) {
      const set = new Set<number>();
      this.nodes.forEach((n, i) => GANGS[g].turf.includes(districtAt(n.x, n.z)) && set.add(i));
      this.turfNodes.set(g, set);
    }
    for (const h of NEIGHBOURHOODS) this.hoodNodes.push(new Set(this.nodes.map((n, i) => (inHood(h, n.x, n.z) ? i : -1)).filter((i) => i >= 0)));
    this.nodes.forEach((n, i) => inHood(CORE, n.x, n.z) && this.coreNodes.add(i));
  }

  nearestNode(x: number, z: number): number {
    let best = 0;
    let bd = Infinity;
    this.nodes.forEach((n, i) => {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  private spawn() {
    const rng = this.rng;
    const hoodRng = new Rng(9091);
    const total = NEIGHBOURHOODS.reduce((s, h) => s + h.weight, 0);
    const plan: { kind: PersonKind; gang: GangId | null }[] = [];
    for (let i = 0; i < CIVILIANS; i++) plan.push({ kind: 'civ', gang: null });
    for (let i = 0; i < OFFICERS; i++) plan.push({ kind: 'police', gang: null });
    for (const g of GANG_IDS) for (let i = 0; i < PER_GANG; i++) plan.push({ kind: 'gang', gang: g });
    plan.forEach((pl, k) => {
      const last = rng.pick(LAST);
      const name = pl.kind === 'police' ? `Officer ${last}` : pl.kind === 'gang' ? `"${rng.pick(GANG_NICK)}" ${last}` : `${rng.pick(FIRST)} ${last}`;
      const p = new Person(k, `npc-${k}`, name, pl.kind, pl.gang, this.svc, rng);
      const pool = pl.gang ? [...this.turfNodes.get(pl.gang)!] : null;
      p.from = pool?.length ? rng.pick(pool) : rng.int(0, this.nodes.length - 1);
      // Civilians live in a neighbourhood, police patrol the core (separate RNG keeps names stable).
      if (pl.kind === 'civ') {
        let r = hoodRng.next() * total;
        p.hood = NEIGHBOURHOODS.findIndex((h) => (r -= h.weight) < 0);
        if (p.hood < 0) p.hood = 0;
        p.from = hoodRng.pick([...this.hoodNodes[p.hood]]);
      } else if (pl.kind === 'police') p.from = hoodRng.pick([...this.coreNodes]);
      const n = this.nodes[p.from];
      p.to = n.links[rng.int(0, n.links.length - 1)];
      const t = rng.next();
      const b = this.nodes[p.to];
      p.x = n.x + (b.x - n.x) * t;
      p.z = n.z + (b.z - n.z) * t;
      p.y = this.surface(p.x, p.z);
      p.phase = rng.range(0, 10);
      p.body = this.svc.physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y + 0.86, p.z));
      p.collider = this.svc.physics.world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.26), p.body);
      this.svc.physics.tag(p.collider, { interactable: p, surface: 'concrete' });
      this.svc.interaction.register(p);
      this.people.push(p);
      const skin = rng.pick(SKINS);
      const hair = rng.pick(HAIRS);
      if (pl.kind === 'police') {
        p.outfit = 'Swat';
        p.look = { skin, hair, hue: 0, accent: 0x2c4a8a };
      } else if (pl.kind === 'gang') {
        p.outfit = 'Punk';
        p.look = { skin, hair, hue: 0, accent: GANGS[pl.gang!].color };
      } else {
        p.outfit = rng.pick(CIVILIAN_OUTFITS);
        p.look = { skin, hair, hue: rng.range(-0.5, 0.5), accent: undefined };
      }
      if (pl.kind === 'police') {
        p.baseShirt = 0x2c4a8a;
        this.renderer.setLook(k, { skin: rng.pick(SKINS), shirt: p.baseShirt, pants: 0x1b2233, hair: 0x141820, vest: 0x1d1f22 });
      } else if (pl.kind === 'gang') {
        const g = GANGS[pl.gang!];
        p.baseShirt = 0x24272b;
        this.renderer.setLook(k, { skin: rng.pick(SKINS), shirt: p.baseShirt, pants: rng.pick([0x1d1f22, 0x2a2f3a]), hair: g.color, vest: g.color });
      } else {
        p.baseShirt = rng.pick(SHIRTS);
        this.renderer.setLook(k, { skin: rng.pick(SKINS), shirt: p.baseShirt, pants: rng.pick(PANTS), hair: rng.pick(HAIRS) });
      }
    });
  }

  private surface(x: number, z: number): number {
    const onAsphalt = (inGridZ(z, 7) && nearestLine(X_LINES, x).dist < ROAD.asphaltHalf) || (inGridX(x, 7) && nearestLine(Z_LINES, z).dist < ROAD.asphaltHalf);
    return this.hm.get(x, z) + (onAsphalt ? 0.06 : ROAD.curb + 0.06);
  }

  sendTo(p: Person, x: number, z: number) {
    p.mode = 'wait';
    p.x = x;
    p.z = z;
    p.y = this.surface(x, z);
    p.body.setTranslation({ x, y: p.y + 0.86, z }, true);
  }

  release(p: Person) {
    if (p.mode === 'use') {
      p.afterUse = 'walk';
      return;
    }
    p.mode = 'walk';
    p.from = this.nearestNode(p.x, p.z);
    p.to = this.nodes[p.from].links[0];
  }

  /** The customer uses the product they just bought: hand to mouth, a puff, then the effects kick in. */
  consume(p: Person, color: number, effects: string[]) {
    p.afterUse = p.mode === 'wait' ? 'walk' : p.mode === 'use' ? p.afterUse : (p.mode as PersonMode);
    if (p.afterUse === 'chase') p.afterUse = 'walk';
    p.mode = 'use';
    p.useT = 0;
    p.useColor = color;
    p.effects = [...effects];
    p.facePlayer = 0;
    this.renderer.setItemColor(p.index, color);
  }

  canSee(p: Person, range: number): boolean {
    const pl = this.svc.player.position;
    const dx = pl.x - p.x;
    const dz = pl.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist > range) return false;
    const eye = { x: p.x, y: p.y + 1.6, z: p.z };
    const dir = { x: pl.x - eye.x, y: pl.y + 1.5 - eye.y, z: pl.z - eye.z };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    if (len < 0.01) return true;
    dir.x /= len;
    dir.y /= len;
    dir.z /= len;
    const hit = this.svc.physics.raycast(eye, dir, len, [p.collider], false);
    return !hit || hit.collider.handle === this.svc.player.collider.handle || hit.distance > len - 0.6;
  }

  private startChase(p: Person, reason: string) {
    p.mode = 'chase';
    p.lostFor = 0;
    this.onSpotted?.(p, reason);
  }

  /** Any officer who can see the player within `range` starts a chase. */
  alertPolice(range: number, reason: string): boolean {
    if (this.chasing) return true;
    for (const p of this.people) {
      if (!p.police || p.cooldown > 0 || p.mode === 'use') continue;
      if (this.canSee(p, range)) {
        this.startChase(p, reason);
        return true;
      }
    }
    return false;
  }

  /** Which gang (if any) has a member watching the player right now. */
  gangWitness(range: number): GangId | undefined {
    for (const p of this.people) if (p.kind === 'gang' && p.mode !== 'use' && this.canSee(p, range)) return p.gang!;
    return undefined;
  }

  endChase(p: Person, cooldown = 30) {
    p.cooldown = cooldown;
    this.release(p);
  }

  /**
   * Rigged character models are pooled, so only so many can be on screen. Hand them to the people
   * closest to the player first (release far ones before acquiring), leaving a few for staff,
   * other players and the shopkeeper. Everyone else falls back to the simple far-distance body.
   */
  private rankCharacters(player: THREE.Vector3) {
    if (!this.chars.ready) return;
    const cand: { p: Person; d2: number }[] = [];
    let mine = 0;
    for (const p of this.people) {
      p.wantChar = false;
      if (p.char) mine++;
      const dx = p.x - player.x;
      const dz = p.z - player.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < (p.char ? NEAR_OUT * NEAR_OUT : NEAR_IN * NEAR_IN)) cand.push({ p, d2 });
    }
    const others = this.chars.live.size - mine;
    const budget = Math.max(0, this.chars.max - others - 6);
    cand.sort((a, b) => a.d2 - b.d2);
    for (let i = 0; i < cand.length && i < budget; i++) cand[i].p.wantChar = true;
    for (const p of this.people)
      if (p.char && !p.wantChar) {
        this.chars.release(p.char);
        p.char = null;
      }
  }

  update(dt: number, night: number, curfew: boolean): void {
    if (this.beam) {
      this.beamT -= dt;
      (this.beam.material as THREE.LineBasicMaterial).opacity = Math.max(0, this.beamT / 0.35);
      if (this.beamT <= 0) {
        this.svc.scene.remove(this.beam);
        this.beam.geometry.dispose();
        this.beam = null;
      }
    }
    const player = this.svc.player.position;
    const rng = this.rng;
    const r = this.renderer;
    const rivals = this.svc.rivals;
    this.rankCharacters(player);
    for (let k = 0; k < this.people.length; k++) {
      const p = this.people[k];
      if (p.cooldown > 0) p.cooldown -= dt;
      const active = p.mode !== 'walk' || night < 0.5 || p.nightWalker;
      const dx0 = p.x - player.x;
      const dz0 = p.z - player.z;
      const d2 = dx0 * dx0 + dz0 * dz0;
      p.visible = active && d2 < DRAW_DIST * DRAW_DIST && !this.svc.player.hidden;
      if (!active || d2 >= DRAW_DIST * DRAW_DIST) p.visible = false;

      let moving = false;
      let speedMul = 1;
      let hop = 0;
      let shake = 0;
      // Lingering effects.
      if (p.effectLeft > 0) {
        p.effectLeft -= dt;
        const e = p.effects;
        if (e.some((x) => x === 'calming' || x === 'dreamy' || x === 'foggy')) speedMul = 0.55;
        if (e.some((x) => x === 'jittery' || x === 'fizzy' || x === 'electric')) shake = Math.sin(performance.now() / 22 + k) * 0.03;
        if (e.some((x) => x === 'spicy' || x === 'zesty' || x === 'bright')) hop = Math.abs(Math.sin(performance.now() / 160 + k)) * 0.14;
        if (e.includes('dreamy')) hop = Math.max(hop, 0.1 + Math.sin(performance.now() / 600 + k) * 0.08);
        if (p.visible && d2 < 45 * 45 && p.tickFx(dt)) {
          const top = [...e].sort((a, b) => (EFFECTS[b]?.mult ?? 0) - (EFFECTS[a]?.mult ?? 0))[0];
          const col = EFFECTS[top]?.color ?? '#ffffff';
          this.fx.emit(p.x, p.y + 0.6 + Math.random() * 1.1, p.z, col, { count: 1, speed: 0.4, up: 0.3, life: 1.2, size: 0.07, grow: 0.02, spread: 0.6 });
          if (e.includes('electric') && Math.random() < 0.5) this.fx.emit(p.x, p.y + 1.6, p.z, '#cfe3ff', { count: 3, speed: 2.5, up: 0.5, life: 0.25, size: 0.04, grow: 0, spread: 0.3 });
        }
        const glow = e.some((x) => ['glowing', 'shimmering', 'cosmic', 'gilded', 'velvet', 'electric'].includes(x));
        if (glow && p.visible) {
          const top = e.find((x) => ['glowing', 'shimmering', 'cosmic', 'gilded', 'velvet', 'electric'].includes(x))!;
          r.tint(k, p.baseShirt, new THREE.Color(EFFECTS[top].color).getHex(), 0.45 + Math.sin(performance.now() / 300 + k) * 0.25);
        }
        if (p.effectLeft <= 0) r.tint(k, p.baseShirt, p.baseShirt, 0);
      }

      if (p.mode === 'use') {
        p.useT += dt;
        const t = p.useT;
        if (t > 1.0 && t - dt <= 1.0 && p.visible) {
          r.facePos(this.posePerson(p, 0, 0, 0), this.v);
          this.fx.emit(this.v.x, this.v.y, this.v.z, p.useColor, { count: 14, speed: 0.5, up: 0.35, life: 2.2, size: 0.1, grow: 0.25, spread: 0.1 });
        }
        if (t > 1.6 && t - dt <= 1.6 && p.visible) {
          r.facePos(this.posePerson(p, 0, 0, 0), this.v);
          this.fx.emit(this.v.x, this.v.y + 0.1, this.v.z, '#ffffff', { count: 6, speed: 0.3, up: 0.25, life: 2.5, size: 0.12, grow: 0.3, spread: 0.1 });
        }
        if (t > 2.4 && t - dt <= 2.4) {
          p.effectLeft = 45;
          if (p.visible) {
            const top = [...p.effects].sort((a, b) => (EFFECTS[b]?.mult ?? 0) - (EFFECTS[a]?.mult ?? 0))[0];
            this.fx.emit(p.x, p.y + 1.9, p.z, EFFECTS[top]?.color ?? '#fff', { count: 22, speed: 1.8, up: 1.4, life: 1.1, size: 0.08, grow: 0, gravity: 2, spread: 0.2 });
          }
        }
        if (t > 4.0) {
          p.useT = -1;
          p.mode = p.afterUse;
          if (p.mode === 'walk') {
            p.from = this.nearestNode(p.x, p.z);
            p.to = this.nodes[p.from].links[0];
          }
        }
      } else if (p.mode === 'chase') {
        moving = this.chase(p, dt);
      } else if (p.mode === 'wait') {
        p.yaw = Math.atan2(-dx0, -dz0);
      } else if (p.pause > 0) p.pause -= dt;
      else if (active) {
        // Police enforce curfew; gangs come after you once they're hostile enough.
        if (!this.chasing && p.cooldown <= 0 && d2 < 16 * 16 && !this.svc.player.hidden) {
          if (p.police && curfew && this.canSee(p, 26)) {
            this.startChase(p, 'curfew');
            continue;
          }
          if (p.kind === 'gang' && rivals.canShakedown(p.gang!) && this.canSee(p, 16)) {
            this.startChase(p, 'shakedown');
            continue;
          }
        }
        const target = this.nodes[p.to];
        const tx = target.x - p.x;
        const tz = target.z - p.z;
        const dist = Math.hypot(tx, tz);
        const ahead = dist > 0 ? (-dx0 * tx - dz0 * tz) / dist : 0;
        const lateral = dist > 0 ? Math.abs(-dx0 * tz + dz0 * tx) / dist : 9;
        const blocked = ahead > 0 && ahead < 1.3 && lateral < 0.7;
        if (!blocked) {
          const step = p.speed * speedMul * dt;
          if (dist <= step) {
            p.x = target.x;
            p.z = target.z;
            let opts = target.links.filter((l) => l !== p.from);
            if (p.gang) {
              const turf = this.turfNodes.get(p.gang)!;
              const inTurf = opts.filter((l) => turf.has(l));
              if (inTurf.length) opts = inTurf;
            } else {
              // Stay in your own neighbourhood (police: the core); head back if you've strayed.
              const area = p.hood !== null ? this.hoodNodes[p.hood] : p.police ? this.coreNodes : null;
              if (area) {
                const inside = opts.filter((l) => area.has(l));
                if (inside.length) opts = inside;
                else if (opts.length) {
                  const h = p.hood !== null ? NEIGHBOURHOODS[p.hood] : CORE;
                  const cx = (h.x0 + h.x1) / 2;
                  const cz = (h.z0 + h.z1) / 2;
                  opts = [opts.reduce((a, b) => (Math.hypot(this.nodes[a].x - cx, this.nodes[a].z - cz) < Math.hypot(this.nodes[b].x - cx, this.nodes[b].z - cz) ? a : b))];
                }
              }
            }
            p.from = p.to;
            p.to = opts.length ? opts[rng.int(0, opts.length - 1)] : target.links[0];
          } else {
            p.x += (tx / dist) * step;
            p.z += (tz / dist) * step;
            moving = true;
            this.turn(p, Math.atan2(tx, tz), dt);
          }
          p.y = this.surface(p.x, p.z);
        }
      }
      if (p.facePlayer > 0) {
        p.facePlayer -= dt;
        p.yaw = Math.atan2(-dx0, -dz0);
      }
      if (moving) p.phase += dt * (p.mode === 'chase' ? 9 : p.speed * speedMul * 5.2);
      else p.phase += (Math.round(p.phase / Math.PI) * Math.PI - p.phase) * Math.min(1, dt * 6);
      if (p.mode !== 'chase') p.body.setNextKinematicTranslation({ x: p.x, y: p.visible ? p.y + 0.86 : -500, z: p.z });

      const near = p.visible && this.chars.ready && p.wantChar;
      if (near && !p.char) {
        p.char = this.chars.acquire(p.outfit, p);
        p.char?.setLook(p.look);
      } else if (!near && p.char) {
        this.chars.release(p.char);
        p.char = null;
      }
      if (!p.visible || p.char) r.hide(k);
      if (!p.visible) continue;

      let armR = 0;
      let head = 0;
      let item = false;
      if (p.mode === 'use') {
        const t = p.useT;
        const raise = t < 0.6 ? t / 0.6 : t < 2.0 ? 1 : t < 2.6 ? 1 - (t - 2.0) / 0.6 : 0;
        armR = -2.5 * raise;
        head = t > 0.6 && t < 2.2 ? -0.25 : 0;
        item = t < 2.3;
      }
      if (p.char) {
        const c = p.char;
        c.root.position.set(p.x + shake, p.y + hop, p.z);
        c.root.rotation.y = p.yaw;
        if (p.mode === 'use') {
          const t = p.useT;
          c.raise = t < 0.6 ? t / 0.6 : t < 2.0 ? 1 : t < 2.6 ? 1 - (t - 2.0) / 0.6 : 0;
          c.tilt = t > 0.6 && t < 2.2 ? 0.3 : 0;
          c.item.visible = item;
          (c.item.material as THREE.MeshStandardMaterial).color.setHex(p.useColor);
          c.play(t > 2.5 && p.effects.length ? 'Wave' : 'Idle', 0.3);
        } else {
          c.raise = 0;
          c.tilt = 0;
          c.item.visible = false;
          if (p.mode === 'chase') c.play('Run', 0.2, 1.1);
          else if (moving) c.play('Walk', 0.25, (p.speed * speedMul) / 1.25);
          else c.play(p.mode === 'wait' || p.facePlayer > 0 ? 'Idle_Neutral' : 'Idle', 0.3);
        }
        if (p.effectLeft > 0 && p.effects.some((x) => ['glowing', 'shimmering', 'cosmic', 'gilded', 'velvet', 'electric'].includes(x))) {
          const top = p.effects.find((x) => ['glowing', 'shimmering', 'cosmic', 'gilded', 'velvet', 'electric'].includes(x))!;
          c.glow(new THREE.Color(EFFECTS[top].color).getHex(), 0.6 + Math.sin(performance.now() / 300 + k) * 0.4);
        } else c.glow(0x000000, 0);
        c.update(dt);
        continue;
      }
      const swing = moving ? (p.mode === 'chase' ? 0.9 : 0.55) : 0;
      const pose = this.posePerson(p, swing, armR, head);
      pose.y += hop;
      pose.shake = shake;
      pose.vest = p.kind !== 'civ';
      pose.item = item;
      r.pose(k, pose);
    }
    r.commit();
  }

  private posePerson(p: Person, swing: number, armR: number, head: number): Pose {
    const o = this.pose;
    o.x = p.x;
    o.y = p.y;
    o.z = p.z;
    o.yaw = p.yaw;
    o.phase = p.phase;
    o.swing = swing;
    o.armR = armR;
    o.armL = 0;
    o.head = head;
    o.shake = 0;
    return o;
  }

  private turn(p: Person, want: number, dt: number) {
    let d = want - p.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    p.yaw += d * Math.min(1, dt * 8);
  }

  /** Taser wires: a crackling line from the officer to you (or past you on a miss). */
  private fireBeam(p: Person, hit: boolean) {
    const pl = this.svc.player.position;
    const from = new THREE.Vector3(p.x, p.y + 1.2, p.z);
    const to = new THREE.Vector3(pl.x + (hit ? 0 : (Math.random() - 0.5) * 2), pl.y + (hit ? 1.0 : 0.3), pl.z + (hit ? 0 : (Math.random() - 0.5) * 2));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 12; i++) {
      const v = from.clone().lerp(to, i / 12);
      if (i > 0 && i < 12) v.add(new THREE.Vector3((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12));
      pts.push(v);
    }
    if (this.beam) this.svc.scene.remove(this.beam);
    this.beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xbfe0ff, transparent: true, opacity: 1 }));
    this.svc.scene.add(this.beam);
    this.beamT = 0.35;
    this.fx.emit(to.x, to.y, to.z, '#cfe3ff', { count: hit ? 26 : 8, speed: 3, up: 0.6, life: 0.35, size: 0.05, grow: 0, spread: 0.2 });
    this.svc.audio.play('switch', to);
  }

  /** Pursuit with a real character controller, so walls and stairs are respected. */
  private chase(p: Person, dt: number): boolean {
    const pl = this.svc.player.position;
    const dx = pl.x - p.x;
    const dz = pl.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (this.svc.player.hidden || this.svc.vehicles.driving) {
      p.lostFor += dt * 3;
    } else if (dist < 1.7 && Math.abs(pl.y - p.y) < 1.5) {
      this.onCaught?.(p);
      return false;
    }
    if (!this.svc.vehicles.driving && this.canSee(p, 70)) p.lostFor = 0;
    else p.lostFor += dt;
    // Police carry tasers: within 11 m and in sight, they fire every few seconds.
    if (p.police) {
      p.taserCd -= dt;
      if (p.taserCd <= 0 && dist < 11 && dist > 1.8 && !this.svc.vehicles.driving && !this.svc.player.hidden && this.svc.player.stun <= 0 && this.canSee(p, 11)) {
        p.taserCd = 3.5;
        const hit = Math.random() < (dist < 6 ? 0.8 : 0.55);
        this.fireBeam(p, hit);
        if (hit) this.svc.player.stun = 2.4;
        this.onTased?.(p, hit);
      }
    }
    if (p.lostFor > 14 || dist > 85) {
      this.endChase(p, 45);
      this.onLost?.(p);
      return false;
    }
    // Officers sprint about as fast as you; gang members are a touch slower.
    const sp = (p.police ? 7.3 : 6.2) * dt;
    const desired = { x: (dx / dist) * sp, y: -4 * dt, z: (dz / dist) * sp };
    this.ctrl.computeColliderMovement(p.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (c: Collider) => c.handle !== this.svc.player.collider.handle);
    const mv = this.ctrl.computedMovement();
    const cur = p.collider.translation();
    const next = { x: cur.x + mv.x, y: cur.y + mv.y, z: cur.z + mv.z };
    const ground = this.hm.get(next.x, next.z);
    if (next.y - 0.86 < ground - 1) next.y = ground + 0.86;
    p.body.setNextKinematicTranslation(next);
    p.x = next.x;
    p.z = next.z;
    p.y = next.y - 0.86;
    this.turn(p, Math.atan2(dx, dz), dt);
    return true;
  }
}
