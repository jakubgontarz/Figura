/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import polygonClipping, { MultiPolygon, Polygon, Pair } from 'polygon-clipping';
import { SKPoint, SKRectI, SelectionCombineMode, SelectionSettings } from './types.ts';

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

export interface SelectionSnapshot {
  imgData: ImageData | null;
  seedPoint: SKPoint | null;
  activeMultiPoly?: MultiPolygon;
}

/**
 * Zaawansowany menedżer zaznaczeń z Wektorowym Silnikiem Geometrii i Sub-Pixel Marching Squares:
 * 1. Prawdziwa wektorowa ścieżka mrówek zbudowana z figur wektorowych (Prostokąty, Elipsy, Lasso).
 * 2. Przecinanie i łączenie figur wektorowych daje czystą ścieżkę z długimi prostokątnymi odcinkami i gładkimi łukami elips.
 * 3. Narzędzie modyfikacji zaznaczenia (ramka, 8 niezależnych uchwytów ze stałym punktem przeciwległym, obrót).
 */
export class SelectionManager {
  public width: number;
  public height: number;

  public maskCanvas: HTMLCanvasElement;
  public maskCtx: CanvasRenderingContext2D;
  public hasActiveSelection: boolean = false;

  public wandBaseMaskCanvas: HTMLCanvasElement;
  public wandBaseMaskCtx: CanvasRenderingContext2D;

  // Główna struktura wektorowa przechowywana dla zaznaczenia
  public activeMultiPoly: MultiPolygon = [];
  public initialMultiPoly: MultiPolygon = [];

  // Jednolita ścieżka wektorowa i punkty dla maszerujących mrówek
  public contourPath: Path2D = new Path2D();
  public contourPolygons: SKPoint[][] = [];
  public initialContourPolygons: SKPoint[][] = [];

  // Stan interaktywnego przekształcania zaznaczenia
  public transformState: TransformSelectionState | null = null;

  public wandSeedPoint: SKPoint | null = null;
  public lastWandSettings: SelectionSettings | null = null;

  constructor(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    this.maskCanvas = document.createElement('canvas');
    this.maskCanvas.width = this.width;
    this.maskCanvas.height = this.height;
    const mctx = this.maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!mctx) throw new Error('Nie można utworzyć kontekstu maski zaznaczenia');
    this.maskCtx = mctx;

    this.wandBaseMaskCanvas = document.createElement('canvas');
    this.wandBaseMaskCanvas.width = this.width;
    this.wandBaseMaskCanvas.height = this.height;
    this.wandBaseMaskCtx = this.wandBaseMaskCanvas.getContext('2d', { willReadFrequently: true })!;
  }

  public resize(width: number, height: number): void {
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
      this.wandBaseMaskCanvas.width = width;
      this.wandBaseMaskCanvas.height = height;
      this.clear();
    }
  }

  public clear(): void {
    this.maskCtx.clearRect(0, 0, this.width, this.height);
    this.wandBaseMaskCtx.clearRect(0, 0, this.width, this.height);
    this.hasActiveSelection = false;
    this.wandSeedPoint = null;
    this.activeMultiPoly = [];
    this.initialMultiPoly = [];
    this.contourPath = new Path2D();
    this.contourPolygons = [];
    this.initialContourPolygons = [];
    this.transformState = null;
  }

  public getSelectionBounds(): SKRectI | null {
    if (!this.hasActiveSelection) return null;
    const imgData = this.maskCtx.getImageData(0, 0, this.width, this.height);
    // Przeszukiwanie jako słowa 32-bit (little-endian: alfa to najstarszy bajt) - kilka razy szybciej
    const px = new Uint32Array(imgData.data.buffer);
    const w = this.width;
    const h = this.height;

    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (px[row + x] >>> 24 !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) return null;
    return {
      left: minX,
      top: minY,
      right: maxX + 1,
      bottom: maxY + 1,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
    };
  }

  public beginTransformSelection(knownBounds?: SKRectI | null): TransformSelectionState | null {
    const bounds = knownBounds ?? this.getSelectionBounds();
    if (!bounds) return null;

    const initCanvas = document.createElement('canvas');
    initCanvas.width = this.width;
    initCanvas.height = this.height;
    const ictx = initCanvas.getContext('2d', { willReadFrequently: true })!;
    // Maska jest niezerowa tylko w `bounds` - kopiujemy i binaryzujemy wyłącznie ten fragment
    ictx.drawImage(
      this.maskCanvas,
      bounds.left, bounds.top, bounds.width, bounds.height,
      bounds.left, bounds.top, bounds.width, bounds.height
    );

    // Oczyszczanie maski do postaci binarnej
    const mImgData = ictx.getImageData(bounds.left, bounds.top, bounds.width, bounds.height);
    const mData = mImgData.data;
    for (let i = 3; i < mData.length; i += 4) {
      mData[i] = mData[i] > 0 ? 255 : 0;
    }
    ictx.putImageData(mImgData, bounds.left, bounds.top);

    const cx = bounds.left + bounds.width / 2;
    const cy = bounds.top + bounds.height / 2;

    this.initialContourPolygons = this.contourPolygons;
    this.initialMultiPoly = JSON.parse(JSON.stringify(this.activeMultiPoly));

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

    if (this.initialMultiPoly && this.initialMultiPoly.length > 0) {
      const transformed: MultiPolygon = this.initialMultiPoly.map((poly) =>
        poly.map((ring) =>
          ring.map(([x, y]) => {
            const lx = x - st.initialCenter.x;
            const ly = y - st.initialCenter.y;
            const rx = (lx * sx) * cos - (ly * sy) * sin;
            const ry = (lx * sx) * sin + (ly * sy) * cos;
            return [st.pos.x + rx, st.pos.y + ry];
          })
        )
      );
      this.activeMultiPoly = transformed;
      this.rebuildFromActiveMultiPoly();
    } else {
      const ctx = this.maskCtx;
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
      this.initialMultiPoly = [];
      if (this.activeMultiPoly.length > 0) {
        this.rebuildFromActiveMultiPoly();
      } else {
        this.rebuildContoursFromMask();
      }
    }
  }

  public cancelTransformSelection(): void {
    if (!this.transformState) return;
    if (this.initialMultiPoly && this.initialMultiPoly.length > 0) {
      this.activeMultiPoly = JSON.parse(JSON.stringify(this.initialMultiPoly));
    }
    this.maskCtx.clearRect(0, 0, this.width, this.height);
    this.maskCtx.drawImage(this.transformState.initialMaskCanvas, 0, 0);
    this.transformState = null;
    this.initialMultiPoly = [];
    if (this.activeMultiPoly.length > 0) {
      this.rebuildFromActiveMultiPoly();
    } else {
      this.rebuildContoursFromMask();
    }
  }

  public getMaskSnapshot(): SelectionSnapshot {
    if (!this.hasActiveSelection) {
      return { imgData: null, seedPoint: null, activeMultiPoly: [] };
    }
    const imgData = this.maskCtx.getImageData(0, 0, this.width, this.height);
    return {
      imgData,
      seedPoint: this.wandSeedPoint ? { ...this.wandSeedPoint } : null,
      activeMultiPoly: JSON.parse(JSON.stringify(this.activeMultiPoly)),
    };
  }

  public restoreMaskSnapshot(snapshot: SelectionSnapshot): void {
    if (!snapshot.imgData && (!snapshot.activeMultiPoly || snapshot.activeMultiPoly.length === 0)) {
      this.clear();
      return;
    }
    if (snapshot.activeMultiPoly && snapshot.activeMultiPoly.length > 0) {
      this.activeMultiPoly = JSON.parse(JSON.stringify(snapshot.activeMultiPoly));
      this.wandSeedPoint = snapshot.seedPoint ? { ...snapshot.seedPoint } : null;
      this.rebuildFromActiveMultiPoly();
    } else if (snapshot.imgData) {
      this.maskCtx.putImageData(snapshot.imgData, 0, 0);
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
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = this.width;
      tempCanvas.height = this.height;
      const tctx = tempCanvas.getContext('2d')!;
      tctx.fillStyle = '#ffffff';

      if (shapeType === 'rect') {
        const p0 = points[0];
        const p1 = points[1] || points[0];
        const rect = this.calculateConstrainedRect(p0, p1, settings, isShiftPressed, hasMoved);
        if (rect.width > 0 && rect.height > 0) {
          tctx.fillRect(rect.left, rect.top, rect.width, rect.height);
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
          tctx.beginPath();
          tctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
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
      this.combineTempMask(tempCanvas, settings.mode);
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
  private rebuildFromActiveMultiPoly(): void {
    this.maskCtx.clearRect(0, 0, this.width, this.height);

    if (!this.activeMultiPoly || this.activeMultiPoly.length === 0) {
      this.hasActiveSelection = false;
      this.contourPath = new Path2D();
      this.contourPolygons = [];
      return;
    }

    // 1. Wypełnienie rasterowe maskCtx (dla operacji obcinania/kopiowania)
    this.maskCtx.fillStyle = '#ffffff';
    this.maskCtx.beginPath();
    for (const poly of this.activeMultiPoly) {
      for (const ring of poly) {
        if (ring.length < 3) continue;
        this.maskCtx.moveTo(ring[0][0], ring[0][1]);
        for (let i = 1; i < ring.length; i++) {
          this.maskCtx.lineTo(ring[i][0], ring[i][1]);
        }
      }
    }
    this.maskCtx.fill('evenodd');

    // 2. Budowanie wektorowego Path2D dla maszerujących mrówek
    this.contourPath = new Path2D();
    this.contourPolygons = [];

    for (const poly of this.activeMultiPoly) {
      for (const ring of poly) {
        if (ring.length < 3) continue;

        const loop: SKPoint[] = ring.map(([x, y]) => ({ x, y }));
        this.contourPolygons.push(loop);

        this.contourPath.moveTo(ring[0][0], ring[0][1]);
        for (let i = 1; i < ring.length; i++) {
          this.contourPath.lineTo(ring[i][0], ring[i][1]);
        }
        this.contourPath.closePath();
      }
    }

    this.hasActiveSelection = this.contourPolygons.length > 0;
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
    this.wandBaseMaskCtx.clearRect(0, 0, this.width, this.height);
    this.wandBaseMaskCtx.drawImage(this.maskCanvas, 0, 0);
  }

  public applyMagicWand(
    seedPoint: SKPoint,
    compositeCanvas: HTMLCanvasElement,
    settings: SelectionSettings,
    isNewClick: boolean = true
  ): void {
    if (isNewClick) {
      this.snapshotWandBase();
    }

    this.wandSeedPoint = { ...seedPoint };
    this.lastWandSettings = { ...settings };

    const sx = Math.max(0, Math.min(this.width - 1, Math.floor(seedPoint.x)));
    const sy = Math.max(0, Math.min(this.height - 1, Math.floor(seedPoint.y)));

    const cCtx = compositeCanvas.getContext('2d');
    if (!cCtx) return;

    const imgData = cCtx.getImageData(0, 0, this.width, this.height);
    const data = imgData.data;
    const totalPixels = this.width * this.height;

    const startIdx = (sy * this.width + sx) * 4;
    const targetR = data[startIdx];
    const targetG = data[startIdx + 1];
    const targetB = data[startIdx + 2];
    const targetA = data[startIdx + 3];

    const maxDist = (settings.tolerance / 100) * 441.67;
    const wandMask = new Uint8Array(totalPixels);
    const w = this.width;
    const h = this.height;

    if (settings.wandMode === 'global') {
      for (let i = 0; i < totalPixels; i++) {
        const p = i * 4;
        const dr = data[p] - targetR;
        const dg = data[p + 1] - targetG;
        const db = data[p + 2] - targetB;
        const da = data[p + 3] - targetA;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db + (da * da) / 4);
        if (dist <= maxDist) {
          wandMask[i] = 255;
        }
      }
    } else {
      const visited = new Uint8Array(totalPixels);
      const queue: number[] = [sy * w + sx];
      visited[sy * w + sx] = 1;
      wandMask[sy * w + sx] = 255;

      let head = 0;
      while (head < queue.length) {
        const idx = queue[head++];
        const cy = Math.floor(idx / w);
        const cx = idx % w;

        const neighbors = [
          cx > 0 ? idx - 1 : -1,
          cx < w - 1 ? idx + 1 : -1,
          cy > 0 ? idx - w : -1,
          cy < h - 1 ? idx + w : -1,
        ];

        for (const nIdx of neighbors) {
          if (nIdx >= 0 && !visited[nIdx]) {
            visited[nIdx] = 1;
            const pIdx = nIdx * 4;
            const dr = data[pIdx] - targetR;
            const dg = data[pIdx + 1] - targetG;
            const db = data[pIdx + 2] - targetB;
            const da = data[pIdx + 3] - targetA;
            const dist = Math.sqrt(dr * dr + dg * dg + db * db + (da * da) / 4);

            if (dist <= maxDist) {
              wandMask[nIdx] = 255;
              queue.push(nIdx);
            }
          }
        }
      }
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tctx = tempCanvas.getContext('2d')!;
    const maskImgData = tctx.createImageData(w, h);
    const mData = maskImgData.data;

    for (let i = 0; i < totalPixels; i++) {
      if (wandMask[i] > 0) {
        const p = i * 4;
        mData[p] = 255;
        mData[p + 1] = 255;
        mData[p + 2] = 255;
        mData[p + 3] = 255;
      }
    }
    tctx.putImageData(maskImgData, 0, 0);

    if (settings.feather > 0) {
      this.applyFeatherToCanvas(tempCanvas, settings.feather);
      this.maskCtx.clearRect(0, 0, this.width, this.height);
      if (settings.mode !== 'replace') {
        this.maskCtx.drawImage(this.wandBaseMaskCanvas, 0, 0);
      }
      this.combineTempMask(tempCanvas, settings.mode);
      return;
    }

    // Wyodrębnij kontury z tempCanvas i przekształć na wektory z uproszczeniem prostokątnym
    this.rebuildContoursFromCanvas(tempCanvas);
    if (this.contourPolygons.length > 0) {
      const wandMultiPoly: MultiPolygon = [];
      for (const loop of this.contourPolygons) {
        if (loop.length < 3) continue;
        const rawRing: Pair[] = loop.map((pt) => [pt.x, pt.y]);
        const simpleRing = this.simplifyCollinearLoop(rawRing, 0.15);
        if (simpleRing.length >= 3) {
          wandMultiPoly.push([simpleRing]);
        }
      }
      if (wandMultiPoly.length > 0) {
        this.combineVectorGeometry(wandMultiPoly, settings.mode);
      }
    }
  }

  private simplifyCollinearLoop(points: Pair[], eps: number = 0.15): Pair[] {
    if (points.length < 3) return points;
    const closed =
      points[0][0] === points[points.length - 1][0] &&
      points[0][1] === points[points.length - 1][1];
    const pts = closed ? points.slice(0, points.length - 1) : points;

    if (pts.length < 3) return points;

    const res: Pair[] = [];
    const n = pts.length;

    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const curr = pts[i];
      const next = pts[(i + 1) % n];

      const dx = next[0] - prev[0];
      const dy = next[1] - prev[1];
      const lenSq = dx * dx + dy * dy;

      if (lenSq < 0.00001) continue;

      const cross = Math.abs((curr[1] - prev[1]) * dx - (curr[0] - prev[0]) * dy);
      const dist = cross / Math.sqrt(lenSq);

      if (dist > eps) {
        res.push(curr);
      }
    }

    if (res.length < 3) return points;
    res.push([res[0][0], res[0][1]]);
    return res;
  }

  private applyFeatherToCanvas(canvas: HTMLCanvasElement, featherRadius: number): void {
    if (featherRadius <= 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const blurCanvas = document.createElement('canvas');
    blurCanvas.width = this.width;
    blurCanvas.height = this.height;
    const bctx = blurCanvas.getContext('2d')!;

    bctx.filter = `blur(${Math.max(1, featherRadius)}px)`;
    bctx.drawImage(canvas, 0, 0);

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.drawImage(blurCanvas, 0, 0);
  }

  private combineTempMask(tempCanvas: HTMLCanvasElement, mode: SelectionCombineMode): void {
    const ctx = this.maskCtx;

    if (mode === 'replace') {
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(tempCanvas, 0, 0);
    } else if (mode === 'add') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(tempCanvas, 0, 0);
    } else if (mode === 'subtract') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(tempCanvas, 0, 0);
    } else if (mode === 'intersect') {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(tempCanvas, 0, 0);
    } else if (mode === 'invert') {
      ctx.globalCompositeOperation = 'xor';
      ctx.drawImage(tempCanvas, 0, 0);
    }

    ctx.globalCompositeOperation = 'source-over';

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
    this.rebuildContoursFromMask();
  }

  public rebuildContoursFromCanvas(srcCanvas: HTMLCanvasElement): void {
    const ctx = srcCanvas.getContext('2d');
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, this.width, this.height);
    this.extractMarchingSquares(imgData);
  }

  public rebuildContoursFromMask(searchBounds?: SKRectI | null): void {
    if (!this.hasActiveSelection) {
      this.contourPath = new Path2D();
      this.contourPolygons = [];
      return;
    }
    const imgData = this.maskCtx.getImageData(0, 0, this.width, this.height);
    this.extractMarchingSquares(imgData, searchBounds);
  }

  private extractMarchingSquares(imgData: ImageData, searchBounds?: SKRectI | null): void {
    this.contourPath = new Path2D();
    this.contourPolygons = [];

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

    const data = imgData.data;

    const getAlpha = (x: number, y: number): number => {
      if (x < 0 || x >= w || y < 0 || y >= h) return 0;
      return data[(y * w + x) * 4 + 3];
    };

    const T = 127.5;

    interface DirectedSegment {
      p1: SKPoint;
      p2: SKPoint;
    }

    const segments: DirectedSegment[] = [];

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const v0 = getAlpha(x, y);         // TL
        const v1 = getAlpha(x + 1, y);     // TR
        const v2 = getAlpha(x + 1, y + 1); // BR
        const v3 = getAlpha(x, y + 1);     // BL

        let caseIdx = 0;
        if (v0 >= T) caseIdx |= 1;
        if (v1 >= T) caseIdx |= 2;
        if (v2 >= T) caseIdx |= 4;
        if (v3 >= T) caseIdx |= 8;

        if (caseIdx === 0 || caseIdx === 15) continue;

        const topT = Math.max(0.01, Math.min(0.99, (T - v0) / (v1 - v0 || 0.0001)));
        const rightT = Math.max(0.01, Math.min(0.99, (T - v1) / (v2 - v1 || 0.0001)));
        const bottomT = Math.max(0.01, Math.min(0.99, (T - v3) / (v2 - v3 || 0.0001)));
        const leftT = Math.max(0.01, Math.min(0.99, (T - v0) / (v3 - v0 || 0.0001)));

        const pTop: SKPoint = { x: x + 0.5 + topT, y: y + 0.5 };
        const pRight: SKPoint = { x: x + 1.5, y: y + 0.5 + rightT };
        const pBottom: SKPoint = { x: x + 0.5 + bottomT, y: y + 1.5 };
        const pLeft: SKPoint = { x: x + 0.5, y: y + 0.5 + leftT };

        switch (caseIdx) {
          case 1:  segments.push({ p1: pLeft, p2: pTop }); break;
          case 2:  segments.push({ p1: pTop, p2: pRight }); break;
          case 3:  segments.push({ p1: pLeft, p2: pRight }); break;
          case 4:  segments.push({ p1: pRight, p2: pBottom }); break;
          case 5:
            segments.push({ p1: pLeft, p2: pTop });
            segments.push({ p1: pRight, p2: pBottom });
            break;
          case 6:  segments.push({ p1: pTop, p2: pBottom }); break;
          case 7:  segments.push({ p1: pLeft, p2: pBottom }); break;
          case 8:  segments.push({ p1: pBottom, p2: pLeft }); break;
          case 9:  segments.push({ p1: pBottom, p2: pTop }); break;
          case 10:
            segments.push({ p1: pTop, p2: pRight });
            segments.push({ p1: pBottom, p2: pLeft });
            break;
          case 11: segments.push({ p1: pBottom, p2: pRight }); break;
          case 12: segments.push({ p1: pRight, p2: pLeft }); break;
          case 13: segments.push({ p1: pRight, p2: pTop }); break;
          case 14: segments.push({ p1: pTop, p2: pLeft }); break;
        }
      }
    }

    if (segments.length === 0) return;

    const used = new Uint8Array(segments.length);
    const EPS = 0.05;

    for (let i = 0; i < segments.length; i++) {
      if (used[i]) continue;

      const loop: SKPoint[] = [segments[i].p1, segments[i].p2];
      used[i] = 1;
      let curr = segments[i].p2;

      let safety = 20000;
      while (safety-- > 0) {
        let nearestIdx = -1;
        let nearestDist = 0.8;

        for (let j = 0; j < segments.length; j++) {
          if (!used[j]) {
            const d = Math.hypot(segments[j].p1.x - curr.x, segments[j].p1.y - curr.y);
            if (d < nearestDist) {
              nearestDist = d;
              nearestIdx = j;
              if (d < EPS) break;
            }
          }
        }

        if (nearestIdx >= 0) {
          used[nearestIdx] = 1;
          loop.push(segments[nearestIdx].p2);
          curr = segments[nearestIdx].p2;

          if (Math.hypot(curr.x - loop[0].x, curr.y - loop[0].y) < 0.8) {
            break;
          }
        } else {
          break;
        }
      }

      if (loop.length >= 3) {
        this.contourPolygons.push(loop);
        this.contourPath.moveTo(loop[0].x, loop[0].y);
        for (let k = 1; k < loop.length; k++) {
          this.contourPath.lineTo(loop[k].x, loop[k].y);
        }
        this.contourPath.closePath();
      }
    }
  }
}
