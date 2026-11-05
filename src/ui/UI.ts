import { openWorldMap } from './Minimap';
import type { EventBus } from '../core/EventBus';
import type { GameState } from '../core/GameState';
import { saveSettings, type Settings } from '../core/Settings';
import type { TimeOfDay } from '../core/TimeOfDay';
import { CITY_NAME, DISTRICTS } from '../world/CityPlan';
import { HUD } from './HUD';
import type { Services } from '../core/Services';
import type { Container, Stack } from '../inventory/Inventory';
import { Panels } from './Panels';
import { Phone } from './Phone';
import { stackName } from './Icons';

/** What the UI needs from the game. Keeps the UI free of rendering and physics details. */
export interface UIHost {
  settings: Settings;
  state: GameState;
  time: TimeOfDay;
  bus: EventBus;
  start(continueSlot?: number): void;
  saveGame(auto?: boolean): Promise<boolean>;
  resume(): void;
  /** Releases the pointer for a modal and pauses player control. */
  enterModal(): void;
  exitModal(): void;
  applySettings(): void;
  sleep(): void;
  worldStats(): { buildings: number; trees: number; cars: number; colliders: number };
  playUi(): void;
  onViewPunch?: () => void;
  onShake?: (amount: number) => void;
  openMultiplayer(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

const CONTROLS: [string[], string][] = [
  [['W', 'A', 'S', 'D'], 'Move'],
  [['Shift'], 'Sprint'],
  [['Space'], 'Jump'],
  [['E'], 'Interact / drive / get out'],
  [['Tab'], 'Inventory'],
  [['M'], 'Phone'],
  [['N'], 'City map (or click the minimap)'],
  [['1-4', 'Wheel'], 'Hotbar'],
  [['R'], 'Skateboard'],
  [['T'], 'Chat (multiplayer)'],
  [['G'], 'Drop carried object'],
  [['5'], 'Cheats & teleport'],
  [['Esc'], 'Pause'],
];

function controlsGrid(): HTMLElement {
  const g = el('div', 'controls');
  for (const [keys, label] of CONTROLS) {
    const k = el('div', 'keys');
    for (const key of keys) k.appendChild(el('kbd', undefined, key));
    g.append(k, el('div', undefined, label));
  }
  return g;
}

export class UI {
  readonly layer: HTMLElement;
  readonly hud: HUD;
  private screen: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private fadeEl: HTMLElement;
  private loadingBar?: HTMLElement;
  private loadingLabel?: HTMLElement;
  private onModalClose: (() => void) | null = null;
  svc!: Services;
  panels!: Panels;
  phone!: Phone;

  constructor(
    root: HTMLElement,
    private host: UIHost,
  ) {
    this.layer = el('div', 'ui-layer');
    root.appendChild(this.layer);
    this.hud = new HUD(this.layer, host);
    this.hud.setVisible(false);
    this.fadeEl = el('div', 'fade');
    this.layer.appendChild(this.fadeEl);
    host.bus.on('toast', (t) => this.toast(t.text, t.kind));
  }

  /** Connects the gameplay services once they exist. */
  bind(svc: Services) {
    this.svc = svc;
    this.panels = new Panels(this, svc);
    this.phone = new Phone(this, svc);
    this.hud.bind(svc);
    this.hud.onOpenMap = () => this.openMap();
  }

  /** Full-screen city map (minimap click or N). */
  openMap() {
    if (!this.hud.minimap) return;
    openWorldMap(this.svc, this.hud.minimap.cityMap, this, () => this.hud.heading());
  }

  /** Shows a modal panel and releases the mouse. */
  present(m: HTMLElement, onClose?: () => void) {
    if (!this.modal) this.host.enterModal();
    this.setModal(m);
    this.onModalClose = onClose ?? null;
    this.hud.setPrompt(null);
  }

  /** Closes the current panel and returns to play. */
  dismiss() {
    this.closeDialog();
  }

  itemName(s: Stack | { id: string; v?: string }) {
    return stackName(s, this.svc.variants);
  }

  openInventory(other?: Container, label?: string) {
    this.panels.openInventory(other, label);
  }

  /** Small forward jab of the held item (handing something over). */
  viewPunch() {
    this.host.onViewPunch?.();
  }

  /** Brief camera shake (crashes). */
  shake(amount: number) {
    this.host.onShake?.(amount);
  }

  busted(text: string) {
    void this.fade('Busted', () => this.toast(text, 'warn'));
  }

  toast(text: string, kind: 'info' | 'good' | 'warn' = 'info') {
    this.hud.toast(text, kind);
  }

  get modalOpen() {
    return !!this.modal;
  }

  // ---------------------------------------------------------------- loading
  showLoading() {
    const s = el('div', 'screen loading');
    const col = el('div');
    col.appendChild(el('div', 'eyebrow', 'Harlow · building the city'));
    col.appendChild(el('div', 'wordmark', 'Underworld<br>Empire'));
    const bar = el('div', 'bar');
    this.loadingBar = el('i');
    bar.appendChild(this.loadingBar);
    col.appendChild(bar);
    this.loadingLabel = el('div', 'label', 'Starting');
    col.appendChild(this.loadingLabel);
    s.appendChild(col);
    this.setScreen(s);
  }

  setLoading(fraction: number, label: string) {
    if (this.loadingBar) this.loadingBar.style.width = `${Math.round(fraction * 100)}%`;
    if (this.loadingLabel) this.loadingLabel.textContent = label;
  }

  showError(message: string) {
    const s = el('div', 'screen loading');
    const col = el('div');
    col.appendChild(el('div', 'wordmark', 'Something broke'));
    const box = el('div', 'error-box');
    box.textContent = message;
    col.appendChild(box);
    s.appendChild(col);
    this.setScreen(s);
  }

  // ---------------------------------------------------------------- title
  showTitle(stats: { buildings: number; trees: number }, saves: { slot: number; savedAt: number; day: number; cash: number }[] = []) {
    const s = el('div', 'screen title-screen');
    const col = el('div', 'title-col');
    col.appendChild(el('div', 'eyebrow', `${CITY_NAME} · Day 1`));
    col.appendChild(el('h1', undefined, 'Underworld<span>Empire</span>'));
    col.appendChild(
      el(
        'p',
        'lede',
        `You've just taken the keys to a small rented house on Larch Street with a garage full of second-hand equipment. Grow, mix and package product, win customers across ${stats.buildings} buildings of Harlow, and stay out of sight of the police.`,
      ),
    );
    const row = el('div', 'btn-row');
    const latest = [...saves].sort((a, b) => b.savedAt - a.savedAt)[0];
    if (latest) {
      const cont = el('button', 'btn primary', `Continue <span class="btn-sub">Day ${latest.day} · $${latest.cash.toLocaleString()}</span>`);
      cont.id = 'btn-continue';
      cont.addEventListener('click', () => {
        this.host.playUi();
        this.host.start(latest.slot);
      });
      row.appendChild(cont);
    }
    const start = el('button', latest ? 'btn' : 'btn primary', 'New game');
    start.id = 'btn-start';
    start.addEventListener('click', () => {
      this.host.playUi();
      this.host.start();
    });
    const mp = el('button', 'btn', 'Multiplayer');
    mp.id = 'btn-title-mp';
    mp.addEventListener('click', () => {
      this.host.playUi();
      this.host.openMultiplayer();
    });
    const settings = el('button', 'btn', 'Settings');
    settings.id = 'btn-title-settings';
    settings.addEventListener('click', () => this.openSettings(true));
    row.append(start, mp, settings);
    col.appendChild(row);
    col.appendChild(controlsGrid());
    col.appendChild(el('div', 'build-note', 'Early access build · saves to this browser · characters and city kit by Quaternius (CC0)'));
    s.appendChild(col);
    this.setScreen(s);
  }

  hideScreen() {
    this.setScreen(null);
  }

  private setScreen(s: HTMLElement | null) {
    this.screen?.remove();
    this.screen = s;
    if (s) this.layer.insertBefore(s, this.fadeEl);
  }

  // ---------------------------------------------------------------- pause & settings
  showPause(dragLook: boolean) {
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.appendChild(el('div', 'eyebrow', `${this.host.time.weekday} · Day ${this.host.time.day} · ${this.host.time.label}`));
    p.appendChild(el('h2', undefined, 'Paused'));
    const list = el('div', 'menu-list');
    const resume = el('button', 'btn primary', 'Resume');
    resume.id = 'btn-resume';
    resume.addEventListener('click', () => {
      this.host.playUi();
      this.closeModal();
      this.host.resume();
    });
    const settings = el('button', 'btn', 'Settings');
    settings.addEventListener('click', () => this.openSettings(false));
    const save = el('button', 'btn', 'Save game');
    save.id = 'btn-save';
    save.addEventListener('click', () => {
      this.host.playUi();
      void this.host.saveGame();
    });
    const mp = el('button', 'btn', this.svc?.net?.online ? `Multiplayer · room ${this.svc.net.room}` : 'Multiplayer');
    mp.addEventListener('click', () => {
      this.host.playUi();
      this.host.openMultiplayer();
    });
    list.append(resume, save, mp, settings);
    p.appendChild(list);
    p.appendChild(el('div', 'section-label', 'Controls'));
    p.appendChild(controlsGrid());
    if (dragLook) p.appendChild(el('div', 'build-note', 'If the mouse is not captured, click the view or hold the left button and drag to look.'));
    o.appendChild(p);
    this.setModal(o);
  }

  openSettings(fromTitle: boolean) {
    const st = this.host.settings;
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.appendChild(el('h2', undefined, 'Settings'));
    const grid = el('div', 'settings-grid');
    const slider = (id: string, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const row = el('div', 'setting');
      const lab = el('label', undefined, label);
      lab.htmlFor = id;
      const out = el('output');
      const input = el('input');
      input.type = 'range';
      input.id = id;
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(get());
      out.textContent = fmt(get());
      input.addEventListener('input', () => {
        set(Number(input.value));
        out.textContent = fmt(Number(input.value));
        saveSettings(st);
        this.host.applySettings();
      });
      row.append(lab, out, input);
      grid.appendChild(row);
    };
    const check = (id: string, label: string, get: () => boolean, set: (v: boolean) => void) => {
      const row = el('div', 'setting');
      const lab = el('label', undefined, label);
      lab.htmlFor = id;
      const input = el('input');
      input.type = 'checkbox';
      input.id = id;
      input.checked = get();
      input.addEventListener('change', () => {
        set(input.checked);
        saveSettings(st);
        this.host.applySettings();
      });
      row.append(lab, input);
      grid.appendChild(row);
    };
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    grid.appendChild(el('div', 'section-label', 'Controls'));
    slider('set-sens', 'Mouse sensitivity', 0.2, 3, 0.05, () => st.sensitivity, (v) => (st.sensitivity = v), (v) => v.toFixed(2));
    check('set-invert', 'Invert vertical look', () => st.invertY, (v) => (st.invertY = v));
    check('set-bob', 'Head bob', () => st.headBob, (v) => (st.headBob = v));
    grid.appendChild(el('div', 'section-label', 'Display'));
    slider('set-fov', 'Field of view', 60, 100, 1, () => st.fov, (v) => (st.fov = v), (v) => `${v}°`);
    slider('set-view', 'View distance', 250, 900, 25, () => st.viewDistance, (v) => (st.viewDistance = v), (v) => `${v} m`);
    slider('set-scale', 'Render scale', 0.5, 1, 0.05, () => st.renderScale, (v) => (st.renderScale = v), pct);
    const select = (id: string, label: string, options: [string, string][], get: () => string, set: (v: string) => void) => {
      const row = el('div', 'setting');
      const lab = el('label', undefined, label);
      lab.htmlFor = id;
      const sel = el('select');
      sel.id = id;
      for (const [v, t] of options) {
        const op = el('option', undefined, t);
        op.value = v;
        sel.appendChild(op);
      }
      sel.value = get();
      sel.addEventListener('change', () => {
        set(sel.value);
        saveSettings(st);
        this.host.applySettings();
      });
      row.append(lab, sel);
      grid.appendChild(row);
    };
    select('set-gfx', 'Graphics', [
      ['ultra', 'Ultra (bloom, reflections, grading)'],
      ['high', 'High (bloom, reflections)'],
      ['low', 'Low (fastest)'],
    ], () => st.graphics, (v) => (st.graphics = v as Settings['graphics']));
    select('set-shadows', 'Shadows', [
      ['high', 'High'],
      ['low', 'Low'],
      ['off', 'Off'],
    ], () => st.shadows, (v) => (st.shadows = v as Settings['shadows']));
    select('set-day', 'Day length', [
      ['24', '24 minutes'],
      ['48', '48 minutes'],
      ['120', '2 hours'],
      ['real', 'Real time (synced to your clock)'],
    ], () => String(st.dayLength), (v) => (st.dayLength = v === 'real' ? 'real' : (Number(v) as 24 | 48 | 120)));
    check('set-fps', 'Show frame rate', () => st.showFps, (v) => (st.showFps = v));
    grid.appendChild(el('div', 'section-label', 'Audio'));
    slider('set-master', 'Master volume', 0, 1, 0.05, () => st.master, (v) => (st.master = v), pct);
    slider('set-sfx', 'Effects', 0, 1, 0.05, () => st.sfx, (v) => (st.sfx = v), pct);
    slider('set-amb', 'Ambience', 0, 1, 0.05, () => st.ambience, (v) => (st.ambience = v), pct);
    p.appendChild(grid);
    const back = el('button', 'btn primary', 'Done');
    back.id = 'btn-settings-done';
    back.addEventListener('click', () => {
      this.host.playUi();
      if (fromTitle) {
        o.remove();
        this.modal = null;
      } else this.showPause(false);
    });
    p.appendChild(back);
    o.appendChild(p);
    if (fromTitle) {
      this.layer.appendChild(o);
      this.modal = o;
    } else this.setModal(o);
  }

  // ---------------------------------------------------------------- in-world dialogs
  openLetter() {
    const o = el('div', 'overlay');
    const l = el('div', 'letter');
    l.innerHTML = `
      <div class="letterhead">Harlow Realty <small>Maple Hill office</small></div>
      <p>Welcome to 14 Larch Street.</p>
      <p>Keys are under the mat, as promised. It isn't much: a front room, a back room and a garage that has seen better days. The rent is paid through the end of the month, and after that it's on you. I left <strong>$400</strong> in the envelope to get you started. Don't spend it all on rent.</p>
      <p>The garage is yours to use however you like. There are grow pots, a mixing station and a packaging bench in there already. Nobody on Larch Street asks many questions, and I'd keep it that way. Your phone's Market app will deliver anything you need to the porch.</p>
      <p>The police patrol the main streets and enforce an 11pm curfew. Don't hand anything over where they can see you.</p>
      <p>Take a walk. Get to know the city: Meridian downtown, Market Row for the shops, the Ironworks yards down south, and the ridges out past Cedar Ridge. Everyone in Harlow started somewhere.</p>
      <p class="sig">Ray Delgado<br>Lettings, Harlow Realty</p>`;
    const close = el('button', 'btn', 'Fold the letter');
    close.id = 'btn-letter-close';
    close.addEventListener('click', () => this.closeDialog());
    l.appendChild(close);
    o.appendChild(l);
    this.present(o);
  }

  openComputer() {
    this.host.bus.emit('objective:signal', { id: 'computer' });
    const st = this.host.state;
    const stats = this.host.worldStats();
    const o = el('div', 'overlay');
    const c = el('div', 'computer');
    const items = st.objectives
      .map((ob) => `<li class="${st.done.has(ob.id) ? 'done' : ''}"><span>${st.done.has(ob.id) ? '✓' : '□'}</span><span>${ob.text}${ob.progress && !st.done.has(ob.id) ? ` <em>(${ob.progress()})</em>` : ''}</span></li>`)
      .join('');
    const visited = [...st.districts].map((d) => DISTRICTS[d].name).join(', ') || 'none yet';
    c.innerHTML = `
      <div class="bar"><span>LARCH-PC · notes.txt</span><span>${this.host.time.weekday} ${this.host.time.label}</span></div>
      <div class="body">
        <section>
          <h3>Getting started</h3>
          <ul>${items}</ul>
        </section>
        <section>
          <h3>Property</h3>
          <dl>
            <dt>Address</dt><dd>${st.propertyName}</dd>
            <dt>Rooms</dt><dd>2 + garage</dd>
            <dt>Rent</dt><dd>paid to month end</dd>
          </dl>
          <h3 style="margin-top:18px">City of ${CITY_NAME}</h3>
          <dl>
            <dt>Buildings</dt><dd>${stats.buildings}</dd>
            <dt>Trees</dt><dd>${stats.trees}</dd>
            <dt>Parked cars</dt><dd>${stats.cars}</dd>
            <dt>Visited</dt><dd>${visited}</dd>
            <dt>Walked</dt><dd>${Math.round(st.walked)} m</dd>
          </dl>
        </section>
      </div>`;
    const foot = el('div', 'foot');
    const close = el('button', 'btn', 'Log off');
    close.id = 'btn-computer-close';
    close.addEventListener('click', () => this.closeDialog());
    foot.appendChild(close);
    c.appendChild(foot);
    o.appendChild(c);
    this.present(o);
  }

  openSleep() {
    const o = el('div', 'overlay');
    const p = el('div', 'panel');
    p.appendChild(el('div', 'eyebrow', `${this.host.time.weekday} · ${this.host.time.label}`));
    p.appendChild(el('h2', undefined, 'Get some sleep?'));
    p.appendChild(el('p', undefined, 'You will wake up at 07:00 the next morning.'));
    const row = el('div', 'btn-row');
    const yes = el('button', 'btn primary', 'Sleep until 07:00');
    yes.id = 'btn-sleep';
    yes.addEventListener('click', () => {
      this.closeModal();
      this.host.sleep();
    });
    const no = el('button', 'btn', 'Not yet');
    no.addEventListener('click', () => this.closeDialog());
    row.append(yes, no);
    p.appendChild(row);
    o.appendChild(p);
    this.present(o);
  }

  async fade(text: string, during: () => void): Promise<void> {
    this.fadeEl.textContent = text;
    this.fadeEl.classList.add('show');
    await new Promise((r) => setTimeout(r, 1000));
    during();
    await new Promise((r) => setTimeout(r, 900));
    this.fadeEl.classList.remove('show');
  }

  private closeDialog() {
    this.host.playUi();
    this.closeModal();
    this.host.exitModal();
  }

  closeModal() {
    this.modal?.remove();
    this.modal = null;
    const f = this.onModalClose;
    this.onModalClose = null;
    f?.();
  }

  private setModal(m: HTMLElement) {
    this.modal?.remove();
    const f = this.onModalClose;
    this.onModalClose = null;
    f?.();
    this.modal = m;
    this.layer.insertBefore(m, this.fadeEl);
  }
}
