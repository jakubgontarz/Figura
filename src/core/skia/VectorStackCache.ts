/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { VectorObject, boundsIntersect, vectorObjectBlend, vectorObjectBounds } from './VectorObjects.ts';
import { RasterRect, blendOp, compositeObjectsRegion, spritesFor } from './VectorSprites.ts';

/**
 * Podział stosu obiektów na czas edycji jednego (albo kilku przesuwanych) obiektów: "pod / edytowane / nad".
 *
 *   dół        - wszystkie obiekty leżące pod najniższym edytowanym, złożone raz (identycznie jak kolejne rysowanie)
 *   segmenty   - od najniższego edytowanego w górę: ciągi zwykłych (SrcOver) obiektów złożone w jedno płótno,
 *                każdy obiekt z innym trybem mieszania osobno (musi widzieć tło), edytowane obiekty jako "żywe"
 *
 * Klatka edycji składa dół, a potem segmenty tylko w odświeżanym prostokącie, więc koszt nie zależy od liczby obiektów
 * i od trybów mieszania nad edytowanym (dawna pamięć podręczna działała tylko dla samych SrcOver i dokumentów do 16 Mpx).
 * Bufory powstają leniwie, kawałkami CHUNK x CHUNK, więc duże dokumenty nie alokują niczego poza dotkniętymi miejscami.
 */

const CHUNK = 512;
const BUDGET_BYTES = 512 * 1024 * 1024;

type Seg =
  | { kind: 'run'; objs: VectorObject[] }
  | { kind: 'obj'; o: VectorObject }
  | { kind: 'live'; id: string };

export class CpuStack {
  private below: VectorObject[] = [];
  private segs: Seg[] = [];
  private chunks = new Map<string, HTMLCanvasElement | null>();
  private bytes = 0;
  private liveIdx = new Map<string, number>();

  /**
   * @param list widoczne obiekty warstwy od dołu do góry (stan z chwili otwarcia sesji; obiekty "żywe" są tylko znacznikami)
   * @param liveIds id obiektów edytowanych / przesuwanych
   */
  constructor(list: readonly VectorObject[], liveIds: ReadonlySet<string>, private docW: number, private docH: number) {
    let seenLive = false;
    for (const o of list) {
      const live = liveIds.has(o.id);
      if (!seenLive && !live) {
        this.below.push(o);
        continue;
      }
      seenLive = true;
      if (live) {
        this.segs.push({ kind: 'live', id: o.id });
      } else if (vectorObjectBlend(o) === 'SrcOver') {
        const last = this.segs[this.segs.length - 1];
        if (last && last.kind === 'run') last.objs.push(o);
        else this.segs.push({ kind: 'run', objs: [o] });
      } else {
        this.segs.push({ kind: 'obj', o });
      }
    }
  }

  private chunkCanvas(seg: number, cx: number, cy: number, objs: readonly VectorObject[]): HTMLCanvasElement | null {
    const key = `${seg}:${cx},${cy}`;
    const cached = this.chunks.get(key);
    if (cached !== undefined) return cached;
    const px = cx * CHUNK;
    const py = cy * CHUNK;
    const cw = Math.min(CHUNK, this.docW - px);
    const ch = Math.min(CHUNK, this.docH - py);
    let out: HTMLCanvasElement | null = null;
    if (cw > 0 && ch > 0) {
      const rect = { x0: px, y0: py, x1: px + cw, y1: py + ch };
      const hits = objs.filter((o) => boundsIntersect(vectorObjectBounds(o), rect));
      if (hits.length > 0) {
        out = document.createElement('canvas');
        out.width = cw;
        out.height = ch;
        compositeObjectsRegion(out.getContext('2d', { willReadFrequently: true })!, hits, px, py, cw, ch);
        this.bytes += cw * ch * 4;
        if (this.bytes > BUDGET_BYTES) {
          // za dużo kawałków: zaczynamy od nowa (kawałki odtworzą się leniwie)
          this.chunks.clear();
          this.bytes = cw * ch * 4;
        }
      }
    }
    this.chunks.set(key, out);
    return out;
  }

  /**
   * Składa stos w prostokącie dokumentu (x0, y0, w, h) na `ctx` (czysty kontekst tego rozmiaru).
   * `current` to bieżąca lista warstwy: z niej brane są aktualne stany obiektów "żywych".
   */
  public compose(ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number, current: readonly VectorObject[]): void {
    const clip: RasterRect = { x0, y0, x1: x0 + w, y1: y0 + h };
    const cx0 = Math.floor(x0 / CHUNK);
    const cx1 = Math.floor((x0 + w - 1) / CHUNK);
    const cy0 = Math.floor(y0 / CHUNK);
    const cy1 = Math.floor((y0 + h - 1) / CHUNK);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const drawChunks = (seg: number, objs: readonly VectorObject[]) => {
      if (objs.length === 0) return;
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = this.chunkCanvas(seg, cx, cy, objs);
          if (c) ctx.drawImage(c, cx * CHUNK - x0, cy * CHUNK - y0);
        }
      }
    };
    drawChunks(-1, this.below);
    for (let i = 0; i < this.segs.length; i++) {
      const s = this.segs[i];
      if (s.kind === 'run') {
        ctx.globalCompositeOperation = 'source-over';
        drawChunks(i, s.objs);
        continue;
      }
      let o: VectorObject | undefined;
      if (s.kind === 'obj') o = s.o;
      else {
        let at = this.liveIdx.get(s.id);
        if (at === undefined || current[at]?.id !== s.id) {
          at = current.findIndex((x) => x.id === s.id);
          this.liveIdx.set(s.id, at);
        }
        o = at >= 0 ? current[at] : undefined;
      }
      if (!o || !o.visible) continue;
      ctx.globalCompositeOperation = blendOp(vectorObjectBlend(o));
      // także obiekty „żywe” idą przez pamięć sprite'ów: przesunięcie o całkowite piksele nie rasteryzuje niczego
      for (const sp of spritesFor(o, 1, clip)) ctx.drawImage(sp.canvas, sp.x - x0, sp.y - y0);
    }
    ctx.restore();
  }
}
