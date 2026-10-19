/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TileGrid } from './TileGrid.ts';
import { Tile } from './Tile.ts';
import { SKBlendMode, SKColor } from './types.ts';


// --- Odroczone odświeżanie miniatur ---
// Miniatura nie jest potrzebna w trakcie edycji, więc odświeżanie jest scalane (debounce), wykonywane
// po jednej warstwie na zadanie i wstrzymywane, gdy czeka zdarzenie wejścia. Panel warstw dostaje powiadomienie.
const THUMB_MAX_W = 46;
const THUMB_MAX_H = 36;
const THUMB_DEBOUNCE_MS = 150;
const THUMB_MAX_WAIT_MS = 900;
const pendingThumbs = new Set<Layer>();
const urgentThumbs = new Set<Layer>();
const thumbListeners = new Set<() => void>();
let thumbTimer: ReturnType<typeof setTimeout> | null = null;
let thumbFirstAt = 0;

export function subscribeThumbnails(cb: () => void): () => void {
  thumbListeners.add(cb);
  return () => {
    thumbListeners.delete(cb);
  };
}

function armThumbTimer(delay: number): void {
  if (thumbTimer !== null) clearTimeout(thumbTimer);
  thumbTimer = setTimeout(pumpThumbs, delay);
}

function scheduleThumb(layer: Layer, urgent: boolean): void {
  (urgent ? urgentThumbs : pendingThumbs).add(layer);
  const now = performance.now();
  if (!thumbFirstAt) thumbFirstAt = now;
  armThumbTimer(Math.max(0, Math.min(THUMB_DEBOUNCE_MS, thumbFirstAt + THUMB_MAX_WAIT_MS - now)));
}

function pumpThumbs(): void {
  thumbTimer = null;
  const sched = (navigator as unknown as { scheduling?: { isInputPending?: () => boolean } }).scheduling;
  if (sched?.isInputPending?.()) {
    armThumbTimer(40);
    return;
  }
  const src = urgentThumbs.size > 0 ? urgentThumbs : pendingThumbs;
  const next = src.values().next();
  if (!next.done) {
    src.delete(next.value);
    pendingThumbs.delete(next.value);
    next.value.refreshThumbnail();
  }
  if (urgentThumbs.size > 0 || pendingThumbs.size > 0) {
    armThumbTimer(2);
    return;
  }
  thumbFirstAt = 0;
  for (const cb of Array.from(thumbListeners)) cb();
}

/** Zamienia piksele RGBA (maska w skali szarości) na kanał alfa: alfa = luminancja * alfa / 255. */
export function grayToAlpha(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = Math.round((lum * a) / 255);
  }
}

/**
 * Odpowiednik warstwy (Layer) w Paint.NET / SkiaSharp WPF.
 * Każda warstwa posiada własną siatkę kafelków (TileGrid),
 * parametry przezroczystości (opacity) oraz tryb mieszania (blendMode).
 */
export class Layer {
  public id: string;
  public name: string;
  public visible: boolean = true;
  public locked: boolean = false;
  public opacity: number = 1.0; // 0.0 .. 1.0
  public blendMode: SKBlendMode = 'SrcOver';
  /** Piksele warstwy (zawsze); `tileGrid` to cel edycji: piksele albo maska (patrz `editMask`). */
  public pixelGrid!: TileGrid;
  /** Maska przezroczystości: skala szarości zapisana w RGB (wartość = luminancja * alfa / 255); biel = widoczne, czerń = ukryte. */
  public maskGrid: TileGrid | null = null;
  /** true = narzędzia i operacje na „aktywnej warstwie” działają na masce. */
  public editMask: boolean = false;
  /** Czy maska jest stosowana przy wyświetlaniu / eksporcie (przełącznik widoczności maski). */
  public maskEnabled: boolean = true;
  /** Czy przekształcenia zawartości zaznaczenia (przesuń / skaluj / obróć) obejmują jednocześnie piksele i maskę. */
  public maskLinked: boolean = true;
  /** Tryb pomocniczy: warstwa-pośrednik pokazuje maskę w skali szarości (używane przy podglądzie maski na płótnie). */
  public grayView: boolean = false;
  private maskedCache = new WeakMap<Tile, { lv: number; mv: number; canvas: HTMLCanvasElement }>();
  private alphaCache = new WeakMap<Tile, { v: number; canvas: HTMLCanvasElement }>();
  private grayCache = new WeakMap<Tile, { v: number; canvas: HTMLCanvasElement }>();

  public get tileGrid(): TileGrid {
    return this.editMask && this.maskGrid ? this.maskGrid : this.pixelGrid;
  }
  public set tileGrid(g: TileGrid) {
    if (this.editMask && this.maskGrid) this.maskGrid = g;
    else this.pixelGrid = g;
  }

  public get hasMask(): boolean {
    return this.maskGrid !== null;
  }
  public thumbnailCanvas: HTMLCanvasElement;
  public thumbW: number = 44;
  public thumbH: number = 30;
  public thumbnailCtx: CanvasRenderingContext2D | null;
  public maskThumbnailCanvas: HTMLCanvasElement;
  private maskThumbDataUrl: string | null = null;
  /** Rośnie przy każdym faktycznym przerysowaniu miniatury. */
  public thumbVersion: number = 0;
  private thumbDirty: boolean = true;
  private thumbDataUrl: string | null = null;

  constructor(
    id: string,
    name: string,
    width: number,
    height: number,
    tileSize?: number
  ) {
    this.id = id;
    this.name = name;
    this.tileGrid = new TileGrid(width, height, tileSize);

    // Miniatura warstwy (do panelu warstw)
    this.thumbnailCanvas = document.createElement('canvas');
    // Miniatura zachowuje proporcje płótna (w ramce THUMB_MAX_W x THUMB_MAX_H)
    const ratio = width / Math.max(1, height);
    this.thumbW = Math.max(8, Math.min(THUMB_MAX_W, Math.round(ratio >= THUMB_MAX_W / THUMB_MAX_H ? THUMB_MAX_W : THUMB_MAX_H * ratio)));
    this.thumbH = Math.max(8, Math.min(THUMB_MAX_H, Math.round(ratio >= THUMB_MAX_W / THUMB_MAX_H ? THUMB_MAX_W / ratio : THUMB_MAX_H)));
    this.thumbnailCanvas.width = this.thumbW;
    this.thumbnailCanvas.height = this.thumbH;
    this.thumbnailCtx = this.thumbnailCanvas.getContext('2d');
    this.maskThumbnailCanvas = document.createElement('canvas');
    this.maskThumbnailCanvas.width = this.thumbW;
    this.maskThumbnailCanvas.height = this.thumbH;
  }

  /**
   * Zgłasza, że miniatura jest nieaktualna. Przerysowanie jest odroczone i scalone (patrz harmonogram wyżej);
   * `urgent` wystawia warstwę na początek kolejki (np. aktywną).
   */
  public updateThumbnail(urgent: boolean = false): void {
    this.thumbDirty = true;
    scheduleThumb(this, urgent);
  }

  /** Natychmiastowe przerysowanie miniatury (używane przez harmonogram). */
  public refreshThumbnail(): void {
    if (!this.thumbDirty || !this.thumbnailCtx) return;
    this.thumbDirty = false;

    const tw = this.thumbW;
    const th = this.thumbH;
    const ctx = this.thumbnailCtx;
    ctx.clearRect(0, 0, tw, th);

    const sz = 4;
    for (let y = 0; y < th; y += sz) {
      for (let x = 0; x < tw; x += sz) {
        ctx.fillStyle = (Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0 ? '#f0f0f0' : '#d0d0d0';
        ctx.fillRect(x, y, sz, sz);
      }
    }

    // Miniatura warstwy pokazuje ją z zastosowaną (włączoną) maską
    const px = document.createElement('canvas');
    px.width = tw;
    px.height = th;
    const pctx = px.getContext('2d')!;
    this.pixelGrid.drawThumbnail(pctx, tw, th);

    if (this.maskGrid) {
      const tmp = document.createElement('canvas');
      tmp.width = tw;
      tmp.height = th;
      const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
      this.maskGrid.drawThumbnail(tctx, tw, th);
      const img = tctx.getImageData(0, 0, tw, th);
      const d = img.data;
      // miniatura maski zawsze w skali szarości (kolory narysowane na masce liczą się jako luminancja)
      const alphaImg = new ImageData(new Uint8ClampedArray(d), tw, th);
      for (let i = 0; i < d.length; i += 4) {
        const g = Math.round((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * (d[i + 3] / 255));
        d[i] = d[i + 1] = d[i + 2] = g;
        d[i + 3] = 255;
        alphaImg.data[i] = alphaImg.data[i + 1] = alphaImg.data[i + 2] = 0;
        alphaImg.data[i + 3] = g;
      }
      const mctx = this.maskThumbnailCanvas.getContext('2d');
      if (mctx) {
        mctx.putImageData(img, 0, 0);
      }
      if (this.maskEnabled) {
        const at = document.createElement('canvas');
        at.width = tw;
        at.height = th;
        at.getContext('2d')!.putImageData(alphaImg, 0, 0);
        pctx.globalCompositeOperation = 'destination-in';
        pctx.drawImage(at, 0, 0);
        pctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.drawImage(px, 0, 0);
    this.thumbVersion++;
    this.thumbDataUrl = null;
    this.maskThumbDataUrl = null;
  }

  /** Adres data: miniatury maski (null, gdy warstwa nie ma maski). */
  public getMaskThumbnailDataUrl(): string | null {
    if (!this.maskGrid) return null;
    if (this.maskThumbDataUrl === null) this.maskThumbDataUrl = this.maskThumbnailCanvas.toDataURL();
    return this.maskThumbDataUrl;
  }

  /** Adres data: miniatury (buforowany do następnego przerysowania). */
  public getThumbnailDataUrl(): string {
    if (this.thumbDataUrl === null) this.thumbDataUrl = this.thumbnailCanvas.toDataURL();
    return this.thumbDataUrl;
  }

  public clone(newId?: string, newName?: string): Layer {
    const copy = new Layer(
      newId || `layer_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      newName || `${this.name} (Kopia)`,
      this.tileGrid.width,
      this.tileGrid.height,
      this.tileGrid.tileSize
    );
    copy.visible = this.visible;
    copy.locked = this.locked;
    copy.opacity = this.opacity;
    copy.blendMode = this.blendMode;
    copy.pixelGrid = this.pixelGrid.clone();
    copy.maskGrid = this.maskGrid ? this.maskGrid.clone() : null;
    copy.editMask = this.editMask;
    copy.maskEnabled = this.maskEnabled;
    copy.maskLinked = this.maskLinked;
    // Kopia dostaje gotową miniaturę zamiast pełnego przeliczania; jeśli źródło jest nieaktualne, kopia też się odświeży
    if (this.thumbDirty || !copy.thumbnailCtx || this.maskGrid) {
      copy.updateThumbnail();
    } else {
      copy.thumbnailCtx.clearRect(0, 0, copy.thumbW, copy.thumbH);
      copy.thumbnailCtx.drawImage(this.thumbnailCanvas, 0, 0);
      copy.thumbDirty = false;
      copy.thumbVersion++;
    }
    return copy;
  }

  // --- MASKA PRZEZROCZYSTOŚCI ---

  /**
   * Tworzy maskę. Bez `selection`: cała biała (warstwa w pełni widoczna). Z `selection` (kanał alfa płótna zaznaczenia):
   * biel w zaznaczeniu (także częściowa, wg krycia zaznaczenia), czerń poza nim.
   */
  public createMask(selection?: HTMLCanvasElement | null): void {
    const g = new TileGrid(this.pixelGrid.width, this.pixelGrid.height, this.pixelGrid.tileSize);
    let white: HTMLCanvasElement | null = null;
    if (selection) {
      white = document.createElement('canvas');
      white.width = g.width;
      white.height = g.height;
      const wctx = white.getContext('2d')!;
      wctx.drawImage(selection, 0, 0);
      wctx.globalCompositeOperation = 'source-in';
      wctx.fillStyle = '#ffffff';
      wctx.fillRect(0, 0, g.width, g.height);
    }
    for (const row of g.tiles) {
      for (const t of row) {
        if (white) {
          t.ctx.fillStyle = '#000000';
          t.ctx.fillRect(0, 0, t.width, t.height);
          t.ctx.drawImage(white, t.pixelX, t.pixelY, t.width, t.height, 0, 0, t.width, t.height);
          t.hasContent = true;
          t.isDirty = true;
        } else {
          t.fill({ r: 255, g: 255, b: 255, a: 255 });
        }
      }
    }
    this.maskGrid = g;
    this.maskEnabled = true;
    this.editMask = true;
    this.updateThumbnail(true);
  }

  /** Usuwa maskę (bez wpływu na piksele). */
  public dropMask(): void {
    this.maskGrid = null;
    this.editMask = false;
    this.maskEnabled = true;
    this.updateThumbnail(true);
  }

  /** Wpieka maskę w piksele warstwy i usuwa ją. */
  public applyMask(): void {
    if (!this.maskGrid) return;
    for (const row of this.pixelGrid.tiles) {
      for (const t of row) {
        if (!t.hasContent) continue;
        const rc = this.renderCanvas(t);
        t.ctx.clearRect(0, 0, t.width, t.height);
        if (rc) t.ctx.drawImage(rc, 0, 0);
        t.isDirty = true;
      }
    }
    // maska nieaktywna (wyłączona) nie zmienia pikseli przy zastosowaniu: wynik = piksele bez maski
    this.dropMask();
  }

  private alphaCanvasFor(maskTile: Tile): HTMLCanvasElement {
    let e = this.alphaCache.get(maskTile);
    if (e && e.v === maskTile.version) return e.canvas;
    const canvas = e ? e.canvas : document.createElement('canvas');
    canvas.width = Math.max(1, maskTile.width);
    canvas.height = Math.max(1, maskTile.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (maskTile.hasContent && maskTile.width > 0 && maskTile.height > 0) {
      const img = maskTile.ctx.getImageData(0, 0, maskTile.width, maskTile.height);
      grayToAlpha(img.data);
      ctx.putImageData(img, 0, 0);
    }
    this.alphaCache.set(maskTile, { v: maskTile.version, canvas });
    return canvas;
  }

  /** Maska w skali szarości jako nieprzezroczysty kafelek (czarne tło pod niepokrytymi pikselami). */
  public grayCanvasFor(maskTile: Tile): HTMLCanvasElement {
    let e = this.grayCache.get(maskTile);
    if (e && e.v === maskTile.version) return e.canvas;
    const canvas = e ? e.canvas : document.createElement('canvas');
    canvas.width = Math.max(1, maskTile.width);
    canvas.height = Math.max(1, maskTile.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (maskTile.hasContent && maskTile.width > 0 && maskTile.height > 0) {
      const img = maskTile.ctx.getImageData(0, 0, maskTile.width, maskTile.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = Math.round((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * (d[i + 3] / 255));
        d[i] = d[i + 1] = d[i + 2] = g;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    this.grayCache.set(maskTile, { v: maskTile.version, canvas });
    return canvas;
  }

  /**
   * Kafelek pikseli do narysowania w kompozycji: z zastosowaną maską (jeśli jest i jest włączona) albo oryginalny.
   * W trybie `grayView` (podgląd maski) zwraca maskę w skali szarości.
   */
  public renderCanvas(tile: Tile): HTMLCanvasElement | null {
    if (this.grayView) return this.grayCanvasFor(tile);
    const mg = this.maskGrid;
    if (!mg || !this.maskEnabled) return tile.canvas;
    const mt = mg.tiles[tile.tileY]?.[tile.tileX];
    if (!mt) return tile.canvas;
    const hit = this.maskedCache.get(tile);
    if (hit && hit.lv === tile.version && hit.mv === mt.version) return hit.canvas;
    const canvas = hit ? hit.canvas : document.createElement('canvas');
    canvas.width = Math.max(1, tile.width);
    canvas.height = Math.max(1, tile.height);
    const ctx = canvas.getContext('2d')!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tile.canvas, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.alphaCanvasFor(mt), 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    this.maskedCache.set(tile, { lv: tile.version, mv: mt.version, canvas });
    return canvas;
  }

  /** Czy warstwa wymaga przetwarzania przy rysowaniu kafelków (maska włączona albo podgląd maski). */
  public get usesRenderTransform(): boolean {
    return this.grayView || (!!this.maskGrid && this.maskEnabled);
  }

  /** Rysuje całą warstwę (z maską) na kontekście w układzie dokumentu. */
  public drawRenderedToContext(ctx: CanvasRenderingContext2D): void {
    if (!this.usesRenderTransform) {
      this.pixelGrid.drawToFlatContext(ctx);
      return;
    }
    for (const row of this.pixelGrid.tiles) {
      for (const t of row) {
        if (!t.hasContent && !this.grayView) continue;
        const rc = this.renderCanvas(t);
        if (rc) ctx.drawImage(rc, t.pixelX, t.pixelY);
      }
    }
  }

  /** Jak `drawCroppedToContext` siatki, ale z maską. */
  public drawRenderedCropped(ctx: CanvasRenderingContext2D, cropX: number, cropY: number, cropW: number, cropH: number): void {
    if (!this.usesRenderTransform) {
      this.pixelGrid.drawCroppedToContext(ctx, cropX, cropY, cropW, cropH);
      return;
    }
    const g = this.pixelGrid;
    const minTx = Math.max(0, Math.floor(cropX / g.tileSize));
    const maxTx = Math.min(g.cols - 1, Math.floor((cropX + cropW - 1) / g.tileSize));
    const minTy = Math.max(0, Math.floor(cropY / g.tileSize));
    const maxTy = Math.min(g.rows - 1, Math.floor((cropY + cropH - 1) / g.tileSize));
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const t = g.tiles[ty][tx];
        if (!t.hasContent && !this.grayView) continue;
        const rc = this.renderCanvas(t);
        if (rc) ctx.drawImage(rc, 0, 0, t.width, t.height, t.pixelX - cropX, t.pixelY - cropY, t.width, t.height);
      }
    }
  }

  /** Płaskie płótno całej warstwy z zastosowaną maską. */
  public renderFlatCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.pixelGrid.width;
    c.height = this.pixelGrid.height;
    this.drawRenderedToContext(c.getContext('2d')!);
    return c;
  }

  /**
   * Podgląd na żywo podczas edycji MASKI (np. pociągnięcie pędzlem): `maskRegion` to obszar (x, y, w, h) płótna maski
   * z naniesionym już podglądem; wynik to piksele warstwy w tym obszarze zamaskowane taką maską.
   */
  public composeWithMaskRegion(maskRegion: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d', { willReadFrequently: true })!;
    this.pixelGrid.drawCroppedToContext(octx, x, y, w, h);
    const mctx = maskRegion.getContext('2d', { willReadFrequently: true })!;
    const mimg = mctx.getImageData(0, 0, w, h);
    grayToAlpha(mimg.data);
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.putImageData(mimg, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(tmp, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    return out;
  }

  /** Nakłada maskę warstwy (jak jest teraz) na podany fragment pikseli (podgląd pędzla na żywo przy edycji pikseli). */
  public applyMaskToRegion(pixels: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const mg = this.maskGrid;
    if (!mg || !this.maskEnabled || this.editMask) return pixels;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d')!;
    octx.drawImage(pixels, 0, 0, w, h, 0, 0, w, h);
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, w, h);
    mg.drawCroppedToContext(tctx, x, y, w, h);
    const mimg = tctx.getImageData(0, 0, w, h);
    grayToAlpha(mimg.data);
    tctx.putImageData(mimg, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(tmp, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    return out;
  }

  /**
   * Wypełnia warstwę kolorem (z opcjonalnym maskowaniem zaznaczenia)
   */
  public fill(color: SKColor, selectionMask?: HTMLCanvasElement | null): void {
    if (!selectionMask) {
      this.tileGrid.fill(color);
    } else {
      const flat = this.tileGrid.compositeToFlatCanvas();
      const ctx = flat.getContext('2d')!;
      const mctx = selectionMask.getContext('2d')!;
      const maskData = mctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height).data;
      const imgData = ctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height);
      const data = imgData.data;

      for (let i = 0; i < data.length; i += 4) {
        const mAlpha = maskData[i + 3];
        if (mAlpha > 0) {
          const norm = mAlpha / 255;
          data[i] = Math.round(data[i] * (1 - norm) + color.r * norm);
          data[i + 1] = Math.round(data[i + 1] * (1 - norm) + color.g * norm);
          data[i + 2] = Math.round(data[i + 2] * (1 - norm) + color.b * norm);
          data[i + 3] = Math.max(data[i + 3], Math.round(color.a * norm));
        }
      }
      ctx.putImageData(imgData, 0, 0);

      for (let ty = 0; ty < this.tileGrid.rows; ty++) {
        for (let tx = 0; tx < this.tileGrid.cols; tx++) {
          const tile = this.tileGrid.tiles[ty][tx];
          tile.ctx.clearRect(0, 0, tile.width, tile.height);
          tile.ctx.drawImage(flat, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
          tile.hasContent = true;
          tile.isDirty = true;
        }
      }
    }
    this.updateThumbnail();
  }

  /**
   * Czyści warstwę (z opcjonalnym maskowaniem zaznaczenia)
   */
  public clear(selectionMask?: HTMLCanvasElement | null): void {
    if (!selectionMask) {
      this.tileGrid.clear();
    } else {
      for (let ty = 0; ty < this.tileGrid.rows; ty++) {
        for (let tx = 0; tx < this.tileGrid.cols; tx++) {
          const tile = this.tileGrid.tiles[ty][tx];
          if (!tile.hasContent) continue;
          tile.ctx.save();
          tile.ctx.globalCompositeOperation = 'destination-out';
          tile.ctx.drawImage(
            selectionMask,
            tile.pixelX, tile.pixelY, tile.width, tile.height,
            0, 0, tile.width, tile.height
          );
          tile.ctx.restore();
          tile.isDirty = true;
        }
      }
    }
    this.updateThumbnail();
  }

  /**
   * Odwraca kolory (Invert Colors)
   */
  public invertColors(selectionMask?: HTMLCanvasElement | null): void {
    const mctx = selectionMask?.getContext('2d');
    const maskData = mctx ? mctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height).data : null;

    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        if (!tile.hasContent) continue;

        const imgData = tile.ctx.getImageData(0, 0, tile.width, tile.height);
        const data = imgData.data;

        for (let y = 0; y < tile.height; y++) {
          for (let x = 0; x < tile.width; x++) {
            const i = (y * tile.width + x) * 4;
            if (data[i + 3] > 0) {
              const gx = tile.pixelX + x;
              const gy = tile.pixelY + y;
              const gIdx = (gy * this.tileGrid.width + gx) * 4;
              const mAlpha = maskData ? maskData[gIdx + 3] : 255;

              if (mAlpha > 0) {
                data[i] = 255 - data[i];
                data[i + 1] = 255 - data[i + 1];
                data[i + 2] = 255 - data[i + 2];
              }
            }
          }
        }
        tile.ctx.putImageData(imgData, 0, 0);
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /**
   * Skala szarości (Grayscale)
   */
  public toGrayscale(selectionMask?: HTMLCanvasElement | null): void {
    const mctx = selectionMask?.getContext('2d');
    const maskData = mctx ? mctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height).data : null;

    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        if (!tile.hasContent) continue;

        const imgData = tile.ctx.getImageData(0, 0, tile.width, tile.height);
        const data = imgData.data;

        for (let y = 0; y < tile.height; y++) {
          for (let x = 0; x < tile.width; x++) {
            const i = (y * tile.width + x) * 4;
            if (data[i + 3] > 0) {
              const gx = tile.pixelX + x;
              const gy = tile.pixelY + y;
              const gIdx = (gy * this.tileGrid.width + gx) * 4;
              const mAlpha = maskData ? maskData[gIdx + 3] : 255;

              if (mAlpha > 0) {
                const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
                data[i] = gray;
                data[i + 1] = gray;
                data[i + 2] = gray;
              }
            }
          }
        }
        tile.ctx.putImageData(imgData, 0, 0);
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /**
   * Regulacja Jasności i Kontrastu (Brightness / Contrast)
   */
  public adjustBrightnessContrast(brightness: number, contrast: number, selectionMask?: HTMLCanvasElement | null): void {
    const b = brightness;
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    const mctx = selectionMask?.getContext('2d');
    const maskData = mctx ? mctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height).data : null;

    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        if (!tile.hasContent) continue;

        const imgData = tile.ctx.getImageData(0, 0, tile.width, tile.height);
        const data = imgData.data;

        for (let y = 0; y < tile.height; y++) {
          for (let x = 0; x < tile.width; x++) {
            const i = (y * tile.width + x) * 4;
            if (data[i + 3] > 0) {
              const gx = tile.pixelX + x;
              const gy = tile.pixelY + y;
              const gIdx = (gy * this.tileGrid.width + gx) * 4;
              const mAlpha = maskData ? maskData[gIdx + 3] : 255;

              if (mAlpha > 0) {
                let r = data[i] + b;
                let g = data[i + 1] + b;
                let bVal = data[i + 2] + b;

                r = factor * (r - 128) + 128;
                g = factor * (g - 128) + 128;
                bVal = factor * (bVal - 128) + 128;

                data[i] = Math.max(0, Math.min(255, Math.round(r)));
                data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
                data[i + 2] = Math.max(0, Math.min(255, Math.round(bVal)));
              }
            }
          }
        }
        tile.ctx.putImageData(imgData, 0, 0);
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /** Odbicie obejmuje piksele i maskę (operacja na całym obrazie). */
  public flipHorizontal(): void {
    const was = this.editMask;
    this.editMask = false;
    this.flipTargetHorizontal();
    if (this.maskGrid) {
      this.editMask = true;
      this.flipTargetHorizontal();
    }
    this.editMask = was;
  }

  private flipTargetHorizontal(): void {
    const flat = this.tileGrid.compositeToFlatCanvas();
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.tileGrid.width;
    tempCanvas.height = this.tileGrid.height;
    const tctx = tempCanvas.getContext('2d')!;
    tctx.translate(this.tileGrid.width, 0);
    tctx.scale(-1, 1);
    tctx.drawImage(flat, 0, 0);

    this.tileGrid.clear();
    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        tile.ctx.drawImage(
          tempCanvas,
          tile.pixelX, tile.pixelY, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /** Odbicie obejmuje piksele i maskę (operacja na całym obrazie). */
  public flipVertical(): void {
    const was = this.editMask;
    this.editMask = false;
    this.flipTargetVertical();
    if (this.maskGrid) {
      this.editMask = true;
      this.flipTargetVertical();
    }
    this.editMask = was;
  }

  private flipTargetVertical(): void {
    const flat = this.tileGrid.compositeToFlatCanvas();
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.tileGrid.width;
    tempCanvas.height = this.tileGrid.height;
    const tctx = tempCanvas.getContext('2d')!;
    tctx.translate(0, this.tileGrid.height);
    tctx.scale(1, -1);
    tctx.drawImage(flat, 0, 0);

    this.tileGrid.clear();
    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        tile.ctx.drawImage(
          tempCanvas,
          tile.pixelX, tile.pixelY, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }
}
