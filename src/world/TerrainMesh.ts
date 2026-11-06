import * as THREE from 'three';
import { fbm, smoothstep } from '../core/math';
import { RAPIER, type Physics } from '../physics/Physics';
import { districtAt, riverCarve, type District } from './CityPlan';
import type { Heightmap } from './Heightmap';
import type { SurfaceSet } from './Surfaces';

/** Per-district tint for the blended ground (multiplies the HD textures). */
const TINT: Record<District, [number, number, number]> = {
  residential: [1.0, 1.0, 1.0],
  downtown: [0.82, 0.84, 0.84],
  commercial: [0.97, 1.0, 0.95],
  industrial: [0.9, 0.88, 0.84],
  outskirts: [0.86, 0.95, 0.82],
};

/** Linear multiplier applied to the grass texture (shared with the grass blades so they match). */
export const GRASS_TINT = new THREE.Color(0.44, 0.52, 0.35);

export interface TerrainResult {
  /** Terrain split into tiles so the parts outside the view aren't drawn. */
  mesh: THREE.Group;
  /** Normalised grass weight per heightmap vertex (0..1), used to place grass blades. */
  grass: Float32Array;
}

/**
 * The visible terrain: an HD splat-blended surface (grass, dirt, rock, river mud) driven by slope,
 * district and noise, with normal maps, height-aware blending and anti-tiling; plus its heightfield collider.
 */
export function buildTerrain(hm: Heightmap, physics: Physics, parks: { x0: number; z0: number; x1: number; z1: number }[], surf: SurfaceSet): TerrainResult {
  const V = hm.verts;
  const pos = new Float32Array(V * V * 3);
  const splat = new Float32Array(V * V * 4);
  const tint = new Float32Array(V * V * 3);
  const grass = new Float32Array(V * V);

  for (let j = 0; j < V; j++) {
    for (let i = 0; i < V; i++) {
      const k = j * V + i;
      const x = hm.xAt(i);
      const z = hm.xAt(j);
      pos[k * 3] = x;
      pos[k * 3 + 1] = hm.data[k];
      pos[k * 3 + 2] = z;
      // Jitter the district boundary so changes are organic.
      const jx = x + fbm(x / 30, z / 30, 2, 41) * 18;
      const jz = z + fbm(x / 30 + 5, z / 30, 2, 43) * 18;
      const d = districtAt(jx, jz);
      const park = parks.some((p) => x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1);
      const flat = hm.flatness(x, z);
      const patches = fbm(x / 22, z / 22, 3, 57) * 0.5 + 0.5;
      let wg = 1;
      let wd = smoothstep(0.95, 0.82, flat) * 0.9;
      const wr = smoothstep(0.84, 0.66, flat) * 1.4;
      const wm = smoothstep(0.15, 0.55, riverCarve(x, z)) * 1.2;
      if (!park) {
        if (d === 'downtown') wd += 1.6;
        else if (d === 'industrial') wd += 0.9 + patches * 0.6;
        else if (d === 'outskirts') wd += smoothstep(0.62, 0.85, patches) * 0.8; // bare patches in the woods
        else wd += smoothstep(0.75, 0.95, patches) * 0.35; // worn spots
      }
      wg = Math.max(0, wg - wr * 0.6 - wm * 0.8);
      const sum = wg + wd + wr + wm || 1;
      splat.set([wg / sum, wd / sum, wr / sum, wm / sum], k * 4);
      grass[k] = wg / sum;
      const t = TINT[park ? 'residential' : d];
      tint.set(t, k * 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('splat', new THREE.BufferAttribute(splat, 4));
  g.setAttribute('tint', new THREE.BufferAttribute(tint, 3));
  // Normals over the whole surface first (so tile edges match), then one index buffer per tile.
  const all = new Uint32Array(hm.n * hm.n * 6);
  let q = 0;
  for (let j = 0; j < hm.n; j++)
    for (let i = 0; i < hm.n; i++) {
      const a = j * V + i;
      all[q++] = a;
      all[q++] = a + V;
      all[q++] = a + 1;
      all[q++] = a + 1;
      all[q++] = a + V;
      all[q++] = a + V + 1;
    }
  g.setIndex(new THREE.BufferAttribute(all, 1));
  g.computeVertexNormals();

  // Tiles share the vertex buffers (uploaded once); each has its own index range and bounds,
  // so the renderer can skip the ones behind the camera or outside the view.
  const mesh = new THREE.Group();
  mesh.name = 'terrain';
  const material = terrainMaterial(surf);
  const T = 8;
  const step = Math.ceil(hm.n / T);
  const attrs = g.attributes;
  for (let tj = 0; tj < T; tj++)
    for (let ti = 0; ti < T; ti++) {
      const j0 = tj * step;
      const i0 = ti * step;
      const j1 = Math.min(hm.n, j0 + step);
      const i1 = Math.min(hm.n, i0 + step);
      if (j1 <= j0 || i1 <= i0) continue;
      const idx = new Uint32Array((j1 - j0) * (i1 - i0) * 6);
      let p = 0;
      const box = new THREE.Box3();
      const v = new THREE.Vector3();
      for (let j = j0; j < j1; j++)
        for (let i = i0; i < i1; i++) {
          const a = j * V + i;
          idx[p++] = a;
          idx[p++] = a + V;
          idx[p++] = a + 1;
          idx[p++] = a + 1;
          idx[p++] = a + V;
          idx[p++] = a + V + 1;
        }
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const a = j * V + i;
          box.expandByPoint(v.set(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]));
        }
      const tg = new THREE.BufferGeometry();
      for (const name of Object.keys(attrs)) tg.setAttribute(name, attrs[name]);
      tg.setIndex(new THREE.BufferAttribute(idx, 1));
      tg.boundingBox = box;
      tg.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const tile = new THREE.Mesh(tg, material);
      tile.receiveShadow = true;
      tile.name = 'terrain-tile';
      mesh.add(tile);
    }

  // Rapier heightfield: rows run along Z, columns along X, data in column-major order.
  const heights = new Float32Array(V * V);
  for (let i = 0; i < V; i++) for (let j = 0; j < V; j++) heights[i * V + j] = hm.data[j * V + i];
  const desc = RAPIER.ColliderDesc.heightfield(hm.n, hm.n, heights, { x: hm.half * 2, y: 1, z: hm.half * 2 }).setFriction(0.9);
  const col2 = physics.world.createCollider(desc);
  physics.tag(col2, { terrain: true, surface: 'grass' });
  return { mesh, grass };
}

/** GLSL shared by the terrain: world-space sampling with anti-tiling and world-aligned normal mapping. */
const COMMON = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWN;
uniform sampler2D tMacro;
// Two samples per layer (different scale and rotation), mixed by large-scale noise: hides tiling.
const mat2 ROT = mat2(0.8090, 0.5878, -0.5878, 0.8090);
vec3 rotN(vec3 n) { return vec3(ROT * n.xy, n.z); }
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

export function terrainMaterial(surf: SurfaceSet): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  const uniforms = {
    tGrass: { value: surf.grass },
    tGrassN: { value: surf.grassN },
    tDirt: { value: surf.dirt },
    tDirtN: { value: surf.dirtN },
    tRock: { value: surf.rock },
    tRockN: { value: surf.rockN },
    tMacro: { value: surf.macro },
    uGrassTint: { value: GRASS_TINT },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 splat;
        attribute vec3 tint;
        varying vec4 vSplat;
        varying vec3 vTint;
        varying vec3 vWPos;
        varying vec3 vWN;`,
      )
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n vWN = normalize(mat3(modelMatrix) * objectNormal);')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vSplat = splat; vTint = tint;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec4 vSplat;
        varying vec3 vTint;
        uniform sampler2D tGrass, tGrassN, tDirt, tDirtN, tRock, tRockN;
        uniform vec3 uGrassTint;
        ${COMMON}`,
      )
      .replace(
        '#include <map_fragment>',
        `
        vec2 wp = vWPos.xz;
        vec3 mac = texture2D(tMacro, wp / 260.0).rgb;
        vec3 mac2 = texture2D(tMacro, wp / 61.0).rgb;
        float am = smoothstep(0.32, 0.68, mac2.g);
        vec2 uG = wp / 2.6, uG2 = ROT * wp / 6.7;
        vec2 uD = wp / 3.4, uD2 = ROT * wp / 8.3;
        vec2 uR = wp / 5.5, uR2 = ROT * wp / 13.0;
        vec3 cg = mix(texture2D(tGrass, uG).rgb, texture2D(tGrass, uG2).rgb, am);
        vec3 cd = mix(texture2D(tDirt, uD).rgb, texture2D(tDirt, uD2).rgb, am);
        vec3 cr = mix(texture2D(tRock, uR).rgb, texture2D(tRock, uR2).rgb, am);
        // Grass: natural tint, big soft light/dark meadow patches and drier yellow areas.
        cg *= uGrassTint * mix(0.72, 1.2, mac.r) * mix(0.9, 1.1, mac2.b);
        cg = mix(cg, cg * vec3(1.25, 1.08, 0.62), smoothstep(0.58, 0.82, mac.g) * 0.55);
        cd *= mix(0.85, 1.12, mac.b);
        vec3 cm = cd * vec3(0.5, 0.47, 0.42);
        // Height-aware blend: pebbles and grass tufts poke through the transition, no smeary edges.
        vec4 hgt = vec4(lum(cg) * 2.2, lum(cd) * 1.4, lum(cr) * 1.2, lum(cd) * 0.8);
        vec4 hw = vSplat * (0.35 + hgt);
        float hmax = max(max(hw.x, hw.y), max(hw.z, hw.w));
        hw = max(hw - hmax + 0.16, 0.0);
        hw /= max(dot(hw, vec4(1.0)), 1e-4);
        vec3 albedo = cg * hw.x + cd * hw.y + cr * hw.z + cm * hw.w;
        diffuseColor.rgb *= albedo * vTint;
        `,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = dot(hw, vec4(0.97, 0.92, 0.82, 0.5));')
      .replace(
        '#include <normal_fragment_maps>',
        `
        vec3 ng = mix(texture2D(tGrassN, uG).xyz * 2.0 - 1.0, rotN(texture2D(tGrassN, uG2).xyz * 2.0 - 1.0), am);
        vec3 nd = mix(texture2D(tDirtN, uD).xyz * 2.0 - 1.0, rotN(texture2D(tDirtN, uD2).xyz * 2.0 - 1.0), am);
        vec3 nr = mix(texture2D(tRockN, uR).xyz * 2.0 - 1.0, rotN(texture2D(tRockN, uR2).xyz * 2.0 - 1.0), am);
        vec3 nts = normalize(ng * hw.x + nd * (hw.y + hw.w * 0.6) + nr * hw.z * 1.3 + vec3(0.0, 0.0, 0.25));
        vec3 Nw = normalize(vWN);
        vec3 Tw = normalize(vec3(1.0, 0.0, 0.0) - Nw * Nw.x);
        vec3 Bw = cross(Tw, Nw);
        vec3 nW = normalize(Tw * nts.x + Bw * nts.y + Nw * nts.z);
        normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        `,
      );
  };
  mat.customProgramCacheKey = () => 'terrain-v2';
  return mat;
}
