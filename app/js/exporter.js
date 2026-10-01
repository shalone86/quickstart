// Downloads (one note or everything), backup/restore, Obsidian import, and sharing.

import * as store from './store.js';
import * as db from './db.js';
import { noteMarkdown } from './sync/github.js';
import { markdownToHtml } from './markdown.js';
import { sanitizeHTML } from './sanitize.js';
import { importSession } from './history.js';
import { htmlToText } from './text.js';
import { makeZip, readZip } from './zip.js';
import { api, hasServer } from './settings.js';
import { safeFileName, downloadBlob, esc, fmtDateTime, blobToBase64, mimeForExt, dayKey } from './util.js';

/* ---------------- single note ---------------- */

async function inlineMedia(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  for (const el of tpl.content.querySelectorAll('img[data-att], audio[data-att]')) {
    const blob = await store.getAttachmentBlob(el.dataset.att);
    if (blob) el.setAttribute('src', `data:${blob.type || 'application/octet-stream'};base64,${await blobToBase64(blob)}`);
    el.removeAttribute('data-att');
  }
  tpl.content.querySelectorAll('.audio-block').forEach((b) => b.removeAttribute('contenteditable'));
  tpl.content.querySelectorAll('a.note-link').forEach((a) => { a.removeAttribute('href'); });
  return tpl.innerHTML;
}

export async function noteStandaloneHTML(note) {
  const body = await inlineMedia(note.html);
  const tags = (note.tags || []).map((id) => store.getTag(id)?.name).filter(Boolean);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(note.title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d1d1f;--bg:#fffdf8;--muted:#6e6e73;--mark:#ffe58a}
@media (prefers-color-scheme:dark){:root{--fg:#f2f2f2;--bg:#1c1b19;--muted:#a1a1a6;--mark:#7a5d00}}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 20px 80px}
.meta{color:var(--muted);font-size:14px;margin-bottom:24px}
img{max-width:100%;height:auto;border-radius:8px}
mark{background:var(--mark);color:inherit;border-radius:3px;padding:0 2px}
blockquote{border-left:3px solid #d4a017;margin:0;padding-left:16px;color:var(--muted)}
ul.checklist{list-style:none;padding-left:4px} ul.checklist li::before{content:"☐ "} ul.checklist li[data-checked=true]::before{content:"☑ "}
ul.checklist li[data-checked=true]{color:var(--muted);text-decoration:line-through}
pre{background:rgba(127,127,127,.12);padding:12px;border-radius:8px;overflow:auto}
a{color:#b8860b} audio{width:100%}
</style></head><body><main>
<div class="meta">${esc(fmtDateTime(note.created))}${tags.length ? ' · ' + tags.map((t) => '#' + esc(t)).join(' ') : ''}</div>
${body}
</main></body></html>`;
}

export async function downloadNote(note, format) {
  const name = safeFileName(note.title);
  if (format === 'md') {
    const atts = store.attachmentsFor(note.id);
    if (!atts.length) return downloadBlob(new Blob([noteMarkdown(note)], { type: 'text/markdown' }), `${name}.md`);
    const files = [{ name: `${name}.md`, data: noteMarkdown(note) }];
    for (const a of atts) { const b = await store.getAttachmentBlob(a.id); if (b) files.push({ name: `${a.id}.${a.ext}`, data: b }); }
    return downloadBlob(await makeZip(files), `${name}.zip`);
  }
  if (format === 'txt') return downloadBlob(new Blob([`${note.title}\n${fmtDateTime(note.created)}\n\n${note.text}\n`], { type: 'text/plain' }), `${name}.txt`);
  if (format === 'html') return downloadBlob(new Blob([await noteStandaloneHTML(note)], { type: 'text/html' }), `${name}.html`);
  if (format === 'pdf') {
    const w = window.open('', '_blank');
    if (!w) throw new Error('Allow pop-ups to print / save as PDF');
    w.document.write((await noteStandaloneHTML(note)).replace('</body>', '<script>setTimeout(()=>print(),400)<\/script></body>'));
    w.document.close();
  }
}

/* ---------------- everything ---------------- */

/** Obsidian-ready vault zip + a full JSON backup inside it. */
export async function exportAll() {
  const files = [];
  const taken = new Set();
  for (const n of store.liveNotes()) {
    const folder = store.getFolder(n.folderId);
    const dir = folder ? `${safeFileName(folder.name)}/` : '';
    let path = `Notes/${dir}${safeFileName(n.title)}.md`;
    let i = 2;
    while (taken.has(path)) path = `Notes/${dir}${safeFileName(n.title)} (${i++}).md`;
    taken.add(path);
    files.push({ name: path, data: noteMarkdown(n), date: new Date(n.updated) });
  }
  for (const a of [...(await db.getAll('attachments'))].filter((x) => !x.deleted)) {
    const b = await store.getAttachmentBlob(a.id);
    if (b) files.push({ name: `Notes/_attachments/${a.id}.${a.ext}`, data: b });
  }
  files.push({ name: 'scriptorium-backup.json', data: JSON.stringify(await backupJSON()) });
  downloadBlob(await makeZip(files), `scriptorium-${dayKey(Date.now())}.zip`);
}

export async function backupJSON() {
  const out = { app: 'scriptorium', version: 1, exported: new Date().toISOString(), records: {} };
  for (const t of db.SYNC_TYPES) out.records[t] = (await db.getAll(t)).map((r) => { const x = { ...r }; delete x._seq; return x; });
  return out;
}

/* ---------------- import ---------------- */

/**
 * Imports a Scriptorium zip/JSON backup, an Obsidian vault folder or zip, or loose .md/.txt files.
 * Returns the number of notes imported.
 */
export async function importFiles(fileList) {
  let entries = [];
  for (const f of fileList) {
    if (/\.zip$/i.test(f.name)) entries.push(...(await readZip(f)).map((e) => ({ name: e.name, blob: new Blob([e.data]) })));
    else entries.push({ name: f.webkitRelativePath || f.name, blob: f });
  }
  const backup = entries.find((e) => /scriptorium-backup\.json$|^scriptorium.*\.json$/i.test(e.name.split('/').pop()));
  if (backup) {
    const j = JSON.parse(await backup.blob.text());
    let n = 0;
    for (const [type, recs] of Object.entries(j.records || {})) n += await store.applyRemote(type, recs);
    for (const e of entries) {
      const m = e.name.match(/_attachments\/([^/.]+)\.(\w+)$/);
      if (m && !(await db.hasBlob(m[1]))) await db.putBlob(m[1], new Blob([e.blob], { type: mimeForExt(m[2]) }));
    }
    return n;
  }
  // Obsidian / markdown
  const media = new Map();
  for (const e of entries) {
    const base = e.name.split('/').pop();
    if (/\.(png|jpe?g|gif|webp|svg|m4a|mp3|webm|ogg|wav)$/i.test(base)) media.set(base, e);
  }
  const mdEntries = entries.filter((e) => /\.(md|markdown|txt)$/i.test(e.name) && !e.name.split('/').some((p) => p.startsWith('.')));
  const created = [];
  const attIds = new Map();
  // First pass creates notes so [[links]] can resolve to each other.
  const pending = [];
  for (const e of mdEntries) {
    const text = await e.blob.text();
    const parts = e.name.split('/');
    const file = parts.pop().replace(/\.(md|markdown|txt)$/i, '');
    const folderName = parts.filter((p) => p && !/^(notes|vault)$/i.test(p)).pop() || null;
    const fm = parseFrontmatter(text);
    const folder = folderName ? await store.folderByName(folderName) : null;
    const tagIds = [];
    for (const t of [...(fm.tags || []), ...((text.match(/(^|\s)#([\p{L}\p{N}_/-]+)/gu) || []).map((x) => x.trim().slice(1)))]) {
      tagIds.push((await store.createTag(String(t))).id);
    }
    const note = await store.createNote({
      html: '', title: file, titleManual: true, folderId: folder?.id || null, tags: [...new Set(tagIds)],
      created: fm.created ? Date.parse(fm.created) || e.blob.lastModified || Date.now() : e.blob.lastModified || Date.now(),
      pinned: !!fm.pinned, bookmarked: !!fm.bookmarked,
    });
    pending.push({ note, text, isTxt: /\.txt$/i.test(e.name) });
    created.push(note);
  }
  for (const { note, text, isTxt } of pending) {
    let html;
    if (isTxt) html = text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
    else {
      const ctx = {
        resolveLink: (t) => store.findNoteByTitle(t)?.id || null,
        resolveEmbed: (name) => {
          const m = media.get(name) || media.get(decodeURIComponent(name));
          if (!m) return null;
          return { att: name, kind: /\.(m4a|mp3|webm|ogg|wav)$/i.test(name) ? 'audio' : 'image', entry: m };
        },
      };
      html = markdownToHtml(text, ctx);
      // turn embeds into real attachments
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      for (const el of tpl.content.querySelectorAll('[data-att]')) {
        const name = el.dataset.att;
        let id = attIds.get(name);
        if (!id) {
          const m = media.get(name);
          if (!m) continue;
          const ext = name.split('.').pop();
          const att = await store.addAttachment(new Blob([m.blob], { type: mimeForExt(ext) }), { noteId: note.id, name });
          id = att.id;
          attIds.set(name, id);
        }
        el.dataset.att = id;
        if (el.tagName === 'AUDIO') { const wrap = document.createElement('div'); wrap.className = 'audio-block'; wrap.dataset.att = id; wrap.setAttribute('contenteditable', 'false'); el.replaceWith(wrap); wrap.appendChild(el); }
      }
      html = tpl.innerHTML;
    }
    html = sanitizeHTML(html, { keepClasses: true });
    await store.updateNote(note.id, { html }, { touch: false });
    await db.put('history', importSession(note.id, store.deviceId(), htmlToText(html), html, 'a', note.created));
  }
  return created.length;
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  const out = {};
  for (const line of text.slice(3, end).split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else v = v.replace(/^["']|["']$/g, '');
    if (v === 'true') v = true;
    out[m[1].toLowerCase()] = v;
  }
  if (typeof out.tags === 'string') out.tags = out.tags.split(/[,\s]+/).filter(Boolean);
  return out;
}

/* ---------------- sharing ---------------- */

/** Publishes a read-only copy through your Worker/server; returns the public URL. */
export async function publishShare(note) {
  if (!hasServer()) throw new Error('Share links need your Cloudflare Worker or home server.');
  const html = await noteStandaloneHTML(note);
  const res = await api('/api/share', { method: 'POST', body: { id: note.shareId || null, title: note.title, html } });
  await store.updateNote(note.id, { shareId: res.id, shareUrl: res.url }, { touch: false });
  return res.url;
}

export async function unpublishShare(note) {
  if (note.shareId) await api(`/api/share/${note.shareId}`, { method: 'DELETE' });
  await store.updateNote(note.id, { shareId: null, shareUrl: null }, { touch: false });
}

/** Native share sheet (Messages, Mail, AirDrop…) with text, falling back to the clipboard. */
export async function shareNative(note) {
  const text = `${note.title}\n\n${note.text}`;
  if (navigator.share) {
    try {
      const file = new File([await noteStandaloneHTML(note)], `${safeFileName(note.title)}.html`, { type: 'text/html' });
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: note.title, text, files: [file] });
      else await navigator.share({ title: note.title, text });
      return 'shared';
    } catch (e) { if (e.name === 'AbortError') return 'cancelled'; }
  }
  await navigator.clipboard.writeText(text);
  return 'copied';
}
