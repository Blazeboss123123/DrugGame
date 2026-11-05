import * as THREE from 'three';
import { RAPIER, type Collider, type RigidBody } from '../physics/Physics';
import type { Services } from '../core/Services';
import { ownMaterial, type Interactable } from './Interactable';

const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

/** Hinged door with a kinematic collider. Always swings away from the player. */
export class Door implements Interactable {
  readonly pivot = new THREE.Group();
  readonly highlight: THREE.Mesh[] = [];
  readonly maxDistance = 2.4;
  private panel: THREE.Mesh;
  private body: RigidBody;
  readonly collider: Collider;
  private angle = 0;
  private target = 0;
  get isOpen() {
    return this.target !== 0;
  }

  constructor(
    private svc: Services,
    readonly id: string,
    hinge: THREE.Vector3,
    private yaw: number,
    private width: number,
    height: number,
    material: THREE.Material,
    private label = 'door',
    /** Returns a reason when the door can't be used (e.g. the property isn't yours). */
    public lock?: () => string | null,
  ) {
    this.pivot.position.copy(hinge);
    this.pivot.rotation.y = yaw;
    const t = 0.05;
    this.panel = ownMaterial(new THREE.Mesh(new THREE.BoxGeometry(width - 0.02, height - 0.02, t), material));
    this.panel.position.set(width / 2, height / 2, 0);
    this.panel.castShadow = true;
    this.panel.receiveShadow = true;
    this.pivot.add(this.panel);
    const knobMat = new THREE.MeshStandardMaterial({ color: 0xc9b37a, metalness: 0.8, roughness: 0.3 });
    for (const side of [-1, 1]) {
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), knobMat);
      knob.position.set(width - 0.1, 1.0, side * 0.05);
      this.pivot.add(knob);
    }
    this.highlight.push(this.panel);
    svc.scene.add(this.pivot);
    this.body = svc.physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = svc.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2 - 0.03, height / 2 - 0.01, t / 2 + 0.01), this.body);
    svc.physics.tag(this.collider, { interactable: this, surface: 'wood' });
    this.sync(true);
  }

  prompt() {
    const locked = !this.isOpen && this.lock?.();
    if (locked) return locked;
    if (this.isOpen && this.blocked()) return `Step out of the doorway to close the ${this.label}`;
    return this.isOpen ? `Close ${this.label}` : `Open ${this.label}`;
  }

  /** True if the player is standing where the closing door would sweep. */
  private blocked(): boolean {
    const p = this.svc.player.position;
    tmpV.set(p.x, p.y, p.z).sub(this.pivot.position);
    tmpV.applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw);
    const swingSide = Math.sign(this.target) < 0 ? 1 : -1; // positive angle sweeps toward local -z
    return tmpV.length() < this.width + 0.45 && tmpV.z * swingSide > -0.4 && tmpV.x > -0.4;
  }

  interact() {
    if (!this.isOpen && this.lock?.()) {
      this.svc.audio.play('denied');
      return;
    }
    if (this.isOpen) {
      if (this.blocked()) {
        this.svc.audio.play('denied');
        return;
      }
      this.target = 0;
      this.svc.audio.play('doorClose', this.pivot.position);
    } else {
      const p = this.svc.player.position;
      tmpV.set(p.x, p.y, p.z).sub(this.pivot.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), -this.yaw);
      this.target = tmpV.z > 0 ? 1.75 : -1.75;
      this.svc.audio.play('doorOpen', this.pivot.position);
    }
  }

  update(dt: number) {
    if (this.angle === this.target) return;
    const speed = 3.2;
    const d = this.target - this.angle;
    const stepA = Math.sign(d) * Math.min(Math.abs(d), speed * dt * (0.35 + Math.abs(d)));
    this.angle += stepA;
    if (Math.abs(this.target - this.angle) < 0.002) {
      this.angle = this.target;
      if (this.target === 0) this.svc.audio.play('doorThud', this.pivot.position);
    }
    this.pivot.rotation.y = this.yaw + this.angle;
    this.sync(false);
  }

  private sync(teleport: boolean) {
    this.pivot.updateMatrixWorld(true);
    this.panel.getWorldPosition(tmpV);
    this.panel.getWorldQuaternion(tmpQ);
    const t = { x: tmpV.x, y: tmpV.y, z: tmpV.z };
    const q = { x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w };
    if (teleport) {
      this.body.setTranslation(t, true);
      this.body.setRotation(q, true);
    } else {
      this.body.setNextKinematicTranslation(t);
      this.body.setNextKinematicRotation(q);
    }
  }
}

/** Sectional garage door that rolls up into the ceiling. */
export class RollerDoor implements Interactable {
  readonly highlight: THREE.Mesh[] = [];
  readonly maxDistance = 3;
  private panel: THREE.Mesh;
  private body: RigidBody;
  private t = 0;
  private target = 0;

  constructor(
    private svc: Services,
    readonly id: string,
    private center: THREE.Vector3, // bottom centre of the opening
    private width: number,
    private height: number,
    material: THREE.Material,
    public lock?: () => string | null,
  ) {
    const geo = new THREE.BoxGeometry(width, height, 0.06);
    geo.translate(0, -height / 2, 0); // anchor at the top edge
    this.panel = ownMaterial(new THREE.Mesh(geo, material));
    this.panel.position.set(center.x, center.y + height, center.z);
    this.panel.castShadow = true;
    this.highlight.push(this.panel);
    svc.scene.add(this.panel);
    this.body = svc.physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(center.x, center.y + height / 2, center.z));
    const col = svc.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, height / 2, 0.06), this.body);
    svc.physics.tag(col, { interactable: this, surface: 'metal' });
  }

  get isOpen() {
    return this.target === 1;
  }

  private playerUnder(): boolean {
    const p = this.svc.player.position;
    return Math.abs(p.x - this.center.x) < this.width / 2 + 0.4 && Math.abs(p.z - this.center.z) < 0.7;
  }

  prompt() {
    const locked = !this.isOpen && this.lock?.();
    if (locked) return locked;
    if (this.isOpen && this.playerUnder()) return 'Step clear to close the garage door';
    return this.isOpen ? 'Close roller door' : 'Open roller door';
  }

  interact() {
    if (!this.isOpen && this.lock?.()) {
      this.svc.audio.play('denied');
      return;
    }
    if (this.isOpen && this.playerUnder()) {
      this.svc.audio.play('denied');
      return;
    }
    this.target = this.isOpen ? 0 : 1;
    this.svc.audio.play('roller', this.center);
  }

  update(dt: number) {
    if (this.t === this.target) return;
    const d = this.target - this.t;
    this.t += Math.sign(d) * Math.min(Math.abs(d), dt * 0.55);
    this.panel.scale.y = Math.max(0.06, 1 - this.t * 0.94);
    this.body.setNextKinematicTranslation({ x: this.center.x, y: this.center.y + this.height / 2 + this.t * (this.height - 0.15), z: this.center.z });
  }
}

/** A group of lights and the fixtures that glow with them. */
export class LightCircuit {
  on = false;
  constructor(
    readonly lights: THREE.PointLight[],
    readonly bulbs: THREE.Mesh[],
    private intensity: number,
  ) {
    this.apply();
  }
  set(on: boolean) {
    this.on = on;
    this.apply();
  }
  private apply() {
    for (const l of this.lights) {
      l.intensity = this.on ? this.intensity : 0;
      l.visible = this.on;
    }
    for (const b of this.bulbs) (b.material as THREE.MeshStandardMaterial).emissiveIntensity = this.on ? 2.2 : 0;
  }
}

export class LightSwitch implements Interactable {
  readonly highlight: THREE.Mesh[];
  readonly maxDistance = 2.2;
  constructor(
    private svc: Services,
    readonly id: string,
    private circuit: LightCircuit,
    plate: THREE.Mesh,
    private lever: THREE.Mesh,
    private roomName: string,
  ) {
    this.highlight = [plate];
    this.apply();
  }
  prompt() {
    return `${this.circuit.on ? 'Turn off' : 'Turn on'} ${this.roomName} light`;
  }
  interact() {
    this.circuit.set(!this.circuit.on);
    this.apply();
    this.svc.audio.play('switch');
    if (this.circuit.on) this.svc.bus.emit('objective:signal', { id: 'light' });
  }
  private apply() {
    this.lever.rotation.x = this.circuit.on ? -0.35 : 0.35;
  }
}

/** A physical object that can be picked up, carried and set down. */
export class Pickup implements Interactable {
  readonly highlight: THREE.Mesh[];
  readonly maxDistance = 2.6;
  readonly body: RigidBody;
  readonly collider: Collider;
  carried = false;
  /** Set when dropped, used to play an impact sound on landing. */
  falling = false;

  constructor(
    private svc: Services,
    readonly id: string,
    readonly name: string,
    readonly mesh: THREE.Mesh,
    readonly half: THREE.Vector3,
    position: THREE.Vector3,
    yaw = 0,
    mass = 4,
  ) {
    ownMaterial(mesh);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.highlight = [mesh];
    svc.scene.add(mesh);
    this.body = svc.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
        .setLinearDamping(0.3)
        .setAngularDamping(0.6)
        .setCcdEnabled(true),
    );
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setFriction(0.8).setRestitution(0.05);
    desc.setMass(mass);
    this.collider = svc.physics.world.createCollider(desc, this.body);
    svc.physics.tag(this.collider, { interactable: this, surface: 'wood' });
    this.syncMesh();
  }

  prompt() {
    if (this.svc.interaction.carrying) return null;
    return `Pick up ${this.name}`;
  }

  interact() {
    this.svc.interaction.pickUp(this);
  }

  syncMesh() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}
