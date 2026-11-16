/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolType } from './types.ts';
import { settings } from './Settings.ts';

/** Narzędzia z jednoliterowym skrótem klawiszowym, który można zmienić (Edycja > Ustawienia > Skróty). */
export interface ToolKeyDef {
  id: ToolType;
  name: string;
  /** domyślny klawisz (mała litera) */
  key: string;
  /** narzędzie działa tylko na warstwie wektorowej (klawisz może się wtedy pokrywać z narzędziem rastrowym) */
  vector?: boolean;
}

export const TOOL_KEY_DEFS: ToolKeyDef[] = [
  { id: 'select-rect', name: 'Zaznaczenie prostokątne', key: 's' },
  { id: 'select-ellipse', name: 'Zaznaczenie eliptyczne', key: 'm' },
  { id: 'select-lasso', name: 'Zaznaczanie odręczne', key: 'l' },
  { id: 'magic-wand', name: 'Magiczna różdżka', key: 'w' },
  { id: 'transform-selection', name: 'Przekształć zaznaczenie', key: 't' },
  { id: 'brush', name: 'Pędzel', key: 'b' },
  { id: 'eraser', name: 'Gumka', key: 'e' },
  { id: 'correction-brush', name: 'Pędzel korekcyjny', key: 'j' },
  { id: 'color-replace', name: 'Zmiana koloru', key: 'r' },
  { id: 'stamp', name: 'Pieczątka (klonowanie)', key: 'c' },
  { id: 'deform', name: 'Deformacja', key: 'd' },
  { id: 'pipette', name: 'Pipeta', key: 'k' },
  { id: 'bucket', name: 'Wypełnienie', key: 'f' },
  { id: 'gradient', name: 'Gradient', key: 'g' },
  { id: 'shapes', name: 'Kształty', key: 'o' },
  { id: 'line', name: 'Linia prosta', key: 'u' },
  { id: 'bezier', name: 'Krzywa', key: 'p' },
  { id: 'text', name: 'Tekst', key: 'y' },
  { id: 'pan', name: 'Nawigacja', key: 'h' },
  { id: 'zoom', name: 'Lupa', key: 'z' },
  { id: 'vector-select', name: 'Manipulacja (obiekty wektorowe)', key: 'v', vector: true },
  { id: 'pen', name: 'Pisak (krzywa wektorowa)', key: 'n', vector: true },
];

/** Klawisze zajęte na stałe przez program (zamiana kolorów) — nie można ich przypisać narzędziom. */
export const RESERVED_TOOL_KEYS = ['x'];

const DEF_BY_ID = new Map(TOOL_KEY_DEFS.map((d) => [d.id as string, d]));

/** Obowiązujący klawisz narzędzia (zmieniony przez użytkownika albo domyślny); '' = brak skrótu. */
export function toolKey(id: string): string {
  const d = DEF_BY_ID.get(id);
  if (!d) return '';
  const o = settings.get().toolKeys[id];
  return o !== undefined ? o : d.key;
}

/** Narzędzie przypisane do klawisza; narzędzia wektorowe tylko, gdy aktywna jest warstwa wektorowa. */
export function toolForKey(key: string, vectorLayer: boolean): ToolType | null {
  for (const d of TOOL_KEY_DEFS) {
    if (d.vector && !vectorLayer) continue;
    if (toolKey(d.id) === key) return d.id;
  }
  return null;
}

/** Tekst skrótu do podpowiedzi przycisku narzędzia (null = narzędzie nie ma konfigurowalnego skrótu). */
export function toolKeyLabel(id: string): string | null {
  if (!DEF_BY_ID.has(id)) return null;
  const k = toolKey(id);
  return k ? k.toUpperCase() : 'brak';
}
