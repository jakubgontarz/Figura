/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SKColor,
  SKPoint,
  TextAlign,
  TextCharStyle,
  TextToolSettings,
  getCanvasCompositeOperation,
  skColorToRgbaString,
} from './types.ts';

/* ------------------------------------------------------------------ */
/*  MODEL TEKSTU Z FORMATOWANIEM FRAGMENTÓW                            */
/* ------------------------------------------------------------------ */

export interface TextRun {
  text: string;
  style: TextCharStyle;
}

export function sameCharStyle(a: TextCharStyle, b: TextCharStyle): boolean {
  return (
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.script === b.script
  );
}

export function pickCharStyle(s: TextCharStyle): TextCharStyle {
  return {
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    bold: s.bold,
    italic: s.italic,
    underline: s.underline,
    script: s.script,
  };
}

export class RichText {
  runs: TextRun[] = [];

  get length(): number {
    let n = 0;
    for (const r of this.runs) n += r.text.length;
    return n;
  }

  get plainText(): string {
    return this.runs.map((r) => r.text).join('');
  }

  clone(): RichText {
    const c = new RichText();
    c.runs = this.runs.map((r) => ({ text: r.text, style: { ...r.style } }));
    return c;
  }

  restore(other: RichText): void {
    this.runs = other.runs.map((r) => ({ text: r.text, style: { ...r.style } }));
  }

  /** Tablica stylów dla każdego znaku (referencje do obiektów run-ów). */
  styleArray(): TextCharStyle[] {
    const out: TextCharStyle[] = [];
    for (const r of this.runs) {
      for (let i = 0; i < r.text.length; i++) out.push(r.style);
    }
    return out;
  }

  /** Dzieli run na granicy `pos`; zwraca indeks run-a, który zaczyna się w `pos`. */
  private splitAt(pos: number): number {
    let acc = 0;
    for (let i = 0; i < this.runs.length; i++) {
      const r = this.runs[i];
      if (pos === acc) return i;
      if (pos < acc + r.text.length) {
        const k = pos - acc;
        const left: TextRun = { text: r.text.slice(0, k), style: { ...r.style } };
        const right: TextRun = { text: r.text.slice(k), style: { ...r.style } };
        this.runs.splice(i, 1, left, right);
        return i + 1;
      }
      acc += r.text.length;
    }
    return this.runs.length;
  }

  normalize(): void {
    const out: TextRun[] = [];
    for (const r of this.runs) {
      if (r.text.length === 0) continue;
      const last = out[out.length - 1];
      if (last && sameCharStyle(last.style, r.style)) last.text += r.text;
      else out.push(r);
    }
    this.runs = out;
  }

  insert(pos: number, text: string, style: TextCharStyle): void {
    if (!text) return;
    pos = Math.max(0, Math.min(this.length, pos));
    const idx = this.splitAt(pos);
    this.runs.splice(idx, 0, { text, style: { ...style } });
    this.normalize();
  }

  delete(start: number, end: number): void {
    start = Math.max(0, start);
    end = Math.min(this.length, end);
    if (end <= start) return;
    const s = this.splitAt(start);
    const e = this.splitAt(end);
    this.runs.splice(s, e - s);
    this.normalize();
  }

  applyStyle(start: number, end: number, patch: Partial<TextCharStyle>): void {
    start = Math.max(0, start);
    end = Math.min(this.length, end);
    if (end <= start) return;
    const s = this.splitAt(start);
    const e = this.splitAt(end);
    for (let i = s; i < e; i++) {
      this.runs[i].style = { ...this.runs[i].style, ...patch };
    }
    this.normalize();
  }

  /** Styl znaku na pozycji `index` (null gdy poza tekstem). */
  charStyle(index: number): TextCharStyle | null {
    let acc = 0;
    for (const r of this.runs) {
      if (index < acc + r.text.length) return r.style;
      acc += r.text.length;
    }
    return null;
  }

  /** Styl, który odziedziczy znak wpisany w `pos` (znak przed kursorem). */
  styleForInsert(pos: number): TextCharStyle | null {
    if (this.length === 0) return null;
    if (pos > 0) return this.charStyle(pos - 1);
    return this.charStyle(0);
  }

  /** Styl wyświetlany w pasku opcji dla zakresu (pierwszy zaznaczony znak lub znak przed kursorem). */
  styleForRange(start: number, end: number): TextCharStyle | null {
    if (this.length === 0) return null;
    if (end > start) return this.charStyle(start);
    return this.styleForInsert(start);
  }
}

/* ------------------------------------------------------------------ */
/*  POMIARY                                                            */
/* ------------------------------------------------------------------ */

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
const SCRIPT_SIZE_FACTOR = 0.65;
const SUPER_SHIFT = 0.33; // w górę, część rozmiaru bazowego
const SUB_SHIFT = 0.12;   // w dół

let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    measureCtx = c.getContext('2d')!;
  }
  return measureCtx;
}

export function effectiveFontSize(style: TextCharStyle): number {
  const base = Math.max(1, style.fontSize);
  return style.script === 'normal' ? base : Math.max(1, base * SCRIPT_SIZE_FACTOR);
}

export function buildFontString(style: TextCharStyle): string {
  const size = effectiveFontSize(style);
  const fam = GENERIC_FAMILIES.has(style.fontFamily)
    ? style.fontFamily
    : `"${style.fontFamily}", sans-serif`;
  return `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${size}px ${fam}`;
}

function scriptShiftY(style: TextCharStyle): number {
  if (style.script === 'super') return -Math.round(style.fontSize * SUPER_SHIFT);
  if (style.script === 'sub') return Math.round(style.fontSize * SUB_SHIFT);
  return 0;
}

function measureString(text: string, style: TextCharStyle, letterSpacing: number): number {
  if (!text) return 0;
  const ctx = getMeasureCtx();
  ctx.font = buildFontString(style);
  if (letterSpacing === 0) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + letterSpacing;
  return w;
}

interface FontMetrics {
  ascent: number;
  descent: number;
}
const metricsCache = new Map<string, FontMetrics>();

function getMetrics(style: TextCharStyle): FontMetrics {
  const font = buildFontString(style);
  const cached = metricsCache.get(font);
  if (cached) return cached;
  const ctx = getMeasureCtx();
  ctx.font = font;
  const m = ctx.measureText('Hgjpq');
  const size = effectiveFontSize(style);
  const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? size * 0.8;
  const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? size * 0.2;
  const res = { ascent, descent };
  if (metricsCache.size > 500) metricsCache.clear();
  metricsCache.set(font, res);
  return res;
}

/* ------------------------------------------------------------------ */
/*  UKŁAD TEKSTU (ŁAMANIE WIERSZY, WYRÓWNANIE)                         */
/* ------------------------------------------------------------------ */

export interface LayoutPiece {
  start: number;
  end: number;
  text: string;
  style: TextCharStyle;
  isSpace: boolean;
  width: number;
  x: number; // względem początku zawartości wiersza (bez offsetX)
}

export interface LayoutLine {
  start: number;
  end: number;
  pieces: LayoutPiece[];
  top: number;
  height: number;
  baseline: number; // względem góry układu
  contentWidth: number;
  offsetX: number;
  endsParagraph: boolean;
}

export interface TextLayout {
  lines: LayoutLine[];
  height: number;
  length: number;
  letterSpacing: number;
}

export interface LayoutOptions {
  align: TextAlign;
  lineSpacing: number;   // %
  letterSpacing: number; // px
  fallbackStyle: TextCharStyle;
}

interface Atom {
  pieces: LayoutPiece[];
  isSpace: boolean;
  width: number;
}

export function layoutText(rt: RichText, maxWidth: number, opts: LayoutOptions): TextLayout {
  const text = rt.plainText;
  const n = text.length;
  const styles = rt.styleArray();
  const ls = opts.letterSpacing;
  maxWidth = Math.max(1, maxWidth);
  const lines: LayoutLine[] = [];

  const makePiece = (a: number, b: number, isSpace: boolean): LayoutPiece => ({
    start: a,
    end: b,
    text: text.slice(a, b),
    style: styles[a],
    isSpace,
    width: measureString(text.slice(a, b), styles[a], ls),
    x: 0,
  });

  const buildPieces = (a: number, b: number): LayoutPiece[] => {
    const out: LayoutPiece[] = [];
    let s = a;
    for (let i = a + 1; i <= b; i++) {
      if (
        i === b ||
        styles[i] !== styles[s] ||
        (text[i] === ' ') !== (text[s] === ' ')
      ) {
        out.push(makePiece(s, i, text[s] === ' '));
        s = i;
      }
    }
    return out;
  };

  const charAdvance = (i: number): number => {
    // Szerokość pojedynczego znaku (z odstępem), na potrzeby dzielenia długich słów
    return measureString(text[i], styles[i], ls);
  };

  const finishLine = (
    pieces: LayoutPiece[],
    start: number,
    end: number,
    endsParagraph: boolean,
    fallbackIdx: number
  ) => {
    // Zawartość = do ostatniego niebiałego piece'a
    let lastContent = -1;
    for (let i = pieces.length - 1; i >= 0; i--) {
      if (!pieces[i].isSpace) {
        lastContent = i;
        break;
      }
    }
    // Linia samych spacji: cała zawartość to te spacje
    const contentEnd = lastContent === -1 ? pieces.length - 1 : lastContent;

    let contentWidth = 0;
    for (let i = 0; i <= contentEnd; i++) contentWidth += pieces[i].width;

    // Justowanie
    if (opts.align === 'justify' && !endsParagraph && contentWidth < maxWidth && lastContent !== -1) {
      let spaceChars = 0;
      for (let i = 0; i <= contentEnd; i++) if (pieces[i].isSpace) spaceChars += pieces[i].text.length;
      if (spaceChars > 0) {
        const extra = maxWidth - contentWidth;
        for (let i = 0; i <= contentEnd; i++) {
          if (pieces[i].isSpace) pieces[i].width += (extra * pieces[i].text.length) / spaceChars;
        }
        contentWidth = maxWidth;
      }
    }

    let x = 0;
    for (const p of pieces) {
      p.x = x;
      x += p.width;
    }

    let asc = 0;
    let desc = 0;
    const consider = (st: TextCharStyle) => {
      const m = getMetrics(st);
      const shift = scriptShiftY(st);
      asc = Math.max(asc, m.ascent - Math.min(0, shift));
      desc = Math.max(desc, m.descent + Math.max(0, shift));
    };
    if (pieces.length === 0) {
      consider(fallbackIdx >= 0 && fallbackIdx < n ? styles[fallbackIdx] : opts.fallbackStyle);
    } else {
      for (const p of pieces) consider(p.style);
    }

    const natural = asc + desc;
    const height = Math.max(1, Math.round((natural * opts.lineSpacing) / 100));
    const top = lines.length ? lines[lines.length - 1].top + lines[lines.length - 1].height : 0;

    let offsetX = 0;
    if (opts.align === 'center') offsetX = (maxWidth - contentWidth) / 2;
    else if (opts.align === 'right') offsetX = maxWidth - contentWidth;

    lines.push({
      start,
      end,
      pieces,
      top,
      height,
      baseline: Math.round(top + asc),
      contentWidth,
      offsetX: Math.round(offsetX),
      endsParagraph,
    });
  };

  let paraStart = 0;
  for (;;) {
    let paraEnd = text.indexOf('\n', paraStart);
    const hasNL = paraEnd !== -1;
    if (!hasNL) paraEnd = n;

    // Atomy: słowa i spacje
    const rawPieces = buildPieces(paraStart, paraEnd);
    const atoms: Atom[] = [];
    let k = 0;
    while (k < rawPieces.length) {
      const p = rawPieces[k];
      if (p.isSpace) {
        atoms.push({ pieces: [p], isSpace: true, width: p.width });
        k++;
      } else {
        let j = k;
        let w = 0;
        while (j < rawPieces.length && !rawPieces[j].isSpace) {
          w += rawPieces[j].width;
          j++;
        }
        const wordStart = rawPieces[k].start;
        const wordEnd = rawPieces[j - 1].end;
        if (w <= maxWidth) {
          atoms.push({ pieces: rawPieces.slice(k, j), isSpace: false, width: w });
        } else {
          // Zbyt długie słowo: dzielimy na kawałki mieszczące się w linii
          let cs = wordStart;
          let cw = 0;
          for (let i = wordStart; i < wordEnd; i++) {
            const adv = charAdvance(i);
            if (cw + adv > maxWidth && i > cs) {
              const ps = buildPieces(cs, i);
              atoms.push({ pieces: ps, isSpace: false, width: ps.reduce((a, b) => a + b.width, 0) });
              cs = i;
              cw = 0;
            }
            cw += adv;
          }
          const ps = buildPieces(cs, wordEnd);
          atoms.push({ pieces: ps, isSpace: false, width: ps.reduce((a, b) => a + b.width, 0) });
        }
        k = j;
      }
    }

    // Zachłanne łamanie
    let cur: LayoutPiece[] = [];
    let curStart = paraStart;
    let contentW = 0;
    let trailW = 0;
    let hasWord = false;
    const flush = (endsPara: boolean) => {
      const end = cur.length ? cur[cur.length - 1].end : curStart;
      finishLine(cur, curStart, end, endsPara, hasNL ? paraEnd : -1);
      curStart = end;
      cur = [];
      contentW = 0;
      trailW = 0;
      hasWord = false;
    };

    for (const atom of atoms) {
      if (atom.isSpace) {
        if (!hasWord) {
          cur.push(...atom.pieces);
          contentW += atom.width;
        } else {
          cur.push(...atom.pieces);
          trailW += atom.width;
        }
      } else {
        const fits = contentW + trailW + atom.width <= maxWidth + 0.01;
        if (!fits && cur.length > 0 && hasWord) {
          flush(false);
        } else if (!fits && cur.length > 0 && !hasWord && contentW + atom.width > maxWidth + 0.01) {
          // same wiodące spacje, a słowo się nie mieści
          flush(false);
        }
        cur.push(...atom.pieces);
        contentW += trailW + atom.width;
        trailW = 0;
        hasWord = true;
      }
    }
    flush(true);

    if (!hasNL) break;
    paraStart = paraEnd + 1;
    curStart = paraStart;
  }

  const last = lines[lines.length - 1];
  return {
    lines,
    height: last ? last.top + last.height : 0,
    length: n,
    letterSpacing: ls,
  };
}

/* ------------------------------------------------------------------ */
/*  POZYCJE KURSORA, ZAZNACZENIE, HIT-TESTING                          */
/* ------------------------------------------------------------------ */

function pieceOffset(p: LayoutPiece, k: number, ls: number): number {
  if (k <= 0) return 0;
  if (k >= p.text.length) return p.width;
  if (p.isSpace) return (p.width * k) / p.text.length;
  return measureString(p.text.slice(0, k), p.style, ls);
}

/** Indeks kursora na końcu wiersza (dla zawiniętych wierszy – przed końcowymi spacjami). */
export function lineEndCaretIndex(line: LayoutLine): number {
  if (line.endsParagraph) return line.end;
  for (let i = line.pieces.length - 1; i >= 0; i--) {
    if (!line.pieces[i].isSpace) return line.pieces[i].end;
  }
  return line.end;
}

export function findLineForIndex(layout: TextLayout, index: number): number {
  const lines = layout.lines;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (index >= l.start && index < l.end) return i;
    if (index === l.end && l.endsParagraph) return i;
  }
  return Math.max(0, lines.length - 1);
}

export function indexToX(layout: TextLayout, lineIdx: number, index: number): number {
  const line = layout.lines[lineIdx];
  if (!line) return 0;
  for (const p of line.pieces) {
    if (index >= p.start && index <= p.end) {
      if (index === p.end && p !== line.pieces[line.pieces.length - 1]) continue;
      return line.offsetX + p.x + pieceOffset(p, index - p.start, layout.letterSpacing);
    }
  }
  return line.offsetX + (line.pieces.length ? line.pieces[line.pieces.length - 1].x + line.pieces[line.pieces.length - 1].width : 0);
}

export interface CaretInfo {
  x: number;
  top: number;
  height: number;
  line: number;
}

export function getCaretInfo(layout: TextLayout, index: number): CaretInfo {
  const li = findLineForIndex(layout, index);
  const line = layout.lines[li];
  if (!line) return { x: 0, top: 0, height: 16, line: 0 };
  return { x: indexToX(layout, li, index), top: line.top, height: line.height, line: li };
}

export function hitTestIndex(layout: TextLayout, x: number, y: number): number {
  const lines = layout.lines;
  if (!lines.length) return 0;
  let li = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    if (y < lines[i].top + lines[i].height) {
      li = i;
      break;
    }
  }
  if (y < 0) li = 0;
  const line = lines[li];
  const lx = x - line.offsetX;
  if (line.pieces.length === 0 || lx <= 0) return line.start;
  for (const p of line.pieces) {
    if (lx < p.x + p.width) {
      const len = p.text.length;
      let best = p.start;
      let bestDist = Infinity;
      for (let k = 0; k <= len; k++) {
        const px = p.x + pieceOffset(p, k, layout.letterSpacing);
        const d = Math.abs(lx - px);
        if (d < bestDist) {
          bestDist = d;
          best = p.start + k;
        }
      }
      if (best === line.end && !line.endsParagraph) best = lineEndCaretIndex(line);
      return best;
    }
  }
  // Za końcem linii
  return lineEndCaretIndex(line);
}

export interface SelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function getSelectionRects(layout: TextLayout, a: number, b: number): SelRect[] {
  const out: SelRect[] = [];
  if (b <= a) return out;
  for (let li = 0; li < layout.lines.length; li++) {
    const line = layout.lines[li];
    const s = Math.max(a, line.start);
    const e = Math.min(b, line.end);
    const coversNewline = line.endsParagraph && b > line.end && a <= line.end;
    if (e <= s && !coversNewline) continue;
    const x1 = indexToX(layout, li, Math.max(s, line.start));
    let x2 = indexToX(layout, li, Math.max(e, s));
    if (coversNewline) x2 += 5;
    if (x2 - x1 <= 0) continue;
    out.push({ x: x1, y: line.top, w: x2 - x1, h: line.height });
  }
  return out;
}

/** Granice słowa wokół `index` (do zaznaczania dwuklikiem). */
export function wordBoundsAt(text: string, index: number): [number, number] {
  const n = text.length;
  index = Math.max(0, Math.min(n, index));
  const isWord = (c: string) => /[\p{L}\p{N}_]/u.test(c);
  let i = index;
  if (i >= n || !isWord(text[i])) {
    if (i > 0 && isWord(text[i - 1])) i--;
    else return [index, Math.min(n, index + (index < n && text[index] !== '\n' ? 1 : 0))];
  }
  let s = i;
  let e = i;
  while (s > 0 && isWord(text[s - 1])) s--;
  while (e < n && isWord(text[e])) e++;
  return [s, e];
}

export function prevWordIndex(text: string, index: number): number {
  let i = index;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

export function nextWordIndex(text: string, index: number): number {
  const n = text.length;
  let i = index;
  while (i < n && !/\s/.test(text[i])) i++;
  while (i < n && /\s/.test(text[i])) i++;
  return i;
}

/* ------------------------------------------------------------------ */
/*  GEOMETRIA RAMKI I RENDEROWANIE DO PIKSELI PŁÓTNA                   */
/* ------------------------------------------------------------------ */

/** Wewnętrzny margines tekstu wewnątrz obszaru edycji (margines jest zawsze 0). */
export function getTextInset(settings: TextToolSettings): number {
  const sw = Math.max(0, settings.strokeWidth);
  return sw > 0 ? Math.ceil(sw) : 0;
}

export function getTextInnerWidth(width: number, settings: TextToolSettings): number {
  return Math.max(1, width - 2 * getTextInset(settings));
}

export function getTextLayoutOptions(settings: TextToolSettings, fallbackStyle: TextCharStyle): LayoutOptions {
  return {
    align: settings.align,
    lineSpacing: Math.max(10, settings.lineSpacing),
    letterSpacing: settings.letterSpacing,
    fallbackStyle,
  };
}

/** Określa kolory wypełnienia i obramowania samych liter (ramka jest zawsze kolorem głównym). */
export function getTextColors(settings: TextToolSettings): {
  fillColor: SKColor | null;
  strokeColor: SKColor | null;
  hasFill: boolean;
  hasStroke: boolean;
} {
  const sw = Math.max(0, settings.strokeWidth);
  const sCol = settings.strokeColor; // Ramka jest ZAWSZE kolorem głównym

  if (settings.fillMode === 'none') {
    // tylko obrys liter kolorem głównym
    return {
      fillColor: null,
      strokeColor: sCol,
      hasFill: false,
      hasStroke: true,
    };
  }
  if (settings.fillMode === 'primary') {
    // wypełnienie liter kolorem głównym, ramka kolorem głównym
    return {
      fillColor: settings.strokeColor,
      strokeColor: sw > 0 ? sCol : null,
      hasFill: true,
      hasStroke: sw > 0,
    };
  }
  // 'stroke-and-fill': wypełnienie liter kolorem dodatkowym, ramka kolorem głównym
  return {
    fillColor: settings.fillColor,
    strokeColor: sw > 0 ? sCol : null,
    hasFill: true,
    hasStroke: sw > 0,
  };
}

/**
 * Rysuje maskę tekstu (tylko w kolorze białym #ffffff) dla wypełnienia, obrysu lub całości.
 */
function drawTextMask(
  ctx: CanvasRenderingContext2D,
  layout: TextLayout,
  mode: 'fill' | 'stroke' | 'both',
  strokeWidth: number
): void {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const ls = layout.letterSpacing;

  if (mode === 'stroke' || mode === 'both') {
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.miterLimit = 3;
    for (const line of layout.lines) {
      for (const p of line.pieces) {
        if (p.isSpace) continue;
        const shift = scriptShiftY(p.style);
        const x0 = line.offsetX + p.x;
        const y = line.baseline + shift;
        ctx.font = buildFontString(p.style);
        if (ls === 0) {
          ctx.strokeText(p.text, x0, y);
        } else {
          let x = x0;
          for (const ch of p.text) {
            ctx.strokeText(ch, x, y);
            x += ctx.measureText(ch).width + ls;
          }
        }
      }
    }
  }

  if (mode === 'fill' || mode === 'both') {
    for (const line of layout.lines) {
      for (const p of line.pieces) {
        if (p.isSpace) continue;
        const shift = scriptShiftY(p.style);
        const x0 = line.offsetX + p.x;
        const y = line.baseline + shift;
        ctx.font = buildFontString(p.style);
        if (ls === 0) {
          ctx.fillText(p.text, x0, y);
        } else {
          let x = x0;
          for (const ch of p.text) {
            ctx.fillText(ch, x, y);
            x += ctx.measureText(ch).width + ls;
          }
        }
      }
    }
  }

  // Podkreślenie liter (underline)
  for (const line of layout.lines) {
    for (const p of line.pieces) {
      if (p.style.underline && p.width > 0) {
        const shift = scriptShiftY(p.style);
        const x0 = line.offsetX + p.x;
        const y = line.baseline + shift;
        const size = effectiveFontSize(p.style);
        const thick = Math.max(1, Math.round(size / 14));
        const uy = Math.round(y + Math.max(1, size * 0.12));
        if (mode === 'stroke' || mode === 'both') {
          if (strokeWidth > 0) {
            ctx.strokeRect(Math.round(x0), uy, Math.max(1, Math.round(p.width)), thick);
          }
        }
        if (mode === 'fill' || mode === 'both') {
          ctx.fillRect(Math.round(x0), uy, Math.max(1, Math.round(p.width)), thick);
        }
      }
    }
  }

  ctx.restore();
}

/**
 * Renderuje litery z precyzyjnym podziałem pokrycia subpikselowego (coverage partitioning),
 * na wzór narzędzia "kształty" (renderVectorShape).
 * Gwarantuje idealne spasowanie obrysu i wypełnienia bez szczelin, bez nakładania się
 * przezroczystości (brak brudnych podwójnych cieni) oraz pełne wsparcie kanału alfa
 * przy włączonym i wyłączonym wygładzaniu.
 */
function renderTextRaster(
  targetCtx: CanvasRenderingContext2D,
  layout: TextLayout,
  settings: TextToolSettings,
  pad: number,
  bufW: number,
  bufH: number
): void {
  const sw = Math.max(0, settings.strokeWidth);
  const hasFill = settings.fillMode !== 'none';
  const hasStroke = settings.fillMode === 'none' ? true : sw > 0;
  const strokeW = settings.fillMode === 'none' ? Math.max(1, sw) : sw * 2;

  // Kolory wypełnienia i obrysu:
  // - Ramka (obrys) jest ZAWSZE kolorem głównym (strokeColor)
  // - Wypełnienie: 'primary' = kolor główny (strokeColor), 'stroke-and-fill' = kolor dodatkowy (fillColor)
  const sCol = settings.strokeColor;
  const fCol = settings.fillMode === 'stroke-and-fill' ? settings.fillColor : settings.strokeColor;

  // 1. Maska całości (tCanvas: litery + ewentualny obrys)
  const tCanvas = document.createElement('canvas');
  tCanvas.width = bufW;
  tCanvas.height = bufH;
  const tCtx = tCanvas.getContext('2d')!;
  tCtx.imageSmoothingEnabled = true;
  tCtx.translate(pad, pad);
  drawTextMask(tCtx, layout, hasStroke && hasFill ? 'both' : hasStroke ? 'stroke' : 'fill', strokeW);

  // 2. Maska wypełnienia (fCanvas: tylko wnętrze liter)
  let fCanvas: HTMLCanvasElement | null = null;
  if (hasFill && hasStroke) {
    fCanvas = document.createElement('canvas');
    fCanvas.width = bufW;
    fCanvas.height = bufH;
    const fCtx = fCanvas.getContext('2d')!;
    fCtx.imageSmoothingEnabled = true;
    fCtx.translate(pad, pad);
    drawTextMask(fCtx, layout, 'fill', 0);
  }

  const tData = tCtx.getImageData(0, 0, bufW, bufH).data;
  const fData = fCanvas ? fCanvas.getContext('2d')!.getImageData(0, 0, bufW, bufH).data : null;

  const outImg = targetCtx.createImageData(bufW, bufH);
  const outData = outImg.data;

  const rS = sCol.r, gS = sCol.g, bS = sCol.b, aS = sCol.a;
  const rF = fCol.r, gF = fCol.g, bF = fCol.b, aF = fCol.a;
  const aNormS = aS / 255;
  const aNormF = aF / 255;

  if (settings.antiAliasing) {
    // --- WYGŁADZANIE WŁĄCZONE (płynne krawędzie, precyzyjne coverage partitioning bez nakładania przezroczystości) ---
    for (let i = 0; i < outData.length; i += 4) {
      const tVal = tData[i + 3];
      if (tVal === 0) continue;

      const covT = tVal / 255;
      let covF = 0;
      let covS = 0;

      if (!hasFill) {
        covS = covT;
      } else if (!hasStroke) {
        covF = covT;
      } else {
        const fVal = fData ? fData[i + 3] : 0;
        covF = Math.min(covT, fVal / 255);
        covS = Math.max(0, covT - covF);
      }

      const aPartF = covF * aNormF;
      const aPartS = covS * aNormS;
      const aTotal = aPartF + aPartS;

      if (aTotal > 0.0001) {
        const rPremul = aPartF * rF + aPartS * rS;
        const gPremul = aPartF * gF + aPartS * gS;
        const bPremul = aPartF * bF + aPartS * bS;

        outData[i] = Math.round(rPremul / aTotal);
        outData[i + 1] = Math.round(gPremul / aTotal);
        outData[i + 2] = Math.round(bPremul / aTotal);
        outData[i + 3] = Math.round(aTotal * 255);
      }
    }
  } else {
    // --- WYGŁADZANIE WYŁĄCZONE (1-bit crisp krawędzie z pełnym zachowaniem przezroczystości alfa użytkownika) ---
    const strokeCutoff = sw <= 1 ? 55 : sw <= 2 ? 80 : 128;
    const fillCutoff = 128;

    for (let i = 0; i < outData.length; i += 4) {
      const tVal = tData[i + 3];
      if (tVal === 0) continue;

      if (!hasFill) {
        // Tylko obrys
        if (tVal >= strokeCutoff) {
          outData[i] = rS;
          outData[i + 1] = gS;
          outData[i + 2] = bS;
          outData[i + 3] = aS;
        }
        continue;
      }

      if (!hasStroke) {
        // Tylko wypełnienie
        if (tVal >= fillCutoff) {
          outData[i] = rF;
          outData[i + 1] = gF;
          outData[i + 2] = bF;
          outData[i + 3] = aF;
        }
        continue;
      }

      // Obrys i wypełnienie razem
      const fVal = fData ? fData[i + 3] : 0;
      if (fVal >= fillCutoff) {
        outData[i] = rF;
        outData[i + 1] = gF;
        outData[i + 2] = bF;
        outData[i + 3] = aF;
      } else if (tVal >= strokeCutoff) {
        outData[i] = rS;
        outData[i + 1] = gS;
        outData[i + 2] = bS;
        outData[i + 3] = aS;
      }
    }
  }

  targetCtx.putImageData(outImg, 0, 0);
}

export interface RenderTextResult {
  /** Efektywna wysokość obszaru zajętego przez tekst (px, przed obrotem). */
  extentHeight: number;
  extentWidth: number;
}

/**
 * Renderuje litery (wypełnienie i/lub obrys samych liter) do `ctx` w pikselach płótna dokumentu.
 * Tekst nie posiada żadnego tła ani obramowania ramki.
 */
export function renderVectorText(
  ctx: CanvasRenderingContext2D,
  center: SKPoint,
  width: number,
  height: number,
  angle: number,
  rt: RichText,
  settings: TextToolSettings,
  layout?: TextLayout,
  fallbackStyle?: TextCharStyle
): RenderTextResult {
  const inset = getTextInset(settings);
  const innerW = getTextInnerWidth(width, settings);
  const fb = fallbackStyle ?? pickCharStyle(settings);
  const lay = layout ?? layoutText(rt, innerW, getTextLayoutOptions(settings, fb));
  const extentH = Math.max(height, lay.height + 2 * inset);

  if (rt.length === 0) return { extentHeight: extentH, extentWidth: width };

  // Margines bezpieczeństwa w buforze pikseli dla grubych obrysów liter
  const sw = Math.max(0, settings.strokeWidth);
  const pad = Math.ceil(sw * 2) + 8;
  const bufW = Math.max(1, Math.ceil(innerW + 2 * pad));
  const bufH = Math.max(1, Math.ceil(lay.height + 2 * pad));
  const textCanvas = document.createElement('canvas');
  textCanvas.width = bufW;
  textCanvas.height = bufH;
  const tctx = textCanvas.getContext('2d')!;

  renderTextRaster(tctx, lay, settings, pad, bufW, bufH);

  // Umieszczenie i ewentualny obrót w dokumencie
  const diag = Math.ceil(Math.hypot(Math.max(width, bufW + 2 * inset), Math.max(extentH, height))) + 8;
  const originX = Math.floor(center.x - diag / 2);
  const originY = Math.floor(center.y - diag / 2);
  const cx = center.x - originX;
  const cy = center.y - originY;

  const iso = document.createElement('canvas');
  iso.width = diag;
  iso.height = diag;
  const ictx = iso.getContext('2d')!;
  ictx.imageSmoothingEnabled = settings.antiAliasing;
  ictx.imageSmoothingQuality = 'high';

  const isAxisAligned = Math.abs(angle) < 0.001;
  ictx.translate(isAxisAligned ? Math.round(cx) : cx, isAxisAligned ? Math.round(cy) : cy);
  ictx.rotate(angle);

  let tx = -width / 2 + inset - pad;
  let ty = -height / 2 + inset - pad;
  if (isAxisAligned) {
    tx = Math.round(tx);
    ty = Math.round(ty);
  }
  ictx.drawImage(textCanvas, tx, ty);

  ctx.save();
  ctx.globalCompositeOperation = getCanvasCompositeOperation(settings.blendMode);
  ctx.imageSmoothingEnabled = settings.antiAliasing;
  ctx.drawImage(iso, originX, originY);
  ctx.restore();

  return { extentHeight: extentH, extentWidth: Math.max(width, bufW + 2 * inset) };
}
