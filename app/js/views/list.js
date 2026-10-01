// Text list of all notes, filterable by folder / tag / bookmarks / trash, grouped by date.

import * as store from '../store.js';
import { esc, dateGroup } from '../util.js';
import { icon } from '../icons.js';
import { menu, toast, confirmDialog } from '../ui.js';
import { noteRow, bindNoteActions, onDataChange, nav } from './common.js';
import { syncBadge } from './syncbadge.js';

let sortBy = 'updated';
try { sortBy = localStorage.getItem('sortBy') || 'updated'; } catch { /* ignore */ }

export function renderList(root, params) {
  const folderId = params.get('folder');
  const tagId = params.get('tag');
  const filter = params.get('filter'); // bookmarks | trash | pinned | unfiled
  const folder = store.getFolder(folderId);
  const tag = store.getTag(tagId);
  const title = folder ? folder.name : tag ? `#${tag.name}` : filter === 'bookmarks' ? 'Bookmarks' : filter === 'trash' ? 'Trash' : filter === 'unfiled' ? 'No folder' : 'All notes';

  root.innerHTML = `
    <header class="page-head">
      <div><div class="eyebrow">${folder ? 'Folder' : tag ? 'Tag' : 'Notes'}</div><h1>${folder?.icon ? `<span class="emoji">${esc(folder.icon)}</span> ` : ''}${esc(title)}</h1></div>
      <div class="head-actions"><span class="sync-slot"></span>
        <button class="icon-btn" data-a="sort" aria-label="Sort">${icon('layers')}</button>
        ${filter === 'trash' ? `<button class="btn ghost" data-a="empty">Empty trash</button>` : `<button class="btn primary" data-a="new">${icon('square-pen')} New</button>`}
      </div>
    </header>
    <nav class="filter-row"></nav>
    <div class="list-body"></div>`;
  root.querySelector('.sync-slot').appendChild(syncBadge());

  const renderFilters = () => {
    const live = store.liveNotes();
    const chip = (href, label, active, ic = '', count = '') => `<a class="filter-chip ${active ? 'on' : ''}" href="${href}">${ic}${esc(label)}${count !== '' ? ` <b>${count}</b>` : ''}</a>`;
    const parts = [
      chip('#/notes', 'All', !folderId && !tagId && !filter, '', live.length),
      chip('#/notes?filter=bookmarks', 'Bookmarks', filter === 'bookmarks', icon('bookmark')),
      ...store.folders().map((f) => chip(`#/notes?folder=${f.id}`, f.name, f.id === folderId, f.icon ? `<span class="emoji">${esc(f.icon)}</span>` : icon('folder'))),
      ...store.tags().map((t) => chip(`#/notes?tag=${t.id}`, t.name, t.id === tagId, `<span class="tag-dot c-${t.color}"></span>`)),
      chip('#/notes?filter=trash', 'Trash', filter === 'trash', icon('trash-2'), store.trashedNotes().length || ''),
    ];
    root.querySelector('.filter-row').innerHTML = parts.join('');
    root.querySelector('.filter-row .on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  };

  const render = () => {
    renderFilters();
    let notes = filter === 'trash' ? store.trashedNotes() : store.liveNotes();
    if (folderId) notes = notes.filter((n) => n.folderId === folderId);
    if (tagId) notes = notes.filter((n) => n.tags?.includes(tagId));
    if (filter === 'bookmarks') notes = notes.filter((n) => n.bookmarked);
    if (filter === 'unfiled') notes = notes.filter((n) => !n.folderId);
    store.sortNotes(notes, sortBy);
    const body = root.querySelector('.list-body');
    if (!notes.length) {
      body.innerHTML = `<div class="empty">${icon(filter === 'trash' ? 'trash-2' : filter === 'bookmarks' ? 'bookmark' : 'notebook-pen', 'empty-ic')}<h3>${filter === 'trash' ? 'Trash is empty' : filter === 'bookmarks' ? 'No bookmarks yet' : 'No notes here yet'}</h3><p>${filter === 'bookmarks' ? 'Use the bookmark button on any note to keep it here.' : filter === 'trash' ? 'Deleted notes stay here until you empty the trash.' : 'Start one with the New button.'}</p></div>`;
      return;
    }
    const pinned = filter === 'trash' ? [] : notes.filter((n) => n.pinned);
    const rest = notes.filter((n) => !pinned.includes(n));
    let html = '';
    if (pinned.length) html += `<h2 class="group-title">${icon('pin')} Pinned</h2><div class="rows">${pinned.map((n) => noteRow(n)).join('')}</div>`;
    if (sortBy === 'title') html += `<div class="rows">${rest.map((n) => noteRow(n)).join('')}</div>`;
    else {
      let group = null;
      for (const n of rest) {
        const g = dateGroup(sortBy === 'created' ? n.created : n.updated);
        if (g !== group) { if (group !== null) html += '</div>'; html += `<h2 class="group-title">${esc(g)}</h2><div class="rows">`; group = g; }
        html += noteRow(n);
      }
      if (group !== null) html += '</div>';
    }
    body.innerHTML = html;
  };
  render();
  bindNoteActions(root, render);
  const off = onDataChange(render);

  root.querySelector('.head-actions').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-a]');
    if (!b) return;
    if (b.dataset.a === 'new') {
      const n = await store.createNote({ folderId: folderId || null, tags: tagId ? [tagId] : [], bookmarked: filter === 'bookmarks' });
      nav(`#/note/${n.id}?new=1`);
    }
    if (b.dataset.a === 'sort') {
      const pick = await menu([
        { label: 'Date edited', icon: 'clock', v: 'updated', checked: sortBy === 'updated' },
        { label: 'Date created', icon: 'calendar', v: 'created', checked: sortBy === 'created' },
        { label: 'Title', icon: 'type', v: 'title', checked: sortBy === 'title' },
      ], b);
      if (pick) { sortBy = pick.v; try { localStorage.setItem('sortBy', sortBy); } catch { /* ignore */ } render(); }
    }
    if (b.dataset.a === 'empty') {
      const t = store.trashedNotes();
      if (t.length && await confirmDialog(`Permanently delete ${t.length} note${t.length > 1 ? 's' : ''}?`, { ok: 'Delete', danger: true })) {
        for (const n of t) await store.deleteNoteForever(n.id);
        toast('Trash emptied');
      }
    }
  });
  return off;
}
