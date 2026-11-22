/**
 * Opt-in local persistence (IndexedDB) for the current workspace and snapshots of
 * recent documents. Nothing is stored unless the user enables
 * "Remember workspace" in Settings, and everything can be wiped from there.
 */
const DB_NAME = 'formatx';
const STORE = 'documents';
const MAX_SNAPSHOTS = 25;

export interface StoredDocument {
  id: string;
  time: number;
  text: string;
  fileName: string | null;
  formatId: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => {
      db.close();
      resolve(req ? (req.result as T) : undefined);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

export async function saveDocument(doc: StoredDocument): Promise<void> {
  await tx('readwrite', (s) => s.put(doc));
  if (doc.id !== 'current') await pruneSnapshots();
}

export async function loadDocument(id: string): Promise<StoredDocument | undefined> {
  return tx<StoredDocument>('readonly', (s) => s.get(id));
}

export async function listDocuments(): Promise<StoredDocument[]> {
  const all = (await tx<StoredDocument[]>('readonly', (s) => s.getAll())) ?? [];
  return all.sort((a, b) => b.time - a.time);
}

async function pruneSnapshots(): Promise<void> {
  const docs = (await listDocuments()).filter((d) => d.id !== 'current');
  const excess = docs.slice(MAX_SNAPSHOTS);
  if (!excess.length) return;
  await tx('readwrite', (s) => {
    for (const d of excess) s.delete(d.id);
  });
}

export async function clearAllDocuments(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}
