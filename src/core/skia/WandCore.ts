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


/**
 * Usuwa punkty prawie współliniowe z sąsiadami (odległość od prostej prev-next <= eps). Odpowiednik dawnego
 * simplifyCollinearLoop na tablicach par, ale na płaskich tablicach liczb; wynik jest taki sam.
 */
export function simplifyFlatRing(pts: Float64Array, eps: number): Float64Array {
  let count = pts.length >> 1;
  if (count < 3) return pts;
  const closed = pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1];
  if (closed) count--;
  if (count < 3) return pts;
  const keep = new Uint8Array(count);
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const pi = (i - 1 + count) % count;
    const ni = (i + 1) % count;
    const dx = pts[2 * ni] - pts[2 * pi];
    const dy = pts[2 * ni + 1] - pts[2 * pi + 1];
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 0.00001) continue;
    const cross = Math.abs((pts[2 * i + 1] - pts[2 * pi + 1]) * dx - (pts[2 * i] - pts[2 * pi]) * dy);
    if (cross / Math.sqrt(lenSq) > eps) {
      keep[i] = 1;
      kept++;
    }
  }
  if (kept < 3) return pts;
  const out = new Float64Array((kept + 1) * 2);
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (keep[i]) {
      out[o++] = pts[2 * i];
      out[o++] = pts[2 * i + 1];
    }
  }
  out[o++] = out[0];
  out[o++] = out[1];
  return out;
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

/**
 * Marching squares na masce różdżki (0/1/2/255, układ z marginesem - patrz WAND_PAD); klasyfikacja komórek omija
 * jednolite obszary po 4 piksele naraz (kontur to zwykle drobny ułamek obszaru). Zwraca pierścienie w układzie dokumentu.
 */
export function traceBinaryMask(
  mask: Uint8Array,
  ms: number,
  w: number,
  h: number,
  left: number,
  top: number,
  right: number,
  bottom: number
): Float64Array[] {
  const minX = Math.max(-1, Math.floor(left) - 4);
  const minY = Math.max(-1, Math.floor(top) - 4);
  // Komórki x = w i y = h nie mają krawędzi (wszystkie ich piksele leżą poza płótnem), więc ich pomijamy
  const maxX = Math.min(w - 1, Math.ceil(right) + 4);
  const maxY = Math.min(h - 1, Math.ceil(bottom) + 4);
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  if (cw <= 0 || ch <= 0) return [];

  const cm = new Uint8Array((cw * ch + 3) & ~3);
  const m32 = new Uint32Array(mask.buffer, mask.byteOffset, mask.length >> 2);
  const HI = 0x80808080;
  for (let cy = 0; cy < ch; cy++) {
    const y = minY + cy;
    const r0 = (y + 1) * ms + WAND_PAD; // wiersz y (y = -1 i y = h to puste wiersze)
    const r1 = r0 + ms; // wiersz y + 1
    const o = cy * cw;
    let xi = 0;
    const cell = (x: number): void => {
      const c =
        (mask[r0 + x] >> 7) |
        ((mask[r0 + x + 1] >> 7) << 1) |
        ((mask[r1 + x + 1] >> 7) << 2) |
        ((mask[r1 + x] >> 7) << 3);
      cm[o + x - minX] = c === 15 ? 0 : c;
    };
    // początek: do granicy słowa
    while (xi < cw && ((minX + xi) & 3) !== 0) cell(minX + xi++);
    // środek: po 4 komórki; słowo wiersza + pierwszy bajt następnego słowa pokrywają piksele x..x+4
    for (; xi + 3 < cw; xi += 4) {
      const x = minX + xi;
      const k0 = (r0 + x) >> 2;
      const k1 = (r1 + x) >> 2;
      const a = m32[k0];
      const a1 = m32[k0 + 1];
      const b = m32[k1];
      const b1 = m32[k1 + 1];
      if (((a | a1 | b | b1) & HI) === 0) continue; // same piksele spoza obszaru
      if (((a & a1 & b & b1) & HI) === HI) continue; // same piksele z obszaru
      cell(x);
      cell(x + 1);
      cell(x + 2);
      cell(x + 3);
    }
    while (xi < cw) cell(minX + xi++);
  }

  const pxy = (x: number, y: number, e: number, out: Float64Array): void => {
    if (e === 0) { out[0] = x + 1; out[1] = y + 0.5; }
    else if (e === 1) { out[0] = x + 1.5; out[1] = y + 1; }
    else if (e === 2) { out[0] = x + 1; out[1] = y + 1.5; }
    else { out[0] = x + 0.5; out[1] = y + 1; }
  };
  return traceCells(cm, cw, ch, minX, minY, pxy);
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
export function ringsOfFlood(f: FloodResult, w: number, h: number): Float64Array[] {
  if (f.bMaxX < f.bMinX || f.bMaxY < f.bMinY) return [];
  const raw = traceBinaryMask(f.mask, f.ms, w, h, f.bMinX, f.bMinY, f.bMaxX + 1, f.bMaxY + 1);
  const out: Float64Array[] = [];
  for (const ring of raw) {
    if (ring.length < 6) continue;
    const simple = simplifyFlatRing(ring, 0.15);
    if (simple.length >= 6) out.push(simple);
  }
  return out;
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
