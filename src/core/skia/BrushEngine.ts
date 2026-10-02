/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Layer } from './Layer.ts';
import { BrushSettings, SKBlendMode, SKColor, SKPoint, SKRectI, getCanvasCompositeOperation } from './types.ts';

export interface StrokeResult {
  dirtyRect: SKRectI;
  affectedTilesCount: number;
}

export interface EndStrokeResult {
  dirtyRect: SKRectI;
  before: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
  after: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
}

/**
 * Zoptymalizowany silnik pędzla z obsługą maskowania zaznaczenia.
 */
export class BrushEngine {
  public isDrawing: boolean = false;
  public isEraser: boolean = false;

  private strokePoints: SKPoint[] = [];
  private lastDabPoint: SKPoint | null = null;
  private residualDistance: number = 0;

  public strokeCanvas: HTMLCanvasElement;
  public strokeCtx: CanvasRenderingContext2D;
  public strokeDirtyRect: SKRectI | null = null;
  public activeBrushSettings: BrushSettings | null = null;

  constructor() {
    this.strokeCanvas = document.createElement('canvas');
    this.strokeCanvas.width = 1;
    this.strokeCanvas.height = 1;
    const ctx = this.strokeCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Nie można utworzyć kontekstu bufora pociągnięcia');
    this.strokeCtx = ctx;
  }

  public ensureBufferSize(width: number, height: number): void {
    if (this.strokeCanvas.width !== width || this.strokeCanvas.height !== height) {
      this.strokeCanvas.width = width;
      this.strokeCanvas.height = height;
    }
  }

  private clampRectToCanvas(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    canvasWidth: number,
    canvasHeight: number
  ): SKRectI {
    const left = Math.max(0, Math.min(canvasWidth, Math.floor(minX)));
    const top = Math.max(0, Math.min(canvasHeight, Math.floor(minY)));
    const right = Math.max(0, Math.min(canvasWidth, Math.ceil(maxX)));
    const bottom = Math.max(0, Math.min(canvasHeight, Math.ceil(maxY)));
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    return { left, top, right, bottom, width, height };
  }

  public beginStroke(
    point: SKPoint,
    layer: Layer,
    settings: BrushSettings,
    isEraser: boolean = false
  ): StrokeResult {
    this.isDrawing = true;
    this.isEraser = isEraser;
    this.strokePoints = [{ ...point }, { ...point }];
    this.lastDabPoint = { ...point };
    this.residualDistance = 0;
    this.activeBrushSettings = { ...settings };

    this.ensureBufferSize(layer.tileGrid.width, layer.tileGrid.height);

    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    this.strokeDirtyRect = this.clampRectToCanvas(
      point.x - pad,
      point.y - pad,
      point.x + pad,
      point.y + pad,
      layer.tileGrid.width,
      layer.tileGrid.height
    );

    this.stampOnStrokeBuffer(point.x, point.y, settings);

    return {
      dirtyRect: this.strokeDirtyRect,
      affectedTilesCount: 1,
    };
  }

  public continueStroke(
    point: SKPoint,
    layer: Layer,
    settings: BrushSettings,
    isEraser: boolean = false
  ): StrokeResult {
    if (!this.isDrawing || this.strokePoints.length === 0 || !this.lastDabPoint) {
      return this.beginStroke(point, layer, settings, isEraser);
    }

    const prevPoint = this.strokePoints[this.strokePoints.length - 1];
    const distToPrev = Math.hypot(point.x - prevPoint.x, point.y - prevPoint.y);
    if (distToPrev < 0.25) {
      return {
        dirtyRect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        affectedTilesCount: 0,
      };
    }

    this.strokePoints.push({ ...point });

    const size = Math.max(1, settings.size);
    const stepDistance = Math.max(0.5, size * (Math.max(1, settings.spacing) / 100));

    let segmentDirty: SKRectI;

    if (!settings.antiAliasing || this.strokePoints.length < 4) {
      const pA = this.strokePoints[this.strokePoints.length - 2];
      const pB = this.strokePoints[this.strokePoints.length - 1];
      segmentDirty = this.interpolateStraightSegment(pA, pB, stepDistance, settings, layer.tileGrid.width, layer.tileGrid.height);
    } else {
      const pts = this.strokePoints;
      const p0 = pts[pts.length - 4];
      const p1 = pts[pts.length - 3];
      const p2 = pts[pts.length - 2];
      const p3 = pts[pts.length - 1];

      segmentDirty = this.interpolateCatmullRomSegment(p0, p1, p2, p3, stepDistance, settings, layer.tileGrid.width, layer.tileGrid.height);
    }

    if (segmentDirty.width > 0 && segmentDirty.height > 0) {
      if (this.strokeDirtyRect && this.strokeDirtyRect.width > 0 && this.strokeDirtyRect.height > 0) {
        const left = Math.min(this.strokeDirtyRect.left, segmentDirty.left);
        const top = Math.min(this.strokeDirtyRect.top, segmentDirty.top);
        const right = Math.max(this.strokeDirtyRect.right, segmentDirty.right);
        const bottom = Math.max(this.strokeDirtyRect.bottom, segmentDirty.bottom);
        this.strokeDirtyRect = {
          left,
          top,
          right,
          bottom,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        };
      } else {
        this.strokeDirtyRect = segmentDirty;
      }
    }

    return {
      dirtyRect: segmentDirty,
      affectedTilesCount: 1,
    };
  }

  private interpolateStraightSegment(
    p0: SKPoint,
    p1: SKPoint,
    stepDistance: number,
    settings: BrushSettings,
    canvasWidth: number,
    canvasHeight: number
  ): SKRectI {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);

    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    const minX = Math.min(p0.x, p1.x) - pad;
    const minY = Math.min(p0.y, p1.y) - pad;
    const maxX = Math.max(p0.x, p1.x) + pad;
    const maxY = Math.max(p0.y, p1.y) + pad;

    // Szybkie pominięcie jeśli cały odcinek leży całkowicie poza płótnem
    const isTotallyOutside =
      maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

    if (dist > 0) {
      let d = stepDistance - this.residualDistance;

      if (isTotallyOutside) {
        const numSteps = Math.floor((dist - d) / stepDistance);
        if (numSteps >= 0) {
          d += (numSteps + 1) * stepDistance;
        }
        this.residualDistance = dist - (d - stepDistance);
        this.lastDabPoint = { ...p1 };
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      }

      while (d <= dist) {
        const t = d / dist;
        const stampX = p0.x + dx * t;
        const stampY = p0.y + dy * t;
        this.stampOnStrokeBuffer(stampX, stampY, settings);
        this.lastDabPoint = { x: stampX, y: stampY };
        d += stepDistance;
      }
      this.residualDistance = dist - (d - stepDistance);
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  private interpolateCatmullRomSegment(
    p0: SKPoint,
    p1: SKPoint,
    p2: SKPoint,
    p3: SKPoint,
    stepDistance: number,
    settings: BrushSettings,
    canvasWidth: number,
    canvasHeight: number
  ): SKRectI {
    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p1.x, p2.x) - pad;
    let minY = Math.min(p1.y, p2.y) - pad;
    let maxX = Math.max(p1.x, p2.x) + pad;
    let maxY = Math.max(p1.y, p2.y) + pad;

    // Szybkie pominięcie jeśli segment leży całkowicie poza płótnem
    const isTotallyOutside =
      maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

    if (isTotallyOutside) {
      this.lastDabPoint = { ...p2 };
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const numSubSteps = Math.min(128, Math.max(4, Math.ceil(chord)));

    let prevPt = { ...p1 };

    for (let i = 1; i <= numSubSteps; i++) {
      const t = i / numSubSteps;
      const t2 = t * t;
      const t3 = t2 * t;

      const curX =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const curY =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

      const subDist = Math.hypot(curX - prevPt.x, curY - prevPt.y);
      let d = stepDistance - this.residualDistance;

      while (d <= subDist) {
        const segT = d / Math.max(0.001, subDist);
        const stampX = prevPt.x + (curX - prevPt.x) * segT;
        const stampY = prevPt.y + (curY - prevPt.y) * segT;

        this.stampOnStrokeBuffer(stampX, stampY, settings);
        this.lastDabPoint = { x: stampX, y: stampY };

        minX = Math.min(minX, stampX - pad);
        minY = Math.min(minY, stampY - pad);
        maxX = Math.max(maxX, stampX + pad);
        maxY = Math.max(maxY, stampY + pad);

        d += stepDistance;
      }

      this.residualDistance = subDist - (d - stepDistance);
      prevPt = { x: curX, y: curY };
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  public stampOnStrokeBuffer(rawX: number, rawY: number, settings: BrushSettings): void {
    const size = Math.max(1, Math.round(settings.size));
    const radius = Math.max(1, size / 2);

    // Szybkie odrzucenie plamki jeśli nie dotyka bufora
    if (
      rawX + radius < 0 ||
      rawX - radius > this.strokeCanvas.width ||
      rawY + radius < 0 ||
      rawY - radius > this.strokeCanvas.height
    ) {
      return;
    }

    const ctx = this.strokeCtx;
    const r = settings.color.r;
    const g = settings.color.g;
    const b = settings.color.b;

    ctx.save();

    if (!settings.antiAliasing) {
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;

      if (size === 1) {
        ctx.fillRect(Math.floor(rawX), Math.floor(rawY), 1, 1);
      } else if (size === 2) {
        ctx.fillRect(Math.floor(rawX - 0.5), Math.floor(rawY - 0.5), 2, 2);
      } else if (size === 3) {
        const cx = Math.floor(rawX);
        const cy = Math.floor(rawY);
        ctx.fillRect(cx - 1, cy, 3, 1);
        ctx.fillRect(cx, cy - 1, 1, 3);
      } else {
        const isEven = size % 2 === 0;
        const radius = size / 2;
        const radiusSq = radius * radius;

        if (isEven) {
          const originX = Math.floor(rawX - 0.5);
          const originY = Math.floor(rawY - 0.5);
          const half = size / 2;

          for (let dy = 0; dy < size; dy++) {
            const distY = dy - half + 0.5;
            for (let dx = 0; dx < size; dx++) {
              const distX = dx - half + 0.5;
              if (distX * distX + distY * distY <= radiusSq + 0.05) {
                ctx.fillRect(originX - half + 1 + dx, originY - half + 1 + dy, 1, 1);
              }
            }
          }
        } else {
          const cx = Math.floor(rawX);
          const cy = Math.floor(rawY);
          const half = Math.floor(size / 2);

          for (let dy = -half; dy <= half; dy++) {
            for (let dx = -half; dx <= half; dx++) {
              if (dx * dx + dy * dy <= radiusSq + 0.05) {
                ctx.fillRect(cx + dx, cy + dy, 1, 1);
              }
            }
          }
        }
      }
    } else {
      ctx.imageSmoothingEnabled = true;
      const radius = Math.max(0.5, size / 2);
      const h = Math.max(0, Math.min(1, settings.hardness / 100));

      if (h >= 0.99) {
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.beginPath();
        ctx.arc(rawX, rawY, radius, 0, Math.PI * 2);
        ctx.fill();
      } else if (h <= 0.5) {
        const exponent = 2.8 - (h / 0.5) * 1.8;
        const grad = ctx.createRadialGradient(rawX, rawY, 0, rawX, rawY, radius);

        const numStops = 12;
        for (let i = 0; i <= numStops; i++) {
          const u = i / numStops;
          const alpha = Math.pow(Math.max(0, 1 - u), exponent);
          grad.addColorStop(u, `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
        }

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(rawX, rawY, radius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const coreRatio = (h - 0.5) / 0.5;
        const grad = ctx.createRadialGradient(rawX, rawY, 0, rawX, rawY, radius);

        grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
        if (coreRatio > 0.01) {
          grad.addColorStop(Math.min(0.99, coreRatio), `rgba(${r}, ${g}, ${b}, 1)`);
        }

        const numStops = 8;
        for (let i = 1; i <= numStops; i++) {
          const t = i / numStops;
          const u = coreRatio + t * (1 - coreRatio);
          const alpha = Math.pow(Math.max(0, 1 - t), 1.3);
          grad.addColorStop(Math.min(1.0, u), `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`);
        }

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(rawX, rawY, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();
  }

  public endStroke(layer?: Layer, selectionMask?: HTMLCanvasElement | null): EndStrokeResult | null {
    if (!this.isDrawing) return null;
    this.isDrawing = false;
    this.strokePoints = [];
    this.lastDabPoint = null;
    this.residualDistance = 0;

    const dirty = this.strokeDirtyRect;
    let before: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];
    let after: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];

    if (layer && dirty && this.activeBrushSettings && dirty.width > 0 && dirty.height > 0) {
      const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirty);

      before = affectedTiles.map((t) => ({
        tx: t.tileX,
        ty: t.tileY,
        imgData: t.ctx.getImageData(0, 0, t.width, t.height),
        hasContent: t.hasContent,
      }));

      this.bakeStrokeToLayer(layer, dirty, this.activeBrushSettings, this.isEraser, selectionMask);

      after = affectedTiles.map((t) => ({
        tx: t.tileX,
        ty: t.tileY,
        imgData: t.ctx.getImageData(0, 0, t.width, t.height),
        hasContent: t.hasContent,
      }));
    }

    // Zawsze wyczyść cały bufor pociągnięcia, aby nie pozostawić żadnych pozostałości
    this.strokeCtx.clearRect(0, 0, this.strokeCanvas.width, this.strokeCanvas.height);

    this.strokeDirtyRect = null;
    this.activeBrushSettings = null;

    if (dirty && before.length > 0) {
      return { dirtyRect: dirty, before, after };
    }
    return null;
  }

  private bakeStrokeToLayer(
    layer: Layer,
    dirty: SKRectI,
    settings: BrushSettings,
    isEraser: boolean,
    selectionMask?: HTMLCanvasElement | null
  ): void {
    const alphaNorm = settings.color.a / 255;
    const blendMode: SKBlendMode = isEraser ? 'Clear' : settings.blendMode;
    const compositeOp = getCanvasCompositeOperation(blendMode);

    // Jeśli aktywne jest zaznaczenie, zamaskuj bufor pociągnięcia
    let sourceCanvas: HTMLCanvasElement = this.strokeCanvas;
    if (selectionMask) {
      const maskedCanvas = document.createElement('canvas');
      maskedCanvas.width = dirty.width;
      maskedCanvas.height = dirty.height;
      const mctx = maskedCanvas.getContext('2d')!;

      mctx.drawImage(
        this.strokeCanvas,
        dirty.left, dirty.top, dirty.width, dirty.height,
        0, 0, dirty.width, dirty.height
      );
      mctx.globalCompositeOperation = 'destination-in';
      mctx.drawImage(
        selectionMask,
        dirty.left, dirty.top, dirty.width, dirty.height,
        0, 0, dirty.width, dirty.height
      );

      sourceCanvas = maskedCanvas;
    }

    const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirty);

    for (const tile of affectedTiles) {
      tile.ctx.save();
      tile.ctx.globalAlpha = alphaNorm;
      tile.ctx.globalCompositeOperation = compositeOp;

      if (!selectionMask) {
        tile.ctx.drawImage(
          this.strokeCanvas,
          tile.pixelX, tile.pixelY, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );
      } else {
        tile.ctx.drawImage(
          sourceCanvas,
          tile.pixelX - dirty.left, tile.pixelY - dirty.top, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );
      }

      tile.ctx.restore();
      tile.hasContent = true;
      tile.isDirty = true;
    }

    layer.updateThumbnail();
  }

  public floodFill(
    startX: number,
    startY: number,
    layer: Layer,
    fillColor: SKColor,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI | null {
    const w = layer.tileGrid.width;
    const h = layer.tileGrid.height;
    if (startX < 0 || startX >= w || startY < 0 || startY >= h) return null;

    const flatCanvas = layer.tileGrid.compositeToFlatCanvas();
    const ctx = flatCanvas.getContext('2d');
    if (!ctx) return null;

    const imgData = ctx.getImageData(0, 0, w, h);
    const data = imgData.data;

    let maskData: Uint8ClampedArray | null = null;
    if (selectionMask) {
      const mctx = selectionMask.getContext('2d');
      if (mctx) maskData = mctx.getImageData(0, 0, w, h).data;
    }

    const startIndex = (startY * w + startX) * 4;
    const targetR = data[startIndex];
    const targetG = data[startIndex + 1];
    const targetB = data[startIndex + 2];
    const targetA = data[startIndex + 3];

    if (
      targetR === fillColor.r &&
      targetG === fillColor.g &&
      targetB === fillColor.b &&
      targetA === fillColor.a
    ) {
      return null;
    }

    const matchTarget = (idx: number) => {
      if (maskData && maskData[idx + 3] === 0) return false;
      return (
        Math.abs(data[idx] - targetR) < 15 &&
        Math.abs(data[idx + 1] - targetG) < 15 &&
        Math.abs(data[idx + 2] - targetB) < 15 &&
        Math.abs(data[idx + 3] - targetA) < 15
      );
    };

    const queue: [number, number][] = [[startX, startY]];
    const visited = new Uint8Array(w * h);
    visited[startY * w + startX] = 1;

    let minX = startX;
    let maxX = startX;
    let minY = startY;
    let maxY = startY;

    while (queue.length > 0) {
      const [curX, curY] = queue.pop()!;
      const idx = (curY * w + curX) * 4;

      data[idx] = fillColor.r;
      data[idx + 1] = fillColor.g;
      data[idx + 2] = fillColor.b;
      data[idx + 3] = fillColor.a;

      if (curX < minX) minX = curX;
      if (curX > maxX) maxX = curX;
      if (curY < minY) minY = curY;
      if (curY > maxY) maxY = curY;

      const neighbors: [number, number][] = [
        [curX + 1, curY],
        [curX - 1, curY],
        [curX, curY + 1],
        [curX, curY - 1],
      ];

      for (const [nx, ny] of neighbors) {
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          const nCoord = ny * w + nx;
          if (!visited[nCoord]) {
            visited[nCoord] = 1;
            const nIdx = nCoord * 4;
            if (matchTarget(nIdx)) {
              queue.push([nx, ny]);
            }
          }
        }
      }
    }

    const dirtyRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX + 1,
      bottom: maxY + 1,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };

    ctx.putImageData(imgData, 0, 0);

    const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirtyRect);
    for (const tile of affectedTiles) {
      tile.ctx.clearRect(0, 0, tile.width, tile.height);
      tile.ctx.drawImage(
        flatCanvas,
        tile.pixelX, tile.pixelY, tile.width, tile.height,
        0, 0, tile.width, tile.height
      );
      tile.hasContent = true;
      tile.isDirty = true;
    }

    layer.updateThumbnail();
    return dirtyRect;
  }
}
