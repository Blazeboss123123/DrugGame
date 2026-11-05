import * as RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Surface } from '../core/EventBus';
import type { Interactable } from '../interaction/Interactable';

// The compat build exposes its API either as named exports or as a default export depending on bundler.
export const RAPIER: typeof RAPIER_NS = ((RAPIER_NS as unknown as { default?: typeof RAPIER_NS }).default ?? RAPIER_NS) as typeof RAPIER_NS;
export type Collider = RAPIER_NS.Collider;
export type RigidBody = RAPIER_NS.RigidBody;

export interface ColliderInfo {
  surface?: Surface;
  interactable?: Interactable;
  terrain?: boolean;
}

export interface RayHit {
  collider: Collider;
  distance: number;
  normal: { x: number; y: number; z: number };
  point: { x: number; y: number; z: number };
}

const yawQuat = (yaw: number) => ({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) });

/** Thin wrapper over the Rapier world: static geometry helpers, collider metadata and ray queries. */
export class Physics {
  readonly world: RAPIER_NS.World;
  /** The Rapier module, for systems that build their own bodies. */
  readonly R = RAPIER;
  private info = new Map<number, ColliderInfo>();
  private accumulator = 0;
  readonly fixedStep = 1 / 60;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedStep;
  }

  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  tag(collider: Collider, info: ColliderInfo): Collider {
    this.info.set(collider.handle, { ...this.info.get(collider.handle), ...info });
    return collider;
  }

  infoOf(collider: Collider | null | undefined): ColliderInfo | undefined {
    return collider ? this.info.get(collider.handle) : undefined;
  }

  /** Static axis-aligned (optionally yawed) box. Arguments are centre and half extents. */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, yaw = 0, surface: Surface = 'concrete'): Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setFriction(0.8);
    if (yaw) desc.setRotation(yawQuat(yaw));
    return this.tag(this.world.createCollider(desc), { surface });
  }

  /** Static box with an arbitrary rotation quaternion. */
  boxQuat(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, q: { x: number; y: number; z: number; w: number }, surface: Surface = 'concrete'): Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz).setRotation(q).setFriction(0.8);
    return this.tag(this.world.createCollider(desc), { surface });
  }

  cylinder(cx: number, cy: number, cz: number, halfHeight: number, radius: number, surface: Surface = 'metal'): Collider {
    const desc = RAPIER.ColliderDesc.cylinder(halfHeight, radius).setTranslation(cx, cy, cz);
    return this.tag(this.world.createCollider(desc), { surface });
  }

  /** Steps dynamic bodies at a fixed rate. Returns the number of steps taken. */
  step(dt: number): number {
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    let n = 0;
    while (this.accumulator >= this.fixedStep) {
      this.world.step();
      this.accumulator -= this.fixedStep;
      n++;
    }
    return n;
  }

  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxDist: number,
    exclude: (Collider | null | undefined)[] = [],
    includeSensors = true,
  ): RayHit | null {
    const ray = new RAPIER.Ray(origin, dir);
    const handles = exclude.filter(Boolean).map((c) => c!.handle);
    const flags = includeSensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, flags, undefined, undefined, undefined, (c: Collider) => !handles.includes(c.handle));
    if (!hit) return null;
    const toi = (hit as unknown as { timeOfImpact?: number; toi?: number }).timeOfImpact ?? (hit as unknown as { toi: number }).toi;
    return {
      collider: hit.collider,
      distance: toi,
      normal: hit.normal,
      point: { x: origin.x + dir.x * toi, y: origin.y + dir.y * toi, z: origin.z + dir.z * toi },
    };
  }
}

export { yawQuat };
