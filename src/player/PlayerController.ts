import * as THREE from 'three';
import type { EventBus, Surface } from '../core/EventBus';
import type { Input } from '../core/Input';
import { clamp, damp } from '../core/math';
import type { Settings } from '../core/Settings';
import { RAPIER, type Collider, type Physics } from '../physics/Physics';
import type { Heightmap } from '../world/Heightmap';
import { roadDistance } from '../world/CityPlan';

const HALF_HEIGHT = 0.55;
const RADIUS = 0.32;
const CENTER = HALF_HEIGHT + RADIUS; // capsule centre above the feet
const EYE = 1.64;
const WALK = 4.3;
const SPRINT = 7.4;
const GRAVITY = 21;
const JUMP = 6.6;

/**
 * Kinematic first-person character on Rapier's character controller: autostep for stairs and curbs,
 * slope limits, snap-to-ground, acceleration and air control.
 */
export class PlayerController {
  /** Feet position. */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  grounded = false;
  readonly collider: Collider;
  private ctrl: ReturnType<Physics['world']['createCharacterController']>;
  private camY = 0;
  private bobPhase = 0;
  private stepDist = 0;
  private airTime = 0;
  private lastVy = 0;
  private fovKick = 0;
  /** Count of times the fall-through safety net had to rescue the player (should stay 0). */
  rescues = 0;
  /** True while the player is inside a vehicle. */
  hidden = false;
  // Skateboard.
  onBoard = false;
  boardYaw = 0;
  boardSpeed = 0;
  canBoard: () => boolean = () => false;
  readonly board = new THREE.Group();

  constructor(
    private physics: Physics,
    private camera: THREE.PerspectiveCamera,
    private hm: Heightmap,
    private bus: EventBus,
    private settings: Settings,
  ) {
    const desc = RAPIER.ColliderDesc.capsule(HALF_HEIGHT, RADIUS).setFriction(0);
    this.collider = physics.world.createCollider(desc);
    this.ctrl = physics.world.createCharacterController(0.03);
    this.ctrl.setUp({ x: 0, y: 1, z: 0 });
    this.ctrl.enableAutostep(0.42, 0.18, false);
    this.ctrl.enableSnapToGround(0.45);
    this.ctrl.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.ctrl.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    (this.ctrl as unknown as { setSlideEnabled?: (v: boolean) => void }).setSlideEnabled?.(true);
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.84), new THREE.MeshStandardMaterial({ color: 0xc23a2a, roughness: 0.6 }));
    deck.position.y = 0.1;
    deck.castShadow = true;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.005, 0.8), new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 1 }));
    grip.position.y = 0.118;
    this.board.add(deck, grip);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0xf2efe4, roughness: 0.5 });
    for (const z of [-0.28, 0.28])
      for (const x of [-0.09, 0.09]) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.035, 10), wheelMat);
        w.rotation.z = Math.PI / 2;
        w.position.set(x, 0.035, z);
        this.board.add(w);
      }
    this.board.visible = false;
  }

  /** Hop on or off the skateboard (R). Returns a message if it can't be done. */
  toggleBoard(): string | null {
    if (this.onBoard) {
      this.onBoard = false;
      this.board.visible = false;
      return null;
    }
    if (!this.canBoard()) return 'You need a skateboard. Order one from the Market app.';
    this.onBoard = true;
    this.boardYaw = this.yaw;
    this.boardSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    this.board.visible = true;
    return null;
  }

  teleport(x: number, y: number, z: number, yaw?: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    if (yaw !== undefined) this.yaw = yaw;
    this.collider.setTranslation({ x, y: y + CENTER, z });
    this.camY = y + EYE;
    this.applyCamera(0);
  }

  look(dx: number, dy: number): void {
    const k = 0.0021 * this.settings.sensitivity;
    this.yaw -= dx * k;
    this.pitch -= dy * k * (this.settings.invertY ? -1 : 1);
    this.pitch = clamp(this.pitch, -1.52, 1.52);
  }

  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
  }

  update(dt: number, input: Input, active: boolean): void {
    const ax = active ? input.axis() : { forward: 0, right: 0, sprint: false, jump: false };
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const hv = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    let sprinting = false;
    if (this.onBoard) {
      // Board: momentum along the deck, steered toward where you look (A/D carve harder).
      let d = this.yaw - this.boardYaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const rate = 2.4 + Math.abs(ax.right) * 1.6;
      this.boardYaw += Math.sign(d) * Math.min(Math.abs(d), rate * dt) - ax.right * 1.2 * dt;
      if (ax.forward > 0) this.boardSpeed += 7 * dt;
      else if (ax.forward < 0) this.boardSpeed -= 11 * dt;
      this.boardSpeed -= 0.7 * dt;
      const dir = new THREE.Vector3(-Math.sin(this.boardYaw), 0, -Math.cos(this.boardYaw));
      if (this.grounded) {
        const dh = this.hm.get(this.position.x + dir.x, this.position.z + dir.z) - this.hm.get(this.position.x, this.position.z);
        this.boardSpeed -= 9.81 * Math.max(-0.5, Math.min(0.5, dh)) * 0.6 * dt;
      }
      this.boardSpeed = Math.max(0, Math.min(ax.forward > 0 ? 12.5 : 17, this.boardSpeed));
      hv.copy(dir).multiplyScalar(this.boardSpeed);
    } else {
      const wish = fwd.clone().multiplyScalar(ax.forward).add(right.multiplyScalar(ax.right));
      if (wish.lengthSq() > 1) wish.normalize();
      sprinting = ax.sprint && ax.forward > 0 && this.grounded;
      wish.multiplyScalar(sprinting ? SPRINT : WALK);
      const accel = this.grounded ? (wish.lengthSq() > 0 ? 38 : 46) : 9;
      const diff = wish.sub(hv);
      const maxDelta = accel * dt;
      if (diff.length() > maxDelta) diff.setLength(maxDelta);
      hv.add(diff);
    }

    // Vertical.
    let vy = this.velocity.y;
    if (this.grounded && ax.jump) {
      vy = JUMP;
      this.grounded = false;
      this.bus.emit('player:jump', {});
      this.bus.emit('objective:signal', { id: 'jumped' });
    } else {
      vy -= GRAVITY * dt;
    }
    if (vy < -45) vy = -45;

    const desired = { x: hv.x * dt, y: vy * dt, z: hv.z * dt };
    this.ctrl.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const m = this.ctrl.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.ctrl.computedGrounded();
    const cur = this.collider.translation();
    const next = { x: cur.x + m.x, y: cur.y + m.y, z: cur.z + m.z };
    this.collider.setTranslation(next);

    // Velocity follows what actually happened (slides along walls, stops on ceilings).
    if (dt > 0) {
      const wanted = Math.hypot(desired.x, desired.z);
      hv.set(m.x / dt, 0, m.z / dt);
      if (this.onBoard) {
        if (wanted > 0.04 && Math.hypot(m.x, m.z) < wanted * 0.35 && this.boardSpeed > 5) {
          this.bus.emit('player:land', { speed: 9 });
          this.boardSpeed = 0;
        } else this.boardSpeed = Math.min(this.boardSpeed, hv.length() + 0.5);
      }
      if (this.grounded && vy < 0) vy = -1;
      else if (desired.y > 0 && m.y < desired.y * 0.5) vy = 0;
    }
    this.velocity.set(hv.x, vy, hv.z);
    this.position.set(next.x, next.y - CENTER, next.z);

    // Landing.
    if (!wasGrounded && this.grounded && this.airTime > 0.25) this.bus.emit('player:land', { speed: -this.lastVy });
    this.airTime = this.grounded ? 0 : this.airTime + dt;
    this.lastVy = vy;

    // Footsteps and objective tracking.
    const moved = Math.hypot(m.x, m.z);
    if (this.grounded && moved > 0.0005 && !this.onBoard) {
      this.stepDist += moved;
      this.bobPhase += moved * (sprinting ? 1.25 : 1.6);
      const stride = sprinting ? 2.4 : 1.9;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        this.bus.emit('player:footstep', { surface: this.surfaceUnder(), sprint: sprinting });
      }
      this.bus.emit('objective:signal', { id: 'walked', amount: moved });
      if (sprinting) this.bus.emit('objective:signal', { id: 'sprinted', amount: moved });
    }

    // Safety net: never let the player end up under the terrain.
    const ground = this.hm.get(this.position.x, this.position.z);
    if (this.position.y < ground - 2.5) {
      this.rescues++;
      this.teleport(this.position.x, ground + 0.5, this.position.z);
    }

    if (this.onBoard && moved > 0.0005) this.bus.emit('objective:signal', { id: 'walked', amount: moved });
    this.board.position.set(this.position.x, this.position.y, this.position.z);
    this.board.rotation.y = this.boardYaw;
    this.fovKick = damp(this.fovKick, (sprinting && hv.length() > WALK + 0.5) || (this.onBoard && this.boardSpeed > 8) ? 6 : 0, 6, dt);
    this.applyCamera(dt, hv.length(), sprinting);
  }

  private applyCamera(dt: number, speed = 0, sprinting = false): void {
    const targetY = this.position.y + EYE + (this.onBoard ? 0.12 : 0);
    // Smooth out autostep pops but stay locked on during falls.
    if (dt === 0 || Math.abs(targetY - this.camY) > 0.9) this.camY = targetY;
    else this.camY = damp(this.camY, targetY, this.grounded ? 16 : 40, dt);
    let bob = 0;
    let sway = 0;
    if (this.settings.headBob && this.grounded && speed > 0.5 && !this.onBoard) {
      const amp = sprinting ? 0.05 : 0.032;
      bob = Math.sin(this.bobPhase * 2) * amp;
      sway = Math.cos(this.bobPhase) * amp * 0.6;
    }
    this.camera.position.set(this.position.x + Math.cos(this.yaw) * sway, this.camY + bob, this.position.z - Math.sin(this.yaw) * sway);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    const fov = this.settings.fov + this.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Surface type under the feet, for footstep sounds. */
  surfaceUnder(): Surface {
    const hit = this.physics.raycast({ x: this.position.x, y: this.position.y + 0.3, z: this.position.z }, { x: 0, y: -1, z: 0 }, 1.2, [this.collider], false);
    const info = this.physics.infoOf(hit?.collider);
    if (info?.terrain) return roadDistance(this.position.x, this.position.z) < 7.2 ? 'concrete' : 'grass';
    return info?.surface ?? 'concrete';
  }
}
