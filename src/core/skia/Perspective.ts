/**
 * Przekształcenie perspektywiczne (homografia) dla narzędzia manipulacji zawartością.
 * Czworokąt: [lewy-górny, prawy-górny, prawy-dolny, lewy-dolny] (współrzędne dokumentu).
 * Źródło: prostokąt (0,0)-(w,h) mapowany na czworokąt.
 */
export type Pt = { x: number; y: number };
export type Quad = [Pt, Pt, Pt, Pt];

/** Macierz 3x3 (wierszami) przekształcająca kwadrat jednostkowy (0,0),(1,0),(1,1),(0,1) na czworokąt. */
export function homographyUnitToQuad(q: Quad): number[] | null {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g: number;
  let h: number;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    g = 0;
    h = 0;
  } else {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-12) return null;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  const a = p1.x - p0.x + g * p1.x;
  const b = p3.x - p0.x + h * p3.x;
  const c = p0.x;
  const d = p1.y - p0.y + g * p1.y;
  const e = p3.y - p0.y + h * p3.y;
  const f = p0.y;
  return [a, b, c, d, e, f, g, h, 1];
}

export function invert3(m: number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

export function applyH(m: number[], x: number, y: number): Pt {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

/** Czy czworokąt jest wypukły i niezdegenerowany (warunek poprawnej perspektywy). */
export function isConvexQuad(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-3) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function quadBounds(q: Quad): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of q) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function pointInQuad(q: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Szybki (GPU) podgląd: obraz dzielony na siatkę trójkątów, każdy rysowany przekształceniem afinicznym.
 * Trójkąty są lekko powiększone, żeby nie było szwów między nimi.
 */
export function drawPerspectiveMesh(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  srcW: number,
  srcH: number,
  quad: Quad,
  cells: number = 16
): void {
  const H = homographyUnitToQuad(quad);
  if (!H) return;
  const n = Math.max(1, cells);
  const pts: Pt[][] = [];
  for (let j = 0; j <= n; j++) {
    const row: Pt[] = [];
    for (let i = 0; i <= n; i++) row.push(applyH(H, i / n, j / n));
    pts.push(row);
  }
  const cw = srcW / n;
  const ch = srcH / n;

  const tri = (
    s0: Pt, s1: Pt, s2: Pt,
    d0: Pt, d1: Pt, d2: Pt
  ) => {
    // Afiniczne przekształcenie trójkąta źródłowego na docelowy
    const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (Math.abs(den) < 1e-9) return;
    const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
    const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
    const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
    const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
    const e = d0.x - a * s0.x - c * s0.y;
    const f = d0.y - b * s0.x - d * s0.y;

    // Powiększenie trójkąta docelowego o ~0.6 px od środka ciężkości (likwiduje szwy)
    const cx = (d0.x + d1.x + d2.x) / 3;
    const cy = (d0.y + d1.y + d2.y) / 3;
    const grow = (p: Pt): Pt => {
      const vx = p.x - cx;
      const vy = p.y - cy;
      const len = Math.hypot(vx, vy) || 1;
      return { x: p.x + (vx / len) * 0.6, y: p.y + (vy / len) * 0.6 };
    };
    const g0 = grow(d0);
    const g1 = grow(d1);
    const g2 = grow(d2);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(g0.x, g0.y);
    ctx.lineTo(g1.x, g1.y);
    ctx.lineTo(g2.x, g2.y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const s00 = { x: i * cw, y: j * ch };
      const s10 = { x: (i + 1) * cw, y: j * ch };
      const s11 = { x: (i + 1) * cw, y: (j + 1) * ch };
      const s01 = { x: i * cw, y: (j + 1) * ch };
      const d00 = pts[j][i];
      const d10 = pts[j][i + 1];
      const d11 = pts[j + 1][i + 1];
      const d01 = pts[j + 1][i];
      tri(s00, s10, s11, d00, d10, d11);
      tri(s00, s11, s01, d00, d11, d01);
    }
  }
}

export interface WarpResult {
  canvas: HTMLCanvasElement;
  left: number;
  top: number;
}

/**
 * Dokładne przekształcenie piksel po pikselu (odwrotne mapowanie, interpolacja dwuliniowa na pre-multiplikowanym alfa).
 * Wynik obejmuje obwiednię czworokąta przyciętą do płótna `docW` x `docH`.
 */
export function warpPerspectiveExact(
  src: HTMLCanvasElement,
  quad: Quad,
  docW: number,
  docH: number,
  nearest: boolean
): WarpResult | null {
  const H = homographyUnitToQuad(quad);
  if (!H) return null;
  const inv = invert3(H);
  if (!inv) return null;
  const qb = quadBounds(quad);
  const left = Math.max(0, Math.floor(qb.minX));
  const top = Math.max(0, Math.floor(qb.minY));
  const right = Math.min(docW, Math.ceil(qb.maxX));
  const bottom = Math.min(docH, Math.ceil(qb.maxY));
  const w = right - left;
  const h = bottom - top;
  if (w <= 0 || h <= 0) return null;

  const sw = src.width;
  const sh = src.height;
  const sdata = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const oimg = octx.createImageData(w, h);
  const od = oimg.data;

  const m0 = inv[0], m1 = inv[1], m2 = inv[2];
  const m3 = inv[3], m4 = inv[4], m5 = inv[5];
  const m6 = inv[6], m7 = inv[7], m8 = inv[8];

  for (let y = 0; y < h; y++) {
    const py = top + y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = left + x + 0.5;
      const wq = m6 * px + m7 * py + m8;
      if (wq === 0) continue;
      const u = (m0 * px + m1 * py + m2) / wq;
      const v = (m3 * px + m4 * py + m5) / wq;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const sx = u * sw;
      const sy = v * sh;
      const o = (y * w + x) * 4;
      if (nearest) {
        const ix = Math.min(sw - 1, Math.floor(sx));
        const iy = Math.min(sh - 1, Math.floor(sy));
        const si = (iy * sw + ix) * 4;
        od[o] = sdata[si];
        od[o + 1] = sdata[si + 1];
        od[o + 2] = sdata[si + 2];
        od[o + 3] = sdata[si + 3];
        continue;
      }
      const fx = sx - 0.5;
      const fy = sy - 0.5;
      let x0 = Math.floor(fx);
      let y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      let x1 = x0 + 1;
      let y1 = y0 + 1;
      if (x0 < 0) x0 = 0;
      if (y0 < 0) y0 = 0;
      if (x1 > sw - 1) x1 = sw - 1;
      if (y1 > sh - 1) y1 = sh - 1;
      if (x0 > sw - 1) x0 = sw - 1;
      if (y0 > sh - 1) y0 = sh - 1;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const a00 = sdata[i00 + 3] * w00;
      const a10 = sdata[i10 + 3] * w10;
      const a01 = sdata[i01 + 3] * w01;
      const a11 = sdata[i11 + 3] * w11;
      const a = a00 + a10 + a01 + a11;
      if (a <= 0) continue;
      od[o] = (sdata[i00] * a00 + sdata[i10] * a10 + sdata[i01] * a01 + sdata[i11] * a11) / a;
      od[o + 1] = (sdata[i00 + 1] * a00 + sdata[i10 + 1] * a10 + sdata[i01 + 1] * a01 + sdata[i11 + 1] * a11) / a;
      od[o + 2] = (sdata[i00 + 2] * a00 + sdata[i10 + 2] * a10 + sdata[i01 + 2] * a01 + sdata[i11 + 2] * a11) / a;
      od[o + 3] = a;
    }
  }
  octx.putImageData(oimg, 0, 0);
  return { canvas: out, left, top };
}
