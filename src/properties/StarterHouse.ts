import * as THREE from 'three';
import type { Services } from '../core/Services';
import { SimpleInteractable, ownMaterial } from '../interaction/Interactable';
import { Door, LightCircuit, LightSwitch, Pickup, RollerDoor } from '../interaction/Objects';
import { STARTER, type CityContent } from '../world/CityGenerator';
import { GeoBatch } from '../world/GeoBatch';
import type { Heightmap, Pad } from '../world/Heightmap';
import { noiseTexture, plasterTexture, shingleTexture, stoneTexture, woodFloorTexture } from '../world/Textures';
import { BuildKit } from './BuildKit';

const H = 3; // wall height
const FLOOR = 0.45; // floor height above the lot

function sidingTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8fa3ad';
  g.fillRect(0, 0, 128, 128);
  for (let y = 0; y < 128; y += 21) {
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(0, y, 128, 2);
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.fillRect(0, y + 18, 128, 3);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * 14 Larch Street: the player's first property. A small single-storey house with a front room,
 * a back room and a garage, fully enterable and furnished. Local frame: origin at the floor centre,
 * front wall at +z facing Larch Street.
 */
export class StarterHouse {
  readonly group = new THREE.Group();
  readonly origin: THREE.Vector3;
  readonly floorY: number;
  readonly spawn: { x: number; y: number; z: number; yaw: number };
  private porchLight!: THREE.MeshStandardMaterial;
  private screenMat!: THREE.MeshStandardMaterial;
  frontDoor!: Door;
  garageDoor!: RollerDoor;
  readonly circuits: LightCircuit[] = [];
  private wasInside = false;

  constructor(
    private svc: Services,
    private hm: Heightmap,
    pad: Pad,
  ) {
    this.floorY = pad.h! + FLOOR;
    this.origin = new THREE.Vector3(STARTER.house.x, this.floorY, STARTER.house.z);
    this.group.name = 'starter-house';
    svc.scene.add(this.group);
    const sidewalkY = hm.get(STARTER.house.x - 2.5, -80.6) + 0.22;
    this.spawn = { x: STARTER.house.x - 2.5, y: sidewalkY, z: -80.6, yaw: 0 };
    this.build(pad.h!);
  }

  /** Lot details that belong to the generic prop pipeline (fences, garden trees). */
  addLotFeatures(content: CityContent): void {
    const l = STARTER.lot;
    content.fences.push({ x0: l.x0, z0: l.z0, x1: l.x1, z1: l.z0, kind: 'picket' });
    content.fences.push({ x0: l.x0, z0: l.z0, x1: l.x0, z1: l.z1 - 2, kind: 'picket' });
    content.fences.push({ x0: l.x1, z0: l.z0, x1: l.x1, z1: l.z1 - 2, kind: 'picket' });
    const ground = this.floorY - FLOOR - 0.1;
    content.trees.push({ x: l.x0 + 3, z: l.z1 - 3, type: 'broad', scale: 1.1, y: ground });
    content.trees.push({ x: l.x0 + 3.5, z: l.z0 + 4, type: 'pine', scale: 1.2, y: ground });
    content.trees.push({ x: l.x1 - 3, z: l.z0 + 3, type: 'broad', scale: 0.9, y: ground });
  }

  /** True when the given feet position is inside the house walls. */
  contains(p: THREE.Vector3): boolean {
    const lx = p.x - this.origin.x;
    const lz = p.z - this.origin.z;
    return lx > -5.9 && lx < 5.9 && lz > -4.9 && lz < 4.9 && p.y > this.floorY - 0.6 && p.y < this.floorY + 2.5;
  }

  update(nightFactor: number): void {
    this.porchLight.emissiveIntensity = nightFactor * 2.4;
    const inside = this.contains(this.svc.player.position);
    if (inside !== this.wasInside) {
      this.wasInside = inside;
      this.svc.bus.emit('interior:change', { inside });
      if (inside) this.svc.bus.emit('objective:signal', { id: 'enterHouse' });
    }
    this.screenMat.emissiveIntensity = 0.9 + Math.sin(performance.now() / 900) * 0.05;
  }

  private L(x: number, y: number, z: number) {
    return new THREE.Vector3(this.origin.x + x, this.origin.y + y, this.origin.z + z);
  }

  private build(groundY: number) {
    const svc = this.svc;
    const k = new BuildKit(this.origin, svc.physics);
    const g0 = groundY - this.floorY; // local y of the lot surface (-FLOOR)

    // ---------------------------------------------------------- shell
    k.box('foundation', -6.1, g0 - 0.6, -5.1, 6.1, 0, 5.1, { surface: 'concrete' });
    k.batch('wood').quad([this.origin.x - 6, this.floorY + 0.005, this.origin.z + 5], [this.origin.x + 2, this.floorY + 0.005, this.origin.z + 5], [this.origin.x + 2, this.floorY + 0.005, this.origin.z - 5], [this.origin.x - 6, this.floorY + 0.005, this.origin.z - 5], [0, 0, 4, 5]);
    k.batch('garageFloor').quad([this.origin.x + 2, this.floorY + 0.005, this.origin.z + 5], [this.origin.x + 6, this.floorY + 0.005, this.origin.z + 5], [this.origin.x + 6, this.floorY + 0.005, this.origin.z - 5], [this.origin.x + 2, this.floorY + 0.005, this.origin.z - 5], [0, 0, 2, 5]);
    // Wood floors register as wood for footsteps.
    k.collider(-6, -0.02, -5, 2, 0.005, 5, 'wood');

    const win = (a: number, b: number, bottom = 0.95, top = 2.1) => ({ a, b, bottom, top, glass: true });
    const door = (a: number, b: number, top = 2.2) => ({ a, b, bottom: 0, top });
    k.wallX(5, -6.1, 6.1, H, [win(-5.3, -4.1), door(-3.1, -2.0), win(-1.0, 0.8), door(2.4, 5.6, 2.6)], 'siding', 'plaster', 1);
    k.wallX(-5, -6.1, 6.1, H, [win(-4.6, -3.3), win(-0.6, 0.6), win(3.6, 4.6, 1.4, 2.1)], 'siding', 'plaster', -1);
    k.wallZ(-6, -4.9, 4.9, H, [win(2.0, 3.4), win(-3.6, -2.4)], 'siding', 'plaster', -1);
    k.wallZ(6, -4.9, 4.9, H, [win(-1.0, 0.2, 1.3, 2.1)], 'siding', 'garageWall', 1);
    k.wallZ(2, -4.9, 4.9, H, [door(2.6, 3.5, 2.1)], 'garageWall', 'plaster', 1, 0.14);
    k.wallX(-1, -5.9, 1.93, H, [door(-3.6, -2.7, 2.1)], 'plaster', 'plasterB', 1, 0.14);

    // Ceiling and roof.
    const o = this.origin;
    k.batch('ceiling').quad([o.x - 6, o.y + H - 0.02, o.z - 5], [o.x + 6, o.y + H - 0.02, o.z - 5], [o.x + 6, o.y + H - 0.02, o.z + 5], [o.x - 6, o.y + H - 0.02, o.z + 5], [0, 0, 6, 5]);
    this.roof(k.batch('roof'), k.batch('siding'));

    // Porch, steps and driveway ramp.
    k.box('stone', -4.0, g0, 5.1, -1.1, -0.02, 6.6, { surface: 'concrete' });
    k.box('stone', -3.6, g0, 6.6, -1.5, -0.17, 6.95, { surface: 'concrete' });
    k.box('stone', -3.6, g0, 6.95, -1.5, -0.32, 7.3, { surface: 'concrete' });
    this.ramp(k, g0);
    this.paths(k, g0);

    // ---------------------------------------------------------- furniture
    this.furniture(k);

    const mats: Record<string, THREE.Material> = {
      foundation: new THREE.MeshStandardMaterial({ map: stoneTexture(), roughness: 0.9 }),
      wood: new THREE.MeshStandardMaterial({ map: woodFloorTexture(), roughness: 0.65 }),
      garageFloor: new THREE.MeshStandardMaterial({ map: noiseTexture(71, '#8e8b85', '#bbb', '#555', 9000, 3), roughness: 0.85 }),
      siding: new THREE.MeshStandardMaterial({ map: sidingTexture(), roughness: 0.85 }),
      plaster: new THREE.MeshStandardMaterial({ map: plasterTexture('#d9cfbf', 81), roughness: 0.95 }),
      plasterB: new THREE.MeshStandardMaterial({ map: plasterTexture('#b9c2b4', 82), roughness: 0.95 }),
      garageWall: new THREE.MeshStandardMaterial({ map: noiseTexture(83, '#a8a49b', '#ddd', '#555', 6000, 2), roughness: 0.95 }),
      ceiling: new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 1, side: THREE.DoubleSide }),
      roof: new THREE.MeshStandardMaterial({ map: shingleTexture(), roughness: 0.9, side: THREE.DoubleSide }),
      glass: new THREE.MeshStandardMaterial({ color: 0xa9c6d6, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.22, depthWrite: false }),
      frame: new THREE.MeshStandardMaterial({ color: 0xf1eee8, roughness: 0.6 }),
      stone: new THREE.MeshStandardMaterial({ map: noiseTexture(84, '#9b968c', '#ddd', '#444', 8000, 2), roughness: 0.9 }),
      fabric: new THREE.MeshStandardMaterial({ color: 0x4d5b6a, roughness: 1 }),
      fabricB: new THREE.MeshStandardMaterial({ color: 0x8a5a44, roughness: 1 }),
      darkWood: new THREE.MeshStandardMaterial({ map: woodFloorTexture(), color: 0x6a4a36, roughness: 0.6 }),
      metal: new THREE.MeshStandardMaterial({ color: 0x6d7378, roughness: 0.45, metalness: 0.6 }),
      white: new THREE.MeshStandardMaterial({ color: 0xeceae4, roughness: 0.4 }),
      black: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.4 }),
      linen: new THREE.MeshStandardMaterial({ color: 0xd9d4c9, roughness: 1 }),
      rug: new THREE.MeshStandardMaterial({ color: 0x7b3d33, roughness: 1 }),
    };
    k.build(mats, this.group, ['glass']);

    this.interactive(mats);
  }

  private roof(roof: GeoBatch, gable: GeoBatch) {
    const o = this.origin;
    const x0 = o.x - 6.1;
    const x1 = o.x + 6.1;
    const z0 = o.z - 5.1;
    const z1 = o.z + 5.1;
    const y = o.y + H;
    const rise = 2.2;
    const ov = 0.5;
    const zm = o.z;
    const half = 5.1;
    const yl = y - (ov * rise) / half;
    const yr = y + rise;
    roof.quad([x0 - ov, yl, z1 + ov], [x1 + ov, yl, z1 + ov], [x1 + ov, yr, zm], [x0 - ov, yr, zm], [0, 0, 6.5, 3]);
    roof.quad([x1 + ov, yl, z0 - ov], [x0 - ov, yl, z0 - ov], [x0 - ov, yr, zm], [x1 + ov, yr, zm], [0, 0, 6.5, 3]);
    gable.tri([x0, y, z0], [x0, y, z1], [x0, yr, zm], [0, 0], [10.2, 0], [5.1, rise]);
    gable.tri([x1, y, z1], [x1, y, z0], [x1, yr, zm], [0, 0], [10.2, 0], [5.1, rise]);
  }

  private ramp(k: BuildKit, g0: number) {
    // Driveway ramp from the lot up to the garage floor.
    const len = 1.8;
    const ang = Math.atan2(FLOOR, len);
    // Positive rotation about x tips local +z downward, so the slab descends away from the garage.
    const q = { x: Math.sin(ang / 2), y: 0, z: 0, w: Math.cos(ang / 2) };
    const cz = 5 + len / 2 + 0.05;
    const cy = g0 + FLOOR / 2;
    const o = this.origin;
    this.svc.physics.boxQuat(o.x + 4, o.y + cy - 0.12, o.z + cz, 1.65, 0.12, Math.hypot(len, FLOOR) / 2 + 0.1, q, 'concrete');
    const b = k.batch('stone');
    b.quad([o.x + 2.35, o.y + g0 + 0.01, o.z + 5 + len + 0.1], [o.x + 5.65, o.y + g0 + 0.01, o.z + 5 + len + 0.1], [o.x + 5.65, o.y + 0.01, o.z + 5.05], [o.x + 2.35, o.y + 0.01, o.z + 5.05], [0, 0, 3, 2]);
    for (const x of [2.35, 5.65]) b.quadFacing([o.x + x, o.y + g0 - 0.1, o.z + 5 + len + 0.1], [o.x + x, o.y + g0 - 0.1, o.z + 5.05], [o.x + x, o.y + 0.01, o.z + 5.05], [o.x + x, o.y + g0 + 0.01, o.z + 5 + len + 0.1], [x < 4 ? -1 : 1, 0, 0]);
  }

  private paths(k: BuildKit, g0: number) {
    const o = this.origin;
    const b = k.batch('stone');
    // Driveway from the ramp to the sidewalk, and the front path from the steps.
    const strips: [number, number, number, number][] = [
      [2.35, 5.65, 7.0, 13.0],
      [-3.15, -1.95, 7.3, 13.0],
    ];
    for (const [x0, x1, z0, z1] of strips) {
      const n = Math.ceil((z1 - z0) / 1);
      b.grid(n, 2, (r, c) => {
        const x = o.x + x0 + ((x1 - x0) * c) / 2;
        const z = o.z + z0 + ((z1 - z0) * r) / n;
        return [x, this.hm.get(x, z) + 0.035, z, x, z];
      });
    }
    void g0;
  }

  private furniture(k: BuildKit) {
    // Living area (east half of the front room).
    k.box('rug', -1.9, 0.005, 0.1, 1.3, 0.02, 2.4, { collide: false });
    k.box('fabric', -1.85, 0, 0.3, -1.0, 0.45, 2.1, { surface: 'wood' }); // sofa seat
    k.box('fabric', -1.95, 0, 0.3, -1.65, 0.95, 2.1, { collide: false }); // backrest
    k.box('fabric', -1.95, 0, 0.12, -1.0, 0.65, 0.32, { collide: false }); // arms
    k.box('fabric', -1.95, 0, 2.08, -1.0, 0.65, 2.28, { collide: false });
    k.box('darkWood', -0.2, 0, 0.8, 0.6, 0.42, 1.7, { surface: 'wood' }); // coffee table
    k.box('darkWood', 1.4, 0, 0.3, 1.9, 0.5, 1.9, { surface: 'wood' }); // TV stand
    k.box('black', 1.6, 0.5, 0.35, 1.68, 1.35, 1.85, { collide: false }); // TV
    // Kitchen (west half).
    k.box('white', -5.92, 0, -0.85, -5.25, 1.85, -0.2, { surface: 'metal' }); // fridge
    k.box('darkWood', -5.92, 0, -0.18, -5.3, 0.88, 1.85, { surface: 'wood' }); // counter
    k.box('stone', -5.95, 0.88, -0.2, -5.27, 0.92, 1.88, { collide: false });
    k.box('metal', -5.8, 0.89, 0.6, -5.4, 0.93, 1.1, { collide: false }); // sink
    k.box('darkWood', -4.8, 0, 2.6, -3.9, 0.76, 3.5, { surface: 'wood' }); // dining table
    k.box('darkWood', -5.25, 0, 2.85, -4.9, 0.46, 3.2, { surface: 'wood' }); // chairs
    k.box('darkWood', -3.8, 0, 2.85, -3.45, 0.46, 3.2, { surface: 'wood' });
    // Back room: bed, nightstand, desk, wardrobe.
    k.box('darkWood', -5.85, 0, -4.9, -4.15, 0.45, -2.85, { surface: 'wood' }); // bed frame
    k.box('linen', -5.8, 0.45, -4.85, -4.2, 0.62, -2.9, { collide: false });
    k.box('white', -5.6, 0.62, -4.75, -4.4, 0.72, -4.35, { collide: false }); // pillow
    k.box('darkWood', -5.9, 0, -4.98, -4.1, 1.05, -4.88, { collide: false }); // headboard
    k.box('darkWood', -3.95, 0, -4.9, -3.45, 0.55, -4.45, { surface: 'wood' }); // nightstand
    k.box('darkWood', -1.0, 0, -4.9, 0.7, 0.74, -4.25, { surface: 'wood' }); // desk
    k.box('darkWood', -0.35, 0, -3.9, 0.15, 0.46, -3.45, { surface: 'wood' }); // chair
    k.box('darkWood', -0.35, 0.46, -3.47, 0.15, 0.95, -3.4, { collide: false });
    k.box('darkWood', 1.2, 0, -3.4, 1.9, 2.0, -1.4, { surface: 'wood' }); // wardrobe
    // Garage: storage shelving along the back wall (production stations are added by Production).
    for (const y of [0.05, 0.75, 1.45]) k.box('metal', 2.4, y, -4.9, 4.9, y + 0.04, -4.35, { surface: 'metal' });
    for (const x of [2.42, 4.86]) k.box('metal', x - 0.02, 0, -4.9, x + 0.02, 2.0, -4.35, { surface: 'metal' });
  }

  private interactive(mats: Record<string, THREE.Material>) {
    const svc = this.svc;
    const L = (x: number, y: number, z: number) => this.L(x, y, z);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x5b3a2a, roughness: 0.55 });
    const innerDoorMat = new THREE.MeshStandardMaterial({ color: 0xe9e3d6, roughness: 0.6 });
    this.frontDoor = new Door(svc, 'front-door', L(-3.1, 0, 5), 0, 1.1, 2.2, doorMat, 'front door');
    svc.interaction.register(this.frontDoor);
    svc.interaction.register(new Door(svc, 'bedroom-door', L(-3.6, 0, -1), 0, 0.9, 2.1, innerDoorMat, 'door'));
    svc.interaction.register(new Door(svc, 'garage-inner-door', L(2, 0, 2.6), -Math.PI / 2, 0.9, 2.1, innerDoorMat, 'door'));
    const rollerMat = new THREE.MeshStandardMaterial({ color: 0xd6d3cc, roughness: 0.5, metalness: 0.2 });
    this.garageDoor = new RollerDoor(svc, 'garage-door', L(4, 0, 5), 3.2, 2.6, rollerMat);
    svc.interaction.register(this.garageDoor);

    // Lights: three circuits with ceiling fixtures and wall switches.
    const rooms: { name: string; light: [number, number, number]; sw: [number, number, number]; face: 'x+' | 'x-' | 'z+' | 'z-'; color: number }[] = [
      { name: 'front room', light: [-2, H - 0.25, 2], sw: [-1.75, 1.3, 4.88], face: 'z-', color: 0xffd9a8 },
      { name: 'back room', light: [-2.4, H - 0.25, -3], sw: [-2.45, 1.3, -1.08], face: 'z-', color: 0xffd9a8 },
      { name: 'garage', light: [4, H - 0.25, 0], sw: [2.08, 1.3, 3.8], face: 'x+', color: 0xe6eeff },
    ];
    for (const r of rooms) {
      const light = new THREE.PointLight(r.color, 0, 11, 2);
      light.position.copy(L(...r.light));
      this.group.add(light);
      const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff6e6, emissive: r.color, emissiveIntensity: 0 });
      const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.12, 16), bulbMat);
      bulb.position.copy(L(r.light[0], H - 0.08, r.light[2]));
      this.group.add(bulb);
      const circuit = new LightCircuit([light], [bulb], 18);
      this.circuits.push(circuit);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.02), new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.5 }));
      const lever = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.05, 0.03), new THREE.MeshStandardMaterial({ color: 0xdcd8cf }));
      const holder = new THREE.Group();
      holder.position.copy(L(...r.sw));
      holder.rotation.y = r.face === 'z-' ? Math.PI : r.face === 'x+' ? Math.PI / 2 : r.face === 'x-' ? -Math.PI / 2 : 0;
      holder.add(plate);
      lever.position.z = 0.02;
      holder.add(lever);
      this.group.add(holder);
      const sw = new LightSwitch(svc, `switch-${r.name}`, circuit, plate, lever, r.name);
      const p = L(...r.sw);
      const col = svc.physics.box(p.x, p.y, p.z, 0.09, 0.11, 0.09);
      col.setSensor(true);
      svc.physics.tag(col, { interactable: sw });
      svc.interaction.register(sw);
    }

    // Computer on the desk.
    const monitor = ownMaterial(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.4, 0.04), mats.black as THREE.MeshStandardMaterial));
    monitor.position.copy(L(-0.15, 1.04, -4.72));
    const stand = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.26, 0.06), mats.black);
    stand.position.copy(L(-0.15, 0.82, -4.74));
    this.screenMat = new THREE.MeshStandardMaterial({ color: 0x0f1a22, emissive: 0x3d86a8, emissiveIntensity: 0.9 });
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.34), this.screenMat);
    screen.position.copy(L(-0.15, 1.04, -4.697));
    const kb = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.02, 0.14), mats.metal);
    kb.position.copy(L(-0.15, 0.75, -4.48));
    this.group.add(monitor, stand, screen, kb);
    const computer = new SimpleInteractable('computer', () => 'Use computer', () => svc.ui.openComputer(), [monitor], 2.2);
    const cp = L(-0.15, 1.0, -4.6);
    svc.physics.tag(svc.physics.box(cp.x, cp.y, cp.z, 0.34, 0.3, 0.2), { interactable: computer });
    svc.interaction.register(computer);

    // Bed: sleep.
    const bedHl = ownMaterial(new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.05, 1.93), mats.linen as THREE.MeshStandardMaterial));
    bedHl.position.copy(L(-5.0, 0.64, -3.875));
    this.group.add(bedHl);
    const bed = new SimpleInteractable('bed', () => 'Sleep', () => svc.ui.openSleep(), [bedHl], 2.4);
    const bp = L(-5.0, 0.55, -3.875);
    const bedCol = svc.physics.box(bp.x, bp.y, bp.z, 0.8, 0.12, 0.98);
    bedCol.setSensor(true);
    svc.physics.tag(bedCol, { interactable: bed });
    svc.interaction.register(bed);

    // Mailbox by the front path.
    const mb = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.05, 0.1), mats.darkWood);
    post.position.y = 0.52;
    const boxMesh = ownMaterial(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.48, 16, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({ color: 0x2c4a6e, metalness: 0.5, roughness: 0.4 })));
    boxMesh.rotation.z = Math.PI / 2;
    boxMesh.rotation.y = Math.PI / 2;
    boxMesh.position.y = 1.08;
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.48), mats.metal);
    base.position.y = 1.07;
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.18, 0.06), new THREE.MeshStandardMaterial({ color: 0xc23a2a }));
    flag.position.set(0.19, 1.2, 0.08);
    mb.add(post, boxMesh, base, flag);
    const mx = this.origin.x - 4.4;
    const mz = this.origin.z + 12.2;
    mb.position.set(mx, this.hm.get(mx, mz), mz);
    mb.traverse((o) => (o.castShadow = true));
    this.group.add(mb);
    let read = false;
    const mailbox = new SimpleInteractable(
      'mailbox',
      () => (read ? 'Re-read the letter' : 'Check mail'),
      () => {
        if (!read && !svc.state.done.has('mail')) svc.economy.earn(400, 'Envelope from Harlow Realty', false);
        read = true;
        flag.visible = false;
        svc.ui.openLetter();
        svc.bus.emit('objective:signal', { id: 'mail' });
      },
      [boxMesh],
      2.4,
    );
    svc.physics.tag(svc.physics.box(mx, mb.position.y + 0.75, mz, 0.22, 0.6, 0.28), { interactable: mailbox, surface: 'metal' });
    svc.interaction.register(mailbox);

    // Porch light and house number.
    this.porchLight = new THREE.MeshStandardMaterial({ color: 0xfff2d8, emissive: 0xffc27a, emissiveIntensity: 0 });
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.24, 0.12), this.porchLight);
    lamp.position.copy(L(-1.7, 2.05, 5.16));
    this.group.add(lamp);
    const num = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.2), new THREE.MeshStandardMaterial({ map: numberTexture(), roughness: 0.6 }));
    num.position.copy(L(-3.65, 1.95, 5.11));
    this.group.add(num);

    // Movable items in the garage and house.
    const box = (w: number, h: number, d: number, color: number) => new THREE.Mesh(new THREE.BoxGeometry(w * 2, h * 2, d * 2), new THREE.MeshStandardMaterial({ map: cardboardTexture(), color, roughness: 0.9 }));
    const items: [string, string, THREE.Mesh, THREE.Vector3, THREE.Vector3, number, number][] = [
      ['box-1', 'cardboard box', box(0.28, 0.22, 0.24, 0xffffff), new THREE.Vector3(0.28, 0.22, 0.24), L(4.2, 0.25, -3.85), 0.2, 3],
      ['box-2', 'cardboard box', box(0.24, 0.18, 0.2, 0xf0e2c8), new THREE.Vector3(0.24, 0.18, 0.2), L(2.7, 0.2, 4.3), -0.4, 2],
      ['box-3', 'small box', box(0.18, 0.14, 0.16, 0xe8d2b0), new THREE.Vector3(0.18, 0.14, 0.16), L(3.15, 0.94, -4.62), 0.1, 1.5],
      ['crate', 'wooden crate', new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.5), new THREE.MeshStandardMaterial({ map: woodFloorTexture(), color: 0xc7a27a, roughness: 0.8 })), new THREE.Vector3(0.35, 0.25, 0.25), L(4.3, 0.27, 2.2), 0.5, 6],
      ['plant', 'potted plant', plantMesh(), new THREE.Vector3(0.16, 0.15, 0.16), L(1.65, 0.16, 3.9), 0, 2],
    ];
    for (const [id, name, mesh, half, pos, yaw, mass] of items) svc.interaction.register(new Pickup(svc, id, name, mesh, half, pos, yaw, mass));

    // Porch delivery crate and the garage storage shelf (both open the storage screen).
    const crateMat = new THREE.MeshStandardMaterial({ map: woodFloorTexture(), color: 0xc9a77c, roughness: 0.85 });
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.55), crateMat);
    crate.position.copy(L(-1.6, 0.23, 5.85));
    crate.castShadow = true;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.05, 0.59), crateMat);
    lid.position.copy(L(-1.6, 0.5, 5.85));
    const label = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.14), new THREE.MeshStandardMaterial({ map: deliveryTexture(), roughness: 0.7 }));
    label.position.copy(L(-1.6, 0.26, 6.126));
    this.group.add(crate, lid, label);
    const shelfHl = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.04, 0.55), new THREE.MeshStandardMaterial({ color: 0x6d7378, metalness: 0.6, roughness: 0.45 }));
    shelfHl.position.copy(L(3.65, 0.77, -4.62));
    this.group.add(shelfHl);
    const crateP = L(-1.6, 0.25, 5.85);
    const sp = L(3.65, 1.0, -4.62);
    svc.production.init(
      L,
      [shelfHl],
      [crate],
      () => {
        const c = svc.physics.box(sp.x, sp.y, sp.z, 1.25, 1.0, 0.3, 0, 'metal');
        c.setSensor(true);
        return c;
      },
      () => svc.physics.box(crateP.x, crateP.y, crateP.z, 0.4, 0.25, 0.28, 0, "wood"),
    );
  }
}

function deliveryTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.fillStyle = '#efe6d2';
  g.fillRect(0, 0, 128, 48);
  g.fillStyle = '#2a251e';
  g.font = '800 22px "Big Shoulders Display", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('DELIVERIES', 64, 25);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function cardboardTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b58b5c';
  g.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    g.fillRect(Math.random() * 64, Math.random() * 64, 2, 2);
  }
  g.fillStyle = 'rgba(210,190,150,0.8)';
  g.fillRect(28, 0, 8, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function numberTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#26221e';
  g.fillRect(0, 0, 128, 64);
  g.fillStyle = '#e8d9b8';
  g.font = '800 46px "Big Shoulders Display", Impact, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('14', 64, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function plantMesh(): THREE.Mesh {
  // A pot whose material is the highlight target; the foliage rides along as children.
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.3, 14), new THREE.MeshStandardMaterial({ color: 0xa4553a, roughness: 0.8 }));
  pot.position.y = 0;
  const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 1), new THREE.MeshStandardMaterial({ color: 0x3f6b35, roughness: 0.9, flatShading: true }));
  leaves.position.y = 0.3;
  leaves.castShadow = true;
  pot.add(leaves);
  return pot;
}
