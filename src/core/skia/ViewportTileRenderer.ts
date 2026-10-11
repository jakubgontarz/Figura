/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GraphicEngine } from './GraphicEngine.ts';
import { SKBlendMode, SKRectI, getCanvasCompositeOperation } from './types.ts';
import { markWindowedContext } from './VectorRenderer.ts';

/**
 * Szybki, przerywalny renderer podglądu edycji (figury, linie, krzywe, tekst, gradient) dla płótna dowolnej wielkości.
 *
 * Zasady działania:
 *  - Jednostka podziału ma VIEW_TILE_SIZE (128) px:
 *      * zoom < 100%  -> w pikselach EKRANU (render w rozdzielczości ekranu, koszt kafelka ograniczony do ~128x128 px),
 *      * zoom >= 100% -> w pikselach PŁÓTNA (render w rozdzielczości dokumentu i powiększenie; mały widok nie jest
 *                        dzielony na setki kafelków, a wynik jest dokładnie tym, co powstanie po zatwierdzeniu).
 *  - Odświeżany jest tylko prostokątny blok jednostek przecinający: obszar figury ∩ widoczny dokument ∩ bbox zaznaczenia.
 *    Wszystko poza blokiem jest natychmiast czyszczone (odsłania płótno dokumentu), więc po pan/zoom nie zostają
 *    resztki starego podglądu.
 *  - Praca jest dzielona na zadania (prostokątne grupy jednostek). Rozmiar zadania dobierany jest do budżetu klatki
 *    z zmierzonej szybkości renderowania: mały obraz to jedno zadanie w jednej klatce (zmiana pojawia się od razu,
 *    bez migotania kafelków), duży to wiele zadań sortowanych promieniowo od kursora.
 *  - Renderowanie odbywa się w callbackach requestAnimationFrame: w jednej klatce wykonuje się tyle zadań, ile mieści się
 *    w budżecie czasu, a efekt jest malowany razem (atomowo). Każda nowa prośba (ruch myszy) unieważnia kolejkę,
 *    a pętla przerywa się też, gdy isInputPending zgłasza zdarzenie wejścia.
 *  - Brak buforów pośrednich odbudowywanych przy zmianie: zadanie składa się bezpośrednio z kafelków warstw.
 *
 * Płótno kafelków leży nad płótnem dokumentu. Obszary bez podglądu pozostają przezroczyste i odsłaniają płótno dokumentu.
 */

export const VIEW_TILE_SIZE = 128;

/**
 * Jeśli szacowany koszt odświeżenia całego bloku jest nie większy niż tyle (ms), idzie on jako JEDNO zadanie
 * i pojawia się na ekranie naraz (jak przed kafelkowaniem). Dopiero większe obszary są dzielone na zadania
 * mieszczące się w budżecie klatki.
 */
const ATOMIC_MAX_MS = 25;

/** Górny limit rastra jednego zadania (piksele) - chroni przed ogromnymi buforami. */
const MAX_JOB_RASTER_PX = 1024 * 1024;

export interface TileViewState {
  zoom: number;
  /** Położenie lewego górnego rogu dokumentu na ekranie (piksele całkowite) */
  left: number;
  top: number;
  /** Rozmiar widoku (płótna kafelków) */
  width: number;
  height: number;
}

export interface TilePreview {
  /** Rysuje podgląd w układzie dokumentu; kontekst ma ustawioną transformację dokument -> raster */
  render: (ctx: CanvasRenderingContext2D) => void;
  blendMode: SKBlendMode;
  /** Obszar zajmowany przez podgląd (układ dokumentu, razem z marginesami) */
  bounds: SKRectI | null;
}

export interface TileRequest {
  view: TileViewState;
  preview: TilePreview;
  /** Punkt, od którego zadania są renderowane promieniowo (współrzędne ekranu) */
  focus: { x: number; y: number } | null;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Zadanie: prostokątna grupa jednostek [ux0..ux1] x [uy0..uy1] (włącznie). */
interface Job {
  ux0: number;
  uy0: number;
  ux1: number;
  uy1: number;
  d: number;
}

const makeCanvas = (): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: false })!;
  return { canvas, ctx };
};

export class ViewportTileRenderer {
  private readonly engine: GraphicEngine;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  // Bufory robocze jednego zadania (zmieniają rozmiar tylko gdy zmieni się rozmiar zadania)
  private readonly raster = makeCanvas();
  private readonly layerBuf = makeCanvas();
  private readonly previewBuf = makeCanvas();
  private readonly snap = makeCanvas();

  private generation = 0;
  private queue: Job[] = [];
  private rafId = 0;
  private timerId = 0;
  private idleWaiters: Array<() => void> = [];

  private view: TileViewState | null = null;
  private preview: TilePreview | null = null;
  private docMode = false;

  // Zmierzone parametry wydajności (adaptacja do maszyny i obciążenia)
  private msPerKpx = 0.08; // ms na 1000 pikseli rastra (z narzutem); korygowane pomiarami
  private frameInterval = 16.7; // ms między klatkami (rAF)
  private lastRafTs = 0;
  private jobsThisFrame = 0;

  private selCacheRef: unknown = null;
  private selCacheRect: Rect | null = null;

  public tilesRendered = 0;
  public jobsRendered = 0;

  constructor(canvas: HTMLCanvasElement, engine: GraphicEngine) {
    this.canvas = canvas;
    this.engine = engine;
    this.ctx = canvas.getContext('2d')!;
  }

  public isIdle(): boolean {
    return this.queue.length === 0;
  }

  /** Promise rozwiązywana, gdy kolejka jest pusta (używane w testach). */
  public whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  public dispose(): void {
    this.generation++;
    this.queue = [];
    this.cancelScheduled();
  }

  /** Usuwa podgląd (cały obszar staje się przezroczysty) i przerywa renderowanie. */
  public clear(): void {
    this.generation++;
    this.queue = [];
    this.preview = null;
    this.view = null;
    this.cancelScheduled();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.flushIdle();
  }

  /** Budżet czasu na jedną klatkę: ok. połowy odstępu między klatkami (ms). */
  private frameBudget(): number {
    return Math.min(12, Math.max(4, this.frameInterval * 0.6));
  }

  /**
   * Nowa prośba o odświeżenie podglądu. Natychmiast unieważnia poprzednią kolejkę.
   */
  public request(req: TileRequest): void {
    this.generation++;
    const v = req.view;
    const prev = this.view;
    const T = VIEW_TILE_SIZE;
    const z = v.zoom;

    // --- dopasowanie płótna do widoku, zachowanie zawartości na czas renderu (brak migotania) ---
    if (this.canvas.width !== v.width || this.canvas.height !== v.height) {
      this.canvas.width = v.width;
      this.canvas.height = v.height;
    } else if (prev && (prev.left !== v.left || prev.top !== v.top || prev.zoom !== v.zoom)) {
      this.transformExistingContent(prev, v);
    }

    this.view = v;
    this.preview = req.preview;
    this.docMode = z >= 1;
    this.queue = [];

    const eff = this.computeEffective(req.preview.bounds, v);
    if (!eff) {
      this.ctx.clearRect(0, 0, v.width, v.height);
      this.flushIdle();
      return;
    }

    // --- zakres jednostek (blok) przecinający obszar podglądu ---
    let ux0: number, uy0: number, ux1: number, uy1: number;
    if (this.docMode) {
      ux0 = Math.floor(eff.x0 / T);
      uy0 = Math.floor(eff.y0 / T);
      ux1 = Math.floor((eff.x1 - 1) / T);
      uy1 = Math.floor((eff.y1 - 1) / T);
    } else {
      const sx0 = Math.max(0, Math.floor(v.left + eff.x0 * z) - 1);
      const sy0 = Math.max(0, Math.floor(v.top + eff.y0 * z) - 1);
      const sx1 = Math.min(v.width, Math.ceil(v.left + eff.x1 * z) + 1);
      const sy1 = Math.min(v.height, Math.ceil(v.top + eff.y1 * z) + 1);
      if (sx1 <= sx0 || sy1 <= sy0) {
        this.ctx.clearRect(0, 0, v.width, v.height);
        this.flushIdle();
        return;
      }
      ux0 = Math.floor(sx0 / T);
      uy0 = Math.floor(sy0 / T);
      ux1 = Math.floor((sx1 - 1) / T);
      uy1 = Math.floor((sy1 - 1) / T);
    }

    // --- wszystko poza blokiem czyścimy od razu (odsłania płótno dokumentu, usuwa resztki starego podglądu) ---
    const blk = this.unitRectToScreen(ux0, uy0, ux1, uy1);
    this.clearOutside(blk);

    // --- grupowanie jednostek w zadania o rozmiarze dopasowanym do budżetu klatki ---
    const nx = ux1 - ux0 + 1;
    const ny = uy1 - uy0 + 1;
    const unitPx = T * T;
    const budget = this.frameBudget();
    const estAll = (this.msPerKpx * nx * ny * unitPx) / 1000;
    let gx = nx;
    let gy = ny;
    if (estAll > ATOMIC_MAX_MS) {
      const perUnit = (this.msPerKpx * unitPx) / 1000;
      // jedno zadanie ~ 80% budżetu klatki: duże zadania amortyzują narzut (alokacje buforów, getImageData)
      const k = Math.max(1, Math.floor((budget * 0.8) / Math.max(1e-6, perUnit)));
      gx = Math.max(1, Math.min(nx, Math.round(Math.sqrt(k))));
      gy = Math.max(1, Math.min(ny, Math.floor(k / gx)));
    }
    const maxUnits = Math.max(1, Math.floor(MAX_JOB_RASTER_PX / unitPx));
    while (gx * gy > maxUnits) {
      if (gx >= gy) gx = Math.max(1, gx - 1);
      else gy = Math.max(1, gy - 1);
    }

    const cx = req.focus ? req.focus.x : (blk.x0 + blk.x1) / 2;
    const cy = req.focus ? req.focus.y : (blk.y0 + blk.y1) / 2;
    const jobs: Job[] = [];
    for (let jy = uy0; jy <= uy1; jy += gy) {
      for (let jx = ux0; jx <= ux1; jx += gx) {
        const job: Job = { ux0: jx, uy0: jy, ux1: Math.min(jx + gx - 1, ux1), uy1: Math.min(jy + gy - 1, uy1), d: 0 };
        const r = this.unitRectToScreen(job.ux0, job.uy0, job.ux1, job.uy1);
        const dx = (r.x0 + r.x1) / 2 - cx;
        const dy = (r.y0 + r.y1) / 2 - cy;
        job.d = dx * dx + dy * dy;
        jobs.push(job);
      }
    }
    jobs.sort((a, b) => a.d - b.d);
    this.queue = jobs;

    if (this.queue.length > 0) this.schedule();
    else this.flushIdle();
  }

  // ------------------------------------------------------------------------------------------------
  // Planowanie (rytm klatek)
  // ------------------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.rafId || this.timerId) return;
    this.rafId = requestAnimationFrame((ts) => {
      this.rafId = 0;
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = 0;
      }
      this.run(ts);
    });
    // Zapasowo, gdy karta jest w tle i rAF nie jest wywoływane
    this.timerId = window.setTimeout(() => {
      this.timerId = 0;
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
      this.run(performance.now());
    }, 100);
  }

  private cancelScheduled(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.timerId) clearTimeout(this.timerId);
    this.rafId = 0;
    this.timerId = 0;
  }

  private flushIdle(): void {
    if (this.queue.length > 0 || this.idleWaiters.length === 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Jedna klatka pracy: wykonuje tyle zadań, ile mieści się w budżecie czasu. Wszystkie zmiany trafiają na ekran razem
   * (malowanie następuje po zakończeniu callbacku), więc mały obraz odświeża się od razu, a nie kafelek po kafelku.
   */
  private run(ts: number): void {
    if (this.lastRafTs > 0) {
      const dt = ts - this.lastRafTs;
      if (dt > 4 && dt < 100) this.frameInterval = Math.min(34, Math.max(6, this.frameInterval * 0.8 + dt * 0.2));
    }
    this.lastRafTs = ts;

    const gen = this.generation;
    const t0 = performance.now();
    const budget = this.frameBudget();
    this.jobsThisFrame = 0;
    const sched = (navigator as unknown as { scheduling?: { isInputPending?: () => boolean } }).scheduling;

    while (this.queue.length > 0) {
      // Pierwsze zadanie w klatce zawsze; kolejne tylko jeśli według pomiarów zmieści się w budżecie
      if (this.jobsThisFrame > 0) {
        const next = this.queue[0];
        const units = (next.ux1 - next.ux0 + 1) * (next.uy1 - next.uy0 + 1);
        const predicted = (this.msPerKpx * units * VIEW_TILE_SIZE * VIEW_TILE_SIZE) / 1000;
        if (performance.now() - t0 + predicted > budget) break;
      }
      const job = this.queue.shift()!;
      this.jobsThisFrame++;
      try {
        this.renderJob(job);
      } catch (err) {
        console.error('ViewportTileRenderer: błąd renderowania zadania', err);
      }
      if (gen !== this.generation) break;
      // Zdarzenie wejścia (mysz/klawiatura) czeka: oddaj sterowanie, resztę dokończymy w następnej klatce
      if (sched?.isInputPending?.()) break;
    }

    if (this.queue.length > 0) this.schedule();
    else this.flushIdle();
  }

  // ------------------------------------------------------------------------------------------------
  // Geometria
  // ------------------------------------------------------------------------------------------------

  /** Widoczny fragment dokumentu (piksele całkowite, przycięty do dokumentu). */
  private visibleDocRect(v: TileViewState): Rect {
    const z = v.zoom;
    return {
      x0: Math.max(0, Math.floor((0 - v.left) / z)),
      y0: Math.max(0, Math.floor((0 - v.top) / z)),
      x1: Math.min(this.engine.width, Math.ceil((v.width - v.left) / z)),
      y1: Math.min(this.engine.height, Math.ceil((v.height - v.top) / z)),
    };
  }

  /** Obszar podglądu przycięty do dokumentu, widocznego okna i prostokąta opisanego na zaznaczeniu. */
  private computeEffective(bounds: SKRectI | null, v: TileViewState): Rect | null {
    if (!bounds) return null;
    const e = this.engine;
    let r: Rect = {
      x0: Math.max(0, bounds.left),
      y0: Math.max(0, bounds.top),
      x1: Math.min(e.width, bounds.right),
      y1: Math.min(e.height, bounds.bottom),
    };
    const vis = this.visibleDocRect(v);
    r = this.intersect(r, { x0: vis.x0 - 2, y0: vis.y0 - 2, x1: vis.x1 + 2, y1: vis.y1 + 2 });

    const sel = this.getSelectionRect();
    if (sel !== undefined) {
      if (sel === null) return null; // zaznaczenie puste: podgląd i tak byłby w pełni zamaskowany
      r = this.intersect(r, sel);
    }
    return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
  }

  private intersect(a: Rect, b: Rect): Rect {
    return {
      x0: Math.max(a.x0, b.x0),
      y0: Math.max(a.y0, b.y0),
      x1: Math.min(a.x1, b.x1),
      y1: Math.min(a.y1, b.y1),
    };
  }

  /**
   * Prostokąt opisany na zaznaczeniu. undefined = brak zaznaczenia (bez ograniczenia), null = puste.
   * Liczony z wielokątów konturu (tanio), a nie ze skanu milionów pikseli maski.
   */
  private getSelectionRect(): Rect | null | undefined {
    const sm = this.engine.selectionManager;
    if (!sm.hasActiveSelection) return undefined;
    const polys = sm.contourPolygons;
    if (this.selCacheRef === polys) return this.selCacheRect;

    let rect: Rect | null = null;
    if (polys.length > 0) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const loop of polys) {
        for (const p of loop) {
          if (p.x < x0) x0 = p.x;
          if (p.y < y0) y0 = p.y;
          if (p.x > x1) x1 = p.x;
          if (p.y > y1) y1 = p.y;
        }
      }
      if (x1 >= x0 && y1 >= y0) {
        rect = { x0: Math.floor(x0) - 2, y0: Math.floor(y0) - 2, x1: Math.ceil(x1) + 2, y1: Math.ceil(y1) + 2 };
      }
    } else {
      const b = sm.getSelectionBounds();
      if (b) rect = { x0: b.left - 1, y0: b.top - 1, x1: b.right + 1, y1: b.bottom + 1 };
    }
    this.selCacheRef = polys;
    this.selCacheRect = rect;
    return rect;
  }

  /**
   * Prostokąt ekranowy (liczby całkowite) pokrywany przez grupę jednostek. Sąsiednie grupy mają wspólne krawędzie,
   * więc przy zoomie ułamkowym nie powstają szwy.
   */
  private unitRectToScreen(ux0: number, uy0: number, ux1: number, uy1: number): Rect {
    const v = this.view!;
    const T = VIEW_TILE_SIZE;
    const z = v.zoom;
    if (this.docMode) {
      const vis = this.visibleDocRect(v);
      const dx0 = Math.max(ux0 * T, vis.x0);
      const dy0 = Math.max(uy0 * T, vis.y0);
      const dx1 = Math.min((ux1 + 1) * T, vis.x1);
      const dy1 = Math.min((uy1 + 1) * T, vis.y1);
      return {
        x0: Math.max(0, Math.round(v.left + dx0 * z)),
        y0: Math.max(0, Math.round(v.top + dy0 * z)),
        x1: Math.min(v.width, Math.round(v.left + dx1 * z)),
        y1: Math.min(v.height, Math.round(v.top + dy1 * z)),
      };
    }
    const eng = this.engine;
    return {
      x0: Math.max(ux0 * T, Math.ceil(v.left), 0),
      y0: Math.max(uy0 * T, Math.ceil(v.top), 0),
      x1: Math.min((ux1 + 1) * T, v.width, Math.floor(v.left + eng.width * z)),
      y1: Math.min((uy1 + 1) * T, v.height, Math.floor(v.top + eng.height * z)),
    };
  }

  /** Czyści płótno poza prostokątem bloku (cztery pasy). */
  private clearOutside(b: Rect): void {
    const c = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const x0 = Math.min(W, Math.max(0, b.x0));
    const x1 = Math.min(W, Math.max(x0, b.x1));
    const y0 = Math.min(H, Math.max(0, b.y0));
    const y1 = Math.min(H, Math.max(y0, b.y1));
    c.clearRect(0, 0, W, y0);
    c.clearRect(0, y1, W, H - y1);
    c.clearRect(0, y0, x0, y1 - y0);
    c.clearRect(x1, y0, W - x1, y1 - y0);
  }

  /** Przesunięcie / skalowanie dotychczasowej zawartości przy pan i zoom, żeby podgląd nie znikał na czas renderu. */
  private transformExistingContent(prev: TileViewState, next: TileViewState): void {
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sn = this.snap;
    if (sn.canvas.width !== W || sn.canvas.height !== H) {
      sn.canvas.width = W;
      sn.canvas.height = H;
    } else {
      sn.ctx.clearRect(0, 0, W, H);
    }
    sn.ctx.drawImage(this.canvas, 0, 0);
    this.ctx.clearRect(0, 0, W, H);
    this.ctx.imageSmoothingEnabled = false;
    if (prev.zoom === next.zoom) {
      this.ctx.drawImage(sn.canvas, next.left - prev.left, next.top - prev.top);
    } else {
      const zr = next.zoom / prev.zoom;
      this.ctx.drawImage(sn.canvas, next.left - prev.left * zr, next.top - prev.top * zr, W * zr, H * zr);
    }
  }

  // ------------------------------------------------------------------------------------------------
  // Render jednego zadania
  // ------------------------------------------------------------------------------------------------

  private sizeBuf(buf: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }, w: number, h: number): void {
    if (buf.canvas.width !== w || buf.canvas.height !== h) {
      buf.canvas.width = w;
      buf.canvas.height = h;
    } else {
      buf.ctx.setTransform(1, 0, 0, 1, 0, 0);
      buf.ctx.globalAlpha = 1;
      buf.ctx.globalCompositeOperation = 'source-over';
      buf.ctx.clearRect(0, 0, w, h);
    }
  }

  private drawLayerTiles(
    c: CanvasRenderingContext2D,
    layer: GraphicEngine['layers'][number],
    ox: number,
    oy: number,
    s: number,
    rw: number,
    rh: number
  ): void {
    const left = Math.floor(ox) - 1;
    const top = Math.floor(oy) - 1;
    const right = Math.ceil(ox + rw / s) + 1;
    const bottom = Math.ceil(oy + rh / s) + 1;
    const tiles = layer.tileGrid.getTilesIntersectingRect({
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    });
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'low';
    for (const tile of tiles) {
      if (!tile.hasContent) continue;
      // Docelowe prostokąty zaokrąglane do pikseli rastra: brak szwów między sąsiednimi kafelkami warstwy
      const x0 = Math.round((tile.pixelX - ox) * s);
      const y0 = Math.round((tile.pixelY - oy) * s);
      const x1 = Math.round((tile.pixelX + tile.width - ox) * s);
      const y1 = Math.round((tile.pixelY + tile.height - oy) * s);
      if (x1 <= x0 || y1 <= y0) continue;
      c.drawImage(tile.canvas, 0, 0, tile.width, tile.height, x0, y0, x1 - x0, y1 - y0);
    }
  }

  private renderJob(job: Job): void {
    const v = this.view;
    const preview = this.preview;
    if (!v || !preview) return;
    const eng = this.engine;
    const T = VIEW_TILE_SIZE;
    const z = v.zoom;

    // Prostokąt ekranowy zadania (całkowity) - obszar, który zostanie zastąpiony
    const clip = this.unitRectToScreen(job.ux0, job.uy0, job.ux1, job.uy1);
    if (clip.x1 <= clip.x0 || clip.y1 <= clip.y0) return;

    // Parametry rastra: dokument -> raster to x_r = (x - ox) * s
    let ox: number, oy: number, s: number, rw: number, rh: number;
    if (this.docMode) {
      const vis = this.visibleDocRect(v);
      const dx0 = Math.max(job.ux0 * T, vis.x0);
      const dy0 = Math.max(job.uy0 * T, vis.y0);
      const dx1 = Math.min((job.ux1 + 1) * T, vis.x1);
      const dy1 = Math.min((job.uy1 + 1) * T, vis.y1);
      if (dx1 <= dx0 || dy1 <= dy0) return;
      // margines 1 px, żeby filtrowanie przy powiększeniu 1-2x było poprawne na styku zadań
      ox = Math.max(0, dx0 - 1);
      oy = Math.max(0, dy0 - 1);
      s = 1;
      rw = Math.min(eng.width, dx1 + 1) - ox;
      rh = Math.min(eng.height, dy1 + 1) - oy;
    } else {
      s = z;
      ox = (clip.x0 - v.left) / z;
      oy = (clip.y0 - v.top) / z;
      rw = clip.x1 - clip.x0;
      rh = clip.y1 - clip.y0;
    }
    if (rw <= 0 || rh <= 0) return;

    const tStart = performance.now();

    const rc = this.raster;
    this.sizeBuf(rc, rw, rh);
    const r = rc.ctx;

    const hasSel = eng.selectionManager.hasActiveSelection;
    const maskCanvas = eng.selectionManager.maskCanvas;

    for (let i = 0; i < eng.layers.length; i++) {
      const layer = eng.layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;

      if (i !== eng.activeLayerIndex) {
        r.save();
        r.globalAlpha = layer.opacity;
        r.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        this.drawLayerTiles(r, layer, ox, oy, s, rw, rh);
        r.restore();
        continue;
      }

      // Aktywna warstwa + podgląd (z maską zaznaczenia i trybem mieszania narzędzia)
      const lb = this.layerBuf;
      this.sizeBuf(lb, rw, rh);
      this.drawLayerTiles(lb.ctx, layer, ox, oy, s, rw, rh);

      const pb = this.previewBuf;
      this.sizeBuf(pb, rw, rh);
      markWindowedContext(pb.ctx);
      pb.ctx.setTransform(s, 0, 0, s, -ox * s, -oy * s);
      preview.render(pb.ctx);
      pb.ctx.setTransform(1, 0, 0, 1, 0, 0);

      if (hasSel) {
        pb.ctx.save();
        pb.ctx.globalCompositeOperation = 'destination-in';
        pb.ctx.imageSmoothingEnabled = s < 1;
        const srcW = Math.min(rw / s, maskCanvas.width - ox);
        const srcH = Math.min(rh / s, maskCanvas.height - oy);
        if (srcW > 0 && srcH > 0) {
          pb.ctx.drawImage(maskCanvas, ox, oy, srcW, srcH, 0, 0, srcW * s, srcH * s);
        }
        pb.ctx.restore();
      }

      lb.ctx.save();
      lb.ctx.globalCompositeOperation = getCanvasCompositeOperation(preview.blendMode);
      lb.ctx.drawImage(pb.canvas, 0, 0);
      lb.ctx.restore();

      r.save();
      r.globalAlpha = layer.opacity;
      r.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
      r.drawImage(lb.canvas, 0, 0);
      r.restore();
    }

    // --- wyświetlenie (zadanie zastępuje swój prostokąt w całości) ---
    const d = this.ctx;
    d.clearRect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
    if (this.docMode) {
      d.save();
      d.beginPath();
      d.rect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
      d.clip();
      d.imageSmoothingEnabled = z < 2;
      d.drawImage(rc.canvas, 0, 0, rw, rh, v.left + ox * z, v.top + oy * z, rw * z, rh * z);
      d.restore();
    } else {
      d.drawImage(rc.canvas, 0, 0, rw, rh, clip.x0, clip.y0, rw, rh);
    }

    // Adaptacja szacunku kosztu (do doboru rozmiaru zadań w kolejnych prośbach)
    const elapsed = performance.now() - tStart;
    const kpx = (rw * rh) / 1000;
    if (kpx > 0.5) this.msPerKpx = this.msPerKpx * 0.7 + (elapsed / kpx) * 0.3;
    this.jobsRendered++;
    this.tilesRendered++;
  }
}

// ------------------------------------------------------------------------------------------------
// Obszary zajmowane przez podgląd (układ dokumentu) - do wyznaczania dirty rect
// ------------------------------------------------------------------------------------------------

const toRectI = (x0: number, y0: number, x1: number, y1: number): SKRectI => {
  const left = Math.floor(x0);
  const top = Math.floor(y0);
  const right = Math.ceil(x1);
  const bottom = Math.ceil(y1);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
};

/** Linia i krzywa: prostokąt opisany na punktach + ten sam margines, którego używa renderer (grubość, markery). */
export function boundsForPoints(
  pts: Array<{ x: number; y: number }>,
  strokeWidth: number,
  markerSize: number | undefined
): SKRectI {
  const sw = Math.max(1, Math.round(strokeWidth));
  const pad = Math.max(30, sw * (markerSize || 1.0) * 4 + 30);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return toRectI(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
}

/** Obrócony prostokąt w x h wokół środka + margines `ext` (obrys, ostre naroża, wygładzanie). */
export function boundsForRotatedBox(
  center: { x: number; y: number },
  width: number,
  height: number,
  angle: number,
  ext: number
): SKRectI {
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  const hx = (width * c + height * s) / 2 + ext;
  const hy = (width * s + height * c) / 2 + ext;
  return toRectI(center.x - hx, center.y - hy, center.x + hx, center.y + hy);
}

/** Figura: obrys może wystawać poza ramkę (wyrównanie na zewnątrz, miter przy ostrych narożach gwiazdy). */
export function boundsForShape(
  center: { x: number; y: number },
  width: number,
  height: number,
  angle: number,
  strokeWidth: number
): SKRectI {
  return boundsForRotatedBox(center, width, height, angle, Math.max(0, strokeWidth) * 5 + 4);
}
