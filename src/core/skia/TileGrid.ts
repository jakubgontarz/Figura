/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tile } from './Tile.ts';
import { SKBlendMode, SKColor, SKRectI } from './types.ts';

export const DEFAULT_TILE_SIZE = 64;

/** Migawka jednego kafelka (Undo/Redo). */
export interface TileSnapshot {
  tx: number;
  ty: number;
  imgData: ImageData;
  hasContent: boolean;
}

/**
 * Puste kafelki (hasContent === false) nie mają pikseli do zapamiętania, więc wszystkie migawki
 * współdzielą jeden, tylko do odczytu, wyzerowany ImageData danego rozmiaru zamiast kopii 16 KB na kafelek.
 * putImageData z samymi zerami przywraca stan pusty tak samo jak kopia.
 */
const emptyImageDataCache = new Map<string, ImageData>();
const sharedEmptyImageData = new WeakSet<ImageData>();

function getSharedEmptyImageData(w: number, h: number): ImageData {
  const key = `${w}x${h}`;
  let img = emptyImageDataCache.get(key);
  if (!img) {
    img = new ImageData(w, h);
    emptyImageDataCache.set(key, img);
    sharedEmptyImageData.add(img);
  }
  return img;
}


function sameTileSnapshot(a: TileSnapshot, b: TileSnapshot): boolean {
  if (a.hasContent !== b.hasContent) return false;
  if (a.imgData === b.imgData) return true;
  const da = a.imgData.data;
  const db = b.imgData.data;
  if (da.length !== db.length) return false;
  if (sharedEmptyImageData.has(a.imgData) && sharedEmptyImageData.has(b.imgData)) return true;
  const n = da.length >> 2;
  const ua = new Uint32Array(da.buffer, da.byteOffset, n);
  const ub = new Uint32Array(db.buffer, db.byteOffset, n);
  for (let i = 0; i < n; i++) {
    if (ua[i] !== ub[i]) return false;
  }
  return true;
}

/**
 * Z dwóch migawek tych samych kafelków usuwa kafelki, które operacja nie zmieniła.
 * Dzięki temu historia trzyma tylko faktycznie zmienione kafelki, nawet gdy migawkę zrobiono dla całej warstwy.
 */
export function trimUnchangedTiles(
  before: TileSnapshot[],
  after: TileSnapshot[]
): { before: TileSnapshot[]; after: TileSnapshot[] } {
  const key = (t: TileSnapshot) => t.ty * 65536 + t.tx;
  const afterMap = new Map<number, TileSnapshot>();
  for (const a of after) afterMap.set(key(a), a);
  const unchanged = new Set<number>();
  const keepBefore: TileSnapshot[] = [];
  for (const b of before) {
    const a = afterMap.get(key(b));
    if (a && sameTileSnapshot(b, a)) {
      unchanged.add(key(b));
    } else {
      keepBefore.push(b);
    }
  }
  const keepAfter = after.filter((a) => !unchanged.has(key(a)));
  return { before: keepBefore, after: keepAfter };
}

/** Pamięć zajmowana przez migawki (bez współdzielonych pustych buforów i bez podwójnego liczenia). */
export function snapshotBytes(...lists: TileSnapshot[][]): number {
  let bytes = 0;
  const seen = new Set<ImageData>();
  for (const list of lists) {
    for (const t of list) {
      const img = t.imgData;
      if (!img || sharedEmptyImageData.has(img) || seen.has(img)) continue;
      seen.add(img);
      bytes += img.data.byteLength;
    }
  }
  return bytes;
}

/**
 * Odpowiednik siatki kafelków (TileGrid) dla warstwy.
 * Dzieli powierzchnię dokumentu na niezależne kwadraty o wymiarach tileSize x tileSize (np. 64x64).
 * Pozwala na modyfikowanie i odświeżanie wyłącznie dotkniętych kafelków (Dirty Rect & Dirty Tiles).
 */
export class TileGrid {
  public readonly width: number;
  public readonly height: number;
  public readonly tileSize: number;
  public readonly cols: number;
  public readonly rows: number;
  public readonly tiles: Tile[][];
  /** Przyrostowy bufor miniatury (patrz drawThumbnail). */
  private thumbCache: { div: number; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; versions: Int32Array; content: Uint8Array } | null = null;

  constructor(width: number, height: number, tileSize: number = DEFAULT_TILE_SIZE) {
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    this.cols = Math.ceil(width / tileSize);
    this.rows = Math.ceil(height / tileSize);

    this.tiles = [];
    for (let ty = 0; ty < this.rows; ty++) {
      const row: Tile[] = [];
      for (let tx = 0; tx < this.cols; tx++) {
        row.push(new Tile(tx, ty, tileSize, width, height));
      }
      this.tiles.push(row);
    }
  }

  /**
   * Zwraca kafelek na danych współrzędnych siatki (tx, ty)
   */
  public getTile(tx: number, ty: number): Tile | null {
    if (tx < 0 || tx >= this.cols || ty < 0 || ty >= this.rows) {
      return null;
    }
    return this.tiles[ty][tx];
  }

  /**
   * Zwraca kafelek zawierający dany piksel dokumentu (px, py)
   */
  public getTileAtPixel(px: number, py: number): Tile | null {
    const tx = Math.floor(px / this.tileSize);
    const ty = Math.floor(py / this.tileSize);
    return this.getTile(tx, ty);
  }

  /**
   * Znajduje wszystkie kafelki przecinające dany prostokąt (SKRectI / dirty rect).
   * Jest to podstawa szybkiego pipeline'u bez lagowania.
   */
  public getTilesIntersectingRect(rect: SKRectI): Tile[] {
    const minTx = Math.max(0, Math.floor(rect.left / this.tileSize));
    const maxTx = Math.min(this.cols - 1, Math.floor((rect.right - 1) / this.tileSize));
    const minTy = Math.max(0, Math.floor(rect.top / this.tileSize));
    const maxTy = Math.min(this.rows - 1, Math.floor((rect.bottom - 1) / this.tileSize));

    const result: Tile[] = [];
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const tile = this.tiles[ty][tx];
        if (tile) {
          result.push(tile);
        }
      }
    }
    return result;
  }

  /**
   * Stempluje pędzel w punkcie (docX, docY) tylko na kafelkach, które go otaczają.
   * Zwraca tablicę zmienionych kafelków.
   */
  public stampBrush(
    docX: number,
    docY: number,
    radius: number,
    color: SKColor,
    hardness: number,
    blendMode: SKBlendMode,
    isAntiAliased: boolean
  ): Tile[] {
    const left = Math.floor(docX - radius);
    const top = Math.floor(docY - radius);
    const right = Math.ceil(docX + radius);
    const bottom = Math.ceil(docY + radius);

    const dirtyRect: SKRectI = {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };

    const affectedTiles = this.getTilesIntersectingRect(dirtyRect);
    for (const tile of affectedTiles) {
      tile.stampBrush(docX, docY, radius, color, hardness, blendMode, isAntiAliased);
    }
    return affectedTiles;
  }

  /**
   * Wypełnia całą siatkę kolorem
   */
  public fill(color: SKColor): void {
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        this.tiles[ty][tx].fill(color);
      }
    }
  }

  /**
   * Czyści całą siatkę (przezroczystość)
   */
  public clear(): void {
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        this.tiles[ty][tx].clear();
      }
    }
  }

  /**
   * Oznacza wszystkie kafelki jako brudne (do pełnego przerysowania)
   */
  public markAllDirty(): void {
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        this.tiles[ty][tx].isDirty = true;
      }
    }
  }

  /**
   * Resetuje flagi isDirty dla wszystkich kafelków
   */
  public clearDirtyFlags(): void {
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        this.tiles[ty][tx].isDirty = false;
      }
    }
  }

  /**
   * Klonuje całą siatkę kafelków (dla operacji Undo / Klonowania warstwy)
   */
  public clone(): TileGrid {
    const copy = new TileGrid(this.width, this.height, this.tileSize);
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const sourceTile = this.tiles[ty][tx];
        const destTile = copy.tiles[ty][tx];
        destTile.hasContent = sourceTile.hasContent;
        destTile.isDirty = true;
        if (sourceTile.hasContent) {
          destTile.ctx.drawImage(sourceTile.canvas, 0, 0);
        }
      }
    }
    return copy;
  }

  /**
   * Rysuje całą siatkę bezpośrednio na podany kontekst CanvasRenderingContext2D
   */
  public drawToFlatContext(targetCtx: CanvasRenderingContext2D): void {
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const tile = this.tiles[ty][tx];
        if (tile.hasContent) {
          targetCtx.drawImage(tile.canvas, tile.pixelX, tile.pixelY);
        }
      }
    }
  }

  /**
   * Szybkie rysowanie tylko kafelków przecinających dany wycięty obszar (Crop Rect).
   * Eliminuje pętle po całej siatce na dużych płótnach (np. 5000x5000px).
   */
  public drawCroppedToContext(
    targetCtx: CanvasRenderingContext2D,
    cropX: number,
    cropY: number,
    cropWidth: number,
    cropHeight: number
  ): void {
    const minTx = Math.max(0, Math.floor(cropX / this.tileSize));
    const maxTx = Math.min(this.cols - 1, Math.floor((cropX + cropWidth - 1) / this.tileSize));
    const minTy = Math.max(0, Math.floor(cropY / this.tileSize));
    const maxTy = Math.min(this.rows - 1, Math.floor((cropY + cropHeight - 1) / this.tileSize));

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const tile = this.tiles[ty][tx];
        if (tile.hasContent) {
          targetCtx.drawImage(
            tile.canvas,
            0, 0, tile.width, tile.height,
            tile.pixelX - cropX, tile.pixelY - cropY, tile.width, tile.height
          );
        }
      }
    }
  }

  /**
   * Generuje płaskie płótno ze scaloną zawartością siatki (np. miniatura lub eksport)
   */
  public compositeToFlatCanvas(targetCanvas?: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = targetCanvas || document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    ctx.clearRect(0, 0, this.width, this.height);
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const tile = this.tiles[ty][tx];
        if (tile.hasContent) {
          ctx.drawImage(tile.canvas, tile.pixelX, tile.pixelY);
        }
      }
    }
    return canvas;
  }

  /**
   * Rysuje zmniejszoną wersję całej siatki na kontekście miniatury (dw x dh) bez alokowania płaskiego płótna
   * rozmiaru dokumentu. Dla dużych zmniejszeń najpierw skleja kafelki w pośredni bufor ~1/8, a dopiero
   * potem zmniejsza go jakością 'high' (dokładniejsze niż jednoetapowe próbkowanie i kilka razy szybsze).
   */
  public drawThumbnail(ctx: CanvasRenderingContext2D, dw: number, dh: number): void {
    let div = Math.max(1, Math.min(8, Math.floor(Math.min(this.width / dw, this.height / dh))));
    // dzielnik musi dzielić rozmiar kafelka (granice kafelków w buforze pośrednim są wtedy całkowite)
    while (div > 1 && this.tileSize % div !== 0) div--;
    if (div === 1) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.scale(dw / this.width, dh / this.height);
      this.drawToFlatContext(ctx);
      ctx.restore();
      return;
    }
    const mw = Math.max(1, Math.ceil(this.width / div));
    const mh = Math.max(1, Math.ceil(this.height / div));
    // Bufor pośredni (~1/div) jest trzymany przy siatce i odświeżany PRZYROSTOWO: przerysowujemy tylko kafelki,
    // których wersja albo zawartość zmieniła się od poprzedniej miniatury. Dzięki temu koszt miniatury nie rośnie
    // z rozmiarem płótna (wcześniej każde pociągnięcie pędzla sklejało wszystkie kafelki od nowa).
    let tc = this.thumbCache;
    const n = this.rows * this.cols;
    if (!tc || tc.div !== div || tc.canvas.width !== mw || tc.canvas.height !== mh) {
      const canvas = document.createElement('canvas');
      canvas.width = mw;
      canvas.height = mh;
      const c2 = canvas.getContext('2d');
      if (!c2) return;
      c2.imageSmoothingEnabled = true;
      c2.imageSmoothingQuality = 'low';
      tc = { div, canvas, ctx: c2, versions: new Int32Array(n).fill(-1), content: new Uint8Array(n) };
      this.thumbCache = tc;
    }
    const mx = tc.ctx;
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const tile = this.tiles[ty][tx];
        const i = ty * this.cols + tx;
        const has = tile.hasContent ? 1 : 0;
        if (tc.versions[i] === tile.version && tc.content[i] === has) continue;
        tc.versions[i] = tile.version;
        tc.content[i] = has;
        const dx = tile.pixelX / div, dy = tile.pixelY / div;
        const dwid = tile.width / div, dhei = tile.height / div;
        mx.clearRect(dx, dy, Math.ceil(dwid), Math.ceil(dhei));
        if (has) mx.drawImage(tile.canvas, 0, 0, tile.width, tile.height, dx, dy, dwid, dhei);
      }
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tc.canvas, 0, 0, mw, mh, 0, 0, dw, dh);
    ctx.restore();
  }

  /**
   * Zwraca migawkę stanu kafelków siatki (do operacji Undo/Redo), opcjonalnie tylko tych przecinających `rect`.
   * Puste kafelki nie są kopiowane (współdzielony wyzerowany bufor), więc migawka warstwy
   * z niewielką ilością treści jest tania zarówno pod względem czasu, jak i pamięci.
   */
  public getTilesSnapshot(rect?: SKRectI): TileSnapshot[] {
    const result: TileSnapshot[] = [];
    const minTx = rect ? Math.max(0, Math.floor(rect.left / this.tileSize)) : 0;
    const maxTx = rect ? Math.min(this.cols - 1, Math.floor((rect.right - 1) / this.tileSize)) : this.cols - 1;
    const minTy = rect ? Math.max(0, Math.floor(rect.top / this.tileSize)) : 0;
    const maxTy = rect ? Math.min(this.rows - 1, Math.floor((rect.bottom - 1) / this.tileSize)) : this.rows - 1;
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const tile = this.tiles[ty][tx];
        result.push({
          tx,
          ty,
          imgData: tile.hasContent
            ? tile.ctx.getImageData(0, 0, tile.width, tile.height)
            : getSharedEmptyImageData(tile.width, tile.height),
          hasContent: tile.hasContent,
        });
      }
    }
    return result;
  }
}
