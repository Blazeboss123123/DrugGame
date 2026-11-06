import * as THREE from 'three';
import type { Services } from '../core/Services';
import { ITEMS } from '../products/Catalog';
import { SimpleInteractable } from '../interaction/Interactable';
import { streetCorner } from '../business/Customers';
import type { Collider } from '../physics/Physics';

/** Seeds come from a supplier who stashes them at a dead drop somewhere in the city. */
export interface DeadDrop {
  id: number;
  items: { id: string; qty: number }[];
  /** Exact stash position (only found by searching). */
  x: number;
  y: number;
  z: number;
  /** Centre of the search area shown on the map. */
  cx: number;
  cz: number;
  /** Absolute game minutes when it's in place. */
  ready: number;
  hint: string;
  total: number;
}

export const DROP_MINUTES = 20;
/** Radius of the search circle on the map (metres). */
export const DROP_AREA = 22;
export const SUPPLIER = { key: 'supplier', name: 'Hoover (seeds)' };
const HIDING = ['behind a bin', 'under a bench', 'tucked by a lamp post', 'in a hedge', 'under a mailbox', 'behind a fire hydrant', 'by a drainpipe'];

/** Mixers and brewing supplies are only sold over the counter at Kwik Corner. */
export function shopOnly(id: string): boolean {
  const k = ITEMS[id]?.kind;
  return k === 'ingredient' || id === 'moonsalt' || id === 'starwater' || id === 'resin';
}

export interface Delivery {
  id: number;
  site: string;
  items: { id: string; qty: number }[];
  arrives: number; // absolute game minutes
  total: number;
}

export const DELIVERY_MINUTES = 15;

/** Supplier orders placed from the phone, delivered to the porch box after a short wait. */
export class Market {
  readonly pending: Delivery[] = [];
  private nextId = 1;
  constructor(private svc: Services) {}

  private now() {
    return this.svc.time.day * 1440 + this.svc.time.minutes;
  }

  unlocked(id: string): boolean {
    const u = ITEMS[id].unlock;
    return !u || this.svc.economy.lifetimeRevenue >= u.lifetimeRevenue;
  }

  /** Why an item can't be ordered to a site right now, or null. */
  canBuy(id: string, site = 'home'): string | null {
    if (ITEMS[id]?.kind === 'seed') return 'Seeds only come from your supplier (dead drop)';
    if (shopOnly(id)) return 'Sold over the counter at Kwik Corner';
    if (!this.unlocked(id)) return `Unlocks at $${ITEMS[id].unlock!.lifetimeRevenue.toLocaleString()} lifetime sales`;
    if (!this.svc.production.sites.get(site)) return 'Unknown property';
    return null;
  }

  order(cart: Map<string, number>, site = 'home'): { ok: boolean; text: string } {
    const items = [...cart].filter(([, q]) => q > 0).map(([id, qty]) => ({ id, qty }));
    if (!items.length) return { ok: false, text: 'Your cart is empty.' };
    const s = this.svc.production.sites.get(site);
    if (!s || !this.svc.properties.owns(site)) return { ok: false, text: 'You don\u2019t own that property.' };
    for (const it of items) {
      const reason = this.canBuy(it.id, site);
      if (reason) return { ok: false, text: `${ITEMS[it.id].name}: ${reason}.` };
    }
    const total = items.reduce((sum, it) => sum + ITEMS[it.id].price * it.qty, 0);
    if (!this.svc.economy.spend(total, `Market order #${this.nextId}`)) return { ok: false, text: `You need $${total} (you have $${this.svc.economy.cash}).` };
    const d: Delivery = { id: this.nextId++, site, items, arrives: this.now() + DELIVERY_MINUTES, total };
    this.pending.push(d);
    this.svc.bus.emit('objective:signal', { id: 'order' });
    return { ok: true, text: `Order #${d.id} placed for $${total}. Arriving at ${this.svc.properties.name(site)} in about ${DELIVERY_MINUTES} minutes.` };
  }

  advance() {
    this.advanceDrops();
    const now = this.now();
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const d = this.pending[i];
      if (now < d.arrives) continue;
      this.pending.splice(i, 1);
      const overflow: string[] = [];
      const site = this.svc.production.sites.get(d.site ?? 'home') ?? this.svc.production.home;
      for (const it of d.items) {
        const left = site.delivery.add(it.id, it.qty);
        if (left > 0) {
          // Delivery box full: the courier leaves the rest on the shelf, or reports it.
          const left2 = site.storage.add(it.id, left);
          if (left2 > 0) overflow.push(`${left2} × ${ITEMS[it.id].name}`);
        }
      }
      site.delivered = true;
      this.svc.bus.emit('phone:notify', { app: 'market', text: `Order #${d.id} delivered to ${site.id === 'home' ? 'your porch box' : site.name}.` });
      if (overflow.length) this.svc.ui.toast(`No room for ${overflow.join(', ')}. Empty your porch box and shelf.`, 'warn');
    }
  }

  /**
   * Over-the-counter purchase (the corner shop): pays and puts the items straight into the backpack.
   * Returns a message; nothing is charged if the backpack can't hold the full amount.
   */
  buyNow(id: string, qty: number, markup = 1): { ok: boolean; text: string } {
    const def = ITEMS[id];
    const reason = this.unlocked(id) ? null : `Unlocks at $${def.unlock!.lifetimeRevenue.toLocaleString()} lifetime sales`;
    if (reason) return { ok: false, text: reason };
    const inv = this.svc.inventory;
    if (inv.space(id) < qty) return { ok: false, text: 'Your backpack is full.' };
    const total = Math.round(def.price * markup) * qty;
    if (!this.svc.economy.spend(total, `Corner shop: ${qty} × ${def.name}`)) return { ok: false, text: `You need $${total} (you have $${this.svc.economy.cash}).` };
    inv.add(id, qty);
    this.svc.audio.play('paper');
    return { ok: true, text: `Bought ${qty} × ${def.name} for $${total}.${def.kind === 'equipment' ? ' Hold it and press E to place it.' : ''}` };
  }

  // ------------------------------------------------------------------ seed supplier & dead drops
  readonly drops: DeadDrop[] = [];
  private nextDrop = 1;
  private live = new Map<number, { group: THREE.Group; col: Collider }>();

  /** Pay the supplier up front; he hides the seeds somewhere in the city and texts you the area. */
  orderSeeds(cart: Map<string, number>): { ok: boolean; text: string } {
    const items = [...cart].filter(([id, q]) => q > 0 && ITEMS[id]?.kind === 'seed').map(([id, qty]) => ({ id, qty }));
    if (!items.length) return { ok: false, text: 'Pick some seeds first.' };
    for (const it of items) if (!this.unlocked(it.id)) return { ok: false, text: `${ITEMS[it.id].name}: unlocks at $${ITEMS[it.id].unlock!.lifetimeRevenue.toLocaleString()} lifetime sales.` };
    const total = items.reduce((sum, it) => sum + ITEMS[it.id].price * it.qty, 0);
    const spot = this.pickSpot();
    if (!spot) return { ok: false, text: 'Your supplier isn’t answering right now.' };
    if (!this.svc.economy.spend(total, `Seeds from ${SUPPLIER.name}`)) return { ok: false, text: `You need $${total} (you have $${this.svc.economy.cash}).` };
    const d: DeadDrop = { id: this.nextDrop++, items, ...spot, ready: this.now() + DROP_MINUTES, total };
    this.drops.push(d);
    const c = this.svc.customers;
    c.say(SUPPLIER.key, `${items.map((i) => `${i.qty} × ${ITEMS[i.id].name}`).join(', ')}. Sent $${total}.`);
    c.post(SUPPLIER.key, SUPPLIER.name, `Got the money. Give me ${DROP_MINUTES} minutes and I'll tell you where to look. Don't come with company.`);
    this.svc.bus.emit('objective:signal', { id: 'order' });
    return { ok: true, text: `Paid $${total}. Hoover will text you where the seeds are hidden in about ${DROP_MINUTES} minutes.` };
  }

  /** A random sidewalk spot away from you, with a search circle offset around it. */
  private pickSpot(): Omit<DeadDrop, 'id' | 'items' | 'ready' | 'total'> | null {
    const peds = this.svc.customers.peds;
    if (!peds?.nodes.length) return null;
    const me = this.svc.player.position;
    const nodes = peds.nodes.filter((n) => Math.hypot(n.x - me.x, n.z - me.z) > 90 && Math.hypot(n.x - me.x, n.z - me.z) < 380);
    const list = nodes.length ? nodes : peds.nodes;
    const n = list[Math.floor(Math.random() * list.length)];
    const a = Math.random() * Math.PI * 2;
    const x = n.x + Math.cos(a) * 0.9;
    const z = n.z + Math.sin(a) * 0.9;
    const hit = this.svc.physics.raycast({ x, y: 300, z }, { x: 0, y: -1, z: 0 }, 600, [], false);
    const y = hit && hit.point.y < this.svc.world.hm.get(x, z) + 1.5 ? hit.point.y : this.svc.world.hm.get(x, z) + 0.25;
    // The circle on the map is centred somewhere near the stash, not on it.
    const r = Math.random() * DROP_AREA * 0.7;
    const b = Math.random() * Math.PI * 2;
    return { x, y, z, cx: x + Math.cos(b) * r, cz: z + Math.sin(b) * r, hint: `${HIDING[Math.floor(Math.random() * HIDING.length)]} near ${streetCorner(n.x, n.z)}` };
  }

  /** Puts the stash bag in the world (once it's ready). */
  private spawnDrop(d: DeadDrop) {
    if (this.live.has(d.id)) return;
    const g = new THREE.Group();
    const paper = new THREE.MeshStandardMaterial({ color: 0x9a7a52, roughness: 0.95 });
    const bag = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.17), paper);
    bag.position.y = 0.15;
    bag.rotation.z = 0.06;
    const fold = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.05, 0.12), paper);
    fold.position.set(0, 0.31, 0.02);
    fold.rotation.x = -0.4;
    for (const m of [bag, fold]) {
      m.castShadow = true;
      g.add(m);
    }
    g.position.set(d.x, d.y, d.z);
    g.rotation.y = Math.random() * Math.PI * 2;
    g.name = 'dead-drop';
    this.svc.scene.add(g);
    const it = new SimpleInteractable(`drop:${d.id}`, () => `Pick up the stash (${d.items.map((i) => `${i.qty} × ${ITEMS[i.id].name}`).join(', ')})`, () => this.pickUp(d.id), [bag, fold], 2.2);
    const col = this.svc.physics.box(d.x, d.y + 0.2, d.z, 0.35, 0.3, 0.35);
    col.setSensor(true);
    this.svc.physics.tag(col, { interactable: it });
    this.svc.interaction.register(it);
    this.live.set(d.id, { group: g, col });
  }

  private despawn(id: number) {
    const l = this.live.get(id);
    if (!l) return;
    this.svc.scene.remove(l.group);
    this.svc.physics.world.removeCollider(l.col, false);
    const i = this.svc.interaction.items.findIndex((x) => x.id === `drop:${id}`);
    if (i >= 0) this.svc.interaction.items.splice(i, 1);
    this.live.delete(id);
  }

  pickUp(id: number) {
    const d = this.drops.find((x) => x.id === id);
    if (!d) return;
    const inv = this.svc.inventory;
    const got: string[] = [];
    for (const it of d.items) {
      const n = Math.min(it.qty, inv.space(it.id));
      if (n > 0) {
        inv.add(it.id, n);
        it.qty -= n;
        got.push(`${n} × ${ITEMS[it.id].name}`);
      }
    }
    d.items = d.items.filter((i) => i.qty > 0);
    if (!got.length) {
      this.svc.ui.toast('Your backpack is full. Make some room, the stash will wait.', 'warn');
      return;
    }
    this.svc.audio.play('pickup');
    if (!d.items.length) {
      this.drops.splice(this.drops.indexOf(d), 1);
      this.despawn(id);
      this.svc.ui.toast(`Picked up the stash: ${got.join(', ')}.`, 'good');
      this.svc.bus.emit('objective:signal', { id: 'drop' });
    } else this.svc.ui.toast(`Took ${got.join(', ')}. The rest won't fit, come back for it.`, 'warn');
  }

  /** Called as game time passes: drops whose time has come appear and you get the text. */
  private advanceDrops() {
    const now = this.now();
    for (const d of this.drops) {
      if (now < d.ready || this.live.has(d.id)) continue;
      this.spawnDrop(d);
      this.svc.customers.post(SUPPLIER.key, SUPPLIER.name, `Done. It's ${d.hint}. I've marked the area on your map. Look around, it's small.`);
      this.svc.bus.emit('phone:notify', { app: 'messages', text: `${SUPPLIER.name}: your seeds are hidden ${d.hint}.` });
    }
  }

  deliverNow() {
    for (const d of this.pending) d.arrives = 0;
    this.advance();
  }

  toJSON() {
    return { pending: this.pending, nextId: this.nextId, drops: this.drops, nextDrop: this.nextDrop };
  }

  load(d: (Partial<ReturnType<Market['toJSON']>> & { pending: Delivery[]; nextId: number }) | undefined) {
    for (const id of [...this.live.keys()]) this.despawn(id);
    this.drops.length = 0;
    if (!d) return;
    this.pending.length = 0;
    this.pending.push(...d.pending.map((p) => ({ ...p, site: p.site ?? 'home' })));
    this.nextId = d.nextId;
    this.drops.push(...(d.drops ?? []));
    this.nextDrop = d.nextDrop ?? 1;
    const now = this.now();
    for (const x of this.drops) if (now >= x.ready) this.spawnDrop(x);
  }
}
