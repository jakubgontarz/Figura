/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GradientPreviewParams } from './GraphicEngine.ts';
import { getCtxWindow } from './VectorRenderer.ts';

interface Lut {
  r: Uint8Array;
  g: Uint8Array;
  b: Uint8Array;
  a: Uint8Array;
}

// Tablica kolorów zależy tylko od parametrów, więc liczymy ją raz na zmianę parametrów (a nie w każdym kafelku)
const lutCache = new WeakMap<GradientPreviewParams, Lut>();

function getLut(params: GradientPreviewParams): Lut {
  let lut = lutCache.get(params);
  if (lut) return lut;
  const c0 = params.settings.reverse ? params.secondary : params.primary;
  const c1 = params.settings.reverse ? params.primary : params.secondary;
  lut = { r: new Uint8Array(1024), g: new Uint8Array(1024), b: new Uint8Array(1024), a: new Uint8Array(1024) };
  for (let k = 0; k < 1024; k++) {
    const frac = k / 1023;
    lut.r[k] = Math.round(c0.r + (c1.r - c0.r) * frac);
    lut.g[k] = Math.round(c0.g + (c1.g - c0.g) * frac);
    lut.b[k] = Math.round(c0.b + (c1.b - c0.b) * frac);
    lut.a[k] = Math.round(c0.a + (c1.a - c0.a) * frac);
  }
  lutCache.set(params, lut);
  return lut;
}

/**
 * Rysuje podgląd gradientu w oknie rastra kontekstu (kafelku). Wzory są takie same jak przy zatwierdzaniu
 * w GraphicEngine.bakeGradient, więc przy skali 1:1 podgląd jest dokładnie tym, co powstanie w warstwie.
 * Maska zaznaczenia i tryb mieszania są nakładane przez kafelkowy kompozytor, nie tutaj.
 */
export function renderGradientPreview(
  ctx: CanvasRenderingContext2D,
  params: GradientPreviewParams,
  docWidth: number,
  docHeight: number
): void {
  const win = getCtxWindow(ctx);
  const s = win.scale;
  const rw = ctx.canvas.width;
  const rh = ctx.canvas.height;
  if (rw <= 0 || rh <= 0) return;

  const { p0, p1, settings } = params;
  const sx = p0.x;
  const sy = p0.y;
  const dx = p1.x - sx;
  const dy = p1.y - sy;
  let L = Math.hypot(dx, dy);
  if (L < 0.001) L = 0.001;
  const ux = dx / L;
  const uy = dy / L;
  const vx = -uy;
  const vy = ux;

  const lut = getLut(params);
  const shape = settings.type;
  const isRepeat = settings.repeat === 'repeat';
  const twoPi = Math.PI * 2;

  const img = ctx.createImageData(rw, rh);
  const g = img.data;

  for (let j = 0; j < rh; j++) {
    const y = win.y + j / s;
    if (y < 0 || y >= docHeight) continue;
    const py = y - sy;
    for (let i = 0; i < rw; i++) {
      const x = win.x + i / s;
      if (x < 0 || x >= docWidth) continue;
      const px = x - sx;
      let t = 0;

      switch (shape) {
        case 'linear':
          t = (px * ux + py * uy) / L;
          break;
        case 'reflected':
          t = Math.abs(px * ux + py * uy) / L;
          break;
        case 'diamond':
          t = (Math.abs(px * ux + py * uy) + Math.abs(px * vx + py * vy)) / L;
          break;
        case 'radial':
          t = Math.sqrt(px * px + py * py) / L;
          break;
        case 'conic': {
          let ang = Math.atan2(px * vx + py * vy, px * ux + py * uy);
          if (ang < 0) ang += twoPi;
          t = ang / twoPi;
          break;
        }
        case 'spiral-left': {
          let ang = Math.atan2(px * vx + py * vy, px * ux + py * uy);
          if (ang < 0) ang += twoPi;
          t = Math.sqrt(px * px + py * py) / L - ang / twoPi;
          break;
        }
        case 'spiral-right': {
          let ang = Math.atan2(px * vx + py * vy, px * ux + py * uy);
          if (ang < 0) ang += twoPi;
          t = Math.sqrt(px * px + py * py) / L + ang / twoPi;
          break;
        }
      }

      if (isRepeat) {
        t = t - Math.floor(t);
        if (t < 0) t += 1;
      } else if (t < 0) t = 0;
      else if (t > 1) t = 1;

      const lutIdx = Math.min(1023, Math.max(0, Math.floor(t * 1023)));
      const o = (j * rw + i) * 4;
      g[o] = lut.r[lutIdx];
      g[o + 1] = lut.g[lutIdx];
      g[o + 2] = lut.b[lutIdx];
      g[o + 3] = lut.a[lutIdx];
    }
  }
  ctx.putImageData(img, 0, 0);
}
