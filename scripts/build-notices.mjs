// Writes public/THIRD_PARTY_NOTICES.txt: the license of every package shipped
// in the game (the runtime dependencies and theirs, not type-only packages).
// Runs before each build, so the notices follow the lockfile.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
const app = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const seen = new Map();
const walk = (name) => {
  const entry = lock[`node_modules/${name}`];
  if (!entry || seen.has(name)) return;
  seen.set(name, entry);
  for (const dep of Object.keys(entry.dependencies ?? {})) walk(dep);
};
for (const name of Object.keys(app.dependencies)) walk(name);

const parts = [];
for (const [name, entry] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
  // Type declarations are never shipped.
  if (name.startsWith('@types/') || name.endsWith('/types')) continue;
  const dir = join(root, 'node_modules', name);
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${entry.license}`;
  parts.push(`${name} ${entry.version} (${entry.license})\n${'-'.repeat(60)}\n${text}`);
}

const head = `Untrue uses the following open source software. Their licenses follow.\n\n${'='.repeat(60)}\n\n`;
writeFileSync(join(root, 'public', 'THIRD_PARTY_NOTICES.txt'), head + parts.join(`\n\n${'='.repeat(60)}\n\n`) + '\n');
console.log(`Wrote notices for ${parts.length} packages.`);
