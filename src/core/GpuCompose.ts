/**
 * GpuCompose - kompozytor podglądu edycji na GPU (WebGL2).
 *
 * Składa warstwy dokumentu (piksele, maski, korekcje, filtry, stylizacje, tryby mieszania, krycie, korekcje samodzielne)
 * wraz z podglądem narzędzia (figura, linia, krzywa, gradient, wiadro, przekształcanie) w jednym przebiegu na karcie
 * graficznej i pokazuje wynik bez odczytu z GPU. Zastępuje kafelkowe składanie na procesorze, które przy podglądzie na
 * warstwie leżącej niżej (pod innymi warstwami, z efektami / trybami mieszania) musiało odtwarzać kafelki.
 *
 * Odwzorowuje `ViewportTileRenderer.composeWindowRaw` krok po kroku: okno rastra (skala s: dokument -> raster x_r = (x - ox) * s),
 * ten sam podział na „piksele -> podgląd -> maska -> korekcje -> krycie / tryb”, te same łańcuchy efektów (GpuFx / GpuStyles
 * w sesji bez odczytu). Zwraca `null`, gdy czegoś nie umie (grupy izolowane, „Przepuszczanie”, szum / pikselizacja / ziarno
 * filmowe, zbyt duże okno, brak GPU) - wtedy działa ścieżka procesorowa.
 *
 * Piksele warstw (RGBA8, proste kolory = to samo co `getImageData`) leżą w jednej wspólnej puli kafelków (GpuTilePool):
 * slot dostaje wyłącznie kafelek z treścią, a warstwa zna swoje sloty przez małą tablicę stron. Pamięć GPU rośnie więc
 * z zamalowanym obszarem, nie z liczbą warstw ani rozmiarem płótna. Pula jest wspólna dla wszystkich klatek i aktualizowana
 * przyrostowo (tylko kafelki, których wersja się zmieniła, i tylko w widocznym oknie); gdy się zapełni, wypierane są
 * najdawniej używane kafelki spoza bieżącej klatki. Warstwy bez żadnej treści w oknie nie kosztują ani przebiegu, ani pamięci.
 *
 * Edycja „na żywo” obiektu leżącego pod innymi obiektami warstwy wektorowej (`composeLiveLayer`): piksele warstwy nie są
 * w ogóle przebudowywane. Warstwa jest składana na GPU z segmentów stosu `CpuStack` (dół, ciągi zwykłych obiektów nad
 * edytowanym, obiekty z własnym trybem mieszania), wgranych raz na sesję w kawałkach 512 px, oraz z żywego podglądu
 * edytowanego obiektu wstawianego na jego miejsce w kolejności - tą samą drogą (rasteryzacja okna + `passPrev`), którą
 * idzie obiekt leżący na wierzchu. Koszt klatki nie zależy od liczby obiektów ani od ich trybów mieszania.
 */

import type { GraphicEngine } from './GraphicEngine.ts';
import type { Layer } from './Layer.ts';
import type { TileGrid } from './TileGrid.ts';
import { SparseSurface, TilePool } from './GpuTilePool.ts';
import type { SKBlendMode, SKRectI } from './types.ts';
import type { FxContext } from './Filters.ts';
import { STACK_CHUNK, type CpuStack } from './VectorStackCache.ts';
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
/** Limit pamięci podręcznej wyników efektów (tekstury wielkości okna), w bajtach. Pamięć warstw reguluje pula kafelków. */
const FX_CACHE_BUDGET = 420 * 1024 * 1024;
/** Minimalne przesunięcie siatki próbkowania (jak TIE_EPS w ViewportTileRenderer: ten sam piksel wygrywa w obu ścieżkach). */
const TIE_EPS = 0.002;
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

/**
 * Próbkowanie warstwy do okna rastra (RGBA8, proste kolory). Warstwa jest powierzchnią rzadką (patrz GpuTilePool):
 * `srcTexel(q)` pobiera piksel powierzchni przez tablicę stron, a brakujący kafelek daje przezroczystość.
 */
const SAMPLE_BODY = `uniform ivec2 uDoc;
uniform vec2 uOrg;
uniform float uS;
uniform int uGray;
uniform ivec4 uCov;
vec4 fetchPre(ivec2 q) {
  q = clamp(q, ivec2(0), uDoc - 1);
  vec4 c = srcTexel(q);
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
    vec4 c = srcTexel(q);
    if (uGray == 1) {
      float g = floor(dot(c.rgb * 255.0, vec3(0.299, 0.587, 0.114)) * c.a + 0.5) / 255.0;
      o = vec4(vec3(g), 1.0);
    } else o = c;
    return;
  }
  if (r.x < uCov.x || r.y < uCov.y || r.x >= uCov.z || r.y >= uCov.w) { o = vec4(0.0); return; }
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

/** Pełny shader próbkowania dla danej puli (liczba kawałków atlasu i rozmiar kafelka są jego stałymi). */
export const sparseSampleShader = (pool: TilePool): string => GL_HEAD + BLEND_FN + pool.glsl() + SAMPLE_BODY;

/** Podgląd narzędzia (tekstura z mnożeniem alfa) nałożony na zawartość (proste kolory) z trybem mieszania narzędzia. */
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

/** Zawartość w prostych kolorach (RGBA8) nałożona na inną zawartość w prostych kolorach z trybem mieszania (obiekty w obrębie warstwy). */
const FS_BLEND_ST =
  GL_HEAD +
  BLEND_FN +
  `uniform sampler2D uDst;
uniform sampler2D uSrc;
uniform int uMode;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 d = texelFetch(uDst, p, 0);
  vec4 sp = texelFetch(uSrc, p, 0);
  o = d;
  if (sp.a <= 0.0 && uMode != 12) return;
  vec4 r = blendOver(vec4(d.rgb * d.a, d.a), sp, 1.0, uMode);
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

/** Segment stosu edycji „na żywo” na GPU: powierzchnia rzadka (przypięta w puli) wypełniana leniwie kawałkami STACK_CHUNK. */
interface LiveSegTex {
  surf: SparseSurface;
  cols: number;
  rows: number;
  /** kawałek został już zbudowany i wgrany (albo okazał się pusty) */
  loaded: Uint8Array;
  /** kawałek ma zawartość */
  has: Uint8Array;
}

interface LiveState {
  segs: Map<number, LiveSegTex>;
  used: number;
}

/** Największa liczba osobnych tekstur segmentów jednej edycji (dół + segmenty); powyżej działa zwykła przebudowa pikseli. */
const LIVE_MAX_SEGS = 8;

interface FxCacheEntry {
  key: string;
  tex: Tex;
  used: number;
}

const bytesOf = (w: number, h: number, bpp: number): number => w * h * bpp;

export class GpuComposer {
  private readonly eng: GraphicEngine;
  private g: GL | null = null;
  /** Warstwy i maski jako powierzchnie rzadkie w wspólnej puli kafelków (osobna pula na rozmiar kafelka). */
  private grids = new Map<TileGrid, SparseSurface>();
  private tilePools = new Map<number, TilePool>();
  private fxCache = new Map<Layer, FxCacheEntry>();
  private fxBytes = 0;
  private pool = new Map<string, Tex>();
  private frame = 0;
  private prevTex: Tex | null = null;
  private liveStates = new Map<CpuStack, LiveState>();
  private broken = false;
  /** Statystyki ostatniej klatki (diagnostyka i testy). `slots` / `atlasMiB` opisują wspólną pulę kafelków. */
  public lastStats = { layers: 0, uploads: 0, chains: 0, cached: 0, w: 0, h: 0, skipped: 0, slots: 0, atlasMiB: 0 };

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
      for (const sf of this.grids.values()) if (sf.ptTex) g.deleteTexture(sf.ptTex);
      for (const st of this.liveStates.values()) for (const sg of st.segs.values()) if (sg.surf.ptTex) g.deleteTexture(sg.surf.ptTex);
      for (const e of this.fxCache.values()) this.del(g, e.tex);
      for (const t of this.pool.values()) this.del(g, t);
      if (this.prevTex) this.del(g, this.prevTex);
    }
    for (const tp of this.tilePools.values()) tp.dispose();
    this.tilePools.clear();
    this.liveStates.clear();
    this.grids.clear();
    this.fxCache.clear();
    this.pool.clear();
    this.prevTex = null;
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

  /** Pula kafelków dla danego rozmiaru kafelka (tworzona leniwie); null, gdy GPU nie ma dość jednostek tekstur. */
  private tilePool(g: GL, ts: number): TilePool | null {
    let tp = this.tilePools.get(ts);
    if (!tp) {
      tp = new TilePool(g, ts);
      this.tilePools.set(ts, tp);
    }
    return tp.usable ? tp : null;
  }

  /**
   * Synchronizuje z GPU kafelki warstwy w zakresie dokumentu [x0, x1) x [y0, y1): kafelek z treścią dostaje slot w puli
   * i jest wgrywany tylko wtedy, gdy zmieniła się jego wersja; kafelek pusty nie zajmuje nic. Zwraca null, gdy pula jest
   * pełna nawet po wyparciu kafelków spoza tej klatki (kompozytor oddaje wtedy klatkę ścieżce procesorowej).
   */
  private syncGrid(g: GL, grid: TileGrid, x0: number, y0: number, x1: number, y1: number): SparseSurface | null {
    const tp = this.tilePool(g, grid.tileSize);
    if (!tp) return null;
    let sf = this.grids.get(grid);
    if (sf && (sf.width !== grid.width || sf.height !== grid.height || sf.cols !== grid.cols || sf.rows !== grid.rows)) {
      sf.dispose(g);
      this.grids.delete(grid);
      sf = undefined;
    }
    if (!sf) {
      if (grid.cols > kitMaxTex() || grid.rows > kitMaxTex()) return null;
      sf = new SparseSurface(tp, grid.width, grid.height);
      this.grids.set(grid, sf);
    }
    sf.used = this.frame;
    sf.visible = 0;
    const frame = this.frame;
    const ts = grid.tileSize;
    const tx0 = Math.max(0, Math.floor(x0 / ts));
    const ty0 = Math.max(0, Math.floor(y0 / ts));
    const tx1 = Math.min(grid.cols - 1, Math.floor((x1 - 1) / ts));
    const ty1 = Math.min(grid.rows - 1, Math.floor((y1 - 1) / ts));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const idx = ty * grid.cols + tx;
        const tile = grid.tiles[ty][tx];
        const has = tile.hasContent ? 1 : 0;
        if (sf.ref[idx] === tile && sf.ver[idx] === tile.version && sf.has[idx] === has) {
          // bez zmian: slot tylko oznaczamy jako użyty w tej klatce (chroni go przed wyparciem)
          if (sf.filled(idx)) {
            sf.visible++;
            if (sf.slot[idx] >= 0) tp.lastUsed[sf.slot[idx]] = frame;
          }
          continue;
        }
        sf.ref[idx] = tile;
        sf.ver[idx] = tile.version;
        sf.has[idx] = has;
        if (tile.width <= 0 || tile.height <= 0) continue;
        if (has) {
          const img = tile.ctx.getImageData(0, 0, tile.width, tile.height);
          // 0 = całkiem przezroczysty, 1 = wgrany do slotu, 2 = jednolity (kolor w tablicy stron), -1 = brak miejsca
          const r = tp.put(sf, idx, frame, tile.width, tile.height, img.data);
          if (r < 0) {
            sf.ver[idx] = -1; // nie wgrany: przy następnej próbie ma wrócić do tej gałęzi
            sf.flush(g);
            return null;
          }
          if (r > 0) sf.visible++;
          sf.rev++;
          if (r === 1) this.lastStats.uploads++;
        } else if (sf.filled(idx)) {
          // kafelek został wyczyszczony: oddaj slot (pusty kafelek nie kosztuje pamięci GPU)
          tp.release(sf, idx);
          sf.rev++;
        }
      }
    }
    sf.flush(g);
    return sf;
  }

  private prune(g: GL): void {
    for (const [k, v] of this.grids) {
      if (this.frame - v.used > 240) {
        v.dispose(g);
        this.grids.delete(k);
      }
    }
    for (const [k, v] of this.fxCache) {
      if (this.frame - v.used > 240) {
        this.del(g, v.tex);
        this.fxBytes -= bytesOf(v.tex.w, v.tex.h, 4);
        this.fxCache.delete(k);
      }
    }
    // kawałki atlasu bez ani jednego slotu wracają do GPU
    for (const tp of this.tilePools.values()) tp.trim();
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

  private passSample(g: GL, sf: SparseSurface, dst: Tex, win: GpuWindow, gray: boolean, docW: number, docH: number): void {
    const tp = sf.pool;
    const p = kitProg(g, `gc_sample_${tp.ts}_${tp.chunkCount}`, sparseSampleShader(tp));
    const s = win.s;
    // prostokąt rastra zajmowany przez dokument (zaokrąglony jak w drawLayerTiles)
    const cx0 = Math.round((0 - win.ox) * s);
    const cy0 = Math.round((0 - win.oy) * s);
    const cx1 = Math.round((docW - win.ox) * s);
    const cy1 = Math.round((docH - win.oy) * s);
    kitPass(g, p, dst, win.W, win.H, () => {
      tp.bind(sf);
      this.u1i(g, p, 'uPT', 0);
      for (let c = 0; c < tp.chunkCount; c++) this.u1i(g, p, `uA${c}`, 1 + c);
      g.uniform2i(kitUni(g, p, 'uSrcDim'), sf.width, sf.height);
      g.uniform2i(kitUni(g, p, 'uDoc'), docW, docH);
      g.uniform2f(kitUni(g, p, 'uOrg'), win.ox, win.oy);
      this.u1f(g, p, 'uS', s);
      this.u1i(g, p, 'uGray', gray ? 1 : 0);
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

  private passBlendStraight(g: GL, dst: Tex, src: Tex, out: Tex, win: GpuWindow, mode: number): void {
    const p = this.pr(g, 'gc_blendst', FS_BLEND_ST);
    kitPass(g, p, out, win.W, win.H, () => {
      kitBind(g, 0, dst);
      kitBind(g, 1, src);
      this.u1i(g, p, 'uDst', 0);
      this.u1i(g, p, 'uSrc', 1);
      this.u1i(g, p, 'uMode', mode);
    });
  }

  // --- edycja „na żywo” obiektu pod innymi (segmenty stosu na GPU) -------------------------------------------------

  private liveState(stack: CpuStack): LiveState | null {
    let st = this.liveStates.get(stack);
    if (!st) {
      if (stack.segmentCount + 1 > LIVE_MAX_SEGS) return null;
      st = { segs: new Map(), used: this.frame };
      this.liveStates.set(stack, st);
    }
    st.used = this.frame;
    return st;
  }

  /** Powierzchnia segmentu (`idx` = -1: dół); null, gdy rozmiar kafelka nie dzieli kawałka stosu albo brak miejsca w puli. */
  private liveSeg(g: GL, st: LiveState, idx: number): LiveSegTex | null {
    let sg = st.segs.get(idx);
    if (sg) return sg;
    const docW = this.eng.width;
    const docH = this.eng.height;
    const ts = this.eng.tileSize;
    if (STACK_CHUNK % ts !== 0) return null;
    const tp = this.tilePool(g, ts);
    if (!tp) return null;
    const cols = Math.ceil(docW / STACK_CHUNK);
    const rows = Math.ceil(docH / STACK_CHUNK);
    // sloty segmentu są przypięte na czas sesji; pula sama pilnuje, czy jest dla nich miejsce (acquire)
    sg = { surf: new SparseSurface(tp, docW, docH, true), cols, rows, loaded: new Uint8Array(cols * rows), has: new Uint8Array(cols * rows) };
    st.segs.set(idx, sg);
    return sg;
  }

  /**
   * Wgrywa brakujące kawałki segmentu w zakresie dokumentu [x0, x1) x [y0, y1) i zwraca, czy w tym zakresie jest
   * jakakolwiek zawartość (pusty segment pomija się w całości). -1 = brak miejsca w puli (sesja idzie zwykłą drogą).
   * Kawałek (STACK_CHUNK px) jest dzielony na kafelki puli; kafelek bez żadnego piksela nie dostaje slotu.
   */
  private syncLiveSeg(g: GL, stack: CpuStack, sg: LiveSegTex, idx: number, x0: number, y0: number, x1: number, y1: number): number {
    const cx0 = Math.max(0, Math.floor(x0 / STACK_CHUNK));
    const cy0 = Math.max(0, Math.floor(y0 / STACK_CHUNK));
    const cx1 = Math.min(sg.cols - 1, Math.floor((x1 - 1) / STACK_CHUNK));
    const cy1 = Math.min(sg.rows - 1, Math.floor((y1 - 1) / STACK_CHUNK));
    const sf = sg.surf;
    const tp = sf.pool;
    const ts = sf.ts;
    let any = false;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cy * sg.cols + cx;
        if (!sg.loaded[k]) {
          const cv = stack.buildGpuChunk(idx, cx, cy);
          if (cv) {
            const cw = cv.width;
            const ch = cv.height;
            const ctx = cv.getContext('2d');
            const img = ctx && cw > 0 && ch > 0 ? ctx.getImageData(0, 0, cw, ch) : null;
            if (img) {
              const per = STACK_CHUNK / ts;
              const data = img.data;
              for (let ly = 0; ly * ts < ch; ly++) {
                for (let lx = 0; lx * ts < cw; lx++) {
                  const px = lx * ts;
                  const py = ly * ts;
                  const w = Math.min(ts, cw - px);
                  const h = Math.min(ts, ch - py);
                  const tIdx = (cy * per + ly) * sf.cols + (cx * per + lx);
                  // kafelek całkiem przezroczysty nie dostaje nic, jednolity trafia do tablicy stron
                  const r = tp.put(sf, tIdx, this.frame, w, h, data, cw, px, py);
                  if (r < 0) {
                    sf.flush(g);
                    return -1;
                  }
                  if (r > 0) {
                    sf.has[tIdx] = 1;
                    sg.has[k] = 1;
                  }
                  if (r === 1) this.lastStats.uploads++;
                }
              }
            }
            cv.width = 0;
            cv.height = 0;
          }
          // kawałek liczy się jako wczytany dopiero po wgraniu wszystkich jego kafelków (porażka wraca wcześniej)
          sg.loaded[k] = 1;
        }
        if (sg.has[k]) any = true;
      }
    }
    sf.rev++;
    sf.flush(g);
    return any ? 1 : 0;
  }

  /**
   * Składa edytowaną warstwę wektorową bez dotykania jej pikseli: dół, kolejne segmenty (ciągi zwykłych obiektów i obiekty
   * z własnym trybem mieszania) i żywy podgląd edytowanego obiektu na jego miejscu w kolejności. Wynik (proste kolory, okno
   * rastra) leży w `ta` albo `tb`; null = nie da się (brak pamięci GPU, zbyt wiele segmentów) i warstwa idzie zwykłą drogą.
   */
  private composeLiveLayer(
    g: GL,
    stack: CpuStack,
    live: GpuPreviewSource,
    win: GpuWindow,
    dx0: number,
    dy0: number,
    dx1: number,
    dy1: number,
    ta: Tex,
    tb: Tex,
    tmp: Tex,
    loadPreview: (src: GpuPreviewSource) => { x: number; y: number; w: number; h: number } | null,
    baseGrid: SparseSurface | null = null
  ): Tex | null {
    const st = this.liveState(stack);
    if (!st) return null;
    const docW = this.eng.width;
    const docH = this.eng.height;
    let a = ta;
    let b = tb;
    // najpierw wszystkie potrzebne tekstury (brak pamięci ma wyjść przed pierwszym przebiegiem)
    const need: Array<{ idx: number; sg: LiveSegTex }> = [];
    if (stack.hasBelow) {
      const sg = this.liveSeg(g, st, -1);
      if (!sg) return null;
      need.push({ idx: -1, sg });
    }
    for (let i = 0; i < stack.segmentCount; i++) {
      if (stack.segmentInfo(i).kind === 'live') continue;
      const sg = this.liveSeg(g, st, i);
      if (!sg) return null;
      need.push({ idx: i, sg });
    }
    let started = false;
    // maska wektorowa: obiekty leżą na podkładzie (maskBase), nie na przezroczystym tle
    if (baseGrid) {
      this.passSample(g, baseGrid, a, win, false, docW, docH);
      started = true;
    }
    if (stack.hasBelow) {
      const e = need[0];
      const r = this.syncLiveSeg(g, stack, e.sg, e.idx, dx0, dy0, dx1, dy1);
      if (r < 0) return null;
      if (r > 0) {
        if (started) {
          this.passSample(g, e.sg.surf, tmp, win, false, docW, docH);
          this.passBlendStraight(g, a, tmp, b, win, modeId('SrcOver'));
          const t = a;
          a = b;
          b = t;
        } else {
          this.passSample(g, e.sg.surf, a, win, false, docW, docH);
          started = true;
        }
      }
    }
    if (!started) {
      g.bindFramebuffer(g.FRAMEBUFFER, a.fbo);
      g.viewport(0, 0, win.W, win.H);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
    }
    for (let i = 0; i < stack.segmentCount; i++) {
      const info = stack.segmentInfo(i);
      if (info.kind === 'live') {
        const pr = loadPreview(live);
        if (pr) {
          this.passPrev(g, a, b, win, pr, modeId(live.blendMode));
          const t = a;
          a = b;
          b = t;
        }
        continue;
      }
      const e = need.find((x) => x.idx === i)!;
      const r = this.syncLiveSeg(g, stack, e.sg, i, dx0, dy0, dx1, dy1);
      if (r < 0) return null;
      if (r === 0) continue;
      this.passSample(g, e.sg.surf, tmp, win, false, docW, docH);
      this.passBlendStraight(g, a, tmp, b, win, modeId(info.blend));
      const t = a;
      a = b;
      b = t;
    }
    return a;
  }

  /** Zwalnia tekstury sesji edycji „na żywo”, które nie były użyte w tej klatce (sesja się skończyła). */
  private pruneLive(g: GL): void {
    for (const [k, st] of this.liveStates) {
      if (st.used === this.frame) continue;
      for (const sg of st.segs.values()) sg.surf.dispose(g);
      this.liveStates.delete(k);
    }
  }

  /** Łańcuch efektów warstwy na teksturze `src` (RGBA8, proste kolory); wynik w teksturze puli sesji GPU albo null. */
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
  public compose(view: GpuView, preview: GpuPreviewSource | null, live: GpuPreviewSource | null = null): HTMLCanvasElement | null {
    if (this.broken) return null;
    const g = kitGl();
    if (!g) return null;
    if (this.g !== g) {
      this.dispose();
      this.g = g;
    }
    try {
      return this.composeImpl(g, view, preview, live);
    } catch (e) {
      console.warn('GpuCompose', e);
      this.broken = true;
      return null;
    }
  }

  private composeImpl(g: GL, view: GpuView, preview: GpuPreviewSource | null, live: GpuPreviewSource | null): HTMLCanvasElement | null {
    const eng = this.eng;
    this.frame++;
    this.lastStats = { layers: 0, uploads: 0, chains: 0, cached: 0, w: 0, h: 0, skipped: 0, slots: 0, atlasMiB: 0 };
    if (g.isContextLost()) return null;
    // grupy izolowane i „Przepuszczanie” obsługuje kompozytor CPU
    if (eng.renderIsolation || eng.renderHasPass) return null;
    if (eng.transformContentSession?.other) return null;
    const docW = eng.width;
    const docH = eng.height;
    // dokument może być większy niż największa tekstura: warstwy to powierzchnie rzadkie, a okno (W x H) jest sprawdzane niżej
    const layers = eng.renderLayers;
    const act = eng.renderActiveIndex;
    const z = view.zoom;

    // --- okno rastra ---
    let s: number;
    let ox: number;
    let oy: number;
    let rw: number;
    let rh: number;
    let offX = 0;
    let offY = 0;
    if (z >= 1) {
      s = 1;
      const x0 = Math.max(0, Math.floor(-view.left / z) - 1);
      const y0 = Math.max(0, Math.floor(-view.top / z) - 1);
      const x1 = Math.min(docW, Math.ceil((view.width - view.left) / z) + 1);
      const y1 = Math.min(docH, Math.ceil((view.height - view.top) / z) + 1);
      ox = x0;
      oy = y0;
      rw = x1 - x0;
      rh = y1 - y0;
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
    let prevSrc: GpuPreviewSource | null = null;
    const loadPreview = (src: GpuPreviewSource | null): boolean => {
      if (!src) return false;
      if (prevRect && prevSrc === src) return true;
      prevRect = null;
      let rect: { x0: number; y0: number; x1: number; y1: number } | null = null;
      if (src.bounds) {
        const b = src.bounds;
        rect = {
          x0: Math.max(0, Math.floor((b.left - win.ox) * s)),
          y0: Math.max(0, Math.floor((b.top - win.oy) * s)),
          x1: Math.min(W, Math.ceil((b.right - win.ox) * s)),
          y1: Math.min(H, Math.ceil((b.bottom - win.oy) * s)),
        };
        if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return false;
      }
      const pr = src.rasterize(win, rect);
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
      prevSrc = src;
      return true;
    };

    let liveUsed = false;
    const swapAcc = (): void => {
      const t = acc;
      acc = alt;
      alt = t;
    };

    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
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
      const grid = layer.pixelGridPeek;
      if (grid.width !== docW || grid.height !== docH) return null;
      const gray = layer.grayView;
      const mg = layer.maskGridPeek;
      const hasMask = !!mg && layer.maskEnabled && !gray;
      const editingMask = isActive && layer.editMask && hasMask;
      const corr = layer.hasActiveCorrections;
      const withPreview = isActive && !!preview;

      // Edycja „na żywo” obiektu pod innymi: warstwa jest składana z segmentów stosu i podglądu obiektu, bez przebudowy pikseli
      let liveCur: Tex | null = null;
      let liveMask: Tex | null = null;
      const liveInfo = isActive && live && !gray ? eng.vec.gpuLive(layer) : null;
      if (liveInfo && !liveInfo.onMask && !editingMask) {
        liveCur = this.composeLiveLayer(g, liveInfo.stack, live!, win, dx0, dy0, dx1, dy1, t1, t2, t3, (src) => (loadPreview(src) ? prevRect : null));
        if (liveCur) liveUsed = true;
      } else if (liveInfo && liveInfo.onMask && editingMask && layer.maskBase) {
        // maska wektorowa: podkład + segmenty stosu + żywy podgląd obiektu (t1 zostaje na piksele warstwy)
        const bg = this.syncGrid(g, layer.maskBase, dx0, dy0, dx1, dy1);
        if (bg) {
          liveMask = this.composeLiveLayer(g, liveInfo.stack, live!, win, dx0, dy0, dx1, dy1, t2, t3, t4, (src) => (loadPreview(src) ? prevRect : null), bg);
          if (liveMask) liveUsed = true;
        }
      }
      let gp: SparseSurface | null = null;
      if (!liveCur) {
        if (layer.isVector) layer.ensurePixels();
        gp = this.syncGrid(g, grid, dx0, dy0, dx1, dy1);
        if (!gp) return null;
      }
      // Warstwa bez żadnego kafelka z treścią w oknie, bez korekcji i bez podglądu / edycji „na żywo” nie wnosi nic do wyniku
      // (przezroczystość złożona z czymkolwiek daje to samo tło; wyjątek: widok szarości pokazuje nieprzezroczystą czerń).
      if (gp && !liveCur && !gray && !corr && gp.visible === 0 && !(isActive && (preview || live))) {
        this.lastStats.skipped++;
        continue;
      }
      let gm: SparseSurface | null = null;
      if (hasMask && !liveMask) {
        // odczyt przez `maskGrid` uzupełnia zaległe (leniwie malowane) fragmenty maski wektorowej
        gm = this.syncGrid(g, layer.maskGrid!, dx0, dy0, dx1, dy1);
        if (!gm) return null;
      }

      // nieaktywna warstwa z efektami: wynik w pamięci podręcznej (zmienia się tylko przy zmianie warstwy albo widoku)
      let fxKey = '';
      if (!isActive && corr) {
        fxKey = `${gp ? gp.rev : 0}|${gm ? gm.rev : '-'}|${layer.correctionsSignature}|${wkey}|${gray ? 1 : 0}`;
        const hit = this.fxCache.get(layer);
        if (hit && hit.key === fxKey && hit.tex.w === W && hit.tex.h === H) {
          hit.used = this.frame;
          this.lastStats.cached++;
          this.passComposite(g, acc, hit.tex, alt, win, layer.opacity, modeId(layer.blendMode));
          swapAcc();
          continue;
        }
      }

      let cur: Tex = t1;
      if (liveCur) cur = liveCur;
      else this.passSample(g, gp!, t1, win, gray, docW, docH);
      if (editingMask && liveMask) {
        this.passMask(g, t1, liveMask, t4, win);
        cur = t4;
      } else if (editingMask && gm) {
        // podgląd narzędzia nanoszony na MASKĘ, a dopiero ona (jako alfa) na piksele warstwy
        this.passSample(g, gm, t2, win, false, docW, docH);
        let mt = t2;
        if (withPreview && loadPreview(preview)) {
          this.passPrev(g, t2, t3, win, prevRect!, modeId(preview!.blendMode));
          mt = t3;
        }
        this.passMask(g, t1, mt, t4, win);
        cur = t4;
      } else {
        if (!liveCur && withPreview && loadPreview(preview)) {
          this.passPrev(g, cur, t2, win, prevRect!, modeId(preview!.blendMode));
          cur = t2;
        }
        if (hasMask && gm) {
          this.passSample(g, gm, t3, win, false, docW, docH);
          this.passMask(g, cur, t3, t4, win);
          cur = t4;
        }
      }

      if (corr) {
        const out = this.runChain(layer, cur, win);
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

    if (!liveUsed && this.liveStates.size > 0) this.pruneLive(g);

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
    if (z >= 1) {
      this.u1i(g, dp, 'uKind', z < 2 ? 1 : 0);
      g.uniform4f(kitUni(g, dp, 'uMap'), view.left + TIE_EPS + win.ox * z, view.top + TIE_EPS + win.oy * z, z, 0);
    } else {
      this.u1i(g, dp, 'uKind', 2);
      g.uniform4f(kitUni(g, dp, 'uMap'), offX - M, offY - M, 1, 0);
    }
    g.drawArrays(g.TRIANGLES, 0, 3);
    if (this.frame % 60 === 0) this.prune(g);
    let slots = 0;
    let mib = 0;
    for (const tp of this.tilePools.values()) {
      const st = tp.stats();
      slots += st.slots;
      mib += st.atlasMiB;
    }
    this.lastStats.slots = slots;
    this.lastStats.atlasMiB = mib;
    return glc;
  }
}
