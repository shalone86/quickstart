// Text utilities: plain-text extraction, automatic titles, snippets.

const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'UL', 'OL', 'TR', 'HR', 'SECTION', 'ARTICLE']);

/**
 * Deterministic plain text for a DOM subtree: blocks become lines.
 * Used for titles, search, word counts and keystroke history (so it must be stable).
 */
export function nodeText(root) {
  let out = '';
  const walk = (node) => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/​/g, ''); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') { out += '\n'; continue; }
      if (tag === 'IMG') { out += n.dataset.sketch ? '[sketch]' : '[image]'; continue; }
      if (tag === 'AUDIO' || n.classList?.contains('audio-block')) { out += '[audio]'; if (n.classList?.contains('audio-block')) { if (!out.endsWith('\n')) out += '\n'; continue; } continue; }
      if (tag === 'SCRIPT' || tag === 'STYLE' || n.dataset?.noText) continue;
      const block = BLOCK.has(tag);
      if (block && out && !out.endsWith('\n')) out += '\n';
      walk(n);
      if (block && !out.endsWith('\n')) out += '\n';
    }
  };
  walk(root);
  return out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

let scratch = null;
export function htmlToText(html) {
  if (!scratch) scratch = document.createElement('template');
  scratch.innerHTML = html || '';
  return nodeText(scratch.content);
}

/**
 * Automatic title: first meaningful line, trimmed to a natural length.
 * Falls back to a kind label (sketch / image / voice note) plus the date.
 */
export function autoTitle(text, created = Date.now()) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => !/^\[(sketch|image|audio)\]$/.test(l));
  if (first) {
    let t = first.replace(/^[#>*\-\s\d.)[\]]+/, '').replace(/\[(sketch|image|audio)\]/g, '').trim();
    if (!t) t = first;
    if (t.length > 60) {
      const cut = t.slice(0, 60);
      const sp = cut.lastIndexOf(' ');
      t = (sp > 25 ? cut.slice(0, sp) : cut).replace(/[,;:\-–—]+$/, '') + '…';
    }
    return t;
  }
  const date = new Date(created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (/\[sketch\]/.test(text)) return `Sketch · ${date}`;
  if (/\[audio\]/.test(text)) return `Voice note · ${date}`;
  if (/\[image\]/.test(text)) return `Image · ${date}`;
  return 'New note';
}

/** Body snippet: text after the title line. */
export function snippet(text, title, max = 160) {
  let t = String(text || '');
  const firstNl = t.indexOf('\n');
  const firstLine = (firstNl < 0 ? t : t.slice(0, firstNl)).trim();
  if (title && title.replace(/…$/, '') && firstLine.startsWith(title.replace(/…$/, ''))) t = firstNl < 0 ? '' : t.slice(firstNl + 1);
  t = t.replace(/\[(sketch|image|audio)\]/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t;
}

export function wordCount(text) {
  const m = String(text || '').match(/[\p{L}\p{N}'’]+/gu);
  return m ? m.length : 0;
}

/** Lowercased, accent-folded tokens for search. */
export function tokenize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) || [];
}

export function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
