import * as THREE from 'three';
import { AudioManager } from '../audio/AudioManager';
import { Customers } from '../business/Customers';
import { GANG_IDS, Rivals } from '../business/Rivals';
import { runSelfTest, type SelfTestReport } from '../debug/SelfTest';
import { Economy } from '../economy/Economy';
import { Market } from '../economy/Market';
import { Employees } from '../employees/Employees';
import { Sky } from '../environment/Sky';
import { Particles } from '../fx/Particles';
import { InteractionSystem } from '../interaction/InteractionSystem';
import { Container } from '../inventory/Inventory';
import { Net } from '../net/Net';
import { CharacterLibrary, CharacterPool } from '../npc/Characters';
import { Pedestrians } from '../npc/Pedestrians';
import { Physics } from '../physics/Physics';
import { PlayerController } from '../player/PlayerController';
import { ViewModel } from '../player/ViewModel';
import { ITEMS, VariantRegistry } from '../products/Catalog';
import { Production } from '../production/Production';
import { Properties } from '../properties/Properties';
import { PROPERTIES } from '../properties/PropertyDefs';
import { SAVE_VERSION, SaveSystem, type SaveData, type SaveSlotInfo } from '../save/SaveSystem';
import type { CheatAction } from '../ui/Panels';
import { UI, type UIHost } from '../ui/UI';
import { Vehicles } from '../vehicles/Vehicles';
import { STARTER } from '../world/CityGenerator';
import { Z_LINES, bridgeSpan, riverX } from '../world/CityPlan';
import { World } from '../world/World';
import { EventBus } from './EventBus';
import { GameState } from './GameState';
import { Input } from './Input';
import { nextFrame } from './math';
import type { Services } from './Services';
import { loadSettings, saveSettings } from './Settings';
import { TimeOfDay } from './TimeOfDay';

type Mode = 'loading' | 'title' | 'playing' | 'paused' | 'modal';
const HOTBAR_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

/** Owns the renderer and main loop and wires every system together. */
export class Game implements UIHost {
  readonly bus = new EventBus();
  readonly settings = loadSettings();
  readonly state = new GameState(this.bus);
  readonly time = new TimeOfDay();
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(this.settings.fov, 1, 0.05, 2000);
  readonly audio = new AudioManager(this.settings);
  readonly inventory = new Container('Backpack', 24);
  readonly hotbar = { selected: 0 };
  readonly economy = new Economy(this.bus, () => ({ day: this.time.day, label: this.time.label }));
  readonly variants = new VariantRegistry();
  readonly saves = new SaveSystem();
  readonly charLib = new CharacterLibrary();
  renderer!: THREE.WebGLRenderer;
  physics!: Physics;
  input!: Input;
  world!: World;
  sky!: Sky;
  player!: PlayerController;
  interaction!: InteractionSystem;
  production!: Production;
  customers!: Customers;
  market!: Market;
  rivals!: Rivals;
  properties!: Properties;
  employees!: Employees;
  vehicles!: Vehicles;
  net!: Net;
  peds!: Pedestrians;
  particles!: Particles;
  chars!: CharacterPool;
  viewModel!: ViewModel;
  ui: UI;
  mode: Mode = 'loading';
  slot = 1;
  private svc = {} as Services;
  private last = performance.now();
  private titleAngle = 0;
  private indoors = false;
  private indoorBlend = 0;
  private autosave = 0;
  private titleSaves: SaveSlotInfo[] = [];
  private fromTitle = false;
  private chatting = false;
  private shakeAmt = 0;
  /** While true, the main loop does not advance the simulation (the self-test drives it). */
  private externalDrive = false;

  constructor(private root: HTMLElement) {
    this.ui = new UI(root, this);
  }

  async init(): Promise<void> {
    this.ui.showLoading();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.root.insertBefore(this.renderer.domElement, this.root.firstChild);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.input = new Input(this.renderer.domElement);
    this.scene.add(this.camera);

    this.ui.setLoading(0.03, 'Starting physics');
    await nextFrame();
    this.physics = await Physics.create();
    // Characters download while the city is generated.
    const charLoad = this.charLib.load();

    const svc = this.svc;
    Object.assign(svc, {
      scene: this.scene,
      bus: this.bus,
      physics: this.physics,
      audio: this.audio,
      time: this.time,
      state: this.state,
      ui: this.ui,
      inventory: this.inventory,
      hotbar: this.hotbar,
      economy: this.economy,
      variants: this.variants,
      settings: this.settings,
      held: () => this.inventory.slots[this.hotbar.selected] ?? null,
    });
    this.sky = new Sky(this.scene, this.renderer, this.settings);
    this.world = new World(svc, this.bus);
    svc.world = this.world;
    this.player = new PlayerController(this.physics, this.camera, this.world.hm, this.bus, this.settings);
    this.player.canBoard = () => this.inventory.count('skateboard') > 0;
    this.scene.add(this.player.board);
    this.interaction = new InteractionSystem(svc, this.camera);
    this.production = new Production(svc);
    this.customers = new Customers(svc);
    this.market = new Market(svc);
    this.rivals = new Rivals(svc);
    this.properties = new Properties(svc);
    this.vehicles = new Vehicles(svc, this.camera);
    this.particles = new Particles(this.scene);
    this.chars = new CharacterPool(this.charLib, this.scene, 42);
    this.employees = new Employees(svc, this.chars);
    this.net = new Net(svc, this.chars);
    Object.assign(svc, {
      player: this.player,
      interaction: this.interaction,
      production: this.production,
      customers: this.customers,
      market: this.market,
      rivals: this.rivals,
      properties: this.properties,
      vehicles: this.vehicles,
      employees: this.employees,
      net: this.net,
    });
    this.ui.bind(svc);
    await this.world.build((f, l) => this.ui.setLoading(f, l));
    this.ui.setLoading(0.97, 'Waking up the neighbours');
    await charLoad;
    await nextFrame();
    this.peds = new Pedestrians(svc, this.world.hm, this.particles, this.chars);
    this.customers.attach(this.peds);
    this.viewModel = new ViewModel(this.camera);
    this.newGameState();

    this.wireEvents();
    this.renderer.compile(this.scene, this.camera);
    this.mode = 'title';
    this.titleSaves = await this.saves.list();
    this.ui.showTitle(this.world.stats, this.titleSaves);
    if (!this.charLib.ready) this.ui.toast('Character models could not be loaded, so people use simple placeholder bodies.', 'warn');
    this.loop();
  }

  /** Fresh-start inventory and position. */
  private newGameState() {
    this.inventory.clear();
    this.inventory.add('wateringcan', 1);
    const sp = this.world.starter.spawn;
    this.player.teleport(sp.x, sp.y, sp.z, sp.yaw);
  }

  private wireEvents() {
    this.bus.on('player:footstep', (e) => this.audio.footstep(e.surface, e.sprint));
    this.bus.on('player:land', (e) => e.speed > 4 && this.audio.play('land'));
    this.bus.on('player:jump', () => this.audio.play('jump'));
    this.bus.on('interior:change', (e) => (this.indoors = e.inside));
    this.input.dragLook = true;
    this.input.onLockChange = (locked) => {
      if (!locked && this.mode === 'playing' && !this.chatting) this.pause();
    };
    this.input.onLockError = () => {
      if (this.mode === 'paused' && !this.ui.modalOpen) this.enterPlay();
    };
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.settings.showFps = !this.settings.showFps;
        saveSettings(this.settings);
      }
      if (this.mode === 'modal' && !this.chatting && (e.code === 'Tab' || e.code === 'KeyM' || e.code === 'Escape' || e.code === 'Digit5')) {
        e.preventDefault();
        this.ui.dismiss();
        setTimeout(() => this.input.endFrame(), 0);
        return;
      }
      if (e.code === 'Escape' && !this.input.locked && !this.chatting) {
        if (this.mode === 'playing') this.pause();
        else if (this.mode === 'paused') this.resume();
      }
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'playing' || this.vehicles.driving) return;
        this.hotbar.selected = (this.hotbar.selected + (e.deltaY > 0 ? 1 : 7)) % 8;
        this.ui.hud.renderHotbar();
      },
      { passive: true },
    );
    this.renderer.domElement.addEventListener('click', () => {
      if (this.mode === 'playing' && !this.input.locked) this.input.requestLock();
    });
    // Chat box.
    const chat = this.ui.hud.chatInput;
    chat.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        this.net.say(chat.value);
        this.closeChat();
      } else if (e.key === 'Escape') this.closeChat();
    });
    this.net.onChange = () => this.ui.hud.renderChat(this.net.chat);
  }

  private openChat() {
    if (!this.net.online) {
      this.ui.toast('Join a multiplayer room first (pause menu → Multiplayer).', 'info');
      return;
    }
    this.chatting = true;
    this.mode = 'modal';
    this.input.releaseLock();
    const c = this.ui.hud.chatInput;
    c.hidden = false;
    c.value = '';
    setTimeout(() => c.focus(), 0);
  }

  private closeChat() {
    const c = this.ui.hud.chatInput;
    c.hidden = true;
    c.blur();
    this.chatting = false;
    this.mode = 'playing';
    this.input.requestLock();
  }

  // ------------------------------------------------------------------ UIHost
  start(continueSlot?: number): void {
    this.audio.start();
    this.ui.hideScreen();
    this.ui.closeModal();
    const begin = () => {
      this.enterPlay();
      this.input.requestLock();
    };
    if (continueSlot) void this.loadGame(continueSlot).then(begin);
    else {
      this.slot = 1;
      this.newGameState();
      begin();
    }
  }

  resume(): void {
    this.audio.start();
    this.ui.closeModal();
    this.enterPlay();
    this.input.requestLock();
  }

  enterModal(): void {
    if (this.interaction.carrying) this.interaction.drop();
    if (this.mode === 'title') this.fromTitle = true;
    this.mode = 'modal';
    this.input.releaseLock();
    this.ui.hud.setPrompt(null);
  }

  exitModal(): void {
    if (this.fromTitle) {
      this.fromTitle = false;
      this.mode = 'title';
      return;
    }
    this.mode = 'paused';
    this.resume();
  }

  openMultiplayer(): void {
    const fromTitle = this.mode === 'title';
    this.ui.panels.openMultiplayer(() => {
      if (fromTitle) {
        this.fromTitle = false;
        const latest = [...this.titleSaves].sort((a, b) => b.savedAt - a.savedAt)[0];
        this.start(latest?.slot);
      } else this.ui.dismiss();
    });
  }

  onViewPunch = () => this.viewModel?.punch();
  onShake = (a: number) => (this.shakeAmt = Math.max(this.shakeAmt, a));

  applySettings(): void {
    this.sky.applyShadowQuality();
    this.audio.applyVolumes();
    this.camera.fov = this.settings.fov;
    this.camera.far = Math.max(900, this.settings.viewDistance * 2);
    this.camera.updateProjectionMatrix();
    this.resize();
  }

  /** Advances every time-driven system by the given number of game minutes. */
  private advanceMinutes(minutes: number) {
    this.production.advance(minutes);
    this.customers.advance(minutes);
    this.market.advance();
    this.employees.advance(minutes);
    this.rivals.advance();
    this.properties.advance();
  }

  sleep(): void {
    if (this.net.online && !this.net.isHost) {
      this.ui.toast('Only the host can skip time in multiplayer.', 'warn');
      this.exitModal();
      return;
    }
    this.mode = 'modal';
    void this.ui
      .fade('Day ' + (this.time.minutes >= 420 ? this.time.day + 1 : this.time.day), () => {
        const before = this.time.day * 1440 + this.time.minutes;
        this.time.skipTo(7);
        const after = this.time.day * 1440 + this.time.minutes;
        for (let m = before; m < after; m += 30) this.advanceMinutes(Math.min(30, after - m));
        this.bus.emit('objective:signal', { id: 'sleep' });
        this.bus.emit('time:slept', { day: this.time.day });
      })
      .then(() => {
        void this.saveGame(true);
        this.mode = 'paused';
        this.ui.showPause(true);
      });
  }

  worldStats() {
    return this.world.stats;
  }

  playUi(): void {
    this.audio.start();
    this.audio.play('ui');
  }

  async saveGame(auto = false): Promise<boolean> {
    const p = this.player.position;
    const data: SaveData = {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      time: { day: this.time.day, minutes: this.time.minutes },
      player: { x: p.x, y: p.y, z: p.z, yaw: this.player.yaw },
      economy: this.economy.toJSON(),
      inventory: this.inventory.toJSON(),
      hotbar: this.hotbar.selected,
      variants: { list: [...this.variants.variants.values()], names: [...this.variants.names] },
      properties: this.properties.toJSON(),
      production: this.production.save(),
      customers: this.customers.toJSON(),
      market: this.market.toJSON(),
      state: this.state.toJSON(),
      rivals: this.rivals.toJSON(),
      employees: this.employees.toJSON(),
      vehicles: this.vehicles.toJSON(),
    };
    const ok = await this.saves.write(this.slot, data);
    if (!auto) this.ui.toast(ok ? `Saved to slot ${this.slot}.` : 'Saving failed: browser storage is unavailable.', ok ? 'good' : 'warn');
    return ok;
  }

  async loadGame(slot: number): Promise<boolean> {
    const d = await this.saves.read(slot);
    if (!d) return false;
    this.slot = slot;
    type V = { list: import('../products/Catalog').Variant[]; names: [string, string][] };
    const t = d.time as { day: number; minutes: number };
    this.time.day = t.day;
    this.time.minutes = t.minutes;
    const vs = d.variants as V;
    this.variants.variants.clear();
    for (const v of vs.list) this.variants.variants.set(v.key, v);
    this.variants.names.clear();
    for (const [k, n] of vs.names) this.variants.names.set(k, n);
    this.economy.load(d.economy as ReturnType<Economy['toJSON']>);
    this.inventory.load(d.inventory as never);
    this.hotbar.selected = (d.hotbar as number) ?? 0;
    this.properties.load(d.properties as ReturnType<Properties['toJSON']>);
    this.production.load(d.production as never);
    this.customers.load(d.customers as never);
    this.market.load(d.market as ReturnType<Market['toJSON']>);
    this.state.load(d.state as ReturnType<GameState['toJSON']>);
    this.rivals.load(d.rivals as ReturnType<Rivals['toJSON']>);
    this.employees.load(d.employees as ReturnType<Employees['toJSON']>);
    this.vehicles.load(d.vehicles as ReturnType<Vehicles['toJSON']>);
    const pl = d.player as { x: number; y: number; z: number; yaw: number };
    this.player.teleport(pl.x, pl.y + 0.1, pl.z, pl.yaw);
    this.ui.hud.renderHotbar();
    this.ui.toast(`Loaded slot ${slot}: Day ${t.day}.`, 'good');
    return true;
  }

  private enterPlay() {
    this.mode = 'playing';
    this.ui.closeModal();
    this.ui.hideScreen();
    this.ui.hud.setVisible(true);
  }

  private pause() {
    if (this.mode !== 'playing') return;
    if (this.interaction.carrying) this.interaction.drop();
    this.mode = 'paused';
    this.ui.showPause(true);
  }

  // ------------------------------------------------------------------ cheats
  openCheats() {
    const tp = (x: number, z: number, yaw = 0) => () => this.teleportTo(x, z, yaw);
    const span = bridgeSpan(Z_LINES[3]);
    const hm = this.world.hm;
    let ridge = { x: -420, z: -420, h: -Infinity };
    for (let x = -460; x <= 460; x += 20)
      for (const z of [-460, 460, -440, 440]) {
        const h = hm.get(x, z);
        if (h > ridge.h) ridge = { x, z, h };
      }
    const sections: { title: string; items: CheatAction[] }[] = [
      {
        title: 'Teleport',
        items: [
          { label: 'Home · 14 Larch St', run: tp(this.world.starter.spawn.x, this.world.starter.spawn.z, 0) },
          { label: 'Garage (inside)', run: () => this.teleportTo(STARTER.house.x + 3.8, STARTER.house.z + 1.5, 0, this.world.starter.floorY + 0.05) },
          ...PROPERTIES.map((p) => ({ label: p.name, run: tp(p.x, p.z + p.d / 2 + 3, 0) })),
          { label: 'Meridian Civic Plaza', run: tp(37.5, -30, 0) },
          { label: 'Main St, downtown', run: tp(40, 5.8, -Math.PI / 2) },
          { label: 'Market Row', run: tp(225, 40, 0) },
          { label: 'Ironworks yards', run: tp(75, 262, 0) },
          { label: 'River bridge', run: tp((span.xa + span.xb) / 2, Z_LINES[3], -Math.PI / 2) },
          { label: 'Riverside (under the bridge)', run: tp(riverX(Z_LINES[3]) + 18, Z_LINES[3] + 14, 0) },
          { label: 'Cedar Ridge lookout', run: tp(ridge.x, ridge.z, 0) },
          {
            label: 'Next deal meeting point',
            run: () => {
              const d = this.customers.activeDeal;
              if (!d) return 'No accepted deal right now.';
              this.teleportTo(d.meet.x + 1.5, d.meet.z + 1.5, 0);
            },
          },
          {
            label: 'Nearest car',
            run: () => {
              const v = [...this.vehicles.list].sort((a, b) => a.pos.distanceTo(this.player.position) - b.pos.distanceTo(this.player.position))[0];
              if (!v) return 'You don’t own a car.';
              this.teleportTo(v.pos.x + Math.sin(v.yaw) * -2, v.pos.z + Math.cos(v.yaw) * -2, 0);
            },
          },
        ],
      },
      {
        title: 'Money & items',
        items: [
          { label: '+$1,000', run: () => this.economy.earn(1000, 'Cheat', false) },
          { label: '+$25,000', run: () => this.economy.earn(25000, 'Cheat', false) },
          {
            label: '+$10,000 lifetime sales (unlocks)',
            run: () => {
              this.economy.earn(10000, 'Cheat sales', true);
              this.bus.emit('objective:signal', { id: 'cash', amount: this.economy.lifetimeRevenue });
            },
          },
          {
            label: 'Starter kit (seeds, soil, mixers, baggies)',
            run: () => {
              const kit: [string, number][] = [
                ['seed_violet', 3],
                ['seed_fern', 2],
                ['soil', 4],
                ['fertilizer', 2],
                ['mint', 10],
                ['cola', 10],
                ['sugar', 10],
                ['glowfluid', 10],
                ['baggie', 40],
                ['jar', 10],
              ];
              const lost = kit.reduce((s, [id, q]) => s + this.inventory.add(id, q), 0);
              return lost ? 'Some items did not fit in your backpack.' : 'Starter kit added to your backpack.';
            },
          },
          { label: 'Skateboard', run: () => (this.inventory.add('skateboard', 1) ? 'No room in your backpack.' : 'Skateboard added. Press R to ride.') },
          {
            label: '10 packaged Nightshade',
            run: () => {
              const { variant } = this.variants.get('nightshade', ['calming', 'bright'], 1, this.time.day);
              this.inventory.add('pkg_bag', 10, variant.key);
              return `Added 10 × ${variant.name}.`;
            },
          },
          {
            label: 'Free car (hatchback)',
            run: () => {
              const f = this.player.forward();
              const p = this.player.position;
              this.vehicles.spawn('hatch', 0x2b3f63, p.x + f.x * 5, p.z + f.z * 5, Math.atan2(-f.z, f.x));
              return 'A hatchback appeared in front of you.';
            },
          },
        ],
      },
      {
        title: 'Business',
        items: [
          { label: 'Finish all plants and stations', run: () => this.production.growAll() },
          { label: 'Deliver pending orders now', run: () => this.market.deliverNow() },
          {
            label: 'Install kettle + press at home',
            run: () => {
              this.production.install('kettle');
              this.production.install('press');
            },
          },
          { label: 'Request a deal now', run: () => this.customers.forceDeal() },
          {
            label: 'Make every customer want more',
            run: () => {
              for (const p of this.customers.profiles.values()) p.need = 1;
              return 'Everyone is craving again.';
            },
          },
          {
            label: 'Own all properties',
            run: () => {
              for (const p of PROPERTIES) if (!this.properties.owns(p.id)) {
                this.economy.earn(p.price, 'Cheat', false);
                this.properties.buy(p.id);
              }
              return 'You own every property.';
            },
          },
          { label: 'Clear police / gang pursuit', run: () => this.customers.clearHeat() },
          {
            label: 'Calm every gang',
            run: () => {
              for (const g of GANG_IDS) this.rivals.hostility[g] = 0;
              return 'All gangs are calm.';
            },
          },
          {
            label: 'Anger every gang',
            run: () => {
              for (const g of GANG_IDS) this.rivals.hostility[g] = 80;
              return 'Every gang wants a word with you.';
            },
          },
        ],
      },
      {
        title: 'Time & progress',
        items: [
          { label: 'Morning 07:00', run: () => this.setHour(7) },
          { label: 'Noon 12:00', run: () => this.setHour(12) },
          { label: 'Dusk 19:30', run: () => this.setHour(19.5) },
          { label: 'Night 23:30 (curfew)', run: () => this.setHour(23.5) },
          { label: 'Skip current objective', run: () => this.state.skipCurrent() },
          { label: 'Complete tutorial', run: () => this.state.completeAll() },
          { label: 'Save game', run: () => void this.saveGame() },
        ],
      },
      {
        title: 'Diagnostics',
        items: [
          {
            label: 'Run gameplay self-test',
            keep: true,
            run: async () => {
              const r = await this.debugApi().selfTest();
              return `${r.passed}/${r.passed + r.failed} checks passed in ${r.ms} ms\n` + r.results.map((x) => `${x.pass ? 'PASS' : 'FAIL'}  ${x.name}: ${x.detail}`).join('\n');
            },
          },
        ],
      },
    ];
    this.ui.panels.openCheats(sections);
  }

  private setHour(h: number) {
    const before = this.time.day * 1440 + this.time.minutes;
    this.time.skipTo(h);
    const after = this.time.day * 1440 + this.time.minutes;
    for (let m = before; m < after; m += 30) this.advanceMinutes(Math.min(30, after - m));
  }

  /** Teleports to the walkable surface at (x, z), found by a downward ray. */
  teleportTo(x: number, z: number, yaw = 0, y?: number) {
    if (this.vehicles.driving) this.vehicles.exit();
    let top = y;
    if (top === undefined) {
      const hit = this.physics.raycast({ x, y: 400, z }, { x: 0, y: -1, z: 0 }, 800, [this.player.collider], false);
      top = hit ? hit.point.y : this.world.hm.get(x, z);
    }
    this.player.teleport(x, top + 0.15, z, yaw);
    this.customers.clearHeat();
  }

  // ------------------------------------------------------------------ loop
  private resize() {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * this.settings.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.externalDrive) this.tick(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private handleKeys() {
    const i = this.input;
    if (this.vehicles.driving) {
      if (i.wasPressed('KeyE') || i.wasPressed('KeyF')) this.vehicles.exit();
      else if (i.wasPressed('KeyM')) this.ui.phone.open();
      else if (i.wasPressed('Digit5')) this.openCheats();
      else if (i.wasPressed('KeyT')) this.openChat();
      else if (i.wasPressed('KeyH')) this.audio.play('denied', this.vehicles.driving.pos);
      return;
    }
    if (i.wasPressed('Tab')) this.ui.openInventory();
    else if (i.wasPressed('KeyM')) this.ui.phone.open();
    else if (i.wasPressed('Digit5')) this.openCheats();
    else if (i.wasPressed('KeyT')) this.openChat();
    else if (i.wasPressed('KeyR')) {
      const msg = this.player.toggleBoard();
      if (msg) this.ui.toast(msg, 'warn');
    }
    HOTBAR_KEYS.forEach((k, idx) => {
      if (i.wasPressed(k)) {
        this.hotbar.selected = idx;
        this.ui.hud.renderHotbar();
      }
    });
  }

  /** One simulation step. Public so the self-test can drive the game deterministically. */
  tick(dt: number): void {
    const playing = this.mode === 'playing';
    const driving = this.vehicles.driving;
    if (playing) {
      if (!driving && (this.input.mouseDX || this.input.mouseDY)) this.player.look(this.input.mouseDX, this.input.mouseDY);
      // Everyone's clock runs; in multiplayer the host's clock is broadcast and corrects the others.
      const before = this.time.minutes;
      this.time.update(dt);
      this.advanceMinutes((this.time.minutes - before + 1440) % 1440);
      if (!this.externalDrive) this.handleKeys();
    }
    if (this.mode === 'title') this.titleCamera(dt);
    else if (driving && (playing || this.externalDrive)) {
      this.vehicles.drive(dt, this.input, playing, this.sky.night);
      this.physics.step(dt);
    } else if (playing || this.externalDrive) {
      this.player.update(dt, this.input, playing);
      this.physics.step(dt);
      this.interaction.update(dt, this.input, playing);
    } else {
      this.interaction.update(0, this.input, false);
    }
    if (playing && !this.player.canBoard() && this.player.onBoard) this.player.toggleBoard();
    // Camera shake from crashes.
    if (this.shakeAmt > 0) {
      this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.5);
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmt * 0.3;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmt * 0.3;
    }
    const inside = this.properties.siteAt(this.player.position) !== null;
    this.indoors = inside;
    this.indoorBlend += ((this.indoors ? 1 : 0) - this.indoorBlend) * Math.min(1, dt * 3);
    const focus = this.mode === 'title' ? this.camera.position : this.player.position;
    this.sky.update(this.time, focus, this.indoorBlend);
    this.world.update(dt, this.sky.night, this.player.position);
    const m = this.time.minutes;
    const simDt = playing || this.externalDrive ? dt : 0;
    this.peds.update(simDt, this.sky.night, m >= 23 * 60 || m < 5 * 60);
    this.employees.frame(simDt);
    this.particles.update(dt);
    this.production.frame(dt);
    this.vehicles.frame();
    this.net.update(dt);
    this.audio.update(dt, this.player.position, this.indoors, this.sky.night);
    const showHand = this.mode !== 'title' && !this.interaction.carrying && !driving;
    this.viewModel.set(showHand ? this.inventory.slots[this.hotbar.selected] : null, this.variants);
    this.viewModel.group.visible = showHand;
    this.viewModel.update(dt, Math.hypot(this.player.velocity.x, this.player.velocity.z) > 0.5);
    if (this.mode !== 'title' && this.mode !== 'loading') {
      this.ui.hud.update(dt, this.player.position.x, this.player.position.z, this.world.currentDistrict);
      this.ui.hud.setHeading(driving ? Math.PI / 2 - driving.yaw : -this.player.yaw);
      this.ui.hud.setHint(playing && !this.input.locked ? 'Click the view to capture the mouse, or drag to look around' : driving ? null : null);
      if (driving) this.ui.hud.setPrompt(`${driving.def.name} · ${Math.round(Math.abs(driving.speed) * 3.6)} km/h`, [['E', 'Get out']]);
    }
    if (playing && !this.externalDrive) {
      this.autosave += dt;
      if (this.autosave > 90) {
        this.autosave = 0;
        void this.saveGame(true);
      }
    }
    this.input.endFrame();
  }

  /** Slow aerial orbit over the city behind the title screen. */
  private titleCamera(dt: number) {
    this.titleAngle += dt * 0.025;
    const cx = -20;
    const cz = -40;
    const r = 210;
    const x = cx + Math.cos(this.titleAngle) * r;
    const z = cz + Math.sin(this.titleAngle) * r;
    const y = Math.max(this.world.hm.get(x, z) + 70, 90);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(cx, 20, cz);
  }

  // ------------------------------------------------------------------ automation
  debugApi() {
    return {
      game: this,
      selfTest: async (): Promise<SelfTestReport> => {
        this.externalDrive = true;
        const prevMode = this.mode;
        try {
          return await runSelfTest(this);
        } finally {
          this.externalDrive = false;
          this.input.override = null;
          this.mode = prevMode;
        }
      },
      teleport: (x: number, z: number, yaw = 0) => this.teleportTo(x, z, yaw),
      setTime: (h: number) => (this.time.minutes = h * 60),
      give: (id: string, qty = 1) => (ITEMS[id] ? this.inventory.add(id, qty) : -1),
      state: () => ({
        mode: this.mode,
        pos: this.player.position.toArray().map((v) => +v.toFixed(2)),
        grounded: this.player.grounded,
        district: this.world.currentDistrict,
        time: this.time.label,
        cash: this.economy.cash,
        objectives: [...this.state.done],
        rescues: this.player.rescues,
        characters: this.charLib.ready,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      }),
    };
  }
}
