/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useSyncExternalStore } from 'react';

/**
 * Stos otwartych okien dialogowych: ostatni element jest „na wierzchu”. Kliknięcie okna wynosi je na wierzch,
 * a klawisze (Esc / Enter) obsługuje wyłącznie okno z wierzchu.
 */
let stack: string[] = [];
let version = 0;
const listeners = new Set<() => void>();
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

export const dialogStack = {
  open(id: string): void {
    stack = [...stack.filter((x) => x !== id), id];
    emit();
  },
  close(id: string): void {
    if (!stack.includes(id)) return;
    stack = stack.filter((x) => x !== id);
    emit();
  },
  raise(id: string): void {
    if (stack[stack.length - 1] === id || !stack.includes(id)) return;
    stack = [...stack.filter((x) => x !== id), id];
    emit();
  },
  indexOf(id: string): number {
    return stack.indexOf(id);
  },
  top(): string | null {
    return stack.length ? stack[stack.length - 1] : null;
  },
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  version: () => version,
};

/** Numer okna w stosie (rośnie ku wierzchowi); odświeża komponent przy zmianie kolejności. */
export function useDialogLayer(id: string): number {
  useSyncExternalStore(dialogStack.subscribe, dialogStack.version);
  return dialogStack.indexOf(id);
}

/**
 * Czy zdarzenie klawiatury ma obsłużyć okno o danym `testId`: tylko okno z wierzchu, a Esc nie dotyczy okna, gdy
 * trwa edycja drobniejszego elementu (przechwytywanie skrótu, pole liczbowe), który sam obsłuży Esc.
 */
const claimed = new WeakSet<Event>();
export function dialogOwnsKey(e: KeyboardEvent, testId: string): boolean {
  // zdarzenie obsługuje jedno okno: kolejne nasłuchy (okno zamknięte w międzyczasie przez React) już go nie dostają
  if (claimed.has(e)) return false;
  const top = dialogStack.top();
  if (top !== null && top !== testId) return false;
  // otwarty mały panel koloru sam obsługuje Esc / Enter
  if ((e.key === 'Escape' || e.key === 'Enter') && document.querySelector('[data-color-popover]')) return false;
  if (e.key === 'Escape' && e.target instanceof HTMLElement && (e.target.dataset.capturing !== undefined || e.target.dataset.scrubEditing !== undefined)) return false;
  claimed.add(e);
  return true;
}
