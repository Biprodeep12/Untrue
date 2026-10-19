// Builds the static documentation site in docs-site/ from the Markdown in docs/.
// Run with `npm run docs`. The pages open straight from disk; no server needed.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs-site');
const SPEC = 'Endless 2D Procedural Survival Game Design Spec.md';

/** Sidebar groups, in reading order. `file` is relative to the repository root. */
const GROUPS = [
  { name: 'Start here', pages: [['docs/README.md', 'index'], [SPEC, 'design-spec']] },
  {
    name: 'Engine',
    pages: [
      ['docs/architecture.md', 'architecture'],
      ['docs/world-streaming.md', 'world-streaming'],
      ['docs/world-generation.md', 'world-generation'],
      ['docs/objects-and-structures.md', 'objects-and-structures'],
      ['docs/rendering.md', 'rendering'],
      ['docs/saves.md', 'saves'],
    ],
  },
  {
    name: 'Gameplay',
    pages: [
      ['docs/survival.md', 'survival'],
      ['docs/combat.md', 'combat'],
      ['docs/living-world.md', 'living-world'],
      ['docs/buildings-and-interiors.md', 'buildings-and-interiors'],
      ['docs/exploration.md', 'exploration'],
      ['docs/audio.md', 'audio'],
    ],
  },
  {
    name: 'Story',
    pages: [
      ['docs/story.md', 'story'],
      ['docs/dimensions.md', 'dimensions'],
    ],
  },
  {
    name: 'Multiplayer',
    pages: [
      ['docs/multiplayer-plan.md', 'multiplayer-plan'],
      ['docs/networking.md', 'networking'],
    ],
  },
];

const pages = GROUPS.flatMap((g) => g.pages.map(([file, slug]) => ({ file, slug, group: g.name })));
const bySource = new Map(pages.map((p) => [p.file.split('/').pop(), p.slug]));

/** GitHub-style heading anchors, so `combat.md#enemies` keeps working. */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Points Markdown links at the generated pages. */
function rewriteHref(href) {
  if (/^[a-z]+:/i.test(href) || href.startsWith('#')) return href;
  const [path, hash] = href.split('#');
  const file = decodeURIComponent(path).split('/').pop();
  const slug = bySource.get(file);
  if (!slug) return href;
  return `${slug}.html${hash ? `#${hash}` : ''}`;
}

const marked = new Marked({
  gfm: true,
  walkTokens(token) {
    if (token.type === 'link') token.href = rewriteHref(token.href);
  },
});

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Renders one page's Markdown, adding heading ids and wrapping tables to scroll. */
function render(md) {
  let html = marked.parse(md);
  const headings = [];
  const used = new Map();
  html = html.replace(/<h([1-4])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
    let id = slugify(inner);
    const n = used.get(id) ?? 0;
    used.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    if (level === '2' || level === '3') headings.push({ level: Number(level), id, text: stripTags(inner) });
    const anchor = level === '1' ? '' : `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`;
    return `<h${level} id="${id}">${inner}${anchor}</h${level}>`;
  });
  html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
  return { html, headings };
}

function sidebar(current) {
  return GROUPS.map(
    (g) => `<div class="nav-group"><h4>${escapeHtml(g.name)}</h4><ul>${g.pages
      .map(([, slug]) => {
        const p = pages.find((x) => x.slug === slug);
        return `<li><a href="${slug}.html"${slug === current ? ' class="current" aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`;
      })
      .join('')}</ul></div>`,
  ).join('');
}

function toc(headings) {
  if (headings.length < 2) return '';
  return `<nav class="toc" aria-label="On this page"><h4>On this page</h4><ul>${headings
    .map((h) => `<li class="l${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('')}</ul></nav>`;
}

function layout(page, prev, next) {
  const pager = `<nav class="pager">${prev ? `<a class="prev" href="${prev.slug}.html"><small>Previous</small>${escapeHtml(prev.title)}</a>` : '<span></span>'}${
    next ? `<a class="next" href="${next.slug}.html"><small>Next</small>${escapeHtml(next.title)}</a>` : ''
  }</nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)} · Untrue docs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Pixelify+Sans:wght@500;600&display=swap">
<link rel="stylesheet" href="style.css">
<script>try{var t=localStorage.getItem('untrue-docs-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}</script>
</head>
<body>
<header class="top">
  <button class="menu-toggle" aria-label="Open navigation">☰</button>
  <a class="brand" href="index.html"><span class="lantern" aria-hidden="true"></span>Untrue <small>Documentation</small></a>
  <div class="search"><input type="search" placeholder="Search the docs" aria-label="Search the docs"><div class="results" hidden></div></div>
  <button class="theme-toggle" aria-label="Toggle dark mode">◐</button>
</header>
<div class="shell">
  <aside class="sidebar">${sidebar(page.slug)}</aside>
  <main class="content">
    <p class="crumb">${escapeHtml(page.group)}</p>
    <article>${page.html}</article>
    ${pager}
  </main>
  ${toc(page.headings)}
</div>
<script src="search-index.js"></script>
<script src="site.js"></script>
</body>
</html>
`;
}

// Build ---------------------------------------------------------------------

for (const p of pages) {
  const md = readFileSync(join(root, p.file), 'utf8');
  const { html, headings } = render(md);
  p.html = html;
  p.headings = headings;
  p.title = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? p.slug).replace(/#$/, '');
  if (p.slug === 'index') p.title = 'Overview';
  if (p.slug === 'design-spec') p.title = 'Design spec';
  // Index the words, not the heading link icons.
  p.text = stripTags(html.replace(/<a class="anchor"[^>]*>#<\/a>/g, ' ')).replace(/\s+/g, ' ');
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
pages.forEach((p, i) => writeFileSync(join(out, `${p.slug}.html`), layout(p, pages[i - 1], pages[i + 1])));

const index = pages.map((p) => ({ slug: p.slug, title: p.title, group: p.group, headings: p.headings, text: p.text }));
writeFileSync(join(out, 'search-index.js'), `window.DOCS_INDEX = ${JSON.stringify(index)};\n`);
writeFileSync(join(out, 'style.css'), readFileSync(join(root, 'scripts', 'docs-assets', 'style.css'), 'utf8'));
writeFileSync(join(out, 'site.js'), readFileSync(join(root, 'scripts', 'docs-assets', 'site.js'), 'utf8'));
// The architecture, infrastructure and story overview: a page of its own, linked from the docs.
writeFileSync(join(out, 'overview-diagram.html'), readFileSync(join(root, 'docs', 'overview-diagram.html'), 'utf8'));
console.log(`Built ${pages.length} pages into docs-site/`);
