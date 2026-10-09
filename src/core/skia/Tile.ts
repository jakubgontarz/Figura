/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SKBlendMode, SKColor, getCanvasCompositeOperation } from './types.ts';

/**
 * Odpowiednik kafelka (Tile / SKSurface / SKBitmap fragment) w architekturze SkiaSharp.
 * Każdy kafelek przechowuje bufor rastrowy o stałym rozmiarze (domyślnie 64x64 px).
 * Flaga isDirty pozwala silnikowi renderować wyłącznie zmodyfikowane fragmenty płótna.
 */
export class Tile {
  public readonly tileX: number;
  public readonly tileY: number;
  public readonly pixelX: number;
  public readonly pixelY: number;
  public readonly width: number;
  public readonly height: number;

  public canvas: HTMLCanvasElement;
  public ctx: CanvasRenderingContext2D;
  /**
   * Globalny licznik modyfikacji kafelków. Każde ustawienie isDirty = true podbija licznik,
   * dzięki czemu kompozytor tanio wykrywa, że zawartość warstw zmieniła się poza kontrolowanym podglądem.
   */
  public static contentVersion: number = 0;
  private _isDirty: boolean = false;
  public hasContent: boolean = false;

  public get isDirty(): boolean {
    return this._isDirty;
  }
  public set isDirty(v: boolean) {
    if (v) Tile.contentVersion++;
    this._isDirty = v;
  }

  constructor(tileX: number, tileY: number, tileSize: number, docWidth: number, docHeight: number) {
    this.tileX = tileX;
    this.tileY = tileY;
    this.pixelX = tileX * tileSize;
    this.pixelY = tileY * tileSize;

    // Obsługa krawędzi dokumentu (kafelki brzegowe mogą mieć mniejsze wymiary, lub pełne tileSize z klipowaniem)
    this.width = Math.min(tileSize, Math.max(0, docWidth - this.pixelX));
    this.height = Math.min(tileSize, Math.max(0, docHeight - this.pixelY));

    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.max(1, this.width);
    this.canvas.height = Math.max(1, this.height);

    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('Nie można zainicjalizować kontekstu 2D dla kafelka');
    }
    this.ctx = context;
    this.ctx.imageSmoothingEnabled = true;
  }

  /**
   * Czyści zawartość kafelka (przezroczystość)
   */
  public clear(): void {
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.hasContent = false;
    this.isDirty = true;
  }

  /**
   * Wypełnia kafelek jednolitym kolorem (np. dla warstwy Tło)
   */
  public fill(color: SKColor): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a / 255})`;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.restore();
    this.hasContent = color.a > 0;
    this.isDirty = true;
  }

  /**
   * Rysuje stempel pędzla w układzie współrzędnych dokumentu.
   * Współrzędne są przekształcane na lokalny układ kafelka.
   */
  public stampBrush(
    docX: number,
    docY: number,
    radius: number,
    color: SKColor,
    hardness: number,
    blendMode: SKBlendMode,
    isAntiAliased: boolean
  ): void {
    const localX = docX - this.pixelX;
    const localY = docY - this.pixelY;

    // Szybkie odrzucenie jeśli okrąg stempla leży poza tym kafelkiem
    if (
      localX + radius < 0 ||
      localX - radius > this.width ||
      localY + radius < 0 ||
      localY - radius > this.height
    ) {
      return;
    }

    this.ctx.save();
    this.ctx.imageSmoothingEnabled = isAntiAliased;
    this.ctx.globalCompositeOperation = getCanvasCompositeOperation(blendMode);

    const alphaNorm = color.a / 255;
    const innerRadius = radius * (hardness / 100);

    if (hardness >= 99 || innerRadius >= radius - 0.5) {
      // Twardy pędzel - rysowanie jednolitego koła
      this.ctx.fillStyle = `rgba(${color.r}, ${color.g}, ${color.b}, ${alphaNorm})`;
      this.ctx.beginPath();
      this.ctx.arc(localX, localY, Math.max(0.5, radius), 0, Math.PI * 2);
      this.ctx.fill();
    } else {
      // Miękki pędzel z radialnym gradientem (odpowiednik SKShader.CreateRadialGradient w SkiaSharp)
      const grad = this.ctx.createRadialGradient(
        localX, localY, Math.max(0, innerRadius),
        localX, localY, Math.max(0.5, radius)
      );
      grad.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, ${alphaNorm})`);
      grad.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`);

      this.ctx.fillStyle = grad;
      this.ctx.beginPath();
      this.ctx.arc(localX, localY, Math.max(0.5, radius), 0, Math.PI * 2);
      this.ctx.fill();
    }

    this.ctx.restore();
    this.hasContent = true;
    this.isDirty = true;
  }

  /**
   * Rysuje zawartość tego kafelka na docelowy kontekst (np. kompozytor warstw)
   */
  public drawTo(
    targetCtx: CanvasRenderingContext2D,
    dx: number = this.pixelX,
    dy: number = this.pixelY,
    opacity: number = 1.0,
    blendMode: SKBlendMode = 'SrcOver'
  ): void {
    if (!this.hasContent && blendMode === 'SrcOver') {
      return;
    }

    targetCtx.save();
    targetCtx.globalAlpha = opacity;
    targetCtx.globalCompositeOperation = getCanvasCompositeOperation(blendMode);
    targetCtx.drawImage(this.canvas, dx, dy);
    targetCtx.restore();
  }

  /**
   * Klonuje stan kafelka (do operacji Undo / Kopiowanie warstwy)
   */
  public clone(docWidth: number, docHeight: number): Tile {
    const copy = new Tile(this.tileX, this.tileY, Math.max(this.width, this.height), docWidth, docHeight);
    copy.hasContent = this.hasContent;
    copy.isDirty = true;
    if (this.hasContent) {
      copy.ctx.drawImage(this.canvas, 0, 0);
    }
    return copy;
  }
}
