// Sync orchestrator: runs every enabled backend (your server/Worker, GitHub) after changes,
// on an interval, when the app comes back to the foreground and when the network returns.

import * as store from '../store.js';
import { settings, events as settingsEvents } from '../settings.js';
import { Emitter, debounce } from '../util.js';
import { serverBackend } from './server.js';
import { githubBackend } from './github.js';

export const syncEvents = new Emitter();
const backends = [serverBackend, githubBackend];

const status = { state: 'local', last: null, error: null, per: {} };
export const syncStatus = () => status;

let running = null;
let again = false;

function setState(state, extra = {}) {
  Object.assign(status, { state }, extra);
  syncEvents.emit('status', status);
}

export const enabledBackends = () => backends.filter((b) => b.enabled(settings()));

export async function syncNow({ reason = 'manual' } = {}) {
  if (running) { again = true; return running; }
  const active = enabledBackends();
  if (!active.length) { setState('local'); return; }
  if (!navigator.onLine) { setState('offline'); return; }
  running = (async () => {
    setState('syncing');
    let anyError = null, deferred = false;
    for (const b of active) {
      const t0 = Date.now();
      try {
        const res = await b.sync({ reason });
        if (res?.deferred) { deferred = true; continue; }
        status.per[b.id] = { ok: true, at: Date.now(), ms: Date.now() - t0, ...res };
      } catch (e) {
        console.warn(`sync ${b.id} failed`, e);
        anyError = e;
        status.per[b.id] = { ok: false, at: Date.now(), error: e.message || String(e) };
      }
    }
    setState(anyError ? 'error' : deferred ? 'pending' : 'synced', { last: Date.now(), error: anyError ? anyError.message : null });
  })();
  try { await running; } finally {
    running = null;
    if (again) { again = false; scheduleSync(1500); }
  }
}

let timer = null;
export function scheduleSync(ms = 2500) {
  clearTimeout(timer);
  if (!enabledBackends().length) return;
  if (status.state !== 'syncing') setState('pending');
  timer = setTimeout(() => syncNow({ reason: 'change' }), ms);
}

const onLocalChange = debounce(() => scheduleSync(500), 2000);

export function startSync() {
  for (const b of backends) store.registerBlobFetcher(async (meta) => (b.enabled(settings()) ? b.fetchBlob(meta) : null));
  for (const ev of ['notes', 'folders', 'tags', 'feeds', 'attachments', 'history']) {
    store.events.on(ev, (d) => { if (d?.type !== 'remote') onLocalChange(); });
  }
  settingsEvents.on('change', () => scheduleSync(500));
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('offline', () => setState('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(300);
    else if (status.state === 'pending') syncNow({ reason: 'hide' });
  });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow({ reason: 'interval' }); }, 60000);
  if (enabledBackends().length) scheduleSync(800);
  else setState('local');
}

export async function testBackend(id) {
  const b = backends.find((x) => x.id === id);
  return b.test(settings());
}
