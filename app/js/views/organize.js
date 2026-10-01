// Folders & tags management.

import * as store from '../store.js';
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { promptDialog, confirmDialog, menu, toast } from '../ui.js';
import { onDataChange } from './common.js';

export function renderOrganize(root, params) {
  root.innerHTML = `
    <header class="page-head"><div><div class="eyebrow">Organize</div><h1>Folders & tags</h1></div></header>
    <section class="card"><div class="sec-head"><h2 class="sec-title">${icon('folder')} Folders</h2><button class="btn small" data-a="new-folder">${icon('folder-plus')} New folder</button></div><div class="org-folders"></div></section>
    <section class="card"><div class="sec-head"><h2 class="sec-title">${icon('tag')} Tags</h2><button class="btn small" data-a="new-tag">${icon('plus')} New tag</button></div><div class="org-tags"></div></section>`;
  const render = () => {
    const live = store.liveNotes();
    const folders = store.folders();
    root.querySelector('.org-folders').innerHTML = folders.length ? folders.map((f, i) => `<div class="org-row">
      <a href="#/notes?folder=${f.id}">${f.icon ? `<span class="emoji">${esc(f.icon)}</span>` : icon('folder')}<b>${esc(f.name)}</b><span class="muted">${live.filter((n) => n.folderId === f.id).length}</span></a>
      <div class="org-btns">
        <button class="icon-btn" data-up="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon('chevron-left', 'rot90')}</button>
        <button class="icon-btn" data-fmenu="${f.id}" aria-label="Folder actions">${icon('ellipsis')}</button></div></div>`).join('')
      : '<p class="muted hint">Folders hold projects or collections. A note lives in one folder.</p>';
    const tags = store.tags();
    root.querySelector('.org-tags').innerHTML = tags.length ? `<div class="tag-cloud">${tags.map((t) => `<span class="tag-edit"><a class="tag-chip c-${t.color}" href="#/notes?tag=${t.id}">${esc(t.name)} <b>${store.tagUsage(t.id)}</b></a><button class="icon-btn small" data-tmenu="${t.id}" aria-label="Tag actions">${icon('ellipsis')}</button></span>`).join('')}</div>`
      : '<p class="muted hint">Tags cut across folders. Add them from any note with the tag button — type a new name to create one.</p>';
  };
  render();
  const off = onDataChange(render);

  const newFolder = async () => {
    const name = await promptDialog('Folder name', { placeholder: 'e.g. Church projects', ok: 'Create' });
    if (name?.trim()) { await store.createFolder(name); toast('Folder created'); }
  };
  if (params.get('new') === 'folder') setTimeout(newFolder, 100);

  root.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.a === 'new-folder') newFolder();
    if (b.dataset.a === 'new-tag') { const n = await promptDialog('Tag name', { ok: 'Create' }); if (n?.trim()) await store.createTag(n); }
    if (b.dataset.up) {
      const fs = store.folders();
      const i = +b.dataset.up;
      await store.updateFolder(fs[i].id, { order: i - 1 });
      await store.updateFolder(fs[i - 1].id, { order: i });
      fs.forEach((f, j) => { if (j !== i && j !== i - 1 && f.order !== j) store.updateFolder(f.id, { order: j }); });
    }
    if (b.dataset.fmenu) {
      const f = store.getFolder(b.dataset.fmenu);
      await menu([
        { label: 'Rename', icon: 'type', action: async () => { const n = await promptDialog('Folder name', { value: f.name, ok: 'Rename' }); if (n?.trim()) store.updateFolder(f.id, { name: n.trim() }); } },
        { label: 'Set emoji', icon: 'star', action: async () => { const n = await promptDialog('Emoji (leave empty for none)', { value: f.icon || '', ok: 'Save' }); if (n !== null) store.updateFolder(f.id, { icon: [...n.trim()].slice(0, 2).join('') }); } },
        { label: 'Delete folder', icon: 'trash-2', danger: true, action: async () => { if (await confirmDialog(`Delete “${f.name}”? Its notes are kept and move to “No folder”.`, { ok: 'Delete', danger: true })) store.deleteFolder(f.id); } },
      ], b);
    }
    if (b.dataset.tmenu) {
      const t = store.getTag(b.dataset.tmenu);
      await menu([
        { label: 'Rename', icon: 'type', action: async () => { const n = await promptDialog('Tag name', { value: t.name, ok: 'Rename' }); if (n?.trim()) store.updateTag(t.id, { name: n.trim().replace(/^#/, '') }); } },
        ...store.tagColors.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), icon: 'circle', checked: t.color === c, action: () => store.updateTag(t.id, { color: c }) })),
        '-',
        { label: 'Delete tag', icon: 'trash-2', danger: true, action: async () => { if (await confirmDialog(`Delete tag “${t.name}”? Notes keep their content.`, { ok: 'Delete', danger: true })) store.deleteTag(t.id); } },
      ], b);
    }
  });
  return off;
}
