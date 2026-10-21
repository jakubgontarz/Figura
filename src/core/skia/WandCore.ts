/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Czyste obliczenia wypełniania obszarów (magiczna różdżka i wiadro z farbą): wypełnianie przebiegami poziomymi,
 * śledzenie konturów (marching squares) i uproszczenie pierścieni. Moduł nie używa DOM, więc działa tak samo
 * w głównym wątku i w wątku roboczym (WandWorker.ts).
 */

// Liczby zapisane jako wielokrotności 0,5 (kontury z maski) formatujemy z tabeli - dużo szybciej niż String(number)
const HALF_STR: string[] = [];
function fmtNum(v: number): string {
  const t = v * 2;
  if (t >= 0 && t < 20000 && t === (t | 0)) {
    if (HALF_STR.length === 0) {
      for (let i = 0; i < 20000; i++) HALF_STR.push(String(i / 2));
    }
    return HALF_STR[t];
  }
  return String(v);
}

/** Napis SVG jednego pierścienia (M ... L ... Z). */
export function ringToPathString(ring: Float64Array): string {
  let d = 'M' + fmtNum(ring[0]) + ' ' + fmtNum(ring[1]);
  for (let i = 2; i < ring.length; i += 2) d += 'L' + fmtNum(ring[i]) + ' ' + fmtNum(ring[i + 1]);
  return d + 'Z';
}

/** Napis SVG ścieżki z pierścieni (każdy: M ... L ... Z). */
export function ringsToPathString(rings: Float64Array[]): string {
  const parts: string[] = new Array(rings.length);
  for (let r = 0; r < rings.length; r++) parts[r] = ringToPathString(rings[r]);
  return parts.join('');
}


// Tablice przejść marching squares: segmenty każdego z 16 przypadków jako (krawędź wejścia -> krawędź wyjścia).
// Krawędzie: 0 góra, 1 prawa, 2 dół, 3 lewa. Bity przypadku: 1 = lewy górny, 2 = prawy górny, 4 = prawy dolny, 8 = lewy dolny.
/** Margines (w pikselach) po bokach maski różdżki; wielokrotność 4, żeby kolumna x leżała na granicy słowa 32-bitowego. */
export const WAND_PAD = 4;

export const TRACE_NEXT = new Int8Array(16 * 4).fill(-1);
export const TRACE_SLOT = new Uint8Array(16 * 4);
export const TRACE_START = new Int8Array(16 * 2).fill(-1);
(() => {
  const T = 0, R = 1, B = 2, L = 3;
  const defs: Record<number, number[][]> = {
    1: [[L, T]], 2: [[T, R]], 3: [[L, R]], 4: [[R, B]],
    5: [[L, T], [R, B]], 6: [[T, B]], 7: [[L, B]], 8: [[B, L]],
    9: [[B, T]], 10: [[T, R], [B, L]], 11: [[B, R]], 12: [[R, L]],
    13: [[R, T]], 14: [[T, L]],
  };
  for (const k of Object.keys(defs)) {
    const c = Number(k);
    defs[c].forEach(([from, to], slot) => {
      TRACE_NEXT[c * 4 + from] = to;
      TRACE_SLOT[c * 4 + from] = slot;
      TRACE_START[c * 2 + slot] = from;
    });
  }
})();


/**
 * Śledzenie pętli po sklasyfikowanych komórkach. Segment: (krawędź wejścia -> krawędź wyjścia);
 * NEXT/SLOT indeksowane [przypadek * 4 + wejście], START [przypadek * 2 + slot] = krawędź wejścia segmentu.
 */
export function traceCells(
  cm: Uint8Array,
  cw: number,
  ch: number,
  minX: number,
  minY: number,
  edgePoint: (x: number, y: number, e: number, out: Float64Array) => void
): Float64Array[] {
  const NEXT = TRACE_NEXT;
  const SLOT = TRACE_SLOT;
  const START = TRACE_START;
  const pt = new Float64Array(2);
  let buf = new Float64Array(4096);
  let n = 0;
  const push = (): void => {
    if (n + 2 > buf.length) {
      const nb = new Float64Array(buf.length * 2);
      nb.set(buf);
      buf = nb;
    }
    buf[n++] = pt[0];
    buf[n++] = pt[1];
  };
  const rings: Float64Array[] = [];

  // Skan komórek w kolejności wierszowej; puste słowa 4 komórek są pomijane jednym porównaniem
  const total = cw * ch;
  const cm32 = new Uint32Array(cm.buffer, cm.byteOffset, cm.length >> 2);
  for (let i = 0; i < total; i++) {
    if ((i & 3) === 0 && cm32[i >> 2] === 0) {
      i += 3;
      continue;
    }
    const c0 = cm[i] & 15;
    if (c0 === 0) continue;
    const cy = (i / cw) | 0;
    const cx = i - cy * cw;
    const slots = c0 === 5 || c0 === 10 ? 2 : 1;
    for (let sl = 0; sl < slots; sl++) {
      if (cm[i] & (16 << sl)) continue;

      n = 0;
      let ccx = cx;
      let ccy = cy;
      let e = START[c0 * 2 + sl];
      edgePoint(minX + ccx, minY + ccy, e, pt);
      push();
      for (;;) {
        const idx = ccy * cw + ccx;
        const c = cm[idx] & 15;
        cm[idx] |= 16 << SLOT[c * 4 + e];
        const out = NEXT[c * 4 + e];
        edgePoint(minX + ccx, minY + ccy, out, pt);
        push();
        let nx = ccx;
        let ny = ccy;
        if (out === 0) ny--;
        else if (out === 1) nx++;
        else if (out === 2) ny++;
        else nx--;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) break; // kontur urwany granicą obszaru wyszukiwania
        const ne = (out + 2) & 3;
        const nidx = ny * cw + nx;
        const nc = cm[nidx] & 15;
        if (nc === 0 || NEXT[nc * 4 + ne] < 0) break;
        if (cm[nidx] & (16 << SLOT[nc * 4 + ne])) break; // wróciliśmy do segmentu startowego - pętla zamknięta
        ccx = nx;
        ccy = ny;
        e = ne;
      }

      if (n >= 6) rings.push(buf.slice(0, n));
    }
  }
  return rings;
}

export interface FloodResult {
  /** Maska w układzie z marginesem (patrz WAND_PAD): 255 = wybrany piksel */
  mask: Uint8Array;
  /** Długość wiersza maski */
  ms: number;
  count: number;
  /** Prostokąt opisany na wybranych pikselach (włącznie); bMaxX < bMinX = pusty */
  bMinX: number;
  bMinY: number;
  bMaxX: number;
  bMaxY: number;
}

/**
 * Wybór pikseli o kolorze zbliżonym do koloru piksela startowego. `data` = RGBA (jak ImageData), tolerancja w %.
 * Test koloru: sqrt(dr^2 + dg^2 + db^2 + da^2/4) <= tolerancja/100 * 441.67 (dokładnie jak dawniej; pierwiastek liczony
 * tylko tuż przy progu). `allow` (opcjonalnie): płaszczyzna alfa zaznaczenia - piksele z alfą 0 są pomijane
 * (poza pikselem startowym, który zawsze jest wybrany).
 */
export function floodSelect(
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  tolerance: number,
  global: boolean,
  allow: Uint8Array | null = null
): FloodResult {
  const startIdx = (sy * w + sx) * 4;
  const targetR = data[startIdx];
  const targetG = data[startIdx + 1];
  const targetB = data[startIdx + 2];
  const targetA = data[startIdx + 3];
  const maxDist = (tolerance / 100) * 441.67;
  // Porównanie kwadratów zamiast pierwiastka; tylko tuż przy progu rozstrzyga dokładny pierwiastek.
  // Pracujemy na 4*d2 (liczba całkowita: 4*(dr^2+dg^2+db^2) + da^2), co jest dokładnym przeskalowaniem d2 o potęgę dwójki.
  const maxD2 = maxDist * maxDist;
  const bandLo4 = 4 * (maxD2 * (1 - 1e-9));
  const bandHi4 = 4 * (maxD2 * (1 + 1e-9));
  const inTol4 = (d4: number): boolean => (d4 <= bandLo4 ? true : d4 > bandHi4 ? false : Math.sqrt(d4 / 4) <= maxDist);
  // Stany: 0 = nieznany, 1 = poza tolerancją, 2 = w tolerancji (jeszcze nie wypełniony), 255 = wybrany.
  // Układ maski: wiersze o długości ms (wielokrotność 4) z marginesem WAND_PAD po bokach oraz pustym wierszem
  // na górze i na dole. Dzięki temu skan konturów nie sprawdza granic i może porównywać po 4 piksele naraz.
  const ms = (w + 2 * WAND_PAD + 3) & ~3;
  const wandMask = new Uint8Array(ms * (h + 2));
  let count = 0;
  let bMinX = w;
  let bMinY = h;
  let bMaxX = -1;
  let bMaxY = -1;

  if (global) {
    for (let y = 0; y < h; y++) {
      let p = y * w * 4;
      const row = (y + 1) * ms + WAND_PAD;
      const arow = y * w;
      for (let x = 0; x < w; x++, p += 4) {
        if (allow !== null && allow[arow + x] === 0) continue;
        const dr = data[p] - targetR;
        const dg = data[p + 1] - targetG;
        const db = data[p + 2] - targetB;
        const da = data[p + 3] - targetA;
        if (inTol4(4 * (dr * dr + dg * dg + db * db) + da * da)) {
          wandMask[row + x] = 255;
          count++;
          if (x < bMinX) bMinX = x;
          if (x > bMaxX) bMaxX = x;
          if (y < bMinY) bMinY = y;
          if (y > bMaxY) bMaxY = y;
        }
      }
    }
  } else {
    // Wypełnianie 4-spójne metodą przebiegów poziomych (bez alokacji na piksel). Wynik sprawdzenia każdego piksela jest
    // zapamiętany w masce, więc sąsiednie przebiegi nie liczą go ponownie. true = piksel jeszcze nie wybrany i w tolerancji.
    const free = (mi: number, pi: number): boolean => {
      const st = wandMask[mi];
      if (st !== 0) return st === 2;
      if (allow !== null && allow[pi >> 2] === 0) {
        wandMask[mi] = 1;
        return false;
      }
      const dr = data[pi] - targetR;
      const dg = data[pi + 1] - targetG;
      const db = data[pi + 2] - targetB;
      const da = data[pi + 3] - targetA;
      const ok = inTol4(4 * (dr * dr + dg * dg + db * db) + da * da);
      wandMask[mi] = ok ? 2 : 1;
      return ok;
    };

    wandMask[(sy + 1) * ms + WAND_PAD + sx] = 2; // piksel startowy jest zawsze wybrany
    const stack: number[] = [sx, sy];
    while (stack.length > 0) {
      const y = stack.pop()!;
      const x = stack.pop()!;
      const row = (y + 1) * ms + WAND_PAD; // indeks w masce
      const prow = y * w * 4; // indeks w pikselach
      if (!free(row + x, prow + x * 4)) continue;

      let xl = x;
      while (xl > 0 && free(row + xl - 1, prow + (xl - 1) * 4)) xl--;
      let xr = x;
      while (xr < w - 1 && free(row + xr + 1, prow + (xr + 1) * 4)) xr++;

      wandMask.fill(255, row + xl, row + xr + 1);
      count += xr - xl + 1;
      if (xl < bMinX) bMinX = xl;
      if (xr > bMaxX) bMaxX = xr;
      if (y < bMinY) bMinY = y;
      if (y > bMaxY) bMaxY = y;

      for (let ny = y - 1; ny <= y + 1; ny += 2) {
        if (ny < 0 || ny >= h) continue;
        const nrow = (ny + 1) * ms + WAND_PAD;
        const nprow = ny * w * 4;
        let inRun = false;
        for (let nx = xl; nx <= xr; nx++) {
          const ok = free(nrow + nx, nprow + nx * 4);
          if (ok && !inRun) {
            stack.push(nx, ny);
            inRun = true;
          } else if (!ok) {
            inRun = false;
          }
        }
      }
    }
  }
  return { mask: wandMask, ms, count, bMinX, bMinY, bMaxX, bMaxY };
}

/** Kontury obszaru z maski flood: pierścienie po uproszczeniu (jak w zaznaczeniu różdżką), każdy >= 3 punkty. */
export interface WandCrop {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 255 = piksel zaznaczony, 0 = nie; w x h, bez marginesu */
  data: Uint8Array;
}

/** Dokładna (piksel w piksel) maska obszaru różdżki w prostokącie opisanym; null gdy nic nie wybrano. */
export function cropOfFlood(f: FloodResult): WandCrop | null {
  if (f.bMaxX < f.bMinX || f.bMaxY < f.bMinY) return null;
  const w = f.bMaxX - f.bMinX + 1;
  const h = f.bMaxY - f.bMinY + 1;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (f.bMinY + y + 1) * f.ms + WAND_PAD + f.bMinX;
    for (let x = 0; x < w; x++) if (f.mask[src + x] === 255) data[y * w + x] = 255;
  }
  return { x: f.bMinX, y: f.bMinY, w, h, data };
}

/**
 * Kontur obszaru różdżki jako wielokąty biegnące dokładnie po krawędziach pikseli (jak suma wielu prostokątów):
 * wielokąty = [pierścień zewnętrzny, ...otwory], współrzędne całkowite w układzie dokumentu. Bez upraszczania i bez
 * ścinania narożników, więc rasteryzacja daje dokładnie te same piksele. Zwraca null, gdy kontur jest zbyt złożony
 * (wtedy wywołujący używa dokładnej maski rastrowej).
 */
export function pixelGeomOfCrop(crop: WandCrop, maxEdges = 600000): Float64Array[][] | null {
  const { w, h, data, x: ox, y: oy } = crop;
  const W = w + 1;
  // bity wyjścia z wierzchołka: 1 = w prawo, 2 = w dół, 4 = w lewo, 8 = w górę (wnętrze po prawej stronie ruchu)
  const out = new Uint8Array(W * (h + 1));
  let edges = 0;
  const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[y * w + x] !== 255) continue;
      if (!on(x, y - 1)) { out[y * W + x] |= 1; edges++; }
      if (!on(x + 1, y)) { out[y * W + x + 1] |= 2; edges++; }
      if (!on(x, y + 1)) { out[(y + 1) * W + x + 1] |= 4; edges++; }
      if (!on(x - 1, y)) { out[(y + 1) * W + x] |= 8; edges++; }
    }
    if (edges > maxEdges) return null;
  }
  if (edges === 0) return [];
  const orig = out.slice();
  const DX = [1, 0, -1, 0];
  const DY = [0, 1, 0, -1];
  const outers: { ring: Float64Array; area: number; bx0: number; by0: number; bx1: number; by1: number }[] = [];
  const holes: { ring: Float64Array; area: number; bx0: number; by0: number; bx1: number; by1: number }[] = [];
  const pts: number[] = [];
  for (let v = 0; v < out.length; v++) {
    while (out[v] !== 0) {
      const bits = out[v];
      let d = 0;
      while (!(bits & (1 << d))) d++;
      const startV = v;
      pts.length = 0;
      let cx = v % W;
      let cy = (v - cx) / W;
      let dir = d;
      for (;;) {
        out[cy * W + cx] &= ~(1 << dir);
        cx += DX[dir];
        cy += DY[dir];
        const ob = orig[cy * W + cx];
        // reguła skrętu (prawo, prosto, lewo) rozstrzyga wierzchołki styku narożnikowego jednolicie
        let nd = (dir + 1) & 3;
        if (!(ob & (1 << nd))) {
          nd = dir;
          if (!(ob & (1 << nd))) nd = (dir + 3) & 3;
        }
        if (nd !== dir) pts.push(cx + ox, cy + oy);
        dir = nd;
        if (!(out[cy * W + cx] & (1 << dir))) break;
      }
      void startV;
      const ring = Float64Array.from(pts);
      let area = 0;
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      const n = ring.length >> 1;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        area += ring[2 * i] * ring[2 * j + 1] - ring[2 * j] * ring[2 * i + 1];
        if (ring[2 * i] < bx0) bx0 = ring[2 * i];
        if (ring[2 * i] > bx1) bx1 = ring[2 * i];
        if (ring[2 * i + 1] < by0) by0 = ring[2 * i + 1];
        if (ring[2 * i + 1] > by1) by1 = ring[2 * i + 1];
      }
      area /= 2;
      (area > 0 ? outers : holes).push({ ring, area, bx0, by0, bx1, by1 });
    }
  }
  if (holes.length * outers.length > 4e6) return null;
  outers.sort((a, b) => a.area - b.area);
  const polys: Float64Array[][] = outers.map((o) => [o.ring]);
  for (const hole of holes) {
    // punkt na środku pierwszej krawędzi otworu leży wewnątrz jego rodzica (najmniejszego zewnętrznego pierścienia)
    const px = (hole.ring[0] + hole.ring[2]) / 2;
    const py = (hole.ring[1] + hole.ring[3]) / 2;
    for (let i = 0; i < outers.length; i++) {
      const o = outers[i];
      if (px < o.bx0 || px > o.bx1 || py < o.by0 || py > o.by1) continue;
      const r = o.ring;
      const n = r.length >> 1;
      let inside = false;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ax = r[2 * a], ay = r[2 * a + 1], bx = r[2 * b], by = r[2 * b + 1];
        if ((ay > py) !== (by > py) && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside;
      }
      if (inside) {
        polys[i].push(hole.ring);
        break;
      }
    }
  }
  return polys;
}

export interface BucketAlpha {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Alfa wypełnienia w prostokącie (w x h); 0 = bez wypełnienia */
  alpha: Uint8Array;
  count: number;
}

/**
 * Maska alfa wiadra z farbą w prostokącie opisanym na obszarze. Z wygładzaniem piksele w ostatnich 25% tolerancji dostają
 * malejącą alfę (jak dawniej: 1 - (dist - 0,75*max) / (0,25*max)), reszta 255.
 */
export function bucketAlphaOfFlood(
  f: FloodResult,
  data: Uint8ClampedArray | Uint8Array,
  w: number,
  sx: number,
  sy: number,
  tolerance: number,
  antiAlias: boolean
): BucketAlpha | null {
  if (f.bMaxX < f.bMinX || f.bMaxY < f.bMinY) return null;
  const bw = f.bMaxX - f.bMinX + 1;
  const bh = f.bMaxY - f.bMinY + 1;
  const alpha = new Uint8Array(bw * bh);
  const maxDist = (tolerance / 100) * 441.67;
  const startIdx = (sy * w + sx) * 4;
  const tR = data[startIdx];
  const tG = data[startIdx + 1];
  const tB = data[startIdx + 2];
  const tA = data[startIdx + 3];
  const grade = antiAlias && maxDist > 0;
  const lo = maxDist * 0.75;
  const lo4 = 4 * lo * lo;
  for (let y = 0; y < bh; y++) {
    const mrow = (f.bMinY + y + 1) * f.ms + WAND_PAD + f.bMinX;
    const orow = y * bw;
    let p = ((f.bMinY + y) * w + f.bMinX) * 4;
    for (let x = 0; x < bw; x++, p += 4) {
      if (f.mask[mrow + x] !== 255) continue;
      if (grade) {
        const dr = data[p] - tR;
        const dg = data[p + 1] - tG;
        const db = data[p + 2] - tB;
        const da = data[p + 3] - tA;
        const d4 = 4 * (dr * dr + dg * dg + db * db) + da * da;
        if (d4 > lo4) {
          const dist = Math.sqrt(dr * dr + dg * dg + db * db + (da * da) / 4);
          if (dist > lo) {
            alpha[orow + x] = Math.max(1, Math.round((1 - (dist - maxDist * 0.75) / (maxDist * 0.25)) * 255));
            continue;
          }
        }
      }
      alpha[orow + x] = 255;
    }
  }
  return { x: f.bMinX, y: f.bMinY, w: bw, h: bh, alpha, count: f.count };
}
