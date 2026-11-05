import * as THREE from 'three';
import type { Services } from '../core/Services';
import { SimpleInteractable } from '../interaction/Interactable';
import { Door } from '../interaction/Objects';
import type { CharacterInstance, CharacterPool } from '../npc/Characters';
import type { Heightmap, Pad } from '../world/Heightmap';
import { letterTexture } from '../world/Textures';
import { BuildKit, type Opening } from './BuildKit';
import { loadKitMaterials } from './Properties';

/** Kwik Corner: footprint and opening hours. Front faces -z, across Larch Street from the starter house. */
export const SHOP = { x: -50, z: -56, w: 14, d: 10, opens: 7 * 60, closes: 23 * 60 };
export const SHOP_PAD = { x0: SHOP.x - SHOP.w / 2 - 2, x1: SHOP.x + SHOP.w / 2 + 2, z0: SHOP.z - SHOP.d / 2 - 5, z1: SHOP.z + SHOP.d / 2 + 2 };
/** Carry-out prices are this much above phone orders. */
export const SHOP_MARKUP = 1.15;

const H = 3.6;
const FLOOR = 0.2;

/**
 * The corner shop: a walk-in store selling equipment and supplies over the counter. Open 07:00–23:00;
 * outside those hours the door is locked and the OPEN sign is off.
 */
export class CornerShop {
  readonly group = new THREE.Group();
  readonly origin: THREE.Vector3;
  private openSign!: THREE.MeshStandardMaterial;
  private lights: THREE.PointLight[] = [];
  private keeper: CharacterInstance | null = null;
  private keeperPos: THREE.Vector3;
  door!: Door;

  constructor(
    private svc: Services,
    private hm: Heightmap,
    pad: Pad,
    private chars: CharacterPool | null,
  ) {
    this.origin = new THREE.Vector3(SHOP.x, pad.h! + FLOOR, SHOP.z);
    this.keeperPos = this.L(4.4, 0, 3.2);
    this.group.name = 'corner-shop';
    svc.scene.add(this.group);
  }

  get open(): boolean {
    const m = this.svc.time.minutes;
    return m >= SHOP.opens && m < SHOP.closes;
  }

  private L = (x: number, y: number, z: number) => new THREE.Vector3(this.origin.x + x, this.origin.y + y, this.origin.z + z);

  async build(): Promise<void> {
    const m = await loadKitMaterials();
    const svc = this.svc;
    const k = new BuildKit(this.origin, svc.physics);
    const hw = SHOP.w / 2;
    const hd = SHOP.d / 2;
    const g0 = this.hm.get(SHOP.x, SHOP.z - hd - 2) - this.origin.y;
    k.box('concrete', -hw - 0.2, g0 - 0.8, -hd - 0.2, hw + 0.2, 0, hd + 0.2);
    k.box('marble', -hw + 0.1, 0, -hd + 0.1, hw - 0.1, 0.01, hd - 0.1, { collide: false });
    k.box('roof', -hw - 0.5, H, -hd - 0.9, hw + 0.5, H + 0.35, hd + 0.4);
    // Awning over the shopfront.
    k.box('awning', -hw - 0.3, H - 0.55, -hd - 1.6, hw + 0.3, H - 0.45, -hd - 0.1, { collide: false });
    if (-g0 > 0.05) k.box('concrete', -1.6, g0, -hd - 1.3, 1.6, -0.02, -hd - 0.2);

    const win = (a: number, b: number, bottom = 0.55, top = 2.8) => ({ a, b, bottom, top, glass: true }) as Opening;
    const gap = (a: number, b: number, top: number) => ({ a, b, bottom: 0, top }) as Opening;
    k.wallX(-hd, -hw, hw, H, [win(-6.3, -1.2), gap(-0.6, 0.6, 2.3), win(1.2, 6.3)], 'brick', 'plaster', -1, 0.25);
    k.wallX(hd, -hw, hw, H, [], 'brick', 'plaster', 1, 0.25);
    k.wallZ(-hw, -hd + 0.12, hd - 0.12, H, [win(-2.5, 0.5, 1.1, 2.4)], 'brick', 'plaster', -1, 0.25);
    k.wallZ(hw, -hd + 0.12, hd - 0.12, H, [], 'brick', 'plaster', 1, 0.25);

    // Two gondola aisles packed with stock.
    const prodKeys = ['p0', 'p1', 'p2', 'p3', 'p4'];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const az of [-1.6, 1.0]) {
      const x0 = -6.2;
      const x1 = -1.4;
      k.box('dark', x0, 0, az - 0.35, x1, 0.12, az + 0.35);
      k.box('frame', x0, 0.12, az - 0.04, x1, 1.65, az + 0.04, { collide: false });
      k.collider(x0, 0, az - 0.35, x1, 1.65, az + 0.35, 'metal');
      for (const shelfY of [0.12, 0.6, 1.08]) {
        k.box('white', x0, shelfY, az - 0.35, x1, shelfY + 0.03, az + 0.35, { collide: false });
        for (const side of [-1, 1]) {
          let x = x0 + 0.05;
          while (x < x1 - 0.2) {
            const w = 0.12 + rnd() * 0.18;
            const h = 0.16 + rnd() * 0.24;
            const zc = az + side * 0.2;
            k.box(prodKeys[Math.floor(rnd() * prodKeys.length)], x, shelfY + 0.03, zc - 0.12, x + w, shelfY + 0.03 + h, zc + 0.12, { collide: false });
            x += w + 0.03;
          }
        }
      }
    }
    // Drinks cooler along the back wall.
    k.box('dark', -6.7, 0, 4.5, -1.6, 2.1, 4.85, { collide: false });
    k.box('dark', -6.7, 0, 4.08, -1.6, 0.15, 4.5, { collide: false });
    k.box('dark', -6.7, 1.98, 4.08, -1.6, 2.1, 4.5, { collide: false });
    k.box('coolerGlow', -6.6, 0.15, 4.47, -1.7, 1.98, 4.5, { collide: false });
    for (let shelfY = 0.25; shelfY < 1.9; shelfY += 0.42) {
      k.box('white', -6.65, shelfY - 0.02, 4.15, -1.65, shelfY, 4.47, { collide: false });
      for (let x = -6.5; x < -1.8; x += 0.13) k.box(prodKeys[Math.floor(rnd() * 5)], x, shelfY, 4.25, x + 0.08, shelfY + 0.2, 4.4, { collide: false });
    }
    k.box('glass', -6.65, 0.15, 4.08, -1.65, 1.98, 4.1, { collide: false });
    for (const x of [-6.7, -5.0, -3.3, -1.65]) k.box('frame', x - 0.03, 0.15, 4.06, x + 0.03, 1.98, 4.12, { collide: false });
    k.collider(-6.7, 0, 4.06, -1.6, 2.1, 4.85, 'metal');
    // Equipment display: boxed gear stacked along the right wall.
    for (let i = 0; i < 4; i++) {
      const z = -3.6 + i * 1.3;
      k.box('cardboard', 5.9, 0, z - 0.45, 6.7, 0.7, z + 0.45);
      k.box('cardboard', 6.0, 0.7, z - 0.35, 6.7, 1.2, z + 0.3);
    }
    // Counter with till, behind which the shopkeeper stands.
    k.box('wood', 2.4, 0, 1.9, 6.2, 1.0, 2.6);
    k.box('marble', 2.35, 1.0, 1.85, 6.25, 1.05, 2.65, { collide: false });
    k.box('dark', 3.0, 1.05, 2.0, 3.45, 1.3, 2.45, { collide: false });
    k.box('frame', 2.4, 0, 4.5, 6.2, 2.2, 4.85); // shelves behind the counter
    for (let y = 0.4; y < 2.1; y += 0.45) for (let x = 2.5; x < 6.0; x += 0.16) k.box(prodKeys[Math.floor(rnd() * 5)], x, y, 4.3, x + 0.1, y + 0.18, 4.48, { collide: false });
    // Ceiling strip lights.
    for (const x of [-4, 0, 4]) k.box('strip', x - 1.2, H - 0.05, -0.15, x + 1.2, H - 0.02, 0.15, { collide: false });

    const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.6, ...p });
    const cardboard = std({ color: 0xb58b5c, roughness: 0.9 });
    k.build(
      {
        concrete: m.concrete,
        marble: m.marble,
        roof: m.roof,
        brick: m.brick,
        plaster: m.plaster,
        glass: m.glass,
        frame: m.frame,
        white: m.white,
        dark: m.dark,
        wood: m.wood,
        cardboard,
        awning: std({ map: awningTexture(), side: THREE.DoubleSide }),
        coolerGlow: std({ color: 0xdff4ff, emissive: 0xbfe8ff, emissiveIntensity: 0.9 }),
        strip: std({ color: 0xffffff, emissive: 0xf2f6ff, emissiveIntensity: 1.6 }),
        p0: std({ color: 0xc23a2a }),
        p1: std({ color: 0x2f6bb0 }),
        p2: std({ color: 0xe0b33a }),
        p3: std({ color: 0x3f8f4a }),
        p4: std({ color: 0xeeeae0 }),
      },
      this.group,
      ['glass'],
    );

    // Lights: bright fluorescent interior, always on while trading.
    for (const x of [-4, 0, 4]) {
      const l = new THREE.PointLight(0xf2f6ff, 0, 12, 2);
      l.position.copy(this.L(x, H - 0.4, 0));
      this.group.add(l);
      this.lights.push(l);
    }

    // Shop sign and OPEN neon.
    const name = letterTexture('KWIK CORNER', '#1d5a3a', '#f5e9c8', 768, 128);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(6.5, 1.0), std({ map: name, emissive: 0xffffff, emissiveMap: name, emissiveIntensity: 0.35 }));
    sign.position.copy(this.L(0, H - 0.05, -hd - 0.92));
    sign.rotation.y = Math.PI;
    this.group.add(sign);
    const openTex = letterTexture('OPEN', '#000000', '#ff3b6b', 256, 96);
    this.openSign = new THREE.MeshStandardMaterial({ map: openTex, emissive: 0xffffff, emissiveMap: openTex, emissiveIntensity: 2.2, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const neon = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.42), this.openSign);
    neon.position.copy(this.L(2.4, 2.1, -hd + 0.06));
    neon.rotation.y = Math.PI;
    this.group.add(neon);
    const hours = letterTexture('7AM – 11PM', '#1d1f22', '#f1e6c8', 256, 64);
    const hp = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.13), std({ map: hours }));
    hp.position.copy(this.L(-0.9, 1.5, -hd - 0.14));
    hp.rotation.y = Math.PI;
    this.group.add(hp);

    // Front door: locked outside opening hours (unless you're already inside).
    const dm = new THREE.MeshStandardMaterial({ color: 0x9fc1cf, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.5 });
    this.door = new Door(svc, 'shop:door', this.L(-0.6, 0, -hd), 0, 1.2, 2.3, dm, 'door', () => (this.open || this.inside(svc.player.position) ? null : 'Kwik Corner is closed · opens 07:00'));
    svc.interaction.register(this.door);

    // The counter: the whole shop is served from here.
    const till = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.05, 0.8), std({ map: m.marble instanceof THREE.MeshStandardMaterial ? m.marble.map : null, color: 0xdedad2 }));
    till.position.copy(this.L(4.3, 1.03, 2.25));
    this.group.add(till);
    const counter = new SimpleInteractable(
      'shop:counter',
      () => (this.open ? 'Buy equipment and supplies' : 'Closed for the night'),
      () => (this.open ? svc.ui.panels.openShop(SHOP_MARKUP) : svc.ui.toast('The till is shut. Kwik Corner opens at 07:00.', 'warn')),
      [till],
      3,
    );
    const cp = this.L(4.3, 1.0, 2.25);
    const col = svc.physics.box(cp.x, cp.y, cp.z, 1.9, 0.2, 0.4);
    col.setSensor(true);
    svc.physics.tag(col, { interactable: counter });
    svc.interaction.register(counter);
  }

  inside(p: THREE.Vector3): boolean {
    const lx = p.x - this.origin.x;
    const lz = p.z - this.origin.z;
    return Math.abs(lx) < SHOP.w / 2 && Math.abs(lz) < SHOP.d / 2 && p.y > this.origin.y - 0.6 && p.y < this.origin.y + 3;
  }

  update(dt: number, night: number) {
    const open = this.open;
    this.openSign.emissiveIntensity = open ? 2.2 + Math.sin(performance.now() / 160) * 0.08 : 0;
    this.openSign.opacity = open ? 1 : 0.15;
    for (const l of this.lights) l.intensity = open ? 6 + night * 6 : 0;
    // Shopkeeper: borrowed from the character pool only while the player is nearby and the shop is open.
    const near = this.svc.player.position.distanceTo(this.keeperPos) < 70;
    if (this.chars && near && open && !this.keeper) {
      this.keeper = this.chars.acquire('Casual_2', this);
      if (this.keeper) {
        this.keeper.setLook({ skin: 0xc68e62, hair: 0x2a1d14, hue: 0.12 });
        this.keeper.root.position.copy(this.keeperPos);
        this.keeper.root.rotation.y = Math.PI;
        this.keeper.play('Idle');
      }
    } else if (this.keeper && (!near || !open)) {
      this.chars!.release(this.keeper);
      this.keeper = null;
    }
    if (this.keeper) {
      // Turn to face the player when they're in the shop.
      const p = this.svc.player.position;
      if (this.inside(p)) {
        const target = Math.atan2(p.x - this.keeperPos.x, p.z - this.keeperPos.z);
        let d = target - this.keeper.root.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.keeper.root.rotation.y += d * Math.min(1, dt * 3);
      }
      this.keeper.update(dt);
    }
  }
}

function awningTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? '#f1ece0' : '#2b7a4f';
    g.fillRect(i * 16, 0, 16, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
