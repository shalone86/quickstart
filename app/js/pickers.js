// Pop-up pickers: tags (multi-select + create), folders (single select + create), notes (for linking).

import * as store from './store.js';
import { esc, fmtRelative } from './util.js';
import { icon } from './icons.js';
import { h, popover, sheet } from './ui.js';
import { fold } from './text.js';

function openPicker(anchor, content, opts = {}) {
  // Popover anchored on wide screens; bottom sheet on phones so the keyboard does not cover it.
  if (window.matchMedia('(min-width: 700px)').matches && anchor) {
    return popover(anchor, content, { className: 'picker-pop', ...opts });
  }
  const s = sheet({ title: opts.title || '', body: content, className: 'picker-sheet', onClose: opts.onClose });
  return { el: s.sheet, close: s.close, place() {} };
}

/** Tag picker. Calls onChange(tagIds) on every toggle. */
export function tagPicker(anchor, selected, onChange) {
  let sel = new Set(selected || []);
  const root = h(`<div class="picker">
    <div class="picker-search">${icon('tag')}<input class="picker-input" placeholder="Find or create a tag" autocomplete="off" enterkeyhint="done"></div>
    <div class="picker-list" role="listbox" aria-multiselectable="true"></div>
  </div>`);
  const input = root.querySelector('input');
  const list = root.querySelector('.picker-list');
  let active = 0;
  const render = () => {
    const q = fold(input.value.trim().replace(/^#/, ''));
    const all = store.tags();
    const items = all.filter((t) => !q || fold(t.name).includes(q))
      .sort((a, b) => (sel.has(b.id) - sel.has(a.id)) || a.name.localeCompare(b.name));
    const exact = all.some((t) => fold(t.name) === q);
    let html = items.map((t, i) => `<button class="picker-item ${i === active ? 'active' : ''}" data-id="${t.id}" role="option" aria-selected="${sel.has(t.id)}">
      <span class="tag-dot c-${t.color}"></span><span class="picker-label">${esc(t.name)}</span>
      <span class="picker-count">${store.tagUsage(t.id) || ''}</span>${sel.has(t.id) ? icon('check', 'picker-check') : ''}</button>`).join('');
    if (q && !exact) html += `<button class="picker-item create ${items.length === active ? 'active' : ''}" data-create="1">${icon('plus')}<span class="picker-label">Create tag “${esc(input.value.trim().replace(/^#/, ''))}”</span></button>`;
    if (!html) html = '<div class="picker-empty">Type to create your first tag</div>';
    list.innerHTML = html;
  };
  const toggle = async (btn) => {
    if (!btn) return;
    if (btn.dataset.create) {
      const t = await store.createTag(input.value);
      sel.add(t.id);
      input.value = '';
    } else {
      const id = btn.dataset.id;
      sel.has(id) ? sel.delete(id) : sel.add(id);
    }
    onChange([...sel]);
    render();
    input.focus();
  };
  list.addEventListener('click', (e) => toggle(e.target.closest('.picker-item')));
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    const n = list.querySelectorAll('.picker-item').length;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(n - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); toggle(list.querySelectorAll('.picker-item')[active]); }
  });
  render();
  const p = openPicker(anchor, root, { title: 'Tags' });
  input.focus();
  return p;
}

/** Folder picker (single). onPick(folderId|null). */
export function folderPicker(anchor, current, onPick) {
  const root = h(`<div class="picker">
    <div class="picker-search">${icon('folder')}<input class="picker-input" placeholder="Find or create a folder" autocomplete="off"></div>
    <div class="picker-list"></div></div>`);
  const input = root.querySelector('input');
  const list = root.querySelector('.picker-list');
  let p;
  const render = () => {
    const q = fold(input.value.trim());
    const items = store.folders().filter((f) => !q || fold(f.name).includes(q));
    const exact = store.folders().some((f) => fold(f.name) === q);
    let html = `<button class="picker-item" data-id="">${icon('inbox')}<span class="picker-label">No folder</span>${!current ? icon('check', 'picker-check') : ''}</button>`;
    html += items.map((f) => `<button class="picker-item" data-id="${f.id}">${f.icon ? `<span class="emoji">${esc(f.icon)}</span>` : icon('folder')}<span class="picker-label">${esc(f.name)}</span>${current === f.id ? icon('check', 'picker-check') : ''}</button>`).join('');
    if (q && !exact) html += `<button class="picker-item create" data-create="1">${icon('folder-plus')}<span class="picker-label">New folder “${esc(input.value.trim())}”</span></button>`;
    list.innerHTML = html;
  };
  list.addEventListener('click', async (e) => {
    const b = e.target.closest('.picker-item');
    if (!b) return;
    let id = b.dataset.id || null;
    if (b.dataset.create) id = (await store.createFolder(input.value)).id;
    p.close();
    onPick(id);
  });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); list.querySelector('.create, .picker-item:nth-child(2)')?.click(); } });
  render();
  p = openPicker(anchor, root, { title: 'Move to folder' });
  if (window.matchMedia('(min-width: 700px)').matches) input.focus();
  return p;
}

/**
 * Note picker used for linking ("@" in the editor). onPick({id,title}) or onPick({create: title}).
 * Shows recent notes first; fuzzy-ish matching on title.
 */
export function notePicker(anchor, { exclude, initial = '', onPick, onClose }) {
  const root = h(`<div class="picker note-picker">
    <div class="picker-search">${icon('at-sign')}<input class="picker-input" placeholder="Link to a note…" autocomplete="off" enterkeyhint="go"></div>
    <div class="picker-list"></div></div>`);
  const input = root.querySelector('input');
  input.value = initial;
  const list = root.querySelector('.picker-list');
  let active = 0, picked = false, results = [];
  let p;
  const render = () => {
    const q = fold(input.value.trim());
    const notes = store.liveNotes().filter((n) => n.id !== exclude);
    results = q ? notes.map((n) => ({ n, s: score(fold(n.title), q) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.n.updated - a.n.updated).map((x) => x.n)
      : store.sortNotes(notes).slice(0, 30);
    results = results.slice(0, 30);
    let html = results.map((n, i) => `<button class="picker-item ${i === active ? 'active' : ''}" data-id="${n.id}">${icon('file-text')}<span class="picker-label">${esc(n.title)}</span><span class="picker-count">${fmtRelative(n.updated)}</span></button>`).join('');
    if (q) html += `<button class="picker-item create ${results.length === active ? 'active' : ''}" data-create="1">${icon('plus')}<span class="picker-label">New note “${esc(input.value.trim())}”</span></button>`;
    list.innerHTML = html || '<div class="picker-empty">No notes yet</div>';
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (b) => {
    if (!b) return;
    picked = true;
    p.close();
    if (b.dataset.create) onPick({ create: input.value.trim() });
    else onPick({ id: b.dataset.id, title: store.getNote(b.dataset.id)?.title });
  };
  list.addEventListener('click', (e) => choose(e.target.closest('.picker-item')));
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.picker-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(items[active]); }
    else if (e.key === 'Backspace' && !input.value) { p.close(); }
  });
  render();
  p = openPicker(anchor, root, { title: 'Link a note', onClose: () => { if (!picked) onClose?.(); } });
  input.focus();
  return p;
}

function score(title, q) {
  if (!title) return 0;
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.includes(` ${q}`)) return 60;
  if (title.includes(q)) return 40;
  // subsequence match
  let i = 0;
  for (const c of title) if (c === q[i]) i++;
  return i === q.length ? 10 : 0;
}
