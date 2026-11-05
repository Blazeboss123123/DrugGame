import type { Services } from '../core/Services';
import type { Stack } from '../inventory/Inventory';
import type { Site } from '../production/Production';

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
export type WorldOp = StationOp | DelOp | BoxOp | RoomOp;

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
  private stash: unknown = null;
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
    return this.stash ?? this.svc.production.save();
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
    if (this.stash) {
      this.applying = true;
      this.svc.production.load(this.stash as never);
      this.applying = false;
      this.stash = null;
      this.svc.ui.toast('Back in your own world.', 'info');
    }
    this.ready = false;
    this.known.clear();
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
    return ops;
  }

  /** Guest receives the host's world: put your own aside and mirror theirs exactly. */
  applySnapshot(ops: WorldOp[]) {
    if (!this.stash) this.stash = this.svc.production.save();
    this.applying = true;
    const keep = new Set(ops.filter((o): o is StationOp => o.k === 'put').map((o) => `${o.site}|${o.key}`));
    for (const [id, site] of this.svc.production.sites)
      for (const st of [...site.stations]) if (!keep.has(`${id}|${keyOf(st.kind, st.lx, st.lz)}`)) site.remove(st);
    this.applying = false;
    this.apply(ops);
    this.snapshotKnown();
    this.ready = true;
    this.svc.ui.toast("You're in the host's world: their equipment, plants and storage are shared with you.", 'good');
  }

  apply(ops: WorldOp[]) {
    this.applying = true;
    try {
      for (const op of ops) {
        if (op.k === 'room') {
          this.svc.world.starter.convertRoom(op.room);
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
    if (ops.length) this.send({ t: 'w', ops });
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
  }
}
