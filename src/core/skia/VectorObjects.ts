/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LineAndCurveSettings,
  SKBlendMode,
  SKPoint,
  TextCharStyle,
  TextToolSettings,
  VectorShapeSettings,
  getCanvasCompositeOperation,
} from './types.ts';
import { PenNode, cloneNodes, nearestOnPath, penAllPoints } from './PenPath.ts';
import { renderVectorLine, renderVectorPath, renderVectorShape } from './VectorRenderer.ts';
import { RichText, TextRun, getTextInnerWidth, getTextInset, getTextLayoutOptions, layoutText, pickCharStyle, renderVectorText } from './TextEngine.ts';

/**
 * Obiekty warstwy wektorowej: linia, krzywa (także z Pisaka), kształt i tekst. Przechowują parametry, z których
 * piksele warstwy są budowane za każdym razem tym samym rendererem co przy warstwie rastrowej.
 */
export type VectorKind = 'line' | 'path' | 'shape' | 'text';

interface Base {
  id: string;
  /** Własna nazwa (null = nazwa automatyczna z rodzaju obiektu). */
  name: string | null;
  /** Widoczność obiektu (oko w liście). */
  visible: boolean;
}

export interface VecLine extends Base {
  kind: 'line';
  p0: SKPoint;
  p1: SKPoint;
  settings: LineAndCurveSettings;
}

export interface VecPath extends Base {
  kind: 'path';
  nodes: PenNode[];
  closed: boolean;
  settings: LineAndCurveSettings;
  /** true = narysowana Pisakiem (swobodnie) */
  freehand?: boolean;
}

export interface VecShape extends Base {
  kind: 'shape';
  center: SKPoint;
  width: number;
  height: number;
  angle: number;
  flipX: boolean;
  flipY: boolean;
  settings: VectorShapeSettings;
}

export interface VecText extends Base {
  kind: 'text';
  center: SKPoint;
  width: number;
  height: number;
  angle: number;
  autoHeight: boolean;
  runs: TextRun[];
  settings: TextToolSettings;
  fallback: TextCharStyle;
}

export type VectorObject = VecLine | VecPath | VecShape | VecText;

export interface VecBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

let idCounter = 0;
export function newVectorId(): string {
  return `vo_${Date.now().toString(36)}_${(++idCounter).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

const cp = (p: SKPoint): SKPoint => ({ x: p.x, y: p.y });
const cloneColor = <T extends { r: number; g: number; b: number; a: number }>(c: T): T => ({ ...c });

function cloneLineSettings(s: LineAndCurveSettings): LineAndCurveSettings {
  return { ...s, strokeColor: cloneColor(s.strokeColor), fillColor: cloneColor(s.fillColor) };
}
function cloneShapeSettings(s: VectorShapeSettings): VectorShapeSettings {
  return { ...s, strokeColor: cloneColor(s.strokeColor), fillColor: cloneColor(s.fillColor) };
}
function cloneTextSettings(s: TextToolSettings): TextToolSettings {
  return { ...s, strokeColor: cloneColor(s.strokeColor), fillColor: cloneColor(s.fillColor) };
}

export function cloneVectorObject(o: VectorObject): VectorObject {
  switch (o.kind) {
    case 'line':
      return { ...o, p0: cp(o.p0), p1: cp(o.p1), settings: cloneLineSettings(o.settings) };
    case 'path':
      return { ...o, nodes: cloneNodes(o.nodes), settings: cloneLineSettings(o.settings) };
    case 'shape':
      return { ...o, center: cp(o.center), settings: cloneShapeSettings(o.settings) };
    case 'text':
      return {
        ...o,
        center: cp(o.center),
        runs: o.runs.map((r) => ({ text: r.text, style: { ...r.style } })),
        settings: cloneTextSettings(o.settings),
        fallback: { ...o.fallback },
      };
  }
}

export function cloneVectorObjects(list: VectorObject[]): VectorObject[] {
  return list.map(cloneVectorObject);
}

/** Dane z pliku .fig: uzupełnia brakujące pola i odrzuca obiekty uszkodzone. */
export function reviveVectorObjects(raw: unknown): VectorObject[] {
  if (!Array.isArray(raw)) return [];
  const out: VectorObject[] = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object' || typeof o.kind !== 'string') continue;
    if (!['line', 'path', 'shape', 'text'].includes(o.kind)) continue;
    const base = { id: typeof o.id === 'string' ? o.id : newVectorId(), name: typeof o.name === 'string' ? o.name : null, visible: o.visible !== false };
    try {
      if (o.kind === 'line') out.push({ ...(o as VecLine), ...base });
      else if (o.kind === 'path') out.push({ ...(o as VecPath), ...base });
      else if (o.kind === 'shape') out.push({ ...(o as VecShape), ...base });
      else out.push({ ...(o as VecText), ...base });
    } catch {
      /* pomiń */
    }
  }
  return cloneVectorObjects(out);
}

export function vectorObjectBlend(o: VectorObject): SKBlendMode {
  return o.settings.blendMode;
}

export function vectorRichText(o: VecText): RichText {
  const rt = new RichText();
  rt.runs = o.runs.map((r) => ({ text: r.text, style: { ...r.style } }));
  return rt;
}

/** Rysuje obiekt na przezroczystym kontekście (tryb mieszania stosuje wołający). */
export function drawVectorObject(ctx: CanvasRenderingContext2D, o: VectorObject): void {
  switch (o.kind) {
    case 'line':
      renderVectorLine(ctx, o.p0, o.p1, { ...o.settings, blendMode: 'SrcOver' });
      break;
    case 'path':
      renderVectorPath(ctx, o.nodes, o.closed, { ...o.settings, blendMode: 'SrcOver' });
      break;
    case 'shape':
      renderVectorShape(ctx, o.center, o.width, o.height, o.angle, { ...o.settings, blendMode: 'SrcOver' }, o.flipX, o.flipY);
      break;
    case 'text':
      renderVectorText(ctx, o.center, o.width, o.height, o.angle, vectorRichText(o), o.settings, undefined, o.fallback);
      break;
  }
}

/** Nakłada obiekt na kontekst akumulacji tak jak przy zatwierdzaniu na warstwie rastrowej (obiekt osobno, potem tryb mieszania). */
let scratchCanvas: HTMLCanvasElement | null = null;
export function compositeVectorObject(acc: CanvasRenderingContext2D, o: VectorObject, w: number, h: number, ox: number, oy: number): void {
  if (!scratchCanvas) scratchCanvas = document.createElement('canvas');
  if (scratchCanvas.width !== w || scratchCanvas.height !== h) {
    scratchCanvas.width = w;
    scratchCanvas.height = h;
  }
  const sctx = scratchCanvas.getContext('2d')!;
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, w, h);
  sctx.translate(-ox, -oy);
  drawVectorObject(sctx, o);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  acc.save();
  acc.globalCompositeOperation = getCanvasCompositeOperation(vectorObjectBlend(o));
  acc.drawImage(scratchCanvas, 0, 0);
  acc.restore();
}

/** Zachowawczy prostokąt (piksele dokumentu), poza którym obiekt niczego nie rysuje. */
export function vectorObjectBounds(o: VectorObject): VecBounds {
  switch (o.kind) {
    case 'line': {
      const sw = o.settings.strokeWidth * (o.settings.markerSize || 1) * 4;
      const pad = Math.max(40, sw + 40);
      return { x0: Math.floor(Math.min(o.p0.x, o.p1.x) - pad), y0: Math.floor(Math.min(o.p0.y, o.p1.y) - pad), x1: Math.ceil(Math.max(o.p0.x, o.p1.x) + pad), y1: Math.ceil(Math.max(o.p0.y, o.p1.y) + pad) };
    }
    case 'path': {
      const pts = penAllPoints(o.nodes);
      const sw = o.settings.strokeWidth * (o.settings.markerSize || 1) * 4;
      const pad = Math.max(40, sw + 40);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pts) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
      if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
      return { x0: Math.floor(x0 - pad), y0: Math.floor(y0 - pad), x1: Math.ceil(x1 + pad), y1: Math.ceil(y1 + pad) };
    }
    case 'shape': {
      const diag = Math.hypot(o.width, o.height) / 2;
      const pad = Math.max(40, o.settings.strokeWidth * 3 + 40);
      const r = diag + pad;
      return { x0: Math.floor(o.center.x - r), y0: Math.floor(o.center.y - r), x1: Math.ceil(o.center.x + r), y1: Math.ceil(o.center.y + r) };
    }
    case 'text': {
      const s = o.settings;
      const inset = getTextInset(s);
      let extH = o.height;
      let extW = o.width;
      try {
        const lay = layoutText(vectorRichText(o), getTextInnerWidth(o.width, s), getTextLayoutOptions(s, o.fallback ?? pickCharStyle(s)));
        extH = Math.max(o.height, lay.height + 2 * inset);
        extW = Math.max(o.width, getTextInnerWidth(o.width, s) + 2 * inset);
      } catch {
        /* pomiar niedostępny: zostaje rozmiar ramki */
      }
      const r = Math.hypot(extW, extH) / 2 + Math.max(24, s.strokeWidth * 2 + 24) + s.fontSize;
      return { x0: Math.floor(o.center.x - r), y0: Math.floor(o.center.y - r), x1: Math.ceil(o.center.x + r), y1: Math.ceil(o.center.y + r) };
    }
  }
}

export function unionBounds(a: VecBounds | null, b: VecBounds): VecBounds {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export function boundsIntersect(a: VecBounds, b: VecBounds): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

const SHAPE_NAMES: Record<string, string> = {
  rectangle: 'Prostokąt',
  'round-rect': 'Prostokąt zaokrąglony',
  ellipse: 'Elipsa',
  triangle: 'Trójkąt',
  star: 'Gwiazda',
  polygon: 'Wielokąt',
  arrow: 'Strzałka',
  heart: 'Serce',
};

export function vectorObjectLabel(o: VectorObject): string {
  if (o.name) return o.name;
  switch (o.kind) {
    case 'line':
      return 'Linia';
    case 'path':
      return o.freehand ? 'Pisak' : o.closed ? 'Krzywa zamknięta' : 'Krzywa';
    case 'shape':
      return SHAPE_NAMES[o.settings.shapeKind as string] ?? 'Kształt';
    case 'text': {
      const t = o.runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
      return t ? `Tekst: ${t.length > 18 ? `${t.slice(0, 18)}…` : t}` : 'Tekst';
    }
  }
}

function distToSegment(p: SKPoint, a: SKPoint, b: SKPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Czy punkt dokumentu trafia w obiekt (linie i krzywe: w pobliżu osi; kształty i tekst: wewnątrz ramki). */
export function hitTestVectorObject(o: VectorObject, p: SKPoint, tol: number): boolean {
  switch (o.kind) {
    case 'line':
      return distToSegment(p, o.p0, o.p1) <= Math.max(o.settings.strokeWidth / 2, 0) + tol;
    case 'path': {
      const hit = nearestOnPath(o.nodes, o.closed, p);
      if (hit && hit.dist <= Math.max(o.settings.strokeWidth / 2, 0) + tol) return true;
      if (o.closed && o.nodes.length > 2 && o.settings.fillMode !== 'none') {
        const c = document.createElement('canvas').getContext('2d')!;
        const path = new Path2D();
        const pts = o.nodes;
        path.moveTo(pts[0].x, pts[0].y);
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          path.bezierCurveTo((a.hout ?? a).x, (a.hout ?? a).y, (b.hin ?? b).x, (b.hin ?? b).y, b.x, b.y);
        }
        path.closePath();
        return c.isPointInPath(path, p.x, p.y);
      }
      return false;
    }
    case 'shape':
    case 'text': {
      const dx = p.x - o.center.x;
      const dy = p.y - o.center.y;
      const c = Math.cos(-o.angle);
      const s = Math.sin(-o.angle);
      const lx = dx * c - dy * s;
      const ly = dx * s + dy * c;
      let h = o.height;
      if (o.kind === 'text') {
        try {
          const st = o.settings;
          const lay = layoutText(vectorRichText(o), getTextInnerWidth(o.width, st), getTextLayoutOptions(st, o.fallback ?? pickCharStyle(st)));
          h = Math.max(o.height, lay.height + 2 * getTextInset(st));
        } catch {
          /* zostaje wysokość ramki */
        }
      }
      return Math.abs(lx) <= o.width / 2 + tol && Math.abs(ly) <= h / 2 + tol;
    }
  }
}

/** Przesuwa obiekt o wektor (w miejscu) i zwraca go. */
export function translateVectorObject<T extends VectorObject>(o: T, dx: number, dy: number): T {
  const mv = (p: SKPoint | null | undefined) => {
    if (p) {
      p.x += dx;
      p.y += dy;
    }
  };
  switch (o.kind) {
    case 'line':
      mv(o.p0);
      mv(o.p1);
      break;
    case 'path':
      for (const n of o.nodes) {
        mv(n);
        mv(n.hin);
        mv(n.hout);
      }
      break;
    case 'shape':
    case 'text':
      mv(o.center);
      break;
  }
  return o;
}

/** Dokładny prostokąt widocznego rysunku obiektu (do ramki zaznaczenia i zaznaczania obszarem), w pikselach dokumentu. */
export function vectorObjectTightBounds(o: VectorObject): VecBounds {
  const pts: SKPoint[] = [];
  let pad = 0;
  switch (o.kind) {
    case 'line':
      pts.push(o.p0, o.p1);
      pad = o.settings.strokeWidth / 2 + (o.settings.markerSize > 1 ? o.settings.strokeWidth * (o.settings.markerSize - 1) * 2 : 0);
      break;
    case 'path':
      pts.push(...penAllPoints(o.nodes));
      pad = o.settings.strokeWidth / 2;
      break;
    case 'shape':
    case 'text': {
      let h = o.height;
      let w = o.width;
      if (o.kind === 'text') {
        try {
          const st = o.settings;
          const lay = layoutText(vectorRichText(o), getTextInnerWidth(o.width, st), getTextLayoutOptions(st, o.fallback ?? pickCharStyle(st)));
          h = Math.max(o.height, lay.height + 2 * getTextInset(st));
        } catch {
          /* zostaje wysokość ramki */
        }
      }
      const c = Math.cos(o.angle);
      const s = Math.sin(o.angle);
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = (sx * w) / 2;
        const ly = (sy * h) / 2;
        pts.push({ x: o.center.x + lx * c - ly * s, y: o.center.y + lx * s + ly * c });
      }
      pad = o.settings.strokeWidth / 2;
      break;
    }
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  if (!isFinite(x0)) return { x0: 0, y0: 0, x1: 0, y1: 0 };
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** Klucz niezależny od kolejności pól (do porównywania obiektów). */
export function vectorObjectKey(o: VectorObject): string {
  return JSON.stringify(o, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v)
          .sort()
          .reduce((acc: Record<string, unknown>, k) => {
            acc[k] = v[k];
            return acc;
          }, {})
      : v
  );
}

export function vectorObjectsEqual(a: VectorObject, b: VectorObject): boolean {
  return vectorObjectKey(a) === vectorObjectKey(b);
}
