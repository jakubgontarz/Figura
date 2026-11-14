/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Obiekty inteligentne: rejestr bitmap (spłaszczony obraz wewnętrznego dokumentu) wyszukiwanych po kluczu `png`.
 * Obiekt przechowuje `fig` (cały wewnętrzny dokument do dalszej edycji) i `png` (jego spłaszczony wynik).
 */
const bitmaps = new Map<string, HTMLCanvasElement>();
const loading = new Map<string, Promise<void>>();
const ids = new Map<string, number>();
let idSeq = 0;
let readyHook: (() => void) | null = null;

/** Wołane, gdy bitmapa wczytana z pliku jest gotowa (odświeżenie warstw). */
export function setSmartReadyHook(fn: (() => void) | null): void {
  readyHook = fn;
}

export function registerSmartBitmap(png: string, canvas: HTMLCanvasElement): void {
  bitmaps.set(png, canvas);
}

/** Krótki numer bitmapy (do kluczy podglądu). */
export function smartBitmapId(png: string | null): number {
  if (!png) return 0;
  let v = ids.get(png);
  if (v === undefined) {
    v = ++idSeq;
    ids.set(png, v);
  }
  return v;
}

export function getSmartBitmap(png: string | null): HTMLCanvasElement | null {
  if (!png) return null;
  const b = bitmaps.get(png);
  if (b) return b;
  void ensureSmartBitmap(png);
  return null;
}

/** Dekoduje bitmapę z data URL (po wczytaniu pliku lub po cofnięciu do nieznanego stanu). */
export function ensureSmartBitmap(png: string): Promise<void> {
  if (bitmaps.has(png)) return Promise.resolve();
  const pending = loading.get(png);
  if (pending) return pending;
  const p = new Promise<void>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')?.drawImage(img, 0, 0);
      bitmaps.set(png, c);
      loading.delete(png);
      resolve();
      readyHook?.();
    };
    img.onerror = () => {
      loading.delete(png);
      resolve();
    };
    img.src = png;
  });
  loading.set(png, p);
  return p;
}

/** Rysuje bitmapę obiektu w obróconej ramce (środek, rozmiar, kąt, odbicia). */
export function drawSmartBitmap(
  ctx: CanvasRenderingContext2D,
  bmp: HTMLCanvasElement | null,
  center: { x: number; y: number },
  width: number,
  height: number,
  angle: number,
  flipX: boolean,
  flipY: boolean
): void {
  if (!bmp || bmp.width < 1 || bmp.height < 1) return;
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(angle);
  ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, -width / 2, -height / 2, width, height);
  ctx.restore();
}
