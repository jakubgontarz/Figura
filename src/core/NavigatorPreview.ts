/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GraphicEngine } from './GraphicEngine.ts';
import type { Layer } from './Layer.ts';
import type { TileGrid } from './TileGrid.ts';
import { getTileEpoch } from './Tile.ts';
import { getCanvasCompositeOperation } from './types.ts';

/**
 * Miniatura całego dokumentu dla panelu „Nawigator”.
 *
 * Nie korzysta z kompozytora GPU widoku (nie rusza jego puli kafelków ani niczego nie wysyła na kartę): każda siatka pikseli
 * warstwy ma własną, pomniejszoną kopię (1/`div` rozmiaru), odświeżaną PRZYROSTOWO: przerysowywane są tylko kafelki, których
 * wersja się zmieniła, w ograniczonych czasowo porcjach. Z tych kopii składa się niewielki obraz (krycie, tryby mieszania,
 * maski i grupy jak w kompozycji dokumentu). Korekcje, efekty i filtry warstw nie są uwzględniane: to podgląd orientacyjny.
 */

/** Dłuższy bok miniatury w pikselach ekranu. */
export const NAV_MAX = 320;

interface Reduced {
  div: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  versions: Int32Array;
  content: Uint8Array;
  /** Liczba kafelków, które jeszcze czekają na przerysowanie po ostatnim przeglądzie. */
  stale: number;
  /** Licznik zmian kopii (rośnie przy każdym przerysowanym kafelku) – klucz pamięci podręcznej miniatur warstw. */
  gen: number;
}

/** Gotowa miniatura jednej warstwy (z maską), przeliczana tylko wtedy, gdy zmieniła się kopia pikseli lub maski. */
interface LayerBmp {
  canvas: HTMLCanvasElement;
  pr: Reduced;
  pgen: number;
  mr: Reduced | null;
  mgen: number;
  w: number;
  h: number;
}

function sizeOf(engine: GraphicEngine, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(engine.width, engine.height));
  return { w: Math.max(1, Math.round(engine.width * k)), h: Math.max(1, Math.round(engine.height * k)) };
}

/** Największy dzielnik (potęga dwójki dzieląca rozmiar kafelka), przy którym kopia nadal ma ≥ 2x rozmiaru miniatury. */
function pickDiv(grid: TileGrid, max: number): number {
  let div = 1;
  const longSide = Math.max(grid.width, grid.height);
  while (div * 2 <= grid.tileSize && grid.tileSize % (div * 2) === 0 && longSide / (div * 2) >= max * 1.5) div *= 2;
  return div;
}

export class NavigatorPreview {
  /** Gotowa miniatura (rozmiar `sizeOf`); nowa zawartość pojawia się po `update`. */
  public readonly canvas: HTMLCanvasElement = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private reduced = new WeakMap<TileGrid, Reduced>();
  private bitmaps = new WeakMap<Layer, LayerBmp>();
  private sigDone = '';
  private pendingWork = true;
  private lastCompose = 0;

  /** `max` = dłuższy bok miniatury (domyślnie NAV_MAX; panel Kanały używa małych miniatur). */
  constructor(private engine: GraphicEngine, private max: number = NAV_MAX) {
    const s = sizeOf(engine, max);
    this.canvas.width = s.w;
    this.canvas.height = s.h;
    this.ctx = this.canvas.getContext('2d')!;
  }

  /** Podpis wszystkiego, co wpływa na wygląd miniatury poza samymi pikselami (kolejność, krycie, tryby, widoczność). */
  private structSig(): string {
    const e = this.engine;
    let s = `${e.width}x${e.height}|${getTileEpoch()}`;
    for (const l of e.layers) {
      s += `|${l.id}:${l.ownVisible ? 1 : 0}${l.groupHidden ? 'h' : ''}:${l.opacity}:${l.blendMode}:${l.groupId ?? ''}:${l.maskEnabled && l.hasMask ? 'm' : ''}`;
    }
    return s;
  }

  /** Czy od ostatniego pełnego odświeżenia coś mogło się zmienić (tania kontrola, bez przeglądu kafelków). */
  public get dirty(): boolean {
    return this.pendingWork || this.structSig() !== this.sigDone;
  }

  /**
   * Odświeża kopie warstw i składa miniaturę. Przerywa się po `budgetMs` (praca jest wznawiana kolejnym wywołaniem);
   * zwraca true, gdy miniatura jest już aktualna.
   */
  public update(budgetMs: number): boolean {
    const e = this.engine;
    const t0 = performance.now();
    const sig = this.structSig();
    if (!this.pendingWork && sig === this.sigDone) return true;

    const s = sizeOf(e, this.max);
    if (this.canvas.width !== s.w || this.canvas.height !== s.h) {
      this.canvas.width = s.w;
      this.canvas.height = s.h;
      this.ctx = this.canvas.getContext('2d')!;
    }

    let complete = true;
    for (const l of e.layers) {
      if (l.isAdjustment) continue;
      if (!this.layerNeeded(l)) continue;
      if (!l.isGroup) {
        // warstwa wektorowa z zaległym uzupełnieniem pikseli: nie wymuszamy go z poziomu podglądu (zrobi to widok)
        if (l.vecPending) { complete = false; continue; }
        if (!this.refresh(l.pixelGridPeek, t0, budgetMs)) { complete = false; break; }
      }
      const mg = l.hasMask && l.maskEnabled ? l.maskGridPeek : null;
      if (mg && !l.maskPending && !this.refresh(mg, t0, budgetMs)) { complete = false; break; }
      // miniaturę warstwy przeliczamy tutaj (w ramach budżetu), żeby samo składanie było tanie
      if (!l.isGroup && !l.vecPending) {
        this.layerBitmap(l, this.canvas.width, this.canvas.height);
        if (performance.now() - t0 > budgetMs) { complete = false; break; }
      }
    }
    // pełne składanie dopiero po zakończeniu przeglądu (przy długim odświeżaniu: co pół sekundy, żeby obraz „dochodził”)
    const now = performance.now();
    if (complete || now - this.lastCompose > 500) {
      this.compose();
      this.lastCompose = now;
    }
    this.pendingWork = !complete;
    if (complete) this.sigDone = sig;
    return complete;
  }

  private layerNeeded(l: Layer): boolean {
    return l.ownVisible && !l.groupHidden && l.opacity > 0;
  }

  /** Przegląd kafelków siatki: przerysowuje zmienione do budżetu czasu. Zwraca false, gdy budżet się skończył. */
  private refresh(grid: TileGrid, t0: number, budgetMs: number): boolean {
    let r = this.reduced.get(grid);
    const div = pickDiv(grid, this.max);
    const mw = Math.max(1, Math.ceil(grid.width / div));
    const mh = Math.max(1, Math.ceil(grid.height / div));
    const n = grid.rows * grid.cols;
    if (!r || r.div !== div || r.canvas.width !== mw || r.canvas.height !== mh || r.versions.length !== n) {
      const canvas = document.createElement('canvas');
      canvas.width = mw;
      canvas.height = mh;
      // procesorowe płótno: kafelki dokumentu też są procesorowe, więc rysowanie nie wymaga wysyłania ich na kartę
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return true;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';
      r = { div, canvas, ctx, versions: new Int32Array(n).fill(-1), content: new Uint8Array(n), stale: n, gen: 0 };
      this.reduced.set(grid, r);
    }
    const mx = r.ctx;
    let drawn = 0;
    let stale = 0;
    for (let ty = 0; ty < grid.rows; ty++) {
      for (let tx = 0; tx < grid.cols; tx++) {
        const tile = grid.tiles[ty][tx];
        const i = ty * grid.cols + tx;
        const has = tile.hasContent ? 1 : 0;
        if (r.versions[i] === tile.version && r.content[i] === has) continue;
        // Kafelek, który nigdy nie miał treści, a nadal jej nie ma, nie wymaga rysowania (kopia jest pusta)
        if (!has && r.versions[i] === -1) {
          r.versions[i] = tile.version;
          r.content[i] = 0;
          continue;
        }
        if ((++drawn & 7) === 0 && performance.now() - t0 > budgetMs) { r.stale = stale + 1; return false; }
        r.versions[i] = tile.version;
        r.content[i] = has;
        r.gen++;
        const dx = tile.pixelX / div;
        const dy = tile.pixelY / div;
        const dw = tile.width / div;
        const dh = tile.height / div;
        mx.clearRect(dx, dy, Math.ceil(dw), Math.ceil(dh));
        if (has) mx.drawImage(tile.canvas, 0, 0, tile.width, tile.height, dx, dy, dw, dh);
      }
    }
    r.stale = 0;
    return true;
  }

  /** Piksele warstwy jako kopia o rozmiarze miniatury (z maską, jeśli jest włączona). */
  private layerBitmap(l: Layer, w: number, h: number): HTMLCanvasElement | null {
    const pr = this.reduced.get(l.pixelGridPeek);
    if (!pr) return null;
    const useMask = l.hasMask && l.maskEnabled;
    const mg = useMask ? l.maskGridPeek : null;
    const mr = mg ? this.reduced.get(mg) ?? null : null;
    const hit = this.bitmaps.get(l);
    if (hit && hit.pr === pr && hit.pgen === pr.gen && hit.mr === mr && hit.mgen === (mr ? mr.gen : 0) && hit.w === w && hit.h === h) return hit.canvas;
    const out = hit && hit.w === w && hit.h === h ? hit.canvas : document.createElement('canvas');
    out.width = w;
    out.height = h;
    const c = out.getContext('2d', { willReadFrequently: true })!;
    c.clearRect(0, 0, w, h);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(pr.canvas, 0, 0, pr.canvas.width, pr.canvas.height, 0, 0, w, h);
    const res = useMask ? this.applyMask(l, out, w, h) : out;
    this.bitmaps.set(l, { canvas: res, pr, pgen: pr.gen, mr, mgen: mr ? mr.gen : 0, w, h });
    return res;
  }

  private applyMask(l: Layer, bmp: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
    const mg = l.maskGridPeek;
    const mr = mg ? this.reduced.get(mg) : undefined;
    if (!mr) return bmp;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const t = tmp.getContext('2d', { willReadFrequently: true })!;
    t.fillStyle = '#fff';
    t.fillRect(0, 0, w, h);
    t.imageSmoothingEnabled = true;
    t.imageSmoothingQuality = 'high';
    t.drawImage(mr.canvas, 0, 0, mr.canvas.width, mr.canvas.height, 0, 0, w, h);
    const img = t.getImageData(0, 0, w, h);
    const d = img.data;
    // jasność maski -> przezroczystość (jak `grayToAlpha` w kompozycji dokumentu)
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = 0;
      d[i + 3] = Math.round((lum * d[i + 3]) / 255);
    }
    t.putImageData(img, 0, 0);
    const c = bmp.getContext('2d')!;
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(tmp, 0, 0);
    c.globalCompositeOperation = 'source-over';
    return bmp;
  }

  /** Składa miniaturę z kopii warstw: pierwsza warstwa na dole, grupy izolowane w osobnym buforze zamykanym po ostatnim dziecku. */
  private compose(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);
    const L = this.engine.layers;
    const byId = new Map<string, Layer>();
    const index = new Map<string, number>();
    L.forEach((l, i) => { byId.set(l.id, l); index.set(l.id, i); });
    const isolated = new Set<string>();
    for (const l of L) if (l.isGroup && this.engine.groupKind(l) !== 'none') isolated.add(l.id);

    // najbliższa izolowana grupa nadrzędna (null = rysujemy wprost na dokumencie)
    const isoOwner = (l: Layer): Layer | null => {
      let g = l.groupId ? byId.get(l.groupId) : undefined;
      for (let n = 0; g && n < 64; n++) {
        if (isolated.has(g.id)) return g;
        g = g.groupId ? byId.get(g.groupId) : undefined;
      }
      return null;
    };
    const depth = (l: Layer): number => {
      let d = 0;
      let g = l.groupId ? byId.get(l.groupId) : undefined;
      while (g && d < 64) { d++; g = g.groupId ? byId.get(g.groupId) : undefined; }
      return d;
    };

    // grupę domykamy po jej ostatnim elemencie (nagłówek może leżeć przed dziećmi albo za nimi)
    const closeAt = new Map<string, number>();
    for (const id of isolated) closeAt.set(id, index.get(id)!);
    for (const l of L) {
      let g = l.groupId ? byId.get(l.groupId) : undefined;
      for (let n = 0; g && n < 64; n++) {
        if (isolated.has(g.id)) closeAt.set(g.id, Math.max(closeAt.get(g.id)!, index.get(l.id)!));
        g = g.groupId ? byId.get(g.groupId) : undefined;
      }
    }
    const closing = new Map<number, Layer[]>();
    for (const [id, at] of closeAt) {
      const a = closing.get(at) ?? [];
      a.push(byId.get(id)!);
      closing.set(at, a);
    }

    const buffers = new Map<string, CanvasRenderingContext2D>();
    const ctxOf = (g: Layer | null): CanvasRenderingContext2D => {
      if (!g) return ctx;
      let bc = buffers.get(g.id);
      if (!bc) {
        const b = document.createElement('canvas');
        b.width = w;
        b.height = h;
        bc = b.getContext('2d')!;
        buffers.set(g.id, bc);
      }
      return bc;
    };

    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      if (!l.isGroup && !l.isAdjustment && this.layerNeeded(l)) {
        const bmp = this.layerBitmap(l, w, h);
        if (bmp) {
          const target = ctxOf(isoOwner(l));
          target.save();
          target.globalAlpha = l.opacity;
          target.globalCompositeOperation = getCanvasCompositeOperation(l.blendMode === 'PassThrough' ? 'SrcOver' : l.blendMode);
          target.drawImage(bmp, 0, 0);
          target.restore();
        }
      }
      const toClose = closing.get(i);
      if (!toClose) continue;
      toClose.sort((a, b) => depth(b) - depth(a));
      for (const g of toClose) {
        const bc = buffers.get(g.id);
        if (!bc || !g.ownVisible || g.groupHidden || g.opacity <= 0) continue;
        let src = bc.canvas;
        if (g.hasMask && g.maskEnabled) src = this.applyMask(g, src, w, h);
        const target = ctxOf(isoOwner(g));
        target.save();
        target.globalAlpha = g.opacity;
        target.globalCompositeOperation = getCanvasCompositeOperation(g.blendMode === 'PassThrough' ? 'SrcOver' : g.blendMode);
        target.drawImage(src, 0, 0);
        target.restore();
      }
    }
  }
}
