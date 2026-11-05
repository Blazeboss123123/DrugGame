import type { Services } from '../core/Services';
import { ITEMS } from '../products/Catalog';

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

  deliverNow() {
    for (const d of this.pending) d.arrives = 0;
    this.advance();
  }

  toJSON() {
    return { pending: this.pending, nextId: this.nextId };
  }

  load(d: ReturnType<Market['toJSON']> | undefined) {
    if (!d) return;
    this.pending.length = 0;
    this.pending.push(...d.pending.map((p) => ({ ...p, site: p.site ?? 'home' })));
    this.nextId = d.nextId;
  }
}
