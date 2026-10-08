/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Layer } from './Layer.ts';
import {
  BrushSettings,
  ColorReplaceSettings,
  CorrectionBrushSettings,
  CorrectionSubAction,
  DeformActionType,
  DeformSettings,
  DeformSubAction,
  SKBlendMode,
  SKColor,
  SKPoint,
  SKRectI,
  StampSampleSource,
  StampSettings,
  StampSourceMode,
  getCanvasCompositeOperation,
} from './types.ts';

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
  public isCorrectionBrush: boolean = false;
  public isColorReplace: boolean = false;
  public isStamp: boolean = false;
  public isDeform: boolean = false;

  private strokePoints: SKPoint[] = [];
  private lastDabPoint: SKPoint | null = null;
  private residualDistance: number = 0;

  public strokeCanvas: HTMLCanvasElement;
  public strokeCtx: CanvasRenderingContext2D;
  public strokeDirtyRect: SKRectI | null = null;
  public activeBrushSettings: BrushSettings | null = null;
  public activeStampSettings: StampSettings | null = null;
  public activeStampAlpha: number = 1.0;
  public stampBasePoint: SKPoint | null = null;
  public stampStrokeStartPoint: SKPoint | null = null;
  public stampRelativeOffset: SKPoint | null = null;

  // Bufor i stan dla pędzla korekcyjnego i podmiany koloru oraz deformacji
  private correctionBeforeTilesMap: Map<string, { tx: number; ty: number; imgData: ImageData; hasContent: boolean }> = new Map();
  private deformBeforeTilesMap: Map<string, { tx: number; ty: number; imgData: ImageData; hasContent: boolean }> = new Map();
  private colorReplaceTileMasks: Map<string, Uint8Array> = new Map();
  private correctionDabCanvas: HTMLCanvasElement;
  private correctionDabCtx: CanvasRenderingContext2D;
  private deformDabCanvas: HTMLCanvasElement;
  private deformDabCtx: CanvasRenderingContext2D;
  private stampSampleCanvas: HTMLCanvasElement;
  private stampSampleCtx: CanvasRenderingContext2D;

  constructor() {
    this.strokeCanvas = document.createElement('canvas');
    this.strokeCanvas.width = 1;
    this.strokeCanvas.height = 1;
    const ctx = this.strokeCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Nie można utworzyć kontekstu bufora pociągnięcia');
    this.strokeCtx = ctx;

    this.correctionDabCanvas = document.createElement('canvas');
    this.correctionDabCanvas.width = 128;
    this.correctionDabCanvas.height = 128;
    const cctx = this.correctionDabCanvas.getContext('2d', { willReadFrequently: true });
    if (!cctx) throw new Error('Nie można utworzyć kontekstu bufora pędzla korekcyjnego');
    this.correctionDabCtx = cctx;

    this.deformDabCanvas = document.createElement('canvas');
    this.deformDabCanvas.width = 128;
    this.deformDabCanvas.height = 128;
    const dfctx = this.deformDabCanvas.getContext('2d', { willReadFrequently: true });
    if (!dfctx) throw new Error('Nie można utworzyć kontekstu bufora deformacji');
    this.deformDabCtx = dfctx;

    this.stampSampleCanvas = document.createElement('canvas');
    this.stampSampleCanvas.width = 128;
    this.stampSampleCanvas.height = 128;
    const sctx = this.stampSampleCanvas.getContext('2d', { willReadFrequently: true });
    if (!sctx) throw new Error('Nie można utworzyć kontekstu próbkowania pieczątki');
    this.stampSampleCtx = sctx;
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

  // --- SILNIK PĘDZLA KOREKCYJNEGO (ROZJAŚNIJ/ŚCIEMNIJ, ROZMYJ/WYOSTRZ, SATURUJ/DESATURUJ) ---

  public beginCorrectionStroke(
    point: SKPoint,
    layer: Layer,
    settings: CorrectionBrushSettings,
    subAction: CorrectionSubAction,
    intensity: number,
    selectionMask?: HTMLCanvasElement | null
  ): StrokeResult {
    this.isDrawing = true;
    this.isCorrectionBrush = true;
    this.strokePoints = [{ ...point }, { ...point }];
    this.lastDabPoint = { ...point };
    this.residualDistance = 0;
    this.correctionBeforeTilesMap.clear();

    const dabRect = this.applyCorrectionDab(point.x, point.y, layer, settings, subAction, intensity, selectionMask);
    this.strokeDirtyRect = dabRect;

    return {
      dirtyRect: dabRect,
      affectedTilesCount: 1,
    };
  }

  public continueCorrectionStroke(
    point: SKPoint,
    layer: Layer,
    settings: CorrectionBrushSettings,
    subAction: CorrectionSubAction,
    intensity: number,
    selectionMask?: HTMLCanvasElement | null
  ): StrokeResult {
    if (!this.isDrawing || !this.isCorrectionBrush || this.strokePoints.length === 0 || !this.lastDabPoint) {
      return this.beginCorrectionStroke(point, layer, settings, subAction, intensity, selectionMask);
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
      segmentDirty = this.interpolateStraightCorrectionSegment(
        pA,
        pB,
        stepDistance,
        layer,
        settings,
        subAction,
        intensity,
        selectionMask
      );
    } else {
      const pts = this.strokePoints;
      const p0 = pts[pts.length - 4];
      const p1 = pts[pts.length - 3];
      const p2 = pts[pts.length - 2];
      const p3 = pts[pts.length - 1];
      segmentDirty = this.interpolateCatmullRomCorrectionSegment(
        p0,
        p1,
        p2,
        p3,
        stepDistance,
        layer,
        settings,
        subAction,
        intensity,
        selectionMask
      );
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

  private interpolateStraightCorrectionSegment(
    p0: SKPoint,
    p1: SKPoint,
    stepDistance: number,
    layer: Layer,
    settings: CorrectionBrushSettings,
    subAction: CorrectionSubAction,
    intensity: number,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);

    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p0.x, p1.x) - pad;
    let minY = Math.min(p0.y, p1.y) - pad;
    let maxX = Math.max(p0.x, p1.x) + pad;
    let maxY = Math.max(p0.y, p1.y) + pad;

    const canvasWidth = layer.tileGrid.width;
    const canvasHeight = layer.tileGrid.height;

    const isTotallyOutside = maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

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
        const dabRect = this.applyCorrectionDab(stampX, stampY, layer, settings, subAction, intensity, selectionMask);
        if (dabRect.width > 0 && dabRect.height > 0) {
          minX = Math.min(minX, dabRect.left);
          minY = Math.min(minY, dabRect.top);
          maxX = Math.max(maxX, dabRect.right);
          maxY = Math.max(maxY, dabRect.bottom);
        }
        this.lastDabPoint = { x: stampX, y: stampY };
        d += stepDistance;
      }
      this.residualDistance = dist - (d - stepDistance);
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  private interpolateCatmullRomCorrectionSegment(
    p0: SKPoint,
    p1: SKPoint,
    p2: SKPoint,
    p3: SKPoint,
    stepDistance: number,
    layer: Layer,
    settings: CorrectionBrushSettings,
    subAction: CorrectionSubAction,
    intensity: number,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p1.x, p2.x) - pad;
    let minY = Math.min(p1.y, p2.y) - pad;
    let maxX = Math.max(p1.x, p2.x) + pad;
    let maxY = Math.max(p1.y, p2.y) + pad;

    const canvasWidth = layer.tileGrid.width;
    const canvasHeight = layer.tileGrid.height;

    const isTotallyOutside = maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

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

        const dabRect = this.applyCorrectionDab(stampX, stampY, layer, settings, subAction, intensity, selectionMask);
        if (dabRect.width > 0 && dabRect.height > 0) {
          minX = Math.min(minX, dabRect.left);
          minY = Math.min(minY, dabRect.top);
          maxX = Math.max(maxX, dabRect.right);
          maxY = Math.max(maxY, dabRect.bottom);
        }
        this.lastDabPoint = { x: stampX, y: stampY };

        d += stepDistance;
      }

      this.residualDistance = subDist - (d - stepDistance);
      prevPt = { x: curX, y: curY };
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  public applyCorrectionDab(
    rawX: number,
    rawY: number,
    layer: Layer,
    settings: CorrectionBrushSettings,
    subAction: CorrectionSubAction,
    intensity: number,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const size = Math.max(1, Math.round(settings.size));
    const radius = Math.max(1, size / 2);
    const docW = layer.tileGrid.width;
    const docH = layer.tileGrid.height;

    // Szybkie odrzucenie plamki poza obszarem płótna
    if (
      rawX + radius < 0 ||
      rawX - radius > docW ||
      rawY + radius < 0 ||
      rawY - radius > docH
    ) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    // Dla rozmycia/wyostrzenia rozszerzamy obszar próbkowania o 2px sąsiedztwa
    const neighborPad = (subAction === 'blur' || subAction === 'sharpen') ? 2 : 1;
    const minX = Math.max(0, Math.floor(rawX - radius - neighborPad));
    const minY = Math.max(0, Math.floor(rawY - radius - neighborPad));
    const maxX = Math.min(docW - 1, Math.ceil(rawX + radius + neighborPad));
    const maxY = Math.min(docH - 1, Math.ceil(rawY + radius + neighborPad));
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    if (cropW <= 0 || cropH <= 0) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    const dabRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX + 1,
      bottom: maxY + 1,
      width: cropW,
      height: cropH,
    };

    // 1. Zapisz oryginalne kafelki do mapy historii przed pierwszą modyfikacją
    const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dabRect);
    for (const tile of affectedTiles) {
      const key = `${tile.tileX}_${tile.tileY}`;
      if (!this.correctionBeforeTilesMap.has(key)) {
        this.correctionBeforeTilesMap.set(key, {
          tx: tile.tileX,
          ty: tile.tileY,
          imgData: tile.ctx.getImageData(0, 0, tile.width, tile.height),
          hasContent: tile.hasContent,
        });
      }
    }

    // 2. Przygotuj bufor roboczy i pobierz oryginalne piksele wycinka
    if (this.correctionDabCanvas.width < cropW || this.correctionDabCanvas.height < cropH) {
      this.correctionDabCanvas.width = Math.max(this.correctionDabCanvas.width, cropW);
      this.correctionDabCanvas.height = Math.max(this.correctionDabCanvas.height, cropH);
    }
    const dCtx = this.correctionDabCtx;
    dCtx.clearRect(0, 0, cropW, cropH);
    layer.tileGrid.drawCroppedToContext(dCtx, minX, minY, cropW, cropH);

    const patchImgData = dCtx.getImageData(0, 0, cropW, cropH);
    const data = patchImgData.data;

    // Kopia danych dla filtrów konwolucyjnych (blur / sharpen)
    const origData = (subAction === 'blur' || subAction === 'sharpen') ? new Uint8ClampedArray(data) : null;

    // Maska zaznaczenia
    let maskData: Uint8ClampedArray | null = null;
    if (selectionMask) {
      const mctx = selectionMask.getContext('2d');
      if (mctx) {
        maskData = mctx.getImageData(minX, minY, cropW, cropH).data;
      }
    }

    const h = Math.max(0, Math.min(100, settings.hardness)) / 100;
    const intensityNorm = Math.max(0.01, Math.min(1.0, intensity / 255));

    // 3. Zastosuj filtr piksel po pikselu
    for (let ly = 0; ly < cropH; ly++) {
      const py = minY + ly;
      const dy = py - rawY;

      for (let lx = 0; lx < cropW; lx++) {
        const px = minX + lx;
        const dx = px - rawX;
        const dist = Math.hypot(dx, dy);

        if (dist > radius) continue;

        const idx = (ly * cropW + lx) * 4;
        const a = data[idx + 3];
        if (a === 0) continue; // Pomiń całkowicie przezroczyste piksele

        // Oblicz wagę radialną na podstawie odległości i twardości pędzla
        let radialWeight = 1.0;
        if (!settings.antiAliasing) {
          radialWeight = dist <= radius ? 1.0 : 0.0;
        } else if (h >= 0.99) {
          radialWeight = dist >= radius - 0.5 ? Math.max(0, radius + 0.5 - dist) : 1.0;
        } else {
          const u = dist / radius;
          if (u <= h) {
            radialWeight = 1.0;
          } else {
            const t = (u - h) / (1 - h);
            radialWeight = 0.5 * (1 + Math.cos(t * Math.PI));
          }
        }

        let dabWeight = radialWeight * intensityNorm;

        // Maskowanie aktywnym zaznaczeniem
        if (maskData) {
          const maskA = maskData[idx + 3];
          if (maskA === 0) continue;
          dabWeight *= maskA / 255;
        }

        if (dabWeight <= 0.001) continue;

        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        if (subAction === 'dodge') {
          // Rozjaśnij: płynne podbicie jasności (Dodge)
          const factor = dabWeight * 0.22;
          data[idx] = Math.min(255, Math.round(r + (255 - r) * factor));
          data[idx + 1] = Math.min(255, Math.round(g + (255 - g) * factor));
          data[idx + 2] = Math.min(255, Math.round(b + (255 - b) * factor));
        } else if (subAction === 'burn') {
          // Ściemnij: płynne przyciemnienie cieni i półtonów (Burn)
          const factor = dabWeight * 0.22;
          data[idx] = Math.max(0, Math.round(r - r * factor));
          data[idx + 1] = Math.max(0, Math.round(g - g * factor));
          data[idx + 2] = Math.max(0, Math.round(b - b * factor));
        } else if (subAction === 'saturate') {
          // Saturuj: nasycenie barw chromatycznych
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const satBoost = 1 + (dabWeight * 0.35);
          data[idx] = Math.max(0, Math.min(255, Math.round(lum + (r - lum) * satBoost)));
          data[idx + 1] = Math.max(0, Math.min(255, Math.round(lum + (g - lum) * satBoost)));
          data[idx + 2] = Math.max(0, Math.min(255, Math.round(lum + (b - lum) * satBoost)));
        } else if (subAction === 'desaturate') {
          // Desaturuj: odsycenie barw w stronę szarości
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const satDrop = Math.max(0, 1 - (dabWeight * 0.35));
          data[idx] = Math.max(0, Math.min(255, Math.round(lum + (r - lum) * satDrop)));
          data[idx + 1] = Math.max(0, Math.min(255, Math.round(lum + (g - lum) * satDrop)));
          data[idx + 2] = Math.max(0, Math.min(255, Math.round(lum + (b - lum) * satDrop)));
        } else if (subAction === 'blur' && origData) {
          // Rozmyj: próbkowanie otoczenia 3x3
          let sumR = 0, sumG = 0, sumB = 0, count = 0;
          for (let ky = -1; ky <= 1; ky++) {
            const ny = ly + ky;
            if (ny < 0 || ny >= cropH) continue;
            for (let kx = -1; kx <= 1; kx++) {
              const nx = lx + kx;
              if (nx < 0 || nx >= cropW) continue;
              const nIdx = (ny * cropW + nx) * 4;
              if (origData[nIdx + 3] > 0) {
                const kw = (kx === 0 && ky === 0) ? 2 : 1;
                sumR += origData[nIdx] * kw;
                sumG += origData[nIdx + 1] * kw;
                sumB += origData[nIdx + 2] * kw;
                count += kw;
              }
            }
          }
          if (count > 0) {
            const avgR = sumR / count;
            const avgG = sumG / count;
            const avgB = sumB / count;
            const blend = Math.min(1.0, dabWeight * 0.45);
            data[idx] = Math.round(r * (1 - blend) + avgR * blend);
            data[idx + 1] = Math.round(g * (1 - blend) + avgG * blend);
            data[idx + 2] = Math.round(b * (1 - blend) + avgB * blend);
          }
        } else if (subAction === 'sharpen' && origData) {
          // Wyostrz: wyostrzanie kontrastu lokalnego
          let sumR = 0, sumG = 0, sumB = 0, count = 0;
          for (let ky = -1; ky <= 1; ky++) {
            const ny = ly + ky;
            if (ny < 0 || ny >= cropH) continue;
            for (let kx = -1; kx <= 1; kx++) {
              const nx = lx + kx;
              if (nx < 0 || nx >= cropW) continue;
              const nIdx = (ny * cropW + nx) * 4;
              if (origData[nIdx + 3] > 0) {
                const kw = (kx === 0 && ky === 0) ? 2 : 1;
                sumR += origData[nIdx] * kw;
                sumG += origData[nIdx + 1] * kw;
                sumB += origData[nIdx + 2] * kw;
                count += kw;
              }
            }
          }
          if (count > 0) {
            const avgR = sumR / count;
            const avgG = sumG / count;
            const avgB = sumB / count;
            const sharp = dabWeight * 0.75;
            data[idx] = Math.max(0, Math.min(255, Math.round(r + (r - avgR) * sharp)));
            data[idx + 1] = Math.max(0, Math.min(255, Math.round(g + (g - avgG) * sharp)));
            data[idx + 2] = Math.max(0, Math.min(255, Math.round(b + (b - avgB) * sharp)));
          }
        }
      }
    }

    // 4. Przepisz zmodyfikowany wycinek na kafelki warstwy
    dCtx.putImageData(patchImgData, 0, 0);

    for (const tile of affectedTiles) {
      const overlapLeft = Math.max(tile.pixelX, minX);
      const overlapTop = Math.max(tile.pixelY, minY);
      const overlapRight = Math.min(tile.pixelX + tile.width, minX + cropW);
      const overlapBottom = Math.min(tile.pixelY + tile.height, minY + cropH);
      const overlapW = overlapRight - overlapLeft;
      const overlapH = overlapBottom - overlapTop;

      if (overlapW > 0 && overlapH > 0) {
        const tileLocalX = overlapLeft - tile.pixelX;
        const tileLocalY = overlapTop - tile.pixelY;
        const patchSrcX = overlapLeft - minX;
        const patchSrcY = overlapTop - minY;

        tile.ctx.clearRect(tileLocalX, tileLocalY, overlapW, overlapH);
        tile.ctx.drawImage(
          this.correctionDabCanvas,
          patchSrcX, patchSrcY, overlapW, overlapH,
          tileLocalX, tileLocalY, overlapW, overlapH
        );
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }

    return dabRect;
  }

  public endCorrectionStroke(layer?: Layer): EndStrokeResult | null {
    if (!this.isDrawing || !this.isCorrectionBrush) return null;
    this.isDrawing = false;
    this.isCorrectionBrush = false;
    this.strokePoints = [];
    this.lastDabPoint = null;
    this.residualDistance = 0;

    const dirty = this.strokeDirtyRect;
    let before: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];
    let after: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];

    if (layer && dirty && dirty.width > 0 && dirty.height > 0) {
      before = Array.from(this.correctionBeforeTilesMap.values());
      after = before.map((b) => {
        const tile = layer.tileGrid.getTile(b.tx, b.ty);
        return {
          tx: b.tx,
          ty: b.ty,
          imgData: tile ? tile.ctx.getImageData(0, 0, tile.width, tile.height) : b.imgData,
          hasContent: tile ? tile.hasContent : b.hasContent,
        };
      });
      layer.updateThumbnail();
    }

    this.correctionBeforeTilesMap.clear();
    this.strokeDirtyRect = null;

    if (dirty && before.length > 0) {
      return { dirtyRect: dirty, before, after };
    }
    return null;
  }

  // --- SILNIK ZMIANY KOLORU (COLOR REPLACEMENT / RECOLOR) ---

  public beginColorReplaceStroke(
    point: SKPoint,
    layer: Layer,
    settings: ColorReplaceSettings,
    targetColor: SKColor,
    replacementColor: SKColor,
    selectionMask?: HTMLCanvasElement | null
  ): StrokeResult {
    this.isDrawing = true;
    this.isColorReplace = true;
    this.strokePoints = [{ ...point }, { ...point }];
    this.lastDabPoint = { ...point };
    this.residualDistance = 0;
    this.correctionBeforeTilesMap.clear();
    this.colorReplaceTileMasks.clear();

    const dabRect = this.applyColorReplaceDab(
      point.x,
      point.y,
      layer,
      settings,
      targetColor,
      replacementColor,
      selectionMask
    );
    this.strokeDirtyRect = dabRect;

    return {
      dirtyRect: dabRect,
      affectedTilesCount: 1,
    };
  }

  public continueColorReplaceStroke(
    point: SKPoint,
    layer: Layer,
    settings: ColorReplaceSettings,
    targetColor: SKColor,
    replacementColor: SKColor,
    selectionMask?: HTMLCanvasElement | null
  ): StrokeResult {
    if (!this.isDrawing || !this.isColorReplace || this.strokePoints.length === 0 || !this.lastDabPoint) {
      return this.beginColorReplaceStroke(point, layer, settings, targetColor, replacementColor, selectionMask);
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
      segmentDirty = this.interpolateStraightColorReplaceSegment(
        pA,
        pB,
        stepDistance,
        layer,
        settings,
        targetColor,
        replacementColor,
        selectionMask
      );
    } else {
      const pts = this.strokePoints;
      const p0 = pts[pts.length - 4];
      const p1 = pts[pts.length - 3];
      const p2 = pts[pts.length - 2];
      const p3 = pts[pts.length - 1];
      segmentDirty = this.interpolateCatmullRomColorReplaceSegment(
        p0,
        p1,
        p2,
        p3,
        stepDistance,
        layer,
        settings,
        targetColor,
        replacementColor,
        selectionMask
      );
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

  private interpolateStraightColorReplaceSegment(
    p0: SKPoint,
    p1: SKPoint,
    stepDistance: number,
    layer: Layer,
    settings: ColorReplaceSettings,
    targetColor: SKColor,
    replacementColor: SKColor,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);

    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p0.x, p1.x) - pad;
    let minY = Math.min(p0.y, p1.y) - pad;
    let maxX = Math.max(p0.x, p1.x) + pad;
    let maxY = Math.max(p0.y, p1.y) + pad;

    const canvasWidth = layer.tileGrid.width;
    const canvasHeight = layer.tileGrid.height;

    const isTotallyOutside = maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

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
        const dabRect = this.applyColorReplaceDab(
          stampX,
          stampY,
          layer,
          settings,
          targetColor,
          replacementColor,
          selectionMask
        );
        if (dabRect.width > 0 && dabRect.height > 0) {
          minX = Math.min(minX, dabRect.left);
          minY = Math.min(minY, dabRect.top);
          maxX = Math.max(maxX, dabRect.right);
          maxY = Math.max(maxY, dabRect.bottom);
        }
        this.lastDabPoint = { x: stampX, y: stampY };
        d += stepDistance;
      }
      this.residualDistance = dist - (d - stepDistance);
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  private interpolateCatmullRomColorReplaceSegment(
    p0: SKPoint,
    p1: SKPoint,
    p2: SKPoint,
    p3: SKPoint,
    stepDistance: number,
    layer: Layer,
    settings: ColorReplaceSettings,
    targetColor: SKColor,
    replacementColor: SKColor,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p1.x, p2.x) - pad;
    let minY = Math.min(p1.y, p2.y) - pad;
    let maxX = Math.max(p1.x, p2.x) + pad;
    let maxY = Math.max(p1.y, p2.y) + pad;

    const canvasWidth = layer.tileGrid.width;
    const canvasHeight = layer.tileGrid.height;

    const isTotallyOutside = maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

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

        const dabRect = this.applyColorReplaceDab(
          stampX,
          stampY,
          layer,
          settings,
          targetColor,
          replacementColor,
          selectionMask
        );
        if (dabRect.width > 0 && dabRect.height > 0) {
          minX = Math.min(minX, dabRect.left);
          minY = Math.min(minY, dabRect.top);
          maxX = Math.max(maxX, dabRect.right);
          maxY = Math.max(maxY, dabRect.bottom);
        }
        this.lastDabPoint = { x: stampX, y: stampY };

        d += stepDistance;
      }

      this.residualDistance = subDist - (d - stepDistance);
      prevPt = { x: curX, y: curY };
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  public applyColorReplaceDab(
    rawX: number,
    rawY: number,
    layer: Layer,
    settings: ColorReplaceSettings,
    targetColor: SKColor,
    replacementColor: SKColor,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const size = Math.max(1, Math.round(settings.size));
    const radius = Math.max(0.5, size / 2);
    const docW = layer.tileGrid.width;
    const docH = layer.tileGrid.height;

    // Szybkie odrzucenie plamki poza płótnem
    if (
      rawX + radius < 0 ||
      rawX - radius > docW ||
      rawY + radius < 0 ||
      rawY - radius > docH
    ) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    const minX = Math.max(0, Math.floor(rawX - radius - 1));
    const minY = Math.max(0, Math.floor(rawY - radius - 1));
    const maxX = Math.min(docW - 1, Math.ceil(rawX + radius + 1));
    const maxY = Math.min(docH - 1, Math.ceil(rawY + radius + 1));
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    if (cropW <= 0 || cropH <= 0) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    const dabRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX + 1,
      bottom: maxY + 1,
      width: cropW,
      height: cropH,
    };

    const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dabRect);
    if (affectedTiles.length === 0) return dabRect;

    const h = Math.max(0, Math.min(100, settings.hardness)) / 100;
    // Maksymalny dystans euklidesowy w RGB = sqrt(255^2*3) = ~441.67
    const maxDist = (Math.max(0, Math.min(100, settings.tolerance)) / 100) * 441.67;
    const repAlphaNorm = replacementColor.a / 255;

    let selMaskCtx: CanvasRenderingContext2D | null = null;
    if (selectionMask) {
      selMaskCtx = selectionMask.getContext('2d');
    }

    for (const tile of affectedTiles) {
      const key = `${tile.tileX}_${tile.tileY}`;

      // 1. Zabezpiecz nienaruszone, oryginalne piksele z początku pociągnięcia
      let beforeEntry = this.correctionBeforeTilesMap.get(key);
      if (!beforeEntry) {
        beforeEntry = {
          tx: tile.tileX,
          ty: tile.tileY,
          imgData: tile.ctx.getImageData(0, 0, tile.width, tile.height),
          hasContent: tile.hasContent,
        };
        this.correctionBeforeTilesMap.set(key, beforeEntry);
      }

      // Jeśli kafelek przed pociągnięciem był pusty i przezroczysty, nie ma czego podmieniać
      if (!beforeEntry.hasContent) {
        continue;
      }

      // 2. Pobierz lub zainicjalizuj bufor pokrycia (maskę alfa) dla tego kafelka w ramach TEGO pociągnięcia
      let maskArray = this.colorReplaceTileMasks.get(key);
      if (!maskArray) {
        maskArray = new Uint8Array(tile.width * tile.height);
        this.colorReplaceTileMasks.set(key, maskArray);
      }

      // 3. Oblicz obszar przecięcia stempla z tym kafelkiem
      const tMinX = Math.max(tile.pixelX, minX);
      const tMinY = Math.max(tile.pixelY, minY);
      const tMaxX = Math.min(tile.pixelX + tile.width - 1, maxX);
      const tMaxY = Math.min(tile.pixelY + tile.height - 1, maxY);

      if (tMinX > tMaxX || tMinY > tMaxY) continue;

      let maskData: Uint8ClampedArray | null = null;
      if (selMaskCtx) {
        maskData = selMaskCtx.getImageData(tile.pixelX, tile.pixelY, tile.width, tile.height).data;
      }

      const origData = beforeEntry.imgData.data;
      const currentTileImgData = tile.ctx.getImageData(0, 0, tile.width, tile.height);
      const currentData = currentTileImgData.data;

      let tileModified = false;

      for (let gy = tMinY; gy <= tMaxY; gy++) {
        const ly = gy - tile.pixelY;
        const dy = gy - rawY;

        for (let gx = tMinX; gx <= tMaxX; gx++) {
          const lx = gx - tile.pixelX;
          const dx = gx - rawX;
          const dist = Math.hypot(dx, dy);

          if (dist > radius) continue;

          const pixIdx = ly * tile.width + lx;
          const byteIdx = pixIdx * 4;
          const origA = origData[byteIdx + 3];
          if (origA === 0) continue; // Pomiń piksele w pełni przezroczyste

          // Sprawdź czy oryginalny piksel mieści się w tolerancji koloru docelowego
          const origR = origData[byteIdx];
          const origG = origData[byteIdx + 1];
          const origB = origData[byteIdx + 2];

          const dr = origR - targetColor.r;
          const dg = origG - targetColor.g;
          const db = origB - targetColor.b;
          const colorDist = Math.hypot(dr, dg, db);

          if (colorDist > maxDist) continue;

          // Oblicz radialne krycie pojedynczego stempla pędzla
          let radialWeight = 1.0;
          if (!settings.antiAliasing) {
            radialWeight = dist <= radius ? 1.0 : 0.0;
          } else if (h >= 0.99) {
            radialWeight = dist >= radius - 0.5 ? Math.max(0, radius + 0.5 - dist) : 1.0;
          } else {
            const u = dist / radius;
            if (u <= h) {
              radialWeight = 1.0;
            } else {
              const t = (u - h) / (1 - h);
              radialWeight = 0.5 * (1 + Math.cos(t * Math.PI));
            }
          }

          if (radialWeight <= 0) continue;

          // Tolerancja z wygładzaniem na granicy tolerancji
          let toleranceFactor = 1.0;
          if (settings.antiAliasing && maxDist > 0 && colorDist > maxDist * 0.7) {
            toleranceFactor = Math.max(0, 1.0 - (colorDist - maxDist * 0.7) / (maxDist * 0.3));
          }

          const dabCoverageByte = Math.round(radialWeight * toleranceFactor * 255);
          if (dabCoverageByte <= 0) continue;

          // KLUCZ ARCHITEKTURY: Brak kumulowania nakładających się stempli w jednym pociągnięciu (MAX blend)
          const oldCoverage = maskArray[pixIdx];
          const newCoverage = Math.max(oldCoverage, dabCoverageByte);
          if (newCoverage <= oldCoverage && tile.isDirty) {
            // Ten piksel ma już takie samo lub większe krycie z wcześniejszego stempla tego pociągnięcia
            continue;
          }
          maskArray[pixIdx] = newCoverage;

          // Efektywne krycie podmiany koloru w oparciu o przezroczystość (alpha)
          let blend = (newCoverage / 255) * repAlphaNorm;
          if (maskData) {
            const selA = maskData[byteIdx + 3];
            if (selA === 0) continue;
            blend *= selA / 255;
          }

          if (blend <= 0.0001) continue;

          // Podmiana koloru: ZAWSZE bazujemy na ORYGINALNYM pikselu (origData) z początku pociągnięcia,
          // sterując krawędzią wyłącznie przezroczystością (alpha blend) do replacementColor!
          // Eliminuje to wszelkie sztuczne rozjaśnienia i poszarpane krawędzie stempli.
          currentData[byteIdx] = Math.round(origR * (1 - blend) + replacementColor.r * blend);
          currentData[byteIdx + 1] = Math.round(origG * (1 - blend) + replacementColor.g * blend);
          currentData[byteIdx + 2] = Math.round(origB * (1 - blend) + replacementColor.b * blend);
          currentData[byteIdx + 3] = origA; // zachowaj przezroczystość piksela

          tileModified = true;
        }
      }

      if (tileModified) {
        tile.ctx.putImageData(currentTileImgData, 0, 0);
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }

    return dabRect;
  }

  public endColorReplaceStroke(layer?: Layer): EndStrokeResult | null {
    if (!this.isDrawing || !this.isColorReplace) return null;
    this.isDrawing = false;
    this.isColorReplace = false;
    this.strokePoints = [];
    this.lastDabPoint = null;
    this.residualDistance = 0;

    const dirty = this.strokeDirtyRect;
    let before: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];
    let after: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];

    if (layer && dirty && dirty.width > 0 && dirty.height > 0) {
      before = Array.from(this.correctionBeforeTilesMap.values());
      after = before.map((b) => {
        const tile = layer.tileGrid.getTile(b.tx, b.ty);
        return {
          tx: b.tx,
          ty: b.ty,
          imgData: tile ? tile.ctx.getImageData(0, 0, tile.width, tile.height) : b.imgData,
          hasContent: tile ? tile.hasContent : b.hasContent,
        };
      });
      layer.updateThumbnail();
    }

    this.correctionBeforeTilesMap.clear();
    this.colorReplaceTileMasks.clear();
    this.strokeDirtyRect = null;

    if (dirty && before.length > 0) {
      return { dirtyRect: dirty, before, after };
    }
    return null;
  }

  // --- SILNIK PIECZĄTKI / KLONOWANIA (CLONE STAMP TOOL) ---

  public beginStampStroke(
    point: SKPoint,
    layer: Layer,
    engine: any,
    settings: StampSettings,
    alpha: number,
    basePoint: SKPoint,
    relativeOffset: SKPoint | null
  ): StrokeResult {
    this.isDrawing = true;
    this.isStamp = true;
    this.strokePoints = [{ ...point }, { ...point }];
    this.lastDabPoint = { ...point };
    this.residualDistance = 0;
    this.activeStampSettings = { ...settings };
    this.activeStampAlpha = alpha;
    this.stampBasePoint = { ...basePoint };
    this.stampStrokeStartPoint = { ...point };

    if (settings.sourceMode === 'relative') {
      if (relativeOffset) {
        this.stampRelativeOffset = { ...relativeOffset };
      } else {
        this.stampRelativeOffset = { x: Math.round(point.x - basePoint.x), y: Math.round(point.y - basePoint.y) };
      }
    } else {
      this.stampRelativeOffset = null;
    }

    this.ensureBufferSize(layer.tileGrid.width, layer.tileGrid.height);
    this.strokeCtx.clearRect(0, 0, this.strokeCanvas.width, this.strokeCanvas.height);

    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    this.strokeDirtyRect = this.clampRectToCanvas(
      point.x - pad,
      point.y - pad,
      point.x + pad,
      point.y + pad,
      layer.tileGrid.width,
      layer.tileGrid.height
    );

    this.stampCloneDab(point.x, point.y, engine, layer, settings);

    return {
      dirtyRect: this.strokeDirtyRect,
      affectedTilesCount: 1,
    };
  }

  public continueStampStroke(
    point: SKPoint,
    layer: Layer,
    engine: any,
    settings: StampSettings
  ): StrokeResult {
    if (!this.isDrawing || !this.isStamp || this.strokePoints.length === 0 || !this.lastDabPoint) {
      return {
        dirtyRect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
        affectedTilesCount: 0,
      };
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
      segmentDirty = this.interpolateStraightStampSegment(pA, pB, stepDistance, layer, engine, settings);
    } else {
      const pts = this.strokePoints;
      const p0 = pts[pts.length - 4];
      const p1 = pts[pts.length - 3];
      const p2 = pts[pts.length - 2];
      const p3 = pts[pts.length - 1];
      segmentDirty = this.interpolateCatmullRomStampSegment(p0, p1, p2, p3, stepDistance, layer, engine, settings);
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

  private interpolateStraightStampSegment(
    p0: SKPoint,
    p1: SKPoint,
    stepDistance: number,
    layer: Layer,
    engine: any,
    settings: StampSettings
  ): SKRectI {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);

    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p0.x, p1.x) - pad;
    let minY = Math.min(p0.y, p1.y) - pad;
    let maxX = Math.max(p0.x, p1.x) + pad;
    let maxY = Math.max(p0.y, p1.y) + pad;

    const canvasWidth = layer.tileGrid.width;
    const canvasHeight = layer.tileGrid.height;

    const isTotallyOutside = maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

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

        this.stampCloneDab(stampX, stampY, engine, layer, settings);
        this.lastDabPoint = { x: stampX, y: stampY };

        d += stepDistance;
      }
      this.residualDistance = dist - (d - stepDistance);
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  private interpolateCatmullRomStampSegment(
    p0: SKPoint,
    p1: SKPoint,
    p2: SKPoint,
    p3: SKPoint,
    stepDistance: number,
    layer: Layer,
    engine: any,
    settings: StampSettings
  ): SKRectI {
    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p1.x, p2.x) - pad;
    let minY = Math.min(p1.y, p2.y) - pad;
    let maxX = Math.max(p1.x, p2.x) + pad;
    let maxY = Math.max(p1.y, p2.y) + pad;

    const canvasWidth = layer.tileGrid.width;
    const canvasHeight = layer.tileGrid.height;

    const isTotallyOutside = maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

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

        this.stampCloneDab(stampX, stampY, engine, layer, settings);
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

  public stampCloneDab(
    dstX: number,
    dstY: number,
    engine: any,
    layer: Layer,
    settings: StampSettings
  ): void {
    const size = Math.max(1, Math.round(settings.size));
    const radius = size / 2;
    const dstLeft = Math.round(dstX - radius);
    const dstTop = Math.round(dstY - radius);

    let srcLeft: number;
    let srcTop: number;

    if (settings.sourceMode === 'fixed') {
      srcLeft = Math.round(this.stampBasePoint!.x - radius);
      srcTop = Math.round(this.stampBasePoint!.y - radius);
    } else if (settings.sourceMode === 'selected') {
      const offX = Math.round(this.stampStrokeStartPoint!.x - this.stampBasePoint!.x);
      const offY = Math.round(this.stampStrokeStartPoint!.y - this.stampBasePoint!.y);
      srcLeft = dstLeft - offX;
      srcTop = dstTop - offY;
    } else {
      const offX = Math.round(this.stampRelativeOffset!.x);
      const offY = Math.round(this.stampRelativeOffset!.y);
      srcLeft = dstLeft - offX;
      srcTop = dstTop - offY;
    }

    if (this.stampSampleCanvas.width !== size || this.stampSampleCanvas.height !== size) {
      this.stampSampleCanvas.width = size;
      this.stampSampleCanvas.height = size;
    }
    const sCtx = this.stampSampleCtx;
    sCtx.clearRect(0, 0, size, size);

    sCtx.imageSmoothingEnabled = settings.antiAliasing;
    engine.drawCroppedComposite(sCtx, srcLeft, srcTop, size, size, settings.sampleSource);

    // Utwórz maskę obcięcia krawędzi stempla
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = size;
    maskCanvas.height = size;
    const mctx = maskCanvas.getContext('2d')!;

    const center = size / 2;

    if (!settings.antiAliasing) {
      mctx.fillStyle = '#000000';
      mctx.beginPath();
      mctx.arc(center, center, radius, 0, Math.PI * 2);
      mctx.fill();

      // Binarne progowanie alfy dla maski: 1-bitowa ostra krawędź okręgu bez wygładzania
      const mImgData = mctx.getImageData(0, 0, size, size);
      const mData = mImgData.data;
      for (let i = 3; i < mData.length; i += 4) {
        mData[i] = mData[i] >= 128 ? 255 : 0;
      }
      mctx.putImageData(mImgData, 0, 0);
    } else {
      const h = Math.max(0, Math.min(100, settings.hardness)) / 100;
      if (h >= 0.99) {
        mctx.fillStyle = '#000000';
        mctx.beginPath();
        mctx.arc(center, center, radius, 0, Math.PI * 2);
        mctx.fill();
      } else {
        const coreRatio = h <= 0.5 ? 0 : (h - 0.5) / 0.5;
        const exponent = h <= 0.5 ? (2.8 - (h / 0.5) * 1.8) : 1.3;
        const grad = mctx.createRadialGradient(center, center, 0, center, center, radius);

        const numStops = 12;
        for (let i = 0; i <= numStops; i++) {
          const u = i / numStops;
          let alpha = 1.0;
          if (u > coreRatio) {
            const t = (u - coreRatio) / Math.max(0.001, 1 - coreRatio);
            alpha = Math.pow(Math.max(0, 1 - t), exponent);
          }
          grad.addColorStop(u, `rgba(0, 0, 0, ${alpha.toFixed(3)})`);
        }
        mctx.fillStyle = grad;
        mctx.beginPath();
        mctx.arc(center, center, radius, 0, Math.PI * 2);
        mctx.fill();
      }
    }

    // Przycina pobraną próbkę obrazu dokładnie do maski stempla
    sCtx.save();
    sCtx.globalCompositeOperation = 'destination-in';
    sCtx.drawImage(maskCanvas, 0, 0);
    sCtx.restore();

    this.strokeCtx.save();
    this.strokeCtx.imageSmoothingEnabled = settings.antiAliasing;
    this.strokeCtx.drawImage(this.stampSampleCanvas, dstLeft, dstTop);
    this.strokeCtx.restore();
  }

  public endStampStroke(layer?: Layer, selectionMask?: HTMLCanvasElement | null): EndStrokeResult | null {
    if (!this.isDrawing || !this.isStamp) return null;
    this.isDrawing = false;
    this.isStamp = false;
    this.strokePoints = [];
    this.lastDabPoint = null;
    this.residualDistance = 0;

    const dirty = this.strokeDirtyRect;
    let before: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];
    let after: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];

    if (layer && dirty && this.activeStampSettings && dirty.width > 0 && dirty.height > 0) {
      const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirty);

      before = affectedTiles.map((t) => ({
        tx: t.tileX,
        ty: t.tileY,
        imgData: t.ctx.getImageData(0, 0, t.width, t.height),
        hasContent: t.hasContent,
      }));

      this.bakeStampStrokeToLayer(layer, dirty, this.activeStampSettings, this.activeStampAlpha, selectionMask);

      after = affectedTiles.map((t) => ({
        tx: t.tileX,
        ty: t.tileY,
        imgData: t.ctx.getImageData(0, 0, t.width, t.height),
        hasContent: t.hasContent,
      }));
    }

    this.strokeCtx.clearRect(0, 0, this.strokeCanvas.width, this.strokeCanvas.height);
    this.strokeDirtyRect = null;
    this.activeStampSettings = null;

    if (dirty && before.length > 0) {
      return { dirtyRect: dirty, before, after };
    }
    return null;
  }

  private bakeStampStrokeToLayer(
    layer: Layer,
    dirty: SKRectI,
    settings: StampSettings,
    alpha: number,
    selectionMask?: HTMLCanvasElement | null
  ): void {
    const compositeOp = getCanvasCompositeOperation(settings.blendMode);

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
      tile.ctx.imageSmoothingEnabled = settings.antiAliasing;
      tile.ctx.globalAlpha = alpha;
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

  // --- SILNIK DEFORMACJI (LIQUIFY / WARP / DEFORM) ---

  public beginDeformStroke(
    point: SKPoint,
    layer: Layer,
    settings: DeformSettings,
    subAction: DeformSubAction,
    intensity: number = 255,
    selectionMask?: HTMLCanvasElement | null
  ): StrokeResult {
    this.isDrawing = true;
    this.isDeform = true;
    this.strokePoints = [{ ...point }, { ...point }];
    this.lastDabPoint = { ...point };
    this.residualDistance = 0;
    this.deformBeforeTilesMap.clear();

    const dabRect = this.applyDeformDab(
      point.x,
      point.y,
      point.x,
      point.y,
      layer,
      settings,
      subAction,
      intensity,
      selectionMask
    );
    this.strokeDirtyRect = dabRect;

    return {
      dirtyRect: dabRect,
      affectedTilesCount: 1,
    };
  }

  public continueDeformStroke(
    point: SKPoint,
    layer: Layer,
    settings: DeformSettings,
    subAction: DeformSubAction,
    intensity: number = 255,
    selectionMask?: HTMLCanvasElement | null
  ): StrokeResult {
    if (!this.isDrawing || !this.isDeform || this.strokePoints.length === 0 || !this.lastDabPoint) {
      return this.beginDeformStroke(point, layer, settings, subAction, intensity, selectionMask);
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
      segmentDirty = this.interpolateStraightDeformSegment(
        pA,
        pB,
        stepDistance,
        layer,
        settings,
        subAction,
        intensity,
        selectionMask
      );
    } else {
      const pts = this.strokePoints;
      const p0 = pts[pts.length - 4];
      const p1 = pts[pts.length - 3];
      const p2 = pts[pts.length - 2];
      const p3 = pts[pts.length - 1];
      segmentDirty = this.interpolateCatmullRomDeformSegment(
        p0,
        p1,
        p2,
        p3,
        stepDistance,
        layer,
        settings,
        subAction,
        intensity,
        selectionMask
      );
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

  private interpolateStraightDeformSegment(
    p0: SKPoint,
    p1: SKPoint,
    stepDistance: number,
    layer: Layer,
    settings: DeformSettings,
    subAction: DeformSubAction,
    intensity: number,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dist = Math.hypot(dx, dy);

    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p0.x, p1.x) - pad;
    let minY = Math.min(p0.y, p1.y) - pad;
    let maxX = Math.max(p0.x, p1.x) + pad;
    let maxY = Math.max(p0.y, p1.y) + pad;

    const canvasWidth = layer.tileGrid.width;
    const canvasHeight = layer.tileGrid.height;

    const isTotallyOutside = maxX < 0 || minX > canvasWidth || maxY < 0 || minY > canvasHeight;

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
        const fromPt = this.lastDabPoint || p0;
        const dabRect = this.applyDeformDab(
          fromPt.x,
          fromPt.y,
          stampX,
          stampY,
          layer,
          settings,
          subAction,
          intensity,
          selectionMask
        );
        if (dabRect.width > 0 && dabRect.height > 0) {
          minX = Math.min(minX, dabRect.left);
          minY = Math.min(minY, dabRect.top);
          maxX = Math.max(maxX, dabRect.right);
          maxY = Math.max(maxY, dabRect.bottom);
        }
        this.lastDabPoint = { x: stampX, y: stampY };
        d += stepDistance;
      }
      this.residualDistance = dist - (d - stepDistance);
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  private interpolateCatmullRomDeformSegment(
    p0: SKPoint,
    p1: SKPoint,
    p2: SKPoint,
    p3: SKPoint,
    stepDistance: number,
    layer: Layer,
    settings: DeformSettings,
    subAction: DeformSubAction,
    intensity: number,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const numSubdivisions = Math.max(4, Math.min(64, Math.ceil(chord / 2)));

    const pad = Math.max(2, Math.ceil(settings.size / 2) + 2);
    let minX = Math.min(p1.x, p2.x) - pad;
    let minY = Math.min(p1.y, p2.y) - pad;
    let maxX = Math.max(p1.x, p2.x) + pad;
    let maxY = Math.max(p1.y, p2.y) + pad;

    const canvasWidth = layer.tileGrid.width;
    const canvasHeight = layer.tileGrid.height;

    let prevPt = { ...p1 };

    for (let i = 1; i <= numSubdivisions; i++) {
      const t = i / numSubdivisions;
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
        const fromPt = this.lastDabPoint || prevPt;

        const dabRect = this.applyDeformDab(
          fromPt.x,
          fromPt.y,
          stampX,
          stampY,
          layer,
          settings,
          subAction,
          intensity,
          selectionMask
        );

        if (dabRect.width > 0 && dabRect.height > 0) {
          minX = Math.min(minX, dabRect.left);
          minY = Math.min(minY, dabRect.top);
          maxX = Math.max(maxX, dabRect.right);
          maxY = Math.max(maxY, dabRect.bottom);
        }

        this.lastDabPoint = { x: stampX, y: stampY };
        d += stepDistance;
      }

      this.residualDistance = subDist - (d - stepDistance);
      prevPt = { x: curX, y: curY };
    }

    return this.clampRectToCanvas(minX, minY, maxX, maxY, canvasWidth, canvasHeight);
  }

  public applyDeformDab(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    layer: Layer,
    settings: DeformSettings,
    subAction: DeformSubAction,
    intensity: number = 255,
    selectionMask?: HTMLCanvasElement | null
  ): SKRectI {
    const size = Math.max(1, Math.round(settings.size));
    const radius = Math.max(1, size / 2);
    const pad = Math.ceil(radius) + 2;

    const canvasW = layer.tileGrid.width;
    const canvasH = layer.tileGrid.height;

    const minRawX = Math.min(fromX, toX) - pad;
    const minRawY = Math.min(fromY, toY) - pad;
    const maxRawX = Math.max(fromX, toX) + pad;
    const maxRawY = Math.max(fromY, toY) + pad;

    const minX = Math.max(0, Math.min(canvasW, Math.floor(minRawX)));
    const minY = Math.max(0, Math.min(canvasH, Math.floor(minRawY)));
    const maxX = Math.max(0, Math.min(canvasW, Math.ceil(maxRawX)));
    const maxY = Math.max(0, Math.min(canvasH, Math.ceil(maxRawY)));

    const cropW = maxX - minX;
    const cropH = maxY - minY;

    if (cropW <= 0 || cropH <= 0) {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }

    const dabRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: cropW,
      height: cropH,
    };

    const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dabRect);
    if (affectedTiles.length === 0) return dabRect;

    // 1. Zapisz oryginalne kafelki do historii przed pierwszą modyfikacją
    for (const tile of affectedTiles) {
      const key = `${tile.tileX}_${tile.tileY}`;
      if (!this.deformBeforeTilesMap.has(key)) {
        this.deformBeforeTilesMap.set(key, {
          tx: tile.tileX,
          ty: tile.tileY,
          imgData: tile.ctx.getImageData(0, 0, tile.width, tile.height),
          hasContent: tile.hasContent,
        });
      }
    }

    // 2. Pobierz aktualny wycinek z kafelków do bufora roboczego
    if (this.deformDabCanvas.width < cropW || this.deformDabCanvas.height < cropH) {
      this.deformDabCanvas.width = Math.max(this.deformDabCanvas.width, cropW + 64);
      this.deformDabCanvas.height = Math.max(this.deformDabCanvas.height, cropH + 64);
    }
    const dCtx = this.deformDabCtx;
    dCtx.clearRect(0, 0, cropW, cropH);

    for (const tile of affectedTiles) {
      dCtx.drawImage(
        tile.canvas,
        tile.pixelX - minX,
        tile.pixelY - minY
      );
    }

    const srcImgData = dCtx.getImageData(0, 0, cropW, cropH);
    const srcData = srcImgData.data;
    const destImgData = dCtx.createImageData(cropW, cropH);
    const destData = destImgData.data;
    destData.set(srcData);

    // Maska zaznaczenia
    let maskData: Uint8ClampedArray | null = null;
    if (selectionMask) {
      const mctx = selectionMask.getContext('2d');
      if (mctx) {
        maskData = mctx.getImageData(minX, minY, cropW, cropH).data;
      }
    }

    const h = Math.max(0, Math.min(100, settings.hardness)) / 100;
    const intensityNorm = Math.max(0.01, Math.min(1.0, intensity / 255));
    const isSmudge = subAction === 'smudge' || subAction === 'smudge-rev';
    const moveDx = toX - fromX;
    const moveDy = toY - fromY;

    const isExpand = subAction === 'expand';
    const isShrink = subAction === 'shrink';
    const isTwirlCw = subAction === 'twirl-cw';
    const isTwirlCcw = subAction === 'twirl-ccw';

    const cx = toX;
    const cy = toY;

    // 3. Deformacja piksel po pikselu
    for (let ly = 0; ly < cropH; ly++) {
      const py = minY + ly;
      const dy = py - cy;

      for (let lx = 0; lx < cropW; lx++) {
        const px = minX + lx;
        const dx = px - cx;
        const dist = Math.hypot(dx, dy);

        if (dist > radius) continue;

        const idx = (ly * cropW + lx) * 4;

        // Radialna waga twardości / wygładzania
        let radialWeight = 1.0;
        const u = dist / radius; // 0..1
        if (!settings.antiAliasing) {
          radialWeight = dist <= radius ? 1.0 : 0.0;
        } else if (h >= 0.99) {
          radialWeight = dist >= radius - 0.5 ? Math.max(0, radius + 0.5 - dist) : 1.0;
        } else {
          if (u <= h) {
            radialWeight = 1.0;
          } else {
            const t = (u - h) / (1 - h);
            radialWeight = 0.5 * (1 + Math.cos(t * Math.PI));
          }
        }

        let weight = radialWeight * intensityNorm;

        // Maskowanie aktywnym zaznaczeniem
        if (maskData) {
          const maskA = maskData[idx + 3];
          if (maskA === 0) continue;
          weight *= maskA / 255;
        }

        if (weight <= 0.0005) continue;

        let sampleDocX = px;
        let sampleDocY = py;

        if (isExpand) {
          // Zwiększ (Wypychanie na zewnątrz):
          // Piksel w odległości r pobiera kolor z punktu bliższego środka (r_src < r)
          const factor = Math.max(0, 1.0 - 0.38 * weight * (1.0 - u * 0.7));
          sampleDocX = cx + dx * factor;
          sampleDocY = cy + dy * factor;
        } else if (isShrink) {
          // Zmniejsz (Zasysanie do środka):
          // Piksel w odległości r pobiera kolor z punktu dalszego od środka (r_src > r)
          const factor = 1.0 + 0.38 * weight * (1.0 - u * 0.7);
          sampleDocX = cx + dx * factor;
          sampleDocY = cy + dy * factor;
        } else if (isSmudge) {
          // Przesuń (Smudge / Warp):
          // Przeciąga piksele w kierunku ruchu myszy
          const sign = subAction === 'smudge-rev' ? -1 : 1;
          const smudgeFactor = weight * (1.0 - u * 0.25);
          sampleDocX = px - sign * moveDx * smudgeFactor;
          sampleDocY = py - sign * moveDy * smudgeFactor;
        } else if (isTwirlCw || isTwirlCcw) {
          // Obróć (Twirl):
          // Wkręca/obraca piksele wokół środka
          const angle = Math.atan2(dy, dx);
          const dir = isTwirlCw ? 1 : -1;
          const deltaAngle = dir * (0.65 * weight * (1.0 - u * 0.7));
          const srcAngle = angle - deltaAngle;
          sampleDocX = cx + dist * Math.cos(srcAngle);
          sampleDocY = cy + dist * Math.sin(srcAngle);
        }

        // Konwersja na współrzędne lokalne wycinka
        const localSrcX = sampleDocX - minX;
        const localSrcY = sampleDocY - minY;

        if (localSrcX < 0 || localSrcX >= cropW - 1 || localSrcY < 0 || localSrcY >= cropH - 1) {
          const clX = Math.max(0, Math.min(cropW - 1, Math.round(localSrcX)));
          const clY = Math.max(0, Math.min(cropH - 1, Math.round(localSrcY)));
          const sIdx = (clY * cropW + clX) * 4;
          destData[idx] = srcData[sIdx];
          destData[idx + 1] = srcData[sIdx + 1];
          destData[idx + 2] = srcData[sIdx + 2];
          destData[idx + 3] = srcData[sIdx + 3];
          continue;
        }

        if (!settings.antiAliasing) {
          // Najbliższy sąsiad
          const sIdx = (Math.round(localSrcY) * cropW + Math.round(localSrcX)) * 4;
          destData[idx] = srcData[sIdx];
          destData[idx + 1] = srcData[sIdx + 1];
          destData[idx + 2] = srcData[sIdx + 2];
          destData[idx + 3] = srcData[sIdx + 3];
        } else {
          // Interpolacja dwuliniowa (Bilinear)
          const x0 = Math.floor(localSrcX);
          const y0 = Math.floor(localSrcY);
          const x1 = Math.min(cropW - 1, x0 + 1);
          const y1 = Math.min(cropH - 1, y0 + 1);

          const fx = localSrcX - x0;
          const fy = localSrcY - y0;

          const w00 = (1 - fx) * (1 - fy);
          const w10 = fx * (1 - fy);
          const w01 = (1 - fx) * fy;
          const w11 = fx * fy;

          const idx00 = (y0 * cropW + x0) * 4;
          const idx10 = (y0 * cropW + x1) * 4;
          const idx01 = (y1 * cropW + x0) * 4;
          const idx11 = (y1 * cropW + x1) * 4;

          destData[idx] = Math.round(
            srcData[idx00] * w00 + srcData[idx10] * w10 + srcData[idx01] * w01 + srcData[idx11] * w11
          );
          destData[idx + 1] = Math.round(
            srcData[idx00 + 1] * w00 + srcData[idx10 + 1] * w10 + srcData[idx01 + 1] * w01 + srcData[idx11 + 1] * w11
          );
          destData[idx + 2] = Math.round(
            srcData[idx00 + 2] * w00 + srcData[idx10 + 2] * w10 + srcData[idx01 + 2] * w01 + srcData[idx11 + 2] * w11
          );
          destData[idx + 3] = Math.round(
            srcData[idx00 + 3] * w00 + srcData[idx10 + 3] * w10 + srcData[idx01 + 3] * w01 + srcData[idx11 + 3] * w11
          );
        }
      }
    }

    // 4. Przepisz zmodyfikowany wycinek na kafelki warstwy
    dCtx.putImageData(destImgData, 0, 0);

    for (const tile of affectedTiles) {
      const overlapLeft = Math.max(tile.pixelX, minX);
      const overlapTop = Math.max(tile.pixelY, minY);
      const overlapRight = Math.min(tile.pixelX + tile.width, minX + cropW);
      const overlapBottom = Math.min(tile.pixelY + tile.height, minY + cropH);
      const overlapW = overlapRight - overlapLeft;
      const overlapH = overlapBottom - overlapTop;

      if (overlapW > 0 && overlapH > 0) {
        const tileLocalX = overlapLeft - tile.pixelX;
        const tileLocalY = overlapTop - tile.pixelY;
        const patchSrcX = overlapLeft - minX;
        const patchSrcY = overlapTop - minY;

        tile.ctx.clearRect(tileLocalX, tileLocalY, overlapW, overlapH);
        tile.ctx.drawImage(
          this.deformDabCanvas,
          patchSrcX, patchSrcY, overlapW, overlapH,
          tileLocalX, tileLocalY, overlapW, overlapH
        );
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }

    return dabRect;
  }

  public endDeformStroke(layer?: Layer): EndStrokeResult | null {
    if (!this.isDrawing || !this.isDeform) return null;
    this.isDrawing = false;
    this.isDeform = false;
    this.strokePoints = [];
    this.lastDabPoint = null;
    this.residualDistance = 0;

    const dirty = this.strokeDirtyRect;
    let before: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];
    let after: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] = [];

    if (layer && dirty && dirty.width > 0 && dirty.height > 0) {
      before = Array.from(this.deformBeforeTilesMap.values());
      after = before.map((b) => {
        const tile = layer.tileGrid.getTile(b.tx, b.ty);
        return {
          tx: b.tx,
          ty: b.ty,
          imgData: tile ? tile.ctx.getImageData(0, 0, tile.width, tile.height) : b.imgData,
          hasContent: tile ? tile.hasContent : b.hasContent,
        };
      });
      layer.updateThumbnail();
    }

    this.deformBeforeTilesMap.clear();
    this.strokeDirtyRect = null;

    if (dirty && before.length > 0) {
      return { dirtyRect: dirty, before, after };
    }
    return null;
  }
}

