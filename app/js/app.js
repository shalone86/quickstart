// App shell: startup, routing, sidebar (desktop) and tab bar (phone).

import * as store from './store.js';
import * as db from './db.js';
import { loadSettings } from './settings.js';
import { applyAppearance } from './theme.js';
import { startSync } from './sync/engine.js';
import { newSession } from './history.js';
import { isUrl, esc } from './util.js';
import { icon } from './icons.js';
import { $, closeAllSheets, closePopover, toast } from './ui.js';
import { saveArticle } from './article.js';
import { renderHome } from './views/home.js';
import { renderList } from './views/list.js';
import { renderNote } from './views/note.js';
import { renderCalendar } from './views/calendar.js';
import { renderSearch } from './views/search.js';
import { renderNews } from './views/news.js';
import { renderAsk } from './views/ask.js';
import { renderSettings } from './views/settings.js';
import { renderOrganize } from './views/organize.js';
import { renderHistoryView } from './views/historyview.js';
import { onDataChange } from './views/common.js';
import { syncBadge } from './views/syncbadge.js';

const ROUTES = [
  [/^\/?$/, renderHome, 'home'],
  [/^\/notes$/, renderList, 'notes'],
  [/^\/note\/([\w-]+)$/, renderNote, 'notes'],
  [/^\/history\/([\w-]+)$/, renderHistoryView, 'notes'],
  [/^\/calendar$/, renderCalendar, 'calendar'],
  [/^\/search$/, renderSearch, 'search'],
  [/^\/news$/, renderNews, 'news'],
  [/^\/ask$/, renderAsk, 'ask'],
  [/^\/settings$/, renderSettings, 'settings'],
  [/^\/organize$/, renderOrganize, 'notes'],
];

let cleanup = null;
let currentKey = null;

function route() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const key = raw;
  // the search page rewrites its own URL while typing; don't rebuild it
  if (currentKey && currentKey.startsWith('/search') && path === '/search' && cleanup) { currentKey = key; return; }
  currentKey = key;
  closeAllSheets();
  closePopover();
  try { cleanup?.(); } catch (e) { console.error(e); }
  cleanup = null;
  const view = $('#view');
  view.innerHTML = '';
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  for (const [re, fn, tab] of ROUTES) {
    const m = path.match(re);
    if (!m) continue;
    document.body.dataset.route = tab;
    document.body.classList.toggle('in-note', path.startsWith('/note/'));
    markNav(tab, raw);
    cleanup = fn(view, params, m[1]) || null;
    return;
  }
  view.innerHTML = `<div class="empty"><h3>Page not found</h3><a class="btn" href="#/">Go home</a></div>`;
}

function markNav(tab, raw) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const target = a.getAttribute('href').replace(/^#/, '');
    a.classList.toggle('on', a.dataset.nav === tab && (a.dataset.exact ? target === raw : true));
  });
  document.querySelectorAll('.side-list a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#${raw}`));
}

function shell() {
  document.body.innerHTML = `
    <div class="app">
      <aside class="sidebar" aria-label="Navigation">
        <div class="brand"><img src="icons/icon.svg" alt="" width="28" height="28"><span>Scriptorium</span><span class="side-sync"></span></div>
        <a class="side-new btn primary" href="#/">${icon('square-pen')} New note</a>
        <nav class="side-nav">
          <a href="#/" data-nav="home">${icon('home')} Home</a>
          <a href="#/search" data-nav="search">${icon('search')} Search</a>
          <a href="#/notes" data-nav="notes" data-exact="1">${icon('notebook-pen')} All notes</a>
          <a href="#/notes?filter=bookmarks" data-nav="notes" data-exact="1">${icon('bookmark')} Bookmarks</a>
          <a href="#/calendar" data-nav="calendar">${icon('calendar')} Calendar</a>
          <a href="#/news" data-nav="news">${icon('newspaper')} News & papers</a>
          <a href="#/ask" data-nav="ask">${icon('sparkles')} Ask AI</a>
        </nav>
        <div class="side-sec"><div class="side-sec-head"><span>Folders</span><a href="#/organize?new=folder" aria-label="New folder">${icon('plus')}</a></div><div class="side-list side-folders"></div></div>
        <div class="side-sec"><div class="side-sec-head"><span>Tags</span><a href="#/organize" aria-label="Manage tags">${icon('settings')}</a></div><div class="side-list side-tags"></div></div>
        <div class="side-foot">
          <a href="#/notes?filter=trash" data-nav="notes" data-exact="1">${icon('trash-2')} Trash</a>
          <a href="#/settings" data-nav="settings">${icon('settings')} Settings</a>
        </div>
      </aside>
      <main id="view" class="main" tabindex="-1"></main>
      <nav class="tabbar" aria-label="Main">
        <a href="#/" data-nav="home">${icon('home')}<span>Home</span></a>
        <a href="#/notes" data-nav="notes">${icon('notebook-pen')}<span>Notes</span></a>
        <a href="#/calendar" data-nav="calendar">${icon('calendar')}<span>Calendar</span></a>
        <a href="#/news" data-nav="news">${icon('newspaper')}<span>News</span></a>
        <a href="#/ask" data-nav="ask">${icon('sparkles')}<span>Ask</span></a>
      </nav>
    </div>`;
  $('.side-sync').appendChild(syncBadge());
  const renderSide = () => {
    const live = store.liveNotes();
    $('.side-folders').innerHTML = store.folders().map((f) => `<a href="#/notes?folder=${f.id}">${f.icon ? `<span class="emoji">${esc(f.icon)}</span>` : icon('folder')}<span>${esc(f.name)}</span><b>${live.filter((n) => n.folderId === f.id).length || ''}</b></a>`).join('') || '<p class="side-empty">No folders yet</p>';
    $('.side-tags').innerHTML = store.tags().map((t) => `<a href="#/notes?tag=${t.id}"><span class="tag-dot c-${t.color}"></span><span>${esc(t.name)}</span><b>${store.tagUsage(t.id) || ''}</b></a>`).join('') || '<p class="side-empty">No tags yet</p>';
    markNav(document.body.dataset.route, location.hash.replace(/^#/, '') || '/');
  };
  renderSide();
  onDataChange(renderSide);
}

/** Keeps the local version of a note in history when another device's edit wins. */
function keepConflicts() {
  store.events.on('conflict', ({ local }) => {
    const s = newSession(local.id, store.deviceId(), local.text || '', local.html || '', local.updated);
    s.label = 'Before sync';
    db.put('history', s);
  });
}

/** Android/desktop "Share to Scriptorium" (manifest share_target) and ?new= quick-capture links. */
async function handleIncomingShare() {
  const p = new URLSearchParams(location.search);
  if (!p.has('share') && !p.has('new')) return;
  history.replaceState(null, '', location.pathname + location.hash);
  const title = p.get('title') || '', text = p.get('text') || '', url = p.get('url') || (isUrl(text) ? text : '');
  if (url) {
    const close = toast('Saving shared page…', { timeout: 60000 });
    try { const n = await saveArticle(url); close(); location.hash = `#/note/${n.id}`; return; } catch (e) { close(); toast(e.message, { kind: 'error' }); }
  }
  const body = [title, text, url].filter(Boolean).join('\n');
  if (body) {
    const n = await store.createNote({ html: body.split('\n').map((l) => `<p>${esc(l)}</p>`).join('') });
    location.hash = `#/note/${n.id}`;
  }
}

async function main() {
  try {
    await db.openDB();
  } catch (e) {
    document.body.innerHTML = `<div class="empty"><h3>Storage unavailable</h3><p>This browser blocked local storage (private mode?). ${esc(e.message)}</p></div>`;
    return;
  }
  await loadSettings();
  applyAppearance();
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);
  await store.load();
  shell();
  keepConflicts();
  window.addEventListener('hashchange', route);
  window.addEventListener('app:rerender', () => { currentKey = null; route(); });
  route();
  startSync();
  handleIncomingShare();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !new URLSearchParams(location.search).has('nosw')) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            toast('A new version is ready', { action: 'Reload', onAction: () => location.reload(), timeout: 15000 });
          }
        });
      });
    }).catch((e) => console.warn('SW registration failed', e));
  }
  // global shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k' && !e.target.closest?.('.editor')) { e.preventDefault(); location.hash = '#/search'; }
    if (mod && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); location.hash = '#/'; }
  });
}

main();
