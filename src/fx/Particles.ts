import * as THREE from 'three';

/** Pooled point particles (smoke puffs, sparks, glows). One draw call for everything. */
export class Particles {
  private readonly max = 900;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grow: Float32Array;
  private gravity: Float32Array;
  private next = 0;
  private geo: THREE.BufferGeometry;
  readonly points: THREE.Points;

  constructor(scene: THREE.Scene) {
    const n = this.max;
    this.pos = new Float32Array(n * 3).fill(-9999);
    this.col = new Float32Array(n * 3);
    this.size = new Float32Array(n);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n).fill(1);
    this.grow = new Float32Array(n);
    this.gravity = new Float32Array(n);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      vertexColors: true,
      uniforms: { scale: { value: 600 } },
      vertexShader: `attribute float size; varying vec3 vColor; varying float vA; uniform float scale;
        void main(){ vColor = color; vA = clamp(size, 0.0, 1.0); vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = size * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vColor; varying float vA;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;
        float a = smoothstep(0.5, 0.1, r); gl_FragColor = vec4(vColor, a * 0.85); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  emit(x: number, y: number, z: number, color: THREE.ColorRepresentation, opts: { count?: number; speed?: number; up?: number; life?: number; size?: number; grow?: number; gravity?: number; spread?: number } = {}) {
    const c = new THREE.Color(color);
    const count = opts.count ?? 8;
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const sp = opts.speed ?? 0.6;
      const spread = opts.spread ?? 0.05;
      this.pos[i * 3] = x + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 1] = y + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      this.vel[i * 3] = (Math.random() - 0.5) * sp;
      this.vel[i * 3 + 1] = (opts.up ?? 0.5) + Math.random() * sp * 0.5;
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * sp;
      this.col[i * 3] = c.r;
      this.col[i * 3 + 1] = c.g;
      this.col[i * 3 + 2] = c.b;
      this.life[i] = this.maxLife[i] = (opts.life ?? 1.4) * (0.7 + Math.random() * 0.6);
      this.size[i] = opts.size ?? 0.12;
      this.grow[i] = opts.grow ?? 0.15;
      this.gravity[i] = opts.gravity ?? 0;
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -9999;
        this.size[i] = 0;
        continue;
      }
      this.vel[i * 3 + 1] -= this.gravity[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 1 - dt * 1.2;
      this.vel[i * 3 + 2] *= 1 - dt * 1.2;
      const f = this.life[i] / this.maxLife[i];
      this.size[i] = Math.max(0, this.size[i] + this.grow[i] * dt) * (f < 0.3 ? 0.9 : 1);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    this.geo.attributes.size.needsUpdate = true;
  }
}
