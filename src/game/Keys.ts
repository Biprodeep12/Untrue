// Key bindings: each game action has a main key the player can change in
// Settings, plus fixed extras (arrow keys, numpad). Codes are physical keys
// (KeyboardEvent.code), so WASD sits in the same place on any layout.

export type Action =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'run'
  | 'attack'
  | 'block'
  | 'dodge'
  | 'interact'
  | 'use'
  | 'drop'
  | 'bag'
  | 'map'
  | 'zoomIn'
  | 'zoomOut';

/** The main key of each action; the player can change these. */
export const DEFAULT_KEYS: Record<Action, string> = {
  up: 'KeyW',
  down: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  run: 'ShiftLeft',
  attack: 'KeyJ',
  block: 'KeyK',
  dodge: 'Space',
  interact: 'KeyE',
  use: 'KeyF',
  drop: 'KeyQ',
  bag: 'Tab',
  map: 'KeyM',
  zoomIn: 'Equal',
  zoomOut: 'Minus',
};

/** Keys that always work too, whatever the main key is. */
const EXTRA_KEYS: Partial<Record<Action, string[]>> = {
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  run: ['ShiftRight'],
  bag: ['KeyI'],
  zoomIn: ['NumpadAdd'],
  zoomOut: ['NumpadSubtract'],
};

export const ACTION_LABELS: Record<Action, string> = {
  up: 'Move up',
  down: 'Move down',
  left: 'Move left',
  right: 'Move right',
  run: 'Run (hold)',
  attack: 'Attack',
  block: 'Block (hold)',
  dodge: 'Dodge roll',
  interact: 'Talk, gather, open, read',
  use: 'Use the selected item',
  drop: 'Drop the selected item',
  bag: 'Bag, crafting, quests',
  map: 'Map',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
};

/** Keys the game keeps for itself: they cannot be bound. */
export const RESERVED_KEYS = new Set(['Escape', 'F3', 'F4', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8']);

export type Bindings = Record<Action, string[]>;

/** Every key of every action: the main key (default or the player's) and the extras. */
export function bindings(custom: Partial<Record<Action, string>> = {}): Bindings {
  const out = {} as Bindings;
  for (const a of Object.keys(DEFAULT_KEYS) as Action[]) out[a] = [custom[a] ?? DEFAULT_KEYS[a], ...(EXTRA_KEYS[a] ?? [])];
  return out;
}

/** A key's name for the screen: KeyE → E, ShiftLeft → Shift. */
export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return `${code.slice(5)} arrow`;
  const names: Record<string, string> = {
    ShiftLeft: 'Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Alt',
    AltRight: 'Right Alt',
    Equal: '=',
    Minus: '−',
    Space: 'Space',
    Backquote: '`',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
  };
  return names[code] ?? code;
}
