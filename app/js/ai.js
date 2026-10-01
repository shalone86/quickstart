// Ask questions about your notes (and optionally the open web) through your Worker/server.
// The API key lives only on the server; the app sends the question plus the most relevant notes.

import * as store from './store.js';
import { settings, apiBase, hasServer } from './settings.js';
import { tokenize, fold } from './text.js';
import { dayKey } from './util.js';

const STOP = new Set('a an and are as at be but by did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with you your about any all can could should would just also not no yes did ever'.split(' '));

/** Picks the notes most relevant to the question, within a character budget. */
export function selectNotes(question, { budget = 60000, focusId = null } = {}) {
  const terms = tokenize(question).filter((t) => !STOP.has(t) && t.length > 1);
  const notes = store.liveNotes();
  const now = Date.now();
  // date hints like "yesterday", "last week", "in March"
  const q = fold(question);
  const wantsRecent = /\b(today|yesterday|this week|last week|recent|lately)\b/.test(q);
  const scored = notes.map((n) => {
    const title = fold(n.title), body = fold(n.text);
    const tagNames = (n.tags || []).map((id) => fold(store.getTag(id)?.name || '')).join(' ');
    const folder = fold(store.getFolder(n.folderId)?.name || '');
    let s = 0;
    for (const t of terms) {
      if (title.includes(t)) s += 6;
      if (tagNames.includes(t) || folder.includes(t)) s += 4;
      const c = body.split(t).length - 1;
      if (c) s += 1 + Math.min(5, c);
    }
    const ageDays = (now - n.updated) / 86400000;
    s += wantsRecent ? Math.max(0, 6 - ageDays) : Math.max(0, 1 - ageDays / 60);
    if (n.pinned) s += 0.5;
    if (n.id === focusId) s += 1000;
    return { n, s };
  }).filter((x) => x.s > 0.2 || x.n.id === focusId).sort((a, b) => b.s - a.s);
  const picked = [];
  let used = 0;
  for (const { n } of scored) {
    const text = n.text.length > 12000 ? n.text.slice(0, 12000) + '\n[…truncated]' : n.text;
    if (used + text.length > budget && picked.length) break;
    picked.push(n);
    used += text.length;
  }
  return picked;
}

function packNote(n, full = true) {
  const tags = (n.tags || []).map((id) => store.getTag(id)?.name).filter(Boolean);
  const text = n.text.length > 12000 ? n.text.slice(0, 12000) + '\n[…truncated]' : n.text;
  return {
    id: n.id,
    title: n.title,
    created: new Date(n.created).toISOString(),
    updated: new Date(n.updated).toISOString(),
    folder: store.getFolder(n.folderId)?.name || '',
    tags,
    source: n.source?.url || '',
    ...(full ? { text } : {}),
  };
}

/**
 * Streams an answer. onEvent receives {type:'text', text} | {type:'source', title, url} | {type:'status', text}.
 * Returns { text, sources, notes } when done.
 */
export async function ask(question, { history = [], web, focusId = null, onEvent, signal } = {}) {
  if (!hasServer()) throw new Error('Ask AI runs through your Cloudflare Worker or home server — connect it in Settings → Sync.');
  const s = settings();
  const notes = selectNotes(question, { focusId });
  const index = store.sortNotes(store.liveNotes()).slice(0, 400).map((n) => `${dayKey(n.created)} · ${n.title}`);
  const body = {
    question,
    history: history.slice(-12),
    notes: notes.map((n) => packNote(n)),
    index,
    web: web ?? s.aiWeb,
    effort: s.aiEffort || 'medium',
    today: new Date().toString(),
  };
  const headers = { 'Content-Type': 'application/json' };
  if (s.serverToken) headers.Authorization = `Bearer ${s.serverToken}`;
  const res = await fetch(`${apiBase()}/api/ai`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '';
  const sources = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5)); } catch { continue; }
      if (ev.type === 'text') text += ev.text;
      if (ev.type === 'source' && !sources.some((x) => x.url === ev.url)) sources.push(ev);
      if (ev.type === 'error') throw new Error(ev.error);
      onEvent?.(ev);
    }
  }
  return { text, sources, notes };
}
