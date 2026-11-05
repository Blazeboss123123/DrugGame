import * as THREE from 'three';
import type { Services } from '../core/Services';
import { SimpleInteractable, ownMaterial } from '../interaction/Interactable';
import { Door } from '../interaction/Objects';
import type { CharacterInstance, CharacterPool, Outfit } from '../npc/Characters';
import { openBlackjack, openDoubleUp, openSlots } from '../ui/CasinoGames';
import type { Heightmap, Pad } from '../world/Heightmap';
import { letterTexture } from '../world/Textures';
import { BuildKit, type Opening } from './BuildKit';
import { loadKitMaterials } from './Properties';

/** Lucky 7 Casino on Main St, downtown. Front faces -z (Main St). Open around the clock. */
export const CASINO = { x: 37.5, z: 25, w: 30, d: 22, opens: 20 * 60, closes: 4 * 60 };

/** The Lucky 7 opens its doors at 20:00 and closes at 04:00. */
export const casinoOpen = (minutes: number) => minutes >= CASINO.opens || minutes < CASINO.closes;
export const CASINO_PAD = { x0: CASINO.x - CASINO.w / 2 - 2, x1: CASINO.x + CASINO.w / 2 + 2, z0: CASINO.z - CASINO.d / 2 - 6, z1: CASINO.z + CASINO.d / 2 + 2 };
const H = 6;
const FLOOR = 0.2;
const SLOTS = 6;

function carpetTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#5a0f1e';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 64)
    for (let x = 0; x < 256; x += 64) {
      g.fillStyle = '#7a1a2c';
      g.beginPath();
      g.moveTo(x + 32, y + 4);
      g.lineTo(x + 60, y + 32);
      g.lineTo(x + 32, y + 60);
      g.lineTo(x + 4, y + 32);
      g.fill();
      g.fillStyle = '#d8a845';
      g.beginPath();
      g.arc(x + 32, y + 32, 6, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(216,168,69,0.45)';
      g.lineWidth = 2;
      g.strokeRect(x + 2, y + 2, 60, 60);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function feltTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0f5a34';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = 'rgba(240,220,160,0.8)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(256, -40, 220, 0.25 * Math.PI, 0.75 * Math.PI);
  g.stroke();
  g.fillStyle = 'rgba(240,220,160,0.85)';
  g.font = '700 26px Georgia, serif';
  g.textAlign = 'center';
  g.fillText('BLACKJACK PAYS 3 TO 2', 256, 120);
  g.font = '500 16px Georgia, serif';
  g.fillText('Dealer stands on all 17s', 256, 150);
  for (let i = 0; i < 5; i++) {
    const a = (0.3 + i * 0.1) * Math.PI;
    g.strokeRect(256 + Math.cos(a) * 170 - 22, -40 + Math.sin(a) * 170 - 30 + 40, 44, 60);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function reelTexture(seed: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 128);
  grad.addColorStop(0, '#2a0f3a');
  grad.addColorStop(1, '#120618');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 128);
  const sym = ['7', '♦', '★', '🍒', '🔔', '🍋'];
  g.font = '700 58px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let i = 0; i < 3; i++) {
    g.fillStyle = '#f7f0e0';
    g.fillRect(12 + i * 80, 16, 72, 96);
    g.fillStyle = ['#c0192c', '#1c5fc0', '#d4a020'][(i + seed) % 3];
    g.fillText(sym[(i * 2 + seed) % sym.length], 48 + i * 80, 66);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * The Lucky 7: neon frontage with chasing marquee bulbs, a carpeted floor with six slot machines,
 * a blackjack table with a dealer, and the Double Up card table. Everything is played with real cash.
 */
export class Casino {
  readonly group = new THREE.Group();
  readonly origin: THREE.Vector3;
  private bulbs: THREE.MeshStandardMaterial[] = [];
  private screens: THREE.MeshStandardMaterial[] = [];
  private staff: { pos: THREE.Vector3; yaw: number; outfit: Outfit; inst: CharacterInstance | null }[] = [];
  private t = 0;
  private signMat!: THREE.MeshStandardMaterial;
  private lights: THREE.PointLight[] = [];
  door!: Door;

  get open() {
    return casinoOpen(this.svc.time.minutes);
  }

  private play(fn: () => void) {
    if (this.open) fn();
    else this.svc.ui.toast('The Lucky 7 is closed. Doors open at 20:00.', 'warn');
  }

  constructor(
    private svc: Services,
    private hm: Heightmap,
    pad: Pad,
    private chars: CharacterPool | null,
  ) {
    this.origin = new THREE.Vector3(CASINO.x, pad.h! + FLOOR, CASINO.z);
    this.group.name = 'casino';
    svc.scene.add(this.group);
  }

  private L = (x: number, y: number, z: number) => new THREE.Vector3(this.origin.x + x, this.origin.y + y, this.origin.z + z);

  inside(p: THREE.Vector3) {
    return Math.abs(p.x - this.origin.x) < CASINO.w / 2 && Math.abs(p.z - this.origin.z) < CASINO.d / 2 && p.y > this.origin.y - 0.6 && p.y < this.origin.y + H;
  }

  async build(): Promise<void> {
    const m = await loadKitMaterials();
    const svc = this.svc;
    const k = new BuildKit(this.origin, svc.physics);
    const hw = CASINO.w / 2;
    const hd = CASINO.d / 2;
    const g0 = this.hm.get(CASINO.x, CASINO.z - hd - 3) - this.origin.y;
    k.box('concrete', -hw - 0.2, g0 - 0.8, -hd - 0.2, hw + 0.2, 0, hd + 0.2);
    k.box('carpet', -hw + 0.1, 0, -hd + 0.1, hw - 0.1, 0.012, hd - 0.1, { collide: false, uv: 0.33 });
    k.box('roof', -hw - 0.4, H, -hd - 0.4, hw + 0.4, H + 0.4, hd + 0.4, { bottom: true });
    k.box('ceiling', -hw + 0.1, H - 0.05, -hd + 0.1, hw - 0.1, H - 0.01, hd - 0.1, { collide: false, bottom: true });
    // Canopy over the entrance, held up by two gold columns.
    k.box('gold', -5, H - 1.6, -hd - 3.2, 5, H - 1.35, -hd, { collide: false });
    for (const x of [-4.6, 4.6]) k.box('gold', x - 0.18, g0, -hd - 3.0, x + 0.18, H - 1.6, -hd - 2.64);
    k.box('red', -5.1, H - 1.75, -hd - 3.3, 5.1, H - 1.6, -hd - 3.15, { collide: false });
    if (-g0 > 0.05) k.box('concrete', -4, g0, -hd - 2.4, 4, -0.02, -hd - 0.2);

    const win = (a: number, b: number, bottom = 0.8, top = 3.4) => ({ a, b, bottom, top, glass: true }) as Opening;
    const gap = (a: number, b: number, top: number) => ({ a, b, bottom: 0, top }) as Opening;
    k.wallX(-hd, -hw, hw, H, [win(-13.5, -4.5), gap(-1.6, 1.6, 3), win(4.5, 13.5)], 'facade', 'wallIn', -1, 0.3);
    k.wallX(hd, -hw, hw, H, [], 'facade', 'wallIn', 1, 0.3);
    k.wallZ(-hw, -hd + 0.15, hd - 0.15, H, [], 'facade', 'wallIn', -1, 0.3);
    k.wallZ(hw, -hd + 0.15, hd - 0.15, H, [], 'facade', 'wallIn', 1, 0.3);
    // Gold band and a dark plinth along the frontage.
    k.box('gold', -hw - 0.2, 3.7, -hd - 0.22, hw + 0.2, 3.85, -hd - 0.15, { collide: false });
    k.box('dark', -hw - 0.2, 0, -hd - 0.24, hw + 0.2, 0.5, -hd - 0.15, { collide: false });

    // Slot machines along the left (-x) wall, facing +x.
    const slotX = -hw + 1.0;
    for (let i = 0; i < SLOTS; i++) {
      const z = -hd + 3.2 + i * 2.6;
      k.box('cabinet', slotX - 0.45, 0, z - 0.5, slotX + 0.45, 1.05, z + 0.5);
      k.box('cabinetTop', slotX - 0.4, 1.05, z - 0.45, slotX + 0.2, 1.95, z + 0.45, { collide: false });
      k.box('gold', slotX + 0.2, 1.0, z - 0.48, slotX + 0.5, 1.07, z + 0.48, { collide: false });
      k.box('dark', slotX - 0.3, 0.55, z - 0.42, slotX + 0.47, 0.62, z + 0.42, { collide: false });
      k.box('stool', slotX + 1.1, 0, z - 0.2, slotX + 1.5, 0.65, z + 0.2);
    }
    // Blackjack table (right half) and the Double Up table (back centre).
    k.box('wood', 5, 0, -1.2, 11, 0.85, 1.2);
    k.box('dark', 5.6, 0, 1.2, 10.4, 0.15, 3.6, { collide: false });
    k.box('wood', -3.4, 0, 4.2, 3.4, 0.85, 6.2);
    // Cashier cage at the back right.
    k.box('wood', 8, 0, 8.6, 14.5, 1.1, 9.4);
    k.box('gold', 8, 1.1, 8.6, 14.5, 2.4, 8.68, { collide: false });
    k.box('wallIn', 8, 0, 9.4, 14.5, H, 10.7);
    // Feature columns.
    for (const [x, z] of [
      [-6, -4],
      [-6, 4],
      [3, -4],
      [13, -4],
    ])
      k.box('gold', x - 0.3, 0, z - 0.3, x + 0.3, H, z + 0.3);

    const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.6, ...p });
    const facadeTex = letterTexture('', '#1a1220', '#1a1220', 64, 64);
    k.build(
      {
        concrete: m.concrete,
        roof: m.roof,
        glass: m.glass,
        frame: m.frame,
        dark: m.dark,
        wood: std({ map: m.wood instanceof THREE.MeshStandardMaterial ? m.wood.map : null, color: 0x6a3a22, roughness: 0.45 }),
        carpet: std({ map: carpetTexture(), roughness: 0.95 }),
        ceiling: std({ color: 0x1c1018, roughness: 0.9 }),
        facade: std({ map: facadeTex, color: 0x2a1830, roughness: 0.5, metalness: 0.3 }),
        wallIn: std({ color: 0x3a1a28, roughness: 0.8 }),
        gold: std({ color: 0xd9a63a, metalness: 0.9, roughness: 0.3 }),
        red: std({ color: 0xb3172c, emissive: 0x6a0010, emissiveIntensity: 0.6 }),
        cabinet: std({ color: 0x2a1640, metalness: 0.4, roughness: 0.35 }),
        cabinetTop: std({ color: 0x3a2060, metalness: 0.4, roughness: 0.35 }),
        stool: std({ color: 0x8a1a2a, roughness: 0.5 }),
      },
      this.group,
      ['glass'],
    );

    // Slot screens and top lights (animated), plus the interactable for each machine.
    for (let i = 0; i < SLOTS; i++) {
      const z = -hd + 3.2 + i * 2.6;
      const screenMat = new THREE.MeshStandardMaterial({ map: reelTexture(i), emissive: 0xffffff, emissiveMap: reelTexture(i), emissiveIntensity: 0.7 });
      this.screens.push(screenMat);
      const screen = ownMaterial(new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.42), screenMat));
      screen.position.copy(this.L(slotX + 0.21, 1.42, z));
      screen.rotation.y = Math.PI / 2;
      this.group.add(screen);
      const topMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: [0xff3355, 0x33aaff, 0xffcc33][i % 3], emissiveIntensity: 2 });
      this.bulbs.push(topMat);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.22, 16), topMat);
      top.position.copy(this.L(slotX - 0.1, 2.08, z));
      this.group.add(top);
      const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.5, 8), m.dark);
      lever.position.copy(this.L(slotX + 0.1, 1.2, z + 0.55));
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshStandardMaterial({ color: 0xc0192c, roughness: 0.3 }));
      knob.position.copy(this.L(slotX + 0.1, 1.47, z + 0.55));
      this.group.add(lever, knob);
      const it = new SimpleInteractable(`casino:slot-${i}`, () => (this.open ? `Play slot machine ${i + 1}` : 'Closed · opens 20:00'), () => this.play(() => openSlots(svc, i)), [screen], 2.6);
      const p = this.L(slotX, 1.0, z);
      const col = svc.physics.box(p.x, p.y, p.z, 0.5, 1.0, 0.5);
      col.setSensor(true);
      svc.physics.tag(col, { interactable: it });
      svc.interaction.register(it);
    }

    // Blackjack felt + dealer.
    const felt = ownMaterial(new THREE.Mesh(new THREE.PlaneGeometry(5.8, 2.2), new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.95 })));
    felt.rotation.x = -Math.PI / 2;
    felt.rotation.z = Math.PI;
    felt.position.copy(this.L(8, 0.86, 0));
    this.group.add(felt);
    const bj = new SimpleInteractable('casino:blackjack', () => (this.open ? 'Play blackjack' : 'Table closed · opens 20:00'), () => this.play(() => openBlackjack(svc)), [felt], 3);
    const bp = this.L(8, 0.9, 0);
    const bc = svc.physics.box(bp.x, bp.y, bp.z, 3, 0.2, 1.2);
    bc.setSensor(true);
    svc.physics.tag(bc, { interactable: bj });
    svc.interaction.register(bj);
    this.staff.push({ pos: this.L(8, 0, 1.8), yaw: Math.PI, outfit: 'Suit', inst: null });

    // Double Up table: dark felt with three card spots.
    const duTex = letterTexture('DOUBLE UP  ·  x2  x4  x8', '#14361f', '#f0dca0', 512, 96);
    const du = ownMaterial(new THREE.Mesh(new THREE.PlaneGeometry(6.6, 1.8), new THREE.MeshStandardMaterial({ map: duTex, roughness: 0.9 })));
    du.rotation.x = -Math.PI / 2;
    du.position.copy(this.L(0, 0.86, 5.2));
    this.group.add(du);
    const dut = new SimpleInteractable('casino:doubleup', () => (this.open ? 'Play Double Up (x2 · x4 · x8)' : 'Table closed · opens 20:00'), () => this.play(() => openDoubleUp(svc)), [du], 3);
    const dp = this.L(0, 0.9, 5.2);
    const dc = svc.physics.box(dp.x, dp.y, dp.z, 3.4, 0.2, 1);
    dc.setSensor(true);
    svc.physics.tag(dc, { interactable: dut });
    svc.interaction.register(dut);
    this.staff.push({ pos: this.L(0, 0, 6.9), yaw: Math.PI, outfit: 'Suit', inst: null });

    // Glass entrance door: locked until 20:00 (you can always get out).
    const dm = new THREE.MeshStandardMaterial({ color: 0xd9a63a, roughness: 0.2, metalness: 0.6, transparent: true, opacity: 0.55 });
    this.door = new Door(svc, 'casino:door', this.L(-1.6, 0, -hd), 0, 3.2, 3, dm, 'door', () =>
      this.open || this.inside(svc.player.position) ? null : 'Lucky 7 is closed · opens 20:00 (until 04:00)',
    );
    svc.interaction.register(this.door);

    // Lights: warm chandeliers inside.
    for (const [x, z] of [
      [-8, -3],
      [0, 0],
      [8, 0],
      [0, 6],
    ]) {
      const l = new THREE.PointLight(0xffd8a0, 14, 16, 2);
      l.position.copy(this.L(x, H - 0.8, z));
      this.group.add(l);
      this.lights.push(l);
      const ch = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd8a0, emissiveIntensity: 3, roughness: 0.2 }));
      ch.position.copy(this.L(x, H - 0.7, z));
      this.group.add(ch);
    }

    // Neon sign and chasing marquee bulbs on the frontage.
    const sign = letterTexture('LUCKY 7 CASINO', '#000000', '#ffcf3a', 1024, 160);
    const signMat = (this.signMat = new THREE.MeshStandardMaterial({ map: sign, emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: 2.4, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(13, 2), signMat);
    signMesh.position.copy(this.L(0, 4.85, -hd - 0.4));
    signMesh.rotation.y = Math.PI;
    this.group.add(signMesh);
    const backing = new THREE.Mesh(new THREE.PlaneGeometry(14, 2.4), new THREE.MeshStandardMaterial({ color: 0x120a16, roughness: 0.5 }));
    backing.position.copy(this.L(0, 4.85, -hd - 0.36));
    backing.rotation.y = Math.PI;
    this.group.add(backing);
    const bulbGeo = new THREE.SphereGeometry(0.09, 8, 6);
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.MeshStandardMaterial({ color: 0xfff1c0, emissive: 0xffc860, emissiveIntensity: 2.5 });
      this.bulbs.push(mat);
      for (let x = -14.6 + i * 0.6; x <= 14.6; x += 1.2) {
        const b = new THREE.Mesh(bulbGeo, mat);
        b.position.copy(this.L(x, H + 0.15, -hd - 0.3));
        this.group.add(b);
      }
      for (let x = -4.8 + i * 0.6; x <= 4.8; x += 1.2) {
        const b = new THREE.Mesh(bulbGeo, mat);
        b.position.copy(this.L(x, H - 1.32, -hd - 3.3));
        this.group.add(b);
      }
    }
    const glow = new THREE.PointLight(0xffb84a, 22, 22, 2);
    glow.position.copy(this.L(0, 3.5, -hd - 3));
    this.group.add(glow);
    // Uplights washing the frontage in magenta and gold.
    for (const [x, c] of [
      [-10, 0xff3fa0],
      [10, 0xffb84a],
      [-4, 0x8a5cff],
      [4, 0x8a5cff],
    ] as const) {
      const l = new THREE.PointLight(c, 16, 12, 2);
      l.position.copy(this.L(x, 0.6, -hd - 1.2));
      this.group.add(l);
    }
  }

  update(dt: number) {
    this.t += dt;
    // Marquee chase: the two bulb sets alternate.
    const phase = Math.floor(this.t * 3) % 2;
    const open = this.open;
    this.bulbs.forEach((b, i) => {
      if (i < SLOTS) b.emissiveIntensity = open ? 1.5 + Math.sin(this.t * 4 + i) * 1.2 : 0.2;
      else b.emissiveIntensity = open ? ((i - SLOTS) % 2 === phase ? 3.2 : 0.4) : 0;
    });
    this.signMat.emissiveIntensity = open ? 2.4 : 0.25;
    // At closing time the doors swing shut behind the last customer.
    if (!open && this.door?.isOpen && !this.inside(this.svc.player.position) && Math.hypot(this.svc.player.position.x - this.origin.x, this.svc.player.position.z - (this.origin.z - CASINO.d / 2)) > 3) this.door.interact();
    for (const l of this.lights) l.intensity = open ? 14 : 2;
    for (const s of this.screens) s.emissiveIntensity = 0.6 + Math.sin(this.t * 2) * 0.1;
    // Dealers: borrowed from the character pool while you're nearby.
    const pl = this.svc.player.position;
    const near = open && Math.hypot(pl.x - this.origin.x, pl.z - this.origin.z) < 60;
    for (const s of this.staff) {
      if (this.chars && near && !s.inst) {
        s.inst = this.chars.acquire(s.outfit, this);
        if (s.inst) {
          s.inst.setLook({ skin: 0xd2a07a, hair: 0x1a1410, hue: 0 });
          s.inst.root.position.copy(s.pos);
          s.inst.root.rotation.y = s.yaw;
          s.inst.play('Idle');
        }
      } else if (s.inst && !near) {
        this.chars!.release(s.inst);
        s.inst = null;
      }
      s.inst?.update(dt);
    }
  }
}
