/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LineAndCurveSettings,
  MarkerType,
  SKColor,
  SKPoint,
  SKRectI,
  StrokeCornerJoin,
  StrokeDashStyle,
  VectorShapeSettings,
  getCanvasCompositeOperation,
  skColorToRgbaString,
} from './types.ts';


/** Maksymalna liczba pikseli bufora pośredniego, powyżej której okno jest przycinane do widocznego obszaru. */
const MAX_ISO_PIXELS = 48_000_000;

/**
 * Okno renderowania (x,y,w,h) w pikselach dokumentu dla bufora pośredniego figury/linii.
 *
 * Okno to ciasna obwiednia geometrii (z zapasem), a NIE jej przycięcie do płótna: rasteryzator
 * Skia daje nieco inne pokrycie AA na krawędziach, gdy ścieżka jest ucinana przez brzeg bufora,
 * więc dopóki geometria mieści się w buforze, wynik jest bit-w-bit taki sam jak w pełnym buforze.
 * Zwraca null, gdy okno nie dotyka widocznego obszaru (płótno ∩ clip) - wtedy nie ma czego rysować.
 * Tylko dla gigantycznych okien (> MAX_ISO_PIXELS) przycina się do widocznego obszaru.
 */
export function computeIsoWindow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  clip?: SKRectI | null
): { x: number; y: number; w: number; h: number } | null {
  let vl = 0;
  let vt = 0;
  let vr = ctx.canvas.width;
  let vb = ctx.canvas.height;
  if (clip) {
    vl = Math.max(vl, clip.left);
    vt = Math.max(vt, clip.top);
    vr = Math.min(vr, clip.right);
    vb = Math.min(vb, clip.bottom);
  }
  if (x >= vr || y >= vb || x + w <= vl || y + h <= vt || vr <= vl || vb <= vt) return null;
  if (w * h > MAX_ISO_PIXELS || w > 16000 || h > 16000) {
    const l = Math.max(x, vl);
    const t = Math.max(y, vt);
    const r = Math.min(x + w, vr);
    const b = Math.min(y + h, vb);
    return { x: l, y: t, w: r - l, h: b - t };
  }
  return { x, y, w, h };
}

/** Kontekst 2D bufora pośredniego, z którego odczytujemy piksele (CPU - bez kosztownego readbacku z GPU). */
function getReadbackContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext('2d', { willReadFrequently: true });
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

/** Geometria bufora figury: stary bufor kwadratowy (squareX/Y, diag) i okno renderowania (left..bottom). */
function getShapeGeometry(
  center: SKPoint,
  width: number,
  height: number,
  angle: number,
  sw: number
): { squareX: number; squareY: number; diag: number; left: number; top: number; right: number; bottom: number } {
  const pad = Math.max(30, sw * 3 + 30);
  const diag = Math.ceil(Math.hypot(width, height) + pad * 2);

  // PRECYZYJNE WYRÓWNANIE DO SIATKI PIKSELI: początek bufora musi być liczbą całkowitą,
  // aby ctx.drawImage nie powodowało rozmycia subpikselowego.
  const squareX = Math.floor(center.x - diag / 2);
  const squareY = Math.floor(center.y - diag / 2);

  // Ciasne okno: obwiednia obróconego prostokąta + zapas na obrys (narożniki miter sięgają do
  // 10 x grubość), przecięta ze starym kwadratowym buforem. Poza oknem nic nie mogło być narysowane.
  const cosA = Math.abs(Math.cos(angle));
  const sinA = Math.abs(Math.sin(angle));
  const margin = Math.max(pad, Math.ceil(sw * 10) + 6);
  const hx = (width * cosA + height * sinA) / 2 + margin;
  const hy = (width * sinA + height * cosA) / 2 + margin;
  let left = Math.max(squareX, Math.floor(center.x - hx));
  let top = Math.max(squareY, Math.floor(center.y - hy));
  let right = Math.min(squareX + diag, Math.ceil(center.x + hx));
  let bottom = Math.min(squareY + diag, Math.ceil(center.y + hy));
  // Rasteryzator Skia potrafi dać minimalnie inne pokrycie AA dla bufora o innym rozmiarze/pozycji,
  // więc ciasne okno stosujemy tylko tam, gdzie realnie oszczędza dużo (figury wydłużone/obrócone).
  // W pozostałych przypadkach zostaje dotychczasowy bufor - wynik bit-w-bit ten sam.
  if ((right - left) * (bottom - top) > 0.25 * diag * diag) {
    left = squareX;
    top = squareY;
    right = squareX + diag;
    bottom = squareY + diag;
  }
  return { squareX, squareY, diag, left, top, right, bottom };
}

/** Obszar (piksele dokumentu), w którym renderVectorShape może coś narysować. */
export function getShapeRenderBounds(
  center: SKPoint,
  width: number,
  height: number,
  angle: number,
  strokeWidth: number
): SKRectI {
  const g = getShapeGeometry(center, width, height, angle, Math.max(0, strokeWidth));
  return { left: g.left, top: g.top, right: g.right, bottom: g.bottom, width: g.right - g.left, height: g.bottom - g.top };
}

function lineLikePad(settings: LineAndCurveSettings): number {
  const sw = Math.max(1, Math.round(settings.strokeWidth));
  return Math.max(30, sw * (settings.markerSize || 1.0) * 4 + 30);
}

/** Obszar, w którym renderVectorLine/renderVectorBezier może coś narysować (obwiednia punktów + zapas). */
export function getLineRenderBounds(points: SKPoint[], settings: LineAndCurveSettings): SKRectI {
  const pad = lineLikePad(settings);
  const minX = Math.floor(Math.min(...points.map((p) => p.x)) - pad);
  const minY = Math.floor(Math.min(...points.map((p) => p.y)) - pad);
  const maxX = Math.ceil(Math.max(...points.map((p) => p.x)) + pad);
  const maxY = Math.ceil(Math.max(...points.map((p) => p.y)) + pad);
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  return { left: minX, top: minY, right: minX + w, bottom: minY + h, width: w, height: h };
}

export function renderVectorLine(
  ctx: CanvasRenderingContext2D,
  p0: SKPoint,
  p1: SKPoint,
  settings: LineAndCurveSettings,
  clip?: SKRectI | null
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
  const win = computeIsoWindow(ctx, minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY), clip);
  if (!win) return;
  const w = win.w;
  const h = win.h;
  const isoX = win.x;
  const isoY = win.y;

  const isoCanvas = document.createElement('canvas');
  isoCanvas.width = w;
  isoCanvas.height = h;
  const isoCtx = getReadbackContext(isoCanvas);
  if (!isoCtx) return;

  isoCtx.save();
  isoCtx.imageSmoothingEnabled = settings.antiAliasing;
  isoCtx.translate(-isoX + pixelOffset, -isoY + pixelOffset);

  const strokeColor = skColorToRgbaString(
    settings.antiAliasing ? settings.strokeColor : { r: 255, g: 255, b: 255, a: 255 }
  );
  isoCtx.strokeStyle = strokeColor;
  isoCtx.lineWidth = sw;
  isoCtx.lineCap = settings.antiAliasing ? 'round' : (sw <= 1 ? 'butt' : 'round');
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
    const imgData = isoCtx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const r = settings.strokeColor.r;
    const g = settings.strokeColor.g;
    const b = settings.strokeColor.b;
    const a = settings.strokeColor.a;

    const strokeCutoff = sw <= 1 ? 96 : sw <= 2 ? 110 : 128;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= strokeCutoff) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      } else {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
      }
    }
    isoCtx.putImageData(imgData, 0, 0);
  }

  ctx.save();
  ctx.globalCompositeOperation = getCanvasCompositeOperation(settings.blendMode);
  ctx.imageSmoothingEnabled = settings.antiAliasing;
  ctx.drawImage(isoCanvas, isoX, isoY);
  ctx.restore();
}

/**
 * Rysuje sześcienną krzywą Beziera (P0, P1, P2, P3) z opcjami i markerami
 */
export function renderVectorBezier(
  ctx: CanvasRenderingContext2D,
  p0: SKPoint,
  p1: SKPoint,
  p2: SKPoint,
  p3: SKPoint,
  settings: LineAndCurveSettings,
  clip?: SKRectI | null
): void {
  const sw = Math.max(1, Math.round(settings.strokeWidth));
  const isOdd = sw % 2 === 1;
  const pixelOffset = isOdd ? 0.5 : 0.0;

  const pad = Math.max(30, sw * (settings.markerSize || 1.0) * 4 + 30);
  const minX = Math.floor(Math.min(p0.x, p1.x, p2.x, p3.x) - pad);
  const minY = Math.floor(Math.min(p0.y, p1.y, p2.y, p3.y) - pad);
  const maxX = Math.ceil(Math.max(p0.x, p1.x, p2.x, p3.x) + pad);
  const maxY = Math.ceil(Math.max(p0.y, p1.y, p2.y, p3.y) + pad);
  const win = computeIsoWindow(ctx, minX, minY, Math.max(1, maxX - minX), Math.max(1, maxY - minY), clip);
  if (!win) return;
  const w = win.w;
  const h = win.h;
  const isoX = win.x;
  const isoY = win.y;

  const isoCanvas = document.createElement('canvas');
  isoCanvas.width = w;
  isoCanvas.height = h;
  const isoCtx = getReadbackContext(isoCanvas);
  if (!isoCtx) return;

  isoCtx.save();
  isoCtx.imageSmoothingEnabled = settings.antiAliasing;
  isoCtx.translate(-isoX + pixelOffset, -isoY + pixelOffset);

  const strokeColor = skColorToRgbaString(
    settings.antiAliasing ? settings.strokeColor : { r: 255, g: 255, b: 255, a: 255 }
  );
  isoCtx.strokeStyle = strokeColor;
  isoCtx.lineWidth = sw;
  isoCtx.lineCap = settings.antiAliasing ? 'round' : (sw <= 1 ? 'butt' : 'round');
  isoCtx.lineJoin = 'round';
  isoCtx.setLineDash(getDashArray(settings.dashStyle, sw));

  // Obliczenie wektorów stycznych na krańcach krzywej
  let startTanX = p0.x - p1.x;
  let startTanY = p0.y - p1.y;
  if (Math.hypot(startTanX, startTanY) < 0.001) {
    startTanX = p0.x - p2.x;
    startTanY = p0.y - p2.y;
  }
  if (Math.hypot(startTanX, startTanY) < 0.001) {
    startTanX = p0.x - p3.x;
    startTanY = p0.y - p3.y;
  }

  let endTanX = p3.x - p2.x;
  let endTanY = p3.y - p2.y;
  if (Math.hypot(endTanX, endTanY) < 0.001) {
    endTanX = p3.x - p1.x;
    endTanY = p3.y - p1.y;
  }
  if (Math.hypot(endTanX, endTanY) < 0.001) {
    endTanX = p3.x - p0.x;
    endTanY = p3.y - p0.y;
  }

  const baseSize = Math.max(8, sw * 2.8) * Math.max(0.4, settings.markerSize || 1.0);

  let startShorten = 0;
  if (settings.startMarker !== 'none') {
    startShorten = getMarkerShortenDistance(settings.startMarker, baseSize, sw);
  }

  let endShorten = 0;
  if (settings.endMarker !== 'none') {
    endShorten = getMarkerShortenDistance(settings.endMarker, baseSize, sw);
  }

  const lenStart = Math.hypot(startTanX, startTanY);
  const lenEnd = Math.hypot(endTanX, endTanY);

  const p0Draw = { ...p0 };
  if (startShorten > 0 && lenStart > 0.001) {
    const ux = startTanX / lenStart;
    const uy = startTanY / lenStart;
    p0Draw.x = p0.x - ux * startShorten;
    p0Draw.y = p0.y - uy * startShorten;
  }

  const p3Draw = { ...p3 };
  if (endShorten > 0 && lenEnd > 0.001) {
    const ux = endTanX / lenEnd;
    const uy = endTanY / lenEnd;
    p3Draw.x = p3.x - ux * endShorten;
    p3Draw.y = p3.y - uy * endShorten;
  }

  isoCtx.beginPath();
  isoCtx.moveTo(p0Draw.x, p0Draw.y);
  isoCtx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3Draw.x, p3Draw.y);
  isoCtx.stroke();

  const markerColor = settings.antiAliasing ? settings.strokeColor : { r: 255, g: 255, b: 255, a: 255 };
  if (settings.startMarker !== 'none') {
    drawMarker(
      isoCtx,
      p0.x,
      p0.y,
      startTanX,
      startTanY,
      settings.startMarker,
      settings.markerSize,
      sw,
      markerColor
    );
  }

  if (settings.endMarker !== 'none') {
    drawMarker(
      isoCtx,
      p3.x,
      p3.y,
      endTanX,
      endTanY,
      settings.endMarker,
      settings.markerSize,
      sw,
      markerColor
    );
  }

  isoCtx.restore();

  if (!settings.antiAliasing) {
    // 1-bit crisp binary threshold
    const imgData = isoCtx.getImageData(0, 0, w, h);
    const data = imgData.data;
    const r = settings.strokeColor.r;
    const g = settings.strokeColor.g;
    const b = settings.strokeColor.b;
    const a = settings.strokeColor.a;

    const strokeCutoff = sw <= 1 ? 96 : sw <= 2 ? 110 : 128;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= strokeCutoff) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      } else {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 0;
      }
    }
    isoCtx.putImageData(imgData, 0, 0);
  }

  ctx.save();
  ctx.globalCompositeOperation = getCanvasCompositeOperation(settings.blendMode);
  ctx.imageSmoothingEnabled = settings.antiAliasing;
  ctx.drawImage(isoCanvas, isoX, isoY);
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
 * Rysuje figurę wektorową w zadanym środku, kącie i parametrach
 * z perfekcyjnym wyrównaniem obrysu, obsługą przezroczystości alfa,
 * brakiem nachodzenia, idealnym dopasowaniem do siatki pikseli (pixel grid)
 * i bez żadnych szczelin.
 */
export function renderVectorShape(
  ctx: CanvasRenderingContext2D,
  center: SKPoint,
  width: number,
  height: number,
  angle: number,
  settings: VectorShapeSettings,
  flipX: boolean = false,
  flipY: boolean = false,
  clip?: SKRectI | null
): void {
  if (width <= 0 || height <= 0) return;

  const sw = Math.max(0, settings.strokeWidth);
  const geo = getShapeGeometry(center, width, height, angle, sw);
  const { squareX, squareY, diag } = geo;
  const tightL = geo.left;
  const tightT = geo.top;
  const tightR = geo.right;
  const tightB = geo.bottom;
  const win = computeIsoWindow(ctx, tightL, tightT, tightR - tightL, tightB - tightT, clip);
  if (!win) return;
  const originX = win.x;
  const originY = win.y;
  const isoW = win.w;
  const isoH = win.h;
  const centerXOnIso = center.x - originX;
  const centerYOnIso = center.y - originY;

  const isAxisAligned = Math.abs(angle) < 0.001;
  const centerPixelOffset =
    settings.strokeAlignment === 'center' && sw % 2 === 1 && isAxisAligned ? 0.5 : 0;

  const strokeColor = settings.strokeColor;
  const fillColor = settings.fillMode === 'primary' ? settings.strokeColor : settings.fillColor;

  const joinMap: Record<StrokeCornerJoin, CanvasLineJoin> = {
    miter: 'miter',
    round: 'round',
    bevel: 'bevel',
  };
  const lineJoin = joinMap[settings.strokeCornerJoin] || 'miter';
  const lineCap: CanvasLineCap = lineJoin === 'round' ? 'round' : 'butt';

  const isoCanvas = document.createElement('canvas');
  isoCanvas.width = isoW;
  isoCanvas.height = isoH;
  const isoCtx = getReadbackContext(isoCanvas);
  if (!isoCtx) return;

  if (settings.antiAliasing) {
    // --- WYGŁADZANIE WŁĄCZONE (PŁYNNE KRAWĘDZIE, BRAK PODWÓJNEJ PRZEZROCZYSTOŚCI, BRAK SZCZELIN) ---
    const path = createShapePath(settings.shapeKind, width, height, settings);

    if (settings.fillMode === 'none') {
      // 1. Tylko obrys
      if (sw > 0) {
        isoCtx.save();
        isoCtx.imageSmoothingEnabled = true;
        isoCtx.translate(centerXOnIso + centerPixelOffset, centerYOnIso + centerPixelOffset);
        isoCtx.rotate(angle);
        isoCtx.scale(flipX ? -1 : 1, flipY ? -1 : 1);

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
          const big = diag * 2;
          inverseClip.rect(-big, -big, big * 2, big * 2);
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
      isoCtx.translate(centerXOnIso + centerPixelOffset, centerYOnIso + centerPixelOffset);
      isoCtx.rotate(angle);
      isoCtx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
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

      const tCanvas = document.createElement('canvas');
      tCanvas.width = isoW;
      tCanvas.height = isoH;
      const tCtx = getReadbackContext(tCanvas)!;
      tCtx.imageSmoothingEnabled = true;
      tCtx.translate(centerXOnIso + centerPixelOffset, centerYOnIso + centerPixelOffset);
      tCtx.rotate(angle);
      tCtx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
      tCtx.fillStyle = '#ffffff';
      tCtx.strokeStyle = '#ffffff';
      tCtx.lineJoin = lineJoin;
      tCtx.lineCap = lineCap;
      tCtx.miterLimit = 10;

      const sCanvas = document.createElement('canvas');
      sCanvas.width = isoW;
      sCanvas.height = isoH;
      const sCtx = getReadbackContext(sCanvas)!;
      sCtx.imageSmoothingEnabled = true;
      sCtx.translate(centerXOnIso + centerPixelOffset, centerYOnIso + centerPixelOffset);
      sCtx.rotate(angle);
      sCtx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
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

      const tData = new Uint32Array(tCtx.getImageData(0, 0, isoW, isoH).data.buffer);
      const sData = new Uint32Array(sCtx.getImageData(0, 0, isoW, isoH).data.buffer);
      const outImg = isoCtx.createImageData(isoW, isoH);
      const out32 = new Uint32Array(outImg.data.buffer);

      const aNormS = strokeColor.a / 255;
      const aNormF = activeFillColor.a / 255;
      const rS = strokeColor.r;
      const gS = strokeColor.g;
      const bS = strokeColor.b;
      const rF = activeFillColor.r;
      const gF = activeFillColor.g;
      const bF = activeFillColor.b;
      const isOutside = settings.strokeAlignment === 'outside';

      // Wynik zależy wyłącznie od pary (pokrycie całości, pokrycie obrysu/wypełnienia) - obie to
      // wartości 0..255, więc cała funkcja trafia do tablicy 64k wpisów liczonej tym samym wzorem co
      // wcześniej per piksel (wynik bit-w-bit ten sam, pętla po pikselach to już tylko odczyt tablicy).
      const table = new Uint32Array(256 * 256);
      for (let tVal = 1; tVal < 256; tVal++) {
        const covT = tVal / 255;
        for (let sv = 0; sv < 256; sv++) {
          let covS = 0;
          let covF = 0;
          if (isOutside) {
            covF = Math.min(covT, sv / 255);
            covS = Math.max(0, covT - covF);
          } else {
            covS = Math.min(covT, sv / 255);
            covF = Math.max(0, covT - covS);
          }
          const aF = covF * aNormF;
          const aS = covS * aNormS;
          const aTotal = aF + aS;
          if (aTotal > 0.0001) {
            const rr = Math.round((aF * rF + aS * rS) / aTotal);
            const gg = Math.round((aF * gF + aS * gS) / aTotal);
            const bb = Math.round((aF * bF + aS * bS) / aTotal);
            const aa = Math.round(aTotal * 255);
            table[(tVal << 8) | sv] = ((aa << 24) | (bb << 16) | (gg << 8) | rr) >>> 0;
          }
        }
      }

      for (let i = 0; i < out32.length; i++) {
        const tVal = tData[i] >>> 24;
        if (tVal === 0) continue;
        out32[i] = table[(tVal << 8) | (sData[i] >>> 24)];
      }

      isoCtx.putImageData(outImg, 0, 0);
    }
  } else {
    // --- WYGŁADZANIE WYŁĄCZONE (1-BIT CRISP ALIASED, GEOMETRIA NAROŻNIKÓW MITER/ROUND/BEVEL, BEZ SZCZELIN) ---
    // Renderujemy wypełnienie i obrys na odrębnych buforach z pełną geometrią narożników (lineJoin: miter/round/bevel)
    // i dokładnym wycięciem obszaru obrysu (destination-out z tym samym lineJoin), a następnie dokonujemy
    // 1-bitowej binaryzacji bez nakładania się przezroczystości i bez żadnych szczelin.
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = isoW;
    fillCanvas.height = isoH;
    const fCtx = getReadbackContext(fillCanvas)!;
    fCtx.imageSmoothingEnabled = true;
    fCtx.translate(centerXOnIso + centerPixelOffset, centerYOnIso + centerPixelOffset);
    fCtx.rotate(angle);
    fCtx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    fCtx.fillStyle = '#ffffff';
    fCtx.lineJoin = lineJoin;
    fCtx.miterLimit = 10;
    fCtx.lineCap = lineCap;

    const path = createShapePath(settings.shapeKind, width, height, settings);
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

    const strokeCanvas = document.createElement('canvas');
    strokeCanvas.width = isoW;
    strokeCanvas.height = isoH;
    const sCtx = getReadbackContext(strokeCanvas)!;
    sCtx.imageSmoothingEnabled = true;
    sCtx.translate(centerXOnIso + centerPixelOffset, centerYOnIso + centerPixelOffset);
    sCtx.rotate(angle);
    sCtx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
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
        const big = diag * 2;
        inverseClip.rect(-big, -big, big * 2, big * 2);
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

    const fMaskData = fCtx.getImageData(0, 0, isoW, isoH).data;
    const sMaskData = sCtx.getImageData(0, 0, isoW, isoH).data;
    const outImg = isoCtx.createImageData(isoW, isoH);
    const outData = outImg.data;

    const rS = strokeColor.r, gS = strokeColor.g, bS = strokeColor.b, aS = strokeColor.a;
    const rF = fillColor.r, gF = fillColor.g, bF = fillColor.b, aF = fillColor.a;

    const hasFill = settings.fillMode !== 'none';
    const hasStroke = sw > 0;
    const strokeCutoff = sw <= 1 ? 55 : sw <= 2 ? 80 : 128;
    const fillCutoff = 128;

    for (let i = 0; i < outData.length; i += 4) {
      const fCov = fMaskData[i + 3];
      const sCov = sMaskData[i + 3];

      if (!hasFill) {
        // Tylko obrys
        if (sCov >= strokeCutoff) {
          outData[i] = rS;
          outData[i + 1] = gS;
          outData[i + 2] = bS;
          outData[i + 3] = aS;
        }
        continue;
      }

      if (!hasStroke) {
        // Tylko wypełnienie
        if (fCov >= fillCutoff) {
          outData[i] = rF;
          outData[i + 1] = gF;
          outData[i + 2] = bF;
          outData[i + 3] = aF;
        }
        continue;
      }

      // Zarówno obrys jak i wypełnienie
      if (settings.fillMode === 'primary') {
        const totalCov = fCov + sCov;
        if (totalCov >= 128 || sCov >= strokeCutoff) {
          outData[i] = rS;
          outData[i + 1] = gS;
          outData[i + 2] = bS;
          outData[i + 3] = aS;
        }
        continue;
      }

      // stroke-and-fill: obrys w rS, wypełnienie w rF
      const totalCov = fCov + sCov;
      if (totalCov >= 128 || sCov >= strokeCutoff) {
        if (sCov >= fCov) {
          outData[i] = rS;
          outData[i + 1] = gS;
          outData[i + 2] = bS;
          outData[i + 3] = aS;
        } else {
          outData[i] = rF;
          outData[i + 1] = gF;
          outData[i + 2] = bF;
          outData[i + 3] = aF;
        }
      }
    }

    isoCtx.putImageData(outImg, 0, 0);
  }

  ctx.save();
  ctx.globalCompositeOperation = getCanvasCompositeOperation(settings.blendMode);
  ctx.imageSmoothingEnabled = settings.antiAliasing;
  ctx.drawImage(isoCanvas, originX, originY);
  ctx.restore();
}
