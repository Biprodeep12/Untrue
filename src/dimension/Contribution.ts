// Who did what in one run of a dimension, and what each is owed for it. A run
// may hold several players (a host feeds it every guest's hits, by player id);
// alone, the player is `LOCAL` and everything is theirs.
//
// Score: damage dealt to the Warden and its summons, point for point, and a
// fixed score for each trial broken, split among the players in its site when
// it broke. When the Warden falls the shares are settled: the vault's loot and
// coins go by share (whatever rounding leaves goes to the top scorer), the
// rift's experience goes by share with a floor for those who took part, and a
// player is attuned to the portal (it closes their rift) with a tenth of the
// score or a trial broken. Nothing here runs per frame but `damage`, which
// only adds to a map entry.

/** The player on this machine. */
export const LOCAL = 'local';
/** Score for breaking a trial, split among the players there. */
export const TRIAL_SCORE = 100;
/** Share of the score that attunes a player to the portal. */
export const ATTUNE_SHARE = 0.1;
/** Least share of the experience for an attuned player. */
export const XP_FLOOR = 0.25;

export interface ItemCount {
  item: string;
  count: number;
}

/** What one player is owed when the Warden falls. */
export interface Settlement {
  share: number;
  attuned: boolean;
  xp: number;
  items: ItemCount[];
}

export class Contribution {
  /** Score per player, in the order they joined. */
  private readonly scores = new Map<string, number>();
  /** Players who were there when a trial broke. */
  private readonly breakers = new Set<string>();
  private total = 0;

  /** A player is in the run; joining twice changes nothing. */
  join(player: string): void {
    if (!this.scores.has(player)) this.scores.set(player, 0);
  }

  /** The players who have taken part, in the order they joined. Leaving the
   *  run keeps a player's score, so their share is kept for the settling. */
  get players(): readonly string[] {
    return [...this.scores.keys()];
  }

  /** Damage dealt to the Warden or one of its summons. */
  damage(player: string, amount: number): void {
    if (!(amount > 0)) return;
    this.scores.set(player, (this.scores.get(player) ?? 0) + amount);
    this.total += amount;
  }

  /** A trial broke with these players in its site; nobody there scores nothing. */
  trial(present: readonly string[]): void {
    if (!present.length) return;
    const each = TRIAL_SCORE / present.length;
    for (const p of present) {
      this.breakers.add(p);
      this.damage(p, each);
    }
  }

  score(player: string): number {
    return this.scores.get(player) ?? 0;
  }

  /** A player's share of the score, 0–1. With no score at all (a run skipped
   *  through), everyone in it shares alike. */
  share(player: string): number {
    if (!this.scores.has(player)) return 0;
    if (this.total <= 0) return 1 / this.scores.size;
    return this.scores.get(player)! / this.total;
  }

  /** The portal answers this player: a tenth of the score, or a trial broken. */
  attuned(player: string): boolean {
    return this.breakers.has(player) || this.share(player) >= ATTUNE_SHARE - 1e-9;
  }

  /** What each player is owed of the vault's `items` and the rift's `xp`. */
  settle(items: readonly ItemCount[], xp: number): Map<string, Settlement> {
    const out = new Map<string, Settlement>();
    let top = '';
    let best = -1;
    for (const p of this.scores.keys()) {
      const share = this.share(p);
      const attuned = this.attuned(p);
      out.set(p, { share, attuned, xp: Math.round(xp * (attuned ? Math.max(share, XP_FLOOR) : share)), items: [] });
      if (share > best) {
        best = share;
        top = p;
      }
    }
    for (const { item, count } of items) {
      let given = 0;
      for (const [p, s] of out) {
        const n = Math.floor(count * this.share(p));
        if (n > 0) s.items.push({ item, count: n });
        given += n;
      }
      // What rounding leaves goes to the top scorer.
      const left = count - given;
      if (left > 0 && top) {
        const mine = out.get(top)!.items;
        const had = mine.find((i) => i.item === item);
        if (had) had.count += left;
        else mine.push({ item, count: left });
      }
    }
    return out;
  }

  /** The tally as it stands, for sharing: score and whether they broke a trial. */
  entries(): Array<{ player: string; score: number; breaker: boolean }> {
    return [...this.scores].map(([player, score]) => ({ player, score, breaker: this.breakers.has(player) }));
  }

  /** Takes on a tally kept elsewhere (a host that left), replacing this one. */
  restore(entries: ReadonlyArray<{ player: string; score: number; breaker: boolean }>): void {
    this.scores.clear();
    this.breakers.clear();
    this.total = 0;
    for (const e of entries) {
      const score = Number.isFinite(e.score) && e.score > 0 ? e.score : 0;
      this.scores.set(e.player, score);
      this.total += score;
      if (e.breaker) this.breakers.add(e.player);
    }
  }

  /** The Warden is back: a new fight, a new tally, kept to the players still
   *  here (`here`; everyone if not given), so it cannot grow without end. */
  reset(here?: Iterable<string>): void {
    const keep = here ? new Set(here) : null;
    for (const p of [...this.scores.keys()]) {
      if (keep && !keep.has(p)) this.scores.delete(p);
      else this.scores.set(p, 0);
    }
    this.breakers.clear();
    this.total = 0;
  }
}
