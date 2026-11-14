/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TileGrid } from './TileGrid.ts';
import type { Tile } from './Tile.ts';

/**
 * Kanały dokumentu (panel „Kanały”).
 *
 * - Kanały koloru R, G, B: nie mają własnych danych (to składowe kompozytu). Mają dwa niezależne stany:
 *   „oko” (co widać na płótnie) i „zaznaczenie” (do których kanałów trafiają zmiany pikseli).
 * - Kanały alfa: zapisane zaznaczenia / maski w skali szarości. Przechowywane rzadko (`TileGrid`: biel o przezroczystości
 *   równej pokryciu; kafelek bez treści = 0), więc pusty obszar nic nie kosztuje. Siatka kanału jest po zapisaniu NIEZMIENNA
 *   (każda operacja tworzy nową), dzięki czemu historia trzyma je przez referencję.
 *
 * Wygląd płótna: maska widoczności R/G/B jest filtrem kolorów nakładanym na gotowy obraz (patrz `buildChannelMatrix`),
 * a kanały alfa rysuje osobna nakładka (patrz `renderAlphaOverlay`).
 */

export type ColorChannel = 'r' | 'g' | 'b';
export const COLOR_CHANNELS: readonly ColorChannel[] = ['r', 'g', 'b'];

/** Sposób łączenia nowej maski z istniejącą (zapis do kanału / wczytanie jako zaznaczenie). */
export type ChannelCombine = 'replace' | 'add' | 'subtract' | 'intersect';

export interface AlphaChannel {
  id: string;
  name: string;
  grid: TileGrid;
}

/** Stan zmieniany przez historię (lista kanałów alfa). Siatki są współdzielone przez referencję. */
export type AlphaList = AlphaChannel[];

/** Co pokazać na płótnie. */
export interface ChannelDisplay {
  /** 20 liczb macierzy 4x5 filtra kolorów (feColorMatrix) albo null, gdy kolory nie są zmieniane. */
  matrix: number[] | null;
  /** Kanały alfa rysowane nakładką (czerwona maska przy widocznym obrazie). */
  overlay: AlphaChannel[];
  /** Obraz zasłonięty podglądem kanałów alfa w skali szarości (wszystkie kanały koloru ukryte). */
  solo: boolean;
}

const IDENTITY: number[] = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];

export class ChannelModel {
  /** „Oko” kanałów koloru. */
  public visible: Record<ColorChannel, boolean> = { r: true, g: true, b: true };
  /** Zaznaczenie kanałów koloru: tylko one przyjmują zmiany pikseli. */
  public selected: Record<ColorChannel, boolean> = { r: true, g: true, b: true };
  public alpha: AlphaList = [];
  /** „Oko” kanałów alfa. */
  public alphaVisible = new Set<string>();
  /** Zaznaczony kanał alfa (podgląd / cel poleceń panelu). */
  public selectedAlpha: string | null = null;
  /** Pojedynczy widoczny kanał koloru pokazywany jako odcienie szarości (domyślnie jak w programach graficznych). */
  public singleAsGray = true;
  /** Rośnie przy każdej zmianie, która wpływa na wygląd płótna lub panel. */
  public version = 0;
  private seq = 1;

  public touch(): void {
    this.version++;
  }

  /** Nowy, unikalny identyfikator kanału. */
  public nextId(): string {
    return `ch_${Date.now().toString(36)}_${this.seq++}`;
  }

  public find(id: string | null): AlphaChannel | null {
    if (!id) return null;
    return this.alpha.find((c) => c.id === id) ?? null;
  }

  /** Domyślna nazwa nowego kanału alfa („Alfa 1”, „Alfa 2”...). */
  public nextName(): string {
    const used = new Set(this.alpha.map((c) => c.name));
    for (let i = 1; i < 10000; i++) {
      const n = `Alfa ${i}`;
      if (!used.has(n)) return n;
    }
    return 'Alfa';
  }

  /** Wszystko jak w świeżym dokumencie: bez kanałów alfa, wszystkie kanały koloru widoczne i zaznaczone. */
  public isDefaultView(): boolean {
    return this.visible.r && this.visible.g && this.visible.b && this.alphaVisible.size === 0;
  }

  public isDefaultEdit(): boolean {
    return this.selected.r && this.selected.g && this.selected.b && this.selectedAlpha === null;
  }

  /** Kanały koloru przyjmujące zmiany pikseli (kanał alfa jest tylko do podglądu, więc przy jego zaznaczeniu zmiany są blokowane). */
  public editable(): Record<ColorChannel, boolean> {
    return { r: this.selected.r, g: this.selected.g, b: this.selected.b };
  }

  public setList(list: AlphaList): void {
    this.alpha = list.map((c) => ({ ...c }));
    const ids = new Set(this.alpha.map((c) => c.id));
    for (const id of [...this.alphaVisible]) if (!ids.has(id)) this.alphaVisible.delete(id);
    if (this.selectedAlpha && !ids.has(this.selectedAlpha)) this.selectedAlpha = null;
    this.touch();
  }

  /** Kliknięcie wiersza „RGB”: wszystko widoczne i zaznaczone. */
  public selectComposite(): void {
    this.selected = { r: true, g: true, b: true };
    this.visible = { r: true, g: true, b: true };
    this.selectedAlpha = null;
    this.touch();
  }

  /** Kliknięcie kanału koloru; `additive` (Ctrl / Shift) dodaje lub usuwa go z zaznaczenia. */
  public selectColor(ch: ColorChannel, additive: boolean): void {
    if (additive && this.selectedAlpha === null) {
      const next = { ...this.selected, [ch]: !this.selected[ch] };
      // zawsze zostaje co najmniej jeden zaznaczony kanał
      if (next.r || next.g || next.b) this.selected = next;
    } else {
      this.selected = { r: false, g: false, b: false, [ch]: true } as Record<ColorChannel, boolean>;
    }
    this.selectedAlpha = null;
    // „oko” podąża za zaznaczeniem: widać dokładnie wybrane kanały
    this.visible = { ...this.selected };
    this.touch();
  }

  /** Kliknięcie kanału alfa: zaznacza go i pokazuje samodzielnie w skali szarości. */
  public selectAlphaChannel(id: string): void {
    if (!this.find(id)) return;
    this.selectedAlpha = id;
    this.selected = { r: false, g: false, b: false };
    this.visible = { r: false, g: false, b: false };
    this.alphaVisible = new Set([id]);
    this.touch();
  }

  public toggleColorEye(ch: ColorChannel): void {
    this.visible = { ...this.visible, [ch]: !this.visible[ch] };
    this.touch();
  }

  /** Oko wiersza „RGB”: ukrywa albo pokazuje wszystkie kanały koloru naraz. */
  public toggleCompositeEye(): void {
    const all = this.visible.r && this.visible.g && this.visible.b;
    this.visible = { r: !all, g: !all, b: !all };
    this.touch();
  }

  public toggleAlphaEye(id: string): void {
    if (!this.find(id)) return;
    const s = new Set(this.alphaVisible);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.alphaVisible = s;
    this.touch();
  }

  /** Stan widoku do narysowania. */
  public display(): ChannelDisplay {
    const v = this.visible;
    const count = (v.r ? 1 : 0) + (v.g ? 1 : 0) + (v.b ? 1 : 0);
    const shown = this.alpha.filter((c) => this.alphaVisible.has(c.id));
    // żaden kanał koloru nie jest widoczny, ale pokazywany jest kanał alfa: podgląd samego kanału w skali szarości
    const solo = count === 0 && shown.length > 0;
    return {
      matrix: buildChannelMatrix(v, this.singleAsGray),
      overlay: shown,
      solo,
    };
  }

  /** Krótki podpis stanu widoku (do kluczy pamięci podręcznej i porównań). */
  public viewSignature(): string {
    return `${this.version}|${this.visible.r ? 1 : 0}${this.visible.g ? 1 : 0}${this.visible.b ? 1 : 0}|${[...this.alphaVisible].join(',')}|${this.singleAsGray ? 1 : 0}`;
  }
}

/**
 * Macierz 4x5 filtra kolorów dla widoczności kanałów.
 * - wszystkie widoczne: brak filtra (null);
 * - jeden widoczny: odcienie szarości tego kanału (gdy `asGray`), inaczej tylko ten kanał w kolorze;
 * - dwa widoczne: ukryty kanał jest zerowany (czarny); brak widocznych: czerń (przezroczystość zostaje).
 */
export function buildChannelMatrix(v: Record<ColorChannel, boolean>, asGray: boolean): number[] | null {
  const count = (v.r ? 1 : 0) + (v.g ? 1 : 0) + (v.b ? 1 : 0);
  if (count === 3) return null;
  const m = IDENTITY.slice();
  if (count === 1 && asGray) {
    const row = v.r ? [1, 0, 0] : v.g ? [0, 1, 0] : [0, 0, 1];
    for (let i = 0; i < 3; i++) {
      m[i * 5] = row[0];
      m[i * 5 + 1] = row[1];
      m[i * 5 + 2] = row[2];
    }
    return m;
  }
  if (!v.r) m[0] = 0;
  if (!v.g) m[6] = 0;
  if (!v.b) m[12] = 0;
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Dane kanałów alfa
// ---------------------------------------------------------------------------------------------------------------

/** Prostokąt (piksele dokumentu) zajęty przez treść siatki z dokładnością do kafelka; null = siatka pusta. */
export function gridContentBounds(grid: TileGrid): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const row of grid.tiles) {
    for (const t of row) {
      if (!t.hasContent) continue;
      x0 = Math.min(x0, t.pixelX);
      y0 = Math.min(y0, t.pixelY);
      x1 = Math.max(x1, t.pixelX + t.width);
      y1 = Math.max(y1, t.pixelY + t.height);
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

export function gridContentTiles(grid: TileGrid): number {
  let n = 0;
  for (const row of grid.tiles) for (const t of row) if (t.hasContent) n++;
  return n;
}

/**
 * Pokrycie piksela kanału to jasność × przezroczystość: biel z przezroczystością = pokrycie (tak zapisuje się zaznaczenie),
 * czerń = 0 (tak maluje pędzel i gumka w trybie szarości). Zamienia dane na „biel z przezroczystością równą pokryciu”.
 */
export function coverageToWhite(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    const cov = Math.round(((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a) / 255);
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = cov;
  }
}

/** Rysuje pokrycie kanału (biel z przezroczystością) w prostokącie (x0, y0, w, h) układu dokumentu. */
export function drawCoverage(grid: TileGrid, ctx: CanvasRenderingContext2D, x0: number, y0: number, w: number, h: number): void {
  for (const row of grid.tiles) {
    for (const t of row) {
      if (!t.hasContent) continue;
      if (t.pixelX >= x0 + w || t.pixelX + t.width <= x0 || t.pixelY >= y0 + h || t.pixelY + t.height <= y0) continue;
      const img = t.ctx.getImageData(0, 0, t.width, t.height);
      coverageToWhite(img.data);
      ctx.putImageData(img, t.pixelX - x0, t.pixelY - y0);
    }
  }
}

function tileHasAlpha(t: Tile): boolean {
  const d = t.ctx.getImageData(0, 0, t.width, t.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
  return false;
}

/**
 * Siatka kanału z płótna z pokryciem w kanale alfa (maska zaznaczenia). `region` ogranicza przeglądane kafelki
 * (poza nim kanał jest pusty). Biel o przezroczystości równej pokryciu.
 */
export function gridFromCoverage(
  src: HTMLCanvasElement,
  width: number,
  height: number,
  tileSize: number,
  region: { x0: number; y0: number; x1: number; y1: number } | null
): TileGrid {
  const g = new TileGrid(width, height, tileSize);
  if (!region) return g;
  const tx0 = Math.max(0, Math.floor(region.x0 / tileSize));
  const ty0 = Math.max(0, Math.floor(region.y0 / tileSize));
  const tx1 = Math.min(g.cols - 1, Math.floor((region.x1 - 1) / tileSize));
  const ty1 = Math.min(g.rows - 1, Math.floor((region.y1 - 1) / tileSize));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const t = g.tiles[ty][tx];
      t.ctx.clearRect(0, 0, t.width, t.height);
      t.ctx.drawImage(src, t.pixelX, t.pixelY, t.width, t.height, 0, 0, t.width, t.height);
      if (tileHasAlpha(t)) {
        t.hasContent = true;
        t.isDirty = true;
      } else {
        t.hasContent = false;
      }
    }
  }
  return g;
}

/**
 * Łączy maskę (płótno z pokryciem w kanale alfa) z istniejącą siatką kanału i zwraca NOWĄ siatkę.
 * replace: sama maska; add: suma; subtract: kanał bez maski; intersect: część wspólna.
 */
export function combineIntoGrid(
  base: TileGrid | null,
  mask: HTMLCanvasElement,
  maskBounds: { x0: number; y0: number; x1: number; y1: number } | null,
  mode: ChannelCombine,
  width: number,
  height: number,
  tileSize: number
): TileGrid {
  if (mode === 'replace' || !base) {
    return mode === 'intersect' && !base ? new TileGrid(width, height, tileSize) : gridFromCoverage(mask, width, height, tileSize, maskBounds);
  }
  const out = base.clone();
  const touch = (t: Tile, applyMask: boolean) => {
    const tmp = document.createElement('canvas');
    tmp.width = t.width;
    tmp.height = t.height;
    const c = tmp.getContext('2d', { willReadFrequently: true })!;
    if (t.hasContent) {
      const bi = t.ctx.getImageData(0, 0, t.width, t.height);
      coverageToWhite(bi.data);
      c.putImageData(bi, 0, 0);
    }
    if (applyMask) {
      c.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
      c.drawImage(mask, t.pixelX, t.pixelY, t.width, t.height, 0, 0, t.width, t.height);
    } else if (mode === 'intersect') {
      c.clearRect(0, 0, t.width, t.height); // poza maską część wspólna jest pusta
    }
    const d = c.getImageData(0, 0, t.width, t.height);
    let any = false;
    for (let i = 3; i < d.data.length; i += 4) if (d.data[i] > 0) { any = true; break; }
    t.ctx.clearRect(0, 0, t.width, t.height);
    if (any) t.ctx.putImageData(d, 0, 0);
    t.hasContent = any;
    t.isDirty = true;
  };
  const inB = (t: Tile) => !!maskBounds && t.pixelX < maskBounds.x1 && t.pixelX + t.width > maskBounds.x0 && t.pixelY < maskBounds.y1 && t.pixelY + t.height > maskBounds.y0;
  for (const row of out.tiles) {
    for (const t of row) {
      const inside = inB(t);
      if (inside) touch(t, true);
      else if (mode === 'intersect' && t.hasContent) touch(t, false);
    }
  }
  return out;
}

/** Rysuje siatkę kanału na kontekście (biel z pokryciem) w skali `s`. */
export function drawChannelGrid(ctx: CanvasRenderingContext2D, grid: TileGrid, dw: number, dh: number): void {
  grid.drawThumbnail(ctx, dw, dh);
}

/** Nakładka kanałów alfa na płótnie widoku (urządzenie): czerwona maska nad obrazem albo podgląd w skali szarości. */
export function renderAlphaOverlay(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  left: number,
  top: number,
  zoom: number,
  docW: number,
  docH: number,
  channels: AlphaChannel[],
  solo: boolean,
  cache: WeakMap<TileGrid, HTMLCanvasElement>
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (channels.length === 0) return;
  const dw = docW * zoom;
  const dh = docH * zoom;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, dw, dh);
  ctx.clip();
  if (solo) {
    ctx.fillStyle = '#000';
    ctx.fillRect(left, top, dw, dh);
  }
  ctx.imageSmoothingEnabled = zoom < 2;
  ctx.imageSmoothingQuality = 'medium';
  for (const c of channels) {
    const img = tintedRaster(c.grid, solo, cache);
    if (!img) continue;
    ctx.globalAlpha = solo ? 1 : 0.5;
    ctx.globalCompositeOperation = solo ? 'lighter' : 'source-over';
    ctx.drawImage(img, left, top, dw, dh);
  }
  ctx.restore();
}

/** Podpis zawartości siatki (suma wersji kafelków): zmienia się przy każdej edycji, więc raster nakładki nie bywa nieaktualny. */
export function gridSignature(grid: TileGrid): string {
  let sum = 0;
  let n = 0;
  for (const row of grid.tiles) {
    for (const t of row) {
      if (!t.hasContent) continue;
      sum = (sum + t.version * 2654435761) % 4294967291;
      n++;
    }
  }
  return `${grid.width}x${grid.height}:${n}:${sum}`;
}

/**
 * Zmniejszony (do 2048 px) raster kanału: biały (podgląd) albo czerwony (nakładka); pamiętany dla danej siatki.
 * Pokrycie liczone jest z jasności i przezroczystości (jak przy edycji kanału), próbkowanie jest „najbliższym sąsiadem”
 * w skali będącej potęgą dwójki, więc na łączeniach kafelków nie powstają szwy (filtr dwuliniowy mieszałby brzeg kafelka
 * z przezroczystością sąsiada, co na karcie graficznej było widać jako siatka).
 */
function tintedRaster(grid: TileGrid, solo: boolean, cache: WeakMap<TileGrid, HTMLCanvasElement>): HTMLCanvasElement | null {
  const slot = (solo ? 'w' : 'r') + gridSignature(grid);
  const hit = cache.get(grid) as (HTMLCanvasElement & { __k?: string }) | undefined;
  if (hit && hit.__k === slot) return hit;
  let div = 1;
  while (Math.max(grid.width, grid.height) / div > 2048 && div < grid.tileSize) div *= 2;
  while (div > 1 && grid.tileSize % div !== 0) div >>= 1;
  const w = Math.max(1, Math.ceil(grid.width / div));
  const h = Math.max(1, Math.ceil(grid.height / div));
  const img = new ImageData(w, h);
  const o = img.data;
  const cr = 255;
  const cg = solo ? 255 : 42;
  const cb = solo ? 255 : 42;
  for (const row of grid.tiles) {
    for (const t of row) {
      if (!t.hasContent) continue;
      const src = t.ctx.getImageData(0, 0, t.width, t.height).data;
      const ox = t.pixelX / div;
      const oy = t.pixelY / div;
      const tw = Math.ceil(t.width / div);
      const th = Math.ceil(t.height / div);
      for (let y = 0; y < th; y++) {
        const sy = Math.min(t.height - 1, y * div);
        for (let x = 0; x < tw; x++) {
          const sx = Math.min(t.width - 1, x * div);
          const i = (sy * t.width + sx) * 4;
          const a = src[i + 3];
          if (a === 0) continue;
          const cov = Math.round(((0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2]) * a) / 255);
          if (cov === 0) continue;
          const j = ((oy + y) * w + (ox + x)) * 4;
          o[j] = cr;
          o[j + 1] = cg;
          o[j + 2] = cb;
          o[j + 3] = cov;
        }
      }
    }
  }
  const c = document.createElement('canvas') as HTMLCanvasElement & { __k?: string };
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(img, 0, 0);
  c.__k = slot;
  cache.set(grid, c);
  return c;
}

// ---------------------------------------------------------------------------------------------------------------
// Zmiany pikseli tylko w zaznaczonych kanałach
// ---------------------------------------------------------------------------------------------------------------

export interface TileSnapLike {
  tx: number;
  ty: number;
  imgData: ImageData;
  hasContent: boolean;
}

/**
 * Ogranicza zmianę pikseli do zaznaczonych kanałów koloru: w `after` kanały niezaznaczone dostają wartości z `before`
 * (piksele nieprzezroczyste i częściowo przezroczyste są liczone w niewymnożonej postaci, jak w ImageData).
 * Zwraca kafelki do wpisania w siatkę (nowe ImageData) albo null, gdy ograniczenie nie zmienia niczego.
 */
export function restrictSnapshotsToChannels(
  before: TileSnapLike[],
  after: TileSnapLike[],
  ed: Record<ColorChannel, boolean>
): TileSnapLike[] | null {
  if (ed.r && ed.g && ed.b) return null;
  const bm = new Map<number, TileSnapLike>();
  for (const b of before) bm.set(b.ty * 100000 + b.tx, b);
  const out: TileSnapLike[] = [];
  for (const a of after) {
    const b = bm.get(a.ty * 100000 + a.tx);
    const ad = a.imgData.data;
    const w = a.imgData.width;
    const h = a.imgData.height;
    const res = new ImageData(w, h);
    const rd = res.data;
    const bd = b && b.hasContent ? b.imgData.data : null;
    let any = false;
    for (let i = 0; i < ad.length; i += 4) {
      const aa = ad[i + 3];
      if (aa === 0) {
        // piksel wymazany / pusty: bez zmian względem nowego stanu (alfa nie jest kanałem do zaznaczenia)
        continue;
      }
      rd[i] = ed.r ? ad[i] : bd ? bd[i] : 0;
      rd[i + 1] = ed.g ? ad[i + 1] : bd ? bd[i + 1] : 0;
      rd[i + 2] = ed.b ? ad[i + 2] : bd ? bd[i + 2] : 0;
      rd[i + 3] = aa;
      any = true;
    }
    out.push({ tx: a.tx, ty: a.ty, imgData: res, hasContent: any || a.hasContent });
  }
  return out;
}
