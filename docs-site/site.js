// Documentation site behaviour: search, mobile navigation, theme toggle and
// highlighting the current section in "On this page".

(function () {
  var index = window.DOCS_INDEX || [];
  var input = document.querySelector('.search input');
  var results = document.querySelector('.search .results');

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function snippet(text, q) {
    var i = text.toLowerCase().indexOf(q);
    if (i < 0) return '';
    var start = Math.max(0, i - 50);
    var s = (start ? '…' : '') + text.slice(start, i + q.length + 70) + '…';
    var re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    return escapeHtml(s).replace(re, '<mark>$1</mark>');
  }

  function search(q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) {
      results.hidden = true;
      return;
    }
    var hits = [];
    index.forEach(function (p) {
      p.headings.forEach(function (h) {
        if (h.text.toLowerCase().indexOf(q) >= 0) hits.push({ score: 3, href: p.slug + '.html#' + h.id, title: h.text, where: p.title, body: '' });
      });
      if (p.title.toLowerCase().indexOf(q) >= 0) hits.push({ score: 4, href: p.slug + '.html', title: p.title, where: p.group, body: '' });
      var s = snippet(p.text, q);
      if (s) hits.push({ score: 1, href: p.slug + '.html', title: p.title, where: p.group, body: s });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    results.innerHTML = hits.length
      ? hits.slice(0, 12).map(function (h) {
          return '<a href="' + h.href + '"><b>' + escapeHtml(h.title) + '</b><small>' + escapeHtml(h.where) + '</small>' + (h.body ? '<span>' + h.body + '</span>' : '') + '</a>';
        }).join('')
      : '<p class="none">Nothing found.</p>';
    results.hidden = false;
  }

  if (input) {
    input.addEventListener('input', function () { search(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; results.hidden = true; }
      if (e.key === 'Enter') { var first = results.querySelector('a'); if (first) location.href = first.href; }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.search')) results.hidden = true;
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); }
    });
  }

  var toggle = document.querySelector('.menu-toggle');
  if (toggle) toggle.addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
  document.querySelectorAll('.sidebar a').forEach(function (a) {
    a.addEventListener('click', function () { document.body.classList.remove('nav-open'); });
  });

  var theme = document.querySelector('.theme-toggle');
  if (theme) theme.addEventListener('click', function () {
    var root = document.documentElement;
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('untrue-docs-theme', root.dataset.theme); } catch (e) {}
  });

  // Highlight the section being read.
  var links = document.querySelectorAll('.toc a');
  if (links.length && 'IntersectionObserver' in window) {
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('href').slice(1)] = a; });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('active'); });
        var a = map[e.target.id];
        if (a) a.classList.add('active');
      });
    }, { rootMargin: '0px 0px -70% 0px' });
    document.querySelectorAll('article h2[id], article h3[id]').forEach(function (h) { observer.observe(h); });
  }
})();
