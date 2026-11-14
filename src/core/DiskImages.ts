/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * „Obraz z dysku”: obiekt inteligentny, który zamiast bitmapy niesie tylko odwołanie do pliku (`DiskImageRef`).
 * Zapis dokumentu i historia cofania przechowują wyłącznie to odwołanie; bitmapa żyje w pamięci tej sesji.
 *
 * Dostęp do pliku zależy od środowiska:
 *  - Tauri (`window.__TAURI__`, wymaga `withGlobalTauri: true` oraz wtyczek dialog i fs): systemowe okno wyboru pliku,
 *    w odwołaniu zapisana jest pełna ścieżka, a plik czytany jest po tej ścieżce;
 *  - przeglądarka z File System Access API (Chrome, Edge): okno wyboru, uchwyt pliku zapamiętany w IndexedDB
 *    (przeglądarka nie ujawnia pełnej ścieżki, więc odwołanie ma nazwę pliku i identyfikator uchwytu);
 *  - pozostałe przeglądarki: zwykłe okno wyboru bez uchwytu (obraz działa do końca sesji, po ponownym otwarciu dokumentu
 *    trzeba wskazać plik jeszcze raz).
 */

export interface DiskImageRef {
  /** Identyfikator bitmapy: w Tauri `path:<ścieżka>`, w przeglądarce losowy klucz uchwytu. */
  key: string;
  /** Nazwa pliku (do podpisu i etykiety). */
  name: string;
  /** Pełna ścieżka (tylko Tauri), w przeglądarce null. */
  path: string | null;
  /** Wymiary oryginału w pikselach. */
  w: number;
  h: number;
}

export type DiskImageState = 'ready' | 'loading' | 'missing' | 'permission';

type Bmp = ImageBitmap | HTMLCanvasElement;

const bitmaps = new Map<string, Bmp>();
const loading = new Map<string, Promise<void>>();
const states = new Map<string, DiskImageState>();
const versions = new Map<string, number>();
let readyHook: ((key: string) => void) | null = null;

/** Wołane, gdy bitmapa pliku zostanie wczytana albo jej stan się zmieni (odświeżenie warstw). */
export function setDiskReadyHook(fn: ((key: string) => void) | null): void {
  readyHook = fn;
}

/** Numer wersji bitmapy: do kluczy podglądu (zmienia się po wczytaniu pliku). */
export function diskImageVersion(key: string): number {
  return versions.get(key) ?? 0;
}

export function diskImageState(key: string): DiskImageState {
  return bitmaps.has(key) ? 'ready' : states.get(key) ?? 'loading';
}

function setReady(key: string, bmp: Bmp): void {
  bitmaps.set(key, bmp);
  states.set(key, 'ready');
  versions.set(key, (versions.get(key) ?? 0) + 1);
  readyHook?.(key);
}

function setState(key: string, st: DiskImageState): void {
  if (states.get(key) === st) return;
  states.set(key, st);
  versions.set(key, (versions.get(key) ?? 0) + 1);
  readyHook?.(key);
}

// ---- środowisko ----

interface TauriGlobal {
  dialog?: { open: (o: unknown) => Promise<string | string[] | null> };
  fs?: { readFile: (path: string) => Promise<Uint8Array> };
}
function tauri(): TauriGlobal | null {
  const t = typeof window !== 'undefined' ? (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ : undefined;
  return t && t.dialog && t.fs ? t : null;
}

/** Czy program działa w Tauri (systemowe okno wyboru pliku i ścieżki na dysku). */
export function isTauriEnvironment(): boolean {
  return tauri() !== null;
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return ext === 'jpg' ? 'image/jpeg' : ext ? `image/${ext}` : 'image/png';
}

async function decode(blob: Blob): Promise<Bmp> {
  return await createImageBitmap(blob);
}

function newKey(): string {
  return `di_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---- uchwyty plików w IndexedDB (przeglądarka) ----

interface FsHandle {
  getFile(): Promise<File>;
  queryPermission?(d: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(d: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
}
const DB_NAME = 'figura-disk-images';
const STORE = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbPut(key: string, h: FsHandle): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(h, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    /* brak IndexedDB: obraz działa do końca sesji */
  }
}
async function idbGet(key: string): Promise<FsHandle | null> {
  try {
    const db = await openDb();
    return await new Promise<FsHandle | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as FsHandle | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

// ---- wybór pliku ----

/** Okno wyboru pliku obrazu. Wołać bezpośrednio z obsługi kliknięcia (przeglądarka wymaga gestu użytkownika). */
export async function pickDiskImage(): Promise<DiskImageRef | null> {
  const t = tauri();
  if (t) {
    const sel = await t.dialog!.open({ multiple: false, directory: false, filters: [{ name: 'Obrazy', extensions: IMAGE_EXTENSIONS }] });
    const path = Array.isArray(sel) ? sel[0] : sel;
    if (!path) return null;
    return await registerFromPath(path);
  }
  const w = window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FsHandle[]> };
  let file: File | null = null;
  let handle: FsHandle | null = null;
  if (typeof w.showOpenFilePicker === 'function') {
    try {
      const [h] = await w.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'Obrazy', accept: { 'image/*': IMAGE_EXTENSIONS.map((e) => `.${e}`) } }],
      });
      handle = h;
      file = await h.getFile();
    } catch {
      return null; // anulowano
    }
  } else {
    file = await new Promise<File | null>((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = () => resolve(input.files?.[0] ?? null);
      input.oncancel = () => resolve(null);
      input.click();
    });
  }
  if (!file) return null;
  const key = newKey();
  const bmp = await decode(file).catch(() => null);
  if (!bmp) return null;
  if (handle) await idbPut(key, handle);
  setReady(key, bmp);
  return { key, name: file.name, path: null, w: bmp.width, h: bmp.height };
}

async function registerFromPath(path: string): Promise<DiskImageRef | null> {
  const t = tauri();
  if (!t) return null;
  try {
    const bytes = await t.fs!.readFile(path);
    const name = baseName(path);
    const bmp = await decode(new Blob([bytes as BlobPart], { type: mimeFor(name) }));
    const key = `path:${path}`;
    setReady(key, bmp);
    return { key, name, path, w: bmp.width, h: bmp.height };
  } catch {
    return null;
  }
}

// ---- wczytywanie zapisanych odwołań ----

/** Wczytuje bitmapę odwołania (po otwarciu dokumentu albo po cofnięciu do nieznanego stanu). Nigdy nie rzuca wyjątku. */
export function ensureDiskImage(ref: DiskImageRef, force = false): Promise<void> {
  if (!force && bitmaps.has(ref.key)) return Promise.resolve();
  const pending = loading.get(ref.key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const t = tauri();
      if (ref.path && t) {
        const bytes = await t.fs!.readFile(ref.path);
        setReady(ref.key, await decode(new Blob([bytes as BlobPart], { type: mimeFor(ref.name) })));
        return;
      }
      const h = await idbGet(ref.key);
      if (!h) {
        { if (force) bitmaps.delete(ref.key); setState(ref.key, 'missing'); }
        return;
      }
      const perm = h.queryPermission ? await h.queryPermission({ mode: 'read' }) : 'granted';
      if (perm !== 'granted') {
        { if (force) bitmaps.delete(ref.key); setState(ref.key, 'permission'); }
        return;
      }
      setReady(ref.key, await decode(await h.getFile()));
    } catch {
      { if (force) bitmaps.delete(ref.key); setState(ref.key, 'missing'); }
    } finally {
      loading.delete(ref.key);
    }
  })();
  loading.set(ref.key, p);
  return p;
}

/** Bitmapa obrazu albo null (wtedy rysowany jest zastępnik, a wczytywanie rusza w tle). */
export function getDiskBitmap(ref: DiskImageRef): Bmp | null {
  const b = bitmaps.get(ref.key);
  if (b) return b;
  if (!loading.has(ref.key) && !states.has(ref.key)) void ensureDiskImage(ref);
  return null;
}

/**
 * Przywraca dostęp do pliku (wołać z gestu użytkownika, np. dwuklik na obiekcie): najpierw prosi przeglądarkę o zgodę
 * dla zapamiętanego uchwytu, a gdy to niemożliwe, otwiera okno wyboru. Zwraca odwołanie do użycia (to samo albo nowe)
 * albo null, gdy anulowano.
 */
export async function reconnectDiskImage(ref: DiskImageRef): Promise<DiskImageRef | null> {
  if (bitmaps.has(ref.key)) return ref;
  if (!ref.path) {
    const h = await idbGet(ref.key);
    if (h && h.requestPermission) {
      try {
        if ((await h.requestPermission({ mode: 'read' })) === 'granted') {
          setReady(ref.key, await decode(await h.getFile()));
          return ref;
        }
      } catch {
        /* wybór nowego pliku poniżej */
      }
    }
  }
  const picked = await pickDiskImage();
  return picked;
}

/** Rysuje bitmapę w obróconej ramce (środek, rozmiar, kąt, odbicia). */
export function drawDiskBitmap(
  ctx: CanvasRenderingContext2D,
  ref: DiskImageRef,
  center: { x: number; y: number },
  width: number,
  height: number,
  angle: number,
  flipX: boolean,
  flipY: boolean
): void {
  const bmp = getDiskBitmap(ref);
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  if (bmp && bmp.width > 0 && bmp.height > 0) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, -width / 2, -height / 2, width, height);
  } else {
    // zastępnik: brak pliku, brak zgody albo plik jeszcze się wczytuje
    const st = diskImageState(ref.key);
    ctx.fillStyle = 'rgba(128,128,128,0.18)';
    ctx.fillRect(-width / 2, -height / 2, width, height);
    ctx.strokeStyle = st === 'loading' ? 'rgba(180,180,180,0.8)' : 'rgba(224,90,90,0.9)';
    ctx.lineWidth = Math.max(1, Math.min(width, height) / 120);
    ctx.strokeRect(-width / 2, -height / 2, width, height);
    ctx.beginPath();
    ctx.moveTo(-width / 2, -height / 2);
    ctx.lineTo(width / 2, height / 2);
    ctx.moveTo(width / 2, -height / 2);
    ctx.lineTo(-width / 2, height / 2);
    ctx.stroke();
    const fs = Math.max(10, Math.min(width / 14, height / 6, 28));
    ctx.fillStyle = 'rgba(235,235,235,0.95)';
    ctx.font = `${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const msg = st === 'loading' ? ref.name : st === 'permission' ? `${ref.name} (kliknij dwukrotnie, aby przywrócić dostęp)` : `Brak pliku: ${ref.name}`;
    ctx.fillText(msg, 0, 0, Math.max(10, width - 8));
  }
  ctx.restore();
}
