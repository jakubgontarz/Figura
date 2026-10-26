/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SKPoint } from './types.ts';

/**
 * Model krzywej wielowęzłowej (narzędzie "Krzywa Beziera").
 *
 * Każdy węzeł ma położenie oraz opcjonalne uchwyty: `hin` (wygładzenie odcinka PRZED węzłem) i `hout`
 * (wygładzenie odcinka PO węźle), oba w bezwzględnych współrzędnych dokumentu. Rodzaj węzła wynika z tego, które
 * uchwyty istnieją:
 *  - sharp  - brak uchwytów (ostry narożnik),
 *  - before - tylko `hin`,
 *  - after  - tylko `hout`,
 *  - both   - oba uchwyty, zawsze współliniowe (gładki przebieg).
 * Odcinek między węzłami a i b jest sześcienną krzywą Beziera (a, a.hout ?? a, b.hin ?? b, b); gdy żaden z uchwytów
 * nie istnieje, jest to zwykła prosta.
 */
export interface PenNode {
  x: number;
  y: number;
  hin: SKPoint | null;
  hout: SKPoint | null;
}

export type PenMode = 'sharp' | 'before' | 'after' | 'both';

export const PEN_MODES: { id: PenMode; label: string; hint: string }[] = [
  { id: 'sharp', label: 'Ostry', hint: 'Narożnik bez wygładzenia' },
  { id: 'before', label: 'Wygładzony przed', hint: 'Wygładzony odcinek przed węzłem' },
  { id: 'after', label: 'Wygładzony po', hint: 'Wygładzony odcinek po węźle' },
  { id: 'both', label: 'Wygładzony z obu stron', hint: 'Gładki przebieg przez węzeł' },
];

export interface PenSegment {
  /** indeks węzła początkowego i końcowego */
  i: number;
  j: number;
  a: SKPoint;
  c1: SKPoint;
  c2: SKPoint;
  b: SKPoint;
  /** prosta (bez uchwytów) */
  straight: boolean;
}

const EPS = 1e-6;
const same = (p: SKPoint, q: SKPoint) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;

export function penNodeMode(n: PenNode): PenMode {
  if (n.hin && n.hout) return 'both';
  if (n.hin) return 'before';
  if (n.hout) return 'after';
  return 'sharp';
}

export function cloneNodes(nodes: PenNode[]): PenNode[] {
  return nodes.map((n) => ({
    x: n.x,
    y: n.y,
    hin: n.hin ? { x: n.hin.x, y: n.hin.y } : null,
    hout: n.hout ? { x: n.hout.x, y: n.hout.y } : null,
  }));
}

export function penSegments(nodes: PenNode[], closed: boolean): PenSegment[] {
  const out: PenSegment[] = [];
  const n = nodes.length;
  const count = closed && n > 2 ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n;
    const A = nodes[i];
    const B = nodes[j];
    const a = { x: A.x, y: A.y };
    const b = { x: B.x, y: B.y };
    const c1 = A.hout ? { x: A.hout.x, y: A.hout.y } : a;
    const c2 = B.hin ? { x: B.hin.x, y: B.hin.y } : b;
    out.push({ i, j, a, c1, c2, b, straight: same(c1, a) && same(c2, b) });
  }
  return out;
}

/** Wszystkie punkty (węzły i uchwyty) - do wyznaczania obszaru krzywej. */
export function penAllPoints(nodes: PenNode[]): SKPoint[] {
  const pts: SKPoint[] = [];
  for (const n of nodes) {
    pts.push({ x: n.x, y: n.y });
    if (n.hin) pts.push(n.hin);
    if (n.hout) pts.push(n.hout);
  }
  return pts;
}

/** Klucz zawartości krzywej (bez stanu edycji) - do porównywania podglądu. */
export function penContentKey(nodes: PenNode[], closed: boolean): string {
  return JSON.stringify([nodes, closed]);
}

/** Klucz czystego przesunięcia: współrzędne względem pierwszego węzła. */
export function penShapeKey(nodes: PenNode[], closed: boolean): string {
  if (nodes.length === 0) return '[]';
  const ox = nodes[0].x;
  const oy = nodes[0].y;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return JSON.stringify([
    nodes.map((n) => [
      r(n.x - ox),
      r(n.y - oy),
      n.hin ? [r(n.hin.x - ox), r(n.hin.y - oy)] : 0,
      n.hout ? [r(n.hout.x - ox), r(n.hout.y - oy)] : 0,
    ]),
    closed,
  ]);
}

/** Kierunki styczne na końcach otwartej krzywej (od wnętrza krzywej na zewnątrz), jak dotychczas dla krzywej 4-punktowej. */
export function penEndTangents(nodes: PenNode[]): { start: SKPoint; end: SKPoint } | null {
  const segs = penSegments(nodes, false);
  if (segs.length === 0) return null;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const dir = (from: SKPoint, candidates: SKPoint[]): SKPoint => {
    for (const c of candidates) {
      const dx = from.x - c.x;
      const dy = from.y - c.y;
      if (Math.hypot(dx, dy) >= 0.001) return { x: dx, y: dy };
    }
    return { x: 0, y: 0 };
  };
  return {
    start: dir(first.a, [first.c1, first.c2, first.b]),
    end: dir(last.b, [last.c2, last.c1, last.a]),
  };
}

/** Dodaje do kontekstu 2D ścieżkę krzywej; końce otwartej krzywej mogą być skrócone (markery). */
export function tracePenPath(
  ctx: { moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void; closePath(): void },
  nodes: PenNode[],
  closed: boolean,
  startDraw?: SKPoint,
  endDraw?: SKPoint
): void {
  const segs = penSegments(nodes, closed);
  if (segs.length === 0) return;
  const isClosed = closed && nodes.length > 2;
  const s0 = startDraw ?? segs[0].a;
  ctx.moveTo(s0.x, s0.y);
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    const b = !isClosed && k === segs.length - 1 && endDraw ? endDraw : s.b;
    if (s.straight) ctx.lineTo(b.x, b.y);
    else ctx.bezierCurveTo(s.c1.x, s.c1.y, s.c2.x, s.c2.y, b.x, b.y);
  }
  if (isClosed) ctx.closePath();
}

// ---------- Edycja węzłów ----------

const round = (v: number) => Math.round(v);

function norm(dx: number, dy: number): SKPoint | null {
  const l = Math.hypot(dx, dy);
  return l < EPS ? null : { x: dx / l, y: dy / l };
}

function neighbor(nodes: PenNode[], i: number, d: -1 | 1, closed: boolean): PenNode | null {
  const n = nodes.length;
  const k = i + d;
  if (k >= 0 && k < n) return nodes[k];
  if (closed && n > 2) return nodes[(k + n) % n];
  return null;
}

/** Położenia uchwytów wyznaczone z sąsiadów (styczna równoległa do prostej prev -> next, długość = 1/3 odcinka). */
function autoHandles(nodes: PenNode[], i: number, closed: boolean): { hin: SKPoint | null; hout: SKPoint | null } {
  const node = nodes[i];
  const prev = neighbor(nodes, i, -1, closed);
  const next = neighbor(nodes, i, 1, closed);
  let dir: SKPoint | null = null;
  if (prev && next) dir = norm(next.x - prev.x, next.y - prev.y);
  else if (next) dir = norm(next.x - node.x, next.y - node.y);
  else if (prev) dir = norm(node.x - prev.x, node.y - prev.y);
  if (!dir) return { hin: null, hout: null };
  const lenIn = prev ? Math.hypot(node.x - prev.x, node.y - prev.y) / 3 : next ? Math.hypot(next.x - node.x, next.y - node.y) / 3 : 0;
  const lenOut = next ? Math.hypot(next.x - node.x, next.y - node.y) / 3 : lenIn;
  return {
    hin: lenIn > 0.5 ? { x: round(node.x - dir.x * lenIn), y: round(node.y - dir.y * lenIn) } : null,
    hout: lenOut > 0.5 ? { x: round(node.x + dir.x * lenOut), y: round(node.y + dir.y * lenOut) } : null,
  };
}

/** Które rodzaje węzła mają sens dla danego węzła (końce otwartej krzywej mają tylko jedną stronę). */
export function penModeAvailable(nodes: PenNode[], i: number, closed: boolean, mode: PenMode): boolean {
  if (closed && nodes.length > 2) return true;
  if (mode === 'sharp') return true;
  const isFirst = i === 0;
  const isLast = i === nodes.length - 1;
  if (nodes.length < 2) return false;
  if (isFirst && (mode === 'before' || mode === 'both')) return false;
  if (isLast && (mode === 'after' || mode === 'both')) return false;
  return true;
}

/** Zmienia rodzaj węzła. Istniejące uchwyty są zachowywane, brakujące wyznaczane automatycznie. */
export function setNodeMode(nodes: PenNode[], i: number, mode: PenMode, closed: boolean): PenNode[] {
  const out = cloneNodes(nodes);
  const n = out[i];
  if (!n) return out;
  if (mode === 'sharp') {
    n.hin = null;
    n.hout = null;
    return out;
  }
  const auto = autoHandles(out, i, closed);
  const dirFrom = (h: SKPoint) => norm(h.x - n.x, h.y - n.y);
  if (mode === 'before') {
    n.hin = n.hin ?? auto.hin ?? (n.hout ? { x: round(2 * n.x - n.hout.x), y: round(2 * n.y - n.hout.y) } : null);
    n.hout = null;
  } else if (mode === 'after') {
    n.hout = n.hout ?? auto.hout ?? (n.hin ? { x: round(2 * n.x - n.hin.x), y: round(2 * n.y - n.hin.y) } : null);
    n.hin = null;
  } else {
    // both: współliniowe uchwyty
    if (n.hin && !n.hout) {
      const d = dirFrom(n.hin);
      const len = auto.hout ? Math.hypot(auto.hout.x - n.x, auto.hout.y - n.y) : Math.hypot(n.hin.x - n.x, n.hin.y - n.y);
      n.hout = d && len > 0 ? { x: round(n.x - d.x * len), y: round(n.y - d.y * len) } : auto.hout;
    } else if (n.hout && !n.hin) {
      const d = dirFrom(n.hout);
      const len = auto.hin ? Math.hypot(auto.hin.x - n.x, auto.hin.y - n.y) : Math.hypot(n.hout.x - n.x, n.hout.y - n.y);
      n.hin = d && len > 0 ? { x: round(n.x - d.x * len), y: round(n.y - d.y * len) } : auto.hin;
    } else if (!n.hin && !n.hout) {
      n.hin = auto.hin;
      n.hout = auto.hout;
    }
  }
  return out;
}

/** Przesuwa uchwyt; w węźle gładkim z obu stron drugi uchwyt obraca się, zachowując swoją długość. */
export function moveHandle(nodes: PenNode[], i: number, which: 'hin' | 'hout', target: SKPoint): PenNode[] {
  const out = cloneNodes(nodes);
  const n = out[i];
  if (!n) return out;
  n[which] = { x: target.x, y: target.y };
  const other = which === 'hin' ? 'hout' : 'hin';
  const o = n[other];
  if (o) {
    const d = norm(target.x - n.x, target.y - n.y);
    if (d) {
      const len = Math.hypot(o.x - n.x, o.y - n.y);
      n[other] = { x: round(n.x - d.x * len), y: round(n.y - d.y * len) };
    }
  }
  return out;
}

/** Przesuwa węzeł wraz z jego uchwytami. */
export function moveNodeBy(nodes: PenNode[], i: number, dx: number, dy: number): PenNode[] {
  const out = cloneNodes(nodes);
  const n = out[i];
  if (!n) return out;
  n.x += dx;
  n.y += dy;
  if (n.hin) n.hin = { x: n.hin.x + dx, y: n.hin.y + dy };
  if (n.hout) n.hout = { x: n.hout.x + dx, y: n.hout.y + dy };
  return out;
}

export function moveAllBy(nodes: PenNode[], dx: number, dy: number): PenNode[] {
  return nodes.map((n) => ({
    x: n.x + dx,
    y: n.y + dy,
    hin: n.hin ? { x: n.hin.x + dx, y: n.hin.y + dy } : null,
    hout: n.hout ? { x: n.hout.x + dx, y: n.hout.y + dy } : null,
  }));
}

/** Nowy węzeł nadaje obu uchwytom kierunek przeciągania (gładki przebieg): hout w miejscu kursora, hin symetrycznie. */
export function setSmoothFromDrag(nodes: PenNode[], i: number, cursor: SKPoint): PenNode[] {
  const out = cloneNodes(nodes);
  const n = out[i];
  if (!n) return out;
  n.hout = { x: cursor.x, y: cursor.y };
  n.hin = { x: round(2 * n.x - cursor.x), y: round(2 * n.y - cursor.y) };
  return out;
}

/** Końce otwartej krzywej nie mają uchwytów od strony, po której nie ma odcinka. */
export function normalizeOpenEnds(nodes: PenNode[], closed: boolean): PenNode[] {
  const out = cloneNodes(nodes);
  if (closed && out.length > 2) return out;
  if (out.length > 0) out[0].hin = null;
  if (out.length > 0) out[out.length - 1].hout = null;
  return out;
}

export function removeNode(nodes: PenNode[], i: number): PenNode[] {
  const out = cloneNodes(nodes);
  out.splice(i, 1);
  return out;
}

// ---------- Geometria krzywej ----------

export function bezierPoint(s: PenSegment, t: number): SKPoint {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * s.a.x + w1 * s.c1.x + w2 * s.c2.x + w3 * s.b.x,
    y: w0 * s.a.y + w1 * s.c1.y + w2 * s.c2.y + w3 * s.b.y,
  };
}

export interface PenHit {
  seg: PenSegment;
  t: number;
  dist: number;
  point: SKPoint;
}

/** Najbliższy punkt na krzywej (w jednostkach dokumentu). */
export function nearestOnPath(nodes: PenNode[], closed: boolean, p: SKPoint): PenHit | null {
  let best: PenHit | null = null;
  for (const seg of penSegments(nodes, closed)) {
    const N = seg.straight ? 1 : 40;
    let bt = 0;
    let bd = Infinity;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      const q = bezierPoint(seg, t);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) {
        bd = d;
        bt = t;
      }
    }
    if (seg.straight) {
      // rzut na odcinek
      const dx = seg.b.x - seg.a.x;
      const dy = seg.b.y - seg.a.y;
      const l2 = dx * dx + dy * dy;
      bt = l2 < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - seg.a.x) * dx + (p.y - seg.a.y) * dy) / l2));
    } else {
      let lo = Math.max(0, bt - 1 / N);
      let hi = Math.min(1, bt + 1 / N);
      for (let it = 0; it < 24; it++) {
        const m1 = lo + (hi - lo) / 3;
        const m2 = hi - (hi - lo) / 3;
        const q1 = bezierPoint(seg, m1);
        const q2 = bezierPoint(seg, m2);
        if (Math.hypot(q1.x - p.x, q1.y - p.y) < Math.hypot(q2.x - p.x, q2.y - p.y)) hi = m2;
        else lo = m1;
      }
      bt = (lo + hi) / 2;
    }
    const q = bezierPoint(seg, bt);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (!best || d < best.dist) best = { seg, t: bt, dist: d, point: q };
  }
  return best;
}

/** Wstawia węzeł w punkcie krzywej (podział de Casteljau), nie zmieniając kształtu krzywej. Zwraca nowe węzły i indeks nowego węzła. */
export function insertNodeAt(nodes: PenNode[], hit: PenHit): { nodes: PenNode[]; index: number } {
  const out = cloneNodes(nodes);
  const { seg, t } = hit;
  const lerp = (p: SKPoint, q: SKPoint): SKPoint => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const insertAt = seg.j === 0 ? out.length : seg.j; // segment zamykający: nowy węzeł na końcu listy
  if (seg.straight) {
    const p = lerp(seg.a, seg.b);
    out.splice(insertAt, 0, { x: round(p.x), y: round(p.y), hin: null, hout: null });
    return { nodes: out, index: insertAt };
  }
  const p01 = lerp(seg.a, seg.c1);
  const p12 = lerp(seg.c1, seg.c2);
  const p23 = lerp(seg.c2, seg.b);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);
  const A = out[seg.i];
  const B = out[seg.j];
  A.hout = same(p01, seg.a) ? null : p01;
  B.hin = same(p23, seg.b) ? null : p23;
  out.splice(insertAt, 0, { x: mid.x, y: mid.y, hin: p012, hout: p123 });
  return { nodes: out, index: insertAt };
}
