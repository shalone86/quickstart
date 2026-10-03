#!/usr/bin/env node
// Scriptorium home server — the same API as the Cloudflare Worker, for your own machine/NAS.
// Zero dependencies except @anthropic-ai/sdk (only needed for Ask AI).
//
//   APP_TOKEN=some-long-secret node server/server.js
//
// Env: PORT (8787), DATA_DIR (server/data), APP_TOKEN (required), ANTHROPIC_API_KEY or AI_URL + AI_API_KEY (Ollama / Open WebUI), AI_MODEL,
//      SEARXNG_URL, WHISPER_URL (OpenAI-compatible, e.g. http://localhost:8000 for faster-whisper-server/speaches),
//      WHISPER_MODEL, PUBLIC_URL (for share links), ALLOW_PRIVATE_FETCH=1 (let /api/fetch reach your LAN)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const DATA = path.resolve(process.env.DATA_DIR || path.join(here, 'data'));
const APP_DIR = path.resolve(here, '..', 'app');
const TOKEN = process.env.APP_TOKEN || '';
const VERSION = '1.0.0';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

if (!TOKEN) { console.error('Set APP_TOKEN (a long random secret) before starting the server.'); process.exit(1); }
for (const d of ['blobs', 'shares', 'backups']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

/* ---------------- record store (JSON file, written atomically) ---------------- */

const DB_FILE = path.join(DATA, 'records.json');
let db = { seq: 0, records: {} }; // records["type:id"] = { type, id, updated, deleted, data, seq }
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* fresh */ }
let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db));
    await fsp.rename(tmp, DB_FILE);
  }, 300);
}

const TYPES = new Set(['notes', 'folders', 'tags', 'attachments', 'history', 'feeds']);
function upsert(r) {
  if (!TYPES.has(r.type) || !r.id || typeof r.data !== 'string') return;
  const key = `${r.type}:${r.id}`;
  const cur = db.records[key];
  if (cur && cur.updated >= (Number(r.updated) || 0)) return;
  db.seq += 1;
  db.records[key] = { type: r.type, id: String(r.id), updated: Number(r.updated) || 0, deleted: r.deleted ? 1 : 0, data: r.data, seq: db.seq };
}

/* ---------------- helpers ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...CORS, ...headers });
  res.end(body);
}
const json = (res, data, status = 200) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json' });
const fail = (res, status, error) => json(res, { error }, status);

function authorized(req) {
  const h = req.headers.authorization || '';
  const t = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
  const k = Buffer.from(TOKEN);
  return t.length === k.length && crypto.timingSafeEqual(t, k);
}

async function readBody(req, limit = 110 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}
const readJSON = async (req) => JSON.parse((await readBody(req, 50 * 1024 * 1024)).toString('utf8') || '{}');

async function isPrivate(hostname) {
  if (process.env.ALLOW_PRIVATE_FETCH) return false;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) return true;
  let addrs = [];
  try { addrs = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map((a) => a.address); } catch { return false; }
  return addrs.some((a) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|::1$|fc|fd|fe80)/i.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

async function serveStatic(req, res, pathname) {
  let p = decodeURIComponent(pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(APP_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(APP_DIR)) return send(res, 403, 'Forbidden');
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  } catch { send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
}

/* ---------------- handlers ---------------- */

async function handleSync(req, res) {
  const body = await readJSON(req);
  for (const r of (Array.isArray(body.records) ? body.records : []).slice(0, 1000)) upsert(r);
  if (body.records?.length) persist();
  if (body.since === undefined || body.since === null) return json(res, { ok: true });
  const since = Number(body.since) || 0;
  const all = Object.values(db.records).filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
  const page = all.slice(0, 400);
  const cursor = page.length ? page[page.length - 1].seq : since;
  json(res, { records: page.map(({ seq, ...r }) => r), cursor, more: all.length > page.length });
}

async function handleBlob(req, res, id) {
  if (!/^[\w-]{1,80}$/.test(id)) return fail(res, 400, 'bad id');
  const file = path.join(DATA, 'blobs', id);
  if (req.method === 'PUT') {
    const buf = await readBody(req);
    await fsp.writeFile(file, buf);
    await fsp.writeFile(`${file}.type`, req.headers['content-type'] || 'application/octet-stream');
    return json(res, { ok: true });
  }
  try {
    const [buf, type] = await Promise.all([fsp.readFile(file), fsp.readFile(`${file}.type`, 'utf8').catch(() => 'application/octet-stream')]);
    send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' });
  } catch { fail(res, 404, 'not found'); }
}

async function handleFetch(res, url) {
  let u;
  try { u = new URL(url.searchParams.get('url')); } catch { return fail(res, 400, 'bad url'); }
  if (!/^https?:$/.test(u.protocol)) return fail(res, 400, 'bad url');
  if (await isPrivate(u.hostname)) return fail(res, 403, 'Private network addresses are blocked (set ALLOW_PRIVATE_FETCH=1 to allow)');
  const r = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) return fail(res, 502, `The site answered ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) return fail(res, 413, 'Too large');
  const ct = r.headers.get('content-type') || 'application/octet-stream';
  if (url.searchParams.get('binary')) return send(res, 200, buf, { 'Content-Type': ct });
  let charset = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!charset) charset = (buf.subarray(0, 2048).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  let text;
  try { text = new TextDecoder(charset).decode(buf); } catch { text = buf.toString('utf8'); }
  send(res, 200, text, { 'Content-Type': ct.includes('xml') ? 'text/xml; charset=utf-8' : 'text/plain; charset=utf-8', 'X-Final-Url': r.url });
}

async function handleSearch(res, url) {
  const inst = (url.searchParams.get('instance') || process.env.SEARXNG_URL || '').replace(/\/+$/, '');
  if (!inst) return fail(res, 400, 'No SearXNG instance configured.');
  const r = await fetch(`${inst}/search?q=${encodeURIComponent(url.searchParams.get('q') || '')}&format=json&pageno=${encodeURIComponent(url.searchParams.get('page') || '1')}`, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return fail(res, 502, `SearXNG answered ${r.status}. Is the JSON format enabled?`);
  send(res, 200, await r.text(), { 'Content-Type': 'application/json' });
}

async function handleTranscribe(req, res) {
  const base = process.env.WHISPER_URL;
  if (!base) return fail(res, 501, 'Set WHISPER_URL to an OpenAI-compatible transcription server (e.g. faster-whisper-server) to enable this.');
  const { audio, mime } = await readJSON(req);
  const form = new FormData();
  const ext = (mime || '').includes('mp4') ? 'm4a' : (mime || '').includes('ogg') ? 'ogg' : 'webm';
  form.append('file', new Blob([Buffer.from(audio, 'base64')], { type: mime || 'audio/webm' }), `voice.${ext}`);
  form.append('model', process.env.WHISPER_MODEL || 'Systran/faster-whisper-small');
  const headers = process.env.WHISPER_API_KEY ? { Authorization: `Bearer ${process.env.WHISPER_API_KEY}` } : {};
  const r = await fetch(`${base.replace(/\/+$/, '')}/v1/audio/transcriptions`, { method: 'POST', body: form, headers });
  if (!r.ok) return fail(res, 502, `Transcriber answered ${r.status}`);
  const j = await r.json();
  json(res, { text: j.text || '' });
}

async function handleAI(req, res) {
  const body = await readJSON(req);
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const sendEv = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  try {
    const { answer } = await import('../worker/src/ai.js');
    await answer(body, { apiKey: process.env.ANTHROPIC_API_KEY, aiUrl: process.env.AI_URL, aiKey: process.env.AI_API_KEY, searxng: process.env.SEARXNG_URL, model: process.env.AI_MODEL, send: sendEv });
  } catch (e) {
    sendEv({ type: 'error', error: e.code === 'ERR_MODULE_NOT_FOUND' ? 'Run `npm install` in the project folder to enable Ask AI.' : e.message });
  }
  res.end();
}

async function handleShare(req, res, url, id) {
  if (req.method === 'DELETE') { await fsp.rm(path.join(DATA, 'shares', `${id}.html`), { force: true }); return json(res, { ok: true }); }
  const { id: existing, html } = await readJSON(req);
  if (!html) return fail(res, 400, 'no content');
  const sid = existing && /^[a-z0-9]{8,32}$/.test(existing) ? existing : Array.from(crypto.randomBytes(12), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  await fsp.writeFile(path.join(DATA, 'shares', `${sid}.html`), html);
  const origin = process.env.PUBLIC_URL || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  json(res, { id: sid, url: `${origin.replace(/\/+$/, '')}/s/${sid}` });
}

async function viewShare(res, id) {
  if (!/^[a-z0-9]{8,32}$/.test(id)) return send(res, 404, 'Not found');
  try {
    const html = await fsp.readFile(path.join(DATA, 'shares', `${id}.html`));
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; img-src data: https:; media-src data:; style-src 'unsafe-inline'", 'X-Robots-Tag': 'noindex' });
  } catch { send(res, 404, 'This shared note was removed or never existed.', { 'Content-Type': 'text/plain; charset=utf-8' }); }
}

/* nightly backup */
async function backup() {
  const day = new Date().toISOString().slice(0, 10);
  const gz = zlib.gzipSync(JSON.stringify({ app: 'scriptorium', exported: new Date().toISOString(), records: Object.values(db.records) }));
  await fsp.writeFile(path.join(DATA, 'backups', `${day}.json.gz`), gz);
  const files = (await fsp.readdir(path.join(DATA, 'backups'))).sort();
  for (const f of files.slice(0, -60)) await fsp.rm(path.join(DATA, 'backups', f));
}
setInterval(() => backup().catch((e) => console.error('backup failed', e)), 24 * 3600 * 1000).unref();

/* ---------------- server ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p.startsWith('/s/')) return await viewShare(res, p.slice(3));
    if (!p.startsWith('/api/')) return await serveStatic(req, res, p);
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (!authorized(req)) return fail(res, 401, 'Wrong access token');
    if (p === '/api/health') return json(res, { ok: true, name: 'Scriptorium home server', version: VERSION, storage: `files in ${DATA}`, ai: !!(process.env.AI_URL || process.env.ANTHROPIC_API_KEY), transcribe: !!process.env.WHISPER_URL });
    if (p === '/api/sync' && req.method === 'POST') return await handleSync(req, res);
    if (p.startsWith('/api/blob/')) return await handleBlob(req, res, decodeURIComponent(p.slice(10)));
    if (p === '/api/fetch') return await handleFetch(res, url);
    if (p === '/api/search') return await handleSearch(res, url);
    if (p === '/api/transcribe' && req.method === 'POST') return await handleTranscribe(req, res);
    if (p === '/api/ai' && req.method === 'POST') return await handleAI(req, res);
    if (p === '/api/share' && req.method === 'POST') return await handleShare(req, res, url);
    if (p.startsWith('/api/share/') && req.method === 'DELETE') return await handleShare(req, res, url, p.slice(11));
    if (p === '/api/backup' && req.method === 'POST') { await backup(); return json(res, { ok: true }); }
    fail(res, 404, 'unknown endpoint');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.message || String(e)); else res.end();
  }
});

server.listen(PORT, () => console.log(`Scriptorium server on http://localhost:${PORT} (data: ${DATA})`));
process.on('SIGTERM', async () => { clearTimeout(saveTimer); await fsp.writeFile(DB_FILE, JSON.stringify(db)); process.exit(0); });
