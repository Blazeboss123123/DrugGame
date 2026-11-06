import { DISTRICTS, streetNameAt, type District } from '../world/CityPlan';
import type { UIHost } from './UI';
import type { Services } from '../core/Services';
import { FAMILIES } from '../products/Catalog';
import { iconFor, stackName } from './Icons';
import { Minimap } from './Minimap';

/** On-screen heads-up display: crosshair, prompt, objective, clock, compass, location and toasts. */
/** Only writes to the page when the text actually changed. */
function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}
const htmlCache = new WeakMap<HTMLElement, string>();
function setHtml(el: HTMLElement, html: string) {
  if (htmlCache.get(el) === html) return;
  htmlCache.set(el, html);
  el.innerHTML = html;
}

export class HUD {
  private slowTimer = 0;
  private wpArrow?: HTMLElement;
  private wpText?: HTMLElement;
  private root: HTMLElement;
  private crosshair: HTMLElement;
  private prompt: HTMLElement;
  private objText: HTMLElement;
  private objMeta: HTMLElement;
  private objective: HTMLElement;
  private time: HTMLElement;
  private day: HTMLElement;
  private street: HTMLElement;
  private area: HTMLElement;
  private strip: HTMLElement;
  private banner: HTMLElement;
  private bannerName: HTMLElement;
  private bannerKind: HTMLElement;
  private toasts: HTMLElement;
  private fps: HTMLElement;
  private hint: HTMLElement;
  private bannerTimer = 0;
  private hotbar!: HTMLElement;
  private cash!: HTMLElement;
  private wanted!: HTMLElement;
  private dealTrack!: HTMLElement;
  private notifyEl!: HTMLElement;
  private notifyTimer = 0;
  private svc?: Services;
  private heldName!: HTMLElement;
  private wpEl!: HTMLElement;
  private chatFeed!: HTMLElement;
  chatInput!: HTMLInputElement;
  waypoint: { x: number; z: number } | null = null;
  minimap: Minimap | null = null;
  private chase = false;
  /** Opens the full-screen map (set by UI). */
  onOpenMap: () => void = () => {};
  private chatSeen = 0;
  private lastPrompt = '';
  private fpsFrames = 0;
  private fpsTime = 0;

  constructor(layer: HTMLElement, private host: UIHost) {
    const r = document.createElement('div');
    r.className = 'hud';
    r.innerHTML = `
      <div class="crosshair"></div>
      <div class="prompt" hidden></div>
      <div class="objective"><div class="meta"><span class="eyebrow">Objective</span><span class="obj-meta"></span></div><div class="text"></div></div>
      <div class="compass"><div class="strip"></div></div>
      <div class="clock"><div class="time">--:--</div><div class="day"></div></div>
      <div class="location"><div class="street"></div><div class="area"></div></div>
      <div class="banner"><div class="name"></div><div class="kind"></div></div>
      <div class="toasts"></div>
      <div class="fps" hidden></div>
      <div class="hint" hidden></div>
      <div class="wanted" hidden><span class="siren"></span><span class="wanted-text">Police pursuit</span></div>
      <div class="deal-track" hidden></div>
      <div class="notify" hidden></div>
      <div class="waypoint" hidden><span class="wp-arrow">▲</span><span class="wp-text"></span></div>
      <div class="chat-feed"></div>
      <input class="chat-input" id="chat-input" maxlength="200" placeholder="Say something to the room (Enter to send, Esc to cancel)" hidden>
      <div class="bottom-bar"><div class="hotbar"></div><div class="cash"><span>Cash</span><strong>$0</strong></div></div>`;
    layer.appendChild(r);
    this.root = r;
    const q = (s: string) => r.querySelector(s) as HTMLElement;
    this.crosshair = q('.crosshair');
    this.prompt = q('.prompt');
    this.objective = q('.objective');
    this.objText = q('.objective .text');
    this.objMeta = q('.obj-meta');
    this.time = q('.clock .time');
    this.day = q('.clock .day');
    this.street = q('.location .street');
    this.area = q('.location .area');
    this.strip = q('.compass .strip');
    this.banner = q('.banner');
    this.bannerName = q('.banner .name');
    this.bannerKind = q('.banner .kind');
    this.toasts = q('.toasts');
    this.fps = q('.fps');
    this.hint = q('.hint');
    this.hotbar = q('.hotbar');
    this.cash = q('.cash strong');
    this.wanted = q('.wanted');
    this.dealTrack = q('.deal-track');
    this.notifyEl = q('.notify');
    this.wpEl = q('.waypoint');
    this.chatFeed = q('.chat-feed');
    this.chatInput = q('.chat-input') as HTMLInputElement;
    this.heldName = document.createElement('div');
    this.heldName.className = 'held-name';
    r.querySelector('.bottom-bar')!.prepend(this.heldName);
    this.buildCompass();
    host.bus.on('district:enter', ({ district }) => this.showBanner(district));
    host.bus.on('objectives:changed', () => this.refreshObjective());
    this.refreshObjective();
  }

  bind(svc: Services) {
    this.svc = svc;
    svc.inventory.onChange(() => this.renderHotbar());
    svc.bus.on('money:changed', (m) => {
      this.cash.textContent = `$${m.cash.toLocaleString()}`;
      if (m.delta) {
        const f = document.createElement('span');
        f.className = `cash-float ${m.delta > 0 ? 'pos' : 'neg'}`;
        f.textContent = `${m.delta > 0 ? '+' : '−'}$${Math.abs(m.delta).toLocaleString()}`;
        this.cash.parentElement!.appendChild(f);
        setTimeout(() => f.remove(), 1600);
      }
    });
    svc.bus.on('police:state', (p) => (this.chase = p.state === 'chase'));
    this.minimap = new Minimap(this.root, svc, () => this.waypoint, () => this.onOpenMap());
    this.renderHotbar();
  }

  renderHotbar() {
    const svc = this.svc;
    if (!svc) return;
    let html = '';
    for (let i = 0; i < 8; i++) {
      const s = svc.inventory.slots[i];
      html += `<div class="hslot${i === svc.hotbar.selected ? ' selected' : ''}"><span class="slot-key">${i < 4 ? i + 1 : i + 2}</span>${s ? `<img src="${iconFor(s, svc.variants)}" alt="">${s.qty > 1 ? `<span class="qty">${s.qty}</span>` : ''}` : ''}</div>`;
    }
    this.hotbar.innerHTML = html;
    const h = svc.inventory.slots[svc.hotbar.selected];
    const takeable = h && svc.substances?.canTake(h.id);
    this.heldName.textContent = h ? `${stackName(h, svc.variants)}${takeable ? '  ·  C to take' : ''}` : '';
  }

  /** Direction the player (or their car) faces: 0 = north, clockwise. */
  heading(): number {
    const svc = this.svc;
    if (!svc) return 0;
    return svc.vehicles.driving ? Math.PI / 2 - svc.vehicles.driving.yaw : -svc.player.yaw;
  }

  /** Red CURFEW badge on the clock while it's in force (amber shortly before). */
  setCurfew(active: boolean, soon: boolean) {
    const state = active ? 'on' : soon ? 'soon' : '';
    if (this.root.dataset.curfew === state) return;
    this.root.dataset.curfew = state;
    let b = this.root.querySelector('.curfew-badge') as HTMLElement | null;
    if (!b) {
      b = document.createElement('div');
      b.className = 'curfew-badge';
      this.root.querySelector('.clock')!.appendChild(b);
    }
    b.hidden = !state;
    b.className = `curfew-badge ${state}`;
    b.textContent = active ? 'Curfew · until 05:00' : 'Curfew at 23:00';
  }

  setWaypoint(x: number, z: number) {
    this.waypoint = { x, z };
  }

  /** Renders recent multiplayer chat lines (they fade after a while). */
  renderChat(lines: { name: string; text: string; at: number; system?: boolean }[]) {
    const now = performance.now();
    const recent = lines.slice(-6);
    setHtml(this.chatFeed, recent
      .map((l) => {
        const age = (now - l.at) / 1000;
        const op = this.chatInput.hidden ? Math.max(0, Math.min(1, (16 - age) / 3)) : 1;
        const t = document.createElement('div');
        t.textContent = l.text;
        const n = document.createElement('div');
        n.textContent = l.name;
        return `<div class="cl${l.system ? ' sys' : ''}" style="opacity:${op.toFixed(2)}">${l.system ? '' : `<strong>${n.innerHTML}</strong> `}${t.innerHTML}</div>`;
      })
      .join(''));
    this.chatSeen = lines.length;
  }

  notify(text: string) {
    this.notifyEl.hidden = false;
    this.notifyEl.textContent = text;
    this.notifyTimer = 5;
  }

  setVisible(v: boolean) {
    this.root.hidden = !v;
  }

  setHint(text: string | null) {
    this.hint.hidden = !text;
    if (text) this.hint.textContent = text;
  }

  private buildCompass() {
    // Two full turns so the strip can scroll seamlessly. 15° per tick, 30 px per tick.
    const labels: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    let html = '';
    for (let k = 0; k < 48; k++) {
      const deg = (k * 15) % 360;
      const l = labels[deg];
      html += l ? `<span class="cardinal ${deg === 0 ? 'n' : ''}">${l}</span>` : `<span>·</span>`;
    }
    this.strip.innerHTML = html;
  }

  /** Heading in radians where 0 faces north (-z) and values increase clockwise. */
  setHeading(heading: number) {
    const deg = ((((heading * 180) / Math.PI) % 360) + 360) % 360;
    const pxPerDeg = 30 / 15;
    const width = (this.strip.parentElement as HTMLElement).clientWidth;
    const x = width / 2 - (deg + 360) * pxPerDeg - 15;
    this.strip.style.transform = `translateX(${x}px)`;
  }

  setPrompt(text: string | null, keys: [string, string][] = []) {
    const key = text ? text + keys.map((k) => k.join()).join() : '';
    this.crosshair.classList.toggle('active', !!text);
    if (key === this.lastPrompt) return;
    this.lastPrompt = key;
    if (!text) {
      this.prompt.hidden = true;
      return;
    }
    this.prompt.hidden = false;
    this.prompt.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = text;
    if (keys.length === 1 && !keys[0][1]) {
      const k = document.createElement('kbd');
      k.textContent = keys[0][0];
      this.prompt.append(k, label);
      return;
    }
    this.prompt.append(label);
    for (const [k, l] of keys) {
      const pair = document.createElement('span');
      pair.className = 'pair';
      const kb = document.createElement('kbd');
      kb.textContent = k;
      const t = document.createElement('span');
      t.textContent = l;
      pair.append(kb, t);
      this.prompt.append(pair);
    }
  }

  refreshObjective() {
    const st = this.host.state;
    const cur = st.current();
    if (!cur) {
      this.objText.textContent = 'Explore Harlow. More of the city opens up in the next update.';
      this.objMeta.textContent = 'All done';
      return;
    }
    const idx = st.objectives.indexOf(cur) + 1;
    this.objText.innerHTML = `${cur.text}<span class="obj-hint">${cur.hint}</span>`;
    this.objMeta.textContent = `${idx}/${st.objectives.length}${cur.progress ? ' · ' + cur.progress() : ''}`;
  }

  private showBanner(d: District) {
    this.bannerName.textContent = DISTRICTS[d].name;
    this.bannerKind.textContent = DISTRICTS[d].kind;
    this.banner.classList.add('show');
    this.bannerTimer = 3.2;
  }

  toast(text: string, kind: 'info' | 'good' | 'warn') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = text;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4700);
  }

  update(dt: number, x: number, z: number, district: District | null) {
    // Text and lists refresh 8 times a second, and only touch the page when something changed:
    // rewriting the DOM every frame forces the browser to re-lay-out the HUD 60+ times a second.
    this.slowTimer -= dt;
    const slow = this.slowTimer <= 0;
    if (slow) {
      this.slowTimer = 0.125;
      setText(this.time, this.host.time.label);
      setText(this.day, `${this.host.time.weekday} · Day ${this.host.time.day}`);
      const street = streetNameAt(x, z);
      setText(this.street, street ?? (district ? DISTRICTS[district].name : ''));
      setText(this.area, district ? `${DISTRICTS[district].name} · ${DISTRICTS[district].kind}` : '');
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    }
    // Progress labels (walk distance) change continuously.
    const cur = slow ? this.host.state.current() : null;
    if (cur?.progress) this.refreshObjective();
    if (this.notifyTimer > 0) {
      this.notifyTimer -= dt;
      if (this.notifyTimer <= 0) this.notifyEl.hidden = true;
    }
    const svc = this.svc;
    if (svc) {
      const deals = svc.customers.deals.filter((d) => d.status === 'accepted');
      this.dealTrack.hidden = !deals.length;
      if (deals.length && slow) {
        setHtml(this.dealTrack, deals
          .slice(0, 3)
          .map((d) => {
            const left = Math.max(0, d.expires - (svc.time.day * 1440 + svc.time.minutes));
            const dist = Math.round(Math.hypot(d.meet.x - x, d.meet.z - z));
            return `<div><span class="eyebrow">Deal</span> <strong>${svc.customers.person(d.person).name}</strong> wants ${d.units} × ${FAMILIES[d.family].name} · $${d.price}<br><span class="muted">${d.meet.name} · ${dist} m · ${Math.floor(left / 60)}h ${Math.floor(left % 60)}m left</span></div>`;
          })
          .join(''));
      }
      const wp = this.waypoint ?? (deals[0] ? { x: deals[0].meet.x, z: deals[0].meet.z } : null);
      this.wpEl.hidden = !wp;
      if (wp) {
        const dist = Math.hypot(wp.x - x, wp.z - z);
        if (this.waypoint && dist < 8) this.waypoint = null;
        const bearing = Math.atan2(wp.x - x, -(wp.z - z));
        const heading = svc.vehicles.driving ? Math.PI / 2 - svc.vehicles.driving.yaw : -svc.player.yaw;
        this.wpArrow ??= this.wpEl.querySelector('.wp-arrow') as HTMLElement;
        this.wpText ??= this.wpEl.querySelector('.wp-text') as HTMLElement;
        this.wpArrow.style.transform = `rotate(${(bearing - heading).toFixed(3)}rad)`;
        if (slow) setText(this.wpText, `${this.waypoint ? 'Waypoint' : 'Deal'} · ${Math.round(dist)} m`);
      }
      this.minimap?.update(dt, this.heading());
      if (svc.net.online && slow) this.renderChat(svc.net.chat);
      else if (this.chatSeen) {
        setHtml(this.chatFeed, '');
        this.chatSeen = 0;
      }
      // The pursuit banner only shows while an officer is actually after you and close by.
      const c = svc.customers.peds?.chasing;
      const cd = c ? Math.hypot(c.x - x, c.z - z) : Infinity;
      this.wanted.hidden = !(this.chase && c && cd < 70);
      if (c && !this.wanted.hidden && slow) setText(this.wanted.querySelector('.wanted-text') as HTMLElement, `${c.name} is chasing you · ${Math.round(cd)} m`);
    }
    this.fps.hidden = !this.host.settings.showFps;
    if (this.host.settings.showFps) {
      this.fpsFrames++;
      this.fpsTime += dt;
      if (this.fpsTime > 0.5) {
        this.fps.textContent = `${Math.round(this.fpsFrames / this.fpsTime)} fps`;
        this.fpsFrames = 0;
        this.fpsTime = 0;
      }
    }
  }
}
