/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { VectorObject, cloneVectorObjects } from './VectorObjects.ts';
import { TileGrid } from './TileGrid.ts';
import { Tile } from './Tile.ts';
import { SKBlendMode, SKColor } from './types.ts';
import { Correction, cloneCorrections } from './Corrections.ts';
import { Chain, FxContext, chainGpuSupported, chainMargin, compileChain, runChain, runChainInSession, runChainOnCanvas } from './Filters.ts';
import { LayerStyles, StyleFx, cloneStyles, styleOn, stylesActive } from './Styles.ts';

const layerTileUids = new WeakMap<object, number>();
let layerTileUidNext = 1;
const tileUidOf = (t: object): number => {
  let id = layerTileUids.get(t);
  if (id === undefined) {
    id = layerTileUidNext++;
    layerTileUids.set(t, id);
  }
  return id;
};

let corrVersionCounter = 0;


// --- Odroczone odświeżanie miniatur ---
// Miniatura nie jest potrzebna w trakcie edycji, więc odświeżanie jest scalane (debounce), wykonywane
// po jednej warstwie na zadanie i wstrzymywane, gdy czeka zdarzenie wejścia. Panel warstw dostaje powiadomienie.
const THUMB_MAX_W = 35;
const THUMB_MAX_H = 35;
const THUMB_DEBOUNCE_MS = 150;
const THUMB_MAX_WAIT_MS = 900;
const pendingThumbs = new Set<Layer>();
const urgentThumbs = new Set<Layer>();
const thumbListeners = new Set<() => void>();
let thumbTimer: ReturnType<typeof setTimeout> | null = null;
let thumbFirstAt = 0;

export function subscribeThumbnails(cb: () => void): () => void {
  thumbListeners.add(cb);
  return () => {
    thumbListeners.delete(cb);
  };
}

function armThumbTimer(delay: number): void {
  if (thumbTimer !== null) clearTimeout(thumbTimer);
  thumbTimer = setTimeout(pumpThumbs, delay);
}

function scheduleThumb(layer: Layer, urgent: boolean): void {
  (urgent ? urgentThumbs : pendingThumbs).add(layer);
  const now = performance.now();
  if (!thumbFirstAt) thumbFirstAt = now;
  armThumbTimer(Math.max(0, Math.min(THUMB_DEBOUNCE_MS, thumbFirstAt + THUMB_MAX_WAIT_MS - now)));
}

function pumpThumbs(): void {
  thumbTimer = null;
  const sched = (navigator as unknown as { scheduling?: { isInputPending?: () => boolean } }).scheduling;
  if (sched?.isInputPending?.()) {
    armThumbTimer(40);
    return;
  }
  const src = urgentThumbs.size > 0 ? urgentThumbs : pendingThumbs;
  const next = src.values().next();
  if (!next.done) {
    src.delete(next.value);
    pendingThumbs.delete(next.value);
    next.value.refreshThumbnail();
  }
  if (urgentThumbs.size > 0 || pendingThumbs.size > 0) {
    armThumbTimer(2);
    return;
  }
  thumbFirstAt = 0;
  for (const cb of Array.from(thumbListeners)) cb();
}

/**
 * Domyka grupę w trybie „Przepuszczanie” z krytem lub maską: kontekst `ctx` w prostokącie (x, y, w, h) zawiera już wynik
 * rysowania warstw grupy NA tle, `snapshot` to to samo tło sprzed grupy, a `alpha` (w x h) to krycie * maska grupy.
 * Wynik = tło * (1 - a) + wynik * a (w przestrzeni z mnożeniem alfa, więc także przy półprzezroczystym tle).
 */
export function finishPassThrough(
  ctx: CanvasRenderingContext2D,
  snapshot: HTMLCanvasElement,
  alpha: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const cur = document.createElement('canvas');
  cur.width = w;
  cur.height = h;
  const cctx = cur.getContext('2d')!;
  cctx.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
  cctx.globalCompositeOperation = 'destination-in';
  cctx.drawImage(alpha, 0, 0);
  const bg = document.createElement('canvas');
  bg.width = w;
  bg.height = h;
  const bctx = bg.getContext('2d')!;
  bctx.drawImage(snapshot, 0, 0);
  bctx.globalCompositeOperation = 'destination-out';
  bctx.drawImage(alpha, 0, 0);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(x, y, w, h);
  ctx.drawImage(bg, x, y);
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(cur, x, y);
  ctx.restore();
}

/** Zamienia piksele RGBA (maska w skali szarości) na kanał alfa: alfa = luminancja * alfa / 255. */
export function grayToAlpha(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = 0;
    d[i + 3] = Math.round((lum * a) / 255);
  }
}

/**
 * Odpowiednik warstwy (Layer) w Paint.NET / SkiaSharp WPF.
 * Każda warstwa posiada własną siatkę kafelków (TileGrid),
 * parametry przezroczystości (opacity) oraz tryb mieszania (blendMode).
 */
export class Layer {
  public id: string;
  public name: string;
  private _visible: boolean = true;
  private _locked: boolean = false;
  /** Grupa warstw: nagłówek grupy (bez pikseli) leży w tablicy ZA (nad) swoimi dziećmi. */
  public isGroup: boolean = false;
  /**
   * Korekcja samodzielna w stosie (jak warstwa dopasowania): nie ma pikseli, a jej jedyna korekcja (`corrections[0]`)
   * działa na wszystko, co leży pod nią w tym samym kontenerze (grupie albo na poziomie głównym).
   */
  public isAdjustment: boolean = false;
  /**
   * Warstwa wektorowa: piksele są pochodną listy `vectorObjects` (silnik przebudowuje je po każdej zmianie listy),
   * więc narzędzia rastrowe jej nie dotykają, a korekcje, filtry, maska i style działają jak na zwykłej warstwie.
   */
  public isVector: boolean = false;
  /** Obiekty warstwy wektorowej od najniższego do najwyższego (kolejność rysowania). */
  public vectorObjects: VectorObject[] = [];
  /** Id nagłówka grupy, do której należy warstwa (null = poziom główny). */
  public groupId: string | null = null;
  /** Grupa rozwinięta (dzieci widoczne na liście). */
  public expanded: boolean = true;
  /** Ustawiane przez silnik: grupa nadrzędna jest ukryta / zablokowana. */
  public groupHidden: boolean = false;
  public groupLocked: boolean = false;

  /**
   * Widoczność efektywna (uwzględnia ukrytą grupę). Nagłówek grupy sam nie ma pikseli do narysowania, więc raportuje
   * „widoczny” tylko wtedy, gdy edytowana jest jego maska (narzędzia sprawdzają `visible` przed rysowaniem po masce).
   */
  public get visible(): boolean {
    if (this.isAdjustment) return false; // nie ma pikseli: narzędzia rysujące jej nie dotykają
    if (this.isGroup) return this._visible && this.editMask && !!this.maskGrid;
    return this._visible && !this.groupHidden;
  }
  public set visible(v: boolean) {
    this._visible = v;
  }
  /** Własny przełącznik widoczności (dla grupy: widoczność całej grupy). */
  public get ownVisible(): boolean {
    return this._visible;
  }
  /**
   * Blokada efektywna (uwzględnia zablokowaną grupę). Nagłówek grupy nie ma pikseli do edycji: da się go
   * edytować tylko wtedy, gdy ma maskę i jest ona celem edycji (i grupa nie jest zablokowana).
   */
  public get locked(): boolean {
    if (this.isAdjustment) return true;
    if (this.isGroup) return this._locked || !(this.editMask && !!this.maskGrid);
    return this._locked || this.groupLocked;
  }
  public set locked(v: boolean) {
    this._locked = v;
  }
  public get ownLocked(): boolean {
    return this._locked;
  }
  public opacity: number = 1.0; // 0.0 .. 1.0
  public blendMode: SKBlendMode = 'SrcOver';
  /** Piksele warstwy (zawsze); `tileGrid` to cel edycji: piksele albo maska (patrz `editMask`). */
  public pixelGrid!: TileGrid;
  /** Maska przezroczystości: skala szarości zapisana w RGB (wartość = luminancja * alfa / 255); biel = widoczne, czerń = ukryte. */
  public maskGrid: TileGrid | null = null;
  /** true = narzędzia i operacje na „aktywnej warstwie” działają na masce. */
  public editMask: boolean = false;
  /** Czy maska jest stosowana przy wyświetlaniu / eksporcie (przełącznik widoczności maski). */
  public maskEnabled: boolean = true;
  /** Czy przekształcenia zawartości zaznaczenia (przesuń / skaluj / obróć) obejmują jednocześnie piksele i maskę. */
  public maskLinked: boolean = true;
  /** Tryb pomocniczy: warstwa-pośrednik pokazuje maskę w skali szarości (używane przy podglądzie maski na płótnie). */
  public grayView: boolean = false;
  /**
   * Korekcje nieniszczące (kolejność tablicy = kolejność stosowania; ostatnia działa na wynik poprzednich).
   * Po KAŻDEJ zmianie tablicy lub parametrów trzeba wywołać `touchCorrections()` (silnik robi to w swoich metodach).
   */
  public corrections: Correction[] = [];
  /** Lista korekcji rozwinięta pod warstwą w panelu warstw (tylko interfejs). */
  public correctionsExpanded: boolean = false;
  /**
   * Stylizacje warstwy (cień, obrys, poświata...): osobno od listy korekcji, ale w łańcuchu zawsze po korekcjach i filtrach
   * (jako jeden krok `layerStyles`). Po KAŻDEJ zmianie trzeba wywołać `touchCorrections()`.
   */
  public styles: LayerStyles | null = null;
  private _corrKey: string = 'c0';
  private _corrActive: Correction[] | null = null;
  private _effective: Correction[] | null = null;
  private _chain: Chain | null = null;
  private _chainMargin = -1;

  /** Unieważnia pamięci podręczne korekcji (nowy klucz = nowy wygląd). */
  public touchCorrections(): void {
    this._corrKey = `c${++corrVersionCounter}`;
    this._corrActive = null;
    this._effective = null;
    this._chain = null;
    this._chainMargin = -1;
  }

  /** Korekcje, filtry i (na końcu) stylizacje, które faktycznie działają na piksele warstwy. */
  public get effectiveCorrections(): Correction[] {
    if (!this._effective) {
      const list = this.activeCorrections;
      this._effective =
        !this.isGroup && !this.isAdjustment && this.styles && stylesActive(this.styles)
          ? [...list, { id: 'layer-styles', type: 'layerStyles', enabled: true, params: this.styles } as Correction]
          : list;
    }
    return this._effective;
  }

  /** Czy warstwa ma jakąkolwiek widoczną stylizację. */
  public get hasActiveStyles(): boolean {
    return !this.isGroup && !this.isAdjustment && stylesActive(this.styles);
  }

  private _bounds: { key: string; b: { x0: number; y0: number; x1: number; y1: number } | null } | null = null;

  /** Prostokąt (piksele dokumentu) zajmowany przez niepustą zawartość warstwy; null dla pustej. */
  public contentBounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    const g = this.pixelGrid;
    let key = '';
    for (const row of g.tiles) for (const t of row) if (t.hasContent) key += `${tileUidOf(t)}.${t.version};`;
    if (this._bounds && this._bounds.key === key) return this._bounds.b;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const row of g.tiles) {
      for (const t of row) {
        if (!t.hasContent || t.width <= 0 || t.height <= 0) continue;
        const d = t.ctx.getImageData(0, 0, t.width, t.height).data;
        for (let y = 0; y < t.height; y++) {
          for (let x = 0; x < t.width; x++) {
            if (d[(y * t.width + x) * 4 + 3] === 0) continue;
            const X = t.pixelX + x;
            const Y = t.pixelY + y;
            if (X < x0) x0 = X;
            if (X + 1 > x1) x1 = X + 1;
            if (Y < y0) y0 = Y;
            if (Y + 1 > y1) y1 = Y + 1;
          }
        }
      }
    }
    const b = x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
    this._bounds = { key, b };
    return b;
  }

  /** Kontekst dla stylizacji: gradient „względem warstwy” potrzebuje jej prostokąta. */
  private styleFx(fx: FxContext): FxContext {
    const s = this.styles;
    if (!s || !styleOn(s, 'gradientOverlay') || s.gradientOverlay.align !== 'layer') return fx;
    return { ...fx, layerBounds: this.contentBounds() } as StyleFx;
  }

  /** Włączone korekcje (kolejność stosowania). */
  public get activeCorrections(): Correction[] {
    if (!this._corrActive) this._corrActive = this.corrections.filter((c) => c.enabled);
    return this._corrActive;
  }

  public get hasActiveCorrections(): boolean {
    return this.effectiveCorrections.length > 0;
  }

  /** Korekcja samodzielna, która faktycznie coś robi (widoczna i włączona). */
  public get adjustmentActive(): boolean {
    return this.isAdjustment && this._visible && this.hasActiveCorrections;
  }

  /** Wchodzi do sygnatury kompozytu: pusty, gdy brak włączonych korekcji (wyłączenie wraca do poprzedniego wyglądu). */
  public get correctionsSignature(): string {
    return this.hasActiveCorrections ? this._corrKey : '';
  }

  private chain(): Chain {
    if (!this._chain) this._chain = compileChain(this.effectiveCorrections);
    return this._chain;
  }

  /** Czy wśród włączonych korekcji są filtry (operacje na sąsiedztwie pikseli). */
  public get hasActiveFilters(): boolean {
    return this.chain().hasFilters;
  }

  /** Margines (piksele dokumentu), o jaki trzeba powiększyć fragment, żeby filtry dały na nim ten sam wynik co na całości. */
  public get filterMargin(): number {
    if (!this.hasActiveFilters) return 0;
    if (this._chainMargin < 0) this._chainMargin = chainMargin(this.effectiveCorrections, this.pixelGrid.width, this.pixelGrid.height);
    return this._chainMargin;
  }

  /** Czy filtry mogą „rozlać” zawartość na kafelki, które same są puste (rozmycia, pikselizacja). */
  public get filtersSpread(): boolean {
    return this.chain().spreads;
  }

  /** Kafelek wnosi coś do obrazu: ma treść albo (filtry rozlewające) sąsiad w zasięgu filtru ma treść. */
  public tileShown(t: Tile): boolean {
    if (t.hasContent) return true;
    if (!this.hasActiveCorrections || !this.filtersSpread) return false;
    const g = this.pixelGrid;
    const n = Math.max(1, Math.ceil(this.filterMargin / g.tileSize));
    for (let ty = Math.max(0, t.tileY - n); ty <= Math.min(g.rows - 1, t.tileY + n); ty++) {
      for (let tx = Math.max(0, t.tileX - n); tx <= Math.min(g.cols - 1, t.tileX + n); tx++) {
        if (g.tiles[ty][tx].hasContent) return true;
      }
    }
    return false;
  }

  /** Czy cały łańcuch korekcji / filtrów / stylizacji warstwy da się wykonać w sesji GPU na oknie w x h (brak efektów = tak). */
  public gpuChainFits(w: number, h: number, scale: number): boolean {
    return !this.hasActiveCorrections || chainGpuSupported(this.chain(), w, h, scale);
  }

  /** Wykonuje łańcuch warstwy w otwartej sesji GPU (kompozytor GPU); false = wynik do odrzucenia. */
  public runChainGpu(w: number, h: number, fx: FxContext): boolean {
    return runChainInSession(this.chain(), w, h, this.styleFx(fx));
  }

  /** Nakłada włączone korekcje i filtry W MIEJSCU na fragment (x, y, w, h) płótna; bez nich nic nie robi. Zwraca to samo płótno. */
  public applyCorrectionsToCanvas(
    cv: HTMLCanvasElement,
    w: number = cv.width,
    h: number = cv.height,
    x: number = 0,
    y: number = 0,
    fx?: FxContext
  ): HTMLCanvasElement {
    if (!this.hasActiveCorrections || w <= 0 || h <= 0) return cv;
    const fxc = this.styleFx(fx ?? { scale: 1, docX0: x, docY0: y, docW: this.pixelGrid.width, docH: this.pixelGrid.height });
    // cały płótno + łańcuch obsługiwany przez GPU: jedna sesja bez kopiowania przez CPU
    if (x === 0 && y === 0 && w === cv.width && h === cv.height && runChainOnCanvas(this.chain(), cv, fxc)) return cv;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return cv;
    const img = ctx.getImageData(x, y, w, h);
    const chain = this.chain();
    // bez kontekstu: bufor jest fragmentem dokumentu w skali 1:1 (współrzędne bufora = współrzędne dokumentu + (x, y) wycinka)
    runChain(chain, img.data, w, h, this.styleFx(fx ?? { scale: 1, docX0: x, docY0: y, docW: this.pixelGrid.width, docH: this.pixelGrid.height }));
    ctx.putImageData(img, x, y);
    return cv;
  }

  /**
   * Wynik łańcucha `chain` dla kafelka `tile` liczony na obszarze powiększonym o margines (sąsiednie kafelki),
   * przycięty do kafelka. Piksele poza dokumentem są powtórzeniem krawędzi.
   */
  private filterTileCanvas(tile: Tile, chain: Chain, margin: number, out: HTMLCanvasElement): HTMLCanvasElement {
    const reg = this.filterRegion(tile.pixelX, tile.pixelY, tile.width, tile.height, chain, margin);
    out.width = Math.max(1, tile.width);
    out.height = Math.max(1, tile.height);
    const octx = out.getContext('2d', { willReadFrequently: true })!;
    octx.globalCompositeOperation = 'source-over';
    octx.clearRect(0, 0, out.width, out.height);
    octx.drawImage(reg, 0, 0);
    return out;
  }

  /**
   * Wynik łańcucha dla prostokąta (rx, ry, rw, rh) dokumentu liczony raz na obszarze powiększonym o margines.
   * Duże regiony (kilka kafelków) są dużo tańsze niż osobne okna z marginesem wokół każdego kafelka.
   */
  private filterRegion(rx: number, ry: number, rw: number, rh: number, chain: Chain, margin: number): HTMLCanvasElement {
    const g = this.pixelGrid;
    const m = Math.max(0, Math.ceil(margin));
    const pw = rw + 2 * m;
    const ph = rh + 2 * m;
    const ox = rx - m;
    const oy = ry - m;
    const buf = document.createElement('canvas');
    buf.width = pw;
    buf.height = ph;
    const bctx = buf.getContext('2d', { willReadFrequently: true })!;
    const tx0 = Math.max(0, Math.floor(ox / g.tileSize));
    const ty0 = Math.max(0, Math.floor(oy / g.tileSize));
    const tx1 = Math.min(g.cols - 1, Math.floor((ox + pw - 1) / g.tileSize));
    const ty1 = Math.min(g.rows - 1, Math.floor((oy + ph - 1) / g.tileSize));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = g.tiles[ty][tx];
        // maska działa PRZED filtrami i stylizacjami: cień i zniekształcenie dotyczą już zamaskowanego obrazu
        if (t.hasContent) {
          const mc = this.renderCore(t, false);
          if (mc) bctx.drawImage(mc, t.pixelX - ox, t.pixelY - oy);
        }
      }
    }
    const img = bctx.getImageData(0, 0, pw, ph);
    runChain(
      chain,
      img.data,
      pw,
      ph,
      this.styleFx({
        scale: 1,
        docX0: ox,
        docY0: oy,
        docW: g.width,
        docH: g.height,
        bounds: { x0: -ox, y0: -oy, x1: g.width - ox, y1: g.height - oy },
      })
    );
    bctx.putImageData(img, 0, 0);
    const out = document.createElement('canvas');
    out.width = Math.max(1, rw);
    out.height = Math.max(1, rh);
    const octx = out.getContext('2d', { willReadFrequently: true })!;
    octx.drawImage(buf, m, m, rw, rh, 0, 0, rw, rh);
    return out;
  }

  /** Ile kafelków na bok liczy się razem: przy dużym marginesie osobne okna wokół każdego kafelka byłyby wielokrotnie droższe. */
  private blockTiles(_margin: number): number {
    // Zawsze bloki 8x8 kafelków: osobne wywołanie (a przy GPU: odczyt wyniku) dla każdego kafelka 64 px kosztowało
    // tysiące wywołań przy przeliczaniu całej warstwy na dużym płótnie (4000x3000 = ok. 3000 kafelków)
    return 8;
  }

  /** Nakłada podaną listę korekcji (w tej kolejności) na piksele warstwy (bez maski); lista korekcji warstwy bez zmian. */
  /**
   * Wpieka włączoną maskę w piksele warstwy i ustawia maskę na biało (cała warstwa widoczna). Efekty działają PO masce
   * (cienie i zniekształcenia widzą już zamaskowany obraz i nie są przycinane maską), więc po wypieczeniu efektów
   * maska nie może zostać, bo zadziałałaby drugi raz. Wygląd warstwy przed i po jest taki sam.
   */
  public bakeMaskIntoPixels(): void {
    const mg = this.maskGrid;
    if (!mg || !this.maskEnabled) return;
    const g = this.pixelGrid;
    const copies: Array<{ t: Tile; cv: HTMLCanvasElement }> = [];
    for (const row of g.tiles) {
      for (const t of row) {
        if (!t.hasContent || t.width <= 0 || t.height <= 0) continue;
        const mc = this.renderCore(t, false);
        if (!mc || mc === t.canvas) continue;
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, t.width);
        cv.height = Math.max(1, t.height);
        cv.getContext('2d')!.drawImage(mc, 0, 0);
        copies.push({ t, cv });
      }
    }
    for (const { t, cv } of copies) {
      t.ctx.globalCompositeOperation = 'source-over';
      t.ctx.clearRect(0, 0, t.width, t.height);
      t.ctx.drawImage(cv, 0, 0);
      t.isDirty = true;
    }
    mg.fill({ r: 255, g: 255, b: 255, a: 255 });
  }

  public bakeCorrectionList(list: Correction[]): void {
    const enabled = list.filter((c) => c.enabled);
    if (enabled.length === 0) return;
    this.bakeMaskIntoPixels();
    const chain = compileChain(enabled);
    const g = this.pixelGrid;
    const results: Array<{ t: Tile; cv: HTMLCanvasElement }> = [];
    const blocks = new Map<string, { x0: number; y0: number; cv: HTMLCanvasElement }>();
    if (chain.hasFilters) {
      // filtry czytają sąsiednie kafelki: najpierw wyniki dla wszystkich kafelków (z oryginałów), potem zapis
      const margin = chainMargin(enabled, g.width, g.height);
      const n = Math.max(1, Math.ceil(margin / g.tileSize));
      const K = this.blockTiles(margin);
      for (const row of g.tiles) {
        for (const t of row) {
          if (t.width <= 0 || t.height <= 0) continue;
          let shown = t.hasContent;
          if (!shown && chain.spreads) {
            for (let ty = Math.max(0, t.tileY - n); ty <= Math.min(g.rows - 1, t.tileY + n) && !shown; ty++) {
              for (let tx = Math.max(0, t.tileX - n); tx <= Math.min(g.cols - 1, t.tileX + n); tx++) {
                if (g.tiles[ty][tx].hasContent) {
                  shown = true;
                  break;
                }
              }
            }
          }
          if (!shown) continue;
          if (K > 1) {
            // region bloku liczony raz (przy pierwszym kafelku bloku); kafelki dostają wycinki
            const bx = Math.floor(t.tileX / K) * K;
            const by = Math.floor(t.tileY / K) * K;
            const bk = `${bx},${by}`;
            let blk = blocks.get(bk);
            if (!blk) {
              const x0 = g.tiles[by][bx].pixelX;
              const y0 = g.tiles[by][bx].pixelY;
              const lastT = g.tiles[Math.min(g.rows - 1, by + K - 1)][Math.min(g.cols - 1, bx + K - 1)];
              blk = { x0, y0, cv: this.filterRegion(x0, y0, lastT.pixelX + lastT.width - x0, lastT.pixelY + lastT.height - y0, chain, margin) };
              blocks.set(bk, blk);
            }
            const cv = document.createElement('canvas');
            cv.width = Math.max(1, t.width);
            cv.height = Math.max(1, t.height);
            cv.getContext('2d', { willReadFrequently: true })!.drawImage(blk.cv, t.pixelX - blk.x0, t.pixelY - blk.y0, t.width, t.height, 0, 0, t.width, t.height);
            results.push({ t, cv });
          } else {
            results.push({ t, cv: this.filterTileCanvas(t, chain, margin, document.createElement('canvas')) });
          }
        }
      }
      blocks.clear();
      for (const { t, cv } of results) {
        t.ctx.globalCompositeOperation = 'source-over';
        t.ctx.clearRect(0, 0, t.width, t.height);
        t.ctx.drawImage(cv, 0, 0);
        t.hasContent = true;
        t.isDirty = true;
      }
      this.updateThumbnail();
      return;
    }
    for (const row of g.tiles) {
      for (const t of row) {
        if (!t.hasContent || t.width <= 0 || t.height <= 0) continue;
        const ctx = t.canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) continue;
        const img = ctx.getImageData(0, 0, t.width, t.height);
        runChain(chain, img.data, t.width, t.height, { scale: 1, docX0: t.pixelX, docY0: t.pixelY, docW: g.width, docH: g.height });
        ctx.putImageData(img, 0, 0);
        t.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /** Wpieka włączone korekcje w piksele warstwy (bez maski) i czyści całą listę korekcji. */
  public bakeCorrections(): void {
    if (this.isGroup) return;
    this.bakeCorrectionList(this.effectiveCorrections);
    this.corrections = [];
    this.styles = null;
    this.touchCorrections();
    this.updateThumbnail();
  }

  private maskedCache = new WeakMap<Tile, { lv: number; mv: number; ck: string; canvas: HTMLCanvasElement }>();
  private correctedCache = new WeakMap<Tile, { lv: number; mv: number; ck: string; canvas: HTMLCanvasElement }>();
  private alphaCache = new WeakMap<Tile, { v: number; canvas: HTMLCanvasElement }>();
  private grayCache = new WeakMap<Tile, { v: number; canvas: HTMLCanvasElement }>();

  public get tileGrid(): TileGrid {
    return this.editMask && this.maskGrid ? this.maskGrid : this.pixelGrid;
  }
  public set tileGrid(g: TileGrid) {
    if (this.editMask && this.maskGrid) this.maskGrid = g;
    else this.pixelGrid = g;
  }

  public get hasMask(): boolean {
    return this.maskGrid !== null;
  }
  public thumbnailCanvas: HTMLCanvasElement;
  public thumbW: number = 35;
  public thumbH: number = 35;
  public thumbnailCtx: CanvasRenderingContext2D | null;
  public maskThumbnailCanvas: HTMLCanvasElement;
  private maskThumbDataUrl: string | null = null;
  /** Rośnie przy każdym faktycznym przerysowaniu miniatury. */
  public thumbVersion: number = 0;
  private thumbDirty: boolean = true;
  private thumbDataUrl: string | null = null;

  constructor(
    id: string,
    name: string,
    width: number,
    height: number,
    tileSize?: number
  ) {
    this.id = id;
    this.name = name;
    this.tileGrid = new TileGrid(width, height, tileSize);

    // Miniatura warstwy (do panelu warstw)
    this.thumbnailCanvas = document.createElement('canvas');
    // Miniatura zachowuje proporcje płótna (w ramce THUMB_MAX_W x THUMB_MAX_H)
    const ratio = width / Math.max(1, height);
    this.thumbW = Math.max(6, Math.min(THUMB_MAX_W, Math.round(ratio >= THUMB_MAX_W / THUMB_MAX_H ? THUMB_MAX_W : THUMB_MAX_H * ratio)));
    this.thumbH = Math.max(6, Math.min(THUMB_MAX_H, Math.round(ratio >= THUMB_MAX_W / THUMB_MAX_H ? THUMB_MAX_W / ratio : THUMB_MAX_H)));
    this.thumbnailCanvas.width = this.thumbW;
    this.thumbnailCanvas.height = this.thumbH;
    this.thumbnailCtx = this.thumbnailCanvas.getContext('2d');
    this.maskThumbnailCanvas = document.createElement('canvas');
    this.maskThumbnailCanvas.width = this.thumbW;
    this.maskThumbnailCanvas.height = this.thumbH;
  }

  /**
   * Zgłasza, że miniatura jest nieaktualna. Przerysowanie jest odroczone i scalone (patrz harmonogram wyżej);
   * `urgent` wystawia warstwę na początek kolejki (np. aktywną).
   */
  public updateThumbnail(urgent: boolean = false): void {
    this.thumbDirty = true;
    scheduleThumb(this, urgent);
  }

  /** Natychmiastowe przerysowanie miniatury (używane przez harmonogram). */
  public refreshThumbnail(): void {
    if (!this.thumbDirty || !this.thumbnailCtx) return;
    this.thumbDirty = false;

    const tw = this.thumbW;
    const th = this.thumbH;
    const ctx = this.thumbnailCtx;
    ctx.clearRect(0, 0, tw, th);

    const sz = 4;
    for (let y = 0; y < th; y += sz) {
      for (let x = 0; x < tw; x += sz) {
        ctx.fillStyle = (Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0 ? '#f0f0f0' : '#d0d0d0';
        ctx.fillRect(x, y, sz, sz);
      }
    }

    // Miniatura warstwy pokazuje ją z zastosowaną (włączoną) maską
    const px = document.createElement('canvas');
    px.width = tw;
    px.height = th;
    const pctx = px.getContext('2d')!;
    this.pixelGrid.drawThumbnail(pctx, tw, th);
    // Miniatura pokazuje warstwę z włączonymi korekcjami (tak jak na płótnie)
    this.applyCorrectionsToCanvas(px, tw, th, 0, 0, {
      scale: tw / Math.max(1, this.pixelGrid.width),
      docX0: 0,
      docY0: 0,
      docW: this.pixelGrid.width,
      docH: this.pixelGrid.height,
      bounds: { x0: 0, y0: 0, x1: tw, y1: th },
    });

    if (this.maskGrid) {
      const tmp = document.createElement('canvas');
      tmp.width = tw;
      tmp.height = th;
      const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
      this.maskGrid.drawThumbnail(tctx, tw, th);
      const img = tctx.getImageData(0, 0, tw, th);
      const d = img.data;
      // miniatura maski zawsze w skali szarości (kolory narysowane na masce liczą się jako luminancja)
      const alphaImg = new ImageData(new Uint8ClampedArray(d), tw, th);
      for (let i = 0; i < d.length; i += 4) {
        const g = Math.round((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * (d[i + 3] / 255));
        d[i] = d[i + 1] = d[i + 2] = g;
        d[i + 3] = 255;
        alphaImg.data[i] = alphaImg.data[i + 1] = alphaImg.data[i + 2] = 0;
        alphaImg.data[i + 3] = g;
      }
      const mctx = this.maskThumbnailCanvas.getContext('2d');
      if (mctx) {
        mctx.putImageData(img, 0, 0);
      }
      if (this.maskEnabled) {
        const at = document.createElement('canvas');
        at.width = tw;
        at.height = th;
        at.getContext('2d')!.putImageData(alphaImg, 0, 0);
        pctx.globalCompositeOperation = 'destination-in';
        pctx.drawImage(at, 0, 0);
        pctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.drawImage(px, 0, 0);
    this.thumbVersion++;
    this.thumbDataUrl = null;
    this.maskThumbDataUrl = null;
  }

  /** Adres data: miniatury maski (null, gdy warstwa nie ma maski). */
  public getMaskThumbnailDataUrl(): string | null {
    if (!this.maskGrid) return null;
    if (this.maskThumbDataUrl === null) this.maskThumbDataUrl = this.maskThumbnailCanvas.toDataURL();
    return this.maskThumbDataUrl;
  }

  /** Adres data: miniatury (buforowany do następnego przerysowania). */
  public getThumbnailDataUrl(): string {
    if (this.thumbDataUrl === null) this.thumbDataUrl = this.thumbnailCanvas.toDataURL();
    return this.thumbDataUrl;
  }

  public clone(newId?: string, newName?: string): Layer {
    const copy = new Layer(
      newId || `layer_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      newName || `${this.name} (Kopia)`,
      this.tileGrid.width,
      this.tileGrid.height,
      this.tileGrid.tileSize
    );
    copy._visible = this._visible;
    copy._locked = this._locked;
    copy.isGroup = this.isGroup;
    copy.isAdjustment = this.isAdjustment;
    copy.isVector = this.isVector;
    copy.vectorObjects = cloneVectorObjects(this.vectorObjects);
    copy.groupId = this.groupId;
    copy.expanded = this.expanded;
    copy.groupHidden = this.groupHidden;
    copy.groupLocked = this.groupLocked;
    copy.opacity = this.opacity;
    copy.blendMode = this.blendMode;
    copy.pixelGrid = this.pixelGrid.clone();
    copy.maskGrid = this.maskGrid ? this.maskGrid.clone() : null;
    copy.corrections = cloneCorrections(this.corrections);
    copy.styles = this.styles ? cloneStyles(this.styles) : null;
    copy.correctionsExpanded = this.correctionsExpanded;
    copy.touchCorrections();
    copy.editMask = this.editMask;
    copy.maskEnabled = this.maskEnabled;
    copy.thumbW = this.thumbW;
    copy.thumbH = this.thumbH;
    copy.thumbnailCanvas.width = this.thumbW;
    copy.thumbnailCanvas.height = this.thumbH;
    copy.maskThumbnailCanvas.width = this.thumbW;
    copy.maskThumbnailCanvas.height = this.thumbH;
    // Kopia dostaje gotową miniaturę zamiast pełnego przeliczania; jeśli źródło jest nieaktualne, kopia też się odświeży
    if (this.thumbDirty || !copy.thumbnailCtx || this.maskGrid) {
      copy.updateThumbnail();
    } else {
      copy.thumbnailCtx.clearRect(0, 0, copy.thumbW, copy.thumbH);
      copy.thumbnailCtx.drawImage(this.thumbnailCanvas, 0, 0);
      copy.thumbDirty = false;
      copy.thumbVersion++;
    }
    return copy;
  }

  // --- MASKA PRZEZROCZYSTOŚCI ---

  /**
   * Tworzy maskę. Bez `selection`: cała biała (warstwa w pełni widoczna). Z `selection` (kanał alfa płótna zaznaczenia):
   * biel w zaznaczeniu (także częściowa, wg krycia zaznaczenia), czerń poza nim.
   */
  public createMask(selection?: HTMLCanvasElement | null, docW?: number, docH?: number): void {
    // nagłówek grupy ma 1x1 pikseli własnych, a maska grupy musi mieć rozmiar dokumentu (docW/docH)
    const mw = docW ?? this.pixelGrid.width;
    const mh = docH ?? this.pixelGrid.height;
    const g = new TileGrid(mw, mh, this.pixelGrid.tileSize);

    // Miniatura maski (i grupy) musi odzwierciedlać proporcje dokumentu/maski
    const ratio = mw / Math.max(1, mh);
    this.thumbW = Math.max(6, Math.min(THUMB_MAX_W, Math.round(ratio >= THUMB_MAX_W / THUMB_MAX_H ? THUMB_MAX_W : THUMB_MAX_H * ratio)));
    this.thumbH = Math.max(6, Math.min(THUMB_MAX_H, Math.round(ratio >= THUMB_MAX_W / THUMB_MAX_H ? THUMB_MAX_W / ratio : THUMB_MAX_H)));
    this.thumbnailCanvas.width = this.thumbW;
    this.thumbnailCanvas.height = this.thumbH;
    this.maskThumbnailCanvas.width = this.thumbW;
    this.maskThumbnailCanvas.height = this.thumbH;

    let white: HTMLCanvasElement | null = null;
    if (selection) {
      white = document.createElement('canvas');
      white.width = g.width;
      white.height = g.height;
      const wctx = white.getContext('2d')!;
      wctx.drawImage(selection, 0, 0);
      wctx.globalCompositeOperation = 'source-in';
      wctx.fillStyle = '#ffffff';
      wctx.fillRect(0, 0, g.width, g.height);
    }
    for (const row of g.tiles) {
      for (const t of row) {
        if (white) {
          t.ctx.fillStyle = '#000000';
          t.ctx.fillRect(0, 0, t.width, t.height);
          t.ctx.drawImage(white, t.pixelX, t.pixelY, t.width, t.height, 0, 0, t.width, t.height);
          t.hasContent = true;
          t.isDirty = true;
        } else {
          t.fill({ r: 255, g: 255, b: 255, a: 255 });
        }
      }
    }
    this.maskGrid = g;
    this.maskEnabled = true;
    this.editMask = true;
    this.updateThumbnail(true);
  }

  /**
   * Tworzy maskę z innej warstwy: konwertuje piksele warstwy źródłowej do skali szarości.
   */
  public setMaskFromLayer(sourceLayer: Layer): void {
    const mw = this.pixelGrid.width;
    const mh = this.pixelGrid.height;
    const g = new TileGrid(mw, mh, this.pixelGrid.tileSize);

    const ratio = mw / Math.max(1, mh);
    this.thumbW = Math.max(6, Math.min(THUMB_MAX_W, Math.round(ratio >= THUMB_MAX_W / THUMB_MAX_H ? THUMB_MAX_W : THUMB_MAX_H * ratio)));
    this.thumbH = Math.max(6, Math.min(THUMB_MAX_H, Math.round(ratio >= THUMB_MAX_W / THUMB_MAX_H ? THUMB_MAX_W / ratio : THUMB_MAX_H)));
    this.thumbnailCanvas.width = this.thumbW;
    this.thumbnailCanvas.height = this.thumbH;
    this.maskThumbnailCanvas.width = this.thumbW;
    this.maskThumbnailCanvas.height = this.thumbH;

    for (let ty = 0; ty < g.rows; ty++) {
      for (let tx = 0; tx < g.cols; tx++) {
        const destTile = g.tiles[ty][tx];
        // Przezroczysty kolor traktujemy jako biały (w pełni widoczny w masce)
        destTile.ctx.fillStyle = '#ffffff';
        destTile.ctx.fillRect(0, 0, destTile.width, destTile.height);

        const srcTile = sourceLayer.pixelGrid.tiles[ty]?.[tx];
        if (srcTile && srcTile.hasContent) {
          const renderedCanvas = sourceLayer.renderCanvas(srcTile) ?? srcTile.canvas;
          const rctx = renderedCanvas.getContext('2d', { willReadFrequently: true });
          if (rctx) {
            const img = rctx.getImageData(0, 0, srcTile.width, srcTile.height);
            const d = img.data;
            for (let i = 0; i < d.length; i += 4) {
              const a = d[i + 3];
              if (a === 0) {
                d[i] = 255;
                d[i + 1] = 255;
                d[i + 2] = 255;
                d[i + 3] = 255;
              } else {
                const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                // Mieszanie luminancji z białym tłem (alfa-blending z bielą)
                const v = Math.round(lum * (a / 255) + 255 * (1 - a / 255));
                d[i] = v;
                d[i + 1] = v;
                d[i + 2] = v;
                d[i + 3] = 255;
              }
            }
            destTile.ctx.putImageData(img, 0, 0);
          }
        }
        destTile.hasContent = true;
        destTile.isDirty = true;
      }
    }

    this.maskGrid = g;
    this.maskEnabled = true;
    this.editMask = true;
    this.maskLinked = true;
    this.updateThumbnail(true);
  }

  /** Usuwa maskę (bez wpływu na piksele). */
  public dropMask(): void {
    this.maskGrid = null;
    this.editMask = false;
    this.maskEnabled = true;
    this.updateThumbnail(true);
  }

  /** Wpieka maskę w piksele warstwy i usuwa ją. */
  public applyMask(): void {
    if (!this.maskGrid) return;
    for (const row of this.pixelGrid.tiles) {
      for (const t of row) {
        if (!t.hasContent) continue;
        // tylko maska: korekcje pozostają nieniszczące i dalej działają na warstwie
        const rc = this.renderCanvas(t, false);
        t.ctx.clearRect(0, 0, t.width, t.height);
        if (rc) t.ctx.drawImage(rc, 0, 0);
        t.isDirty = true;
      }
    }
    // maska nieaktywna (wyłączona) nie zmienia pikseli przy zastosowaniu: wynik = piksele bez maski
    this.dropMask();
  }

  private alphaCanvasFor(maskTile: Tile): HTMLCanvasElement {
    let e = this.alphaCache.get(maskTile);
    if (e && e.v === maskTile.version) return e.canvas;
    const canvas = e ? e.canvas : document.createElement('canvas');
    canvas.width = Math.max(1, maskTile.width);
    canvas.height = Math.max(1, maskTile.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (maskTile.hasContent && maskTile.width > 0 && maskTile.height > 0) {
      const img = maskTile.ctx.getImageData(0, 0, maskTile.width, maskTile.height);
      grayToAlpha(img.data);
      ctx.putImageData(img, 0, 0);
    }
    this.alphaCache.set(maskTile, { v: maskTile.version, canvas });
    return canvas;
  }

  /** Maska w skali szarości jako nieprzezroczysty kafelek (czarne tło pod niepokrytymi pikselami). */
  public grayCanvasFor(maskTile: Tile): HTMLCanvasElement {
    let e = this.grayCache.get(maskTile);
    if (e && e.v === maskTile.version) return e.canvas;
    const canvas = e ? e.canvas : document.createElement('canvas');
    canvas.width = Math.max(1, maskTile.width);
    canvas.height = Math.max(1, maskTile.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (maskTile.hasContent && maskTile.width > 0 && maskTile.height > 0) {
      const img = maskTile.ctx.getImageData(0, 0, maskTile.width, maskTile.height);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const g = Math.round((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * (d[i + 3] / 255));
        d[i] = d[i + 1] = d[i + 2] = g;
        d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    }
    this.grayCache.set(maskTile, { v: maskTile.version, canvas });
    return canvas;
  }

  /**
   * Kafelek pikseli do narysowania w kompozycji: z zastosowaną maską (jeśli jest i jest włączona) albo oryginalny.
   * W trybie `grayView` (podgląd maski) zwraca maskę w skali szarości.
   */
  public renderCanvas(tile: Tile, withCorrections: boolean = true): HTMLCanvasElement | null {
    if (this.grayView) return this.grayCanvasFor(tile);
    return this.renderCore(tile, withCorrections);
  }

  /** Jak `renderCanvas`, ale zawsze piksele (bez podglądu maski w skali szarości). */
  private renderCore(tile: Tile, withCorrections: boolean): HTMLCanvasElement | null {
    const mg = this.maskGrid;
    const useCorr = withCorrections && this.hasActiveCorrections;
    const mt = mg && this.maskEnabled ? mg.tiles[tile.tileY]?.[tile.tileX] : undefined;
    if (!mt && !useCorr) return tile.canvas;
    if (useCorr && this.hasActiveFilters) return this.renderFilteredTile(tile);
    const cache = useCorr ? this.correctedCache : this.maskedCache;
    const ck = useCorr ? this._corrKey : '';
    const mv = mt ? mt.version : -1;
    const hit = cache.get(tile);
    if (hit && hit.lv === tile.version && hit.mv === mv && hit.ck === ck) return hit.canvas;
    let canvas = hit ? hit.canvas : null;
    if (!canvas) {
      canvas = document.createElement('canvas');
    }
    canvas.width = Math.max(1, tile.width);
    canvas.height = Math.max(1, tile.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tile.canvas, 0, 0);
    // korekcje działają na kolorze (kanał alfa bez zmian), więc kolejność względem maski nie ma znaczenia
    if (useCorr && tile.hasContent) this.applyCorrectionsToCanvas(canvas, canvas.width, canvas.height);
    if (mt) {
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(this.alphaCanvasFor(mt), 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
    cache.set(tile, { lv: tile.version, mv, ck, canvas });
    return canvas;
  }

  private filteredCache = new WeakMap<Tile, { key: string; canvas: HTMLCanvasElement }>();

  /** Klucz ważności wyniku dla kafelka: korekcje, maska i wersje wszystkich kafelków w zasięgu filtru. */
  private filteredKey(tile: Tile, n: number): string {
    const g = this.pixelGrid;
    const mg = this.maskGrid && this.maskEnabled ? this.maskGrid : null;
    let h1 = 0;
    let h2 = 0;
    for (let ty = Math.max(0, tile.tileY - n); ty <= Math.min(g.rows - 1, tile.tileY + n); ty++) {
      for (let tx = Math.max(0, tile.tileX - n); tx <= Math.min(g.cols - 1, tile.tileX + n); tx++) {
        const t = g.tiles[ty][tx];
        const mt = mg ? mg.tiles[ty]?.[tx] : undefined;
        const v = tileUidOf(t) * 8191 + t.version * 2 + (t.hasContent ? 1 : 0) + (mt ? (tileUidOf(mt) * 131 + mt.version) * 977 : 0);
        h1 = (Math.imul(h1, 31) + v) | 0;
        h2 = (Math.imul(h2 ^ v, 16777619) + 0x9e3779b9) | 0;
      }
    }
    return `${this._corrKey}|${mg ? 'm' : '-'}|${h1}.${h2}`;
  }

  /** Kafelek z korekcjami i filtrami (z sąsiadami w zasięgu filtru); maska jest już w danych wejściowych. Wynik w pamięci podręcznej. */
  private renderFilteredTile(tile: Tile): HTMLCanvasElement {
    const g = this.pixelGrid;
    const margin = this.filterMargin;
    const n = Math.max(1, Math.ceil(margin / g.tileSize));
    const key = this.filteredKey(tile, n);
    const hit = this.filteredCache.get(tile);
    if (hit && hit.key === key) return hit.canvas;
    const K = this.blockTiles(margin);
    if (K > 1) {
      // Blok kafelków liczony jednym przebiegiem, ale tylko dla kafelków, których wynik jest nieaktualny: region obliczeń
      // to prostokąt obejmujący te kafelki (zmiana jednego kafelka nie przelicza całego bloku 8x8)
      const bx = Math.floor(tile.tileX / K) * K;
      const by = Math.floor(tile.tileY / K) * K;
      const stale: Array<{ t: Tile; key: string }> = [];
      let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
      for (let ty = by; ty <= Math.min(g.rows - 1, by + K - 1); ty++) {
        for (let tx = bx; tx <= Math.min(g.cols - 1, bx + K - 1); tx++) {
          const t = g.tiles[ty][tx];
          if (t.width <= 0 || t.height <= 0 || (t !== tile && !this.tileShown(t))) continue;
          const tk = t === tile ? key : this.filteredKey(t, n);
          const cur = this.filteredCache.get(t);
          if (cur && cur.key === tk) continue;
          stale.push({ t, key: tk });
          rx0 = Math.min(rx0, t.pixelX); ry0 = Math.min(ry0, t.pixelY);
          rx1 = Math.max(rx1, t.pixelX + t.width); ry1 = Math.max(ry1, t.pixelY + t.height);
        }
      }
      const reg = this.filterRegion(rx0, ry0, rx1 - rx0, ry1 - ry0, this.chain(), margin);
      for (const { t, key: tk } of stale) {
        const cur = this.filteredCache.get(t);
        const cv = cur ? cur.canvas : document.createElement('canvas');
        cv.width = Math.max(1, t.width);
        cv.height = Math.max(1, t.height);
        const c2 = cv.getContext('2d', { willReadFrequently: true })!;
        c2.globalCompositeOperation = 'source-over';
        c2.clearRect(0, 0, cv.width, cv.height);
        c2.drawImage(reg, t.pixelX - rx0, t.pixelY - ry0, t.width, t.height, 0, 0, t.width, t.height);
        this.filteredCache.set(t, { key: tk, canvas: cv });
      }
      return this.filteredCache.get(tile)!.canvas;
    }
    const canvas = hit ? hit.canvas : document.createElement('canvas');
    this.filterTileCanvas(tile, this.chain(), margin, canvas);
    this.filteredCache.set(tile, { key, canvas });
    return canvas;
  }

  /** Czy warstwa wymaga przetwarzania przy rysowaniu kafelków (maska włączona, korekcje albo podgląd maski). */
  public get usesRenderTransform(): boolean {
    return this.grayView || (!!this.maskGrid && this.maskEnabled) || this.hasActiveCorrections;
  }

  /** Rysuje całą warstwę (z maską) na kontekście w układzie dokumentu. */
  public drawRenderedToContext(ctx: CanvasRenderingContext2D): void {
    if (!this.usesRenderTransform) {
      this.pixelGrid.drawToFlatContext(ctx);
      return;
    }
    for (const row of this.pixelGrid.tiles) {
      for (const t of row) {
        if (!this.tileShown(t) && !this.grayView) continue;
        const rc = this.renderCanvas(t);
        if (rc) ctx.drawImage(rc, t.pixelX, t.pixelY);
      }
    }
  }

  /** Jak `drawCroppedToContext` siatki, ale z maską. */
  public drawRenderedCropped(ctx: CanvasRenderingContext2D, cropX: number, cropY: number, cropW: number, cropH: number): void {
    if (!this.usesRenderTransform) {
      this.pixelGrid.drawCroppedToContext(ctx, cropX, cropY, cropW, cropH);
      return;
    }
    const g = this.pixelGrid;
    const minTx = Math.max(0, Math.floor(cropX / g.tileSize));
    const maxTx = Math.min(g.cols - 1, Math.floor((cropX + cropW - 1) / g.tileSize));
    const minTy = Math.max(0, Math.floor(cropY / g.tileSize));
    const maxTy = Math.min(g.rows - 1, Math.floor((cropY + cropH - 1) / g.tileSize));
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const t = g.tiles[ty][tx];
        if (!this.tileShown(t) && !this.grayView) continue;
        const rc = this.renderCanvas(t);
        if (rc) ctx.drawImage(rc, 0, 0, t.width, t.height, t.pixelX - cropX, t.pixelY - cropY, t.width, t.height);
      }
    }
  }

  /** Płaskie płótno całej warstwy z zastosowaną maską. */
  public renderFlatCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.pixelGrid.width;
    c.height = this.pixelGrid.height;
    this.drawRenderedToContext(c.getContext('2d')!);
    return c;
  }

  /**
   * Podgląd na żywo podczas edycji MASKI (np. pociągnięcie pędzlem): `maskRegion` to obszar (x, y, w, h) płótna maski
   * z naniesionym już podglądem; wynik to piksele warstwy w tym obszarze zamaskowane taką maską.
   */
  public composeWithMaskRegion(maskRegion: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d', { willReadFrequently: true })!;
    this.pixelGrid.drawCroppedToContext(octx, x, y, w, h);
    const mctx = maskRegion.getContext('2d', { willReadFrequently: true })!;
    const mimg = mctx.getImageData(0, 0, w, h);
    grayToAlpha(mimg.data);
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    tmp.getContext('2d')!.putImageData(mimg, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(tmp, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    return out;
  }

  /** Nakłada maskę warstwy (jak jest teraz) na podany fragment pikseli (podgląd pędzla na żywo przy edycji pikseli). */
  public applyMaskToRegion(pixels: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
    if (!this.maskGrid || !this.maskEnabled || this.editMask) return pixels;
    return this.maskRegionAlways(pixels, x, y, w, h);
  }

  /** Jak `applyMaskToRegion`, ale zawsze (także podczas edycji maski): dla kompozycji grup i eksportu. */
  public maskRegionAlways(pixels: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const mg = this.maskGrid;
    if (!mg || !this.maskEnabled) return pixels;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d')!;
    octx.drawImage(pixels, 0, 0, w, h, 0, 0, w, h);
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, w, h);
    mg.drawCroppedToContext(tctx, x, y, w, h);
    const mimg = tctx.getImageData(0, 0, w, h);
    grayToAlpha(mimg.data);
    tctx.putImageData(mimg, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(tmp, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    return out;
  }

  /**
   * Wypełnia warstwę kolorem (z opcjonalnym maskowaniem zaznaczenia)
   */
  public fill(color: SKColor, selectionMask?: HTMLCanvasElement | null): void {
    if (!selectionMask) {
      this.tileGrid.fill(color);
    } else {
      const flat = this.tileGrid.compositeToFlatCanvas();
      const ctx = flat.getContext('2d')!;
      const mctx = selectionMask.getContext('2d')!;
      const maskData = mctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height).data;
      const imgData = ctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height);
      const data = imgData.data;

      for (let i = 0; i < data.length; i += 4) {
        const mAlpha = maskData[i + 3];
        if (mAlpha > 0) {
          const norm = mAlpha / 255;
          data[i] = Math.round(data[i] * (1 - norm) + color.r * norm);
          data[i + 1] = Math.round(data[i + 1] * (1 - norm) + color.g * norm);
          data[i + 2] = Math.round(data[i + 2] * (1 - norm) + color.b * norm);
          data[i + 3] = Math.max(data[i + 3], Math.round(color.a * norm));
        }
      }
      ctx.putImageData(imgData, 0, 0);

      for (let ty = 0; ty < this.tileGrid.rows; ty++) {
        for (let tx = 0; tx < this.tileGrid.cols; tx++) {
          const tile = this.tileGrid.tiles[ty][tx];
          tile.ctx.clearRect(0, 0, tile.width, tile.height);
          tile.ctx.drawImage(flat, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
          tile.hasContent = true;
          tile.isDirty = true;
        }
      }
    }
    this.updateThumbnail();
  }

  /**
   * Czyści warstwę (z opcjonalnym maskowaniem zaznaczenia)
   */
  public clear(selectionMask?: HTMLCanvasElement | null): void {
    if (!selectionMask) {
      this.tileGrid.clear();
    } else {
      for (let ty = 0; ty < this.tileGrid.rows; ty++) {
        for (let tx = 0; tx < this.tileGrid.cols; tx++) {
          const tile = this.tileGrid.tiles[ty][tx];
          if (!tile.hasContent) continue;
          tile.ctx.save();
          tile.ctx.globalCompositeOperation = 'destination-out';
          tile.ctx.drawImage(
            selectionMask,
            tile.pixelX, tile.pixelY, tile.width, tile.height,
            0, 0, tile.width, tile.height
          );
          tile.ctx.restore();
          tile.isDirty = true;
        }
      }
    }
    this.updateThumbnail();
  }

  /**
   * Odwraca kolory (Invert Colors)
   */
  public invertColors(selectionMask?: HTMLCanvasElement | null): void {
    const mctx = selectionMask?.getContext('2d');
    const maskData = mctx ? mctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height).data : null;

    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        if (!tile.hasContent) continue;

        const imgData = tile.ctx.getImageData(0, 0, tile.width, tile.height);
        const data = imgData.data;

        for (let y = 0; y < tile.height; y++) {
          for (let x = 0; x < tile.width; x++) {
            const i = (y * tile.width + x) * 4;
            if (data[i + 3] > 0) {
              const gx = tile.pixelX + x;
              const gy = tile.pixelY + y;
              const gIdx = (gy * this.tileGrid.width + gx) * 4;
              const mAlpha = maskData ? maskData[gIdx + 3] : 255;

              if (mAlpha > 0) {
                data[i] = 255 - data[i];
                data[i + 1] = 255 - data[i + 1];
                data[i + 2] = 255 - data[i + 2];
              }
            }
          }
        }
        tile.ctx.putImageData(imgData, 0, 0);
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /**
   * Skala szarości (Grayscale)
   */
  public toGrayscale(selectionMask?: HTMLCanvasElement | null): void {
    const mctx = selectionMask?.getContext('2d');
    const maskData = mctx ? mctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height).data : null;

    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        if (!tile.hasContent) continue;

        const imgData = tile.ctx.getImageData(0, 0, tile.width, tile.height);
        const data = imgData.data;

        for (let y = 0; y < tile.height; y++) {
          for (let x = 0; x < tile.width; x++) {
            const i = (y * tile.width + x) * 4;
            if (data[i + 3] > 0) {
              const gx = tile.pixelX + x;
              const gy = tile.pixelY + y;
              const gIdx = (gy * this.tileGrid.width + gx) * 4;
              const mAlpha = maskData ? maskData[gIdx + 3] : 255;

              if (mAlpha > 0) {
                const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
                data[i] = gray;
                data[i + 1] = gray;
                data[i + 2] = gray;
              }
            }
          }
        }
        tile.ctx.putImageData(imgData, 0, 0);
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /**
   * Regulacja Jasności i Kontrastu (Brightness / Contrast)
   */
  public adjustBrightnessContrast(brightness: number, contrast: number, selectionMask?: HTMLCanvasElement | null): void {
    const b = brightness;
    const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
    const mctx = selectionMask?.getContext('2d');
    const maskData = mctx ? mctx.getImageData(0, 0, this.tileGrid.width, this.tileGrid.height).data : null;

    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        if (!tile.hasContent) continue;

        const imgData = tile.ctx.getImageData(0, 0, tile.width, tile.height);
        const data = imgData.data;

        for (let y = 0; y < tile.height; y++) {
          for (let x = 0; x < tile.width; x++) {
            const i = (y * tile.width + x) * 4;
            if (data[i + 3] > 0) {
              const gx = tile.pixelX + x;
              const gy = tile.pixelY + y;
              const gIdx = (gy * this.tileGrid.width + gx) * 4;
              const mAlpha = maskData ? maskData[gIdx + 3] : 255;

              if (mAlpha > 0) {
                let r = data[i] + b;
                let g = data[i + 1] + b;
                let bVal = data[i + 2] + b;

                r = factor * (r - 128) + 128;
                g = factor * (g - 128) + 128;
                bVal = factor * (bVal - 128) + 128;

                data[i] = Math.max(0, Math.min(255, Math.round(r)));
                data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
                data[i + 2] = Math.max(0, Math.min(255, Math.round(bVal)));
              }
            }
          }
        }
        tile.ctx.putImageData(imgData, 0, 0);
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /** Odbicie obejmuje piksele i maskę (operacja na całym obrazie). */
  public flipHorizontal(): void {
    const was = this.editMask;
    this.editMask = false;
    this.flipTargetHorizontal();
    if (this.maskGrid) {
      this.editMask = true;
      this.flipTargetHorizontal();
    }
    this.editMask = was;
  }

  private flipTargetHorizontal(): void {
    const flat = this.tileGrid.compositeToFlatCanvas();
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.tileGrid.width;
    tempCanvas.height = this.tileGrid.height;
    const tctx = tempCanvas.getContext('2d')!;
    tctx.translate(this.tileGrid.width, 0);
    tctx.scale(-1, 1);
    tctx.drawImage(flat, 0, 0);

    this.tileGrid.clear();
    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        tile.ctx.drawImage(
          tempCanvas,
          tile.pixelX, tile.pixelY, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }

  /** Odbicie obejmuje piksele i maskę (operacja na całym obrazie). */
  public flipVertical(): void {
    const was = this.editMask;
    this.editMask = false;
    this.flipTargetVertical();
    if (this.maskGrid) {
      this.editMask = true;
      this.flipTargetVertical();
    }
    this.editMask = was;
  }

  private flipTargetVertical(): void {
    const flat = this.tileGrid.compositeToFlatCanvas();
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.tileGrid.width;
    tempCanvas.height = this.tileGrid.height;
    const tctx = tempCanvas.getContext('2d')!;
    tctx.translate(0, this.tileGrid.height);
    tctx.scale(1, -1);
    tctx.drawImage(flat, 0, 0);

    this.tileGrid.clear();
    for (let ty = 0; ty < this.tileGrid.rows; ty++) {
      for (let tx = 0; tx < this.tileGrid.cols; tx++) {
        const tile = this.tileGrid.tiles[ty][tx];
        tile.ctx.drawImage(
          tempCanvas,
          tile.pixelX, tile.pixelY, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }
    this.updateThumbnail();
  }
}
