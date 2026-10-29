/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SKPoint } from './types.ts';
import { PenNode } from './PenPath.ts';

/**
 * Dopasowanie krzywych Beziera do punktów narysowanych odręcznie (algorytm Schneidera, „An Algorithm for Automatically
 * Fitting Digitized Curves”). Wynik to lista węzłów gładkiej krzywej z uchwytami współliniowymi na połączeniach.
 */

type V = { x: number; y: number };
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
const dot = (a: V, b: V): number => a.x * b.x + a.y * b.y;
const len = (a: V): number => Math.hypot(a.x, a.y);
const norm = (a: V): V => {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

type Bez = [V, V, V, V];

function bezAt(b: Bez, t: number): V {
  const u = 1 - t;
  return {
    x: u * u * u * b[0].x + 3 * u * u * t * b[1].x + 3 * u * t * t * b[2].x + t * t * t * b[3].x,
    y: u * u * u * b[0].y + 3 * u * u * t * b[1].y + 3 * u * t * t * b[2].y + t * t * t * b[3].y,
  };
}
function bezD1(b: Bez, t: number): V {
  const u = 1 - t;
  return {
    x: 3 * u * u * (b[1].x - b[0].x) + 6 * u * t * (b[2].x - b[1].x) + 3 * t * t * (b[3].x - b[2].x),
    y: 3 * u * u * (b[1].y - b[0].y) + 6 * u * t * (b[2].y - b[1].y) + 3 * t * t * (b[3].y - b[2].y),
  };
}
function bezD2(b: Bez, t: number): V {
  const u = 1 - t;
  return {
    x: 6 * u * (b[2].x - 2 * b[1].x + b[0].x) + 6 * t * (b[3].x - 2 * b[2].x + b[1].x),
    y: 6 * u * (b[2].y - 2 * b[1].y + b[0].y) + 6 * t * (b[3].y - 2 * b[2].y + b[1].y),
  };
}

function chordParams(pts: V[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

function generateBezier(pts: V[], u: number[], t1: V, t2: V): Bez {
  const first = pts[0];
  const last = pts[pts.length - 1];
  const A: [V, V][] = u.map((t) => {
    const b1 = 3 * (1 - t) * (1 - t) * t;
    const b2 = 3 * (1 - t) * t * t;
    return [mul(t1, b1), mul(t2, b2)];
  });
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const t = u[i];
    const b0 = (1 - t) ** 3;
    const b1 = 3 * (1 - t) ** 2 * t;
    const b2 = 3 * (1 - t) * t * t;
    const b3 = t ** 3;
    c00 += dot(A[i][0], A[i][0]);
    c01 += dot(A[i][0], A[i][1]);
    c11 += dot(A[i][1], A[i][1]);
    const tmp = sub(pts[i], add(mul(first, b0 + b1), mul(last, b2 + b3)));
    x0 += dot(A[i][0], tmp);
    x1 += dot(A[i][1], tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let a1 = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let a2 = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const seg = len(sub(last, first));
  const eps = 1e-6 * seg;
  if (a1 < eps || a2 < eps) {
    a1 = a2 = seg / 3;
  }
  return [first, add(first, mul(t1, a1)), add(last, mul(t2, a2)), last];
}

function reparam(b: Bez, pts: V[], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(bezAt(b, t), pts[i]);
    const d1 = bezD1(b, t);
    const d2 = bezD2(b, t);
    const num = dot(d, d1);
    const den = dot(d1, d1) + dot(d, d2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - num / den));
  });
}

function maxError(b: Bez, pts: V[], u: number[]): { err: number; split: number } {
  let err = 0;
  let split = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = sub(bezAt(b, u[i]), pts[i]);
    const e = dot(d, d);
    if (e >= err) {
      err = e;
      split = i;
    }
  }
  return { err, split };
}

function fitCubic(pts: V[], t1: V, t2: V, error: number, out: Bez[]): void {
  if (pts.length === 2) {
    const dist = len(sub(pts[1], pts[0])) / 3;
    out.push([pts[0], add(pts[0], mul(t1, dist)), add(pts[1], mul(t2, dist)), pts[1]]);
    return;
  }
  let u = chordParams(pts);
  let b = generateBezier(pts, u, t1, t2);
  let { err, split } = maxError(b, pts, u);
  if (err < error) {
    out.push(b);
    return;
  }
  if (err < error * 16) {
    for (let k = 0; k < 4; k++) {
      u = reparam(b, pts, u);
      b = generateBezier(pts, u, t1, t2);
      ({ err, split } = maxError(b, pts, u));
      if (err < error) {
        out.push(b);
        return;
      }
    }
  }
  split = Math.max(1, Math.min(pts.length - 2, split));
  const center = norm(sub(pts[split - 1], pts[split + 1]));
  fitCubic(pts.slice(0, split + 1), t1, center, error, out);
  fitCubic(pts.slice(split), mul(center, -1), t2, error, out);
}

/** Usuwa punkty bliższe niż `minDist` od poprzedniego (poza ostatnim). */
function dedupe(points: SKPoint[], minDist: number): V[] {
  const out: V[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) >= minDist) out.push({ x: p.x, y: p.y });
  }
  const last = points[points.length - 1];
  if (out.length > 1 && last && (out[out.length - 1].x !== last.x || out[out.length - 1].y !== last.y)) {
    const q = out[out.length - 1];
    if (Math.hypot(last.x - q.x, last.y - q.y) < minDist) out[out.length - 1] = { x: last.x, y: last.y };
    else out.push({ x: last.x, y: last.y });
  }
  return out;
}

/** Lekkie wygładzenie drgań ręki (średnia ruchoma 3 punktów; końce stałe). */
function smooth(pts: V[]): V[] {
  if (pts.length < 4) return pts;
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return p;
    return { x: (pts[i - 1].x + 2 * p.x + pts[i + 1].x) / 4, y: (pts[i - 1].y + 2 * p.y + pts[i + 1].y) / 4 };
  });
}

/**
 * Zamienia ścieżkę punktów (pędzel odręczny) na węzły krzywej Beziera. `tolerance` to największe dopuszczalne
 * odchylenie krzywej od narysowanej ścieżki w pikselach dokumentu.
 */
export function fitFreehand(points: SKPoint[], tolerance: number): PenNode[] {
  const pts = smooth(dedupe(points, 1.5));
  if (pts.length < 2) return [];
  if (pts.length === 2) {
    return [
      { x: Math.round(pts[0].x), y: Math.round(pts[0].y), hin: null, hout: null },
      { x: Math.round(pts[1].x), y: Math.round(pts[1].y), hin: null, hout: null },
    ];
  }
  const t1 = norm(sub(pts[1], pts[0]));
  const t2 = norm(sub(pts[pts.length - 2], pts[pts.length - 1]));
  const segs: Bez[] = [];
  fitCubic(pts, t1, t2, tolerance * tolerance, segs);
  const nodes: PenNode[] = [];
  const r = (p: V): SKPoint => ({ x: Math.round(p.x), y: Math.round(p.y) });
  segs.forEach((s, i) => {
    if (i === 0) nodes.push({ x: Math.round(s[0].x), y: Math.round(s[0].y), hin: null, hout: r(s[1]) });
    else nodes[nodes.length - 1].hout = r(s[1]);
    nodes.push({ x: Math.round(s[3].x), y: Math.round(s[3].y), hin: r(s[2]), hout: null });
  });
  return mergeCloseNodes(nodes, 4);
}

/** Zlewa węzły leżące bliżej niż `minDist` (Schneider potrafi gęsto dzielić końce krzywej). */
function mergeCloseNodes(nodes: PenNode[], minDist: number): PenNode[] {
  const out: PenNode[] = [];
  nodes.forEach((n, i) => {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(n.x - prev.x, n.y - prev.y) < minDist) {
      if (i === nodes.length - 1) {
        // ostatni węzeł zastępuje poprzedni (zachowuje punkt końcowy)
        prev.x = n.x;
        prev.y = n.y;
        prev.hout = null;
        if (n.hin) prev.hin = n.hin;
      } else {
        prev.hout = n.hout;
      }
      return;
    }
    out.push({ x: n.x, y: n.y, hin: n.hin ? { ...n.hin } : null, hout: n.hout ? { ...n.hout } : null });
  });
  return out.length >= 2 ? out : nodes;
}
