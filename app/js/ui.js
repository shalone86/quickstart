// UI primitives: toasts, sheets (modal on desktop, bottom sheet on phones), menus, prompts, popovers.

import { esc } from './util.js';
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/* ---------- toast ---------- */
let toastWrap;
export function toast(msg, { action, onAction, timeout = 3500, kind = '' } = {}) {
  if (!toastWrap) { toastWrap = h('<div class="toasts" role="status" aria-live="polite"></div>'); document.body.appendChild(toastWrap); }
  const el = h(`<div class="toast ${kind}"><span>${esc(msg)}</span>${action ? `<button class="toast-btn">${esc(action)}</button>` : ''}</div>`);
  toastWrap.appendChild(el);
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  if (action) el.querySelector('button').onclick = () => { close(); onAction?.(); };
  setTimeout(close, timeout);
  return close;
}

/* ---------- sheet / modal ---------- */
const stack = [];
export function sheet({ title = '', body = '', className = '', full = false, onClose, actions = '' } = {}) {
  const el = h(`<div class="sheet-backdrop">
    <div class="sheet ${full ? 'full' : ''} ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      ${title !== null ? `<header class="sheet-head"><h2>${esc(title)}</h2><div class="sheet-actions">${actions}</div><button class="icon-btn sheet-close" aria-label="Close">${icon('x')}</button></header>` : ''}
      <div class="sheet-body"></div>
    </div></div>`);
  const bodyEl = el.querySelector('.sheet-body');
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    el.classList.remove('open');
    setTimeout(() => el.remove(), 220);
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    onClose?.(result);
  };
  el.addEventListener('pointerdown', (e) => { if (e.target === el) el._downOnBackdrop = true; });
  el.addEventListener('click', (e) => { if (e.target === el && el._downOnBackdrop) close(); el._downOnBackdrop = false; });
  el.querySelector('.sheet-close')?.addEventListener('click', () => close());
  const api = { el, body: bodyEl, close, sheet: el.querySelector('.sheet') };
  stack.push(api);
  return api;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) { e.preventDefault(); stack[stack.length - 1].close(); }
});

export function closeAllSheets() { [...stack].forEach((s) => s.close()); }

/* ---------- action menu ---------- */
/** items: [{label, icon, action, danger, checked, hint}] or '-' separators. Anchored on desktop, sheet on phones. */
export function menu(items, anchor) {
  return new Promise((resolve) => {
    const list = h('<div class="menu-list" role="menu"></div>');
    let done = false;
    let closer;
    for (const it of items) {
      if (it === '-') { list.appendChild(h('<div class="menu-sep"></div>')); continue; }
      if (!it) continue;
      const b = h(`<button class="menu-item ${it.danger ? 'danger' : ''}" role="menuitem">${it.icon ? icon(it.icon) : '<span class="ic"></span>'}<span class="menu-label">${esc(it.label)}</span>${it.hint ? `<span class="menu-hint">${esc(it.hint)}</span>` : ''}${it.checked ? icon('check', 'menu-check') : ''}</button>`);
      b.onclick = () => { done = true; closer(); resolve(it); it.action?.(); };
      list.appendChild(b);
    }
    if (anchor && window.matchMedia('(min-width: 700px)').matches) {
      const pop = popover(anchor, list, { onClose: () => { if (!done) resolve(null); } });
      closer = pop.close;
    } else {
      const s = sheet({ title: null, body: list, className: 'menu-sheet', onClose: () => { if (!done) resolve(null); } });
      closer = s.close;
    }
  });
}

/* ---------- popover ---------- */
let openPop = null;
export function popover(anchor, content, { onClose, className = '', align = 'start' } = {}) {
  openPop?.close();
  const el = h(`<div class="popover ${className}"></div>`);
  if (typeof content === 'string') el.innerHTML = content; else el.appendChild(content);
  document.body.appendChild(el);
  const place = () => {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    const pw = el.offsetWidth, ph = el.offsetHeight;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, innerWidth - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > innerHeight - 8 && r.top - ph - 6 > 8) top = r.top - ph - 6;
    top = Math.max(8, Math.min(top, innerHeight - ph - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  place();
  requestAnimationFrame(() => el.classList.add('open'));
  const outside = (e) => { if (!el.contains(e.target) && !(anchor.contains && anchor.contains(e.target))) close(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); });
  window.addEventListener('resize', place);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', place);
    el.remove();
    if (openPop === api) openPop = null;
    onClose?.();
  }
  const api = { el, close, place };
  openPop = api;
  return api;
}

export function closePopover() { openPop?.close(); }

/* ---------- dialogs ---------- */
export function confirmDialog(message, { ok = 'OK', danger = false, title = '' } = {}) {
  return new Promise((resolve) => {
    const body = h(`<div class="dialog"><p>${esc(message)}</p><div class="dialog-btns"><button class="btn ghost" data-r="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div></div>`);
    const s = sheet({ title, body, className: 'small', onClose: (r) => resolve(!!r) });
    body.querySelectorAll('button').forEach((b) => { b.onclick = () => s.close(b.dataset.r === '1'); });
    body.querySelector('[data-r="1"]').focus();
  });
}

export function promptDialog(message, { value = '', placeholder = '', ok = 'Save', title = '', multiline = false } = {}) {
  return new Promise((resolve) => {
    const field = multiline ? `<textarea class="input" rows="4" placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
    const body = h(`<form class="dialog">${message ? `<label class="dialog-label">${esc(message)}</label>` : ''}${field}<div class="dialog-btns"><button type="button" class="btn ghost" data-r="0">Cancel</button><button class="btn primary" type="submit">${esc(ok)}</button></div></form>`);
    let result = null;
    const s = sheet({ title, body, className: 'small', onClose: () => resolve(result) });
    const input = body.querySelector('.input');
    body.onsubmit = (e) => { e.preventDefault(); result = input.value; s.close(); };
    body.querySelector('[data-r="0"]').onclick = () => s.close();
    setTimeout(() => { input.focus(); input.select?.(); }, 50);
  });
}

/* ---------- misc ---------- */
export function spinner(label = '') {
  return `<div class="spinner-wrap"><span class="spinner"></span>${label ? `<span>${esc(label)}</span>` : ''}</div>`;
}

export function emptyState(ic, title, sub = '') {
  return `<div class="empty">${icon(ic, 'empty-ic')}<h3>${esc(title)}</h3>${sub ? `<p>${sub}</p>` : ''}</div>`;
}

export function pickFiles({ accept = '*/*', multiple = false, directory = false, capture } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (directory) input.webkitdirectory = true;
    if (capture) input.capture = capture;
    input.style.display = 'none';
    input.onchange = () => { resolve(Array.from(input.files || [])); input.remove(); };
    input.oncancel = () => { resolve([]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}
