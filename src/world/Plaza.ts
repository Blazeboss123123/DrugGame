import * as THREE from 'three';
import type { Physics } from '../physics/Physics';
import { BuildKit } from '../properties/BuildKit';
import type { CityContent } from './CityGenerator';
import type { Pad } from './Heightmap';
import { letterTexture, noiseTexture, stoneTexture } from './Textures';

const RISE = 2.4;
const STEPS = 11;
const STEP_RUN = 0.42;

/**
 * Meridian Civic Plaza: a raised square in downtown with stone retaining walls, two staircases,
 * a fountain, planters and benches.
 */
export function buildPlaza(pad: Pad, physics: Physics, content: CityContent): THREE.Group {
  const group = new THREE.Group();
  group.name = 'plaza';
  const cx = (pad.x0 + pad.x1) / 2;
  const cz = (pad.z0 + pad.z1) / 2;
  const ground = pad.h!;
  const top = ground + RISE;
  const k = new BuildKit(new THREE.Vector3(cx, ground, cz), physics);
  const half = 20;

  // Platform with retaining walls; paving on top.
  k.box('wall', -half, -0.6, -half, half, RISE, half, { uv: 3 });
  k.box('paving', -half + 0.3, RISE, -half + 0.3, half - 0.3, RISE + 0.02, half - 0.3, { collide: false, uv: 2 });
  // Coping along the edge, with gaps where the two staircases arrive (south and west).
  const width = 8;
  const w2 = width / 2;
  for (const [x0, z0, x1, z1] of [
    [-half, -half, half, -half + 0.4],
    [half - 0.4, -half, half, half],
    [-half, half - 0.4, -w2, half],
    [w2, half - 0.4, half, half],
    [-half, -half, -half + 0.4, -w2],
    [-half, w2, -half + 0.4, half],
  ])
    k.box('coping', x0, RISE, z0, x1, RISE + 0.5, z1, { surface: 'concrete' });

  // Staircases: south (toward Main St) and west (toward Central Ave).
  for (let s = 1; s <= STEPS; s++) {
    const h = (RISE * s) / (STEPS + 1);
    const zFar = half + (STEPS + 1 - s) * STEP_RUN;
    const zNear = half + (STEPS - s) * STEP_RUN;
    k.box('step', -width / 2, -0.4, zNear, width / 2, h, zFar, { surface: 'concrete', uv: 1 });
    const xFar = -half - (STEPS + 1 - s) * STEP_RUN;
    const xNear = -half - (STEPS - s) * STEP_RUN;
    k.box('step', xFar, -0.4, -width / 2, xNear, h, width / 2, { surface: 'concrete', uv: 1 });
  }

  // Fountain.
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.5, 0.7, 32, 1, true), new THREE.MeshStandardMaterial({ map: stoneTexture(), roughness: 0.8, side: THREE.DoubleSide }));
  basin.position.set(cx, top + 0.35, cz);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(3.45, 0.14, 8, 40), new THREE.MeshStandardMaterial({ color: 0xa9a294, roughness: 0.7 }));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(cx, top + 0.7, cz);
  const water = new THREE.Mesh(new THREE.CircleGeometry(3.35, 32), new THREE.MeshStandardMaterial({ color: 0x3f6b78, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.85 }));
  water.rotation.x = -Math.PI / 2;
  water.position.set(cx, top + 0.5, cz);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.55, 2.4, 16), new THREE.MeshStandardMaterial({ color: 0x8c8679, roughness: 0.6 }));
  column.position.set(cx, top + 1.2, cz);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 0.4, 0.4, 24), new THREE.MeshStandardMaterial({ color: 0x8c8679, roughness: 0.6 }));
  bowl.position.set(cx, top + 2.4, cz);
  for (const m of [basin, rim, column, bowl]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  group.add(basin, rim, water, column, bowl);
  physics.cylinder(cx, top + 0.35, cz, 0.35, 3.55, 'concrete');
  physics.cylinder(cx, top + 1.4, cz, 1.4, 0.6, 'concrete');

  // Plaque.
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.8), new THREE.MeshStandardMaterial({ map: letterTexture('MERIDIAN CIVIC PLAZA', '#2b2925', '#d8c79f', 512, 96), roughness: 0.5, metalness: 0.3 }));
  plaque.position.set(cx + 6.5, ground + 1.4, cz + half + 0.02);
  group.add(plaque);

  // Planters with trees at the four quarters, benches facing the fountain.
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const px = sx * 11;
    const pz = sz * 11;
    k.box('coping', px - 1.6, RISE, pz - 1.6, px + 1.6, RISE + 0.6, pz + 1.6, { surface: 'concrete' });
    k.box('soil', px - 1.4, RISE + 0.6, pz - 1.4, px + 1.4, RISE + 0.62, pz + 1.4, { collide: false });
    content.trees.push({ x: cx + px, z: cz + pz, type: 'broad', scale: 1.2, y: top + 0.55 });
    content.benches.push({ x: cx + sx * 6.5, z: cz + sz * 6.5, yaw: Math.atan2(-sx, -sz), y: top });
  }
  content.bins.push({ x: cx + 15, z: cz + 3, yaw: 0, y: top }, { x: cx - 3, z: cz - 15, yaw: 0, y: top });

  k.build(
    {
      wall: new THREE.MeshStandardMaterial({ map: stoneTexture(), roughness: 0.9 }),
      paving: new THREE.MeshStandardMaterial({ map: noiseTexture(91, '#b3aca0', '#fff', '#555', 9000, 2), roughness: 0.85 }),
      coping: new THREE.MeshStandardMaterial({ color: 0xc2bcb0, roughness: 0.8 }),
      step: new THREE.MeshStandardMaterial({ map: noiseTexture(92, '#a9a397', '#fff', '#555', 6000, 2), roughness: 0.85 }),
      soil: new THREE.MeshStandardMaterial({ color: 0x3b2e22, roughness: 1 }),
    },
    group,
  );
  return group;
}
