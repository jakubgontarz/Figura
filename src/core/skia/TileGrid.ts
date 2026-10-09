/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tile } from './Tile.ts';
import { SKBlendMode, SKColor, SKRectI } from './types.ts';

export const DEFAULT_TILE_SIZE = 64;

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

  /** Migawka (ImageData) tylko kafelków przecinających prostokąt - tanie undo dla operacji lokalnych. */
  public getTilesSnapshotForRect(rect: SKRectI): { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] {
    return this.getTilesIntersectingRect(rect).map((tile) => ({
      tx: tile.tileX,
      ty: tile.tileY,
      imgData: tile.ctx.getImageData(0, 0, tile.width, tile.height),
      hasContent: tile.hasContent,
    }));
  }

  /**
   * Zwraca pełną migawkę stanu wszystkich kafelków siatki (do operacji Undo/Redo)
   */
  public getTilesSnapshot(): { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] {
    const result: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];
    for (let ty = 0; ty < this.rows; ty++) {
      for (let tx = 0; tx < this.cols; tx++) {
        const tile = this.tiles[ty][tx];
        result.push({
          tx,
          ty,
          imgData: tile.ctx.getImageData(0, 0, tile.width, tile.height),
          hasContent: tile.hasContent,
        });
      }
    }
    return result;
  }
}
