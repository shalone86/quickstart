// Search results page (live as you type).

import { searchNotes, matchSnippet } from '../search.js';
import { esc, debounce } from '../util.js';
import { icon } from '../icons.js';
import { noteRow, bindNoteActions, nav } from './common.js';
import { webSearchPanel } from './toolbar.js';
import { searchConfigured } from '../websearch.js';

export function renderSearch(root, params) {
  const q0 = params.get('q') || '';
  root.innerHTML = `
    <header class="page-head"><div><div class="eyebrow">Search</div><h1>Find anything</h1></div></header>
    <form class="search-bar big" role="search">${icon('search')}<input class="input" name="q" type="search" value="${esc(q0)}" placeholder="Words, &quot;exact phrase&quot;, #tag, folder:name, is:pinned" autocomplete="off" enterkeyhint="search"></form>
    <div class="search-results"></div>`;
  const input = root.querySelector('input');
  const out = root.querySelector('.search-results');
  const run = () => {
    const q = input.value.trim();
    history.replaceState(null, '', `#/search${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    if (!q) { out.innerHTML = '<p class="muted hint">Search titles, text, tags and folders. Try <code>#idea</code> or <code>"exact words"</code>.</p>'; return; }
    const res = searchNotes(q);
    out.innerHTML = `<p class="muted count">${res.length} note${res.length === 1 ? '' : 's'}</p>
      ${res.length ? `<div class="rows">${res.map((n) => noteRow(n, { snippetHTML: matchSnippet(n.text, q) })).join('')}</div>` : ''}
      <div class="search-web">
        <button class="btn" data-a="web">${icon('globe')} Search the web for “${esc(q)}”</button>
        <button class="btn ghost" data-a="ask">${icon('sparkles')} Ask AI about this</button>
      </div>`;
  };
  const deb = debounce(run, 120);
  input.addEventListener('input', deb);
  root.querySelector('form').onsubmit = (e) => { e.preventDefault(); run(); input.blur(); };
  out.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) return;
    if (b.dataset.a === 'web') { if (searchConfigured()) webSearchPanel(null, input.value.trim()); else webSearchPanel(null); }
    if (b.dataset.a === 'ask') nav(`#/ask?q=${encodeURIComponent(input.value.trim())}`);
  });
  bindNoteActions(root, run);
  run();
  setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 30);
  return () => deb.cancel();
}
