import * as THREE from 'three';
import { Rng } from '../core/math';
import type { Services } from '../core/Services';
import type { Stack } from '../inventory/Inventory';
import type { Pedestrians, Person } from '../npc/Pedestrians';
import { EFFECTS, FAMILIES, ITEMS, unitValue, unitsOf, type Family, type Variant } from '../products/Catalog';
import { DISTRICTS, districtAt, streetNameAt } from '../world/CityPlan';
import { GANGS, type GangId } from './Rivals';

/**
 * Customer relationships, demand, haggling, deal requests by text, samples, and the consequences of
 * dealing in public (police and rival gangs). Customers are real pedestrians in the world.
 */

export interface Profile {
  idx: number;
  unlocked: boolean;
  family: Family;
  likes: string[];
  budget: number;
  loyalty: number; // 0..100
  deals: number;
  spent: number;
  refusedDay: number;
  /** 0..1: how much they want right now. Drops when they buy, recovers over about a day. */
  need: number;
  /** Most units they'll take in one go when fully wanting. */
  appetite: number;
  /** Day-scale recovery multiplier (rises with how much they like your product). */
  craving: number;
  lastBuy: number;
}

export interface Deal {
  id: number;
  person: number;
  family: Family;
  units: number;
  price: number;
  meet: { name: string; x: number; z: number };
  expires: number;
  status: 'offered' | 'accepted' | 'done' | 'failed' | 'declined';
  /** Hidden ceiling for counter-offers by text. */
  ceiling: number;
  rounds: number;
}

export interface Msg {
  id: number;
  me: boolean;
  text: string;
  at: string;
  deal?: number;
}

export interface Thread {
  key: string;
  name: string;
  color: string;
  msgs: Msg[];
  unread: number;
  updated: number;
}

/** A live in-person negotiation. */
export interface Haggle {
  person: Person;
  prof: Profile;
  slot: number;
  qty: number;
  units: number;
  variant: Variant;
  max: number;
  counter: number;
  patience: number;
  over: boolean;
}

export type HaggleResult = { kind: 'accept'; price: number; text: string } | { kind: 'counter'; price: number; text: string } | { kind: 'walk'; text: string } | { kind: 'error'; text: string };

const MEET_SPOTS: [number, number][] = [
  [-69.2, -80.8],
  [5.8, -5.8],
  [37.5, -5.8],
  [80.8, 69.2],
  [155.8, -69.2],
  [219.2, 80.8],
  [80.8, 219.2],
  [-144.2, -144.2],
  [5.8, -219.2],
  [-69.2, -230.8],
  [230.8, -5.8],
  [-144.2, 69.2],
  [155.8, 155.8],
  [294.2, 80.8],
];

const SALE_LINES = ['Pleasure doing business.', 'Good stuff. I’ll be back.', 'Keep it quiet, yeah?', 'Same time next week.', 'That’s exactly what I needed.'];
const COUNTER_LINES = ['Come on, be reasonable.', 'That’s steep. How about this?', 'I can do this, no more.', 'Meet me halfway.'];
const WALK_LINES = ['Forget it.', 'I’ll find someone else.', 'You’re having a laugh.', 'Not worth it.'];
const FULL_LINES = ['I’m still good from last time.', 'Not today, I’m set.', 'Ask me again tomorrow.'];

export class Customers {
  readonly profiles = new Map<number, Profile>();
  readonly deals: Deal[] = [];
  readonly threads = new Map<string, Thread>();
  private nextDealAt = 0;
  private nextId = 1;
  private rng = new Rng(9001);
  peds!: Pedestrians;
  heat: 'clear' | 'chase' = 'clear';
  /** Incremented whenever messages change, so the phone can refresh. */
  version = 0;

  constructor(private svc: Services) {}

  attach(peds: Pedestrians) {
    this.peds = peds;
    const fams: Family[] = ['nightshade', 'nightshade', 'nightshade', 'dreamdust', 'neon'];
    const effects = Object.keys(EFFECTS).filter((e) => EFFECTS[e].mult > 0);
    for (const p of peds.people) {
      if (p.kind !== 'civ') continue;
      const likes: string[] = [];
      while (likes.length < 3) {
        const e = this.rng.pick(effects);
        if (!likes.includes(e)) likes.push(e);
      }
      this.profiles.set(p.index, {
        idx: p.index,
        unlocked: false,
        family: this.rng.pick(fams),
        likes,
        budget: Math.round(this.rng.range(80, 420) / 10) * 10,
        loyalty: 20,
        deals: 0,
        spent: 0,
        refusedDay: -1,
        need: this.rng.range(0.6, 1),
        appetite: this.rng.int(2, 9),
        craving: 1,
        lastBuy: -1e9,
      });
    }
    peds.onSpotted = (o, reason) => {
      this.heat = 'chase';
      this.svc.bus.emit('police:state', { state: 'chase', officer: o.name });
      const msg =
        reason === 'curfew'
          ? `${o.name}: "Hey! It’s past curfew. Stop right there!"`
          : reason === 'shakedown'
            ? `${o.name} of ${GANGS[o.gang!].name} is coming for you. Run, or pay up.`
            : `${o.name} saw that. Run!`;
      this.svc.ui.toast(msg, 'warn');
      this.svc.audio.play('denied');
    };
    peds.onLost = (o) => {
      this.heat = 'clear';
      this.svc.bus.emit('police:state', { state: 'clear' });
      this.svc.ui.toast(o.police ? 'You lost the police.' : 'You shook them off.', 'good');
    };
    peds.onCaught = (o) => (o.police ? this.arrested(o) : this.shakedown(o));
  }

  get absMinutes() {
    return this.svc.time.day * 1440 + this.svc.time.minutes;
  }

  get customers(): Profile[] {
    return [...this.profiles.values()].filter((p) => p.unlocked);
  }

  person(idx: number): Person {
    return this.peds.people[idx];
  }

  /** Units this customer will take right now. */
  wantUnits(prof: Profile): number {
    return Math.max(0, Math.floor(prof.need * prof.appetite + 0.001));
  }

  private consumed(prof: Profile, units: number) {
    prof.need = Math.max(0, prof.need - units / prof.appetite);
    prof.lastBuy = this.absMinutes;
  }

  // ------------------------------------------------------------------ messaging
  thread(key: string, name: string): Thread {
    let t = this.threads.get(key);
    if (!t) {
      const color = key.startsWith('gang:') ? GANGS[key.slice(5) as GangId].css : key.startsWith('c:') ? '#3fae6a' : key.startsWith('emp') ? '#4a7fc1' : key.startsWith('player:') ? '#d98a2b' : '#7a7f86';
      t = { key, name, color, msgs: [], unread: 0, updated: 0 };
      this.threads.set(key, t);
    }
    return t;
  }

  /** A message arriving from someone else. */
  post(key: string, name: string, text: string, deal?: number) {
    const t = this.thread(key, name);
    t.msgs.push({ id: this.nextId++, me: false, text, at: `${this.svc.time.weekday} ${this.svc.time.label}`, deal });
    if (t.msgs.length > 40) t.msgs.shift();
    t.unread++;
    t.updated = this.absMinutes;
    this.version++;
    this.svc.bus.emit('phone:notify', { app: 'messages', text: `${name}: ${text}` });
  }

  /** A message the player sent. */
  say(key: string, text: string) {
    const t = this.threads.get(key);
    if (!t) return;
    t.msgs.push({ id: this.nextId++, me: true, text, at: `${this.svc.time.weekday} ${this.svc.time.label}` });
    t.updated = this.absMinutes;
    this.version++;
  }

  get unread() {
    let n = 0;
    for (const t of this.threads.values()) n += t.unread;
    return n;
  }

  // ------------------------------------------------------------------ prompts and interaction
  activeDealFor(p: Person): Deal | undefined {
    return this.deals.find((d) => d.person === p.index && d.status === 'accepted');
  }

  promptFor(p: Person): string {
    if (p.mode === 'use') return `${p.name} is busy`;
    if (p.police) return p.mode === 'chase' ? `${p.name} is chasing you` : `Talk to ${p.name}`;
    if (p.kind === 'gang') return `Talk to ${p.name} (${GANGS[p.gang!].name})`;
    const deal = this.activeDealFor(p);
    if (deal) return `Hand over ${deal.units} × ${FAMILIES[deal.family].name} to ${p.name}`;
    const prof = this.profiles.get(p.index);
    return prof?.unlocked ? `Deal with ${p.name} (customer)` : `Talk to ${p.name}`;
  }

  interact(p: Person) {
    if (p.mode === 'use') return;
    p.pause = Math.max(p.pause, 6);
    p.facePlayer = 6;
    if (p.police) {
      const late = this.svc.time.minutes > 1320 || this.svc.time.minutes < 300;
      this.svc.ui.toast(`${p.name}: "${late ? 'Curfew starts at eleven. Get yourself home.' : 'Keep your nose clean.'}"`, 'info');
      return;
    }
    if (p.kind === 'gang') {
      const g = GANGS[p.gang!];
      const h = this.svc.rivals.hostility[p.gang!];
      const line = h >= 65 ? 'You’ve got some nerve showing your face here.' : h >= 35 ? `${g.leader} has been asking about you.` : 'This is our corner. Keep walking.';
      this.svc.ui.toast(`${p.name}: "${line}"`, h >= 35 ? 'warn' : 'info');
      return;
    }
    const deal = this.activeDealFor(p);
    if (deal) {
      this.completeDeal(deal);
      return;
    }
    this.svc.ui.panels.openPerson(p, this.profiles.get(p.index)!);
  }

  // ------------------------------------------------------------------ product helpers
  packagedStacks(family?: Family): { slot: number; stack: Stack; variant: Variant }[] {
    const out: { slot: number; stack: Stack; variant: Variant }[] = [];
    this.svc.inventory.slots.forEach((s, slot) => {
      if (!s || ITEMS[s.id].kind !== 'packaged') return;
      const v = this.svc.variants.byKey(s.v);
      if (!v || (family && v.family !== family)) return;
      out.push({ slot, stack: s, variant: v });
    });
    return out;
  }

  matches(prof: Profile, v: Variant) {
    return v.effects.filter((e) => prof.likes.includes(e)).length;
  }

  /** Fair price per unit for this customer, before haggling. */
  willingness(prof: Profile, v: Variant): number {
    const fam = prof.family === v.family ? 1.12 : 0.92;
    const d = districtAt(this.person(prof.idx).x, this.person(prof.idx).z);
    return unitValue(v) * fam * (0.85 + 0.12 * this.matches(prof, v) + prof.loyalty / 300) * this.svc.rivals.priceMult(d);
  }

  private colorOf(v: Variant): number {
    const top = [...v.effects].sort((a, b) => EFFECTS[b].mult - EFFECTS[a].mult)[0];
    return new THREE.Color(top ? EFFECTS[top].color : FAMILIES[v.family].color).getHex();
  }

  // ------------------------------------------------------------------ samples
  giveSample(p: Person, slot: number): string {
    const prof = this.profiles.get(p.index)!;
    const s = this.svc.inventory.slots[slot];
    const v = this.svc.variants.byKey(s?.v);
    if (!s || !v) return 'Choose a packaged product first.';
    if (prof.unlocked) return `${p.name} is already a customer.`;
    if (prof.refusedDay === this.svc.time.day) return `${p.name} already said no today.`;
    const d = districtAt(p.x, p.z);
    if (this.rng.next() < this.svc.rivals.loyalToGang(d) * 0.6) {
      prof.refusedDay = this.svc.time.day;
      return `${p.name}: "I get my stuff from ${GANGS[this.svc.rivals.dominant(d).gang].name}. No thanks."`;
    }
    this.svc.inventory.removeAt(slot, 1);
    this.peds.consume(p, this.colorOf(v), v.effects);
    const chance = 0.3 + 0.18 * this.matches(prof, v) + v.quality * 0.12 + (prof.family === v.family ? 0.2 : 0);
    this.witness(d, 1);
    if (this.rng.next() < chance) {
      prof.unlocked = true;
      prof.loyalty = 35;
      prof.need = 0.4;
      this.svc.bus.emit('objective:signal', { id: 'sample' });
      this.post(`c:${p.index}`, p.name, `That ${v.name} was something else. Text me when you have more. I'm into ${prof.likes.map((e) => EFFECTS[e].name).join(', ')}.`);
      this.nextDealAt = Math.min(this.nextDealAt, this.absMinutes + 25);
      return `${p.name} loved it and is now your customer. They like ${prof.likes.map((e) => EFFECTS[e].name).join(', ')}.`;
    }
    prof.refusedDay = this.svc.time.day;
    return `${p.name} wasn't impressed. Try a product with effects they like.`;
  }

  // ------------------------------------------------------------------ haggling in person
  startHaggle(p: Person, slot: number, qty: number): Haggle | string {
    const prof = this.profiles.get(p.index)!;
    const s = this.svc.inventory.slots[slot];
    const v = this.svc.variants.byKey(s?.v);
    if (!s || !v) return 'Choose a packaged product.';
    const units = unitsOf(s.id) * qty;
    const want = this.wantUnits(prof);
    if (want <= 0) return `${p.name}: "${this.rng.pick(FULL_LINES)}"`;
    if (units > want) return `${p.name}: "That's too much. I only want ${want} unit${want === 1 ? '' : 's'} right now."`;
    if (qty > s.qty) return 'You don’t have that many.';
    const max = Math.min(prof.budget * 1.3, this.willingness(prof, v) * units * this.rng.range(1.0, 1.18));
    return { person: p, prof, slot, qty, units, variant: v, max, counter: Math.round(max * this.rng.range(0.62, 0.75)), patience: 3, over: false };
  }

  /** The player names a price. The customer accepts, counters, or walks away. */
  offer(h: Haggle, ask: number): HaggleResult {
    if (h.over) return { kind: 'error', text: 'This negotiation is over.' };
    const name = h.person.name;
    if (ask <= h.max * 0.93) return this.closeHaggle(h, ask);
    if (ask > h.max * 1.7) {
      h.over = true;
      h.prof.loyalty = Math.max(0, h.prof.loyalty - 5);
      return { kind: 'walk', text: `${name}: "${this.rng.pick(WALK_LINES)}" (insulted, loyalty down)` };
    }
    h.patience--;
    if (h.patience <= 0) {
      h.over = true;
      h.prof.loyalty = Math.max(0, h.prof.loyalty - 2);
      return { kind: 'walk', text: `${name}: "${this.rng.pick(WALK_LINES)}"` };
    }
    // Move toward the ask, but never past what they're really willing to pay.
    h.counter = Math.round(Math.min(h.max * 0.97, h.counter + (Math.min(ask, h.max) - h.counter) * 0.55));
    return { kind: 'counter', price: h.counter, text: `${name}: "${this.rng.pick(COUNTER_LINES)} $${h.counter}?"` };
  }

  acceptCounter(h: Haggle): HaggleResult {
    if (h.over) return { kind: 'error', text: 'This negotiation is over.' };
    return this.closeHaggle(h, h.counter);
  }

  private closeHaggle(h: Haggle, price: number): HaggleResult {
    const s = this.svc.inventory.slots[h.slot];
    if (!s || s.v !== h.variant.key || s.qty < h.qty) return { kind: 'error', text: 'You no longer have that product.' };
    h.over = true;
    const p = h.person;
    const prof = h.prof;
    this.svc.inventory.removeAt(h.slot, h.qty);
    this.svc.economy.earn(price, `Sold ${h.units} × ${h.variant.name} to ${p.name}`, true, h.units);
    prof.spent += price;
    prof.deals++;
    const good = price < h.max * 0.8;
    prof.loyalty = Math.min(100, prof.loyalty + (good ? 6 : 3) + this.matches(prof, h.variant));
    this.consumed(prof, h.units);
    prof.craving = Math.min(2.5, prof.craving + 0.08 * (1 + h.variant.quality) + 0.04 * this.matches(prof, h.variant));
    this.svc.audio.play('pickup');
    this.svc.ui.viewPunch();
    this.peds.consume(p, this.colorOf(h.variant), h.variant.effects);
    this.svc.bus.emit('objective:signal', { id: 'sale' });
    this.svc.bus.emit('objective:signal', { id: 'cash', amount: this.svc.economy.lifetimeRevenue });
    this.witness(districtAt(p.x, p.z), h.units);
    return { kind: 'accept', price, text: `${p.name}: "${this.rng.pick(SALE_LINES)}" +$${price}` };
  }

  /** Police and gang members notice handoffs that happen in view; the sale also moves territory. */
  private witness(d: ReturnType<typeof districtAt>, units: number) {
    const gang = this.peds.gangWitness(20);
    this.svc.rivals.recordSale(d, units, gang);
    this.peds.alertPolice(18, 'deal');
  }

  // ------------------------------------------------------------------ deal requests by text
  private newDeal() {
    const pool = this.customers.filter((c) => this.wantUnits(c) >= 1 && c.need >= 0.45 && !this.deals.some((d) => d.person === c.idx && (d.status === 'offered' || d.status === 'accepted')));
    if (!pool.length) return;
    const prof = this.rng.pick(pool);
    const p = this.person(prof.idx);
    const known = [...this.svc.variants.variants.values()];
    const fam: Family = known.some((v) => v.family === prof.family) ? prof.family : (known[0]?.family ?? 'nightshade');
    const famVariants = known.filter((v) => v.family === fam);
    const ref = famVariants.length ? famVariants.reduce((s, v) => s + unitValue(v), 0) / famVariants.length : FAMILIES[fam].base;
    const units = Math.max(1, Math.min(this.wantUnits(prof), Math.round(prof.budget / ref)));
    const price = Math.round((units * ref * (0.95 + prof.loyalty / 400)) / 5) * 5;
    const spot = this.rng.pick(MEET_SPOTS);
    const meet = { name: streetCorner(spot[0], spot[1]), x: spot[0], z: spot[1] };
    const deal: Deal = { id: this.nextId++, person: prof.idx, family: fam, units, price, meet, expires: this.absMinutes + 90, status: 'offered', ceiling: Math.round(price * this.rng.range(1.08, 1.3)), rounds: 0 };
    this.deals.unshift(deal);
    if (this.deals.length > 50) this.deals.pop();
    this.post(`c:${prof.idx}`, p.name, `Need ${units} × ${FAMILIES[fam].name}. Meet at ${meet.name}? I'll pay $${price}.`, deal.id);
  }

  accept(id: number): string {
    const d = this.deals.find((x) => x.id === id);
    if (!d || d.status !== 'offered') return 'That offer is no longer available.';
    const other = this.activeDeal;
    if (other && other.id !== id) {
      // Several meetings at once are fine, but warn.
      this.svc.ui.toast('You now have more than one meeting to get to.', 'info');
    }
    d.status = 'accepted';
    d.expires = this.absMinutes + 240;
    const p = this.person(d.person);
    this.say(`c:${d.person}`, `Deal. See you at ${d.meet.name}.`);
    this.peds.sendTo(p, d.meet.x, d.meet.z);
    this.svc.ui.toast(`Deal accepted. Meet ${p.name} at ${d.meet.name} within 4 hours.`, 'info');
    return 'Accepted';
  }

  /** Haggle by text: counter-offer a deal's price. */
  counterDeal(id: number, price: number): string {
    const d = this.deals.find((x) => x.id === id);
    if (!d || d.status !== 'offered') return 'That offer is no longer available.';
    const p = this.person(d.person);
    const key = `c:${d.person}`;
    this.say(key, `How about $${price}?`);
    d.rounds++;
    if (price <= d.ceiling) {
      d.price = price;
      this.post(key, p.name, `Fine, $${price} it is.`);
      this.accept(id);
      return 'accepted';
    }
    if (price > d.ceiling * 1.5 || d.rounds >= 3) {
      d.status = 'declined';
      const prof = this.profiles.get(d.person);
      if (prof) prof.loyalty = Math.max(0, prof.loyalty - 4);
      this.post(key, p.name, `Forget it then.`);
      return 'declined';
    }
    const meet = Math.round((d.price + (Math.min(price, d.ceiling) - d.price) * 0.6) / 5) * 5;
    d.price = Math.max(d.price, meet);
    this.post(key, p.name, `Too much. I can do $${d.price}, final offer.`, d.id);
    return 'countered';
  }

  decline(id: number) {
    const d = this.deals.find((x) => x.id === id);
    if (d && d.status === 'offered') {
      d.status = 'declined';
      this.say(`c:${d.person}`, 'Not today.');
      const prof = this.profiles.get(d.person);
      if (prof) prof.loyalty = Math.max(0, prof.loyalty - 3);
    }
  }

  get activeDeal(): Deal | undefined {
    return this.deals.find((d) => d.status === 'accepted');
  }

  completeDeal(d: Deal) {
    const p = this.person(d.person);
    const prof = this.profiles.get(d.person)!;
    const stacks = this.packagedStacks(d.family).sort((a, b) => unitsOf(a.stack.id) - unitsOf(b.stack.id));
    const have = stacks.reduce((s, x) => s + unitsOf(x.stack.id) * x.stack.qty, 0);
    if (have < d.units) {
      this.svc.ui.toast(`${p.name}: "You've only got ${have} of the ${d.units} ${FAMILIES[d.family].name} we agreed."`, 'warn');
      return;
    }
    stacks.sort((a, b) => this.matches(prof, b.variant) - this.matches(prof, a.variant) || unitsOf(a.stack.id) - unitsOf(b.stack.id));
    let need = d.units;
    let matchSum = 0;
    let used: Variant | undefined;
    const take = (s: (typeof stacks)[number], k: number) => {
      const per = unitsOf(s.stack.id);
      this.svc.inventory.removeAt(s.slot, k);
      need -= per * k;
      matchSum += this.matches(prof, s.variant) * per * k;
      used = used ?? s.variant;
    };
    for (const s of stacks) {
      const per = unitsOf(s.stack.id);
      const k = Math.min(s.stack.qty, Math.floor(need / per));
      if (k > 0) take(s, k);
      if (need <= 0) break;
    }
    if (need > 0) {
      const extra = stacks.find((s) => this.svc.inventory.slots[s.slot] === s.stack && s.stack.qty > 0);
      if (extra) take(extra, 1);
    }
    const bonus = Math.round(d.price * Math.min(0.25, (matchSum / d.units) * 0.08));
    const total = d.price + bonus;
    this.svc.economy.earn(total, `Deal with ${p.name}`, true, d.units);
    d.status = 'done';
    prof.deals++;
    prof.spent += total;
    prof.loyalty = Math.min(100, prof.loyalty + 8);
    this.consumed(prof, d.units);
    this.svc.audio.play('pickup');
    this.svc.ui.viewPunch();
    if (used) this.peds.consume(p, this.colorOf(used), used.effects);
    else this.peds.release(p);
    this.svc.ui.toast(`${p.name}: "${this.rng.pick(SALE_LINES)}" +$${total}${bonus ? ` (incl. $${bonus} tip for effects they like)` : ''}`, 'good');
    this.svc.bus.emit('objective:signal', { id: 'sale' });
    this.svc.bus.emit('objective:signal', { id: 'cash', amount: this.svc.economy.lifetimeRevenue });
    this.witness(districtAt(p.x, p.z), d.units);
  }

  // ------------------------------------------------------------------ dealers (employees)
  /** A dealer employee sells to a customer who wants product. Returns the sale or null. */
  dealerSale(stockFamily: Family[], quality: number): { prof: Profile; units: number; price: number; family: Family } | null {
    const pool = this.customers.filter((c) => this.wantUnits(c) >= 1 && stockFamily.includes(c.family));
    const anyPool = pool.length ? pool : this.customers.filter((c) => this.wantUnits(c) >= 1);
    if (!anyPool.length) return null;
    const prof = this.rng.pick(anyPool);
    const fam = stockFamily.includes(prof.family) ? prof.family : stockFamily[0];
    const units = Math.min(this.wantUnits(prof), 3);
    const p = this.person(prof.idx);
    const d = districtAt(p.x, p.z);
    const price = Math.round(FAMILIES[fam].base * (1 + quality * 0.3) * units * this.svc.rivals.priceMult(d) * (0.95 + prof.loyalty / 300));
    this.consumed(prof, units);
    prof.deals++;
    prof.spent += price;
    prof.loyalty = Math.min(100, prof.loyalty + 2);
    this.svc.rivals.recordSale(d, units * 0.6);
    if (p.visible && p.mode === 'walk') this.peds.consume(p, new THREE.Color(FAMILIES[fam].color).getHex(), ['calming']);
    return { prof, units, price, family: fam };
  }

  // ------------------------------------------------------------------ police and gangs
  private arrested(o: Person) {
    const contraband = this.svc.inventory.slots.some((s) => s && (ITEMS[s.id].kind === 'product' || ITEMS[s.id].kind === 'packaged'));
    this.peds.endChase(o, 60);
    this.heat = 'clear';
    this.svc.bus.emit('police:state', { state: 'clear' });
    if (!contraband) {
      this.svc.ui.toast(`${o.name} searched you and found nothing. "Move along."`, 'info');
      return;
    }
    let units = 0;
    this.svc.inventory.slots.forEach((s, i) => {
      if (s && (ITEMS[s.id].kind === 'product' || ITEMS[s.id].kind === 'packaged')) {
        units += unitsOf(s.id) * s.qty;
        this.svc.inventory.slots[i] = null;
      }
    });
    this.svc.inventory.changed();
    const fine = this.svc.economy.forfeit(200 + this.svc.economy.cash * 0.1, `Fine from ${o.name}`);
    this.svc.ui.busted(`${o.name} searched you. ${units} units confiscated and a $${fine} fine.`);
  }

  private shakedown(o: Person) {
    const g = o.gang!;
    this.peds.endChase(o, 90);
    this.heat = 'clear';
    this.svc.bus.emit('police:state', { state: 'clear' });
    const take = this.svc.economy.forfeit(Math.max(80, this.svc.economy.cash * 0.18), `Shaken down by ${GANGS[g].name}`);
    let units = 0;
    if (take < 80) {
      // Not enough cash: they take product instead.
      const slot = this.svc.inventory.slots.findIndex((s) => s && ITEMS[s.id].kind === 'packaged');
      if (slot >= 0) {
        const s = this.svc.inventory.slots[slot]!;
        units = unitsOf(s.id) * s.qty;
        this.svc.inventory.removeAt(slot, s.qty);
      }
    }
    this.svc.rivals.settled(g);
    this.svc.ui.toast(`${o.name}: "Consider this rent." They took $${take}${units ? ` and ${units} units` : ''}.`, 'warn');
    this.post(`gang:${g}`, GANGS[g].leader, `My people collected. Keep selling on our turf and they'll keep collecting.`);
  }

  // ------------------------------------------------------------------ time
  advance(minutes: number) {
    const now = this.absMinutes;
    // Customers slowly want more again (about a day to recover fully; faster if hooked).
    for (const prof of this.profiles.values()) prof.need = Math.min(1, prof.need + (minutes / 1300) * prof.craving);
    if (this.nextDealAt === 0) this.nextDealAt = now + 30;
    if (this.customers.length && now >= this.nextDealAt) {
      this.newDeal();
      this.nextDealAt = now + (this.rng.range(40, 100) / Math.min(3, 1 + this.customers.length * 0.15)) * (this.svc.upgrades?.has('burner') ? 0.6 : 1);
    }
    for (const d of this.deals) {
      if ((d.status === 'offered' || d.status === 'accepted') && now > d.expires) {
        const p = this.person(d.person);
        const prof = this.profiles.get(d.person)!;
        if (d.status === 'accepted') {
          prof.loyalty = Math.max(0, prof.loyalty - 15);
          this.peds.release(p);
          this.post(`c:${d.person}`, p.name, 'You never showed. Not cool.');
        }
        d.status = 'failed';
      }
    }
  }

  forceDeal() {
    if (!this.customers.length) {
      const first = [...this.profiles.values()][0];
      first.unlocked = true;
    }
    for (const c of this.customers) c.need = 1;
    this.newDeal();
  }

  clearHeat() {
    const c = this.peds.chasing;
    if (c) this.peds.endChase(c, 60);
    this.heat = 'clear';
    this.svc.bus.emit('police:state', { state: 'clear' });
  }

  toJSON() {
    return { profiles: [...this.profiles.values()], deals: this.deals, threads: [...this.threads.values()], nextDealAt: this.nextDealAt, nextId: this.nextId };
  }

  load(d: (ReturnType<Customers['toJSON']> & { messages?: unknown }) | undefined) {
    if (!d) return;
    for (const p of d.profiles) if (this.profiles.has(p.idx)) this.profiles.set(p.idx, { ...this.profiles.get(p.idx)!, ...p });
    this.deals.length = 0;
    this.deals.push(...d.deals.map((x) => ({ ...x, ceiling: x.ceiling ?? Math.round(x.price * 1.15), rounds: x.rounds ?? 0 })));
    this.threads.clear();
    for (const t of d.threads ?? []) this.threads.set(t.key, t);
    this.nextDealAt = d.nextDealAt;
    this.nextId = d.nextId;
    for (const deal of this.deals) if (deal.status === 'accepted') this.peds.sendTo(this.person(deal.person), deal.meet.x, deal.meet.z);
    this.version++;
  }
}

export function streetCorner(x: number, z: number): string {
  const s = streetNameAt(x, z) ?? '';
  const d = DISTRICTS[districtAt(x, z)].name;
  return `${s} (${d})`;
}
