/** Keyboard + mouse input with pointer lock, plus a drag-to-look fallback where pointer lock is refused. */
export interface InputOverride {
  forward: number;
  right: number;
  sprint: boolean;
  jump: boolean;
}

export class Input {
  readonly held = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;
  /** When pointer lock is unavailable, holding the left mouse button looks around. */
  dragLook = false;
  private dragging = false;
  override: InputOverride | null = null;
  onLockChange?: (locked: boolean) => void;
  onLockError?: () => void;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.pressed.add(e.code);
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    document.addEventListener('mousemove', (e) => {
      if (this.locked || (this.dragLook && this.dragging)) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.dragging = true;
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onLockChange?.(this.locked);
    });
    document.addEventListener('pointerlockerror', () => this.onLockError?.());
  }

  requestLock(): void {
    try {
      const r = this.canvas.requestPointerLock() as unknown;
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch(() => this.onLockError?.());
      }
    } catch {
      this.onLockError?.();
    }
  }

  releaseLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Synthesises a key press (used by the automated self-test). */
  press(code: string): void {
    this.pressed.add(code);
  }

  axis(): { forward: number; right: number; sprint: boolean; jump: boolean } {
    if (this.override) return { ...this.override };
    const f = (this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0) - (this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0);
    const r = (this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0) - (this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0);
    return {
      forward: f,
      right: r,
      sprint: this.isDown('ShiftLeft') || this.isDown('ShiftRight'),
      jump: this.wasPressed('Space'),
    };
  }

  endFrame(): void {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
