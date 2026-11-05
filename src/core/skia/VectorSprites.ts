/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SKBlendMode, getCanvasCompositeOperation } from './types.ts';
import {
  VecBounds,
  VectorObject,
  cloneVectorObject,
  drawVectorObject,
  scaleVectorObject,
  translateVectorObject,
  vectorObjectBlend,
  vectorObjectBounds,
  vectorObjectMeta,
} from './VectorObjects.ts';
import { markWindowedContext, unmarkWindowedContext } from './VectorRenderer.ts';

/**
 * Pamięć podręczna rastrów obiektów wektorowych ("sprite'y").
 *
 * Każdy obiekt jest rasteryzowany RAZ (sam, na przezroczystym tle, bez trybu mieszania) do własnego bufora w danej skali
 * (1 = piksele dokumentu, S = skala widoku). Wszystko, co składa warstwę (przebudowa pikseli dokumentu, składanie GPU
 * w trybie Wektory, podział "pod / edytowany / nad" podczas edycji) tylko NAKŁADA gotowe sprite'y, więc koszt klatki
 * nie zależy od złożoności rysowania obiektów (obrysy + wypełnienia liczone pikselowo, tekst, obiekty inteligentne).
 *
 * Klucz sprite'a jest niezależny od położenia: obiekt przesunięty o całkowitą liczbę pikseli rastra ma ten sam klucz
 * (jego postać "kanoniczna" ma początek w (0,0)), więc przesuwanie obiektu o całkowite piksele nie rasteryzuje niczego.
 * Obiekt przesunięty o ułamek piksela rastra ma inny klucz i jest rasteryzowany od nowa (tylko on, jeden raz na klatkę).
 */

export interface Sprite {
  /** Unikalny numer (klucze tekstur GPU). */
  id: number;
  canvas: HTMLCanvasElement;
  /** Lewy górny róg w pikselach rastra (skala sprite'a, początek = lewy górny róg dokumentu). */
  x: number;
  y: number;
  w: number;
  h: number;
  bytes: number;
  used: number;
}

export interface RasterRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Największy sprite całego obiektu (piksele). Większe obiekty (np. tło na całe płótno) rysujemy tylko w oknie. */
export const SPRITE_MAX_PX = 8 * 1024 * 1024;
/** Limit pamięci sprite'ów na procesorze (bajty); najdawniej używane wypadają. */
const CACHE_BUDGET = 640 * 1024 * 1024;

interface ObjRaster {
  /** Prostokąt rastra obiektu (globalne piksele rastra). */
  rect: RasterRect;
  /** Klucz sprite'a całego obiektu; null = obiekt za duży (rysowany tylko w oknie). */
  key: string | null;
  /** Klucz dużego obiektu w trybie dokładnym (skala 1); wyliczany leniwie. */
  bigKey?: string;
}

const cache = new Map<string, Sprite>();
let cacheBytes = 0;
let tick = 0;
let spriteSeq = 1;

/** Podpis rastra obiektu: wszystko, co wpływa na rysunek (bez id, nazwy, widoczności i trybu mieszania). */
function rasterSig(o: VectorObject): string {
  return JSON.stringify(o, (k, v) => {
    if (k === 'id' || k === 'name' || k === 'visible' || k === 'blendMode') return undefined;
    if (typeof v !== 'string' || v.length <= 200) return v;
    // duże ładunki (obiekt inteligentny: PNG / dokument) skracamy do długości i próbki znaków
    let sm = '';
    for (let q = 0; q < 64; q++) sm += v[Math.floor((q * (v.length - 1)) / 63)];
    return `${v.length}:${sm}`;
  });
}

/** Rysuje obiekt tak, że punkt rastra (ox, oy) leży w (0, 0) bufora; skala 1 = dokładnie jak przy zatwierdzaniu obiektu. */
function drawAt(ctx: CanvasRenderingContext2D, o: VectorObject, S: number, ox: number, oy: number): void {
  if (S === 1) {
    ctx.translate(-ox, -oy);
    drawVectorObject(ctx, o);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    drawVectorObject(ctx, scaleVectorObject(o, S, -ox, -oy));
  }
}

/** Postać obiektu z początkiem rastra w (0, 0): wspólna dla wszystkich położeń różniących się o całkowite piksele rastra. */
function canonical(o: VectorObject, S: number, ox: number, oy: number): VectorObject {
  return S === 1 ? translateVectorObject(cloneVectorObject(o), -ox, -oy) : scaleVectorObject(o, S, -ox, -oy);
}

function rasterInfo(o: VectorObject, S: number): ObjRaster {
  const meta = vectorObjectMeta(o);
  const store = (meta.raster ??= new Map<number, unknown>()) as Map<number, ObjRaster>;
  let r = store.get(S);
  if (r) return r;
  const b = vectorObjectBounds(o);
  const rect: RasterRect = { x0: Math.floor(b.x0 * S), y0: Math.floor(b.y0 * S), x1: Math.ceil(b.x1 * S), y1: Math.ceil(b.y1 * S) };
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  let key: string | null = null;
  if (w > 0 && h > 0 && w * h <= SPRITE_MAX_PX) key = `${S}|${w}x${h}|${rasterSig(canonical(o, S, rect.x0, rect.y0))}`;
  r = { rect, key };
  store.set(S, r);
  return r;
}

/** Prostokąt rastra (piksele w skali S) zajmowany przez obiekt (zachowawczy). */
export function objectRasterRect(o: VectorObject, S: number): RasterRect {
  return rasterInfo(o, S).rect;
}

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // bufor programowy: wynik trafia do kafelków dokumentu (CPU) albo do tekstury GPU (wgranie z pamięci)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  return { canvas, ctx };
}

function evict(): void {
  if (cacheBytes <= CACHE_BUDGET) return;
  const all = [...cache.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [k, sp] of all) {
    if (cacheBytes <= CACHE_BUDGET * 0.8) break;
    cache.delete(k);
    cacheBytes -= sp.bytes;
  }
}

function store(key: string, canvas: HTMLCanvasElement, x: number, y: number): Sprite {
  const w = canvas.width;
  const h = canvas.height;
  const sp: Sprite = { id: spriteSeq++, canvas, x, y, w, h, bytes: w * h * 4, used: ++tick };
  cache.set(key, sp);
  cacheBytes += sp.bytes;
  evict();
  return sp;
}

/**
 * Sprite całego obiektu w skali S albo null, gdy obiekt jest zbyt duży (patrz `getTileSprites`).
 * Zwrócony sprite jest współdzielony: nie wolno go modyfikować.
 */
export function getObjectSprite(o: VectorObject, S: number): Sprite | null {
  const info = rasterInfo(o, S);
  if (!info.key) return null;
  const hit = cache.get(info.key);
  if (hit) {
    hit.used = ++tick;
    // sprite został zrasteryzowany dla innego położenia obiektu różniącego się o całkowite piksele: przesuwamy go
    return hit.x === info.rect.x0 && hit.y === info.rect.y0 ? hit : { ...hit, x: info.rect.x0, y: info.rect.y0 };
  }
  const w = info.rect.x1 - info.rect.x0;
  const h = info.rect.y1 - info.rect.y0;
  const { canvas, ctx } = makeCanvas(w, h);
  drawAt(ctx, o, S, info.rect.x0, info.rect.y0);
  return store(info.key, canvas, info.rect.x0, info.rect.y0);
}

/** Bok wyrównanego kafelka sprite'a dla obiektów większych niż `SPRITE_MAX_PX` (tło na całe płótno, duże powiększenie). */
export const SPRITE_TILE = 512;

/**
 * Obiekt zbyt duży na jeden sprite: sprite'y wyrównanych kafelków SPRITE_TILE x SPRITE_TILE (początek siatki = początek
 * rastra) przecinających okno `clip`. Kafelek ma stały klucz niezależny od okna, więc przesuwanie widoku / edycja obok
 * nie rasteryzują ich od nowa; w kafelku rysunek jest przycięty do bufora (jak przy rysowaniu w oknie).
 */
/** Największy obiekt rysowany w całości w trybie dokładnym (skala 1): ~ 160 Mpx (bufor tymczasowy ~ 640 MB). */
const EXACT_MAX_PX = 160 * 1024 * 1024;

/**
 * Skala 1 (piksele dokumentu, zatwierdzanie): rysunek musi być dokładnie taki jak całego obiektu naraz (rysowanie w oknie
 * zmienia rasteryzację krawędzi), więc duży obiekt rysujemy RAZ w całości do bufora tymczasowego i tniemy na kafelki
 * zakotwiczone w obiekcie (przesunięcie o całkowite piksele daje te same kafelki). Bufor tymczasowy jest zwalniany.
 */
function getExactTiles(o: VectorObject, info: ObjRaster, clip: RasterRect): Sprite[] {
  const r = info.rect;
  const T = SPRITE_TILE;
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const bigKey = (info.bigKey ??= `X|${w}x${h}|${rasterSig(canonical(o, 1, r.x0, r.y0))}`);
  const i0 = Math.max(0, Math.floor((Math.max(r.x0, clip.x0) - r.x0) / T));
  const j0 = Math.max(0, Math.floor((Math.max(r.y0, clip.y0) - r.y0) / T));
  const i1 = Math.floor((Math.min(r.x1, clip.x1) - 1 - r.x0) / T);
  const j1 = Math.floor((Math.min(r.y1, clip.y1) - 1 - r.y0) / T);
  const out: Sprite[] = [];
  if (i1 < i0 || j1 < j0) return out;
  const place = (sp: Sprite, i: number, j: number): Sprite => (sp.x === r.x0 + i * T && sp.y === r.y0 + j * T ? sp : { ...sp, x: r.x0 + i * T, y: r.y0 + j * T });
  let missing = false;
  for (let j = j0; j <= j1 && !missing; j++) {
    for (let i = i0; i <= i1; i++) {
      const hit = cache.get(`${bigKey}#${i},${j}`);
      if (hit) continue;
      if (emptyTiles.has(`${bigKey}#${i},${j}`)) continue;
      missing = true;
      break;
    }
  }
  if (missing) {
    if (emptyTiles.size > 200000) emptyTiles.clear();
    const { canvas, ctx } = makeCanvas(w, h);
    unmarkWindowedContext(ctx);
    drawAt(ctx, o, 1, r.x0, r.y0);
    const cols = Math.ceil(w / T);
    const rows = Math.ceil(h / T);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const tw = Math.min(T, w - i * T);
        const th = Math.min(T, h - j * T);
        const k = `${bigKey}#${i},${j}`;
        const data = ctx.getImageData(i * T, j * T, tw, th).data;
        let any = false;
        for (let q = 3; q < data.length; q += 4) if (data[q] !== 0) { any = true; break; }
        if (!any) {
          emptyTiles.add(k);
          continue;
        }
        const t = makeCanvas(tw, th);
        t.ctx.drawImage(canvas, i * T, j * T, tw, th, 0, 0, tw, th);
        store(k, t.canvas, r.x0 + i * T, r.y0 + j * T);
      }
    }
    canvas.width = 0;
    canvas.height = 0;
  }
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const hit = cache.get(`${bigKey}#${i},${j}`);
      if (hit) {
        hit.used = ++tick;
        out.push(place(hit, i, j));
      }
    }
  }
  return out;
}
const emptyTiles = new Set<string>();

export function getTileSprites(o: VectorObject, S: number, clip: RasterRect, exact = true): Sprite[] {
  const info = rasterInfo(o, S);
  if (exact && S === 1 && (info.rect.x1 - info.rect.x0) * (info.rect.y1 - info.rect.y0) <= EXACT_MAX_PX) return getExactTiles(o, info, clip);
  const r = info.rect;
  const x0 = Math.max(r.x0, clip.x0);
  const y0 = Math.max(r.y0, clip.y0);
  const x1 = Math.min(r.x1, clip.x1);
  const y1 = Math.min(r.y1, clip.y1);
  const out: Sprite[] = [];
  if (x1 <= x0 || y1 <= y0) return out;
  const T = SPRITE_TILE;
  for (let ty = Math.floor(y0 / T); ty <= Math.floor((y1 - 1) / T); ty++) {
    for (let tx = Math.floor(x0 / T); tx <= Math.floor((x1 - 1) / T); tx++) {
      const px0 = Math.max(r.x0, tx * T);
      const py0 = Math.max(r.y0, ty * T);
      const px1 = Math.min(r.x1, (tx + 1) * T);
      const py1 = Math.min(r.y1, (ty + 1) * T);
      const w = px1 - px0;
      const h = py1 - py0;
      if (w <= 0 || h <= 0) continue;
      const key = `T|${S}|${w}x${h}|${rasterSig(canonical(o, S, px0, py0))}`;
      const hit = cache.get(key);
      if (hit) {
        hit.used = ++tick;
        out.push(hit.x === px0 && hit.y === py0 ? hit : { ...hit, x: px0, y: py0 });
        continue;
      }
      const { canvas, ctx } = makeCanvas(w, h);
      markWindowedContext(ctx);
      drawAt(ctx, o, S, px0, py0);
      out.push(store(key, canvas, px0, py0));
    }
  }
  return out;
}

/** Sprite'y obiektu do narysowania w oknie `clip`: cały sprite (z pamięci) albo wyrównane kafelki dla obiektów dużych. */
/** `exact` = piksel w piksel jak rysowanie całego obiektu (zatwierdzanie / piksele dokumentu); false = podgląd okienkowy. */
export function spritesFor(o: VectorObject, S: number, clip: RasterRect, exact = true): Sprite[] {
  const r = rasterInfo(o, S).rect;
  if (r.x1 <= clip.x0 || r.x0 >= clip.x1 || r.y1 <= clip.y0 || r.y0 >= clip.y1) return [];
  const whole = getObjectSprite(o, S);
  return whole ? [whole] : getTileSprites(o, S, clip, exact);
}

let transient: HTMLCanvasElement[] = [];
/**
 * Sprite obiektu edytowanego na żywo: zmienia się w każdej klatce, więc nie trafia do pamięci podręcznej (rysowany do
 * współdzielonego bufora, ważnego do następnego wywołania z tym samym `slot`). Obiekty duże: tylko fragment w oknie `clip`.
 */
export function liveSprite(o: VectorObject, S: number, clip: RasterRect, slot = 0): Sprite | null {
  const r = rasterInfo(o, S).rect;
  const x0 = Math.max(r.x0, clip.x0);
  const y0 = Math.max(r.y0, clip.y0);
  const x1 = Math.min(r.x1, clip.x1);
  const y1 = Math.min(r.y1, clip.y1);
  if (x1 <= x0 || y1 <= y0) return null;
  const w = x1 - x0;
  const h = y1 - y0;
  let cv = transient[slot];
  if (!cv) cv = transient[slot] = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  } else {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
  }
  if (w * h < (r.x1 - r.x0) * (r.y1 - r.y0)) markWindowedContext(ctx);
  else unmarkWindowedContext(ctx);
  drawAt(ctx, o, S, x0, y0);
  return { id: -1, canvas: cv, x: x0, y: y0, w, h, bytes: 0, used: 0 };
}

export function blendOp(b: SKBlendMode): GlobalCompositeOperation {
  return getCanvasCompositeOperation(b);
}

/**
 * Nakłada obiekty (od dołu do góry, każdy z własnym trybem mieszania) na kontekst `acc` obejmujący prostokąt dokumentu
 * (x0, y0, w, h) w skali 1. Wynik jest taki sam jak dawne `compositeVectorObject` dla każdego obiektu po kolei,
 * ale rysunek obiektów pochodzi z pamięci sprite'ów.
 */
export function compositeObjectsRegion(acc: CanvasRenderingContext2D, objs: readonly VectorObject[], x0: number, y0: number, w: number, h: number): void {
  const clip: RasterRect = { x0, y0, x1: x0 + w, y1: y0 + h };
  acc.save();
  acc.setTransform(1, 0, 0, 1, 0, 0);
  acc.globalAlpha = 1;
  for (const o of objs) {
    const sps = spritesFor(o, 1, clip);
    if (sps.length === 0) continue;
    acc.globalCompositeOperation = blendOp(vectorObjectBlend(o));
    for (const sp of sps) acc.drawImage(sp.canvas, sp.x - x0, sp.y - y0);
  }
  acc.restore();
}

export function boundsToRect(b: VecBounds, S: number): RasterRect {
  return { x0: Math.floor(b.x0 * S), y0: Math.floor(b.y0 * S), x1: Math.ceil(b.x1 * S), y1: Math.ceil(b.y1 * S) };
}

export function clearSpriteCache(): void {
  cache.clear();
  emptyTiles.clear();
  cacheBytes = 0;
}

export function spriteCacheStats(): { count: number; bytes: number } {
  return { count: cache.size, bytes: cacheBytes };
}
