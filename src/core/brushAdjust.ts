import type { ToolType } from './types.ts';

/**
 * Szybka regulacja parametrów pędzla z klawiatury i myszy (bez wchodzenia w pasek opcji).
 *
 *  Alt + przeciąganie (LPM lub PPM)          ← → rozmiar,   ↑ ↓ twardość
 *  Ctrl + Alt + przeciąganie (LPM lub PPM)   ← → odstępy,   ↑ ↓ krycie (tylko pędzel)
 *  Shift w trakcie przeciągania              precyzja (×0.25)
 *  Alt + kółko                               rozmiar
 *  Alt + Shift + kółko                       twardość
 *  [ ]                                       rozmiar (proporcjonalnie)
 *  Shift + [ ]                               twardość ±10
 */
export const BRUSH_ADJUST_TOOLS: ToolType[] = ['brush', 'eraser', 'correction-brush', 'color-replace', 'stamp', 'deform'];

export const isBrushAdjustTool = (t: ToolType): boolean => BRUSH_ADJUST_TOOLS.includes(t);

/** Przezroczystość (alfa koloru głównego) działa we wszystkich narzędziach pędzlowych, choć nazywa się różnie (patrz niżej). */
export const supportsOpacity = (t: ToolType): boolean => isBrushAdjustTool(t);

/** Nazwa parametru w danym narzędziu: tak jak na jego pasku opcji (Intensywność, Krycie) lub w panelu kolorów (Przezroczystość). */
export const paramLabel = (p: BrushParam, tool: ToolType): string => {
  if (p !== 'opacity') return PARAM_LABEL[p];
  if (tool === 'correction-brush' || tool === 'deform') return 'Intensywność';
  if (tool === 'stamp') return 'Krycie';
  return 'Przezroczystość';
};

export type BrushParam = 'size' | 'hardness' | 'spacing' | 'opacity';

export interface BrushAdjustFns {
  size?: (v: number) => number;
  hardness?: (v: number) => number;
  spacing?: (v: number) => number;
  /** krycie w procentach 0..100 */
  opacity?: (v: number) => number;
}

export const SIZE_MIN = 1;
export const SIZE_MAX = 2000;
export const SPACING_MIN = 1;
export const SPACING_MAX = 500;

export const clampSize = (v: number) => Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(v)));
export const clampPct = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
export const clampSpacing = (v: number) => Math.max(SPACING_MIN, Math.min(SPACING_MAX, Math.round(v)));

/** Ile pikseli ruchu to podwojenie wartości (skala wykładnicza). */
const SIZE_PX_PER_DOUBLING = 150;
const SPACING_PX_PER_DOUBLING = 100;
/** Ile punktów procentowych na piksel ruchu. */
const PCT_PER_PX = 0.5;

export const sizeFromDrag = (start: number, dx: number) => clampSize(start * Math.pow(2, dx / SIZE_PX_PER_DOUBLING));
export const spacingFromDrag = (start: number, dx: number) => clampSpacing(start * Math.pow(2, dx / SPACING_PX_PER_DOUBLING));
/** dy rośnie w dół ekranu, więc ruch w górę = więcej. */
export const pctFromDrag = (start: number, dy: number) => clampPct(start - dy * PCT_PER_PX);

export const alphaToPct = (a: number) => Math.round((a / 255) * 100);
export const pctToAlpha = (p: number) => Math.round((clampPct(p) / 100) * 255);

/** Dostępne osie danej warstwy w danym narzędziu: [poziomo, pionowo]. */
export const axesFor = (tool: ToolType, layer: 1 | 2): [BrushParam | null, BrushParam | null] => {
  if (layer === 1) return ['size', 'hardness'];
  return ['spacing', supportsOpacity(tool) ? 'opacity' : null];
};

export const PARAM_LABEL: Record<BrushParam, string> = {
  size: 'Rozmiar',
  hardness: 'Twardość',
  spacing: 'Odstępy',
  opacity: 'Przezroczystość',
};

export const formatParam = (p: BrushParam, v: number): string => (p === 'size' ? `${v} px` : `${v}%`);

/** Kolejny krok rozmiaru dla klawiszy [ ] (około 10%, minimum 1 px). */
export const stepSize = (v: number, dir: 1 | -1): number => {
  const step = Math.max(1, Math.round(v * 0.1));
  return clampSize(v + dir * step);
};

/**
 * Dopuszczalny zakres przesunięcia myszy (w pikselach, w osi danego parametru) przy zadanej wartości początkowej.
 * Dalszy ruch poza ten zakres jest ignorowany, więc powrót myszy zmienia wartość od razu.
 */
export const dragBounds = (param: BrushParam, start: number): [number, number] => {
  switch (param) {
    case 'size':
      return [SIZE_PX_PER_DOUBLING * Math.log2(SIZE_MIN / start), SIZE_PX_PER_DOUBLING * Math.log2(SIZE_MAX / start)];
    case 'spacing':
      return [SPACING_PX_PER_DOUBLING * Math.log2(SPACING_MIN / start), SPACING_PX_PER_DOUBLING * Math.log2(SPACING_MAX / start)];
    case 'hardness':
      return [(start - 100) / PCT_PER_PX, (start - 0) / PCT_PER_PX];
    default:
      return [(start - 100) / PCT_PER_PX, (start - 1) / PCT_PER_PX];
  }
};
