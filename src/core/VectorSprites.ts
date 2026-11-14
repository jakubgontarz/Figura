/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SKBlendMode, getCanvasCompositeOperation } from './types.ts';
import {
  VectorObject,
  cloneVectorObject,
  drawVectorObject,
  translateVectorObject,
  vectorObjectBlend,
  vectorObjectBounds,
  vectorObjectMeta,
} from './VectorObjects.ts';
import { markWindowedContext, unmarkWindowedContext } from './VectorRenderer.ts';

/**
 * Pamięć podręczna rastrów obiektów wektorowych ("sprite'y").
 *
 * Każdy obiekt jest rasteryzowany RAZ (sam, na przezroczystym tle, bez trybu mieszania) do własnego bufora w pikselach
 * dokumentu. Wszystko, co składa warstwę (przebudowa pikseli dokumentu, podział "pod / edytowany / nad" podczas edycji)
 * tylko nakłada gotowe sprite'y, więc koszt składania nie zależy od złożoności rysowania obiektów (obrysy i wypełnienia
 * liczone pikselowo, tekst, obiekty inteligentne).
 *
 * Klucz sprite'a jest niezależny od położenia: obiekt przesunięty o całkowitą liczbę pikseli ma ten sam klucz
 * (jego postać "kanoniczna" ma początek w (0,0)), więc przesuwanie obiektu o całkowite piksele nie rasteryzuje niczego.
 * Obiekt przesunięty o ułamek piksela ma inny klucz i jest rasteryzowany od nowa.
 */

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Lewy górny róg w pikselach dokumentu. */
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
const SPRITE_MAX_PX = 8 * 1024 * 1024;
/** Limit pamięci sprite'ów na procesorze (bajty); najdawniej używane wypadają. */
const CACHE_BUDGET = 640 * 1024 * 1024;

interface ObjRaster {
  /** Prostokąt obiektu (piksele dokumentu). */
  rect: RasterRect;
  /** Klucz sprite'a całego obiektu; null = obiekt za duży (rysowany tylko w oknie). */
  key: string | null;
  /** Klucz kafelków dużego obiektu rysowanego w całości; wyliczany leniwie. */
  bigKey?: string;
}

const cache = new Map<string, Sprite>();
let cacheBytes = 0;
let tick = 0;

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

/** Rysuje obiekt tak, że punkt (ox, oy) leży w (0, 0) bufora; rysunek jest taki sam jak przy zatwierdzaniu obiektu. */
function drawAt(ctx: CanvasRenderingContext2D, o: VectorObject, ox: number, oy: number): void {
  ctx.translate(-ox, -oy);
  drawVectorObject(ctx, o);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Postać obiektu z początkiem w (0, 0): wspólna dla wszystkich położeń różniących się o całkowite piksele. */
function canonical(o: VectorObject, ox: number, oy: number): VectorObject {
  return translateVectorObject(cloneVectorObject(o), -ox, -oy);
}

function rasterInfo(o: VectorObject): ObjRaster {
  const meta = vectorObjectMeta(o);
  let r = meta.raster as ObjRaster | undefined;
  if (r) return r;
  const b = vectorObjectBounds(o);
  const rect: RasterRect = { x0: Math.floor(b.x0), y0: Math.floor(b.y0), x1: Math.ceil(b.x1), y1: Math.ceil(b.y1) };
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  let key: string | null = null;
  if (w > 0 && h > 0 && w * h <= SPRITE_MAX_PX) key = `${w}x${h}|${rasterSig(canonical(o, rect.x0, rect.y0))}`;
  r = { rect, key };
  meta.raster = r;
  return r;
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
  const sp: Sprite = { canvas, x, y, w, h, bytes: w * h * 4, used: ++tick };
  cache.set(key, sp);
  cacheBytes += sp.bytes;
  evict();
  return sp;
}

/**
 * Sprite obiektu edytowanego „na żywo”: każda klatka przeciągania uchwytu (rozmiar, obrót, kolor) ma inny klucz, więc
 * wpisywanie ich do pamięci LRU wypychałoby z niej sprite'y reszty dokumentu i zmuszało do sortowania całej pamięci przy
 * każdej klatce. Żywy obiekt ma jedno własne miejsce (zastępowane); przesunięcie o całkowite piksele nadal trafia w ten
 * sam klucz.
 */
let liveSlot: { key: string; sprite: Sprite } | null = null;

/**
 * Sprite całego obiektu albo null, gdy obiekt jest zbyt duży (patrz `getTileSprites`).
 * Zwrócony sprite jest współdzielony: nie wolno go modyfikować.
 */
function getObjectSprite(o: VectorObject, live = false): Sprite | null {
  const info = rasterInfo(o);
  if (!info.key) return null;
  if (live) {
    const cur = liveSlot;
    if (cur && cur.key === info.key) {
      const sp = cur.sprite;
      return sp.x === info.rect.x0 && sp.y === info.rect.y0 ? sp : { ...sp, x: info.rect.x0, y: info.rect.y0 };
    }
    const w = info.rect.x1 - info.rect.x0;
    const h = info.rect.y1 - info.rect.y0;
    const { canvas, ctx } = makeCanvas(w, h);
    drawAt(ctx, o, info.rect.x0, info.rect.y0);
    if (cur) {
      cur.sprite.canvas.width = 0;
      cur.sprite.canvas.height = 0;
    }
    const sprite: Sprite = { canvas, x: info.rect.x0, y: info.rect.y0, w, h, bytes: w * h * 4, used: ++tick };
    liveSlot = { key: info.key, sprite };
    return sprite;
  }
  const hit = cache.get(info.key);
  if (hit) {
    hit.used = ++tick;
    // sprite został zrasteryzowany dla innego położenia obiektu różniącego się o całkowite piksele: przesuwamy go
    return hit.x === info.rect.x0 && hit.y === info.rect.y0 ? hit : { ...hit, x: info.rect.x0, y: info.rect.y0 };
  }
  const w = info.rect.x1 - info.rect.x0;
  const h = info.rect.y1 - info.rect.y0;
  const { canvas, ctx } = makeCanvas(w, h);
  drawAt(ctx, o, info.rect.x0, info.rect.y0);
  return store(info.key, canvas, info.rect.x0, info.rect.y0);
}

/** Bok wyrównanego kafelka sprite'a dla obiektów większych niż `SPRITE_MAX_PX` (np. tło na całe płótno). */
const SPRITE_TILE = 512;

/** Największy obiekt rysowany w całości przed pocięciem na kafelki: ~ 160 Mpx (bufor tymczasowy ~ 640 MB). */
const EXACT_MAX_PX = 160 * 1024 * 1024;

/**
 * Rysunek musi być dokładnie taki jak całego obiektu naraz (rysowanie w oknie zmienia rasteryzację krawędzi), więc duży
 * obiekt rysujemy RAZ w całości do bufora tymczasowego i tniemy na kafelki zakotwiczone w obiekcie (przesunięcie
 * o całkowite piksele daje te same kafelki). Bufor tymczasowy jest zwalniany.
 */
function getExactTiles(o: VectorObject, info: ObjRaster, clip: RasterRect): Sprite[] {
  const r = info.rect;
  const T = SPRITE_TILE;
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const bigKey = (info.bigKey ??= `X|${w}x${h}|${rasterSig(canonical(o, r.x0, r.y0))}`);
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
    drawAt(ctx, o, r.x0, r.y0);
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

/**
 * Obiekt zbyt duży na jeden sprite: sprite'y wyrównanych kafelków SPRITE_TILE x SPRITE_TILE przecinających okno `clip`.
 * Kafelek ma stały klucz niezależny od okna, więc edycja obok nie rasteryzuje ich od nowa. Obiekty mieszczące się
 * w `EXACT_MAX_PX` są rysowane w całości (patrz `getExactTiles`); większe są rysowane kafelek po kafelku, z przycięciem
 * rysunku do bufora kafelka.
 */
function getTileSprites(o: VectorObject, clip: RasterRect): Sprite[] {
  const info = rasterInfo(o);
  if ((info.rect.x1 - info.rect.x0) * (info.rect.y1 - info.rect.y0) <= EXACT_MAX_PX) return getExactTiles(o, info, clip);
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
      const key = `T|${w}x${h}|${rasterSig(canonical(o, px0, py0))}`;
      const hit = cache.get(key);
      if (hit) {
        hit.used = ++tick;
        out.push(hit.x === px0 && hit.y === py0 ? hit : { ...hit, x: px0, y: py0 });
        continue;
      }
      const { canvas, ctx } = makeCanvas(w, h);
      markWindowedContext(ctx);
      drawAt(ctx, o, px0, py0);
      out.push(store(key, canvas, px0, py0));
    }
  }
  return out;
}

/** Sprite'y obiektu do narysowania w oknie `clip`: cały sprite (z pamięci) albo wyrównane kafelki dla obiektów dużych. */
export function spritesFor(o: VectorObject, clip: RasterRect, live = false): Sprite[] {
  const r = rasterInfo(o).rect;
  if (r.x1 <= clip.x0 || r.x0 >= clip.x1 || r.y1 <= clip.y0 || r.y0 >= clip.y1) return [];
  const whole = getObjectSprite(o, live);
  return whole ? [whole] : getTileSprites(o, clip);
}

export function blendOp(b: SKBlendMode): GlobalCompositeOperation {
  return getCanvasCompositeOperation(b);
}

/**
 * Nakłada obiekty (od dołu do góry, każdy z własnym trybem mieszania) na kontekst `acc` obejmujący prostokąt dokumentu
 * (x0, y0, w, h). Rysunek obiektów pochodzi z pamięci sprite'ów.
 */
export function compositeObjectsRegion(
  acc: CanvasRenderingContext2D,
  objs: readonly VectorObject[],
  x0: number,
  y0: number,
  w: number,
  h: number,
  /** true = tryby mieszania obiektów są pomijane (rysunek source-over); stosuje je później kompozytor GPU */
  plain = false
): void {
  const clip: RasterRect = { x0, y0, x1: x0 + w, y1: y0 + h };
  acc.save();
  acc.setTransform(1, 0, 0, 1, 0, 0);
  acc.globalAlpha = 1;
  for (const o of objs) {
    const sps = spritesFor(o, clip);
    if (sps.length === 0) continue;
    acc.globalCompositeOperation = plain ? 'source-over' : blendOp(vectorObjectBlend(o));
    for (const sp of sps) acc.drawImage(sp.canvas, sp.x - x0, sp.y - y0);
  }
  acc.restore();
}
