// Full-text search over notes. Supports "quoted phrases", #tag, folder:name, is:pinned / is:bookmarked.

import * as store from './store.js';
import { fold, tokenize } from './text.js';
import { esc } from './util.js';

export function parseQuery(q) {
  const out = { terms: [], phrases: [], tags: [], folder: null, flags: [] };
  const re = /"([^"]+)"|#(\S+)|folder:(\S+)|is:(\S+)|(\S+)/g;
  let m;
  while ((m = re.exec(q))) {
    if (m[1]) out.phrases.push(fold(m[1]));
    else if (m[2]) out.tags.push(fold(m[2]));
    else if (m[3]) out.folder = fold(m[3]);
    else if (m[4]) out.flags.push(m[4].toLowerCase());
    else out.terms.push(...tokenize(m[5]));
  }
  return out;
}

export function searchNotes(q, { limit = 200 } = {}) {
  const pq = parseQuery(q);
  if (!pq.terms.length && !pq.phrases.length && !pq.tags.length && !pq.folder && !pq.flags.length) return [];
  const results = [];
  for (const n of store.liveNotes()) {
    if (pq.flags.includes('pinned') && !n.pinned) continue;
    if (pq.flags.includes('bookmarked') && !n.bookmarked) continue;
    if (pq.folder) { const f = store.getFolder(n.folderId); if (!f || !fold(f.name).includes(pq.folder)) continue; }
    const tagNames = (n.tags || []).map((id) => fold(store.getTag(id)?.name || ''));
    if (pq.tags.length && !pq.tags.every((t) => tagNames.some((x) => x.startsWith(t)))) continue;
    const title = fold(n.title);
    const body = fold(n.text);
    let score = 0, ok = true;
    for (const ph of pq.phrases) { if (title.includes(ph)) score += 12; else if (body.includes(ph)) score += 5; else { ok = false; break; } }
    if (!ok) continue;
    for (const t of pq.terms) {
      const inTitle = title.includes(t);
      const inTags = tagNames.some((x) => x.includes(t));
      const inBody = body.includes(t);
      if (!inTitle && !inBody && !inTags) { ok = false; break; }
      score += (inTitle ? 10 : 0) + (inTags ? 6 : 0) + (inBody ? 2 + Math.min(4, body.split(t).length - 1) : 0);
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, 'u').test(title)) score += 4;
    }
    if (!ok) continue;
    score += n.pinned ? 2 : 0;
    score += Math.max(0, 3 - (Date.now() - n.updated) / (30 * 86400000));
    results.push({ note: n, score });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map((r) => r.note);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Snippet around the first match with <mark> highlighting (HTML-escaped). */
export function matchSnippet(text, q, len = 150) {
  const pq = parseQuery(q);
  const needles = [...pq.phrases, ...pq.terms].filter(Boolean);
  const src = String(text || '').replace(/\[(sketch|image|audio)\]/g, '').replace(/\s+/g, ' ');
  const f = fold(src);
  let idx = -1;
  for (const n of needles) { const i = f.indexOf(n); if (i >= 0 && (idx < 0 || i < idx)) idx = i; }
  let start = Math.max(0, idx - 40);
  if (start > 0) { const sp = src.indexOf(' ', start); if (sp > 0 && sp < idx) start = sp + 1; }
  const piece = src.slice(start, start + len);
  let html = esc(piece);
  for (const n of needles.sort((a, b) => b.length - a.length)) {
    if (n.length < 2 && needles.length > 1) continue;
    // fold-insensitive highlighting: map positions in folded string
    const fp = fold(piece);
    let out = '', i = 0, pos;
    const raw = piece;
    let last = 0;
    out = '';
    while ((pos = fp.indexOf(n, i)) >= 0) {
      out += esc(raw.slice(last, pos)) + '<mark>' + esc(raw.slice(pos, pos + n.length)) + '</mark>';
      last = pos + n.length;
      i = last;
    }
    if (last) { html = out + esc(raw.slice(last)); break; }
  }
  return (start > 0 ? '…' : '') + html + (start + len < src.length ? '…' : '');
}
