/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stylizacje warstw (nieniszczące): cień na zewnątrz, obrys, poświata na zewnątrz, cień wewnątrz, poświata wewnątrz,
 * wytłoczenie i fasetowanie, satyna, nakładka koloru i nakładka gradientu.
 *
 * Wszystkie stylizacje warstwy są jednym krokiem łańcucha filtrów (Filters.ts, typ `layerStyles`), który wykonuje się po
 * korekcjach i filtrach warstwy. Krok działa na buforze RGBA (kafelek z marginesem, okno widoku albo cały dokument) i
 * korzysta z kształtu warstwy (kanał alfa) oraz jego odległości od krawędzi. Rozmiary w parametrach są w pikselach
 * DOKUMENTU, `FxContext.scale` przelicza je na piksele bufora.
 *
 * Kolejność rysowania (od dołu): cień, poświata zewnętrzna, obrys zewnętrzny, ZAWARTOŚĆ, satyna, nakładka koloru,
 * nakładka gradientu, poświata wewnętrzna, cień wewnętrzny, wytłoczenie, obrys wewnętrzny.
 */

import type { FxContext } from './Filters.ts';

export type StyleBlend =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'darken'
  | 'lighten'
  | 'colorDodge'
  | 'colorBurn'
  | 'difference'
  | 'exclusion';

export const STYLE_BLEND_OPTIONS: { value: StyleBlend; label: string }[] = [
  { value: 'normal', label: 'Normalny' },
  { value: 'multiply', label: 'Mnożenie' },
  { value: 'screen', label: 'Ekran' },
  { value: 'overlay', label: 'Nakładka' },
  { value: 'softLight', label: 'Łagodne światło' },
  { value: 'hardLight', label: 'Ostre światło' },
  { value: 'darken', label: 'Ciemniejszy' },
  { value: 'lighten', label: 'Jaśniejszy' },
  { value: 'colorDodge', label: 'Rozjaśnianie koloru' },
  { value: 'colorBurn', label: 'Ściemnianie koloru' },
  { value: 'difference', label: 'Różnica' },
  { value: 'exclusion', label: 'Wykluczenie' },
];

export type StyleKind =
  | 'dropShadow'
  | 'outerGlow'
  | 'stroke'
  | 'innerShadow'
  | 'innerGlow'
  | 'bevel'
  | 'satin'
  | 'colorOverlay'
  | 'gradientOverlay';

/** Kolejność i nazwy na liście okna. */
export const STYLE_LIST: { kind: StyleKind; name: string }[] = [
  { kind: 'dropShadow', name: 'Cień na zewnątrz' },
  { kind: 'stroke', name: 'Obrys' },
  { kind: 'outerGlow', name: 'Poświata zewnątrz' },
  { kind: 'innerShadow', name: 'Cień wewnątrz' },
  { kind: 'innerGlow', name: 'Poświata wewnątrz' },
  { kind: 'bevel', name: 'Wytłoczenie i fasetowanie' },
  { kind: 'satin', name: 'Satyna' },
  { kind: 'colorOverlay', name: 'Nakładka koloru' },
  { kind: 'gradientOverlay', name: 'Nakładka gradientu' },
];

export interface StyleBase {
  /** Zaznaczona na liście (stylizacja wchodzi do wyglądu i do wypalania). */
  enabled: boolean;
  /** Oko przy stylizacji: chwilowe ukrycie bez utraty ustawień. */
  visible: boolean;
}

export interface DropShadowStyle extends StyleBase {
  color: string;
  opacity: number;
  useGlobalLight: boolean;
  angle: number;
  distance: number;
  spread: number;
  size: number;
}

export interface OuterGlowStyle extends StyleBase {
  color: string;
  opacity: number;
  spread: number;
  size: number;
}

export type StrokePosition = 'outside' | 'center' | 'inside';
export interface StrokeStyle extends StyleBase {
  color: string;
  opacity: number;
  width: number;
  position: StrokePosition;
  blend: StyleBlend;
}

export interface InnerShadowStyle extends StyleBase {
  blend: StyleBlend;
  color: string;
  opacity: number;
  useGlobalLight: boolean;
  angle: number;
  distance: number;
  choke: number;
  size: number;
}

export interface InnerGlowStyle extends StyleBase {
  blend: StyleBlend;
  color: string;
  opacity: number;
  source: 'edge' | 'center';
  choke: number;
  size: number;
}

export type BevelKind = 'inner' | 'outer' | 'emboss' | 'pillow';
export interface BevelStyle extends StyleBase {
  kind: BevelKind;
  direction: 'up' | 'down';
  size: number;
  soften: number;
  depth: number;
  useGlobalLight: boolean;
  angle: number;
  altitude: number;
  highlightColor: string;
  highlightBlend: StyleBlend;
  highlightOpacity: number;
  shadowColor: string;
  shadowBlend: StyleBlend;
  shadowOpacity: number;
}

export interface SatinStyle extends StyleBase {
  blend: StyleBlend;
  color: string;
  opacity: number;
  angle: number;
  distance: number;
  size: number;
  invert: boolean;
}

export interface ColorOverlayStyle extends StyleBase {
  blend: StyleBlend;
  color: string;
  opacity: number;
}

export interface GradStop {
  /** położenie 0..100 */
  pos: number;
  color: string;
  /** krycie 0..100 */
  alpha: number;
}

export type GradientShape = 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
export interface GradientOverlayStyle extends StyleBase {
  blend: StyleBlend;
  opacity: number;
  stops: GradStop[];
  shape: GradientShape;
  angle: number;
  scale: number;
  reverse: boolean;
  align: 'layer' | 'document';
}

export interface LayerStyles {
  /** Wspólne oko na pasku warstwy: ukrywa wszystkie stylizacje warstwy. */
  visible: boolean;
  /** Wspólne światło (stylizacje z zaznaczonym „światło globalne”). */
  globalAngle: number;
  globalAltitude: number;
  dropShadow: DropShadowStyle;
  stroke: StrokeStyle;
  outerGlow: OuterGlowStyle;
  innerShadow: InnerShadowStyle;
  innerGlow: InnerGlowStyle;
  bevel: BevelStyle;
  satin: SatinStyle;
  colorOverlay: ColorOverlayStyle;
  gradientOverlay: GradientOverlayStyle;
}

export function defaultStyles(): LayerStyles {
  const b = { enabled: false, visible: true };
  return {
    visible: true,
    globalAngle: 120,
    globalAltitude: 30,
    dropShadow: { ...b, color: '#000000', opacity: 75, useGlobalLight: true, angle: 120, distance: 6, spread: 0, size: 8 },
    stroke: { ...b, color: '#000000', opacity: 100, width: 3, position: 'outside', blend: 'normal' },
    outerGlow: { ...b, color: '#fff3a0', opacity: 75, spread: 0, size: 10 },
    innerShadow: { ...b, blend: 'multiply', color: '#000000', opacity: 75, useGlobalLight: true, angle: 120, distance: 5, choke: 0, size: 8 },
    innerGlow: { ...b, blend: 'screen', color: '#fff3a0', opacity: 75, source: 'edge', choke: 0, size: 8 },
    bevel: {
      ...b,
      kind: 'inner',
      direction: 'up',
      size: 6,
      soften: 0,
      depth: 100,
      useGlobalLight: true,
      angle: 120,
      altitude: 30,
      highlightColor: '#ffffff',
      highlightBlend: 'screen',
      highlightOpacity: 75,
      shadowColor: '#000000',
      shadowBlend: 'multiply',
      shadowOpacity: 75,
    },
    satin: { ...b, blend: 'multiply', color: '#000000', opacity: 50, angle: 19, distance: 11, size: 14, invert: true },
    colorOverlay: { ...b, blend: 'normal', color: '#ff3b30', opacity: 100 },
    gradientOverlay: {
      ...b,
      blend: 'normal',
      opacity: 100,
      stops: [
        { pos: 0, color: '#ff512f', alpha: 100 },
        { pos: 100, color: '#f09819', alpha: 100 },
      ],
      shape: 'linear',
      angle: 90,
      scale: 100,
      reverse: false,
      align: 'layer',
    },
  };
}

export function cloneStyles(s: LayerStyles): LayerStyles {
  return JSON.parse(JSON.stringify(s)) as LayerStyles;
}

export function stylesEqual(a: LayerStyles | null, b: LayerStyles | null): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Czy stylizacja `k` jest faktycznie widoczna (zaznaczona, oko włączone). */
export function styleOn(s: LayerStyles, k: StyleKind): boolean {
  const x = s[k] as StyleBase;
  return s.visible && x.enabled && x.visible;
}

/** Czy cokolwiek z zestawu wpływa na wygląd. */
export function stylesActive(s: LayerStyles | null | undefined): boolean {
  if (!s || !s.visible) return false;
  return STYLE_LIST.some((e) => (s[e.kind] as StyleBase).enabled && (s[e.kind] as StyleBase).visible);
}

/** Liczba zaznaczonych stylizacji (do plakietki na pasku warstwy). */
export function stylesCount(s: LayerStyles | null | undefined): number {
  if (!s) return 0;
  return STYLE_LIST.filter((e) => (s[e.kind] as StyleBase).enabled).length;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeInto(base: any, raw: any): any {
  if (Array.isArray(base)) return Array.isArray(raw) ? raw : base;
  if (isObj(base)) {
    const out: any = {};
    for (const k of Object.keys(base)) out[k] = mergeInto(base[k], isObj(raw) ? raw[k] : undefined);
    return out;
  }
  return typeof raw === typeof base && !(typeof raw === 'number' && !Number.isFinite(raw)) ? raw : base;
}

/** Odtwarza zestaw z danych zapisanych w pliku (brakujące pola dostają wartości domyślne). */
export function reviveStyles(raw: unknown): LayerStyles | null {
  if (!isObj(raw)) return null;
  const s = mergeInto(defaultStyles(), raw) as LayerStyles;
  const g = s.gradientOverlay;
  const ok = Array.isArray(g.stops) && g.stops.length >= 2 && g.stops.every((t) => t && typeof t.pos === 'number' && typeof t.color === 'string' && typeof t.alpha === 'number');
  if (!ok) g.stops = defaultStyles().gradientOverlay.stops;
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Presety wbudowane
// ---------------------------------------------------------------------------------------------------------------

export interface StylePreset {
  id: string;
  name: string;
  styles: LayerStyles;
  builtin?: boolean;
}

function mk(patch: (s: LayerStyles) => void): LayerStyles {
  const s = defaultStyles();
  patch(s);
  return s;
}

export const BUILTIN_PRESETS: StylePreset[] = [
  {
    id: 'b-soft-shadow',
    name: 'Delikatny cień',
    builtin: true,
    styles: mk((s) => {
      s.dropShadow = { ...s.dropShadow, enabled: true, opacity: 40, distance: 8, size: 14 };
    }),
  },
  {
    id: 'b-hard-shadow',
    name: 'Twardy cień',
    builtin: true,
    styles: mk((s) => {
      s.dropShadow = { ...s.dropShadow, enabled: true, opacity: 85, distance: 7, size: 0 };
    }),
  },
  {
    id: 'b-sticker',
    name: 'Naklejka',
    builtin: true,
    styles: mk((s) => {
      s.stroke = { ...s.stroke, enabled: true, color: '#ffffff', width: 6, position: 'outside' };
      s.dropShadow = { ...s.dropShadow, enabled: true, opacity: 45, distance: 3, size: 6 };
    }),
  },
  {
    id: 'b-neon',
    name: 'Neon',
    builtin: true,
    styles: mk((s) => {
      s.outerGlow = { ...s.outerGlow, enabled: true, color: '#18f0ff', opacity: 95, spread: 20, size: 18 };
      s.innerGlow = { ...s.innerGlow, enabled: true, color: '#ffffff', opacity: 80, size: 6 };
      s.stroke = { ...s.stroke, enabled: true, color: '#ffffff', width: 2, position: 'inside' };
    }),
  },
  {
    id: 'b-emboss',
    name: 'Wypukły plastik',
    builtin: true,
    styles: mk((s) => {
      s.bevel = { ...s.bevel, enabled: true, size: 8, soften: 2 };
      s.dropShadow = { ...s.dropShadow, enabled: true, opacity: 50, distance: 5, size: 8 };
    }),
  },
  {
    id: 'b-gold',
    name: 'Złoto',
    builtin: true,
    styles: mk((s) => {
      s.gradientOverlay = {
        ...s.gradientOverlay,
        enabled: true,
        angle: 90,
        stops: [
          { pos: 0, color: '#8a5a00', alpha: 100 },
          { pos: 28, color: '#ffe27a', alpha: 100 },
          { pos: 52, color: '#b97a12', alpha: 100 },
          { pos: 78, color: '#fff1a8', alpha: 100 },
          { pos: 100, color: '#9c6a0a', alpha: 100 },
        ],
      };
      s.bevel = { ...s.bevel, enabled: true, size: 5, soften: 1, depth: 120 };
      s.stroke = { ...s.stroke, enabled: true, color: '#5a3a00', width: 2, position: 'outside' };
      s.dropShadow = { ...s.dropShadow, enabled: true, opacity: 55, distance: 4, size: 5 };
    }),
  },
  {
    id: 'b-inset',
    name: 'Wgłębienie',
    builtin: true,
    styles: mk((s) => {
      s.innerShadow = { ...s.innerShadow, enabled: true, opacity: 70, distance: 5, size: 8 };
      s.dropShadow = { ...s.dropShadow, enabled: true, color: '#ffffff', opacity: 70, distance: 2, size: 1 };
    }),
  },
  {
    id: 'b-sunset',
    name: 'Zachód słońca',
    builtin: true,
    styles: mk((s) => {
      s.gradientOverlay = {
        ...s.gradientOverlay,
        enabled: true,
        angle: 90,
        stops: [
          { pos: 0, color: '#ff3d6e', alpha: 100 },
          { pos: 55, color: '#ff9a3c', alpha: 100 },
          { pos: 100, color: '#ffe46b', alpha: 100 },
        ],
      };
      s.dropShadow = { ...s.dropShadow, enabled: true, opacity: 45, distance: 6, size: 10 };
    }),
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Margines i rozlewanie
// ---------------------------------------------------------------------------------------------------------------

const GAUSS_REACH = 1.7;

/** Margines (piksele dokumentu), o jaki trzeba powiększyć fragment, żeby wynik na nim był taki sam jak na całości. */
export function stylesMargin(s: LayerStyles): number {
  let m = 0;
  if (styleOn(s, 'dropShadow')) {
    const x = s.dropShadow;
    m = Math.max(m, x.distance + x.size * (GAUSS_REACH + x.spread / 100) + 3);
  }
  if (styleOn(s, 'outerGlow')) {
    const x = s.outerGlow;
    m = Math.max(m, x.size * (GAUSS_REACH + x.spread / 100) + 3);
  }
  if (styleOn(s, 'stroke')) m = Math.max(m, s.stroke.width + 3);
  if (styleOn(s, 'innerShadow')) {
    const x = s.innerShadow;
    m = Math.max(m, x.distance + x.size * GAUSS_REACH + x.choke * x.size / 100 + 3);
  }
  if (styleOn(s, 'innerGlow')) {
    const x = s.innerGlow;
    m = Math.max(m, x.size * (GAUSS_REACH + x.choke / 100) + 3);
  }
  if (styleOn(s, 'bevel')) m = Math.max(m, s.bevel.size * 2 + s.bevel.soften * GAUSS_REACH + 4);
  if (styleOn(s, 'satin')) m = Math.max(m, s.satin.distance + s.satin.size * GAUSS_REACH + 3);
  return Math.ceil(m);
}

/** Czy stylizacje mogą rysować poza obrysem warstwy (puste kafelki obok zawartości też trzeba narysować). */
export function stylesSpread(s: LayerStyles): boolean {
  if (styleOn(s, 'dropShadow') || styleOn(s, 'outerGlow')) return true;
  if (styleOn(s, 'stroke') && s.stroke.position !== 'inside') return true;
  if (styleOn(s, 'bevel') && s.bevel.kind !== 'inner') return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Narzędzia: płaszczyzny, rozmycie, odległość
// ---------------------------------------------------------------------------------------------------------------

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function parseColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function boxRadii(sigma: number): number[] {
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

function boxLines(src: Float32Array, dst: Float32Array, len: number, count: number, stride: number, lineStride: number, r: number): void {
  const inv = 1 / (2 * r + 1);
  for (let l = 0; l < count; l++) {
    const base = l * lineStride;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[base + (k < 0 ? 0 : k >= len ? len - 1 : k) * stride];
    for (let i = 0; i < len; i++) {
      dst[base + i * stride] = acc * inv;
      const a = i + r + 1;
      const b = i - r;
      acc += src[base + (a >= len ? len - 1 : a) * stride] - src[base + (b < 0 ? 0 : b) * stride];
    }
  }
}

/** Rozmycie Gaussa (3 przebiegi pudełkowe) jednej płaszczyzny; brzegi bufora powtarzają skrajne piksele. */
function blurPlane(p: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return p;
  let src = p;
  for (const r0 of boxRadii(sigma)) {
    const r = Math.max(0, Math.round(r0));
    if (r === 0) continue;
    const t = new Float32Array(p.length);
    boxLines(src, t, w, h, 1, w, r);
    const o = new Float32Array(p.length);
    boxLines(t, o, h, w, w, 1, r);
    src = o;
  }
  return src;
}

/** Przesunięcie płaszczyzny o (dx, dy) z interpolacją dwuliniową; brzegi powtarzają skrajne piksele. */
function shiftPlane(p: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) return p;
  const out = new Float32Array(p.length);
  const ix = Math.floor(-dx);
  const iy = Math.floor(-dy);
  const fx = -dx - ix;
  const fy = -dy - iy;
  for (let y = 0; y < h; y++) {
    let y0 = y + iy;
    let y1 = y0 + 1;
    y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
    y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
    for (let x = 0; x < w; x++) {
      let x0 = x + ix;
      let x1 = x0 + 1;
      x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
      x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
      const a = p[y0 * w + x0] * (1 - fx) + p[y0 * w + x1] * fx;
      const b = p[y1 * w + x0] * (1 - fx) + p[y1 * w + x1] * fx;
      out[y * w + x] = a * (1 - fy) + b * fy;
    }
  }
  return out;
}

const INF = 1e12;

/** Odległość euklidesowa (w pikselach) do najbliższego piksela „cechy” (feature = 1); 0 na samych cechach. */
function distanceTo(feature: Uint8Array, w: number, h: number): Float32Array {
  const n = w * h;
  const g = new Float32Array(n);
  const m = Math.max(w, h);
  const f = new Float64Array(m);
  const dd = new Float64Array(m);
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  const run = (len: number): void => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const dq = q - v[k];
      dd[q] = dq * dq + f[v[k]];
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = feature[y * w + x] ? 0 : INF;
    run(h);
    for (let y = 0; y < h; y++) g[y * w + x] = dd[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    run(w);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(dd[x]);
  }
  return g;
}

// ---------------------------------------------------------------------------------------------------------------
// Mieszanie
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// Pamięć podręczna płaszczyzn pośrednich i rozmycie w zmniejszonej rozdzielczości
// ---------------------------------------------------------------------------------------------------------------

/**
 * Płaszczyzny zależne tylko od kształtu (mapy odległości, kształt po rozszerzeniu, rozmyty cień) są pamiętane między
 * kolejnymi wywołaniami: przesunięcie suwaka koloru lub krycia nic wtedy nie liczy od nowa. Klucz zawiera skrót kanału
 * alfa, więc zmiana zawartości warstwy sama unieważnia wpisy. Pamięć jest ograniczona (najstarsze wpisy wypadają).
 */
const PLANE_CACHE_LIMIT = 48 * 1024 * 1024;
const planeCache = new Map<string, Float32Array>();
let planeCacheBytes = 0;

function cachedPlane(key: string, make: () => Float32Array): Float32Array {
  const hit = planeCache.get(key);
  if (hit) {
    planeCache.delete(key);
    planeCache.set(key, hit);
    return hit;
  }
  const v = make();
  if (v.byteLength > PLANE_CACHE_LIMIT / 2) return v;
  planeCache.set(key, v);
  planeCacheBytes += v.byteLength;
  while (planeCacheBytes > PLANE_CACHE_LIMIT && planeCache.size > 1) {
    const k = planeCache.keys().next().value as string;
    planeCacheBytes -= planeCache.get(k)!.byteLength;
    planeCache.delete(k);
  }
  return v;
}

/** Czyści pamięć podręczną (testy). */
export function clearStyleCache(): void {
  planeCache.clear();
  planeCacheBytes = 0;
}

/** Skrót kanału alfa bufora RGBA (dwa niezależne 32-bitowe). */
function alphaHash(d: Uint8ClampedArray, n: number): string {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b1 | 0;
  for (let i = 0, j = 3; i < n; i++, j += 4) {
    const a = d[j];
    h1 = Math.imul(h1 ^ a, 16777619);
    h2 = (Math.imul(h2, 31) + a) | 0;
  }
  return (h1 >>> 0).toString(36) + '.' + (h2 >>> 0).toString(36);
}

/**
 * Rozmycie z przesunięciem. Duże rozmycia liczone są na zmniejszonej siatce (komórki f x f zakotwiczone w układzie
 * dokumentu przez `phase`, więc kafelek i całe okno dają ten sam wynik) i rozciągane dwuliniowo z jednoczesnym
 * przesunięciem; małe - w pełnej rozdzielczości.
 */
function blurShift(p: Float32Array, w: number, h: number, sigma: number, dx: number, dy: number, phaseX: number, phaseY: number): Float32Array {
  if (sigma < 5) return blurPlane(shiftPlane(p, w, h, dx, dy), w, h, sigma);
  const f = sigma >= 24 ? 8 : sigma >= 11 ? 4 : 2;
  const lw = Math.ceil((w + phaseX) / f);
  const lh = Math.ceil((h + phaseY) / f);
  let low: Float32Array = new Float32Array(lw * lh);
  const cx = new Float32Array(lw);
  const cy = new Float32Array(lh);
  for (let x = 0; x < w; x++) cx[((x + phaseX) / f) | 0]++;
  for (let y = 0; y < h; y++) cy[((y + phaseY) / f) | 0]++;
  for (let y = 0; y < h; y++) {
    const row = (((y + phaseY) / f) | 0) * lw;
    const src = y * w;
    for (let x = 0; x < w; x++) low[row + (((x + phaseX) / f) | 0)] += p[src + x];
  }
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) low[y * lw + x] /= cx[x] * cy[y] || 1;
  low = blurPlane(low, lw, lh, sigma / f);
  const out = new Float32Array(w * h);
  const x0 = new Int32Array(w);
  const x1 = new Int32Array(w);
  const fxw = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const u = (x + phaseX - dx + 0.5) / f - 0.5;
    const i0 = Math.floor(u);
    fxw[x] = u - i0;
    x0[x] = i0 < 0 ? 0 : i0 >= lw ? lw - 1 : i0;
    x1[x] = i0 + 1 < 0 ? 0 : i0 + 1 >= lw ? lw - 1 : i0 + 1;
  }
  for (let y = 0; y < h; y++) {
    const v = (y + phaseY - dy + 0.5) / f - 0.5;
    const j0 = Math.floor(v);
    const fy = v - j0;
    const r0 = (j0 < 0 ? 0 : j0 >= lh ? lh - 1 : j0) * lw;
    const r1 = (j0 + 1 < 0 ? 0 : j0 + 1 >= lh ? lh - 1 : j0 + 1) * lw;
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const a = low[r0 + x0[x]] * (1 - fxw[x]) + low[r0 + x1[x]] * fxw[x];
      const b = low[r1 + x0[x]] * (1 - fxw[x]) + low[r1 + x1[x]] * fxw[x];
      out[o + x] = a * (1 - fy) + b * fy;
    }
  }
  return out;
}

function blendCh(mode: StyleBlend, b: number, s: number): number {
  switch (mode) {
    case 'multiply':
      return b * s;
    case 'screen':
      return b + s - b * s;
    case 'overlay':
      return b <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'hardLight':
      return s <= 0.5 ? 2 * b * s : 1 - 2 * (1 - b) * (1 - s);
    case 'softLight': {
      if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
      const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
      return b + (2 * s - 1) * (d - b);
    }
    case 'darken':
      return b < s ? b : s;
    case 'lighten':
      return b > s ? b : s;
    case 'colorDodge':
      return b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 'colorBurn':
      return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 'difference':
      return Math.abs(b - s);
    case 'exclusion':
      return b + s - 2 * b * s;
    default:
      return s;
  }
}

/** Powierzchnia robocza: kolory proste (nie mnożone przez alfę), 0..1. */
interface Surf {
  R: Float32Array;
  G: Float32Array;
  B: Float32Array;
  A: Float32Array;
}

function paint(S: Surf, i: number, cr: number, cg: number, cb: number, sa: number, mode: StyleBlend): void {
  if (sa <= 0.0005) return;
  const ab = S.A[i];
  const ao = sa + ab * (1 - sa);
  if (mode === 'normal' || ab <= 0) {
    const k = ab * (1 - sa);
    S.R[i] = (cr * sa + S.R[i] * k) / ao;
    S.G[i] = (cg * sa + S.G[i] * k) / ao;
    S.B[i] = (cb * sa + S.B[i] * k) / ao;
  } else {
    const kb = (1 - sa) * ab;
    const ks = sa * (1 - ab);
    const km = sa * ab;
    S.R[i] = (kb * S.R[i] + ks * cr + km * blendCh(mode, S.R[i], cr)) / ao;
    S.G[i] = (kb * S.G[i] + ks * cg + km * blendCh(mode, S.G[i], cg)) / ao;
    S.B[i] = (kb * S.B[i] + ks * cb + km * blendCh(mode, S.B[i], cb)) / ao;
  }
  S.A[i] = ao;
}

// ---------------------------------------------------------------------------------------------------------------
// Gradient
// ---------------------------------------------------------------------------------------------------------------

export function gradientLut(stops: GradStop[], reverse: boolean): Float32Array {
  const st = [...stops].sort((a, b) => a.pos - b.pos).map((s) => ({ p: clamp01(s.pos / 100), c: parseColor(s.color), a: clamp01(s.alpha / 100) }));
  const lut = new Float32Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let t = i / 255;
    if (reverse) t = 1 - t;
    let lo = st[0];
    let hi = st[st.length - 1];
    if (t <= st[0].p) hi = lo;
    else if (t >= st[st.length - 1].p) lo = hi;
    else {
      for (let k = 0; k < st.length - 1; k++) {
        if (t >= st[k].p && t <= st[k + 1].p) {
          lo = st[k];
          hi = st[k + 1];
          break;
        }
      }
    }
    const f = hi.p === lo.p ? 0 : (t - lo.p) / (hi.p - lo.p);
    lut[i * 4] = lo.c[0] + (hi.c[0] - lo.c[0]) * f;
    lut[i * 4 + 1] = lo.c[1] + (hi.c[1] - lo.c[1]) * f;
    lut[i * 4 + 2] = lo.c[2] + (hi.c[2] - lo.c[2]) * f;
    lut[i * 4 + 3] = lo.a + (hi.a - lo.a) * f;
  }
  return lut;
}

/** Prostokąt (piksele dokumentu), względem którego liczony jest gradient; dostarcza go warstwa. */
export interface StyleFx extends FxContext {
  layerBounds?: { x0: number; y0: number; x1: number; y1: number } | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Wykonanie
// ---------------------------------------------------------------------------------------------------------------

export function applyLayerStyles(d: Uint8ClampedArray, w: number, h: number, st: LayerStyles, fx: StyleFx, inner = false): void {
  if (!stylesActive(st) || w <= 0 || h <= 0) return;
  const n = w * h;
  const sc = fx.scale || 1;

  // Praca tylko w prostokącie zawartości powiększonym o zasięg efektów (poza nim nic się nie zmienia): przy małych
  // obiektach w dużym oknie oszczędza większość obliczeń. Wynik jest taki sam, bo poza zawartością alfa = 0.
  if (!inner) {
    let bx0 = w;
    let by0 = h;
    let bx1 = -1;
    let by1 = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4 + 3;
      for (let x = 0; x < w; x++) {
        if (d[row + x * 4] !== 0) {
          if (x < bx0) bx0 = x;
          if (x > bx1) bx1 = x;
          if (y < by0) by0 = y;
          by1 = y;
        }
      }
    }
    if (bx1 < 0) return;
    const m = Math.ceil(stylesMargin(st) * sc) + 2;
    const x0 = Math.max(0, bx0 - m);
    const y0 = Math.max(0, by0 - m);
    const x1 = Math.min(w, bx1 + 1 + m);
    const y1 = Math.min(h, by1 + 1 + m);
    const sw = x1 - x0;
    const sh = y1 - y0;
    if (sw * sh < n * 0.6) {
      const sub = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) sub.set(d.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + sw) * 4), y * sw * 4);
      applyLayerStyles(sub, sw, sh, st, { ...fx, docX0: fx.docX0 + x0 / sc, docY0: fx.docY0 + y0 / sc, bounds: undefined }, true);
      for (let y = 0; y < sh; y++) d.set(sub.subarray(y * sw * 4, (y + 1) * sw * 4), ((y0 + y) * w + x0) * 4);
      return;
    }
  }

  // zawartość: kolory proste
  const OR = new Float32Array(n);
  const OG = new Float32Array(n);
  const OB = new Float32Array(n);
  const OA = new Float32Array(n);
  let any = false;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = d[j + 3];
    if (a > 0) any = true;
    OA[i] = a / 255;
    OR[i] = d[j] / 255;
    OG[i] = d[j + 1] / 255;
    OB[i] = d[j + 2] / 255;
  }
  if (!any) return;

  const S: Surf = { R: new Float32Array(n), G: new Float32Array(n), B: new Float32Array(n), A: new Float32Array(n) };

  // klucz pamięci podręcznej: kształt (alfa), rozmiar bufora, skala i położenie siatki rozmycia względem dokumentu
  const phaseX = Math.round(fx.docX0 * sc);
  const phaseY = Math.round(fx.docY0 * sc);
  let akv = '';
  const ak = (): string => akv || (akv = `${alphaHash(d, n)}|${w}x${h}|${sc.toFixed(4)}`);
  const ph = (f: number): [number, number] => [((phaseX % f) + f) % f, ((phaseY % f) + f) % f];
  /** Rozmycie z przesunięciem z pamięcią podręczną (kształt `tag` + parametry geometrii). */
  const blurred = (tag: string, base: () => Float32Array, sigma: number, dx: number, dy: number): Float32Array => {
    const f = sigma >= 24 ? 8 : sigma >= 11 ? 4 : sigma >= 5 ? 2 : 1;
    const [px, py] = f > 1 ? ph(f) : [0, 0];
    return cachedPlane(`${ak()}|${tag}|${sigma.toFixed(2)}|${dx.toFixed(3)},${dy.toFixed(3)}|${px},${py}`, () => blurShift(base(), w, h, sigma, dx, dy, px, py));
  };

  // odległości liczone na żądanie (i pamiętane)
  const dIn = (): Float32Array =>
    cachedPlane(`${ak()}|dIn`, () => {
      const f = new Uint8Array(n);
      for (let i = 0; i < n; i++) f[i] = OA[i] >= 0.5 ? 1 : 0;
      return distanceTo(f, w, h);
    });
  const dOut = (): Float32Array =>
    cachedPlane(`${ak()}|dOut`, () => {
      const f = new Uint8Array(n);
      for (let i = 0; i < n; i++) f[i] = OA[i] < 0.5 ? 1 : 0;
      return distanceTo(f, w, h);
    });

  /** Kształt powiększony o r pikseli (r = 0: bez zmian). */
  const grow = (r: number): Float32Array => {
    if (r <= 0.01) return OA;
    return cachedPlane(`${ak()}|grow|${r.toFixed(2)}`, () => {
      const di = dIn();
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = clamp01(r + 1 - di[i]);
        out[i] = v > OA[i] ? v : OA[i];
      }
      return out;
    });
  };
  /** Kształt pomniejszony o r pikseli. */
  const shrink = (r: number): Float32Array => {
    if (r <= 0.01) return OA;
    return cachedPlane(`${ak()}|shrink|${r.toFixed(2)}`, () => {
      const dOutP = dOut();
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = clamp01(dOutP[i] - r);
        out[i] = v < OA[i] ? v : OA[i];
      }
      return out;
    });
  };

  const lightAngle = (own: boolean, a: number): number => (own ? st.globalAngle : a);
  const offsetOf = (angDeg: number, dist: number): [number, number] => {
    const t = (angDeg * Math.PI) / 180;
    return [-Math.cos(t) * dist * sc, Math.sin(t) * dist * sc];
  };

  // --- WARSTWY POD ZAWARTOŚCIĄ ---
  const behindShape = (shape: Float32Array, color: string, opacity: number): void => {
    const [cr, cg, cb] = parseColor(color);
    const op = clamp01(opacity / 100);
    for (let i = 0; i < n; i++) {
      // wycięcie zawartością: cień nie prześwituje przez nieprzezroczyste fragmenty
      const k = shape[i] * (1 - OA[i]) * op;
      if (k > 0.0005) paint(S, i, cr, cg, cb, k, 'normal');
    }
  };

  if (styleOn(st, 'dropShadow')) {
    const x = st.dropShadow;
    const size = x.size * sc;
    const [ox, oy] = offsetOf(lightAngle(x.useGlobalLight, x.angle), x.distance);
    const r = (x.spread / 100) * size;
    const sh = blurred(`ds${r.toFixed(2)}`, () => grow(r), size / 2, ox, oy);
    behindShape(sh, x.color, x.opacity);
  }
  if (styleOn(st, 'outerGlow')) {
    const x = st.outerGlow;
    const size = x.size * sc;
    const r = (x.spread / 100) * size;
    const sh = blurred(`og${r.toFixed(2)}`, () => grow(r), size / 2, 0, 0);
    behindShape(sh, x.color, x.opacity);
  }
  if (styleOn(st, 'stroke') && st.stroke.position !== 'inside') {
    const x = st.stroke;
    const r = (x.position === 'center' ? x.width / 2 : x.width) * sc;
    const di = dIn();
    const dOutP = dOut();
    const [cr, cg, cb] = parseColor(x.color);
    const op = clamp01(x.opacity / 100);
    for (let i = 0; i < n; i++) {
      if (dOutP[i] > 1.5) continue;
      const k = clamp01(r + 1 - di[i]) * op;
      if (k > 0.0005) paint(S, i, cr, cg, cb, k, 'normal');
    }
  }

  // --- ZAWARTOŚĆ ---
  for (let i = 0; i < n; i++) {
    const a = OA[i];
    if (a <= 0) continue;
    if (a >= 0.999 || S.A[i] === 0) {
      S.R[i] = OR[i];
      S.G[i] = OG[i];
      S.B[i] = OB[i];
      S.A[i] = a;
    } else paint(S, i, OR[i], OG[i], OB[i], a, 'normal');
  }

  // --- WARSTWY NAD ZAWARTOŚCIĄ (przycięte do kształtu) ---
  const overShape = (plane: Float32Array | null, color: [number, number, number], opacity: number, mode: StyleBlend): void => {
    const op = clamp01(opacity / 100);
    for (let i = 0; i < n; i++) {
      const k = (plane ? plane[i] : 1) * OA[i] * op;
      if (k > 0.0005) paint(S, i, color[0], color[1], color[2], k, mode);
    }
  };

  if (styleOn(st, 'satin')) {
    const x = st.satin;
    const size = x.size * sc;
    const [ox, oy] = offsetOf(x.angle, x.distance);
    const a1 = blurred('sat', () => OA, size / 2, ox, oy);
    const a2 = blurred('sat', () => OA, size / 2, -ox, -oy);
    const pl = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.abs(a1[i] - a2[i]);
      pl[i] = x.invert ? 1 - v : v;
    }
    overShape(pl, parseColor(x.color), x.opacity, x.blend);
  }
  if (styleOn(st, 'colorOverlay')) {
    const x = st.colorOverlay;
    overShape(null, parseColor(x.color), x.opacity, x.blend);
  }
  if (styleOn(st, 'gradientOverlay')) {
    const x = st.gradientOverlay;
    const lut = gradientLut(x.stops, x.reverse);
    const lb = x.align === 'layer' && fx.layerBounds ? fx.layerBounds : { x0: 0, y0: 0, x1: fx.docW, y1: fx.docH };
    const bw = Math.max(1, lb.x1 - lb.x0);
    const bh = Math.max(1, lb.y1 - lb.y0);
    const cx = (lb.x0 + lb.x1) / 2;
    const cy = (lb.y0 + lb.y1) / 2;
    const th = (x.angle * Math.PI) / 180;
    const ux = Math.cos(th);
    const uy = -Math.sin(th);
    const k = Math.max(0.01, x.scale / 100);
    const half = Math.max(1e-3, ((Math.abs(bw * ux) + Math.abs(bh * uy)) / 2) * k);
    const rad = Math.max(1e-3, (Math.hypot(bw, bh) / 2) * k);
    const op = clamp01(x.opacity / 100);
    for (let y = 0; y < h; y++) {
      const py = fx.docY0 + (y + 0.5) / sc - cy;
      for (let xx = 0; xx < w; xx++) {
        const i = y * w + xx;
        const a = OA[i];
        if (a <= 0) continue;
        const px = fx.docX0 + (xx + 0.5) / sc - cx;
        let t: number;
        switch (x.shape) {
          case 'radial':
            t = Math.hypot(px, py) / rad;
            break;
          case 'angle':
            t = (Math.atan2(py * -1, px) - th) / (2 * Math.PI);
            t = t - Math.floor(t);
            break;
          case 'reflected':
            t = Math.abs((px * ux + py * uy) / half);
            break;
          case 'diamond':
            t = (Math.abs(px) + Math.abs(py)) / rad;
            break;
          default:
            t = 0.5 + (px * ux + py * uy) / (2 * half);
        }
        const li = Math.max(0, Math.min(255, Math.round(clamp01(t) * 255))) * 4;
        const sa = lut[li + 3] * a * op;
        if (sa > 0.0005) paint(S, i, lut[li], lut[li + 1], lut[li + 2], sa, x.blend);
      }
    }
  }
  if (styleOn(st, 'innerGlow')) {
    const x = st.innerGlow;
    const size = x.size * sc;
    let pl: Float32Array;
    if (x.source === 'edge') {
      const r = (x.choke / 100) * size;
      pl = blurred(`ig${r.toFixed(2)}`, () => {
        const e = shrink(r);
        const inv = new Float32Array(n);
        for (let i = 0; i < n; i++) inv[i] = 1 - e[i];
        return inv;
      }, size / 2, 0, 0);
    } else {
      const e = shrink(size * 0.0);
      pl = blurred('igc', () => e, Math.max(0.5, size / 2), 0, 0).slice();
      const di = dOut();
      const reach = Math.max(1, size * (1 + x.choke / 100));
      for (let i = 0; i < n; i++) pl[i] = pl[i] * clamp01(di[i] / reach);
    }
    overShape(pl, parseColor(x.color), x.opacity, x.blend);
  }
  if (styleOn(st, 'innerShadow')) {
    const x = st.innerShadow;
    const size = x.size * sc;
    const [ox, oy] = offsetOf(lightAngle(x.useGlobalLight, x.angle), x.distance);
    const r = (x.choke / 100) * size;
    const pl = blurred(`is${r.toFixed(2)}`, () => {
      const e = shrink(r);
      const inv = new Float32Array(n);
      for (let i = 0; i < n; i++) inv[i] = 1 - e[i];
      return inv;
    }, size / 2, ox, oy);
    overShape(pl, parseColor(x.color), x.opacity, x.blend);
  }
  if (styleOn(st, 'bevel')) applyBevel(st, S, OA, n, w, h, sc, dIn, dOut);

  if (styleOn(st, 'stroke') && st.stroke.position !== 'outside') {
    const x = st.stroke;
    const r = (x.position === 'center' ? x.width / 2 : x.width) * sc;
    const dOutP = dOut();
    const [cr, cg, cb] = parseColor(x.color);
    const op = clamp01(x.opacity / 100);
    for (let i = 0; i < n; i++) {
      const band = OA[i] - clamp01(dOutP[i] - r);
      const k = (band > 0 ? band : 0) * op;
      if (k > 0.0005) paint(S, i, cr, cg, cb, k, x.blend);
    }
  }

  // zapis
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = S.A[i];
    d[j] = Math.round(clamp01(S.R[i]) * 255);
    d[j + 1] = Math.round(clamp01(S.G[i]) * 255);
    d[j + 2] = Math.round(clamp01(S.B[i]) * 255);
    d[j + 3] = Math.round(clamp01(a) * 255);
  }
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function applyBevel(
  st: LayerStyles,
  S: Surf,
  OA: Float32Array,
  n: number,
  w: number,
  h: number,
  sc: number,
  dIn: () => Float32Array,
  dOut: () => Float32Array
): void {
  const x = st.bevel;
  const size = Math.max(1, x.size * sc);
  const di = dIn();
  const dOutP = dOut();
  const hm = new Float32Array(n);
  const mask = new Float32Array(n);
  const sgn = x.direction === 'up' ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const inside = OA[i] >= 0.5;
    // odległość ze znakiem od krawędzi: dodatnia wewnątrz, ujemna na zewnątrz
    const sd = inside ? dOutP[i] - 0.5 : -(di[i] - 0.5);
    let hv = 0;
    let m = 0;
    switch (x.kind) {
      case 'inner':
        hv = inside ? smooth(clamp01(sd / size)) : 0;
        m = OA[i];
        break;
      case 'outer':
        hv = inside ? 1 : 1 - smooth(clamp01(-sd / size));
        m = 1 - OA[i];
        break;
      case 'emboss':
        hv = smooth(clamp01(0.5 + sd / (2 * size)));
        m = 1;
        break;
      default:
        hv = smooth(clamp01(Math.abs(sd) / size));
        m = 1;
    }
    hm[i] = hv * sgn;
    mask[i] = m;
  }
  const soft = Math.max(0.7, x.soften * sc);
  const hb = blurPlane(hm, w, h, soft);
  const depth = (x.depth / 100) * size * 1.5;
  const ang = (((x.useGlobalLight ? st.globalAngle : x.angle) * Math.PI) / 180);
  const alt = (((x.useGlobalLight ? st.globalAltitude : x.altitude) * Math.PI) / 180);
  const Lx = Math.cos(alt) * Math.cos(ang);
  const Ly = -Math.cos(alt) * Math.sin(ang);
  const Lz = Math.sin(alt);
  const I0 = Lz;
  const hc = parseColor(x.highlightColor);
  const sc2 = parseColor(x.shadowColor);
  const ho = clamp01(x.highlightOpacity / 100);
  const so = clamp01(x.shadowOpacity / 100);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y;
    const yp = y < h - 1 ? y + 1 : y;
    for (let xx = 0; xx < w; xx++) {
      const i = y * w + xx;
      const m = mask[i];
      if (m <= 0.0005) continue;
      const xm = xx > 0 ? xx - 1 : xx;
      const xp = xx < w - 1 ? xx + 1 : xx;
      const gx = (hb[y * w + xp] - hb[y * w + xm]) / (xp - xm || 1);
      const gy = (hb[yp * w + xx] - hb[ym * w + xx]) / (yp - ym || 1);
      if (gx === 0 && gy === 0) continue;
      const nx = -gx * depth;
      const ny = -gy * depth;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const I = (nx * Lx + ny * Ly + Lz) * inv;
      if (I > I0) {
        const k = clamp01((I - I0) / (1 - I0 + 1e-3)) * ho * m;
        paint(S, i, hc[0], hc[1], hc[2], k, x.highlightBlend);
      } else {
        const k = clamp01((I0 - I) / (I0 + 1e-3)) * so * m;
        paint(S, i, sc2[0], sc2[1], sc2[2], k, x.shadowBlend);
      }
    }
  }
}
