// IndexedDB wrapper. Everything the app knows lives here first (local-first);
// sync backends copy records to and from this database.

const DB_NAME = 'scriptorium';
const DB_VERSION = 1;

/** Record stores that sync between devices. */
export const SYNC_TYPES = ['notes', 'folders', 'tags', 'attachments', 'history', 'feeds'];
/** Local-only stores: blobs (attachment bytes), meta (settings, cursors). */
const LOCAL_STORES = ['blobs', 'meta'];

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of SYNC_TYPES) {
        if (!db.objectStoreNames.contains(name)) {
          const s = db.createObjectStore(name, { keyPath: 'id' });
          s.createIndex('_seq', '_seq');
          if (name === 'history' || name === 'attachments') s.createIndex('noteId', 'noteId');
        }
      }
      for (const name of LOCAL_STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); location.reload(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => console.warn('IndexedDB upgrade blocked by another tab');
  });
  return dbPromise;
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(stores, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; }, reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export async function get(store, key) {
  return tx([store], 'readonly', (t) => reqP(t.objectStore(store).get(key)));
}

export async function getAll(store) {
  return tx([store], 'readonly', (t) => reqP(t.objectStore(store).getAll()));
}

export async function getByIndex(store, index, value) {
  return tx([store], 'readonly', (t) => reqP(t.objectStore(store).index(index).getAll(value)));
}

/** Records with _seq greater than `seq` (changed locally since a backend last saw them). */
export async function changedSince(store, seq) {
  return tx([store], 'readonly', (t) => reqP(t.objectStore(store).index('_seq').getAll(IDBKeyRange.lowerBound(seq, true))));
}

let seqCache = null;
async function nextSeq(t) {
  const meta = t.objectStore('meta');
  if (seqCache === null) seqCache = (await reqP(meta.get('seq'))) || 0;
  seqCache += 1;
  meta.put(seqCache, 'seq');
  return seqCache;
}

export async function currentSeq() {
  if (seqCache !== null) return seqCache;
  return (await getMeta('seq')) || 0;
}

/** Writes a synced record and stamps it with a new local sequence number. */
export async function put(store, record) {
  return tx([store, 'meta'], 'readwrite', async (t) => {
    record._seq = await nextSeq(t);
    t.objectStore(store).put(record);
    return record;
  });
}

export async function putMany(store, records) {
  if (!records.length) return;
  return tx([store, 'meta'], 'readwrite', async (t) => {
    for (const r of records) {
      r._seq = await nextSeq(t);
      t.objectStore(store).put(r);
    }
  });
}

/** Hard delete (used only for purging tombstones/local caches). */
export async function del(store, key) {
  return tx([store], 'readwrite', (t) => reqP(t.objectStore(store).delete(key)));
}

export async function getMeta(key) {
  return tx(['meta'], 'readonly', (t) => reqP(t.objectStore('meta').get(key)));
}

export async function setMeta(key, value) {
  return tx(['meta'], 'readwrite', (t) => reqP(t.objectStore('meta').put(value, key)));
}

export async function getBlob(id) {
  return tx(['blobs'], 'readonly', (t) => reqP(t.objectStore('blobs').get(id)));
}

export async function putBlob(id, blob) {
  return tx(['blobs'], 'readwrite', (t) => reqP(t.objectStore('blobs').put(blob, id)));
}

export async function hasBlob(id) {
  return tx(['blobs'], 'readonly', (t) => reqP(t.objectStore('blobs').count(id))).then((n) => n > 0);
}

export async function blobKeys() {
  return tx(['blobs'], 'readonly', (t) => reqP(t.objectStore('blobs').getAllKeys()));
}

export async function deleteBlob(id) {
  return tx(['blobs'], 'readwrite', (t) => reqP(t.objectStore('blobs').delete(id)));
}

export async function wipeAll() {
  const db = await openDB();
  db.close();
  dbPromise = null;
  seqCache = null;
  await reqP(indexedDB.deleteDatabase(DB_NAME));
}
