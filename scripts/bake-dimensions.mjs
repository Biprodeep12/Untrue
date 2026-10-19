// Bakes the outer dimensions' fixed maps into public/dimensions/<id>.json.
// Run by hand (npm run bake) when a map's design changes; the files it writes
// are committed, and are the maps everyone plays. The bakers are TypeScript
// in src/dimension/bake, loaded through Vite so they share the game's code.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const root = join(import.meta.dirname, '..');
const server = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { bakeHollow } = await server.ssrLoadModule('/src/dimension/bake/hollowMap.ts');
  const { bakeArchive } = await server.ssrLoadModule('/src/dimension/bake/archiveMap.ts');
  const { decodeDimension } = await server.ssrLoadModule('/src/dimension/DimensionData.ts');
  const out = join(root, 'public', 'dimensions');
  mkdirSync(out, { recursive: true });
  for (const [id, bake] of [['hollow', bakeHollow], ['archive', bakeArchive]]) {
    const file = bake();
    // What the game would refuse is never written.
    decodeDimension(file);
    const json = `${JSON.stringify(file)}\n`;
    writeFileSync(join(out, `${id}.json`), json);
    console.log(`${id}.json: ${(json.length / 1024).toFixed(1)} KB`);
  }
} finally {
  await server.close();
}
