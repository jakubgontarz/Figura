/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SKPoint {
  x: number;
  y: number;
}

export interface SKRectI {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface SKColor {
  r: number; // 0..255
  g: number; // 0..255
  b: number; // 0..255
  a: number; // 0..255
}

export type SKBlendMode =
  | 'SrcOver'     // Normalny
  | 'Multiply'    // Mnożenie
  | 'Screen'      // Ekran
  | 'Overlay'     // Nakładka
  | 'Darken'      // Ciemniej
  | 'Lighten'     // Jaśniej
  | 'ColorDodge'  // Rozjaśnianie koloru
  | 'ColorBurn'   // Ściemnianie koloru
  | 'HardLight'   // Ostre światło
  | 'SoftLight'   // Łagodne światło
  | 'Difference'  // Różnica
  | 'Exclusion'   // Wykluczenie
  | 'Clear';      // Czyszczenie / Gumka

export interface BlendModeInfo {
  id: SKBlendMode;
  namePl: string;
  canvasCompositeOp: GlobalCompositeOperation;
  csharpEnum: string;
}

export const BLEND_MODES: BlendModeInfo[] = [
  { id: 'SrcOver', namePl: 'Normalny', canvasCompositeOp: 'source-over', csharpEnum: 'SKBlendMode.SrcOver' },
  { id: 'Multiply', namePl: 'Mnożenie', canvasCompositeOp: 'multiply', csharpEnum: 'SKBlendMode.Multiply' },
  { id: 'Screen', namePl: 'Ekran', canvasCompositeOp: 'screen', csharpEnum: 'SKBlendMode.Screen' },
  { id: 'Overlay', namePl: 'Nakładka', canvasCompositeOp: 'overlay', csharpEnum: 'SKBlendMode.Overlay' },
  { id: 'Darken', namePl: 'Ciemniej', canvasCompositeOp: 'darken', csharpEnum: 'SKBlendMode.Darken' },
  { id: 'Lighten', namePl: 'Jaśniej', canvasCompositeOp: 'lighten', csharpEnum: 'SKBlendMode.Lighten' },
  { id: 'ColorDodge', namePl: 'Rozjaśnianie koloru', canvasCompositeOp: 'color-dodge', csharpEnum: 'SKBlendMode.ColorDodge' },
  { id: 'ColorBurn', namePl: 'Ściemnianie koloru', canvasCompositeOp: 'color-burn', csharpEnum: 'SKBlendMode.ColorBurn' },
  { id: 'HardLight', namePl: 'Ostre światło', canvasCompositeOp: 'hard-light', csharpEnum: 'SKBlendMode.HardLight' },
  { id: 'SoftLight', namePl: 'Łagodne światło', canvasCompositeOp: 'soft-light', csharpEnum: 'SKBlendMode.SoftLight' },
  { id: 'Difference', namePl: 'Różnica', canvasCompositeOp: 'difference', csharpEnum: 'SKBlendMode.Difference' },
  { id: 'Exclusion', namePl: 'Wykluczenie', canvasCompositeOp: 'exclusion', csharpEnum: 'SKBlendMode.Exclusion' },
];

export function getCanvasCompositeOperation(blendMode: SKBlendMode): GlobalCompositeOperation {
  switch (blendMode) {
    case 'Clear':
      return 'destination-out';
    case 'Multiply':
      return 'multiply';
    case 'Screen':
      return 'screen';
    case 'Overlay':
      return 'overlay';
    case 'Darken':
      return 'darken';
    case 'Lighten':
      return 'lighten';
    case 'ColorDodge':
      return 'color-dodge';
    case 'ColorBurn':
      return 'color-burn';
    case 'HardLight':
      return 'hard-light';
    case 'SoftLight':
      return 'soft-light';
    case 'Difference':
      return 'difference';
    case 'Exclusion':
      return 'exclusion';
    case 'SrcOver':
    default:
      return 'source-over';
  }
}

export function skColorToRgbaString(c: SKColor): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${(c.a / 255).toFixed(3)})`;
}

export function skColorToHex(c: SKColor): string {
  const r = c.r.toString(16).padStart(2, '0').toUpperCase();
  const g = c.g.toString(16).padStart(2, '0').toUpperCase();
  const b = c.b.toString(16).padStart(2, '0').toUpperCase();
  return `#${r}${g}${b}`;
}

export function hexToSkColor(hex: string, alpha: number = 255): SKColor {
  let clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map(ch => ch + ch).join('');
  }
  const num = parseInt(clean, 16);
  if (isNaN(num) || clean.length !== 6) {
    return { r: 0, g: 0, b: 0, a: alpha };
  }
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
    a: Math.max(0, Math.min(255, Math.round(alpha)))
  };
}

export interface BrushSettings {
  size: number;          // Rozmiar w px: 1..2000
  hardness: number;      // Twardość: 0..100%
  antiAliasing: boolean; // Wygładzanie (wł/wył)
  spacing: number;       // Odstęp w %: 1..500%
  blendMode: SKBlendMode;// Tryb mieszania pędzla
  color: SKColor;        // Kolor pędzla (RGB + A)
}

export type SelectionCombineMode = 'replace' | 'add' | 'subtract' | 'intersect' | 'invert';
export type SelectionConstraint = 'normal' | 'fixed-ratio' | 'fixed-size';
export type WandSamplingMode = 'contiguous' | 'global';
export type WandSampleSource = 'image' | 'layer'; // 'image' = Wszystkie widoczne warstwy (Obraz) | 'layer' = Tylko aktywna warstwa (Warstwa)
export type InterpolationMode = 'nearest-neighbor' | 'bilinear' | 'bicubic';

export interface PipetteSettings {
  sampleSource: 'image' | 'layer'; // 'image' = Cały obraz | 'layer' = Bieżąca warstwa
  sampleDiameter: number;          // Średnica obszaru zbierania w px (1 = pojedynczy punkt, 3, 5, 11, etc.)
  showLoupe: boolean;              // Okrągły obszar przybliżenia (lupa)
}

export interface SelectionSettings {
  mode: SelectionCombineMode;      // Tryb: Zastąp, Dodaj, Odejmij, Część wspólna, Odwróć
  constraint: SelectionConstraint; // Rozmiar: Dowolny, Stały stosunek, Stały rozmiar
  ratioW: number;                  // np. 16
  ratioH: number;                  // np. 9
  fixedW: number;                  // np. 400 px
  fixedH: number;                  // np. 300 px
  feather: number;                 // Piórkowanie: 0..100 px
  tolerance: number;               // Czułość / Tolerancja dla Różdżki: 0..100%
  wandMode: WandSamplingMode;      // 'contiguous' (Wskazany obszar) | 'global' (Na całym obrazie)
  sampleSource: WandSampleSource;  // 'image' (Obraz) | 'layer' (Warstwa)
  interpolation: InterpolationMode;// Próbkowanie: Najbliższe sąsiedztwo, Dwuliniowe, Dwusześcienne
}

export type GradientType =
  | 'linear'         // Liniowy
  | 'reflected'      // Liniowy lustrzany
  | 'diamond'        // Diamentowy
  | 'radial'         // Kolisty
  | 'conic'          // Stożkowy
  | 'spiral-left'    // Spirala lewa
  | 'spiral-right';  // Spirala prawa

export type GradientRepeatMode = 'none' | 'repeat';

export interface GradientSettings {
  type: GradientType;
  repeat: GradientRepeatMode;
  reverse: boolean;
  blendMode?: SKBlendMode;
}

export type StrokeDashStyle = 'solid' | 'dashed' | 'dotted' | 'dash-dot' | 'long-dash';

export type MarkerType = 'none' | 'arrow' | 'stealth-arrow' | 'circle' | 'square' | 'diamond';

export type ShapeKind =
  | 'rect'
  | 'round-rect'
  | 'ellipse'
  | 'triangle'
  | 'star'
  | 'polygon'
  | 'arrow'
  | 'heart'
  | 'diamond';

export type ShapeFillMode = 'none' | 'primary' | 'stroke-and-fill';

export type StrokeCornerJoin = 'miter' | 'round' | 'bevel';

export type StrokeAlignment = 'center' | 'inside' | 'outside';

export interface VectorShapeSettings {
  shapeKind: ShapeKind;
  fillMode: ShapeFillMode;
  strokeWidth: number;          // 0..200 px
  strokeColor: SKColor;
  fillColor: SKColor;
  strokeCornerJoin: StrokeCornerJoin;
  strokeAlignment: StrokeAlignment;
  antiAliasing: boolean;
  hardness?: number;            // Opcjonalne (usunięte z UI)
  blendMode: SKBlendMode;
  cornerRadius: number;         // px
  starPoints: number;           // np. 5
  starInnerRatio: number;       // np. 0.45 (45%)
  polygonSides: number;         // np. 6
  arrowHeadWidth: number;       // 0.2..1.0
  arrowShaftThickness: number;  // 0.1..0.8
}

export interface LineAndCurveSettings {
  strokeWidth: number;
  strokeColor: SKColor;
  dashStyle: StrokeDashStyle;
  startMarker: MarkerType;
  endMarker: MarkerType;
  markerSize: number;           // 0.5 .. 3.0
  antiAliasing: boolean;
  hardness?: number;            // Opcjonalne (usunięte z UI)
  blendMode: SKBlendMode;
}

export type CorrectionBrushType =
  | 'dodge-burn'          // Rozjaśnij / Ściemnij
  | 'blur-sharpen'        // Rozmyj / Wyostrz
  | 'saturate-desaturate';// Saturuj / Desaturuj

export type CorrectionSubAction =
  | 'dodge'
  | 'burn'
  | 'blur'
  | 'sharpen'
  | 'saturate'
  | 'desaturate';

export interface CorrectionBrushSettings {
  brushType: CorrectionBrushType; // 'dodge-burn' | 'blur-sharpen' | 'saturate-desaturate'
  size: number;                   // 1..2000 px
  hardness: number;               // 0..100%
  antiAliasing: boolean;          // Wygładzanie
  spacing: number;                // 1..500%
  invertAction: boolean;          // Odwróć działanie (zamienia LPM z PPM)
}

export type DeformActionType =
  | 'expand-shrink'   // Zwiększ / Zmniejsz
  | 'smudge'          // Przesuń (Smudge / Warp)
  | 'twirl';          // Obróć (Twirl)

export type DeformSubAction =
  | 'expand'
  | 'shrink'
  | 'smudge'
  | 'smudge-rev'
  | 'twirl-cw'
  | 'twirl-ccw';

export interface DeformSettings {
  actionType: DeformActionType; // 'expand-shrink' | 'smudge' | 'twirl'
  size: number;                 // 1..2000 px
  hardness: number;             // 0..100%
  antiAliasing: boolean;        // Wygładzanie
  spacing: number;              // 1..500%
  invertAction: boolean;        // Odwróć działanie
}

export type ColorReplaceMode = 'single' | 'secondary';

export interface ColorReplaceSettings {
  size: number;          // 1..2000 px
  hardness: number;      // 0..100%
  antiAliasing: boolean; // Wygładzanie
  spacing: number;       // 1..500%
  tolerance: number;     // 0..100%
  mode: ColorReplaceMode;// 'single' = Pojedynczy (próbkowany przy kliknięciu) | 'secondary' = Kolor dodatkowy
}

export type StampSampleSource = 'image' | 'layer';
export type StampSourceMode = 'fixed' | 'selected' | 'relative'; // 'nieruchomy' | 'wybrany' | 'względny'

export interface StampSettings {
  size: number;                    // 1..2000 px
  hardness: number;                // 0..100%
  antiAliasing: boolean;           // Wygładzanie
  spacing: number;                 // 1..500%
  blendMode: SKBlendMode;          // Tryb mieszania
  sampleSource: StampSampleSource; // 'image' | 'layer'
  sourceMode: StampSourceMode;     // 'fixed' | 'selected' | 'relative'
}

export type ToolType =
  | 'brush'
  | 'eraser'
  | 'correction-brush'
  | 'color-replace'
  | 'stamp'
  | 'deform'
  | 'pipette'
  | 'select-rect'
  | 'select-ellipse'
  | 'select-lasso'
  | 'magic-wand'
  | 'transform-selection'
  | 'transform-content'
  | 'bucket'
  | 'gradient'
  | 'shapes'
  | 'line'
  | 'bezier'
  | 'text'
  | 'pan';

export interface FiguraProjectFile {
  format: 'FIGURA_PROJECT';
  version: '1.0';
  title: string;
  width: number;
  height: number;
  tileSize: number;
  activeLayerIndex: number;
  layers: {
    id: string;
    name: string;
    visible: boolean;
    opacity: number;
    blendMode: SKBlendMode;
    dataUrl: string;
  }[];
}
