// Little sync status indicator: tap to sync now.

import { syncEvents, syncStatus, syncNow, enabledBackends } from '../sync/engine.js';
import { icon } from '../icons.js';
import { h, toast } from '../ui.js';
import { fmtRelative } from '../util.js';

const LABEL = {
  local: 'On this device only — set up sync in Settings',
  synced: 'Synced', syncing: 'Syncing…', pending: 'Changes waiting to sync', error: 'Sync problem', offline: 'Offline — will sync when back online',
};

export function syncBadge() {
  const el = h(`<button class="sync-badge" type="button"></button>`);
  const render = () => {
    const s = syncStatus();
    el.dataset.state = s.state;
    el.title = `${LABEL[s.state] || s.state}${s.last ? ` · last ${fmtRelative(s.last)}` : ''}${s.error ? ` · ${s.error}` : ''}`;
    el.setAttribute('aria-label', el.title);
    el.innerHTML = `${icon(s.state === 'local' || s.state === 'offline' ? 'cloud-off' : s.state === 'syncing' ? 'refresh-cw' : 'cloud', s.state === 'syncing' ? 'spin' : '')}<span class="sync-dot"></span>`;
  };
  render();
  const off = syncEvents.on('status', () => { if (!el.isConnected) { off(); return; } render(); });
  el.addEventListener('click', () => {
    if (!enabledBackends().length) { location.hash = '#/settings'; return; }
    const s = syncStatus();
    if (s.state === 'error') toast(`Sync problem: ${s.error}`, { kind: 'error', action: 'Settings', onAction: () => { location.hash = '#/settings'; } });
    syncNow();
  });
  return el;
}
