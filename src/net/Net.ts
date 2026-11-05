import * as THREE from 'three';
import type { Services } from '../core/Services';
import type { Interactable } from '../interaction/Interactable';
import type { Stack } from '../inventory/Inventory';
import type { CharacterInstance, CharacterPool, Outfit } from '../npc/Characters';
import { HumanoidRenderer } from '../npc/Humanoid';
import { ITEMS } from '../products/Catalog';
import { makeVehicleMesh, type VehicleType } from '../vehicles/Vehicles';

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
  private nextTid = 1;
  private far: HumanoidRenderer;
  onChange?: () => void;

  constructor(
    private svc: Services,
    private pool: CharacterPool,
  ) {
    this.far = new HumanoidRenderer(svc.scene, 8);
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

  connect(url: string, room: string, name: string, outfit: Outfit): Promise<string | null> {
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
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: this.name, outfit: this.outfit }));
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
    this.ws = null;
    this.status = 'offline';
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
        this.status = 'online';
        for (const p of m.players as { id: string; name: string; outfit: string }[]) this.add(p.id, p.name, p.outfit);
        this.system(`Joined room ${m.room}. ${this.players.size ? `${this.players.size} other player(s) here.` : 'Share the room code so friends can join.'}${this.isHost ? ' You are the host: your clock sets day and night.' : ''}`);
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
      case 'host':
        this.host = String(m.id);
        if (this.isHost) this.system('You are now the host.');
        break;
      case 'states': {
        const s = m.s as Record<string, NetState>;
        for (const [id, st] of Object.entries(s)) {
          const p = this.players.get(id);
          if (p) p.state = st;
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
        const t = this.svc.time;
        const mine = t.day * 1440 + t.minutes;
        const theirs = Number(m.day) * 1440 + Number(m.minutes);
        if (Math.abs(theirs - mine) > 2) {
          t.day = Number(m.day);
          t.minutes = Number(m.minutes);
        }
        break;
      }
      case 'trade': {
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
    this.send({ t: 'trade', to, tid, items, cash });
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
    if (this.isHost) {
      this.timeTimer -= dt;
      if (this.timeTimer <= 0) {
        this.timeTimer = 5;
        this.send({ t: 'time', day: this.svc.time.day, minutes: this.svc.time.minutes });
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
          p.car = makeVehicleMesh(st.v.type, st.v.c);
          p.carKey = key;
          this.svc.scene.add(p.car.group);
        }
        const g = p.car!.group;
        g.position.lerp(new THREE.Vector3(...st.v.p), p.car && g.position.lengthSq() ? k : 1);
        g.rotation.set(0, 0, 0);
        g.rotateY(st.v.yaw);
        g.rotateZ(st.v.pitch);
        g.rotateX(st.v.roll);
        p.pos.copy(g.position);
        if (p.char) {
          this.pool.release(p.char);
          p.char = null;
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
