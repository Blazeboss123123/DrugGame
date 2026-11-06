import * as THREE from 'three';
import type { Services } from '../core/Services';
import type { Interactable } from '../interaction/Interactable';
import type { Stack } from '../inventory/Inventory';
import type { CharacterInstance, CharacterPool, Outfit } from '../npc/Characters';
import { HumanoidRenderer } from '../npc/Humanoid';
import { ITEMS } from '../products/Catalog';
import { makeVehicleMesh, type VehicleType } from '../vehicles/Vehicles';
import { WorldSync, type WorldOp } from './WorldSync';

/**
 * Co-op multiplayer client. Everyone shares the streets: you see each other walking and driving,
 * chat, trade items and cash, and the host's clock drives day and night for the whole room.
 * Each player keeps their own business, inventory and save.
 */

export interface NetState {
  p: [number, number, number];
  yaw: number;
  a: 'idle' | 'walk' | 'run';
  v?: { type: VehicleType; c: number; p: [number, number, number]; yaw: number; pitch: number; roll: number } | null;
}

export interface PublicRoom {
  code: string;
  name: string;
  host: string;
  players: number;
  max: number;
  names: string[];
  day: number;
  minutes: number;
  since: number;
}

export interface ChatLine {
  name: string;
  text: string;
  at: number;
  system?: boolean;
}

export interface TradeOffer {
  tid: number;
  from: string;
  name: string;
  items: Stack[];
  cash: number;
}

class RemotePlayer implements Interactable {
  readonly highlight: THREE.Mesh[] = [];
  readonly maxDistance = 3;
  state: NetState | null = null;
  pos = new THREE.Vector3();
  yaw = 0;
  char: CharacterInstance | null = null;
  tag: THREE.Sprite;
  car: ReturnType<typeof makeVehicleMesh> | null = null;
  carKey = '';
  /** Car smoothing: last network position, its arrival time and the estimated velocity. */
  carLast = new THREE.Vector3();
  carAt = 0;
  carVel = new THREE.Vector3();
  carYaw = 0;
  body: import('../physics/Physics').RigidBody;
  phase = 0;
  constructor(
    readonly id: string,
    public name: string,
    public outfit: Outfit,
    private svc: Services,
    readonly slot: number,
  ) {
    this.tag = nameTag(name);
    svc.scene.add(this.tag);
    const R = svc.physics.R;
    this.body = svc.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -900, 0));
    const col = svc.physics.world.createCollider(R.ColliderDesc.capsule(0.55, 0.3), this.body);
    svc.physics.tag(col, { interactable: this });
  }
  get id_() {
    return this.id;
  }
  prompt() {
    return this.state?.v ? null : `Trade with ${this.name}`;
  }
  interact() {
    this.svc.ui.panels.openTrade(this.id, this.name);
  }
  dispose(pool: CharacterPool) {
    if (this.char) pool.release(this.char);
    this.svc.scene.remove(this.tag);
    if (this.car) this.svc.scene.remove(this.car.group);
    this.body.setTranslation({ x: 0, y: -900, z: 0 }, true);
  }
}

function nameTag(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(14,17,21,0.75)';
  g.beginPath();
  g.roundRect(8, 10, 240, 44, 10);
  g.fill();
  g.fillStyle = '#f2a23a';
  g.font = '700 28px Archivo, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33, 230);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: true, transparent: true }));
  s.scale.set(1.4, 0.35, 1);
  return s;
}

export class Net {
  ws: WebSocket | null = null;
  id = '';
  host = '';
  room = '';
  /** Name of the world (room) you're in, and whether it's listed publicly. */
  world = '';
  isPublic = true;
  name = 'Player';
  outfit: Outfit = 'Casual_Hoodie';
  status: 'offline' | 'connecting' | 'online' = 'offline';
  error = '';
  readonly players = new Map<string, RemotePlayer>();
  readonly chat: ChatLine[] = [];
  readonly offers: TradeOffer[] = [];
  /** Items held back while an outgoing trade waits for an answer. */
  private escrow = new Map<number, { to: string; items: Stack[]; cash: number; at: number }>();
  private sendTimer = 0;
  private timeTimer = 0;
  private pedTimer = 0;
  private nextTid = 1;
  private far: HumanoidRenderer;
  onChange?: () => void;
  /** Host: a guest asked to jump the clock to this hour. */
  onTimeRequest?: (hour: number) => void;
  /** Shared equipment, plants and storage for everyone in the room. */
  readonly sync: WorldSync;
  /** Whether the host allows cheats in this room. */
  cheatsAllowed = true;

  constructor(
    private svc: Services,
    private pool: CharacterPool,
  ) {
    this.far = new HumanoidRenderer(svc.scene, 8);
    this.sync = new WorldSync(svc, (m) => this.send(m));
  }

  get online() {
    return this.status === 'online';
  }

  get isHost() {
    return this.online && this.id === this.host;
  }

  defaultUrl(): string {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      if (!/claude\.ai|claudeusercontent|anthropic/.test(location.host)) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    }
    return 'ws://localhost:8080/ws';
  }

  /** Host: send the clock to everyone right now (also after any time jump). */
  pushTime() {
    if (!this.isHost) return;
    this.timeTimer = 1;
    const t = this.svc.time;
    this.send({ t: 'time', day: t.day, minutes: t.minutes, speed: t.speed });
  }

  /** Guest: ask the host to change everyone's time (cheat menu). */
  requestTime(hour: number) {
    this.send({ t: 'timeset', hour });
  }

  /** Host only: allow or block cheats for everyone in the room. */
  setCheats(on: boolean) {
    if (!this.isHost) return;
    this.cheatsAllowed = on;
    this.send({ t: 'cfg', cheats: on });
  }

  /** Sets every player's cash (yours included) to $0. Returns how many other players were hit. */
  wipeAllMoney(): number {
    this.svc.economy.forfeit(this.svc.economy.cash, 'Money wiped');
    if (!this.online) return 0;
    this.send({ t: 'wipe' });
    this.system("You wiped everyone's money.");
    return this.players.size;
  }

  /** Public worlds currently running on the server (for the world browser). */
  async listRooms(url: string): Promise<{ rooms: PublicRoom[]; online: number } | { error: string }> {
    try {
      const http = url.replace(/^ws(s?):/, 'http$1:').replace(/\/ws\/?$/, '/rooms');
      const res = await fetch(http, { cache: 'no-store' });
      if (!res.ok) return { error: `Server answered ${res.status}.` };
      return (await res.json()) as { rooms: PublicRoom[]; online: number };
    } catch {
      return { error: "Can't reach the multiplayer server." };
    }
  }

  connect(url: string, room: string, name: string, outfit: Outfit, opts: { world?: string; public?: boolean } = {}): Promise<string | null> {
    this.disconnect();
    this.name = name.trim().slice(0, 20) || 'Player';
    this.outfit = outfit;
    this.room = room.trim().toUpperCase().slice(0, 12) || 'HARLOW';
    this.status = 'connecting';
    this.error = '';
    return new Promise((resolve) => {
      let settled = false;
      const done = (err: string | null) => {
        if (settled) return;
        settled = true;
        resolve(err);
      };
      try {
        const ws = new WebSocket(`${url}?room=${encodeURIComponent(this.room)}`);
        this.ws = ws;
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: this.name, outfit: this.outfit, world: opts.world, public: opts.public, cheats: this.svc.settings.allowCheats }));
        ws.onmessage = (e) => {
          let m: Record<string, unknown>;
          try {
            m = JSON.parse(String(e.data));
          } catch {
            return;
          }
          if (m.t === 'welcome') done(null);
          if (m.t === 'error') {
            this.error = String(m.text);
            done(this.error);
          }
          this.handle(m);
        };
        ws.onerror = () => {
          this.error = 'Could not reach the server.';
          done(this.error);
        };
        ws.onclose = () => {
          const was = this.status;
          this.cleanup();
          if (was === 'online') this.system('Disconnected from the server.');
          done(this.error || 'Connection closed.');
        };
        setTimeout(() => done(this.status === 'online' ? null : 'Timed out connecting to the server.'), 8000);
      } catch (err) {
        this.status = 'offline';
        this.error = 'This page is not allowed to open network connections. Run the game from the multiplayer server (see README).';
        done(this.error);
        void err;
      }
    });
  }

  disconnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.cleanup();
  }

  private cleanup() {
    // Return anything still held for unanswered trades.
    for (const [tid] of this.escrow) this.refund(tid);
    for (const p of this.players.values()) p.dispose(this.pool);
    this.players.clear();
    this.sync.stop();
    if (this.svc.customers?.peds) {
      this.svc.customers.peds.remote = false;
      this.svc.customers.peds.onEvent = undefined;
    }
    this.ws = null;
    this.status = 'offline';
    // Back to your own clock speed.
    this.svc.time.setDayLength(this.svc.settings.dayLength);
    this.onChange?.();
  }

  private send(m: unknown) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private system(text: string) {
    this.chat.push({ name: '', text, at: performance.now(), system: true });
    if (this.chat.length > 50) this.chat.shift();
    this.onChange?.();
  }

  private add(id: string, name: string, outfit: string) {
    if (this.players.has(id)) return;
    this.players.set(id, new RemotePlayer(id, name, outfit as Outfit, this.svc, this.players.size));
    this.svc.interaction.register(this.players.get(id)!);
  }

  private handle(m: Record<string, unknown>) {
    switch (m.t) {
      case 'welcome': {
        this.id = String(m.id);
        this.host = String(m.host);
        this.world = String(m.world ?? this.room);
        this.isPublic = m.public !== false;
        this.cheatsAllowed = m.cheats !== false;
        // Guests take the room's clock straight away (the host keeps its own).
        if (String(m.id) !== String(m.host) && Number(m.day) > 0) {
          this.svc.time.day = Number(m.day);
          this.svc.time.minutes = Number(m.minutes) || 0;
        }
        this.status = 'online';
        for (const p of m.players as { id: string; name: string; outfit: string }[]) this.add(p.id, p.name, p.outfit);
        this.sync.start(this.isHost);
        this.system(`Joined ${this.world} (code ${m.room}). ${this.players.size ? `${this.players.size} other player(s) here.` : this.isPublic ? 'It is listed in the world browser, or share the code.' : 'Private world: share the code so friends can join.'}${this.isHost ? ' You are the host: your clock sets day and night.' : ''}`);
        break;
      }
      case 'join':
        this.add(String(m.id), String(m.name), String(m.outfit));
        this.system(`${m.name} joined.`);
        this.svc.audio.play('ui');
        break;
      case 'leave': {
        const p = this.players.get(String(m.id));
        if (p) {
          p.dispose(this.pool);
          const i = this.svc.interaction.items.indexOf(p);
          if (i >= 0) this.svc.interaction.items.splice(i, 1);
          this.players.delete(p.id);
          this.system(`${p.name} left.`);
        }
        break;
      }
      case 'w':
        // A reset replaces the whole world (the host changed); otherwise it's an incremental change.
        if (m.reset) this.sync.applySnapshot(m.ops as WorldOp[]);
        else if (this.sync.ready) this.sync.apply(m.ops as WorldOp[]);
        break;
      case 'cfg': {
        const was = this.cheatsAllowed;
        this.cheatsAllowed = m.cheats !== false;
        if (was !== this.cheatsAllowed) {
          this.system(`${m.name} ${this.cheatsAllowed ? 'turned cheats on' : 'turned cheats off'} for this world.`);
          if (!this.cheatsAllowed && !this.isHost) this.svc.ui.toast('The host turned cheats off.', 'warn');
        }
        this.onChange?.();
        break;
      }
      case 'wipe': {
        const lost = this.svc.economy.forfeit(this.svc.economy.cash, `Money wiped by ${m.name}`);
        this.system(`${m.name} wiped everyone's money.`);
        this.svc.ui.toast(`${m.name} wiped everyone's money${lost ? ` · you lost $${lost.toLocaleString()}` : ''}.`, 'warn');
        break;
      }
      case 'wreq':
        if (this.isHost) this.send({ t: 'wsnap', to: m.from, ops: this.sync.snapshot() });
        break;
      case 'pev': {
        const from = this.players.get(String(m.from));
        this.svc.customers.peds?.applyEvent(m as unknown as import('../npc/Pedestrians').PedEvent, from ? { x: from.pos.x, z: from.pos.z } : undefined);
        break;
      }
      case 'peds':
        if (!this.isHost) this.svc.customers.peds?.applyRemote(m.p as number[]);
        break;
      case 'wsnap':
        this.sync.applySnapshot(m.ops as WorldOp[]);
        break;
      case 'host':
        this.host = String(m.id);
        if (this.isHost) {
          this.system('You are now the host. The room now plays in your world.');
          // Keep the room's current time, but run it at your own day length from now on.
          const len = this.svc.settings.dayLength;
          this.svc.time.speed = len === 'real' ? 1 / 60 : 1440 / (len * 60);
          this.pushTime();
          const ops = this.sync.becomeHost();
          if (ops) this.send({ t: 'w', ops, reset: true });
        }
        break;
      case 'states': {
        const s = m.s as Record<string, NetState>;
        for (const [id, st] of Object.entries(s)) {
          const p = this.players.get(id);
          if (!p) continue;
          if (st.v) {
            // Estimate the car's velocity so it can be drawn slightly ahead between updates.
            const now = performance.now();
            const np = new THREE.Vector3(...st.v.p);
            const dtS = (now - p.carAt) / 1000;
            if (p.state?.v && dtS > 0.02 && dtS < 0.5) p.carVel.lerp(np.clone().sub(p.carLast).divideScalar(dtS), 0.6);
            else p.carVel.set(0, 0, 0);
            p.carLast.copy(np);
            p.carAt = now;
          }
          p.state = st;
        }
        break;
      }
      case 'chat':
        this.chat.push({ name: String(m.name), text: String(m.text), at: performance.now() });
        if (this.chat.length > 50) this.chat.shift();
        if (m.id !== this.id) this.svc.audio.play('ui');
        this.onChange?.();
        break;
      case 'time': {
        // The host's clock is the world's clock: same time, same speed for everyone.
        if (this.isHost) break;
        const t = this.svc.time;
        const sp = Number(m.speed);
        if (sp > 0 && sp < 10) t.speed = sp;
        const mine = t.day * 1440 + t.minutes;
        const theirs = Number(m.day) * 1440 + Number(m.minutes);
        if (Number.isFinite(theirs) && Math.abs(theirs - mine) > 0.25) {
          t.day = Number(m.day);
          t.minutes = Number(m.minutes);
        }
        break;
      }
      case 'timeset': {
        // A guest used a time cheat: the host applies it for the whole room.
        if (!this.isHost || !this.cheatsAllowed) break;
        const h = Number(m.hour);
        if (!(h >= 0 && h < 24)) break;
        this.onTimeRequest?.(h);
        this.system(`${m.name} set the time to ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} for everyone.`);
        break;
      }
      case 'trade': {
        this.svc.variants.merge(m.variants as import('../products/Catalog').Variant[]);
        const offer: TradeOffer = { tid: Number(m.tid), from: String(m.from), name: String(m.name), items: (m.items as Stack[]).filter((x) => ITEMS[x.id] && x.qty > 0), cash: Math.max(0, Number(m.cash) || 0) };
        this.offers.push(offer);
        this.svc.ui.panels.openTradeOffer(offer);
        break;
      }
      case 'trade-reply': {
        const tid = Number(m.tid);
        const e = this.escrow.get(tid);
        if (!e) break;
        if (m.accept) {
          this.escrow.delete(tid);
          this.svc.ui.toast(`${m.name} accepted your trade.`, 'good');
        } else {
          this.refund(tid);
          this.svc.ui.toast(`${m.name} declined your trade. Items returned.`, 'warn');
        }
        break;
      }
    }
  }

  say(text: string) {
    const t = text.trim();
    if (t && this.online) this.send({ t: 'chat', text: t });
  }

  /** Offer items (by inventory slot) and cash to another player. Items are held until they answer. */
  offerTrade(to: string, slots: { slot: number; qty: number }[], cash: number): string {
    if (!this.online) return 'Not connected.';
    const inv = this.svc.inventory;
    const items: Stack[] = [];
    if (cash > 0 && cash > this.svc.economy.cash) return 'You don’t have that much cash.';
    for (const { slot, qty } of slots) {
      const s = inv.slots[slot];
      if (!s || qty <= 0 || qty > s.qty) return 'Some of those items are no longer in your inventory.';
    }
    for (const { slot, qty } of slots) {
      const got = inv.removeAt(slot, qty);
      if (got) items.push(got);
    }
    if (cash > 0) this.svc.economy.forfeit(cash, 'Trade (held)');
    const tid = this.nextTid++;
    this.escrow.set(tid, { to, items, cash, at: performance.now() });
    // Send the product definitions along, so the other player's game knows what these items are.
    const variants = items.map((it) => (it.v ? this.svc.variants.byKey(it.v) : undefined)).filter(Boolean);
    this.send({ t: 'trade', to, tid, items, cash, variants });
    return 'Offer sent. Your items are held until they answer.';
  }

  private refund(tid: number) {
    const e = this.escrow.get(tid);
    if (!e) return;
    this.escrow.delete(tid);
    for (const it of e.items) {
      const left = this.svc.inventory.add(it.id, it.qty, it.v);
      if (left > 0) this.svc.production.home.storage.add(it.id, left, it.v);
    }
    if (e.cash > 0) this.svc.economy.earn(e.cash, 'Trade returned', false);
  }

  answerTrade(tid: number, accept: boolean): string {
    const i = this.offers.findIndex((o) => o.tid === tid);
    if (i < 0) return 'That offer is gone.';
    const o = this.offers[i];
    this.offers.splice(i, 1);
    if (accept) {
      const space = o.items.every((it) => this.svc.inventory.space(it.id, it.v) >= it.qty);
      if (!space) {
        this.send({ t: 'trade-reply', to: o.from, tid, accept: false });
        return 'Not enough room in your inventory, so the trade was declined.';
      }
      for (const it of o.items) this.svc.inventory.add(it.id, it.qty, it.v);
      if (o.cash > 0) this.svc.economy.earn(o.cash, `Trade from ${o.name}`, false);
    }
    this.send({ t: 'trade-reply', to: o.from, tid, accept });
    return accept ? `Trade with ${o.name} complete.` : 'Trade declined.';
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number) {
    if (!this.online) return;
    this.sync.update(dt);
    // Outgoing state at ~12 Hz.
    this.sendTimer -= dt;
    if (this.sendTimer <= 0) {
      this.sendTimer = 1 / 12;
      const pl = this.svc.player;
      const v = this.svc.vehicles.driving;
      const speed = Math.hypot(pl.velocity.x, pl.velocity.z);
      const st: NetState = {
        p: [round(pl.position.x), round(pl.position.y), round(pl.position.z)],
        yaw: round(pl.yaw),
        a: speed > 5.5 ? 'run' : speed > 0.6 ? 'walk' : 'idle',
        v: v ? { type: v.type, c: v.color, p: [round(v.pos.x), round(v.pos.y), round(v.pos.z)], yaw: round(v.yaw), pitch: round(v.pitch), roll: round(v.roll) } : null,
      };
      this.send({ t: 'st', s: st });
    }
    // The host's pedestrians are the real ones: everyone else sees them where the host does.
    if (this.isHost && this.players.size) {
      this.pedTimer -= dt;
      if (this.pedTimer <= 0) {
        this.pedTimer = 0.25;
        const peds = this.svc.customers.peds;
        if (peds) this.send({ t: 'peds', p: peds.snapshot() });
      }
    }
    const peds = this.svc.customers.peds;
    if (peds) {
      peds.remote = this.online && !this.isHost;
      peds.onEvent = (e) => this.send({ t: 'pev', ...e });
    }
    if (this.isHost) {
      this.timeTimer -= dt;
      if (this.timeTimer <= 0) {
        this.pushTime();
      }
    }
    // Trades nobody answered within a minute are returned.
    for (const [tid, e] of this.escrow)
      if (performance.now() - e.at > 60000) {
        this.refund(tid);
        this.svc.ui.toast('Your trade offer timed out. Items returned.', 'info');
      }
    this.renderPlayers(dt);
  }

  private renderPlayers(dt: number) {
    const cam = this.svc.player.position;
    for (const p of this.players.values()) {
      const st = p.state;
      if (!st) continue;
      const k = 1 - Math.exp(-12 * dt);
      if (st.v) {
        // In a vehicle: draw the car, hide the body.
        const key = `${st.v.type}:${st.v.c}`;
        if (p.carKey !== key) {
          if (p.car) this.svc.scene.remove(p.car.group);
          p.car = makeVehicleMesh(st.v.type, st.v.c, true);
          p.carKey = key;
          this.svc.scene.add(p.car.group);
          p.car.group.position.set(...st.v.p);
          p.carYaw = st.v.yaw;
        }
        const g = p.car!.group;
        // Draw where the car is now (last update + velocity × time since), easing towards it.
        const ahead = Math.min(0.25, (performance.now() - p.carAt) / 1000);
        _v.copy(p.carLast).addScaledVector(p.carVel, ahead);
        if (g.position.distanceTo(_v) > 12) g.position.copy(_v);
        else g.position.lerp(_v, 1 - Math.exp(-18 * dt));
        let dy = st.v.yaw - p.carYaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        p.carYaw += dy * (1 - Math.exp(-14 * dt));
        g.rotation.set(0, 0, 0);
        g.rotateY(p.carYaw);
        g.rotateZ(st.v.pitch);
        g.rotateX(st.v.roll);
        g.updateMatrixWorld();
        p.pos.copy(g.position);
        // The driver, seated behind the wheel and visible through the windows.
        const dist = g.position.distanceTo(cam);
        if (dist < 90 && this.pool.ready && !p.char) {
          p.char = this.pool.acquire(p.outfit, p);
          p.char?.setLook({ skin: 0xd9a47e, hair: 0x2b1d14, hue: 0 });
        } else if (dist > 110 && p.char) {
          this.pool.release(p.char);
          p.char = null;
        }
        if (p.char) {
          const seat = SEATS[st.v.type] ?? SEATS.hatch;
          p.char.sit = 1;
          p.char.root.position.copy(g.localToWorld(_v.set(seat.x, seat.y - p.char.hipHeight, seat.z)));
          p.char.root.quaternion.copy(g.quaternion).multiply(_q.setFromAxisAngle(_up, Math.PI / 2));
          p.char.play('Idle', 0.2);
          p.char.update(dt);
        }
        this.far.hide(p.slot);
        p.body.setNextKinematicTranslation({ x: 0, y: -900, z: 0 });
        p.tag.position.set(g.position.x, g.position.y + 2.4, g.position.z);
        continue;
      }
      if (p.car) {
        this.svc.scene.remove(p.car.group);
        p.car = null;
        p.carKey = '';
        if (p.char) {
          p.char.sit = 0;
          p.char.root.rotation.set(0, p.yaw, 0);
        }
      }
      const target = new THREE.Vector3(...st.p);
      if (p.pos.distanceTo(target) > 8) p.pos.copy(target);
      else p.pos.lerp(target, k);
      // Remote yaw is the camera yaw; the model faces +z so turn it around.
      let d = st.yaw + Math.PI - p.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      p.yaw += d * k;
      p.body.setNextKinematicTranslation({ x: p.pos.x, y: p.pos.y + 0.86, z: p.pos.z });
      p.tag.position.set(p.pos.x, p.pos.y + 2.25, p.pos.z);
      const dist = p.pos.distanceTo(cam);
      if (dist < 70 && this.pool.ready && !p.char) {
        p.char = this.pool.acquire(p.outfit, p);
        p.char?.setLook({ skin: 0xd9a47e, hair: 0x2b1d14, hue: 0 });
      }
      if (p.char) {
        p.char.root.position.copy(p.pos);
        p.char.root.rotation.y = p.yaw;
        p.char.play(st.a === 'run' ? 'Run' : st.a === 'walk' ? 'Walk' : 'Idle', 0.2);
        p.char.update(dt);
        this.far.hide(p.slot);
      } else {
        p.phase += st.a === 'idle' ? 0 : dt * 7;
        this.far.setLook(p.slot, { skin: 0xd9a47e, shirt: 0xf2a23a, pants: 0x2a2f3a, hair: 0x2b1d14 });
        this.far.pose(p.slot, { x: p.pos.x, y: p.pos.y, z: p.pos.z, yaw: p.yaw, phase: p.phase, swing: st.a === 'idle' ? 0 : 0.6 });
      }
    }
    this.far.commit();
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
/** Driver's seat in car space (+x forward, +z right): hip position for each body style. */
const SEATS: Record<string, { x: number; y: number; z: number }> = {
  hatch: { x: 0.05, y: 0.9, z: 0.12 },
  coupe: { x: -0.15, y: 0.62, z: 0.12 },
  van: { x: 1.15, y: 1.15, z: 0.25 },
};
