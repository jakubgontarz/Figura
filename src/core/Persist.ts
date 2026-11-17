/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { isTauri } from '../platform/index.ts';

/**
 * Trwała pamięć aplikacji (ustawienia, presety efektów, lista ostatnich plików). Interfejs jest synchroniczny:
 * odczyty idą z pamięci podręcznej, a zapisy trafiają
 *  - w przeglądarce do `localStorage`,
 *  - w aplikacji Tauri do pliku `figura-state.json` w folderze konfiguracji użytkownika aplikacji
 *    (Windows: `%APPDATA%\<identyfikator aplikacji>\`), a dodatkowo (kopia zapasowa) do `localStorage` widoku WebView.
 * `initPersist()` wywołujemy raz przed startem interfejsu.
 */
const FILE = 'figura-state.json';
let cache: Record<string, string> = {};
let ready = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const tauriFs = () => (window as any).__TAURI__?.fs;

async function writeFileNow(): Promise<void> {
  const fs = tauriFs();
  if (!fs) return;
  const dir = fs.BaseDirectory?.AppConfig;
  try {
    await fs.mkdir('', { baseDir: dir, recursive: true });
  } catch {
    /* katalog już istnieje */
  }
  try {
    await fs.writeTextFile(FILE, JSON.stringify(cache), { baseDir: dir });
  } catch (e) {
    console.warn('Figura: nie udało się zapisać pliku stanu aplikacji', e);
  }
}

function scheduleWrite(): void {
  if (!isTauri()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void writeFileNow();
  }, 400);
}

export const persist = {
  get(key: string): string | null {
    if (key in cache) return cache[key];
    if (!isTauri()) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    }
    return null;
  },
  set(key: string, value: string): void {
    cache[key] = value;
    try {
      localStorage.setItem(key, value);
    } catch {
      /* brak miejsca / tryb prywatny */
    }
    scheduleWrite();
  },
  remove(key: string): void {
    delete cache[key];
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignoruj */
    }
    scheduleWrite();
  },
  /** Zapisuje oczekujące zmiany od razu (przed zamknięciem okna). */
  flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return isTauri() ? writeFileNow() : Promise.resolve();
  },
};

/** Wczytuje stan z pliku użytkownika (Tauri). Bez Tauri nic nie robi: dane są w `localStorage`. */
export async function initPersist(): Promise<void> {
  if (ready) return;
  ready = true;
  if (!isTauri()) return;
  const fs = tauriFs();
  if (!fs) return;
  try {
    const txt: string = await fs.readTextFile(FILE, { baseDir: fs.BaseDirectory?.AppConfig });
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) if (typeof obj[k] === 'string') cache[k] = obj[k];
    }
  } catch {
    // brak pliku (pierwsze uruchomienie): przenosimy to, co jest w localStorage widoku
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (k.startsWith('figura.')) cache[k] = localStorage.getItem(k)!;
      }
      if (Object.keys(cache).length) scheduleWrite();
    } catch {
      /* ignoruj */
    }
  }
}
