// Full note editor: formatting toolbar, tags, folder, pin/bookmark, backlinks, history, share.

import * as store from '../store.js';
import { Editor } from '../editor.js';
import { esc, fmtDateTime, fmtRelative } from '../util.js';
import { wordCount } from '../text.js';
import { icon } from '../icons.js';
import { promptDialog, toast } from '../ui.js';
import { tagPicker, folderPicker } from '../pickers.js';
import { noteMenu, shareSheet, nav, onDataChange } from './common.js';
import { buildToolbar, editorHooks } from './toolbar.js';
import { openNoteAsk } from './askpanel.js';
import { syncBadge } from './syncbadge.js';

export function renderNote(root, params, id) {
  let note = store.getNote(id);
  if (!note || note.deleted) {
    root.innerHTML = `<div class="empty">${icon('file-text', 'empty-ic')}<h3>Note not found</h3><p>It may have been deleted, or it hasn't synced to this device yet.</p><a class="btn" href="#/">Go home</a></div>`;
    return () => {};
  }
  root.innerHTML = `
    <div class="note-view ${note.trashed ? 'trashed' : ''}">
      <header class="note-head">
        <button class="icon-btn back" data-a="back" aria-label="Back">${icon('chevron-left')}</button>
        <div class="note-head-mid"><button class="folder-btn" data-a="folder"></button></div>
        <div class="head-actions">
          <span class="sync-slot"></span>
          <button class="icon-btn ask-btn" data-a="ask" aria-label="Ask AI about this note" title="Ask AI about this note">${icon('sparkles')}</button>
          <button class="icon-btn" data-a="tags" aria-label="Tags" title="Tags">${icon('tag')}</button>
          <button class="icon-btn" data-a="pin" aria-label="Pin" title="Pin">${icon('pin')}</button>
          <button class="icon-btn" data-a="bookmark" aria-label="Bookmark" title="Bookmark">${icon('bookmark')}</button>
          <button class="icon-btn" data-a="share" aria-label="Share" title="Share">${icon('share-2')}</button>
          <button class="icon-btn" data-a="more" aria-label="More" title="More">${icon('ellipsis')}</button>
        </div>
      </header>
      ${note.trashed ? `<div class="banner">This note is in the trash. <button class="btn small" data-a="restore">Restore</button></div>` : ''}
      <div class="note-toolbar"></div>
      <article class="note-paper">
        <div class="note-meta"></div>
        <div class="note-editor"></div>
        <footer class="note-foot"></footer>
      </article>
    </div>`;
  root.querySelector('.sync-slot').appendChild(syncBadge());

  const editor = new Editor(root.querySelector('.note-editor'), { note, placeholder: 'Start writing… type @ to link a note' });
  editor.hooks = editorHooks(editor);
  editor.el.classList.add('note-body');
  root.querySelector('.note-toolbar').appendChild(buildToolbar(editor));
  if (note.trashed) editor.el.setAttribute('contenteditable', 'false');

  const renderHead = () => {
    note = store.getNote(id) || note;
    const f = store.getFolder(note.folderId);
    root.querySelector('.folder-btn').innerHTML = `${f?.icon ? `<span class="emoji">${esc(f.icon)}</span>` : icon('folder')}<span>${esc(f ? f.name : 'Notes')}</span>${icon('chevron-down')}`;
    root.querySelector('[data-a="pin"]').classList.toggle('on', !!note.pinned);
    root.querySelector('[data-a="bookmark"]').classList.toggle('on', !!note.bookmarked);
    const words = wordCount(note.text);
    root.querySelector('.note-meta').innerHTML = `
      ${note.titleManual ? `<div class="note-manual-title">${esc(note.title)}</div>` : ''}
      <time title="Created">${esc(fmtDateTime(note.created))}</time>
      <span>· edited ${esc(fmtRelative(note.updated))}</span><span>· ${words} word${words === 1 ? '' : 's'}</span>
      <a class="meta-link" href="#/history/${note.id}">${icon('history')} History</a>`;
    renderFoot();
  };

  const renderFoot = () => {
    const tags = (note.tags || []).map((t) => store.getTag(t)).filter((t) => t && !t.deleted);
    const links = store.backlinks(note.id);
    const out = Array.from(editor.el.querySelectorAll('a.note-link')).map((a) => store.getNote(a.dataset.noteId)).filter((n) => n && !n.deleted);
    const uniq = [...new Map(out.map((n) => [n.id, n])).values()];
    root.querySelector('.note-foot').innerHTML = `
      <div class="foot-tags">${tags.map((t) => `<a class="tag-chip c-${t.color}" href="#/notes?tag=${t.id}">${esc(t.name)}</a>`).join('')}<button class="tag-chip add" data-a="tags">${icon('plus')} Tag</button></div>
      ${note.source?.url ? `<div class="foot-source">${icon(note.source.kind === 'paper' ? 'book-open' : 'newspaper')} Saved from <a href="${esc(note.source.url)}" target="_blank" rel="noopener noreferrer">${esc(note.source.site || new URL(note.source.url).hostname)}</a></div>` : ''}
      ${note.shareUrl ? `<div class="foot-source">${icon('share-2')} Shared at <a href="${esc(note.shareUrl)}" target="_blank" rel="noopener">${esc(note.shareUrl)}</a></div>` : ''}
      ${links.length || uniq.length ? `<div class="foot-links">
        ${links.length ? `<h4>Linked from</h4>${links.map((n) => `<a class="link-chip" href="#/note/${n.id}">${icon('arrow-up-right')}${esc(n.title)}</a>`).join('')}` : ''}
        ${uniq.length ? `<h4>Links to</h4>${uniq.map((n) => `<a class="link-chip" href="#/note/${n.id}">${icon('link')}${esc(n.title)}</a>`).join('')}` : ''}
      </div>` : ''}`;
  };

  renderHead();
  editor.onSaved = () => renderHead();

  root.querySelector('.note-view').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b || b.closest('.toolbar') || b.closest('.editor')) return;
    const a = b.dataset.a;
    if (a === 'back') { editor.flush(); history.length > 1 ? history.back() : nav('#/'); }
    if (a === 'folder') folderPicker(b, note.folderId, (folderId) => store.updateNote(id, { folderId }, { touch: false }));
    if (a === 'tags') tagPicker(b, note.tags, (tags) => store.updateNote(id, { tags }, { touch: false }));
    if (a === 'pin') { await store.updateNote(id, { pinned: !note.pinned }, { touch: false }); toast(note.pinned ? 'Pinned' : 'Unpinned'); }
    if (a === 'bookmark') { await store.updateNote(id, { bookmarked: !note.bookmarked }, { touch: false }); toast(note.bookmarked ? 'Bookmarked' : 'Bookmark removed'); }
    if (a === 'share') { editor.flush(); shareSheet(note); }
    if (a === 'ask') openNoteAsk(editor);
    if (a === 'restore') { await store.restoreNote(id); window.dispatchEvent(new Event('app:rerender')); }
    if (a === 'more') {
      editor.flush();
      const pick = await noteMenu(note, b, { inNote: true });
      if (pick?.key === 'rename') {
        if (note.titleManual) await store.updateNote(id, { titleManual: false }, { touch: false });
        else {
          const t = await promptDialog('Note title', { value: note.title, ok: 'Rename' });
          if (t !== null && t.trim()) await store.updateNote(id, { title: t.trim(), titleManual: true }, { touch: false });
        }
      }
      if (store.getNote(id)?.trashed) nav('#/notes');
    }
  });

  // live updates from sync (another device edited this note)
  const offRemote = store.events.on('notes', (d) => {
    if (d.type === 'remote' && d.records.some((r) => r.id === id)) {
      const fresh = store.getNote(id);
      if (fresh && fresh.html !== editor.getHTML() && document.activeElement !== editor.el) {
        editor.lastSavedHtml = fresh.html;
        editor.el.innerHTML = fresh.html;
        editor.normalize();
        editor.decorate();
        store.hydrateMedia(editor.el);
        editor.recorder?.resync('e');
      }
      renderHead();
    }
  });
  const offData = onDataChange(renderHead, ['folders', 'tags']);
  const offNotes = store.events.on('notes', (d) => { if (d.type !== 'remote' && d.note?.id === id && d.fields && !('html' in d.fields)) renderHead(); });

  if (params.get('new') === '1' || !note.text) setTimeout(() => editor.placeCaretAtEnd(), 50);

  // Expose for the history view's restore
  root._editor = editor;
  return () => {
    offRemote(); offData(); offNotes();
    editor.destroy();
    const n = store.getNote(id);
    // drop notes that were opened and left completely empty
    if (n && !n.deleted && !n.html && !n.text && !store.attachmentsFor(id).length && Date.now() - n.created < 10 * 60 * 1000) store.deleteNoteForever(id);
  };
}
