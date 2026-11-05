import type * as THREE from 'three';
import type { Surface } from '../core/EventBus';
import type { Settings } from '../core/Settings';

export type Sfx = 'doorOpen' | 'doorClose' | 'doorThud' | 'roller' | 'switch' | 'pickup' | 'place' | 'thud' | 'ui' | 'denied' | 'land' | 'paper' | 'jump';

/**
 * All sound is synthesised with Web Audio (no audio files): footsteps per surface, doors, UI
 * feedback, and a layered outdoor/indoor ambience that follows the time of day.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private amb!: GainNode;
  private noise!: AudioBuffer;
  private outdoor!: GainNode;
  private indoor!: GainNode;
  private crickets!: GainNode;
  private listener: { x: number; z: number } = { x: 0, z: 0 };
  private birdTimer = 2;
  private night = 0;

  constructor(private settings: Settings) {}

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.amb = ctx.createGain();
    this.amb.connect(this.master);
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      d[i] = w;
      b = b * 0.98 + w * 0.02; // brown-ish component mixed in later via filters
    }
    void b;
    this.applyVolumes();
    this.buildAmbience();
  }

  applyVolumes(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.master, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.settings.sfx, t, 0.05);
    this.amb.gain.setTargetAtTime(this.settings.ambience, t, 0.05);
  }

  private loopNoise(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.start();
    return src;
  }

  private buildAmbience(): void {
    const ctx = this.ctx!;
    // Distant city rumble: low-passed noise.
    this.outdoor = ctx.createGain();
    this.outdoor.gain.value = 0.5;
    this.outdoor.connect(this.amb);
    const rumble = this.loopNoise();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    const rg = ctx.createGain();
    rg.gain.value = 0.22;
    rumble.connect(lp).connect(rg).connect(this.outdoor);
    // Wind: band-passed noise with a slow LFO.
    const wind = this.loopNoise();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 700;
    bp.Q.value = 0.6;
    const wg = ctx.createGain();
    wg.gain.value = 0.035;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.025;
    lfo.connect(lfoG).connect(wg.gain);
    lfo.start();
    wind.connect(bp).connect(wg).connect(this.outdoor);
    // Indoor: quiet room tone.
    this.indoor = ctx.createGain();
    this.indoor.gain.value = 0;
    this.indoor.connect(this.amb);
    const hum = ctx.createOscillator();
    hum.frequency.value = 60;
    const hg = ctx.createGain();
    hg.gain.value = 0.012;
    hum.connect(hg).connect(this.indoor);
    hum.start();
    const tone = this.loopNoise();
    const tlp = ctx.createBiquadFilter();
    tlp.type = 'lowpass';
    tlp.frequency.value = 140;
    const tg = ctx.createGain();
    tg.gain.value = 0.09;
    tone.connect(tlp).connect(tg).connect(this.indoor);
    // Night crickets: pulsed high tone.
    this.crickets = ctx.createGain();
    this.crickets.gain.value = 0;
    this.crickets.connect(this.outdoor);
    const cr = ctx.createOscillator();
    cr.frequency.value = 4400;
    const crAmp = ctx.createGain();
    crAmp.gain.value = 0;
    const pulse = ctx.createOscillator();
    pulse.type = 'square';
    pulse.frequency.value = 14;
    const pg = ctx.createGain();
    pg.gain.value = 0.006;
    pulse.connect(pg).connect(crAmp.gain);
    cr.connect(crAmp).connect(this.crickets);
    cr.start();
    pulse.start();
  }

  /** Per-frame: crossfade indoor/outdoor beds, crickets at night, occasional birds by day. */
  update(dt: number, listener: THREE.Vector3, indoors: boolean, night: number): void {
    this.listener = { x: listener.x, z: listener.z };
    this.night = night;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.outdoor.gain.setTargetAtTime(indoors ? 0.12 : 0.5, t, 0.4);
    this.indoor.gain.setTargetAtTime(indoors ? 1 : 0, t, 0.4);
    this.crickets.gain.setTargetAtTime(night > 0.6 ? 1 : 0, t, 1.5);
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 3 + Math.random() * 7;
      if (night < 0.3 && !indoors) this.bird();
    }
  }

  private env(gain: GainNode, t: number, attack: number, peak: number, decay: number) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private attenuation(pos?: { x: number; z: number }): number {
    if (!pos) return 1;
    const d = Math.hypot(pos.x - this.listener.x, pos.z - this.listener.z);
    return 1 / (1 + d * 0.25);
  }

  private noiseBurst(t: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack: number, decay: number, out: AudioNode = this.sfx) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, attack, peak, decay);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + decay + 0.05);
  }

  private tone(t: number, type: OscillatorType, f0: number, f1: number, peak: number, attack: number, decay: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + attack + decay);
    const g = ctx.createGain();
    this.env(g, t, attack, peak, decay);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + attack + decay + 0.05);
  }

  footstep(surface: Surface, sprint: boolean): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = (sprint ? 1.25 : 1) * (0.85 + Math.random() * 0.3);
    switch (surface) {
      case 'grass':
      case 'dirt':
        this.noiseBurst(t, 'lowpass', 900 + Math.random() * 300, 0.7, 0.22 * v, 0.008, 0.12);
        break;
      case 'wood':
        this.noiseBurst(t, 'bandpass', 380 + Math.random() * 80, 1.4, 0.5 * v, 0.004, 0.09);
        this.tone(t, 'sine', 120, 70, 0.12 * v, 0.003, 0.08);
        break;
      case 'metal':
        this.noiseBurst(t, 'bandpass', 2600, 4, 0.22 * v, 0.002, 0.12);
        this.noiseBurst(t, 'lowpass', 500, 1, 0.15 * v, 0.003, 0.06);
        break;
      default:
        this.noiseBurst(t, 'bandpass', 1500 + Math.random() * 400, 1.1, 0.3 * v, 0.003, 0.06);
        this.noiseBurst(t, 'lowpass', 300, 0.8, 0.2 * v, 0.003, 0.05);
    }
  }

  play(name: Sfx, at?: THREE.Vector3 | { x: number; z: number }): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const a = this.attenuation(at as { x: number; z: number } | undefined);
    switch (name) {
      case 'doorOpen':
        this.tone(t, 'sawtooth', 190, 260, 0.03 * a, 0.05, 0.35);
        this.noiseBurst(t, 'bandpass', 900, 3, 0.08 * a, 0.02, 0.3);
        this.noiseBurst(t, 'bandpass', 2200, 6, 0.08 * a, 0.002, 0.04); // latch click
        break;
      case 'doorClose':
        this.noiseBurst(t, 'bandpass', 1000, 2, 0.05 * a, 0.05, 0.25);
        break;
      case 'doorThud':
        this.tone(t, 'sine', 110, 50, 0.5 * a, 0.004, 0.22);
        this.noiseBurst(t, 'lowpass', 400, 1, 0.3 * a, 0.003, 0.12);
        this.noiseBurst(t, 'bandpass', 2400, 6, 0.12 * a, 0.002, 0.03);
        break;
      case 'roller':
        for (let i = 0; i < 14; i++) this.noiseBurst(t + i * 0.12, 'bandpass', 1400 + Math.random() * 600, 3, 0.1 * a, 0.004, 0.08);
        this.tone(t, 'sawtooth', 70, 80, 0.04 * a, 0.2, 1.6);
        break;
      case 'switch':
        this.noiseBurst(t, 'highpass', 3000, 1, 0.25, 0.001, 0.025);
        this.tone(t, 'square', 1800, 1200, 0.03, 0.001, 0.02);
        break;
      case 'pickup':
        this.noiseBurst(t, 'bandpass', 700, 1.5, 0.18, 0.01, 0.12);
        this.tone(t, 'sine', 440, 520, 0.05, 0.01, 0.1);
        break;
      case 'place':
        this.tone(t, 'sine', 150, 90, 0.3 * a, 0.004, 0.12);
        this.noiseBurst(t, 'bandpass', 600, 1.2, 0.2 * a, 0.003, 0.08);
        break;
      case 'thud':
        this.tone(t, 'sine', 120, 55, 0.45 * a, 0.003, 0.18);
        this.noiseBurst(t, 'lowpass', 500, 1, 0.3 * a, 0.003, 0.1);
        break;
      case 'land':
        this.tone(t, 'sine', 90, 45, 0.3, 0.004, 0.14);
        this.noiseBurst(t, 'lowpass', 700, 0.8, 0.3, 0.003, 0.1);
        break;
      case 'jump':
        this.noiseBurst(t, 'bandpass', 1100, 1, 0.08, 0.005, 0.06);
        break;
      case 'ui':
        this.tone(t, 'triangle', 880, 990, 0.06, 0.004, 0.07);
        break;
      case 'denied':
        this.tone(t, 'square', 220, 180, 0.04, 0.004, 0.16);
        break;
      case 'paper':
        for (let i = 0; i < 3; i++) this.noiseBurst(t + i * 0.07, 'highpass', 2500, 0.7, 0.1, 0.01, 0.08);
        break;
    }
  }

  private bird(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const n = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 1600;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const st = t + i * 0.13;
      o.frequency.setValueAtTime(base, st);
      o.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.4), st + 0.07);
      const g = ctx.createGain();
      this.env(g, st, 0.01, 0.025, 0.08);
      o.connect(g).connect(this.outdoor);
      o.start(st);
      o.stop(st + 0.12);
    }
  }

  get running(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  get nightLevel() {
    return this.night;
  }
}
