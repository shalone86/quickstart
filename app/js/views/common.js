// Shared pieces for views: note cards/rows, tag chips, the note action menu.

import * as store from '../store.js';
import { esc, fmtRelative, fmtDateTime } from '../util.js';
import { icon } from '../icons.js';
import { snippet } from '../text.js';
import { menu, toast, confirmDialog, sheet, h } from '../ui.js';
import { tagPicker, folderPicker } from '../pickers.js';
import { downloadNote, publishShare, unpublishShare, shareNative } from '../exporter.js';
import { hasServer } from '../settings.js';

export const nav = (hash) => { if (location.hash !== hash) location.hash = hash; };

export function tagChips(note, { max = 4 } = {}) {
  const tags = (note.tags || []).map((id) => store.getTag(id)).filter((t) => t && !t.deleted);
  if (!tags.length) return '';
  return `<span class="tag-chips">${tags.slice(0, max).map((t) => `<span class="tag-chip c-${t.color}">${esc(t.name)}</span>`).join('')}${tags.length > max ? `<span class="tag-chip more">+${tags.length - max}</span>` : ''}</span>`;
}

function badges(n) {
  return `${n.pinned ? icon('pin', 'badge') : ''}${n.bookmarked ? icon('bookmark', 'badge') : ''}${n.source?.url ? icon(n.source.kind === 'paper' ? 'book-open' : 'newspaper', 'badge') : ''}${n.shareUrl ? icon('share-2', 'badge') : ''}`;
}

/** Card with title, date and a body snippet (home page). */
export function noteCard(n) {
  const thumb = n.html?.match(/<img[^>]*data-att="([^"]+)"/);
  return `<a class="note-card" href="#/note/${n.id}" data-id="${n.id}">
    <div class="note-card-top"><h3>${esc(n.title)}</h3>${badges(n)}</div>
    <p class="note-card-snip">${esc(snippet(n.text, n.title, 180)) || '<span class="muted">No additional text</span>'}</p>
    ${thumb ? `<img class="note-card-thumb" data-att="${thumb[1]}" alt="">` : ''}
    <div class="note-card-foot"><time title="${esc(fmtDateTime(n.created))}">${esc(fmtRelative(n.updated))}</time>${tagChips(n, { max: 3 })}</div>
  </a>`;
}

/** Compact list row (all-notes list, search, calendar). */
export function noteRow(n, { snippetHTML } = {}) {
  const folder = store.getFolder(n.folderId);
  return `<a class="note-row" href="#/note/${n.id}" data-id="${n.id}">
    <div class="note-row-main">
      <div class="note-row-title">${esc(n.title)}${badges(n)}</div>
      <div class="note-row-sub"><time>${esc(fmtRelative(n.updated))}</time><span class="note-row-snip">${snippetHTML ?? esc(snippet(n.text, n.title, 120))}</span></div>
      ${(folder || n.tags?.length) ? `<div class="note-row-meta">${folder ? `<span class="folder-chip">${icon('folder')}${esc(folder.name)}</span>` : ''}${tagChips(n)}</div>` : ''}
    </div>
    <button class="icon-btn note-row-more" data-more="${n.id}" aria-label="More actions">${icon('ellipsis')}</button>
  </a>`;
}

/** Hooks up "…" buttons and right-click / long-press on note rows and cards inside root. */
export function bindNoteActions(root, after) {
  root.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (!more) return;
    e.preventDefault();
    e.stopPropagation();
    const n = store.getNote(more.dataset.more);
    if (n) noteMenu(n, more).then(() => after?.());
  });
  root.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    e.preventDefault();
    const n = store.getNote(row.dataset.id);
    if (n) noteMenu(n, { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }).then(() => after?.());
  });
}

export async function noteMenu(n, anchor, { inNote = false } = {}) {
  const items = n.trashed ? [
    { label: 'Restore', icon: 'rotate-ccw', action: () => store.restoreNote(n.id).then(() => toast('Restored')) },
    { label: 'Delete forever', icon: 'trash-2', danger: true, action: async () => { if (await confirmDialog('Delete this note forever? This cannot be undone.', { ok: 'Delete', danger: true })) await store.deleteNoteForever(n.id); } },
  ] : [
    !inNote && { label: 'Open', icon: 'file-text', action: () => nav(`#/note/${n.id}`) },
    { label: n.pinned ? 'Unpin' : 'Pin', icon: 'pin', action: () => store.updateNote(n.id, { pinned: !n.pinned }, { touch: false }) },
    { label: n.bookmarked ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', action: () => store.updateNote(n.id, { bookmarked: !n.bookmarked }, { touch: false }) },
    { label: 'Tags…', icon: 'tag', action: () => tagPicker(anchor, n.tags, (tags) => store.updateNote(n.id, { tags }, { touch: false })) },
    { label: 'Move to folder…', icon: 'folder', action: () => folderPicker(anchor, n.folderId, (folderId) => store.updateNote(n.id, { folderId }, { touch: false })) },
    '-',
    { label: 'Share…', icon: 'share-2', action: () => shareSheet(n) },
    { label: 'Download…', icon: 'download', action: () => downloadSheet(n) },
    { label: 'Version history', icon: 'history', action: () => nav(`#/history/${n.id}`) },
    inNote && { label: n.titleManual ? 'Use automatic title' : 'Rename…', icon: 'type', key: 'rename' },
    '-',
    { label: 'Move to trash', icon: 'trash-2', danger: true, action: () => store.trashNote(n.id).then(() => toast('Moved to trash', { action: 'Undo', onAction: () => store.restoreNote(n.id) })) },
  ];
  return menu(items.filter(Boolean), anchor);
}

export function downloadSheet(n) {
  const body = h(`<div class="choice-list">
    <button class="choice" data-f="md">${icon('file-text')}<div><b>Markdown</b><small>For Obsidian and other apps (zip if it has images)</small></div></button>
    <button class="choice" data-f="html">${icon('globe')}<div><b>Web page</b><small>One file with images included</small></div></button>
    <button class="choice" data-f="pdf">${icon('file-down')}<div><b>PDF</b><small>Opens the print dialog — choose “Save as PDF”</small></div></button>
    <button class="choice" data-f="txt">${icon('type')}<div><b>Plain text</b></div></button>
  </div>`);
  const s = sheet({ title: 'Download note', body, className: 'small' });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    s.close();
    try { await downloadNote(store.getNote(n.id), b.dataset.f); } catch (err) { toast(err.message, { kind: 'error' }); }
  });
}

export function shareSheet(n) {
  const note = store.getNote(n.id);
  const body = h(`<div class="choice-list">
    <button class="choice" data-s="native">${icon('send')}<div><b>Send a copy</b><small>Messages, Mail, AirDrop… (or copy text)</small></div></button>
    <button class="choice" data-s="link">${icon('link')}<div><b>${note.shareUrl ? 'Update public link' : 'Create a share link'}</b><small>${hasServer() ? 'Read-only web page anyone with the link can open' : 'Needs your Cloudflare Worker or home server'}</small></div></button>
    ${note.shareUrl ? `<div class="share-url"><input class="input" readonly value="${esc(note.shareUrl)}"><button class="btn" data-s="copy">${icon('copy')} Copy</button></div>
    <button class="choice danger" data-s="unshare">${icon('x')}<div><b>Stop sharing</b><small>The link stops working</small></div></button>` : ''}
    <button class="choice" data-s="email">${icon('at-sign')}<div><b>Email</b><small>Opens your mail app with the note text</small></div></button>
  </div>`);
  const s = sheet({ title: 'Share', body, className: 'small' });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    const cur = store.getNote(n.id);
    try {
      if (b.dataset.s === 'native') { s.close(); const r = await shareNative(cur); if (r === 'copied') toast('Copied to clipboard'); }
      if (b.dataset.s === 'link') {
        b.disabled = true;
        const url = await publishShare(cur);
        await navigator.clipboard?.writeText(url).catch(() => {});
        toast('Share link copied');
        s.close();
        shareSheet(n);
      }
      if (b.dataset.s === 'copy') { await navigator.clipboard.writeText(cur.shareUrl); toast('Link copied'); }
      if (b.dataset.s === 'unshare') { await unpublishShare(cur); toast('Sharing stopped'); s.close(); }
      if (b.dataset.s === 'email') { s.close(); location.href = `mailto:?subject=${encodeURIComponent(cur.title)}&body=${encodeURIComponent(cur.text.slice(0, 8000))}`; }
    } catch (err) { b.disabled = false; toast(err.message, { kind: 'error' }); }
  });
}

/** Re-renders when store data changes; returns an unsubscribe. */
export function onDataChange(fn, events = ['notes', 'folders', 'tags']) {
  let t = null;
  const run = () => { clearTimeout(t); t = setTimeout(fn, 60); };
  const offs = events.map((e) => store.events.on(e, run));
  return () => { clearTimeout(t); offs.forEach((o) => o()); };
}
