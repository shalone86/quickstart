// Small shared helpers. No DOM-heavy code here so it can be unit-tested in Node.

export function uid(prefix = '') {
  const t = Date.now().toString(36);
  const r = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join('');
  return prefix + t + r;
}

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { if (timer) { clearTimeout(timer); timer = null; fn(...args); } };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

export function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  return (...args) => {
    const now = Date.now();
    pending = args;
    if (now - last >= ms) { last = now; fn(...args); pending = null; }
    else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); if (pending) fn(...pending); pending = null; }, ms - (now - last));
    }
  };
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const pad2 = (n) => String(n).padStart(2, '0');

/** Local calendar day key, e.g. 2026-10-01. */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function fmtDate(ts, opts = {}) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...opts });
}

export function fmtDateTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** "Today", "Yesterday", weekday within a week, else a date. */
export function fmtRelative(ts, now = Date.now()) {
  const k = dayKey(ts);
  if (k === dayKey(now)) return fmtTime(ts);
  if (k === dayKey(now - 86400000)) return 'Yesterday';
  if (now - ts < 6 * 86400000) return new Date(ts).toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return fmtDate(ts, sameYear ? { year: undefined } : {});
}

/** Section heading used by note lists (Apple Notes style). */
export function dateGroup(ts, now = Date.now()) {
  const k = dayKey(ts);
  if (k === dayKey(now)) return 'Today';
  if (k === dayKey(now - 86400000)) return 'Yesterday';
  if (now - ts < 7 * 86400000) return 'Previous 7 days';
  if (now - ts < 30 * 86400000) return 'Previous 30 days';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** File-system safe name (also used for Obsidian filenames). */
export function safeFileName(s, fallback = 'Untitled') {
  const out = String(s || '').replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/^\.+/, '');
  return out || fallback;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function base64ToBlob(b64, type = 'application/octet-stream') {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export const extForMime = (mime) => ({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'application/json': 'json', 'application/pdf': 'pdf',
}[String(mime).split(';')[0]] || 'bin');

export const mimeForExt = (ext) => ({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
  webm: 'audio/webm', m4a: 'audio/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', json: 'application/json', pdf: 'application/pdf',
}[String(ext).toLowerCase()] || 'application/octet-stream');

/** Simple event emitter. */
export class Emitter {
  constructor() { this.map = new Map(); }
  on(ev, fn) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev).add(fn);
    return () => this.map.get(ev)?.delete(fn);
  }
  emit(ev, data) { this.map.get(ev)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isUrl(s) {
  try { const u = new URL(String(s).trim()); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}
