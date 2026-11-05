import * as THREE from 'three';
import { fbm, lerp, smoothstep } from '../core/math';
import { RAPIER, type Physics } from '../physics/Physics';
import { districtAt, riverCarve, type District } from './CityPlan';
import type { Heightmap } from './Heightmap';
import { noiseTexture } from './Textures';

const GROUND: Record<District, number> = {
  residential: 0x56703a,
  downtown: 0x77746d,
  commercial: 0x627245,
  industrial: 0x6f675a,
  outskirts: 0x51703a,
};

/** Builds the visible terrain mesh (vertex-coloured by district, slope and noise) and its heightfield collider. */
export function buildTerrain(hm: Heightmap, physics: Physics, parks: { x0: number; z0: number; x1: number; z1: number }[]): THREE.Mesh {
  const V = hm.verts;
  const pos = new Float32Array(V * V * 3);
  const uv = new Float32Array(V * V * 2);
  const col = new Float32Array(V * V * 3);
  const dirt = new THREE.Color(0x6b5640);
  const rock = new THREE.Color(0x77736b);
  const mud = new THREE.Color(0x6e6248);
  const forest = new THREE.Color(0x3f5a2c);
  const park = new THREE.Color(0x4f7434);
  const c = new THREE.Color();
  const tmp = new THREE.Color();

  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const k = j * V + i;
      const x = hm.xAt(i);
      const z = hm.xAt(j);
      const y = hm.data[k];
      pos[k * 3] = x;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = z;
      uv[k * 2] = x / 6;
      uv[k * 2 + 1] = z / 6;
      // Jitter the district boundary so colour changes are organic.
      const jx = x + fbm(x / 30, z / 30, 2, 41) * 18;
      const jz = z + fbm(x / 30 + 5, z / 30, 2, 43) * 18;
      const d = districtAt(jx, jz);
      c.setHex(GROUND[d]);
      if (d === 'outskirts') c.lerp(forest, smoothstep(-0.2, 0.5, fbm(x / 60, z / 60, 3, 50)));
      if (parks.some((p) => x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1)) c.copy(park);
      const flat = hm.flatness(x, z);
      c.lerp(dirt, smoothstep(0.93, 0.8, flat));
      c.lerp(rock, smoothstep(0.78, 0.6, flat));
      c.lerp(mud, smoothstep(0.1, 0.5, riverCarve(x, z)));
      const n = fbm(x / 9, z / 9, 3, 61) * 0.5 + 0.5;
      tmp.copy(c).multiplyScalar(lerp(0.82, 1.12, n));
      col[k * 3] = tmp.r;
      col[k * 3 + 1] = tmp.g;
      col[k * 3 + 2] = tmp.b;
    }
  }
  const idx = new Uint32Array(hm.n * hm.n * 6);
  let p = 0;
  for (let j = 0; j < hm.n; j++)
    for (let i = 0; i < hm.n; i++) {
      const a = j * V + i;
      const b = a + 1;
      const cc = a + V;
      const e = cc + 1;
      idx[p++] = a;
      idx[p++] = cc;
      idx[p++] = b;
      idx[p++] = b;
      idx[p++] = cc;
      idx[p++] = e;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();

  const detail = noiseTexture(31, '#d8d8d8', '#ffffff', '#6a6a6a', 26000, 2.5);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.96, metalness: 0 });
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';

  // Rapier heightfield: rows run along Z, columns along X, data in column-major order.
  const heights = new Float32Array(V * V);
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) heights[i * V + j] = hm.data[j * V + i];
  const desc = RAPIER.ColliderDesc.heightfield(hm.n, hm.n, heights, { x: hm.half * 2, y: 1, z: hm.half * 2 }).setFriction(0.9);
  const col2 = physics.world.createCollider(desc);
  physics.tag(col2, { terrain: true, surface: 'grass' });
  return mesh;
}
