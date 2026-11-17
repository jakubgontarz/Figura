/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GraphicEngine } from './GraphicEngine.ts';

export type ExportFormat = 'png' | 'jpeg' | 'webp' | 'bmp';
export type ExportScope = 'document' | 'selection' | 'layer';

export interface ExportOptions {
  format: ExportFormat;
  /** Jakość 1–100 (JPEG, WebP) */
  quality: number;
  scope: ExportScope;
  /** Rozmiar wynikowy w pikselach (po skalowaniu) */
  width: number;
  height: number;
  /** Tło pod przezroczystością: null = zachowaj przezroczystość (PNG, WebP), inaczej kolor `#rrggbb` */
  background: string | null;
  /** Rozdzielczość zapisywana w metadanych pliku (punkty na cal) */
  dpi: number;
  /** PNG: dołącz znacznik przestrzeni barw sRGB */
  srgbTag: boolean;
}

export interface FormatInfo {
  id: ExportFormat;
  label: string;
  ext: string;
  mime: string;
  alpha: boolean;
  lossy: boolean;
  dpiMeta: boolean;
  hint: string;
}

export const EXPORT_FORMATS: FormatInfo[] = [
  { id: 'png', label: 'PNG', ext: 'png', mime: 'image/png', alpha: true, lossy: false, dpiMeta: true, hint: 'Bezstratny, z przezroczystością. Najlepszy do grafiki, zrzutów i obrazów, które będą dalej edytowane.' },
  { id: 'jpeg', label: 'JPEG', ext: 'jpg', mime: 'image/jpeg', alpha: false, lossy: true, dpiMeta: true, hint: 'Stratny, bez przezroczystości, małe pliki. Najlepszy do zdjęć.' },
  { id: 'webp', label: 'WebP', ext: 'webp', mime: 'image/webp', alpha: true, lossy: true, dpiMeta: false, hint: 'Nowoczesny format dla internetu: małe pliki, przezroczystość. Bez zapisu rozdzielczości.' },
  { id: 'bmp', label: 'BMP', ext: 'bmp', mime: 'image/bmp', alpha: false, lossy: false, dpiMeta: true, hint: 'Nieskompresowany 24-bitowy, bez przezroczystości. Duże pliki, pełna zgodność.' },
];

export const formatInfo = (f: ExportFormat): FormatInfo => EXPORT_FORMATS.find((x) => x.id === f)!;

/** Prostokąt (w pikselach dokumentu), który obejmuje eksport w danym zakresie. */
export function exportSourceRect(engine: GraphicEngine, scope: ExportScope): { x: number; y: number; w: number; h: number } {
  if (scope === 'selection' && engine.selectionManager.hasActiveSelection) {
    const b = engine.selectionManager.getSelectionBounds();
    if (b && b.width > 0 && b.height > 0) {
      const x = Math.max(0, Math.floor(b.left));
      const y = Math.max(0, Math.floor(b.top));
      return { x, y, w: Math.min(engine.width, Math.ceil(b.right)) - x, h: Math.min(engine.height, Math.ceil(b.bottom)) - y };
    }
  }
  return { x: 0, y: 0, w: engine.width, h: engine.height };
}

/** Obraz źródłowy eksportu w rozdzielczości dokumentu (przed skalowaniem), bez tła. */
export function renderExportSource(engine: GraphicEngine, scope: ExportScope): HTMLCanvasElement {
  const r = exportSourceRect(engine, scope);
  const out = document.createElement('canvas');
  out.width = r.w;
  out.height = r.h;
  const ctx = out.getContext('2d')!;
  let src: CanvasImageSource;
  if (scope === 'layer') {
    const full = document.createElement('canvas');
    full.width = engine.width;
    full.height = engine.height;
    const l = engine.getActiveLayer();
    if (l && !l.isGroup && !l.isAdjustment && !l.isVector) l.tileGrid.drawToFlatContext(full.getContext('2d')!);
    src = full;
  } else {
    src = engine.getCompositeFlatCanvas();
  }
  ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return out;
}

/** Skaluje obraz do `w`×`h` z wygładzaniem; duże zmniejszenia robi etapami (połowienie), żeby uniknąć aliasingu. */
export function resampleCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (w === src.width && h === src.height) return src;
  let cur = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(cur.width / 2);
    c.height = Math.ceil(cur.height / 2);
    const x = c.getContext('2d')!;
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = cur.width < w || cur.height < h ? w / cur.width < 4 : true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

/** Gotowy do zapisu obraz: wybrany zakres, skala, tło. */
export function renderExportCanvas(engine: GraphicEngine, o: ExportOptions): HTMLCanvasElement {
  const info = formatInfo(o.format);
  const scaled = resampleCanvas(renderExportSource(engine, o.scope), o.width, o.height);
  const bg = !info.alpha ? o.background ?? '#ffffff' : o.background;
  if (!bg) return scaled;
  const out = document.createElement('canvas');
  out.width = scaled.width;
  out.height = scaled.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(scaled, 0, 0);
  return out;
}

// --------------------------------------------------------------------------------------------------------------
// Kodowanie i metadane
// --------------------------------------------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ppm = (dpi: number) => Math.round(dpi / 0.0254);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Wstawia do PNG znaczniki rozdzielczości (pHYs) i, opcjonalnie, przestrzeni barw sRGB. */
export function pngWithMeta(png: Uint8Array, dpi: number, srgb: boolean): Uint8Array {
  // sygnatura (8) + IHDR (4 długość + 4 typ + 13 danych + 4 CRC)
  const insertAt = 8 + 25;
  const extra: Uint8Array[] = [];
  if (srgb) extra.push(pngChunk('sRGB', new Uint8Array([0])));
  const phys = new Uint8Array(9);
  const dv = new DataView(phys.buffer);
  dv.setUint32(0, ppm(dpi));
  dv.setUint32(4, ppm(dpi));
  phys[8] = 1;
  extra.push(pngChunk('pHYs', phys));
  const total = extra.reduce((s, e) => s + e.length, 0);
  const out = new Uint8Array(png.length + total);
  out.set(png.subarray(0, insertAt), 0);
  let p = insertAt;
  for (const e of extra) {
    out.set(e, p);
    p += e.length;
  }
  out.set(png.subarray(insertAt), p);
  return out;
}

/** Ustawia gęstość (punkty na cal) w nagłówku JFIF; gdy go brak, dodaje nowy. */
export function jpegWithDpi(jpg: Uint8Array, dpi: number): Uint8Array {
  const d = Math.max(1, Math.min(65535, Math.round(dpi)));
  const hasJfif = jpg[2] === 0xff && jpg[3] === 0xe0 && jpg[6] === 0x4a && jpg[7] === 0x46 && jpg[8] === 0x49 && jpg[9] === 0x46;
  if (hasJfif) {
    const out = jpg.slice();
    out[11] = 1;
    out[12] = (d >> 8) & 255;
    out[13] = d & 255;
    out[14] = (d >> 8) & 255;
    out[15] = d & 255;
    return out;
  }
  const hdr = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, (d >> 8) & 255, d & 255, (d >> 8) & 255, d & 255, 0, 0]);
  const out = new Uint8Array(jpg.length + hdr.length);
  out.set(jpg.subarray(0, 2), 0);
  out.set(hdr, 2);
  out.set(jpg.subarray(2), 2 + hdr.length);
  return out;
}

/** 24-bitowy BMP (bez przezroczystości: obraz musi mieć już tło). */
export function encodeBmp(canvas: HTMLCanvasElement, dpi: number): Uint8Array {
  const w = canvas.width;
  const h = canvas.height;
  const rowBytes = Math.ceil((w * 3) / 4) * 4;
  const size = 54 + rowBytes * h;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true);
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, rowBytes * h, true);
  dv.setInt32(38, ppm(dpi), true);
  dv.setInt32(42, ppm(dpi), true);
  const data = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  for (let y = 0; y < h; y++) {
    let o = 54 + (h - 1 - y) * rowBytes;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[o++] = data[i + 2];
      out[o++] = data[i + 1];
      out[o++] = data[i];
    }
  }
  return out;
}

const toBlob = (c: HTMLCanvasElement, mime: string, q?: number): Promise<Blob> =>
  new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Nie udało się zakodować obrazu'))), mime, q));

/** Koduje obraz w wybranym formacie i dopisuje metadane (rozdzielczość, sRGB). */
export async function encodeExport(engine: GraphicEngine, o: ExportOptions): Promise<Uint8Array> {
  const canvas = renderExportCanvas(engine, o);
  return encodeCanvas(canvas, o);
}

export async function encodeCanvas(canvas: HTMLCanvasElement, o: ExportOptions): Promise<Uint8Array> {
  const info = formatInfo(o.format);
  if (o.format === 'bmp') return encodeBmp(canvas, o.dpi);
  const blob = await toBlob(canvas, info.mime, info.lossy ? Math.max(0.01, Math.min(1, o.quality / 100)) : undefined);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (o.format === 'png') return pngWithMeta(bytes, o.dpi, o.srgbTag);
  if (o.format === 'jpeg') return jpegWithDpi(bytes, o.dpi);
  return bytes;
}

export const humanBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** Odczytuje rozdzielczość zapisaną w pliku PNG (pHYs) albo JPEG (JFIF); null, gdy jej brak lub format nieznany. */
export function sniffDpi(d: Uint8Array): number | null {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  // PNG
  if (d.length > 33 && d[0] === 0x89 && d[1] === 0x50) {
    let p = 8;
    while (p + 12 <= d.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(d[p + 4], d[p + 5], d[p + 6], d[p + 7]);
      if (type === 'pHYs' && len >= 9 && dv.getUint8(p + 16) === 1) {
        const ppm = dv.getUint32(p + 8);
        return ppm > 0 ? Math.round((ppm * 25.4) / 1000) : null;
      }
      if (type === 'IDAT' || type === 'IEND') return null;
      p += 12 + len;
    }
    return null;
  }
  // JPEG: segment APP0 „JFIF”
  if (d.length > 20 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff && d[3] === 0xe0 && d[6] === 0x4a && d[7] === 0x46) {
    const unit = d[13];
    const x = dv.getUint16(14);
    if (x > 0 && unit === 1) return x;
    if (x > 0 && unit === 2) return Math.round(x * 2.54);
  }
  return null;
}
