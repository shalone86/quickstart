// Calendar: tap a day to see the notes written (or edited) that day.

import * as store from '../store.js';
import { dayKey, esc, pad2 } from '../util.js';
import { icon } from '../icons.js';
import { noteRow, bindNoteActions, onDataChange } from './common.js';

export function renderCalendar(root, params) {
  const today = new Date();
  let [y, m] = (params.get('month') || `${today.getFullYear()}-${today.getMonth() + 1}`).split('-').map(Number);
  let selected = params.get('day') || dayKey(today);
  let mode = 'created';

  root.innerHTML = `
    <header class="page-head"><div><div class="eyebrow">Calendar</div><h1 class="cal-title"></h1></div>
      <div class="head-actions">
        <div class="seg"><button data-mode="created" class="on">Written</button><button data-mode="updated">Edited</button></div>
        <button class="icon-btn" data-nav="-1" aria-label="Previous month">${icon('chevron-left')}</button>
        <button class="btn ghost small" data-nav="0">Today</button>
        <button class="icon-btn" data-nav="1" aria-label="Next month">${icon('chevron-right')}</button>
      </div></header>
    <div class="cal-grid" role="grid"></div>
    <section class="cal-day"></section>`;

  const counts = () => {
    const map = new Map();
    for (const n of store.liveNotes()) {
      const k = dayKey(mode === 'created' ? n.created : n.updated);
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  };

  const render = () => {
    const first = new Date(y, m - 1, 1);
    root.querySelector('.cal-title').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const startDow = (first.getDay() + 6) % 7; // Monday first
    const days = new Date(y, m, 0).getDate();
    const map = counts();
    const max = Math.max(1, ...map.values());
    const dows = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }));
    let html = dows.map((d) => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < startDow; i++) html += '<div class="cal-cell empty"></div>';
    for (let d = 1; d <= days; d++) {
      const k = `${y}-${pad2(m)}-${pad2(d)}`;
      const c = map.get(k) || 0;
      const level = c ? Math.ceil((c / max) * 3) : 0;
      html += `<button class="cal-cell ${k === dayKey(today) ? 'today' : ''} ${k === selected ? 'sel' : ''} lv${level}" data-day="${k}" aria-label="${k}, ${c} notes"><span class="cal-num">${d}</span>${c ? `<span class="cal-dots">${'<i></i>'.repeat(Math.min(c, 3))}</span>` : ''}</button>`;
    }
    root.querySelector('.cal-grid').innerHTML = html;
    renderDay();
  };

  const renderDay = () => {
    const notes = store.sortNotes(store.liveNotes().filter((n) => dayKey(mode === 'created' ? n.created : n.updated) === selected), mode);
    const date = new Date(`${selected}T12:00:00`);
    root.querySelector('.cal-day').innerHTML = `<h2 class="sec-title">${esc(date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</h2>
      ${notes.length ? `<div class="rows">${notes.map((n) => noteRow(n)).join('')}</div>` : `<p class="muted hint">No notes ${mode === 'created' ? 'written' : 'edited'} this day.</p>`}`;
  };

  root.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-day]');
    if (cell) { selected = cell.dataset.day; root.querySelectorAll('.cal-cell.sel').forEach((c) => c.classList.remove('sel')); cell.classList.add('sel'); renderDay(); return; }
    const navb = e.target.closest('[data-nav]');
    if (navb) {
      const v = +navb.dataset.nav;
      if (v === 0) { y = today.getFullYear(); m = today.getMonth() + 1; selected = dayKey(today); }
      else { m += v; if (m < 1) { m = 12; y--; } if (m > 12) { m = 1; y++; } }
      render();
      return;
    }
    const mb = e.target.closest('[data-mode]');
    if (mb) { mode = mb.dataset.mode; root.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b === mb)); render(); }
  });
  // swipe between months
  let sx = null;
  const grid = root.querySelector('.cal-grid');
  grid.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  grid.addEventListener('touchend', (e) => {
    if (sx === null) return;
    const dx = e.changedTouches[0].clientX - sx;
    sx = null;
    if (Math.abs(dx) > 60) root.querySelector(`[data-nav="${dx < 0 ? 1 : -1}"]`).click();
  });
  render();
  bindNoteActions(root, renderDay);
  return onDataChange(render);
}
