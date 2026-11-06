import type { Services } from '../core/Services';
import type { Stack } from '../inventory/Inventory';
import type { Site } from '../production/Production';
import type { Variant } from '../products/Catalog';
import type { Deal, Profile, Thread } from '../business/Customers';

/**
 * Shared world for multiplayer: every placed station (pots with their soil, seeds and plants,
 * mixers, kettles, racks, lamps, storage racks), every property's storage shelf and delivery box,
 * and converted rooms are kept identical for everyone in the room.
 *
 * The host's world is the starting point: when you join, your local stations are put aside and you
 * receive the host's. After that, any player's change is sent to everyone as a small op. Changes are
 * found by comparing a signature of each object a few times a second, so every way of changing a
 * station (planting, watering, harvesting, mixing, placing, picking up, staff work) is covered.
 * Slowly changing numbers (growth, water) are coarsened in the signature so ordinary ticking, which
 * every client simulates on the shared clock, doesn't flood the network.
 */

interface StationOp {
  k: 'put';
  site: string;
  key: string;
  kind: string;
  x: number;
  z: number;
  yaw: number;
  d: Record<string, unknown>;
}
interface DelOp {
  k: 'del';
  site: string;
  key: string;
}
interface BoxOp {
  k: 'box';
  site: string;
  box: 'storage' | 'delivery';
  slots: (Stack | null)[];
}
interface RoomOp {
  k: 'room';
  room: 'front' | 'back';
}
interface VarsOp {
  k: 'vars';
  list: Variant[];
}
/** Shared customers: a profile (loyalty, need, unlocked), a deal, or a message thread. */
interface ProfOp {
  k: 'prof';
  d: Profile;
}
interface DealOp {
  k: 'deal';
  d: Deal;
}
interface ThreadOp {
  k: 'thr';
  d: Thread;
}
export type WorldOp = StationOp | DelOp | BoxOp | RoomOp | VarsOp | ProfOp | DealOp | ThreadOp;

const keyOf = (kind: string, x: number, z: number) => `${kind}@${x.toFixed(2)},${z.toFixed(2)}`;

/** JSON with fractional numbers rounded to quarters and countdowns dropped. */
function signature(v: unknown): string {
  return JSON.stringify(v, (k, x) => (k === 'remaining' ? undefined : typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 4) / 4 : x));
}

export class WorldSync {
  /** Last signature known to be shared (sent or received), per site, per object key. */
  private known = new Map<string, Map<string, string>>();
  private timer = 0;
  /** Your own production while you are a guest in someone else's world. */
  private stash: { prod: unknown; cust: unknown } | null = null;
  private sentVariants = new Set<string>();
  private applying = false;
  ready = false;

  constructor(
    private svc: Services,
    private send: (m: unknown) => void,
  ) {}

  get guest() {
    return this.stash !== null;
  }

  /** What to write into your save while online: your own world, not the host's. */
  saveData(): unknown {
    return this.stash?.prod ?? this.svc.production.save();
  }

  /** Same for customers: your own customers, loyalty and messages go into your save. */
  saveCustomers(): unknown {
    return this.stash?.cust ?? this.svc.customers.toJSON();
  }

  /** Progress reset while visiting: your own (stashed) equipment and customers start over too. */
  resetOwn(prod: unknown, cust: unknown) {
    if (this.stash) this.stash = { prod, cust };
  }

  private restoreOwn() {
    if (!this.stash) return;
    this.applying = true;
    this.svc.production.load(this.stash.prod as never);
    this.svc.customers.load(this.stash.cust as never);
    this.applying = false;
    this.stash = null;
  }

  /** Called once connected. Guests ask the host for the world; the host is ready straight away. */
  start(isHost: boolean) {
    this.known.clear();
    if (isHost) {
      this.snapshotKnown();
      this.ready = true;
    } else {
      this.ready = false;
      this.send({ t: 'wreq' });
    }
  }

  /** Disconnected: guests get their own world back. */
  stop() {
    // (The game then switches you back to your own save and says so.)
    if (this.stash) this.restoreOwn();
    this.ready = false;
    this.known.clear();
    this.sentVariants.clear();
  }

  /**
   * The previous host left and you took over. If you were visiting their world, your own comes back
   * and everyone still in the room switches to it (returns ops to broadcast as a reset, or null).
   */
  becomeHost(): WorldOp[] | null {
    if (!this.stash) return null;
    this.restoreOwn();
    this.snapshotKnown();
    this.ready = true;
    this.svc.ui.toast("You're the host now, so the room is playing in your world. Your own equipment and plants are back.", 'good');
    return this.snapshot();
  }

  /** Full world for a newcomer (host only). */
  snapshot(): WorldOp[] {
    const ops: WorldOp[] = [];
    for (const [id, site] of this.svc.production.sites) {
      for (const st of site.stations) ops.push({ k: 'put', site: id, key: keyOf(st.kind, st.lx, st.lz), kind: st.kind, x: st.lx, z: st.lz, yaw: st.lyaw, d: st.save() });
      ops.push({ k: 'box', site: id, box: 'storage', slots: site.storage.toJSON() }, { k: 'box', site: id, box: 'delivery', slots: site.delivery.toJSON() });
    }
    const house = this.svc.world.starter;
    for (const r of ['back', 'front'] as const) if (house.isConverted(r)) ops.push({ k: 'room', room: r });
    const c = this.svc.customers;
    ops.push({ k: 'vars', list: [...this.svc.variants.variants.values()] });
    for (const p of c.profiles.values()) ops.push({ k: 'prof', d: p });
    for (const d of c.deals) ops.push({ k: 'deal', d });
    // Your supplier chat is yours alone (dead drops aren't shared).
    for (const t of c.threads.values()) if (t.key !== 'supplier') ops.push({ k: 'thr', d: t });
    return ops;
  }

  /** Guest receives the host's world: put your own aside and mirror theirs exactly. */
  applySnapshot(ops: WorldOp[]) {
    const first = !this.stash;
    if (first) this.stash = { prod: this.svc.production.save(), cust: this.svc.customers.toJSON() };
    // Customers are the host's too: start from a clean slate, then take theirs.
    const c = this.svc.customers;
    for (const d of c.deals) if (d.status === 'accepted') c.peds.release(c.person(d.person));
    c.deals.length = 0;
    c.threads.clear();
    this.applying = true;
    const keep = new Set(ops.filter((o): o is StationOp => o.k === 'put').map((o) => `${o.site}|${o.key}`));
    for (const [id, site] of this.svc.production.sites)
      for (const st of [...site.stations]) if (!keep.has(`${id}|${keyOf(st.kind, st.lx, st.lz)}`)) site.remove(st);
    this.applying = false;
    this.apply(ops);
    this.snapshotKnown();
    this.ready = true;
    this.svc.ui.toast(
      first
        ? "You're playing in the host's world, so you'll see their equipment and plants. Yours are saved and come back when you leave the room (or if you become host)."
        : 'The host changed, so the room switched to their world.',
      'info',
    );
  }

  apply(ops: WorldOp[]) {
    this.applying = true;
    try {
      for (const op of ops) {
        if (op.k === 'room') {
          this.svc.world.starter.convertRoom(op.room);
          continue;
        }
        if (op.k === 'vars') {
          this.svc.variants.merge(op.list);
          for (const v of op.list) this.sentVariants.add(v.key);
          continue;
        }
        if (op.k === 'prof' || op.k === 'deal' || op.k === 'thr') {
          this.applyCustomer(op);
          continue;
        }
        const site = this.svc.production.sites.get(op.site);
        if (!site) continue;
        const known = this.knownFor(op.site);
        if (op.k === 'box') {
          const box = op.box === 'storage' ? site.storage : site.delivery;
          while (box.slots.length < op.slots.length) (box.slots as (Stack | null)[]).push(null);
          box.load(op.slots as Stack[]);
          known.set(`#${op.box}`, signature(box.toJSON()));
        } else if (op.k === 'del') {
          const st = this.find(site, op.key);
          if (st) site.remove(st);
          known.delete(op.key);
        } else {
          let st = this.find(site, op.key);
          if (!st) st = site.place(op.kind, op.x, op.z, op.yaw) ?? undefined;
          if (!st) continue;
          st.load(op.d);
          known.set(op.key, signature(st.save()));
        }
      }
    } finally {
      this.applying = false;
    }
  }

  /** Looks for local changes and sends them (a few times a second). */
  update(dt: number) {
    if (!this.ready || this.applying) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    const ops: WorldOp[] = [];
    for (const [id, site] of this.svc.production.sites) {
      const known = this.knownFor(id);
      const seen = new Set<string>();
      for (const st of site.stations) {
        const key = keyOf(st.kind, st.lx, st.lz);
        seen.add(key);
        const d = st.save();
        const sig = signature(d);
        if (known.get(key) !== sig) {
          known.set(key, sig);
          ops.push({ k: 'put', site: id, key, kind: st.kind, x: st.lx, z: st.lz, yaw: st.lyaw, d });
        }
      }
      for (const key of [...known.keys()])
        if (!key.startsWith('#') && !seen.has(key)) {
          known.delete(key);
          ops.push({ k: 'del', site: id, key });
        }
      for (const box of ['storage', 'delivery'] as const) {
        const c = box === 'storage' ? site.storage : site.delivery;
        const slots = c.toJSON();
        const sig = signature(slots);
        if (known.get(`#${box}`) !== sig) {
          known.set(`#${box}`, sig);
          ops.push({ k: 'box', site: id, box, slots });
        }
      }
    }
    const house = this.svc.world.starter;
    for (const r of ['back', 'front'] as const) {
      const k = `#room-${r}`;
      const home = this.knownFor('home');
      if (house.isConverted(r) && !home.has(k)) {
        home.set(k, '1');
        ops.push({ k: 'room', room: r });
      }
    }
    // Products someone discovers are announced so everyone can use and sell them.
    const fresh = [...this.svc.variants.variants.values()].filter((v) => !this.sentVariants.has(v.key));
    if (fresh.length) {
      for (const v of fresh) this.sentVariants.add(v.key);
      ops.unshift({ k: 'vars', list: fresh });
    }
    // Customers: profiles, deals and message threads.
    const c = this.svc.customers;
    const ck = this.knownFor('#customers');
    for (const p of c.profiles.values()) {
      const sig = signature([p.unlocked, p.loyalty, p.deals, p.spent, p.need, p.refusedDay, p.craving]);
      if (ck.get(`p${p.idx}`) !== sig) {
        ck.set(`p${p.idx}`, sig);
        ops.push({ k: 'prof', d: p });
      }
    }
    for (const d of c.deals) {
      const sig = signature([d.status, d.price, d.units, d.expires, d.rounds, d.sent ? 1 : 0]);
      if (ck.get(`d${d.id}`) !== sig) {
        ck.set(`d${d.id}`, sig);
        ops.push({ k: 'deal', d });
      }
    }
    for (const t of c.threads.values()) {
      if (t.key === 'supplier') continue;
      const sig = `${t.msgs.length}|${t.msgs[t.msgs.length - 1]?.text ?? ''}`;
      if (ck.get(`t${t.key}`) !== sig) {
        ck.set(`t${t.key}`, sig);
        ops.push({ k: 'thr', d: t });
      }
    }
    if (ops.length) this.send({ t: 'w', ops });
  }

  /** Applies another player's customer change and keeps local side effects (where people wait) in step. */
  private applyCustomer(op: ProfOp | DealOp | ThreadOp) {
    const c = this.svc.customers;
    const ck = this.knownFor('#customers');
    if (op.k === 'prof') {
      const cur = c.profiles.get(op.d.idx);
      if (!cur) return;
      Object.assign(cur, op.d);
      ck.set(`p${cur.idx}`, signature([cur.unlocked, cur.loyalty, cur.deals, cur.spent, cur.need, cur.refusedDay, cur.craving]));
    } else if (op.k === 'deal') {
      const d = op.d;
      const cur = c.deals.find((x) => x.id === d.id);
      const was = cur?.status;
      const wasSent = cur?.sent;
      if (cur) Object.assign(cur, d);
      else {
        c.deals.unshift({ ...d });
        if (c.deals.length > 50) c.deals.pop();
      }
      c.bumpId(d.id);
      // The customer walks to (or leaves) the meeting point for everyone.
      const p = c.person(d.person);
      // (An arranged meet only sends them over close to the agreed time.)
      if (d.status === 'accepted' && was !== 'accepted' && (!d.at || d.sent)) c.peds.sendTo(p, d.meet.x, d.meet.z);
      else if (d.sent && cur && !wasSent) c.peds.sendTo(p, d.meet.x, d.meet.z);
      else if (was === 'accepted' && d.status !== 'accepted' && p.mode === 'wait') c.peds.release(p);
      ck.set(`d${d.id}`, signature([d.status, d.price, d.units, d.expires, d.rounds, d.sent ? 1 : 0]));
    } else {
      const t = op.d;
      const cur = c.threads.get(t.key);
      const added = t.msgs.length - (cur?.msgs.length ?? 0);
      const unread = (cur?.unread ?? 0) + Math.max(0, t.msgs.slice(-Math.max(0, added)).filter((m) => !m.me).length);
      c.threads.set(t.key, { ...t, unread });
      ck.set(`t${t.key}`, `${t.msgs.length}|${t.msgs[t.msgs.length - 1]?.text ?? ''}`);
    }
    c.version++;
  }

  private knownFor(site: string) {
    let m = this.known.get(site);
    if (!m) this.known.set(site, (m = new Map()));
    return m;
  }

  private find(site: Site, key: string) {
    return site.stations.find((s) => keyOf(s.kind, s.lx, s.lz) === key);
  }

  /** Marks everything currently in the world as already shared. */
  private snapshotKnown() {
    this.known.clear();
    for (const [id, site] of this.svc.production.sites) {
      const known = this.knownFor(id);
      for (const st of site.stations) known.set(keyOf(st.kind, st.lx, st.lz), signature(st.save()));
      known.set('#storage', signature(site.storage.toJSON()));
      known.set('#delivery', signature(site.delivery.toJSON()));
    }
    const house = this.svc.world.starter;
    for (const r of ['back', 'front'] as const) if (house.isConverted(r)) this.knownFor('home').set(`#room-${r}`, '1');
    const c = this.svc.customers;
    const ck = this.knownFor('#customers');
    for (const p of c.profiles.values()) ck.set(`p${p.idx}`, signature([p.unlocked, p.loyalty, p.deals, p.spent, p.need, p.refusedDay, p.craving]));
    for (const d of c.deals) ck.set(`d${d.id}`, signature([d.status, d.price, d.units, d.expires, d.rounds, d.sent ? 1 : 0]));
    for (const t of c.threads.values()) ck.set(`t${t.key}`, `${t.msgs.length}|${t.msgs[t.msgs.length - 1]?.text ?? ''}`);
    for (const v of this.svc.variants.variants.values()) this.sentVariants.add(v.key);
  }
}
