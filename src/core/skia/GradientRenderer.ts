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
  /** Te same kolory spakowane w jedno słowo 32-bitowe (kolejność bajtów zgodna z ImageData). */
  packed: Uint32Array;
}

const IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Bufor wyjściowy wielokrotnego użytku (alokacja ImageData na każde zadanie podglądu obciążała GC). */
let scratchImg: ImageData | null = null;
let scratchU32: Uint32Array | null = null;

function getScratchImage(ctx: CanvasRenderingContext2D, w: number, h: number): { img: ImageData; u32: Uint32Array } {
  if (!scratchImg || scratchImg.width !== w || scratchImg.height !== h) {
    scratchImg = ctx.createImageData(w, h);
    scratchU32 = new Uint32Array(scratchImg.data.buffer);
  }
  return { img: scratchImg, u32: scratchU32! };
}

// Tablica kolorów zależy tylko od parametrów, więc liczymy ją raz na zmianę parametrów (a nie w każdym kafelku)
const lutCache = new WeakMap<GradientPreviewParams, Lut>();

function getLut(params: GradientPreviewParams): Lut {
  let lut = lutCache.get(params);
  if (lut) return lut;
  const c0 = params.settings.reverse ? params.secondary : params.primary;
  const c1 = params.settings.reverse ? params.primary : params.secondary;
  lut = {
    r: new Uint8Array(1024),
    g: new Uint8Array(1024),
    b: new Uint8Array(1024),
    a: new Uint8Array(1024),
    packed: new Uint32Array(1024),
  };
  for (let k = 0; k < 1024; k++) {
    const frac = k / 1023;
    lut.r[k] = Math.round(c0.r + (c1.r - c0.r) * frac);
    lut.g[k] = Math.round(c0.g + (c1.g - c0.g) * frac);
    lut.b[k] = Math.round(c0.b + (c1.b - c0.b) * frac);
    lut.a[k] = Math.round(c0.a + (c1.a - c0.a) * frac);
    lut.packed[k] = IS_LITTLE_ENDIAN
      ? ((lut.a[k] << 24) | (lut.b[k] << 16) | (lut.g[k] << 8) | lut.r[k]) >>> 0
      : ((lut.r[k] << 24) | (lut.g[k] << 16) | (lut.b[k] << 8) | lut.a[k]) >>> 0;
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

  // Bufor wielokrotnego użytku; piksele poza dokumentem muszą pozostać przezroczyste, więc czyścimy go na początku
  const { img, u32 } = getScratchImage(ctx, rw, rh);
  u32.fill(0);

  // Współrzędne kolumn liczone raz (te same wyrażenia co wcześniej, więc wynik jest identyczny co do piksela)
  const pxs = new Float64Array(rw);
  const colOk = new Uint8Array(rw);
  for (let i = 0; i < rw; i++) {
    const x = win.x + i / s;
    colOk[i] = x < 0 || x >= docWidth ? 0 : 1;
    pxs[i] = x - sx;
  }

  const packed = lut.packed;
  /** t -> indeks w tablicy kolorów (powtarzanie albo przycięcie) */
  const idxOf = (t0: number): number => {
    let t = t0;
    if (isRepeat) {
      t = t - Math.floor(t);
      if (t < 0) t += 1;
    } else if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return Math.min(1023, Math.max(0, Math.floor(t * 1023)));
  };

  // Rodzaj gradientu wybierany raz na zadanie (a nie w każdym pikselu)
  for (let j = 0; j < rh; j++) {
    const y = win.y + j / s;
    if (y < 0 || y >= docHeight) continue;
    const py = y - sy;
    const row = j * rw;
    switch (shape) {
      case 'linear':
        for (let i = 0; i < rw; i++) {
          if (colOk[i]) u32[row + i] = packed[idxOf((pxs[i] * ux + py * uy) / L)];
        }
        break;
      case 'reflected':
        for (let i = 0; i < rw; i++) {
          if (colOk[i]) u32[row + i] = packed[idxOf(Math.abs(pxs[i] * ux + py * uy) / L)];
        }
        break;
      case 'diamond':
        for (let i = 0; i < rw; i++) {
          if (colOk[i]) {
            const px = pxs[i];
            u32[row + i] = packed[idxOf((Math.abs(px * ux + py * uy) + Math.abs(px * vx + py * vy)) / L)];
          }
        }
        break;
      case 'radial':
        for (let i = 0; i < rw; i++) {
          if (colOk[i]) {
            const px = pxs[i];
            u32[row + i] = packed[idxOf(Math.sqrt(px * px + py * py) / L)];
          }
        }
        break;
      case 'conic':
        for (let i = 0; i < rw; i++) {
          if (colOk[i]) {
            const px = pxs[i];
            let ang = Math.atan2(px * vx + py * vy, px * ux + py * uy);
            if (ang < 0) ang += twoPi;
            u32[row + i] = packed[idxOf(ang / twoPi)];
          }
        }
        break;
      case 'spiral-left':
        for (let i = 0; i < rw; i++) {
          if (colOk[i]) {
            const px = pxs[i];
            let ang = Math.atan2(px * vx + py * vy, px * ux + py * uy);
            if (ang < 0) ang += twoPi;
            u32[row + i] = packed[idxOf(Math.sqrt(px * px + py * py) / L - ang / twoPi)];
          }
        }
        break;
      case 'spiral-right':
        for (let i = 0; i < rw; i++) {
          if (colOk[i]) {
            const px = pxs[i];
            let ang = Math.atan2(px * vx + py * vy, px * ux + py * uy);
            if (ang < 0) ang += twoPi;
            u32[row + i] = packed[idxOf(Math.sqrt(px * px + py * py) / L + ang / twoPi)];
          }
        }
        break;
      default:
        // nieznany rodzaj: jak dawniej t = 0
        for (let i = 0; i < rw; i++) {
          if (colOk[i]) u32[row + i] = packed[idxOf(0)];
        }
    }
  }
  ctx.putImageData(img, 0, 0);
}
