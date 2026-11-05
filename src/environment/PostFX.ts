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
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float vignette; uniform float warmth; uniform float lift; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      // Gentle filmic split-tone: warm highlights at golden hour, cool shadows at night.
      float l = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb += warmth * vec3(0.06, 0.02, -0.04) * smoothstep(0.2, 1.2, l);
      c.rgb += lift * vec3(-0.01, 0.0, 0.03) * (1.0 - smoothstep(0.0, 0.4, l));
      vec2 d = vUv - 0.5;
      c.rgb *= 1.0 - vignette * dot(d, d) * 1.6;
      gl_FragColor = c;
    }`,
};

export class PostFX {
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private grade: ShaderPass | null = null;
  enabled = false;

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
      const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      this.composer = new EffectComposer(this.renderer, rt);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.4, 0.55, 0.9);
      this.composer.addPass(this.bloom);
      this.grade = new ShaderPass(GradeShader);
      this.composer.addPass(this.grade);
      this.composer.addPass(new OutputPass());
    }
    this.enabled = want && !!this.composer;
    if (this.bloom) this.bloom.enabled = this.settings.graphics !== 'low';
    this.resize();
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
    this.bloom.strength = (0.18 + night * 0.75) * (ultra ? 1.15 : 0.9);
    this.bloom.threshold = 0.95 - night * 0.3;
    this.bloom.radius = 0.5 + night * 0.2;
    this.grade.uniforms.warmth.value = dusk;
    this.grade.uniforms.lift.value = night;
    this.grade.uniforms.vignette.value = ultra ? 0.38 : 0.28;
  }

  render() {
    if (this.enabled && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
