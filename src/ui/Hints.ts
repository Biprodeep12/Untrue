// First-time tips: each shows once per browser, the first time it applies,
// so new players learn the game as they meet it.

const KEY = 'untrue.hints';

export class Hints {
  private readonly seen: Set<string>;

  constructor(private readonly show: (text: string) => void) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    } catch {
      // Storage blocked: tips show once per session instead.
    }
    this.seen = new Set(Array.isArray(ids) ? ids : []);
  }

  /** Shows the tip `id` if `when` holds and it was never shown. Returns whether it showed. */
  once(id: string, when: boolean, text: string): boolean {
    if (!when || this.seen.has(id)) return false;
    this.seen.add(id);
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.seen]));
    } catch {
      // Not kept; fine.
    }
    this.show(text);
    return true;
  }
}
