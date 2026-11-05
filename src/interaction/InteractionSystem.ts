import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { Services } from '../core/Services';
import { RAPIER } from '../physics/Physics';
import { setHighlight, type Interactable } from './Interactable';
import type { Pickup } from './Objects';

const REACH = 3.2;

/**
 * Looks along the camera ray (walls block it), shows a prompt for the targeted object, handles E/G,
 * and carries picked-up items in front of the player.
 */
export class InteractionSystem {
  current: Interactable | null = null;
  /** World point the crosshair ray last hit (for objects with several interaction zones). */
  lastHitPoint: { x: number; y: number; z: number } | null = null;
  carrying: Pickup | null = null;
  readonly items: Interactable[] = [];
  readonly pickups: Pickup[] = [];
  private camDir = new THREE.Vector3();
  private holdPos = new THREE.Vector3();
  private holdQuat = new THREE.Quaternion();

  constructor(
    private svc: Services,
    private camera: THREE.PerspectiveCamera,
  ) {}

  register(i: Interactable): void {
    this.items.push(i);
    if ('body' in i && 'syncMesh' in i) this.pickups.push(i as unknown as Pickup);
  }

  update(dt: number, input: Input, active: boolean): void {
    for (const i of this.items) i.update?.(dt);
    for (const p of this.pickups) {
      if (p.carried) continue;
      p.syncMesh();
      if (p.falling) {
        const vy = p.body.linvel().y;
        const last = (p.mesh.userData.lastVy as number | undefined) ?? 0;
        p.mesh.userData.lastVy = vy;
        if (last < -1.2 && vy > last * 0.4) {
          p.falling = false;
          this.svc.audio.play('thud', p.mesh.position);
        }
      }
    }

    this.camera.getWorldDirection(this.camDir);
    const origin = this.camera.position;
    let target: Interactable | null = null;
    if (active && !this.carrying && !this.svc.player.hidden) {
      const hit = this.svc.physics.raycast(origin, this.camDir, REACH, [this.svc.player.collider]);
      this.lastHitPoint = hit ? hit.point : null;
      const it = this.svc.physics.infoOf(hit?.collider)?.interactable;
      if (hit && it && hit.distance <= (it.maxDistance ?? 2.6) && it.prompt() !== null) target = it;
    }
    if (target !== this.current) {
      if (this.current) setHighlight(this.current.highlight, false);
      if (target) setHighlight(target.highlight, true);
      this.current = target;
    }

    if (this.carrying) this.updateCarry();

    // Prompt.
    if (!active) this.svc.ui.hud.setPrompt(null);
    else if (this.carrying) this.svc.ui.hud.setPrompt(`Carrying ${this.carrying.name}`, [
      ['E', 'Set down'],
      ['G', 'Drop'],
    ]);
    else if (this.current) {
      const sec = this.current.secondaryPrompt?.();
      this.svc.ui.hud.setPrompt(this.current.prompt(), sec ? [['E', 'Use'], ['F', sec]] : [['E', '']]);
    }
    else this.svc.ui.hud.setPrompt(null);

    if (!active) return;
    if (input.wasPressed('KeyE')) {
      if (this.carrying) this.place();
      else if (this.current) this.current.interact();
    } else if (input.wasPressed('KeyF') && this.current?.secondaryPrompt?.()) this.current.secondary?.();
    else if (input.wasPressed('KeyG') && this.carrying) this.drop();
  }

  pickUp(p: Pickup): void {
    if (this.carrying) return;
    this.carrying = p;
    p.carried = true;
    p.falling = false;
    p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    p.collider.setSensor(true);
    setHighlight(p.highlight, false);
    this.current = null;
    this.svc.audio.play('pickup');
    this.updateCarry(true);
  }

  private updateCarry(teleport = false): void {
    const p = this.carrying!;
    const origin = this.camera.position;
    this.camera.getWorldDirection(this.camDir);
    let dist = 1.15 + p.half.z;
    const hit = this.svc.physics.raycast(origin, this.camDir, dist + 0.4, [this.svc.player.collider, p.collider], false);
    if (hit) dist = Math.max(0.55, hit.distance - Math.max(p.half.x, p.half.z) - 0.05);
    this.holdPos.copy(origin).addScaledVector(this.camDir, dist);
    this.holdPos.y -= 0.18;
    this.holdQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.svc.player.yaw);
    const t = { x: this.holdPos.x, y: this.holdPos.y, z: this.holdPos.z };
    const q = { x: this.holdQuat.x, y: this.holdQuat.y, z: this.holdQuat.z, w: this.holdQuat.w };
    if (teleport) {
      p.body.setTranslation(t, true);
      p.body.setRotation(q, true);
    } else {
      p.body.setNextKinematicTranslation(t);
      p.body.setNextKinematicRotation(q);
    }
    p.mesh.position.copy(this.holdPos);
    p.mesh.quaternion.copy(this.holdQuat);
  }

  /** Puts the carried item on the surface you're looking at; drops it if there isn't one. */
  place(): boolean {
    const p = this.carrying;
    if (!p) return false;
    this.camera.getWorldDirection(this.camDir);
    const hit = this.svc.physics.raycast(this.camera.position, this.camDir, REACH, [this.svc.player.collider, p.collider], false);
    if (!hit || hit.normal.y < 0.6) {
      this.svc.ui.toast('Aim at a floor or table to set it down (G drops it).', 'warn');
      this.svc.audio.play('denied');
      return false;
    }
    const pos = { x: hit.point.x, y: hit.point.y + p.half.y + 0.01, z: hit.point.z };
    this.release();
    p.body.setTranslation(pos, true);
    p.body.setRotation({ x: this.holdQuat.x, y: this.holdQuat.y, z: this.holdQuat.z, w: this.holdQuat.w }, true);
    p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    p.syncMesh();
    this.svc.audio.play('place', p.mesh.position);
    this.svc.bus.emit('objective:signal', { id: 'placeItem' });
    return true;
  }

  drop(): void {
    const p = this.carrying;
    if (!p) return;
    this.release();
    this.camera.getWorldDirection(this.camDir);
    const v = this.svc.player.velocity;
    p.body.setLinvel({ x: this.camDir.x * 2.2 + v.x * 0.6, y: this.camDir.y * 2.2 + 0.5, z: this.camDir.z * 2.2 + v.z * 0.6 }, true);
    p.falling = true;
    this.svc.bus.emit('objective:signal', { id: 'placeItem' });
  }

  private release(): void {
    const p = this.carrying!;
    p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    p.collider.setSensor(false);
    p.carried = false;
    this.carrying = null;
  }
}
