// Home: search bar, a Twitter-style "just type" composer, pinned notes, and the 3 most recent notes.

import * as store from '../store.js';
import { Editor } from '../editor.js';
import { settings } from '../settings.js';
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { h, toast } from '../ui.js';
import { tagPicker, folderPicker } from '../pickers.js';
import { noteCard, bindNoteActions, onDataChange, nav } from './common.js';
import { buildToolbar, editorHooks } from './toolbar.js';
import { syncBadge } from './syncbadge.js';

export function renderHome(root) {
  const now = new Date();
  const hour = now.getHours();
  const greet = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  root.innerHTML = `
    <header class="page-head home-head">
      <div>
        <div class="eyebrow">${esc(now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }))}</div>
        <h1>${greet}</h1>
      </div>
      <div class="head-actions"><span class="sync-slot"></span><a class="icon-btn" href="#/settings" aria-label="Settings">${icon('settings')}</a></div>
    </header>
    <form class="search-bar home-search" role="search">${icon('search')}<input class="input" name="q" type="search" placeholder="Search all notes" autocomplete="off" enterkeyhint="search"></form>
    <section class="composer card">
      <div class="composer-meta"><span class="composer-when">${esc(now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))} · ${esc(now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))}</span><span class="composer-chips"></span></div>
      <div class="composer-editor"></div>
      <div class="composer-bar">
        <div class="composer-tools"></div>
        <div class="composer-actions">
          <button class="icon-btn" data-a="tag" title="Tags" aria-label="Tags">${icon('tag')}</button>
          <button class="icon-btn" data-a="folder" title="Folder" aria-label="Folder">${icon('folder')}</button>
          <button class="icon-btn" data-a="expand" title="Open full editor" aria-label="Open full editor">${icon('square-pen')}</button>
          <button class="btn primary composer-save" data-a="save" disabled>Save</button>
        </div>
      </div>
    </section>
    <section class="home-pinned"></section>
    <section class="home-recent"></section>
    <section class="home-folders"></section>`;

  root.querySelector('.sync-slot').appendChild(syncBadge());

  // search → search page
  const form = root.querySelector('.home-search');
  form.onsubmit = (e) => { e.preventDefault(); const q = form.q.value.trim(); if (q) nav(`#/search?q=${encodeURIComponent(q)}`); };
  form.q.addEventListener('input', () => { if (form.q.value.trim().length >= 2) { const q = form.q.value; nav(`#/search?q=${encodeURIComponent(q)}`); } });

  // composer
  const composerFields = { tags: [], folderId: null };
  const edWrap = root.querySelector('.composer-editor');
  const saveBtn = root.querySelector('.composer-save');
  let editor;
  const makeEditor = () => {
    editor?.destroy();
    edWrap.innerHTML = '';
    editor = new Editor(edWrap, {
      note: null,
      compact: true,
      placeholder: 'What’s on your mind?',
      onSubmit: () => post(),
      onCreate: () => { saveBtn.disabled = false; },
      onSaved: () => { saveBtn.disabled = editor.isEmpty(); },
    });
    editor.newNoteFields = () => ({ tags: [...composerFields.tags], folderId: composerFields.folderId });
    editor.hooks = editorHooks(editor);
    editor.el.addEventListener('input', () => { saveBtn.disabled = editor.isEmpty(); });
    const tools = root.querySelector('.composer-tools');
    tools.innerHTML = '';
    tools.appendChild(buildToolbar(editor, { compact: true }));
  };
  const renderChips = () => {
    const chips = [];
    const f = store.getFolder(composerFields.folderId);
    if (f) chips.push(`<span class="folder-chip">${icon('folder')}${esc(f.name)}</span>`);
    for (const id of composerFields.tags) { const t = store.getTag(id); if (t) chips.push(`<span class="tag-chip c-${t.color}">${esc(t.name)}</span>`); }
    root.querySelector('.composer-chips').innerHTML = chips.join('');
  };
  const applyFields = () => { if (editor.note) store.updateNote(editor.note.id, { tags: [...composerFields.tags], folderId: composerFields.folderId }, { touch: false }); renderChips(); };
  async function post() {
    if (editor.isEmpty()) return;
    await editor.persist();
    editor.flush();
    const note = editor.note;
    toast('Note saved', { action: 'Open', onAction: () => nav(`#/note/${note.id}`) });
    composerFields.tags = [];
    composerFields.folderId = null;
    renderChips();
    makeEditor();
    renderLists();
    saveBtn.disabled = true;
    editor.focus();
  }
  root.querySelector('.composer-actions').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    if (b.dataset.a === 'save') post();
    if (b.dataset.a === 'tag') tagPicker(b, composerFields.tags, (tags) => { composerFields.tags = tags; applyFields(); });
    if (b.dataset.a === 'folder') folderPicker(b, composerFields.folderId, (id) => { composerFields.folderId = id; applyFields(); });
    if (b.dataset.a === 'expand') {
      const n = await editor.ensureNote();
      await editor.persist();
      editor.flush();
      if (!editor.isEmpty() || n) nav(`#/note/${n.id}`);
    }
  });
  makeEditor();

  // lists
  const renderLists = () => {
    const live = store.sortNotes(store.liveNotes());
    const current = editor?.note?.id;
    const pinned = live.filter((n) => n.pinned);
    const recent = live.filter((n) => n.id !== current).slice(0, settings().recentCount || 3);
    root.querySelector('.home-pinned').innerHTML = pinned.length ? `<h2 class="sec-title">${icon('pin')} Pinned</h2><div class="card-row">${pinned.map(noteCard).join('')}</div>` : '';
    root.querySelector('.home-recent').innerHTML = `<div class="sec-head"><h2 class="sec-title">Recent</h2><a class="sec-link" href="#/notes">All notes ${icon('chevron-right')}</a></div>
      ${recent.length ? `<div class="card-grid">${recent.map(noteCard).join('')}</div>` : `<p class="muted hint">Your newest notes show up here. Type above and press <b>Save</b> (or ⌘/Ctrl + Enter).</p>`}`;
    const folders = store.folders();
    root.querySelector('.home-folders').innerHTML = `<div class="sec-head"><h2 class="sec-title">Collections</h2><a class="sec-link" href="#/organize">Manage ${icon('chevron-right')}</a></div>
      <div class="pill-row">
        <a class="pill" href="#/notes">${icon('notebook-pen')} All notes <b>${live.length}</b></a>
        <a class="pill" href="#/notes?filter=bookmarks">${icon('bookmark')} Bookmarks <b>${live.filter((n) => n.bookmarked).length}</b></a>
        ${folders.map((f) => `<a class="pill" href="#/notes?folder=${f.id}">${f.icon ? `<span class="emoji">${esc(f.icon)}</span>` : icon('folder')} ${esc(f.name)} <b>${live.filter((n) => n.folderId === f.id).length}</b></a>`).join('')}
        <a class="pill ghost" href="#/organize?new=folder">${icon('folder-plus')} New folder</a>
      </div>`;
    store.hydrateMedia(root.querySelector('.home-recent'));
    store.hydrateMedia(root.querySelector('.home-pinned'));
  };
  renderLists();
  bindNoteActions(root, renderLists);
  const off = onDataChange(renderLists);
  // focus composer on desktop
  if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => editor.focus(), 50);

  return () => { off(); editor.destroy(); };
}
