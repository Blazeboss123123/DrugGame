import * as THREE from 'three';
import type { Services } from '../core/Services';
import type { HighLook, PostFX } from '../environment/PostFX';
import { EFFECTS, ITEMS, QUALITY_NAMES } from '../products/Catalog';
import type { PlayerController } from './PlayerController';

/**
 * Taking your own product. Every effect in the mix changes how you move and how the world looks,
 * so different recipes really feel different. While it's in your system, a police search finds it.
 */
interface Mod {
  speed?: number;
  jump?: number;
  gravity?: number;
  fov?: number;
  wobble?: number;
  shake?: number;
  tint?: number;
  tintAmt?: number;
  hueSpin?: number;
  warp?: number;
  chroma?: number;
  exposure?: number;
  saturation?: number;
  vignette?: number;
  bloom?: number;
  text: string;
}

export const SIDE_EFFECTS: Record<string, Mod> = {
  calming: { speed: 0.85, saturation: -0.2, vignette: 0.15, text: 'everything slows down' },
  bright: { exposure: 1.25, bloom: 0.35, text: 'the world is too bright' },
  fizzy: { jump: 1.35, chroma: 0.6, text: 'bouncy legs' },
  minty: { tint: 0x9fe8ff, tintAmt: 0.22, text: 'everything feels cold' },
  spicy: { speed: 1.12, tint: 0xff6a4a, tintAmt: 0.25, shake: 0.2, text: 'sweating, heart racing' },
  sweet: { tint: 0xffa6d8, tintAmt: 0.25, saturation: 0.35, text: 'candy-coloured' },
  glowing: { bloom: 1.1, exposure: 1.1, text: 'lights glow and smear' },
  electric: { speed: 1.35, shake: 0.5, chroma: 1.2, text: 'wired, twitchy and fast' },
  smoky: { saturation: -0.35, vignette: 0.35, exposure: 0.85, text: 'heavy and hazy' },
  zesty: { speed: 1.15, tint: 0xffe066, tintAmt: 0.18, text: 'sharp and alert' },
  dreamy: { wobble: 0.7, fov: 8, warp: 0.6, speed: 0.92, text: 'floaty, the street sways' },
  shimmering: { hueSpin: 1, chroma: 0.6, text: 'colours keep shifting' },
  cosmic: { fov: 18, gravity: 0.55, jump: 1.25, tint: 0x9c7aff, tintAmt: 0.25, warp: 0.4, text: 'weightless, the sky opens up' },
  gilded: { tint: 0xffd36a, tintAmt: 0.35, exposure: 1.1, text: 'everything turns gold' },
  foggy: { vignette: 0.55, saturation: -0.45, exposure: 0.8, speed: 0.9, text: 'can barely see straight' },
  jittery: { shake: 0.8, speed: 1.2, chroma: 0.4, text: 'jittery and paranoid' },
  velvet: { tint: 0xc0304a, tintAmt: 0.3, saturation: 0.25, wobble: 0.25, text: 'warm and heavy' },
};

const DURATION = 80; // real seconds of effects
const TRACE = 120; // extra seconds it still shows up in a search

export class Substances {
  private effects: string[] = [];
  private t = 0;
  private dur = 0;
  /** Seconds left that a police search will find drugs in your system. */
  traces = 0;
  private hueT = 0;
  private look: HighLook = { tint: new THREE.Color(1, 1, 1), tintAmt: 0, hue: 0, warp: 0, chroma: 0, exposure: 1, saturation: 0, vignette: 0, bloom: 0 };

  constructor(
    private svc: Services,
    private player: PlayerController,
    private postfx: PostFX,
  ) {}

  get high() {
    return this.t > 0;
  }

  /** Something in your system a search would find. */
  get inSystem() {
    return this.t > 0 || this.traces > 0;
  }

  get activeEffects() {
    return this.effects;
  }

  /** Can the held stack be taken? */
  canTake(id: string | undefined): boolean {
    if (!id) return false;
    const k = ITEMS[id]?.kind;
    return k === 'product' || k === 'packaged';
  }

  /** Takes one of the held item. Returns a message for the player. */
  take(): string {
    const svc = this.svc;
    const held = svc.held();
    if (!held || !this.canTake(held.id)) return 'Hold some product in your hotbar to take it.';
    const v = svc.variants.byKey(held.v);
    if (!svc.inventory.remove(held.id, 1, held.v)) return 'Nothing to take.';
    const effects = v?.effects.length ? v.effects : ['calming'];
    // A new dose replaces the old mix and resets the clock; stacking doses lasts a bit longer.
    this.effects = [...effects];
    this.dur = DURATION * (this.t > 0 ? 1.3 : 1) * (1 + (v?.quality ?? 0) * 0.15);
    this.t = this.dur;
    this.traces = this.dur + TRACE;
    svc.audio.play('pickup');
    svc.bus.emit('player:took', { effects });
    const what = v ? `${v.name} (${QUALITY_NAMES[v.quality]})` : 'it';
    return `You took ${what}: ${effects.map((e) => SIDE_EFFECTS[e]?.text ?? EFFECTS[e]?.name ?? e).join(', ')}.`;
  }

  /** Sober up instantly (arrest, sleep). */
  clear() {
    this.t = 0;
    this.traces = 0;
    this.effects = [];
    this.apply(0);
  }

  update(dt: number) {
    if (this.traces > 0) this.traces = Math.max(0, this.traces - dt);
    if (this.t <= 0) return;
    this.t = Math.max(0, this.t - dt);
    // Kicks in over 4 s, fades over the last 15 s.
    const k = Math.min(1, (this.dur - this.t) / 4) * Math.min(1, this.t / 15);
    this.apply(k);
    if (this.t === 0) {
      this.effects = [];
      this.svc.ui.toast('The effects have worn off. It will still show up in a search for a couple of minutes.', 'info');
    }
  }

  private apply(k: number) {
    const p = this.player;
    const L = this.look;
    let speed = 1, jump = 1, gravity = 1, fov = 0, wobble = 0, shake = 0, hueSpin = 0;
    L.tintAmt = 0;
    L.warp = L.chroma = L.saturation = L.vignette = L.bloom = 0;
    L.exposure = 1;
    const tints: THREE.Color[] = [];
    for (const e of this.effects) {
      const m = SIDE_EFFECTS[e];
      if (!m) continue;
      if (m.speed) speed *= m.speed;
      if (m.jump) jump *= m.jump;
      if (m.gravity) gravity *= m.gravity;
      fov += m.fov ?? 0;
      wobble += m.wobble ?? 0;
      shake += m.shake ?? 0;
      hueSpin += m.hueSpin ?? 0;
      L.warp += m.warp ?? 0;
      L.chroma += m.chroma ?? 0;
      L.saturation += m.saturation ?? 0;
      L.vignette += m.vignette ?? 0;
      L.bloom += m.bloom ?? 0;
      if (m.exposure) L.exposure *= m.exposure;
      if (m.tint !== undefined) {
        tints.push(new THREE.Color(m.tint));
        L.tintAmt = Math.max(L.tintAmt, m.tintAmt ?? 0.2);
      }
    }
    const lerp = (a: number, b: number) => a + (b - a) * k;
    p.speedMul = lerp(1, Math.min(1.6, speed));
    p.jumpMul = lerp(1, Math.min(1.8, jump));
    p.gravityMul = lerp(1, gravity);
    p.fovAdd = lerp(0, Math.min(25, fov));
    p.wobble = lerp(0, Math.min(1, wobble));
    p.shake = lerp(0, Math.min(1.2, shake));
    if (tints.length) {
      L.tint.setRGB(0, 0, 0);
      for (const c of tints) L.tint.add(c);
      L.tint.multiplyScalar(1 / tints.length);
    }
    this.hueT += 0.016 * hueSpin;
    L.hue = hueSpin ? Math.sin(this.hueT * 2) * 1.2 * k : 0;
    L.tintAmt *= k;
    L.warp *= k;
    L.chroma *= k;
    L.saturation *= k;
    L.vignette *= k;
    L.bloom *= k;
    L.exposure = lerp(1, L.exposure);
    this.postfx.high = k > 0 ? L : null;
  }
}
