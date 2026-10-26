/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Korekcje nieniszczące warstwy.
 *
 * Każda korekcja jest operacją PUNKTOWĄ (piksel -> piksel, bez sąsiedztwa) na kolorze RGB; kanał alfa pozostaje bez zmian.
 * Dzięki temu można ją stosować niezależnie na każdym kafelku warstwy oraz na dowolnym fragmencie podglądu
 * (pędzel, figury, przekształcanie zawartości) - wynik jest zawsze taki sam jak po zatwierdzeniu.
 *
 * Moduł nie zależy od DOM ani od reszty silnika: zawiera model danych, domyślne parametry, opisy kontrolek okna
 * dialogowego oraz kompilację łańcucha korekcji do szybkiej funkcji działającej na `Uint8ClampedArray` (RGBA).
 * Kolejne operacje oparte na tablicach LUT są łączone w jedną tablicę.
 */

import type { LayerStyles } from './Styles.ts';
import { defaultStyles } from './Styles.ts';

export type CorrectionType =
  | 'brightnessContrast'
  | 'hueSaturation'
  | 'invert'
  | 'grayscale'
  | 'levels'
  | 'curves'
  | 'colorBalance'
  | 'shadowsHighlights'
  | 'exposure'
  | 'threshold'
  | 'posterize'
  | 'temperatureTint'
  // filtry (operacje na sąsiedztwie pikseli; patrz Filters.ts)
  | 'gaussianBlur'
  | 'motionBlur'
  | 'radialBlur'
  | 'sharpen'
  | 'noise'
  | 'pixelate'
  | 'vignette'
  | 'emboss'
  | 'findEdges'
  | 'surfaceBlur'
  | 'lensBlur'
  | 'chromaticAberration'
  | 'halftone'
  | 'filmGrain'
  | 'glow'
  | 'wave'
  | 'twirl'
  | 'spherize'
  // stylizacje warstwy (jeden krok łańcucha po korekcjach i filtrach; patrz Styles.ts) - nigdy nie leży na liście korekcji
  | 'layerStyles';

// ---------------------------------------------------------------------------------------------------------------
// Parametry
// ---------------------------------------------------------------------------------------------------------------

export interface BrightnessContrastParams {
  /** -100..100 */
  brightness: number;
  /** -100..100 */
  contrast: number;
}

export interface HueSaturationParams {
  /** -180..180 (stopnie) */
  hue: number;
  /** -100..100 */
  saturation: number;
  /** -100..100 */
  lightness: number;
}

export interface InvertParams {
  red: boolean;
  green: boolean;
  blue: boolean;
  /** 0..100 (%) */
  amount: number;
}

export type GrayscaleMethod = 'rec601' | 'rec709' | 'average' | 'lightness' | 'custom';

export interface GrayscaleParams {
  method: GrayscaleMethod;
  /** Wagi kanałów (%), używane przy method = 'custom' */
  weightR: number;
  weightG: number;
  weightB: number;
  /** 0..100 (%) */
  amount: number;
}

export type ChannelId = 'rgb' | 'r' | 'g' | 'b';

export interface LevelsChannelParams {
  inBlack: number; // 0..254
  gamma: number; // 0.1..9.99
  inWhite: number; // 1..255
  outBlack: number; // 0..255
  outWhite: number; // 0..255
}

export interface LevelsParams {
  channels: Record<ChannelId, LevelsChannelParams>;
}

export interface CurvePoint {
  x: number; // 0..255
  y: number; // 0..255
}

export interface CurvesParams {
  channels: Record<ChannelId, CurvePoint[]>;
}

export type TonalRange = 'shadows' | 'midtones' | 'highlights';

export interface ColorBalanceRange {
  /** -100..100: Cyjan (-) <-> Czerwony (+) */
  cyanRed: number;
  /** -100..100: Magenta (-) <-> Zielony (+) */
  magentaGreen: number;
  /** -100..100: Żółty (-) <-> Niebieski (+) */
  yellowBlue: number;
}

export interface ColorBalanceParams {
  shadows: ColorBalanceRange;
  midtones: ColorBalanceRange;
  highlights: ColorBalanceRange;
  preserveLuminosity: boolean;
}

export interface ShadowsHighlightsParams {
  /** -100..100: rozjaśnienie (+) / przyciemnienie (-) cieni */
  shadows: number;
  /** -100..100: półtony */
  midtones: number;
  /** -100..100: rozjaśnienie (+) / przyciemnienie (-) świateł */
  highlights: number;
  /** 0..100: jak daleko w głąb tonów sięga działanie na cienie (zakres tonalny) */
  shadowRange: number;
  /** 0..100: zakres tonalny świateł */
  highlightRange: number;
  /** luminance = zmiana jasności z zachowaniem kolorów; channels = każdy kanał RGB osobno */
  mode: 'luminance' | 'channels';
}

export interface ExposureParams {
  /** -5..5 (EV) */
  exposure: number;
  /** -0.5..0.5 */
  offset: number;
  /** 0.1..4 */
  gamma: number;
  /** true = obliczenia w przestrzeni liniowej (sRGB -> liniowa -> sRGB) */
  linear: boolean;
}

export interface ThresholdParams {
  /** 0..255 */
  level: number;
  mode: 'luminance' | 'channels';
  invert: boolean;
}

export interface PosterizeParams {
  /** 2..64 */
  levels: number;
  mode: 'channels' | 'lightness';
}

export interface TemperatureTintParams {
  /** -100 (chłodniej) .. 100 (cieplej) */
  temperature: number;
  /** -100 (zielonkawy) .. 100 (magenta) */
  tint: number;
  preserveLuminosity: boolean;
}

// --- Filtry (wymiary w pikselach dokumentu) ---

export interface GaussianBlurParams {
  /** 0.1..100 px */
  radius: number;
  /** rozmywa także przezroczystość (krawędzie obiektów); wyłączone = zachowuje kształt */
  blurAlpha: boolean;
}

export interface MotionBlurParams {
  /** -180..180 stopni */
  angle: number;
  /** 1..300 px */
  distance: number;
  /** true = w obie strony od piksela, false = tylko wzdłuż kierunku (smuga) */
  centered: boolean;
}

export interface RadialBlurParams {
  mode: 'spin' | 'zoom';
  /** spin: kąt obrotu (1..90 stopni); zoom: siła (1..100) */
  amount: number;
  /** środek w % szerokości / wysokości dokumentu */
  centerX: number;
  centerY: number;
  quality: 'draft' | 'good' | 'best';
}

export interface SharpenParams {
  /** 0..500 % */
  amount: number;
  /** 0.1..50 px */
  radius: number;
  /** 0..255: różnice mniejsze od progu nie są wyostrzane */
  threshold: number;
  /** wyostrza tylko jasność (bez kolorowych obwódek) */
  luminanceOnly: boolean;
}

export interface NoiseParams {
  /** 0..100 % */
  amount: number;
  distribution: 'gaussian' | 'uniform';
  monochrome: boolean;
  /** 0..9999: ziarno generatora (ten sam wzór po każdym odświeżeniu) */
  seed: number;
}

export interface PixelateParams {
  /** 2..200 px (rozmiar komórki) */
  size: number;
  mode: 'average' | 'center';
}

export interface VignetteParams {
  /** -100 (ciemna) .. 100 (jasna) */
  amount: number;
  /** 0..100 %: rozmiar jasnego środka */
  size: number;
  /** 0..100 %: miękkość przejścia */
  softness: number;
  /** 0 = elipsa dopasowana do dokumentu, 100 = koło */
  roundness: number;
  centerX: number;
  centerY: number;
}

export interface EmbossParams {
  /** 0..360 stopni (kierunek światła) */
  angle: number;
  /** 1..20 px */
  height: number;
  /** 1..500 % */
  amount: number;
  /** true = relief nakładany na kolory, false = szary relief */
  keepColor: boolean;
}

export interface FindEdgesParams {
  /** 1..500 % */
  strength: number;
  /** 1..5 px */
  thickness: number;
  style: 'dark' | 'bright';
  /** true = krawędzie osobno dla każdego kanału RGB */
  color: boolean;
}

export interface SurfaceBlurParams {
  /** 1..20 px */
  radius: number;
  /** 1..100: różnice kolorów powyżej progu nie są rozmywane (krawędzie zostają ostre) */
  threshold: number;
}

export interface LensBlurParams {
  /** 1..60 px */
  radius: number;
  shape: 'circle' | 'hexagon';
  /** 0..100: jak mocno jasne punkty tworzą wyraźne „krążki” */
  highlights: number;
}

export interface ChromaticAberrationParams {
  /** 0..50 px: przesunięcie kanałów czerwonego i niebieskiego */
  amount: number;
  /** kierunek przesunięcia (tryb kierunkowy), stopnie */
  angle: number;
  /** radial = przesunięcie rośnie z odległością od środka */
  mode: 'directional' | 'radial';
  centerX: number;
  centerY: number;
}

export interface HalftoneParams {
  /** 3..60 px: odstęp między punktami */
  size: number;
  /** 0..90 stopni: obrót siatki */
  angle: number;
  /** mono = czarne punkty na bieli, color = punkty w kolorze obrazu */
  mode: 'mono' | 'color';
  /** jasne punkty na ciemnym tle */
  invert: boolean;
}

export interface FilmGrainParams {
  /** 0..100 % */
  amount: number;
  /** 0.5..6 px: wielkość ziarna */
  size: number;
  /** mocniejsze w półtonach, słabsze w cieniach i światłach */
  tonal: boolean;
  monochrome: boolean;
  seed: number;
}

export interface GlowParams {
  /** 0..254: od jakiej jasności zaczyna się poświata */
  threshold: number;
  /** 1..100 px */
  radius: number;
  /** 0..300 % */
  intensity: number;
}

export interface WaveParams {
  /** 1..100 px */
  amplitude: number;
  /** 5..400 px */
  wavelength: number;
  /** 0..360 stopni */
  phase: number;
  direction: 'horizontal' | 'vertical' | 'both';
}

export interface TwirlParams {
  /** -720..720 stopni (kąt obrotu w środku) */
  angle: number;
  /** 10..1500 px */
  radius: number;
  centerX: number;
  centerY: number;
}

export interface SpherizeParams {
  /** -100 (wklęsłość) .. 100 (wypukłość) */
  amount: number;
  /** 10..1500 px */
  radius: number;
  centerX: number;
  centerY: number;
}

export interface CorrectionParamsMap {
  surfaceBlur: SurfaceBlurParams;
  lensBlur: LensBlurParams;
  chromaticAberration: ChromaticAberrationParams;
  halftone: HalftoneParams;
  filmGrain: FilmGrainParams;
  glow: GlowParams;
  wave: WaveParams;
  twirl: TwirlParams;
  spherize: SpherizeParams;
  gaussianBlur: GaussianBlurParams;
  motionBlur: MotionBlurParams;
  radialBlur: RadialBlurParams;
  sharpen: SharpenParams;
  noise: NoiseParams;
  pixelate: PixelateParams;
  vignette: VignetteParams;
  emboss: EmbossParams;
  findEdges: FindEdgesParams;
  brightnessContrast: BrightnessContrastParams;
  hueSaturation: HueSaturationParams;
  invert: InvertParams;
  grayscale: GrayscaleParams;
  levels: LevelsParams;
  curves: CurvesParams;
  colorBalance: ColorBalanceParams;
  shadowsHighlights: ShadowsHighlightsParams;
  exposure: ExposureParams;
  threshold: ThresholdParams;
  posterize: PosterizeParams;
  temperatureTint: TemperatureTintParams;
  layerStyles: LayerStyles;
}

export interface Correction<T extends CorrectionType = CorrectionType> {
  id: string;
  type: T;
  /** Włączona (oko w panelu warstw). Wyłączona korekcja nie wpływa na wygląd, ale zachowuje ustawienia. */
  enabled: boolean;
  params: CorrectionParamsMap[T];
}

// ---------------------------------------------------------------------------------------------------------------
// Domyślne parametry i definicje interfejsu
// ---------------------------------------------------------------------------------------------------------------

const defaultLevelsChannel = (): LevelsChannelParams => ({ inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 });
const defaultCurve = (): CurvePoint[] => [
  { x: 0, y: 0 },
  { x: 255, y: 255 },
];
const defaultRange = (): ColorBalanceRange => ({ cyanRed: 0, magentaGreen: 0, yellowBlue: 0 });

const DEFAULTS: { [K in CorrectionType]: () => CorrectionParamsMap[K] } = {
  brightnessContrast: () => ({ brightness: 0, contrast: 0 }),
  hueSaturation: () => ({ hue: 0, saturation: 0, lightness: 0 }),
  invert: () => ({ red: true, green: true, blue: true, amount: 100 }),
  grayscale: () => ({ method: 'rec601', weightR: 30, weightG: 59, weightB: 11, amount: 100 }),
  levels: () => ({
    channels: { rgb: defaultLevelsChannel(), r: defaultLevelsChannel(), g: defaultLevelsChannel(), b: defaultLevelsChannel() },
  }),
  curves: () => ({ channels: { rgb: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve() } }),
  colorBalance: () => ({
    shadows: defaultRange(),
    midtones: defaultRange(),
    highlights: defaultRange(),
    preserveLuminosity: true,
  }),
  shadowsHighlights: () => ({ shadows: 0, midtones: 0, highlights: 0, shadowRange: 50, highlightRange: 50, mode: 'luminance' }),
  exposure: () => ({ exposure: 0, offset: 0, gamma: 1, linear: true }),
  threshold: () => ({ level: 128, mode: 'luminance', invert: false }),
  posterize: () => ({ levels: 4, mode: 'channels' }),
  temperatureTint: () => ({ temperature: 0, tint: 0, preserveLuminosity: true }),
  gaussianBlur: () => ({ radius: 5, blurAlpha: true }),
  motionBlur: () => ({ angle: 0, distance: 20, centered: true }),
  radialBlur: () => ({ mode: 'spin', amount: 10, centerX: 50, centerY: 50, quality: 'good' }),
  sharpen: () => ({ amount: 100, radius: 1.5, threshold: 0, luminanceOnly: true }),
  noise: () => ({ amount: 20, distribution: 'gaussian', monochrome: false, seed: 1 }),
  pixelate: () => ({ size: 12, mode: 'average' }),
  vignette: () => ({ amount: -60, size: 40, softness: 60, roundness: 30, centerX: 50, centerY: 50 }),
  emboss: () => ({ angle: 135, height: 2, amount: 100, keepColor: false }),
  findEdges: () => ({ strength: 100, thickness: 1, style: 'dark', color: false }),
  surfaceBlur: () => ({ radius: 6, threshold: 25 }),
  lensBlur: () => ({ radius: 10, shape: 'circle', highlights: 40 }),
  chromaticAberration: () => ({ amount: 4, angle: 0, mode: 'radial', centerX: 50, centerY: 50 }),
  halftone: () => ({ size: 10, angle: 45, mode: 'mono', invert: false }),
  filmGrain: () => ({ amount: 30, size: 1.5, tonal: true, monochrome: true, seed: 1 }),
  glow: () => ({ threshold: 170, radius: 18, intensity: 100 }),
  wave: () => ({ amplitude: 12, wavelength: 80, phase: 0, direction: 'horizontal' }),
  twirl: () => ({ angle: 180, radius: 250, centerX: 50, centerY: 50 }),
  spherize: () => ({ amount: 60, radius: 250, centerX: 50, centerY: 50 }),
  layerStyles: () => defaultStyles(),
};

export function defaultParams<T extends CorrectionType>(type: T): CorrectionParamsMap[T] {
  return DEFAULTS[type]() as CorrectionParamsMap[T];
}

/** Opis pojedynczej kontrolki okna korekcji (okno generuje się z opisu). */
export type ControlDef =
  | {
      kind: 'slider';
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      /** Liczba miejsc po przecinku w polu liczbowym */
      decimals?: number;
      unit?: string;
      showIf?: (p: any) => boolean;
    }
  | { kind: 'checkbox'; key: string; label: string; showIf?: (p: any) => boolean }
  | {
      kind: 'select';
      key: string;
      label: string;
      options: { value: string; label: string }[];
      showIf?: (p: any) => boolean;
    };

export interface CorrectionDefinition {
  type: CorrectionType;
  /** Nazwa na liście rozwijanej i w tytule okna */
  name: string;
  /** Kontrolki generowane z opisu; brak = dedykowany edytor (poziomy, krzywe, balans kolorów) */
  controls?: ControlDef[];
  editor?: 'levels' | 'curves' | 'colorBalance';
}

export const CORRECTION_DEFS: CorrectionDefinition[] = [
  {
    type: 'brightnessContrast',
    name: 'Jasność i kontrast',
    controls: [
      { kind: 'slider', key: 'brightness', label: 'Jasność', min: -100, max: 100, step: 1 },
      { kind: 'slider', key: 'contrast', label: 'Kontrast', min: -100, max: 100, step: 1 },
    ],
  },
  {
    type: 'hueSaturation',
    name: 'Barwa / Nasycenie / Jasność',
    controls: [
      { kind: 'slider', key: 'hue', label: 'Barwa', min: -180, max: 180, step: 1, unit: '°' },
      { kind: 'slider', key: 'saturation', label: 'Nasycenie', min: -100, max: 100, step: 1 },
      { kind: 'slider', key: 'lightness', label: 'Jasność', min: -100, max: 100, step: 1 },
    ],
  },
  {
    type: 'invert',
    name: 'Negatyw',
    controls: [
      { kind: 'slider', key: 'amount', label: 'Intensywność', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'checkbox', key: 'red', label: 'Odwróć kanał czerwony' },
      { kind: 'checkbox', key: 'green', label: 'Odwróć kanał zielony' },
      { kind: 'checkbox', key: 'blue', label: 'Odwróć kanał niebieski' },
    ],
  },
  {
    type: 'grayscale',
    name: 'Skala szarości',
    controls: [
      {
        kind: 'select',
        key: 'method',
        label: 'Metoda',
        options: [
          { value: 'rec601', label: 'Luminancja (Rec. 601)' },
          { value: 'rec709', label: 'Luminancja (Rec. 709)' },
          { value: 'average', label: 'Średnia kanałów' },
          { value: 'lightness', label: 'Jasność (HSL)' },
          { value: 'custom', label: 'Własne mieszanie kanałów' },
        ],
      },
      { kind: 'slider', key: 'weightR', label: 'Czerwony', min: -100, max: 200, step: 1, unit: '%', showIf: (p) => p.method === 'custom' },
      { kind: 'slider', key: 'weightG', label: 'Zielony', min: -100, max: 200, step: 1, unit: '%', showIf: (p) => p.method === 'custom' },
      { kind: 'slider', key: 'weightB', label: 'Niebieski', min: -100, max: 200, step: 1, unit: '%', showIf: (p) => p.method === 'custom' },
      { kind: 'slider', key: 'amount', label: 'Intensywność', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  { type: 'levels', name: 'Poziomy', editor: 'levels' },
  { type: 'curves', name: 'Krzywe', editor: 'curves' },
  { type: 'colorBalance', name: 'Balans kolorów', editor: 'colorBalance' },
  {
    type: 'shadowsHighlights',
    name: 'Cienie / Półtony / Światła',
    controls: [
      { kind: 'slider', key: 'shadows', label: 'Cienie', min: -100, max: 100, step: 1 },
      { kind: 'slider', key: 'midtones', label: 'Półtony', min: -100, max: 100, step: 1 },
      { kind: 'slider', key: 'highlights', label: 'Światła', min: -100, max: 100, step: 1 },
      { kind: 'slider', key: 'shadowRange', label: 'Zakres cieni', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'highlightRange', label: 'Zakres świateł', min: 0, max: 100, step: 1, unit: '%' },
      {
        kind: 'select',
        key: 'mode',
        label: 'Tryb',
        options: [
          { value: 'luminance', label: 'Jasność (zachowuje kolory)' },
          { value: 'channels', label: 'Każdy kanał RGB osobno' },
        ],
      },
    ],
  },
  {
    type: 'exposure',
    name: 'Ekspozycja',
    controls: [
      { kind: 'slider', key: 'exposure', label: 'Ekspozycja', min: -5, max: 5, step: 0.01, decimals: 2, unit: ' EV' },
      { kind: 'slider', key: 'offset', label: 'Przesunięcie', min: -0.5, max: 0.5, step: 0.001, decimals: 3 },
      { kind: 'slider', key: 'gamma', label: 'Gamma', min: 0.1, max: 4, step: 0.01, decimals: 2 },
      { kind: 'checkbox', key: 'linear', label: 'Oblicz w przestrzeni liniowej' },
    ],
  },
  {
    type: 'threshold',
    name: 'Progowanie',
    controls: [
      { kind: 'slider', key: 'level', label: 'Próg', min: 0, max: 255, step: 1 },
      {
        kind: 'select',
        key: 'mode',
        label: 'Tryb',
        options: [
          { value: 'luminance', label: 'Luminancja (czerń i biel)' },
          { value: 'channels', label: 'Każdy kanał osobno' },
        ],
      },
      { kind: 'checkbox', key: 'invert', label: 'Odwróć wynik' },
    ],
  },
  {
    type: 'posterize',
    name: 'Posteryzacja',
    controls: [
      { kind: 'slider', key: 'levels', label: 'Liczba poziomów', min: 2, max: 64, step: 1 },
      {
        kind: 'select',
        key: 'mode',
        label: 'Tryb',
        options: [
          { value: 'channels', label: 'Każdy kanał RGB' },
          { value: 'lightness', label: 'Tylko jasność (HSL)' },
        ],
      },
    ],
  },
  {
    type: 'temperatureTint',
    name: 'Temperatura i odcień',
    controls: [
      { kind: 'slider', key: 'temperature', label: 'Temperatura', min: -100, max: 100, step: 1 },
      { kind: 'slider', key: 'tint', label: 'Odcień', min: -100, max: 100, step: 1 },
      { kind: 'checkbox', key: 'preserveLuminosity', label: 'Zachowaj luminancję' },
    ],
  },
];

export const FILTER_DEFS: CorrectionDefinition[] = [
  {
    type: 'gaussianBlur',
    name: 'Rozmycie Gaussa',
    controls: [
      { kind: 'slider', key: 'radius', label: 'Promień', min: 0.1, max: 100, step: 0.1, decimals: 1, unit: ' px' },
      { kind: 'checkbox', key: 'blurAlpha', label: 'Rozmywaj także przezroczystość (krawędzie)' },
    ],
  },
  {
    type: 'motionBlur',
    name: 'Rozmycie w ruchu',
    controls: [
      { kind: 'slider', key: 'angle', label: 'Kąt', min: -180, max: 180, step: 1, unit: '°' },
      { kind: 'slider', key: 'distance', label: 'Odległość', min: 1, max: 300, step: 1, unit: ' px' },
      { kind: 'checkbox', key: 'centered', label: 'W obie strony (symetrycznie)' },
    ],
  },
  {
    type: 'radialBlur',
    name: 'Rozmycie radialne',
    controls: [
      {
        kind: 'select',
        key: 'mode',
        label: 'Rodzaj',
        options: [
          { value: 'spin', label: 'Obrotowe' },
          { value: 'zoom', label: 'Przybliżające (zoom)' },
        ],
      },
      { kind: 'slider', key: 'amount', label: 'Siła / kąt', min: 1, max: 90, step: 1, unit: '' },
      { kind: 'slider', key: 'centerX', label: 'Środek X', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'centerY', label: 'Środek Y', min: 0, max: 100, step: 1, unit: '%' },
      {
        kind: 'select',
        key: 'quality',
        label: 'Jakość',
        options: [
          { value: 'draft', label: 'Szkic (szybko)' },
          { value: 'good', label: 'Dobra' },
          { value: 'best', label: 'Najlepsza (wolno)' },
        ],
      },
    ],
  },
  {
    type: 'sharpen',
    name: 'Wyostrzenie',
    controls: [
      { kind: 'slider', key: 'amount', label: 'Ilość', min: 0, max: 500, step: 1, unit: '%' },
      { kind: 'slider', key: 'radius', label: 'Promień', min: 0.1, max: 50, step: 0.1, decimals: 1, unit: ' px' },
      { kind: 'slider', key: 'threshold', label: 'Próg', min: 0, max: 255, step: 1 },
      { kind: 'checkbox', key: 'luminanceOnly', label: 'Tylko jasność (bez kolorowych obwódek)' },
    ],
  },
  {
    type: 'noise',
    name: 'Szum',
    controls: [
      { kind: 'slider', key: 'amount', label: 'Ilość', min: 0, max: 100, step: 1, unit: '%' },
      {
        kind: 'select',
        key: 'distribution',
        label: 'Rozkład',
        options: [
          { value: 'gaussian', label: 'Gaussa (naturalny)' },
          { value: 'uniform', label: 'Równomierny' },
        ],
      },
      { kind: 'checkbox', key: 'monochrome', label: 'Szum jednobarwny (monochromatyczny)' },
      { kind: 'slider', key: 'seed', label: 'Ziarno losowości', min: 0, max: 9999, step: 1 },
    ],
  },
  {
    type: 'pixelate',
    name: 'Pikselizacja',
    controls: [
      { kind: 'slider', key: 'size', label: 'Rozmiar komórki', min: 2, max: 200, step: 1, unit: ' px' },
      {
        kind: 'select',
        key: 'mode',
        label: 'Kolor komórki',
        options: [
          { value: 'average', label: 'Średnia z komórki' },
          { value: 'center', label: 'Piksel ze środka' },
        ],
      },
    ],
  },
  {
    type: 'vignette',
    name: 'Winieta',
    controls: [
      { kind: 'slider', key: 'amount', label: 'Ilość (ciemna − / jasna +)', min: -100, max: 100, step: 1 },
      { kind: 'slider', key: 'size', label: 'Rozmiar środka', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'softness', label: 'Miękkość', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'roundness', label: 'Okrągłość', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'centerX', label: 'Środek X', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'centerY', label: 'Środek Y', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    type: 'emboss',
    name: 'Płaskorzeźba',
    controls: [
      { kind: 'slider', key: 'angle', label: 'Kierunek światła', min: 0, max: 360, step: 1, unit: '°' },
      { kind: 'slider', key: 'height', label: 'Wysokość', min: 1, max: 20, step: 1, unit: ' px' },
      { kind: 'slider', key: 'amount', label: 'Ilość', min: 1, max: 500, step: 1, unit: '%' },
      { kind: 'checkbox', key: 'keepColor', label: 'Zachowaj kolory obrazu' },
    ],
  },
  {
    type: 'findEdges',
    name: 'Znajdź krawędzie',
    controls: [
      { kind: 'slider', key: 'strength', label: 'Siła', min: 1, max: 500, step: 1, unit: '%' },
      { kind: 'slider', key: 'thickness', label: 'Grubość linii', min: 1, max: 5, step: 1, unit: ' px' },
      {
        kind: 'select',
        key: 'style',
        label: 'Styl',
        options: [
          { value: 'dark', label: 'Ciemne linie na jasnym tle' },
          { value: 'bright', label: 'Jasne linie na ciemnym tle' },
        ],
      },
      { kind: 'checkbox', key: 'color', label: 'Kolorowe krawędzie (osobno każdy kanał)' },
    ],
  },
  {
    type: 'surfaceBlur',
    name: 'Rozmycie powierzchniowe',
    controls: [
      { kind: 'slider', key: 'radius', label: 'Promień', min: 1, max: 20, step: 1, unit: ' px' },
      { kind: 'slider', key: 'threshold', label: 'Próg krawędzi', min: 1, max: 100, step: 1 },
    ],
  },
  {
    type: 'lensBlur',
    name: 'Rozmycie soczewki',
    controls: [
      { kind: 'slider', key: 'radius', label: 'Promień', min: 1, max: 60, step: 1, unit: ' px' },
      {
        kind: 'select',
        key: 'shape',
        label: 'Kształt przysłony',
        options: [
          { value: 'circle', label: 'Koło' },
          { value: 'hexagon', label: 'Sześciokąt' },
        ],
      },
      { kind: 'slider', key: 'highlights', label: 'Wzmocnienie świateł', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    type: 'chromaticAberration',
    name: 'Aberracja chromatyczna',
    controls: [
      { kind: 'slider', key: 'amount', label: 'Przesunięcie kanałów', min: 0, max: 50, step: 0.5, decimals: 1, unit: ' px' },
      {
        kind: 'select',
        key: 'mode',
        label: 'Tryb',
        options: [
          { value: 'radial', label: 'Radialny (od środka)' },
          { value: 'directional', label: 'Kierunkowy' },
        ],
      },
      { kind: 'slider', key: 'angle', label: 'Kierunek', min: 0, max: 360, step: 1, unit: '°', showIf: (p) => p.mode === 'directional' },
      { kind: 'slider', key: 'centerX', label: 'Środek X', min: 0, max: 100, step: 1, unit: '%', showIf: (p) => p.mode === 'radial' },
      { kind: 'slider', key: 'centerY', label: 'Środek Y', min: 0, max: 100, step: 1, unit: '%', showIf: (p) => p.mode === 'radial' },
    ],
  },
  {
    type: 'halftone',
    name: 'Półton (raster)',
    controls: [
      { kind: 'slider', key: 'size', label: 'Odstęp punktów', min: 3, max: 60, step: 1, unit: ' px' },
      { kind: 'slider', key: 'angle', label: 'Kąt rastra', min: 0, max: 90, step: 1, unit: '°' },
      {
        kind: 'select',
        key: 'mode',
        label: 'Kolor punktów',
        options: [
          { value: 'mono', label: 'Czarne na białym' },
          { value: 'color', label: 'Kolory obrazu' },
        ],
      },
      { kind: 'checkbox', key: 'invert', label: 'Jasne punkty na ciemnym tle' },
    ],
  },
  {
    type: 'filmGrain',
    name: 'Ziarno filmowe',
    controls: [
      { kind: 'slider', key: 'amount', label: 'Ilość', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'size', label: 'Wielkość ziarna', min: 0.5, max: 6, step: 0.1, decimals: 1, unit: ' px' },
      { kind: 'checkbox', key: 'tonal', label: 'Mocniejsze w półtonach' },
      { kind: 'checkbox', key: 'monochrome', label: 'Ziarno jednobarwne' },
      { kind: 'slider', key: 'seed', label: 'Ziarno losowości', min: 0, max: 9999, step: 1 },
    ],
  },
  {
    type: 'glow',
    name: 'Poświata',
    controls: [
      { kind: 'slider', key: 'threshold', label: 'Próg jasności', min: 0, max: 254, step: 1 },
      { kind: 'slider', key: 'radius', label: 'Promień', min: 1, max: 100, step: 1, unit: ' px' },
      { kind: 'slider', key: 'intensity', label: 'Intensywność', min: 0, max: 300, step: 1, unit: '%' },
    ],
  },
  {
    type: 'wave',
    name: 'Fala',
    controls: [
      { kind: 'slider', key: 'amplitude', label: 'Amplituda', min: 1, max: 100, step: 1, unit: ' px' },
      { kind: 'slider', key: 'wavelength', label: 'Długość fali', min: 5, max: 400, step: 1, unit: ' px' },
      { kind: 'slider', key: 'phase', label: 'Faza', min: 0, max: 360, step: 1, unit: '°' },
      {
        kind: 'select',
        key: 'direction',
        label: 'Kierunek',
        options: [
          { value: 'horizontal', label: 'Poziomo' },
          { value: 'vertical', label: 'Pionowo' },
          { value: 'both', label: 'W obu kierunkach' },
        ],
      },
    ],
  },
  {
    type: 'twirl',
    name: 'Skręcenie',
    controls: [
      { kind: 'slider', key: 'angle', label: 'Kąt', min: -720, max: 720, step: 1, unit: '°' },
      { kind: 'slider', key: 'radius', label: 'Promień', min: 10, max: 1500, step: 1, unit: ' px' },
      { kind: 'slider', key: 'centerX', label: 'Środek X', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'centerY', label: 'Środek Y', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
  {
    type: 'spherize',
    name: 'Wypukłość',
    controls: [
      { kind: 'slider', key: 'amount', label: 'Wypukłość (+) / wklęsłość (−)', min: -100, max: 100, step: 1 },
      { kind: 'slider', key: 'radius', label: 'Promień', min: 10, max: 1500, step: 1, unit: ' px' },
      { kind: 'slider', key: 'centerX', label: 'Środek X', min: 0, max: 100, step: 1, unit: '%' },
      { kind: 'slider', key: 'centerY', label: 'Środek Y', min: 0, max: 100, step: 1, unit: '%' },
    ],
  },
];

/** Filtry = korekcje operujące na sąsiedztwie pikseli (wymagają kontekstu: patrz Filters.ts). */
export const FILTER_TYPES: ReadonlySet<CorrectionType> = new Set(FILTER_DEFS.map((d) => d.type));
export const isFilterType = (t: CorrectionType): boolean => FILTER_TYPES.has(t) || t === 'layerStyles';

export function getCorrectionDef(type: CorrectionType): CorrectionDefinition {
  return CORRECTION_DEFS.find((d) => d.type === type) ?? FILTER_DEFS.find((d) => d.type === type) ?? CORRECTION_DEFS[0];
}

export function correctionName(type: CorrectionType): string {
  return getCorrectionDef(type).name;
}

// ---------------------------------------------------------------------------------------------------------------
// Tworzenie, kopiowanie, porównywanie, wczytywanie
// ---------------------------------------------------------------------------------------------------------------

let idCounter = 0;
export function newCorrectionId(): string {
  idCounter++;
  return `corr_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function createCorrection<T extends CorrectionType>(type: T, params?: CorrectionParamsMap[T]): Correction<T> {
  return { id: newCorrectionId(), type, enabled: true, params: params ?? defaultParams(type) };
}

export function cloneParams<T>(p: T): T {
  return JSON.parse(JSON.stringify(p)) as T;
}

export function cloneCorrection(c: Correction): Correction {
  return { id: c.id, type: c.type, enabled: c.enabled, params: cloneParams(c.params) };
}

export function cloneCorrections(list: Correction[]): Correction[] {
  return list.map(cloneCorrection);
}

export function correctionsEqual(a: Correction[], b: Correction[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Nakłada wartości z `raw` na `base` zachowując typy domyślnych wartości (odporność na uszkodzone pliki). */
function mergeInto(base: any, raw: any): any {
  if (Array.isArray(base)) return Array.isArray(raw) ? raw : base;
  if (isPlainObject(base)) {
    const out: any = {};
    for (const k of Object.keys(base)) out[k] = mergeInto(base[k], isPlainObject(raw) ? raw[k] : undefined);
    return out;
  }
  return typeof raw === typeof base && !(typeof raw === 'number' && !Number.isFinite(raw)) ? raw : base;
}

function sanitizeCurve(raw: unknown): CurvePoint[] {
  if (!Array.isArray(raw)) return defaultCurve();
  const pts: CurvePoint[] = [];
  for (const p of raw) {
    if (p && typeof p.x === 'number' && typeof p.y === 'number' && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      pts.push({ x: Math.max(0, Math.min(255, p.x)), y: Math.max(0, Math.min(255, p.y)) });
    }
  }
  return pts.length >= 2 ? pts : defaultCurve();
}

/** Odtwarza korekcję z danych zapisanych w pliku; zwraca null dla nieznanego typu. */
export function reviveCorrection(raw: unknown): Correction | null {
  if (!isPlainObject(raw)) return null;
  const type = raw.type as CorrectionType;
  if (!CORRECTION_DEFS.some((d) => d.type === type) && !FILTER_DEFS.some((d) => d.type === type)) return null;
  const params = mergeInto(defaultParams(type), raw.params);
  if (type === 'curves') {
    const rp = isPlainObject(raw.params) && isPlainObject((raw.params as any).channels) ? (raw.params as any).channels : {};
    for (const ch of ['rgb', 'r', 'g', 'b'] as ChannelId[]) params.channels[ch] = sanitizeCurve(rp[ch]);
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newCorrectionId(),
    type,
    enabled: raw.enabled !== false,
    params,
  };
}

export function reviveCorrections(raw: unknown): Correction[] {
  if (!Array.isArray(raw)) return [];
  const out: Correction[] = [];
  for (const r of raw) {
    const c = reviveCorrection(r);
    if (c) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Kompilacja do operacji pikselowych
// ---------------------------------------------------------------------------------------------------------------

type Lut = Uint8Array;

/** Opis operacji punktowej dla GPU: tablice LUT albo numer funkcji shadera z parametrami. */
export type GpuPtOp = { k: 'lut'; r: Uint8Array; g: Uint8Array; b: Uint8Array } | { k: 'fn'; id: number; p: number[]; tbl?: Float32Array };

type Op =
  | { kind: 'lut'; r: Lut; g: Lut; b: Lut }
  | { kind: 'fn'; run: (d: Uint8ClampedArray) => void; gpu?: { id: number; p: number[]; tbl?: Float32Array } };

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

function lutFrom(f: (x: number) => number): Lut {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const y = f(i / 255);
    t[i] = y <= 0 ? 0 : y >= 1 ? 255 : Math.round(y * 255);
  }
  return t;
}

function isIdentityLut(t: Lut): boolean {
  for (let i = 0; i < 256; i++) if (t[i] !== i) return false;
  return true;
}

function lutOp(r: Lut, g: Lut = r, b: Lut = r): Op | null {
  if (isIdentityLut(r) && isIdentityLut(g) && isIdentityLut(b)) return null;
  return { kind: 'lut', r, g, b };
}

const compose = (first: Lut, second: Lut): Lut => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = second[first[i]];
  return t;
};

const srgbToLinear = (x: number): number => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const linearToSrgb = (x: number): number => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);

// --- konwersje HSL (bez alokacji: wynik w zmiennych modułu) ---
let _r = 0;
let _g = 0;
let _b = 0;
let _h = 0;
let _s = 0;
let _l = 0;

function rgbToHsl(r: number, g: number, b: number): void {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  _l = (max + min) / 2;
  if (max === min) {
    _h = 0;
    _s = 0;
    return;
  }
  const d = max - min;
  _s = _l > 0.5 ? d / (2 - max - min) : d / (max + min);
  if (max === r) _h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) _h = ((b - r) / d + 2) / 6;
  else _h = ((r - g) / d + 4) / 6;
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): void {
  if (s <= 0) {
    _r = _g = _b = l;
    return;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  _r = hue2rgb(p, q, h + 1 / 3);
  _g = hue2rgb(p, q, h);
  _b = hue2rgb(p, q, h - 1 / 3);
}

// --- poszczególne korekcje ---

function compileBrightnessContrast(p: BrightnessContrastParams): Op | null {
  const b = p.brightness / 100;
  const c = Math.max(-1, Math.min(0.995, p.contrast / 100));
  const slope = Math.tan(((c + 1) * Math.PI) / 4);
  return lutOp(lutFrom((x) => (x - 0.5) * slope + 0.5 + b * 0.5));
}

function compileHueSaturation(p: HueSaturationParams): Op | null {
  const hs = p.hue / 360;
  const sat = p.saturation / 100;
  const lig = p.lightness / 100;
  if (!hs && !sat && !lig) return null;
  return {
    kind: 'fn',
    gpu: { id: 1, p: [hs, sat, lig] },
    run(d) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
        let h = _h + hs;
        h -= Math.floor(h);
        const s = sat >= 0 ? Math.min(1, _s * (1 + 2 * sat)) : _s * (1 + sat);
        const l = lig >= 0 ? _l + (1 - _l) * lig : _l * (1 + lig);
        hslToRgb(h, s, l);
        d[i] = _r * 255;
        d[i + 1] = _g * 255;
        d[i + 2] = _b * 255;
      }
    },
  };
}

function compileInvert(p: InvertParams): Op | null {
  const a = Math.max(0, Math.min(1, p.amount / 100));
  const inv = lutFrom((x) => x + (1 - 2 * x) * a);
  const id = lutFrom((x) => x);
  return lutOp(p.red ? inv : id, p.green ? inv : id, p.blue ? inv : id);
}

function compileGrayscale(p: GrayscaleParams): Op | null {
  const a = Math.max(0, Math.min(1, p.amount / 100));
  if (a === 0) return null;
  let wr = 0.299;
  let wg = 0.587;
  let wb = 0.114;
  if (p.method === 'rec709') {
    wr = 0.2126;
    wg = 0.7152;
    wb = 0.0722;
  } else if (p.method === 'average') {
    wr = wg = wb = 1 / 3;
  } else if (p.method === 'custom') {
    wr = p.weightR / 100;
    wg = p.weightG / 100;
    wb = p.weightB / 100;
  }
  const lightness = p.method === 'lightness';
  return {
    kind: 'fn',
    gpu: { id: 2, p: [wr, wg, wb, a, lightness ? 1 : 0] },
    run(d) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const gray = lightness ? (Math.max(r, g, b) + Math.min(r, g, b)) / 2 : wr * r + wg * g + wb * b;
        d[i] = r + (gray - r) * a;
        d[i + 1] = g + (gray - g) * a;
        d[i + 2] = b + (gray - b) * a;
      }
    },
  };
}

function levelsLut(ch: LevelsChannelParams): Lut {
  const inB = ch.inBlack;
  const inW = Math.max(inB + 1, ch.inWhite);
  const invG = 1 / Math.max(0.01, ch.gamma);
  return lutFrom((x) => {
    const t = Math.pow(clamp01((x * 255 - inB) / (inW - inB)), invG);
    return (ch.outBlack + t * (ch.outWhite - ch.outBlack)) / 255;
  });
}

function compileLevels(p: LevelsParams): Op | null {
  const master = levelsLut(p.channels.rgb);
  return lutOp(compose(master, levelsLut(p.channels.r)), compose(master, levelsLut(p.channels.g)), compose(master, levelsLut(p.channels.b)));
}

/** Krzywa jako tablica 256 wartości: monotoniczna interpolacja sześcienna (Fritsch-Carlson), bez przestrzałów. */
export function curveLut(points: CurvePoint[]): Lut {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of sorted) {
    if (xs.length && p.x <= xs[xs.length - 1]) continue;
    xs.push(p.x);
    ys.push(p.y);
  }
  const n = xs.length;
  const lut = new Uint8Array(256);
  if (n === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  const delta: number[] = [];
  for (let k = 0; k < n - 1; k++) delta.push((ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]));
  const m: number[] = new Array(n).fill(0);
  if (n > 1) {
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for (let k = 1; k < n - 1; k++) m[k] = delta[k - 1] * delta[k] <= 0 ? 0 : (delta[k - 1] + delta[k]) / 2;
    for (let k = 0; k < n - 1; k++) {
      if (delta[k] === 0) {
        m[k] = 0;
        m[k + 1] = 0;
        continue;
      }
      const a = m[k] / delta[k];
      const b = m[k + 1] / delta[k];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        m[k] = tau * a * delta[k];
        m[k + 1] = tau * b * delta[k];
      }
    }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    let y: number;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      while (seg < n - 2 && x >= xs[seg + 1]) seg++;
      const h = xs[seg + 1] - xs[seg];
      const t = (x - xs[seg]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      y =
        (2 * t3 - 3 * t2 + 1) * ys[seg] +
        (t3 - 2 * t2 + t) * h * m[seg] +
        (-2 * t3 + 3 * t2) * ys[seg + 1] +
        (t3 - t2) * h * m[seg + 1];
    }
    lut[x] = y <= 0 ? 0 : y >= 255 ? 255 : Math.round(y);
  }
  return lut;
}

function compileCurves(p: CurvesParams): Op | null {
  const master = curveLut(p.channels.rgb);
  return lutOp(compose(master, curveLut(p.channels.r)), compose(master, curveLut(p.channels.g)), compose(master, curveLut(p.channels.b)));
}

const BALANCE_SCALE = 0.35 * 255;

function compileColorBalance(p: ColorBalanceParams): Op | null {
  const { shadows: sh, midtones: mi, highlights: hi } = p;
  const zero = (r: ColorBalanceRange) => !r.cyanRed && !r.magentaGreen && !r.yellowBlue;
  if (zero(sh) && zero(mi) && zero(hi)) return null;
  const preserve = p.preserveLuminosity;
  const k = BALANCE_SCALE / 100;
  return {
    kind: 'fn',
    gpu: { id: 3, p: [sh.cyanRed, sh.magentaGreen, sh.yellowBlue, mi.cyanRed, mi.magentaGreen, mi.yellowBlue, hi.cyanRed, hi.magentaGreen, hi.yellowBlue, k, preserve ? 1 : 0] },
    run(d) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const ws = Math.max(0, 1 - 2 * lum);
        const wh = Math.max(0, 2 * lum - 1);
        const wm = 1 - Math.abs(2 * lum - 1);
        const cr = (sh.cyanRed * ws + mi.cyanRed * wm + hi.cyanRed * wh) * k;
        const mg = (sh.magentaGreen * ws + mi.magentaGreen * wm + hi.magentaGreen * wh) * k;
        const yb = (sh.yellowBlue * ws + mi.yellowBlue * wm + hi.yellowBlue * wh) * k;
        let nr = Math.max(0, Math.min(255, r + cr - mg / 2 - yb / 2));
        let ng = Math.max(0, Math.min(255, g + mg - cr / 2 - yb / 2));
        let nb = Math.max(0, Math.min(255, b + yb - cr / 2 - mg / 2));
        if (preserve) {
          const before = 0.299 * r + 0.587 * g + 0.114 * b;
          const after = 0.299 * nr + 0.587 * ng + 0.114 * nb;
          if (after > 0.5) {
            const s = before / after;
            nr = Math.min(255, nr * s);
            ng = Math.min(255, ng * s);
            nb = Math.min(255, nb * s);
          }
        }
        d[i] = nr;
        d[i + 1] = ng;
        d[i + 2] = nb;
      }
    },
  };
}

/** Zmiana tonalna cieni / półtonów / świateł: wagi gładkie (smoothstep), maks. zmiana jednej strefy = ±50% zakresu. */
function compileShadowsHighlights(p: ShadowsHighlightsParams): Op | null {
  const s = p.shadows / 100;
  const m = p.midtones / 100;
  const h = p.highlights / 100;
  if (!s && !m && !h) return null;
  const cs = 0.1 + 0.8 * (p.shadowRange / 100);
  const ch = 0.1 + 0.8 * (p.highlightRange / 100);
  const smooth = (t: number) => {
    const u = t < 0 ? 0 : t > 1 ? 1 : t;
    return u * u * (3 - 2 * u);
  };
  const f = (v: number): number => {
    const ws = smooth(1 - v / cs);
    const wh = smooth((v - (1 - ch)) / ch);
    const wm = 4 * v * (1 - v);
    return v + 0.5 * (s * ws + m * wm + h * wh);
  };
  if (p.mode === 'channels') return lutOp(lutFrom(f));
  const delta = new Int16Array(256);
  for (let i = 0; i < 256; i++) delta[i] = Math.round(f(i / 255) * 255) - i;
  return {
    kind: 'fn',
    gpu: { id: 4, p: [], tbl: Float32Array.from(delta) },
    run(d) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const dl = delta[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] + 0.5) | 0];
        d[i] += dl;
        d[i + 1] += dl;
        d[i + 2] += dl;
      }
    },
  };
}

function compileExposure(p: ExposureParams): Op | null {
  const k = Math.pow(2, p.exposure);
  const invG = 1 / Math.max(0.01, p.gamma);
  return lutOp(
    lutFrom((x) => {
      let v = p.linear ? srgbToLinear(x) : x;
      v = Math.max(0, v * k + p.offset);
      v = Math.pow(v, invG);
      return p.linear ? linearToSrgb(v) : v;
    })
  );
}

function compileThreshold(p: ThresholdParams): Op | null {
  const level = p.level;
  const hiV = p.invert ? 0 : 255;
  const loV = p.invert ? 255 : 0;
  if (p.mode === 'channels') {
    return lutOp(lutFrom((x) => ((x * 255 >= level ? hiV : loV) as number) / 255));
  }
  return {
    kind: 'fn',
    gpu: { id: 5, p: [level, hiV, loV] },
    run(d) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        const v = lum >= level ? hiV : loV;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
    },
  };
}

function compilePosterize(p: PosterizeParams): Op | null {
  const n = Math.max(2, Math.min(255, Math.round(p.levels)));
  if (p.mode === 'channels') {
    const t = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      const idx = Math.min(n - 1, Math.floor((v * n) / 256));
      t[v] = Math.round((idx * 255) / (n - 1));
    }
    return lutOp(t);
  }
  return {
    kind: 'fn',
    gpu: { id: 6, p: [n] },
    run(d) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
        const idx = Math.min(n - 1, Math.floor(_l * n));
        hslToRgb(_h, _s, idx / (n - 1));
        d[i] = _r * 255;
        d[i + 1] = _g * 255;
        d[i + 2] = _b * 255;
      }
    },
  };
}

function compileTemperatureTint(p: TemperatureTintParams): Op | null {
  const t = p.temperature / 100;
  const ti = p.tint / 100;
  if (!t && !ti) return null;
  const gr = 1 + 0.4 * t + 0.15 * ti;
  const gg = 1 + 0.1 * t - 0.4 * ti;
  const gb = 1 - 0.4 * t + 0.15 * ti;
  if (!p.preserveLuminosity) {
    return lutOp(
      lutFrom((x) => x * gr),
      lutFrom((x) => x * gg),
      lutFrom((x) => x * gb)
    );
  }
  return {
    kind: 'fn',
    gpu: { id: 7, p: [gr, gg, gb] },
    run(d) {
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i];
        const g = d[i + 1];
        const b = d[i + 2];
        let nr = Math.min(255, r * gr);
        let ng = Math.min(255, g * gg);
        let nb = Math.min(255, b * gb);
        const before = 0.299 * r + 0.587 * g + 0.114 * b;
        const after = 0.299 * nr + 0.587 * ng + 0.114 * nb;
        if (after > 0.5) {
          const s = before / after;
          nr = Math.min(255, nr * s);
          ng = Math.min(255, ng * s);
          nb = Math.min(255, nb * s);
        }
        d[i] = nr;
        d[i + 1] = ng;
        d[i + 2] = nb;
      }
    },
  };
}

function compileOne(c: Correction): Op | null {
  switch (c.type) {
    case 'brightnessContrast':
      return compileBrightnessContrast(c.params as BrightnessContrastParams);
    case 'hueSaturation':
      return compileHueSaturation(c.params as HueSaturationParams);
    case 'invert':
      return compileInvert(c.params as InvertParams);
    case 'grayscale':
      return compileGrayscale(c.params as GrayscaleParams);
    case 'levels':
      return compileLevels(c.params as LevelsParams);
    case 'curves':
      return compileCurves(c.params as CurvesParams);
    case 'colorBalance':
      return compileColorBalance(c.params as ColorBalanceParams);
    case 'shadowsHighlights':
      return compileShadowsHighlights(c.params as ShadowsHighlightsParams);
    case 'exposure':
      return compileExposure(c.params as ExposureParams);
    case 'threshold':
      return compileThreshold(c.params as ThresholdParams);
    case 'posterize':
      return compilePosterize(c.params as PosterizeParams);
    case 'temperatureTint':
      return compileTemperatureTint(c.params as TemperatureTintParams);
    default:
      return null;
  }
}

function runLut(d: Uint8ClampedArray, r: Lut, g: Lut, b: Lut): void {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r[d[i]];
    d[i + 1] = g[d[i + 1]];
    d[i + 2] = b[d[i + 2]];
  }
}

/**
 * Kompiluje łańcuch korekcji (tylko włączone, w kolejności stosowania) do jednej funkcji działającej w miejscu na
 * danych RGBA (nieprzemnożone alfą - tak jak zwraca getImageData). Sąsiednie tablice LUT są łączone w jedną.
 */
export type PtFn = ((d: Uint8ClampedArray) => void) & { gpu?: GpuPtOp[] | null };

export function compileCorrections(list: Correction[]): PtFn {
  const ops: Op[] = [];
  for (const c of list) {
    if (!c.enabled) continue;
    const op = compileOne(c);
    if (!op) continue;
    const last = ops[ops.length - 1];
    if (op.kind === 'lut' && last && last.kind === 'lut') {
      ops[ops.length - 1] = { kind: 'lut', r: compose(last.r, op.r), g: compose(last.g, op.g), b: compose(last.b, op.b) };
    } else {
      ops.push(op);
    }
  }
  const fnOps: PtFn = (d) => {
    for (const op of ops) {
      if (op.kind === 'lut') runLut(d, op.r, op.g, op.b);
      else op.run(d);
    }
  };
  // opis dla GPU (null, gdy któraś operacja go nie ma)
  const gops: GpuPtOp[] = [];
  let gok = true;
  for (const op of ops) {
    if (op.kind === 'lut') gops.push({ k: 'lut', r: op.r, g: op.g, b: op.b });
    else if (op.gpu) gops.push({ k: 'fn', id: op.gpu.id, p: op.gpu.p, tbl: op.gpu.tbl });
    else gok = false;
  }
  fnOps.gpu = gok ? gops : null;
  if (ops.length === 0) {
    const noop: PtFn = () => {};
    noop.gpu = [];
    return noop;
  }
  return fnOps;
}

// ---------------------------------------------------------------------------------------------------------------
// Histogram (do okien Poziomy i Krzywe)
// ---------------------------------------------------------------------------------------------------------------

export interface Histogram {
  lum: Uint32Array;
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
}

export function createHistogram(): Histogram {
  return { lum: new Uint32Array(256), r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256) };
}

/** Dolicza do histogramu piksele z `d` (RGBA); w pełni przezroczyste są pomijane. */
export function accumulateHistogram(d: Uint8ClampedArray, h: Histogram): void {
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    h.r[r]++;
    h.g[g]++;
    h.b[b]++;
    h.lum[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;
  }
}
