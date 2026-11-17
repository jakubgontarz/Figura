/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileRef } from '../platform/index.ts';
import { persist } from './Persist.ts';

/** Lista „Najnowsze”: w Tauri zapamiętujemy ścieżki, w przeglądarce uchwyty plików (IndexedDB) i nazwy. */
export interface RecentItem {
  id: string;
  name: string;
  path?: string;
  /** Czy w IndexedDB leży uchwyt pliku (przeglądarka) */
  hasHandle?: boolean;
  time: number;
}

const KEY = 'figura.recent.v1';
const MAX = 10;
const DB = 'figura-recent';
const STORE = 'handles';

/** Uchwyty z bieżącej sesji (zapasowo, gdy IndexedDB jest niedostępne albo nie przyjmie uchwytu) */
const memHandles = new Map<string, unknown>();
let items: RecentItem[] | null = null;
const listeners = new Set<() => void>();

const load = (): RecentItem[] => {
  if (items) return items;
  try {
    const r = JSON.parse(persist.get(KEY) || '[]');
    items = Array.isArray(r) ? r.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string').slice(0, MAX) : [];
  } catch {
    items = [];
  }
  return items!;
};

const save = () => {
  persist.set(KEY, JSON.stringify(items ?? []));
  listeners.forEach((l) => l());
};

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function idbPut(id: string, handle: unknown): Promise<boolean> {
  const db = await idb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}
async function idbGet(id: string): Promise<any> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      rq.onsuccess = () => resolve(rq.result ?? null);
      rq.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}
async function idbClear(ids?: string[]): Promise<void> {
  const db = await idb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      if (ids) ids.forEach((i) => tx.objectStore(STORE).delete(i));
      else tx.objectStore(STORE).clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export const recents = {
  list: (): RecentItem[] => load().slice(),
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Dodaje plik na początek listy (ten sam plik nie powtarza się). Pliki bez ścieżki i uchwytu (pobrane) nie trafiają na listę. */
  async add(ref: FileRef): Promise<void> {
    if (!ref.path && !ref.handle) return;
    const list = load();
    const same = list.filter((r) => (ref.path ? r.path === ref.path : !r.path && r.name === ref.name));
    const id = same[0]?.id ?? 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    let hasHandle = false;
    if (!ref.path && ref.handle) {
      memHandles.set(id, ref.handle);
      hasHandle = (await idbPut(id, ref.handle)) || true;
    }
    if (!ref.path && !hasHandle) return;
    const item: RecentItem = { id, name: ref.name, path: ref.path, hasHandle, time: Date.now() };
    const rest = list.filter((r) => r.id !== id);
    items = [item, ...rest];
    const dropped = items.slice(MAX);
    items = items.slice(0, MAX);
    if (dropped.length) void idbClear(dropped.map((d) => d.id));
    save();
  },
  /** Zamienia wpis listy na odnośnik do pliku; null, gdy uchwyt zniknął. */
  async resolve(item: RecentItem): Promise<FileRef | null> {
    if (item.path) return { name: item.name, path: item.path };
    if (item.hasHandle) {
      const handle = memHandles.get(item.id) ?? (await idbGet(item.id));
      if (handle) return { name: item.name, handle };
    }
    return null;
  },
  remove(id: string): void {
    items = load().filter((r) => r.id !== id);
    void idbClear([id]);
    save();
  },
  clear(): void {
    items = [];
    void idbClear();
    save();
  },
};
