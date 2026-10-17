// The main story, for now: the world has begun to forget itself since rifts
// tore open all over it, onto outer dimensions. Why is left unsaid. The story
// shows an opening vision on a new world, keeps the objective in the HUD's
// tracker (find a rift, enter it, survive what is inside, close it) and
// counts the rifts closed. It plugs in at LivingWorld.

import type { VisionText } from '../ui/Vision';

/** Within this many tiles of an open rift, "Find a rift" becomes "Enter the rift". */
const NEAR = 14;

const INTRO: VisionText = {
  title: 'Rifts',
  pages: [
    'It began quietly. A path that led somewhere yesterday leads somewhere else today. Wells move in the night. Whole valleys are not where the old maps put them. The world has started to forget itself.',
    'Then the tears opened. Rifts, hanging in the air like torn cloth, burning violet at the edges. Around them the land stutters and slips, as if it cannot decide what it is.',
    'No one knows who tore them, or why. But something on the other side is calling, and it sounds almost like your name. Find a rift. Step through. Close it, if you can.',
  ],
};

const FIRST_CLOSED: VisionText = {
  title: 'The Tear Seals',
  pages: [
    'The rift closes behind you with a sound like a held breath let go. For a moment the land around you holds perfectly still. Then, far off, you hear the call again. There are other rifts. Something is still waiting on the other side.',
  ],
};

/** A trip in progress, as the story sees it. */
export interface RiftRunView {
  readonly name: string;
  readonly chambersDone: number;
  readonly chambers: number;
  readonly portalOpen: boolean;
}

export interface RiftStorySave {
  version: 1;
  /** Rifts the player has closed. */
  closed: number;
  /** The player has stepped through a rift at least once. */
  entered: boolean;
}

export interface TrackerLine {
  text: string;
  angle: number | null;
}

export class RiftStory {
  closed = 0;
  entered = false;

  constructor(private readonly show: (v: VisionText) => void) {}

  /** The opening vision, for a new world only. */
  intro(): void {
    this.show(INTRO);
  }

  onEnter(): void {
    this.entered = true;
  }

  onClosed(): void {
    if (++this.closed === 1) this.show(FIRST_CLOSED);
  }

  /** The objective. `at` is the player's overworld spot; `rift` the nearest
   *  open rift loaded, if any; `run` the trip the player is on, if any. */
  objective(at: { x: number; y: number }, rift: { x: number; y: number } | null, run: RiftRunView | null): TrackerLine {
    if (run) {
      if (run.portalOpen) return { text: 'Close the rift: step through the portal', angle: null };
      return { text: `Survive ${run.name}: ${run.chambersDone}/${run.chambers} chambers`, angle: null };
    }
    const angle = rift ? Math.atan2(rift.y - at.y, rift.x - at.x) : null;
    if (this.closed > 0) return { text: `Rifts closed: ${this.closed}`, angle };
    if (rift && Math.hypot(rift.x - at.x, rift.y - at.y) < NEAR) return { text: 'Enter the rift', angle };
    return { text: 'Find a rift', angle };
  }

  save(): RiftStorySave {
    return { version: 1, closed: this.closed, entered: this.entered };
  }

  /** Missing (saves from before the rifts) starts at "Find a rift". */
  load(s: unknown): void {
    const save = s as Partial<RiftStorySave> | null | undefined;
    this.closed = typeof save?.closed === 'number' && Number.isFinite(save.closed) ? Math.max(0, Math.floor(save.closed)) : 0;
    this.entered = save?.entered === true;
  }
}
