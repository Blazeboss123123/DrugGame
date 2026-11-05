import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Loads the Quaternius Downtown City MegaKit (CC0) models shipped in assets/megakit and turns
 * repeated placements into instanced meshes (one draw call per sub-mesh, however many copies).
 */

export const KIT_BUILDINGS = ['Building_Large_2', 'Building_Medium_2_001', 'Building_Small_1'] as const;
export const KIT_PROPS = ['Prop_Bollard', 'Prop_ManholeCover', 'Prop_ACUnit', 'Prop_Planter_Single'] as const;
export type KitName = (typeof KIT_BUILDINGS)[number] | (typeof KIT_PROPS)[number];

export interface KitModel {
  name: KitName;
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material; local: THREE.Matrix4 }[];
  box: THREE.Box3;
}

export class KitAssets {
  readonly models = new Map<KitName, KitModel>();
  readonly nightMaterials: THREE.MeshStandardMaterial[] = [];
  failed: string[] = [];

  constructor(private base = './assets/megakit/') {}

  async load(timeoutMs = 25000): Promise<void> {
    const loader = new GLTFLoader();
    const names = [...KIT_BUILDINGS, ...KIT_PROPS];
    const one = (n: KitName) =>
      new Promise<void>((resolve) => {
        loader.load(
          `${this.base}${n}.json`,
          (g: { scene: THREE.Object3D }) => {
            g.scene.updateMatrixWorld(true);
            const parts: KitModel['parts'] = [];
            g.scene.traverse((o: THREE.Object3D) => {
              const m = o as THREE.Mesh;
              if (!m.isMesh) return;
              const mat = m.material as THREE.MeshStandardMaterial;
              if (/FakeInterior/i.test(mat.name) && mat.map) {
                mat.emissiveMap = mat.map;
                mat.emissive = new THREE.Color(0xffffff);
                mat.emissiveIntensity = 0;
                this.nightMaterials.push(mat);
              }
              if (/Glass/i.test(mat.name)) {
                mat.transparent = true;
                mat.opacity = Math.min(mat.opacity, 0.45);
                mat.depthWrite = false;
              }
              parts.push({ geometry: m.geometry, material: mat, local: m.matrixWorld.clone() });
            });
            const box = new THREE.Box3().setFromObject(g.scene);
            this.models.set(n, { name: n, parts, box });
            resolve();
          },
          undefined,
          () => {
            this.failed.push(n);
            resolve();
          },
        );
      });
    await Promise.race([Promise.all(names.map(one)), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  get ready() {
    return KIT_BUILDINGS.every((n) => this.models.has(n));
  }

  /** Builds one InstancedMesh per sub-mesh for all placements of a model. */
  instance(name: KitName, placements: THREE.Matrix4[], shadows = true): THREE.Group {
    const g = new THREE.Group();
    const model = this.models.get(name);
    if (!model || !placements.length) return g;
    const m = new THREE.Matrix4();
    for (const part of model.parts) {
      const im = new THREE.InstancedMesh(part.geometry, part.material, placements.length);
      placements.forEach((p, i) => im.setMatrixAt(i, m.multiplyMatrices(p, part.local)));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = shadows;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      g.add(im);
    }
    return g;
  }
}
