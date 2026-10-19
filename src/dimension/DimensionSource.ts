// Where dimensions' maps come from. The game asks a `DimensionSource` for a
// dimension by id and gets it decoded and checked (`decodeDimension`). Today
// that is `LocalDimensionSource`, which fetches the file shipped with the game
// (public/dimensions/<id>.json); a server-backed source is later work and only
// has to answer `load` the same way (its data refused just the same if bad).
//
// Loading starts early, when the player nears a rift (`preload`), so stepping
// through never waits; decoded maps are kept, so each one loads once.

import type { DimensionLayout } from './Dimension';
import { decodeDimension, DimensionDataError } from './DimensionData';

export interface DimensionSource {
  /** The dimension's map, decoded; rejects with a reason. */
  load(id: string): Promise<DimensionLayout>;
  /** The map file as loaded, once it has: players behind the same rift
   *  compare its hash, so everyone stands on the same land. */
  file?(id: string): string | undefined;
}

/** Larger than any map is allowed to be, so a bad answer cannot eat memory. */
const MAX_BYTES = 4 * 1024 * 1024;
/** A failed load is tried again after this many milliseconds, not sooner. */
const RETRY_MS = 5000;
/** A fetch that has not finished in this long is given up (and retried later). */
const FETCH_MS = 10_000;

/** `final`: the map itself is bad, so asking again this session would not help. */
type Entry = { layout: DimensionLayout } | { error: string; at: number; final: boolean } | { pending: Promise<DimensionLayout> };

/** Keeps what a source loaded, and remembers failures (until retried). */
export class DimensionCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly source: DimensionSource) {}

  /** The map if it has loaded, else null (and starts loading it). */
  get(id: string): DimensionLayout | null {
    const e = this.entries.get(id);
    if (e && 'layout' in e) return e.layout;
    this.preload(id);
    return null;
  }

  /** The map file as loaded (see `DimensionSource.file`). */
  file(id: string): string | undefined {
    return this.source.file?.(id);
  }

  /** Why it failed to load, if it did. */
  error(id: string): string | null {
    const e = this.entries.get(id);
    return e && 'error' in e ? e.error : null;
  }

  /** Starts loading, unless it is loaded or on its way. A failure to reach
   *  it is retried, but not more often than every few seconds; a map that
   *  was refused (bad data) is not asked for again this session. */
  preload(id: string): void {
    const e = this.entries.get(id);
    if (e && (!('error' in e) || e.final || Date.now() - e.at < RETRY_MS)) return;
    void this.load(id).catch(() => {});
  }

  load(id: string): Promise<DimensionLayout> {
    const e = this.entries.get(id);
    if (e && 'layout' in e) return Promise.resolve(e.layout);
    if (e && 'pending' in e) return e.pending;
    if (e && 'error' in e && e.final) return Promise.reject(new DimensionDataError(e.error));
    const pending = this.source.load(id).then(
      (layout) => {
        this.entries.set(id, { layout });
        return layout;
      },
      (err: unknown) => {
        this.entries.set(id, { error: err instanceof Error ? err.message : String(err), at: Date.now(), final: err instanceof DimensionDataError });
        throw err;
      },
    );
    this.entries.set(id, { pending });
    return pending;
  }
}

/** The maps shipped with the game, fetched from the same origin. */
export class LocalDimensionSource implements DimensionSource {
  private readonly files = new Map<string, string>();

  constructor(private readonly base = `${import.meta.env?.BASE_URL ?? './'}dimensions/`) {}

  file(id: string): string | undefined {
    return this.files.get(id);
  }

  async load(id: string): Promise<DimensionLayout> {
    if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new DimensionDataError(`bad dimension id "${id}"`);
    // A fetch that stalls is given up, so a later try can succeed.
    const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(FETCH_MS) : undefined;
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.base}${id}.json`, { credentials: 'same-origin', signal });
      if (!res.ok) throw new Error(`could not fetch the map (${res.status})`);
      // Refused before reading, when the size is known up front.
      const length = Number(res.headers.get('content-length'));
      if (length > MAX_BYTES) throw new DimensionDataError('the map is too large');
      text = await res.text();
    } catch (e) {
      if (e instanceof DimensionDataError) throw e;
      if (e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new Error('fetching the map took too long');
      throw e;
    }
    if (text.length > MAX_BYTES) throw new DimensionDataError('the map is too large');
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new DimensionDataError('the map is not valid JSON');
    }
    const layout = decodeDimension(data);
    this.files.set(id, text);
    return layout;
  }
}
