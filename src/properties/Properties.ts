import * as THREE from 'three';
import type { Services } from '../core/Services';
import { SimpleInteractable, ownMaterial } from '../interaction/Interactable';
import { Door, LightCircuit, LightSwitch, RollerDoor } from '../interaction/Objects';
import { StorageBox, type SiteLayout } from '../production/Production';
import { DISTRICTS } from '../world/CityPlan';
import type { Heightmap, Pad } from '../world/Heightmap';
import { facadeTexture, letterTexture, noiseTexture } from '../world/Textures';
import { BuildKit, type Opening } from './BuildKit';
import { PROPERTIES, type PropertyDef } from './PropertyDefs';

/**
 * Purchasable properties: each is a real enterable building with a for-sale sign, locked doors until
 * you own it, lights, a storage shelf, a delivery box and slots for production equipment.
 * Walls and floors use the Downtown City MegaKit textures (CC0, Quaternius).
 */

const FLOOR = 0.25;

/** Layouts in each building's local frame (origin = floor centre, front wall at +d/2). */
const LAYOUTS: Record<string, SiteLayout> = {
  laundromat: {
    pots: [
      [-5.6, -4.6],
      [-4.4, -4.6],
      [-5.6, -3.4],
      [-4.4, -3.4],
    ],
    mixer: [[-1.2, -5.1, 0]],
    packager: [[1.4, -5.1, 0]],
    kettle: [[5.9, -3.2, -Math.PI / 2]],
    press: [],
    rest: [0.5, -2.2],
    storage: [4.2, -5.2],
    zones: [{ x0: -6.85, z0: -5.85, x1: 6.85, z1: -1.6 }],
    keepClear: [
      { x0: -0.8, z0: -2.7, x1: 0.9, z1: -1.2 },
      { x0: 2.9, z0: -5.6, x1: 5.5, z1: -4.6 },
    ],
  },
  barn: {
    pots: [
      [-8.2, -4.8],
      [-7, -4.8],
      [-5.8, -4.8],
      [-4.6, -4.8],
      [-3.4, -4.8],
      [-8.2, -3.4],
      [-7, -3.4],
      [-5.8, -3.4],
      [-4.6, -3.4],
      [-3.4, -3.4],
    ],
    mixer: [[1.5, -6, 0]],
    packager: [[4, -6, 0]],
    kettle: [[9.1, -3.5, -Math.PI / 2]],
    press: [],
    rest: [0, 0],
    storage: [7.2, -6.1],
    zones: [{ x0: -9.85, z0: -6.85, x1: 9.85, z1: 6.4 }],
    keepClear: [
      { x0: -2.5, z0: 4.4, x1: 2.5, z1: 7 },
      { x0: 2.0, z0: 5.0, x1: 6.4, z1: 7 },
      { x0: 5.9, z0: -6.9, x1: 8.5, z1: -5.5 },
    ],
  },
  warehouse: {
    pots: [-9.6, -8.4, -7.2, -6.0].flatMap((x) => [-6.6, -5.4, -4.2].map((z) => [x, z] as [number, number])),
    mixer: [
      [-1.5, -8, 0],
      [1, -8, 0],
    ],
    packager: [
      [3.5, -8, 0],
      [6, -8, 0],
    ],
    kettle: [
      [11.1, -4.5, -Math.PI / 2],
      [11.1, -2.5, -Math.PI / 2],
    ],
    press: [
      [11.1, 0, -Math.PI / 2],
      [11.1, 2.2, -Math.PI / 2],
    ],
    rest: [0, 2],
    storage: [9.3, -8.3],
    zones: [{ x0: -11.85, z0: -8.85, x1: 11.85, z1: 8.4 }],
    keepClear: [
      { x0: -2.8, z0: 6.4, x1: 2.8, z1: 9 },
      { x0: 2.8, z0: 7.2, x1: 7.4, z1: 9 },
      { x0: 8.0, z0: -9, x1: 10.6, z1: -7.6 },
    ],
  },
};

export interface KitMaterials {
  concrete: THREE.Material;
  metal: THREE.Material;
  brick: THREE.Material;
  marble: THREE.Material;
  dirt: THREE.Material;
  trim: THREE.Material;
  barn: THREE.Material;
  plaster: THREE.Material;
  glass: THREE.Material;
  frame: THREE.Material;
  roof: THREE.Material;
  white: THREE.Material;
  dark: THREE.Material;
  wood: THREE.Material;
}

async function loadTex(url: string, repeat: number, fallback: () => THREE.Texture): Promise<THREE.Texture> {
  try {
    const t = await new THREE.TextureLoader().loadAsync(url);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 8;
    return t;
  } catch {
    const f = fallback();
    f.repeat.set(repeat * 4, repeat * 4);
    return f;
  }
}

export async function loadKitMaterials(base = './assets/megakit/'): Promise<KitMaterials> {
  const [concrete, metal, brick, marble, dirt, trim] = await Promise.all([
    loadTex(`${base}T_Concrete_BaseColor.jpg`, 0.33, () => noiseTexture(301, '#8f8b84', '#ccc', '#444', 9000, 2)),
    loadTex(`${base}T_MetalConcrete_BaseColor.jpg`, 0.25, () => facadeTexture('corrugated', 302).map),
    loadTex(`${base}T_RedBrick_BaseColor.jpg`, 0.33, () => facadeTexture('brick', 303).map),
    loadTex(`${base}T_MarbleFloor_BaseColor.jpg`, 0.4, () => noiseTexture(304, '#d9d4cb', '#fff', '#888', 5000, 2)),
    loadTex(`${base}T_Dirt_BaseColor.jpg`, 0.25, () => noiseTexture(305, '#6b5640', '#998066', '#2a2018', 12000, 3)),
    loadTex(`${base}T_Trim_BaseColor.jpg`, 0.5, () => noiseTexture(306, '#bdb8ae', '#fff', '#555', 4000, 2)),
  ]);
  const std = (p: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.85, ...p });
  const barnTex = facadeTexture('barn', 307).map;
  barnTex.repeat.set(0.25, 0.25);
  return {
    concrete: std({ map: concrete }),
    metal: std({ map: metal, roughness: 0.6, metalness: 0.2 }),
    brick: std({ map: brick }),
    marble: std({ map: marble, roughness: 0.35 }),
    dirt: std({ map: dirt, roughness: 1 }),
    trim: std({ map: trim }),
    barn: std({ map: barnTex }),
    plaster: std({ map: noiseTexture(308, '#d8d3c8', '#fff', '#777', 5000, 2) }),
    glass: new THREE.MeshStandardMaterial({ color: 0xa9c6d6, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.25, depthWrite: false }),
    frame: std({ color: 0x2b2e33, roughness: 0.5, metalness: 0.4 }),
    roof: std({ color: 0x55524d, roughness: 0.95 }),
    white: std({ color: 0xeceae4, roughness: 0.4 }),
    dark: std({ color: 0x1d1f22, roughness: 0.5 }),
    wood: std({ map: noiseTexture(309, '#8a6a4a', '#b08a62', '#4a3422', 8000, 3) }),
  };
}

/** One purchasable building in the world. */
export class PropertyBuilding {
  readonly origin: THREE.Vector3;
  readonly floorY: number;
  readonly group = new THREE.Group();
  private signMat!: THREE.MeshStandardMaterial;
  private circuit!: LightCircuit;

  constructor(
    private svc: Services,
    readonly def: PropertyDef,
    pad: Pad,
    private hm: Heightmap,
    private mats: KitMaterials,
  ) {
    this.floorY = pad.h! + FLOOR;
    this.origin = new THREE.Vector3(def.x, this.floorY, def.z);
    svc.scene.add(this.group);
    this.build(pad.h!);
  }

  get owned() {
    return this.svc.properties.owns(this.def.id);
  }

  L = (x: number, y: number, z: number) => new THREE.Vector3(this.origin.x + x, this.origin.y + y, this.origin.z + z);

  contains(p: THREE.Vector3) {
    const lx = p.x - this.origin.x;
    const lz = p.z - this.origin.z;
    return Math.abs(lx) < this.def.w / 2 - 0.1 && Math.abs(lz) < this.def.d / 2 - 0.1 && p.y > this.floorY - 0.6 && p.y < this.floorY + 4;
  }

  private lock = () => (this.owned ? null : `Locked: ${this.def.name} is for sale`);

  private build(ground: number) {
    const { def, mats: m, svc } = this;
    const k = new BuildKit(this.origin, svc.physics);
    const hw = def.w / 2;
    const hd = def.d / 2;
    const H = def.kind === 'warehouse' ? 6.5 : def.kind === 'barn' ? 5.5 : 3.6;
    const g0 = ground - this.floorY;
    const ext = def.kind === 'laundromat' ? 'brick' : def.kind === 'barn' ? 'barn' : 'metal';
    const floorKey = def.kind === 'laundromat' ? 'marble' : def.kind === 'barn' ? 'dirt' : 'concrete';
    const intKey = def.kind === 'laundromat' ? 'plaster' : def.kind === 'barn' ? 'wood' : 'concrete';
    // Slab, floor and roof.
    k.box('concrete', -hw - 0.2, g0 - 0.8, -hd - 0.2, hw + 0.2, 0, hd + 0.2);
    k.box(floorKey, -hw + 0.1, 0, -hd + 0.1, hw - 0.1, 0.01, hd - 0.1, { collide: false });
    k.box('roof', -hw - 0.4, H, -hd - 0.4, hw + 0.4, H + 0.3, hd + 0.4, { bottom: true });
    // Front steps/ramp down to the lot.
    if (-g0 > 0.05) k.box('concrete', -2.6, g0, hd + 0.2, 2.6, -0.02, hd + 1.4);

    const win = (a: number, b: number, bottom = 1, top = 2.4) => ({ a, b, bottom, top, glass: true }) as Opening;
    const gap = (a: number, b: number, top: number) => ({ a, b, bottom: 0, top }) as Opening;
    const front: Opening[] = [];
    let roller: [number, number] | null = null;
    let personDoor: [number, number] | null = null;
    if (def.kind === 'warehouse') {
      roller = [-2.5, 2.5];
      personDoor = [6, 7.1];
      front.push(gap(-2.5, 2.5, 4.4), gap(6, 7.1, 2.2), win(-9, -6, 2.6, 4), win(9, 11, 2.6, 4));
    } else if (def.kind === 'barn') {
      roller = [-2.2, 2.2];
      personDoor = [5, 6.1];
      front.push(gap(-2.2, 2.2, 3.8), gap(5, 6.1, 2.2));
    } else {
      personDoor = [-0.55, 0.55];
      front.push(win(-6.4, -1.2, 0.5, 2.8), gap(-0.55, 0.55, 2.3), win(1.2, 6.4, 0.5, 2.8));
    }
    k.wallX(hd, -hw, hw, H, front, ext, intKey, 1, 0.25);
    k.wallX(-hd, -hw, hw, H, def.kind === 'warehouse' ? [win(-6, -2, 3.2, 4.6), win(2, 6, 3.2, 4.6)] : [], ext, intKey, -1, 0.25);
    k.wallZ(-hw, -hd + 0.12, hd - 0.12, H, def.kind === 'barn' ? [] : [win(-2, 0, 1.2, 2.4)], ext, intKey, -1, 0.25);
    k.wallZ(hw, -hd + 0.12, hd - 0.12, H, [], ext, intKey, 1, 0.25);
    if (def.kind === 'laundromat') {
      // Back room partition with a doorway.
      k.wallX(-1.4, -hw + 0.12, hw - 0.12, H, [gap(-0.5, 0.6, 2.2)], 'plaster', 'plaster', 1, 0.14);
      // Washing machines along the side walls of the front room.
      for (let i = 0; i < 4; i++) {
        const x = -6.3 + i * 0.85;
        k.box('white', x - 0.38, 0, 4.4, x + 0.38, 0.9, 5.15);
        k.box('dark', x - 0.22, 0.25, 5.15, x + 0.22, 0.65, 5.17, { collide: false });
        const x2 = 3.7 + i * 0.85;
        k.box('white', x2 - 0.38, 0, -0.9, x2 + 0.38, 0.9, -0.15);
      }
      k.box('wood', 2.5, 0, 2.8, 5.8, 1.0, 3.5); // counter
      k.box('trim', 2.4, 1.0, 2.75, 5.9, 1.05, 3.55, { collide: false });
    }
    // Storage shelving.
    const [sx, sz] = LAYOUTS[def.kind].storage;
    for (const y of [0.05, 0.8, 1.55]) k.box('frame', sx - 1.2, y, sz - 0.3, sx + 1.2, y + 0.05, sz + 0.3);
    for (const dx of [-1.18, 1.18]) k.box('frame', sx + dx - 0.03, 0, sz - 0.3, sx + dx + 0.03, 2.1, sz + 0.3, { collide: false });
    k.collider(sx - 1.2, 0, sz - 0.3, sx + 1.2, 2.1, sz + 0.3, 'metal');

    k.build(
      {
        concrete: m.concrete,
        metal: m.metal,
        brick: m.brick,
        marble: m.marble,
        dirt: m.dirt,
        trim: m.trim,
        barn: m.barn,
        plaster: m.plaster,
        glass: m.glass,
        frame: m.frame,
        roof: m.roof,
        white: m.white,
        dark: m.dark,
        wood: m.wood,
      },
      this.group,
      ['glass'],
    );

    // Doors.
    if (roller) {
      const rd = new RollerDoor(svc, `${def.id}:roller`, this.L((roller[0] + roller[1]) / 2, 0, hd), roller[1] - roller[0], def.kind === 'warehouse' ? 4.4 : 3.8, new THREE.MeshStandardMaterial({ map: facadeTexture('corrugated', 311).map, roughness: 0.5, metalness: 0.3 }), this.lock);
      svc.interaction.register(rd);
    }
    if (personDoor) {
      const dm = new THREE.MeshStandardMaterial({ color: def.kind === 'laundromat' ? 0x9fc1cf : 0x3a4048, roughness: 0.4, transparent: def.kind === 'laundromat', opacity: def.kind === 'laundromat' ? 0.55 : 1 });
      const door = new Door(svc, `${def.id}:door`, this.L(personDoor[0], 0, hd), 0, personDoor[1] - personDoor[0], 2.2, dm, 'door', this.lock);
      svc.interaction.register(door);
    }

    // Lights: one circuit, switch inside the door.
    const lights: THREE.PointLight[] = [];
    const bulbs: THREE.Mesh[] = [];
    const nx = def.kind === 'warehouse' ? 3 : 2;
    for (let i = 0; i < nx; i++) {
      const x = -hw + (def.w * (i + 0.5)) / nx;
      const light = new THREE.PointLight(0xffe6c4, 0, def.kind === 'warehouse' ? 16 : 11, 2);
      light.position.copy(this.L(x, H - 0.4, -1));
      this.group.add(light);
      lights.push(light);
      const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.38, 0.14, 16), new THREE.MeshStandardMaterial({ color: 0xfff6e6, emissive: 0xffe6c4, emissiveIntensity: 0 }));
      bulb.position.copy(this.L(x, H - 0.1, -1));
      this.group.add(bulb);
      bulbs.push(bulb);
    }
    this.circuit = new LightCircuit(lights, bulbs, def.kind === 'warehouse' ? 30 : 20);
    const swx = (personDoor?.[1] ?? 0) + 0.45;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.02), new THREE.MeshStandardMaterial({ color: 0xf4f1ea }));
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.03), new THREE.MeshStandardMaterial({ color: 0xdcd8cf }));
    const holder = new THREE.Group();
    holder.position.copy(this.L(swx, 1.3, hd - 0.14));
    holder.rotation.y = Math.PI;
    lever.position.z = 0.02;
    holder.add(plate, lever);
    this.group.add(holder);
    const sw = new LightSwitch(svc, `${def.id}:switch`, this.circuit, plate, lever, 'the');
    const swp = this.L(swx, 1.3, hd - 0.14);
    const swc = svc.physics.box(swp.x, swp.y, swp.z, 0.09, 0.11, 0.09);
    swc.setSensor(true);
    svc.physics.tag(swc, { interactable: sw });
    svc.interaction.register(sw);

    // Site: storage shelf and delivery crate.
    const site = svc.production.addSite(def.id, def.name, this.L, LAYOUTS[def.kind], def.storage);
    const shelfHl = ownMaterial(new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.05, 0.6), new THREE.MeshStandardMaterial({ color: 0x3a3f46 })));
    shelfHl.position.copy(this.L(sx, 0.83, sz));
    this.group.add(shelfHl);
    const shelf = new StorageBox(svc, `${def.id}:shelf`, site.storage, `${def.name} storage`, [shelfHl]);
    const shp = this.L(sx, 1.0, sz + 0.05);
    const shc = svc.physics.box(shp.x, shp.y, shp.z, 1.2, 1.0, 0.36);
    shc.setSensor(true);
    svc.physics.tag(shc, { interactable: shelf });
    svc.interaction.register(shelf);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.55), new THREE.MeshStandardMaterial({ map: facadeTexture('barn', 312).map, color: 0xd8b48a }));
    const cx = personDoor ? personDoor[0] - 1.4 : -2;
    crate.position.copy(this.L(cx, 0.25, hd - 0.7));
    crate.castShadow = true;
    this.group.add(crate);
    const crateBox = new StorageBox(svc, `${def.id}:delivery`, site.delivery, 'delivery crate', [crate]);
    const cp = this.L(cx, 0.25, hd - 0.7);
    svc.physics.tag(svc.physics.box(cp.x, cp.y, cp.z, 0.4, 0.25, 0.28, 0, 'wood'), { interactable: crateBox });
    svc.interaction.register(crateBox);

    // Name board over the door and the for-sale sign by the street.
    const nameTex = letterTexture(def.name.toUpperCase(), def.kind === 'laundromat' ? '#1f4f7a' : '#2b2925', '#f1e6c8', 768, 96);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(def.w * 0.7, 9), 1.1), new THREE.MeshStandardMaterial({ map: nameTex, roughness: 0.6, emissive: 0xffffff, emissiveMap: nameTex, emissiveIntensity: 0.15 }));
    board.position.copy(this.L(0, Math.min(H - 0.6, 3.1) + (def.kind === 'warehouse' ? 1.7 : def.kind === 'barn' ? 1 : 0), hd + 0.14));
    this.group.add(board);
    this.buildSign(hd);
  }

  private buildSign(hd: number) {
    const { def, svc } = this;
    const sx = def.x + def.w / 2 - 1.5;
    const sz = def.z + hd + 4;
    const y = this.hm.get(sx, sz);
    const g = new THREE.Group();
    g.position.set(sx, y, sz);
    const post = new THREE.MeshStandardMaterial({ color: 0x5b4a3a, roughness: 0.8 });
    for (const x of [-0.75, 0.75]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.09, 2.2, 0.09), post);
      p.position.set(x, 1.1, 0);
      p.castShadow = true;
      g.add(p);
    }
    this.signMat = new THREE.MeshStandardMaterial({ map: this.signTexture(), roughness: 0.6 });
    const board = ownMaterial(new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.1, 0.05), this.signMat));
    board.position.set(0, 1.6, 0);
    board.castShadow = true;
    g.add(board);
    svc.scene.add(g);
    this.signMat = board.material as THREE.MeshStandardMaterial;
    const sign = new SimpleInteractable(
      `${def.id}:sign`,
      () => (this.owned ? `${def.name} (yours)` : `View ${def.name} · $${def.price.toLocaleString()}`),
      () => (this.owned ? svc.ui.toast(`You own ${def.name}. Hire staff for it in the Staff app.`, 'info') : svc.ui.panels.openPropertySale(def)),
      [board],
      3,
    );
    svc.physics.tag(svc.physics.box(sx, y + 1.6, sz, 0.9, 0.55, 0.08), { interactable: sign, surface: 'wood' });
    svc.interaction.register(sign);
  }

  private signTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 312;
    const g = c.getContext('2d')!;
    const sold = this.owned;
    g.fillStyle = '#f4efe4';
    g.fillRect(0, 0, 512, 312);
    g.fillStyle = sold ? '#2f7a4f' : '#b3261e';
    g.fillRect(0, 0, 512, 92);
    g.fillRect(0, 266, 512, 46);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = '900 72px "Big Shoulders Display", Impact, sans-serif';
    g.fillText(sold ? 'SOLD' : 'FOR SALE', 256, 50);
    g.fillStyle = '#1c1a17';
    g.font = '800 40px "Big Shoulders Display", Impact, sans-serif';
    g.fillText(this.def.name, 256, 140, 480);
    g.fillStyle = sold ? '#2f7a4f' : '#2f7a4f';
    g.font = '800 64px "Big Shoulders Display", Impact, sans-serif';
    g.fillText(sold ? 'OWNER: YOU' : `$${this.def.price.toLocaleString()}`, 256, 208);
    g.fillStyle = '#fff';
    g.font = '600 26px Archivo, Arial, sans-serif';
    g.fillText(`Harlow Realty · ${DISTRICTS[this.def.district].name}`, 256, 290);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  refreshSign() {
    this.signMat.map?.dispose();
    this.signMat.map = this.signTexture();
    this.signMat.needsUpdate = true;
  }
}

/** Ownership, purchases and daily running costs. */
export class Properties {
  readonly owned = new Set<string>(['home']);
  readonly buildings = new Map<string, PropertyBuilding>();
  private lastDay = 0;

  constructor(private svc: Services) {}

  owns(id: string) {
    return this.owned.has(id);
  }

  async build(hm: Heightmap, pads: Map<string, Pad>) {
    const mats = await loadKitMaterials();
    for (const def of PROPERTIES) {
      const pad = pads.get(def.id);
      if (pad) this.buildings.set(def.id, new PropertyBuilding(this.svc, def, pad, hm, mats));
    }
  }

  buy(id: string): string {
    const def = PROPERTIES.find((p) => p.id === id);
    if (!def) return 'Unknown property.';
    if (this.owns(id)) return 'You already own it.';
    if (!this.svc.economy.spend(def.price, `Bought ${def.name}`)) return `You need $${def.price.toLocaleString()} (you have $${this.svc.economy.cash.toLocaleString()}).`;
    this.owned.add(id);
    const site = this.svc.production.sites.get(id);
    for (const [kind, n] of def.includes) for (let i = 0; i < n; i++) site?.install(kind);
    this.buildings.get(id)?.refreshSign();
    this.svc.audio.play('ui');
    this.svc.customers.post('sys:realty', 'Ray Delgado (Harlow Realty)', `Congratulations on ${def.name}. Keys are in the door. Running costs are $${def.upkeep}/day.`);
    return `You bought ${def.name}.`;
  }

  /** Which owned site (if any) the player is standing in. */
  siteAt(p: THREE.Vector3): string | null {
    if (this.svc.world.starter.contains(p)) return 'home';
    for (const [id, b] of this.buildings) if (this.owns(id) && b.contains(p)) return id;
    return null;
  }

  name(id: string) {
    return id === 'home' ? '14 Larch Street' : (PROPERTIES.find((p) => p.id === id)?.name ?? id);
  }

  ownedList(): string[] {
    return ['home', ...PROPERTIES.filter((p) => this.owns(p.id)).map((p) => p.id)];
  }

  staffCap(id: string) {
    return id === 'home' ? 2 : (PROPERTIES.find((p) => p.id === id)?.staff ?? 0);
  }

  /** Daily upkeep, charged with payroll at 07:00. */
  advance() {
    const day = this.svc.time.day;
    if (this.lastDay === 0) this.lastDay = day;
    if (day === this.lastDay || this.svc.time.minutes < 7 * 60) return;
    this.lastDay = day;
    for (const def of PROPERTIES) if (this.owns(def.id)) this.svc.economy.forfeit(def.upkeep, `Upkeep: ${def.name}`);
  }

  toJSON() {
    return { owned: [...this.owned], lastDay: this.lastDay };
  }

  load(d: ReturnType<Properties['toJSON']> | undefined) {
    if (!d) return;
    this.owned.clear();
    d.owned.forEach((o) => this.owned.add(o));
    this.lastDay = d.lastDay;
    for (const b of this.buildings.values()) b.refreshSign();
  }
}

export { LAYOUTS };
