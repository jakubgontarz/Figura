/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Przesunięcie krawędzi zaznaczenia (Zaznacz > Rozszerz / zmniejsz): prawdziwy offset konturu, z okrągłymi narożami,
 * liczony na masce z dokładnością do ułamka piksela (euklidesowa transformata odległości, Felzenszwalb–Huttenlocher).
 * Dzięki temu rozszerzenie o 10 px wypycha każdy fragment krawędzi o dokładnie 10 px, a nie „kwadratowo” jak maksymalny filtr.
 */

const INF = 1e20;

/** Kwadrat odległości do najbliższego piksela „zerowego” (f = 0), jednowymiarowo, w miejscu. */
function edt1d(f: Float32Array, n: number, v: Int32Array, z: Float32Array, out: Float32Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

/** Kwadraty odległości euklidesowej każdego piksela od najbliższego piksela, dla którego `zero[i]` jest prawdą. */
export function squaredDistance(zero: Uint8Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = zero[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float32Array(n);
  const o = new Float32Array(n);
  const v = new Int32Array(n);
  const z = new Float32Array(n + 1);
  // kolumny
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, v, z, o);
    for (let y = 0; y < h; y++) g[y * w + x] = o[y];
  }
  // wiersze
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = g[row + x];
    edt1d(f, w, v, z, o);
    for (let x = 0; x < w; x++) g[row + x] = o[x];
  }
  return g;
}

/**
 * Przesuwa krawędź maski (kanał alfa, 0–255) o `delta` px: dodatnie rozszerza, ujemne zmniejsza.
 * Wynik zachowuje oryginalne, miękkie wartości tam, gdzie krawędź się nie przesunęła (rozszerzenie nigdy nie
 * obniża, a zmniejszenie nigdy nie podnosi pokrycia piksela), a nowa krawędź jest wygładzona na szerokość piksela.
 * Granice obrazu NIE są traktowane jak zaznaczenie ani jak „brak zaznaczenia”: poza obrazem nic nie ma.
 */
export function offsetAlpha(alpha: Uint8Array | Uint8ClampedArray, w: number, h: number, delta: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(alpha.length);
  out.set(alpha);
  if (delta === 0) return out;
  const grow = delta > 0;
  const r = Math.abs(delta);
  // „zerowe” piksele: przy rozszerzaniu zaznaczone, przy zmniejszaniu niezaznaczone
  const src = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) src[i] = grow ? (alpha[i] >= 128 ? 1 : 0) : alpha[i] < 128 ? 1 : 0;
  const d2 = squaredDistance(src, w, h);
  for (let i = 0; i < alpha.length; i++) {
    const d = d2[i] >= INF / 2 ? 1e9 : Math.sqrt(d2[i]);
    if (grow) {
      // piksele należące do zaznaczenia (także z częściowym kryciem na dawnej krawędzi) stają się pełne, inaczej na granicy
      // dawnego zaznaczenia zostałby cienki, jaśniejszy pasek
      if (src[i]) {
        out[i] = 255;
        continue;
      }
      const cover = Math.max(0, Math.min(1, r - d + 1));
      const a = Math.round(cover * 255);
      if (a > out[i]) out[i] = a;
    } else {
      if (src[i]) {
        // piksel niezaznaczony: zeruje się także słaby, półprzezroczysty ślad dawnej krawędzi
        out[i] = 0;
        continue;
      }
      const cover = Math.max(0, Math.min(1, d - r));
      const a = Math.round(cover * 255);
      if (a < out[i]) out[i] = a;
    }
  }
  return out;
}
