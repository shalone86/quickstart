// Keystroke-level version history ("provenance").
//
// Every edit is stored as a tiny diff of the note's plain text:
//   [msSinceSessionStart, kind, position, deletedLength, insertedText]
// kinds: t typed · p pasted · r dropped · x cut · v dictated · a app/AI/import · u undo/redo/restore · e external (sync)
// Rich-text checkpoints (diffs of the HTML) are kept every ~20s so any moment can be restored with formatting.
// Sessions are synced like other records, so the log is backed up to GitHub/your server with timestamps.

import { uid } from './util.js';

export const KIND_LABEL = { t: 'Typed', p: 'Pasted', r: 'Dropped in', x: 'Cut', v: 'Dictated', a: 'Inserted by app', u: 'Undo / restore', e: 'Changed elsewhere', b: 'Existing text' };

/** Minimal diff: common prefix/suffix. Returns [pos, delLen, ins] or null when equal. */
export function diff(a, b) {
  if (a === b) return null;
  let s = 0;
  const min = Math.min(a.length, b.length);
  while (s < min && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a.charCodeAt(ea - 1) === b.charCodeAt(eb - 1)) { ea--; eb--; }
  return [s, ea - s, b.slice(s, eb)];
}

export function applyDiff(text, pos, del, ins) {
  return text.slice(0, pos) + ins + text.slice(pos + del);
}

export function newSession(noteId, device, text, html, now = Date.now()) {
  return { id: uid('h'), noteId, device, start: now, end: now, baseText: text, baseHtml: html, ops: [], cps: [], updated: now };
}

export class Recorder {
  /**
   * @param {object} o
   * @param {string} o.noteId
   * @param {string} o.device
   * @param {() => string} o.getText   current plain text
   * @param {() => string} o.getHtml   current html
   * @param {(session) => Promise} o.save persist a session
   */
  constructor(o) {
    Object.assign(this, o);
    this.session = null;
    this.lastText = o.initialText ?? o.getText();
    this.lastHtml = o.initialHtml ?? o.getHtml();
    this.cpHtml = this.lastHtml;
    this.pendingKind = null;
    this.lastEdit = 0;
    this.saveTimer = null;
  }

  /** The composer starts recording before its note exists; attach the id once it does. */
  setNoteId(id) {
    this.noteId = id;
    if (this.session) { this.session.noteId = id; this.scheduleSave(); }
  }

  /** Mark the next recorded change as coming from a specific source (paste, AI, dictation…). */
  mark(kind) { this.pendingKind = kind; }

  record(kind = 't') {
    const now = Date.now();
    const text = this.getText();
    if (this.pendingKind) { kind = this.pendingKind; this.pendingKind = null; }
    const d = diff(this.lastText, text);
    if (!d) { this.maybeCheckpoint(now, false); return; }
    if (!this.session || now - this.lastEdit > 5 * 60 * 1000) this.startSession(now);
    const dt = now - this.session.start;
    const ops = this.session.ops;
    const prev = ops[ops.length - 1];
    // Coalesce consecutive single-character typing within 1.5s into one op to keep logs compact
    // while still preserving per-word timing.
    if (prev && kind === 't' && prev[1] === 't' && prev[3] === 0 && d[1] === 0 && dt - prev[0] < 1500 &&
        d[0] === prev[2] + prev[4].length && prev[4].length < 24 && !/\s$/.test(prev[4])) {
      prev[4] += d[2];
      prev[5] = dt; // last keystroke time in this group
    } else {
      ops.push([dt, kind, d[0], d[1], d[2]]);
    }
    this.lastText = text;
    this.lastEdit = now;
    this.session.end = now;
    this.session.updated = now;
    this.maybeCheckpoint(now, false);
    this.scheduleSave();
  }

  startSession(now) {
    this.endSession();
    this.session = newSession(this.noteId, this.device, this.lastText, this.cpHtml, now);
    this.cpHtml = this.session.baseHtml;
    this.lastCp = now;
  }

  maybeCheckpoint(now, force) {
    if (!this.session) return;
    if (!force && now - (this.lastCp || 0) < 20000) return;
    const html = this.getHtml();
    const d = diff(this.cpHtml, html);
    if (d) {
      this.session.cps.push([now - this.session.start, ...d]);
      this.cpHtml = html;
      this.scheduleSave();
    }
    this.lastCp = now;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 1500);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    if (!this.session || !this.session.noteId) return;
    this.maybeCheckpoint(Date.now(), true);
    this.session.updated = Date.now();
    await this.save(this.session);
  }

  endSession() {
    if (this.session) { this.flush(); this.session = null; }
  }

  /** Sync the baseline after an outside change (sync, restore) so it is not attributed to typing. */
  resync(kind = 'e') {
    this.mark(kind);
    this.record(kind);
  }
}

/* ---------------- reconstruction ---------------- */

/** Expands sessions into an ordered list of events with absolute timestamps. */
export function timeline(sessions) {
  const sorted = [...sessions].filter((s) => !s.deleted).sort((a, b) => a.start - b.start);
  const events = [];
  for (const s of sorted) {
    events.push({ type: 'session', t: s.start, session: s });
    for (const op of s.ops) events.push({ type: 'op', t: s.start + (op[5] ?? op[0]), t0: s.start + op[0], session: s, op });
  }
  return events;
}

/**
 * Replays all sessions, tracking where every character came from.
 * Returns frames (text after each op) on demand via the callback, and final attribution.
 */
export function replay(sessions, onFrame) {
  const events = timeline(sessions);
  let text = '';
  let origin = ''; // one kind code per character
  let first = true;
  const stats = { typed: 0, pasted: 0, dropped: 0, dictated: 0, app: 0, deleted: 0, ops: 0, pastes: [], sessions: 0, activeMs: 0 };
  let lastT = null;
  for (const ev of events) {
    if (ev.type === 'session') {
      stats.sessions++;
      const base = ev.session.baseText;
      if (first) { text = base; origin = 'b'.repeat(base.length); first = false; }
      else if (base !== text) {
        const d = diff(text, base);
        if (d) { text = applyDiff(text, ...d); origin = applyDiff(origin, d[0], d[1], 'e'.repeat(d[2].length)); }
      }
      lastT = null;
      onFrame && onFrame({ t: ev.t, text, origin, kind: 's', session: ev.session });
      continue;
    }
    const [, kind, pos, del, ins] = ev.op;
    if (pos > text.length) continue; // corrupted op guard
    text = applyDiff(text, pos, del, ins);
    origin = applyDiff(origin, pos, del, kind.repeat(ins.length));
    stats.ops++;
    stats.deleted += del;
    if (kind === 't') stats.typed += ins.length;
    else if (kind === 'p') { stats.pasted += ins.length; stats.pastes.push({ t: ev.t, text: ins }); }
    else if (kind === 'r') { stats.dropped += ins.length; stats.pastes.push({ t: ev.t, text: ins, drop: true }); }
    else if (kind === 'v') stats.dictated += ins.length;
    else if (kind === 'a') stats.app += ins.length;
    if (lastT !== null) stats.activeMs += Math.min(ev.t - lastT, 30000);
    lastT = ev.t;
    onFrame && onFrame({ t: ev.t, text, origin, kind, op: ev.op, session: ev.session });
  }
  return { text, origin, stats, events };
}

/** Splits final text into runs of the same origin kind. */
export function segments(text, origin) {
  const segs = [];
  let i = 0;
  while (i < text.length) {
    const k = origin[i] || 'b';
    let j = i + 1;
    while (j < text.length && (origin[j] || 'b') === k) j++;
    segs.push({ kind: k, text: text.slice(i, j) });
    i = j;
  }
  return segs;
}

/** Rebuilds the rich HTML of a session at a given offset (ms since session start). */
export function htmlAt(session, dt = Infinity) {
  let html = session.baseHtml || '';
  for (const cp of session.cps || []) {
    if (cp[0] > dt) break;
    html = applyDiff(html, cp[1], cp[2], cp[3]);
  }
  return html;
}

/** Restorable versions: each rich checkpoint across sessions, newest first. */
export function versions(sessions) {
  const out = [];
  for (const s of [...sessions].filter((x) => !x.deleted).sort((a, b) => a.start - b.start)) {
    let html = s.baseHtml || '';
    out.push({ t: s.start, html, session: s, label: 'Session start' });
    for (const cp of s.cps || []) {
      html = applyDiff(html, cp[1], cp[2], cp[3]);
      out.push({ t: s.start + cp[0], html, session: s });
    }
  }
  return out.reverse();
}

/** History for content that arrived all at once (article, import, AI answer): one "inserted by app" op. */
export function importSession(noteId, device, text, html, kind = 'a', now = Date.now()) {
  const s = newSession(noteId, device, '', '', now);
  if (text) s.ops.push([0, kind, 0, 0, text]);
  if (html) s.cps.push([0, 0, 0, html]);
  return s;
}
