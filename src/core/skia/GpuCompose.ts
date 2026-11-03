/**
 * GpuCompose - kompozytor podglądu edycji na GPU (WebGL2).
 *
 * Składa warstwy dokumentu (piksele, maski, korekcje, filtry, stylizacje, tryby mieszania, krycie, korekcje samodzielne)
 * wraz z podglądem narzędzia (figura, linia, krzywa, gradient, wiadro, przekształcanie) w JEDNYM przebiegu na karcie
 * graficznej i pokazuje wynik bez odczytu z GPU. Zastępuje kafelkowe składanie na procesorze, które przy podglądzie na
 * warstwie leżącej niżej (pod innymi warstwami, z efektami / trybami mieszania) musiało odtwarzać kafelki.
 *
 * Odwzorowuje `ViewportTileRenderer.composeWindowRaw` krok po kroku: okno rastra (skala s: dokument -> raster x_r = (x - ox) * s),
 * ten sam podział na „piksele -> podgląd -> maska -> korekcje -> krycie / tryb”, te same łańcuchy efektów (GpuFx / GpuStyles
 * w sesji bez odczytu). Zwraca `null`, gdy czegoś nie umie (grupy izolowane, „Przepuszczanie”, szum / pikselizacja / ziarno
 * filmowe, zbyt duże okno, brak GPU) - wtedy działa dotychczasowa ścieżka procesorowa.
 *
 * Tekstury warstw (RGBA8, proste kolory = to samo co `getImageData`) są wspólne dla wszystkich klatek i aktualizowane
 * przyrostowo (tylko kafelki, których wersja się zmieniła, i tylko w widocznym oknie).
 */

import type { GraphicEngine } from './GraphicEngine.ts';
import type { Layer } from './Layer.ts';
import type { TileGrid } from './TileGrid.ts';
import type { Tile } from './Tile.ts';
import type { SKBlendMode, SKRectI } from './types.ts';
import type { FxContext } from './Filters.ts';
import {
  GL2 as GL,
  GL_HEAD,
  Tex,
  gpuSessionBeginTex,
  gpuSessionEndTex,
  kitBind,
  kitGl,
  kitMakeTex,
  kitMaxTex,
  kitPass,
  kitProg,
  kitUni,
} from './GpuFx.ts';

/** Największe okno składania (piksele rastra razem z marginesem filtrów). */
const MAX_WIN_PX = 24 * 1024 * 1024;
/** Limit pamięci tekstur dokumentu (warstwy + maski) i pamięci podręcznej efektów, w bajtach. */
const GRID_BUDGET = 1400 * 1024 * 1024;
const FX_CACHE_BUDGET = 420 * 1024 * 1024;
/** Minimalne przesunięcie siatki próbkowania (jak TIE_EPS w ViewportTileRenderer: ten sam piksel wygrywa w obu ścieżkach). */
const TIE_EPS = 0.002;
/** Siatka (piksele urządzenia), do której wyrównane jest okno składania w trybie Wektory (patrz composeImpl). */
const CRISP_SNAP = 128;

export interface GpuView {
  zoom: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Okno rastra składania: dokument -> raster x_r = (x - ox) * s; rozmiar W x H razem z marginesem filtrów. */
export interface GpuWindow {
  ox: number;
  oy: number;
  s: number;
  W: number;
  H: number;
  /** margines (piksele rastra) dodany z każdej strony do okna widocznego */
  M: number;
}

/** Zrasteryzowany podgląd: `canvas` leży w oknie rastra od (x, y). Piksele z mnożeniem alfa (kanwa 2D). */
export interface GpuPreviewRaster {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

/**
 * Warstwy wektorowe rysowane w rozdzielczości ekranu (tryb Wektory): kompozytor składa wtedy okno w skali widoku (a nie
 * dokumentu), a pikseli warstwy wektorowej nie próbkuje z kafelków, tylko bierze ostro narysowaną teksturę.
 * Maski, korekcje, filtry, stylizacje, krycie i tryby mieszania działają dalej tak samo jak dla pozostałych warstw.
 */
export interface GpuCrispSource {
  /** Czy warstwa jest rysowana wektorowo w rozdzielczości okna. */
  vector: (layer: Layer) => boolean;
  /** Klucz zawartości warstwy wektorowej (zmienia się, gdy trzeba ją narysować od nowa). */
  key: (layer: Layer) => string;
  /** Rysuje warstwę (kind 'layer') lub jej maskę (kind 'mask') w oknie rastra W x H; null = nie umiem. */
  raster: (layer: Layer, win: GpuWindow, kind: 'layer' | 'mask') => HTMLCanvasElement | null;
}

export interface GpuPreviewSource {
  blendMode: SKBlendMode;
  /** Obszar podglądu w układzie dokumentu (null = całe okno). */
  bounds: SKRectI | null;
  /** Rasteryzuje podgląd dla okna (z maską zaznaczenia); null = pusty. */
  rasterize: (win: GpuWindow, rect: { x0: number; y0: number; x1: number; y1: number } | null) => GpuPreviewRaster | null;
}

const MODE_ID: Record<string, number> = {
  SrcOver: 0,
  Multiply: 1,
  Screen: 2,
  Overlay: 3,
  Darken: 4,
  Lighten: 5,
  ColorDodge: 6,
  ColorBurn: 7,
  HardLight: 8,
  SoftLight: 9,
  Difference: 10,
  Exclusion: 11,
  Clear: 12,
};
const modeId = (m: SKBlendMode): number => MODE_ID[m] ?? 0;

// ---------------------------------------------------------------------------------------------------------------
// Shadery
// ---------------------------------------------------------------------------------------------------------------

const BLEND_FN = `
float bch(int m, float b, float s) {
  if (m == 1) return b * s;
  if (m == 2) return b + s - b * s;
  if (m == 3) return b <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (m == 4) return min(b, s);
  if (m == 5) return max(b, s);
  if (m == 6) return b == 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s)));
  if (m == 7) return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s));
  if (m == 8) return s <= 0.5 ? 2.0 * b * s : 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  if (m == 9) {
    if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
    float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
    return b + (2.0 * s - 1.0) * (d - b);
  }
  if (m == 10) return abs(b - s);
  if (m == 11) return b + s - 2.0 * b * s;
  return s;
}
/** B: tło (RGB * alfa, alfa); S: źródło w prostych kolorach; g: krycie. Wynik: RGB * alfa, alfa. */
vec4 blendOver(vec4 B, vec4 S, float g, int mode) {
  float as = S.a * g;
  if (mode == 12) return B * (1.0 - as);
  float ab = B.a;
  float ao = as + ab * (1.0 - as);
  if (ao <= 0.0) return vec4(0.0);
  vec3 cb = ab > 0.0 ? B.rgb / ab : vec3(0.0);
  vec3 bl = S.rgb;
  if (mode != 0) bl = vec3(bch(mode, cb.r, S.r), bch(mode, cb.g, S.g), bch(mode, cb.b, S.b));
  vec3 co = (1.0 - ab) * as * S.rgb + (1.0 - as) * B.rgb + as * ab * bl;
  return vec4(co, ao);
}
vec4 toStraight(vec4 p) { return p.a > 0.0 ? vec4(p.rgb / p.a, p.a) : vec4(0.0); }
`;

/** Próbkowanie tekstury warstwy do okna rastra (RGBA8, proste kolory). */
const FS_SAMPLE =
  GL_HEAD +
  BLEND_FN +
  `uniform sampler2D uSrc;
uniform ivec2 uDoc;
uniform vec2 uOrg;
uniform float uS;
uniform int uGray;
uniform int uNear;
uniform ivec4 uCov;
vec4 fetchPre(ivec2 q) {
  q = clamp(q, ivec2(0), uDoc - 1);
  vec4 c = texelFetch(uSrc, q, 0);
  if (uGray == 1) {
    float g = floor(dot(c.rgb * 255.0, vec3(0.299, 0.587, 0.114)) * c.a + 0.5) / 255.0;
    return vec4(vec3(g), 1.0);
  }
  return vec4(c.rgb * c.a, c.a);
}
void main() {
  ivec2 r = ivec2(gl_FragCoord.xy);
  if (uS == 1.0) {
    ivec2 q = ivec2(floor(uOrg + 0.5)) + r;
    if (q.x < 0 || q.y < 0 || q.x >= uDoc.x || q.y >= uDoc.y) { o = vec4(0.0); return; }
    vec4 c = texelFetch(uSrc, q, 0);
    if (uGray == 1) {
      float g = floor(dot(c.rgb * 255.0, vec3(0.299, 0.587, 0.114)) * c.a + 0.5) / 255.0;
      o = vec4(vec3(g), 1.0);
    } else o = c;
    return;
  }
  if (r.x < uCov.x || r.y < uCov.y || r.x >= uCov.z || r.y >= uCov.w) { o = vec4(0.0); return; }
  if (uNear == 1) {
    ivec2 q = clamp(ivec2(floor(uOrg + (vec2(r) + 0.5) / uS + 0.0001)), ivec2(0), uDoc - 1);
    vec4 c = texelFetch(uSrc, q, 0);
    if (uGray == 1) {
      float g = floor(dot(c.rgb * 255.0, vec3(0.299, 0.587, 0.114)) * c.a + 0.5) / 255.0;
      o = vec4(vec3(g), 1.0);
    } else o = c;
    return;
  }
  vec2 d = uOrg + (vec2(r) + 0.5) / uS - 0.5;
  vec2 f0 = floor(d);
  vec2 t = d - f0;
  ivec2 i0 = ivec2(f0);
  vec4 a = fetchPre(i0);
  vec4 b = fetchPre(i0 + ivec2(1, 0));
  vec4 c = fetchPre(i0 + ivec2(0, 1));
  vec4 e = fetchPre(i0 + ivec2(1, 1));
  vec4 p = mix(mix(a, b, t.x), mix(c, e, t.x), t.y);
  o = toStraight(p);
}`;

/** Podgląd narzędzia (tekstura z mnożeniem alfa) nałożony na zawartość (proste kolory) z trybem mieszania narzędzia. */
const FS_RESAMPLE =
  GL_HEAD +
  BLEND_FN +
  `uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
uniform vec2 uSrcOrg;
uniform vec2 uOrg;
uniform float uS;
uniform int uNear;
uniform ivec4 uCov;
vec4 fetchPre(ivec2 q) {
  q = clamp(q, ivec2(0), uSrcSize - 1);
  vec4 c = texelFetch(uSrc, q, 0);
  return vec4(c.rgb * c.a, c.a);
}
void main() {
  ivec2 r = ivec2(gl_FragCoord.xy);
  if (r.x < uCov.x || r.y < uCov.y || r.x >= uCov.z || r.y >= uCov.w) { o = vec4(0.0); return; }
  vec2 q = uOrg + (vec2(r) + 0.5) / uS - uSrcOrg;
  if (uNear == 1) {
    o = texelFetch(uSrc, clamp(ivec2(floor(q + 0.0001)), ivec2(0), uSrcSize - 1), 0);
    return;
  }
  vec2 t = q - 0.5;
  vec2 f0 = floor(t);
  vec2 w = t - f0;
  ivec2 i0 = ivec2(f0);
  vec4 p = mix(mix(fetchPre(i0), fetchPre(i0 + ivec2(1, 0)), w.x), mix(fetchPre(i0 + ivec2(0, 1)), fetchPre(i0 + ivec2(1, 1)), w.x), w.y);
  o = toStraight(p);
}`;

const FS_PREV =
  GL_HEAD +
  BLEND_FN +
  `uniform sampler2D uDst;
uniform sampler2D uPrev;
uniform ivec4 uPR;
uniform int uMode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 d = texelFetch(uDst, p, 0);
  ivec2 q = p - uPR.xy;
  o = d;
  if (q.x < 0 || q.y < 0 || q.x >= uPR.z || q.y >= uPR.w) return;
  vec4 sp = texelFetch(uPrev, q, 0);
  if (sp.a <= 0.0) return;
  vec4 r = blendOver(vec4(d.rgb * d.a, d.a), toStraight(sp), 1.0, uMode);
  o = toStraight(r);
}`;

/** Maska (skala szarości w RGB, jak grayToAlpha) jako kanał alfa zawartości. */
const FS_MASK =
  GL_HEAD +
  `uniform sampler2D uL;
uniform sampler2D uM;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 l = texelFetch(uL, p, 0);
  vec4 m = texelFetch(uM, p, 0);
  float a = floor(dot(m.rgb * 255.0, vec3(0.299, 0.587, 0.114)) * m.a + 0.5) / 255.0;
  float ra = l.a * a;
  o = ra > 0.0 ? vec4(l.rgb, ra) : vec4(0.0);
}`;

const FS_TO_STRAIGHT =
  GL_HEAD +
  BLEND_FN +
  `uniform sampler2D uAcc;
void main() {
  o = toStraight(texelFetch(uAcc, ivec2(gl_FragCoord.xy), 0));
}`;

const FS_FROM_STRAIGHT =
  GL_HEAD +
  `uniform sampler2D uL;
void main() {
  vec4 c = texelFetch(uL, ivec2(gl_FragCoord.xy), 0);
  o = vec4(c.rgb * c.a, c.a);
}`;

const FS_COMPOSITE =
  GL_HEAD +
  BLEND_FN +
  `uniform sampler2D uAcc;
uniform sampler2D uL;
uniform float uOp;
uniform int uMode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  o = blendOver(texelFetch(uAcc, p, 0), texelFetch(uL, p, 0), uOp, uMode);
}`;

const FS_COPY8 =
  GL_HEAD +
  `uniform sampler2D uL;
void main() { o = texelFetch(uL, ivec2(gl_FragCoord.xy), 0); }`;

/** Wyświetlenie: okno rastra (z mnożeniem alfa) -> płótno widoku (piksele urządzenia). */
const FS_DISPLAY = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uAcc;
uniform ivec2 uWin;
uniform ivec2 uView;
uniform int uKind;
uniform vec4 uMap;
uniform vec4 uDoc;
out vec4 o;
vec4 at(ivec2 q) {
  q = clamp(q, ivec2(0), uWin - 1);
  return texelFetch(uAcc, q, 0);
}
void main() {
  ivec2 sp = ivec2(int(gl_FragCoord.x), uView.y - 1 - int(gl_FragCoord.y));
  // margines okna (filtry, podgląd obiektu wystającego poza płótno) nigdy nie jest pokazywany poza dokumentem
  vec2 pc = vec2(sp) + 0.5;
  if (pc.x < uDoc.x || pc.y < uDoc.y || pc.x >= uDoc.z || pc.y >= uDoc.w) { o = vec4(0.0); return; }
  if (uKind == 2) {
    ivec2 q = sp - ivec2(int(uMap.x), int(uMap.y));
    if (q.x < 0 || q.y < 0 || q.x >= uWin.x || q.y >= uWin.y) { o = vec4(0.0); return; }
    o = texelFetch(uAcc, q, 0);
    return;
  }
  // uMap: (left + eps - ox * z, top + eps - oy * z, zoom, 0)
  vec2 c = (vec2(sp) + 0.5 - uMap.xy) / uMap.z;
  if (c.x < 0.0 || c.y < 0.0 || c.x >= float(uWin.x) || c.y >= float(uWin.y)) { o = vec4(0.0); return; }
  if (uKind == 0) {
    o = texelFetch(uAcc, ivec2(floor(c)), 0);
    return;
  }
  vec2 t = c - 0.5;
  vec2 f0 = floor(t);
  vec2 w = t - f0;
  ivec2 i0 = ivec2(f0);
  o = mix(mix(at(i0), at(i0 + ivec2(1, 0)), w.x), mix(at(i0 + ivec2(0, 1)), at(i0 + ivec2(1, 1)), w.x), w.y);
}`;

// ---------------------------------------------------------------------------------------------------------------
// Pomocnicze
// ---------------------------------------------------------------------------------------------------------------

type Prog = ReturnType<typeof kitProg>;

interface GridTex {
  tex: Tex;
  cols: number;
  rows: number;
  ref: Array<Tile | null>;
  ver: Int32Array;
  has: Uint8Array;
  /** rośnie przy każdej faktycznej zmianie tekstury */
  rev: number;
  used: number;
  bytes: number;
}

interface FxCacheEntry {
  key: string;
  tex: Tex;
  used: number;
}

const bytesOf = (w: number, h: number, bpp: number): number => w * h * bpp;

function gridHasContent(grid: TileGrid): boolean {
  for (const row of grid.tiles) for (const t of row) if (t.hasContent) return true;
  return false;
}

export class GpuComposer {
  private readonly eng: GraphicEngine;
  private g: GL | null = null;
  private grids = new Map<TileGrid, GridTex>();
  private gridBytes = 0;
  private fxCache = new Map<Layer, FxCacheEntry>();
  private fxBytes = 0;
  private pool = new Map<string, Tex>();
  private frame = 0;
  private zeros: Uint8Array | null = null;
  private prevTex: Tex | null = null;
  private vecTex = new Map<string, { tex: Tex; key: string; used: number }>();
  private broken = false;
  /** Statystyki ostatniej klatki (diagnostyka i testy). */
  public lastStats = { layers: 0, uploads: 0, chains: 0, cached: 0, w: 0, h: 0 };

  constructor(engine: GraphicEngine) {
    this.eng = engine;
  }

  /** Czy GPU nadaje się do składania (jest kontekst, nie wyłączono przełącznikiem). */
  public static available(): boolean {
    const f = (globalThis as { __figuraGpuCompose?: boolean }).__figuraGpuCompose;
    if (f === false) return false;
    if (typeof location !== 'undefined' && /[?&]nogpucompose\b/.test(location.search)) return false;
    return !!kitGl();
  }

  public dispose(): void {
    const g = this.g;
    if (g && !g.isContextLost()) {
      for (const gt of this.grids.values()) this.del(g, gt.tex);
      for (const e of this.fxCache.values()) this.del(g, e.tex);
      for (const t of this.pool.values()) this.del(g, t);
      if (this.prevTex) this.del(g, this.prevTex);
      for (const v of this.vecTex.values()) this.del(g, v.tex);
    }
    this.vecTex.clear();
    this.grids.clear();
    this.fxCache.clear();
    this.pool.clear();
    this.prevTex = null;
    this.gridBytes = 0;
    this.fxBytes = 0;
    this.g = null;
  }

  private del(g: GL, t: Tex): void {
    g.deleteTexture(t.t);
    g.deleteFramebuffer(t.fbo);
  }

  private poolTex(g: GL, slot: string, w: number, h: number, fmt: 'rgba8' | 'rgba16f'): Tex {
    let t = this.pool.get(slot);
    if (t && t.w === w && t.h === h) return t;
    if (t) this.del(g, t);
    t = kitMakeTex(g, w, h, fmt);
    this.pool.set(slot, t);
    return t;
  }

  // --- tekstury dokumentu -------------------------------------------------------------------------------------

  private syncGrid(g: GL, grid: TileGrid, x0: number, y0: number, x1: number, y1: number): GridTex | null {
    let gt = this.grids.get(grid);
    if (gt && (gt.tex.w !== grid.width || gt.tex.h !== grid.height || gt.cols !== grid.cols || gt.rows !== grid.rows)) {
      this.del(g, gt.tex);
      this.gridBytes -= gt.bytes;
      this.grids.delete(grid);
      gt = undefined;
    }
    if (!gt) {
      const bytes = bytesOf(grid.width, grid.height, 4);
      if (grid.width > kitMaxTex() || grid.height > kitMaxTex()) return null;
      this.evictFor(g, bytes);
      if (this.gridBytes + bytes > GRID_BUDGET) return null;
      gt = {
        tex: kitMakeTex(g, grid.width, grid.height, 'rgba8'),
        cols: grid.cols,
        rows: grid.rows,
        ref: new Array<Tile | null>(grid.cols * grid.rows).fill(null),
        ver: new Int32Array(grid.cols * grid.rows).fill(-1),
        has: new Uint8Array(grid.cols * grid.rows),
        rev: 0,
        used: this.frame,
        bytes,
      };
      this.grids.set(grid, gt);
      this.gridBytes += bytes;
    }
    gt.used = this.frame;
    const ts = grid.tileSize;
    const tx0 = Math.max(0, Math.floor(x0 / ts));
    const ty0 = Math.max(0, Math.floor(y0 / ts));
    const tx1 = Math.min(grid.cols - 1, Math.floor((x1 - 1) / ts));
    const ty1 = Math.min(grid.rows - 1, Math.floor((y1 - 1) / ts));
    let bound = false;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const idx = ty * grid.cols + tx;
        const tile = grid.tiles[ty][tx];
        const has = tile.hasContent ? 1 : 0;
        if (gt.ref[idx] === tile && gt.ver[idx] === tile.version && gt.has[idx] === has) continue;
        const prevHas = gt.has[idx];
        gt.ref[idx] = tile;
        gt.ver[idx] = tile.version;
        gt.has[idx] = has;
        if (tile.width <= 0 || tile.height <= 0) continue;
        // pusty kafelek na (jeszcze) pustym miejscu tekstury nic nie wymaga
        if (!has && prevHas === 0) continue;
        if (!bound) {
          g.bindTexture(g.TEXTURE_2D, gt.tex.t);
          g.pixelStorei(g.UNPACK_ALIGNMENT, 1);
          g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
          g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
          bound = true;
        }
        if (has) {
          const img = tile.ctx.getImageData(0, 0, tile.width, tile.height);
          g.texSubImage2D(g.TEXTURE_2D, 0, tile.pixelX, tile.pixelY, tile.width, tile.height, g.RGBA, g.UNSIGNED_BYTE, img.data);
        } else {
          const n = tile.width * tile.height * 4;
          if (!this.zeros || this.zeros.length < n) this.zeros = new Uint8Array(Math.max(n, ts * ts * 4));
          g.texSubImage2D(g.TEXTURE_2D, 0, tile.pixelX, tile.pixelY, tile.width, tile.height, g.RGBA, g.UNSIGNED_BYTE, this.zeros.subarray(0, n));
        }
        gt.rev++;
        this.lastStats.uploads++;
      }
    }
    return gt;
  }

  private evictFor(g: GL, need: number): void {
    if (this.gridBytes + need <= GRID_BUDGET) return;
    const old = [...this.grids.entries()].filter(([, v]) => v.used < this.frame).sort((a, b) => a[1].used - b[1].used);
    for (const [k, v] of old) {
      if (this.gridBytes + need <= GRID_BUDGET) break;
      this.del(g, v.tex);
      this.gridBytes -= v.bytes;
      this.grids.delete(k);
    }
  }

  private prune(g: GL): void {
    for (const [k, v] of this.grids) {
      if (this.frame - v.used > 240) {
        this.del(g, v.tex);
        this.gridBytes -= v.bytes;
        this.grids.delete(k);
      }
    }
    for (const [k, v] of this.vecTex) {
      if (this.frame - v.used > 240) {
        this.del(g, v.tex);
        this.vecTex.delete(k);
      }
    }
    for (const [k, v] of this.fxCache) {
      if (this.frame - v.used > 240) {
        this.del(g, v.tex);
        this.fxBytes -= bytesOf(v.tex.w, v.tex.h, 4);
        this.fxCache.delete(k);
      }
    }
  }

  /** Tekstura warstwy wektorowej (lub jej maski) w oknie rastra; wgrywana ponownie tylko przy zmianie klucza. */
  private vecTexFor(g: GL, layer: Layer, slot: 'l' | 'm', key: string, W: number, H: number, make: () => HTMLCanvasElement | null): Tex | null {
    const id = `${layer.id}:${slot}`;
    let e = this.vecTex.get(id);
    if (e && e.tex.w === W && e.tex.h === H && e.key === key) {
      e.used = this.frame;
      return e.tex;
    }
    const cv = make();
    if (!cv || cv.width !== W || cv.height !== H) return null;
    if (e && (e.tex.w !== W || e.tex.h !== H)) {
      this.del(g, e.tex);
      this.vecTex.delete(id);
      e = undefined;
    }
    if (!e) {
      e = { tex: kitMakeTex(g, W, H, 'rgba8'), key, used: this.frame };
      this.vecTex.set(id, e);
    }
    g.bindTexture(g.TEXTURE_2D, e.tex.t);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, g.RGBA, g.UNSIGNED_BYTE, cv);
    e.key = key;
    e.used = this.frame;
    this.lastStats.uploads++;
    return e.tex;
  }

  // --- przebiegi ------------------------------------------------------------------------------------------------

  private pr(g: GL, name: string, fs: string): Prog {
    return kitProg(g, name, fs);
  }

  private u1i(g: GL, p: Prog, n: string, v: number): void {
    g.uniform1i(kitUni(g, p, n), v);
  }
  private u1f(g: GL, p: Prog, n: string, v: number): void {
    g.uniform1f(kitUni(g, p, n), v);
  }

  private passSample(g: GL, gt: GridTex, dst: Tex, win: GpuWindow, gray: boolean, docW: number, docH: number, near = false): void {
    const p = this.pr(g, 'gc_sample', FS_SAMPLE);
    const s = win.s;
    // prostokąt rastra zajmowany przez dokument (zaokrąglony jak w drawLayerTiles)
    const cx0 = Math.round((0 - win.ox) * s);
    const cy0 = Math.round((0 - win.oy) * s);
    const cx1 = Math.round((docW - win.ox) * s);
    const cy1 = Math.round((docH - win.oy) * s);
    kitPass(g, p, dst, win.W, win.H, () => {
      kitBind(g, 0, gt.tex);
      this.u1i(g, p, 'uSrc', 0);
      g.uniform2i(kitUni(g, p, 'uDoc'), docW, docH);
      g.uniform2f(kitUni(g, p, 'uOrg'), win.ox, win.oy);
      this.u1f(g, p, 'uS', s);
      this.u1i(g, p, 'uGray', gray ? 1 : 0);
      this.u1i(g, p, 'uNear', near ? 1 : 0);
      g.uniform4i(kitUni(g, p, 'uCov'), cx0, cy0, cx1, cy1);
    });
  }

  private passPrev(g: GL, dst: Tex, out: Tex, win: GpuWindow, pr: { x: number; y: number; w: number; h: number }, mode: number): void {
    const p = this.pr(g, 'gc_prev', FS_PREV);
    kitPass(g, p, out, win.W, win.H, () => {
      kitBind(g, 0, dst);
      kitBind(g, 1, this.prevTex!);
      this.u1i(g, p, 'uDst', 0);
      this.u1i(g, p, 'uPrev', 1);
      g.uniform4i(kitUni(g, p, 'uPR'), pr.x, pr.y, pr.w, pr.h);
      this.u1i(g, p, 'uMode', mode);
    });
  }

  private passMask(g: GL, l: Tex, m: Tex, out: Tex, win: GpuWindow): void {
    const p = this.pr(g, 'gc_mask', FS_MASK);
    kitPass(g, p, out, win.W, win.H, () => {
      kitBind(g, 0, l);
      kitBind(g, 1, m);
      this.u1i(g, p, 'uL', 0);
      this.u1i(g, p, 'uM', 1);
    });
  }

  private passTwo(g: GL, name: string, fs: string, src: Tex, out: Tex, win: GpuWindow, uname: string): void {
    const p = this.pr(g, name, fs);
    kitPass(g, p, out, win.W, win.H, () => {
      kitBind(g, 0, src);
      this.u1i(g, p, uname, 0);
    });
  }

  private passComposite(g: GL, acc: Tex, l: Tex, out: Tex, win: GpuWindow, opacity: number, mode: number): void {
    const p = this.pr(g, 'gc_comp', FS_COMPOSITE);
    kitPass(g, p, out, win.W, win.H, () => {
      kitBind(g, 0, acc);
      kitBind(g, 1, l);
      this.u1i(g, p, 'uAcc', 0);
      this.u1i(g, p, 'uL', 1);
      this.u1f(g, p, 'uOp', opacity);
      this.u1i(g, p, 'uMode', mode);
    });
  }

  /** Łańcuch efektów warstwy na teksturze `src` (RGBA8, proste kolory); wynik w teksturze puli sesji GPU albo null. */
  /**
   * Tryb Wektory: efekty (filtry, stylizacje i cały łańcuch korekcji) zwykłej warstwy rastrowej liczone są w pikselach
   * dokumentu - tak samo jak w trybie Piksele - a dopiero wynik jest skalowany do okna widoku (ostre piksele przy dużym
   * powiększeniu). Zwraca teksturę okna widoku albo null, gdy się nie da (wtedy działa nakładka 2D).
   */
  private docResChain(g: GL, layer: Layer, win: GpuWindow, gp: GridTex, gm: GridTex | null, gray: boolean): Tex | null {
    const docW = this.eng.width;
    const docH = this.eng.height;
    const m = Math.min(1500, Math.ceil(layer.filterMargin));
    const ax0 = Math.max(0, Math.floor(win.ox));
    const ay0 = Math.max(0, Math.floor(win.oy));
    const ax1 = Math.min(docW, Math.ceil(win.ox + win.W / win.s));
    const ay1 = Math.min(docH, Math.ceil(win.oy + win.H / win.s));
    if (ax1 <= ax0 || ay1 <= ay0) return this.poolTex(g, 't5', win.W, win.H, 'rgba8');
    const W2 = ax1 - ax0 + 2 * m;
    const H2 = ay1 - ay0 + 2 * m;
    if (W2 * H2 > MAX_WIN_PX || W2 > kitMaxTex() || H2 > kitMaxTex()) return null;
    if (!layer.gpuChainFits(W2, H2, 1)) return null;
    const win2: GpuWindow = { ox: ax0 - m, oy: ay0 - m, s: 1, W: W2, H: H2, M: m };
    const d1 = this.poolTex(g, 'd1', W2, H2, 'rgba8');
    const d2 = this.poolTex(g, 'd2', W2, H2, 'rgba8');
    const d3 = this.poolTex(g, 'd3', W2, H2, 'rgba8');
    this.passSample(g, gp, d1, win2, gray, docW, docH, false);
    let cur2 = d1;
    if (gm) {
      this.passSample(g, gm, d2, win2, false, docW, docH, false);
      this.passMask(g, d1, d2, d3, win2);
      cur2 = d3;
    }
    const out = this.runChain(layer, cur2, win2);
    if (!out) return null;
    const dst = this.poolTex(g, 't5', win.W, win.H, 'rgba8');
    const p = this.pr(g, 'gc_resample', FS_RESAMPLE);
    const cx0 = Math.round((0 - win.ox) * win.s);
    const cy0 = Math.round((0 - win.oy) * win.s);
    const cx1 = Math.round((docW - win.ox) * win.s);
    const cy1 = Math.round((docH - win.oy) * win.s);
    kitPass(g, p, dst, win.W, win.H, () => {
      kitBind(g, 0, out);
      this.u1i(g, p, 'uSrc', 0);
      g.uniform2i(kitUni(g, p, 'uSrcSize'), W2, H2);
      g.uniform2f(kitUni(g, p, 'uSrcOrg'), win2.ox, win2.oy);
      g.uniform2f(kitUni(g, p, 'uOrg'), win.ox, win.oy);
      this.u1f(g, p, 'uS', win.s);
      this.u1i(g, p, 'uNear', win.s >= 2 ? 1 : 0);
      g.uniform4i(kitUni(g, p, 'uCov'), cx0, cy0, cx1, cy1);
    });
    return dst;
  }

  private runChain(layer: Layer, src: Tex, win: GpuWindow): Tex | null {
    if (!gpuSessionBeginTex(src, win.W, win.H)) return null;
    const docW = this.eng.width;
    const docH = this.eng.height;
    const fx: FxContext = {
      scale: win.s,
      docX0: win.ox,
      docY0: win.oy,
      docW,
      docH,
      bounds: { x0: -win.ox * win.s, y0: -win.oy * win.s, x1: (docW - win.ox) * win.s, y1: (docH - win.oy) * win.s },
    };
    const ok = layer.runChainGpu(win.W, win.H, fx);
    const out = gpuSessionEndTex();
    this.lastStats.chains++;
    return ok && out ? out : null;
  }

  // --- składanie ------------------------------------------------------------------------------------------------

  /**
   * Składa widok. Zwraca płótno WebGL (rozmiar widoku) z wynikiem albo null, gdy tej konfiguracji nie obsługujemy.
   * Wynik trzeba skopiować (drawImage) w tym samym zadaniu.
   */
  public compose(view: GpuView, preview: GpuPreviewSource | null, crisp: GpuCrispSource | null = null): HTMLCanvasElement | null {
    if (this.broken) return null;
    const g = kitGl();
    if (!g) return null;
    if (this.g !== g) {
      this.dispose();
      this.g = g;
    }
    try {
      return this.composeImpl(g, view, preview, crisp);
    } catch (e) {
      console.warn('GpuCompose', e);
      this.broken = true;
      return null;
    }
  }

  private composeImpl(g: GL, view: GpuView, preview: GpuPreviewSource | null, crisp: GpuCrispSource | null): HTMLCanvasElement | null {
    const eng = this.eng;
    this.frame++;
    this.lastStats = { layers: 0, uploads: 0, chains: 0, cached: 0, w: 0, h: 0 };
    if (g.isContextLost()) return null;
    // tryb Wektory składa grupy izolowane w osobnym buforze (patrz crispRenderList); poza nim grupy obsługuje kompozytor CPU
    const cl = crisp && !eng.maskView ? eng.crispRenderList : null;
    if (crisp && !eng.maskView && !cl) return null;
    if (!cl && (eng.renderIsolation || eng.renderHasPass)) return null;
    if (eng.transformContentSession?.other) return null;
    const docW = eng.width;
    const docH = eng.height;
    if (docW > kitMaxTex() || docH > kitMaxTex()) return null;
    const layers = cl ? cl.layers : eng.renderLayers;
    const act = cl ? cl.active : eng.renderActiveIndex;
    const groupEnds = cl ? cl.groupEnds : null;
    const groupStarts = new Map<number, number>(); // indeks pierwszego dziecka -> indeks nagłówka
    if (groupEnds) for (const [h, f] of groupEnds) groupStarts.set(f, h);
    const z = view.zoom;

    // --- okno rastra ---
    let s: number;
    let ox: number;
    let oy: number;
    let rw: number;
    let rh: number;
    let offX = 0;
    let offY = 0;
    if (z >= 1 && !crisp) {
      s = 1;
      const x0 = Math.max(0, Math.floor(-view.left / z) - 1);
      const y0 = Math.max(0, Math.floor(-view.top / z) - 1);
      const x1 = Math.min(docW, Math.ceil((view.width - view.left) / z) + 1);
      const y1 = Math.min(docH, Math.ceil((view.height - view.top) / z) + 1);
      ox = x0;
      oy = y0;
      rw = x1 - x0;
      rh = y1 - y0;
    } else if (crisp) {
      // Tryb Wektory: okno rastra jest wyrównane do siatki CRISP_SNAP px (we współrzędnych dokumentu w skali widoku), więc przy
      // przesuwaniu widoku zmienia się dopiero co CRISP_SNAP px, a nie co piksel. Dzięki temu tekstury warstw wektorowych
      // i wyniki efektów (klucze zawierają położenie okna) są ponownie używane z pamięci podręcznej, a klatka przesunięcia
      // kosztuje tylko złożenie gotowych tekstur i wyświetlenie.
      s = z;
      const left = Math.round(view.left);
      const top = Math.round(view.top);
      const docDW = Math.ceil(docW * z);
      const docDH = Math.ceil(docH * z);
      const vx0 = Math.max(0, -left);
      const vy0 = Math.max(0, -top);
      const vx1 = Math.min(docDW, view.width - left);
      const vy1 = Math.min(docDH, view.height - top);
      if (vx1 <= vx0 || vy1 <= vy0) {
        ox = oy = 0;
        rw = rh = 0;
      } else {
        const sx0 = Math.floor(vx0 / CRISP_SNAP) * CRISP_SNAP;
        const sy0 = Math.floor(vy0 / CRISP_SNAP) * CRISP_SNAP;
        const sx1 = Math.min(docDW, Math.ceil(vx1 / CRISP_SNAP) * CRISP_SNAP);
        const sy1 = Math.min(docDH, Math.ceil(vy1 / CRISP_SNAP) * CRISP_SNAP);
        ox = sx0 / z;
        oy = sy0 / z;
        rw = sx1 - sx0;
        rh = sy1 - sy0;
        offX = left + sx0;
        offY = top + sy0;
      }
    } else {
      s = z;
      const cx0 = Math.max(0, Math.floor(view.left));
      const cy0 = Math.max(0, Math.floor(view.top));
      const cx1 = Math.min(view.width, Math.ceil(view.left + docW * z));
      const cy1 = Math.min(view.height, Math.ceil(view.top + docH * z));
      ox = (cx0 - view.left) / z;
      oy = (cy0 - view.top) / z;
      rw = cx1 - cx0;
      rh = cy1 - cy0;
      offX = cx0;
      offY = cy0;
    }
    const glc = g.canvas as HTMLCanvasElement;
    if (glc.width !== view.width || glc.height !== view.height) {
      glc.width = view.width;
      glc.height = view.height;
    }
    if (rw <= 0 || rh <= 0) {
      g.bindFramebuffer(g.FRAMEBUFFER, null);
      g.viewport(0, 0, view.width, view.height);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      return glc;
    }

    // --- margines filtrów: filtry korekcji samodzielnych sumują się, a własny łańcuch warstwy dokłada największy ---
    let adjSum = 0;
    let maxOwn = 0;
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (!l.hasActiveFilters) continue;
      if (l.isAdjustment ? !l.adjustmentActive : !(l.isGroup ? l.ownVisible : l.visible) || l.opacity <= 0) continue;
      if (crisp && !l.isAdjustment && !l.isVector && !l.isGroup) continue; // efekty rastra liczone w pikselach dokumentu (docResChain)
      const m = Math.ceil(l.filterMargin * s);
      if (l.isAdjustment) adjSum += m;
      else maxOwn = Math.max(maxOwn, m);
    }
    const M = Math.min(1500, adjSum + maxOwn);
    const W = rw + 2 * M;
    const H = rh + 2 * M;
    if (W * H > MAX_WIN_PX || W > kitMaxTex() || H > kitMaxTex()) return null;
    const win: GpuWindow = { ox: ox - M / s, oy: oy - M / s, s, W, H, M };
    this.lastStats.w = W;
    this.lastStats.h = H;

    // --- czy cały stos da się policzyć na GPU ---
    for (let i = 0; i < layers.length; i++) {
      const l = layers[i];
      if (l.isAdjustment ? !l.adjustmentActive : !(l.isGroup ? l.ownVisible : l.visible) || l.opacity <= 0) continue;
      if (crisp && !l.isAdjustment && !l.isVector && !l.isGroup && l.hasActiveFilters) continue; // sprawdza docResChain
      if (!l.gpuChainFits(W, H, s)) return null;
    }

    // --- tekstury robocze ---
    let acc = this.poolTex(g, 'accA', W, H, 'rgba16f');
    let alt = this.poolTex(g, 'accB', W, H, 'rgba16f');
    const t1 = this.poolTex(g, 't1', W, H, 'rgba8');
    const t2 = this.poolTex(g, 't2', W, H, 'rgba8');
    const t3 = this.poolTex(g, 't3', W, H, 'rgba8');
    const t4 = this.poolTex(g, 't4', W, H, 'rgba8');
    g.bindFramebuffer(g.FRAMEBUFFER, acc.fbo);
    g.viewport(0, 0, W, H);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);

    // zakres dokumentu potrzebny do próbkowania (z zapasem na filtr dwuliniowy)
    const dx0 = Math.max(0, Math.floor(win.ox) - 2);
    const dy0 = Math.max(0, Math.floor(win.oy) - 2);
    const dx1 = Math.min(docW, Math.ceil(win.ox + W / s) + 2);
    const dy1 = Math.min(docH, Math.ceil(win.oy + H / s) + 2);
    const wkey = `${win.ox}|${win.oy}|${s}|${W}|${H}`;

    // --- podgląd narzędzia: rasteryzacja do obszaru okna + wgranie ---
    let prevRect: { x: number; y: number; w: number; h: number } | null = null;
    const loadPreview = (): boolean => {
      if (!preview) return false;
      if (prevRect) return true;
      let rect: { x0: number; y0: number; x1: number; y1: number } | null = null;
      if (preview.bounds) {
        const b = preview.bounds;
        rect = {
          x0: Math.max(0, Math.floor((b.left - win.ox) * s)),
          y0: Math.max(0, Math.floor((b.top - win.oy) * s)),
          x1: Math.min(W, Math.ceil((b.right - win.ox) * s)),
          y1: Math.min(H, Math.ceil((b.bottom - win.oy) * s)),
        };
        if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return false;
      }
      const pr = preview.rasterize(win, rect);
      if (!pr) return false;
      const cv = pr.canvas;
      if (cv.width <= 0 || cv.height <= 0) return false;
      if (!this.prevTex || this.prevTex.w !== cv.width || this.prevTex.h !== cv.height) {
        if (this.prevTex) this.del(g, this.prevTex);
        this.prevTex = kitMakeTex(g, cv.width, cv.height, 'rgba8');
      }
      g.bindTexture(g.TEXTURE_2D, this.prevTex.t);
      g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0);
      g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, g.RGBA, g.UNSIGNED_BYTE, cv);
      g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
      prevRect = { x: pr.x, y: pr.y, w: cv.width, h: cv.height };
      return true;
    };

    const swapAcc = (): void => {
      const t = acc;
      acc = alt;
      alt = t;
    };

    // bufory grupy izolowanej: dzieci składają się w osobnej parze akumulatorów, nagłówek nakłada wynik na stos zewnętrzny
    let outerAcc: Tex | null = null;
    let outerAlt: Tex | null = null;
    let openHeader = -1;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const startsFor = groupStarts.get(i);
      if (startsFor !== undefined && openHeader < 0) {
        const gh = layers[startsFor];
        if (gh.ownVisible && gh.opacity > 0) {
          outerAcc = acc;
          outerAlt = alt;
          acc = this.poolTex(g, 'grpA', W, H, 'rgba16f');
          alt = this.poolTex(g, 'grpB', W, H, 'rgba16f');
          g.bindFramebuffer(g.FRAMEBUFFER, acc.fbo);
          g.viewport(0, 0, W, H);
          g.clearColor(0, 0, 0, 0);
          g.clear(g.COLOR_BUFFER_BIT);
          openHeader = startsFor;
        } else {
          i = startsFor; // ukryta grupa: pomijamy dzieci i nagłówek
          continue;
        }
      }
      if (i === openHeader) {
        // nagłówek grupy izolowanej: bufor dzieci -> maska grupy -> korekcje grupy -> nałożenie z jej krytem i trybem
        const grpAcc = acc;
        acc = outerAcc!;
        alt = outerAlt!;
        openHeader = -1;
        this.passTwo(g, 'gc_tostr', FS_TO_STRAIGHT, grpAcc, t1, win, 'uAcc');
        let gcur: Tex = t1;
        const gmg = layer.maskGrid;
        if (gmg && layer.maskEnabled) {
          const gmt = this.syncGrid(g, gmg, dx0, dy0, dx1, dy1);
          if (!gmt) return null;
          this.passSample(g, gmt, t3, win, false, docW, docH, !!crisp && s >= 2);
          this.passMask(g, gcur, t3, t4, win);
          gcur = t4;
        }
        if (layer.hasActiveCorrections) {
          const out = this.runChain(layer, gcur, win);
          if (!out) return null;
          gcur = out;
        }
        this.passComposite(g, acc, gcur, alt, win, layer.opacity, modeId(layer.blendMode));
        swapAcc();
        continue;
      }
      if (layer.isAdjustment) {
        if (!layer.adjustmentActive) continue;
        this.passTwo(g, 'gc_tostr', FS_TO_STRAIGHT, acc, t1, win, 'uAcc');
        const out = this.runChain(layer, t1, win);
        if (!out) return null;
        this.passTwo(g, 'gc_fromstr', FS_FROM_STRAIGHT, out, acc, win, 'uL');
        continue;
      }
      if (!layer.visible || layer.opacity <= 0) continue;
      this.lastStats.layers++;
      const isActive = i === act;
      const grid = layer.pixelGrid;
      if (grid.width !== docW || grid.height !== docH) return null;
      const gray = layer.grayView;
      const mg = layer.maskGrid;
      const hasMask = !!mg && layer.maskEnabled && !gray;
      const editingMask = isActive && layer.editMask && hasMask;
      const maskedPixels = isActive && !editingMask && hasMask;
      const corr = layer.hasActiveCorrections;
      const withPreview = isActive && !!preview;

      // tryb Wektory: pusta zwykła warstwa rastrowa (bez efektów i maski) niczego nie zmienia - oszczędzamy jej przebiegi
      if (crisp && !layer.isVector && !corr && !hasMask && !withPreview && !gray && !gridHasContent(grid)) continue;

      // warstwa wektorowa w trybie Wektory: ostra tekstura w skali okna zamiast kafelków dokumentu
      const vecCrisp = !!crisp && layer.isVector && crisp.vector(layer) && !gray && !editingMask;
      const near = !!crisp && s >= 2;
      // zwykła warstwa rastrowa z filtrami / stylizacjami: cały łańcuch efektów w pikselach dokumentu, jak w trybie Piksele
      const docRes = !!crisp && !layer.isVector && layer.hasActiveFilters && !editingMask && !withPreview && !gray;
      let vk = '';
      let vtex: Tex | null = null;
      let vmask: Tex | null = null;
      let gp: GridTex | null = null;
      let gm: GridTex | null = null;
      if (vecCrisp) {
        vk = `${wkey}|${crisp!.key(layer)}`;
        vtex = this.vecTexFor(g, layer, 'l', vk, W, H, () => crisp!.raster(layer, win, 'layer'));
        if (!vtex) return null;
        if (hasMask) {
          vmask = this.vecTexFor(g, layer, 'm', vk, W, H, () => crisp!.raster(layer, win, 'mask'));
          if (!vmask) return null;
        }
      } else {
        gp = this.syncGrid(g, grid, dx0, dy0, dx1, dy1);
        if (!gp) return null;
        if (hasMask) {
          gm = this.syncGrid(g, mg!, dx0, dy0, dx1, dy1);
          if (!gm) return null;
        }
      }

      // nieaktywna warstwa z efektami: wynik w pamięci podręcznej (zmienia się tylko przy zmianie warstwy albo widoku)
      let fxKey = '';
      // aktywna warstwa też trafia do pamięci podręcznej, gdy w trybie Wektory nie ma na niej podglądu narzędzia: jej treść
      // (wersje tekstur, klucz obiektów, sesja na żywo) i korekcje są w kluczu, więc nie przeliczamy efektów przy każdym przesunięciu
      if ((!isActive || (!!crisp && !withPreview && !editingMask)) && corr) {
        fxKey = `${vecCrisp ? vk : gp!.rev}|${gm ? gm.rev : '-'}|${layer.correctionsSignature}|${wkey}|${gray ? 1 : 0}`;
        const hit = this.fxCache.get(layer);
        if (hit && hit.key === fxKey && hit.tex.w === W && hit.tex.h === H) {
          hit.used = this.frame;
          this.lastStats.cached++;
          this.passComposite(g, acc, hit.tex, alt, win, layer.opacity, modeId(layer.blendMode));
          swapAcc();
          continue;
        }
      }

      let cur: Tex;
      let chained: Tex | null = null;
      if (docRes) {
        chained = this.docResChain(g, layer, win, gp!, hasMask ? gm : null, gray);
        if (!chained) return null;
        cur = chained;
      } else if (vecCrisp) cur = vtex!;
      else {
        this.passSample(g, gp!, t1, win, gray, docW, docH, near);
        cur = t1;
      }
      if (docRes) {
        // maska i efekty już uwzględnione
      } else if (editingMask && gm) {
        // podgląd narzędzia nanoszony na MASKĘ, a dopiero ona (jako alfa) na piksele warstwy
        this.passSample(g, gm, t2, win, false, docW, docH, near);
        let mt = t2;
        if (withPreview && loadPreview()) {
          this.passPrev(g, t2, t3, win, prevRect!, modeId(preview!.blendMode));
          mt = t3;
        }
        this.passMask(g, t1, mt, t4, win);
        cur = t4;
      } else {
        if (withPreview && loadPreview()) {
          this.passPrev(g, cur, t2, win, prevRect!, modeId(preview!.blendMode));
          cur = t2;
        }
        if (hasMask && (gm || vmask)) {
          let mt: Tex;
          if (vmask) mt = vmask;
          else {
            this.passSample(g, gm!, t3, win, false, docW, docH, near);
            mt = t3;
          }
          this.passMask(g, cur, mt, t4, win);
          cur = t4;
        }
      }
      void maskedPixels;

      if (corr) {
        const out = docRes ? chained : this.runChain(layer, cur, win);
        if (!out) return null;
        if (fxKey && this.fxBytes + bytesOf(W, H, 4) <= FX_CACHE_BUDGET) {
          let e = this.fxCache.get(layer);
          if (!e || e.tex.w !== W || e.tex.h !== H) {
            if (e) {
              this.del(g, e.tex);
              this.fxBytes -= bytesOf(e.tex.w, e.tex.h, 4);
            }
            e = { key: fxKey, tex: kitMakeTex(g, W, H, 'rgba8'), used: this.frame };
            this.fxCache.set(layer, e);
            this.fxBytes += bytesOf(W, H, 4);
          }
          this.passTwo(g, 'gc_copy8', FS_COPY8, out, e.tex, win, 'uL');
          e.key = fxKey;
          e.used = this.frame;
          cur = e.tex;
        } else cur = out;
      }

      this.passComposite(g, acc, cur, alt, win, layer.opacity, modeId(layer.blendMode));
      swapAcc();
    }

    // --- wyświetlenie ---
    const dp = this.pr(g, 'gc_display', FS_DISPLAY);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    g.viewport(0, 0, view.width, view.height);
    g.disable(g.BLEND);
    g.useProgram(dp.p);
    kitBind(g, 0, acc);
    this.u1i(g, dp, 'uAcc', 0);
    g.uniform2i(kitUni(g, dp, 'uWin'), W, H);
    g.uniform2i(kitUni(g, dp, 'uView'), view.width, view.height);
    g.uniform4f(kitUni(g, dp, 'uDoc'), view.left, view.top, view.left + docW * z, view.top + docH * z);
    if (z >= 1 && !crisp) {
      this.u1i(g, dp, 'uKind', z < 2 ? 1 : 0);
      g.uniform4f(kitUni(g, dp, 'uMap'), view.left + TIE_EPS + win.ox * z, view.top + TIE_EPS + win.oy * z, z, 0);
    } else {
      this.u1i(g, dp, 'uKind', 2);
      g.uniform4f(kitUni(g, dp, 'uMap'), offX - M, offY - M, 1, 0);
    }
    g.drawArrays(g.TRIANGLES, 0, 3);
    if (this.frame % 60 === 0) this.prune(g);
    return glc;
  }
}
