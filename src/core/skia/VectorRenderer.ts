/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LineAndCurveSettings,
  MarkerType,
  SKBlendMode,
  SKColor,
  SKPoint,
  ShapeFillMode,
  StrokeAlignment,
  StrokeCornerJoin,
  StrokeDashStyle,
  StrokeLineCap,
  VectorShapeSettings,
  getCanvasCompositeOperation,
  skColorToRgbaString,
} from './types.ts';
import { PenNode, penAllPoints, penEndTangents, tracePenPath } from './PenPath.ts';

/**
 * Okno rastra: fragment dokumentu, który faktycznie pokrywa dany kontekst (canvas + transformacja).
 * Dzięki temu renderery rysują tylko to, co mieści się w kafelku, a nie całą figurę.
 * Dla zwykłego kontekstu (transformacja jednostkowa, canvas rozmiaru dokumentu) okno = cały dokument,
 * więc zatwierdzanie figur działa dokładnie jak wcześniej.
 */
export interface RasterWindow {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export function getCtxWindow(ctx: CanvasRenderingContext2D): RasterWindow {
  const m = ctx.getTransform();
  const s = m.a > 0 ? m.a : 1;
  return {
    x: -m.e / s,
    y: -m.f / s,
    w: ctx.canvas.width / s,
    h: ctx.canvas.height / s,
    scale: s,
  };
}

/** Konteksty kafelków podglądu: renderery rysują w nich tylko fragment mieszczący się w oknie rastra. */
const windowedContexts = new WeakSet<CanvasRenderingContext2D>();
export function markWindowedContext(ctx: CanvasRenderingContext2D): void {
  windowedContexts.add(ctx);
}

export interface IsoCrop {
  /** Początek bufora w układzie dokumentu */
  ox: number;
  oy: number;
  /** Rozmiar bufora w pikselach rastra */
  pw: number;
  ph: number;
  /** Skala dokument -> raster (1 = rozdzielczość dokumentu) */
  s: number;
}

/** Przecina naturalny prostokąt figury (układ dokumentu) z oknem rastra, z wyrównaniem do siatki pikseli rastra. */
export function computeIsoCrop(
  ctx: CanvasRenderingContext2D,
  natX: number,
  natY: number,
  natW: number,
  natH: number
): IsoCrop | null {
  // Zwykły kontekst (np. zatwierdzanie figury na płótnie dokumentu): bez przycinania, dokładnie jak dawniej,
  // żeby wynik był piksel w piksel identyczny (przycięcie zmienia rasteryzację krawędzi ścieżek).
  if (!windowedContexts.has(ctx)) {
    return { ox: natX, oy: natY, pw: Math.max(1, natW), ph: Math.max(1, natH), s: 1 };
  }
  const win = getCtxWindow(ctx);
  const s = win.scale;
  const x0 = Math.max(natX, win.x);
  const y0 = Math.max(natY, win.y);
  const x1 = Math.min(natX + natW, win.x + win.w);
  const y1 = Math.min(natY + natH, win.y + win.h);
  if (x1 <= x0 || y1 <= y0) return null;
  const rx0 = Math.floor((x0 - win.x) * s + 1e-6);
  const ry0 = Math.floor((y0 - win.y) * s + 1e-6);
  const rx1 = Math.ceil((x1 - win.x) * s - 1e-6);
  const ry1 = Math.ceil((y1 - win.y) * s - 1e-6);
  const pw = rx1 - rx0;
  const ph = ry1 - ry0;
  if (pw <= 0 || ph <= 0) return null;
  return { ox: win.x + rx0 / s, oy: win.y + ry0 / s, pw, ph, s };
}

export function applyCrispThreshold(
  ctx: CanvasRenderingContext2D,
  minX: number,
  minY: number,
  w: number,
  h: number,
  colorA: SKColor,
  colorB?: SKColor,
  threshold: number = 128
): void {
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(minX + w));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(minY + h));
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (cw <= 0 || ch <= 0) return;

  const imgData = ctx.getImageData(x0, y0, cw, ch);
  const data = imgData.data;

  const rA = colorA.r;
  const gA = colorA.g;
  const bA = colorA.b;
  const aA = colorA.a;

  const hasColorB = !!colorB;
  const rB = colorB ? colorB.r : 0;
  const gB = colorB ? colorB.g : 0;
  const bB = colorB ? colorB.b : 0;
  const aB = colorB ? colorB.a : 0;

  for (let i = 0; i < data.length; i += 4) {
    const rawAlpha = data[i + 3];
    if (rawAlpha < threshold) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
    } else {
      if (hasColorB) {
        const pr = data[i];
        const pg = data[i + 1];
        const pb = data[i + 2];
        const distA = (pr - rA) ** 2 + (pg - gA) ** 2 + (pb - bA) ** 2;
        const distB = (pr - rB) ** 2 + (pg - gB) ** 2 + (pb - bB) ** 2;
        if (distB < distA) {
          data[i] = rB;
          data[i + 1] = gB;
          data[i + 2] = bB;
          data[i + 3] = aB;
        } else {
          data[i] = rA;
          data[i + 1] = gA;
          data[i + 2] = bA;
          data[i + 3] = aA;
        }
      } else {
        data[i] = rA;
        data[i + 1] = gA;
        data[i + 2] = bA;
        data[i + 3] = aA;
      }
    }
  }
  ctx.putImageData(imgData, x0, y0);
}

/** Zakończenie linii; przy braku wygładzania i grubości 1 px zostaje płaskie (jak dotąd). */
export function resolveLineCap(settings: { lineCap?: StrokeLineCap; antiAliasing: boolean }, sw: number): CanvasLineCap {
  const cap = settings.lineCap ?? 'round';
  if (!settings.antiAliasing && sw <= 1 && cap === 'round') return 'butt';
  return cap;
}

/** Jeden wybór „Końce” steruje też narożnikami: ostre = prosty narożnik, zaokrąglone = zaokrąglony, ścięte = ścięty. */
export function joinForCap(cap: StrokeLineCap | undefined): StrokeCornerJoin {
  return cap === 'butt' ? 'miter' : cap === 'square' ? 'bevel' : 'round';
}

export function getDashArray(style: StrokeDashStyle, strokeWidth: number): number[] {
  const sw = Math.max(1, strokeWidth);
  switch (style) {
    case 'dashed':
      return [sw * 3.5, sw * 2.5];
    case 'dotted':
      return [sw * 1.2, sw * 2];
    case 'dash-dot':
      return [sw * 4, sw * 2, sw * 1.2, sw * 2];
    case 'long-dash':
      return [sw * 7, sw * 3];
    case 'solid':
    default:
      return [];
  }
}

export function drawMarker(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  tangentX: number,
  tangentY: number,
  markerType: MarkerType,
  markerSizeMult: number,
  strokeWidth: number,
  color: SKColor
): void {
  if (markerType === 'none') return;

  const len = Math.hypot(tangentX, tangentY);
  if (len < 0.0001) return;

  const ux = tangentX / len;
  const uy = tangentY / len;
  const vx = -uy;
  const vy = ux;

  const baseSize = Math.max(8, strokeWidth * 2.8) * Math.max(0.4, markerSizeMult);
  const colorStr = skColorToRgbaString(color);

  ctx.save();
  ctx.fillStyle = colorStr;
  ctx.strokeStyle = colorStr;
  ctx.lineWidth = Math.max(1, strokeWidth * 0.8);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.beginPath();

  switch (markerType) {
    case 'cap-round': {
      ctx.arc(tipX, tipY, strokeWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'cap-square': {
      const h = strokeWidth / 2;
      ctx.moveTo(tipX + vx * h, tipY + vy * h);
      ctx.lineTo(tipX + vx * h + ux * h, tipY + vy * h + uy * h);
      ctx.lineTo(tipX - vx * h + ux * h, tipY - vy * h + uy * h);
      ctx.lineTo(tipX - vx * h, tipY - vy * h);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'arrow': {
      const arrowLength = baseSize * 1.3;
      const arrowHalfWidth = baseSize * 0.65;
      const baseX = tipX - ux * arrowLength;
      const baseY = tipY - uy * arrowLength;

      ctx.moveTo(tipX, tipY);
      ctx.lineTo(baseX + vx * arrowHalfWidth, baseY + vy * arrowHalfWidth);
      ctx.lineTo(baseX - vx * arrowHalfWidth, baseY - vy * arrowHalfWidth);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'stealth-arrow': {
      const arrowLength = baseSize * 1.4;
      const arrowHalfWidth = baseSize * 0.7;
      const baseX = tipX - ux * arrowLength;
      const baseY = tipY - uy * arrowLength;
      const notchX = tipX - ux * (arrowLength * 0.7);
      const notchY = tipY - uy * (arrowLength * 0.7);

      ctx.moveTo(tipX, tipY);
      ctx.lineTo(baseX + vx * arrowHalfWidth, baseY + vy * arrowHalfWidth);
      ctx.lineTo(notchX, notchY);
      ctx.lineTo(baseX - vx * arrowHalfWidth, baseY - vy * arrowHalfWidth);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'circle': {
      const radius = baseSize * 0.45;
      const cx = tipX - ux * radius;
      const cy = tipY - uy * radius;
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'square': {
      const halfSide = baseSize * 0.4;
      const cx = tipX - ux * halfSide;
      const cy = tipY - uy * halfSide;
      const p1x = cx + (ux * halfSide + vx * halfSide);
      const p1y = cy + (uy * halfSide + vy * halfSide);
      const p2x = cx + (-ux * halfSide + vx * halfSide);
      const p2y = cy + (-uy * halfSide + vy * halfSide);
      const p3x = cx + (-ux * halfSide - vx * halfSide);
      const p3y = cy + (-uy * halfSide - vy * halfSide);
      const p4x = cx + (ux * halfSide - vx * halfSide);
      const p4y = cy + (uy * halfSide - vy * halfSide);

      ctx.moveTo(p1x, p1y);
      ctx.lineTo(p2x, p2y);
      ctx.lineTo(p3x, p3y);
      ctx.lineTo(p4x, p4y);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'diamond': {
      const length = baseSize * 0.7;
      const halfWidth = baseSize * 0.45;
      const cx = tipX - ux * length;
      const cy = tipY - uy * length;

      ctx.moveTo(tipX, tipY);
      ctx.lineTo(cx + vx * halfWidth, cy + vy * halfWidth);
      ctx.lineTo(tipX - ux * (length * 2), tipY - uy * (length * 2));
      ctx.lineTo(cx - vx * halfWidth, cy - vy * halfWidth);
      ctx.closePath();
      ctx.fill();
      break;
    }
  }

  ctx.restore();
}

function getMarkerShortenDistance(markerType: MarkerType, baseSize: number, strokeWidth: number): number {
  switch (markerType) {
    case 'arrow':
      return baseSize * 1.3 - strokeWidth * 0.35;
    case 'stealth-arrow':
      return baseSize * 0.98 - strokeWidth * 0.35;
    case 'circle':
      return baseSize * 0.45;
    case 'square':
      return baseSize * 0.4;
    case 'diamond':
      return baseSize * 0.7;
    default:
      return 0;
  }
}

/**
 * Rysuje linię prostą z opcjami stylu, kreskowania, wygładzania i markerów
 */
export function renderVectorLine(
  ctx: CanvasRenderingContext2D,
  p0: SKPoint,
  p1: SKPoint,
  settings: LineAndCurveSettings
): void {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 0.5) return;

  const sw = Math.max(1, Math.round(settings.strokeWidth));
  const isOdd = sw % 2 === 1;
  const pixelOffset = isOdd ? 0.5 : 0.0;

  const pad = Math.max(30, sw * (settings.markerSize || 1.0) * 4 + 30);
  const minX = Math.floor(Math.min(p0.x, p1.x) - pad);
  const minY = Math.floor(Math.min(p0.y, p1.y) - pad);
  const maxX = Math.ceil(Math.max(p0.x, p1.x) + pad);
  const maxY = Math.ceil(Math.max(p0.y, p1.y) + pad);
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);

  const crop = computeIsoCrop(ctx, minX, minY, w, h);
  if (!crop) return;
  const { ox, oy, pw, ph, s } = crop;

  // Bufor z puli (rośnie tylko w górę); bez wygładzania odczytujemy piksele, więc bufor programowy bez synchronizacji z GPU
  const isoScratch = settings.antiAliasing ? getScratch(3, pw, ph, false) : getScratch(4, pw, ph, true);
  const isoCanvas = isoScratch.canvas;
  const isoCtx = isoScratch.ctx;
  isoCtx.scale(s, s);

  isoCtx.save();
  isoCtx.imageSmoothingEnabled = settings.antiAliasing;
  isoCtx.translate(-ox + pixelOffset, -oy + pixelOffset);

  const strokeColor = skColorToRgbaString(
    settings.antiAliasing ? settings.strokeColor : { r: 255, g: 255, b: 255, a: 255 }
  );
  isoCtx.strokeStyle = strokeColor;
  isoCtx.lineWidth = sw;
  isoCtx.lineCap = 'butt'; // zakończenia rysują markery (ostre / zaokrąglone / ścięte / groty)
  isoCtx.lineJoin = 'round';
  isoCtx.setLineDash(getDashArray(settings.dashStyle, sw));

  const baseSize = Math.max(8, sw * 2.8) * Math.max(0.4, settings.markerSize || 1.0);

  let startShorten = 0;
  if (settings.startMarker !== 'none') {
    startShorten = getMarkerShortenDistance(settings.startMarker, baseSize, sw);
  }

  let endShorten = 0;
  if (settings.endMarker !== 'none') {
    endShorten = getMarkerShortenDistance(settings.endMarker, baseSize, sw);
  }

  // Prevent overlap or line reversal
  if (startShorten + endShorten >= dist) {
    const scale = dist / (startShorten + endShorten + 2);
    startShorten *= scale;
    endShorten *= scale;
  }

  const ux = dx / dist;
  const uy = dy / dist;

  const p0Draw = {
    x: p0.x + ux * startShorten,
    y: p0.y + uy * startShorten,
  };
  const p1Draw = {
    x: p1.x - ux * endShorten,
    y: p1.y - uy * endShorten,
  };

  isoCtx.beginPath();
  isoCtx.moveTo(p0Draw.x, p0Draw.y);
  isoCtx.lineTo(p1Draw.x, p1Draw.y);
  isoCtx.stroke();

  // Markery początku i końca
  const markerColor = settings.antiAliasing ? settings.strokeColor : { r: 255, g: 255, b: 255, a: 255 };
  if (settings.startMarker !== 'none') {
    drawMarker(
      isoCtx,
      p0.x,
      p0.y,
      -dx,
      -dy,
      settings.startMarker,
      settings.markerSize,
      sw,
      markerColor
    );
  }

  if (settings.endMarker !== 'none') {
    drawMarker(
      isoCtx,
      p1.x,
      p1.y,
      dx,
      dy,
      settings.endMarker,
      settings.markerSize,
      sw,
      markerColor
    );
  }

  isoCtx.restore();

  if (!settings.antiAliasing) {
    // 1-bit crisp binary threshold
    const imgData = isoCtx.getImageData(0, 0, pw, ph);
    const data = imgData.data;
    const r = settings.strokeColor.r;
    const g = settings.strokeColor.g;
    const b = settings.strokeColor.b;
    const a = settings.strokeColor.a;

    const strokeCutoff = sw <= 1 ? 96 : sw <= 2 ? 110 : 128;
    // jedno słowo 32-bitowe na piksel (te same wartości bajtów co wcześniej)
    const packed = packRgba(r, g, b, a);
    const d32 = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
    for (let p = 0, i = 3; p < d32.length; p++, i += 4) {
      d32[p] = data[i] >= strokeCutoff ? packed : 0;
    }
    isoCtx.putImageData(imgData, 0, 0);
  }

  ctx.save();
  ctx.globalCompositeOperation = getCanvasCompositeOperation(settings.blendMode);
  ctx.imageSmoothingEnabled = settings.antiAliasing;
  ctx.drawImage(isoCanvas, 0, 0, pw, ph, ox, oy, pw / s, ph / s);
  ctx.restore();
}

/**
 * Rysuje krzywą wielowęzłową (węzły z opcjonalnymi uchwytami, patrz PenPath) z opcjami i markerami.
 * Ten sam kod rysuje podgląd i zatwierdzanie, więc piksele są identyczne.
 */
export function renderVectorPath(
  ctx: CanvasRenderingContext2D,
  nodes: PenNode[],
  closed: boolean,
  settings: LineAndCurveSettings
): void {
  if (nodes.length < 2) return;
  const isClosed = closed && nodes.length > 2;
  const sw = Math.max(0, Math.round(settings.strokeWidth));
  if (!isClosed && sw < 1) return; // krzywa otwarta bez grubości nie ma czego rysować
  const isOdd = sw % 2 === 1;
  const pixelOffset = isOdd ? 0.5 : 0.0;

  const pts = penAllPoints(nodes);
  const pad = Math.max(30, sw * (settings.markerSize || 1.0) * 4 + 30);
  let loX = Infinity;
  let loY = Infinity;
  let hiX = -Infinity;
  let hiY = -Infinity;
  for (const q of pts) {
    if (q.x < loX) loX = q.x;
    if (q.y < loY) loY = q.y;
    if (q.x > hiX) hiX = q.x;
    if (q.y > hiY) hiY = q.y;
  }
  const minX = Math.floor(loX - pad);
  const minY = Math.floor(loY - pad);
  const maxX = Math.ceil(hiX + pad);
  const maxY = Math.ceil(hiY + pad);
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);

  const crop = computeIsoCrop(ctx, minX, minY, w, h);
  if (!crop) return;
  const { ox, oy, pw, ph, s } = crop;

  if (isClosed) {
    // Zamknięta krzywa: obrys (środek / wewnątrz / zewnątrz) i wypełnienie, tym samym rysownikiem co figury
    const path = new Path2D();
    tracePenPath(path, nodes, true);
    const off = (settings.strokeAlignment ?? 'center') === 'center' && isOdd ? 0.5 : 0;
    renderStrokeFillPath(
      ctx,
      crop,
      path,
      (c) => c.translate(-ox + off, -oy + off),
      { x: ox - 4, y: oy - 4, w: pw / s + 8, h: ph / s + 8 },
      {
        fillMode: settings.fillMode === 'primary' ? 'primary' : settings.fillMode === 'secondary' ? 'stroke-and-fill' : 'none',
        strokeWidth: sw,
        strokeColor: settings.strokeColor,
        fillColor: settings.fillColor ?? settings.strokeColor,
        strokeAlignment: settings.strokeAlignment ?? 'center',
        strokeCornerJoin: settings.cornerJoin ?? 'round',
        antiAliasing: settings.antiAliasing,
        blendMode: settings.blendMode,
        dashStyle: settings.dashStyle,
      }
    );
    return;
  }

  // Bufor z puli (rośnie tylko w górę); bez wygładzania odczytujemy piksele, więc bufor programowy bez synchronizacji z GPU
  const isoScratch = settings.antiAliasing ? getScratch(3, pw, ph, false) : getScratch(4, pw, ph, true);
  const isoCanvas = isoScratch.canvas;
  const isoCtx = isoScratch.ctx;
  isoCtx.scale(s, s);

  isoCtx.save();
  isoCtx.imageSmoothingEnabled = settings.antiAliasing;
  isoCtx.translate(-ox + pixelOffset, -oy + pixelOffset);

  const strokeColor = skColorToRgbaString(
    settings.antiAliasing ? settings.strokeColor : { r: 255, g: 255, b: 255, a: 255 }
  );
  isoCtx.strokeStyle = strokeColor;
  isoCtx.lineWidth = sw;
  isoCtx.lineCap = 'butt';
  isoCtx.lineJoin = settings.cornerJoin ?? 'round';
  isoCtx.miterLimit = 10;
  isoCtx.setLineDash(getDashArray(settings.dashStyle, sw));

  // Markery tylko na końcach krzywej otwartej
  const tangents = isClosed ? null : penEndTangents(nodes);
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const baseSize = Math.max(8, sw * 2.8) * Math.max(0.4, settings.markerSize || 1.0);

  let startDraw: SKPoint | undefined;
  let endDraw: SKPoint | undefined;
  if (tangents) {
    if (settings.startMarker !== 'none') {
      const shorten = getMarkerShortenDistance(settings.startMarker, baseSize, sw);
      const len = Math.hypot(tangents.start.x, tangents.start.y);
      if (shorten > 0 && len > 0.001) {
        startDraw = { x: first.x - (tangents.start.x / len) * shorten, y: first.y - (tangents.start.y / len) * shorten };
      }
    }
    if (settings.endMarker !== 'none') {
      const shorten = getMarkerShortenDistance(settings.endMarker, baseSize, sw);
      const len = Math.hypot(tangents.end.x, tangents.end.y);
      if (shorten > 0 && len > 0.001) {
        endDraw = { x: last.x - (tangents.end.x / len) * shorten, y: last.y - (tangents.end.y / len) * shorten };
      }
    }
  }

  isoCtx.beginPath();
  tracePenPath(isoCtx, nodes, isClosed, startDraw, endDraw);
  isoCtx.stroke();

  const markerColor = settings.antiAliasing ? settings.strokeColor : { r: 255, g: 255, b: 255, a: 255 };
  if (tangents) {
    if (settings.startMarker !== 'none') {
      drawMarker(isoCtx, first.x, first.y, tangents.start.x, tangents.start.y, settings.startMarker, settings.markerSize, sw, markerColor);
    }
    if (settings.endMarker !== 'none') {
      drawMarker(isoCtx, last.x, last.y, tangents.end.x, tangents.end.y, settings.endMarker, settings.markerSize, sw, markerColor);
    }
  }

  isoCtx.restore();

  if (!settings.antiAliasing) {
    // 1-bit crisp binary threshold
    const imgData = isoCtx.getImageData(0, 0, pw, ph);
    const data = imgData.data;
    const r = settings.strokeColor.r;
    const g = settings.strokeColor.g;
    const b = settings.strokeColor.b;
    const a = settings.strokeColor.a;

    const strokeCutoff = sw <= 1 ? 96 : sw <= 2 ? 110 : 128;
    // jedno słowo 32-bitowe na piksel (te same wartości bajtów co wcześniej)
    const packed = packRgba(r, g, b, a);
    const d32 = new Uint32Array(data.buffer, data.byteOffset, data.length >> 2);
    for (let p = 0, i = 3; p < d32.length; p++, i += 4) {
      d32[p] = data[i] >= strokeCutoff ? packed : 0;
    }
    isoCtx.putImageData(imgData, 0, 0);
  }

  ctx.save();
  ctx.globalCompositeOperation = getCanvasCompositeOperation(settings.blendMode);
  ctx.imageSmoothingEnabled = settings.antiAliasing;
  ctx.drawImage(isoCanvas, 0, 0, pw, ph, ox, oy, pw / s, ph / s);
  ctx.restore();
}

/**
 * Buduje ścieżkę Path2D dla danego kształtu wyśrodkowaną w (0, 0) o zadanym wymiarze w x h
 */
export function createShapePath(
  shapeKind: VectorShapeSettings['shapeKind'],
  width: number,
  height: number,
  settings: VectorShapeSettings
): Path2D {
  const path = new Path2D();
  const halfW = Math.max(1, width / 2);
  const halfH = Math.max(1, height / 2);

  switch (shapeKind) {
    case 'rect': {
      path.rect(-halfW, -halfH, width, height);
      break;
    }
    case 'round-rect': {
      const maxR = Math.min(halfW, halfH);
      const r = Math.max(0, Math.min(maxR, Math.round(settings.cornerRadius ?? 16)));
      if (typeof path.roundRect === 'function') {
        path.roundRect(-halfW, -halfH, width, height, r);
      } else {
        path.rect(-halfW, -halfH, width, height);
      }
      break;
    }
    case 'ellipse': {
      path.ellipse(0, 0, halfW, halfH, 0, 0, Math.PI * 2);
      break;
    }
    case 'triangle': {
      path.moveTo(0, -halfH);
      path.lineTo(halfW, halfH);
      path.lineTo(-halfW, halfH);
      path.closePath();
      break;
    }
    case 'star': {
      const numPoints = Math.max(3, settings.starPoints || 5);
      const innerRatio = Math.max(0.1, Math.min(0.9, settings.starInnerRatio || 0.45));
      const outerRadius = Math.min(halfW, halfH);
      const innerRadius = outerRadius * innerRatio;
      const scaleX = halfW / Math.max(1, outerRadius);
      const scaleY = halfH / Math.max(1, outerRadius);

      const step = Math.PI / numPoints;
      let startAngle = -Math.PI / 2;

      for (let i = 0; i < numPoints * 2; i++) {
        const r = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = startAngle + i * step;
        const x = Math.cos(angle) * r * scaleX;
        const y = Math.sin(angle) * r * scaleY;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      break;
    }
    case 'polygon': {
      const sides = Math.max(3, settings.polygonSides || 6);
      const outerRadius = Math.min(halfW, halfH);
      const scaleX = halfW / Math.max(1, outerRadius);
      const scaleY = halfH / Math.max(1, outerRadius);
      const step = (Math.PI * 2) / sides;
      const startAngle = -Math.PI / 2;

      for (let i = 0; i < sides; i++) {
        const angle = startAngle + i * step;
        const x = Math.cos(angle) * outerRadius * scaleX;
        const y = Math.sin(angle) * outerRadius * scaleY;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      path.closePath();
      break;
    }
    case 'arrow': {
      const headWidth = Math.max(0.1, Math.min(0.9, settings.arrowHeadWidth || 0.45));
      const shaftThickness = Math.max(0.05, Math.min(0.9, settings.arrowShaftThickness || 0.35));

      // Precyzyjne wyrównanie geometrii strzałki do siatki pikseli (pixel grid alignment)
      const headLen = Math.max(1, Math.min(width - 1, Math.round(width * headWidth)));
      const shaftLen = width - headLen;

      // Dopasowanie parzystości grubości trzonu do parzystości wysokości
      let shaftH = Math.max(1, Math.min(height - 2, Math.round(height * shaftThickness)));
      if (height % 2 === 1 && shaftH % 2 === 0) {
        shaftH = Math.max(1, shaftH - 1);
      } else if (height % 2 === 0 && shaftH % 2 === 1) {
        shaftH = Math.max(2, shaftH - 1);
      }

      const halfShaftH = shaftH / 2;
      const left = -halfW;
      const right = halfW;
      const headBaseX = left + shaftLen;

      path.moveTo(left, -halfShaftH);
      path.lineTo(headBaseX, -halfShaftH);
      path.lineTo(headBaseX, -halfH);
      path.lineTo(right, 0);
      path.lineTo(headBaseX, halfH);
      path.lineTo(headBaseX, halfShaftH);
      path.lineTo(left, halfShaftH);
      path.closePath();
      break;
    }
    case 'heart': {
      path.moveTo(0, halfH * 0.7);
      path.bezierCurveTo(-halfW * 0.9, -halfH * 0.2, -halfW, -halfH * 0.9, 0, -halfH * 0.35);
      path.bezierCurveTo(halfW, -halfH * 0.9, halfW * 0.9, -halfH * 0.2, 0, halfH * 0.7);
      path.closePath();
      break;
    }
    case 'diamond': {
      path.moveTo(0, -halfH);
      path.lineTo(halfW, 0);
      path.lineTo(0, halfH);
      path.lineTo(-halfW, 0);
      path.closePath();
      break;
    }
  }

  return path;
}

/**
 * Bufory robocze dla ścieżki "obrys + wypełnienie" (wygładzanie włączone). Zamiast tworzyć dwa nowe canvasy na każde
 * wywołanie (co przy podglądzie kafelkowym oznacza kilka alokacji na zadanie i odczyty z GPU), używamy puli.
 * Canvas rośnie tylko w górę; przed użyciem czyszczony jest wyłącznie obszar pw x ph, bo tylko on jest później czytany.
 * `willReadFrequently` wymusza bufor programowy, na którym getImageData nie synchronizuje z GPU.
 */
const scratchPool: Array<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | undefined> = [];

function getScratch(
  index: number,
  w: number,
  h: number,
  readback = true
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  let e = scratchPool[index];
  if (!e) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: readback })!;
    e = { canvas, ctx };
    scratchPool[index] = e;
  }
  const c = e.canvas;
  const tooBig = c.width * c.height > 4 * 1024 * 1024 && c.width * c.height > 4 * w * h;
  if (c.width < w || c.height < h || tooBig) {
    // przy zmianie rozmiaru canvas i tak jest czyszczony (a stan kontekstu resetowany)
    c.width = tooBig ? w : Math.max(c.width, w);
    c.height = tooBig ? h : Math.max(c.height, h);
  }
  e.ctx.setTransform(1, 0, 0, 1, 0, 0);
  e.ctx.globalCompositeOperation = 'source-over';
  e.ctx.clearRect(0, 0, w, h);
  return e;
}

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function packRgba(r: number, g: number, b: number, a: number): number {
  return IS_LITTLE_ENDIAN
    ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
}

/**
 * Rysuje figurę wektorową w zadanym środku, kącie i parametrach
 * z perfekcyjnym wyrównaniem obrysu, obsługą przezroczystości alfa,
 * brakiem nachodzenia, idealnym dopasowaniem do siatki pikseli (pixel grid)
 * i bez żadnych szczelin.
 */
/** Parametry wspólnego rysowania obrysu i wypełnienia ścieżki (figury, zamknięta krzywa). */
export interface StrokeFillSpec {
  fillMode: ShapeFillMode;
  strokeWidth: number;
  strokeColor: SKColor;
  fillColor: SKColor;
  strokeAlignment: StrokeAlignment;
  strokeCornerJoin: StrokeCornerJoin;
  antiAliasing: boolean;
  blendMode: SKBlendMode;
  dashStyle?: StrokeDashStyle;
  lineCap?: CanvasLineCap;
}

/**
 * Rysuje ścieżkę z obrysem (wyrównanym do środka / wewnątrz / na zewnątrz) i wypełnieniem, z dokładnym podziałem
 * pokrycia brzegu (bez szczelin i podwójnej przezroczystości) albo w trybie 1-bitowym bez wygładzania.
 * `xf` ustawia przekształcenie ścieżki w buforze (po skali rastra), `clip` to prostokąt (w układzie ścieżki) obejmujący bufor.
 */
export function renderStrokeFillPath(
  ctx: CanvasRenderingContext2D,
  crop: IsoCrop,
  path: Path2D,
  xf: (c: CanvasRenderingContext2D) => void,
  clip: { x: number; y: number; w: number; h: number },
  settings: StrokeFillSpec
): void {
  const { ox, oy, pw, ph, s } = crop;
  const sw = Math.max(0, settings.strokeWidth);
  const dash = settings.dashStyle && settings.dashStyle !== 'solid' ? getDashArray(settings.dashStyle, sw) : [];
  const xfd = (c: CanvasRenderingContext2D) => {
    xf(c);
    c.setLineDash(dash); // także pusta tablica: zeruje kreskowanie pozostałe w współdzielonym buforze
  };
  const strokeColor = settings.strokeColor;
  const fillColor = settings.fillMode === 'primary' ? settings.strokeColor : settings.fillColor;

  const joinMap: Record<StrokeCornerJoin, CanvasLineJoin> = {
    miter: 'miter',
    round: 'round',
    bevel: 'bevel',
  };
  const lineJoin = joinMap[settings.strokeCornerJoin] || 'miter';
  const lineCap: CanvasLineCap = settings.lineCap ?? (lineJoin === 'round' ? 'round' : 'butt');

  const isoScratch = getScratch(3, pw, ph, false);
  const isoCanvas = isoScratch.canvas;
  const isoCtx = isoScratch.ctx;
  isoCtx.scale(s, s);

  if (settings.antiAliasing) {
    // --- WYGŁADZANIE WŁĄCZONE (PŁYNNE KRAWĘDZIE, BRAK PODWÓJNEJ PRZEZROCZYSTOŚCI, BRAK SZCZELIN) ---

    if (settings.fillMode === 'none') {
      // 1. Tylko obrys
      if (sw > 0) {
        isoCtx.save();
        isoCtx.imageSmoothingEnabled = true;
        xfd(isoCtx);

        isoCtx.strokeStyle = skColorToRgbaString(strokeColor);
        isoCtx.lineJoin = lineJoin;
        isoCtx.miterLimit = 10;
        isoCtx.lineCap = lineCap;

        if (settings.strokeAlignment === 'inside') {
          isoCtx.save();
          isoCtx.clip(path);
          isoCtx.lineWidth = sw * 2;
          isoCtx.stroke(path);
          isoCtx.restore();
        } else if (settings.strokeAlignment === 'outside') {
          const inverseClip = new Path2D();
          inverseClip.rect(clip.x, clip.y, clip.w, clip.h);
          inverseClip.addPath(path);

          isoCtx.save();
          isoCtx.clip(inverseClip, 'evenodd');
          isoCtx.lineWidth = sw * 2;
          isoCtx.stroke(path);
          isoCtx.restore();
        } else {
          // center
          isoCtx.lineWidth = sw;
          isoCtx.stroke(path);
        }
        isoCtx.restore();
      }
    } else if (sw <= 0) {
      // 2. Tylko wypełnienie (grubość obrysu 0)
      const activeFillColor = settings.fillMode === 'primary' ? strokeColor : fillColor;
      isoCtx.save();
      isoCtx.imageSmoothingEnabled = true;
      xfd(isoCtx);
      isoCtx.fillStyle = skColorToRgbaString(activeFillColor);
      isoCtx.lineJoin = lineJoin;
      isoCtx.miterLimit = 10;
      isoCtx.lineCap = lineCap;
      isoCtx.fill(path);
      isoCtx.restore();
    } else {
      // 3. Obrys i wypełnienie (kolor główny 'primary' lub dodatkowy 'stroke-and-fill')
      // Precyzyjna dekompozycja subpikselowego pokrycia (coverage partitioning):
      // Gwarantuje idealną, ciągłą granicę bez żadnych szczelin (covF + covS === covTotal)
      // i bez nakładania się przezroczystości (brak niepożądanego podwójnego zaciemnienia przy alpha < 255).
      const activeFillColor = settings.fillMode === 'primary' ? strokeColor : fillColor;

      const tCtx = getScratch(0, pw, ph).ctx;
      tCtx.scale(s, s);
      tCtx.imageSmoothingEnabled = true;
      xfd(tCtx);
      tCtx.fillStyle = '#ffffff';
      tCtx.strokeStyle = '#ffffff';
      tCtx.lineJoin = lineJoin;
      tCtx.lineCap = lineCap;
      tCtx.miterLimit = 10;

      const sCtx = getScratch(1, pw, ph).ctx;
      sCtx.scale(s, s);
      sCtx.imageSmoothingEnabled = true;
      xfd(sCtx);
      sCtx.fillStyle = '#ffffff';
      sCtx.strokeStyle = '#ffffff';
      sCtx.lineJoin = lineJoin;
      sCtx.lineCap = lineCap;
      sCtx.miterLimit = 10;

      if (settings.strokeAlignment === 'inside') {
        tCtx.fill(path);

        sCtx.save();
        sCtx.clip(path);
        sCtx.lineWidth = sw * 2;
        sCtx.stroke(path);
        sCtx.restore();
      } else if (settings.strokeAlignment === 'outside') {
        tCtx.lineWidth = sw * 2;
        tCtx.fill(path);
        tCtx.stroke(path);

        sCtx.fill(path);
      } else {
        // center
        tCtx.lineWidth = sw;
        tCtx.fill(path);
        tCtx.stroke(path);

        sCtx.lineWidth = sw;
        sCtx.stroke(path);
      }

      // Wynik zapisujemy w miejscu w buforze "t" (każdy piksel zależy tylko od własnych wartości t i s),
      // więc nie jest potrzebny osobny ImageData.
      const tImg = tCtx.getImageData(0, 0, pw, ph);
      const tData = tImg.data;
      const sData = sCtx.getImageData(0, 0, pw, ph).data;

      const aNormS = strokeColor.a / 255;
      const aNormF = activeFillColor.a / 255;
      const rS = strokeColor.r;
      const gS = strokeColor.g;
      const bS = strokeColor.b;
      const rF = activeFillColor.r;
      const gF = activeFillColor.g;
      const bF = activeFillColor.b;
      const isOutside = settings.strokeAlignment === 'outside';

      // Piksele w pełni pokryte wyłącznie wypełnieniem albo wyłącznie obrysem (większość powierzchni) dają dokładnie
      // kolor wypełnienia / obrysu z alfą round(a * 255), więc zapisujemy je jednym słowem 32-bitowym.
      // Piksele brzegowe liczone są dokładnie tym samym wzorem co wcześniej (wynik identyczny bajt w bajt).
      const packF = aNormF > 0.0001 ? packRgba(rF, gF, bF, Math.round(aNormF * 255)) : 0;
      const packS = aNormS > 0.0001 ? packRgba(rS, gS, bS, Math.round(aNormS * 255)) : 0;
      const t32 = new Uint32Array(tData.buffer, tData.byteOffset, tData.length >> 2);
      const count = t32.length;

      for (let p = 0, i = 0; p < count; p++, i += 4) {
        const tVal = tData[i + 3];
        if (tVal === 0) {
          t32[p] = 0;
          continue;
        }
        const other = sData[i + 3];
        if (tVal === 255) {
          // dla "outside" kanał s niesie pokrycie wypełnienia, w pozostałych przypadkach pokrycie obrysu
          if (isOutside) {
            if (other === 255) {
              t32[p] = packF;
              continue;
            }
            if (other === 0) {
              t32[p] = packS;
              continue;
            }
          } else {
            if (other === 0) {
              t32[p] = packF;
              continue;
            }
            if (other === 255) {
              t32[p] = packS;
              continue;
            }
          }
        }

        const covT = tVal / 255;
        let covS = 0;
        let covF = 0;

        if (isOutside) {
          covF = Math.min(covT, other / 255);
          covS = Math.max(0, covT - covF);
        } else {
          covS = Math.min(covT, other / 255);
          covF = Math.max(0, covT - covS);
        }

        const aF = covF * aNormF;
        const aS = covS * aNormS;
        const aTotal = aF + aS;

        if (aTotal > 0.0001) {
          tData[i] = Math.round((aF * rF + aS * rS) / aTotal);
          tData[i + 1] = Math.round((aF * gF + aS * gS) / aTotal);
          tData[i + 2] = Math.round((aF * bF + aS * bS) / aTotal);
          tData[i + 3] = Math.round(aTotal * 255);
        } else {
          t32[p] = 0;
        }
      }

      isoCtx.putImageData(tImg, 0, 0);
    }
  } else {
    // --- WYGŁADZANIE WYŁĄCZONE (1-BIT CRISP ALIASED, GEOMETRIA NAROŻNIKÓW MITER/ROUND/BEVEL, BEZ SZCZELIN) ---
    // Renderujemy wypełnienie i obrys na odrębnych buforach z pełną geometrią narożników (lineJoin: miter/round/bevel)
    // i dokładnym wycięciem obszaru obrysu (destination-out z tym samym lineJoin), a następnie dokonujemy
    // 1-bitowej binaryzacji bez nakładania się przezroczystości i bez żadnych szczelin.
    const fCtx = getScratch(5, pw, ph, true).ctx;
    fCtx.scale(s, s);
    fCtx.imageSmoothingEnabled = true;
    xfd(fCtx);
    fCtx.fillStyle = '#ffffff';
    fCtx.lineJoin = lineJoin;
    fCtx.miterLimit = 10;
    fCtx.lineCap = lineCap;

    fCtx.fill(path);

    if (sw > 0) {
      if (settings.strokeAlignment === 'inside') {
        fCtx.save();
        fCtx.globalCompositeOperation = 'destination-out';
        fCtx.lineWidth = sw * 2;
        fCtx.lineJoin = lineJoin;
        fCtx.miterLimit = 10;
        fCtx.lineCap = lineCap;
        fCtx.stroke(path);
        fCtx.restore();
      } else if (settings.strokeAlignment === 'center') {
        fCtx.save();
        fCtx.globalCompositeOperation = 'destination-out';
        fCtx.lineWidth = sw;
        fCtx.lineJoin = lineJoin;
        fCtx.miterLimit = 10;
        fCtx.lineCap = lineCap;
        fCtx.stroke(path);
        fCtx.restore();
      }
    }

    const sCtx = getScratch(6, pw, ph, true).ctx;
    sCtx.scale(s, s);
    sCtx.imageSmoothingEnabled = true;
    xfd(sCtx);
    sCtx.strokeStyle = '#ffffff';
    sCtx.lineJoin = lineJoin;
    sCtx.miterLimit = 10;
    sCtx.lineCap = lineCap;

    if (sw > 0) {
      if (settings.strokeAlignment === 'inside') {
        sCtx.save();
        sCtx.clip(path);
        sCtx.lineWidth = sw * 2;
        sCtx.stroke(path);
        sCtx.restore();
      } else if (settings.strokeAlignment === 'outside') {
        const inverseClip = new Path2D();
        inverseClip.rect(clip.x, clip.y, clip.w, clip.h);
        inverseClip.addPath(path);

        sCtx.save();
        sCtx.clip(inverseClip, 'evenodd');
        sCtx.lineWidth = sw * 2;
        sCtx.stroke(path);
        sCtx.restore();
      } else {
        // center
        sCtx.lineWidth = sw;
        sCtx.stroke(path);
      }
    }

    // Wynik zapisujemy w miejscu w buforze maski wypełnienia: każdy piksel zależy tylko od własnych pokryć f i s
    const fImg = fCtx.getImageData(0, 0, pw, ph);
    const fMaskData = fImg.data;
    const sMaskData = sCtx.getImageData(0, 0, pw, ph).data;
    const out32 = new Uint32Array(fMaskData.buffer, fMaskData.byteOffset, fMaskData.length >> 2);

    const strokePacked = packRgba(strokeColor.r, strokeColor.g, strokeColor.b, strokeColor.a);
    const fillPacked = packRgba(fillColor.r, fillColor.g, fillColor.b, fillColor.a);

    const hasFill = settings.fillMode !== 'none';
    const hasStroke = sw > 0;
    const strokeCutoff = sw <= 1 ? 55 : sw <= 2 ? 80 : 128;
    const fillCutoff = 128;
    const fillIsPrimary = settings.fillMode === 'primary';

    for (let p = 0, i = 3; p < out32.length; p++, i += 4) {
      const fCov = fMaskData[i];
      const sCov = sMaskData[i];
      let res = 0;

      if (!hasFill) {
        // Tylko obrys
        if (sCov >= strokeCutoff) res = strokePacked;
      } else if (!hasStroke) {
        // Tylko wypełnienie
        if (fCov >= fillCutoff) res = fillPacked;
      } else if (fillIsPrimary) {
        // Zarówno obrys jak i wypełnienie, kolor główny
        if (fCov + sCov >= 128 || sCov >= strokeCutoff) res = strokePacked;
      } else if (fCov + sCov >= 128 || sCov >= strokeCutoff) {
        // stroke-and-fill: obrys w kolorze obrysu, wypełnienie w kolorze wypełnienia
        res = sCov >= fCov ? strokePacked : fillPacked;
      }
      out32[p] = res;
    }

    isoCtx.putImageData(fImg, 0, 0);
  }

  ctx.save();
  ctx.globalCompositeOperation = getCanvasCompositeOperation(settings.blendMode);
  ctx.imageSmoothingEnabled = settings.antiAliasing;
  ctx.drawImage(isoCanvas, 0, 0, pw, ph, ox, oy, pw / s, ph / s);
  ctx.restore();
}

export function renderVectorShape(
  ctx: CanvasRenderingContext2D,
  center: SKPoint,
  width: number,
  height: number,
  angle: number,
  settings: VectorShapeSettings,
  flipX: boolean = false,
  flipY: boolean = false
): void {
  if (width <= 0 || height <= 0) return;

  const sw = Math.max(0, settings.strokeWidth);
  const pad = Math.max(30, sw * 3 + 30);
  const diag = Math.ceil(Math.hypot(width, height) + pad * 2);

  // PRECYZYJNE WYRÓWNANIE DO SIATKI PIKSELI:
  // originX i originY MUSZĄ być liczbami całkowitymi, aby ctx.drawImage
  // nie powodowało rozmycia subpikselowego (subpixel blur/resampling).
  const originX = Math.floor(center.x - diag / 2);
  const originY = Math.floor(center.y - diag / 2);

  // Okno rastra: rysujemy tylko fragment figury, który mieści się w kafelku / dokumencie
  const crop = computeIsoCrop(ctx, originX, originY, diag, diag);
  if (!crop) return;
  const centerXOnIso = center.x - crop.ox;
  const centerYOnIso = center.y - crop.oy;

  const isAxisAligned = Math.abs(angle) < 0.001;
  const centerPixelOffset =
    settings.strokeAlignment === 'center' && sw % 2 === 1 && isAxisAligned ? 0.5 : 0;

  const path = createShapePath(settings.shapeKind, width, height, settings);
  const big = diag * 2;
  renderStrokeFillPath(
    ctx,
    crop,
    path,
    (c) => {
      c.translate(centerXOnIso + centerPixelOffset, centerYOnIso + centerPixelOffset);
      c.rotate(angle);
      c.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    },
    { x: -big, y: -big, w: big * 2, h: big * 2 },
    settings
  );
}
