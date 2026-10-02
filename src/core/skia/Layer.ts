/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TileGrid } from './TileGrid.ts';
import { SKBlendMode, SKColor } from './types.ts';

/**
 * Odpowiednik warstwy (Layer) w Paint.NET / SkiaSharp WPF.
 * Każda warstwa posiada własną siatkę kafelków (TileGrid),
 * parametry przezroczystości (opacity) oraz tryb mieszania (blendMode).
 */
export class Layer {
  public id: string;
  public name: string;
  public visible: boolean = true;
  public opacity: number = 1.0; // 0.0 .. 1.0
  public blendMode: SKBlendMode = 'SrcOver';
  public tileGrid: TileGrid;
  public thumbnailCanvas: HTMLCanvasElement;
  public thumbnailCtx: CanvasRenderingContext2D | null;

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
    this.thumbnailCanvas.width = 44;
    this.thumbnailCanvas.height = 30;
    this.thumbnailCtx = this.thumbnailCanvas.getContext('2d');
  }

  /**
   * Aktualizuje miniaturę warstwy do wyświetlenia w panelu warstw
   */
  public updateThumbnail(): void {
    if (!this.thumbnailCtx) return;

    const ctx = this.thumbnailCtx;
    ctx.clearRect(0, 0, 44, 30);

    const sz = 4;
    for (let y = 0; y < 30; y += sz) {
      for (let x = 0; x < 44; x += sz) {
        ctx.fillStyle = (Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0 ? '#f0f0f0' : '#d0d0d0';
        ctx.fillRect(x, y, sz, sz);
      }
    }

    const flat = this.tileGrid.compositeToFlatCanvas();
    ctx.drawImage(flat, 0, 0, 44, 30);
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
    copy.opacity = this.opacity;
    copy.blendMode = this.blendMode;
    copy.tileGrid = this.tileGrid.clone();
    copy.updateThumbnail();
    return copy;
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

  public flipHorizontal(): void {
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

  public flipVertical(): void {
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
