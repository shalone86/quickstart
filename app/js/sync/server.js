// Sync with your own backend: the Cloudflare Worker (D1 + R2) or the Node home server.
// Both expose the same small API (see worker/README or server/README).

import * as db from '../db.js';
import * as store from '../store.js';
import { api } from '../settings.js';

const META = 'sync:server';

export const serverBackend = {
  id: 'server',
  name: 'Server',
  enabled: (s) => !!s.serverEnabled,

  async test() {
    const r = await api('/api/health');
    return `Connected · ${r.name || 'server'} ${r.version || ''} · storage: ${r.storage || '?'}`;
  },

  async sync() {
    const st = (await db.getMeta(META)) || { pushedSeq: 0, cursor: 0 };
    const snapshot = await db.currentSeq();
    // 1) push local changes in batches
    let pushed = 0;
    let batch = [], size = 0;
    const send = async () => {
      if (!batch.length) return;
      await api('/api/sync', { method: 'POST', body: { records: batch } });
      pushed += batch.length;
      batch = []; size = 0;
    };
    for (const type of db.SYNC_TYPES) {
      const changed = await db.changedSince(type, st.pushedSeq);
      for (const r of changed) {
        const rec = { ...r };
        delete rec._seq;
        const json = JSON.stringify(rec);
        batch.push({ type, id: r.id, updated: r.updated || 0, deleted: !!r.deleted, data: json });
        size += json.length;
        if (batch.length >= 200 || size > 1.5e6) await send();
      }
    }
    await send();
    // 2) upload attachment bytes the server does not have yet
    const uploaded = new Set((await db.getMeta(`${META}:blobs`)) || []);
    let blobs = 0;
    for (const a of await db.getAll('attachments')) {
      const key = `${a.id}:${a.rev || 0}`;
      if (a.deleted || uploaded.has(key)) continue;
      const blob = await db.getBlob(a.id);
      if (!blob) continue;
      await api(`/api/blob/${encodeURIComponent(a.id)}`, { method: 'PUT', body: blob, headers: { 'Content-Type': a.mime || 'application/octet-stream' } });
      uploaded.add(key);
      blobs++;
      await db.setMeta(`${META}:blobs`, [...uploaded]);
    }
    // 3) pull everything newer than our cursor
    let cursor = st.cursor, pulled = 0, more = true;
    while (more) {
      const res = await api('/api/sync', { method: 'POST', body: { since: cursor, records: [] } });
      const byType = {};
      for (const r of res.records || []) {
        let rec;
        try { rec = JSON.parse(r.data); } catch { continue; }
        (byType[r.type] ||= []).push(rec);
      }
      for (const [type, recs] of Object.entries(byType)) pulled += await store.applyRemote(type, recs);
      cursor = res.cursor ?? cursor;
      more = !!res.more;
    }
    // Records we just applied got new local seq numbers; they don't need to go back to this server.
    const after = await db.currentSeq();
    const nothingElseChanged = after - snapshot === pulled;
    await db.setMeta(META, { pushedSeq: nothingElseChanged ? after : snapshot, cursor });
    return { pushed, pulled, blobs };
  },

  async fetchBlob(meta) {
    const res = await api(`/api/blob/${encodeURIComponent(meta.id)}`, { raw: true });
    if (!res.ok) return null;
    return res.blob();
  },
};
