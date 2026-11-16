/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zmiana rozmiaru bitmapy RGBA (okno „Zmień rozmiar”): rozdzielne (poziomo, potem pionowo) próbkowanie z jądrem
 * dobieranym do metody. Przy zmniejszaniu jądro jest rozciągane o współczynnik zmniejszenia, więc wynik uśrednia
 * wszystkie piksele źródła (bez „przeskakiwania” i aliasingu). Obliczenia na kolorach z mnożeniem przez alfę,
 * dzięki czemu przezroczyste piksele nie ciągną za sobą swojego (nieistotnego) koloru na krawędziach.
 */

export type ResampleMethod = 'nearest' | 'bilinear' | 'bicubic' | 'lanczos' | 'box';

export const RESAMPLE_OPTIONS: { value: ResampleMethod; label: string; hint: string }[] = [
  { value: 'bicubic', label: 'Dwusześcienna', hint: 'Gładka i ostra; dobry wybór do większości zdjęć' },
  { value: 'lanczos', label: 'Lanczos', hint: 'Najostrzejsza; przy powiększaniu może dać delikatne aureole' },
  { value: 'bilinear', label: 'Dwuliniowa', hint: 'Miękka, szybka' },
  { value: 'box', label: 'Uśrednianie', hint: 'Średnia z pikseli źródła; najlepsza do zmniejszania' },
  { value: 'nearest', label: 'Najbliższy sąsiad', hint: 'Bez wygładzania; zachowuje ostre piksele (grafika pikselowa)' },
];

type Kernel = { support: number; fn: (x: number) => number };

const sinc = (x: number): number => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));

const KERNELS: Record<Exclude<ResampleMethod, 'nearest'>, Kernel> = {
  bilinear: { support: 1, fn: (x) => (x < 1 ? 1 - x : 0) },
  box: { support: 0.5, fn: (x) => (x <= 0.5 ? 1 : 0) },
  // Catmull-Rom (a = -0.5)
  bicubic: {
    support: 2,
    fn: (x) => {
      if (x < 1) return 1.5 * x * x * x - 2.5 * x * x + 1;
      if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
      return 0;
    },
  },
  lanczos: { support: 3, fn: (x) => (x < 3 ? sinc(x) * sinc(x / 3) : 0) },
};

interface Weights {
  /** pierwszy piksel źródła wkładu dla piksela docelowego i */
  start: Int32Array;
  count: Int32Array;
  /** wagi (unormowane do 1), `maxTaps` na piksel docelowy */
  w: Float32Array;
  maxTaps: number;
}

function buildWeights(srcN: number, dstN: number, method: ResampleMethod): Weights {
  const ratio = srcN / dstN;
  const start = new Int32Array(dstN);
  const count = new Int32Array(dstN);
  if (method === 'nearest') {
    const w = new Float32Array(dstN);
    for (let i = 0; i < dstN; i++) {
      start[i] = Math.min(srcN - 1, Math.max(0, Math.floor((i + 0.5) * ratio)));
      count[i] = 1;
      w[i] = 1;
    }
    return { start, count, w, maxTaps: 1 };
  }
  const k = KERNELS[method];
  // przy zmniejszaniu jądro rozciągamy (filtr dolnoprzepustowy), przy powiększaniu zostaje naturalne
  const scale = Math.max(1, ratio);
  const sup = k.support * scale;
  const maxTaps = Math.ceil(sup * 2) + 2;
  const w = new Float32Array(dstN * maxTaps);
  for (let i = 0; i < dstN; i++) {
    const centre = (i + 0.5) * ratio;
    let lo = Math.floor(centre - sup + 0.5);
    let hi = Math.floor(centre + sup + 0.5);
    lo = Math.max(0, lo);
    hi = Math.min(srcN - 1, hi);
    if (hi < lo) {
      lo = hi = Math.min(srcN - 1, Math.max(0, Math.floor(centre)));
    }
    let sum = 0;
    const base = i * maxTaps;
    let n = 0;
    for (let s = lo; s <= hi && n < maxTaps; s++, n++) {
      const v = k.fn(Math.abs((s + 0.5 - centre) / scale));
      w[base + n] = v;
      sum += v;
    }
    if (sum === 0) {
      w[base] = 1;
      sum = 1;
      n = Math.max(1, n);
    }
    for (let q = 0; q < n; q++) w[base + q] /= sum;
    start[i] = lo;
    count[i] = n;
  }
  return { start, count, w, maxTaps };
}

/** Górny limit pamięci pośredniej (liczby zmiennoprzecinkowe) jednego pasa. */
const BAND_FLOATS = 6_000_000;

/**
 * Zmienia rozmiar bitmapy RGBA (kolory proste, jak w ImageData) z `sw x sh` na `dw x dh`.
 * Zwraca nową tablicę; źródło nie jest zmieniane.
 */
export function resampleRGBA(src: Uint8ClampedArray, sw: number, sh: number, dw: number, dh: number, method: ResampleMethod): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  if (dw === sw && dh === sh) {
    out.set(src);
    return out;
  }
  const wx = buildWeights(sw, dw, method);
  const wy = buildWeights(sh, dh, method);

  if (method === 'nearest') {
    for (let y = 0; y < dh; y++) {
      const sy = wy.start[y];
      for (let x = 0; x < dw; x++) {
        const si = (sy * sw + wx.start[x]) * 4;
        const di = (y * dw + x) * 4;
        out[di] = src[si];
        out[di + 1] = src[si + 1];
        out[di + 2] = src[si + 2];
        out[di + 3] = src[si + 3];
      }
    }
    return out;
  }

  // pas wierszy docelowych: pośredni bufor = wiersze źródła potrzebne pasu, już zmniejszone poziomo (premultiplied)
  const rowsPerDst = Math.max(1, sh / dh);
  const supRows = Math.ceil(wy.maxTaps);
  const rowFloats = dw * 4;
  let band = Math.max(1, Math.floor(BAND_FLOATS / rowFloats / (rowsPerDst + 1) - supRows));
  band = Math.min(band, dh);
  const tmp = new Float32Array(rowFloats * Math.ceil(band * rowsPerDst + supRows * 2 + 4));

  for (let y0 = 0; y0 < dh; y0 += band) {
    const y1 = Math.min(dh, y0 + band);
    // zakres wierszy źródła dla pasa
    let r0 = sh;
    let r1 = -1;
    for (let y = y0; y < y1; y++) {
      const a = wy.start[y];
      const b = a + wy.count[y] - 1;
      if (a < r0) r0 = a;
      if (b > r1) r1 = b;
    }
    const nRows = r1 - r0 + 1;
    // 1) poziomo: każdy wiersz źródła pasa -> dw pikseli (kolory * alfa)
    for (let r = 0; r < nRows; r++) {
      const sRow = (r0 + r) * sw * 4;
      const tRow = r * rowFloats;
      for (let x = 0; x < dw; x++) {
        const s0 = wx.start[x];
        const n = wx.count[x];
        const wb = x * wx.maxTaps;
        let R = 0;
        let G = 0;
        let B = 0;
        let A = 0;
        for (let q = 0; q < n; q++) {
          const si = sRow + (s0 + q) * 4;
          const a = src[si + 3];
          const wt = wx.w[wb + q];
          const wa = wt * a;
          R += src[si] * wa;
          G += src[si + 1] * wa;
          B += src[si + 2] * wa;
          A += wa;
        }
        const ti = tRow + x * 4;
        tmp[ti] = R;
        tmp[ti + 1] = G;
        tmp[ti + 2] = B;
        tmp[ti + 3] = A;
      }
    }
    // 2) pionowo: wiersze docelowe pasa
    for (let y = y0; y < y1; y++) {
      const s0 = wy.start[y] - r0;
      const n = wy.count[y];
      const wb = y * wy.maxTaps;
      for (let x = 0; x < dw; x++) {
        let R = 0;
        let G = 0;
        let B = 0;
        let A = 0;
        for (let q = 0; q < n; q++) {
          const ti = (s0 + q) * rowFloats + x * 4;
          const wt = wy.w[wb + q];
          R += tmp[ti] * wt;
          G += tmp[ti + 1] * wt;
          B += tmp[ti + 2] * wt;
          A += tmp[ti + 3] * wt;
        }
        const di = (y * dw + x) * 4;
        if (A > 1e-6) {
          out[di] = R / A;
          out[di + 1] = G / A;
          out[di + 2] = B / A;
          out[di + 3] = A;
        }
      }
    }
  }
  return out;
}
