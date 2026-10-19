// The main story. The world has always drifted: land left far enough behind
// lets go and is gone, and the same ground regenerates as something new. That
// is old and ordinary. What is new is the Fracture: rifts tearing open onto
// the outer dimensions, where drifted places go, and the land glitching around
// them. Why is left to the clues the dimensions hold, carved on lore stones:
// a sleeping network, the Null beyond it, and a hand that woke it.
//
// The story shows an opening vision on a new world, keeps the objective in
// the HUD's tracker (find a rift, enter it, break the seals, face the Warden,
// close it), counts the rifts closed, and remembers, for the player alone,
// which dimensions they have cleared, which stones they have read, and how
// far they are in each outer world's own plot (who they have met, the relics
// they have found, whether they made the lost thing whole). Each outer world
// closes with its own vision the first time it is cleared. Nothing here runs
// per frame. It plugs in at LivingWorld.

import type { Plot } from '../dimension/Dimension';
import type { VisionText } from '../ui/Vision';

/** Within this many tiles of an open rift, "Find a rift" becomes "Enter the rift". */
const NEAR = 14;

const INTRO: VisionText = {
  title: 'The Fracture',
  pages: [
    'The world has always drifted. Walk far enough and the land behind you lets go: forests, ruins, whole towns slip beyond reach, and the road back is never quite the same road. Everyone knows this. Travellers trade directions, not maps, and children grow up on stories of homelands no one can walk to.',
    'This is different. Tears have opened in the air, burning violet at the edges, and around them the land stutters. Places vanish that should have stayed. Things crawl out of nowhere. People have started calling it the Fracture.',
    'You woke beside one of the first, with ash on your hands and a gap where the last few days should be. Beyond the tear something hums, low and patient, as if it has been waiting for you. Find a rift. Step through. Close it, if you can.',
  ],
};

const FIRST_CLOSED: VisionText = {
  title: 'The Tear Seals',
  pages: [
    'The rift folds shut behind you, and for a moment the land around you holds perfectly still: not drifting, not fracturing, simply still. Then, far off, you feel the hum again. Other tears are open. And for a heartbeat you are certain you have heard that hum before, long before any rift.',
  ],
};

/** Clue ids kept at most, so a save cannot grow without end. */
const MAX_CLUES = 500;
/** Dimensions remembered as cleared at most. */
const MAX_CLEARED = 64;
/** Plots remembered at most, and relics per plot. */
const MAX_PLOTS = 64;
const MAX_RELICS = 16;

/** A trip in progress, as the story sees it. */
export interface RiftRunView {
  readonly name: string;
  /** The dimension's id, for its clues and plot. */
  readonly layout: { readonly id: string; readonly clues: ReadonlyArray<{ readonly id: string }>; readonly plot: Plot | null };
  /** The player's feet. */
  readonly at: { readonly x: number; readonly y: number };
  readonly trialsDone: number;
  readonly trials: number;
  readonly bossOpen: boolean;
  readonly portalOpen: boolean;
  /** The boss's name, e.g. "The Rift Warden". */
  readonly bossName?: string;
  /** Whether the open portal answers this player (in a shared instance, only
   *  those who had a part in the Warden's fall); missing means it does. */
  readonly attuned?: boolean;
  /** Which way the next step lies from the player, if anywhere. */
  goalAngle(): number | null;
}

/** A clue as the story shows it. */
export interface ClueText {
  readonly id: string;
  readonly title: string;
  readonly pages: readonly string[];
}

/** How far the player is in one world's plot. */
export interface PlotProgress {
  /** Has spoken with its resident. */
  met: boolean;
  /** Relics found, by id. */
  relics: Set<string>;
  /** The lost thing is whole again. */
  restored: boolean;
}

export interface RiftStorySave {
  version: 4;
  /** Rifts the player has closed. */
  closed: number;
  /** The player has stepped through a rift at least once. */
  entered: boolean;
  /** Dimensions the player has cleared (closed a rift from), by id. */
  cleared: string[];
  /** Lore stones read, per dimension id. */
  lore: Record<string, string[]>;
  /** Plot progress, per dimension id. */
  plots: Record<string, { met: boolean; relics: string[]; restored: boolean }>;
}

export interface TrackerLine {
  text: string;
  angle: number | null;
}

export class RiftStory {
  closed = 0;
  entered = false;
  /** Dimensions cleared, by id: a rift may be retuned to any of them. */
  readonly cleared = new Set<string>();
  /** Lore stones read, per dimension. */
  private readonly lore = new Map<string, Set<string>>();
  private loreCount = 0;
  /** Plot progress, per dimension. */
  private readonly plots = new Map<string, PlotProgress>();

  constructor(private readonly show: (v: VisionText) => void) {}

  /** The opening vision, for a new world only. */
  intro(): void {
    this.show(INTRO);
  }

  onEnter(): void {
    this.entered = true;
  }

  /** A rift into `dimension` was closed. The first time a world is cleared
   *  its own closing vision shows (`closing`), if it has one. */
  onClosed(dimension: string, closing?: VisionText | null): void {
    const first = !this.cleared.has(dimension);
    if (this.cleared.size < MAX_CLEARED) this.cleared.add(dimension);
    this.closed++;
    if (first && closing) this.show({ title: closing.title, pages: [...closing.pages] });
    else if (this.closed === 1) this.show(FIRST_CLOSED);
  }

  // Plots ------------------------------------------------------------------------

  /** The player's progress in a world's plot (made on first ask). */
  plot(dimension: string): PlotProgress {
    let p = this.plots.get(dimension);
    if (!p) {
      p = { met: false, relics: new Set(), restored: false };
      if (this.plots.size < MAX_PLOTS) this.plots.set(dimension, p);
    }
    return p;
  }

  /** Relics of a plot found so far. */
  relicsFound(dimension: string, plot: Plot): number {
    const found = this.plots.get(dimension)?.relics;
    if (!found) return 0;
    let n = 0;
    for (const r of plot.relics) if (found.has(r.id)) n++;
    return n;
  }

  hasRelic(dimension: string, id: string): boolean {
    return this.plots.get(dimension)?.relics.has(id) ?? false;
  }

  /** Picks up a relic; true if it was new. */
  findRelic(dimension: string, id: string): boolean {
    const p = this.plot(dimension);
    if (p.relics.has(id) || p.relics.size >= MAX_RELICS) return false;
    p.relics.add(id);
    return true;
  }

  /** Every relic is found and the lost thing not yet whole. */
  canRestore(dimension: string, plot: Plot): boolean {
    const p = this.plots.get(dimension);
    return !!p && !p.restored && this.relicsFound(dimension, plot) === plot.relics.length;
  }

  /** Brings the relics back: the lost thing is whole, its vision shows. True
   *  if it happened now (it happens once). */
  restore(dimension: string, plot: Plot): boolean {
    if (!this.canRestore(dimension, plot)) return false;
    this.plot(dimension).restored = true;
    this.show({ title: plot.restored.title, pages: [...plot.restored.pages] });
    return true;
  }

  /** What the resident says now, as pages, and whether the relics can be
   *  given back at the end of it. Meeting them counts. */
  talk(dimension: string, plot: Plot): { pages: string[]; restore: boolean } {
    const p = this.plot(dimension);
    if (!p.met) {
      p.met = true;
      return { pages: [...plot.talk.first], restore: false };
    }
    if (p.restored) return { pages: [this.cleared.has(dimension) ? plot.talk.cleared : plot.talk.after], restore: false };
    const found = this.relicsFound(dimension, plot);
    if (found === plot.relics.length) return { pages: [...plot.talk.ready], restore: true };
    return { pages: [plot.talk.waiting.replace('{found}', String(found)).replace('{of}', String(plot.relics.length))], restore: false };
  }

  /** The plot's line for the tracker inside its world, if anything is left to do. */
  plotLine(run: RiftRunView): TrackerLine | null {
    const plot = run.layout.plot;
    if (!plot) return null;
    const id = run.layout.id;
    const p = this.plots.get(id);
    const { at } = run;
    const toward = (x: number, y: number) => Math.atan2(y + 0.5 - at.y, x + 0.5 - at.x);
    const r = plot.resident;
    if (!p?.met) return { text: `Someone waits here: seek out ${r.name}`, angle: toward(r.x, r.y) };
    if (p.restored) return null;
    const found = this.relicsFound(id, plot);
    if (found === plot.relics.length) return { text: `Bring the pieces back to ${r.name}`, angle: toward(r.x, r.y) };
    return { text: `Restore ${plot.goal}: ${found}/${plot.relics.length} pieces`, angle: null };
  }

  /** Reads a lore stone: shows its text; true if it was new. */
  readClue(dimension: string, clue: ClueText): boolean {
    this.show({ title: clue.title, pages: [...clue.pages] });
    return this.remember(dimension, clue.id);
  }

  hasRead(dimension: string, clueId: string): boolean {
    return this.lore.get(dimension)?.has(clueId) ?? false;
  }

  /** Clues of a dimension read so far. */
  cluesRead(dimension: string, clues: ReadonlyArray<{ readonly id: string }>): number {
    const read = this.lore.get(dimension);
    if (!read) return 0;
    let n = 0;
    for (const c of clues) if (read.has(c.id)) n++;
    return n;
  }

  /** The objective. `at` is the player's overworld spot; `rift` the nearest
   *  open rift loaded, if any; `run` the trip the player is on, if any. */
  objective(at: { x: number; y: number }, rift: { x: number; y: number } | null, run: RiftRunView | null): TrackerLine {
    if (run) {
      const angle = run.goalAngle();
      if (run.portalOpen && run.attuned === false) return { text: 'The portal is not yours: go back through the rift', angle: null };
      if (run.portalOpen) return { text: 'Close the rift: step through the portal', angle };
      if (run.bossOpen) return { text: `Face ${run.bossName ?? 'the Rift Warden'}`, angle };
      return { text: `Break the seals: ${run.trialsDone}/${run.trials} trials`, angle };
    }
    const angle = rift ? Math.atan2(rift.y - at.y, rift.x - at.x) : null;
    if (this.closed > 0) return { text: `Rifts closed: ${this.closed}`, angle };
    if (rift && Math.hypot(rift.x - at.x, rift.y - at.y) < NEAR) return { text: 'Enter the rift', angle };
    return { text: 'Find a rift', angle };
  }

  /** The clue line for the tracker inside a dimension. */
  clueLine(run: RiftRunView): TrackerLine {
    return { text: `Lore stones read: ${this.cluesRead(run.layout.id, run.layout.clues)}/${run.layout.clues.length}`, angle: null };
  }

  save(): RiftStorySave {
    const lore: Record<string, string[]> = {};
    for (const [dimension, read] of this.lore) lore[dimension] = [...read];
    const plots: RiftStorySave['plots'] = {};
    for (const [dimension, p] of this.plots) plots[dimension] = { met: p.met, relics: [...p.relics], restored: p.restored };
    return { version: 4, closed: this.closed, entered: this.entered, cleared: [...this.cleared], lore, plots };
  }

  /** Missing (saves from before the rifts) starts at "Find a rift". Version 1
   *  (before the clues) has read none; versions 1 and 2 kept no cleared
   *  dimensions, and only The Hollow existed, so a closed rift means it was
   *  cleared. Version 2 kept clues as `dimension:clue`. Versions before 4
   *  had no plots: every world's starts afresh. */
  load(s: unknown): void {
    const save = s as Partial<RiftStorySave & { clues: unknown }> | null | undefined;
    this.closed = typeof save?.closed === 'number' && Number.isFinite(save.closed) ? Math.max(0, Math.floor(save.closed)) : 0;
    this.entered = save?.entered === true;
    this.cleared.clear();
    this.lore.clear();
    this.loreCount = 0;
    this.plots.clear();
    if (Array.isArray(save?.cleared)) {
      for (const id of save.cleared) if (validId(id) && this.cleared.size < MAX_CLEARED) this.cleared.add(id);
    } else if (this.closed > 0) this.cleared.add('hollow');
    if (save?.lore && typeof save.lore === 'object' && !Array.isArray(save.lore)) {
      for (const [dimension, ids] of Object.entries(save.lore)) {
        if (!validId(dimension) || !Array.isArray(ids)) continue;
        for (const id of ids) if (validId(id)) this.remember(dimension, id);
      }
    } else if (Array.isArray(save?.clues)) {
      for (const c of save.clues) {
        if (typeof c !== 'string' || c.length > 80) continue;
        const at = c.indexOf(':');
        if (at > 0 && validId(c.slice(0, at)) && validId(c.slice(at + 1))) this.remember(c.slice(0, at), c.slice(at + 1));
      }
    }
    const plots = (save as { plots?: unknown } | null | undefined)?.plots;
    if (plots && typeof plots === 'object' && !Array.isArray(plots)) {
      for (const [dimension, v] of Object.entries(plots)) {
        if (!validId(dimension) || !v || typeof v !== 'object' || this.plots.size >= MAX_PLOTS) continue;
        const raw = v as { met?: unknown; relics?: unknown; restored?: unknown };
        const relics = new Set<string>();
        if (Array.isArray(raw.relics)) for (const id of raw.relics) if (validId(id) && relics.size < MAX_RELICS) relics.add(id);
        this.plots.set(dimension, { met: raw.met === true, relics, restored: raw.restored === true });
      }
    }
  }

  /** Marks a stone read; true if it was new. Bounded, so a save stays small. */
  private remember(dimension: string, id: string): boolean {
    let read = this.lore.get(dimension);
    if (read?.has(id) || this.loreCount >= MAX_CLUES) return false;
    if (!read) this.lore.set(dimension, (read = new Set()));
    read.add(id);
    this.loreCount++;
    return true;
  }
}

/** A dimension or clue id as a save may hold it. */
function validId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 40;
}
