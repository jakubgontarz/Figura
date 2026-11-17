/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zapamiętywanie położenia, rozmiaru i stanu (zmaksymalizowane) okna w aplikacji Tauri.
 * W przeglądarce nic nie robi. Stan leży w pliku ustawień programu (`persist`), a okno jest pokazywane dopiero po
 * przywróceniu (w tauri.conf.json `visible: false`), żeby nie migało w domyślnym miejscu.
 */

import { persist } from '../core/Persist.ts';
import { curWin } from './index.ts';

const KEY = 'figura.window.v1';

interface Saved {
  x: number;
  y: number;
  w: number;
  h: number;
  max: boolean;
}

const tauri = (): any => (window as any).__TAURI__;

const read = (): Saved | null => {
  try {
    const r = JSON.parse(persist.get(KEY) || 'null');
    if (r && [r.x, r.y, r.w, r.h].every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) && r.w >= 200 && r.h >= 150) return { x: r.x, y: r.y, w: r.w, h: r.h, max: !!r.max };
  } catch {
    /* brak zapisu */
  }
  return null;
};

/** Czy zapisane położenie ma co najmniej 120 × 60 px widocznych na którymkolwiek z podłączonych monitorów (monitor mógł zniknąć). */
async function visibleOnSomeMonitor(s: Saved): Promise<boolean> {
  try {
    const mons: any[] = (await tauri()?.window?.availableMonitors?.()) ?? [];
    if (!mons.length) return true;
    return mons.some((m) => {
      const mx = m.position.x, my = m.position.y, mw = m.size.width, mh = m.size.height;
      const ox = Math.min(s.x + s.w, mx + mw) - Math.max(s.x, mx);
      const oy = Math.min(s.y + s.h, my + mh) - Math.max(s.y, my);
      return ox >= 120 && oy >= 60;
    });
  } catch {
    return true;
  }
}

/** Przywraca zapisany stan okna i pokazuje okno. Zawsze kończy się pokazaniem okna, nawet po błędzie. */
export async function restoreWindowState(): Promise<void> {
  const w = curWin();
  if (!w) return;
  try {
    const s = read();
    const dpi = tauri()?.dpi;
    if (s && dpi) {
      await w.setSize(new dpi.PhysicalSize(s.w, s.h));
      if (await visibleOnSomeMonitor(s)) await w.setPosition(new dpi.PhysicalPosition(s.x, s.y));
      else await w.center?.();
      if (s.max) await w.maximize();
    }
  } catch {
    /* zostaje domyślne położenie z tauri.conf.json */
  } finally {
    try {
      await w.show?.();
      await w.setFocus?.();
    } catch {
      /* okno mogło być już widoczne */
    }
  }
}

/** Zapisuje stan okna przy każdej zmianie (z opóźnieniem). Zwraca funkcję odpinającą. */
export function trackWindowState(): () => void {
  const w = curWin();
  if (!w) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: Saved | null = read();

  const capture = async () => {
    try {
      const [maximized, minimized, fullscreen] = await Promise.all([w.isMaximized(), w.isMinimized?.() ?? false, w.isFullscreen?.() ?? false]);
      if (minimized || fullscreen) return;
      if (maximized) {
        // przy maksymalizacji zachowujemy ostatni „zwykły” rozmiar i położenie, żeby po przywróceniu wrócić do nich
        if (last) last = { ...last, max: true };
      } else {
        const p = await w.outerPosition();
        const sz = await w.outerSize();
        if (p.x < -30000 || p.y < -30000) return; // Windows zgłasza tak okno zminimalizowane
        last = { x: p.x, y: p.y, w: sz.width, h: sz.height, max: false };
      }
      if (last) {
        persist.set(KEY, JSON.stringify(last));
      }
    } catch {
      /* ignorujemy: stan okna nie jest krytyczny */
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void capture().then(() => persist.flush()), 400);
  };

  const unsubs: (() => void)[] = [];
  let dead = false;
  const hook = (p: any) => Promise.resolve(p).then((u: () => void) => (dead ? u?.() : u && unsubs.push(u))).catch(() => {});
  if (w.onResized) hook(w.onResized(schedule));
  if (w.onMoved) hook(w.onMoved(schedule));
  void capture(); // stan początkowy (np. pierwsze uruchomienie)
  return () => {
    dead = true;
    if (timer) clearTimeout(timer);
    unsubs.forEach((u) => u());
  };
}

/** Natychmiastowy zapis (tuż przed zamknięciem programu). */
export async function saveWindowStateNow(): Promise<void> {
  const w = curWin();
  if (!w) return;
  try {
    const maximized = await w.isMaximized();
    const prev = read();
    if (maximized && prev) persist.set(KEY, JSON.stringify({ ...prev, max: true }));
    else if (!maximized) {
      const p = await w.outerPosition();
      const sz = await w.outerSize();
      if (p.x > -30000) persist.set(KEY, JSON.stringify({ x: p.x, y: p.y, w: sz.width, h: sz.height, max: false }));
    }
    await persist.flush();
  } catch {
    /* ignorujemy */
  }
}
