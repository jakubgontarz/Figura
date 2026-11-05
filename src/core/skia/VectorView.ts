/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { VectorObject, vectorObjectBlend, vectorObjectSerial } from './VectorObjects.ts';
import { RasterRect, blendOp, objectRasterRect, spritesFor } from './VectorSprites.ts';

/**
 * Obraz warstwy wektorowej w rozdzielczości ekranu (tryb „Wektory”), składany ze sprite'ów obiektów.
 *
 * Stos obiektów jest dzielony na „pod / edytowane / nad” (jak `CpuStack` dla pikseli dokumentu):
 *   - obiekty pod najniższym edytowanym są złożone RAZ do bufora `below`,
 *   - dalej ciągi zwykłych (Normalnych) obiektów są złożone do własnych buforów, a obiekt z innym trybem mieszania oraz
 *     obiekt edytowany nakładane są osobno (muszą widzieć tło),
 *   - klatka edycji składa wynik tylko w prostokącie, który się zmienił (poprzednie + nowe położenie obiektów edytowanych),
 *     więc koszt nie zależy od liczby obiektów ani od rozmiaru okna, a do GPU wgrywany jest tylko ten prostokąt.
 * Zmiana widoku (powiększenie, przesunięcie, rozmiar okna) albo zmiana obiektów poza edytowanymi składa wszystko od nowa
 * z pamięci sprite'ów (obiekty nie są wtedy rasteryzowane ponownie, o ile mają ten sam sprite).
 */

export interface ViewParams {
  /** Skala widoku (piksele ekranu na piksel dokumentu). */
  S: number;
  /** Położenie początku dokumentu w oknie (piksele okna). */
  left: number;
  top: number;
  W: number;
  H: number;
  docW: number;
  docH: number;
}

export interface PixRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Flat {
  cv: HTMLCanvasElement;
  key: string;
}

type Seg = { kind: 'run'; objs: VectorObject[] } | { kind: 'obj'; o: VectorObject } | { kind: 'live'; o: VectorObject };

function makeCv(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const ctxOf = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;

function unionRect(a: PixRect | null, b: PixRect | null): PixRect | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export class VectorView {
  public readonly out: HTMLCanvasElement = makeCv(1, 1);
  private viewKey = '';
  private below: Flat | null = null;
  private runs = new Map<number, Flat>();
  private liveSig = '';
  private lastLive: PixRect | null = null;
  private fullPending = true;
  private pending: PixRect | null = null;
  private produced = false;

  private serials(list: readonly VectorObject[]): string {
    let s = '';
    for (const o of list) s += vectorObjectSerial(o) + vectorObjectBlend(o)[0] + ',';
    return s;
  }

  private flat(slot: Flat | null, key: string, objs: readonly VectorObject[], p: ViewParams): Flat {
    if (slot && slot.key === key) return slot;
    const f = slot ?? { cv: makeCv(p.W, p.H), key };
    if (f.cv.width !== p.W || f.cv.height !== p.H) {
      f.cv.width = p.W;
      f.cv.height = p.H;
    }
    f.key = key;
    const ctx = ctxOf(f.cv);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, p.W, p.H);
    this.drawObjects(ctx, objs, p, null);
    this.fullPending = true;
    return f;
  }

  /** Rysuje obiekty (sprite'y) na `ctx` w oknie; `clip` ogranicza rysowanie do prostokąta okna (piksele okna). */
  private drawObjects(ctx: CanvasRenderingContext2D, objs: readonly VectorObject[], p: ViewParams, clip: PixRect | null): void {
    const win: RasterRect = clip
      ? { x0: clip.x - p.left, y0: clip.y - p.top, x1: clip.x + clip.w - p.left, y1: clip.y + clip.h - p.top }
      : { x0: -p.left, y0: -p.top, x1: p.W - p.left, y1: p.H - p.top };
    for (const o of objs) {
      const sps = spritesFor(o, p.S, win, false);
      if (sps.length === 0) continue;
      ctx.globalCompositeOperation = blendOp(vectorObjectBlend(o));
      for (const sp of sps) ctx.drawImage(sp.canvas, sp.x + p.left, sp.y + p.top);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private liveRect(segs: Seg[], p: ViewParams): PixRect | null {
    let r: PixRect | null = null;
    for (const s of segs) {
      if (s.kind !== 'live') continue;
      const b = objectRasterRect(s.o, p.S);
      const x0 = Math.max(0, b.x0 + p.left - 1);
      const y0 = Math.max(0, b.y0 + p.top - 1);
      const x1 = Math.min(p.W, b.x1 + p.left + 1);
      const y1 = Math.min(p.H, b.y1 + p.top + 1);
      if (x1 > x0 && y1 > y0) r = unionRect(r, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return r;
  }

  /**
   * Składa warstwę. `objs`: widoczne obiekty od dołu do góry (stan bieżący, z podstawionym obiektem na żywo),
   * `liveIds`: id obiektów edytowanych / przesuwanych w tej chwili. Zwraca bufor okna W x H (piksele premnożone, dokument
   * przycięty do swojego prostokąta).
   */
  public produce(objs: readonly VectorObject[], liveIds: ReadonlySet<string>, p: ViewParams): HTMLCanvasElement {
    const vk = `${p.S}|${p.left},${p.top}|${p.W}x${p.H}|${p.docW}x${p.docH}`;
    if (vk !== this.viewKey) {
      this.viewKey = vk;
      this.below = null;
      this.runs.clear();
      this.fullPending = true;
      this.lastLive = null;
      this.liveSig = '';
    }
    if (this.out.width !== p.W || this.out.height !== p.H) {
      this.out.width = p.W;
      this.out.height = p.H;
      this.fullPending = true;
    }

    // podział stosu
    const belowObjs: VectorObject[] = [];
    const segs: Seg[] = [];
    let seenLive = false;
    for (const o of objs) {
      const live = liveIds.has(o.id);
      if (!seenLive && !live) {
        belowObjs.push(o);
        continue;
      }
      seenLive = true;
      if (live) segs.push({ kind: 'live', o });
      else if (vectorObjectBlend(o) === 'SrcOver') {
        const last = segs[segs.length - 1];
        if (last && last.kind === 'run') last.objs.push(o);
        else segs.push({ kind: 'run', objs: [o] });
      } else segs.push({ kind: 'obj', o });
    }

    // bufory stałe
    const bkey = this.serials(belowObjs);
    if (belowObjs.length === 0) {
      if (this.below) this.fullPending = true;
      this.below = null;
    }
    if (belowObjs.length > 0) this.below = this.flat(this.below, bkey, belowObjs, p);
    const keepRuns = new Set<number>();
    segs.forEach((s, i) => {
      if (s.kind !== 'run') return;
      keepRuns.add(i);
      this.runs.set(i, this.flat(this.runs.get(i) ?? null, this.serials(s.objs), s.objs, p));
    });
    for (const k of [...this.runs.keys()]) {
      if (keepRuns.has(k)) continue;
      this.runs.delete(k);
      this.fullPending = true;
    }

    // zmiana obiektów żywych / nie-żywych o specjalnym trybie
    let sig = '';
    for (const s of segs) if (s.kind !== 'run') sig += vectorObjectSerial(s.o) + vectorObjectBlend(s.o)[0] + ',';
    const curLive = this.liveRect(segs, p);
    if (this.produced && !this.fullPending && sig === this.liveSig) return this.out;

    let dirty: PixRect | null;
    if (this.fullPending) dirty = { x: 0, y: 0, w: p.W, h: p.H };
    else dirty = unionRect(this.lastLive, curLive);
    // obiekty bez trybu mieszania także mogą zmienić „pod” sobą wynik tylko w swoim prostokącie; segmenty 'obj' obejmują
    // sąsiednie piksele, więc przy ich zmianie odświeżamy cały prostokąt obiektu
    for (const s of segs) {
      if (s.kind !== 'obj') continue;
      const b = objectRasterRect(s.o, p.S);
      const x0 = Math.max(0, b.x0 + p.left - 1);
      const y0 = Math.max(0, b.y0 + p.top - 1);
      const x1 = Math.min(p.W, b.x1 + p.left + 1);
      const y1 = Math.min(p.H, b.y1 + p.top + 1);
      if (x1 > x0 && y1 > y0) dirty = unionRect(dirty, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    if (dirty) {
      const x0 = Math.max(0, Math.floor(dirty.x));
      const y0 = Math.max(0, Math.floor(dirty.y));
      const x1 = Math.min(p.W, Math.ceil(dirty.x + dirty.w));
      const y1 = Math.min(p.H, Math.ceil(dirty.y + dirty.h));
      dirty = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
    }
    if (dirty) this.compose(segs, dirty, p);
    this.liveSig = sig;
    this.lastLive = curLive;
    this.produced = true;
    if (this.fullPending) this.pending = null;
    else this.pending = unionRect(this.pending, dirty);
    this.fullDirty = this.fullDirty || this.fullPending;
    this.fullPending = false;
    return this.out;
  }

  private fullDirty = true;

  private compose(segs: Seg[], d: PixRect, p: ViewParams): void {
    const ctx = ctxOf(this.out);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(d.x, d.y, d.w, d.h);
    // wszystko tylko w prostokącie zmiany i w obrębie dokumentu (poza dokumentem nic nie ma być widać)
    const dx0 = Math.max(d.x, p.left);
    const dy0 = Math.max(d.y, p.top);
    const dx1 = Math.min(d.x + d.w, p.left + p.docW * p.S);
    const dy1 = Math.min(d.y + d.h, p.top + p.docH * p.S);
    if (dx1 > dx0 && dy1 > dy0) {
      ctx.beginPath();
      ctx.rect(dx0, dy0, dx1 - dx0, dy1 - dy0);
      ctx.clip();
      const clip: PixRect = { x: Math.floor(dx0), y: Math.floor(dy0), w: Math.ceil(dx1) - Math.floor(dx0), h: Math.ceil(dy1) - Math.floor(dy0) };
      if (this.below) ctx.drawImage(this.below.cv, 0, 0);
      segs.forEach((s, i) => {
        if (s.kind === 'run') {
          const f = this.runs.get(i);
          if (f) ctx.drawImage(f.cv, 0, 0);
        } else this.drawObjects(ctx, [s.o], p, clip);
      });
    }
    ctx.restore();
  }

  /**
   * Prostokąt zmian od poprzedniego wywołania (do wgrania części tekstury) albo null = trzeba wgrać całość.
   * Wywoływane po każdym wgraniu bufora do GPU.
   */
  public takeDirty(): PixRect | null {
    const r = this.fullDirty ? null : this.pending ?? { x: 0, y: 0, w: 0, h: 0 };
    this.fullDirty = false;
    this.pending = null;
    return r;
  }
}
