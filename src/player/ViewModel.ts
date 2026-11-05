import * as THREE from 'three';
import type { Stack } from '../inventory/Inventory';
import { ITEMS, type VariantRegistry } from '../products/Catalog';
import { stackColor } from '../ui/Icons';

/** The item in your hand, drawn in the lower right of the first-person view. */
export class ViewModel {
  readonly group = new THREE.Group();
  private current = '';
  private holder = new THREE.Group();
  private t = 0;
  private jab = 0;

  constructor(camera: THREE.Camera) {
    this.group.position.set(0.3, -0.27, -0.55);
    this.group.add(this.holder);
    camera.add(this.group);
  }

  set(stack: Stack | null, variants: VariantRegistry) {
    const key = stack ? `${stack.id}|${stack.v ?? ''}` : '';
    if (key === this.current) return;
    this.current = key;
    this.holder.clear();
    if (!stack) return;
    const def = ITEMS[stack.id];
    const col = new THREE.Color(stackColor(stack, variants));
    const m = (c: THREE.ColorRepresentation, o: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, ...o });
    const add = (g: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(x, y, z);
      this.holder.add(mesh);
      return mesh;
    };
    const v = variants.byKey(stack.v);
    const shape = v && def.kind === 'product' ? (v.family === 'nightshade' ? 'leaf' : v.family === 'dreamdust' ? 'powder' : 'tablet') : def.shape;
    switch (shape) {
      case 'can': {
        add(new THREE.CylinderGeometry(0.07, 0.08, 0.14, 14), m(col, { metalness: 0.4 }));
        const spout = add(new THREE.CylinderGeometry(0.012, 0.018, 0.18, 8), m(col, { metalness: 0.4 }), -0.1, 0.04, 0);
        spout.rotation.z = Math.PI / 3;
        const handle = add(new THREE.TorusGeometry(0.05, 0.01, 6, 14, Math.PI), m(col), 0.02, 0.07, 0);
        handle.rotation.y = Math.PI / 2;
        break;
      }
      case 'bag':
        add(new THREE.BoxGeometry(0.16, 0.2, 0.08), m(col, { roughness: 0.9 }));
        break;
      case 'seed':
        add(new THREE.BoxGeometry(0.09, 0.13, 0.01), m(0xefe6d2));
        add(new THREE.SphereGeometry(0.025, 10, 8), m(col), 0, 0, 0.008);
        break;
      case 'bottle':
        add(new THREE.CylinderGeometry(0.035, 0.04, 0.13, 12), m(col, { roughness: 0.3, transparent: true, opacity: 0.85 }));
        add(new THREE.CylinderGeometry(0.015, 0.015, 0.04, 8), m(0x222222), 0, 0.085, 0);
        break;
      case 'baggie':
        add(new THREE.BoxGeometry(0.09, 0.11, 0.015), m(0xe8f0f2, { transparent: true, opacity: 0.55, roughness: 0.2 }));
        if (v) add(new THREE.SphereGeometry(0.03, 8, 6), m(col), 0, -0.015, 0);
        break;
      case 'jar':
        add(new THREE.CylinderGeometry(0.05, 0.05, 0.11, 14), m(0xcfe3ea, { transparent: true, opacity: 0.45, roughness: 0.1 }));
        if (v) add(new THREE.CylinderGeometry(0.043, 0.043, 0.07, 12), m(col), 0, -0.015, 0);
        add(new THREE.CylinderGeometry(0.053, 0.053, 0.025, 14), m(0xc23a2a), 0, 0.065, 0);
        break;
      case 'leaf':
        for (const [x, y] of [
          [0, 0],
          [0.04, 0.02],
          [-0.03, 0.03],
        ])
          add(new THREE.IcosahedronGeometry(0.035, 0), m(col, { flatShading: true }), x, y, 0);
        break;
      case 'powder':
        add(new THREE.BoxGeometry(0.12, 0.04, 0.07), m(col, { roughness: 0.95 }));
        break;
      case 'tablet':
        for (const x of [-0.03, 0, 0.03]) add(new THREE.CylinderGeometry(0.018, 0.018, 0.008, 12), m(col, { emissive: col, emissiveIntensity: 0.3 }), x, 0, 0);
        break;
      case 'board': {
        const b = add(new THREE.BoxGeometry(0.08, 0.02, 0.4), m(col));
        b.rotation.x = 1.1;
        break;
      }
      case 'crystal':
        add(new THREE.OctahedronGeometry(0.05, 0), m(col, { roughness: 0.2, metalness: 0.1 }));
        break;
      default:
        add(new THREE.BoxGeometry(0.1, 0.1, 0.1), m(col));
    }
    this.holder.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        // Draw on top of the world so the held item never clips into walls.
        (mesh.material as THREE.Material).depthTest = false;
        mesh.renderOrder = 10;
      }
    });
  }

  /** Forward jab, as if handing something over. */
  punch() {
    this.jab = 1;
  }

  update(dt: number, moving: boolean) {
    this.t += dt * (moving ? 9 : 2);
    this.jab = Math.max(0, this.jab - dt * 2.5);
    const j = Math.sin(this.jab * Math.PI);
    this.holder.position.y = Math.sin(this.t) * (moving ? 0.008 : 0.003) + j * 0.06;
    this.holder.position.x = Math.cos(this.t * 0.5) * (moving ? 0.006 : 0.002) - j * 0.12;
    this.holder.position.z = -j * 0.22;
  }
}
