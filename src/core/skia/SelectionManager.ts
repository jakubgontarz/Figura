/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import polygonClipping, { MultiPolygon, Polygon, Pair } from 'polygon-clipping';
import { SKPoint, SKRectI, SelectionCombineMode, SelectionSettings } from './types.ts';
import {
  WAND_PAD,
  WandCrop,
  cropOfFlood,
  pixelGeomOfCrop,
  floodSelect,
  ringToPathString,
  ringsToPathString,
  traceCells,
} from './WandCore.ts';

export interface TransformSelectionState {
  initialMaskCanvas: HTMLCanvasElement;
  initialBounds: SKRectI;
  initialCenter: SKPoint;

  // Bieżący stan ramki
  pos: SKPoint;        // Bieżący środek ramki w przestrzeni dokumentu
  width: number;       // Bieżąca szerokość ramki
  height: number;      // Bieżąca wysokość ramki
  angle: number;       // Bieżący kąt obrotu w radianach
  pivot: SKPoint;      // Niezależny punkt środka ciężkości (pivot) do obrotu
  flipX?: boolean;     // Odbicie w poziomie (Lustrzane w poziomie)
  flipY?: boolean;     // Odbicie w pionie (Lustrzane w pionie)
}

/**
 * Geometria wektorowa zaznaczenia w postaci płaskich tablic: wielokąty -> pierścienie -> współrzędne x,y na przemian.
 * Tablice nigdy nie są modyfikowane po utworzeniu (można je współdzielić między historią, transformacją i konturem),
 * dzięki czemu nie trzeba ich kopiować, a miliony punktów nie są małymi obiektami.
 */
export type FlatGeom = Float64Array[][];

export interface SelectionSnapshot {
  /** Piksele maski; przy snapshotach z samej rastrowej maski przycięte do prostokąta (x, y). */
  imgData: ImageData | null;
  /** Lewy górny róg przyciętego imgData w dokumencie (domyślnie 0,0 = pełny rozmiar). */
  x?: number;
  y?: number;
  seedPoint: SKPoint | null;
  activeMultiPoly?: MultiPolygon;
  /** Geometria wektorowa w postaci płaskiej (bez kopiowania; tablice są niezmienne). */
  activeFlat?: FlatGeom;
}

/** Przycina ImageData do prostokąta, w którym alfa > 0 (pusta maska => 1x1 przezroczysty piksel). */
function cropImageDataToAlpha(img: ImageData): { imgData: ImageData; x: number; y: number } {
  const w = img.width;
  const h = img.height;
  const u32 = new Uint32Array(img.data.buffer, img.data.byteOffset, w * h);
  // Bajt alfa to najstarszy bajt słowa w układzie little-endian (RGBA)
  const alphaMask = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 0xff000000 : 0x000000ff;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if ((u32[row + x] & alphaMask) !== 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return { imgData: new ImageData(1, 1), x: 0, y: 0 };
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const out = new ImageData(cw, ch);
  const o32 = new Uint32Array(out.data.buffer);
  for (let y = 0; y < ch; y++) {
    o32.set(u32.subarray((minY + y) * w + minX, (minY + y) * w + minX + cw), y * cw);
  }
  return { imgData: out, x: minX, y: minY };
}

/**
 * Zaawansowany menedżer zaznaczeń z Wektorowym Silnikiem Geometrii i Sub-Pixel Marching Squares:
 * 1. Prawdziwa wektorowa ścieżka mrówek zbudowana z figur wektorowych (Prostokąty, Elipsy, Lasso).
 * 2. Przecinanie i łączenie figur wektorowych daje czystą ścieżkę z długimi prostokątnymi odcinkami i gładkimi łukami elips.
 * 3. Narzędzie modyfikacji zaznaczenia (ramka, 8 niezależnych uchwytów ze stałym punktem przeciwległym, obrót).
 */

function pairsToFlat(mp: MultiPolygon): FlatGeom {
  return mp.map((poly) =>
    poly.map((ring) => {
      const out = new Float64Array(ring.length * 2);
      for (let i = 0; i < ring.length; i++) {
        out[2 * i] = ring[i][0];
        out[2 * i + 1] = ring[i][1];
      }
      return out;
    })
  );
}

function flatToPairs(g: FlatGeom): MultiPolygon {
  return g.map((poly) =>
    poly.map((ring) => {
      const n = ring.length >> 1;
      const out: Pair[] = new Array(n);
      for (let i = 0; i < n; i++) out[i] = [ring[2 * i], ring[2 * i + 1]];
      return out;
    })
  );
}

/** Pierścienie (>= 3 punkty) ze wszystkich wielokątów w kolejności wielokąt -> pierścień. */
function flatRingsOf(g: FlatGeom): Float64Array[] {
  const rings: Float64Array[] = [];
  for (const poly of g) for (const ring of poly) if (ring.length >= 6) rings.push(ring);
  return rings;
}

/** Prostokąt opisany na pierścieniach (null gdy brak punktów). */
function ringsBounds(rings: Float64Array[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i];
      const y = ring[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 >= x0 && y1 >= y0 ? { x0, y0, x1, y1 } : null;
}

export class SelectionManager {
  public width: number;
  public height: number;

  private _maskCanvas: HTMLCanvasElement;
  private _maskCtx: CanvasRenderingContext2D;
  /**
   * Odroczone rastrowanie maski z geometrii wektorowej. Podczas przeciągania uchwytu lub suwaka liczy się tylko
   * kontur (mrówki); maska rastrowa jest dopisywana dopiero, gdy ktoś jej użyje (maskCanvas / maskCtx).
   */
  private maskPending: boolean = false;
  private maskPath: Path2D | null = null;
  public hasActiveSelection: boolean = false;

  /** Maska zaznaczenia (piksele). Odczyt dopisuje odroczone rastrowanie. */
  public get maskCanvas(): HTMLCanvasElement {
    if (this.maskPending) this.flushMask();
    return this._maskCanvas;
  }
  public get maskCtx(): CanvasRenderingContext2D {
    if (this.maskPending) this.flushMask();
    return this._maskCtx;
  }

  public wandBaseMaskCanvas: HTMLCanvasElement;
  public wandBaseMaskCtx: CanvasRenderingContext2D;

  // Główna struktura wektorowa zaznaczenia: albo pary (dla polygon-clipping), albo płaskie tablice - jedna z postaci
  // jest budowana na żądanie z drugiej.
  private ampPairs: MultiPolygon | null = [];
  private ampFlat: FlatGeom | null = null;
  /** Odroczone przekształcenie ampFlat = transformacja initialFlat (patrz updateTransformSelection). */
  private lazyXform: { initial: FlatGeom; cx: number; cy: number; sx: number; sy: number; cos: number; sin: number; px: number; py: number } | null = null;
  private initialFlat: FlatGeom | null = null;
  private initialPath: Path2D | null = null;

  public get activeMultiPoly(): MultiPolygon {
    if (!this.ampPairs) this.ampPairs = flatToPairs(this.getFlat());
    return this.ampPairs;
  }
  public set activeMultiPoly(v: MultiPolygon) {
    this.ampPairs = v;
    this.ampFlat = null;
    this.lazyXform = null;
  }

  /** Geometria w postaci płaskiej (materializuje odroczoną transformację). */
  private getFlat(): FlatGeom {
    if (this.lazyXform) {
      this.ampFlat = this.applyXform(this.lazyXform);
      this.lazyXform = null;
    } else if (!this.ampFlat) {
      this.ampFlat = pairsToFlat(this.ampPairs || []);
    }
    return this.ampFlat;
  }

  private setFlat(g: FlatGeom): void {
    this.ampFlat = g;
    this.ampPairs = null;
    this.lazyXform = null;
  }

  private geomPolyCount(): number {
    if (this.lazyXform) return this.lazyXform.initial.length;
    if (this.ampFlat) return this.ampFlat.length;
    return this.ampPairs ? this.ampPairs.length : 0;
  }

  // Jednolita ścieżka wektorowa i pierścienie dla maszerujących mrówek
  public contourPath: Path2D = new Path2D();
  private ringsStore: Float64Array[] = [];
  private ringsLazy: boolean = false; // pierścienie konturu = przekształcona geometria (jeszcze nie policzona)
  private polysCache: SKPoint[][] | null = null;
  private boundsCache: { x0: number; y0: number; x1: number; y1: number } | null | undefined = undefined;

  /** Pierścienie konturu (płaskie tablice x,y). Przy odroczonej transformacji są liczone na żądanie. */
  public get contourRings(): Float64Array[] {
    if (this.ringsLazy) {
      this.ringsStore = flatRingsOf(this.getFlat());
      this.ringsLazy = false;
    }
    return this.ringsStore;
  }

  /** Kontur jako tablice punktów (zgodność wsteczna; kosztowne dla dużych zaznaczeń - lepiej używać contourRings). */
  public get contourPolygons(): SKPoint[][] {
    if (!this.polysCache) {
      this.polysCache = this.contourRings.map((ring) => {
        const n = ring.length >> 1;
        const loop: SKPoint[] = new Array(n);
        for (let i = 0; i < n; i++) loop[i] = { x: ring[2 * i], y: ring[2 * i + 1] };
        return loop;
      });
    }
    return this.polysCache;
  }

  private setContour(rings: Float64Array[], path: Path2D): void {
    this.ringsStore = rings;
    this.ringsLazy = false;
    this.contourPath = path;
    this.polysCache = null;
    this.boundsCache = undefined;
    this.visPath = null;
  }

  /** Prostokąt opisany na konturze (null = brak). Przy odroczonej transformacji - zachowawczy (obrócone rogi). */
  public getContourBounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.boundsCache !== undefined) return this.boundsCache;
    let b: { x0: number; y0: number; x1: number; y1: number } | null;
    const lx = this.lazyXform;
    if (this.ringsLazy && lx) {
      const ib = this.initialBoundsCache ?? (this.initialBoundsCache = ringsBounds(flatRingsOf(lx.initial)));
      if (!ib) b = null;
      else {
        let x0 = Infinity,
          y0 = Infinity,
          x1 = -Infinity,
          y1 = -Infinity;
        for (const [ix, iy] of [
          [ib.x0, ib.y0],
          [ib.x1, ib.y0],
          [ib.x1, ib.y1],
          [ib.x0, ib.y1],
        ]) {
          const ddx = ix - lx.cx;
          const ddy = iy - lx.cy;
          const rx = ddx * lx.sx * lx.cos - ddy * lx.sy * lx.sin;
          const ry = ddx * lx.sx * lx.sin + ddy * lx.sy * lx.cos;
          const X = lx.px + rx;
          const Y = lx.py + ry;
          if (X < x0) x0 = X;
          if (X > x1) x1 = X;
          if (Y < y0) y0 = Y;
          if (Y > y1) y1 = Y;
        }
        b = { x0, y0, x1, y1 };
      }
      // Wynik zachowawczy: nie zapamiętujemy go jako dokładnego
      return b;
    }
    b = ringsBounds(this.contourRings);
    this.boundsCache = b;
    return b;
  }
  private initialBoundsCache: { x0: number; y0: number; x1: number; y1: number } | null | undefined = undefined;

  // Stan interaktywnego przekształcania zaznaczenia
  public transformState: TransformSelectionState | null = null;

  public wandSeedPoint: SKPoint | null = null;
  public lastWandSettings: SelectionSettings | null = null;

  constructor(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    this._maskCanvas = document.createElement('canvas');
    this._maskCanvas.width = this.width;
    this._maskCanvas.height = this.height;
    const mctx = this._maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!mctx) throw new Error('Nie można utworzyć kontekstu maski zaznaczenia');
    this._maskCtx = mctx;

    this.wandBaseMaskCanvas = document.createElement('canvas');
    this.wandBaseMaskCanvas.width = this.width;
    this.wandBaseMaskCanvas.height = this.height;
    this.wandBaseMaskCtx = this.wandBaseMaskCanvas.getContext('2d', { willReadFrequently: true })!;
  }

  public resize(width: number, height: number): void {
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this._maskCanvas.width = width;
      this._maskCanvas.height = height;
      this.wandBaseMaskCanvas.width = width;
      this.wandBaseMaskCanvas.height = height;
      this.clear();
    }
  }

  public clear(): void {
    this.maskPending = false;
    this._maskCtx.clearRect(0, 0, this.width, this.height);
    this.wandBaseMaskCtx.clearRect(0, 0, this.width, this.height);
    this.hasActiveSelection = false;
    this.wandSeedPoint = null;
    this.wandLast = null;
    this.activeMultiPoly = [];
    this.initialFlat = null;
    this.initialPath = null;
    this.initialBoundsCache = undefined;
    this.setContour([], new Path2D());
    this.transformState = null;
  }

  /** Rastruje odroczoną maskę: wypełnia (even-odd) pierścienie konturu. */
  private flushMask(): void {
    if (!this.maskPending) return;
    this.maskPending = false;
    const c = this._maskCtx;
    c.clearRect(0, 0, this.width, this.height);
    c.fillStyle = '#ffffff';
    if (this.maskPath) c.fill(this.maskPath, 'evenodd');
  }

  public getSelectionBounds(): SKRectI | null {
    if (!this.hasActiveSelection) return null;
    const w = this.width;
    const h = this.height;
    // Maska czytana pasami: puste pasy od góry i od dołu nie wymagają dalszej pracy, a skan idzie po słowach 32-bitowych
    const BAND = 256;
    const alphaMask = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1 ? 0xff000000 : 0x000000ff;
    const readBand = (y0: number, y1: number): Uint32Array => {
      const d = this.maskCtx.getImageData(0, y0, w, y1 - y0).data;
      return new Uint32Array(d.buffer, d.byteOffset, w * (y1 - y0));
    };
    const rowHas = (u32: Uint32Array, r: number): boolean => {
      const base = r * w;
      for (let x = 0; x < w; x++) if ((u32[base + x] & alphaMask) !== 0) return true;
      return false;
    };

    let minY = -1;
    for (let y0 = 0; y0 < h && minY < 0; y0 += BAND) {
      const y1 = Math.min(h, y0 + BAND);
      const u = readBand(y0, y1);
      for (let r = 0; r < y1 - y0; r++) {
        if (rowHas(u, r)) {
          minY = y0 + r;
          break;
        }
      }
    }
    if (minY < 0) return null;

    let maxY = minY;
    for (let y1 = h; y1 > minY; y1 -= BAND) {
      const y0 = Math.max(minY, y1 - BAND);
      const u = readBand(y0, y1);
      let found = false;
      for (let r = y1 - y0 - 1; r >= 0; r--) {
        if (rowHas(u, r)) {
          maxY = y0 + r;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    let minX = w;
    let maxX = -1;
    for (let y0 = minY; y0 <= maxY; y0 += BAND) {
      const y1 = Math.min(maxY + 1, y0 + BAND);
      const u = readBand(y0, y1);
      for (let r = 0; r < y1 - y0; r++) {
        const base = r * w;
        // Od lewej tylko do bieżącego minX, od prawej tylko do bieżącego maxX
        for (let x = 0; x < minX; x++) {
          if ((u[base + x] & alphaMask) !== 0) {
            minX = x;
            break;
          }
        }
        for (let x = w - 1; x > maxX; x--) {
          if ((u[base + x] & alphaMask) !== 0) {
            maxX = x;
            break;
          }
        }
      }
    }

    if (maxX < minX) return null;
    return {
      left: minX,
      top: minY,
      right: maxX + 1,
      bottom: maxY + 1,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }

  /** Czy zaznaczenie ma opis wektorowy (geometrię), a więc ostry brzeg w dowolnej skali. */
  public get hasVectorGeometry(): boolean {
    return this.geomPolyCount() > 0;
  }

  /** Kontur przekształcanego zaznaczenia jako ścieżka (wypełnienie 'evenodd', jak maska); null dla zaznaczeń czysto rastrowych. */
  public get vectorSelectionPath(): Path2D | null {
    return this.transformState && this.initialFlat && this.initialFlat.length > 0 ? this.contourPath : null;
  }

  public beginTransformSelection(): TransformSelectionState | null {
    const bounds = this.getSelectionBounds();
    if (!bounds) return null;

    const initCanvas = document.createElement('canvas');
    if (this.geomPolyCount() > 0) {
      // Zaznaczenie wektorowe: anulowanie i tak odtwarza maskę z geometrii, więc nie kopiujemy pełnej maski
      // (kilka przebiegów po milionach pikseli przy każdym złapaniu uchwytu).
      initCanvas.width = 1;
      initCanvas.height = 1;
    } else {
      initCanvas.width = this.width;
      initCanvas.height = this.height;
      const ictx = initCanvas.getContext('2d')!;
      ictx.drawImage(this.maskCanvas, 0, 0);

      // Oczyszczanie maski do postaci binarnej
      const mImgData = ictx.getImageData(0, 0, this.width, this.height);
      const mData = mImgData.data;
      for (let i = 3; i < mData.length; i += 4) {
        mData[i] = mData[i] > 0 ? 255 : 0;
      }
      ictx.putImageData(mImgData, 0, 0);
    }

    const cx = bounds.left + bounds.width / 2;
    const cy = bounds.top + bounds.height / 2;

    // Geometria jest niezmienna, więc wystarczy zapamiętać odwołanie (bez kopiowania milionów punktów)
    this.initialFlat = this.geomPolyCount() > 0 ? this.getFlat() : null;
    this.initialPath = this.contourPath;
    this.initialBoundsCache = undefined;

    this.transformState = {
      initialMaskCanvas: initCanvas,
      initialBounds: bounds,
      initialCenter: { x: cx, y: cy },
      pos: { x: cx, y: cy },
      width: bounds.width,
      height: bounds.height,
      angle: 0,
      pivot: { x: cx, y: cy },
      flipX: false,
      flipY: false,
    };

    return this.transformState;
  }

  /**
   * Zastępuje maskę zaznaczenia rastrem narysowanym przez `draw` (maska zostaje czysto rastrowa, bez opisu wektorowego).
   * Używane przez tryb perspektywy.
   */
  public replaceMaskRaster(draw: (ctx: CanvasRenderingContext2D) => void): void {
    this.maskPending = false;
    this.lazyXform = null;
    this.ampFlat = null;
    this.ampPairs = [];
    this.polysCache = null;
    this.boundsCache = undefined;
    this.visPath = null;
    const ctx = this._maskCtx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    ctx.fillStyle = '#ffffff';
    draw(ctx);
    ctx.restore();
    this.hasActiveSelection = true;
    this.rebuildContoursFromMask();
  }

  public updateTransformSelection(params: Partial<TransformSelectionState>): void {
    if (!this.transformState) return;
    Object.assign(this.transformState, params);

    const st = this.transformState;
    const cos = Math.cos(st.angle);
    const sin = Math.sin(st.angle);

    const scaleXMult = st.flipX ? -1 : 1;
    const scaleYMult = st.flipY ? -1 : 1;

    const sx = (st.width / Math.max(1, st.initialBounds.width)) * scaleXMult;
    const sy = (st.height / Math.max(1, st.initialBounds.height)) * scaleYMult;

    if (this.initialFlat && this.initialFlat.length > 0) {
      // Geometria przekształcana jest dopiero na żądanie (commit, maska, historia); w trakcie przeciągania
      // kontur mrówek powstaje natywnie: ścieżka początkowa + macierz (bez pętli po milionach punktów w JS).
      const xf = {
        initial: this.initialFlat,
        cx: st.initialCenter.x,
        cy: st.initialCenter.y,
        sx,
        sy,
        cos,
        sin,
        px: st.pos.x,
        py: st.pos.y,
      };
      this.ampFlat = null;
      this.ampPairs = null;
      this.lazyXform = xf;
      // x' = px + (x - cx) * sx * cos - (y - cy) * sy * sin;  y' = py + (x - cx) * sx * sin + (y - cy) * sy * cos
      const ma = sx * cos;
      const mb = sx * sin;
      const mc = -sy * sin;
      const md = sy * cos;
      const me = st.pos.x - ma * xf.cx - mc * xf.cy;
      const mf = st.pos.y - mb * xf.cx - md * xf.cy;
      const path = new Path2D();
      path.addPath(this.initialPath || new Path2D(), new DOMMatrix([ma, mb, mc, md, me, mf]));
      this.ringsLazy = true;
      this.ringsStore = [];
      this.contourPath = path;
      this.polysCache = null;
      this.boundsCache = undefined;
      this.visPath = null;
      this.hasActiveSelection = true;
      // Podgląd maski w trakcie przeciągania z ścieżki natywnej (dokładna maska powstaje przy zatwierdzeniu)
      this.maskPath = path;
      this.maskPending = true;
    } else {
      this.maskPending = false;
      const ctx = this._maskCtx;
      ctx.clearRect(0, 0, this.width, this.height);

      ctx.save();
      ctx.translate(st.pos.x, st.pos.y);
      ctx.rotate(st.angle);
      ctx.scale(sx, sy);
      ctx.translate(-st.initialCenter.x, -st.initialCenter.y);

      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(st.initialMaskCanvas, 0, 0);
      ctx.restore();

      this.rebuildContoursFromMask();
    }
  }

  private applyXform(x: { initial: FlatGeom; cx: number; cy: number; sx: number; sy: number; cos: number; sin: number; px: number; py: number }): FlatGeom {
    const { cx, cy, sx, sy, cos, sin, px, py } = x;
    return x.initial.map((poly) =>
      poly.map((ring) => {
        const out = new Float64Array(ring.length);
        for (let i = 0; i < ring.length; i += 2) {
          const lx = ring[i] - cx;
          const ly = ring[i + 1] - cy;
          out[i] = px + ((lx * sx) * cos - (ly * sy) * sin);
          out[i + 1] = py + ((lx * sx) * sin + (ly * sy) * cos);
        }
        return out;
      })
    );
  }

  public flipHorizontal(): void {
    if (!this.transformState) return;
    const st = this.transformState;
    st.flipX = !st.flipX;

    const dx = st.pivot.x - st.pos.x;
    const dy = st.pivot.y - st.pos.y;
    const cos = Math.cos(st.angle);
    const sin = Math.sin(st.angle);

    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const newLx = -lx;

    st.pivot = {
      x: st.pos.x + newLx * cos - ly * sin,
      y: st.pos.y + newLx * sin + ly * cos,
    };

    this.updateTransformSelection({});
  }

  public flipVertical(): void {
    if (!this.transformState) return;
    const st = this.transformState;
    st.flipY = !st.flipY;

    const dx = st.pivot.x - st.pos.x;
    const dy = st.pivot.y - st.pos.y;
    const cos = Math.cos(st.angle);
    const sin = Math.sin(st.angle);

    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const newLy = -ly;

    st.pivot = {
      x: st.pos.x + lx * cos - newLy * sin,
      y: st.pos.y + lx * sin + newLy * cos,
    };

    this.updateTransformSelection({});
  }

  public commitTransformSelection(): void {
    if (this.transformState) {
      this.transformState = null;
      this.initialFlat = null;
      this.initialPath = null;
      this.initialBoundsCache = undefined;
      if (this.geomPolyCount() > 0) {
        this.rebuildFromActiveMultiPoly();
      } else {
        this.rebuildContoursFromMask();
      }
    }
  }

  public cancelTransformSelection(): void {
    if (!this.transformState) return;
    if (this.initialFlat && this.initialFlat.length > 0) {
      this.setFlat(this.initialFlat);
    }
    this.maskPending = false;
    this._maskCtx.clearRect(0, 0, this.width, this.height);
    this._maskCtx.drawImage(this.transformState.initialMaskCanvas, 0, 0);
    this.transformState = null;
    this.initialFlat = null;
    this.initialPath = null;
    this.initialBoundsCache = undefined;
    if (this.geomPolyCount() > 0) {
      this.rebuildFromActiveMultiPoly();
    } else {
      this.rebuildContoursFromMask();
    }
  }

  public getMaskSnapshot(): SelectionSnapshot {
    if (!this.hasActiveSelection) {
      return { imgData: null, seedPoint: null, activeMultiPoly: [] };
    }
    const seedPoint = this.wandSeedPoint ? { ...this.wandSeedPoint } : null;
    // Gdy istnieje wektorowy opis zaznaczenia, restore odtwarza maskę z niego i ignoruje piksele,
    // więc kopiowanie całego płótna (np. 48 MB przy 4000x3000) nie ma sensu.
    // Geometria płaska jest niezmienna, więc migawka tylko ją współdzieli (dawniej: kopia JSON milionów punktów).
    if (this.geomPolyCount() > 0) {
      return { imgData: null, seedPoint, activeMultiPoly: [], activeFlat: this.getFlat() };
    }
    const full = this.maskCtx.getImageData(0, 0, this.width, this.height);
    const cropped = cropImageDataToAlpha(full);
    return { imgData: cropped.imgData, x: cropped.x, y: cropped.y, seedPoint, activeMultiPoly: [] };
  }

  public restoreMaskSnapshot(snapshot: SelectionSnapshot): void {
    const hasFlat = !!snapshot.activeFlat && snapshot.activeFlat.length > 0;
    const hasPairs = !!snapshot.activeMultiPoly && snapshot.activeMultiPoly.length > 0;
    if (!snapshot.imgData && !hasFlat && !hasPairs) {
      this.clear();
      return;
    }
    if (hasFlat || hasPairs) {
      if (hasFlat) this.setFlat(snapshot.activeFlat!);
      else this.activeMultiPoly = JSON.parse(JSON.stringify(snapshot.activeMultiPoly));
      this.wandSeedPoint = snapshot.seedPoint ? { ...snapshot.seedPoint } : null;
      this.rebuildFromActiveMultiPoly();
    } else if (snapshot.imgData) {
      this.maskPending = false;
      if (snapshot.x !== undefined || snapshot.y !== undefined) {
        // Przycięty fragment: reszta maski ma być pusta
        this._maskCtx.clearRect(0, 0, this.width, this.height);
      }
      this._maskCtx.putImageData(snapshot.imgData, snapshot.x ?? 0, snapshot.y ?? 0);
      this.hasActiveSelection = true;
      this.wandSeedPoint = snapshot.seedPoint ? { ...snapshot.seedPoint } : null;
      this.rebuildContoursFromMask();
    }
  }

  public selectAll(): void {
    this.wandSeedPoint = null;
    const ring: Pair[] = [
      [0, 0],
      [this.width, 0],
      [this.width, this.height],
      [0, this.height],
      [0, 0],
    ];
    this.activeMultiPoly = [[ring]];
    this.rebuildFromActiveMultiPoly();
  }

  /** Zaznaczenie prostokątne (czysta geometria wektorowa, więc przekształcenia zostają dokładne, bez schodków pikseli). */
  public selectRect(x: number, y: number, w: number, h: number): void {
    this.wandSeedPoint = null;
    const ring: Pair[] = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ];
    this.activeMultiPoly = [[ring]];
    this.rebuildFromActiveMultiPoly();
  }

  public invert(): void {
    this.wandSeedPoint = null;
    const docRing: Pair[] = [
      [0, 0],
      [this.width, 0],
      [this.width, this.height],
      [0, this.height],
      [0, 0],
    ];
    const docMultiPoly: MultiPolygon = [[docRing]];

    if (!this.hasActiveSelection || this.activeMultiPoly.length === 0) {
      this.activeMultiPoly = docMultiPoly;
    } else {
      try {
        this.activeMultiPoly = polygonClipping.difference(docMultiPoly, this.activeMultiPoly);
      } catch (e) {
        console.warn('Invert vector error:', e);
        const imgData = this.maskCtx.getImageData(0, 0, this.width, this.height);
        const data = imgData.data;
        let anySelected = false;
        for (let i = 0; i < data.length; i += 4) {
          const inv = 255 - data[i + 3];
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
          data[i + 3] = inv;
          if (inv > 10) anySelected = true;
        }
        this.maskCtx.putImageData(imgData, 0, 0);
        this.hasActiveSelection = anySelected;
        this.rebuildContoursFromMask();
        return;
      }
    }
    this.rebuildFromActiveMultiPoly();
  }

  /**
   * Zastosowanie zaznaczenia geometrycznego (Prostokąt, Elipsa, Lasso)
   * Tworzy czyste figury wektorowe i wykonuje boolowskie łączenie/przecinanie z istniejącą ścieżką!
   */
  public applyGeometricSelection(
    shapeType: 'rect' | 'ellipse' | 'lasso',
    points: SKPoint[],
    settings: SelectionSettings,
    isShiftPressed: boolean = false,
    hasMoved: boolean = true
  ): void {
    this.wandSeedPoint = null;

    if (settings.feather > 0) {
      // Najpierw prostokąt opisany na kształcie, potem rysowanie i rozmycie tylko w nim (+ zasięg rozmycia)
      let shapeRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
      let drawRect: SKRectI | null = null;
      if (shapeType === 'rect' || shapeType === 'ellipse') {
        const p0 = points[0];
        const p1 = points[1] || points[0];
        const rect = this.calculateConstrainedRect(p0, p1, settings, isShiftPressed, hasMoved);
        if (rect.width > 0 && rect.height > 0) {
          drawRect = rect;
          shapeRect = { x0: rect.left, y0: rect.top, x1: rect.left + rect.width, y1: rect.top + rect.height };
        }
      } else if (points.length >= 2 && hasMoved) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const pt of points) {
          if (pt.x < x0) x0 = pt.x;
          if (pt.y < y0) y0 = pt.y;
          if (pt.x > x1) x1 = pt.x;
          if (pt.y > y1) y1 = pt.y;
        }
        shapeRect = { x0, y0, x1, y1 };
      }

      const region =
        shapeRect && shapeRect.x1 > 0 && shapeRect.y1 > 0 && shapeRect.x0 < this.width && shapeRect.y0 < this.height
          ? this.featherRegion(shapeRect.x0, shapeRect.y0, shapeRect.x1, shapeRect.y1, settings.feather)
          : { x: 0, y: 0, w: 1, h: 1 };

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = region.w;
      tempCanvas.height = region.h;
      const tctx = tempCanvas.getContext('2d')!;
      tctx.translate(-region.x, -region.y);
      tctx.fillStyle = '#ffffff';

      if (shapeType === 'rect') {
        if (drawRect) tctx.fillRect(drawRect.left, drawRect.top, drawRect.width, drawRect.height);
      } else if (shapeType === 'ellipse') {
        if (drawRect) {
          const cx = drawRect.left + drawRect.width / 2;
          const cy = drawRect.top + drawRect.height / 2;
          tctx.beginPath();
          tctx.ellipse(cx, cy, drawRect.width / 2, drawRect.height / 2, 0, 0, Math.PI * 2);
          tctx.fill();
        }
      } else {
        if (points.length >= 2 && hasMoved) {
          tctx.beginPath();
          tctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i++) {
            tctx.lineTo(points[i].x, points[i].y);
          }
          tctx.closePath();
          tctx.fill();
        }
      }

      this.applyFeatherToCanvas(tempCanvas, settings.feather);
      this.combineTempMask(tempCanvas, settings.mode, region.x, region.y);
      return;
    }

    // Czysta gałąź wektorowa (feather == 0)
    let newPoly: Polygon | null = null;

    if (shapeType === 'rect') {
      const p0 = points[0];
      const p1 = points[1] || points[0];
      const rect = this.calculateConstrainedRect(p0, p1, settings, isShiftPressed, hasMoved);
      if (rect.width > 0 && rect.height > 0) {
        const ring: Pair[] = [
          [rect.left, rect.top],
          [rect.right, rect.top],
          [rect.right, rect.bottom],
          [rect.left, rect.bottom],
          [rect.left, rect.top],
        ];
        newPoly = [ring];
      }
    } else if (shapeType === 'ellipse') {
      const p0 = points[0];
      const p1 = points[1] || points[0];
      const rect = this.calculateConstrainedRect(p0, p1, settings, isShiftPressed, hasMoved);
      if (rect.width > 0 && rect.height > 0) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const rx = rect.width / 2;
        const ry = rect.height / 2;

        const segs = Math.max(32, Math.min(256, Math.ceil(Math.max(rx, ry) * 1.5)));
        const ring: Pair[] = [];
        for (let i = 0; i < segs; i++) {
          const a = (i * 2 * Math.PI) / segs;
          ring.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
        }
        ring.push([ring[0][0], ring[0][1]]);
        newPoly = [ring];
      }
    } else if (shapeType === 'lasso') {
      if (points.length >= 3 && hasMoved) {
        const ring: Pair[] = points.map((pt) => [pt.x, pt.y]);
        if (
          ring[ring.length - 1][0] !== ring[0][0] ||
          ring[ring.length - 1][1] !== ring[0][1]
        ) {
          ring.push([ring[0][0], ring[0][1]]);
        }
        newPoly = [ring];
      }
    }

    if (newPoly) {
      this.combineVectorGeometry(newPoly, settings.mode);
    }
  }

  /**
   * To samo co combineVectorGeometry, ale dla geometrii płaskiej: tryby bez operacji logicznych
   * (zastąp, dodaj do pustego) nie przechodzą przez tablice par ani polygon-clipping.
   */
  private combineFlatGeometry(geom: FlatGeom, mode: SelectionCombineMode): void {
    const empty = this.geomPolyCount() === 0;
    if (mode === 'replace' || (empty && (mode === 'add' || mode === 'invert'))) {
      this.setFlat(geom);
      this.rebuildFromActiveMultiPoly();
      return;
    }
    this.combineVectorGeometry(flatToPairs(geom), mode);
  }

  /**
   * Łączy/przecina nową figurę wektorową z obecną strukturą activeMultiPoly
   */
  private combineVectorGeometry(newGeom: Polygon | MultiPolygon, mode: SelectionCombineMode): void {
    const geomAsMulti: MultiPolygon = Array.isArray(newGeom[0]?.[0]?.[0])
      ? (newGeom as MultiPolygon)
      : ([newGeom] as MultiPolygon);

    if (mode === 'replace') {
      this.activeMultiPoly = geomAsMulti;
    } else if (!this.activeMultiPoly || this.activeMultiPoly.length === 0) {
      if (mode === 'add' || mode === 'invert') {
        this.activeMultiPoly = geomAsMulti;
      } else {
        this.activeMultiPoly = [];
      }
    } else {
      try {
        if (mode === 'add') {
          this.activeMultiPoly = polygonClipping.union(this.activeMultiPoly, geomAsMulti);
        } else if (mode === 'subtract') {
          this.activeMultiPoly = polygonClipping.difference(this.activeMultiPoly, geomAsMulti);
        } else if (mode === 'intersect') {
          this.activeMultiPoly = polygonClipping.intersection(this.activeMultiPoly, geomAsMulti);
        } else if (mode === 'invert') {
          this.activeMultiPoly = polygonClipping.xor(this.activeMultiPoly, geomAsMulti);
        }
      } catch (e) {
        console.warn('Vector clipping fallback:', e);
      }
    }

    this.rebuildFromActiveMultiPoly();
  }

  /**
   * Odtwarza maskę bitową oraz ścieżkę mrówek na podstawie struktury wektorowej activeMultiPoly
   */
  // --- Kontur przycięty do widocznego obszaru (maszerujące mrówki) ---
  private visPath: Path2D | null = null;
  private visSrc: Path2D | null = null;
  private visRect: { x0: number; y0: number; x1: number; y1: number } | null = null;

  /**
   * Kontur zaznaczenia przycięty do prostokąta (układ dokumentu) z zapasem. Obrysowywanie przerywaną linią pełnego,
   * ogromnego konturu przy dużym zoomie generuje miliony kresek poza ekranem; przycięta ścieżka ma tylko widoczne odcinki.
   * Wynik jest buforowany, dopóki widok mieści się w policzonym obszarze.
   */
  public getVisibleContourPath(x0: number, y0: number, x1: number, y1: number): Path2D {
    const bounds = this.getContourBounds();
    if (!bounds) return this.contourPath;

    const mx = Math.max(16, (x1 - x0) * 0.5);
    const my = Math.max(16, (y1 - y0) * 0.5);
    const rx0 = x0 - mx;
    const ry0 = y0 - my;
    const rx1 = x1 + mx;
    const ry1 = y1 + my;

    // Cały kontur mieści się w zasięgu widoku: pełna ścieżka (natywna, bez żadnej pracy po punktach)
    if (bounds.x0 >= rx0 && bounds.y0 >= ry0 && bounds.x1 <= rx1 && bounds.y1 <= ry1) return this.contourPath;

    const vr = this.visRect;
    if (this.visPath && this.visSrc === this.contourPath && vr && x0 >= vr.x0 && y0 >= vr.y0 && x1 <= vr.x1 && y1 <= vr.y1) {
      return this.visPath;
    }

    const rings = this.contourRings;
    const parts: string[] = [];
    for (const ring of rings) {
      const n = ring.length >> 1;
      // Szybkie odrzucenie pierścieni poza widokiem i bez przycinania pierścieni w całości widocznych
      let bx0 = Infinity,
        by0 = Infinity,
        bx1 = -Infinity,
        by1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        const px = ring[i];
        const py = ring[i + 1];
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py < by0) by0 = py;
        if (py > by1) by1 = py;
      }
      if (bx1 < rx0 || bx0 > rx1 || by1 < ry0 || by0 > ry1) continue;
      if (bx0 >= rx0 && bx1 <= rx1 && by0 >= ry0 && by1 <= ry1) {
        parts.push(ringToPathString(ring));
        continue;
      }
      let lastX = NaN;
      let lastY = NaN;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const ax = ring[2 * i];
        const ay = ring[2 * i + 1];
        const dx = ring[2 * j] - ax;
        const dy = ring[2 * j + 1] - ay;
        // Liang-Barsky (bez alokacji tablic na odcinek)
        let t0 = 0;
        let t1 = 1;
        let ok = true;
        for (let k = 0; k < 4 && ok; k++) {
          const p = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dy : dy;
          const q = k === 0 ? ax - rx0 : k === 1 ? rx1 - ax : k === 2 ? ay - ry0 : ry1 - ay;
          if (p === 0) {
            if (q < 0) ok = false;
          } else {
            const t = q / p;
            if (p < 0) {
              if (t > t1) ok = false;
              else if (t > t0) t0 = t;
            } else {
              if (t < t0) ok = false;
              else if (t < t1) t1 = t;
            }
          }
        }
        if (!ok) {
          lastX = NaN;
          continue;
        }
        const sx = ax + t0 * dx;
        const sy = ay + t0 * dy;
        const ex = ax + t1 * dx;
        const ey = ay + t1 * dy;
        if (sx !== lastX || sy !== lastY) parts.push('M' + sx + ' ' + sy);
        parts.push('L' + ex + ' ' + ey);
        lastX = ex;
        lastY = ey;
      }
    }
    this.visPath = new Path2D(parts.join(''));
    this.visSrc = this.contourPath;
    this.visRect = { x0: rx0, y0: ry0, x1: rx1, y1: ry1 };
    return this.visPath;
  }

  private rebuildFromActiveMultiPoly(): void {
    if (this.geomPolyCount() === 0) {
      this.maskPending = false;
      this._maskCtx.clearRect(0, 0, this.width, this.height);
      this.hasActiveSelection = false;
      this.setContour([], new Path2D());
      return;
    }

    // Jedna ścieżka (z napisu SVG - dużo szybsza niż tysiące wywołań moveTo/lineTo) służy do mrówek,
    // a maska rastrowa jest dopisywana dopiero przy pierwszym użyciu (flushMask).
    const rings = flatRingsOf(this.getFlat());
    const path = new Path2D(ringsToPathString(rings));
    this.setContour(rings, path);

    this.hasActiveSelection = rings.length > 0;
    if (rings.length > 0) {
      this.maskPath = path;
      this.maskPending = true;
    } else {
      this.maskPending = false;
      this._maskCtx.clearRect(0, 0, this.width, this.height);
    }
  }

  public calculateConstrainedRect(
    p0: SKPoint,
    p1: SKPoint,
    settings: SelectionSettings,
    isShiftPressed: boolean = false,
    hasMoved: boolean = true
  ): SKRectI {
    if (settings.constraint === 'fixed-size') {
      const w = Math.max(1, settings.fixedW || 100);
      const h = Math.max(1, settings.fixedH || 100);
      const anchor = p1 || p0;
      const left = anchor.x;
      const top = anchor.y;
      return {
        left: Math.round(left),
        top: Math.round(top),
        right: Math.round(left + w),
        bottom: Math.round(top + h),
        width: Math.round(w),
        height: Math.round(h),
      };
    }

    if (!hasMoved) {
      return {
        left: Math.round(p0.x),
        top: Math.round(p0.y),
        right: Math.round(p0.x),
        bottom: Math.round(p0.y),
        width: 0,
        height: 0,
      };
    }

    let w = Math.abs(p1.x - p0.x);
    let h = Math.abs(p1.y - p0.y);
    const signX = p1.x >= p0.x ? 1 : -1;
    const signY = p1.y >= p0.y ? 1 : -1;

    if (isShiftPressed) {
      const side = Math.max(w, h);
      w = side;
      h = side;
    } else if (settings.constraint === 'fixed-ratio') {
      const rw = Math.max(0.001, settings.ratioW || 1);
      const rh = Math.max(0.001, settings.ratioH || 1);
      const ratio = rw / rh;
      if (w / Math.max(1, h) > ratio) {
        w = h * ratio;
      } else {
        h = w / ratio;
      }
    }

    const left = signX > 0 ? p0.x : p0.x - w;
    const top = signY > 0 ? p0.y : p0.y - h;

    return {
      left: Math.round(left),
      top: Math.round(top),
      right: Math.round(left + w),
      bottom: Math.round(top + h),
      width: Math.max(1, Math.round(w)),
      height: Math.max(1, Math.round(h)),
    };
  }

  public snapshotWandBase(): void {
    // Zaznaczenie wektorowe zapamiętujemy jako geometrię (tablice są niezmienne), rastrowe jako obraz maski
    this.wandBaseFlat = this.geomPolyCount() > 0 ? this.getFlat() : null;
    this.wandBaseRasterOnly = this.hasActiveSelection && this.wandBaseFlat === null;
    this.wandBaseMaskCtx.clearRect(0, 0, this.width, this.height);
    this.wandBaseMaskCtx.drawImage(this.maskCanvas, 0, 0);
  }

  private wandBaseFlat: FlatGeom | null = null;
  private wandBaseRasterOnly = false;

  /** Ostatni wynik różdżki policzony w wątku roboczym (sygnatura wejścia + ścieżka zaznaczenia, którą wtedy zostawił). */
  private asyncWandLast: { sig: string; path: Path2D } | null = null;

  /**
   * Początek różdżki liczonej asynchronicznie: zapamiętuje punkt (uchwyt przesuwa się od razu) i ustawienia, a przy nowym
   * kliknięciu stan bazowy maski.
   */
  public beginWand(seedPoint: SKPoint, settings: SelectionSettings, isNewClick: boolean): void {
    if (isNewClick) this.snapshotWandBase();
    this.wandSeedPoint = { ...seedPoint };
    this.lastWandSettings = { ...settings };
  }

  /** Czy ostatni wynik z wątku roboczego nadal odpowiada bieżącemu zaznaczeniu (nic go nie zmieniło) i tej sygnaturze. */
  public canReuseAsyncWand(sig: string): boolean {
    const l = this.asyncWandLast;
    return !!l && l.sig === sig && l.path === this.contourPath;
  }

  /** Zastosowanie wyniku z wątku roboczego (kontur po krawędziach pikseli + dokładna maska jako zapas). */
  public applyWandCrop(crop: WandCrop | null, geom: FlatGeom | null, settings: SelectionSettings, sig: string): void {
    this.wandLast = null;
    this.applyWandResult(crop, geom, settings.mode);
    this.asyncWandLast = { sig, path: this.contourPath };
  }

  /**
   * Wynik różdżki łączymy z zaznaczeniem jako geometrię wektorową biegnącą po krawędziach pikseli (obrót i skalowanie
   * zaznaczenia nie zniekształcają wtedy konturu, a kolejne figury łączą się logicznie, bez rastrowania konturów).
   * Maska rastrowa (dokładna, bez wygładzania) jest używana tylko, gdy kontur jest zbyt złożony albo zaznaczenie bazowe
   * jest czysto rastrowe (np. z piórkowaniem).
   */
  private applyWandResult(crop: WandCrop | null, geom: FlatGeom | null, mode: SelectionCombineMode): void {
    const baseIsRaster = mode !== 'replace' && this.wandBaseRasterOnly;
    if (geom === null || baseIsRaster) {
      this.applyExactWandMask(crop, mode);
      return;
    }
    if (mode !== 'replace') {
      // odświeżenie z innym parametrem zaczyna od zaznaczenia sprzed różdżki
      if (this.wandBaseFlat) this.setFlat(this.wandBaseFlat);
      else this.setFlat([]);
    }
    if (geom.length === 0) {
      if (mode === 'replace' || mode === 'intersect') this.setFlat([]);
      this.rebuildFromActiveMultiPoly();
      return;
    }
    this.combineFlatGeometry(geom, mode);
  }

  /** Dokładna maska rastrowa różdżki (bez wygładzania i upraszczania konturu) połączona z zaznaczeniem według trybu. */
  private applyExactWandMask(crop: WandCrop | null, mode: SelectionCombineMode): void {
    const cw = crop ? crop.w : 1;
    const ch = crop ? crop.h : 1;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cw;
    tempCanvas.height = ch;
    const tctx = tempCanvas.getContext('2d')!;
    const img = tctx.createImageData(cw, ch);
    if (crop) {
      const m32 = new Uint32Array(img.data.buffer);
      for (let i = 0; i < crop.data.length; i++) if (crop.data[i] === 255) m32[i] = 0xffffffff;
    }
    tctx.putImageData(img, 0, 0);
    this.setFlat([]);
    this.maskPending = false;
    this._maskCtx.clearRect(0, 0, this.width, this.height);
    if (mode !== 'replace') this._maskCtx.drawImage(this.wandBaseMaskCanvas, 0, 0);
    this.combineTempMask(tempCanvas, mode, crop ? crop.x : 0, crop ? crop.y : 0);
  }

  /** Wynik identyczny z poprzednim: zaznaczenie zostaje, zapamiętujemy tylko sygnaturę. */
  public confirmAsyncWandSame(sig: string): void {
    this.asyncWandLast = { sig, path: this.contourPath };
  }

  /** Ostatni wynik różdżki - pozwala pominąć przebudowę zaznaczenia, gdy zmiana parametru nie zmienia obszaru. */
  private wandLast: {
    sig: string;
    tol: number;
    count: number;
    mask: Uint8Array;
    ms: number;
    path: Path2D;
    color: number;
    sx: number;
    sy: number;
  } | null = null;

  /**
   * Magiczna różdżka.
   * `source` - płótno albo gotowe piksele (ImageData) próbkowanego obrazu. Dla ImageData wywołujący może podać
   * `dataKey` (identyfikator zawartości pikseli): gdy się nie zmienił, a nowy wynik wychodzi z tych samych pikseli,
   * zmiana tolerancji lub punktu początkowego, która nie zmienia zaznaczonego obszaru, nie przebudowuje zaznaczenia.
   */
  public applyMagicWand(
    seedPoint: SKPoint,
    source: HTMLCanvasElement | ImageData,
    settings: SelectionSettings,
    isNewClick: boolean = true,
    dataKey?: string
  ): void {
    if (isNewClick) {
      this.snapshotWandBase();
    }

    this.wandSeedPoint = { ...seedPoint };
    this.lastWandSettings = { ...settings };
    this.asyncWandLast = null;

    const sx = Math.max(0, Math.min(this.width - 1, Math.floor(seedPoint.x)));
    const sy = Math.max(0, Math.min(this.height - 1, Math.floor(seedPoint.y)));

    let imgData: ImageData;
    if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
      imgData = source;
    } else {
      const cCtx = (source as HTMLCanvasElement).getContext('2d');
      if (!cCtx) return;
      imgData = cCtx.getImageData(0, 0, this.width, this.height);
      dataKey = undefined;
    }
    const data = imgData.data;
    const startIdx = (sy * this.width + sx) * 4;
    const targetR = data[startIdx];
    const targetG = data[startIdx + 1];
    const targetB = data[startIdx + 2];
    const targetA = data[startIdx + 3];
    const targetKey = (((targetA << 24) | (targetB << 16) | (targetG << 8) | targetR) >>> 0);
    const isGlobal = settings.wandMode === 'global';
    const sig = dataKey === undefined ? null : `${dataKey}|${settings.wandMode}|${settings.feather}|${settings.mode}`;

    // Ten sam obszar co poprzednio (zaznaczenie nietknięte od ostatniej różdżki)?
    const last = this.wandLast;
    const lastValid = !isNewClick && sig !== null && last !== null && last.sig === sig && last.path === this.contourPath && last.color === targetKey;
    if (lastValid && last!.tol === settings.tolerance && (isGlobal || last!.mask[(sy + 1) * last!.ms + WAND_PAD + sx] === 255)) {
      return;
    }

    const w = this.width;
    const h = this.height;
    const flood = floodSelect(data, w, h, sx, sy, settings.tolerance, isGlobal);
    const wandMask = flood.mask;
    const ms = flood.ms;
    const count = flood.count;
    const bMinX = flood.bMinX;
    const bMinY = flood.bMinY;
    const bMaxX = flood.bMaxX;
    const bMaxY = flood.bMaxY;

    const remember = (): void => {
      this.wandLast = sig === null ? null : { sig, tol: settings.tolerance, count, mask: wandMask, ms, path: this.contourPath, color: targetKey, sx, sy };
    };

    // Obszar identyczny z poprzednim (ten sam piksel startowy i kolor, a obszary są zagnieżdżone przy zmianie tolerancji)
    if (lastValid && last!.count === count && (isGlobal || (last!.sx === sx && last!.sy === sy))) {
      last!.tol = settings.tolerance;
      last!.mask = wandMask;
      return;
    }

    const hasPixels = bMaxX >= bMinX && bMaxY >= bMinY;

    if (settings.feather > 0) {
      // Rozmycie tylko w prostokącie maski powiększonym o zasięg rozmycia (reszta płótna jest przezroczysta)
      const region = hasPixels
        ? this.featherRegion(bMinX, bMinY, bMaxX + 1, bMaxY + 1, settings.feather)
        : { x: 0, y: 0, w: 1, h: 1 };
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = region.w;
      tempCanvas.height = region.h;
      const tctx = tempCanvas.getContext('2d')!;
      const maskImgData = tctx.createImageData(region.w, region.h);
      const m32 = new Uint32Array(maskImgData.data.buffer);
      if (hasPixels) {
        for (let y = 0; y < region.h; y++) {
          const src = (region.y + y + 1) * ms + WAND_PAD + region.x;
          const dst = y * region.w;
          for (let x = 0; x < region.w; x++) {
            if (wandMask[src + x] === 255) m32[dst + x] = 0xffffffff;
          }
        }
      }
      tctx.putImageData(maskImgData, 0, 0);

      this.applyFeatherToCanvas(tempCanvas, settings.feather);
      // Wynik z piórkowaniem jest maską rastrową - nieaktualny opis wektorowy nie może zostać (trafiałby do historii)
      this.activeMultiPoly = [];
      this.maskPending = false;
      this._maskCtx.clearRect(0, 0, this.width, this.height);
      if (settings.mode !== 'replace') {
        this._maskCtx.drawImage(this.wandBaseMaskCanvas, 0, 0);
      }
      this.combineTempMask(tempCanvas, settings.mode, region.x, region.y);
      remember();
      return;
    }

    const crop = cropOfFlood(flood);
    this.applyWandResult(crop, crop ? pixelGeomOfCrop(crop) : [], settings.mode);
    remember();
  }

  /**
   * Obszar, w którym rozmycie piórkowania może zostawić niezerową alfę: prostokąt kształtu powiększony o 4 sigma.
   * Przycięty do płótna, więc krawędzie dokumentu zachowują się jak przy rozmyciu całego płótna.
   */
  private featherRegion(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    feather: number
  ): { x: number; y: number; w: number; h: number } {
    const pad = Math.ceil(Math.max(1, feather) * 4) + 2;
    const rx0 = Math.max(0, Math.floor(x0) - pad);
    const ry0 = Math.max(0, Math.floor(y0) - pad);
    const rx1 = Math.min(this.width, Math.ceil(x1) + pad);
    const ry1 = Math.min(this.height, Math.ceil(y1) + pad);
    return { x: rx0, y: ry0, w: Math.max(1, rx1 - rx0), h: Math.max(1, ry1 - ry0) };
  }

  private applyFeatherToCanvas(canvas: HTMLCanvasElement, featherRadius: number): void {
    if (featherRadius <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const blurCanvas = document.createElement('canvas');
    blurCanvas.width = canvas.width;
    blurCanvas.height = canvas.height;
    const bctx = blurCanvas.getContext('2d')!;

    bctx.filter = `blur(${Math.max(1, featherRadius)}px)`;
    bctx.drawImage(canvas, 0, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(blurCanvas, 0, 0);
  }

  private combineTempMask(tempCanvas: HTMLCanvasElement, mode: SelectionCombineMode, ox: number = 0, oy: number = 0): void {
    const ctx = this.maskCtx;

    if (mode === 'replace') {
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(tempCanvas, ox, oy);
    } else if (mode === 'add') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(tempCanvas, ox, oy);
    } else if (mode === 'subtract') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(tempCanvas, ox, oy);
    } else if (mode === 'intersect') {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(tempCanvas, ox, oy);
    } else if (mode === 'invert') {
      ctx.globalCompositeOperation = 'xor';
      ctx.drawImage(tempCanvas, ox, oy);
    }

    ctx.globalCompositeOperation = 'source-over';

    // Jeden odczyt maski służy zarówno do wykrycia zaznaczenia, jak i do budowy konturów
    const imgData = ctx.getImageData(0, 0, this.width, this.height);
    const data = imgData.data;
    let any = false;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 10) {
        any = true;
        break;
      }
    }

    this.hasActiveSelection = any;
    if (any) {
      this.extractMarchingSquares(imgData);
    } else {
      this.setContour([], new Path2D());
    }
  }

  public rebuildContoursFromCanvas(srcCanvas: HTMLCanvasElement): void {
    const ctx = srcCanvas.getContext('2d');
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, this.width, this.height);
    this.extractMarchingSquares(imgData);
  }

  public rebuildContoursFromMask(searchBounds?: SKRectI | null): void {
    if (!this.hasActiveSelection) {
      this.setContour([], new Path2D());
      return;
    }
    const imgData = this.maskCtx.getImageData(0, 0, this.width, this.height);
    this.extractMarchingSquares(imgData, searchBounds);
  }

  private extractMarchingSquares(imgData: ImageData, searchBounds?: SKRectI | null): void {
    this.extractContours(imgData.data, 4, 3, searchBounds);
  }

  /**
   * Marching squares na kanale alfa (próg 127.5) + łączenie segmentów w zamknięte pętle.
   * `alpha[(y * width + x) * pixelStride + alphaOffset]` - dla ImageData (4, 3), dla maski jednobajtowej (1, 0).
   *
   * Pętle są śledzone topologicznie: koniec segmentu leży na krawędzi komórki, a następny segment zaczyna się
   * dokładnie na tej samej krawędzi w sąsiedniej komórce (tablica przejść dla 16 przypadków). Dzięki temu:
   *  - pętle zawsze się domykają i nie ma limitu ich długości (dawniej limit 20000 kroków ucinał długie kontury
   *    i domykał je prostą linią między odległymi punktami),
   *  - nie ma dopasowywania "najbliższego punktu" (które przy cienkich elementach mogło zamknąć pętlę za wcześnie),
   *  - koszt jest liniowy i bez alokacji pojedynczych segmentów.
   * Dla pętli, które dawniej wychodziły poprawnie, wynik jest identyczny (ten sam punkt startowy i kolejność).
   */
  private extractContours(
    alpha: Uint8ClampedArray | Uint8Array,
    pixelStride: number,
    alphaOffset: number,
    searchBounds?: SKRectI | null
  ): void {
    this.setContour([], new Path2D());

    const w = this.width;
    const h = this.height;

    let minX = -1;
    let minY = -1;
    let maxX = w;
    let maxY = h;

    if (searchBounds) {
      minX = Math.max(-1, Math.floor(searchBounds.left) - 4);
      minY = Math.max(-1, Math.floor(searchBounds.top) - 4);
      maxX = Math.min(w, Math.ceil(searchBounds.right) + 4);
      maxY = Math.min(h, Math.ceil(searchBounds.bottom) + 4);
    }

    const T = 127.5;
    const cw = maxX - minX + 1; // komórki x = minX..maxX
    const ch = maxY - minY + 1; // komórki y = minY..maxY
    if (cw <= 0 || ch <= 0) return;

    // 1. Klasyfikacja komórek: cm[...] = przypadek 0..15 (0 i 15 = brak krawędzi), bity 16/32 = segment już użyty
    const cm = new Uint8Array((cw * ch + 3) & ~3);
    const rowLen = cw + 1;
    let rowTop = new Uint8Array(rowLen);
    let rowBot = new Uint8Array(rowLen);
    const classifyRow = (y: number, out: Uint8Array): void => {
      if (y < 0 || y >= h) {
        out.fill(0);
        return;
      }
      const base = y * w;
      for (let i = 0; i < rowLen; i++) {
        const x = minX + i;
        out[i] = x >= 0 && x < w && alpha[(base + x) * pixelStride + alphaOffset] >= T ? 1 : 0;
      }
    };
    classifyRow(minY, rowTop);
    for (let cy = 0; cy < ch; cy++) {
      classifyRow(minY + cy + 1, rowBot);
      const o = cy * cw;
      for (let xi = 0; xi < cw; xi++) {
        const c = rowTop[xi] | (rowTop[xi + 1] << 1) | (rowBot[xi + 1] << 2) | (rowBot[xi] << 3);
        cm[o + xi] = c === 15 ? 0 : c;
      }
      const tmp = rowTop;
      rowTop = rowBot;
      rowBot = tmp;
    }

    // 2. Punkt przecięcia na krawędzi komórki (x, y) - współrzędne dokumentu. Krawędzie: 0 góra, 1 prawa, 2 dół, 3 lewa.
    //    Ta sama krawędź policzona z sąsiedniej komórki daje bit w bit ten sam punkt.
    const A = (x: number, y: number): number => {
      if (x < 0 || x >= w || y < 0 || y >= h) return 0;
      return alpha[(y * w + x) * pixelStride + alphaOffset];
    };
    const tOf = (a: number, b: number): number => Math.max(0.01, Math.min(0.99, (T - a) / (b - a || 0.0001)));
    const edgePoint = (x: number, y: number, e: number, out: Float64Array): void => {
      if (e === 0) { out[0] = x + 0.5 + tOf(A(x, y), A(x + 1, y)); out[1] = y + 0.5; }
      else if (e === 1) { out[0] = x + 1.5; out[1] = y + 0.5 + tOf(A(x + 1, y), A(x + 1, y + 1)); }
      else if (e === 2) { out[0] = x + 0.5 + tOf(A(x, y + 1), A(x + 1, y + 1)); out[1] = y + 1.5; }
      else { out[0] = x + 0.5; out[1] = y + 0.5 + tOf(A(x, y), A(x, y + 1)); }
    };
    const rings = traceCells(cm, cw, ch, minX, minY, edgePoint);
    this.setContour(rings, new Path2D(ringsToPathString(rings)));
  }
}

