import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Settings } from '../core/Settings';

/**
 * Post-processing: HDR render with MSAA, bloom (street lights, windows and neon glow at night),
 * then a grading pass with a soft vignette, and finally tone mapping to the screen.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    vignette: { value: 0.32 },
    warmth: { value: 0 },
    lift: { value: 0 },
    saturation: { value: 1.1 },
    // Substance effects (all 0 when sober).
    tint: { value: new THREE.Color(1, 1, 1) },
    tintAmt: { value: 0 },
    hue: { value: 0 },
    warp: { value: 0 },
    chroma: { value: 0 },
    exposure: { value: 1 },
    time: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float vignette; uniform float warmth; uniform float lift; uniform float saturation;
    uniform vec3 tint; uniform float tintAmt; uniform float hue; uniform float warp; uniform float chroma; uniform float exposure; uniform float time;
    varying vec2 vUv;
    vec3 hueRotate(vec3 c, float a) {
      const vec3 k = vec3(0.57735);
      float ca = cos(a);
      return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
    }
    void main(){
      vec2 uv = vUv;
      // Wavy, breathing distortion.
      uv += warp * vec2(sin(uv.y * 9.0 + time * 1.7), cos(uv.x * 7.0 + time * 1.3)) * 0.012;
      vec2 dir = (uv - 0.5) * chroma * 0.02;
      vec4 c = texture2D(tDiffuse, uv);
      if (chroma > 0.001) {
        c.r = texture2D(tDiffuse, uv + dir).r;
        c.b = texture2D(tDiffuse, uv - dir).b;
      }
      c.rgb *= exposure;
      // Gentle filmic split-tone: warm highlights at golden hour, cool shadows at night.
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb += warmth * vec3(0.06, 0.02, -0.04) * smoothstep(0.2, 1.2, l);
      c.rgb += lift * vec3(-0.01, 0.0, 0.03) * (1.0 - smoothstep(0.0, 0.4, l));
      c.rgb = max(mix(vec3(l), c.rgb, saturation), 0.0);
      if (abs(hue) > 0.001) c.rgb = max(hueRotate(c.rgb, hue), 0.0);
      c.rgb = mix(c.rgb, c.rgb * tint * 1.4 + tint * l * 0.15, tintAmt);
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vignette * dot(d, d) * 1.6;
      gl_FragColor = c;
    }`,
};

/** Screen-space look of whatever the player has taken (see player/Substances). */
export interface HighLook {
  tint: THREE.Color;
  tintAmt: number;
  hue: number;
  warp: number;
  chroma: number;
  exposure: number;
  saturation: number;
  vignette: number;
  bloom: number;
}

const WHITE = new THREE.Color(1, 1, 1);

export class PostFX {
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  enabled = false;
  /** Current substance look, or null when sober. */
  high: HighLook | null = null;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private settings: Settings,
  ) {
    this.apply();
  }

  apply() {
    const want = this.settings.graphics !== 'low';
    if (want && !this.composer) {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: this.samples() });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.4, 0.55, 0.9);
      this.composer.addPass(this.bloom);
      this.grade = new ShaderPass(GradeShader);
      this.composer.addPass(this.grade);
      this.composer.addPass(new OutputPass());
    }
    // Anti-aliasing samples follow the quality level (4× on Ultra, 2× on High).
    if (this.composer && this.composer.renderTarget1.samples !== this.samples()) {
      for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) {
        t.samples = this.samples();
        t.dispose();
      }
    }
    this.enabled = want && !!this.composer;
    if (this.bloom) this.bloom.enabled = this.settings.graphics !== 'low';
    this.resize();
  }

  private samples() {
    return this.settings.graphics === 'ultra' ? 4 : 2;
  }

  resize() {
    if (!this.composer) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(size.x, size.y);
  }

  /** Night makes lights bloom more; golden hour warms the image. */
  update(night: number, dusk: number) {
    if (!this.bloom || !this.grade) return;
    const ultra = this.settings.graphics === 'ultra';
    this.bloom.strength = (0.16 + night * 0.55) * (ultra ? 1.15 : 0.9);
    this.bloom.threshold = 0.95 - night * 0.3;
    this.bloom.radius = 0.5 + night * 0.2;
    this.grade.uniforms.warmth.value = dusk;
    this.grade.uniforms.lift.value = night;
    const h = this.high;
    const u = this.grade.uniforms;
    u.vignette.value = (ultra ? 0.38 : 0.28) + (h?.vignette ?? 0);
    u.saturation.value = (ultra ? 1.14 : 1.1) - night * 0.25 + (h?.saturation ?? 0);
    u.time.value = performance.now() / 1000;
    u.tint.value.copy(h?.tint ?? WHITE);
    u.tintAmt.value = h?.tintAmt ?? 0;
    u.hue.value = h?.hue ?? 0;
    u.warp.value = h?.warp ?? 0;
    u.chroma.value = h?.chroma ?? 0;
    u.exposure.value = h?.exposure ?? 1;
    this.bloom.strength += h?.bloom ?? 0;
  }

  render() {
    if (this.enabled && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
