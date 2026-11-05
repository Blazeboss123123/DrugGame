import * as THREE from 'three';
import type { Input } from '../core/Input';
import type { Services } from '../core/Services';
import { ITEMS } from '../products/Catalog';
import { FOOTPRINT, PLACEABLE, type Site } from './Production';

/**
 * Placing equipment: hold a piece of equipment in your hotbar, aim at the floor of a property you
 * own, rotate with R and press E. A green ghost shows where it will go (red when it can't).
 */
export class Placement {
  private ghost: THREE.Mesh;
  private arrow: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private yaw = 0;
  active = false;
  private dir = new THREE.Vector3();

  constructor(
    private svc: Services,
    private camera: THREE.PerspectiveCamera,
  ) {
    this.mat = new THREE.MeshBasicMaterial({ color: 0x3ddc84, transparent: true, opacity: 0.35, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.mat);
    this.arrow = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 3).rotateX(Math.PI / 2), this.mat);
    this.ghost.add(this.arrow);
    this.ghost.visible = false;
    this.ghost.renderOrder = 6;
    svc.scene.add(this.ghost);
  }

  /** The placeable equipment kind in the selected hotbar slot, if any. */
  heldKind(): string | null {
    const held = this.svc.held();
    return held && ITEMS[held.id]?.kind === 'equipment' && PLACEABLE.includes(held.id) ? held.id : null;
  }

  /** Returns true while placement mode owns the E key and the prompt. */
  update(input: Input, playing: boolean): boolean {
    const kind = this.heldKind();
    this.active = !!kind && playing && !this.svc.vehicles.driving;
    if (!this.active || !kind) {
      this.ghost.visible = false;
      return false;
    }
    if (input.wasPressed('KeyR') || input.wasPressed('KeyQ')) this.yaw = (this.yaw + Math.PI / 2) % (Math.PI * 2);
    this.camera.getWorldDirection(this.dir);
    const hit = this.svc.physics.raycast(this.camera.position, this.dir, 6, [this.svc.player.collider], false);
    const siteId = hit && hit.normal.y > 0.7 ? this.siteAt(hit.point) : null;
    const site = siteId ? this.svc.production.sites.get(siteId) : undefined;
    const [hx, hz] = FOOTPRINT[kind];
    this.ghost.scale.set(hx * 2, kind === 'lamp' ? 1.9 : 0.9, hz * 2);
    (this.arrow.scale as THREE.Vector3).set(1 / (hx * 2), 1 / 0.9, 1 / (hz * 2));
    this.arrow.position.set(0, 0.55, 0.55);
    if (!hit || !site) {
      this.ghost.visible = !!hit;
      if (hit) this.ghost.position.set(hit.point.x, hit.point.y + this.ghost.scale.y / 2, hit.point.z);
      this.mat.color.setHex(0xff4a3a);
      this.svc.ui.hud.setPrompt(hit ? 'Equipment goes inside a property you own' : `Aim at the floor to place the ${ITEMS[kind].name.toLowerCase()}`, [['R', 'Rotate']]);
      return true;
    }
    const o = site.origin;
    const lx = Math.round((hit.point.x - o.x) * 10) / 10;
    const lz = Math.round((hit.point.z - o.z) * 10) / 10;
    const reason = site.canPlace(kind, lx, lz, this.yaw);
    this.ghost.visible = true;
    this.ghost.position.set(o.x + lx, o.y + this.ghost.scale.y / 2 + 0.01, o.z + lz);
    this.ghost.rotation.y = this.yaw;
    this.mat.color.setHex(reason ? 0xff4a3a : 0x3ddc84);
    this.svc.ui.hud.setPrompt(reason ?? `Place ${ITEMS[kind].name}`, reason ? [['R', 'Rotate']] : [['E', 'Place'], ['R', 'Rotate']]);
    if (input.wasPressed('KeyE')) {
      if (reason) {
        this.svc.audio.play('denied');
        return true;
      }
      if (!this.svc.inventory.remove(kind, 1)) return true;
      site.place(kind, lx, lz, this.yaw);
      this.svc.audio.play('place', this.ghost.position);
    }
    return true;
  }

  private siteAt(p: { x: number; y: number; z: number }): string | null {
    const v = new THREE.Vector3(p.x, p.y + 0.5, p.z);
    for (const [id, site] of this.svc.production.sites) {
      if (!this.svc.properties.owns(id)) continue;
      const o = site.origin;
      if (Math.abs(v.y - o.y) > 1.5) continue;
      const lx = v.x - o.x;
      const lz = v.z - o.z;
      if ((site.layout.zones ?? []).some((z: Site['layout']['zones'] extends (infer T)[] | undefined ? T : never) => lx > z.x0 - 1 && lx < z.x1 + 1 && lz > z.z0 - 1 && lz < z.z1 + 1)) return id;
    }
    return null;
  }
}
