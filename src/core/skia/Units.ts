/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Tryb wyświetlania: piksele (kafelki) albo wektory (obiekty wektorowe rysowane wektorowo, położenia bez zaokrąglania do pikseli). */
export type UnitMode = 'px' | 'vec';

/** Jednostka długości pól liczbowych, współrzędnych kursora i wymiarów obrazu (niezależna od trybu wyświetlania). */
export type LengthUnit = 'px' | 'mm' | 'cm' | 'in';
export const LENGTH_UNITS: LengthUnit[] = ['px', 'mm', 'cm', 'in'];
export const UNIT_LABEL: Record<LengthUnit, string> = { px: 'px', mm: 'mm', cm: 'cm', in: 'cal' };

export const MM_PER_INCH = 25.4;
export const DEFAULT_DPI = 96;

export const pxToMm = (px: number, dpi: number): number => (px * MM_PER_INCH) / dpi;
export const mmToPx = (mm: number, dpi: number): number => (mm * dpi) / MM_PER_INCH;

/** Napis z milimetrami z dokładnością do dwóch miejsc po przecinku. */
export const fmtMm = (px: number, dpi: number): string => pxToMm(px, dpi).toFixed(2);

/** Zaokrąglenie współrzędnej obiektu wektorowego: w trybie wektorowym do 0,001 px (poniżej 0,01 mm), inaczej do pełnego piksela. */
export const quantizeCoord = (v: number, mode: UnitMode): number =>
  mode === 'vec' ? Math.round(v * 1000) / 1000 : Math.round(v);

export interface DocPreset {
  id: string;
  name: string;
  /** piksele (tryb px) albo milimetry (tryb mm) */
  w: number;
  h: number;
}

export const PIXEL_PRESETS: DocPreset[] = [
  { id: 'p800', name: '800 × 600', w: 800, h: 600 },
  { id: 'p1024', name: '1024 × 768', w: 1024, h: 768 },
  { id: 'hd', name: 'HD (720p)', w: 1280, h: 720 },
  { id: 'fhd', name: 'Full HD (1080p)', w: 1920, h: 1080 },
  { id: 'qhd', name: 'QHD (1440p)', w: 2560, h: 1440 },
  { id: '4k', name: '4K UHD', w: 3840, h: 2160 },
  { id: 'sq', name: 'Kwadrat 1080', w: 1080, h: 1080 },
];

export const MM_PRESETS: DocPreset[] = [
  { id: 'a3', name: 'A3', w: 297, h: 420 },
  { id: 'a4', name: 'A4', w: 210, h: 297 },
  { id: 'a5', name: 'A5', w: 148, h: 210 },
  { id: 'a6', name: 'A6', w: 105, h: 148 },
  { id: 'letter', name: 'Letter', w: 215.9, h: 279.4 },
  { id: 'legal', name: 'Legal', w: 215.9, h: 355.6 },
  { id: 'card', name: 'Wizytówka 90 × 50', w: 90, h: 50 },
];

export const DPI_CHOICES = [72, 96, 150, 300, 600];

/** Ile pikseli dokumentu mieści się w jednej jednostce (przy danej rozdzielczości). */
export const pxPerUnit = (unit: LengthUnit, dpi: number): number =>
  unit === 'px' ? 1 : unit === 'mm' ? dpi / MM_PER_INCH : unit === 'cm' ? dpi / (MM_PER_INCH / 10) : dpi;
export const pxToUnit = (px: number, unit: LengthUnit, dpi: number): number => px / pxPerUnit(unit, dpi);
export const unitToPx = (v: number, unit: LengthUnit, dpi: number): number => v * pxPerUnit(unit, dpi);

const UNIT_DECIMALS: Record<LengthUnit, number> = { px: 2, mm: 2, cm: 3, in: 3 };

/** Napis z wartością w jednostce; piksele w całkowitej liczbie, gdy `intPx` (domyślnie), inaczej do 2 miejsc. */
export const fmtUnit = (px: number, unit: LengthUnit, dpi: number, intPx = true): string =>
  unit === 'px' && intPx ? String(Math.round(px)) : pxToUnit(px, unit, dpi).toFixed(UNIT_DECIMALS[unit]);
