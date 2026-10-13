// HTML overlay HUD (spec 7.2): location top right, vitals bottom right,
// notifications bottom left, the action prompt above the hotbar.

import type { VitalValues } from '../systems/Vitals';
import { fullscreenSupported, isFullscreen, onFullscreenChange, toggleFullscreen } from './Fullscreen';

const BARS: Array<[keyof VitalValues, string]> = [
  ['health', 'HP'],
  ['stamina', 'ST'],
  ['hunger', 'FD'],
  ['thirst', 'WT'],
];

/** How bad a vital is: 0 fine, 1 low, 2 critical. */
export type Danger = 0 | 1 | 2;

/** Shares of the bar below which a vital is low and critical. Stamina comes
 *  back in seconds, so it only warns when nearly gone. */
const DANGER: Record<keyof VitalValues, [number, number]> = {
  health: [0.3, 0.12],
  stamina: [0, 0.12],
  hunger: [0.2, 0.001],
  thirst: [0.2, 0.001],
};
/** A warning clears only this far above its threshold, so it does not flicker. */
const HYSTERESIS = 0.03;

const WARNINGS: Record<keyof VitalValues, [string, string]> = {
  health: ['Low health: eat, rest or keep out of fights', 'Near death!'],
  stamina: ['', 'Exhausted: stop running to recover'],
  hunger: ['Hungry: eat something soon', 'Starving! You are losing health'],
  thirst: ['Thirsty: find water soon', 'Dehydrated! You are losing health'],
};

export class Hud {
  onAction?: () => void;
  onBag?: () => void;
  onAttack?: () => void;
  onDodge?: () => void;
  /** The touch Block button is held down. */
  blockHeld = false;
  private readonly level: HTMLElement;
  private readonly xpFill: HTMLElement;
  private readonly statuses: HTMLElement;
  private readonly boss: HTMLElement;
  private readonly hurt: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly tracker: HTMLElement;
  private readonly help: HTMLElement;
  private readonly compass: HTMLElement;
  private readonly location: HTMLElement;
  private readonly notes: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly touch = matchMedia('(pointer: coarse)');
  private readonly fills = new Map<keyof VitalValues, HTMLElement>();
  private readonly warnings: HTMLElement;
  private readonly danger: HTMLElement;
  private readonly dangers: Record<keyof VitalValues, Danger> = { health: 0, stamina: 0, hunger: 0, thirst: 0 };
  /** Called when a vital gets worse: fine to low, or to critical. */
  onDanger?: (key: keyof VitalValues, level: Danger) => void;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <div class="panel hud-location"><div class="hud-clock"></div><div class="hud-biome"></div><div class="hud-meta"></div></div>
      <div class="hud-tracker"></div>
      <div class="panel hud-compass"><div class="compass-dial"><span class="compass-n">N</span><div class="compass-needle"></div></div><div class="compass-label"></div></div>
      <div class="hud-notes"></div>
      <div class="panel hud-prompt"></div>
      <div class="panel hud-vitals"></div>
      <div class="panel hud-level"><span class="hud-level-n"></span><div class="xp-track"><div class="xp-fill"></div></div></div>
      <div class="hud-status"></div>
      <div class="panel hud-boss"><div class="boss-name"></div><div class="boss-track"><div class="boss-fill"></div></div></div>
      <div class="hud-danger"></div>
      <div class="hud-hurt"></div>
      <div class="hud-warnings"></div>
      <div class="panel hud-help">WASD move · Shift run · Click / J attack · Right-click / K block · Space dodge · E talk / gather · 1–8 hotbar · F use · Q drop · Tab bag · Ctrl+S save</div>
      <div class="touch-buttons">
        <button class="touch-btn bag">Bag</button><button class="touch-btn act">Use</button>
        <button class="touch-btn dodge">Roll</button><button class="touch-btn attack">Hit</button>
        <button class="touch-btn block">Block</button><button class="touch-btn full">Full</button>
      </div>
      <div class="hud-loading"><div class="panel">Generating world…</div></div>`;
    this.location = root.querySelector('.hud-location')!;
    this.notes = root.querySelector('.hud-notes')!;
    this.loading = root.querySelector('.hud-loading')!;
    this.prompt = root.querySelector('.hud-prompt')!;
    this.level = root.querySelector('.hud-level-n')!;
    this.xpFill = root.querySelector('.xp-fill')!;
    this.statuses = root.querySelector('.hud-status')!;
    this.boss = root.querySelector('.hud-boss')!;
    this.hurt = root.querySelector('.hud-hurt')!;
    this.warnings = root.querySelector('.hud-warnings')!;
    this.danger = root.querySelector('.hud-danger')!;
    this.clock = root.querySelector('.hud-clock')!;
    this.tracker = root.querySelector('.hud-tracker')!;
    this.help = root.querySelector('.hud-help')!;
    this.compass = root.querySelector('.hud-compass')!;
    const vitals = root.querySelector('.hud-vitals')!;
    for (const [key, label] of BARS) {
      const bar = document.createElement('div');
      bar.className = `vital vital-${key}`;
      bar.title = key;
      bar.innerHTML = `<div class="vital-track"><div class="vital-fill"></div></div><span>${label}</span>`;
      vitals.appendChild(bar);
      this.fills.set(key, bar.querySelector('.vital-fill')!);
    }
    const button = (cls: string, fn: () => (() => void) | undefined) =>
      root.querySelector(`.touch-btn.${cls}`)!.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        fn()?.();
      });
    // On touch screens the prompt is a button too.
    this.prompt.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.onAction?.();
    });
    button('act', () => this.onAction);
    button('bag', () => this.onBag);
    button('attack', () => this.onAttack);
    button('dodge', () => this.onDodge);
    // Full screen: hidden where the browser cannot do it (iPhone).
    const full = root.querySelector<HTMLElement>('.touch-btn.full')!;
    full.hidden = !fullscreenSupported();
    full.addEventListener('pointerdown', (e) => e.stopPropagation());
    full.addEventListener('click', () => toggleFullscreen());
    onFullscreenChange(() => (full.textContent = isFullscreen() ? 'Exit' : 'Full'));
    // Block is held, not tapped.
    const block = root.querySelector('.touch-btn.block')!;
    block.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.blockHeld = true;
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) block.addEventListener(ev, () => (this.blockHeld = false));
  }

  setLoading(on: boolean): void {
    this.loading.style.display = on ? 'flex' : 'none';
  }

  setLocation(biome: string, difficulty: string, x: number, y: number): void {
    this.location.querySelector('.hud-biome')!.textContent = biome;
    this.location.querySelector('.hud-meta')!.textContent = `${difficulty} · ${x}, ${y}`;
  }

  setVitals(v: VitalValues, maxHealth: number): void {
    let changed = false;
    for (const [key, el] of this.fills) {
      const share = v[key] / (key === 'health' ? maxHealth : 100);
      el.style.height = `${share * 100}%`;
      const was = this.dangers[key];
      const level = dangerOf(key, share, was);
      if (level === was) continue;
      changed = true;
      this.dangers[key] = level;
      const bar = el.parentElement!.parentElement!;
      bar.classList.toggle('low', level === 1);
      bar.classList.toggle('critical', level === 2);
      if (level > was) this.onDanger?.(key, level);
    }
    if (!changed) return;
    // Worst first; among equals, in bar order (health first).
    const active = BARS.map(([key]) => key)
      .filter((key) => this.dangers[key])
      .sort((a, b) => this.dangers[b] - this.dangers[a]);
    this.warnings.replaceChildren(
      ...active.map((key) => {
        const el = document.createElement('div');
        el.className = `panel warning warning-${key}${this.dangers[key] === 2 ? ' critical' : ''}`;
        el.textContent = `⚠ ${WARNINGS[key][this.dangers[key] - 1]}`;
        return el;
      }),
    );
    // The screen edges glow red while health is low, and throb when critical.
    this.danger.className = `hud-danger${this.dangers.health ? ` level-${this.dangers.health}` : ''}`;
  }

  setClock(clock: string, weather: string): void {
    this.clock.textContent = `${clock} · ${weather}`;
  }

  /** Points the compass needle (radians, 0 = east) at a target, with its name. */
  setCompass(angle: number | null, label: string): void {
    const needle = this.compass.querySelector('.compass-needle') as HTMLElement;
    needle.style.display = angle === null ? 'none' : '';
    if (angle !== null) needle.style.transform = `rotate(${angle + Math.PI / 2}rad)`;
    this.compass.querySelector('.compass-label')!.textContent = label;
  }

  setHelp(visible: boolean): void {
    this.help.style.display = visible ? '' : 'none';
  }

  /** Quest lines, the first with an optional arrow (radians) toward its target. */
  setTracker(lines: Array<{ text: string; angle: number | null }>): void {
    this.tracker.replaceChildren(
      ...lines.map((l) => {
        const el = document.createElement('div');
        el.className = 'panel tracker-line';
        if (l.angle !== null) {
          const arrow = document.createElement('span');
          arrow.className = 'tracker-arrow';
          arrow.textContent = '➤';
          arrow.style.transform = `rotate(${l.angle}rad)`;
          el.appendChild(arrow);
        }
        el.appendChild(document.createTextNode(l.text));
        return el;
      }),
    );
  }

  setLevel(level: number, xp: number, needed: number): void {
    this.level.textContent = `Lv ${level}`;
    this.xpFill.style.width = `${Math.min(100, (xp / needed) * 100)}%`;
  }

  setStatus(effects: Array<[string, number]>): void {
    const active = effects.filter(([, t]) => t > 0);
    this.statuses.replaceChildren(
      ...active.map(([name, t]) => {
        const el = document.createElement('div');
        el.className = `panel status status-${name}`;
        el.textContent = t === Infinity ? name : `${name} ${Math.ceil(t)}s`;
        return el;
      }),
    );
  }

  setBoss(name: string | null, share: number): void {
    this.boss.style.display = name ? 'block' : 'none';
    if (!name) return;
    this.boss.querySelector('.boss-name')!.textContent = name;
    (this.boss.querySelector('.boss-fill') as HTMLElement).style.width = `${share * 100}%`;
  }

  /** A red flash at the screen edges when the player is hit. */
  flashHurt(): void {
    this.hurt.classList.remove('on');
    void this.hurt.offsetWidth;
    this.hurt.classList.add('on');
  }

  setPrompt(text: string | null): void {
    this.prompt.style.display = text ? 'block' : 'none';
    if (!text) return;
    // Touch screens have no E key: tap the prompt instead.
    const tap = this.touch.matches && text.startsWith('E  ');
    this.prompt.textContent = tap ? text.slice(3) : text;
    this.prompt.classList.toggle('tap', tap);
  }

  notify(text: string): void {
    const el = document.createElement('div');
    el.className = 'panel hud-note';
    el.textContent = text;
    this.notes.appendChild(el);
    while (this.notes.children.length > 5) this.notes.firstElementChild!.remove();
    setTimeout(() => el.classList.add('fade'), 3000);
    setTimeout(() => el.remove(), 3700);
  }
}

function dangerOf(key: keyof VitalValues, share: number, was: Danger): Danger {
  const [low, critical] = DANGER[key];
  if (share < critical || (was === 2 && share < critical + HYSTERESIS)) return 2;
  if (share < low || (was >= 1 && share < low + HYSTERESIS)) return 1;
  return 0;
}
