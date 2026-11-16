/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Przekształcenia całego dokumentu (menu „Obraz”): skalowanie, zmiana rozmiaru płótna / kadrowanie, odbicia i obroty o 90°.
 * Moduł opisuje geometrię takiej operacji (`DocGeom`) i przelicza przez nią dane, które nie są pikselami:
 * współrzędne i rozmiary obiektów wektorowych (także grubości obrysów i wielkość pisma), parametry korekcji i filtrów
 * (długości w pikselach, środki efektów, kierunki) oraz stylizacji warstw (odległości, rozmiary, kąty światła).
 *
 * Zasada: skaluje się wszystko, co jest WYMIAREM w pikselach (promień rozmycia, grubość obrysu, odległość cienia),
 * a nie to, co jest proporcją lub natężeniem (krycie, %, jasność, liczba punktów gwiazdy, ziarno szumu).
 * Środki efektów są zapisane w % wymiarów dokumentu, więc przy samym skalowaniu nie wymagają zmiany; zmieniają się przy
 * zmianie płótna, odbiciach i obrotach.
 */

import { Correction, CorrectionType, cloneCorrections } from './Corrections.ts';
import { LayerStyles, cloneStyles } from './Styles.ts';
import { SKPoint } from './types.ts';
import { LayerTransformOp, VectorObject, VecShape, VecSmart, VecText, cloneVectorObject, invalidateVectorObject, transformVectorObject, translateVectorObject } from './VectorObjects.ts';
import type { ResampleMethod } from './Resample.ts';

export type DocOpKind = 'scale' | 'canvas' | 'ortho';

export interface DocGeom {
  kind: DocOpKind;
  oldW: number;
  oldH: number;
  newW: number;
  newH: number;
  /** skala poziomo / pionowo (kind = scale; w pozostałych przypadkach 1) */
  sx: number;
  sy: number;
  /** przesunięcie starego początku układu w nowym (kind = canvas: nowe = stare + (dx, dy)) */
  dx: number;
  dy: number;
  /** odbicie / obrót (kind = ortho) */
  op: LayerTransformOp | null;
  /** metoda próbkowania pikseli (kind = scale) */
  method: ResampleMethod;
}

export function scaleGeom(oldW: number, oldH: number, newW: number, newH: number, method: ResampleMethod): DocGeom {
  return { kind: 'scale', oldW, oldH, newW, newH, sx: newW / oldW, sy: newH / oldH, dx: 0, dy: 0, op: null, method };
}

export function canvasGeom(oldW: number, oldH: number, newW: number, newH: number, dx: number, dy: number): DocGeom {
  return { kind: 'canvas', oldW, oldH, newW, newH, sx: 1, sy: 1, dx, dy, op: null, method: 'nearest' };
}

export function orthoGeom(oldW: number, oldH: number, op: LayerTransformOp): DocGeom {
  const swap = op === 'cw' || op === 'ccw';
  return { kind: 'ortho', oldW, oldH, newW: swap ? oldH : oldW, newH: swap ? oldW : oldH, sx: 1, sy: 1, dx: 0, dy: 0, op, method: 'nearest' };
}

/** Przelicza punkt (w miejscu) ze starego układu współrzędnych dokumentu na nowy. */
export function mapDocPoint(g: DocGeom, p: SKPoint): void {
  const x = p.x;
  const y = p.y;
  if (g.kind === 'scale') {
    p.x = x * g.sx;
    p.y = y * g.sy;
  } else if (g.kind === 'canvas') {
    p.x = x + g.dx;
    p.y = y + g.dy;
  } else {
    switch (g.op) {
      case 'flipH': p.x = g.oldW - x; break;
      case 'flipV': p.y = g.oldH - y; break;
      case 'cw': p.x = g.oldH - y; p.y = x; break;
      case 'ccw': p.x = y; p.y = g.oldW - x; break;
      case 'r180': p.x = g.oldW - x; p.y = g.oldH - y; break;
      default: break;
    }
  }
}

/** Współczynnik długości (grubości, promienie, rozmiary): średnia geometryczna skal przy skalowaniu nierównomiernym. */
export function lengthScale(g: DocGeom): number {
  return g.kind === 'scale' ? Math.sqrt(g.sx * g.sy) : 1;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Kierunek zapisany jako kąt matematyczny w stopniach (0° = w prawo, rośnie przeciwnie do ruchu wskazówek zegara na ekranie). */
export function mapAngleDeg(g: DocGeom, a: number): number {
  if (g.kind === 'canvas') return a;
  if (g.kind === 'scale') {
    if (g.sx === g.sy) return a;
    const r = (a * Math.PI) / 180;
    return (Math.atan2(g.sy * Math.sin(r), g.sx * Math.cos(r)) * 180) / Math.PI;
  }
  switch (g.op) {
    case 'flipH': return 180 - a;
    case 'flipV': return -a;
    case 'cw': return a - 90;
    case 'ccw': return a + 90;
    case 'r180': return a + 180;
    default: return a;
  }
}

/** Zawija kąt do (-180, 180] (`signed`) albo [0, 360). */
function wrapDeg(a: number, signed: boolean): number {
  let v = ((a % 360) + 360) % 360;
  if (signed && v > 180) v -= 360;
  return Math.round(v * 100) / 100;
}

/** Środek efektu w % wymiarów dokumentu po przekształceniu. */
export function mapCentrePct(g: DocGeom, cx: number, cy: number): { x: number; y: number } {
  const p = { x: (cx / 100) * g.oldW, y: (cy / 100) * g.oldH };
  mapDocPoint(g, p);
  return { x: Math.round((p.x / g.newW) * 10000) / 100, y: Math.round((p.y / g.newH) * 10000) / 100 };
}

// ---------------------------------------------------------------------------------------------------------------
// Obiekty wektorowe
// ---------------------------------------------------------------------------------------------------------------

/** Kopia obiektu przeliczona przez przekształcenie dokumentu (oryginał zostaje nietknięty, bo należy do historii). */
export function remapVectorObject(o: VectorObject, g: DocGeom): VectorObject {
  const c = cloneVectorObject(o);
  if (g.kind === 'ortho') {
    transformVectorObject(c, g.op!, (p) => mapDocPoint(g, p));
    return c;
  }
  if (g.kind === 'canvas') {
    translateVectorObject(c, g.dx, g.dy);
    return c;
  }
  const { sx, sy } = g;
  const s = Math.sqrt(sx * sy);
  const sp = (p: SKPoint | null | undefined) => {
    if (p) {
      p.x *= sx;
      p.y *= sy;
    }
  };
  // rozmiar ramki obróconej o kąt a po rozciągnięciu osi: długość obrazu jej osi lokalnych
  const box = (o2: VecShape | VecSmart | VecText) => {
    const cs = Math.cos(o2.angle);
    const sn = Math.sin(o2.angle);
    o2.width *= Math.hypot(sx * cs, sy * sn);
    o2.height *= Math.hypot(sx * sn, sy * cs);
  };
  switch (c.kind) {
    case 'line':
      sp(c.p0);
      sp(c.p1);
      c.settings.strokeWidth *= s;
      break;
    case 'path':
      for (const n of c.nodes) {
        sp(n);
        sp(n.hin);
        sp(n.hout);
      }
      c.settings.strokeWidth *= s;
      break;
    case 'shape':
      sp(c.center);
      box(c);
      c.settings.strokeWidth *= s;
      c.settings.cornerRadius *= s;
      break;
    case 'smart':
      sp(c.center);
      box(c);
      break;
    case 'text':
      sp(c.center);
      box(c);
      c.settings.fontSize *= s;
      c.settings.letterSpacing *= s;
      c.settings.strokeWidth *= s;
      if (c.settings.padding) c.settings.padding *= s;
      c.fallback.fontSize *= s;
      for (const r of c.runs) r.style.fontSize *= s;
      break;
  }
  // kąt ramki przy nierównomiernym rozciągnięciu: obraz osi lokalnej X
  if (sx !== sy && (c.kind === 'shape' || c.kind === 'smart' || c.kind === 'text') && Math.abs(Math.sin(c.angle * 2)) > 1e-6) {
    c.angle = Math.atan2(sy * Math.sin(c.angle), sx * Math.cos(c.angle));
  }
  invalidateVectorObject(c);
  return c;
}

// ---------------------------------------------------------------------------------------------------------------
// Korekcje i filtry
// ---------------------------------------------------------------------------------------------------------------

/** Parametry będące długościami w pikselach: [pole, min, max] zgodnie z zakresami okien filtrów. */
const LENGTH_PARAMS: Partial<Record<CorrectionType, [string, number, number][]>> = {
  gaussianBlur: [['radius', 0.1, 100]],
  motionBlur: [['distance', 1, 300]],
  sharpen: [['radius', 0.1, 50]],
  pixelate: [['size', 2, 200]],
  emboss: [['height', 1, 20]],
  findEdges: [['thickness', 1, 5]],
  surfaceBlur: [['radius', 1, 20]],
  lensBlur: [['radius', 1, 60]],
  chromaticAberration: [['amount', 0, 50]],
  halftone: [['size', 3, 60]],
  filmGrain: [['size', 0.5, 6]],
  glow: [['radius', 1, 100]],
  wave: [['amplitude', 1, 100], ['wavelength', 5, 400]],
  twirl: [['radius', 10, 1500]],
  spherize: [['radius', 10, 1500]],
};

/** Parametry zapisane jako kierunek (stopnie): [pole, czy zakres ze znakiem, okres symetrii w stopniach]. */
const ANGLE_PARAMS: Partial<Record<CorrectionType, [string, boolean, number][]>> = {
  motionBlur: [['angle', true, 360]],
  emboss: [['angle', false, 360]],
  chromaticAberration: [['angle', false, 360]],
  halftone: [['angle', false, 90]],
};

const CENTRE_TYPES: ReadonlySet<CorrectionType> = new Set<CorrectionType>(['radialBlur', 'vignette', 'chromaticAberration', 'twirl', 'spherize']);

type AnyParams = Record<string, unknown>;

function remapCorrectionInPlace(c: Correction, g: DocGeom): void {
  if (c.type === 'layerStyles') {
    c.params = remapStyles(c.params as LayerStyles, g) as never;
    return;
  }
  const p = c.params as unknown as AnyParams;
  const s = lengthScale(g);
  if (s !== 1) {
    for (const [k, lo, hi] of LENGTH_PARAMS[c.type] ?? []) {
      const v = p[k];
      if (typeof v === 'number') p[k] = Math.round(clamp(v * s, lo, hi) * 100) / 100;
    }
  }
  if (g.kind !== 'canvas') {
    for (const [k, signed, period] of ANGLE_PARAMS[c.type] ?? []) {
      const v = p[k];
      if (typeof v !== 'number') continue;
      let a = mapAngleDeg(g, v);
      if (period < 360) a = ((a % period) + period) % period;
      p[k] = period < 360 ? Math.round(a * 100) / 100 : wrapDeg(a, signed);
    }
    if (c.type === 'wave' && g.kind === 'ortho' && (g.op === 'cw' || g.op === 'ccw')) {
      if (p.direction === 'horizontal') p.direction = 'vertical';
      else if (p.direction === 'vertical') p.direction = 'horizontal';
    }
  }
  if (CENTRE_TYPES.has(c.type) && g.kind !== 'scale' && typeof p.centerX === 'number' && typeof p.centerY === 'number') {
    const m = mapCentrePct(g, p.centerX as number, p.centerY as number);
    p.centerX = m.x;
    p.centerY = m.y;
  }
}

/** Kopia listy korekcji i filtrów przeliczona przez przekształcenie dokumentu. */
export function remapCorrections(list: Correction[], g: DocGeom): Correction[] {
  const out = cloneCorrections(list);
  for (const c of out) remapCorrectionInPlace(c, g);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Stylizacje warstw
// ---------------------------------------------------------------------------------------------------------------

/** Kopia stylizacji przeliczona przez przekształcenie dokumentu: odległości, rozmiary, grubości i kąty światła. */
export function remapStyles(st: LayerStyles, g: DocGeom): LayerStyles {
  const out = cloneStyles(st);
  const s = lengthScale(g);
  const len = (v: number, lo: number, hi: number) => (s === 1 ? v : Math.round(clamp(v * s, lo, hi) * 100) / 100);
  const ang = (v: number) => (g.kind === 'canvas' ? v : wrapDeg(mapAngleDeg(g, v), true));
  out.globalAngle = ang(out.globalAngle);
  out.dropShadow.angle = ang(out.dropShadow.angle);
  out.dropShadow.distance = len(out.dropShadow.distance, 0, 150);
  out.dropShadow.size = len(out.dropShadow.size, 0, 150);
  out.outerGlow.size = len(out.outerGlow.size, 0, 150);
  out.stroke.width = len(out.stroke.width, 1, 100);
  out.innerShadow.angle = ang(out.innerShadow.angle);
  out.innerShadow.distance = len(out.innerShadow.distance, 0, 150);
  out.innerShadow.size = len(out.innerShadow.size, 0, 150);
  out.innerGlow.size = len(out.innerGlow.size, 0, 150);
  out.bevel.angle = ang(out.bevel.angle);
  out.bevel.size = len(out.bevel.size, 1, 80);
  out.bevel.soften = len(out.bevel.soften, 0, 16);
  out.satin.angle = ang(out.satin.angle);
  out.satin.distance = len(out.satin.distance, 0, 100);
  out.satin.size = len(out.satin.size, 0, 100);
  out.gradientOverlay.angle = ang(out.gradientOverlay.angle);
  return out;
}
