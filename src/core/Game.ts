import * as THREE from 'three';
import { AudioManager } from '../audio/AudioManager';
import { Customers } from '../business/Customers';
import { GANG_IDS, Rivals } from '../business/Rivals';
import { runSelfTest, type SelfTestReport } from '../debug/SelfTest';
import { Economy } from '../economy/Economy';
import { Market } from '../economy/Market';
import { Employees } from '../employees/Employees';
import { PostFX } from '../environment/PostFX';
import { Substances } from '../player/Substances';
import { Sky } from '../environment/Sky';
import { Upgrades, UPGRADES } from '../business/Upgrades';
import { Placement } from '../production/Placement';
import { SHOP } from '../properties/CornerShop';
import { CASINO } from '../properties/Casino';
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
import { LightPool } from '../environment/LightPool';
import { rememberHostedWorld } from '../net/Worlds';
import { DetailCuller } from '../world/DetailCuller';
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
/** Where a multiplayer world's progress is saved (hosts keep the whole world; guests their own part). */
const worldKey = (wid: string, role: 'host' | 'guest') => `world-${role}-${wid}`;

/** Real point lights in the pool per graphics level (the rest wait their turn). */
const LIGHTS = { low: 2, high: 4, ultra: 6 } as const;

const HOTBAR_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

/** Police curfew: 23:00 to 05:00. */
export const isCurfew = (minutes: number) => minutes >= 23 * 60 || minutes < 5 * 60;

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
  postfx!: PostFX;
  substances!: Substances;
  private curfewWas: boolean | null = null;
  private curfewWarned = -1;
  placement!: Placement;
  upgrades!: Upgrades;
  player!: PlayerController;
  interaction!: InteractionSystem;
  production!: Production;
  customers!: Customers;
  market!: Market;
  rivals!: Rivals;
  properties!: Properties;
  employees!: Employees;
  vehicles!: Vehicles;
  lights?: LightPool;
  detail?: DetailCuller;
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
    // Soft (many-tap) shadow filtering only on Ultra; High uses the cheaper PCF filter.
    this.renderer.shadowMap.type = this.settings.graphics === 'ultra' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
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
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, this.settings);
    this.time.setDayLength(this.settings.dayLength);
    this.world = new World(svc, this.bus);
    this.world.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    svc.world = this.world;
    this.player = new PlayerController(this.physics, this.camera, this.world.hm, this.bus, this.settings);
    this.player.canBoard = () => this.inventory.count('skateboard') > 0;
    this.substances = new Substances(svc, this.player, this.postfx);
    svc.substances = this.substances;
    this.scene.add(this.player.board);
    this.interaction = new InteractionSystem(svc, this.camera);
    this.production = new Production(svc);
    this.customers = new Customers(svc);
    this.market = new Market(svc);
    this.upgrades = new Upgrades(svc);
    this.rivals = new Rivals(svc);
    this.properties = new Properties(svc);
    this.vehicles = new Vehicles(svc, this.camera);
    this.particles = new Particles(this.scene);
    this.chars = new CharacterPool(this.charLib, this.scene, 56);
    this.world.chars = this.chars;
    this.placement = new Placement(svc, this.camera);
    this.employees = new Employees(svc, this.chars);
    this.net = new Net(svc, this.chars);
    this.net.onTimeRequest = (h) => this.setHour(h);
    Object.assign(svc, {
      player: this.player,
      interaction: this.interaction,
      production: this.production,
      customers: this.customers,
      market: this.market,
      upgrades: this.upgrades,
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
    this.freshSave = this.collectSave();
    this.net.onWelcome = (info) => this.enterWorld(info);
    this.net.onLeft = () => void this.leaveWorld();
    this.net.onWorldReset = (by) =>
      void this.queueWorld(async () => {
        this.resetPersonal();
        await this.saveGame(true);
        this.ui.toast(`${by} reset the world. Everyone starts over: fresh money and an empty backpack.`, 'warn');
      });

    this.wireEvents();
    this.lights = new LightPool(this.scene, LIGHTS[this.settings.graphics]);
    this.lights.update(0, this.camera.position);
    this.detail = new DetailCuller(this.scene);
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
    this.bus.on('player:jailed', (e) => this.jail(e.hours, e.text));
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
      if (this.mode === 'modal' && !this.chatting && (e.code === 'Tab' || e.code === 'KeyM' || e.code === 'KeyN' || e.code === 'Escape' || e.code === 'Digit5')) {
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
        // Straight into the world you joined: your progress there was loaded on joining.
        this.fromTitle = false;
        void this.worldOps.then(() => {
          this.audio.start();
          this.ui.hideScreen();
          this.ui.closeModal();
          this.enterPlay();
          this.input.requestLock();
        });
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
    // Guests run at the host's clock speed.
    if (!this.net?.online || this.net.isHost) this.time.setDayLength(this.settings.dayLength);
    this.postfx.apply();
    this.lights?.resize(LIGHTS[this.settings.graphics]);
    const shadowType = this.settings.graphics === 'ultra' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (this.renderer.shadowMap.type !== shadowType) this.renderer.shadowMap.type = shadowType;
    this.sky.applyShadowQuality();
    this.world.grass?.setQuality(this.settings.graphics);
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
        this.substances.clear();
        const after = this.time.day * 1440 + this.time.minutes;
        for (let m = before; m < after; m += 30) this.advanceMinutes(Math.min(30, after - m));
        this.bus.emit('objective:signal', { id: 'sleep' });
        this.bus.emit('time:slept', { day: this.time.day });
        this.net.pushTime();
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

  /** Everything that makes up a game: used for slot saves and for each multiplayer world's save. */
  private collectSave(): SaveData {
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
      // While visiting someone else's world, your save keeps your own equipment.
      production: this.net.online ? this.net.sync.saveData() : this.production.save(),
      customers: this.net.online ? this.net.sync.saveCustomers() : this.customers.toJSON(),
      market: this.market.toJSON(),
      state: this.state.toJSON(),
      rivals: this.rivals.toJSON(),
      employees: this.employees.toJSON(),
      vehicles: this.vehicles.toJSON(),
      upgrades: this.upgrades.toJSON(),
    };
    return JSON.parse(JSON.stringify(data)) as SaveData;
  }

  async saveGame(auto = false): Promise<boolean> {
    const data = this.collectSave();
    const w = this.mpWorld;
    if (w) {
      // In a multiplayer world: saved to that world only, never over your single-player slots.
      const ok = await this.saves.writeKey(worldKey(w.wid, w.role), data);
      if (w.role === 'host') rememberHostedWorld({ wid: w.wid, name: w.name, code: this.net.room, day: this.time.day, cash: this.economy.cash, savedAt: Date.now() });
      if (!auto) this.ui.toast(ok ? `Saved your progress in ${w.name}.` : 'Saving failed: browser storage is unavailable.', ok ? 'good' : 'warn');
      return ok;
    }
    const ok = await this.saves.write(this.slot, data);
    if (!auto) this.ui.toast(ok ? `Saved to slot ${this.slot}.` : 'Saving failed: browser storage is unavailable.', ok ? 'good' : 'warn');
    return ok;
  }

  // ------------------------------------------------------------------ multiplayer worlds
  /** The multiplayer world you're in: its own money, backpack, objectives and (as host) everything. */
  private mpWorld: { wid: string; name: string; role: 'host' | 'guest' } | null = null;
  /** World switches run one after another (leaving one room and joining the next can overlap). */
  private worldOps: Promise<void> = Promise.resolve();
  /** A brand-new game, captured at start-up: what a new world begins from. */
  private freshSave: SaveData | null = null;

  private queueWorld(fn: () => Promise<void>): Promise<void> {
    this.worldOps = this.worldOps.then(fn).catch((e) => console.error(e));
    return this.worldOps;
  }

  /** Joined (or started hosting) a world: switch to your progress there, or a fresh start. */
  private enterWorld(info: { wid: string; world: string; host: boolean }): Promise<void> {
    return this.queueWorld(async () => {
      // Your single-player game is saved first, so nothing from it is lost or carried over.
      if (!this.mpWorld && this.mode !== 'title' && this.mode !== 'loading') {
        const data = this.collectSave();
        await this.saves.write(this.slot, data);
      }
      const role = info.host ? 'host' : 'guest';
      const saved = await this.saves.readKey(worldKey(info.wid, role));
      this.applySave(saved ?? this.freshSave!);
      if (!saved) this.newGameState();
      this.mpWorld = { wid: info.wid, name: info.world, role };
      this.ui.hud.renderHotbar();
      this.ui.toast(
        saved
          ? `Welcome back to ${info.world}. Your money, backpack and progress here are just as you left them.`
          : `New world: you start fresh in ${info.world}. Your single-player save is untouched.`,
        'good',
      );
      if (!saved) await this.saveGame(true);
    });
  }

  /**
   * Reset progress (Settings). Alone: your current save starts over. Guest: your progress in this world.
   * Host: the whole world starts over for everyone in it.
   */
  resetProgress(): string {
    const w = this.mpWorld;
    if (this.net.online && this.net.isHost) {
      void this.queueWorld(async () => {
        this.applySave(this.freshSave!);
        this.newGameState();
        this.net.broadcastReset();
        await this.saveGame(true);
      });
      return `Reset ${w?.name ?? 'this world'} for everyone: fresh money, empty backpacks and a bare house.`;
    }
    if (this.net.online) {
      void this.queueWorld(async () => {
        this.resetPersonal();
        await this.saveGame(true);
      });
      return `Your progress in ${w?.name ?? 'this world'} is reset. Everyone else's is unchanged.`;
    }
    void this.queueWorld(async () => {
      this.applySave(this.freshSave!);
      this.newGameState();
      await this.saveGame(true);
    });
    return `Slot ${this.slot} starts over from day one.`;
  }

  /** Guest reset: your money, backpack, objectives, cars and property, plus your own stashed equipment. */
  private resetPersonal() {
    const d = JSON.parse(JSON.stringify(this.freshSave)) as SaveData;
    this.economy.load(d.economy as ReturnType<Economy['toJSON']>);
    this.inventory.load(d.inventory as never);
    this.hotbar.selected = 0;
    this.state.load(d.state as ReturnType<GameState['toJSON']>);
    this.vehicles.load(d.vehicles as ReturnType<Vehicles['toJSON']>);
    this.properties.load(d.properties as ReturnType<Properties['toJSON']>);
    this.net.sync.resetOwn(d.production, d.customers);
    this.newGameState();
    this.ui.hud.renderHotbar();
  }

  /** Left a world (or lost the connection): save your progress there and go back to your own game. */
  private leaveWorld(): Promise<void> {
    return this.queueWorld(async () => {
      const w = this.mpWorld;
      if (!w) return;
      await this.saveGame(true);
      this.mpWorld = null;
      const own = await this.saves.read(this.slot);
      this.applySave(own ?? this.freshSave!);
      if (!own) this.newGameState();
      this.ui.hud.renderHotbar();
      this.ui.toast(`Left ${w.name}. Your progress there is saved for next time, and you're back in your own game.`, 'info');
    });
  }

  async loadGame(slot: number): Promise<boolean> {
    const d = await this.saves.read(slot);
    if (!d) return false;
    this.slot = slot;
    this.applySave(d);
    this.ui.toast(`Loaded slot ${slot}: Day ${(d.time as { day: number }).day}.`, 'good');
    return true;
  }

  /** Puts a save into every system (replacing whatever was there). */
  private applySave(src: SaveData) {
    const d = JSON.parse(JSON.stringify(src)) as SaveData;
    type V = { list: import('../products/Catalog').Variant[]; names: [string, string][] };
    const t = d.time as { day: number; minutes: number };
    this.time.day = t.day;
    this.time.minutes = t.minutes;
    // Real-time days follow the player's clock rather than the time stored in the save.
    if (this.settings.dayLength === 'real') this.time.syncToClock();
    const vs = d.variants as V;
    this.variants.variants.clear();
    for (const v of vs.list) this.variants.variants.set(v.key, v);
    this.variants.names.clear();
    for (const [k, n] of vs.names) this.variants.names.set(k, n);
    this.economy.load(d.economy as ReturnType<Economy['toJSON']>);
    this.inventory.load(d.inventory as never);
    this.hotbar.selected = (d.hotbar as number) ?? 0;
    this.properties.load(d.properties as ReturnType<Properties['toJSON']>);
    this.upgrades.load(d.upgrades as string[] | undefined);
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
  /** Cheats follow the host's setting online, and your own setting offline. */
  cheatsAllowed(): boolean {
    return this.net.online ? this.net.cheatsAllowed : this.settings.allowCheats;
  }

  cheatControl() {
    return { online: this.net.online, isHost: this.net.isHost, allowed: this.cheatsAllowed(), players: this.net.players.size };
  }

  /** From Settings: offline it's your own switch; online only the host can change it. */
  setCheatsAllowed(on: boolean): boolean {
    if (this.net.online && !this.net.isHost) return false;
    this.settings.allowCheats = on;
    saveSettings(this.settings);
    if (this.net.online) this.net.setCheats(on);
    return true;
  }

  /** Sets every player's cash to $0 (just yours when playing alone). */
  wipeAllMoney(): string {
    const others = this.net.wipeAllMoney();
    return others ? `Wiped everyone's money (you and ${others} other player${others === 1 ? '' : 's'}).` : this.net.online ? "Wiped your money. Nobody else is in the world right now." : 'Your money is now $0.';
  }

  private cheatSeq: { key: string; at: number }[] = [];
  /** Cheat code: press 7, then 8, then 5 (within two seconds). */
  private checkCheatCode() {
    const i = this.input;
    const key = i.wasPressed('Digit7') ? '7' : i.wasPressed('Digit8') ? '8' : i.wasPressed('Digit5') ? '5' : null;
    if (!key) return;
    const now = performance.now();
    if (key === '7') this.cheatSlot = this.hotbar.selected;
    this.cheatSeq = [...this.cheatSeq.filter((k) => now - k.at < 2000), { key, at: now }].slice(-3);
    if (this.cheatSeq.map((k) => k.key).join('') !== '785') return;
    this.cheatSeq = [];
    // 7 and 8 are hotbar keys: put the hotbar back where it was before the code.
    if (this.cheatSlot !== null) this.hotbar.selected = this.cheatSlot;
    this.cheatSlot = null;
    if (!this.cheatsAllowed()) {
      this.audio.play('denied');
      this.ui.toast(this.net.online && !this.net.isHost ? 'The host has turned cheats off for this world.' : 'Cheats are turned off. Switch them on in Settings.', 'warn');
      return;
    }
    this.openCheats();
  }
  private cheatSlot: number | null = null;

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
          { label: 'Kwik Corner shop', run: tp(SHOP.x, SHOP.z - SHOP.d / 2 - 3, Math.PI) },
          { label: 'Lucky 7 Casino', run: tp(CASINO.x, CASINO.z - CASINO.d / 2 - 5, Math.PI) },
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
          { label: "Remove everyone's money", run: () => this.wipeAllMoney() },
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
          {
            label: 'Equipment pack (pots, lamps, rack, storage)',
            run: () => {
              const kit: [string, number][] = [
                ['pot', 4],
                ['lamp', 2],
                ['rack', 1],
                ['storage', 1],
                ['mixer', 1],
              ];
              const lost = kit.reduce((s, [id, q]) => s + this.inventory.add(id, q), 0);
              return lost ? 'Some equipment did not fit in your backpack.' : 'Equipment added. Hold one and press E inside your property to place it.';
            },
          },
          {
            label: 'Unlock every upgrade',
            run: () => {
              this.economy.earn(10000, 'Cheat sales', true);
              for (const u of UPGRADES) if (!this.upgrades.has(u.id)) {
                this.economy.earn(u.price, 'Cheat', false);
                this.upgrades.buy(u.id);
              }
              return 'Every upgrade is yours, including both converted rooms.';
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
    // If the host switches cheats off while the menu is open, the buttons stop working.
    for (const s of sections)
      for (const it of s.items) {
        const run = it.run;
        it.run = () => (this.cheatsAllowed() ? run() : 'Cheats were turned off by the host.');
      }
    this.ui.panels.openCheats(sections);
  }

  /** Warns before curfew, announces it and its end (once each). */
  private curfewNotices(m: number, curfew: boolean) {
    if (this.curfewWas !== null && curfew !== this.curfewWas)
      this.ui.toast(curfew ? 'Curfew is in force until 05:00. Police will stop and search anyone out on the streets.' : 'Curfew lifted. The streets are yours again.', curfew ? 'warn' : 'good');
    this.curfewWas = curfew;
    if (!curfew && m >= 22 * 60 + 30 && this.curfewWarned !== this.time.day) {
      this.curfewWarned = this.time.day;
      this.ui.toast('Curfew starts at 23:00. Get indoors or stay out of sight of the police.', 'warn');
    }
  }

  /** Busted: time passes in a cell, you're released outside the courthouse on the plaza. */
  private jail(hours: number, text: string) {
    if (this.vehicles.driving) this.vehicles.exit();
    this.substances.clear();
    this.player.stun = 0;
    this.mode = 'modal';
    void this.ui
      .fade(`Arrested · ${hours} hours in Harlow County Jail`, () => {
        // In multiplayer only the host's clock moves; guests just serve the time off-screen.
        if (!this.net.online || this.net.isHost) {
          const total = hours * 60;
          for (let done = 0; done < total; done += 30) {
            const step = Math.min(30, total - done);
            this.time.minutes += step;
            while (this.time.minutes >= 1440) {
              this.time.minutes -= 1440;
              this.time.day++;
            }
            this.advanceMinutes(step);
          }
          this.net.pushTime();
        }
        this.teleportTo(37.5, -12, Math.PI);
        this.ui.toast(text, 'warn');
      })
      .then(() => {
        this.mode = 'playing';
        this.ui.toast('Released. Stay out of trouble.', 'info');
      });
  }

  private setHour(h: number): string | void {
    // Multiplayer: the host's clock is everyone's clock, so a guest's time cheat asks the host.
    if (this.net.online && !this.net.isHost) {
      this.net.requestTime(h);
      return 'Time change sent to the host. Everyone’s clock will jump together.';
    }
    const before = this.time.day * 1440 + this.time.minutes;
    this.time.skipTo(h);
    const after = this.time.day * 1440 + this.time.minutes;
    for (let m = before; m < after; m += 30) this.advanceMinutes(Math.min(30, after - m));
    this.net.pushTime();
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
    // Retina screens render up to 4× the pixels; cap the ratio per quality level (Ultra keeps 2×).
    const cap = this.settings.graphics === 'ultra' ? 2 : this.settings.graphics === 'high' ? 1.5 : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap) * this.settings.renderScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx?.resize();
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (!this.externalDrive) this.tick(dt);
    this.postfx.render();
  };

  private handleKeys() {
    const i = this.input;
    this.checkCheatCode();
    if (this.vehicles.driving) {
      if (i.wasPressed('KeyE') || i.wasPressed('KeyF')) this.vehicles.exit();
      else if (i.wasPressed('KeyM')) this.ui.phone.open();
      else if (i.wasPressed('KeyN')) this.ui.openMap();
      else if (i.wasPressed('KeyT')) this.openChat();
      else if (i.wasPressed('KeyH')) this.audio.play('denied', this.vehicles.driving.pos);
      return;
    }
    if (i.wasPressed('Tab')) this.ui.openInventory();
    else if (i.wasPressed('KeyM')) this.ui.phone.open();
    else if (i.wasPressed('KeyN')) this.ui.openMap();
    else if (i.wasPressed('KeyC')) {
      const msg = this.substances.take();
      this.ui.toast(msg, this.substances.high ? 'info' : 'warn');
    } else if (i.wasPressed('KeyT')) this.openChat();
    else if (i.wasPressed('KeyR') && !this.placement.heldKind()) {
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
      // Holding equipment: E places it, unless you're aiming at something you can use (a door, a pot...).
      const free = !this.interaction.carrying && !this.interaction.current;
      this.placement.update(this.input, playing && free);
    } else {
      this.interaction.update(0, this.input, false);
      this.placement.update(this.input, false);
    }
    if (playing && !this.player.canBoard() && this.player.onBoard) this.player.toggleBoard();
    // Camera shake from crashes.
    if (this.shakeAmt > 0) {
      this.shakeAmt = Math.max(0, this.shakeAmt - dt * 1.5);
      this.camera.position.x += (Math.random() - 0.5) * this.shakeAmt * 0.3;
      this.camera.position.y += (Math.random() - 0.5) * this.shakeAmt * 0.3;
    }
    const inside = this.properties.siteAt(this.player.position) !== null || this.world.shop?.inside(this.player.position) === true || this.world.casino?.inside(this.player.position) === true;
    this.indoors = inside;
    this.indoorBlend += ((this.indoors ? 1 : 0) - this.indoorBlend) * Math.min(1, dt * 3);
    const focus = this.mode === 'title' ? this.camera.position : this.player.position;
    this.sky.update(this.time, focus, this.indoorBlend, dt, this.camera);
    this.postfx.update(this.sky.night, this.sky.dusk);
    this.world.update(dt, this.sky.night, this.player.position, this.camera.position);
    this.world.culler.viewDistance = this.settings.viewDistance;
    this.world.culler.update(dt, this.camera, this.player.position);
    this.detail?.update(dt, this.camera.position);
    this.lights?.update(dt, this.camera.position);
    const m = this.time.minutes;
    const simDt = playing || this.externalDrive ? dt : 0;
    const curfew = isCurfew(m);
    this.peds.update(simDt, this.sky.night, curfew);
    if (playing) this.curfewNotices(m, curfew);
    this.substances.update(simDt);
    this.ui.hud.setCurfew(curfew, !curfew && m >= 22 * 60 + 30);
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
