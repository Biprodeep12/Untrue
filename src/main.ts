// Pixi without runtime code generation, so the CSP needs no 'unsafe-eval'.
import 'pixi.js/unsafe-eval';
import { Game } from './game/Game';

const game = new Game();
game.start(document.getElementById('game')!, document.getElementById('ui')!).catch((e: unknown) => {
  // Most often: no WebGL. Say so instead of leaving a blank page.
  console.error(e);
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML = hasWebGL()
    ? '<h1>Untrue could not start</h1><p>Something went wrong while starting the game. Reloading the page usually fixes it.</p>'
    : '<h1>Untrue could not start</h1><p>This game needs a browser with WebGL turned on. Try an up-to-date Chrome, Edge, Firefox or Safari, and check that hardware acceleration is enabled.</p>';
  document.body.appendChild(box);
  document.getElementById('intro')?.remove();
});
function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

// Dev builds expose the game for poking at it from the console.
if (import.meta.env.DEV) Object.assign(window, { game });
