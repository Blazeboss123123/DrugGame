import * as THREE from 'three';

/** Anything the player can look at and press E on. */
export interface Interactable {
  readonly id: string;
  /** Prompt text, or null when it can't be used right now. */
  prompt(): string | null;
  interact(): void;
  /** Meshes that glow while targeted. Each must own its material (see ownMaterial). */
  readonly highlight: THREE.Mesh[];
  readonly maxDistance?: number;
  update?(dt: number): void;
  /** Optional second action on F (e.g. pick up equipment to move it). */
  secondaryPrompt?(): string | null;
  secondary?(): void;
}

const HIGHLIGHT = new THREE.Color(0xf2a23a);

/** Gives a mesh its own copy of its material so highlighting it doesn't light up every shared user. */
export function ownMaterial(mesh: THREE.Mesh): THREE.Mesh {
  const m = mesh.material as THREE.MeshStandardMaterial;
  mesh.material = m.clone();
  return mesh;
}

export function setHighlight(meshes: THREE.Mesh[], on: boolean): void {
  for (const mesh of meshes) {
    const m = mesh.material as THREE.MeshStandardMaterial;
    if (!('emissive' in m)) continue;
    const ud = mesh.userData as { baseEmissive?: THREE.Color; baseIntensity?: number };
    if (!ud.baseEmissive) {
      ud.baseEmissive = m.emissive.clone();
      ud.baseIntensity = m.emissiveIntensity;
    }
    if (on) {
      m.emissive.copy(HIGHLIGHT);
      m.emissiveIntensity = 0.22;
    } else {
      m.emissive.copy(ud.baseEmissive);
      m.emissiveIntensity = ud.baseIntensity ?? 1;
    }
  }
}

/** Generic interactable driven by callbacks (mailbox, computer, bed...). */
export class SimpleInteractable implements Interactable {
  constructor(
    readonly id: string,
    private label: () => string | null,
    private onUse: () => void,
    readonly highlight: THREE.Mesh[],
    readonly maxDistance = 2.6,
  ) {}
  prompt() {
    return this.label();
  }
  interact() {
    this.onUse();
  }
}
