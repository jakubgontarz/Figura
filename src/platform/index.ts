/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Warstwa platformy: ten sam kod działa w przeglądarce i w aplikacji Tauri (v2).
 *
 * Tauri jest wykrywany w czasie działania (`window.__TAURI_INTERNALS__`), a jego API czytane z globalnego `window.__TAURI__`
 * (w `tauri.conf.json` ustaw `app.withGlobalTauri: true`). Dzięki temu program nie ma żadnej zależności npm od Tauri,
 * a wersja przeglądarkowa nie zawiera ani linijki kodu Tauri. Szczegóły i uprawnienia: plik TAURI.md.
 */

type AnyRec = Record<string, any>;

const T = (): AnyRec | null => (typeof window !== 'undefined' ? ((window as any).__TAURI__ as AnyRec | undefined) ?? null : null);

/** Czy program działa jako aplikacja Tauri. */
export const isTauri = (): boolean => typeof window !== 'undefined' && !!((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__);

/** Odnośnik do pliku na dysku: w Tauri ścieżka, w przeglądarce (Chromium) uchwyt z File System Access API. */
export interface FileRef {
  name: string;
  path?: string;
  handle?: any;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface OpenedFile {
  ref: FileRef;
  data: Uint8Array;
  /** Czas modyfikacji pliku (ms), jeśli znany */
  modified?: number;
}

const baseName = (p: string) => p.replace(/^.*[\\/]/, '');

const toAccept = (filters: FileFilter[]): Record<string, string[]> => {
  const accept: Record<string, string[]> = {};
  for (const f of filters) {
    for (const e of f.extensions) {
      const ext = '.' + e.replace(/^\./, '');
      const mime = ext === '.fig' ? 'application/json' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : ext === '.gif' ? 'image/gif' : 'application/octet-stream';
      (accept[mime] ||= []).push(ext);
    }
  }
  return accept;
};

/** Okno „Otwórz”. Zwraca pustą listę po anulowaniu. */
export async function openFiles(filters: FileFilter[], multiple = true): Promise<OpenedFile[]> {
  const t = T();
  if (t?.dialog && t?.fs) {
    const sel = await t.dialog.open({ multiple, filters });
    if (!sel) return [];
    const paths: string[] = Array.isArray(sel) ? sel : [sel];
    const out: OpenedFile[] = [];
    for (const p of paths) out.push(await readPath(p));
    return out;
  }
  const w = window as any;
  if (typeof w.showOpenFilePicker === 'function') {
    try {
      const handles: any[] = await w.showOpenFilePicker({ multiple, types: filters.map((f) => ({ description: f.name, accept: toAccept([f]) })) });
      const out: OpenedFile[] = [];
      for (const h of handles) {
        const file: File = await h.getFile();
        out.push({ ref: { name: file.name, handle: h }, data: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified });
      }
      return out;
    } catch (e: any) {
      if (e?.name === 'AbortError') return [];
      throw e;
    }
  }
  // Przeglądarki bez File System Access API: zwykły wybór pliku (zapis będzie pobraniem)
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    input.accept = filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
    input.onchange = async () => {
      const out: OpenedFile[] = [];
      for (const f of Array.from(input.files ?? [])) out.push({ ref: { name: f.name }, data: new Uint8Array(await f.arrayBuffer()), modified: f.lastModified });
      resolve(out);
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

async function readPath(p: string): Promise<OpenedFile> {
  const fs = T()!.fs;
  const data: Uint8Array = await fs.readFile(p);
  let modified: number | undefined;
  try {
    const st = await fs.stat(p);
    const m = st?.mtime;
    if (m) modified = new Date(m).getTime();
  } catch {
    /* brak uprawnień do stat: bez daty */
  }
  return { ref: { name: baseName(p), path: p }, data, modified };
}

/** Odczyt pliku z zapamiętanego odnośnika (lista „Najnowsze”). W przeglądarce może poprosić o zgodę. */
export async function readRef(ref: FileRef): Promise<OpenedFile | null> {
  if (ref.path && T()?.fs) return readPath(ref.path);
  if (ref.handle) {
    try {
      if (ref.handle.requestPermission && (await ref.handle.requestPermission({ mode: 'read' })) !== 'granted') return null;
      const file: File = await ref.handle.getFile();
      return { ref, data: new Uint8Array(await file.arrayBuffer()), modified: file.lastModified };
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Tauri: gdy odczyt zapamiętanej ścieżki się nie udaje (np. z powodu zakresu `fs` ważnego tylko do końca poprzedniej sesji),
 * otwiera okno wyboru ustawione na ten plik. Wybranie pliku w oknie od razu daje programowi do niego dostęp.
 */
export async function pickFileNear(path: string, filters: FileFilter[]): Promise<OpenedFile | null> {
  const t = T();
  if (!(t?.dialog && t?.fs)) return null;
  const sel = await t.dialog.open({ multiple: false, defaultPath: path, filters });
  const p = Array.isArray(sel) ? sel[0] : sel;
  return p ? readPath(p) : null;
}

/** Czy `Zapisz` może nadpisać plik bez pytania (mamy ścieżkę lub uchwyt). */
export const canWriteInPlace = (ref: FileRef | null | undefined): boolean => !!ref && !!(ref.path || ref.handle);

/**
 * Zapisuje plik. Gdy `ref` ma ścieżkę lub uchwyt i `askWhere` jest fałszem, nadpisuje ten plik; w przeciwnym razie pokazuje okno
 * „Zapisz jako”. Zwraca nowy odnośnik albo null po anulowaniu. W przeglądarce bez File System Access API plik jest pobierany.
 */
export async function saveFile(data: Uint8Array | Blob, suggestedName: string, filters: FileFilter[], ref: FileRef | null, askWhere: boolean): Promise<FileRef | null> {
  const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
  const t = T();
  if (t?.dialog && t?.fs) {
    let path: string | null | undefined = !askWhere ? ref?.path : undefined;
    if (!path) {
      const def = ref?.path ? ref.path.replace(/[^\\/]*$/, '') + suggestedName : suggestedName;
      path = (await t.dialog.save({ defaultPath: def, filters })) as string | null;
      if (!path) return null;
    }
    await t.fs.writeFile(path, bytes);
    return { name: baseName(path), path };
  }
  const w = window as any;
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      let handle = !askWhere ? ref?.handle : undefined;
      if (handle && handle.requestPermission && (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') handle = undefined;
      if (!handle) {
        handle = await w.showSaveFilePicker({ suggestedName, types: filters.map((f) => ({ description: f.name, accept: toAccept([f]) })) });
      }
      const wr = await handle.createWritable();
      await wr.write(bytes);
      await wr.close();
      return { name: handle.name, handle };
    } catch (e: any) {
      if (e?.name === 'AbortError') return null;
      throw e;
    }
  }
  downloadBytes(bytes, suggestedName);
  return { name: suggestedName };
}

/** Pobranie pliku (przeglądarka bez okna zapisu). */
export function downloadBytes(bytes: Uint8Array | Blob, name: string): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Czy zapis „w to samo miejsce” w ogóle jest możliwy w tym środowisku (Tauri lub Chromium z File System Access API). */
export const supportsNativeSave = (): boolean => !!(T()?.dialog && T()?.fs) || typeof (window as any).showSaveFilePicker === 'function';

// --------------------------------------------------------------------------------------------------------------
// Schowek
// --------------------------------------------------------------------------------------------------------------

/** Element schowka w kształcie zgodnym z `ClipboardItem` (tylko to, czego używa program). */
export interface ClipItem {
  types: readonly string[];
  getType(type: string): Promise<Blob>;
}

/** Czy dostępny jest odczyt obrazu ze schowka przez wtyczkę Tauri (nie wywołuje okienka zgody WebView2). */
const tauriClipboard = (): AnyRec | null => {
  const c = T()?.clipboardManager;
  return c && typeof c.readImage === 'function' ? c : null;
};

/**
 * Odczyt obrazów ze schowka systemowego. W Tauri z wtyczką `clipboard-manager` robi to wtyczka, więc WebView2 nie pyta o zgodę
 * na dostęp do schowka. W przeglądarce (albo bez wtyczki) używa zwykłego `navigator.clipboard.read()`. Zwraca pustą listę,
 * gdy w schowku nie ma obrazu; rzuca wyjątek, gdy odczyt jest niemożliwy.
 */
export async function readClipboardItems(): Promise<ClipItem[]> {
  const c = tauriClipboard();
  if (c) {
    let img: AnyRec;
    try {
      img = await c.readImage();
    } catch {
      return []; // w schowku nie ma obrazu
    }
    const size = await img.size();
    const rgba: Uint8Array = await img.rgba();
    const cv = document.createElement('canvas');
    cv.width = size.width;
    cv.height = size.height;
    cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), size.width, size.height), 0, 0);
    const blob: Blob = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('PNG'))), 'image/png'));
    return [{ types: ['image/png'], getType: async () => blob }];
  }
  if (navigator.clipboard && typeof navigator.clipboard.read === 'function') return (await navigator.clipboard.read()) as unknown as ClipItem[];
  throw new Error('Brak dostępu do schowka');
}

/** Czy odczyt schowka jest możliwy (przeglądarka z `navigator.clipboard.read` albo Tauri z wtyczką). */
export const canReadClipboard = (): boolean => !!tauriClipboard() || !!(navigator.clipboard && typeof navigator.clipboard.read === 'function');

// --------------------------------------------------------------------------------------------------------------
// Okno aplikacji
// --------------------------------------------------------------------------------------------------------------

/** Bieżące okno Tauri (null w przeglądarce). */
export const curWin = (): AnyRec | null => {
  const t = T();
  try {
    return t?.window?.getCurrentWindow?.() ?? null;
  } catch {
    return null;
  }
};

export const appWindow = {
  /** Czy przyciski okna sterują prawdziwym oknem (Tauri) */
  isNative: (): boolean => !!curWin(),
  minimize: (): void => void curWin()?.minimize?.(),
  toggleMaximize: async (): Promise<void> => {
    const w = curWin();
    if (w) await w.toggleMaximize();
    else if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  },
  isMaximized: async (): Promise<boolean> => {
    const w = curWin();
    if (w?.isMaximized) return !!(await w.isMaximized());
    return !!document.fullscreenElement;
  },
  /** Wywołuje `cb` po zmianie rozmiaru okna (do odświeżenia ikony maksymalizacji); zwraca funkcję odpinającą. */
  onResized: (cb: () => void): (() => void) => {
    const w = curWin();
    if (w?.onResized) {
      let un: (() => void) | null = null;
      let dead = false;
      Promise.resolve(w.onResized(cb)).then((u: () => void) => (dead ? u() : (un = u)));
      return () => {
        dead = true;
        un?.();
      };
    }
    document.addEventListener('fullscreenchange', cb);
    return () => document.removeEventListener('fullscreenchange', cb);
  },
  /** Rozpoczyna zmianę rozmiaru okna przeciąganiem krawędzi (okno bez systemowej ramki). */
  startResizeDragging: (dir: string): void => void curWin()?.startResizeDragging?.(dir),
  /** Zamyka okno natychmiast, bez pytań (po zatwierdzeniu przez aplikację). */
  destroy: async (): Promise<void> => {
    const w = curWin();
    if (w?.destroy) await w.destroy();
    else window.close();
  },
  /** Rejestruje obsługę próby zamknięcia okna (krzyżyk, Alt+F4): `handler` decyduje, czy i kiedy zamknąć (przez `destroy`). */
  onCloseRequested: (handler: () => void): (() => void) => {
    const w = curWin();
    if (w?.onCloseRequested) {
      let un: (() => void) | null = null;
      let dead = false;
      Promise.resolve(
        w.onCloseRequested((ev: any) => {
          ev.preventDefault();
          handler();
        })
      ).then((u: () => void) => (dead ? u() : (un = u)));
      return () => {
        dead = true;
        un?.();
      };
    }
    return () => {};
  },
};

// --------------------------------------------------------------------------------------------------------------
// Drukowanie
// --------------------------------------------------------------------------------------------------------------

/** Drukuje gotowy dokument HTML (w ukrytej ramce); działa w przeglądarce i w WebView2 (Tauri). */
export function printHtml(html: string): Promise<void> {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(html);
    doc.close();
    const go = () => {
      const w = frame.contentWindow!;
      const done = () => {
        setTimeout(() => {
          frame.remove();
          resolve();
        }, 500);
      };
      w.addEventListener('afterprint', done, { once: true });
      w.focus();
      w.print();
      // zapasowo: przeglądarki, które nie wysyłają `afterprint`
      setTimeout(done, 60000);
    };
    const imgs = Array.from(doc.images);
    if (imgs.every((i) => i.complete)) setTimeout(go, 50);
    else {
      let n = imgs.filter((i) => !i.complete).length;
      imgs.forEach((i) => {
        if (!i.complete) i.addEventListener('load', () => --n === 0 && go(), { once: true });
      });
    }
  });
}
