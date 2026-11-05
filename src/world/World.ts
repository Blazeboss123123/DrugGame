import * as THREE from 'three';
import type { EventBus } from '../core/EventBus';
import { nextFrame } from '../core/math';
import type { Services } from '../core/Services';
import { CornerShop, SHOP_PAD } from '../properties/CornerShop';
import type { CharacterPool } from '../npc/Characters';
import { StarterHouse } from '../properties/StarterHouse';
import { buildBuildings } from './Buildings';
import { STARTER, generateCity, type CityContent } from './CityGenerator';
import { DISTRICTS, districtAt, type District } from './CityPlan';
import { Heightmap, type Pad } from './Heightmap';
import { buildPlaza } from './Plaza';
import { buildProps, buildRooftop, type PropsResult } from './Props';
import { buildRoads, waterNormals } from './Roads';
import { bakeTerrain } from './TerrainGen';
import { KIT_BUILDINGS, KitAssets, type KitName } from './KitAssets';
import { Rng } from '../core/math';
import { X_LINES, Z_LINES } from './CityPlan';
import { buildTerrain } from './TerrainMesh';
import { GrassField, buildGrassMask } from './GrassField';
import { loadSurfaces, type SurfaceSet } from './Surfaces';
import { WIND } from './Trees';
import { PROPERTIES } from '../properties/PropertyDefs';

export type Progress = (fraction: number, label: string) => void;

/** Builds and owns the city: terrain, roads, buildings, props, the plaza and the starter property. */
export class World {
  readonly hm = new Heightmap();
  content!: CityContent;
  starter!: StarterHouse;
  shop!: CornerShop;
  /** Character pool for hand-placed NPCs (the shopkeeper); set by Game before init. */
  chars: CharacterPool | null = null;
  /** Max texture anisotropy of the renderer; set by Game before build. */
  maxAnisotropy = 8;
  surfaces!: SurfaceSet;
  grass: GrassField | null = null;
  private grassWeight: Float32Array | null = null;
  stats = { buildings: 0, trees: 0, cars: 0, colliders: 0 };
  private nightMats: THREE.MeshStandardMaterial[] = [];
  private props!: PropsResult;
  private district: District | null = null;
  private districtTimer = 0;
  private signalClock = 0;

  constructor(
    private svc: Services,
    private bus: EventBus,
  ) {}

  async build(progress: Progress): Promise<void> {
    const { scene, physics } = this.svc;
    try {
      await Promise.race([document.fonts.load('800 48px "Big Shoulders Display"'), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      /* fonts are optional */
    }
    progress(0.08, 'Loading HD textures');
    this.surfaces = await loadSurfaces(this.maxAnisotropy);
    progress(0.12, 'Shaping the land');
    await nextFrame();
    bakeTerrain(this.hm);

    progress(0.25, 'Zoning the districts');
    await nextFrame();
    this.content = generateCity();
    const starterPad: Pad = { ...STARTER.lot, blend: 4, lock: true };
    const plazaPad: Pad = { ...STARTER.plaza, blend: 3, lock: true };
    const shopPad: Pad = { ...SHOP_PAD, blend: 4, lock: true };
    // Property plots: levelled a little beyond the building so the doors meet flat ground.
    for (const p of PROPERTIES) this.propertyPads.set(p.id, { x0: p.x - p.w / 2 - 2, x1: p.x + p.w / 2 + 2, z0: p.z - p.d / 2 - 2, z1: p.z + p.d / 2 + 6, blend: 6, lock: true });
    this.hm.applyPads([starterPad, plazaPad, shopPad, ...this.propertyPads.values(), ...this.content.pads]);

    progress(0.38, 'Laying the ground');
    await nextFrame();
    const terrain = buildTerrain(this.hm, physics, this.content.parks, this.surfaces);
    scene.add(terrain.mesh);
    this.grassWeight = terrain.grass;

    progress(0.5, 'Paving streets and bridges');
    await nextFrame();
    scene.add(buildRoads(this.hm, physics));

    progress(0.56, 'Loading the downtown kit');
    await nextFrame();
    const kit = new KitAssets();
    await kit.load();
    this.kitLoaded = kit.ready;
    if (kit.ready) this.placeKit(kit);
    this.nightMats.push(...kit.nightMaterials);

    progress(0.62, 'Raising buildings');
    await nextFrame();
    const b = buildBuildings(this.content.buildings, physics);
    scene.add(b.group);
    scene.add(buildRooftop(b.rooftop));
    this.nightMats.push(...b.nightMaterials);

    progress(0.74, 'Unlocking 14 Larch Street');
    await nextFrame();
    this.starter = new StarterHouse(this.svc, this.hm, starterPad);
    this.starter.addLotFeatures(this.content);
    scene.add(buildPlaza(plazaPad, physics, this.content));
    progress(0.8, 'Listing properties for sale');
    await nextFrame();
    await this.svc.properties.build(this.hm, this.propertyPads);
    this.shop = new CornerShop(this.svc, this.hm, shopPad, this.chars);
    await this.shop.build();

    progress(0.86, 'Planting trees and parking cars');
    await nextFrame();
    this.props = buildProps(this.content, this.hm, physics);
    scene.add(this.props.group);
    this.nightMats.push(...this.props.nightMaterials);

    progress(0.92, 'Growing grass');
    await nextFrame();
    const houseRect = { x0: STARTER.house.x - 6.5, z0: STARTER.house.z - 5.5, x1: STARTER.house.x + 6.5, z1: STARTER.house.z + 7.6 };
    const mask = buildGrassMask(this.hm, this.grassWeight!, this.content, [STARTER.plaza, shopPad, houseRect, ...this.propertyPads.values()]);
    this.grassWeight = null;
    this.grass = new GrassField(this.hm, mask, this.surfaces);
    this.grass.setQuality(this.svc.settings.graphics);
    scene.add(this.grass.group);

    // Initialise the query pipeline so ray casts see every static collider immediately.
    physics.world.step();
    this.stats = {
      buildings: this.content.buildings.length + 1,
      trees: this.content.trees.length,
      cars: this.content.cars.length,
      colliders: physics.world.colliders.len(),
    };
    progress(0.97, 'Waking the city');
    await nextFrame();
  }

  update(dt: number, night: number, playerPos: THREE.Vector3, camPos: THREE.Vector3 = playerPos): void {
    WIND.value += dt;
    this.grass?.update(WIND.value, camPos, playerPos);
    waterNormals.offset.y -= dt * 0.08;
    waterNormals.offset.x += dt * 0.01;
    for (const m of this.nightMats) m.emissiveIntensity = night * (m.emissiveMap ? 1.25 : 3);
    this.props.lightPools.opacity = night * 0.55;
    this.starter.update(night);
    this.shop?.update(dt, night);

    // Traffic signals: avenue and street alternate (14 s green, 3 s amber).
    this.signalClock = (this.signalClock + dt) % 34;
    const t = this.signalClock;
    const ns = t < 14 ? 2 : t < 17 ? 1 : 0;
    const ew = t >= 17 && t < 31 ? 2 : t >= 31 ? 1 : 0;
    // Bulb materials are ordered red, amber, green; state 0 = red, 1 = amber, 2 = green.
    this.props.signals.ns.forEach((m, i) => (m.emissiveIntensity = i === ns ? 2.4 : 0.05));
    this.props.signals.ew.forEach((m, i) => (m.emissiveIntensity = i === ew ? 2.4 : 0.05));

    this.districtTimer -= dt;
    if (this.districtTimer <= 0) {
      this.districtTimer = 0.5;
      const d = districtAt(playerPos.x, playerPos.z);
      if (d !== this.district) {
        this.district = d;
        this.bus.emit('district:enter', { district: d });
      }
    }
  }

  kitLoaded = false;
  readonly propertyPads = new Map<string, Pad>();

  /** Swaps some downtown and Market Row plots for MegaKit buildings, and adds kit street props. */
  private placeKit(kit: KitAssets) {
    const rng = new Rng(4040);
    const placements = new Map<KitName, THREE.Matrix4[]>();
    const add = (n: KitName, m: THREE.Matrix4) => {
      if (!placements.has(n)) placements.set(n, []);
      placements.get(n)!.push(m);
    };
    const models = KIT_BUILDINGS.map((n) => kit.models.get(n)!).sort((a, b) => b.box.max.x - b.box.min.x - (a.box.max.x - a.box.min.x));
    for (const s of this.content.buildings) {
      if (!((s.kind === 'tower' || s.kind === 'retail') && (s.facing === 'n' || s.facing === 's'))) continue;
      const d = districtAt(s.x, s.z);
      if (d !== 'downtown' && d !== 'commercial') continue;
      if (!rng.chance(0.55)) continue;
      const fit = models.find((m) => m.box.max.x - m.box.min.x <= s.w + 0.6 && m.box.max.z - m.box.min.z <= s.d + 0.6);
      if (!fit) continue;
      const b = fit.box;
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      const y = s.pad.h!;
      const rot = s.facing === 's' ? 0 : Math.PI;
      const sign = s.facing === 's' ? 1 : -1;
      // Model front is its max-z face; put it on the plot's street-facing edge.
      const px = s.x - sign * cx;
      const pz = s.z + sign * (s.d / 2 - b.max.z);
      const m = new THREE.Matrix4().makeRotationY(rot).setPosition(px, y - 0.02, pz);
      add(fit.name, m);
      s.kit = fit.name;
      const wx = px + sign * cx;
      const wz = pz + sign * cz;
      const hx = (b.max.x - b.min.x) / 2;
      const hz = (b.max.z - b.min.z) / 2;
      const h = b.max.y;
      this.svc.physics.box(wx, y + h / 2 - 0.5, wz, hx, h / 2 + 0.5, hz, 0, 'concrete');
      s.w = hx * 2;
      s.d = hz * 2;
      s.x = wx;
      s.z = wz;
      s.height = h;
    }
    // Street props: manholes on downtown and Market Row roads, bollards along the plaza.
    for (const x of X_LINES)
      for (let k = 0; k < Z_LINES.length - 1; k++) {
        const z = (Z_LINES[k] + Z_LINES[k + 1]) / 2 + 9;
        const d = districtAt(x + 1, z);
        if (d === 'downtown' || d === 'commercial') add('Prop_ManholeCover', new THREE.Matrix4().setPosition(x + 2.2, this.hm.get(x + 2.2, z) + 0.065, z));
      }
    for (let x = 18.5; x <= 56.5; x += 2.5) {
      if (x > 32.5 && x < 42.5) continue;
      const z = -8.6;
      const y = this.hm.get(x, z);
      add('Prop_Bollard', new THREE.Matrix4().setPosition(x, y, z));
      this.svc.physics.cylinder(x, y + 0.45, z, 0.45, 0.11);
    }
    for (const [n, list] of placements) this.svc.scene.add(kit.instance(n, list, n !== 'Prop_ManholeCover'));
  }

  get currentDistrict(): District | null {
    return this.district;
  }

  districtName(d: District) {
    return DISTRICTS[d];
  }
}
