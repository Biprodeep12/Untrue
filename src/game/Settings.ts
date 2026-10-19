// Player settings (spec 8.1, low-end devices): lighting, weather and burst
// effects can be switched off and the frame rate capped at 30; plus volume,
// screen flashes, HUD size and key bindings. Kept in this browser only.

import { DEFAULT_KEYS, type Action } from './Keys';

export interface SettingsValues {
  lighting: boolean;
  weather: boolean;
  fps30: boolean;
  help: boolean;
  /** 0 to 1. */
  music: number;
  sfx: number;
  /** Hit, dust and sparkle bursts. */
  particles: boolean;
  /** Lightning and hurt flashes; off by default when the system asks for reduced motion. */
  flashes: boolean;
  /** HUD and menu size, 0.8 to 1.5. */
  uiScale: number;
  /** Rift trips meet others in public instances (the Drift Beacon's switch);
   *  off, the player goes behind the rifts alone. */
  publicRifts: boolean;
  /** Main keys the player changed. */
  keys: Partial<Record<Action, string>>;
}

const reducedMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const KEY = 'untrue.settings';
const DEFAULTS: SettingsValues = {
  lighting: true,
  weather: true,
  fps30: false,
  help: true,
  music: 0.35,
  sfx: 0.6,
  particles: true,
  flashes: !reducedMotion,
  uiScale: 1,
  publicRifts: true,
  keys: {},
};

/** Stored values over the defaults, keeping only those of the right type: a
 *  damaged entry (say, keys: null) would otherwise break the game at start. */
export function sanitize(stored: unknown): SettingsValues {
  const out: SettingsValues = { ...DEFAULTS, keys: {} };
  if (!stored || typeof stored !== 'object') return out;
  const s = stored as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS) as Array<keyof SettingsValues>) {
    const v = s[k];
    if (k === 'keys') {
      if (v && typeof v === 'object') {
        for (const [a, code] of Object.entries(v)) if (Object.hasOwn(DEFAULT_KEYS, a) && typeof code === 'string') out.keys[a as Action] = code;
      }
    } else if (typeof v === typeof DEFAULTS[k] && (typeof v !== 'number' || Number.isFinite(v))) {
      (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export class Settings {
  values: SettingsValues = { ...DEFAULTS, keys: {} };
  onChange?: (v: SettingsValues) => void;

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.values = sanitize(JSON.parse(raw));
    } catch {
      // Storage blocked: run with defaults.
    }
  }

  set<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]): void {
    this.values[key] = value;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.values));
    } catch {
      // Not persisted; still applies for this session.
    }
    this.onChange?.(this.values);
  }
}
