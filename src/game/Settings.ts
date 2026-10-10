// Player settings (spec 8.1, low-end devices): lighting and weather effects
// can be switched off, and the frame rate capped at 30. Kept in this
// browser only.

export interface SettingsValues {
  lighting: boolean;
  weather: boolean;
  fps30: boolean;
  help: boolean;
  /** 0 to 1. */
  music: number;
  sfx: number;
}

const KEY = 'untrue.settings';
const DEFAULTS: SettingsValues = { lighting: true, weather: true, fps30: false, help: true, music: 0.35, sfx: 0.6 };

export class Settings {
  values: SettingsValues = { ...DEFAULTS };
  onChange?: (v: SettingsValues) => void;

  constructor() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.values = { ...DEFAULTS, ...JSON.parse(raw) };
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
