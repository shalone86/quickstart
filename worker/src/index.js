// Scriptorium Cloudflare Worker: serves the app and provides sync (D1), file storage and
// nightly backups (R2), transcription (Workers AI Whisper), AI answers (Claude), web fetch for
// articles/feeds, SearXNG proxy, and public share links.

import { answerResponse } from './ai.js';

const VERSION = '1.0.0';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS records (type TEXT NOT NULL, id TEXT NOT NULL, updated INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (type, id))`,
  `CREATE INDEX IF NOT EXISTS records_seq ON records(seq)`,
];
let schemaReady = false;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const fail = (status, error) => json({ error }, status);

function authorized(req, env) {
  if (!env.APP_TOKEN) return false;
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token.length !== env.APP_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ env.APP_TOKEN.charCodeAt(i);
  return diff === 0;
}

async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

/* ---------------- sync ---------------- */

async function sync(req, env) {
  await ensureSchema(env);
  const body = await req.json();
  const records = Array.isArray(body.records) ? body.records : [];
  if (records.length) {
    const stmt = env.DB.prepare(`INSERT INTO records (type, id, updated, deleted, data, seq)
      VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records))
      ON CONFLICT(type, id) DO UPDATE SET updated = excluded.updated, deleted = excluded.deleted, data = excluded.data, seq = excluded.seq
      WHERE excluded.updated > records.updated`);
    const ok = new Set(['notes', 'folders', 'tags', 'attachments', 'history', 'feeds']);
    const batch = records.filter((r) => ok.has(r.type) && r.id && typeof r.data === 'string').slice(0, 500)
      .map((r) => stmt.bind(r.type, String(r.id), Number(r.updated) || 0, r.deleted ? 1 : 0, r.data));
    if (batch.length) await env.DB.batch(batch);
  }
  if (body.since === undefined || body.since === null) return json({ ok: true });
  const since = Number(body.since) || 0;
  const limit = 400;
  const { results } = await env.DB.prepare('SELECT type, id, updated, deleted, data, seq FROM records WHERE seq > ?1 ORDER BY seq LIMIT ?2').bind(since, limit).all();
  const cursor = results.length ? results[results.length - 1].seq : since;
  return json({ records: results.map(({ seq, ...r }) => r), cursor, more: results.length === limit });
}

/* ---------------- blobs ---------------- */

async function blob(req, env, id) {
  if (!/^[\w-]{1,80}$/.test(id)) return fail(400, 'bad id');
  const key = `blobs/${id}`;
  if (req.method === 'PUT') {
    const len = Number(req.headers.get('Content-Length') || 0);
    if (len > 100 * 1024 * 1024) return fail(413, 'File too large');
    await env.BUCKET.put(key, await req.arrayBuffer(), { httpMetadata: { contentType: req.headers.get('Content-Type') || 'application/octet-stream' } });
    return json({ ok: true });
  }
  const obj = await env.BUCKET.get(key);
  if (!obj) return fail(404, 'not found');
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream', 'Cache-Control': 'private, max-age=31536000, immutable', ...CORS } });
}

/* ---------------- fetch proxy (articles, feeds, images) ---------------- */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

async function proxyFetch(url) {
  const target = url.searchParams.get('url');
  let u;
  try { u = new URL(target); } catch { return fail(400, 'bad url'); }
  if (!/^https?:$/.test(u.protocol)) return fail(400, 'bad url');
  const res = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: url.searchParams.get('binary') ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', cf: { cacheTtl: 300 } });
  if (!res.ok) return fail(502, `The site answered ${res.status}`);
  const headers = { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'X-Final-Url': res.url, ...CORS };
  if (url.searchParams.get('binary')) return new Response(res.body, { headers });
  // text: make sure non-UTF-8 pages decode properly
  const buf = await res.arrayBuffer();
  if (buf.byteLength > 15 * 1024 * 1024) return fail(413, 'Page too large');
  const ct = headers['Content-Type'];
  let charset = (ct.match(/charset=([\w-]+)/i) || [])[1];
  if (!charset) { const head = new TextDecoder('latin1').decode(buf.slice(0, 2048)); charset = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8'; }
  let text;
  try { text = new TextDecoder(charset).decode(buf); } catch { text = new TextDecoder().decode(buf); }
  return new Response(text, { headers: { ...headers, 'Content-Type': ct.includes('xml') ? 'text/xml; charset=utf-8' : 'text/plain; charset=utf-8' } });
}

async function search(url, env) {
  const inst = (url.searchParams.get('instance') || env.SEARXNG_URL || '').replace(/\/+$/, '');
  if (!inst) return fail(400, 'No SearXNG instance configured. Add it in the app settings or set SEARXNG_URL.');
  const q = url.searchParams.get('q') || '';
  const page = url.searchParams.get('page') || '1';
  const res = await fetch(`${inst}/search?q=${encodeURIComponent(q)}&format=json&pageno=${encodeURIComponent(page)}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) return fail(502, `SearXNG answered ${res.status}. Is the JSON format enabled in settings.yml?`);
  return new Response(res.body, { headers: { 'Content-Type': 'application/json', ...CORS } });
}

/* ---------------- transcription ---------------- */

async function transcribe(req, env) {
  if (!env.AI) return fail(501, 'Workers AI is not bound to this Worker (see wrangler.toml [ai]).');
  const { audio } = await req.json();
  if (!audio) return fail(400, 'no audio');
  const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio });
  return json({ text: out.text || '' });
}

/* ---------------- sharing ---------------- */

function shareId() {
  const a = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

async function share(req, env, url, id) {
  if (req.method === 'DELETE') { await env.BUCKET.delete(`shares/${id}.html`); return json({ ok: true }); }
  const { id: existing, html, title } = await req.json();
  if (!html) return fail(400, 'no content');
  const sid = existing && /^[a-z0-9]{8,32}$/.test(existing) ? existing : shareId();
  await env.BUCKET.put(`shares/${sid}.html`, html, { httpMetadata: { contentType: 'text/html; charset=utf-8' }, customMetadata: { title: String(title || '').slice(0, 200) } });
  return json({ id: sid, url: `${env.PUBLIC_URL || url.origin}/s/${sid}` });
}

async function viewShare(env, id) {
  const obj = /^[a-z0-9]{8,32}$/.test(id) ? await env.BUCKET.get(`shares/${id}.html`) : null;
  if (!obj) return new Response('This shared note was removed or never existed.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; img-src data: https:; media-src data:; style-src 'unsafe-inline'; font-src data:",
      'X-Robots-Tag': 'noindex',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

/* ---------------- nightly backup to R2 ---------------- */

async function backup(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare('SELECT type, id, updated, deleted, data FROM records').all();
  const day = new Date().toISOString().slice(0, 10);
  const gz = new Blob([JSON.stringify({ app: 'scriptorium', exported: new Date().toISOString(), records: results })]).stream().pipeThrough(new CompressionStream('gzip'));
  const body = await new Response(gz).arrayBuffer(); // R2 needs a known length
  await env.BUCKET.put(`backups/${day}.json.gz`, body, { httpMetadata: { contentType: 'application/gzip' } });
  // keep 60 days
  const list = await env.BUCKET.list({ prefix: 'backups/' });
  const old = list.objects.map((o) => o.key).sort().slice(0, -60);
  if (old.length) await env.BUCKET.delete(old);
}

/* ---------------- router ---------------- */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.startsWith('/s/')) return viewShare(env, path.slice(3));
    if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!authorized(req, env)) return fail(401, env.APP_TOKEN ? 'Wrong access token' : 'Set the APP_TOKEN secret on the Worker first');
    try {
      if (path === '/api/health') return json({ ok: true, name: 'Scriptorium Worker', version: VERSION, storage: 'D1 + R2', ai: !!env.ANTHROPIC_API_KEY, transcribe: !!env.AI });
      if (path === '/api/sync' && req.method === 'POST') return await sync(req, env);
      if (path.startsWith('/api/blob/')) return await blob(req, env, decodeURIComponent(path.slice(10)));
      if (path === '/api/fetch') return await proxyFetch(url);
      if (path === '/api/search') return await search(url, env);
      if (path === '/api/transcribe' && req.method === 'POST') return await transcribe(req, env);
      if (path === '/api/ai' && req.method === 'POST') return answerResponse(await req.json(), { apiKey: env.ANTHROPIC_API_KEY, model: env.AI_MODEL }, CORS);
      if (path === '/api/share' && req.method === 'POST') return await share(req, env, url);
      if (path.startsWith('/api/share/') && req.method === 'DELETE') return await share(req, env, url, path.slice(11));
      if (path === '/api/backup' && req.method === 'POST') { ctx.waitUntil(backup(env)); return json({ ok: true }); }
      return fail(404, 'unknown endpoint');
    } catch (e) {
      return fail(500, e.message || String(e));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(backup(env));
  },
};
