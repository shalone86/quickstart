// End-to-end tests in a real browser (Playwright + Chromium).
//   npm i -D playwright && npx playwright install chromium   (if you don't have it)
//   npm run test:e2e
// Starts the home server on a temp data dir, a tiny "article" site, and mocks api.github.com in memory.

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptorium-e2e-'));
const PORT = 8790, SITE = 8791;
const BASE = `http://localhost:${PORT}/?nosw`;

// ---- servers ----
const server = spawn(process.execPath, [path.join(root, 'server/server.js')], { env: { ...process.env, APP_TOKEN: 'e2e', PORT: String(PORT), DATA_DIR: path.join(tmp, 'data'), ALLOW_PRIVATE_FETCH: '1' }, stdio: 'inherit' });
const png = fs.readFileSync(path.join(root, 'app/icons/icon-192.png'));
const site = http.createServer((req, res) => {
  if (req.url === '/pic.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>The Monastery Scriptorium | History Mag</title><meta property="og:site_name" content="History Mag"></head><body><nav>Home</nav><article><h1>The Monastery Scriptorium</h1>
  <p>${'Medieval monks copied books by hand in a room called the scriptorium, preserving classical literature. '.repeat(3)}</p><img src="/pic.png" alt="scribe">
  <p>${'Scribes prepared parchment, mixed inks from oak galls and ruled lines before writing every page. '.repeat(3)}</p></article></body></html>`);
}).listen(SITE);
await new Promise((r) => setTimeout(r, 800));

// ---- in-memory GitHub ----
const gh = { blobs: new Map(), trees: new Map(), commits: new Map(), head: null };
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
const putBlob = (buf) => { const h = sha(buf); gh.blobs.set(h, buf); return h; };
const putTree = (m) => { const h = sha(JSON.stringify([...m.entries()].sort())); gh.trees.set(h, m); return h; };
const treeOf = (c) => gh.trees.get(gh.commits.get(c).tree);
async function githubRoute(route) {
  const req = route.request();
  const u = new URL(req.url());
  const p = decodeURIComponent(u.pathname);
  const m = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  const ok = (j, s = 200) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(j), headers: { 'access-control-allow-origin': '*' } });
  const R = '/repos/me/notes';
  if (p === R) return ok({ full_name: 'me/notes', private: true });
  if (p === `${R}/git/ref/heads/main`) return gh.head ? ok({ object: { sha: gh.head } }) : ok({ message: 'empty' }, 409);
  if (p.startsWith(`${R}/contents/`)) {
    const file = p.slice(`${R}/contents/`.length);
    if (m === 'PUT') { const t = new Map(gh.head ? treeOf(gh.head) : []); t.set(file, putBlob(Buffer.from(body.content, 'base64'))); const c = sha(`c${Math.random()}`); gh.commits.set(c, { tree: putTree(t), parents: gh.head ? [gh.head] : [] }); gh.head = c; return ok({}, 201); }
    const ref = u.searchParams.get('ref');
    const c = gh.commits.has(ref) ? ref : gh.head;
    const b = c && treeOf(c).get(file);
    return b ? route.fulfill({ status: 200, body: gh.blobs.get(b), headers: { 'access-control-allow-origin': '*' } }) : ok({ message: 'Not Found' }, 404);
  }
  if (p.startsWith(`${R}/git/commits/`)) return ok({ tree: { sha: gh.commits.get(p.split('/').pop()).tree } });
  if (p === `${R}/git/blobs`) return ok({ sha: putBlob(Buffer.from(body.content, 'base64')) }, 201);
  if (p === `${R}/git/trees`) {
    const t = new Map(gh.trees.get(body.base_tree));
    for (const e of body.tree) {
      if (e.sha === null) { if (!t.has(e.path)) return ok({ message: 'missing path' }, 422); t.delete(e.path); }
      else t.set(e.path, e.content !== undefined ? putBlob(Buffer.from(e.content)) : e.sha);
    }
    return ok({ sha: putTree(t) }, 201);
  }
  if (p === `${R}/git/commits`) { const c = sha(`c${Math.random()}`); gh.commits.set(c, { tree: body.tree, parents: body.parents }); return ok({ sha: c }, 201); }
  if (p === `${R}/git/refs/heads/main`) { if (gh.commits.get(body.sha).parents[0] !== gh.head) return ok({}, 422); gh.head = body.sha; return ok({}); }
  return ok({ message: 'unmocked' }, 500);
}

// ---- browser helpers ----
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
async function device(name, { mobile = true, settings = {} } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 }, permissions: ['microphone'], acceptDownloads: true });
  await ctx.route('https://api.github.com/**', githubRoute);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(`${BASE}#/`);
  await page.waitForSelector('.composer .editor');
  if (Object.keys(settings).length) await page.evaluate(async (s) => { const m = await import('./js/settings.js'); await m.saveSettings(s); }, settings);
  return page;
}
const syncNow = (p) => p.evaluate(async () => { const m = await import('./js/sync/engine.js'); await m.syncNow(); return m.syncStatus(); });
const notes = (p) => p.evaluate(async () => (await import('./js/store.js')).liveNotes().map((n) => ({ id: n.id, title: n.title, text: n.text, html: n.html })));
let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`✔ ${name}`); } catch (e) { console.log(`✘ ${name}\n  ${e.stack.split('\n').slice(0, 3).join('\n  ')}`); process.exitCode = 1; }
}

// ---- tests ----
const A = await device('A', { settings: { serverEnabled: true, serverToken: 'e2e', githubEnabled: true, githubToken: 'x', githubRepo: 'me/notes', readerFallback: false } });

await t('composer: type, bullets, auto math, save', async () => {
  await A.click('.composer .editor');
  await A.keyboard.type('Groceries\n- milk 3.50\neggs 2\n');
  await A.keyboard.press('Enter');
  await A.keyboard.type('Total 3.5+2 =');
  await A.waitForTimeout(400);
  const html = await A.$eval('.composer .editor', (e) => e.innerHTML);
  assert.match(html, /^<p>Groceries<\/p><ul><li>milk 3.50<\/li><li>eggs 2<\/li><\/ul>/);
  assert.match(html, /Total 3\.5\+2 = 5\.5/);
  await A.click('.composer-save');
  await A.waitForTimeout(500);
  assert.deepEqual(await A.$$eval('.note-card h3', (e) => e.map((x) => x.textContent)), ['Groceries']);
});

await t('@ links, tags, folders, checklist, highlight, backlinks', async () => {
  await A.click('.composer .editor');
  await A.keyboard.type('Church cameras\nSee @');
  await A.waitForSelector('.note-picker input');
  await A.keyboard.type('groc');
  await A.keyboard.press('Enter');
  await A.keyboard.type('for budget.');
  await A.click('.composer-save');
  await A.waitForTimeout(400);
  await A.click('.note-card >> nth=0');
  await A.waitForSelector('.note-view .editor');
  await A.click('.note-head [data-a="tags"]');
  await A.keyboard.type('church');
  await A.keyboard.press('Enter');
  await A.keyboard.press('Escape');
  await A.click('.folder-btn');
  await A.fill('.picker-input', 'Projects');
  await A.keyboard.press('Enter');
  await A.click('.note-view .editor p >> nth=1');
  await A.keyboard.press('End');
  await A.keyboard.press('Enter');
  await A.keyboard.type('[] cables');
  await A.keyboard.press('Shift+Home');
  await A.keyboard.press('Control+Shift+H');
  await A.waitForTimeout(800);
  const html = await A.evaluate(async () => { const s = await import('./js/store.js'); return s.liveNotes().find((n) => n.title === 'Church cameras').html; });
  assert.match(html, /<a class="note-link" data-note-id="n\w+" href="#\/note\/n\w+">Groceries<\/a>/);
  assert.match(html, /<ul class="checklist"><li data-checked="false"><mark>cables<\/mark><\/li><\/ul>/);
  const foot = await A.$eval('.note-foot', (e) => e.innerText);
  assert.match(foot, /church/);
  assert.match(foot, /LINKS TO/i);
  await A.click('.note-view .editor a.note-link');
  await A.waitForTimeout(400);
  assert.match(await A.$eval('.note-foot', (e) => e.innerText), /LINKED FROM/i);
});

await t('search, calendar and list views', async () => {
  await A.goto(`${BASE}#/search?q=camera`);
  await A.waitForTimeout(300);
  assert.deepEqual(await A.$$eval('.note-row-title', (e) => e.map((x) => x.textContent)), ['Church cameras']);
  await A.goto(`${BASE}#/calendar`);
  await A.waitForTimeout(300);
  assert.equal(await A.$$eval('.cal-day .note-row', (e) => e.length), 2);
  await A.goto(`${BASE}#/notes?filter=bookmarks`);
  await A.waitForTimeout(200);
  assert.ok(await A.$('.empty'));
});

await t('sketch and voice note', async () => {
  await A.goto(`${BASE}#/`);
  await A.waitForSelector('.composer .editor');
  await A.click('.composer .editor');
  await A.keyboard.type('Diagram');
  await A.click('.composer [data-a="sketch"]');
  const box = await A.locator('.sketch-canvas').boundingBox();
  await A.mouse.move(box.x + 40, box.y + 40); await A.mouse.down(); await A.mouse.move(box.x + 200, box.y + 120, { steps: 10 }); await A.mouse.up();
  await A.click('.sketch-pad [data-a="done"]');
  await A.waitForTimeout(600);
  assert.ok((await A.$$eval('.composer img[data-sketch]', (e) => e.map((x) => x.naturalWidth)))[0] > 100);
  await A.click('.composer [data-a="voice"]');
  await A.waitForTimeout(1500);
  await A.click('.voice [data-a="stop"]');
  await A.waitForTimeout(800);
  assert.equal(await A.$$eval('.composer .audio-block', (e) => e.length), 1);
  await A.click('.composer-save');
  await A.waitForTimeout(400);
});

await t('save an article with its images', async () => {
  const r = await A.evaluate(async (url) => { const a = await import('./js/article.js'); const s = await import('./js/store.js'); const n = await a.saveArticle(url); return { title: n.title, html: s.getNote(n.id).html, atts: s.attachmentsFor(n.id).length }; }, `http://localhost:${SITE}/article`);
  assert.equal(r.title, 'The Monastery Scriptorium');
  assert.equal(r.atts, 1);
  assert.match(r.html, /data-att="a\w+"/);
});

await t('server sync to a second device (text + images)', async () => {
  const st = await syncNow(A);
  assert.equal(st.state, 'synced', JSON.stringify(st));
  const B = await device('B', { settings: { serverEnabled: true, serverToken: 'e2e' } });
  await syncNow(B);
  const titles = (await notes(B)).map((n) => n.title).sort();
  assert.deepEqual(titles, ['Church cameras', 'Diagram', 'Groceries', 'The Monastery Scriptorium']);
  const id = (await notes(B)).find((n) => n.title === 'Diagram').id;
  await B.goto(`${BASE}#/note/${id}`);
  await B.waitForTimeout(1000);
  assert.ok((await B.$$eval('.note-view img', (e) => e.map((x) => x.naturalWidth)))[0] > 100);
  await B.click('.note-view .editor p >> nth=0');
  await B.keyboard.press('End');
  await B.keyboard.type(' edited on B');
  await B.waitForTimeout(600);
  await syncNow(B);
  await syncNow(A);
  assert.ok((await notes(A)).some((n) => n.text.startsWith('Diagram edited on B')));
  await B.context().close();
});

await t('GitHub sync writes Obsidian Markdown and a second device restores from it', async () => {
  const files = [...treeOf(gh.head).keys()];
  assert.ok(files.includes('Notes/Projects/Church cameras.md'), files.join('\n'));
  assert.ok(files.some((f) => f.startsWith('Notes/_attachments/')));
  assert.ok(files.includes('Notes/.scriptorium/db.json'));
  const md = gh.blobs.get(treeOf(gh.head).get('Notes/Projects/Church cameras.md')).toString();
  assert.match(md, /^---\nid: n\w+\ncreated: .*\nupdated: .*\ntags: \["church"\]\nfolder: "Projects"\n---\n/);
  assert.match(md, /\[\[Groceries\]\]/);
  assert.match(md, /- \[ \] ==cables==/);
  const C = await device('C', { settings: { githubEnabled: true, githubToken: 'x', githubRepo: 'me/notes' } });
  await syncNow(C);
  assert.equal((await notes(C)).length, 4);
  const head = gh.head;
  await syncNow(C); await syncNow(A); await syncNow(C);
  assert.equal(gh.head, head, 'idle devices must not create commits');
  await C.context().close();
});

await t('version history, provenance report and video export', async () => {
  const id = (await notes(A)).find((n) => n.title === 'Groceries').id;
  await A.goto(`${BASE}#/history/${id}`);
  await A.waitForSelector('.prov-summary');
  const typed = await A.$eval('.prov-stat b', (e) => e.textContent);
  assert.match(typed, /\d+%/);
  const [rep] = await Promise.all([A.waitForEvent('download'), A.click('[data-a="report"]')]);
  assert.match(rep.suggestedFilename(), /provenance\.html$/);
  const [vid] = await Promise.all([A.waitForEvent('download', { timeout: 90000 }), A.click('[data-a="video"]')]);
  const vp = path.join(tmp, vid.suggestedFilename());
  await vid.saveAs(vp);
  assert.ok(fs.statSync(vp).size > 10000);
});

await t('export everything and import Obsidian Markdown', async () => {
  await A.goto(`${BASE}#/settings`);
  await A.waitForSelector('[data-a="export"]');
  const [z] = await Promise.all([A.waitForEvent('download'), A.click('[data-a="export"]')]);
  assert.match(z.suggestedFilename(), /\.zip$/);
  const dir = path.join(tmp, 'vault', 'Ideas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Rosary app.md'), '---\ntags: [prayer]\n---\n# Rosary app\n\nSee [[Groceries]].\n\n- [x] screens\n- [ ] images\n\n![[pic.png]]\n');
  fs.writeFileSync(path.join(dir, 'pic.png'), png);
  const [fc] = await Promise.all([A.waitForEvent('filechooser'), A.click('[data-a="import-files"]')]);
  await fc.setFiles([path.join(dir, 'Rosary app.md'), path.join(dir, 'pic.png')]);
  await A.waitForTimeout(1200);
  const n = (await notes(A)).find((x) => x.title === 'Rosary app');
  assert.match(n.html, /class="note-link"/);
  assert.match(n.html, /<ul class="checklist"><li data-checked="true">screens/);
  assert.match(n.html, /<img data-att="a\w+"/);
});

await t('share link serves a read-only page', async () => {
  const url = await A.evaluate(async () => { const s = await import('./js/store.js'); const e = await import('./js/exporter.js'); return e.publishShare(s.liveNotes().find((n) => n.title === 'Groceries')); });
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await res.text(), /Groceries/);
});

await t('highlight is undoable, removable, and Enter starts plain text', async () => {
  const P = await device('H');
  const saved = async () => { await P.waitForTimeout(500); return P.evaluate(async () => { const s = await import('./js/store.js'); return s.sortNotes(s.liveNotes())[0]?.html; }); };
  await P.click('.composer .editor');
  await P.keyboard.type('Hello world');
  await P.keyboard.press('Shift+Home');
  await P.keyboard.press('Control+Shift+H');
  assert.equal(await saved(), '<p><mark>Hello world</mark></p>');
  await P.keyboard.press('Control+z');
  assert.equal(await saved(), '<p>Hello world</p>');
  await P.keyboard.press('Control+Shift+z');
  await P.keyboard.press('End');
  await P.keyboard.press('Enter');
  await P.keyboard.type('plain');
  assert.equal(await saved(), '<p><mark>Hello world</mark></p><p>plain</p>');
  await P.click('.composer .editor p >> nth=0');
  await P.keyboard.press('Control+Shift+H');
  assert.equal(await saved(), '<p>Hello world</p><p>plain</p>');
  await P.context().close();
});

await t('sketch tools all reachable on a small phone', async () => {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const P = await ctx.newPage();
  await P.goto(`${BASE}#/`);
  await P.waitForSelector('.composer .editor');
  await P.click('.composer [data-a="sketch"]');
  for (const tool of ['pen', 'marker', 'eraser', 'line', 'arrow', 'rect', 'ellipse']) {
    const r = await P.$eval(`[data-tool="${tool}"]`, (e) => e.getBoundingClientRect().toJSON());
    assert.ok(r.left >= 0 && r.right <= 360, `${tool} is off screen`);
  }
  await P.click('[data-tool="rect"]');
  await P.click('[data-tool="pen"]');
  assert.equal(await P.$eval('.sketch-tools .on', (e) => e.dataset.tool), 'pen');
  await ctx.close();
});

await t('Ask AI inside a note sends the note and inserts the answer', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let sent;
  await ctx.route('**/api/ai', (r) => { sent = JSON.parse(r.request().postData()); return r.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"text","text":"- step one"}\n\ndata: {"type":"done"}\n\n' }); });
  const P = await ctx.newPage();
  await P.goto(`${BASE}#/`);
  await P.waitForSelector('.composer .editor');
  await P.evaluate(async () => { const s = await import('./js/settings.js'); await s.saveSettings({ serverEnabled: true, serverToken: 'e2e' }); });
  await P.click('.composer .editor');
  await P.keyboard.type('Plan\nDo the thing.');
  await P.click('.composer-save');
  await P.click('.note-card');
  await P.click('.note-head [data-a="ask"]');
  await P.click('[data-quick="1"]');
  await P.click('[data-insert]');
  await P.waitForTimeout(600);
  assert.equal(sent.notes[0].title, 'Plan');
  assert.match(await P.$eval('.note-view .editor', (e) => e.innerHTML), /<blockquote><ul><li>step one<\/li><\/ul><\/blockquote>/);
  await ctx.close();
});

await t('no uncaught page errors', async () => { assert.deepEqual(errors, []); });

console.log(`\n${passed} passed`);
await browser.close();
site.close();
server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
