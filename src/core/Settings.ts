export interface Settings {
  sensitivity: number; // 0.2 .. 3
  fov: number; // degrees
  invertY: boolean;
  headBob: boolean;
  master: number; // 0..1
  sfx: number;
  ambience: number;
  shadows: 'off' | 'low' | 'high';
  viewDistance: number; // metres
  renderScale: number; // 0.5 .. 1
  showFps: boolean;
  graphics: 'low' | 'high' | 'ultra';
  /** Real minutes per in-game day, or 'real' to follow your clock. */
  dayLength: 24 | 48 | 120 | 'real';
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1,
  fov: 75,
  invertY: false,
  headBob: true,
  master: 0.8,
  sfx: 0.9,
  ambience: 0.6,
  shadows: 'high',
  viewDistance: 650,
  renderScale: 1,
  showFps: false,
  graphics: 'high',
  dayLength: 24,
};

const KEY = 'underworld-empire.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable: defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
