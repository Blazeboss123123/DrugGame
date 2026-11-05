import * as THREE from 'three';
import { Sky as SkyShader } from 'three/addons/objects/Sky.js';
import { lerp, smoothstep } from '../core/math';
import type { Settings } from '../core/Settings';
import type { TimeOfDay } from '../core/TimeOfDay';

/** Atmospheric sky, sun/moon light with a player-following shadow frustum, hemisphere fill and fog. */
export class Sky {
  readonly sky = new SkyShader();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4d4436, 0.9);
  readonly fog = new THREE.FogExp2(0xb8c4cc, 0.0022);
  /** 0 = full day, 1 = full night. Drives window glow and street lights. */
  night = 0;
  private dir = new THREE.Vector3();
  private dayFog = new THREE.Color(0xa8bfd6);
  private duskFog = new THREE.Color(0xc79a7e);
  private nightFog = new THREE.Color(0x0d1320);
  private warm = new THREE.Color(0xffa45c);
  private white = new THREE.Color(0xfff3e2);
  private moon = new THREE.Color(0x8fa6d6);
  /** 0..1 golden-hour amount, for colour grading. */
  dusk = 0;
  // Reflections: a small copy of the sky is rendered into an environment map every few seconds.
  private envSky = new SkyShader();
  private envScene = new THREE.Scene();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envTimer = 0;
  private lastEnvSun = new THREE.Vector3(0, -1, 0);
  private deep = { value: 1 };
  private stars: THREE.Points;
  private moonMesh: THREE.Mesh;

  constructor(
    private scene: THREE.Scene,
    private renderer: THREE.WebGLRenderer,
    private settings: Settings,
  ) {
    this.sky.scale.setScalar(4500);
    // Deepen the zenith blue (the stock shader is pale at midday); fades out at sunrise/sunset.
    for (const sk of [this.sky, this.envSky]) {
      const m = sk.material as THREE.ShaderMaterial;
      m.uniforms.uDeep = this.deep;
      m.fragmentShader = m.fragmentShader
        .replace('void main() {', 'uniform float uDeep;\nvoid main() {')
        .replace('gl_FragColor = vec4( retColor, 1.0 );', 'float zen = clamp(direction.y * 1.4, 0.0, 1.0);\nretColor *= mix(vec3(1.0), vec3(0.58, 0.78, 1.15), zen * uDeep);\ngl_FragColor = vec4( retColor, 1.0 );');
    }
    const u = this.sky.material.uniforms;
    u.turbidity.value = 2.6;
    u.rayleigh.value = 1.5;
    u.mieCoefficient.value = 0.0035;
    u.mieDirectionalG.value = 0.86;
    scene.add(this.sky);
    this.sun.castShadow = true;
    const cam = this.sun.shadow.camera;
    cam.left = -75;
    cam.right = 75;
    cam.top = 75;
    cam.bottom = -75;
    cam.near = 1;
    cam.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.applyShadowQuality();
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    // Environment map source: same shader, small enough for the cube camera.
    this.envSky.scale.setScalar(50);
    this.envScene.add(this.envSky);
    this.envScene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0));
    this.pmrem = new THREE.PMREMGenerator(renderer);
    // Stars and moon for the night sky.
    const n = 2200;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const y = Math.abs(u) * 0.95 + 0.05;
      pos.set([r * Math.cos(th) * 1500, y * 1500, r * Math.sin(th) * 1500], i * 3);
      const b = 0.5 + Math.random() * 0.5;
      const tint = Math.random();
      col.set([b * (tint > 0.8 ? 1 : 0.85), b * 0.9, b * (tint < 0.2 ? 0.75 : 1)], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.stars.frustumCulled = false;
    this.stars.renderOrder = -1;
    scene.add(this.stars);
    this.moonMesh = new THREE.Mesh(new THREE.CircleGeometry(28, 32), new THREE.MeshBasicMaterial({ color: 0xe8ecf5, fog: false, transparent: true, opacity: 0 }));
    scene.add(this.moonMesh);
  }

  /** Re-renders the reflection environment when the sun has moved noticeably. */
  private updateEnv(dt: number) {
    if (this.settings.graphics === 'low') {
      if (this.scene.environment) this.scene.environment = null;
      return;
    }
    this.envTimer -= dt;
    if (this.envTimer > 0 && this.lastEnvSun.angleTo(this.dir) < 0.03 && this.envRT) return;
    this.envTimer = 6;
    this.lastEnvSun.copy(this.dir);
    const src = this.sky.material.uniforms;
    const dst = this.envSky.material.uniforms;
    for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) dst[k].value = src[k].value;
    dst.sunPosition.value.copy(this.dir);
    // At night the sky shader is black; fill the environment with a dim blue instead.
    this.envScene.background = this.night > 0.6 ? new THREE.Color(0x0b1220) : null;
    this.envSky.visible = this.night <= 0.6;
    const old = this.envRT;
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02, 0.1, 200);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.3 + (1 - this.night) * 0.45;
    old?.dispose();
  }

  applyShadowQuality(): void {
    const q = this.settings.shadows;
    this.renderer.shadowMap.enabled = q !== 'off';
    this.sun.castShadow = q !== 'off';
    // Ultra graphics doubles shadow resolution for crisper tree and building shadows.
    const size = q === 'high' ? (this.settings.graphics === 'ultra' ? 4096 : 2048) : 1024;
    this.sun.shadow.radius = this.settings.graphics === 'ultra' ? 2 : 1;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  update(time: TimeOfDay, focus: THREE.Vector3, indoors: number, dt = 0.016, camera?: THREE.Camera): void {
    const { elevation, azimuth } = time.sun();
    this.dir.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
    this.sky.material.uniforms.sunPosition.value.copy(this.dir);
    const se = Math.sin(elevation);
    const day = smoothstep(-0.1, 0.22, se);
    this.night = 1 - smoothstep(-0.12, 0.08, se);
    const dusk = smoothstep(0.35, 0.02, Math.abs(se)) * (1 - this.night * 0.6);
    this.dusk = dusk;
    this.deep.value = day * (1 - dusk * 0.8);
    const cam = camera?.position ?? focus;
    this.stars.position.copy(cam);
    (this.stars.material as THREE.PointsMaterial).opacity = this.night * (1 - indoors) * 0.95;
    this.stars.rotation.y = time.minutes * 0.0004;
    const moonDir = this.dir.clone().multiplyScalar(-1).setY(Math.max(0.15, -this.dir.y)).normalize();
    this.moonMesh.position.copy(cam).addScaledVector(moonDir, 1400);
    this.moonMesh.lookAt(cam);
    (this.moonMesh.material as THREE.MeshBasicMaterial).opacity = this.night;
    this.updateEnv(dt);

    // Directional light: sun by day, a dim moon (opposite side) by night.
    const lightDir = se > -0.02 ? this.dir : this.dir.clone().multiplyScalar(-1).setY(0.6).normalize();
    this.sun.position.copy(focus).addScaledVector(lightDir, 220);
    this.sun.target.position.set(Math.round(focus.x / 4) * 4, focus.y, Math.round(focus.z / 4) * 4);
    this.sun.position.x += this.sun.target.position.x - focus.x;
    this.sun.position.z += this.sun.target.position.z - focus.z;
    if (se > -0.02) {
      this.sun.color.copy(this.warm).lerp(this.white, smoothstep(0.02, 0.45, se));
      this.sun.intensity = lerp(0.2, 4.2, smoothstep(-0.02, 0.3, se));
    } else {
      this.sun.color.copy(this.moon);
      this.sun.intensity = 0.32 * this.night;
    }
    // Without the reflection environment (Low graphics) the hemisphere light has to carry all the fill.
    this.hemi.intensity = lerp(0.2, 0.55, day) * lerp(1, 0.75, indoors) * (this.settings.graphics === 'low' ? 2.1 : 1);
    this.hemi.color.setHSL(0.6, 0.45, lerp(0.35, 0.75, day));
    this.hemi.groundColor.setHSL(0.09, 0.2, lerp(0.08, 0.3, day));

    const fogC = this.fog.color;
    fogC.copy(this.nightFog).lerp(this.dayFog, day).lerp(this.duskFog, dusk * 0.55);
    this.fog.density = 0.85 / Math.max(200, this.settings.viewDistance);
    this.renderer.toneMappingExposure = lerp(0.72, 0.74, day) + this.night * 0.12;
    // The sky shader goes black at night; blend in a dark blue scene background through fog colour.
    (this.sky.material as THREE.ShaderMaterial).visible = this.night < 0.97;
    this.scene.background = this.night > 0.5 ? this.fog.color.clone().multiplyScalar(0.9) : null;
  }
}
