import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/**
 * Rigged, animated characters from Quaternius' Ultimate Modular Men pack (CC0).
 * A library loads each outfit once; a pool hands out clones to whoever is close to the camera.
 */

export const OUTFITS = ['Casual_Hoodie', 'Casual_2', 'Beach', 'Farmer', 'Punk', 'Suit', 'Worker', 'Swat', 'Adventurer'] as const;
export type Outfit = (typeof OUTFITS)[number];
export const CIVILIAN_OUTFITS: Outfit[] = ['Casual_Hoodie', 'Casual_2', 'Beach', 'Farmer', 'Suit', 'Worker', 'Adventurer'];
export type Anim = 'Idle' | 'Idle_Neutral' | 'Walk' | 'Run' | 'Interact' | 'Wave' | 'HitRecieve' | 'Punch_Right';

export interface CharLook {
  skin: number;
  hair: number;
  /** Hue shift applied to clothing (0..1), so the same outfit looks different on different people. */
  hue: number;
  /** Optional colour for accent materials (gang colours, police blue). */
  accent?: number;
}

const KEEP = new Set(['Skin', 'Skin_Darker', 'Hair', 'Eyebrows', 'Moustache', 'Eye', 'Earrings', 'Gold', 'Visor', 'Black', 'White']);
const ACCENT: Partial<Record<Outfit, string[]>> = { Punk: ['Red', 'Red_Dark'], Swat: ['Swat'] };

// Bone offsets that bring the right hand up to the mouth (worked out from the rig's rest pose).
const UP_AXIS = new THREE.Vector3(0, 0, 1);
const LOW_AXIS = new THREE.Vector3(1, 0, 0);
const UP_ANGLE = (-135 * Math.PI) / 180;
const LOW_ANGLE = (-120 * Math.PI) / 180;

export class CharacterLibrary {
  readonly templates = new Map<Outfit, THREE.Object3D>();
  readonly clips = new Map<Anim, THREE.AnimationClip>();
  ready = false;

  async load(base = './assets/characters/', timeoutMs = 30000): Promise<void> {
    const loader = new GLTFLoader();
    const get = (file: string) =>
      new Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] } | null>((resolve) =>
        loader.load(`${base}${file}.json`, (g: { scene: THREE.Object3D; animations: THREE.AnimationClip[] }) => resolve(g), undefined, () => resolve(null)),
      );
    const work = (async () => {
      const anims = await get('Animations');
      if (!anims) return;
      for (const c of anims.animations) this.clips.set(c.name as Anim, c);
      await Promise.all(
        OUTFITS.map(async (o) => {
          const g = await get(o);
          if (!g) return;
          g.scene.traverse((n: THREE.Object3D) => {
            const m = n as THREE.SkinnedMesh;
            if (m.isMesh) {
              m.castShadow = true;
              m.receiveShadow = false;
              m.frustumCulled = false;
              const mat = m.material as THREE.MeshStandardMaterial;
              mat.roughness = 0.75;
              mat.metalness = 0;
            }
          });
          this.templates.set(o, g.scene);
        }),
      );
      this.ready = this.clips.has('Walk') && this.templates.size >= 3;
    })();
    await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  has(o: Outfit) {
    return this.templates.has(o);
  }
}

export class CharacterInstance {
  readonly root: THREE.Object3D;
  readonly mixer: THREE.AnimationMixer;
  private actions = new Map<Anim, THREE.AnimationAction>();
  current: Anim | null = null;
  private upper?: THREE.Bone;
  private lower?: THREE.Bone;
  private head?: THREE.Bone;
  readonly item: THREE.Mesh;
  private mats: { mat: THREE.MeshStandardMaterial; base: THREE.Color; name: string }[] = [];
  private q = new THREE.Quaternion();
  /** 0..1 how far the right hand is raised to the mouth. */
  raise = 0;
  /** Head tilt back (radians). */
  tilt = 0;
  owner: unknown = null;

  constructor(
    readonly outfit: Outfit,
    lib: CharacterLibrary,
  ) {
    this.root = cloneSkinned(lib.templates.get(outfit)!);
    this.mixer = new THREE.AnimationMixer(this.root);
    for (const [name, clip] of lib.clips) {
      const a = this.mixer.clipAction(clip);
      if (name === 'Wave' || name === 'HitRecieve' || name === 'Punch_Right') {
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      }
      this.actions.set(name, a);
    }
    this.root.traverse((n: THREE.Object3D) => {
      if ((n as THREE.Bone).isBone) {
        if (n.name === 'UpperArm.R') this.upper = n as THREE.Bone;
        if (n.name === 'LowerArm.R') this.lower = n as THREE.Bone;
        if (n.name === 'Head') this.head = n as THREE.Bone;
      }
      const m = n as THREE.Mesh;
      if (m.isMesh) {
        // Own materials per instance so people can be recoloured individually.
        const src = m.material as THREE.MeshStandardMaterial;
        const mat = src.clone();
        m.material = mat;
        this.mats.push({ mat, base: src.color.clone(), name: src.name });
      }
    });
    this.item = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.03), new THREE.MeshStandardMaterial({ color: 0xd9e6ea, roughness: 0.4 }));
    this.item.visible = false;
    const wrist = this.root.getObjectByName('Wrist.R');
    (wrist ?? this.root).add(this.item);
    this.item.position.set(0, 0.08, 0.03);
  }

  setLook(look: CharLook) {
    const accent = ACCENT[this.outfit] ?? [];
    for (const { mat, base, name } of this.mats) {
      mat.color.copy(base);
      if (name === 'Skin') mat.color.setHex(look.skin);
      else if (name === 'Skin_Darker') mat.color.setHex(look.skin).multiplyScalar(0.8);
      else if (name === 'Hair' || name === 'Eyebrows' || name === 'Moustache') mat.color.setHex(look.hair);
      else if (look.accent !== undefined && accent.includes(name)) mat.color.setHex(look.accent);
      else if (!KEEP.has(name)) mat.color.offsetHSL(look.hue, 0, 0);
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 1;
    }
  }

  /** Glow tint for product effects (0 = off). */
  glow(color: number, amount: number) {
    for (const { mat, name } of this.mats) {
      if (name === 'Eye') continue;
      mat.emissive.setHex(color);
      mat.emissiveIntensity = amount * 0.35;
    }
  }

  play(name: Anim, fade = 0.25, timeScale = 1) {
    const next = this.actions.get(name) ?? this.actions.get('Idle');
    if (!next) return;
    next.timeScale = timeScale;
    if (this.current === name) return;
    const prev = this.current ? this.actions.get(this.current) : null;
    next.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (prev && prev !== next) prev.fadeOut(fade);
    this.current = name;
  }

  setTimeScale(s: number) {
    const a = this.current ? this.actions.get(this.current) : null;
    if (a) a.timeScale = s;
  }

  update(dt: number) {
    this.mixer.update(dt);
    // Procedural overrides on top of the animation: hand to mouth and head tilt.
    if (this.raise > 0.001 && this.upper && this.lower) {
      this.upper.quaternion.multiply(this.q.setFromAxisAngle(UP_AXIS, UP_ANGLE * this.raise));
      this.lower.quaternion.multiply(this.q.setFromAxisAngle(LOW_AXIS, LOW_ANGLE * this.raise));
    }
    if (this.tilt && this.head) this.head.quaternion.multiply(this.q.setFromAxisAngle(LOW_AXIS, -this.tilt));
  }
}

/** Hands out character clones, reusing them as people come in and out of range. */
export class CharacterPool {
  private free = new Map<Outfit, CharacterInstance[]>();
  readonly live = new Set<CharacterInstance>();

  constructor(
    private lib: CharacterLibrary,
    private scene: THREE.Scene,
    readonly max = 40,
  ) {}

  get ready() {
    return this.lib.ready;
  }

  acquire(outfit: Outfit, owner: unknown): CharacterInstance | null {
    if (!this.lib.ready || this.live.size >= this.max) return null;
    const o = this.lib.has(outfit) ? outfit : (CIVILIAN_OUTFITS.find((x) => this.lib.has(x)) as Outfit);
    if (!o) return null;
    const list = this.free.get(o) ?? [];
    const inst = list.pop() ?? new CharacterInstance(o, this.lib);
    this.free.set(o, list);
    inst.owner = owner;
    inst.current = null;
    inst.raise = 0;
    inst.tilt = 0;
    inst.item.visible = false;
    this.scene.add(inst.root);
    this.live.add(inst);
    return inst;
  }

  release(inst: CharacterInstance) {
    if (!this.live.delete(inst)) return;
    inst.owner = null;
    inst.mixer.stopAllAction();
    inst.current = null;
    this.scene.remove(inst.root);
    const list = this.free.get(inst.outfit) ?? [];
    list.push(inst);
    this.free.set(inst.outfit, list);
  }
}
