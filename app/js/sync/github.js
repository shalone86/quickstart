// GitHub sync — works with nothing but a fine-grained token.
//
// Repo layout (under the configured folder, default "Notes/"):
//   <Folder>/<Title>.md            Obsidian-readable Markdown with front matter (one file per note)
//   _attachments/<id>.<ext>        images, sketches, audio (embedded in Markdown as ![[id.ext]])
//   .scriptorium/db.json           every record (notes, folders, tags, feeds, attachment info)
//   .scriptorium/history/<id>.json keystroke history per note
// Each sync is one atomic commit, so GitHub's commit log is also a timestamped backup.

import * as db from '../db.js';
import * as store from '../store.js';
import { settings } from '../settings.js';
import { htmlToMarkdown } from '../markdown.js';
import { safeFileName, blobToBase64, utf8ToBase64, sleep } from '../util.js';

const META = 'sync:github';
const RECORD_TYPES = ['notes', 'folders', 'tags', 'attachments', 'feeds'];

function cfg() {
  const s = settings();
  const [owner, repo] = String(s.githubRepo || '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').split('/');
  const base = String(s.githubPath || '').replace(/^\/+|\/+$/g, '');
  return { token: s.githubToken.trim(), owner, repo, branch: s.githubBranch || 'main', base, markdown: s.githubMarkdown !== false };
}

const p = (c, rel) => (c.base ? `${c.base}/${rel}` : rel);
const encPath = (path) => path.split('/').map(encodeURIComponent).join('/');

async function gh(c, path, { method = 'GET', body, accept = 'application/vnd.github+json', okStatuses = [] } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok && !okStatuses.includes(res.status)) {
    let msg = `${res.status}`;
    try { msg = `${res.status}: ${(await res.json()).message}`; } catch { /* ignore */ }
    const err = new Error(`GitHub ${msg}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const repoPath = (c) => `/repos/${c.owner}/${c.repo}`;

async function getHead(c) {
  const res = await gh(c, `${repoPath(c)}/git/ref/heads/${encodeURIComponent(c.branch)}`, { okStatuses: [404, 409] });
  if (res.status === 404 || res.status === 409) return null;
  const j = await res.json();
  return j.object.sha;
}

async function readFile(c, path, ref, as = 'text') {
  const res = await gh(c, `${repoPath(c)}/contents/${encPath(path)}?ref=${ref}`, { accept: 'application/vnd.github.raw', okStatuses: [404] });
  if (res.status === 404) return null;
  return as === 'blob' ? res.blob() : res.text();
}

/** Creates the first commit in an empty repo/branch. */
async function initRepo(c) {
  const path = p(c, '.scriptorium/README.md');
  await gh(c, `${repoPath(c)}/contents/${encPath(path)}`, {
    method: 'PUT',
    body: { message: 'Scriptorium: initialise notes', content: utf8ToBase64('# Scriptorium data\n\nManaged by the Scriptorium notes app. Notes are plain Markdown in the parent folder.\n'), branch: c.branch },
  });
}

function frontmatter(n) {
  const tags = (n.tags || []).map((id) => store.getTag(id)?.name).filter(Boolean).map((t) => t.replace(/\s+/g, '-'));
  const folder = store.getFolder(n.folderId)?.name;
  const lines = ['---', `id: ${n.id}`, `created: ${new Date(n.created).toISOString()}`, `updated: ${new Date(n.updated).toISOString()}`];
  if (tags.length) lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  if (folder) lines.push(`folder: ${JSON.stringify(folder)}`);
  if (n.pinned) lines.push('pinned: true');
  if (n.bookmarked) lines.push('bookmarked: true');
  if (n.source?.url) lines.push(`source: ${JSON.stringify(n.source.url)}`);
  lines.push('---', '');
  return lines.join('\n');
}

export function noteMarkdown(n) {
  const md = htmlToMarkdown(n.html, {
    attFile: (id) => { const a = store.getAttachment(id); return a ? `${id}.${a.ext}` : id; },
    noteTitle: (id) => store.getNote(id)?.title?.replace(/…$/, ''),
  });
  return frontmatter(n) + md;
}

function notePath(c, n, taken) {
  const folder = store.getFolder(n.folderId);
  const dir = folder ? `${safeFileName(folder.name, 'Folder')}/` : '';
  const name = safeFileName(n.title, 'Untitled');
  let path = p(c, `${dir}${name}.md`);
  let i = 2;
  while (taken.has(path) && taken.get(path) !== n.id) path = p(c, `${dir}${name} (${i++}).md`);
  return path;
}

export const githubBackend = {
  id: 'github',
  name: 'GitHub',
  enabled: (s) => !!(s.githubEnabled && s.githubToken && s.githubRepo),

  async test() {
    const c = cfg();
    const r = await (await gh(c, repoPath(c))).json();
    const head = await getHead(c);
    return `Connected to ${r.full_name} (${r.private ? 'private' : 'PUBLIC — consider making it private'})${head ? '' : ' · empty, will initialise'}`;
  },

  async sync() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.syncOnce(); } catch (e) {
        if (e.status === 422 || e.status === 409) { await sleep(800 * (attempt + 1)); continue; } // branch moved: retry
        throw e;
      }
    }
    throw new Error('GitHub: branch kept changing during sync, will retry');
  },

  async syncOnce() {
    const c = cfg();
    const st = (await db.getMeta(META)) || { pushedSeq: 0, lastCommit: null, histIndex: {} };
    let head = await getHead(c);
    if (!head) { await initRepo(c); head = await getHead(c); }
    const localChanges = (await db.currentSeq()) > st.pushedSeq;
    if (head === st.lastCommit && !localChanges) return { pulled: 0, pushed: 0 };

    // ---- pull ----
    let remote = { records: {}, paths: {}, files: [], histIndex: {} };
    let remoteText = null;
    if (head !== st.lastCommit) {
      remoteText = await readFile(c, p(c, '.scriptorium/db.json'), head);
      if (remoteText) { try { remote = { ...remote, ...JSON.parse(remoteText) }; } catch { console.warn('db.json unreadable'); } }
    } else {
      remote = st.remoteCache || remote;
    }
    let pulled = 0;
    for (const type of RECORD_TYPES) pulled += await store.applyRemote(type, remote.records[type] || []);
    // keystroke history files that changed on another device
    for (const [noteId, ts] of Object.entries(remote.histIndex || {})) {
      if ((st.histIndex[noteId] || 0) >= ts) continue;
      const txt = await readFile(c, p(c, `.scriptorium/history/${noteId}.json`), head);
      if (txt) { try { pulled += await store.applyRemote('history', JSON.parse(txt)); } catch { /* skip corrupt */ } }
      st.histIndex[noteId] = ts;
    }
    const seqAfterPull = await db.currentSeq();
    if (!localChanges) {
      // Nothing new on this device: just remember what we pulled (no commit, so devices never ping-pong).
      await db.setMeta(META, { ...st, pushedSeq: seqAfterPull, lastCommit: head, histIndex: st.histIndex, remoteCache: { paths: remote.paths || {}, files: remote.files || [], histIndex: remote.histIndex || {}, records: {} } });
      return { pulled, pushed: 0 };
    }

    // ---- build the new state ----
    const records = {};
    for (const type of RECORD_TYPES) {
      records[type] = (await db.getAll(type)).map((r) => { const x = { ...r }; delete x._seq; delete x.uploaded; return x; }).sort((a, b) => (a.id < b.id ? -1 : 1));
    }
    const changedNotes = new Set((await db.changedSince('notes', st.pushedSeq)).map((n) => n.id));

    const tree = [];
    const paths = { ...(remote.paths || {}) };
    const taken = new Map(Object.entries(paths).map(([id, path]) => [path, id]));
    if (c.markdown) {
      const folderOrTagChanged = (await db.changedSince('folders', st.pushedSeq)).length || (await db.changedSince('tags', st.pushedSeq)).length;
      for (const n of records.notes) {
        const old = paths[n.id];
        const gone = n.deleted || n.trashed;
        if (gone) {
          if (old) { tree.push({ path: old, mode: '100644', type: 'blob', sha: null }); taken.delete(old); delete paths[n.id]; }
          continue;
        }
        if (!changedNotes.has(n.id) && old && !folderOrTagChanged) continue;
        const path = notePath(c, n, taken);
        if (old && old !== path) { tree.push({ path: old, mode: '100644', type: 'blob', sha: null }); taken.delete(old); }
        paths[n.id] = path;
        taken.set(path, n.id);
        tree.push({ path, mode: '100644', type: 'blob', content: noteMarkdown(n) });
      }
    }

    // history files for notes whose sessions changed locally
    const histChanged = await db.changedSince('history', st.pushedSeq);
    const histIndex = { ...(remote.histIndex || {}) };
    const histNotes = new Set(histChanged.map((s) => s.noteId));
    for (const noteId of histNotes) {
      const sessions = (await db.getByIndex('history', 'noteId', noteId)).map((s) => { const x = { ...s }; delete x._seq; return x; }).sort((a, b) => a.start - b.start);
      const ts = Math.max(...sessions.map((s) => s.updated || 0));
      histIndex[noteId] = ts;
      st.histIndex[noteId] = ts;
      tree.push({ path: p(c, `.scriptorium/history/${noteId}.json`), mode: '100644', type: 'blob', content: JSON.stringify(sessions) });
    }

    // attachment bytes not yet in the repo
    const files = new Set(remote.files || []);
    let blobs = 0;
    for (const a of records.attachments) {
      const key = `${a.id}:${a.rev || 0}`;
      if (a.deleted || files.has(key)) continue;
      const blob = await db.getBlob(a.id);
      if (!blob) continue;
      const res = await gh(c, `${repoPath(c)}/git/blobs`, { method: 'POST', body: { content: await blobToBase64(blob), encoding: 'base64' } });
      const { sha } = await res.json();
      tree.push({ path: p(c, `_attachments/${a.id}.${a.ext}`), mode: '100644', type: 'blob', sha });
      files.add(key);
      blobs++;
    }

    const dbJson = JSON.stringify({ version: 1, app: 'scriptorium', records, paths, files: [...files].sort(), histIndex }, null, 0);
    if (dbJson !== remoteText) tree.push({ path: p(c, '.scriptorium/db.json'), mode: '100644', type: 'blob', content: dbJson });

    let committed = head;
    if (tree.length) {
      const baseTree = (await (await gh(c, `${repoPath(c)}/git/commits/${head}`)).json()).tree.sha;
      const newTree = (await (await gh(c, `${repoPath(c)}/git/trees`, { method: 'POST', body: { base_tree: baseTree, tree } })).json()).sha;
      if (newTree !== baseTree) {
        const n = changedNotes.size;
        const msg = n ? `Notes: ${n} note${n > 1 ? 's' : ''} updated` : 'Notes: sync';
        const commit = (await (await gh(c, `${repoPath(c)}/git/commits`, { method: 'POST', body: { message: msg, tree: newTree, parents: [head] } })).json()).sha;
        await gh(c, `${repoPath(c)}/git/refs/heads/${encodeURIComponent(c.branch)}`, { method: 'PATCH', body: { sha: commit, force: false } });
        committed = commit;
      }
    }
    await db.setMeta(META, {
      // anything edited while this sync ran has a higher seq and goes out next time
      pushedSeq: seqAfterPull, lastCommit: committed, histIndex: st.histIndex,
      remoteCache: { paths, files: [...files], histIndex, records: {} },
    });
    return { pulled, pushed: tree.length, blobs };
  },

  async fetchBlob(meta) {
    if (!meta?.ext) return null;
    const c = cfg();
    return readFile(c, p(c, `_attachments/${meta.id}.${meta.ext}`), c.branch, 'blob');
  },
};
