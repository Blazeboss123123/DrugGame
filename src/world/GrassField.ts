import * as THREE from 'three';
import { Rng } from '../core/math';
import type { CityContent } from './CityGenerator';
import { ROAD, districtAt, onRoadCorridor, riverCarve } from './CityPlan';
import type { Heightmap, Pad } from './Heightmap';
import type { SurfaceSet } from './Surfaces';
import { GRASS_TINT } from './TerrainMesh';

type Rect = { x0: number; z0: number; x1: number; z1: number };

/**
 * Where grass grows, one texel per metre: the terrain's grass weight, minus roads, pavements, building
 * plots, parking, the plaza, the river and downtown. Built once on the CPU, sampled by the GPU.
 */
export function buildGrassMask(hm: Heightmap, grassWeight: Float32Array, content: CityContent, extra: (Rect | Pad)[]): { data: Uint8Array; size: number } {
  const size = hm.half * 2;
  const data = new Uint8Array(size * size);
  const V = hm.verts;
  for (let iz = 0; iz < size; iz++) {
    const z = -hm.half + iz + 0.5;
    const fz = (z + hm.half) / hm.step;
    const j = Math.min(V - 2, Math.floor(fz));
    const tz = fz - j;
    for (let ix = 0; ix < size; ix++) {
      const x = -hm.half + ix + 0.5;
      const fx = (x + hm.half) / hm.step;
      const i = Math.min(V - 2, Math.floor(fx));
      const tx = fx - i;
      const w =
        (grassWeight[j * V + i] * (1 - tx) + grassWeight[j * V + i + 1] * tx) * (1 - tz) +
        (grassWeight[(j + 1) * V + i] * (1 - tx) + grassWeight[(j + 1) * V + i + 1] * tx) * tz;
      let v = Math.max(0, Math.min(1, (w - 0.35) / 0.55));
      if (v > 0 && (onRoadCorridor(x, z, ROAD.sidewalkHalf + 0.5) || riverCarve(x, z) > 0.3)) v = 0;
      if (v > 0 && districtAt(x, z) === 'downtown') v = 0;
      data[iz * size + ix] = Math.round(v * 255);
    }
  }
  const parks = content.parks;
  const clear = (r: Rect, pad = 0) => {
    const x0 = Math.max(0, Math.floor(r.x0 - pad + hm.half));
    const x1 = Math.min(size - 1, Math.ceil(r.x1 + pad + hm.half));
    const z0 = Math.max(0, Math.floor(r.z0 - pad + hm.half));
    const z1 = Math.min(size - 1, Math.ceil(r.z1 + pad + hm.half));
    for (let z = z0; z <= z1; z++) data.fill(0, z * size + x0, z * size + x1 + 1);
  };
  for (const p of content.pads) clear(p, -0.5);
  for (const l of content.lots) clear(l, 0.3);
  for (const r of content.propFree) clear(r, 0);
  for (const r of extra) clear(r, 0);
  // Parks are lawns even downtown.
  for (const r of parks) {
    for (let z = Math.max(0, Math.floor(r.z0 + hm.half)); z < Math.min(size, Math.ceil(r.z1 + hm.half)); z++)
      for (let x = Math.max(0, Math.floor(r.x0 + hm.half)); x < Math.min(size, Math.ceil(r.x1 + hm.half)); x++) {
        const wx = x - hm.half + 0.5;
        const wz = z - hm.half + 0.5;
        if (!onRoadCorridor(wx, wz, ROAD.sidewalkHalf + 0.5)) data[z * size + x] = Math.max(data[z * size + x], 230);
      }
  }
  // Paths inside parks stay clear of the pad and lot rules above (parks have no pads).
  return { data, size };
}

const SHARED_PARS = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uMask;
uniform sampler2D tMacro;
uniform vec3 uCam;
uniform vec3 uPlayer;
uniform float uTime;
uniform float uPatch;
uniform float uHalf;
uniform float uStep;
uniform float uN;
attribute vec2 aOff;
attribute vec4 aRnd;
float terrainH(vec2 p) {
  vec2 f = clamp((p + uHalf) / uStep, vec2(0.0), vec2(uN - 0.001));
  ivec2 i = ivec2(floor(f));
  vec2 t = f - vec2(i);
  float a = texelFetch(uHeight, i, 0).r;
  float b = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uHeight, i + ivec2(0, 1), 0).r;
  float e = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
  if (t.x + t.y <= 1.0) return a + (b - a) * t.x + (c - a) * t.y;
  return e + (c - e) * (1.0 - t.x) + (b - e) * (1.0 - t.y);
}
`;

/** Wraps an instance's fixed offset into the patch around the camera and works out wind and trampling. */
const SHARED_BODY = /* glsl */ `
  vec2 gc = uCam.xz;
  vec2 gp = gc + mod(aOff - gc + 0.5 * uPatch, uPatch) - 0.5 * uPatch;
  float gdist = length(gp - gc);
  float gmask = texture2D(uMask, (gp + uHalf) / (2.0 * uHalf)).r;
  float gfade = 1.0 - smoothstep(uPatch * 0.3, uPatch * 0.49, gdist) * 0.6;
  vec3 gmac = texture2D(tMacro, gp / 260.0).rgb;
  float gground = terrainH(gp);
  float gyaw = aRnd.x * 6.2831853;
  vec2 gside = vec2(cos(gyaw), sin(gyaw));
  float gwind = sin(uTime * 1.3 + dot(gp, vec2(0.11, 0.07))) * 0.6
              + sin(uTime * 2.9 + dot(gp, vec2(-0.23, 0.31))) * 0.25
              + (texture2D(tMacro, gp / 45.0 + uTime * vec2(0.021, 0.009)).g - 0.5) * 1.4;
  vec2 gbend = vec2(0.92, 0.38) * (0.12 + gwind * 0.28) + vec2(-gside.y, gside.x) * (aRnd.z - 0.5) * 0.5;
  vec2 gaway = gp - uPlayer.xz;
  float gpd = length(gaway);
  gbend += gaway / max(gpd, 0.001) * smoothstep(0.9, 0.0, gpd) * 1.4 * step(abs(uPlayer.y - gground), 1.6);
`;

export type GrassQuality = 'low' | 'high' | 'ultra';

/**
 * Instanced grass blades and wild flowers that follow the camera. Each instance has a fixed spot in
 * a square patch; the vertex shader wraps that spot to the copy nearest the camera, sits it on the
 * terrain, thins it by the grass mask and bends it with wind and the player's footsteps.
 * No CPU work per frame beyond a few uniforms.
 */
export class GrassField {
  readonly group = new THREE.Group();
  private uniforms: Record<string, THREE.IUniform>;
  private blades: THREE.Mesh | null = null;
  private flowers: THREE.Mesh | null = null;
  private quality: GrassQuality | null = null;

  constructor(
    hm: Heightmap,
    mask: { data: Uint8Array; size: number },
    private surf: SurfaceSet,
  ) {
    const ht = new THREE.DataTexture(hm.data, hm.verts, hm.verts, THREE.RedFormat, THREE.FloatType);
    ht.minFilter = ht.magFilter = THREE.NearestFilter;
    ht.needsUpdate = true;
    const mt = new THREE.DataTexture(mask.data, mask.size, mask.size, THREE.RedFormat, THREE.UnsignedByteType);
    mt.minFilter = mt.magFilter = THREE.LinearFilter;
    mt.needsUpdate = true;
    this.uniforms = {
      uHeight: { value: ht },
      uMask: { value: mt },
      tMacro: { value: surf.macro },
      uCam: { value: new THREE.Vector3() },
      uPlayer: { value: new THREE.Vector3(0, -999, 0) },
      uTime: { value: 0 },
      uPatch: { value: 50 },
      uHalf: { value: hm.half },
      uStep: { value: hm.step },
      uN: { value: hm.n },
      uBase: { value: new THREE.Color(0x2c4716) },
      uTip: { value: new THREE.Color(0x86ad44) },
      uDry: { value: new THREE.Color(0xbcaa62) },
      tGrass: { value: surf.grass },
      uGrassTint: { value: GRASS_TINT },
    };
    this.group.name = 'grass';
  }

  setQuality(q: GrassQuality) {
    if (q === this.quality) return;
    this.quality = q;
    for (const m of [this.blades, this.flowers]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.blades = this.flowers = null;
    if (q === 'low') return;
    const patch = q === 'ultra' ? 56 : 40;
    const density = q === 'ultra' ? 24 : 16; // tufts per square metre (five blades each)
    this.uniforms.uPatch.value = patch;
    this.blades = this.makeBlades(Math.round(patch * patch * density), patch);
    this.flowers = this.makeFlowers(Math.round(patch * patch * 2.2), patch);
    this.group.add(this.blades, this.flowers);
  }

  update(time: number, camera: THREE.Vector3, player: THREE.Vector3) {
    this.uniforms.uTime.value = time;
    this.uniforms.uCam.value.copy(camera);
    this.uniforms.uPlayer.value.copy(player);
  }

  private instanceAttrs(geo: THREE.InstancedBufferGeometry, count: number, patch: number, seed: number) {
    const rng = new Rng(seed);
    const off = new Float32Array(count * 2);
    const rnd = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      off[i * 2] = rng.next() * patch;
      off[i * 2 + 1] = rng.next() * patch;
      rnd.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
    }
    geo.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
    geo.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 4));
    geo.instanceCount = count;
  }

  private makeBlades(count: number, patch: number): THREE.Mesh {
    const geo = new THREE.InstancedBufferGeometry();
    // A tuft of five tapered blades fanning out from one root. Each blade is 0..1 tall, -0.5..0.5
    // wide; aBlade = (angle offset, outward lean, height scale) is constant per blade.
    const shape = [-0.5, 0, 0.5, 0, -0.32, 0.55, 0.32, 0.55, 0, 1];
    const pos: number[] = [];
    const blade: number[] = [];
    const idx: number[] = [];
    const rng = new Rng(3);
    const BLADES = 5;
    for (let b = 0; b < BLADES; b++) {
      const ang = (b / BLADES) * Math.PI * 2 + rng.range(-0.4, 0.4);
      const lean = rng.range(0.12, 0.45);
      const hs = rng.range(0.55, 1.0);
      const base = b * 5;
      for (let v = 0; v < 5; v++) {
        pos.push(shape[v * 2], shape[v * 2 + 1], 0);
        blade.push(ang, lean, hs);
      }
      idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3, base + 2, base + 3, base + 4);
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setIndex(idx);
    this.instanceAttrs(geo, count, patch, 7);
    const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${SHARED_PARS}\nattribute vec3 aBlade;\nuniform vec3 uBase, uTip, uDry, uGrassTint;\nuniform sampler2D tGrass;\nvarying vec3 vGrassCol;`)
        .replace(
          '#include <beginnormal_vertex>',
          `${SHARED_BODY}
          // Thin out gradually toward the patch edge so there is no visible line where blades stop.
          float gkeep = step(aRnd.w, gmask * 1.15 - 0.1) * step(fract(aRnd.w * 13.7), 1.0 - smoothstep(uPatch * 0.16, uPatch * 0.47, gdist));
          float gh = (0.16 + aRnd.y * 0.28) * mix(0.7, 1.35, gmac.r) * gkeep * gfade * smoothstep(0.05, 0.4, gmask) * aBlade.z;
          float gw = 0.035 + aRnd.z * 0.03;
          float gt = position.y;
          // Each blade of the tuft faces its own way and leans outward from the root.
          float by = gyaw + aBlade.x;
          vec2 bside = vec2(cos(by), sin(by));
          vec2 bout = vec2(-bside.y, bside.x);
          vec3 gLocal = vec3(bside.x * position.x * gw, gt * gh, bside.y * position.x * gw);
          gLocal.xz += bout * (0.02 + aBlade.y * gt * gt * gh);
          gLocal.xz += gbend * gt * gt * gh;
          gLocal.y *= 1.0 - 0.25 * min(length(gbend), 1.2) * gt;
          vec3 gWorld = vec3(gp.x, gground - 0.03, gp.y) + gLocal;
          vec3 objectNormal = normalize(vec3(bout.x, 0.0, bout.y) * 0.35 + vec3(gbend.x * 0.25, 1.0, gbend.y * 0.25));
          // Colour comes from the same grass texture and tint as the ground, so blades melt into it.
          vec3 gmac2 = texture2D(tMacro, gp / 61.0).rgb;
          vec3 gground3 = textureLod(tGrass, gp / 2.6, 4.0).rgb * uGrassTint * mix(0.72, 1.2, gmac.r) * mix(0.9, 1.1, gmac2.b);
          gground3 = mix(gground3, gground3 * vec3(1.25, 1.08, 0.62), smoothstep(0.58, 0.82, gmac.g) * 0.55);
          float gdry = step(0.95, fract(aRnd.w * 7.13));
          vec3 gtip = mix(gground3 * mix(1.05, 1.4, aRnd.y), uDry, gdry * 0.7);
          vGrassCol = mix(gground3 * 0.5, gtip, smoothstep(0.0, 1.0, gt));`,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = gWorld;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol;')
        .replace('#include <color_fragment>', 'diffuseColor.rgb *= vGrassCol;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.16;')
        .replace('#include <normal_fragment_begin>', 'float faceDirection = gl_FrontFacing ? 1.0 : -1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;');
    };
    mat.customProgramCacheKey = () => 'grass-blades';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'grass-blades';
    return mesh;
  }

  private makeFlowers(count: number, patch: number): THREE.Mesh {
    const geo = new THREE.InstancedBufferGeometry();
    // A thin stem (uv.x < 0 marks stem vertices) and a small flower head lying almost flat on top.
    const pos = [-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0, -0.5, 1, -0.5, 0.5, 1, -0.5, -0.5, 1, 0.5, 0.5, 1, 0.5];
    const uv = [-1, -1, -1, -1, -1, -1, -1, -1, 0, 1, 1, 1, 0, 0, 1, 0];
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(24).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    geo.setIndex([0, 1, 2, 2, 1, 3, 4, 6, 5, 5, 6, 7]);
    this.instanceAttrs(geo, count, patch, 9);
    const mat = new THREE.MeshLambertMaterial({ map: this.surf.flowers, alphaTest: 0.5, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${SHARED_PARS}`)
        .replace(
          '#include <beginnormal_vertex>',
          `${SHARED_BODY}
          // Flowers grow in drifts: only where a slow noise field is high and grass is thick.
          float drift = smoothstep(0.45, 0.68, texture2D(tMacro, gp / 37.0 + 0.31).b);
          float gkeep = step(aRnd.w, gmask * drift * 1.3 - 0.15) * step(fract(aRnd.w * 13.7), 1.0 - smoothstep(uPatch * 0.16, uPatch * 0.47, gdist));
          float gh = (0.18 + aRnd.y * 0.22) * gkeep * gfade;
          float gstem = step(uv.x, -0.5);
          float hs = 0.07 + aRnd.z * 0.05;
          vec3 gLocal = gstem > 0.5
            ? vec3(gside.x * position.x * 0.012, position.y * gh, gside.y * position.x * 0.012)
            : vec3(gside.x * position.x * hs - gside.y * position.z * hs, gh, gside.y * position.x * hs + gside.x * position.z * hs);
          gLocal.xz += gbend * (gLocal.y / max(gh, 0.01)) * (gLocal.y / max(gh, 0.01)) * gh * 0.8;
          gLocal.y += (1.0 - gstem) * position.z * 0.25 * hs;
          vec3 gWorld = vec3(gp.x, gground - 0.02, gp.y) + gLocal;
          vec3 objectNormal = vec3(0.0, 1.0, 0.0);
          float kq = floor(aRnd.z * 3.999);
          vMapUv = gstem > 0.5 ? vec2(0.02, 0.98) : uv * 0.5 + vec2(mod(kq, 2.0), floor(kq / 2.0)) * 0.5;`,
        )
        .replace('#include <begin_vertex>', 'vec3 transformed = gWorld;');
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        'float faceDirection = gl_FrontFacing ? 1.0 : -1.0;\nvec3 normal = normalize(vNormal);\nvec3 nonPerturbedNormal = normal;',
      );
    };
    mat.customProgramCacheKey = () => 'grass-flowers';
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.name = 'grass-flowers';
    return mesh;
  }
}
