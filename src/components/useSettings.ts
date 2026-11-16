import { useSyncExternalStore } from 'react';
import { settings, type Settings } from '../core/Settings.ts';

/** Bieżące ustawienia programu; komponent odświeża się po każdej zmianie. */
export function useSettings(): Settings {
  return useSyncExternalStore(settings.subscribe, () => settings.get());
}
