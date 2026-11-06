import * as THREE from 'three';
import type { Input } from '../core/Input';
import { clamp, damp } from '../core/math';
import type { Services } from '../core/Services';
import type { Interactable } from '../interaction/Interactable';
import { Container } from '../inventory/Inventory';
import type { Collider, RigidBody } from '../physics/Physics';
import { STARTER } from '../world/CityGenerator';

/**
 * Drivable cars. Arcade handling on top of Rapier's character controller, so cars climb curbs,
 * follow the hills and stop against walls. Each car has a trunk for moving stock around.
 */

export type VehicleType = 'hatch' | 'van' | 'coupe';

export const VEHICLE_TYPES: Record<VehicleType, { name: string; price: number; trunk: number; top: number; accel: number; grip: number; half: [number, number, number]; unlock: number; desc: string }> = {
  hatch: { name: 'Shelby Hatchback', price: 3500, trunk: 12, top: 21, accel: 7, grip: 2.4, half: [2.1, 0.62, 0.88], unlock: 0, desc: 'Cheap, nippy, small trunk. Gets you around town.' },
  van: { name: 'Mule Panel Van', price: 9000, trunk: 30, top: 17, accel: 5, grip: 2.0, half: [2.5, 1.05, 1.0], unlock: 2000, desc: 'Slow but swallows a whole delivery. 30 trunk slots.' },
  coupe: { name: 'Vento GT Coupe', price: 24000, trunk: 6, top: 32, accel: 11, grip: 2.9, half: [2.2, 0.55, 0.92], unlock: 10000, desc: 'Fast enough to lose anyone on foot. Tiny trunk.' },
};

export const PAINTS = [0x8f2b2b, 0x2b3f63, 0xd7d4cc, 0x1d1f22, 0x30503f, 0xc8642a, 0x6b2f4a, 0xe0b84a];

const tmp = new THREE.Vector3();

/** Builds a car mesh: body, glass, lights, and four wheels you can spin and steer. */
export function makeVehicleMesh(type: VehicleType, color: number, clearGlass = false): { group: THREE.Group; wheels: THREE.Object3D[]; body: THREE.MeshStandardMaterial; lights: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness: 0.55 });
  // Other players' cars get see-through windows so you can see who's driving.
  const glass = clearGlass
    ? new THREE.MeshStandardMaterial({ color: 0x1c2a33, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.32, depthWrite: false })
    : new THREE.MeshStandardMaterial({ color: 0x18222b, roughness: 0.08, metalness: 0.7 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.7 });
  const lights = new THREE.MeshStandardMaterial({ color: 0xf2efe4, emissive: 0xfff2d0, emissiveIntensity: 0 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x7a1010, emissive: 0xff2010, emissiveIntensity: 0.2 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };
  if (type === 'van') {
    add(new THREE.BoxGeometry(4.9, 1.75, 1.95), body, -0.1, 1.33, 0);
    add(new THREE.BoxGeometry(1.0, 0.75, 1.9), glass, 2.0, 1.75, 0).rotation.z = -0.25;
    add(new THREE.BoxGeometry(0.6, 0.55, 1.97), glass, 1.1, 1.75, 0);
    add(new THREE.BoxGeometry(0.1, 0.2, 1.8), trim, 2.4, 0.62, 0);
  } else {
    const coupe = type === 'coupe';
    const len = coupe ? 4.4 : 4.2;
    add(new THREE.BoxGeometry(len, coupe ? 0.55 : 0.7, 1.78), body, 0, coupe ? 0.62 : 0.72, 0);
    const cab = add(new THREE.BoxGeometry(coupe ? 1.9 : 2.2, coupe ? 0.5 : 0.62, 1.58), glass, coupe ? -0.35 : -0.25, coupe ? 1.13 : 1.37, 0);
    cab.scale.set(1, 1, 1);
    add(new THREE.BoxGeometry(coupe ? 1.6 : 1.9, 0.06, 1.6), body, coupe ? -0.4 : -0.3, coupe ? 1.4 : 1.7, 0);
    add(new THREE.BoxGeometry(0.1, 0.18, 1.7), trim, len / 2, 0.5, 0);
    add(new THREE.BoxGeometry(0.1, 0.18, 1.7), trim, -len / 2, 0.5, 0);
  }
  const fx = type === 'van' ? 2.35 : type === 'coupe' ? 2.2 : 2.1;
  for (const z of [0.55, -0.55]) {
    add(new THREE.BoxGeometry(0.06, 0.14, 0.32), lights, fx + 0.03, type === 'van' ? 0.9 : 0.75, z);
    add(new THREE.BoxGeometry(0.06, 0.14, 0.3), tail, -fx - (type === 'van' ? 0.2 : 0) - 0.03, type === 'van' ? 1.0 : 0.78, z);
  }
  const wheels: THREE.Object3D[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 16);
  wheelGeo.rotateX(Math.PI / 2);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.9 });
  const hub = new THREE.MeshStandardMaterial({ color: 0xb9bec2, metalness: 0.8, roughness: 0.3 });
  const wx = type === 'van' ? 1.65 : 1.35;
  for (const x of [wx, -wx])
    for (const z of [0.86, -0.86]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.36, z);
      const w = new THREE.Mesh(wheelGeo, tyre);
      w.castShadow = true;
      const h = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.27, 10).rotateX(Math.PI / 2), hub);
      w.add(h);
      pivot.add(w);
      g.add(pivot);
      wheels.push(pivot);
    }
  return { group: g, wheels, body, lights };
}

export class Vehicle implements Interactable {
  readonly highlight: THREE.Mesh[] = [];
  readonly maxDistance = 3.2;
  readonly id: string;
  readonly group: THREE.Group;
  readonly trunk: Container;
  private wheels: THREE.Object3D[];
  private lightsMat: THREE.MeshStandardMaterial;
  readonly bodyMat: THREE.MeshStandardMaterial;
  readonly body: RigidBody;
  readonly collider: Collider;
  pos = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  steer = 0;
  pitch = 0;
  roll = 0;
  vy = 0;
  private spin = 0;
  headlight: THREE.SpotLight;

  constructor(
    private svc: Services,
    readonly n: number,
    readonly type: VehicleType,
    public color: number,
    x: number,
    y: number,
    z: number,
    yaw: number,
  ) {
    this.id = `vehicle-${n}`;
    const def = VEHICLE_TYPES[type];
    const m = makeVehicleMesh(type, color);
    this.group = m.group;
    this.wheels = m.wheels;
    this.lightsMat = m.lights;
    this.bodyMat = m.body;
    for (const c of this.group.children) if ((c as THREE.Mesh).isMesh && (c as THREE.Mesh).material === m.body) this.highlight.push(c as THREE.Mesh);
    svc.scene.add(this.group);
    this.trunk = new Container(`${def.name} trunk`, def.trunk);
    const R = svc.physics.R;
    this.body = svc.physics.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + def.half[1] + 0.1, z));
    this.collider = svc.physics.world.createCollider(R.ColliderDesc.cuboid(def.half[0], def.half[1], def.half[2]).setFriction(0.2), this.body);
    svc.physics.tag(this.collider, { interactable: this, surface: 'metal' });
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.headlight = new THREE.SpotLight(0xfff2d8, 0, 45, 0.55, 0.5, 1.5);
    this.headlight.position.set(2, 0.8, 0);
    this.headlight.target.position.set(10, 0, 0);
    this.group.add(this.headlight, this.headlight.target);
    this.syncBody(true);
    this.syncMesh();
  }

  get def() {
    return VEHICLE_TYPES[this.type];
  }

  get forward() {
    return tmp.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
  }

  /** Local coordinates of the point the player is aiming at on this car. */
  private aimLocalX(): number {
    const hp = this.svc.interaction.lastHitPoint;
    if (!hp) return 0;
    const dx = hp.x - this.pos.x;
    const dz = hp.z - this.pos.z;
    return dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
  }

  prompt() {
    if (this.svc.vehicles.driving) return null;
    if (this.aimLocalX() < -this.def.half[0] * 0.55) return `Open trunk (${this.trunk.slots.filter(Boolean).length}/${this.trunk.slots.length})`;
    return `Drive ${this.def.name}`;
  }

  interact() {
    if (this.aimLocalX() < -this.def.half[0] * 0.55) {
      this.svc.audio.play('doorOpen', this.pos);
      this.svc.ui.openInventory(this.trunk, `${this.def.name} trunk`);
      return;
    }
    this.svc.vehicles.enter(this);
  }

  syncBody(teleport = false) {
    const t = { x: this.pos.x, y: this.pos.y + this.def.half[1] + 0.1, z: this.pos.z };
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, this.yaw, 0));
    if (teleport) {
      this.body.setTranslation(t, true);
      this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    } else {
      this.body.setNextKinematicTranslation(t);
      this.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
  }

  syncMesh() {
    this.group.position.copy(this.pos);
    this.group.rotation.set(0, 0, 0);
    this.group.rotateY(this.yaw);
    this.group.rotateZ(this.pitch);
    this.group.rotateX(this.roll);
    this.spin += (this.speed / 0.36) * (1 / 60);
    this.wheels.forEach((w, i) => {
      w.rotation.set(0, i < 2 ? this.steer * 0.5 : 0, 0);
      (w.children[0] as THREE.Object3D).rotation.z = -this.spin;
    });
  }

  setLights(on: boolean, brake: boolean) {
    this.lightsMat.emissiveIntensity = on ? 2.5 : 0;
    this.headlight.intensity = on ? 60 : 0;
    void brake;
  }
}

export class Vehicles {
  readonly list: Vehicle[] = [];
  driving: Vehicle | null = null;
  private ctrl: ReturnType<Services['physics']['world']['createCharacterController']>;
  private camYaw = 0;
  private camPitch = 0.25;
  private camPos = new THREE.Vector3();
  private nextN = 1;

  constructor(
    private svc: Services,
    private camera: THREE.PerspectiveCamera,
  ) {
    this.ctrl = svc.physics.world.createCharacterController(0.05);
    this.ctrl.setUp({ x: 0, y: 1, z: 0 });
    this.ctrl.enableAutostep(0.3, 0.3, true);
    this.ctrl.enableSnapToGround(0.7);
    this.ctrl.setMaxSlopeClimbAngle((38 * Math.PI) / 180);
  }

  unlocked(t: VehicleType) {
    return this.svc.economy.lifetimeRevenue >= VEHICLE_TYPES[t].unlock;
  }

  /** A parking spot on Larch Street outside the house, a few metres apart per car. */
  private parkingSpot(): [number, number, number] {
    const i = this.list.length;
    return [STARTER.house.x + 6 + i * 6, -78.4, 0];
  }

  buy(type: VehicleType, color: number): string {
    const def = VEHICLE_TYPES[type];
    if (!this.unlocked(type)) return `Unlocks at $${def.unlock.toLocaleString()} lifetime sales.`;
    // Cars are card-only: dealers don't take bags of cash.
    const short = this.svc.economy.cardShort(def.price);
    if (short || !this.svc.economy.payCard(def.price, `Bought ${def.name}`)) return short ?? 'Card declined.';
    const [x, z, yaw] = this.parkingSpot();
    this.spawn(type, color, x, z, yaw);
    return `Your ${def.name} is parked on Larch Street outside your house.`;
  }

  spawn(type: VehicleType, color: number, x: number, z: number, yaw: number, y?: number): Vehicle {
    const hit = this.svc.physics.raycast({ x, y: 300, z }, { x: 0, y: -1, z: 0 }, 600, [], false);
    const gy = y ?? (hit ? hit.point.y : this.svc.world.hm.get(x, z));
    const v = new Vehicle(this.svc, this.nextN++, type, color, x, gy, z, yaw);
    this.list.push(v);
    this.svc.interaction.register(v);
    return v;
  }

  enter(v: Vehicle) {
    if (this.driving) return;
    this.driving = v;
    this.svc.player.hidden = true;
    this.svc.player.collider.setSensor(true);
    this.camYaw = 0;
    this.camPos.copy(v.pos).addScaledVector(v.forward, -7).setY(v.pos.y + 3);
    this.svc.audio.play('doorClose', v.pos);
    this.svc.ui.toast('W/S throttle and brake · A/D steer · Space handbrake · E to get out', 'info');
  }

  exit(): boolean {
    const v = this.driving;
    if (!v) return false;
    if (Math.abs(v.speed) > 3) {
      this.svc.ui.toast('Slow down before getting out.', 'warn');
      return false;
    }
    // Try the driver's side, then the passenger side, then the roof.
    const right = new THREE.Vector3(Math.sin(v.yaw), 0, Math.cos(v.yaw));
    const tries = [right.clone().multiplyScalar(-(v.def.half[2] + 0.9)), right.clone().multiplyScalar(v.def.half[2] + 0.9)];
    let spot: THREE.Vector3 | null = null;
    for (const off of tries) {
      const p = v.pos.clone().add(off);
      const hit = this.svc.physics.raycast({ x: v.pos.x, y: v.pos.y + 1, z: v.pos.z }, { x: off.x / off.length(), y: 0, z: off.z / off.length() }, off.length() + 0.3, [v.collider, this.svc.player.collider], false);
      if (!hit) {
        spot = p;
        break;
      }
    }
    if (!spot) spot = v.pos.clone().setY(v.pos.y + v.def.half[1] * 2 + 0.2);
    const down = this.svc.physics.raycast({ x: spot.x, y: spot.y + 2, z: spot.z }, { x: 0, y: -1, z: 0 }, 6, [this.svc.player.collider], false);
    this.svc.player.collider.setSensor(false);
    this.svc.player.teleport(spot.x, (down ? down.point.y : spot.y) + 0.05, spot.z, v.yaw - Math.PI / 2);
    this.svc.player.hidden = false;
    v.speed = 0;
    v.setLights(false, false);
    this.driving = null;
    this.svc.audio.play('doorClose', v.pos);
    return true;
  }

  /** Drive the current vehicle and place the chase camera. */
  drive(dt: number, input: Input, active: boolean, night: number) {
    const v = this.driving!;
    const def = v.def;
    const ax = active ? input.axis() : { forward: 0, right: 0, sprint: false, jump: false };
    const hand = active && input.isDown('Space');
    // Throttle and braking.
    if (ax.forward > 0) v.speed += (v.speed < 0 ? def.accel * 2.2 : def.accel) * dt;
    else if (ax.forward < 0) v.speed -= (v.speed > 0 ? def.accel * 2.4 : def.accel * 0.7) * dt;
    else v.speed = damp(v.speed, 0, 0.6, dt);
    if (hand) v.speed = damp(v.speed, 0, 2.5, dt);
    v.speed = clamp(v.speed, -7, def.top);
    // Steering: tighter at low speed, never turns while stopped.
    v.steer = damp(v.steer, -ax.right, 6, dt);
    const turn = v.steer * def.grip * clamp(Math.abs(v.speed) / 6, 0, 1) * (1 / (1 + Math.abs(v.speed) / 25)) * Math.sign(v.speed || 1);
    v.yaw += turn * dt * (hand ? 1.6 : 1);
    // Gravity and movement through the character controller.
    v.vy = Math.max(-30, v.vy - 20 * dt);
    const f = v.forward;
    const desired = { x: f.x * v.speed * dt, y: v.vy * dt, z: f.z * v.speed * dt };
    const pc = this.svc.player.collider;
    this.ctrl.computeColliderMovement(v.collider, desired, this.svc.physics.R.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (c: Collider) => c.handle !== pc.handle);
    const mv = this.ctrl.computedMovement();
    if (this.ctrl.computedGrounded()) v.vy = -1;
    const want = Math.hypot(desired.x, desired.z);
    const got = Math.hypot(mv.x, mv.z);
    if (want > 0.05 && got < want * 0.4) {
      if (Math.abs(v.speed) > 6) {
        this.svc.audio.play('thud', v.pos);
        this.svc.ui.shake(0.4);
      }
      v.speed *= 0.25;
    }
    const cur = v.collider.translation();
    const next = { x: cur.x + mv.x, y: cur.y + mv.y, z: cur.z + mv.z };
    v.body.setNextKinematicTranslation(next);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, v.yaw, 0));
    v.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
    v.pos.set(next.x, next.y - def.half[1] - 0.1, next.z);
    // Safety: never below the terrain.
    const ground = this.svc.world.hm.get(v.pos.x, v.pos.z);
    if (v.pos.y < ground - 2) {
      v.pos.y = ground + 0.2;
      v.syncBody(true);
    }
    // Visual pitch/roll from the surface under the wheels.
    const probe = (lx: number, lz: number) => {
      const wx = v.pos.x + Math.cos(v.yaw) * lx + Math.sin(v.yaw) * lz;
      const wz = v.pos.z - Math.sin(v.yaw) * lx + Math.cos(v.yaw) * lz;
      const hit = this.svc.physics.raycast({ x: wx, y: v.pos.y + 1.5, z: wz }, { x: 0, y: -1, z: 0 }, 3.5, [v.collider, pc], false);
      return hit ? hit.point.y : v.pos.y;
    };
    const L = def.half[0] * 0.8;
    const W = def.half[2] * 0.9;
    v.pitch = damp(v.pitch, Math.atan2(probe(L, 0) - probe(-L, 0), 2 * L), 8, dt);
    v.roll = damp(v.roll, Math.atan2(probe(0, -W) - probe(0, W), 2 * W) * 0.7, 8, dt);
    v.syncMesh();
    v.setLights(night > 0.4, ax.forward < 0);
    // Player rides along.
    this.svc.player.position.copy(v.pos);
    pc.setTranslation({ x: v.pos.x, y: v.pos.y + 3, z: v.pos.z });
    // Chase camera: mouse orbits, then eases back behind the car.
    if (active) {
      this.camYaw -= input.mouseDX * 0.003;
      this.camPitch = clamp(this.camPitch + input.mouseDY * 0.002, 0.05, 0.9);
      if (!input.mouseDX) this.camYaw = damp(this.camYaw, 0, Math.abs(v.speed) > 2 ? 1.5 : 0.2, dt);
    }
    const back = new THREE.Vector3(-Math.cos(v.yaw + this.camYaw), 0, Math.sin(v.yaw + this.camYaw));
    const dist = 6.5 + Math.abs(v.speed) * 0.08;
    const target = v.pos.clone().addScaledVector(back, dist * Math.cos(this.camPitch));
    target.y = v.pos.y + 1.4 + dist * Math.sin(this.camPitch);
    // Keep the camera out of walls.
    const look = v.pos.clone().setY(v.pos.y + 1.4);
    const dir = target.clone().sub(look);
    const len = dir.length();
    const hit = this.svc.physics.raycast(look, dir.normalize(), len, [v.collider, pc], false);
    if (hit) target.copy(look).addScaledVector(dir, Math.max(1.5, hit.distance - 0.3));
    this.camPos.lerp(target, 1 - Math.exp(-10 * dt));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(look);
    const fov = this.svc.settings.fov + clamp(Math.abs(v.speed) - 10, 0, 20) * 0.4;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Parked cars still need their meshes in sync (wheels idle, lights off). */
  frame() {
    for (const v of this.list) if (v !== this.driving) v.setLights(false, false);
  }

  repaint(v: Vehicle, color: number): string {
    if (!this.svc.economy.spend(200, `Respray ${v.def.name}`)) return 'A respray costs $200.';
    v.color = color;
    v.bodyMat.color.setHex(color);
    return 'Fresh paint.';
  }

  toJSON() {
    return this.list.map((v) => ({ type: v.type, color: v.color, x: v.pos.x, y: v.pos.y, z: v.pos.z, yaw: v.yaw, trunk: v.trunk.toJSON() }));
  }

  load(d: ReturnType<Vehicles['toJSON']> | undefined) {
    if (!d) return;
    for (const s of d) {
      const v = this.spawn(s.type, s.color, s.x, s.z, s.yaw, s.y);
      v.trunk.load(s.trunk as never);
    }
  }
}
