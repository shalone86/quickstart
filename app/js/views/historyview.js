// Version history page for one note.

import * as store from '../store.js';
import * as db from '../db.js';
import { esc } from '../util.js';
import { icon } from '../icons.js';
import { toast } from '../ui.js';
import { renderHistory } from '../provenance.js';
import { diff, newSession } from '../history.js';
import { htmlToText } from '../text.js';
import { nav } from './common.js';

export function renderHistoryView(root, params, id) {
  const note = store.getNote(id);
  if (!note || note.deleted) { root.innerHTML = `<div class="empty"><h3>Note not found</h3></div>`; return () => {}; }
  root.innerHTML = `
    <header class="page-head"><div><div class="eyebrow">Version history</div><h1>${esc(note.title)}</h1></div>
      <div class="head-actions"><a class="btn ghost" href="#/note/${id}">${icon('chevron-left')} Back to note</a></div></header>
    <div class="history-body"></div>`;
  const body = root.querySelector('.history-body');
  const draw = () => renderHistory(body, note, {
    onRestore: async (html) => {
      const cur = store.getNote(id);
      // log the restore as one "undo/restore" edit so the history stays continuous
      const s = newSession(id, store.deviceId(), cur.text, cur.html);
      const d = diff(cur.text, htmlToText(html));
      if (d) s.ops.push([0, 'u', ...d]);
      s.cps.push([0, ...(diff(cur.html, html) || [0, 0, ''])]);
      await db.put('history', s);
      await store.updateNote(id, { html });
      toast('Version restored');
      nav(`#/note/${id}`);
    },
  });
  draw();
  return () => {};
}
