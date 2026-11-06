import * as THREE from 'three';

/** Layer the renderer never draws: point lights parked here still hold their settings but cost nothing. */
const PARKED = 31;

/**
 * Real-time point lights are expensive: every lit surface in view pays for every light, every pixel.
 * The world has dozens (casino uplights, chandeliers, shop strips, house lamps), so instead each one
 * becomes a "virtual" light that keeps its colour, intensity, range and on/off state exactly as the
 * game sets them, and a small fixed pool of real lights is handed to whichever are nearest the camera.
 * The light count never changes, so shaders never recompile while you move around.
 */
export class LightPool {
  private real: THREE.PointLight[] = [];
  private slots: (THREE.PointLight | null)[] = [];
  private fade: number[] = [];
  private virtual = new Set<THREE.PointLight>();
  private scanTimer = 0;
  private tmp = new THREE.Vector3();
  private picks: { l: THREE.PointLight; d: number }[] = [];

  constructor(
    private scene: THREE.Scene,
    size: number,
  ) {
    this.resize(size);
  }

  /** Changes how many real lights there are (graphics setting). */
  resize(size: number) {
    while (this.real.length > size) {
      const l = this.real.pop()!;
      this.scene.remove(l);
      this.slots.pop();
      this.fade.pop();
    }
    while (this.real.length < size) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.name = 'light-pool';
      this.scene.add(l);
      this.real.push(l);
      this.slots.push(null);
      this.fade.push(0);
    }
  }

  /** Finds point lights the game has added (rooms, buildings, equipment) and parks them. */
  private scan() {
    this.scene.traverse((o) => {
      const l = o as THREE.PointLight;
      if (!l.isPointLight || l.name === 'light-pool' || this.virtual.has(l)) return;
      this.virtual.add(l);
      l.layers.set(PARKED);
    });
    for (const l of this.virtual) if (!l.parent) this.virtual.delete(l);
  }

  /** On, bright, and actually in the scene (no hidden parent). */
  private live(l: THREE.PointLight) {
    if (l.intensity <= 0.001) return false;
    for (let o: THREE.Object3D | null = l; o; o = o.parent) {
      if (!o.visible) return false;
      if (o === this.scene) return true;
    }
    return false;
  }

  update(dt: number, cam: THREE.Vector3) {
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scanTimer = 1;
      this.scan();
    }
    // Nearest live lights, weighting bigger lights as if they were a little closer.
    const picks = this.picks;
    picks.length = 0;
    for (const l of this.virtual) {
      if (!this.live(l)) continue;
      l.getWorldPosition(this.tmp);
      const d = this.tmp.distanceTo(cam) - (l.distance || 20) * 0.5;
      picks.push({ l, d });
    }
    picks.sort((a, b) => a.d - b.d);
    const want = new Set(picks.slice(0, this.real.length).map((p) => p.l));
    // Keep lights in the slot they already have, so nothing flickers when the order shuffles.
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i] && !want.has(this.slots[i]!)) this.slots[i] = null;
    for (const l of want) {
      if (this.slots.includes(l)) continue;
      const free = this.slots.indexOf(null);
      if (free < 0) break;
      this.slots[free] = l;
      this.fade[free] = 0;
    }
    for (let i = 0; i < this.real.length; i++) {
      const r = this.real[i];
      const v = this.slots[i];
      if (!v) {
        r.intensity = 0;
        continue;
      }
      this.fade[i] = Math.min(1, this.fade[i] + dt * 4);
      v.getWorldPosition(r.position);
      r.color.copy(v.color);
      r.intensity = v.intensity * this.fade[i];
      r.distance = v.distance;
      r.decay = v.decay;
    }
  }
}
