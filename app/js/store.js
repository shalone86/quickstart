// App data model on top of IndexedDB. Keeps notes, folders, tags and feeds in memory for instant
// lists and search; every write goes to IndexedDB first and then triggers sync.

import * as db from './db.js';
import { uid, Emitter, extForMime } from './util.js';
import { htmlToText, autoTitle } from './text.js';

export const events = new Emitter();

const state = {
  notes: new Map(),
  folders: new Map(),
  tags: new Map(),
  feeds: new Map(),
  attachments: new Map(),
  device: null,
  loaded: false,
};

export async function load() {
  const [notes, folders, tags, feeds, atts] = await Promise.all(['notes', 'folders', 'tags', 'feeds', 'attachments'].map((s) => db.getAll(s)));
  notes.forEach((n) => state.notes.set(n.id, n));
  folders.forEach((f) => state.folders.set(f.id, f));
  tags.forEach((t) => state.tags.set(t.id, t));
  feeds.forEach((f) => state.feeds.set(f.id, f));
  atts.forEach((a) => state.attachments.set(a.id, a));
  state.device = (await db.getMeta('device')) || null;
  if (!state.device) { state.device = uid('d'); await db.setMeta('device', state.device); }
  state.loaded = true;
}

export const deviceId = () => state.device;

/* ---------------- notes ---------------- */

export function allNotes({ includeDeleted = false } = {}) {
  const out = [];
  for (const n of state.notes.values()) if (includeDeleted ? true : !n.deleted) out.push(n);
  return out;
}

export const getNote = (id) => state.notes.get(id) || null;

export function sortNotes(notes, by = 'updated') {
  const cmp = {
    updated: (a, b) => b.updated - a.updated,
    created: (a, b) => b.created - a.created,
    title: (a, b) => (a.title || '').localeCompare(b.title || ''),
  }[by] || ((a, b) => b.updated - a.updated);
  return notes.sort(cmp);
}

export async function createNote(fields = {}) {
  const now = Date.now();
  const note = {
    id: uid('n'),
    html: '',
    text: '',
    title: '',
    titleManual: false,
    folderId: null,
    tags: [],
    pinned: false,
    bookmarked: false,
    created: now,
    updated: now,
    deleted: false,
    ...fields,
  };
  if (note.html && !note.text) note.text = htmlToText(note.html);
  if (!note.titleManual) note.title = autoTitle(note.text, note.created);
  state.notes.set(note.id, note);
  await db.put('notes', note);
  events.emit('notes', { type: 'create', note });
  return note;
}

/** Updates fields. Title regenerates automatically unless the user named the note. */
export async function updateNote(id, fields, { touch = true, silent = false } = {}) {
  const note = state.notes.get(id);
  if (!note) return null;
  Object.assign(note, fields);
  if ('html' in fields && !('text' in fields)) note.text = htmlToText(note.html);
  if (!note.titleManual && ('html' in fields || 'text' in fields || 'titleManual' in fields)) note.title = autoTitle(note.text, note.created);
  if (touch) note.updated = Date.now();
  await db.put('notes', note);
  if (!silent) events.emit('notes', { type: 'update', note, fields });
  return note;
}

export async function trashNote(id) {
  return updateNote(id, { trashed: Date.now(), pinned: false });
}

export async function restoreNote(id) {
  return updateNote(id, { trashed: null });
}

/** Permanent delete: becomes a tombstone so the deletion syncs everywhere. */
export async function deleteNoteForever(id) {
  const note = state.notes.get(id);
  if (!note) return;
  const tomb = { id, deleted: true, updated: Date.now(), created: note.created, title: note.title };
  state.notes.set(id, tomb);
  await db.put('notes', tomb);
  for (const a of state.attachments.values()) if (a.noteId === id && !a.deleted) await updateRecord('attachments', { ...a, deleted: true });
  events.emit('notes', { type: 'delete', note: tomb });
}

export const liveNotes = () => allNotes().filter((n) => !n.trashed);
export const trashedNotes = () => allNotes().filter((n) => n.trashed);

/** Notes that link to `id`. */
export function backlinks(id) {
  const needle = `data-note-id="${id}"`;
  return liveNotes().filter((n) => n.id !== id && n.html && n.html.includes(needle));
}

export function findNoteByTitle(title) {
  const t = String(title).trim().toLowerCase();
  return liveNotes().find((n) => (n.title || '').replace(/…$/, '').toLowerCase() === t) || null;
}

/* ---------------- folders & tags ---------------- */

export const folders = () => [...state.folders.values()].filter((f) => !f.deleted).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
export const getFolder = (id) => (id ? state.folders.get(id) || null : null);

export async function createFolder(name, extra = {}) {
  const now = Date.now();
  const f = { id: uid('f'), name: name.trim() || 'New folder', icon: extra.icon || '', order: folders().length, created: now, updated: now, deleted: false, ...extra };
  state.folders.set(f.id, f);
  await db.put('folders', f);
  events.emit('folders', { type: 'create', folder: f });
  return f;
}

export async function updateFolder(id, fields) {
  const f = state.folders.get(id);
  if (!f) return;
  Object.assign(f, fields, { updated: Date.now() });
  await db.put('folders', f);
  events.emit('folders', { type: 'update', folder: f });
}

export async function deleteFolder(id) {
  for (const n of liveNotes()) if (n.folderId === id) await updateNote(n.id, { folderId: null }, { touch: false });
  await updateFolder(id, { deleted: true });
}

export async function folderByName(name, create = true) {
  const f = folders().find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (f || !create) return f || null;
  return createFolder(name);
}

const TAG_COLORS = ['yellow', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green', 'gray'];
export const tagColors = TAG_COLORS;
export const tags = () => [...state.tags.values()].filter((t) => !t.deleted).sort((a, b) => a.name.localeCompare(b.name));
export const getTag = (id) => state.tags.get(id) || null;

export async function createTag(name, color) {
  const clean = name.trim().replace(/^#/, '');
  const existing = tags().find((t) => t.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const now = Date.now();
  const t = { id: uid('t'), name: clean, color: color || TAG_COLORS[tags().length % TAG_COLORS.length], created: now, updated: now, deleted: false };
  state.tags.set(t.id, t);
  await db.put('tags', t);
  events.emit('tags', { type: 'create', tag: t });
  return t;
}

export async function updateTag(id, fields) {
  const t = state.tags.get(id);
  if (!t) return;
  Object.assign(t, fields, { updated: Date.now() });
  await db.put('tags', t);
  events.emit('tags', { type: 'update', tag: t });
}

export async function deleteTag(id) {
  for (const n of liveNotes()) if (n.tags?.includes(id)) await updateNote(n.id, { tags: n.tags.filter((x) => x !== id) }, { touch: false });
  await updateTag(id, { deleted: true });
}

export const tagUsage = (id) => liveNotes().filter((n) => n.tags?.includes(id)).length;

/* ---------------- feeds ---------------- */

export const feeds = () => [...state.feeds.values()].filter((f) => !f.deleted);

export async function saveFeed(feed) {
  const now = Date.now();
  const f = { id: feed.id || uid('r'), created: now, deleted: false, ...feed, updated: now };
  state.feeds.set(f.id, f);
  await db.put('feeds', f);
  events.emit('feeds', { feed: f });
  return f;
}

/* ---------------- attachments ---------------- */

const urlCache = new Map();
const remoteFetchers = [];

/** Sync backends register a function that can fetch a missing blob by attachment meta. */
export function registerBlobFetcher(fn) { remoteFetchers.push(fn); }

export const getAttachment = (id) => state.attachments.get(id) || null;
export const attachmentsFor = (noteId) => [...state.attachments.values()].filter((a) => a.noteId === noteId && !a.deleted);

export async function addAttachment(blob, { kind, noteId = null, name = '', extra = {} } = {}) {
  const now = Date.now();
  const mime = (blob.type || 'application/octet-stream').split(';')[0];
  const att = {
    id: uid('a'), mime, ext: extForMime(mime), kind: kind || (mime.startsWith('image/') ? 'image' : mime.startsWith('audio/') ? 'audio' : 'file'),
    size: blob.size, name, noteId, created: now, updated: now, deleted: false, ...extra,
  };
  await db.putBlob(att.id, blob);
  state.attachments.set(att.id, att);
  await db.put('attachments', att);
  events.emit('attachments', { att });
  return att;
}

export async function updateAttachment(id, fields) {
  const a = state.attachments.get(id);
  if (!a) return;
  Object.assign(a, fields, { updated: Date.now() });
  await db.put('attachments', a);
}

export async function replaceAttachmentBlob(id, blob) {
  await db.putBlob(id, blob);
  const a = state.attachments.get(id);
  if (a) { a.size = blob.size; a.rev = (a.rev || 0) + 1; a.updated = Date.now(); a.uploaded = {}; await db.put('attachments', a); }
  const old = urlCache.get(id);
  if (old) { URL.revokeObjectURL(old); urlCache.delete(id); }
}

export async function getAttachmentBlob(id) {
  let blob = await db.getBlob(id);
  if (blob) return blob;
  const meta = state.attachments.get(id);
  for (const fetcher of remoteFetchers) {
    try {
      blob = await fetcher(meta || { id });
      if (blob) {
        if (meta?.mime && blob.type !== meta.mime) blob = new Blob([blob], { type: meta.mime });
        await db.putBlob(id, blob);
        return blob;
      }
    } catch (e) { console.warn('blob fetch failed', e); }
  }
  return null;
}

export async function attachmentURL(id) {
  if (urlCache.has(id)) return urlCache.get(id);
  const blob = await getAttachmentBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(id, url);
  return url;
}

/** Fills src of <img data-att> / <audio data-att> inside an element. */
export async function hydrateMedia(root) {
  const els = root.querySelectorAll('img[data-att], audio[data-att]');
  await Promise.all(Array.from(els).map(async (el) => {
    if (el.getAttribute('src')) return;
    const url = await attachmentURL(el.dataset.att);
    if (url) el.src = url;
    else el.classList.add('missing');
  }));
}

/* ---------------- generic (used by sync) ---------------- */

const STORE_MAP = { notes: state.notes, folders: state.folders, tags: state.tags, feeds: state.feeds, attachments: state.attachments };

export async function updateRecord(type, record) {
  if (STORE_MAP[type]) STORE_MAP[type].set(record.id, record);
  await db.put(type, record);
}

/** Applies records pulled from a backend. Last writer wins by `updated`. Returns count applied. */
export async function applyRemote(type, records) {
  const applied = [];
  for (const r of records) {
    if (!r || !r.id) continue;
    const local = type === 'history' ? await db.get('history', r.id) : (STORE_MAP[type]?.get(r.id) ?? await db.get(type, r.id));
    if (local && (local.updated || 0) >= (r.updated || 0)) continue;
    const rec = { ...r };
    delete rec._seq;
    if (type === 'attachments' && local) rec.uploaded = local.uploaded; // keep local upload markers
    if (type === 'attachments' && local && (local.rev || 0) !== (rec.rev || 0)) {
      await db.deleteBlob(rec.id);
      const old = urlCache.get(rec.id);
      if (old) { URL.revokeObjectURL(old); urlCache.delete(rec.id); }
    }
    if (type === 'notes' && local && !local.deleted && local.html !== rec.html) {
      events.emit('conflict', { local, remote: rec });
    }
    applied.push(rec);
    if (STORE_MAP[type]) STORE_MAP[type].set(rec.id, rec);
  }
  if (applied.length) {
    await db.putMany(type, applied);
    events.emit(type === 'history' ? 'history' : type, { type: 'remote', records: applied });
    events.emit('remote', { type, records: applied });
  }
  return applied.length;
}

export { db };
