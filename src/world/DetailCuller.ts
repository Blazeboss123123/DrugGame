import * as THREE from 'three';

/** Layer the camera never renders. Used instead of `visible` so game code that toggles visibility is untouched. */
const FAR_LAYER = 30;

/**
 * Small meshes (furniture, casino fittings, shelves, signs, mailboxes) each cost a draw call and a
 * place in the shadow pass even when they're 300 m away and smaller than a pixel. Twice a second this
 * drops any mesh whose size makes it invisible at its distance, and brings it back as you approach.
 * Big meshes (buildings, roads, terrain) are never touched.
 */
export class DetailCuller {
  private timer = 0;
  hidden = 0;

  constructor(private scene: THREE.Scene) {}

  private meshes: THREE.Mesh[] = [];
  private listTimer = 0;
  private center = new THREE.Vector3();

  /** Re-collects candidate meshes (things get built, bought and placed during play). */
  private collect() {
    const out: THREE.Mesh[] = [];
    const visit = (o: THREE.Object3D) => {
      if ((o as THREE.Camera).isCamera || o.userData.noCull) return;
      const m = o as THREE.Mesh;
      // frustumCulled = false marks meshes positioned in the shader (grass, sky): leave those alone.
      if (m.isMesh && m.frustumCulled && !(m as THREE.InstancedMesh).isInstancedMesh && !(m as THREE.SkinnedMesh).isSkinnedMesh && m.geometry) {
        if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
        out.push(m);
      }
      for (const c of o.children) visit(c);
    };
    visit(this.scene);
    // Anything collected earlier but no longer in the list goes back to normal.
    const keep = new Set(out);
    for (const m of this.meshes) if (!keep.has(m) && !m.layers.isEnabled(0)) m.layers.set(0);
    this.meshes = out;
  }

  update(dt: number, cam: THREE.Vector3) {
    this.listTimer -= dt;
    if (this.listTimer <= 0) {
      this.listTimer = 2;
      this.collect();
    }
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    let hidden = 0;
    for (const m of this.meshes) {
      const e = m.matrixWorld.elements;
      // Skip anything not yet placed (no world matrix computed): it can't be judged yet.
      if (e[15] !== 1) continue;
      const bs = m.geometry.boundingSphere!;
      this.center.copy(bs.center).applyMatrix4(m.matrixWorld);
      const r = bs.radius * Math.sqrt(Math.max(e[0] * e[0] + e[1] * e[1] + e[2] * e[2], e[4] * e[4] + e[5] * e[5] + e[6] * e[6], e[8] * e[8] + e[9] * e[9] + e[10] * e[10]));
      const show = r >= 4 || this.center.distanceTo(cam) - r < 30 + r * 60;
      const want = show ? 0 : FAR_LAYER;
      if (!m.layers.isEnabled(want)) m.layers.set(want);
      if (!show) hidden++;
    }
    this.hidden = hidden;
  }
}
