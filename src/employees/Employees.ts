import * as THREE from 'three';
import { Rng } from '../core/math';
import type { Services } from '../core/Services';
import type { Interactable } from '../interaction/Interactable';
import type { Container } from '../inventory/Inventory';
import type { CharacterInstance, CharacterPool, CharLook, Outfit } from '../npc/Characters';
import { HAIRS, HumanoidRenderer, SKINS } from '../npc/Humanoid';
import { FAMILIES, INGREDIENTS, ITEMS, unitsOf, type Family } from '../products/Catalog';
import { GrowPot, Kettle, MixingStation, NeonPress, type Site } from '../production/Production';

/**
 * Staff. Each employee physically walks around their assigned property and works the same
 * stations and storage shelf the player uses, so their work is visible and real.
 */

export type Role = 'botanist' | 'chemist' | 'packager' | 'dealer' | 'manager';
export type Shift = 'day' | 'night' | 'all';

export const ROLES: Record<Role, { name: string; base: number; desc: string; outfit: Outfit }> = {
  botanist: { name: 'Botanist', base: 80, desc: 'Fills pots with soil, plants seeds, waters and harvests into storage.', outfit: 'Farmer' },
  chemist: { name: 'Chemist', base: 110, desc: 'Runs mixing stations with the recipe you set, plus kettles and presses.', outfit: 'Adventurer' },
  packager: { name: 'Packager', base: 60, desc: 'Packages loose product from storage into baggies and jars.', outfit: 'Worker' },
  dealer: { name: 'Dealer', base: 90, desc: 'Takes packaged stock out and sells to your customers. Keeps a 20% cut.', outfit: 'Casual_2' },
  manager: { name: 'Manager', base: 120, desc: 'Empties the delivery crate and buys supplies (+10% fee) to keep storage stocked.', outfit: 'Suit' },
};

export const SHIFTS: Record<Shift, { name: string; from: number; to: number; pay: number }> = {
  day: { name: 'Day (07–19)', from: 7, to: 19, pay: 1 },
  night: { name: 'Night (19–07)', from: 19, to: 7, pay: 1.15 },
  all: { name: 'Around the clock', from: 0, to: 24, pay: 1.6 },
};

export interface EmployeeData {
  id: number;
  name: string;
  role: Role;
  site: string;
  skill: number;
  xp: number;
  shift: Shift;
  morale: number;
  unpaid: number;
  tasksToday: number;
  totalTasks: number;
  earned: number;
  look: CharLook;
}

interface Task {
  label: string;
  at: THREE.Vector3;
  minutes: number;
  run: () => void;
}

const FIRST = ['Mo', 'Jesse', 'Rae', 'Kofi', 'Luz', 'Darnell', 'Pia', 'Gabe', 'Noor', 'Theo', 'Bea', 'Ruben', 'Ivy', 'Cal', 'Ana', 'Fitz'];
const LAST = ['Okoro', 'Vance', 'Holt', 'Mendez', 'Park', 'Lowe', 'Adeyemi', 'Silva', 'Reed', 'Nakamura', 'Price', 'Cole'];

export class Employee implements Interactable {
  readonly id: string;
  readonly highlight: THREE.Mesh[] = [];
  readonly maxDistance = 2.6;
  pos = new THREE.Vector3();
  yaw = 0;
  task: Task | null = null;
  workLeft = 0;
  status = 'Idle';
  away = false;
  /** Dealers: packaged stock they're carrying. */
  carry: { id: string; v?: string; qty: number }[] = [];
  saleTimer = 0;
  offDays = 0;
  char: CharacterInstance | null = null;
  body: import('../physics/Physics').RigidBody;
  collider: import('../physics/Physics').Collider;
  phase = 0;
  constructor(
    readonly data: EmployeeData,
    private svc: Services,
  ) {
    this.id = `employee-${data.id}`;
    const w = svc.physics.world;
    const R = svc.physics.R;
    this.body = w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased());
    this.collider = w.createCollider(R.ColliderDesc.capsule(0.55, 0.28).setSensor(true), this.body);
    svc.physics.tag(this.collider, { interactable: this });
  }
  get role() {
    return ROLES[this.data.role];
  }
  get salary() {
    return Math.round(this.role.base * (0.8 + this.data.skill * 0.22) * SHIFTS[this.data.shift].pay);
  }
  prompt() {
    return this.away ? null : `${this.data.name} (${this.role.name}): ${this.status}`;
  }
  interact() {
    this.svc.ui.phone.open('staff');
  }
}

export class Employees {
  readonly list: Employee[] = [];
  candidates: EmployeeData[] = [];
  /** Mixer each site's chemist uses. */
  readonly recipes = new Map<string, string>();
  private nextId = 1;
  private rng = new Rng(5150);
  private lastPayDay = 0;
  private candidateDay = -1;
  private far: HumanoidRenderer;
  private v = new THREE.Vector3();

  constructor(
    private svc: Services,
    private chars: CharacterPool,
  ) {
    this.far = new HumanoidRenderer(svc.scene, 24);
  }

  private site(e: Employee): Site | undefined {
    return this.svc.production.sites.get(e.data.site);
  }

  onShift(e: Employee): boolean {
    const h = this.svc.time.minutes / 60;
    const s = SHIFTS[e.data.shift];
    if (e.offDays > 0) return false;
    return s.from < s.to ? h >= s.from && h < s.to : h >= s.from || h < s.to;
  }

  countAt(site: string) {
    return this.list.filter((e) => e.data.site === site).length;
  }

  // ------------------------------------------------------------------ hiring
  refreshCandidates(force = false) {
    if (!force && this.candidateDay === this.svc.time.day) return;
    this.candidateDay = this.svc.time.day;
    const roles = Object.keys(ROLES) as Role[];
    this.candidates = [];
    for (let i = 0; i < 5; i++) {
      const role = i < roles.length ? roles[i] : this.rng.pick(roles);
      this.candidates.push({
        id: this.nextId++,
        name: `${this.rng.pick(FIRST)} ${this.rng.pick(LAST)}`,
        role,
        site: 'home',
        skill: this.rng.int(1, 3),
        xp: 0,
        shift: 'day',
        morale: 80,
        unpaid: 0,
        tasksToday: 0,
        totalTasks: 0,
        earned: 0,
        look: { skin: this.rng.pick(SKINS), hair: this.rng.pick(HAIRS), hue: this.rng.range(-0.4, 0.4) },
      });
    }
  }

  hire(candidateId: number, site: string): string {
    const c = this.candidates.find((x) => x.id === candidateId);
    if (!c) return 'That candidate is gone.';
    if (!this.svc.properties.owns(site)) return 'You don’t own that property.';
    if (this.countAt(site) >= this.svc.properties.staffCap(site)) return `${this.svc.properties.name(site)} has no room for more staff.`;
    const fee = Math.round(ROLES[c.role].base * 2);
    if (!this.svc.economy.spend(fee, `Signing fee: ${c.name}`)) return `You need $${fee} for the signing fee.`;
    c.site = site;
    this.candidates = this.candidates.filter((x) => x.id !== candidateId);
    const e = this.spawn(c);
    this.svc.customers.post(`emp:${c.id}`, c.name, `Thanks for the job, boss. I'll be at ${this.svc.properties.name(site)} for my shifts.`);
    return `Hired ${c.name} as a ${e.role.name}.`;
  }

  private spawn(d: EmployeeData): Employee {
    const e = new Employee(d, this.svc);
    const site = this.site(e);
    if (site) e.pos.copy(site.L(site.layout.rest[0], 0, site.layout.rest[1]));
    this.list.push(e);
    this.svc.interaction.register(e);
    return e;
  }

  fire(id: number): string {
    const i = this.list.findIndex((e) => e.data.id === id);
    if (i < 0) return 'No such employee.';
    const e = this.list[i];
    this.returnCarry(e);
    if (e.char) this.chars.release(e.char);
    e.body.setTranslation({ x: 0, y: -900, z: 0 }, true);
    this.list.splice(i, 1);
    const ii = this.svc.interaction.items.indexOf(e);
    if (ii >= 0) this.svc.interaction.items.splice(ii, 1);
    return `${e.data.name} has been let go.`;
  }

  train(id: number): string {
    const e = this.list.find((x) => x.data.id === id);
    if (!e) return 'No such employee.';
    if (e.data.skill >= 5) return `${e.data.name} is already at the top of their game.`;
    const cost = 250 * e.data.skill;
    if (!this.svc.economy.spend(cost, `Training for ${e.data.name}`)) return `Training costs $${cost}.`;
    e.data.skill++;
    return `${e.data.name} is now skill ${e.data.skill}.`;
  }

  setShift(id: number, shift: Shift) {
    const e = this.list.find((x) => x.data.id === id);
    if (e) e.data.shift = shift;
  }

  move(id: number, site: string): string {
    const e = this.list.find((x) => x.data.id === id);
    if (!e) return 'No such employee.';
    if (this.countAt(site) >= this.svc.properties.staffCap(site)) return 'No room there.';
    this.returnCarry(e);
    e.data.site = site;
    e.task = null;
    const s = this.site(e);
    if (s) e.pos.copy(s.L(s.layout.rest[0], 0, s.layout.rest[1]));
    return `${e.data.name} now works at ${this.svc.properties.name(site)}.`;
  }

  private returnCarry(e: Employee) {
    const s = this.site(e);
    for (const c of e.carry) s?.storage.add(c.id, c.qty, c.v);
    e.carry = [];
    e.away = false;
  }

  // ------------------------------------------------------------------ work planning
  private plan(e: Employee): Task | null {
    const site = this.site(e);
    if (!site) return null;
    const st = site.storage;
    const at = (x: number, z: number) => site.L(x, 0, z);
    const shelf = at(site.layout.storage[0], site.layout.storage[1] + 0.9);
    const front = (obj: THREE.Object3D, d = 0.9) => {
      const p = obj.position.clone();
      p.x += Math.sin(obj.rotation.y) * d;
      p.z += Math.cos(obj.rotation.y) * d;
      return p;
    };
    const speed = 0.6 + e.data.skill * 0.25;
    switch (e.data.role) {
      case 'botanist': {
        for (const pot of site.pots) {
          if (pot.ready) return { label: 'Harvesting', at: front(pot.group, 0.8), minutes: 6 / speed, run: () => this.done(e, pot.harvestTo(st, true) > 0) };
        }
        for (const pot of site.pots) {
          if (pot.seed && pot.water < 0.35) return { label: 'Watering', at: front(pot.group, 0.8), minutes: 2 / speed, run: () => this.done(e, (pot.waterNow(), true)) };
        }
        for (const pot of site.pots) {
          if (!pot.soil && (st.count('soil') || st.count('soil_rich'))) {
            const rich = st.count('soil_rich') > 0;
            return { label: 'Filling a pot', at: front(pot.group, 0.8), minutes: 3 / speed, run: () => this.done(e, st.remove(rich ? 'soil_rich' : 'soil', 1) && (pot.fill(rich ? 2 : 1), true)) };
          }
          if (pot.soil && !pot.seed) {
            const seed = ['seed_ember', 'seed_fern', 'seed_violet'].find((s) => st.count(s));
            if (seed) return { label: 'Planting', at: front(pot.group, 0.8), minutes: 2 / speed, run: () => this.done(e, st.remove(seed, 1) && (pot.plant(seed), pot.waterNow(), true)) };
          }
        }
        return null;
      }
      case 'chemist': {
        for (const k of [...site.all<MixingStation>('mixer'), ...site.all<Kettle>('kettle'), ...site.all<NeonPress>('press')]) {
          if (k.output) return { label: 'Collecting a batch', at: front(k.group), minutes: 2 / speed, run: () => this.done(e, k.collectTo(st)) };
        }
        for (const k of site.all<Kettle>('kettle')) {
          if (!k.job && st.count('moonsalt') && st.count('starwater'))
            return {
              label: 'Brewing Dreamdust',
              at: front(k.group),
              minutes: 4 / speed,
              run: () => {
                if (!st.remove('moonsalt', 1)) return this.done(e, false);
                if (!st.remove('starwater', 1)) {
                  st.add('moonsalt', 1);
                  return this.done(e, false);
                }
                const fine = st.remove('glitter', 1);
                const { variant } = this.svc.variants.get('dreamdust', ['dreamy'], fine ? 1 : 0, this.svc.time.day);
                const qty = this.svc.upgrades.has('kettle2') ? 12 : 8;
                k.start({ remaining: 60, total: 60, output: { id: 'prod', qty, v: variant.key }, label: `${qty} × ${variant.name}` });
                this.done(e, true);
              },
            };
        }
        for (const k of site.all<NeonPress>('press')) {
          if (!k.job && st.count('resin'))
            return {
              label: 'Pressing Neon',
              at: front(k.group),
              minutes: 3 / speed,
              run: () => {
                if (!st.remove('resin', 1)) return this.done(e, false);
                const { variant } = this.svc.variants.get('neon', ['glowing'], 0, this.svc.time.day);
                k.start({ remaining: 30, total: 30, output: { id: 'prod', qty: 10, v: variant.key }, label: `10 × ${variant.name}` });
                this.done(e, true);
              },
            };
        }
        const mixer = this.recipes.get(site.id) ?? INGREDIENTS.find((i) => st.count(i.item))?.item;
        const ing = INGREDIENTS.find((i) => i.item === mixer);
        if (ing) {
          for (const m of site.all<MixingStation>('mixer')) {
            if (m.job || m.output) continue;
            const slot = st.slots.findIndex((s) => {
              const v = s && s.id === 'prod' ? this.svc.variants.byKey(s.v) : undefined;
              return !!v && !v.effects.includes(ing.adds) && v.effects.length < 5;
            });
            if (slot < 0 || !st.count(ing.item)) break;
            return {
              label: `Mixing with ${ITEMS[ing.item].name}`,
              at: front(m.group),
              minutes: 3 / speed,
              run: () => {
                const s = st.slots[slot];
                const v = s && s.id === 'prod' ? this.svc.variants.byKey(s.v) : undefined;
                if (!s || !v) return this.done(e, false);
                const n = Math.min(10, s.qty, st.count(ing.item));
                if (n <= 0 || !st.remove(ing.item, n)) return this.done(e, false);
                st.removeAt(slot, n);
                m.startMix(v, ing.item, n);
                this.done(e, true);
              },
            };
          }
        }
        return null;
      }
      case 'packager': {
        const slot = st.slots.findIndex((s) => s?.id === 'prod');
        if (slot < 0) return null;
        const bench = site.find('packager');
        const where = bench ? front(bench.group) : shelf;
        const s = st.slots[slot]!;
        const useJar = s.qty >= 5 && st.count('jar') > 0;
        if (!useJar && !st.count('baggie')) return null;
        return {
          label: 'Packaging',
          at: where,
          minutes: (bench ? 4 : 8) / speed,
          run: () => {
            const cur = st.slots[slot];
            if (!cur || cur.id !== 'prod') return this.done(e, false);
            const per = useJar ? 5 : 1;
            const pack = useJar ? 'jar' : 'baggie';
            const out = useJar ? 'pkg_jar' : 'pkg_bag';
            const k = Math.min(10, Math.floor(cur.qty / per), st.count(pack), Math.max(0, st.space(out, cur.v) + (cur.qty === per * Math.floor(cur.qty / per) ? ITEMS[out].stack : 0)));
            if (k <= 0) return this.done(e, false);
            const v = cur.v;
            st.remove(pack, k);
            st.removeAt(slot, k * per);
            st.add(out, k, v);
            this.done(e, true);
          },
        };
      }
      case 'dealer': {
        if (e.carry.length) return null;
        const stocked = st.slots.some((s) => s && ITEMS[s.id].kind === 'packaged');
        if (!stocked) return null;
        return {
          label: 'Picking up stock',
          at: shelf,
          minutes: 2,
          run: () => {
            let units = 0;
            for (let i = 0; i < st.slots.length && units < 20; i++) {
              const s = st.slots[i];
              if (!s || ITEMS[s.id].kind !== 'packaged') continue;
              const per = unitsOf(s.id);
              const n = Math.min(s.qty, Math.ceil((20 - units) / per));
              const got = st.removeAt(i, n);
              if (got) {
                e.carry.push({ id: got.id, v: got.v, qty: got.qty });
                units += per * got.qty;
              }
            }
            e.away = units > 0;
            e.saleTimer = 20;
            this.done(e, units > 0);
          },
        };
      }
      case 'manager': {
        if (site.delivery.slots.some(Boolean))
          return {
            label: 'Unpacking deliveries',
            at: shelf,
            minutes: 3 / speed,
            run: () => {
              site.delivery.slots.forEach((_, i) => {
                const s = site.delivery.slots[i];
                if (s) {
                  const left = st.add(s.id, s.qty, s.v);
                  if (left < s.qty) site.delivery.removeAt(i, s.qty - left);
                }
              });
              this.done(e, true);
            },
          };
        const needs = this.restockList(site);
        if (needs.length && this.svc.time.minutes % 120 < 5)
          return {
            label: 'Ordering supplies',
            at: shelf,
            minutes: 4 / speed,
            run: () => {
              let spent = 0;
              for (const [id, qty] of needs) {
                const cost = Math.ceil(ITEMS[id].price * qty * 1.1);
                if (st.space(id) < qty || !this.svc.economy.spend(cost, `${e.data.name} restocked ${ITEMS[id].name}`)) continue;
                st.add(id, qty);
                spent += cost;
              }
              this.done(e, spent > 0);
            },
          };
        return null;
      }
    }
  }

  /** What the manager keeps in stock at a site. */
  restockList(site: Site): [string, number][] {
    const st: Container = site.storage;
    const pots = site.pots.length;
    const want: [string, number][] = [];
    const top = (id: string, target: number) => {
      const have = st.count(id);
      if (have < target / 2) want.push([id, target - have]);
    };
    if (pots) {
      top('soil', pots);
      top('seed_violet', pots);
    }
    if (site.has('packager')) top('baggie', 40);
    const mixer = this.recipes.get(site.id);
    if (mixer && site.has('mixer')) top(mixer, 20);
    return want.filter(([id]) => this.svc.market.unlocked(id));
  }

  private done(e: Employee, ok: boolean) {
    if (ok) {
      e.data.tasksToday++;
      e.data.totalTasks++;
      e.data.xp++;
      if (e.data.xp >= 40 * e.data.skill && e.data.skill < 5) {
        e.data.xp = 0;
        e.data.skill++;
        this.svc.customers.post(`emp:${e.data.id}`, e.data.name, `Getting the hang of this. (Skill ${e.data.skill})`);
      }
    }
  }

  // ------------------------------------------------------------------ simulation
  /** Game-time step (minutes). */
  advance(minutes: number) {
    this.refreshCandidates();
    const day = this.svc.time.day;
    if (this.lastPayDay === 0) this.lastPayDay = day;
    if (day !== this.lastPayDay && this.svc.time.minutes >= 7 * 60) {
      this.lastPayDay = day;
      this.payroll();
    }
    for (const e of [...this.list]) {
      if (e.data.role === 'dealer' && e.away) {
        this.dealerTick(e, minutes);
        continue;
      }
      if (!this.onShift(e) || !this.svc.properties.owns(e.data.site)) {
        e.task = null;
        e.status = e.offDays > 0 ? 'Off today' : 'Off shift';
        continue;
      }
      if (e.task && e.workLeft > 0 && this.arrived(e)) {
        e.workLeft -= minutes;
        if (e.workLeft <= 0) {
          const t = e.task;
          e.task = null;
          t.run();
        }
      }
      if (!e.task) {
        const t = this.plan(e);
        if (t) {
          e.task = t;
          e.workLeft = t.minutes;
          e.status = t.label;
        } else e.status = e.data.role === 'dealer' ? 'Waiting for packaged stock' : 'Nothing to do';
      }
    }
  }

  private dealerTick(e: Employee, minutes: number) {
    e.saleTimer -= minutes;
    e.status = `Out selling (${e.carry.reduce((s, c) => s + c.qty * unitsOf(c.id), 0)} units left)`;
    if (e.saleTimer > 0) return;
    e.saleTimer = Math.max(8, 30 - e.data.skill * 4);
    if (!e.carry.length) {
      e.away = false;
      return;
    }
    const fams = [...new Set(e.carry.map((c) => this.svc.variants.byKey(c.v)?.family).filter(Boolean))] as Family[];
    const quality = Math.max(...e.carry.map((c) => this.svc.variants.byKey(c.v)?.quality ?? 0));
    const sale = this.svc.customers.dealerSale(fams, quality);
    if (!sale) return;
    // Hand over packages of that family until the units are covered.
    let need = sale.units;
    for (const c of e.carry) {
      if (need <= 0) break;
      if (this.svc.variants.byKey(c.v)?.family !== sale.family) continue;
      const per = unitsOf(c.id);
      const n = Math.min(c.qty, Math.ceil(need / per));
      c.qty -= n;
      need -= n * per;
    }
    e.carry = e.carry.filter((c) => c.qty > 0);
    if (need > 0) return;
    const cut = Math.round(sale.price * (this.svc.upgrades.has('dealer') ? 0.12 : 0.2));
    this.svc.economy.earn(sale.price - cut, `${e.data.name} sold ${sale.units} × ${FAMILIES[sale.family].name}`, true, sale.units);
    e.data.earned += sale.price - cut;
    this.done(e, true);
    this.svc.bus.emit('objective:signal', { id: 'cash', amount: this.svc.economy.lifetimeRevenue });
    // Night work is riskier.
    const night = this.svc.time.minutes >= 21 * 60 || this.svc.time.minutes < 5 * 60;
    if (night && this.rng.next() < 0.04) {
      const lost = e.carry.reduce((s, c) => s + c.qty * unitsOf(c.id), 0);
      e.carry = [];
      e.away = false;
      e.offDays = 1;
      this.svc.customers.post(`emp:${e.data.id}`, e.data.name, `Cops picked me up. They took the last ${lost} units. I'm out of action until tomorrow.`);
    }
    if (!e.carry.length) e.away = false;
  }

  private payroll() {
    for (const e of [...this.list]) {
      if (e.offDays > 0) e.offDays--;
      e.data.tasksToday = 0;
      if (this.svc.economy.spend(e.salary, `Wages: ${e.data.name}`)) {
        e.data.unpaid = 0;
        e.data.morale = Math.min(100, e.data.morale + 5);
      } else {
        e.data.unpaid++;
        e.data.morale = Math.max(0, e.data.morale - 30);
        if (e.data.unpaid >= 2) {
          this.svc.customers.post(`emp:${e.data.id}`, e.data.name, `Two days without pay. I quit.`);
          this.fire(e.data.id);
        } else this.svc.customers.post(`emp:${e.data.id}`, e.data.name, `Boss, my wages didn't come through. I need $${e.salary}.`);
      }
    }
  }

  get dailyWages() {
    return this.list.reduce((s, e) => s + e.salary, 0);
  }

  private arrived(e: Employee) {
    return !e.task || e.pos.distanceTo(e.task.at) < 0.35;
  }

  /** Real-time movement and rendering. */
  frame(dt: number) {
    const pl = this.svc.player.position;
    this.list.forEach((e, i) => {
      const visible = !e.away && this.onShift(e) && this.svc.properties.owns(e.data.site);
      let moving = false;
      if (visible && e.task && !this.arrived(e)) {
        const d = this.v.copy(e.task.at).sub(e.pos);
        d.y = 0;
        const len = d.length();
        const step = Math.min(len, 1.5 * dt);
        e.pos.addScaledVector(d.normalize(), step);
        e.yaw = Math.atan2(d.x, d.z);
        moving = true;
      }
      const site = this.site(e);
      if (site) e.pos.y = site.L(0, 0, 0).y;
      e.body.setNextKinematicTranslation({ x: e.pos.x, y: visible ? e.pos.y + 0.86 : -900, z: e.pos.z });
      const dist = e.pos.distanceTo(pl);
      const near = visible && dist < 45 && this.chars.ready;
      if (near && !e.char) {
        e.char = this.chars.acquire(ROLES[e.data.role].outfit, e);
        e.char?.setLook(e.data.look);
      } else if (!near && e.char) {
        this.chars.release(e.char);
        e.char = null;
      }
      if (e.char) {
        e.char.root.position.copy(e.pos);
        e.char.root.rotation.y = e.yaw;
        e.char.play(moving ? 'Walk' : e.task && e.workLeft > 0 ? 'Interact' : 'Idle', 0.25);
        e.char.update(dt);
        this.far.hide(i);
      } else if (visible && dist < 150) {
        e.phase += moving ? dt * 7 : 0;
        this.far.setLook(i, { skin: e.data.look.skin, shirt: 0x6d7a84, pants: 0x2a2f3a, hair: e.data.look.hair });
        this.far.pose(i, { x: e.pos.x, y: e.pos.y, z: e.pos.z, yaw: e.yaw, phase: e.phase, swing: moving ? 0.55 : 0 });
      } else this.far.hide(i);
    });
    this.far.commit();
  }

  toJSON() {
    return {
      staff: this.list.map((e) => ({ ...e.data, carry: e.carry, away: e.away, offDays: e.offDays, x: e.pos.x, z: e.pos.z })),
      recipes: [...this.recipes],
      nextId: this.nextId,
      lastPayDay: this.lastPayDay,
    };
  }

  load(d: ReturnType<Employees['toJSON']> | undefined) {
    if (!d) return;
    for (const e of [...this.list]) this.fire(e.data.id);
    for (const s of d.staff) {
      const { carry, away, offDays, x, z, ...data } = s;
      const e = this.spawn(data);
      e.carry = carry;
      e.away = away;
      e.offDays = offDays;
      e.pos.x = x;
      e.pos.z = z;
    }
    this.recipes.clear();
    for (const [k, v] of d.recipes) this.recipes.set(k, v);
    this.nextId = d.nextId;
    this.lastPayDay = d.lastPayDay;
  }
}

export { GrowPot };
