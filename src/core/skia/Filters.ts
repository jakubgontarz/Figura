/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Filtry nieniszczące (rozmycia, wyostrzenie, szum, pikselizacja, winieta, płaskorzeźba, krawędzie).
 *
 * Filtry są elementami tej samej listy co korekcje (Corrections.ts), ale w odróżnieniu od nich korzystają z SĄSIADÓW piksela,
 * więc nie da się ich stosować na izolowanym kafelku. Moduł dostarcza:
 *  - `compileChain` - łańcuch segmentów: kolejne korekcje punktowe są scalane (LUT), filtry są osobnymi krokami,
 *    dzięki czemu zachowana jest kolejność z listy (np. Poziomy -> Rozmycie -> Negatyw),
 *  - `runChain` - wykonanie łańcucha na buforze RGBA (z kontekstem: skala, położenie w dokumencie, granice dokumentu),
 *  - `chainMargin` - ile pikseli dokumentu wokół fragmentu trzeba znać, żeby wynik na fragmencie był identyczny
 *    z wynikiem na całym dokumencie (silnik renderujący powiększa o ten margines okno / kafelek).
 *
 * Wszystkie rozmiary w parametrach są podane w pikselach DOKUMENTU; `FxContext.scale` przelicza je na piksele bufora.
 */

import {
  PtFn,
  Correction,
  CorrectionType,
  EmbossParams,
  FindEdgesParams,
  GaussianBlurParams,
  MotionBlurParams,
  NoiseParams,
  PixelateParams,
  RadialBlurParams,
  SharpenParams,
  VignetteParams,
  SurfaceBlurParams,
  LensBlurParams,
  ChromaticAberrationParams,
  HalftoneParams,
  FilmGrainParams,
  GlowParams,
  WaveParams,
  TwirlParams,
  SpherizeParams,
  compileCorrections,
  isFilterType,
} from './Corrections.ts';
import { gpuApplyStyles, gpuStylesFit, gpuStylesInSession } from './GpuStyles.ts';
import { gpuPt, gpuReplicate, gpuSessionAbort, gpuSessionFail, gpuSessionBegin, gpuSessionEnd, gpuSessionFailed, gpuSessionActive } from './GpuFx.ts';
import { gpuFx2, gpuGauss, gpuGlow, gpuLens, gpuMotion, gpuRadial, gpuSharpen, gpuSurface, gpuWarp } from './GpuFx.ts';
import { LayerStyles, StyleFx, applyLayerStyles, stylesMargin, stylesSpread } from './Styles.ts';

export interface FxBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface FxContext {
  /** piksele bufora na piksel dokumentu (zoom okna; 1 dla kafelków dokumentu) */
  scale: number;
  /** współrzędne dokumentu lewego górnego rogu bufora */
  docX0: number;
  docY0: number;
  docW: number;
  docH: number;
  /** obszar bufora zajmowany przez dokument; poza nim piksele są zastępowane powtórzeniem krawędzi (brak ciemnych brzegów) */
  bounds?: FxBounds;
}

type Seg = { k: 'pt'; run: PtFn } | { k: 'fx'; c: Correction };

export interface Chain {
  segs: Seg[];
  hasFilters: boolean;
  /** czy któryś filtr przenosi zawartość poza obrys pikseli (rozmycia, pikselizacja) */
  spreads: boolean;
}

/** Górny limit marginesu w pikselach dokumentu (okno z większym marginesem byłoby nieużyteczne). */
export const MAX_FILTER_MARGIN = 900;

const SPREAD_TYPES: ReadonlySet<CorrectionType> = new Set<CorrectionType>([
  'gaussianBlur',
  'motionBlur',
  'radialBlur',
  'pixelate',
  'lensBlur',
  'chromaticAberration',
  'glow',
  'wave',
  'twirl',
  'spherize',
]);

export function compileChain(list: Correction[]): Chain {
  const segs: Seg[] = [];
  let pending: Correction[] = [];
  let hasFilters = false;
  let spreads = false;
  const flush = () => {
    if (pending.length === 0) return;
    segs.push({ k: 'pt', run: compileCorrections(pending) });
    pending = [];
  };
  for (const c of list) {
    if (!c.enabled) continue;
    if (isFilterType(c.type)) {
      flush();
      segs.push({ k: 'fx', c });
      hasFilters = true;
      if (SPREAD_TYPES.has(c.type)) spreads = true;
      if (c.type === 'layerStyles' && stylesSpread(c.params as LayerStyles)) spreads = true;
    } else {
      pending.push(c);
    }
  }
  flush();
  return { segs, hasFilters, spreads };
}

/** Margines (piksele dokumentu) potrzebny jednemu filtrowi. */
export function filterMargin(c: Correction, docW: number, docH: number): number {
  switch (c.type) {
    case 'gaussianBlur':
      return Math.ceil((c.params as GaussianBlurParams).radius * 3) + 2;
    case 'motionBlur': {
      const p = c.params as MotionBlurParams;
      return Math.ceil(p.centered ? p.distance / 2 : p.distance) + 2;
    }
    case 'radialBlur': {
      const p = c.params as RadialBlurParams;
      const cx = (p.centerX / 100) * docW;
      const cy = (p.centerY / 100) * docH;
      const maxR = Math.max(Math.hypot(cx, cy), Math.hypot(docW - cx, cy), Math.hypot(cx, docH - cy), Math.hypot(docW - cx, docH - cy));
      const k = p.mode === 'spin' ? (p.amount * Math.PI) / 360 : p.amount / 200;
      return Math.min(MAX_FILTER_MARGIN, Math.ceil(maxR * k) + 2);
    }
    case 'sharpen':
      return Math.ceil((c.params as SharpenParams).radius * 3) + 2;
    case 'pixelate':
      return Math.ceil((c.params as PixelateParams).size) + 1;
    case 'emboss':
      return Math.ceil((c.params as EmbossParams).height) + 2;
    case 'findEdges':
      return Math.ceil((c.params as FindEdgesParams).thickness) + 2;
    case 'surfaceBlur':
      return Math.ceil((c.params as SurfaceBlurParams).radius) + 2;
    case 'lensBlur':
      return Math.ceil((c.params as LensBlurParams).radius) + 2;
    case 'chromaticAberration': {
      const p = c.params as ChromaticAberrationParams;
      return Math.ceil(p.amount) + 2;
    }
    case 'halftone':
      return Math.ceil((c.params as HalftoneParams).size * 1.5) + 2;
    case 'glow':
      return Math.ceil((c.params as GlowParams).radius * 3) + 2;
    case 'wave':
      return Math.ceil((c.params as WaveParams).amplitude) + 2;
    case 'twirl':
    {
      // największe przemieszczenie punktu źródłowego względem piksela (policzone numerycznie)
      const p = c.params as TwirlParams;
      const A = (p.angle * Math.PI) / 180;
      let mx = 0;
      for (let i = 1; i <= 64; i++) {
        const t = i / 64; // odległość / promień
        const th = A * (1 - t) * (1 - t);
        mx = Math.max(mx, 2 * t * Math.abs(Math.sin(th / 2)));
      }
      return Math.min(MAX_FILTER_MARGIN, Math.ceil(p.radius * mx) + 3);
    }
    case 'spherize':
    {
      const p = c.params as SpherizeParams;
      const amt = p.amount / 100;
      let mx = 0;
      for (let i = 1; i <= 64; i++) {
        const nd = i / 64;
        const src = amt >= 0 ? Math.pow(nd, 1 + amt * 1.2) : Math.pow(nd, 1 / (1 - amt * 1.2));
        mx = Math.max(mx, Math.abs(nd - src));
      }
      return Math.min(MAX_FILTER_MARGIN, Math.ceil(p.radius * mx) + 3);
    }
    case 'layerStyles':
      return Math.min(MAX_FILTER_MARGIN, stylesMargin(c.params as LayerStyles));
    default:
      return 0;
  }
}

/** Suma marginesów wszystkich włączonych filtrów listy (piksele dokumentu). */
export function chainMargin(list: Correction[], docW: number, docH: number): number {
  let m = 0;
  for (const c of list) if (c.enabled && isFilterType(c.type)) m += filterMargin(c, docW, docH);
  return Math.min(MAX_FILTER_MARGIN, m);
}

export function listHasFilters(list: Correction[]): boolean {
  return list.some((c) => c.enabled && isFilterType(c.type));
}

export function runChain(chain: Chain, d: Uint8ClampedArray, w: number, h: number, fx: FxContext): void {
  for (const seg of chain.segs) {
    if (seg.k === 'pt') seg.run(d);
    else applyFilter(seg.c, d, w, h, fx);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------------------------------------------

const clampI = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Piksele poza `b` zastępuje powtórzeniem najbliższego piksela wewnątrz (krawędzie dokumentu nie ciemnieją / nie zanikają). */
function replicateOutside(d: Uint8ClampedArray, w: number, h: number, b: FxBounds): void {
  const x0 = clampI(Math.round(b.x0), 0, w);
  const y0 = clampI(Math.round(b.y0), 0, h);
  const x1 = clampI(Math.round(b.x1), 0, w);
  const y1 = clampI(Math.round(b.y1), 0, h);
  if (x1 <= x0 || y1 <= y0) return;
  if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return;
  const u = new Uint32Array(d.buffer, d.byteOffset, w * h);
  for (let y = 0; y < h; y++) {
    const sy = clampI(y, y0, y1 - 1);
    const row = y * w;
    const srow = sy * w;
    if (y < y0 || y >= y1) {
      for (let x = 0; x < w; x++) u[row + x] = u[srow + clampI(x, x0, x1 - 1)];
    } else {
      const l = u[srow + x0];
      const r = u[srow + x1 - 1];
      for (let x = 0; x < x0; x++) u[row + x] = l;
      for (let x = x1; x < w; x++) u[row + x] = r;
    }
  }
}

/** RGB * alfa jako Float32 (kolejność RGBA, alfa 0..255). */
function toPremul(d: Uint8ClampedArray): Float32Array {
  const n = d.length;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i += 4) {
    const a = d[i + 3];
    const k = a / 255;
    f[i] = d[i] * k;
    f[i + 1] = d[i + 1] * k;
    f[i + 2] = d[i + 2] * k;
    f[i + 3] = a;
  }
  return f;
}

/** Promienie trzech przebiegów pudełkowych przybliżających Gaussa o odchyleniu `sigma`. */
function boxRadii(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const r: number[] = [];
  for (let i = 0; i < n; i++) r.push(((i < m ? wl : wu) - 1) / 2);
  return r;
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let c = 0; c < 4; c++) {
      let sum = src[row + c] * (r + 1);
      for (let k = 1; k <= r; k++) sum += src[row + Math.min(k, w - 1) * 4 + c];
      for (let x = 0; x < w; x++) {
        dst[row + x * 4 + c] = sum * inv;
        sum += src[row + Math.min(x + r + 1, w - 1) * 4 + c] - src[row + Math.max(x - r, 0) * 4 + c];
      }
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const n = w * 4;
  const inv = 1 / (2 * r + 1);
  const sum = new Float32Array(n);
  for (let i = 0; i < n; i++) sum[i] = src[i] * (r + 1);
  for (let k = 1; k <= r; k++) {
    const row = Math.min(k, h - 1) * n;
    for (let i = 0; i < n; i++) sum[i] += src[row + i];
  }
  for (let y = 0; y < h; y++) {
    const o = y * n;
    const add = Math.min(y + r + 1, h - 1) * n;
    const sub = Math.max(y - r, 0) * n;
    for (let i = 0; i < n; i++) {
      dst[o + i] = sum[i] * inv;
      sum[i] += src[add + i] - src[sub + i];
    }
  }
}

/** Rozmycie Gaussa (trzy przebiegi pudełkowe) na danych z kanałami przemnożonymi przez alfę; wynik w `f`. */
function gaussPremul(f: Float32Array, w: number, h: number, sigma: number): void {
  if (sigma < 0.35 || w < 2 || h < 2) return;
  const tmp = new Float32Array(f.length);
  for (const r of boxRadii(sigma)) {
    if (r <= 0) continue;
    boxH(f, tmp, w, h, r);
    boxV(tmp, f, w, h, r);
  }
}

/** Zapis wyniku z danych premultiplied; `keepAlpha` = alfa oryginału zostaje, kolor liczony z rozmytej alfy. */
function writePremul(d: Uint8ClampedArray, f: Float32Array, keepAlpha: boolean): void {
  for (let i = 0; i < d.length; i += 4) {
    const a = f[i + 3];
    if (keepAlpha) {
      if (d[i + 3] === 0) continue;
      if (a > 0.001) {
        const k = 255 / a;
        d[i] = f[i] * k;
        d[i + 1] = f[i + 1] * k;
        d[i + 2] = f[i + 2] * k;
      }
    } else if (a > 0.001) {
      const k = 255 / a;
      d[i] = f[i] * k;
      d[i + 1] = f[i + 1] * k;
      d[i + 2] = f[i + 2] * k;
      d[i + 3] = a;
    } else {
      d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
    }
  }
}

/** Zaokrąglenie próbkowania odporne na przesunięcia bufora (stałe 0.5 + epsilon zamiast Math.round na wartościach „równo w połowie”). */
const rnd = (v: number): number => Math.floor(v + 0.500001);

const lum = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

// ---------------------------------------------------------------------------------------------------------------
// Filtry
// ---------------------------------------------------------------------------------------------------------------

/** Powtórzenie krawędzi dokumentu poza `fx.bounds`: na GPU w sesji, inaczej na danych CPU. */
function rep(d: Uint8ClampedArray, w: number, h: number, fx: FxContext): void {
  if (!fx.bounds) return;
  if (gpuSessionActive()) gpuReplicate(w, h, fx.bounds);
  else replicateOutside(d, w, h, fx.bounds);
}

/** Filtry, które potrafią działać w sesji GPU (dane zostają na karcie między krokami). */
const GPU_SESSION_FILTERS = new Set<CorrectionType>([
  'gaussianBlur',
  'motionBlur',
  'radialBlur',
  'sharpen',
  'surfaceBlur',
  'lensBlur',
  'glow',
  'wave',
  'twirl',
  'spherize',
  'vignette',
  'chromaticAberration',
  'halftone',
  'emboss',
  'findEdges',
]);

const NO_DATA = new Uint8ClampedArray(0);

/**
 * Cały łańcuch na płótnie `cv` w jednej sesji GPU: wgranie raz, wszystkie kroki na karcie, jeden zapis wyniku.
 * Zwraca false (płótno bez zmian), gdy łańcuch ma krok bez wersji GPU albo coś się nie powiodło - wtedy liczy CPU.
 */
export function runChainOnCanvas(chain: Chain, cv: HTMLCanvasElement, fx: FxContext): boolean {
  const w = cv.width;
  const h = cv.height;
  for (const seg of chain.segs) {
    if (seg.k === 'pt') {
      const g = (seg.run as PtFn).gpu;
      if (!g) return false;
    } else if (!GPU_SESSION_FILTERS.has(seg.c.type)) {
      if (seg.c.type !== 'layerStyles' || !gpuStylesFit(seg.c.params as LayerStyles, w, h, fx.scale)) return false;
    }
  }
  if (!gpuSessionBegin(cv)) return false;
  try {
    for (const seg of chain.segs) {
      if (seg.k === 'pt') gpuPt((seg.run as PtFn).gpu!, w, h);
      else applyFilter(seg.c, NO_DATA, w, h, fx);
      if (gpuSessionFailed()) break;
    }
  } catch {
    gpuSessionAbort();
    return false;
  }
  return gpuSessionEnd(cv);
}

/** Czy cały łańcuch da się wykonać w sesji GPU na oknie w x h (korekcje punktowe z wersją GPU, filtry z listy, stylizacje w zasięgu). */
export function chainGpuSupported(chain: Chain, w: number, h: number, scale: number): boolean {
  for (const seg of chain.segs) {
    if (seg.k === 'pt') {
      if (!(seg.run as PtFn).gpu) return false;
    } else if (!GPU_SESSION_FILTERS.has(seg.c.type)) {
      if (seg.c.type !== 'layerStyles' || !gpuStylesFit(seg.c.params as LayerStyles, w, h, scale)) return false;
    }
  }
  return true;
}

/** Wykonuje łańcuch w już otwartej sesji GPU (patrz gpuSessionBeginTex). false = coś się nie powiodło, wynik należy odrzucić. */
export function runChainInSession(chain: Chain, w: number, h: number, fx: FxContext): boolean {
  try {
    for (const seg of chain.segs) {
      if (seg.k === 'pt') gpuPt((seg.run as PtFn).gpu!, w, h);
      else applyFilter(seg.c, NO_DATA, w, h, fx);
      if (gpuSessionFailed()) return false;
    }
  } catch {
    return false;
  }
  return !gpuSessionFailed();
}

function applyFilter(c: Correction, d: Uint8ClampedArray, w: number, h: number, fx: FxContext): void {
  if (w <= 0 || h <= 0) return;
  switch (c.type) {
    case 'gaussianBlur':
      rep(d, w, h, fx);
      return gaussianBlur(d, w, h, c.params as GaussianBlurParams, fx);
    case 'motionBlur':
      rep(d, w, h, fx);
      return motionBlur(d, w, h, c.params as MotionBlurParams, fx);
    case 'radialBlur':
      rep(d, w, h, fx);
      return radialBlur(d, w, h, c.params as RadialBlurParams, fx);
    case 'sharpen':
      rep(d, w, h, fx);
      return sharpen(d, w, h, c.params as SharpenParams, fx);
    case 'noise':
      return noise(d, w, h, c.params as NoiseParams, fx);
    case 'pixelate':
      if (fx.bounds && (c.params as PixelateParams).mode === 'center') replicateOutside(d, w, h, fx.bounds);
      return pixelate(d, w, h, c.params as PixelateParams, fx);
    case 'vignette':
      return vignette(d, w, h, c.params as VignetteParams, fx);
    case 'emboss':
      rep(d, w, h, fx);
      return emboss(d, w, h, c.params as EmbossParams, fx);
    case 'findEdges':
      rep(d, w, h, fx);
      return findEdges(d, w, h, c.params as FindEdgesParams, fx);
    case 'surfaceBlur':
      rep(d, w, h, fx);
      return surfaceBlur(d, w, h, c.params as SurfaceBlurParams, fx);
    case 'lensBlur':
      rep(d, w, h, fx);
      return lensBlur(d, w, h, c.params as LensBlurParams, fx);
    case 'chromaticAberration':
      rep(d, w, h, fx);
      return chromaticAberration(d, w, h, c.params as ChromaticAberrationParams, fx);
    case 'halftone':
      rep(d, w, h, fx);
      return halftone(d, w, h, c.params as HalftoneParams, fx);
    case 'filmGrain':
      return filmGrain(d, w, h, c.params as FilmGrainParams, fx);
    case 'glow':
      rep(d, w, h, fx);
      return glow(d, w, h, c.params as GlowParams, fx);
    case 'wave':
      rep(d, w, h, fx);
      return wave(d, w, h, c.params as WaveParams, fx);
    case 'twirl':
      rep(d, w, h, fx);
      return twirl(d, w, h, c.params as TwirlParams, fx);
    case 'spherize':
      rep(d, w, h, fx);
      return spherize(d, w, h, c.params as SpherizeParams, fx);
    case 'layerStyles':
      rep(d, w, h, fx);
      if (gpuSessionActive()) {
        if (!gpuStylesInSession(c.params as LayerStyles, w, h, fx as StyleFx)) gpuSessionFail();
        return;
      }
      if (gpuApplyStyles(d, w, h, c.params as LayerStyles, fx as StyleFx)) return;
      return applyLayerStyles(d, w, h, c.params as LayerStyles, fx as StyleFx);
    default:
      return;
  }
}

function gaussianBlur(d: Uint8ClampedArray, w: number, h: number, p: GaussianBlurParams, fx: FxContext): void {
  const sigma = p.radius * fx.scale;
  if (sigma < 0.35) return;
  if (w >= 2 && h >= 2 && gpuGauss(d, w, h, boxRadii(sigma), !p.blurAlpha)) return;
  const f = toPremul(d);
  gaussPremul(f, w, h, sigma);
  writePremul(d, f, !p.blurAlpha);
}

function motionBlur(d: Uint8ClampedArray, w: number, h: number, p: MotionBlurParams, fx: FxContext): void {
  const len = p.distance * fx.scale;
  if (len < 1) return;
  const ang = (p.angle * Math.PI) / 180;
  const dx = Math.cos(ang);
  const dy = -Math.sin(ang);
  const n = clampI(Math.ceil(len) + 1, 2, 96);
  const t0 = p.centered ? -len / 2 : 0;
  const stepLen = len / (n - 1);
  // przesunięcia całkowite próbek (dla całkowitych x, y: rnd(x + v) = x + rnd(v)); wnętrze obrazu bez przycinania
  const offX = new Int32Array(n);
  const offY = new Int32Array(n);
  const offJ = new Int32Array(n);
  let mx = 0;
  let my = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k * stepLen;
    offX[k] = rnd(dx * t);
    offY[k] = rnd(dy * t);
    offJ[k] = (offY[k] * w + offX[k]) * 4;
    mx = Math.max(mx, Math.abs(offX[k]));
    my = Math.max(my, Math.abs(offY[k]));
  }
  {
    const pairs = new Int32Array(n * 2);
    for (let k = 0; k < n; k++) {
      pairs[k * 2] = offX[k];
      pairs[k * 2 + 1] = offY[k];
    }
    if (gpuMotion(d, w, h, pairs)) return;
  }
  const f = toPremul(d);
  const out = new Float32Array(f.length);
  const inv = 1 / n;
  for (let y = 0; y < h; y++) {
    const rowIn = y >= my && y < h - my;
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      if (rowIn && x >= mx && x < w - mx) {
        const base = (y * w + x) * 4;
        for (let k = 0; k < n; k++) {
          const j = base + offJ[k];
          r += f[j];
          g += f[j + 1];
          b += f[j + 2];
          a += f[j + 3];
        }
      } else {
        for (let k = 0; k < n; k++) {
          const sx = clampI(x + offX[k], 0, w - 1);
          const sy = clampI(y + offY[k], 0, h - 1);
          const j = (sy * w + sx) * 4;
          r += f[j];
          g += f[j + 1];
          b += f[j + 2];
          a += f[j + 3];
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
      out[o + 3] = a * inv;
    }
  }
  writePremul(d, out, false);
}

function radialBlur(d: Uint8ClampedArray, w: number, h: number, p: RadialBlurParams, fx: FxContext): void {
  const n = p.quality === 'draft' ? 12 : p.quality === 'best' ? 64 : 28;
  // środek w pikselach bufora
  const cx = ((p.centerX / 100) * fx.docW - fx.docX0) * fx.scale;
  const cy = ((p.centerY / 100) * fx.docH - fx.docY0) * fx.scale;
  const spin = p.mode === 'spin';
  const sweep = (p.amount * Math.PI) / 180; // całkowity kąt obrotu
  const zoomA = p.amount / 200; // maksymalne ściągnięcie ku środkowi
  const cs = new Float32Array(n);
  const sn = new Float32Array(n);
  const zk = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1);
    if (spin) {
      const a = (u - 0.5) * sweep;
      cs[k] = Math.cos(a);
      sn[k] = Math.sin(a);
    } else {
      zk[k] = 1 - zoomA * u;
    }
  }
  {
    const k3 = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      k3[k * 3] = cs[k];
      k3[k * 3 + 1] = sn[k];
      k3[k * 3 + 2] = zk[k];
    }
    if (gpuRadial(d, w, h, cx, cy, spin, k3)) return;
  }
  const f = toPremul(d);
  const out = new Float32Array(f.length);
  // położenia próbek zmieniają się liniowo ze współrzędną x, więc są przesuwane przyrostowo wzdłuż wiersza
  const sxk = new Float64Array(n);
  const syk = new Float64Array(n);
  const dsx = new Float64Array(n);
  const dsy = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    dsx[k] = spin ? cs[k] : zk[k];
    dsy[k] = spin ? sn[k] : 0;
  }
  const inv = 1 / n;
  const wm = w - 1;
  const hm = h - 1;
  for (let y = 0; y < h; y++) {
    const ry = y - cy;
    const rx0 = -cx;
    for (let k = 0; k < n; k++) {
      if (spin) {
        sxk[k] = cx + rx0 * cs[k] - ry * sn[k];
        syk[k] = cy + rx0 * sn[k] + ry * cs[k];
      } else {
        sxk[k] = cx + rx0 * zk[k];
        syk[k] = cy + ry * zk[k];
      }
    }
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let k = 0; k < n; k++) {
        let ix = Math.floor(sxk[k] + 0.500001);
        let iy = Math.floor(syk[k] + 0.500001);
        sxk[k] += dsx[k];
        syk[k] += dsy[k];
        ix = ix < 0 ? 0 : ix > wm ? wm : ix;
        iy = iy < 0 ? 0 : iy > hm ? hm : iy;
        const j = (iy * w + ix) * 4;
        r += f[j];
        g += f[j + 1];
        b += f[j + 2];
        a += f[j + 3];
      }
      const o = (y * w + x) * 4;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
      out[o + 3] = a * inv;
    }
  }
  writePremul(d, out, false);
}

function sharpen(d: Uint8ClampedArray, w: number, h: number, p: SharpenParams, fx: FxContext): void {
  const sigma = p.radius * fx.scale;
  if (p.amount <= 0 || sigma < 0.35) return;
  if (w >= 2 && h >= 2 && gpuSharpen(d, w, h, boxRadii(sigma), p.amount / 100, p.threshold, p.luminanceOnly)) return;
  const f = toPremul(d);
  gaussPremul(f, w, h, sigma);
  const k = p.amount / 100;
  const thr = p.threshold;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const fa = f[i + 3];
    if (fa < 0.001) continue;
    const inv = 255 / fa;
    const br = f[i] * inv;
    const bg = f[i + 1] * inv;
    const bb = f[i + 2] * inv;
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    if (p.luminanceOnly) {
      const diff = lum(r, g, b) - lum(br, bg, bb);
      if (Math.abs(diff) < thr) continue;
      const add = diff * k;
      d[i] = r + add;
      d[i + 1] = g + add;
      d[i + 2] = b + add;
    } else {
      const dr = r - br;
      const dg = g - bg;
      const db = b - bb;
      if (Math.abs(dr) >= thr) d[i] = r + dr * k;
      if (Math.abs(dg) >= thr) d[i + 1] = g + dg * k;
      if (Math.abs(db) >= thr) d[i + 2] = b + db * k;
    }
  }
}

/** Deterministyczny skrót 32-bitowy (współrzędne dokumentu + ziarno + numer kanału). */
function hash32(x: number, y: number, seed: number, ch: number): number {
  let h = (Math.imul(x | 0, 0x1f1f1f1f) ^ Math.imul(y | 0, 0x2e2e2e2d) ^ Math.imul(seed | 0, 0x3c6ef372) ^ Math.imul(ch + 1, 0x7f4a7c15)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

const u01 = (h: number): number => h / 4294967296;

function noiseValue(ix: number, iy: number, seed: number, ch: number, gaussian: boolean): number {
  if (!gaussian) return u01(hash32(ix, iy, seed, ch)) * 2 - 1; // -1..1
  // suma czterech równomiernych o wariancji 1 (Irwin-Hall)
  const s =
    u01(hash32(ix, iy, seed, ch)) +
    u01(hash32(ix, iy, seed + 7919, ch)) +
    u01(hash32(ix, iy, seed + 15401, ch)) +
    u01(hash32(ix, iy, seed + 24571, ch));
  return (s - 2) * 1.7320508;
}

function noise(d: Uint8ClampedArray, w: number, h: number, p: NoiseParams, fx: FxContext): void {
  if (p.amount <= 0) return;
  const gaussian = p.distribution === 'gaussian';
  const amp = gaussian ? p.amount * 1.28 : p.amount * 2.55;
  const inv = 1 / fx.scale;
  for (let y = 0; y < h; y++) {
    const iy = Math.floor(fx.docY0 + (y + 0.5) * inv);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const ix = Math.floor(fx.docX0 + (x + 0.5) * inv);
      if (p.monochrome) {
        const n = noiseValue(ix, iy, p.seed, 0, gaussian) * amp;
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n;
      } else {
        d[i] += noiseValue(ix, iy, p.seed, 0, gaussian) * amp;
        d[i + 1] += noiseValue(ix, iy, p.seed, 1, gaussian) * amp;
        d[i + 2] += noiseValue(ix, iy, p.seed, 2, gaussian) * amp;
      }
    }
  }
}

function pixelate(d: Uint8ClampedArray, w: number, h: number, p: PixelateParams, fx: FxContext): void {
  const size = Math.max(1, p.size);
  const s = fx.scale;
  const bx0 = fx.bounds ? Math.max(0, Math.ceil(fx.bounds.x0)) : 0;
  const by0 = fx.bounds ? Math.max(0, Math.ceil(fx.bounds.y0)) : 0;
  const bx1 = fx.bounds ? Math.min(w, Math.floor(fx.bounds.x1)) : w;
  const by1 = fx.bounds ? Math.min(h, Math.floor(fx.bounds.y1)) : h;
  // indeks komórki piksela = floor(współrzędna dokumentu / rozmiar); komórki wyrównane do (0, 0) dokumentu
  const cellOfX = (x: number): number => Math.floor((fx.docX0 + (x + 0.5) / s) / size);
  const cellOfY = (y: number): number => Math.floor((fx.docY0 + (y + 0.5) / s) / size);
  const cx0 = cellOfX(0);
  const cy0 = cellOfY(0);
  const ncx = cellOfX(w - 1) - cx0 + 1;
  const ncy = cellOfY(h - 1) - cy0 + 1;
  const cnt = ncx * ncy;
  if (cnt <= 0 || cnt > 4_000_000) return;
  const xs = new Int32Array(w);
  for (let x = 0; x < w; x++) xs[x] = cellOfX(x) - cx0;
  const ys = new Int32Array(h);
  for (let y = 0; y < h; y++) ys[y] = cellOfY(y) - cy0;
  const out = new Uint8ClampedArray(d.length);
  if (p.mode === 'center') {
    // piksel najbliższy środkowi komórki (we współrzędnych bufora)
    const mx = new Int32Array(ncx);
    const my = new Int32Array(ncy);
    for (let i = 0; i < ncx; i++) mx[i] = clampI(rnd(((cx0 + i + 0.5) * size - fx.docX0) * s - 0.5), 0, w - 1);
    for (let j = 0; j < ncy; j++) my[j] = clampI(rnd(((cy0 + j + 0.5) * size - fx.docY0) * s - 0.5), 0, h - 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const j = (my[ys[y]] * w + mx[xs[x]]) * 4;
        out[o] = d[j];
        out[o + 1] = d[j + 1];
        out[o + 2] = d[j + 2];
        out[o + 3] = d[j + 3];
      }
    }
    d.set(out);
    return;
  }
  const sr = new Float64Array(cnt);
  const sg = new Float64Array(cnt);
  const sb = new Float64Array(cnt);
  const sa = new Float64Array(cnt);
  const nn = new Uint32Array(cnt);
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      const i = (y * w + x) * 4;
      const a = d[i + 3];
      const ci = ys[y] * ncx + xs[x];
      const k = a / 255;
      sr[ci] += d[i] * k;
      sg[ci] += d[i + 1] * k;
      sb[ci] += d[i + 2] * k;
      sa[ci] += a;
      nn[ci]++;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ci = ys[y] * ncx + xs[x];
      const o = (y * w + x) * 4;
      const m = nn[ci];
      if (m === 0) {
        out[o] = d[o];
        out[o + 1] = d[o + 1];
        out[o + 2] = d[o + 2];
        out[o + 3] = d[o + 3];
        continue;
      }
      const a = sa[ci] / m;
      if (a < 0.001) continue;
      const k = 255 / (sa[ci]);
      out[o] = sr[ci] * k;
      out[o + 1] = sg[ci] * k;
      out[o + 2] = sb[ci] * k;
      out[o + 3] = a;
    }
  }
  d.set(out);
}

function vignette(d: Uint8ClampedArray, w: number, h: number, p: VignetteParams, fx: FxContext): void {
  if (p.amount === 0) return;
  const cxD = (p.centerX / 100) * fx.docW;
  const cyD = (p.centerY / 100) * fx.docH;
  const hw = Math.max(1, fx.docW / 2);
  const hh = Math.max(1, fx.docH / 2);
  const R = Math.max(1, Math.hypot(fx.docW, fx.docH) / 2);
  const round = p.roundness / 100;
  const start = p.size / 100;
  const end = start + Math.max(0.02, p.softness / 100);
  const strength = Math.abs(p.amount) / 100;
  const dark = p.amount < 0;
  const inv = 1 / fx.scale;
  if (gpuFx2(d, w, h, 1, [cxD, cyD, hw, hh, R, round, start, end, strength, dark ? 1 : 0, inv, fx.docX0, fx.docY0])) return;
  for (let y = 0; y < h; y++) {
    const dy = fx.docY0 + (y + 0.5) * inv - cyD;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const dx = fx.docX0 + (x + 0.5) * inv - cxD;
      const dEll = Math.hypot(dx / hw, dy / hh) / 1.4142136;
      const dCirc = Math.hypot(dx, dy) / R;
      const dist = dEll + (dCirc - dEll) * round;
      let t = (dist - start) / (end - start);
      if (t <= 0) continue;
      if (t > 1) t = 1;
      t = t * t * (3 - 2 * t) * strength;
      if (dark) {
        const k = 1 - t;
        d[i] *= k;
        d[i + 1] *= k;
        d[i + 2] *= k;
      } else {
        d[i] += (255 - d[i]) * t;
        d[i + 1] += (255 - d[i + 1]) * t;
        d[i + 2] += (255 - d[i + 2]) * t;
      }
    }
  }
}

/** Jasność z uwzględnieniem alfy (krawędź obiektu na przezroczystości też jest „wysokością”). */
function heightMap(d: Uint8ClampedArray, w: number, h: number): Float32Array {
  const m = new Float32Array(w * h);
  for (let i = 0, j = 0; j < m.length; i += 4, j++) m[j] = (lum(d[i], d[i + 1], d[i + 2]) * d[i + 3]) / 255;
  return m;
}

function emboss(d: Uint8ClampedArray, w: number, h: number, p: EmbossParams, fx: FxContext): void {
  const ang = (p.angle * Math.PI) / 180;
  const step = Math.max(1, p.height * fx.scale);
  const ox = Math.cos(ang) * step;
  const oy = -Math.sin(ang) * step;
  const k = p.amount / 100;
  if (gpuFx2(d, w, h, 4, [ox, oy, k, p.keepColor ? 1 : 0])) return;
  const hm = heightMap(d, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const ax = clampI(rnd(x + ox), 0, w - 1);
      const ay = clampI(rnd(y + oy), 0, h - 1);
      const bx = clampI(rnd(x - ox), 0, w - 1);
      const by = clampI(rnd(y - oy), 0, h - 1);
      const diff = (hm[ay * w + ax] - hm[by * w + bx]) * k;
      if (p.keepColor) {
        d[i] += diff;
        d[i + 1] += diff;
        d[i + 2] += diff;
      } else {
        const v = 128 + diff;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
      }
    }
  }
}

function findEdges(d: Uint8ClampedArray, w: number, h: number, p: FindEdgesParams, fx: FxContext): void {
  const st = Math.max(1, Math.round(p.thickness * fx.scale));
  const k = p.strength / 100;
  const dark = p.style === 'dark';
  if (gpuFx2(d, w, h, 5, [st, k, dark ? 1 : 0, p.color ? 1 : 0])) return;
  const planes: Float32Array[] = [];
  if (p.color) {
    for (let c = 0; c < 3; c++) {
      const m = new Float32Array(w * h);
      for (let i = 0, j = 0; j < m.length; i += 4, j++) m[j] = (d[i + c] * d[i + 3]) / 255;
      planes.push(m);
    }
  } else {
    planes.push(heightMap(d, w, h));
  }
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) {
    const yu = clampI(y - st, 0, h - 1) * w;
    const yc = y * w;
    const yd = clampI(y + st, 0, h - 1) * w;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = d[i + 3];
      out[i + 3] = a;
      if (a === 0) continue;
      const xl = clampI(x - st, 0, w - 1);
      const xr = clampI(x + st, 0, w - 1);
      for (let c = 0; c < (p.color ? 3 : 1); c++) {
        const m = planes[c];
        const gx = m[yu + xr] + 2 * m[yc + xr] + m[yd + xr] - m[yu + xl] - 2 * m[yc + xl] - m[yd + xl];
        const gy = m[yd + xl] + 2 * m[yd + x] + m[yd + xr] - m[yu + xl] - 2 * m[yu + x] - m[yu + xr];
        const e = Math.min(255, Math.hypot(gx, gy) * 0.25 * k);
        const v = dark ? 255 - e : e;
        out[i + c] = v;
        if (!p.color) {
          out[i + 1] = v;
          out[i + 2] = v;
        }
      }
    }
  }
  d.set(out);
}

// ---------------------------------------------------------------------------------------------------------------
// Dalsze filtry
// ---------------------------------------------------------------------------------------------------------------

function surfaceBlur(d: Uint8ClampedArray, w: number, h: number, p: SurfaceBlurParams, fx: FxContext): void {
  const R = Math.max(1, Math.round(p.radius * fx.scale));
  const stride = Math.max(1, Math.ceil(R / 4));
  const sig2 = 2 * (R / 2) * (R / 2);
  const thr = Math.max(1, p.threshold);
  const inv = 1 / (thr * thr * 3);
  // tablica próbek: odległości, wagi przestrzenne i przesunięcia w buforze (waga zakresowa z tablicy zamiast exp)
  const dxs: number[] = [];
  const dys: number[] = [];
  const sp: number[] = [];
  for (let dy = -R; dy <= R; dy += stride) {
    for (let dx = -R; dx <= R; dx += stride) {
      dxs.push(dx);
      dys.push(dy);
      sp.push(Math.exp(-(dx * dx + dy * dy) / sig2));
    }
  }
  if (gpuSurface(d, w, h, R, stride, sig2, inv)) return;
  const taps = dxs.length;
  const offJ = new Int32Array(taps);
  for (let t = 0; t < taps; t++) offJ[t] = (dys[t] * w + dxs[t]) * 4;
  const LUT_N = 2048;
  const LUT_MAX = 12;
  const lut = new Float32Array(LUT_N + 1);
  for (let i = 0; i <= LUT_N; i++) lut[i] = Math.exp((-i * LUT_MAX) / LUT_N);
  const kq = LUT_N / LUT_MAX;
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    const rowIn = y >= R && y < h - R;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a0 = src[i + 3];
      if (a0 === 0) continue;
      const r0 = src[i];
      const g0 = src[i + 1];
      const b0 = src[i + 2];
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sw = 0;
      const inner = rowIn && x >= R && x < w - R;
      for (let t = 0; t < taps; t++) {
        let j: number;
        if (inner) j = i + offJ[t];
        else j = (clampI(y + dys[t], 0, h - 1) * w + clampI(x + dxs[t], 0, w - 1)) * 4;
        const aj = src[j + 3];
        if (aj === 0) continue;
        const rj = src[j];
        const gj = src[j + 1];
        const bj = src[j + 2];
        const er = rj - r0;
        const eg = gj - g0;
        const eb = bj - b0;
        const q = (er * er + eg * eg + eb * eb) * inv;
        if (q >= LUT_MAX) continue;
        const wt = sp[t] * lut[(q * kq) | 0] * aj;
        sr += rj * wt;
        sg += gj * wt;
        sb += bj * wt;
        sw += wt;
      }
      if (sw > 0) {
        d[i] = sr / sw;
        d[i + 1] = sg / sw;
        d[i + 2] = sb / sw;
      }
    }
  }
}

function lensBlur(d: Uint8ClampedArray, w: number, h: number, p: LensBlurParams, fx: FxContext): void {
  const R = p.radius * fx.scale;
  if (R < 0.8) return;
  const boost = p.highlights / 100;
  // punkty w kole (spirala Fibonacciego) albo w sześciokącie
  const n = clampI(Math.round(R * 4), 12, 120);
  const pts: number[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  const hexInside = (px: number, py: number): boolean => {
    const ax = Math.abs(px);
    const ay = Math.abs(py);
    return ay <= 0.866 && ax * 0.866 + ay * 0.5 <= 0.866;
  };
  for (let k = 0, made = 0; made < n && k < n * 6; k++) {
    const rr = Math.sqrt((k + 0.5) / (n * (p.shape === 'hexagon' ? 1.7 : 1)));
    const th = k * golden;
    const px = Math.cos(th) * rr;
    const py = Math.sin(th) * rr;
    if (rr > 1) break;
    if (p.shape === 'hexagon' && !hexInside(px, py)) continue;
    pts.push(px * R, py * R);
    made++;
  }
  const m = pts.length / 2;
  if (m === 0) return;
  {
    const pairs = new Int32Array(m * 2);
    for (let k = 0; k < m; k++) {
      pairs[k * 2] = rnd(pts[k * 2]);
      pairs[k * 2 + 1] = rnd(pts[k * 2 + 1]);
    }
    if (gpuLens(d, w, h, pairs, boost)) return;
  }
  const f = toPremul(d);
  // waga punktu rośnie z jasnością: jasne światła tworzą wyraźne krążki
  const wgt = new Float32Array(w * h);
  for (let i = 0, j = 0; j < wgt.length; i += 4, j++) {
    const l = lum(d[i], d[i + 1], d[i + 2]) / 255;
    wgt[j] = 1 + boost * 6 * l * l * l * l;
  }
  const out = new Float32Array(f.length);
  const offX = new Int32Array(m);
  const offY = new Int32Array(m);
  const offJ = new Int32Array(m);
  let mx = 0;
  let my = 0;
  for (let k = 0; k < m; k++) {
    offX[k] = rnd(pts[k * 2]);
    offY[k] = rnd(pts[k * 2 + 1]);
    offJ[k] = offY[k] * w + offX[k];
    mx = Math.max(mx, Math.abs(offX[k]));
    my = Math.max(my, Math.abs(offY[k]));
  }
  for (let y = 0; y < h; y++) {
    const rowIn = y >= my && y < h - my;
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let sw = 0;
      const inner = rowIn && x >= mx && x < w - mx;
      const base = y * w + x;
      for (let k = 0; k < m; k++) {
        const jj = inner ? base + offJ[k] : clampI(y + offY[k], 0, h - 1) * w + clampI(x + offX[k], 0, w - 1);
        const wt = wgt[jj];
        const j = jj * 4;
        r += f[j] * wt;
        g += f[j + 1] * wt;
        b += f[j + 2] * wt;
        a += f[j + 3] * wt;
        sw += wt;
      }
      const o = base * 4;
      out[o] = r / sw;
      out[o + 1] = g / sw;
      out[o + 2] = b / sw;
      out[o + 3] = a / sw;
    }
  }
  writePremul(d, out, false);
}

function chromaticAberration(d: Uint8ClampedArray, w: number, h: number, p: ChromaticAberrationParams, fx: FxContext): void {
  const amt = p.amount * fx.scale;
  if (amt < 0.3) return;
  const ang = (p.angle * Math.PI) / 180;
  const ux = Math.cos(ang);
  const uy = -Math.sin(ang);
  const cx = ((p.centerX / 100) * fx.docW - fx.docX0) * fx.scale;
  const cy = ((p.centerY / 100) * fx.docH - fx.docY0) * fx.scale;
  const maxR = Math.max(1, Math.hypot(Math.max(p.centerX, 100 - p.centerX) / 100 * fx.docW, Math.max(p.centerY, 100 - p.centerY) / 100 * fx.docH) * fx.scale);
  if (gpuFx2(d, w, h, 2, [amt, ux, uy, cx, cy, maxR, p.mode === 'radial' ? 1 : 0])) return;
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ox: number;
      let oy: number;
      if (p.mode === 'radial') {
        const rx = x - cx;
        const ry = y - cy;
        const k = amt / maxR;
        ox = rx * k;
        oy = ry * k;
      } else {
        ox = ux * amt;
        oy = uy * amt;
      }
      const i = (y * w + x) * 4;
      const jr = (clampI(rnd(y + oy), 0, h - 1) * w + clampI(rnd(x + ox), 0, w - 1)) * 4;
      const jb = (clampI(rnd(y - oy), 0, h - 1) * w + clampI(rnd(x - ox), 0, w - 1)) * 4;
      const ar = src[jr + 3];
      const ag = src[i + 3];
      const ab = src[jb + 3];
      const a = Math.max(ar, ag, ab);
      if (a === 0) continue;
      // kanały jako wartości premultiplied, wynik z alfą maksymalną z trzech próbek
      const r = (src[jr] * ar) / 255;
      const g = (src[i + 1] * ag) / 255;
      const b = (src[jb + 2] * ab) / 255;
      const k = 255 / a;
      d[i] = r * k;
      d[i + 1] = g * k;
      d[i + 2] = b * k;
      d[i + 3] = a;
    }
  }
}

function halftone(d: Uint8ClampedArray, w: number, h: number, p: HalftoneParams, fx: FxContext): void {
  const size = Math.max(2, p.size);
  const s = fx.scale;
  const ang = (p.angle * Math.PI) / 180;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const inv = 1 / s;
  const half = Math.max(1, Math.round(size * s * 0.25));
  const aa = 0.8; // szerokość krawędzi punktu w pikselach dokumentu
  if (gpuFx2(d, w, h, 3, [size, s, ca, sa, fx.docX0, fx.docY0, half, aa, p.invert ? 1 : 0, p.mode === 'color' ? 1 : 0])) return;
  const src = new Uint8ClampedArray(d);
  for (let y = 0; y < h; y++) {
    const gy = fx.docY0 + (y + 0.5) * inv;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a0 = src[i + 3];
      if (a0 === 0) continue;
      const gx = fx.docX0 + (x + 0.5) * inv;
      // współrzędne w obróconej siatce, środek komórki i jego położenie w dokumencie
      const u = gx * ca + gy * sa;
      const v = -gx * sa + gy * ca;
      const cu = (Math.floor(u / size) + 0.5) * size;
      const cv = (Math.floor(v / size) + 0.5) * size;
      const cxd = cu * ca - cv * sa;
      const cyd = cu * sa + cv * ca;
      // próbka koloru w środku komórki (uśredniona z małego otoczenia)
      const bx = rnd((cxd - fx.docX0) * s - 0.5);
      const by = rnd((cyd - fx.docY0) * s - 0.5);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let yy = -half; yy <= half; yy += Math.max(1, half)) {
        for (let xx = -half; xx <= half; xx += Math.max(1, half)) {
          const j = (clampI(by + yy, 0, h - 1) * w + clampI(bx + xx, 0, w - 1)) * 4;
          sr += src[j];
          sg += src[j + 1];
          sb += src[j + 2];
          n++;
        }
      }
      sr /= n;
      sg /= n;
      sb /= n;
      let dark = 1 - lum(sr, sg, sb) / 255;
      if (p.invert) dark = 1 - dark;
      const rad = size * 0.5 * 1.2 * Math.sqrt(dark);
      const dist = Math.hypot(u - cu, v - cv);
      const cov = clampI(((rad - dist) / aa) + 0.5, 0, 1);
      const bg = p.invert ? 0 : 255;
      const fr = p.mode === 'color' ? sr : p.invert ? 255 : 0;
      const fg = p.mode === 'color' ? sg : p.invert ? 255 : 0;
      const fb = p.mode === 'color' ? sb : p.invert ? 255 : 0;
      d[i] = bg + (fr - bg) * cov;
      d[i + 1] = bg + (fg - bg) * cov;
      d[i + 2] = bg + (fb - bg) * cov;
    }
  }
}

function filmGrain(d: Uint8ClampedArray, w: number, h: number, p: FilmGrainParams, fx: FxContext): void {
  if (p.amount <= 0) return;
  const size = Math.max(0.25, p.size);
  const amp = p.amount * 1.1;
  const inv = 1 / fx.scale;
  for (let y = 0; y < h; y++) {
    const iy = Math.floor((fx.docY0 + (y + 0.5) * inv) / size);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] === 0) continue;
      const ix = Math.floor((fx.docX0 + (x + 0.5) * inv) / size);
      let k = 1;
      if (p.tonal) {
        const l = lum(d[i], d[i + 1], d[i + 2]) / 255;
        k = 4 * l * (1 - l) * 0.85 + 0.15;
      }
      if (p.monochrome) {
        const n = noiseValue(ix, iy, p.seed, 0, true) * amp * k;
        d[i] += n;
        d[i + 1] += n;
        d[i + 2] += n;
      } else {
        d[i] += noiseValue(ix, iy, p.seed, 0, true) * amp * k;
        d[i + 1] += noiseValue(ix, iy, p.seed, 1, true) * amp * k;
        d[i + 2] += noiseValue(ix, iy, p.seed, 2, true) * amp * k;
      }
    }
  }
}

function glow(d: Uint8ClampedArray, w: number, h: number, p: GlowParams, fx: FxContext): void {
  const sigma = p.radius * fx.scale;
  if (p.intensity <= 0 || sigma < 0.35) return;
  if (w >= 2 && h >= 2 && gpuGlow(d, w, h, boxRadii(sigma), p.intensity / 100, p.threshold)) return;
  const f = new Float32Array(d.length);
  const thr = p.threshold;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const l = lum(d[i], d[i + 1], d[i + 2]);
    if (l <= thr) continue;
    const k = ((l - thr) / Math.max(1, 255 - thr)) * (a / 255);
    f[i] = d[i] * k;
    f[i + 1] = d[i + 1] * k;
    f[i + 2] = d[i + 2] * k;
    f[i + 3] = a * (l - thr) / Math.max(1, 255 - thr);
  }
  gaussPremul(f, w, h, sigma);
  const k = p.intensity / 100;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    const pr = (d[i] * a) / 255;
    const pg = (d[i + 1] * a) / 255;
    const pb = (d[i + 2] * a) / 255;
    const na = Math.min(255, a + f[i + 3] * k);
    if (na <= 0) continue;
    const kk = 255 / na;
    d[i] = Math.min(255, pr + f[i] * k) * kk;
    d[i + 1] = Math.min(255, pg + f[i + 1] * k) * kk;
    d[i + 2] = Math.min(255, pb + f[i + 2] * k) * kk;
    d[i + 3] = na;
  }
}

/** Próbkowanie dwuliniowe danych premultiplied w (x, y) (współrzędne środków pikseli = indeksy); wynik w `out`. */
function bilinear(f: Float32Array, w: number, h: number, x: number, y: number, out: Float32Array): void {
  const fx0 = Math.floor(x);
  const fy0 = Math.floor(y);
  const tx = x - fx0;
  const ty = y - fy0;
  const x0 = clampI(fx0, 0, w - 1);
  const x1 = clampI(fx0 + 1, 0, w - 1);
  const y0 = clampI(fy0, 0, h - 1);
  const y1 = clampI(fy0 + 1, 0, h - 1);
  const a = (y0 * w + x0) * 4;
  const b = (y0 * w + x1) * 4;
  const c = (y1 * w + x0) * 4;
  const e = (y1 * w + x1) * 4;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  for (let k = 0; k < 4; k++) out[k] = f[a + k] * w00 + f[b + k] * w10 + f[c + k] * w01 + f[e + k] * w11;
}

/** Wspólna pętla zniekształceń: `map` zwraca punkt źródłowy (w pikselach bufora) dla piksela (x, y). */
function warp(d: Uint8ClampedArray, w: number, h: number, map: (x: number, y: number, o: Float64Array) => void): void {
  const f = toPremul(d);
  const out = new Float32Array(f.length);
  const tmp = new Float32Array(4);
  const pos = new Float64Array(2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      map(x, y, pos);
      const o = (y * w + x) * 4;
      if (pos[0] === x && pos[1] === y) {
        out[o] = f[o];
        out[o + 1] = f[o + 1];
        out[o + 2] = f[o + 2];
        out[o + 3] = f[o + 3];
        continue;
      }
      bilinear(f, w, h, pos[0], pos[1], tmp);
      out[o] = tmp[0];
      out[o + 1] = tmp[1];
      out[o + 2] = tmp[2];
      out[o + 3] = tmp[3];
    }
  }
  writePremul(d, out, false);
}

function wave(d: Uint8ClampedArray, w: number, h: number, p: WaveParams, fx: FxContext): void {
  const A = p.amplitude * fx.scale;
  const k = (2 * Math.PI) / Math.max(1, p.wavelength * fx.scale);
  const ph = (p.phase * Math.PI) / 180;
  const horiz = p.direction !== 'vertical';
  const vert = p.direction !== 'horizontal';
  // fala zależy od współrzędnej dokumentu, nie okna: ta sama faza na każdym kafelku
  const ox = fx.docX0 * fx.scale;
  const oy = fx.docY0 * fx.scale;
  if (gpuWarp(d, w, h, { mode: 0, A, k, ph, ox, oy, horiz, vert })) return;
  warp(d, w, h, (x, y, o) => {
    o[0] = x + (horiz ? A * Math.sin(k * (y + oy) + ph) : 0);
    o[1] = y + (vert ? A * Math.sin(k * (x + ox) + ph) : 0);
  });
}

/** Czy prostokąt bufora leży całkowicie poza kołem o środku (cx, cy) i promieniu R (zniekształcenie nic tu nie zmienia). */
function rectFarFrom(cx: number, cy: number, R: number, w: number, h: number): boolean {
  const nx = clampI(cx, 0, w);
  const ny = clampI(cy, 0, h);
  return Math.hypot(cx - nx, cy - ny) >= R;
}

function twirl(d: Uint8ClampedArray, w: number, h: number, p: TwirlParams, fx: FxContext): void {
  const s = fx.scale;
  const cx = ((p.centerX / 100) * fx.docW - fx.docX0) * s;
  const cy = ((p.centerY / 100) * fx.docH - fx.docY0) * s;
  const R = Math.max(1, p.radius * s);
  const A = (p.angle * Math.PI) / 180;
  if (rectFarFrom(cx, cy, R, w, h)) return;
  if (gpuWarp(d, w, h, { mode: 1, cx, cy, R, A })) return;
  warp(d, w, h, (x, y, o) => {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist >= R) {
      o[0] = x;
      o[1] = y;
      return;
    }
    const t = 1 - dist / R;
    const th = A * t * t;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    o[0] = cx + dx * c - dy * sn;
    o[1] = cy + dx * sn + dy * c;
  });
}

function spherize(d: Uint8ClampedArray, w: number, h: number, p: SpherizeParams, fx: FxContext): void {
  const s = fx.scale;
  const cx = ((p.centerX / 100) * fx.docW - fx.docX0) * s;
  const cy = ((p.centerY / 100) * fx.docH - fx.docY0) * s;
  const R = Math.max(1, p.radius * s);
  const amt = p.amount / 100;
  if (rectFarFrom(cx, cy, R, w, h)) return;
  if (gpuWarp(d, w, h, { mode: 2, cx, cy, R, A: amt })) return;
  warp(d, w, h, (x, y, o) => {
    const dx = x - cx;
    const dy = y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist >= R || dist === 0) {
      o[0] = x;
      o[1] = y;
      return;
    }
    const nd = dist / R;
    // wypukłość: punkt źródłowy bliżej środka (powiększenie), wklęsłość: dalej od środka
    const src = amt >= 0 ? Math.pow(nd, 1 + amt * 1.2) : Math.pow(nd, 1 / (1 - amt * 1.2));
    const k = (src * R) / dist;
    o[0] = cx + dx * k;
    o[1] = cy + dy * k;
  });
}
