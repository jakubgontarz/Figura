/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PenNode, penAllPoints } from './PenPath.ts';
import { Layer, grayToAlpha, finishPassThrough } from './Layer.ts';
import { Quad, drawPerspectiveMesh, drawPerspectivePreview, isConvexQuad, warpPerspectiveExact, warpPerspectivePreview, PerspectivePreview, WarpResult } from './Perspective.ts';
import { renderGradientPreview } from './GradientRenderer.ts';
import { BrushEngine } from './BrushEngine.ts';
import { SelectionManager, SelectionSnapshot } from './SelectionManager.ts';
import { getTileEpoch, Tile } from './Tile.ts';
import { FillClient } from './FillClient.ts';
import { BucketAlpha, WandCrop, bucketAlphaOfFlood, floodSelect } from './WandCore.ts';
import { DEFAULT_TILE_SIZE, TileGrid, TileSnapshot, trimUnchangedTiles, snapshotBytes } from './TileGrid.ts';
import {
  BrushSettings,
  FiguraProjectFile,
  GradientSettings,
  InterpolationMode,
  LineAndCurveSettings,
  SKBlendMode,
  SKColor,
  SKPoint,
  SKRectI,
  SelectionSettings,
  StampSampleSource,
  StampSettings,
  VectorShapeSettings,
  TextCharStyle,
  TextToolSettings,
  WandSampleSource,
  getCanvasCompositeOperation,
} from './types.ts';
import {
  renderVectorPath,
  renderVectorLine,
  renderVectorShape,
} from './VectorRenderer.ts';
import { RichText, renderVectorText } from './TextEngine.ts';

export interface TransformContentSession {
  sourceContentCanvas: HTMLCanvasElement;
  sourceBounds: SKRectI;
  sourceLayerIndex: number;
  initialTilesSnapshot: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
  initialSelectionSnapshot: SelectionSnapshot;
  interpolation: InterpolationMode;
  /** Połączona maska: druga siatka (maska, gdy edytowane są piksele, i odwrotnie) przesuwana razem z pierwszą. */
  other?: { grid: TileGrid; content: HTMLCanvasElement; cutMask: HTMLCanvasElement; before: TileSnapshotLike[] } | null;
  /** Podgląd pływającej zawartości (piksele zamaskowane poruszaną maską); gdy brak, używana jest `sourceContentCanvas`. */
  previewCanvas?: HTMLCanvasElement | null;
  /** Maska zaznaczenia w układzie źródła (rozmiar `sourceContentCanvas`); potrzebna w trybie perspektywy. */
  srcMask?: HTMLCanvasElement | null;
  /** Zawartość niesie własne (ułamkowe) krycie brzegu zaznaczenia, więc przy zatwierdzaniu nie jest przycinana maską drugi raz. */
  softContent?: boolean;
  /** Maska wycinania z warstwy (krycie = waga w, ta sama co w pływającym fragmencie): warstwa traci dokładnie to, co fragment dostaje. */
  cutMask?: HTMLCanvasElement;
  /** Czy wycięcie zostało już wykonane na warstwie (odroczone do pierwszej zmiany względem stanu początkowego). */
  cutDone?: boolean;
  /** Stan warstwy „bez wycięcia” przywracany w stanie początkowym (wklejenie zaraz po wycięciu w tym samym miejscu). */
  identityTiles?: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
  /** Zawartość została już raz przeliczona (perspektywa), więc stan ramki nie jest „identycznością” względem warstwy. */
  contentChanged?: boolean;
  /** Tryb perspektywy: aktualny czworokąt (lewy-górny, prawy-górny, prawy-dolny, lewy-dolny) i jego stan początkowy. */
  persp?: { quad: Quad; quad0: Quad; changed: boolean; cache?: { key: string; pv: PerspectivePreview | null } } | null;
}

/** Element drzewa warstw: zwykła warstwa albo grupa (nagłówek + dzieci od dołu do góry). */
/** Stały numer kafelka (do kluczy pamięci podręcznej pośredników grup: kafelek mógł zostać podmieniony, np. przez cofnięcie). */
const EMPTY_PASS = new Map<number, Layer>();
const tileUids = new WeakMap<object, number>();
let tileUidNext = 1;
function tileUid(t: Tile): number {
  let id = tileUids.get(t);
  if (id === undefined) {
    id = tileUidNext++;
    tileUids.set(t, id);
  }
  return id;
}

/** Pośrednik grupy z ustawieniami: zwykła warstwa, której kafelki to spłaszczone dzieci (patrz `getRenderList`). */
interface GroupProxyEntry {
  layer: Layer;
  maskRef: TileGrid | null;
  keys: string[];
  epoch: number;
  listId: number;
}

interface RenderList {
  layers: Layer[];
  /** Indeks rzeczywistej warstwy dla każdej pozycji `layers`. */
  map: number[];
  iso: { start: number; header: number; group: Layer } | null;
  proxies: { entry: GroupProxyEntry; kids: Layer[] }[];
  /** Grupy „Przepuszczanie” z krytem / maską i warstwami o trybie innym niż Normalny: pozycja pierwszego dziecka -> grupa. */
  passAtStart: Map<number, Layer>;
  /** ... pozycja nagłówka -> grupa (tu następuje domknięcie: tło * (1 - a) + wynik * a). */
  passAtEnd: Map<number, Layer>;
  id: number;
}

interface LayerUnit {
  layer?: Layer;
  header?: Layer;
  children?: Layer[];
}

type TileSnapshotLike = { tx: number; ty: number; imgData: ImageData; hasContent: boolean };

export type HistoryAction =
  | {
      type: 'tiles';
      description: string;
      layerIndex: number;
      /** true = zmiana dotyczy maski warstwy, a nie jej pikseli */
      onMask?: boolean;
      /** druga siatka (piksele <-> maska) zmieniona razem z pierwszą (połączone klonowanie) */
      other?: { before: TileSnapshotLike[]; after: TileSnapshotLike[] };
      before: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
      after: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
    }
  | {
      type: 'layerProperty';
      description: string;
      layerIndex: number;
      property: 'opacity' | 'blendMode' | 'visible' | 'maskEnabled' | 'maskLinked';
      oldValue: number | SKBlendMode | boolean;
      newValue: number | SKBlendMode | boolean;
    }
  | {
      type: 'layers';
      description: string;
      layers: Layer[];
      activeLayerIndex: number;
    }
  | {
      type: 'selection';
      description: string;
      before: SelectionSnapshot;
      after: SelectionSnapshot;
    }
  | {
      type: 'transformContent';
      description: string;
      layerIndex: number;
      onMask?: boolean;
      /** druga siatka (piksele <-> maska) przekształcona razem z pierwszą, gdy maska jest połączona z warstwą */
      other?: { before: TileSnapshotLike[]; after: TileSnapshotLike[] };
      tilesBefore: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
      tilesAfter: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
      selectionBefore: SelectionSnapshot;
      selectionAfter: SelectionSnapshot;
    };

/**
 * Zoptymalizowany silnik graficzny programu FIGURA:
 * - Kafelkowanie TileGrid 64x64px i Dirty-Rect.
 * - Bezpieczne maskowanie pędzla podczas rysowania na żywo (bez wymazywania warstwy pod spodem).
 */
export interface GradientPreviewParams {
  p0: SKPoint;
  p1: SKPoint;
  settings: GradientSettings;
  /** Kolor początkowy / końcowy PRZED uwzględnieniem odwrócenia (settings.reverse) */
  primary: SKColor;
  secondary: SKColor;
  blendMode: SKBlendMode;
}

export class GraphicEngine {
  public id: string;
  public title: string;
  public width: number;
  public height: number;
  public tileSize: number;

  public layers: Layer[] = [];
  public activeLayerIndex: number = 0;

  public brushEngine: BrushEngine;
  public selectionManager: SelectionManager;

  // Sesja nieinwazyjnego przekształcania zawartości zaznaczenia
  public transformContentSession: TransformContentSession | null = null;
  /**
   * true = pływającą zawartość sesji przekształcania rysuje zewnętrzny renderer podglądu (ViewportTileRenderer: tryb mieszania
   * i krycie warstwy, kafelki), więc kompozycja dokumentu jej NIE zawiera (płótno dokumentu pokazuje warstwę z otworem).
   */
  public floatingContentExternal: boolean = false;

  // Stan interaktywnego narzedzia Wiadro z woda (Paint Bucket)
  public bucketSeedPoint: SKPoint | null = null;
  public bucketInitialLayerIndex: number = -1;
  public bucketColorSource: 'primary' | 'secondary' = 'primary';
  /**
   * Wypełnienie wiadra w trakcie edycji (maska alfa w prostokącie). Warstwa NIE jest modyfikowana podczas przeciągania
   * uchwytu ani suwaka: podgląd rysują kafelki ekranu (jak przy gradiencie), a piksele zmieniane są raz, przy zatwierdzeniu.
   * Obszar liczy wątek roboczy, więc uchwyt i suwak reagują od razu, a wynik pojawia się, gdy jest gotowy.
   */
  private bucketPreview: {
    x: number;
    y: number;
    w: number;
    h: number;
    alpha: Uint8Array;
    seq: number;
    tinted: HTMLCanvasElement | null;
    tintKey: string;
  } | null = null;
  private bucketParams: {
    tol: number;
    global: boolean;
    sampleSource: WandSampleSource | undefined;
    aa: boolean;
    blend: SKBlendMode;
    color: SKColor;
  } | null = null;
  private bucketJob: { id: number } | null = null;
  private bucketGeomKey: string | null = null;
  private bucketSeq = 0;
  private selAlphaPath: unknown = null;
  private selAlphaSeq = 0;
  /** Wywoływane, gdy wynik liczony w tle (różdżka, wiadro) jest gotowy i trzeba odświeżyć widok */
  public onAsyncUpdate: (() => void) | null = null;

  // Stan interaktywnego narzędzia Wypełnienie gradientowe (Gradient Fill)
  public gradientStartPoint: SKPoint | null = null;
  public gradientEndPoint: SKPoint | null = null;
  public gradientInitialTilesSnapshot: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] | null = null;
  public gradientInitialLayerIndex: number = -1;
  public gradientColorSource: 'primary' | 'secondary' = 'primary';
  /**
   * Parametry gradientu w trakcie edycji. Warstwa NIE jest modyfikowana podczas przeciągania uchwytów:
   * podgląd liczą kafelki ekranu (ViewportTileRenderer), a piksele zmieniane są raz, przy zatwierdzeniu.
   */
  public gradientPreview: GradientPreviewParams | null = null;

  // Wewnętrzny schowek aplikacji FIGURA
  public clipboardCanvas: HTMLCanvasElement | null = null;
  public clipboardMaskCanvas: HTMLCanvasElement | null = null;

  private undoStack: HistoryAction[] = [];
  private redoStack: HistoryAction[] = [];
  private maxHistory: number = 30;
  /** Limit pamięci historii (migawki pikseli); najstarsze akcje są usuwane po jego przekroczeniu. */
  public maxHistoryBytes: number = 512 * 1024 * 1024;
  private historyBytesCache = new WeakMap<object, number>();

  public lastDirtyRect: SKRectI | null = null;
  private checkerPatternCanvas: HTMLCanvasElement | null = null;

  private dirtyScratchCanvas: HTMLCanvasElement | null = null;
  private dirtyScratchCtx: CanvasRenderingContext2D | null = null;

  private vectorPreviewCanvas: HTMLCanvasElement | null = null;
  private vectorPreviewCtx: CanvasRenderingContext2D | null = null;

  constructor(
    title: string = 'obraz1.fig',
    width: number = 800,
    height: number = 600,
    tileSize: number = DEFAULT_TILE_SIZE
  ) {
    this.id = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    this.title = title;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.tileSize = tileSize;
    this.brushEngine = new BrushEngine();
    this.brushEngine.ensureBufferSize(this.width, this.height);
    this.selectionManager = new SelectionManager(this.width, this.height);

    this.initDefaultLayers();
    this.initCheckerPattern();

    // Operacje czytające zaznaczenie lub warstwę najpierw dokańczają to, co liczy się w tle (różdżka, wiadro)
    const self = this as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of [
      'undo',
      'redo',
      'deselect',
      'selectAll',
      'invertSelection',
      'copy',
      'cut',
      'pasteCanvas',
      'applySelectionShape',
      'beginTransformContent',
    ]) {
      const orig = self[name];
      if (typeof orig !== 'function') continue;
      self[name] = (...a: unknown[]) => {
        this.flushPendingFill();
        return orig.apply(this, a);
      };
    }
  }

  public initDefaultLayers(): void {
    this.layers = [];

    // Tło (Białe)
    const backgroundLayer = new Layer('bg', 'Tło', this.width, this.height, this.tileSize);
    backgroundLayer.fill({ r: 255, g: 255, b: 255, a: 255 });
    this.layers.push(backgroundLayer);

    // Warstwa 1 (Przezroczysta)
    const layer1 = new Layer('layer1', 'Warstwa 1', this.width, this.height, this.tileSize);
    layer1.updateThumbnail();
    this.layers.push(layer1);

    this.activeLayerIndex = 1;
    this.selectionManager.resize(this.width, this.height);
    this.clearHistory();
  }

  private initCheckerPattern(): void {
    const pCanvas = document.createElement('canvas');
    pCanvas.width = 16;
    pCanvas.height = 16;
    const pCtx = pCanvas.getContext('2d');
    if (pCtx) {
      pCtx.fillStyle = '#ffffff';
      pCtx.fillRect(0, 0, 16, 16);
      pCtx.fillStyle = '#e4e4e4';
      pCtx.fillRect(0, 0, 8, 8);
      pCtx.fillRect(8, 8, 8, 8);
    }
    this.checkerPatternCanvas = pCanvas;
  }

  private getDirtyScratch(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    if (!this.dirtyScratchCanvas) {
      this.dirtyScratchCanvas = document.createElement('canvas');
      this.dirtyScratchCanvas.width = Math.max(256, w);
      this.dirtyScratchCanvas.height = Math.max(256, h);
      this.dirtyScratchCtx = this.dirtyScratchCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (this.dirtyScratchCanvas.width < w || this.dirtyScratchCanvas.height < h) {
      this.dirtyScratchCanvas.width = Math.max(this.dirtyScratchCanvas.width, w);
      this.dirtyScratchCanvas.height = Math.max(this.dirtyScratchCanvas.height, h);
    }
    return { canvas: this.dirtyScratchCanvas, ctx: this.dirtyScratchCtx! };
  }

  private brushMaskCanvas: HTMLCanvasElement | null = null;
  private brushMaskCtx: CanvasRenderingContext2D | null = null;
  private getBrushMaskScratch(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    if (!this.brushMaskCanvas) {
      this.brushMaskCanvas = document.createElement('canvas');
      this.brushMaskCanvas.width = Math.max(256, w);
      this.brushMaskCanvas.height = Math.max(256, h);
      this.brushMaskCtx = this.brushMaskCanvas.getContext('2d');
    }
    if (this.brushMaskCanvas.width < w || this.brushMaskCanvas.height < h) {
      this.brushMaskCanvas.width = Math.max(this.brushMaskCanvas.width, w);
      this.brushMaskCanvas.height = Math.max(this.brushMaskCanvas.height, h);
    }
    return { canvas: this.brushMaskCanvas, ctx: this.brushMaskCtx! };
  }

  private getVectorScratch(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    if (!this.vectorPreviewCanvas) {
      this.vectorPreviewCanvas = document.createElement('canvas');
      this.vectorPreviewCanvas.width = Math.max(256, w);
      this.vectorPreviewCanvas.height = Math.max(256, h);
      this.vectorPreviewCtx = this.vectorPreviewCanvas.getContext('2d');
    }
    if (this.vectorPreviewCanvas.width !== w || this.vectorPreviewCanvas.height !== h) {
      this.vectorPreviewCanvas.width = w;
      this.vectorPreviewCanvas.height = h;
      this.vectorPreviewCtx = this.vectorPreviewCanvas.getContext('2d');
    }
    return { canvas: this.vectorPreviewCanvas, ctx: this.vectorPreviewCtx! };
  }

  public getActiveLayer(): Layer {
    if (this.activeLayerIndex < 0 || this.activeLayerIndex >= this.layers.length) {
      this.activeLayerIndex = Math.max(0, this.layers.length - 1);
    }
    return this.layers[this.activeLayerIndex];
  }

  // --- HISTORIA UNDO / REDO ---

  private actionBytes(a: HistoryAction): number {
    const cached = this.historyBytesCache.get(a);
    if (cached !== undefined) return cached;
    let n = 0;
    const selBytes = (sn: { imgData: ImageData | null }) => (sn.imgData ? sn.imgData.data.byteLength : 0);
    switch (a.type) {
      case 'tiles':
        n = snapshotBytes(a.before, a.after);
        break;
      case 'transformContent':
        n = snapshotBytes(a.tilesBefore, a.tilesAfter) + selBytes(a.selectionBefore) + selBytes(a.selectionAfter);
        break;
      case 'selection':
        n = selBytes(a.before) + selBytes(a.after);
        break;
      case 'layers':
        for (const l of a.layers) {
          for (const row of l.pixelGrid.tiles) for (const t of row) if (t.hasContent) n += t.width * t.height * 4;
          if (l.maskGrid) for (const row of l.maskGrid.tiles) for (const t of row) if (t.hasContent) n += t.width * t.height * 4;
        }
        break;
      default:
        n = 0;
    }
    this.historyBytesCache.set(a, n);
    return n;
  }

  /** Szacunkowa pamięć zajmowana przez historię Undo/Redo (bajty). */
  public getHistoryBytes(): number {
    let total = 0;
    for (const a of this.undoStack) total += this.actionBytes(a);
    for (const a of this.redoStack) total += this.actionBytes(a);
    return total;
  }

  private finishHistoryPush(): void {
    this.redoStack = [];
    while (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    let total = this.getHistoryBytes();
    // Zawsze zostaje ostatnia akcja, nawet jeśli sama przekracza limit
    while (total > this.maxHistoryBytes && this.undoStack.length > 1) {
      total -= this.actionBytes(this.undoStack.shift()!);
    }
  }

  public saveFullSnapshot(description: string): void {
    const snapshotLayers = this.layers.map((l) => l.clone(l.id, l.name));
    this.undoStack.push({
      type: 'layers',
      description,
      layers: snapshotLayers,
      activeLayerIndex: this.activeLayerIndex,
    });
    this.finishHistoryPush();
  }

  public pushTileAction(action: HistoryAction): void {
    if ((action.type === 'tiles' || action.type === 'transformContent') && action.onMask === undefined) {
      const L = this.layers[action.layerIndex];
      action = { ...action, onMask: !!(L && L.editMask && L.maskGrid) };
    }
    // Zapamiętujemy tylko kafelki, które operacja faktycznie zmieniła
    if (action.type === 'tiles') {
      const t = trimUnchangedTiles(action.before, action.after);
      action = { ...action, before: t.before, after: t.after };
    } else if (action.type === 'transformContent') {
      const t = trimUnchangedTiles(action.tilesBefore, action.tilesAfter);
      action = { ...action, tilesBefore: t.before, tilesAfter: t.after };
    }
    this.undoStack.push(action);
    this.finishHistoryPush();
  }

  public pushPropertyAction(
    layerIndex: number,
    property: 'opacity' | 'blendMode' | 'visible' | 'maskEnabled' | 'maskLinked',
    oldValue: number | SKBlendMode | boolean,
    newValue: number | SKBlendMode | boolean,
    description: string
  ): void {
    this.undoStack.push({
      type: 'layerProperty',
      description,
      layerIndex,
      property,
      oldValue,
      newValue,
    });
    this.finishHistoryPush();
  }

  public syncTransformState(): void {
    if (this.transformContentSession) {
      this.cancelTransformContent();
    }
    if (this.selectionManager.hasActiveSelection) {
      this.selectionManager.beginTransformSelection();
    } else {
      this.selectionManager.transformState = null;
    }
  }

  /** Siatka, której dotyczy zapisana akcja historii (piksele albo maska). */
  private historyGrid(layer: Layer, onMask?: boolean): TileGrid {
    return onMask && layer.maskGrid ? layer.maskGrid : layer.pixelGrid;
  }

  private applyOtherSnapshot(layer: Layer, primaryOnMask: boolean | undefined, snap: TileSnapshotLike[]): void {
    const grid = primaryOnMask ? layer.pixelGrid : layer.maskGrid;
    if (!grid) return;
    for (const t of snap) {
      const tile = grid.getTile(t.tx, t.ty);
      if (tile) {
        tile.ctx.putImageData(t.imgData, 0, 0);
        tile.hasContent = t.hasContent;
        tile.isDirty = true;
      }
    }
  }

  public undo(): boolean {
    if (this.bucketSeedPoint) {
      this.commitPaintBucketSession();
    }
    if (this.gradientStartPoint) {
      this.commitGradientSession();
    }
    if (this.undoStack.length === 0) return false;

    if (this.transformContentSession) {
      this.cancelTransformContent();
    }

    const action = this.undoStack.pop()!;

    if (action.type === 'tiles') {
      const layer = this.layers[action.layerIndex];
      if (layer) {
        for (const t of action.before) {
          const tile = this.historyGrid(layer, action.onMask).getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
        if (action.other) this.applyOtherSnapshot(layer, action.onMask, action.other.before);
        layer.updateThumbnail();
      }
      this.redoStack.push(action);
    } else if (action.type === 'layerProperty') {
      const layer = this.layers[action.layerIndex];
      if (layer) {
        if (action.property === 'opacity') {
          layer.opacity = action.oldValue as number;
        } else if (action.property === 'blendMode') {
          layer.blendMode = action.oldValue as SKBlendMode;
        } else if (action.property === 'visible') {
          layer.visible = action.oldValue as boolean;
        } else if (action.property === 'maskEnabled') {
          layer.maskEnabled = action.oldValue as boolean;
        } else if (action.property === 'maskLinked') {
          layer.maskLinked = action.oldValue as boolean;
        }
        layer.updateThumbnail();
      }
      this.redoStack.push(action);
    } else if (action.type === 'selection') {
      this.selectionManager.restoreMaskSnapshot(action.before);
      this.redoStack.push(action);
    } else if (action.type === 'transformContent') {
      const layer = this.layers[action.layerIndex];
      if (layer) {
        for (const t of action.tilesBefore) {
          const tile = this.historyGrid(layer, action.onMask).getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
        layer.updateThumbnail();
      }
      if (layer && action.other) this.applyOtherSnapshot(layer, action.onMask, action.other.before);
      this.selectionManager.restoreMaskSnapshot(action.selectionBefore);
      this.redoStack.push(action);
    } else {
      const currentSnapshot: HistoryAction = {
        type: 'layers',
        description: 'Obecny stan',
        layers: this.layers.map((l) => l.clone(l.id, l.name)),
        activeLayerIndex: this.activeLayerIndex,
      };
      this.redoStack.push(currentSnapshot);

      // Akcja zostaje zdjęta ze stosu, więc jej warstwy można przejąć bez kosztownego klonowania
      this.maskView = null;
      this.layers = action.layers;
      this.activeLayerIndex = Math.min(action.activeLayerIndex, this.layers.length - 1);
    }

    this.syncTransformState();
    this.markAllLayersDirty();
    return true;
  }

  public redo(): boolean {
    if (this.bucketSeedPoint) {
      this.commitPaintBucketSession();
    }
    if (this.gradientStartPoint) {
      this.commitGradientSession();
    }
    if (this.redoStack.length === 0) return false;

    if (this.transformContentSession) {
      this.cancelTransformContent();
    }

    const action = this.redoStack.pop()!;

    if (action.type === 'tiles') {
      const layer = this.layers[action.layerIndex];
      if (layer) {
        for (const t of action.after) {
          const tile = this.historyGrid(layer, action.onMask).getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
        if (action.other) this.applyOtherSnapshot(layer, action.onMask, action.other.after);
        layer.updateThumbnail();
      }
      this.undoStack.push(action);
    } else if (action.type === 'layerProperty') {
      const layer = this.layers[action.layerIndex];
      if (layer) {
        if (action.property === 'opacity') {
          layer.opacity = action.newValue as number;
        } else if (action.property === 'blendMode') {
          layer.blendMode = action.newValue as SKBlendMode;
        } else if (action.property === 'visible') {
          layer.visible = action.newValue as boolean;
        } else if (action.property === 'maskEnabled') {
          layer.maskEnabled = action.newValue as boolean;
        } else if (action.property === 'maskLinked') {
          layer.maskLinked = action.newValue as boolean;
        }
        layer.updateThumbnail();
      }
      this.undoStack.push(action);
    } else if (action.type === 'selection') {
      this.selectionManager.restoreMaskSnapshot(action.after);
      this.undoStack.push(action);
    } else if (action.type === 'transformContent') {
      const layer = this.layers[action.layerIndex];
      if (layer) {
        for (const t of action.tilesAfter) {
          const tile = this.historyGrid(layer, action.onMask).getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
        layer.updateThumbnail();
      }
      if (layer && action.other) this.applyOtherSnapshot(layer, action.onMask, action.other.after);
      this.selectionManager.restoreMaskSnapshot(action.selectionAfter);
      this.undoStack.push(action);
    } else {
      const currentSnapshot: HistoryAction = {
        type: 'layers',
        description: 'Obecny stan',
        layers: this.layers.map((l) => l.clone(l.id, l.name)),
        activeLayerIndex: this.activeLayerIndex,
      };
      this.undoStack.push(currentSnapshot);

      // Akcja zostaje zdjęta ze stosu, więc jej warstwy można przejąć bez kosztownego klonowania
      this.maskView = null;
      this.layers = action.layers;
      this.activeLayerIndex = Math.min(action.activeLayerIndex, this.layers.length - 1);
    }

    this.syncTransformState();
    this.markAllLayersDirty();
    return true;
  }

  // --- SCHOWEK (CUT, COPY, PASTE) ---

  public copy(): boolean {
    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return false;

    const clip = document.createElement('canvas');
    clip.width = this.width;
    clip.height = this.height;
    const cctx = clip.getContext('2d')!;

    const maskClip = document.createElement('canvas');
    maskClip.width = this.width;
    maskClip.height = this.height;
    const mctx = maskClip.getContext('2d')!;

    if (this.selectionManager.hasActiveSelection) {
      // To samo miękkie wycięcie co w manipulacji zawartością: fragment = piksel * waga, brzeg z antyaliasingiem
      const sel = this.selectionManager.getSelectionBounds();
      if (!sel) return false;
      const lift = this.liftSoft(layer, sel);
      cctx.drawImage(lift.content, sel.left, sel.top);

      mctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
    } else {
      layer.tileGrid.drawToFlatContext(cctx);
      mctx.fillStyle = '#ffffff';
      mctx.fillRect(0, 0, this.width, this.height);
    }

    this.clipboardCanvas = clip;
    this.clipboardMaskCanvas = maskClip;

    // Kopiuj do systemowego schowka przeglądarki
    try {
      clip.toBlob((blob) => {
        this.ownClipboardBlob = blob;
        if (blob && navigator.clipboard && navigator.clipboard.write) {
          const item = new ClipboardItem({ 'image/png': blob });
          navigator.clipboard.write([item]).catch(() => {});
        }
      });
    } catch {}

    return true;
  }

  public cut(): boolean {
    const layer = this.getActiveLayer();
    if (!layer || layer.locked) return false;

    if (!this.copy()) return false;

    const tilesBefore = layer.tileGrid.getTilesSnapshot();
    const mask = this.selectionManager.hasActiveSelection ? this.selectionManager.maskCanvas : null;
    let cutMaskUsed: HTMLCanvasElement | null = null;

    if (mask) {
      // Z warstwy znika dokładnie tyle, ile trafiło do fragmentu (zostaje piksel * (1 - waga))
      const sel = this.selectionManager.getSelectionBounds();
      if (sel) {
        cutMaskUsed = this.liftSoft(layer, sel).cutMask;
        layer.clear(cutMaskUsed);
      }
    } else {
      layer.clear();
    }

    const tilesAfter = layer.tileGrid.getTilesSnapshot();
    this.pushTileAction({
      type: 'tiles',
      description: 'Wytnij',
      layerIndex: this.activeLayerIndex,
      before: tilesBefore,
      after: tilesAfter,
    });

    this.cutOrigin = cutMaskUsed
      ? { clip: this.clipboardCanvas, layer, cutMask: cutMaskUsed, before: tilesBefore, after: tilesAfter }
      : null;

    this.markAllLayersDirty();
    return true;
  }

  /** Ostatnie wycięcie: pozwala wkleić fragment w to samo miejsce tak, by zlał się z resztą warstwy bez śladu. */
  private cutOrigin: {
    clip: HTMLCanvasElement | null;
    layer: Layer;
    cutMask: HTMLCanvasElement;
    before: TileSnapshotLike[];
    after: TileSnapshotLike[];
  } | null = null;

  /** Ostatni PNG zapisany do schowka systemowego przez `copy()` - pozwala rozpoznać własną zawartość schowka. */
  private ownClipboardBlob: Blob | null = null;

  /** Czy blob ze schowka systemowego to dokładnie ten obraz, który skopiowała aplikacja (wtedy wklejamy bufor wewnętrzny). */
  public async isOwnClipboardBlob(blob: Blob): Promise<boolean> {
    const own = this.ownClipboardBlob;
    const clip = this.clipboardCanvas;
    if (!own || !clip) return false;
    if (own.size === blob.size) {
      const [a, b] = await Promise.all([own.arrayBuffer(), blob.arrayBuffer()]);
      const x = new Uint8Array(a);
      const y = new Uint8Array(b);
      let same = true;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) { same = false; break; }
      if (same) return true;
    }
    // System mógł zakodować obraz od nowa: porównujemy kanał alfa (musi być identyczny) i kolory pikseli nieprzezroczystych
    try {
      const bmp = await createImageBitmap(blob);
      if (bmp.width !== clip.width || bmp.height !== clip.height) return false;
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const cx = c.getContext('2d', { willReadFrequently: true })!;
      cx.drawImage(bmp, 0, 0);
      const x = cx.getImageData(0, 0, c.width, c.height).data;
      const y = clip.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < x.length; i += 4) {
        if (x[i + 3] !== y[i + 3]) return false;
        if (y[i + 3] === 255 && (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2])) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  public pasteCanvas(pastedCanvas: HTMLCanvasElement, customMaskCanvas?: HTMLCanvasElement | null): boolean {
    const layer = this.getActiveLayer();
    if (!layer || layer.locked) return false;

    if (this.transformContentSession) {
      this.commitTransformContent();
    }

    const initialTilesSnapshot = layer.tileGrid.getTilesSnapshot();
    const initialSelectionSnapshot = this.selectionManager.getMaskSnapshot();

    // 1. Zaznaczenie po wklejeniu to zwykły prostokąt (wektorowy) opisany na wklejonym fragmencie
    const area = customMaskCanvas ? this.alphaBounds(customMaskCanvas) : this.alphaBounds(pastedCanvas);
    this.selectionManager.clear();
    if (area) {
      this.selectionManager.selectRect(area.x, area.y, area.w, area.h);
    } else {
      this.selectionManager.selectRect(0, 0, pastedCanvas.width, pastedCanvas.height);
    }

    const bounds = this.selectionManager.getSelectionBounds();
    if (!bounds) return false;

    // Utwórz przycięty wycinek tekstury dokładnie odpowiadający rozmiarowi bounds (eliminuje przesunięcie wklejanego obiektu)
    const croppedSourceCanvas = document.createElement('canvas');
    croppedSourceCanvas.width = bounds.width;
    croppedSourceCanvas.height = bounds.height;
    const csctx = croppedSourceCanvas.getContext('2d')!;
    csctx.drawImage(
      pastedCanvas,
      bounds.left, bounds.top, bounds.width, bounds.height,
      0, 0, bounds.width, bounds.height
    );

    const pasteSrcMask = document.createElement('canvas');
    pasteSrcMask.width = bounds.width;
    pasteSrcMask.height = bounds.height;
    const psx = pasteSrcMask.getContext('2d')!;
    psx.drawImage(
      this.selectionManager.maskCanvas,
      bounds.left, bounds.top, bounds.width, bounds.height,
      0, 0, bounds.width, bounds.height
    );
    const psImg = psx.getImageData(0, 0, bounds.width, bounds.height);
    for (let i = 0; i < psImg.data.length; i += 4) {
      const on = psImg.data[i + 3] >= 128;
      psImg.data[i] = psImg.data[i + 1] = psImg.data[i + 2] = on ? 255 : 0;
      psImg.data[i + 3] = on ? 255 : 0;
    }
    psx.putImageData(psImg, 0, 0);

    // 2. Rozpocznij PŁYWAJĄCĄ SESJĘ BEZ ZAPISYWANIA PIKSELI NA WARSTWIE POD SPODEM!
    // Warstwa pod spodem pozostaje w 100% czysta (nic nie zostaje z tyłu przy przenoszeniu)
    this.selectionManager.beginTransformSelection();

    // Wklejenie zaraz po wycięciu (warstwa nietknięta od tego czasu): w stanie początkowym warstwa wraca do oryginału,
    // a wycięcie następuje dopiero po pierwszej zmianie - jak w manipulacji zawartością (fragment + reszta = oryginał).
    let cutMask: HTMLCanvasElement | undefined;
    let identityTiles: TileSnapshotLike[] | undefined;
    const co = this.cutOrigin;
    if (co && co.layer === layer && co.clip === pastedCanvas && this.sameTiles(initialTilesSnapshot, co.after)) {
      cutMask = co.cutMask;
      identityTiles = co.before as TileSnapshotLike[];
      this.restoreTiles(layer, identityTiles);
    }

    this.transformContentSession = {
      cutMask,
      cutDone: false,
      identityTiles,
      sourceContentCanvas: croppedSourceCanvas,
      sourceBounds: bounds,
      sourceLayerIndex: this.activeLayerIndex,
      initialTilesSnapshot,
      initialSelectionSnapshot,
      interpolation: 'bilinear',
      srcMask: pasteSrcMask,
      softContent: true,
    };

    this.markAllLayersDirty();
    return true;
  }

  /** Prostokąt opisany na pikselach o niezerowej alfie (null, gdy płótno jest puste). */
  private alphaBounds(canvas: HTMLCanvasElement): { x: number; y: number; w: number; h: number } | null {
    const w = canvas.width;
    const h = canvas.height;
    const d = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return maxX >= minX && maxY >= minY ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  }

  public paste(): boolean {
    if (this.clipboardCanvas) {
      return this.pasteCanvas(this.clipboardCanvas, this.clipboardMaskCanvas);
    }
    return false;
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  public clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /** Licznik zmian pikseli; rośnie przy każdej modyfikacji warstw (do wykrywania nieaktualnego podkładu). */
  public pixelVersion: number = 0;

  /** Sygnatura stanu wpływającego na wygląd kompozytu (piksele, widoczność, krycie, tryby, aktywna warstwa). */
  public getBaseSignature(): string {
    let sig = `${this.pixelVersion}|${this.width}x${this.height}|${this.activeLayerIndex}`;
    for (const l of this.layers) sig += `|${l.id}:${l.visible ? 1 : 0}:${l.opacity}:${l.blendMode}:${l.maskGrid ? (l.maskEnabled ? 'm' : 'n') : '-'}`;
    if (this.maskView) sig += `|mv:${this.maskView.id}`;
    return sig;
  }

  // --- MASKI PRZEZROCZYSTOŚCI WARSTW ---

  /** Warstwa, której maska jest pokazywana na płótnie w skali szarości (null = zwykły widok). */
  public maskView: Layer | null = null;
  private maskViewProxy: Layer | null = null;

  /** Warstwy używane przy rysowaniu widoku: zwykle `layers`; w podglądzie maski jedna warstwa-pośrednik z maską w szarości. */
  public get renderLayers(): Layer[] {
    const mv = this.maskView;
    if (mv) {
      if (mv.maskGrid && this.layers[this.activeLayerIndex] === mv) {
        let px = this.maskViewProxy;
        if (!px || px.id !== `mv_${mv.id}` || px.pixelGrid !== mv.maskGrid) {
          px = new Layer(`mv_${mv.id}`, mv.name, this.width, this.height, this.tileSize);
          px.pixelGrid = mv.maskGrid;
          px.grayView = true;
          this.maskViewProxy = px;
        }
        return [px];
      }
      this.maskView = null;
    }
    return this.getRenderList().layers;
  }

  /** Indeks aktywnej warstwy w `renderLayers`. */
  public get renderActiveIndex(): number {
    if (this.maskView) return 0;
    const i = this.getRenderList().map.indexOf(this.activeLayerIndex);
    return i >= 0 ? i : this.activeLayerIndex;
  }

  /** Indeks rzeczywistej warstwy odpowiadającej pozycji `i` w `renderLayers`. */
  public realLayerIndex(i: number): number {
    if (this.maskView) return this.layers.indexOf(this.maskView);
    const m = this.getRenderList().map[i];
    return m === undefined ? i : m;
  }

  /**
   * Zakres `renderLayers` (dzieci + nagłówek) grupy z krytem / trybem / maską, w której leży aktywna warstwa.
   * Taka grupa nie ma pośrednika: kompozytor rysuje jej dzieci do osobnego bufora (z podglądem aktywnej warstwy)
   * i dopiero ten bufor nakłada z ustawieniami grupy. null = brak takiej grupy.
   */
  public get renderIsolation(): { start: number; header: number; group: Layer } | null {
    if (this.maskView) return null;
    return this.getRenderList().iso;
  }

  /** Czy w bieżącej liście są grupy „Przepuszczanie” z krytem / maską, wymagające składania po kolei z tłem. */
  public get renderHasPass(): boolean {
    return !this.maskView && this.getRenderList().passAtStart.size > 0;
  }
  /** Grupa zaczynająca się na pozycji `i` listy renderowania (pierwsze dziecko) albo undefined. */
  public renderPassStartAt(i: number): Layer | undefined {
    return this.maskView ? undefined : this.getRenderList().passAtStart.get(i);
  }
  /** Grupa domykana na pozycji `i` listy renderowania (nagłówek) albo undefined. */
  public renderPassEndAt(i: number): Layer | undefined {
    return this.maskView ? undefined : this.getRenderList().passAtEnd.get(i);
  }

  /** Krycie * maska grupy jako kanał alfa płótna (x, y, w, h) w układzie dokumentu. */
  private groupAlphaCanvas(g: Layer, x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const white = document.createElement('canvas');
    white.width = w;
    white.height = h;
    const wctx = white.getContext('2d')!;
    wctx.fillStyle = '#fff';
    wctx.fillRect(0, 0, w, h);
    const masked = g.maskRegionAlways(white, x, y, w, h);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const octx = out.getContext('2d')!;
    octx.globalAlpha = g.opacity;
    octx.drawImage(masked, 0, 0);
    return out;
  }

  private passSnapshot(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(ctx.canvas, x, y, w, h, 0, 0, w, h);
    return c;
  }

  private passFinish(ctx: CanvasRenderingContext2D, snap: HTMLCanvasElement, g: Layer, x: number, y: number, w: number, h: number): void {
    finishPassThrough(ctx, snap, this.groupAlphaCanvas(g, x, y, w, h), x, y, w, h);
  }

  // --- IZOLOWANA KOMPOZYCJA GRUP (krycie, tryb mieszania i maska grupy) ---

  /**
   * Sposób składania grupy:
   *  - 'none': zwykłe przepuszczanie bez krycia i maski (warstwy rysowane po kolei, jak bez grupy);
   *  - 'isolate': dzieci składane osobno (tryb grupy inny niż Przepuszczanie albo same warstwy Normalne), potem
   *    maska, krycie i tryb grupy (aktywna grupa: bufor w kompozytorze, nieaktywna: pośrednik z cache);
   *  - 'pass': Przepuszczanie z krytem / maską, a wśród warstw są tryby mieszania inne niż Normalny - warstwy
   *    mieszają się z tym, co pod grupą, a wynik jest mieszany z tłem wg krycia * maski.
   */
  public groupKind(h: Layer): 'none' | 'isolate' | 'pass' {
    if (!h.isGroup) return 'none';
    const pass = h.blendMode === 'PassThrough';
    const effect = h.opacity < 1 || (!!h.maskGrid && h.maskEnabled);
    if (pass && !effect) return 'none';
    if (!pass) return 'isolate';
    // przepuszczanie z krytem/maską: gdy wszystkie warstwy są Normalne, wynik jest taki sam jak przy izolacji (a szybszy)
    for (const k of this.layers) {
      if (!k.isGroup && k.groupId === h.id && k.ownVisible && k.opacity > 0 && k.blendMode !== 'SrcOver') return 'pass';
    }
    return 'isolate';
  }

  private groupProxies = new Map<string, GroupProxyEntry>();
  private rlMemo: { snap: unknown[]; list: RenderList } | null = null;
  private rlListId = 0;
  private identityMap: number[] = [];
  private groupScratch: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;

  /** Bufor dokumentu (rozmiar płótna) na dzieci grupy rysowanej izolowanie. */
  public getGroupScratch(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    let g = this.groupScratch;
    if (!g || g.canvas.width !== this.width || g.canvas.height !== this.height) {
      const canvas = document.createElement('canvas');
      canvas.width = this.width;
      canvas.height = this.height;
      g = this.groupScratch = { canvas, ctx: canvas.getContext('2d')! };
    }
    return g;
  }

  private getRenderList(): RenderList {
    const L = this.layers;
    let any = false;
    for (const l of L) {
      if (l.isGroup && this.groupKind(l) !== 'none') {
        any = true;
        break;
      }
    }
    if (!any) {
      // zwykły przypadek (brak grup z ustawieniami): dokładnie dotychczasowe zachowanie
      if (this.groupProxies.size) this.groupProxies.clear();
      this.rlMemo = null;
      if (this.identityMap.length !== L.length) this.identityMap = L.map((_, i) => i);
      return { layers: L, map: this.identityMap, iso: null, proxies: [], passAtStart: EMPTY_PASS, passAtEnd: EMPTY_PASS, id: 0 };
    }
    const snap: unknown[] = [L, L.length, this.activeLayerIndex, this.width, this.height];
    for (const l of L) snap.push(l, l.ownVisible, l.opacity, l.blendMode, l.maskGrid, l.maskEnabled, l.editMask, l.groupId, l.isGroup);
    const m = this.rlMemo;
    let list: RenderList;
    if (m && m.snap.length === snap.length && m.snap.every((v, i) => v === snap[i])) {
      list = m.list;
    } else {
      list = this.buildRenderList();
      this.rlMemo = { snap, list };
    }
    const epoch = getTileEpoch();
    let refreshed = false;
    for (const p of list.proxies) {
      if (p.entry.epoch !== epoch || p.entry.listId !== list.id) {
        this.refreshGroupProxy(p.entry, p.kids);
        p.entry.listId = list.id;
        refreshed = true;
      }
    }
    if (list.proxies.length) {
      // odświeżenie samo podbija licznik kafelków; zapamiętujemy stan po nim, by nie odświeżać w kółko
      const after = getTileEpoch();
      for (const p of list.proxies) p.entry.epoch = after;
    }
    void refreshed;
    return list;
  }

  private buildRenderList(): RenderList {
    const L = this.layers;
    const act = L[this.activeLayerIndex];
    const activeKidGroup = act && !act.isGroup ? act.groupId : null;
    const headers = new Map<string, Layer>();
    const kidsOf = new Map<string, Layer[]>();
    for (const l of L) if (l.isGroup) headers.set(l.id, l);
    for (const l of L) {
      if (!l.isGroup && l.groupId && headers.has(l.groupId)) {
        let a = kidsOf.get(l.groupId);
        if (!a) kidsOf.set(l.groupId, (a = []));
        a.push(l);
      }
    }
    const kind = new Map<string, 'none' | 'isolate' | 'pass'>();
    for (const h of headers.values()) kind.set(h.id, this.groupKind(h));
    const out: Layer[] = [];
    const map: number[] = [];
    const proxies: RenderList['proxies'] = [];
    const passAtStart = new Map<number, Layer>();
    const passAtEnd = new Map<number, Layer>();
    let iso: RenderList['iso'] = null;
    const live = new Set<string>();
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      if (!l.isGroup && l.groupId && headers.has(l.groupId)) {
        const h = headers.get(l.groupId)!;
        // dzieci grupy składanej izolowanie są zastąpione jej pośrednikiem (rysowanym w miejscu nagłówka)
        if (kind.get(h.id) === 'isolate' && h.id !== activeKidGroup) continue;
        if (kind.get(h.id) === 'pass' && !passAtStart.has(out.length) && !Array.from(passAtStart.values()).includes(h)) {
          passAtStart.set(out.length, h);
        }
        out.push(l);
        map.push(i);
        continue;
      }
      const k = l.isGroup ? kind.get(l.id) : 'none';
      if (l.isGroup && k === 'isolate') {
        const kids = kidsOf.get(l.id) ?? [];
        if (l.id === activeKidGroup) {
          iso = { start: out.length - kids.length, header: out.length, group: l };
          out.push(l);
          map.push(i);
          continue;
        }
        const entry = this.ensureGroupProxy(l, kids, i === this.activeLayerIndex);
        live.add(l.id);
        out.push(entry.layer);
        map.push(i);
        proxies.push({ entry, kids });
        continue;
      }
      if (l.isGroup && k === 'pass') {
        // grupa bez dzieci nie ma początku: wtedy nic do domknięcia
        if (Array.from(passAtStart.values()).includes(l)) passAtEnd.set(out.length, l);
      }
      out.push(l);
      map.push(i);
    }
    for (const id of Array.from(this.groupProxies.keys())) if (!live.has(id)) this.groupProxies.delete(id);
    return { layers: out, map, iso, proxies, passAtStart, passAtEnd, id: ++this.rlListId };
  }

  private ensureGroupProxy(h: Layer, kids: Layer[], isActive: boolean): GroupProxyEntry {
    void kids;
    let e = this.groupProxies.get(h.id);
    const tg = e?.layer.pixelGrid;
    if (!e || e.maskRef !== h.maskGrid || !tg || tg.width !== this.width || tg.height !== this.height || tg.tileSize !== this.tileSize) {
      const px = new Layer(`gp_${h.id}`, h.name, this.width, this.height, this.tileSize);
      e = { layer: px, maskRef: h.maskGrid, keys: [], epoch: -1, listId: -1 };
      this.groupProxies.set(h.id, e);
    }
    const px = e.layer;
    px.opacity = h.opacity;
    px.blendMode = h.blendMode === 'PassThrough' ? 'SrcOver' : h.blendMode;
    px.visible = h.ownVisible;
    px.maskGrid = h.maskGrid;
    px.maskEnabled = h.maskEnabled;
    px.maskLinked = h.maskLinked;
    px.editMask = isActive && h.editMask && !!h.maskGrid;
    return e;
  }

  /** Składa dzieci grupy w kafelki pośrednika (tylko te, których wejścia się zmieniły). */
  private refreshGroupProxy(e: GroupProxyEntry, kids: Layer[]): void {
    const g = e.layer.pixelGrid;
    const vis = kids.filter((k) => k.ownVisible && k.opacity > 0);
    for (let ty = 0; ty < g.rows; ty++) {
      for (let tx = 0; tx < g.cols; tx++) {
        let key = '';
        let any = false;
        for (const k of vis) {
          const kt = k.pixelGrid.tiles[ty]?.[tx];
          if (!kt) continue;
          const mg = k.maskGrid && k.maskEnabled ? k.maskGrid : null;
          const mt = mg ? mg.tiles[ty]?.[tx] : null;
          key += `${k.opacity}|${k.blendMode}|${tileUid(kt)}.${kt.version}.${kt.hasContent ? 1 : 0}|${mt ? `${tileUid(mt)}.${mt.version}` : ''};`;
          if (kt.hasContent) any = true;
        }
        const idx = ty * g.cols + tx;
        if (e.keys[idx] === key) continue;
        e.keys[idx] = key;
        const pt = g.tiles[ty][tx];
        const c = pt.ctx;
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
        c.clearRect(0, 0, pt.width, pt.height);
        if (any) {
          for (const k of vis) {
            const kt = k.pixelGrid.tiles[ty]?.[tx];
            if (!kt || !kt.hasContent) continue;
            const rc = k.renderCanvas(kt);
            if (!rc) continue;
            c.globalAlpha = k.opacity;
            c.globalCompositeOperation = getCanvasCompositeOperation(k.blendMode);
            c.drawImage(rc, 0, 0);
          }
          c.globalAlpha = 1;
          c.globalCompositeOperation = 'source-over';
        }
        pt.hasContent = any;
        pt.isDirty = true;
      }
    }
  }

  /**
   * Kompozycja warstw (z izolowanymi grupami) w prostokącie dokumentu (cropX, cropY, w, h) na kontekście `ctx`;
   * używana do eksportu, próbkowania kolorów i źródła pieczątki. Dzieci grupy z ustawieniami są składane osobno,
   * potem maskowane i nakładane z jej krytem i trybem.
   */
  private drawLayersCropped(ctx: CanvasRenderingContext2D, cropX: number, cropY: number, w: number, h: number): void {
    const L = this.layers;
    const headers = new Map<string, Layer>();
    const kind = new Map<string, 'none' | 'isolate' | 'pass'>();
    for (const l of L) {
      if (l.isGroup) {
        headers.set(l.id, l);
        kind.set(l.id, this.groupKind(l));
      }
    }
    const snaps = new Map<string, HTMLCanvasElement>();
    for (const l of L) {
      if (!l.isGroup && l.groupId && headers.has(l.groupId)) {
        const k = kind.get(l.groupId);
        if (k === 'isolate') continue; // narysuje je nagłówek
        if (k === 'pass' && !snaps.has(l.groupId)) snaps.set(l.groupId, this.passSnapshot(ctx, 0, 0, w, h));
      } else if (l.isGroup) {
        const k = kind.get(l.id);
        if (k === 'pass') {
          const snap = snaps.get(l.id);
          if (snap && l.ownVisible) finishPassThrough(ctx, snap, this.groupAlphaCanvas(l, cropX, cropY, w, h), 0, 0, w, h);
          continue;
        }
        if (k !== 'isolate' || !l.ownVisible || l.opacity <= 0) continue;
        const buf = document.createElement('canvas');
        buf.width = w;
        buf.height = h;
        const bctx = buf.getContext('2d')!;
        for (const kid of L) {
          if (kid.isGroup || kid.groupId !== l.id || !kid.ownVisible || kid.opacity <= 0) continue;
          bctx.save();
          bctx.globalAlpha = kid.opacity;
          bctx.globalCompositeOperation = getCanvasCompositeOperation(kid.blendMode);
          kid.drawRenderedCropped(bctx, cropX, cropY, w, h);
          bctx.restore();
        }
        const masked = l.maskRegionAlways(buf, cropX, cropY, w, h);
        ctx.save();
        ctx.globalAlpha = l.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(l.blendMode === 'PassThrough' ? 'SrcOver' : l.blendMode);
        ctx.drawImage(masked, 0, 0);
        ctx.restore();
        continue;
      }
      if (l.isGroup || !l.visible || l.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha = l.opacity;
      ctx.globalCompositeOperation = getCanvasCompositeOperation(l.blendMode);
      l.drawRenderedCropped(ctx, cropX, cropY, w, h);
      ctx.restore();
    }
  }

  /**
   * Zamyka izolowaną grupę w kompozytorze dokumentu: bufor `src` (obszar x,y,w,h dokumentu) maskuje maską grupy
   * i nakłada na `ctx` z jej krytem i trybem mieszania.
   */
  private flushIsolatedGroup(
    ctx: CanvasRenderingContext2D,
    group: Layer,
    src: HTMLCanvasElement,
    x: number,
    y: number,
    w: number,
    h: number
  ): void {
    let region: HTMLCanvasElement = src;
    if (group.maskGrid && group.maskEnabled) {
      const reg = document.createElement('canvas');
      reg.width = w;
      reg.height = h;
      reg.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, w, h);
      region = group.maskRegionAlways(reg, x, y, w, h);
      ctx.save();
      ctx.globalAlpha = group.opacity;
      ctx.globalCompositeOperation = getCanvasCompositeOperation(group.blendMode === 'PassThrough' ? 'SrcOver' : group.blendMode);
      ctx.drawImage(region, 0, 0, w, h, x, y, w, h);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.globalAlpha = group.opacity;
    ctx.globalCompositeOperation = getCanvasCompositeOperation(group.blendMode === 'PassThrough' ? 'SrcOver' : group.blendMode);
    ctx.drawImage(region, x, y, w, h, x, y, w, h);
    ctx.restore();
  }

  /** Zatwierdza otwarte sesje (przekształcanie, gradient, wiadro), zanim zmieni się cel edycji. */
  private finishOpenSessions(): void {
    if (this.transformContentSession) this.commitTransformContent();
    if (this.bucketSeedPoint) this.commitPaintBucketSession();
    if (this.gradientStartPoint) this.commitGradientSession();
  }

  public addLayerMask(fromSelection: boolean): boolean {
    const layer = this.getActiveLayer();
    if (!layer || layer.hasMask) return false;
    this.finishOpenSessions();
    this.saveFullSnapshot(layer.isGroup ? 'Dodanie maski grupy' : 'Dodanie maski');
    // maska grupy ma rozmiar dokumentu (nagłówek grupy nie ma własnych pikseli)
    layer.createMask(
      fromSelection && this.selectionManager.hasActiveSelection ? this.selectionManager.maskCanvas : null,
      this.width,
      this.height
    );
    this.markAllLayersDirty();
    return true;
  }

  /** Usuwa maskę aktywnej warstwy; `apply` wpieka ją w piksele. */
  public removeLayerMask(apply: boolean): boolean {
    const layer = this.getActiveLayer();
    if (!layer || !layer.hasMask) return false;
    this.finishOpenSessions();
    // maski grupy nie da się wpiec w piksele (dotyczy złożenia dzieci), więc dla grupy „zastosuj" nie istnieje
    if (apply && layer.isGroup) return false;
    this.saveFullSnapshot(apply ? 'Zastosowanie maski' : 'Usunięcie maski');
    if (this.maskView === layer) this.maskView = null;
    if (apply) layer.applyMask();
    else layer.dropMask();
    this.markAllLayersDirty();
    return true;
  }

  /** Wybiera cel edycji warstwy: piksele albo maska. */
  public setEditTarget(index: number, target: 'pixels' | 'mask'): void {
    const layer = this.layers[index];
    if (!layer) return;
    if (this.maskView && this.maskView !== layer) this.maskView = null;
    const wantMask = target === 'mask' && layer.hasMask;
    if (layer.editMask === wantMask && (index === this.activeLayerIndex)) {
      this.activeLayerIndex = index;
      return;
    }
    this.finishOpenSessions();
    this.activeLayerIndex = index;
    layer.editMask = wantMask;
    // wyjście z edycji maski kończy też jej podgląd w szarości
    if (!wantMask && this.maskView === layer) this.maskView = null;
    this.markAllLayersDirty();
  }

  /** Pokazuje maskę warstwy w skali szarości na płótnie (null = powrót do zwykłego widoku). */
  public setMaskView(index: number | null): void {
    this.finishOpenSessions();
    if (index === null) {
      this.maskView = null;
    } else {
      const layer = this.layers[index];
      if (!layer || !layer.hasMask) return;
      this.activeLayerIndex = index;
      layer.editMask = true;
      this.maskView = layer;
    }
    this.markAllLayersDirty();
  }

  public toggleMaskEnabled(index: number): void {
    const layer = this.layers[index];
    if (!layer || !layer.hasMask) return;
    this.pushPropertyAction(index, 'maskEnabled', layer.maskEnabled, !layer.maskEnabled, 'Widoczność maski');
    layer.maskEnabled = !layer.maskEnabled;
    if (layer.isGroup) this.invalidateComposite();
    else this.markAllLayersDirty();
  }

  public toggleMaskLink(index: number): void {
    const layer = this.layers[index];
    if (!layer || !layer.hasMask) return;
    this.pushPropertyAction(index, 'maskLinked', layer.maskLinked, !layer.maskLinked, 'Powiązanie maski z warstwą');
    layer.maskLinked = !layer.maskLinked;
  }

  /**
   * Lekka unieważnienie po zmianie wyglądu GRUPY (krycie / tryb / maska włączona): zawartość kafelków dzieci się
   * nie zmieniła, więc pośrednicy grup nie muszą składać kafelków od nowa (pełne markAllDirty by to wymusiło).
   */
  private invalidateComposite(): void {
    this.syncGroupFlags();
    this.pixelVersion++;
    this.lastDirtyRect = null;
  }

  public markAllLayersDirty(): void {
    this.syncGroupFlags();
    this.pixelVersion++;
    for (const layer of this.layers) {
      layer.tileGrid.markAllDirty();
      layer.updateThumbnail(layer === this.layers[this.activeLayerIndex]);
    }
    this.lastDirtyRect = null;
  }

  // --- ZARZĄDZANIE WARSTWAMI ---

  // --- GRUPY WARSTW ---
  // Nagłówek grupy (Layer.isGroup) leży w tablicy NAD swoimi dziećmi (dzieci mają groupId = id nagłówka).
  // Operacje strukturalne budują drzewo z groupId (`buildUnits`) i układają tablicę z powrotem (`flattenUnits`),
  // więc kolejność w tablicy zawsze jest spójna: dzieci, a tuż nad nimi ich nagłówek.

  private buildUnits(): LayerUnit[] {
    const headerIds = new Set<string>();
    for (const l of this.layers) if (l.isGroup) headerIds.add(l.id);
    const kids = new Map<string, Layer[]>();
    for (const l of this.layers) {
      if (l.isGroup) {
        l.groupId = null;
        continue;
      }
      if (l.groupId && headerIds.has(l.groupId)) {
        let arr = kids.get(l.groupId);
        if (!arr) kids.set(l.groupId, (arr = []));
        arr.push(l);
      } else {
        l.groupId = null;
      }
    }
    const units: LayerUnit[] = [];
    for (const l of this.layers) {
      if (l.isGroup) units.push({ header: l, children: kids.get(l.id) || [] });
      else if (!l.groupId) units.push({ layer: l });
    }
    return units;
  }

  private flattenUnits(units: LayerUnit[]): Layer[] {
    const out: Layer[] = [];
    for (const u of units) {
      if (u.header) {
        for (const c of u.children!) out.push(c);
        out.push(u.header);
      } else out.push(u.layer!);
    }
    return out;
  }

  /** Układa tablicę warstw spójnie z grupami, zachowując wskazaną aktywną warstwę. */
  private normalizeLayers(active?: Layer): void {
    const act = active ?? this.layers[this.activeLayerIndex];
    this.layers = this.flattenUnits(this.buildUnits());
    const idx = act ? this.layers.indexOf(act) : -1;
    this.activeLayerIndex = idx >= 0 ? idx : Math.max(0, Math.min(this.activeLayerIndex, this.layers.length - 1));
  }

  /** Przenosi do dzieci informację o ukryciu / blokadzie grupy. */
  public syncGroupFlags(): void {
    const byId = new Map<string, Layer>();
    for (const l of this.layers) if (l.isGroup) byId.set(l.id, l);
    for (const l of this.layers) {
      const g = l.groupId ? byId.get(l.groupId) : undefined;
      l.groupHidden = !!g && !g.ownVisible;
      l.groupLocked = !!g && g.ownLocked;
    }
  }

  /** Dzieci grupy (od dołu do góry). */
  public getGroupChildren(header: Layer): Layer[] {
    return this.layers.filter((l) => !l.isGroup && l.groupId === header.id);
  }

  private makeGroupLayer(name: string): Layer {
    const g = new Layer(`group_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, name, this.width, this.height, this.tileSize);
    g.isGroup = true;
    g.blendMode = 'PassThrough';
    return g;
  }

  /** Nowa pusta grupa nad aktywną warstwą (lub nad aktywną grupą). */
  public addGroup(): Layer {
    this.finishOpenSessions();
    this.saveFullSnapshot('Dodanie grupy');
    const n = this.layers.filter((l) => l.isGroup).length + 1;
    const g = this.makeGroupLayer(`Grupa ${n}`);
    const act = this.getActiveLayer();
    // grupa trafia na poziom główny: nad grupą aktywnej warstwy albo nad nią samą
    let insertAfter = this.activeLayerIndex;
    if (act && !act.isGroup && act.groupId) {
      const hi = this.layers.findIndex((l) => l.isGroup && l.id === act.groupId);
      if (hi >= 0) insertAfter = hi;
    }
    this.layers.splice(insertAfter + 1, 0, g);
    this.normalizeLayers(g);
    this.markAllLayersDirty();
    return g;
  }

  public toggleGroupExpanded(index: number): void {
    const g = this.layers[index];
    if (!g || !g.isGroup) return;
    g.expanded = !g.expanded;
  }

  public addLayer(name?: string): Layer {
    this.saveFullSnapshot('Dodanie warstwy');
    const newIdx = this.layers.filter((l) => !l.isGroup).length + 1;
    const layer = new Layer(
      `layer_${Date.now()}`,
      name || `Warstwa ${newIdx}`,
      this.width,
      this.height,
      this.tileSize
    );
    layer.updateThumbnail();
    const act = this.getActiveLayer();
    if (act?.isGroup) {
      // nowa warstwa na wierzchu aktywnej grupy
      layer.groupId = act.id;
      this.layers.splice(this.activeLayerIndex, 0, layer);
    } else {
      layer.groupId = act?.groupId ?? null;
      this.layers.splice(this.activeLayerIndex + 1, 0, layer);
    }
    this.normalizeLayers(layer);
    this.markAllLayersDirty();
    return layer;
  }

  public removeActiveLayer(): boolean {
    const active = this.getActiveLayer();
    if (!active) return false;
    if (active.isGroup) {
      if (active.ownLocked) return false;
      const kids = this.getGroupChildren(active);
      if (this.layers.filter((l) => !l.isGroup).length - kids.length < 1) return false;
      this.finishOpenSessions();
      this.saveFullSnapshot('Usunięcie grupy');
      const keep = new Set(kids);
      const lowest = this.layers.indexOf(kids[0] ?? active);
      this.layers = this.layers.filter((l) => l !== active && !keep.has(l));
      this.maskView = null;
      this.activeLayerIndex = Math.max(0, Math.min(lowest - 1, this.layers.length - 1));
      this.normalizeLayers(this.layers[this.activeLayerIndex]);
      this.markAllLayersDirty();
      return true;
    }
    if (this.layers.filter((l) => !l.isGroup).length <= 1) return false;
    if (active.locked) return false;
    this.saveFullSnapshot('Usunięcie warstwy');
    this.layers.splice(this.activeLayerIndex, 1);
    this.activeLayerIndex = Math.max(0, this.activeLayerIndex - 1);
    this.normalizeLayers();
    this.markAllLayersDirty();
    return true;
  }

  public duplicateActiveLayer(): Layer {
    this.saveFullSnapshot('Duplikowanie warstwy');
    const active = this.getActiveLayer();
    if (active.isGroup) {
      const kids = this.getGroupChildren(active);
      const stamp = Date.now();
      const gClone = active.clone(`group_${stamp}_${Math.random().toString(36).slice(2, 6)}`, `${active.name} (Kopia)`);
      const kClones = kids.map((k, i) => {
        const c = k.clone(`layer_${stamp}_${i}`, k.name);
        c.groupId = gClone.id;
        return c;
      });
      this.layers.splice(this.activeLayerIndex + 1, 0, ...kClones, gClone);
      this.normalizeLayers(gClone);
      this.markAllLayersDirty();
      return gClone;
    }
    const cloned = active.clone(`layer_${Date.now()}`, `${active.name} (Kopia)`);
    cloned.groupId = active.groupId;
    this.layers.splice(this.activeLayerIndex + 1, 0, cloned);
    this.normalizeLayers(cloned);
    this.markAllLayersDirty();
    return cloned;
  }

  /** Scala wszystkie warstwy grupy w jedną warstwę rastrową (w miejscu grupy). */
  private mergeGroup(header: Layer): boolean {
    const kids = this.getGroupChildren(header);
    if (kids.length === 0 || header.ownLocked || kids.some((k) => k.ownLocked)) return false;
    this.finishOpenSessions();
    this.saveFullSnapshot('Scalenie grupy');
    this.maskView = null;
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d')!;
    for (const k of kids) {
      if (!k.ownVisible || k.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha = k.opacity;
      ctx.globalCompositeOperation = getCanvasCompositeOperation(k.blendMode);
      k.drawRenderedToContext(ctx);
      ctx.restore();
    }
    // maska grupy jest wpiekana w złożenie dzieci; krycie i tryb grupy przejmuje scalona warstwa
    if (header.maskGrid && header.maskEnabled) {
      const mk = header.maskRegionAlways(canvas, 0, 0, this.width, this.height);
      if (mk !== canvas) {
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.drawImage(mk, 0, 0);
      }
    }
    const merged = new Layer(`layer_${Date.now()}`, header.name, this.width, this.height, this.tileSize);
    for (const row of merged.tileGrid.tiles) {
      for (const tile of row) {
        tile.ctx.drawImage(canvas, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }
    merged.visible = header.ownVisible;
    merged.opacity = header.opacity;
    merged.blendMode = header.blendMode;
    merged.updateThumbnail();
    const lowest = this.layers.indexOf(kids[0]);
    const drop = new Set<Layer>([...kids, header]);
    this.layers = this.layers.filter((l) => !drop.has(l));
    this.layers.splice(lowest, 0, merged);
    this.normalizeLayers(merged);
    this.markAllLayersDirty();
    return true;
  }

  public mergeLayerDown(): boolean {
    const active = this.getActiveLayer();
    if (active?.isGroup) return this.mergeGroup(active);
    if (this.activeLayerIndex <= 0) return false;
    const topLayer = this.layers[this.activeLayerIndex];
    const bottomLayer = this.layers[this.activeLayerIndex - 1];
    // scalanie tylko w obrębie tego samego kontenera (grupy / poziomu głównego)
    if (bottomLayer.isGroup || bottomLayer.groupId !== topLayer.groupId) return false;
    if (topLayer?.locked || bottomLayer?.locked) return false;
    this.saveFullSnapshot('Scalenie w dół');
    this.maskView = null;

    const topFlat = topLayer.renderFlatCanvas();
    const mergedCanvas = document.createElement('canvas');
    mergedCanvas.width = this.width;
    mergedCanvas.height = this.height;
    const mctx = mergedCanvas.getContext('2d')!;

    bottomLayer.drawRenderedToContext(mctx);
    mctx.save();
    mctx.globalAlpha = topLayer.opacity;
    mctx.globalCompositeOperation = getCanvasCompositeOperation(topLayer.blendMode);
    mctx.drawImage(topFlat, 0, 0);
    mctx.restore();

    bottomLayer.dropMask();
    for (let ty = 0; ty < bottomLayer.tileGrid.rows; ty++) {
      for (let tx = 0; tx < bottomLayer.tileGrid.cols; tx++) {
        const tile = bottomLayer.tileGrid.tiles[ty][tx];
        tile.ctx.clearRect(0, 0, tile.width, tile.height);
        tile.ctx.drawImage(
          mergedCanvas,
          tile.pixelX, tile.pixelY, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }

    bottomLayer.updateThumbnail();
    this.layers.splice(this.activeLayerIndex, 1);
    this.activeLayerIndex = Math.max(0, this.activeLayerIndex - 1);
    this.markAllLayersDirty();
    return true;
  }

  /**
   * Przenosi warstwę (albo całą grupę, gdy `src` jest nagłówkiem) względem innej: `before` = nad nią (wizualnie),
   * `after` = pod nią, `into` = do wnętrza grupy (gdy `target` jest nagłówkiem). Grupy nie zagnieżdżają się.
   */
  public moveLayerTo(srcIndex: number, targetIndex: number, place: 'before' | 'after' | 'into'): boolean {
    const src = this.layers[srcIndex];
    const tgt = this.layers[targetIndex];
    if (!src || !tgt || src === tgt) return false;
    if (src.isGroup && tgt.groupId === src.id) return false;
    this.finishOpenSessions();

    // Jeśli upuszczamy warstwę na inną warstwę (bez maski), to przenoszona warstwa staje się w skali szarości i staje się maską tej warstwy
    if (place === 'into' && !tgt.isGroup && !tgt.hasMask && !src.isGroup) {
      if (tgt.locked || src.locked) return false;
      this.saveFullSnapshot('Utworzenie maski z warstwy');
      tgt.setMaskFromLayer(src);
      if (this.maskView === src) this.maskView = null;
      this.layers.splice(srcIndex, 1);
      this.activeLayerIndex = this.layers.indexOf(tgt);
      this.normalizeLayers(tgt);
      this.markAllLayersDirty();
      this.invalidateComposite();
      return true;
    }

    const sigBefore = this.layers.map((l) => `${l.id}:${l.groupId}`).join('|');
    this.saveFullSnapshot('Zmiana kolejności warstw');

    const units = this.buildUnits();
    const unitIndexOf = (l: Layer): number => units.findIndex((u) => u.layer === l || u.header === l || (u.children && u.children.includes(l)));

    // 1. wyjęcie źródła
    let removed: LayerUnit;
    if (src.isGroup) {
      removed = units.splice(unitIndexOf(src), 1)[0];
    } else {
      const ui = unitIndexOf(src);
      const u = units[ui];
      if (u.children) {
        u.children.splice(u.children.indexOf(src), 1);
        removed = { layer: src };
      } else {
        removed = units.splice(ui, 1)[0];
      }
    }

    // 2. wstawienie względem celu
    const ti = unitIndexOf(tgt);
    const tu = units[ti];
    if (src.isGroup) {
      units.splice(place === 'after' ? ti : ti + 1, 0, removed);
    } else if (tu.header === tgt) {
      if (place === 'before') {
        src.groupId = null;
        units.splice(ti + 1, 0, removed);
      } else if (place === 'into' || tu.header.expanded) {
        src.groupId = tu.header.id;
        tu.children!.push(src);
      } else {
        src.groupId = null;
        units.splice(ti, 0, removed);
      }
    } else if (tu.children) {
      const j = tu.children.indexOf(tgt);
      src.groupId = tu.header!.id;
      tu.children.splice(place === 'after' ? j : j + 1, 0, src);
    } else {
      src.groupId = null;
      units.splice(place === 'after' ? ti : ti + 1, 0, removed);
    }

    this.layers = this.flattenUnits(units);
    this.activeLayerIndex = this.layers.indexOf(src);
    const sigAfter = this.layers.map((l) => `${l.id}:${l.groupId}`).join('|');
    if (sigAfter === sigBefore) this.undoStack.pop();
    this.markAllLayersDirty();
    return true;
  }

  /** Krok w górę / w dół po wizualnej liście: warstwy wchodzą do rozwiniętych grup i z nich wychodzą. */
  private stepMove(dir: 1 | -1): boolean {
    const L = this.getActiveLayer();
    if (!L) return false;
    this.finishOpenSessions();
    const units = this.buildUnits();
    const u = units.findIndex((x) => x.layer === L || x.header === L || (x.children && x.children.includes(L)));
    if (u < 0) return false;
    const unit = units[u];

    // ruch w obrębie grupy albo wyjście z niej jest zawsze możliwy; poza grupą potrzebny jest sąsiad
    const inGroup = !!unit.children && unit.children.includes(L);
    if (!inGroup && !(u + dir >= 0 && u + dir < units.length)) return false;
    this.saveFullSnapshot('Zmiana kolejności warstw');

    if (unit.children && unit.children.includes(L)) {
      const k = unit.children.indexOf(L);
      const nk = k + dir;
      if (nk >= 0 && nk < unit.children.length) {
        [unit.children[k], unit.children[nk]] = [unit.children[nk], unit.children[k]];
      } else {
        unit.children.splice(k, 1);
        L.groupId = null;
        units.splice(dir > 0 ? u + 1 : u, 0, { layer: L });
      }
    } else if (unit.header === L) {
      [units[u], units[u + dir]] = [units[u + dir], units[u]];
    } else {
      const nu = units[u + dir];
      if (nu.header && nu.header.expanded) {
        units.splice(u, 1);
        const gi = dir > 0 ? u : u - 1;
        const g = units[gi];
        L.groupId = g.header!.id;
        if (dir > 0) g.children!.unshift(L);
        else g.children!.push(L);
      } else {
        [units[u], units[u + dir]] = [units[u + dir], units[u]];
      }
    }

    this.layers = this.flattenUnits(units);
    this.activeLayerIndex = this.layers.indexOf(L);
    this.markAllLayersDirty();
    return true;
  }

  public moveActiveLayerUp(): boolean {
    return this.stepMove(1);
  }

  public moveActiveLayerDown(): boolean {
    return this.stepMove(-1);
  }

  public setLayerOpacity(index: number, opacity: number, recordOldValue?: number): void {
    if (index >= 0 && index < this.layers.length) {
      const newVal = Math.max(0, Math.min(1, opacity));

      if (recordOldValue !== undefined && Math.abs(recordOldValue - newVal) > 0.001) {
        this.pushPropertyAction(index, 'opacity', recordOldValue, newVal, 'Zmiana krycia');
      }

      this.layers[index].opacity = newVal;
      if (this.layers[index].isGroup) this.invalidateComposite();
      else this.markAllLayersDirty();
    }
  }

  public setLayerBlendMode(index: number, blendMode: SKBlendMode): void {
    if (index >= 0 && index < this.layers.length) {
      const oldVal = this.layers[index].blendMode;
      const newVal = blendMode;
      if (oldVal !== newVal) {
        this.pushPropertyAction(index, 'blendMode', oldVal, newVal, 'Zmiana trybu mieszania');
        this.layers[index].blendMode = newVal;
        if (this.layers[index].isGroup) this.invalidateComposite();
        else this.markAllLayersDirty();
      }
    }
  }

  public toggleLayerVisibility(index: number): void {
    if (index >= 0 && index < this.layers.length) {
      const oldVal = this.layers[index].ownVisible;
      const newVal = !oldVal;
      this.pushPropertyAction(index, 'visible', oldVal, newVal, 'Zmiana widoczności');
      this.layers[index].visible = newVal;
      this.markAllLayersDirty();
    }
  }

  public toggleLayerLock(index: number): void {
    if (index >= 0 && index < this.layers.length) {
      this.layers[index].locked = !this.layers[index].ownLocked;
      this.markAllLayersDirty();
    }
  }

  // --- AKCJE ZAZNACZENIA Z OBSŁUGĄ HISTORII UNDO/REDO ---

  public pushSelectionAction(
    before: { imgData: ImageData | null; seedPoint: SKPoint | null },
    after: { imgData: ImageData | null; seedPoint: SKPoint | null },
    description: string = 'Zaznaczenie'
  ): void {
    this.undoStack.push({
      type: 'selection',
      description,
      before,
      after,
    });
    this.finishHistoryPush();
  }

  public selectAll(): void {
    if (this.transformContentSession) {
      this.commitTransformContent();
    }
    const before = this.selectionManager.getMaskSnapshot();
    this.selectionManager.selectAll();
    const after = this.selectionManager.getMaskSnapshot();
    this.pushSelectionAction(before, after, 'Zaznacz wszystko');
    this.markAllLayersDirty();
  }

  public deselect(): void {
    if (this.transformContentSession) {
      this.commitTransformContent();
    }
    const before = this.selectionManager.getMaskSnapshot();
    this.selectionManager.clear();
    const after = this.selectionManager.getMaskSnapshot();
    this.pushSelectionAction(before, after, 'Odznacz');
    this.markAllLayersDirty();
  }

  public invertSelection(): void {
    if (this.transformContentSession) {
      this.commitTransformContent();
    }
    const before = this.selectionManager.getMaskSnapshot();
    this.selectionManager.invert();
    const after = this.selectionManager.getMaskSnapshot();
    this.pushSelectionAction(before, after, 'Odwróć zaznaczenie');
    this.markAllLayersDirty();
  }

  public applySelectionShape(
    shapeType: 'rect' | 'ellipse' | 'lasso',
    points: SKPoint[],
    settings: SelectionSettings,
    isShiftPressed: boolean = false,
    hasMoved: boolean = true
  ): void {
    const before = this.selectionManager.getMaskSnapshot();
    this.selectionManager.applyGeometricSelection(shapeType, points, settings, isShiftPressed, hasMoved);
    const after = this.selectionManager.getMaskSnapshot();
    this.pushSelectionAction(before, after, `Zaznaczenie (${shapeType})`);
    this.markAllLayersDirty();
  }

  private fillSampling = false;

  private getMagicWandSampleCanvas(sampleSource?: WandSampleSource): HTMLCanvasElement {
    this.fillSampling = true;
    try {
      return this.getMagicWandSampleCanvasImpl(sampleSource);
    } finally {
      this.fillSampling = false;
    }
  }

  private getMagicWandSampleCanvasImpl(sampleSource?: WandSampleSource): HTMLCanvasElement {
    if (sampleSource === 'layer') {
      const activeLayer = this.getActiveLayer();
      if (activeLayer) {
        return activeLayer.tileGrid.compositeToFlatCanvas();
      }
    }
    return this.getCompositeFlatCanvas();
  }

  /**
   * Kopia pikseli próbkowanego obrazu (różdżka, wiadro); ponownie używana przy zmianie tolerancji i przesuwaniu punktu.
   * `data` = null, gdy bufor został przekazany do wątku roboczego (wtedy główny wątek go nie trzyma).
   */
  private wandSample: { key: string; data: ImageData | null; id: number } | null = null;
  private wandSampleSeq = 0;
  private fillClient: FillClient | null = null;

  private getFillClient(): FillClient {
    return this.fillClient ?? (this.fillClient = new FillClient());
  }

  private wandSampleKey(sampleSource?: WandSampleSource): string {
    return `${this.getBaseSignature()}|${sampleSource === 'layer' ? 'layer' : 'composite'}|${getTileEpoch()}`;
  }

  /**
   * Piksele do próbkowania. Składanie warstw w płaskie płótno i odczyt całego obrazu kosztują
   * setki milisekund przy dużych dokumentach, więc podczas przeciągania suwaka tolerancji lub uchwytu
   * kopia jest używana ponownie, dopóki nic w dokumencie się nie zmieni (sygnatura podkładu i licznik zmian kafelków).
   */
  private getMagicWandSample(
    sampleSource: WandSampleSource | undefined,
    reuse: boolean,
    needData: boolean = true
  ): { key: string; data: ImageData | null; id: number } {
    const cached = this.wandSample;
    if (reuse && cached && cached.key === this.wandSampleKey(sampleSource) && (cached.data || !needData)) return cached;
    const canvas = this.getMagicWandSampleCanvas(sampleSource);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const data = ctx.getImageData(0, 0, this.width, this.height);
    // Klucz liczony po odczycie (odczyt może np. zatwierdzić sesję gradientu)
    const sample = { key: this.wandSampleKey(sampleSource), data, id: ++this.wandSampleSeq };
    this.wandSample = sample;
    return sample;
  }

  /** Próbka z pikselami w głównym wątku (do obliczeń synchronicznych); odczytuje ją ponownie, gdy trafiła do wątku roboczego. */
  private getSampleWithData(sampleSource: WandSampleSource | undefined, reuse: boolean): { key: string; data: ImageData; id: number } {
    return this.getMagicWandSample(sampleSource, reuse, true) as { key: string; data: ImageData; id: number };
  }

  /** Zapewnia, że wątek roboczy ma aktualne piksele próbki (przesyłane raz na próbkę, bez kopiowania). */
  private ensureWorkerSample(sampleSource: WandSampleSource | undefined): { key: string; id: number } {
    const client = this.getFillClient();
    let sample = this.getMagicWandSample(sampleSource, true, false);
    let key = `s${sample.id}`;
    if (!client.hasSample(key)) {
      if (!sample.data) sample = this.getMagicWandSample(sampleSource, false, true);
      key = `s${sample.id}`;
      client.setSample(key, this.width, this.height, sample.data!.data);
      // Bufor został przeniesiony do wątku roboczego; lokalny solver trzyma ten sam bufor, więc tam nic się nie zmienia
      if (client.threaded) sample.data = null;
    }
    return { key, id: sample.id };
  }

  /** Płaszczyzna alfa zaznaczenia w wątku roboczym (wiadro nie wchodzi w niezaznaczone piksele). */
  private ensureWorkerSelection(): string {
    const sm = this.selectionManager;
    if (this.selAlphaPath !== sm.contourPath) {
      this.selAlphaPath = sm.contourPath;
      this.selAlphaSeq++;
    }
    const key = `sel${this.selAlphaSeq}`;
    const client = this.getFillClient();
    if (!client.hasSelection(key)) {
      client.setSelection(key, this.selectionAlphaPlane());
    }
    return key;
  }

  private selectionAlphaPlane(): Uint8Array {
    const d = this.selectionManager.maskCtx.getImageData(0, 0, this.width, this.height).data;
    const n = this.width * this.height;
    const alpha = new Uint8Array(n);
    for (let i = 0, p = 3; i < n; i++, p += 4) alpha[i] = d[p];
    return alpha;
  }

  /** Zwalnia pamięć kopii próbki (np. po zmianie narzędzia) i wątek roboczy. */
  public releaseWandSample(): void {
    this.wandSample = null;
    this.fillClient?.release();
  }

  // --- RÓŻDŻKA LICZONA W TLE ---
  // Punkt (uchwyt) i ustawienia są zapamiętywane od razu, a obszar liczy wątek roboczy: kolejne zmiany suwaka lub uchwytu
  // nie blokują interfejsu, a z zakolejkowanych zadań liczone jest tylko najnowsze.

  private wandPending: { id: number; before: SelectionSnapshot | null; settings: SelectionSettings; sig: string } | null = null;
  private wandAppliedId: number | null = null;
  private wandWaiters: Array<() => void> = [];

  /** Czy trwa liczenie różdżki w tle */
  public get wandBusy(): boolean {
    return this.wandPending !== null;
  }

  /** Obietnica rozwiązywana, gdy bieżące liczenie różdżki się zakończy (np. przed zapisem stanu do historii). */
  public whenWandIdle(): Promise<void> {
    return this.wandPending ? new Promise<void>((r) => this.wandWaiters.push(r)) : Promise.resolve();
  }

  /** Dokańcza synchronicznie wszystko, co liczy się w tle (przed operacją, która czyta zaznaczenie lub warstwę). */
  public flushPendingFill(): void {
    const p = this.wandPending;
    if (p) this.finishWandSync(p);
    if (this.bucketJob) this.flushBucketSync();
  }

  private completeWand(p: NonNullable<GraphicEngine['wandPending']>): void {
    this.wandPending = null;
    if (p.before) {
      const after = this.selectionManager.getMaskSnapshot();
      this.pushSelectionAction(p.before, after, 'Magiczna różdżka');
      this.markAllLayersDirty();
      // markAllLayersDirty zmienia sygnaturę podkładu - przepisujemy klucz, żeby następne odświeżenia mogły użyć kopii
      const smp = this.wandSample;
      if (smp) smp.key = this.wandSampleKey(p.settings.sampleSource);
    }
    const waiters = this.wandWaiters;
    this.wandWaiters = [];
    for (const w of waiters) w();
    this.onAsyncUpdate?.();
  }

  private finishWandSync(p: NonNullable<GraphicEngine['wandPending']>): void {
    const sm = this.selectionManager;
    const seed = sm.wandSeedPoint;
    this.wandPending = p; // zakończenie zdejmuje oczekujące zadanie, więc spóźniony wynik z wątku zostanie zignorowany
    if (seed) {
      const sample = this.getSampleWithData(p.settings.sampleSource, true);
      sm.applyMagicWand(seed, sample.data, p.settings, false, `s${sample.id}`);
    }
    this.wandAppliedId = null;
    this.completeWand(p);
  }

  private submitWand(settings: SelectionSettings, before: SelectionSnapshot | null): void {
    const sm = this.selectionManager;
    const seed = sm.wandSeedPoint;
    if (!seed) return;
    const sample = this.ensureWorkerSample(settings.sampleSource);
    const sig = `${sample.key}|${settings.wandMode}|${settings.feather}|${settings.mode}`;
    const client = this.getFillClient();
    const id = client.nextId();
    const isNew = before !== null;
    const prevBefore = this.wandPending?.before ?? null;
    this.wandPending = { id, before: before ?? prevBefore, settings: { ...settings }, sig };
    const reuseId = !isNew && this.wandAppliedId !== null && sm.canReuseAsyncWand(sig) ? this.wandAppliedId : null;
    client
      .wand({
        id,
        key: sample.key,
        sx: Math.max(0, Math.min(this.width - 1, Math.floor(seed.x))),
        sy: Math.max(0, Math.min(this.height - 1, Math.floor(seed.y))),
        tol: settings.tolerance,
        global: settings.wandMode === 'global',
        reuseId,
      })
      .then((r) => this.onWandResult(r));
  }

  private onWandResult(r: { id: number; status: string; crop?: WandCrop | null; geom?: Float64Array[][] | null }): void {
    const p = this.wandPending;
    if (!p || p.id !== r.id) return; // wyprzedzone nowszym zadaniem albo już zakończone synchronicznie
    if (r.status !== 'ok' && r.status !== 'same') {
      this.finishWandSync(p); // wątek nie miał próbki / błąd: liczymy w głównym wątku
      return;
    }
    const sm = this.selectionManager;
    if (r.status === 'ok') sm.applyWandCrop(r.crop ?? null, r.geom ?? null, p.settings, p.sig);
    else sm.confirmAsyncWandSame(p.sig);
    this.wandAppliedId = r.id;
    this.completeWand(p);
  }

  public applyMagicWand(seedPoint: SKPoint, settings: SelectionSettings): void {
    if (settings.feather > 0) {
      // Z piórkowaniem wynik jest maską rastrową (rozmycie na płótnie), więc ta ścieżka zostaje synchroniczna
      this.flushPendingFill();
      const before = this.selectionManager.getMaskSnapshot();
      const sample = this.getSampleWithData(settings.sampleSource, false);
      this.selectionManager.applyMagicWand(seedPoint, sample.data, settings, true, `s${sample.id}`);
      const after = this.selectionManager.getMaskSnapshot();
      this.pushSelectionAction(before, after, 'Magiczna różdżka');
      this.markAllLayersDirty();
      // markAllLayersDirty zmienia sygnaturę podkładu - przepisujemy klucz, żeby następne odświeżenia mogły użyć kopii
      sample.key = this.wandSampleKey(settings.sampleSource);
      return;
    }
    const before = this.wandPending?.before ?? this.selectionManager.getMaskSnapshot();
    this.selectionManager.beginWand(seedPoint, settings, true);
    this.submitWand(settings, before);
  }

  public refreshMagicWand(settings: SelectionSettings, seedPoint?: SKPoint): void {
    const sm = this.selectionManager;
    if (seedPoint) {
      sm.wandSeedPoint = seedPoint;
    }
    if (!sm.wandSeedPoint) return;

    if (settings.feather > 0) {
      this.flushPendingFill();
      const sample = this.getSampleWithData(settings.sampleSource, true);
      sm.applyMagicWand(sm.wandSeedPoint, sample.data, settings, false, `s${sample.id}`);
      // Zmiana zaznaczenia nie zmienia pikseli warstw, więc nie unieważniamy kafelków ani miniatur
      return;
    }
    sm.lastWandSettings = { ...settings };
    this.submitWand(settings, null);
  }

  // --- INTERAKTYWNE WIADRO Z WODĄ (PAINT BUCKET) ---

  /**
   * Wiadro: zapamiętuje punkt, kolor i parametry od razu (uchwyt i suwak reagują natychmiast), a obszar liczy wątek roboczy.
   * Piksele warstwy zmieniane są dopiero przy zatwierdzeniu (commitPaintBucketSession).
   */
  public applyPaintBucket(
    seedPoint: SKPoint,
    selectionSettings: SelectionSettings,
    brushSettings: BrushSettings,
    isNewClick: boolean = true,
    colorSource?: 'primary' | 'secondary'
  ): boolean {
    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return false;

    if (isNewClick) {
      this.commitPaintBucketSession();
      this.bucketInitialLayerIndex = this.activeLayerIndex;
      this.bucketSeedPoint = { ...seedPoint };
      this.bucketPreview = null;
      this.bucketGeomKey = null;
      if (colorSource) {
        this.bucketColorSource = colorSource;
      }
    } else if (seedPoint) {
      this.bucketSeedPoint = { ...seedPoint };
    }
    if (!this.bucketSeedPoint) return false;

    this.bucketParams = {
      tol: selectionSettings.tolerance ?? 15,
      global: (selectionSettings.wandMode || 'contiguous') === 'global',
      sampleSource: selectionSettings.sampleSource,
      aa: !!brushSettings.antiAliasing,
      blend: brushSettings.blendMode || 'SrcOver',
      color: { ...brushSettings.color },
    };
    this.submitBucket();
    this.onAsyncUpdate?.();
    return true;
  }

  private bucketSeedPixel(): { sx: number; sy: number } {
    const sp = this.bucketSeedPoint!;
    return {
      sx: Math.max(0, Math.min(this.width - 1, Math.floor(sp.x))),
      sy: Math.max(0, Math.min(this.height - 1, Math.floor(sp.y))),
    };
  }

  private submitBucket(): void {
    const prm = this.bucketParams;
    if (!prm || !this.bucketSeedPoint) return;
    const { sx, sy } = this.bucketSeedPixel();
    const sample = this.ensureWorkerSample(prm.sampleSource);
    const selKey = this.selectionManager.hasActiveSelection ? this.ensureWorkerSelection() : null;
    const geomKey = `${sx},${sy}|${prm.tol}|${prm.global}|${prm.aa}|${sample.key}|${selKey}`;
    // Zmiana samego koloru lub trybu mieszania nie zmienia obszaru: wystarczy odświeżyć podgląd
    if (geomKey === this.bucketGeomKey) {
      this.bucketJob = null;
      return;
    }
    const client = this.getFillClient();
    const id = client.nextId();
    this.bucketJob = { id };
    this.bucketGeomKey = geomKey;
    client
      .bucket({ id, key: sample.key, selKey, sx, sy, tol: prm.tol, global: prm.global, aa: prm.aa })
      .then((r) => {
        if (!this.bucketJob || this.bucketJob.id !== r.id) return; // wyprzedzone nowszym zadaniem
        if (r.status === 'ok' && r.kind === 'bucket') {
          this.bucketJob = null;
          this.setBucketResult(r.res);
          this.onAsyncUpdate?.();
        } else {
          this.flushBucketSync();
          this.onAsyncUpdate?.();
        }
      });
  }

  private setBucketResult(res: BucketAlpha | null): void {
    this.bucketPreview = res
      ? { x: res.x, y: res.y, w: res.w, h: res.h, alpha: res.alpha, seq: ++this.bucketSeq, tinted: null, tintKey: '' }
      : null;
  }

  /** Liczy wypełnienie wiadra od razu w głównym wątku (zatwierdzenie przed końcem liczenia w tle albo awaria wątku). */
  private flushBucketSync(): void {
    const prm = this.bucketParams;
    this.bucketJob = null;
    if (!prm || !this.bucketSeedPoint) return;
    const { sx, sy } = this.bucketSeedPixel();
    const sample = this.getSampleWithData(prm.sampleSource, true);
    const allow = this.selectionManager.hasActiveSelection ? this.selectionAlphaPlane() : null;
    const flood = floodSelect(sample.data.data, this.width, this.height, sx, sy, prm.tol, prm.global, allow);
    this.setBucketResult(bucketAlphaOfFlood(flood, sample.data.data, this.width, sx, sy, prm.tol, prm.aa));
  }

  /** Gotowe wypełnienie wiadra do narysowania przez renderer kafelków (kolor i tryb mieszania z bieżących parametrów). */
  public getBucketPreview(): {
    canvas: HTMLCanvasElement;
    x: number;
    y: number;
    w: number;
    h: number;
    blendMode: SKBlendMode;
    key: string;
  } | null {
    const pv = this.bucketPreview;
    const prm = this.bucketParams;
    if (!pv || !prm || !this.bucketSeedPoint) return null;
    const c = prm.color;
    const tintKey = `${c.r},${c.g},${c.b},${c.a}`;
    if (!pv.tinted || pv.tintKey !== tintKey) {
      const canvas = pv.tinted ?? document.createElement('canvas');
      if (canvas.width !== pv.w || canvas.height !== pv.h) {
        canvas.width = pv.w;
        canvas.height = pv.h;
      }
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(pv.w, pv.h);
      const px = new Uint32Array(img.data.buffer);
      const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
      const lut = new Uint32Array(256);
      for (let a = 1; a < 256; a++) {
        const al = Math.round((c.a * a) / 255);
        lut[a] = little ? ((al << 24) | (c.b << 16) | (c.g << 8) | c.r) >>> 0 : ((c.r << 24) | (c.g << 16) | (c.b << 8) | al) >>> 0;
      }
      const src = pv.alpha;
      for (let i = 0; i < src.length; i++) {
        const a = src[i];
        if (a !== 0) px[i] = lut[a];
      }
      ctx.putImageData(img, 0, 0);
      pv.tinted = canvas;
      pv.tintKey = tintKey;
    }
    return { canvas: pv.tinted, x: pv.x, y: pv.y, w: pv.w, h: pv.h, blendMode: prm.blend, key: `bk${pv.seq}|${tintKey}|${prm.blend}` };
  }

  private resetBucketSession(): void {
    if (this.bucketPreview?.tinted) this.bucketPreview.tinted.width = 0;
    this.bucketPreview = null;
    this.bucketParams = null;
    this.bucketJob = null;
    this.bucketGeomKey = null;
    this.bucketInitialLayerIndex = -1;
    this.bucketSeedPoint = null;
    this.bucketColorSource = 'primary';
  }

  /** Anuluje wiadro bez zmiany pikseli (Esc). */
  public cancelPaintBucketSession(): void {
    this.resetBucketSession();
  }

  public commitPaintBucketSession(): void {
    if (this.bucketJob) this.flushBucketSync();
    const pv = this.getBucketPreview();
    const layerIndex = this.bucketInitialLayerIndex;
    const layer = layerIndex >= 0 ? this.layers[layerIndex] : undefined;
    if (pv && layer && layer.visible) {
      const rect: SKRectI = { left: pv.x, top: pv.y, right: pv.x + pv.w, bottom: pv.y + pv.h, width: pv.w, height: pv.h };
      const before = layer.tileGrid.getTilesSnapshot(rect);
      const hasSel = this.selectionManager.hasActiveSelection;
      const mask = hasSel ? this.selectionManager.maskCanvas : null;
      const blendOp = getCanvasCompositeOperation(pv.blendMode);
      const scratch = document.createElement('canvas');
      for (const tile of layer.tileGrid.getTilesIntersectingRect(rect)) {
        if (tile.width <= 0 || tile.height <= 0) continue;
        if (scratch.width !== tile.width || scratch.height !== tile.height) {
          scratch.width = tile.width;
          scratch.height = tile.height;
        }
        const g = scratch.getContext('2d')!;
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, tile.width, tile.height);
        g.drawImage(pv.canvas, pv.x - tile.pixelX, pv.y - tile.pixelY);
        if (mask) {
          g.globalCompositeOperation = 'destination-in';
          g.drawImage(mask, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
          g.globalCompositeOperation = 'source-over';
        }
        tile.ctx.save();
        tile.ctx.globalCompositeOperation = blendOp;
        tile.ctx.drawImage(scratch, 0, 0);
        tile.ctx.restore();
        tile.hasContent = true;
        tile.isDirty = true;
      }
      const after = layer.tileGrid.getTilesSnapshot(rect);
      this.pushTileAction({ type: 'tiles', description: 'Wypełnienie wiaderkiem', layerIndex, before, after });
      layer.updateThumbnail();
      this.markAllLayersDirty();
    }
    this.resetBucketSession();
  }

  // --- INTERAKTYWNE WYPEŁNIENIE GRADIENTOWE (GRADIENT FILL) ---

  public restoreGradientInitialTiles(): void {
    if (
      this.gradientInitialTilesSnapshot &&
      this.gradientInitialLayerIndex >= 0 &&
      this.gradientInitialLayerIndex < this.layers.length
    ) {
      const layer = this.layers[this.gradientInitialLayerIndex];
      if (layer) {
        for (const t of this.gradientInitialTilesSnapshot) {
          const tile = layer.tileGrid.getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
        layer.updateThumbnail();
      }
    }
  }

  /** Prostokąt, którego dotyczy gradient: obwiednia zaznaczenia albo cały dokument. */
  private getGradientAffectedRect(): SKRectI {
    let left = 0;
    let top = 0;
    let right = this.width;
    let bottom = this.height;
    if (this.selectionManager.hasActiveSelection) {
      const bounds = this.selectionManager.getSelectionBounds();
      if (bounds) {
        left = Math.max(0, Math.floor(bounds.left));
        top = Math.max(0, Math.floor(bounds.top));
        right = Math.min(this.width, Math.ceil(bounds.right));
        bottom = Math.min(this.height, Math.ceil(bounds.bottom));
      }
    }
    return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  /**
   * Edycja gradientu na żywo: zapamiętuje parametry i NIE dotyka pikseli warstwy.
   * Kafelki podglądu rysują gradient na podstawie `gradientPreview`; zatwierdzenie robi commitGradientSession().
   */
  public applyGradient(
    p0: SKPoint,
    p1: SKPoint,
    settings: GradientSettings,
    primaryColor: SKColor,
    secondaryColor: SKColor,
    blendMode: SKBlendMode = 'SrcOver',
    isNewDrag: boolean = true,
    colorSource?: 'primary' | 'secondary'
  ): boolean {
    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return false;

    if (isNewDrag) {
      this.commitGradientSession();
      if (colorSource) {
        this.gradientColorSource = colorSource;
      }
      this.gradientInitialLayerIndex = this.activeLayerIndex;
    } else {
      if (colorSource) {
        this.gradientColorSource = colorSource;
      }
      if (this.gradientInitialLayerIndex < 0) this.gradientInitialLayerIndex = this.activeLayerIndex;
    }
    this.gradientStartPoint = { ...p0 };
    this.gradientEndPoint = { ...p1 };

    // Kolory zależne od przycisku myszy (kolor dodatkowy) rozstrzygane od razu, żeby podgląd i zatwierdzenie były spójne
    const isSecondary = this.gradientColorSource === 'secondary';
    this.gradientPreview = {
      p0: { ...p0 },
      p1: { ...p1 },
      settings: { ...settings },
      primary: { ...(isSecondary ? secondaryColor : primaryColor) },
      secondary: { ...(isSecondary ? primaryColor : secondaryColor) },
      blendMode,
    };
    return true;
  }

  /** Anuluje edycję gradientu bez zmiany pikseli. */
  public cancelGradientSession(): void {
    this.gradientPreview = null;
    this.gradientInitialTilesSnapshot = null;
    this.gradientInitialLayerIndex = -1;
    this.gradientStartPoint = null;
    this.gradientEndPoint = null;
    this.gradientColorSource = 'primary';
  }

  /**
   * Jednorazowe nałożenie gradientu na piksele warstwy (zatwierdzenie).
   * Działa kafelek po kafelku tą samą funkcją, której używa podgląd, więc wynik jest identyczny z podglądem,
   * a koszt zależy od liczby dotkniętych kafelków (obwiednia zaznaczenia), nie od rozmiaru całego płótna.
   */
  private bakeGradient(layer: Layer, params: GradientPreviewParams): void {
    const rect = this.getGradientAffectedRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const hasSel = this.selectionManager.hasActiveSelection;
    const mask = this.selectionManager.maskCanvas;
    const scratch = document.createElement('canvas');
    const blendOp = getCanvasCompositeOperation(params.blendMode);

    for (const tile of layer.tileGrid.getTilesIntersectingRect(rect)) {
      if (tile.width <= 0 || tile.height <= 0) continue;
      if (scratch.width !== tile.width || scratch.height !== tile.height) {
        scratch.width = tile.width;
        scratch.height = tile.height;
      }
      const g = scratch.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, tile.width, tile.height);
      g.setTransform(1, 0, 0, 1, -tile.pixelX, -tile.pixelY);
      renderGradientPreview(g, params, this.width, this.height);
      g.setTransform(1, 0, 0, 1, 0, 0);
      if (hasSel) {
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(mask, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
        g.globalCompositeOperation = 'source-over';
      }
      tile.ctx.save();
      tile.ctx.globalCompositeOperation = blendOp;
      tile.ctx.drawImage(scratch, 0, 0);
      tile.ctx.restore();
      tile.hasContent = true;
      tile.isDirty = true;
    }

    layer.updateThumbnail();
    this.markAllLayersDirty();
  }

  public commitGradientSession(): void {
    const params = this.gradientPreview;
    if (params && this.gradientInitialLayerIndex >= 0) {
      const layerIndex = this.gradientInitialLayerIndex;
      const layer = this.layers[layerIndex];
      if (layer) {
        // Migawka tylko kafelków, których dotyczy gradient (a nie całej warstwy)
        const rect = this.getGradientAffectedRect();
        const before = layer.tileGrid.getTilesSnapshot(rect);
        this.bakeGradient(layer, params);
        const after = layer.tileGrid.getTilesSnapshot(rect);
        this.pushTileAction({
          type: 'tiles',
          description: 'Wypełnienie gradientowe',
          layerIndex,
          before,
          after,
        });
      }
    }
    this.cancelGradientSession();
  }

  // --- MODYFIKACJA ZAWARTOŚCI ZAZNACZENIA (TRANSFORM CONTENT) ---

  /**
   * Wycięcie z miękkim brzegiem (wspólne dla manipulacji zawartością, wytnij i kopiuj). Waga w zależy od krycia
   * zaznaczenia a i alfy piksela al: w = a/255 dla pikseli nieprzezroczystych (zwykły antyaliasing), a dla pikseli
   * częściowo przezroczystych (niosących już własny miękki brzeg) w = 1, żeby nie zostawała obwódka. Fragment dostaje
   * piksel * w, a warstwa traci dokładnie tyle samo (zostaje piksel * (1 - w)): fragment + reszta = oryginał.
   * `content` - fragment w prostokącie bounds, `cutMask` - waga w układzie dokumentu (alfa = w), `shape` - binarny kształt.
   */
  private liftSoft(layer: Layer, bounds: SKRectI): { content: HTMLCanvasElement; cutMask: HTMLCanvasElement; shape: HTMLCanvasElement } {
    const bw = bounds.width;
    const bh = bounds.height;
    const content = document.createElement('canvas');
    content.width = bw;
    content.height = bh;
    const sctx = content.getContext('2d', { willReadFrequently: true })!;
    // Narysuj tylko kafelki przecinające obszar zaznaczenia (100x szybciej niż cała siatka)
    layer.tileGrid.drawCroppedToContext(sctx, bounds.left, bounds.top, bw, bh);
    const lImg = sctx.getImageData(0, 0, bw, bh);
    const selCrop = document.createElement('canvas');
    selCrop.width = bw;
    selCrop.height = bh;
    const selCtx = selCrop.getContext('2d', { willReadFrequently: true })!;
    selCtx.drawImage(this.selectionManager.maskCanvas, bounds.left, bounds.top, bw, bh, 0, 0, bw, bh);
    const sImg = selCtx.getImageData(0, 0, bw, bh);
    const wImg = new ImageData(bw, bh);
    const shImg = new ImageData(bw, bh);
    for (let i = 0; i < lImg.data.length; i += 4) {
      const a = sImg.data[i + 3];
      if (a === 0) {
        lImg.data[i + 3] = 0;
        continue;
      }
      const al = lImg.data[i + 3];
      // piksel częściowo przezroczysty niesie już własny brzeg (antyaliasing): zaznaczony choćby w części jest brany w całości
      const w = al === 0 ? a / 255 : al < 255 ? 1 : a / 255;
      const m = Math.round(w * 255);
      wImg.data[i + 3] = m;
      lImg.data[i + 3] = Math.round((al * m) / 255);
      if (a >= 128) {
        shImg.data[i] = shImg.data[i + 1] = shImg.data[i + 2] = 255;
        shImg.data[i + 3] = 255;
      }
    }
    sctx.putImageData(lImg, 0, 0);
    const cutMask = document.createElement('canvas');
    cutMask.width = this.width;
    cutMask.height = this.height;
    cutMask.getContext('2d')!.putImageData(wImg, bounds.left, bounds.top);

    const shape = document.createElement('canvas');
    shape.width = bw;
    shape.height = bh;
    shape.getContext('2d')!.putImageData(shImg, 0, 0);

    return { content, cutMask, shape };
  }

  public beginTransformContent(interpolation: InterpolationMode = 'bilinear'): boolean {
    if (this.transformContentSession) return true;

    // Jeśli zaznaczenie zostało zmodyfikowane narzędziem transform-selection, zatwierdź je najpierw
    if (this.selectionManager.transformState) {
      this.selectionManager.commitTransformSelection();
    }

    if (!this.selectionManager.hasActiveSelection) {
      this.selectAll();
    }

    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return false;
    // Połączona maska: warstwa przekształca się jako całość (piksele + maska), więc celem jest zawsze siatka pikseli
    if (layer.maskGrid && layer.maskLinked && layer.editMask) {
      if (this.maskView === layer) this.maskView = null;
      layer.editMask = false;
    }

    const bounds = this.selectionManager.getSelectionBounds();
    if (!bounds) return false;

    // 1. Zapisz oryginalny stan kafelków aktywnej warstwy i maski zaznaczenia
    const initialTilesSnapshot = layer.tileGrid.getTilesSnapshot();
    const initialSelectionSnapshot = this.selectionManager.getMaskSnapshot();

    const lift = this.liftSoft(layer, bounds);
    const sourceContentCanvas = lift.content;
    const cleanCutMask = lift.cutMask;
    const srcMaskCanvas = lift.shape;

    // 2b. Połączona maska: druga siatka (maska / piksele) przesuwa się razem z pierwszą
    let other: TransformContentSession['other'] = null;
    if (layer.maskGrid && layer.maskLinked) {
      const og = layer.editMask ? layer.pixelGrid : layer.maskGrid;
      const oc = document.createElement('canvas');
      oc.width = bounds.width;
      oc.height = bounds.height;
      const octx = oc.getContext('2d')!;
      og.drawCroppedToContext(octx, bounds.left, bounds.top, bounds.width, bounds.height);
      octx.globalCompositeOperation = 'destination-in';
      octx.drawImage(cleanCutMask, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
      octx.globalCompositeOperation = 'source-over';
      other = { grid: og, content: oc, cutMask: cleanCutMask, before: og.getTilesSnapshot() };
    }
    let previewCanvas: HTMLCanvasElement | null = null;
    if (other && layer.maskEnabled) {
      // pływające piksele widać przez poruszaną razem z nimi maskę
      previewCanvas = document.createElement('canvas');
      previewCanvas.width = sourceContentCanvas.width;
      previewCanvas.height = sourceContentCanvas.height;
      const pctx = previewCanvas.getContext('2d', { willReadFrequently: true })!;
      pctx.drawImage(sourceContentCanvas, 0, 0);
      const mimg = other.content.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, other.content.width, other.content.height);
      grayToAlpha(mimg.data);
      const mtmp = document.createElement('canvas');
      mtmp.width = other.content.width;
      mtmp.height = other.content.height;
      mtmp.getContext('2d')!.putImageData(mimg, 0, 0);
      pctx.globalCompositeOperation = 'destination-in';
      pctx.drawImage(mtmp, 0, 0);
      pctx.globalCompositeOperation = 'source-over';
    }

    // 3. Wycięcie z warstwy jest odroczone (`syncContentCut`): dopóki ramka jest w stanie początkowym, warstwa pozostaje
    // nietknięta i widać dokładnie oryginał (miękka suma fragmentu i reszty przy nałożeniu „nad” dałaby wgłębienie na brzegu).

    // 4. Uruchom ramkę manipulacji
    this.selectionManager.beginTransformSelection();

    this.transformContentSession = {
      sourceContentCanvas,
      sourceBounds: bounds,
      sourceLayerIndex: this.activeLayerIndex,
      initialTilesSnapshot,
      initialSelectionSnapshot,
      interpolation,
      other,
      previewCanvas,
      srcMask: srcMaskCanvas,
      softContent: true,
      cutMask: cleanCutMask,
      cutDone: false,
    };

    this.markAllLayersDirty();
    return true;
  }

  // --- TRYB PERSPEKTYWY (narzędzie manipulacji zawartością) ---

  public get perspectiveActive(): boolean {
    return !!this.transformContentSession?.persp;
  }

  /** Podgląd perspektywy (zapamiętany do czasu zmiany czworokąta). */
  public getPerspectivePreview(): PerspectivePreview | null {
    const sess = this.transformContentSession;
    if (!sess?.persp) return null;
    const key = JSON.stringify(sess.persp.quad) + sess.interpolation;
    if (sess.persp.cache && sess.persp.cache.key === key) return sess.persp.cache.pv;
    const img = sess.previewCanvas ?? sess.sourceContentCanvas;
    const pv = warpPerspectivePreview(img, sess.persp.quad, this.width, this.height, sess.interpolation === 'nearest-neighbor');
    sess.persp.cache = { key, pv };
    return pv;
  }

  public getPerspectiveQuad(): Quad | null {
    return this.transformContentSession?.persp?.quad ?? null;
  }

  /** Czworokąt odpowiadający aktualnej ramce (pozycja, kąt, rozmiar, odbicia) przekształcenia. */
  private quadFromTransformState(): Quad | null {
    const st = this.selectionManager.transformState;
    if (!st) return null;
    const cos = Math.cos(st.angle);
    const sin = Math.sin(st.angle);
    const fx = st.flipX ? -1 : 1;
    const fy = st.flipY ? -1 : 1;
    const corner = (u: number, v: number) => {
      const lx = (u - 0.5) * st.width * fx;
      const ly = (v - 0.5) * st.height * fy;
      return { x: st.pos.x + lx * cos - ly * sin, y: st.pos.y + lx * sin + ly * cos };
    };
    return [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
  }

  public enterPerspective(): boolean {
    const sess = this.transformContentSession;
    if (!sess || sess.persp) return !!sess;
    const q = this.quadFromTransformState();
    if (!q) return false;
    if (!sess.srcMask) {
      const m = document.createElement('canvas');
      m.width = sess.sourceContentCanvas.width;
      m.height = sess.sourceContentCanvas.height;
      const mc = m.getContext('2d')!;
      mc.fillStyle = '#fff';
      mc.fillRect(0, 0, m.width, m.height);
      sess.srcMask = m;
    }
    sess.persp = { quad: q.map((p) => ({ ...p })) as Quad, quad0: q.map((p) => ({ ...p })) as Quad, changed: false };
    this.markAllLayersDirty();
    return true;
  }

  /** Ustawia nowy czworokąt (odrzuca niewypukły) i przelicza maskę zaznaczenia. */
  public setPerspectiveQuad(q: Quad): boolean {
    const sess = this.transformContentSession;
    if (!sess?.persp || !sess.srcMask) return false;
    if (!isConvexQuad(q)) return false;
    sess.persp.quad = q.map((p) => ({ x: p.x, y: p.y })) as Quad;
    sess.persp.changed = true;
    this.syncContentCut();
    const mask = sess.srcMask;
    const quad = sess.persp.quad;
    this.selectionManager.replaceMaskRaster((ctx) => {
      ctx.imageSmoothingEnabled = false;
      drawPerspectiveMesh(ctx, mask, mask.width, mask.height, quad);
    });
    this.markAllLayersDirty();
    return true;
  }

  private buildMaskedPreview(content: HTMLCanvasElement, maskContent: HTMLCanvasElement): HTMLCanvasElement {
    const pc = document.createElement('canvas');
    pc.width = content.width;
    pc.height = content.height;
    const pctx = pc.getContext('2d', { willReadFrequently: true })!;
    pctx.drawImage(content, 0, 0);
    const mimg = maskContent.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, maskContent.width, maskContent.height);
    grayToAlpha(mimg.data);
    const mtmp = document.createElement('canvas');
    mtmp.width = maskContent.width;
    mtmp.height = maskContent.height;
    mtmp.getContext('2d')!.putImageData(mimg, 0, 0);
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(mtmp, 0, 0);
    pctx.globalCompositeOperation = 'source-over';
    return pc;
  }

  /**
   * Wychodzi z trybu perspektywy: zawartość (i maska zaznaczenia) zostają przeliczone dokładnie piksel po pikselu
   * i stają się nowym źródłem zwykłej ramki manipulacji.
   */
  public exitPerspective(): boolean {
    const sess = this.transformContentSession;
    if (!sess?.persp) return false;
    const persp = sess.persp;
    const sm = this.selectionManager;

    if (!persp.changed) {
      sess.persp = null;
      sm.updateTransformSelection({});
      this.markAllLayersDirty();
      return true;
    }

    const nearest = sess.interpolation === 'nearest-neighbor';
    const quad = persp.quad;
    const wc = warpPerspectiveExact(sess.sourceContentCanvas, quad, this.width, this.height, nearest);
    const wmRaw = sess.srcMask ? warpPerspectiveExact(sess.srcMask, quad, this.width, this.height, true) : null;
    const wo = sess.other ? warpPerspectiveExact(sess.other.content, quad, this.width, this.height, nearest) : null;
    if (!wc || !wmRaw) {
      sess.persp = null;
      sm.updateTransformSelection({});
      this.markAllLayersDirty();
      return false;
    }
    // maska binarna
    const mctx = wmRaw.canvas.getContext('2d', { willReadFrequently: true })!;
    const mimg = mctx.getImageData(0, 0, wmRaw.canvas.width, wmRaw.canvas.height);
    for (let i = 3; i < mimg.data.length; i += 4) {
      mimg.data[i] = mimg.data[i] >= 128 ? 255 : 0;
      if (mimg.data[i]) {
        mimg.data[i - 3] = 255;
        mimg.data[i - 2] = 255;
        mimg.data[i - 1] = 255;
      }
    }
    mctx.putImageData(mimg, 0, 0);
    const wm: WarpResult = wmRaw;

    sm.replaceMaskRaster((ctx) => {
      ctx.drawImage(wm.canvas, wm.left, wm.top);
    });
    sm.commitTransformSelection();
    const st = sm.beginTransformSelection();
    if (!st) {
      sess.persp = null;
      this.markAllLayersDirty();
      return false;
    }
    const b = st.initialBounds;
    const crop = (w: WarpResult): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = b.width;
      c.height = b.height;
      c.getContext('2d')!.drawImage(w.canvas, w.left - b.left, w.top - b.top);
      return c;
    };
    sess.sourceContentCanvas = crop(wc);
    sess.srcMask = crop(wm);
    if (sess.other && wo) {
      sess.other.content = crop(wo);
      sess.previewCanvas = this.getActiveLayer()?.maskEnabled ? this.buildMaskedPreview(sess.sourceContentCanvas, sess.other.content) : null;
    }
    sess.sourceBounds = b;
    sess.persp = null;
    sess.contentChanged = true;
    this.markAllLayersDirty();
    return true;
  }

  /** Renderuje przekształcony (przesunięty / przeskalowany / obrócony) fragment do płótna dokumentu, przycięty do maski zaznaczenia. */
  private renderTransformedContent(src: HTMLCanvasElement, interpolation: InterpolationMode, soft = false): HTMLCanvasElement {
    const st = this.selectionManager.transformState!;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tctx = tempCanvas.getContext('2d')!;
    tctx.save();
    tctx.translate(st.pos.x, st.pos.y);
    tctx.rotate(st.angle);
    const sx = (st.width / Math.max(1, st.initialBounds.width)) * (st.flipX ? -1 : 1);
    const sy = (st.height / Math.max(1, st.initialBounds.height)) * (st.flipY ? -1 : 1);
    tctx.scale(sx, sy);
    if (interpolation === 'nearest-neighbor') {
      tctx.imageSmoothingEnabled = false;
    } else if (interpolation === 'bilinear') {
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'medium';
    } else {
      tctx.imageSmoothingEnabled = true;
      tctx.imageSmoothingQuality = 'high';
    }
    tctx.drawImage(src, -st.initialBounds.width / 2, -st.initialBounds.height / 2);
    tctx.restore();
    if (!soft) {
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
      tctx.restore();
    }
    return tempCanvas;
  }

  public updateTransformContentInterpolation(interpolation: InterpolationMode): void {
    if (this.transformContentSession) {
      this.transformContentSession.interpolation = interpolation;
      this.markAllLayersDirty();
    }
  }

  public commitTransformContent(): boolean {
    if (this.transformContentSession?.persp) this.exitPerspective();
    if (!this.transformContentSession || !this.selectionManager.transformState) {
      this.transformContentSession = null;
      return false;
    }

    const sess = this.transformContentSession;
    const st = this.selectionManager.transformState;
    const layer = this.layers[sess.sourceLayerIndex];

    // Stan początkowy: nic się nie zmieniło, więc nie ma czego zatwierdzać (warstwa jest nietknięta)
    if (this.contentTransformIsIdentity()) {
      if (layer && sess.identityTiles) {
        // wklejenie w miejsce wycięcia: warstwa wróciła do oryginału, co trzeba zapisać w historii (po „Wytnij”)
        const selectionAfter = this.selectionManager.getMaskSnapshot();
        this.pushTileAction({
          type: 'transformContent',
          description: 'Wklej',
          layerIndex: sess.sourceLayerIndex,
          tilesBefore: sess.initialTilesSnapshot,
          tilesAfter: layer.tileGrid.getTilesSnapshot(),
          selectionBefore: sess.initialSelectionSnapshot,
          selectionAfter,
        });
      }
      this.selectionManager.commitTransformSelection();
      this.transformContentSession = null;
      this.markAllLayersDirty();
      return true;
    }
    this.syncContentCut();

    if (layer) {
      // Wyrenderuj ostateczny przekształcony fragment z wybranym algorytmem próbkowania
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = this.width;
      tempCanvas.height = this.height;
      const tctx = tempCanvas.getContext('2d')!;

      tctx.save();
      tctx.translate(st.pos.x, st.pos.y);
      tctx.rotate(st.angle);
      const scaleXMult = st.flipX ? -1 : 1;
      const scaleYMult = st.flipY ? -1 : 1;
      const sx = (st.width / Math.max(1, st.initialBounds.width)) * scaleXMult;
      const sy = (st.height / Math.max(1, st.initialBounds.height)) * scaleYMult;
      tctx.scale(sx, sy);

      if (sess.interpolation === 'nearest-neighbor') {
        tctx.imageSmoothingEnabled = false;
      } else if (sess.interpolation === 'bilinear') {
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = 'medium';
      } else {
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = 'high';
      }

      tctx.drawImage(
        sess.sourceContentCanvas,
        -st.initialBounds.width / 2,
        -st.initialBounds.height / 2
      );
      tctx.restore();

      // Przycina przekształconą zawartość dokładnie do aktualnej maski zaznaczenia,
      // co uniemożliwia wyciekanie rozmytych pikseli poza krawędzie zaznaczenia.
      if (!sess.softContent) {
        tctx.save();
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
        tctx.restore();
      }

      // Wklej wyrenderowany fragment do kafelków warstwy
      for (let ty = 0; ty < layer.tileGrid.rows; ty++) {
        for (let tx = 0; tx < layer.tileGrid.cols; tx++) {
          const tile = layer.tileGrid.tiles[ty][tx];
          tile.ctx.drawImage(
            tempCanvas,
            tile.pixelX, tile.pixelY, tile.width, tile.height,
            0, 0, tile.width, tile.height
          );
          tile.hasContent = true;
          tile.isDirty = true;
        }
      }
      let otherHist: { before: TileSnapshotLike[]; after: TileSnapshotLike[] } | undefined;
      if (sess.other) {
        const o = sess.other;
        const moved = this.renderTransformedContent(o.content, sess.interpolation, !!sess.softContent);
        const vacatedIsMask = o.grid === layer.maskGrid;
        for (const row of o.grid.tiles) {
          for (const tile of row) {
            // miejsce po przesuniętym fragmencie: w masce biel (widoczne), w pikselach przezroczystość
            tile.ctx.save();
            tile.ctx.globalCompositeOperation = 'destination-out';
            tile.ctx.drawImage(o.cutMask, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
            tile.ctx.restore();
            if (vacatedIsMask) {
              tile.ctx.save();
              tile.ctx.globalCompositeOperation = 'destination-over';
              tile.ctx.fillStyle = '#ffffff';
              // biel tylko pod wyciętym obszarem (maska wycinania jako kształt)
              const t2 = document.createElement('canvas');
              t2.width = tile.width;
              t2.height = tile.height;
              const c2 = t2.getContext('2d')!;
              c2.drawImage(o.cutMask, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
              c2.globalCompositeOperation = 'source-in';
              c2.fillStyle = '#ffffff';
              c2.fillRect(0, 0, tile.width, tile.height);
              tile.ctx.globalCompositeOperation = 'source-over';
              tile.ctx.drawImage(t2, 0, 0);
              tile.ctx.restore();
            }
            tile.ctx.drawImage(moved, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
            tile.hasContent = true;
            tile.isDirty = true;
          }
        }
        otherHist = { before: o.before, after: o.grid.getTilesSnapshot() };
      }
      layer.updateThumbnail();

      const tilesAfter = layer.tileGrid.getTilesSnapshot();
      const selectionAfter = this.selectionManager.getMaskSnapshot();

      this.pushTileAction({
        type: 'transformContent',
        description: 'Przekształcenie zawartości',
        layerIndex: sess.sourceLayerIndex,
        other: otherHist,
        tilesBefore: sess.initialTilesSnapshot,
        tilesAfter,
        selectionBefore: sess.initialSelectionSnapshot,
        selectionAfter,
      });
    }

    this.selectionManager.commitTransformSelection();
    this.transformContentSession = null;
    this.markAllLayersDirty();
    return true;
  }

  /** Czy ramka manipulacji zawartością jest w stanie początkowym (nic nie przesunięto, nie przeskalowano, nie obrócono). */
  public contentTransformIsIdentity(): boolean {
    const sess = this.transformContentSession;
    const st = this.selectionManager.transformState;
    if (!sess || !st || !sess.cutMask) return false;
    if (sess.contentChanged || sess.persp?.changed) return false;
    const e = 1e-6;
    return (
      Math.abs(st.pos.x - st.initialCenter.x) < e &&
      Math.abs(st.pos.y - st.initialCenter.y) < e &&
      Math.abs(st.width - st.initialBounds.width) < e &&
      Math.abs(st.height - st.initialBounds.height) < e &&
      Math.abs(st.angle) < e &&
      !st.flipX &&
      !st.flipY
    );
  }

  /**
   * Doprowadza warstwę do stanu zgodnego z ramką: w stanie początkowym warstwa jest nietknięta (podgląd = oryginał),
   * po pierwszej zmianie następuje wycięcie fragmentu (z miękkim brzegiem), a powrót do stanu początkowego je cofa.
   */
  /** Czy dwa zrzuty kafelków mają identyczne piksele (wczesne wyjście przy pierwszej różnicy). */
  private sameTiles(a: TileSnapshotLike[], b: TileSnapshotLike[]): boolean {
    const key = (t: TileSnapshotLike) => t.ty * 100000 + t.tx;
    const mb = new Map<number, TileSnapshotLike>();
    for (const t of b) mb.set(key(t), t);
    for (const t of a) {
      const o = mb.get(key(t));
      if (!o || t.hasContent !== o.hasContent) return false;
      if (!t.hasContent) continue;
      const x = t.imgData.data;
      const y = o.imgData.data;
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    }
    return true;
  }

  private restoreTiles(layer: Layer, snap: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[]): void {
    for (const t of snap) {
      const tile = layer.tileGrid.getTile(t.tx, t.ty);
      if (tile) {
        tile.ctx.putImageData(t.imgData, 0, 0);
        tile.hasContent = t.hasContent;
        tile.isDirty = true;
      }
    }
    layer.updateThumbnail();
  }

  public syncContentCut(): boolean {
    const sess = this.transformContentSession;
    if (!sess || !sess.cutMask) return false;
    const layer = this.layers[sess.sourceLayerIndex];
    if (!layer) return false;
    const identity = this.contentTransformIsIdentity();
    if (!identity && !sess.cutDone) {
      layer.clear(sess.cutMask);
      sess.cutDone = true;
      this.markAllLayersDirty();
      return true;
    } else if (identity && sess.cutDone) {
      this.restoreTiles(layer, sess.identityTiles ?? sess.initialTilesSnapshot);
      sess.cutDone = false;
      this.markAllLayersDirty();
      return true;
    }
    return false;
  }

  public cancelTransformContent(): boolean {
    if (!this.transformContentSession) return false;
    const sess = this.transformContentSession;
    const layer = this.layers[sess.sourceLayerIndex];
    if (layer) {
      for (const t of sess.initialTilesSnapshot) {
        const tile = layer.tileGrid.getTile(t.tx, t.ty);
        if (tile) {
          tile.ctx.putImageData(t.imgData, 0, 0);
          tile.hasContent = t.hasContent;
          tile.isDirty = true;
        }
      }
      layer.updateThumbnail();
    }
    this.selectionManager.restoreMaskSnapshot(sess.initialSelectionSnapshot);
    this.selectionManager.commitTransformSelection();
    this.transformContentSession = null;
    this.markAllLayersDirty();
    return true;
  }

  // --- SZYBKI PIPELINE KOMPOZYCJI Z DIRTY-RECT ---

  /** Wywoływane po każdej kompozycji do płótna widoku (dirty = zmieniony fragment dokumentu albo null = całość). */
  public onViewportComposited: ((target: HTMLCanvasElement, dirty: SKRectI | null) => void) | null = null;

  public compositeToViewport(
    targetCanvas: HTMLCanvasElement,
    dirtyRect?: SKRectI | null,
    previewPointA?: SKPoint | null,
    previewPointB?: SKPoint | null,
    previewShapeType?: string | null,
    previewBrushSettings?: BrushSettings | null,
    customPreviewRenderer?: ((ctx: CanvasRenderingContext2D) => void) | null,
    customPreviewBlendMode?: SKBlendMode | null
  ): void {
    const wasResized = targetCanvas.width !== this.width || targetCanvas.height !== this.height;
    this.compositeToViewportImpl(
      targetCanvas,
      dirtyRect,
      previewPointA,
      previewPointB,
      previewShapeType,
      previewBrushSettings,
      customPreviewRenderer,
      customPreviewBlendMode
    );
    const hook = this.onViewportComposited;
    if (hook) {
      const partial = !wasResized && !customPreviewRenderer && !!dirtyRect && dirtyRect.width > 0 && dirtyRect.height > 0;
      hook(targetCanvas, partial ? dirtyRect! : null);
    }
  }

  private compositeToViewportImpl(
    targetCanvas: HTMLCanvasElement,
    dirtyRect?: SKRectI | null,
    previewPointA?: SKPoint | null,
    previewPointB?: SKPoint | null,
    previewShapeType?: string | null,
    previewBrushSettings?: BrushSettings | null,
    customPreviewRenderer?: ((ctx: CanvasRenderingContext2D) => void) | null,
    customPreviewBlendMode?: SKBlendMode | null
  ): void {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx) return;

    if (targetCanvas.width !== this.width || targetCanvas.height !== this.height) {
      targetCanvas.width = this.width;
      targetCanvas.height = this.height;
      dirtyRect = null;
    }

    // wycięcie fragmentu z warstwy następuje dopiero po pierwszej zmianie ramki (patrz syncContentCut)
    if (this.transformContentSession && this.syncContentCut()) dirtyRect = null;

    if (customPreviewRenderer) {
      dirtyRect = null;
    }

    const isDrawingLive = this.brushEngine.isDrawing && (!!this.brushEngine.activeBrushSettings || !!this.brushEngine.activeStampSettings);

    // SZYBKI DIRTY-RECT PODCZAS RYSOWANIA
    if (dirtyRect && dirtyRect.width > 0 && dirtyRect.height > 0) {
      const clipLeft = Math.max(0, dirtyRect.left);
      const clipTop = Math.max(0, dirtyRect.top);
      const clipRight = Math.min(this.width, dirtyRect.right);
      const clipBottom = Math.min(this.height, dirtyRect.bottom);
      const clipW = clipRight - clipLeft;
      const clipH = clipBottom - clipTop;

      if (clipW > 0 && clipH > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(clipLeft, clipTop, clipW, clipH);
        ctx.clip();

        ctx.clearRect(clipLeft, clipTop, clipW, clipH);

        const rLayers = this.renderLayers;
        const rActive = this.renderActiveIndex;
        const iso = this.renderIsolation;
        // cel rysowania: płótno dokumentu albo (w izolowanej grupie) jej osobny bufor
        let tgt: CanvasRenderingContext2D = ctx;
        const passSnaps = new Map<string, HTMLCanvasElement>();
        for (let i = 0; i < rLayers.length; i++) {
          const layer = rLayers[i];
          // grupa „Przepuszczanie” z krytem / maską: tło przed grupą i domknięcie po jej warstwach
          const psG = this.renderPassStartAt(i);
          if (psG) passSnaps.set(psG.id, this.passSnapshot(ctx, clipLeft, clipTop, clipW, clipH));
          const peG = this.renderPassEndAt(i);
          if (peG) {
            const sn = passSnaps.get(peG.id);
            if (sn && peG.ownVisible) this.passFinish(ctx, sn, peG, clipLeft, clipTop, clipW, clipH);
            continue;
          }
          if (iso && i === iso.start) {
            const gs = this.getGroupScratch();
            gs.ctx.clearRect(clipLeft, clipTop, clipW, clipH);
            tgt = gs.ctx;
          }
          if (iso && i === iso.header) {
            tgt = ctx;
            if (iso.group.ownVisible && iso.group.opacity > 0) {
              this.flushIsolatedGroup(ctx, iso.group, this.getGroupScratch().canvas, clipLeft, clipTop, clipW, clipH);
            }
            continue;
          }
          if (!layer.visible || layer.opacity <= 0) continue;

          const affectedTiles = layer.pixelGrid.getTilesIntersectingRect(dirtyRect);
          if (affectedTiles.length === 0) continue;

          if (i !== rActive || !isDrawingLive) {
            tgt.save();
            tgt.globalAlpha = layer.opacity;
            tgt.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);

            for (const tile of affectedTiles) {
              if (tile.hasContent || layer.grayView) {
                const rc = layer.renderCanvas(tile);
                if (rc) tgt.drawImage(rc, tile.pixelX, tile.pixelY);
              }
            }
            tgt.restore();
          } else {
            // Aktywna warstwa podczas rysowania pędzlem na żywo
            const { canvas: scratch, ctx: sctx } = this.getDirtyScratch(clipW, clipH);
            sctx.clearRect(0, 0, clipW, clipH);

            // 1. Narysuj oryginalne kafelki celu edycji aktywnej warstwy (piksele albo maska)
            const editTiles = layer.tileGrid === layer.pixelGrid ? affectedTiles : layer.tileGrid.getTilesIntersectingRect(dirtyRect);
            for (const tile of editTiles) {
              if (tile.hasContent) {
                sctx.drawImage(tile.canvas, tile.pixelX - clipLeft, tile.pixelY - clipTop);
              }
            }

            const isStamp = !!this.brushEngine.activeStampSettings;
            const bSettings = isStamp ? this.brushEngine.activeStampSettings! : this.brushEngine.activeBrushSettings!;
            const brushBlend = this.brushEngine.isEraser ? 'Clear' : bSettings.blendMode;
            const brushAlpha = isStamp
              ? this.brushEngine.activeStampAlpha
              : ('color' in bSettings ? bSettings.color.a / 255 : 1.0);

            // 2. Jeśli aktywne jest zaznaczenie, zamaskuj TYLKO pędzel (nie wymazując warstwy)
            if (!this.selectionManager.hasActiveSelection) {
              sctx.save();
              sctx.globalAlpha = brushAlpha;
              sctx.globalCompositeOperation = getCanvasCompositeOperation(brushBlend);
              sctx.drawImage(
                this.brushEngine.strokeCanvas,
                clipLeft, clipTop, clipW, clipH,
                0, 0, clipW, clipH
              );
              sctx.restore();
            } else {
              // Bufor wielokrotnego użytku (alokacja płótna na każde pociągnięcie powodowała zacięcia przy zaznaczeniu)
              const { canvas: brushScratch, ctx: bsCtx } = this.getBrushMaskScratch(clipW, clipH);
              bsCtx.globalCompositeOperation = 'source-over';
              bsCtx.clearRect(0, 0, clipW, clipH);

              bsCtx.drawImage(
                this.brushEngine.strokeCanvas,
                clipLeft, clipTop, clipW, clipH,
                0, 0, clipW, clipH
              );
              bsCtx.globalCompositeOperation = 'destination-in';
              bsCtx.drawImage(
                this.selectionManager.maskCanvas,
                clipLeft, clipTop, clipW, clipH,
                0, 0, clipW, clipH
              );

              sctx.save();
              sctx.globalAlpha = brushAlpha;
              sctx.globalCompositeOperation = getCanvasCompositeOperation(brushBlend);
              sctx.drawImage(brushScratch, 0, 0, clipW, clipH, 0, 0, clipW, clipH);
              sctx.restore();
            }

            // 3. Połącz aktywną warstwę z płótnem dokumentu (przy edycji maski: piksele warstwy zamaskowane podglądem maski)
            const liveSrc = this.brushEngine.stampDualCanvas && layer.maskGrid && !layer.grayView
              ? this.composeLinkedStampLive(layer, clipLeft, clipTop, clipW, clipH)
              : layer.editMask && layer.maskGrid && layer !== null && !layer.grayView
              ? layer.composeWithMaskRegion(scratch, clipLeft, clipTop, clipW, clipH)
              : (layer.maskGrid && !layer.editMask && !layer.grayView
                ? layer.applyMaskToRegion(scratch, clipLeft, clipTop, clipW, clipH)
                : scratch);
            tgt.save();
            tgt.globalAlpha = layer.opacity;
            tgt.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
            tgt.drawImage(liveSrc, 0, 0, clipW, clipH, clipLeft, clipTop, clipW, clipH);
            tgt.restore();
          }
        }

        ctx.restore();
        this.lastDirtyRect = dirtyRect;
        return;
      }
    }

    // PEŁNE PRZERYSOWANIE
    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);

    const rLayersF = this.renderLayers;
    const rActiveF = this.renderActiveIndex;
    const isoF = this.renderIsolation;
    // cel rysowania: płótno dokumentu albo (w izolowanej grupie) jej osobny bufor
    let tgt: CanvasRenderingContext2D = ctx;
    const passSnapsF = new Map<string, HTMLCanvasElement>();
    for (let i = 0; i < rLayersF.length; i++) {
      const layer = rLayersF[i];
      const psF = this.renderPassStartAt(i);
      if (psF) passSnapsF.set(psF.id, this.passSnapshot(ctx, 0, 0, this.width, this.height));
      const peF = this.renderPassEndAt(i);
      if (peF) {
        const sn = passSnapsF.get(peF.id);
        if (sn && peF.ownVisible) this.passFinish(ctx, sn, peF, 0, 0, this.width, this.height);
        continue;
      }
      if (isoF && i === isoF.start) {
        const gs = this.getGroupScratch();
        gs.ctx.clearRect(0, 0, this.width, this.height);
        tgt = gs.ctx;
      }
      if (isoF && i === isoF.header) {
        tgt = ctx;
        if (isoF.group.ownVisible && isoF.group.opacity > 0) {
          this.flushIsolatedGroup(ctx, isoF.group, this.getGroupScratch().canvas, 0, 0, this.width, this.height);
        }
        continue;
      }
      if (!layer.visible || layer.opacity <= 0) continue;

      const isLiveBrushActive = (i === rActiveF && isDrawingLive && (!!this.brushEngine.activeBrushSettings || !!this.brushEngine.activeStampSettings));
      const isCustomPreviewActive = (i === rActiveF && !!customPreviewRenderer);

      if (!isLiveBrushActive && !isCustomPreviewActive) {
        tgt.save();
        tgt.globalAlpha = layer.opacity;
        tgt.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.drawRenderedToContext(tgt);
        tgt.restore();
      } else if (isLiveBrushActive) {
        // Aktywna warstwa podczas aktywnego rysowania na żywo w pełnym przerysowaniu
        const activeFlat = layer.tileGrid.compositeToFlatCanvas();
        const afCtx = activeFlat.getContext('2d')!;

        const isStamp = !!this.brushEngine.activeStampSettings;
        const bSettings = isStamp ? this.brushEngine.activeStampSettings! : this.brushEngine.activeBrushSettings!;
        const brushBlend = this.brushEngine.isEraser ? 'Clear' : bSettings.blendMode;
        const brushAlpha = isStamp
          ? this.brushEngine.activeStampAlpha
          : ('color' in bSettings ? bSettings.color.a / 255 : 1.0);

        if (!this.selectionManager.hasActiveSelection) {
          afCtx.save();
          afCtx.globalAlpha = brushAlpha;
          afCtx.globalCompositeOperation = getCanvasCompositeOperation(brushBlend);
          afCtx.drawImage(this.brushEngine.strokeCanvas, 0, 0);
          afCtx.restore();
        } else {
          const brushScratch = document.createElement('canvas');
          brushScratch.width = this.width;
          brushScratch.height = this.height;
          const bsCtx = brushScratch.getContext('2d')!;

          bsCtx.drawImage(this.brushEngine.strokeCanvas, 0, 0);
          bsCtx.globalCompositeOperation = 'destination-in';
          bsCtx.drawImage(this.selectionManager.maskCanvas, 0, 0);

          afCtx.save();
          afCtx.globalAlpha = brushAlpha;
          afCtx.globalCompositeOperation = getCanvasCompositeOperation(brushBlend);
          afCtx.drawImage(brushScratch, 0, 0);
          afCtx.restore();
        }

        const liveFlat = this.brushEngine.stampDualCanvas && layer.maskGrid && !layer.grayView
          ? this.composeLinkedStampLive(layer, 0, 0, this.width, this.height)
          : layer.editMask && layer.maskGrid && !layer.grayView
          ? layer.composeWithMaskRegion(activeFlat, 0, 0, this.width, this.height)
          : (layer.maskGrid && !layer.editMask && !layer.grayView
            ? layer.applyMaskToRegion(activeFlat, 0, 0, this.width, this.height)
            : activeFlat);
        tgt.save();
        tgt.globalAlpha = layer.opacity;
        tgt.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        tgt.drawImage(liveFlat, 0, 0);
        tgt.restore();
      } else if (isCustomPreviewActive) {
        // Aktywna warstwa podczas podglądu narzędzi wektorowych (linie, krzywe, figury)
        const activeFlat = layer.tileGrid.compositeToFlatCanvas();
        const afCtx = activeFlat.getContext('2d')!;

        const { canvas: vScratch, ctx: vsCtx } = this.getVectorScratch(this.width, this.height);
        vsCtx.clearRect(0, 0, this.width, this.height);

        // 1. Renderujemy kształt wektorowy do odizolowanego bufora podglądu
        customPreviewRenderer(vsCtx);

        // 2. Jeśli aktywne jest zaznaczenie, maskujemy kształt przed nałożeniem na warstwę
        if (this.selectionManager.hasActiveSelection) {
          vsCtx.save();
          vsCtx.globalCompositeOperation = 'destination-in';
          vsCtx.drawImage(this.selectionManager.maskCanvas, 0, 0);
          vsCtx.restore();
        }

        // 3. Nakładamy kształt na aktywną warstwę z uwzględnieniem trybu mieszania narzędzia
        const blendOp = getCanvasCompositeOperation(customPreviewBlendMode || 'SrcOver');
        afCtx.save();
        afCtx.globalCompositeOperation = blendOp;
        afCtx.drawImage(vScratch, 0, 0);
        afCtx.restore();

        // 4. Rysujemy aktywną warstwę z nałożonym kształtem na płótno dokumentu zgodnie z kryciem i trybem warstwy
        const customFlat = layer.editMask && layer.maskGrid && !layer.grayView
          ? layer.composeWithMaskRegion(activeFlat, 0, 0, this.width, this.height)
          : activeFlat;
        tgt.save();
        tgt.globalAlpha = layer.opacity;
        tgt.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        tgt.drawImage(customFlat, 0, 0);
        tgt.restore();
      }

      // Pływająca zawartość podczas aktywnej sesji przekształcania zawartości (SZYBKIE HARDWARE-ACCELERATED RENDEROWANIE CROP TEXTURE)
      if (
        !this.floatingContentExternal &&
        !this.contentTransformIsIdentity() &&
        this.transformContentSession &&
        this.transformContentSession.sourceLayerIndex === this.realLayerIndex(i) &&
        this.selectionManager.transformState
      ) {
        const st = this.selectionManager.transformState;
        const sess = this.transformContentSession;

        if (sess.persp) {
          const pv = this.getPerspectivePreview();
          if (pv) drawPerspectivePreview(tgt, pv, sess.interpolation !== 'nearest-neighbor');
          continue;
        }

        tgt.save();
        tgt.translate(st.pos.x, st.pos.y);
        tgt.rotate(st.angle);
        const scaleXMult = st.flipX ? -1 : 1;
        const scaleYMult = st.flipY ? -1 : 1;
        const sx = (st.width / Math.max(1, st.initialBounds.width)) * scaleXMult;
        const sy = (st.height / Math.max(1, st.initialBounds.height)) * scaleYMult;
        tgt.scale(sx, sy);

        if (sess.interpolation === 'nearest-neighbor') {
          tgt.imageSmoothingEnabled = false;
        } else if (sess.interpolation === 'bilinear') {
          tgt.imageSmoothingEnabled = true;
          tgt.imageSmoothingQuality = 'medium';
        } else {
          tgt.imageSmoothingEnabled = true;
          tgt.imageSmoothingQuality = 'high';
        }

        tgt.drawImage(
          sess.previewCanvas ?? sess.sourceContentCanvas,
          -st.initialBounds.width / 2,
          -st.initialBounds.height / 2
        );
        tgt.restore();
      }
    }

    if (previewPointA && previewPointB && previewShapeType && previewBrushSettings) {
      this.renderShapePreview(ctx, previewPointA, previewPointB, previewShapeType, previewBrushSettings);
    }

    ctx.restore();
    this.lastDirtyRect = null;
  }

  public commitVectorLine(
    p0: SKPoint,
    p1: SKPoint,
    settings: LineAndCurveSettings
  ): void {
    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tctx = tempCanvas.getContext('2d');
    if (!tctx) return;

    renderVectorLine(tctx, p0, p1, { ...settings, blendMode: 'SrcOver' });

    if (this.selectionManager.hasActiveSelection) {
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
      tctx.restore();
    }

    const pad = Math.max(20, settings.strokeWidth * (settings.markerSize || 1.0) * 4 + 20);
    const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x) - pad));
    const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y) - pad));
    const maxX = Math.min(this.width, Math.ceil(Math.max(p0.x, p1.x) + pad));
    const maxY = Math.min(this.height, Math.ceil(Math.max(p0.y, p1.y) + pad));

    const dirtyRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };

    this.bakeCanvasToLayer(layer, tempCanvas, dirtyRect, 'Linia', settings.blendMode);
  }

  public commitVectorPath(nodes: PenNode[], closed: boolean, settings: LineAndCurveSettings): void {
    if (nodes.length < 2) return;
    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tctx = tempCanvas.getContext('2d');
    if (!tctx) return;

    renderVectorPath(tctx, nodes, closed, { ...settings, blendMode: 'SrcOver' });

    if (this.selectionManager.hasActiveSelection) {
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
      tctx.restore();
    }

    const pts = penAllPoints(nodes);
    const pad = Math.max(20, settings.strokeWidth * (settings.markerSize || 1.0) * 4 + 20);
    const minX = Math.max(0, Math.floor(Math.min(...pts.map((q) => q.x)) - pad));
    const minY = Math.max(0, Math.floor(Math.min(...pts.map((q) => q.y)) - pad));
    const maxX = Math.min(this.width, Math.ceil(Math.max(...pts.map((q) => q.x)) + pad));
    const maxY = Math.min(this.height, Math.ceil(Math.max(...pts.map((q) => q.y)) + pad));

    const dirtyRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };

    this.bakeCanvasToLayer(layer, tempCanvas, dirtyRect, 'Krzywa Beziera', settings.blendMode);
  }

  public commitVectorShape(
    center: SKPoint,
    width: number,
    height: number,
    angle: number,
    settings: VectorShapeSettings,
    flipX: boolean = false,
    flipY: boolean = false
  ): void {
    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tctx = tempCanvas.getContext('2d');
    if (!tctx) return;

    renderVectorShape(tctx, center, width, height, angle, { ...settings, blendMode: 'SrcOver' }, flipX, flipY);

    if (this.selectionManager.hasActiveSelection) {
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
      tctx.restore();
    }

    const diag = Math.hypot(width, height) / 2;
    const pad = Math.max(10, settings.strokeWidth * 2 + 10);
    const minX = Math.max(0, Math.floor(center.x - diag - pad));
    const minY = Math.max(0, Math.floor(center.y - diag - pad));
    const maxX = Math.min(this.width, Math.ceil(center.x + diag + pad));
    const maxY = Math.min(this.height, Math.ceil(center.y + diag + pad));

    const dirtyRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };

    this.bakeCanvasToLayer(layer, tempCanvas, dirtyRect, 'Figura', settings.blendMode);
  }

  public commitVectorText(
    center: SKPoint,
    width: number,
    height: number,
    angle: number,
    rt: RichText,
    settings: TextToolSettings,
    fallbackStyle?: TextCharStyle
  ): void {
    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return;
    if (rt.length === 0) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tctx = tempCanvas.getContext('2d');
    if (!tctx) return;

    const res = renderVectorText(tctx, center, width, height, angle, rt, settings, undefined, fallbackStyle);

    if (this.selectionManager.hasActiveSelection) {
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
      tctx.restore();
    }

    const diag = Math.hypot(Math.max(width, res.extentWidth), Math.max(height, res.extentHeight)) / 2;
    const pad = Math.max(10, settings.strokeWidth * 2 + 10);
    const minX = Math.max(0, Math.floor(center.x - diag - pad));
    const minY = Math.max(0, Math.floor(center.y - diag - pad));
    const maxX = Math.min(this.width, Math.ceil(center.x + diag + pad));
    const maxY = Math.min(this.height, Math.ceil(center.y + diag + pad));

    const dirtyRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
    };

    this.bakeCanvasToLayer(layer, tempCanvas, dirtyRect, 'Tekst', settings.blendMode);
  }

  private bakeCanvasToLayer(
    layer: Layer,
    sourceCanvas: HTMLCanvasElement,
    dirtyRect: SKRectI,
    actionDesc: string,
    blendMode: SKBlendMode = 'SrcOver'
  ): void {
    if (dirtyRect.width <= 0 || dirtyRect.height <= 0) return;

    const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirtyRect);
    const beforeTiles = affectedTiles.map((t) => ({
      tx: t.tileX,
      ty: t.tileY,
      imgData: t.ctx.getImageData(0, 0, t.width, t.height),
      hasContent: t.hasContent,
    }));

    const compOp = getCanvasCompositeOperation(blendMode);

    for (const tile of affectedTiles) {
      tile.ctx.save();
      tile.ctx.globalCompositeOperation = compOp;
      tile.ctx.drawImage(
        sourceCanvas,
        tile.pixelX, tile.pixelY, tile.width, tile.height,
        0, 0, tile.width, tile.height
      );
      tile.ctx.restore();
      tile.hasContent = true;
      tile.isDirty = true;
    }

    const afterTiles = affectedTiles.map((t) => ({
      tx: t.tileX,
      ty: t.tileY,
      imgData: t.ctx.getImageData(0, 0, t.width, t.height),
      hasContent: t.hasContent,
    }));

    this.pushTileAction({
      type: 'tiles',
      description: actionDesc,
      layerIndex: this.activeLayerIndex,
      before: beforeTiles,
      after: afterTiles,
    });

    layer.updateThumbnail();
    this.markAllLayersDirty();
  }

  private renderShapePreview(
    ctx: CanvasRenderingContext2D,
    p0: SKPoint,
    p1: SKPoint,
    shapeType: string,
    settings: BrushSettings
  ): void {
    ctx.save();
    ctx.strokeStyle = `rgba(${settings.color.r}, ${settings.color.g}, ${settings.color.b}, ${settings.color.a / 255})`;
    ctx.lineWidth = Math.max(1, settings.size);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const minX = Math.min(p0.x, p1.x);
    const minY = Math.min(p0.y, p1.y);
    const w = Math.abs(p1.x - p0.x);
    const h = Math.abs(p1.y - p0.y);

    if (shapeType === 'rect') {
      ctx.strokeRect(minX, minY, w, h);
    } else if (shapeType === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(minX + w / 2, minY + h / 2, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (shapeType === 'line') {
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  public commitShape(
    p0: SKPoint,
    p1: SKPoint,
    shapeType: string,
    settings: BrushSettings
  ): void {
    const layer = this.getActiveLayer();
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tctx = tempCanvas.getContext('2d');
    if (!tctx) return;

    this.renderShapePreview(tctx, p0, p1, shapeType, settings);

    if (this.selectionManager.hasActiveSelection) {
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
      tctx.restore();
    }

    const radius = settings.size;
    const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x) - radius));
    const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y) - radius));
    const maxX = Math.min(this.width, Math.ceil(Math.max(p0.x, p1.x) + radius));
    const maxY = Math.min(this.height, Math.ceil(Math.max(p0.y, p1.y) + radius));

    const dirtyRect: SKRectI = {
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: maxX - minX,
      height: maxY - minY,
    };

    const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirtyRect);
    const beforeTiles = affectedTiles.map((t) => ({
      tx: t.tileX,
      ty: t.tileY,
      imgData: t.ctx.getImageData(0, 0, t.width, t.height),
      hasContent: t.hasContent,
    }));

    for (const tile of affectedTiles) {
      tile.ctx.drawImage(
        tempCanvas,
        tile.pixelX, tile.pixelY, tile.width, tile.height,
        0, 0, tile.width, tile.height
      );
      tile.hasContent = true;
      tile.isDirty = true;
    }

    const afterTiles = affectedTiles.map((t) => ({
      tx: t.tileX,
      ty: t.tileY,
      imgData: t.ctx.getImageData(0, 0, t.width, t.height),
      hasContent: t.hasContent,
    }));

    this.pushTileAction({
      type: 'tiles',
      description: shapeType,
      layerIndex: this.activeLayerIndex,
      before: beforeTiles,
      after: afterTiles,
    });

    layer.updateThumbnail();
  }

  /** Podgląd na żywo połączonego klonowania: piksele + maska z naniesionymi śladami pieczątki, maska zastosowana. */
  private composeLinkedStampLive(layer: Layer, x: number, y: number, w: number, h: number): HTMLCanvasElement {
    const be = this.brushEngine;
    const pxStroke = layer.editMask ? be.stampDualCanvas! : be.strokeCanvas;
    const mkStroke = layer.editMask ? be.strokeCanvas : be.stampDualCanvas!;
    const alpha = be.activeStampAlpha;
    const sel = this.selectionManager.hasActiveSelection ? this.selectionManager.maskCanvas : null;
    const overlay = (ctx: CanvasRenderingContext2D, stroke: HTMLCanvasElement) => {
      let src: HTMLCanvasElement = stroke;
      if (sel) {
        const t = document.createElement('canvas');
        t.width = w; t.height = h;
        const tc = t.getContext('2d')!;
        tc.drawImage(stroke, x, y, w, h, 0, 0, w, h);
        tc.globalCompositeOperation = 'destination-in';
        tc.drawImage(sel, x, y, w, h, 0, 0, w, h);
        src = t;
        ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(src, 0, 0); ctx.restore();
        return;
      }
      ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(src, x, y, w, h, 0, 0, w, h); ctx.restore();
    };
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const octx = out.getContext('2d')!;
    layer.pixelGrid.drawCroppedToContext(octx, x, y, w, h);
    overlay(octx, pxStroke);
    if (!layer.maskEnabled) return out;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d', { willReadFrequently: true })!;
    tctx.fillStyle = '#fff';
    tctx.fillRect(0, 0, w, h);
    layer.maskGrid!.drawCroppedToContext(tctx, x, y, w, h);
    overlay(tctx, mkStroke);
    const img = tctx.getImageData(0, 0, w, h);
    grayToAlpha(img.data);
    tctx.putImageData(img, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(tmp, 0, 0);
    octx.globalCompositeOperation = 'source-over';
    return out;
  }

  public drawCroppedComposite(
    ctx: CanvasRenderingContext2D,
    cropX: number,
    cropY: number,
    cropWidth: number,
    cropHeight: number,
    sampleSource: StampSampleSource = 'image'
  ): void {
    if (sampleSource === 'layer') {
      const layer = this.getActiveLayer();
      if (layer) {
        // Źródło "warstwa" = aktualny cel edycji: surowe piksele warstwy (bez maski) albo maska w skali szarości
        ctx.save();
        if (layer.editMask && layer.maskGrid) {
          ctx.fillStyle = '#fff'; // brakujące kafelki maski = w pełni widoczne
          ctx.fillRect(0, 0, cropWidth, cropHeight);
        }
        layer.tileGrid.drawCroppedToContext(ctx, cropX, cropY, cropWidth, cropHeight);
        ctx.restore();
      }
    } else {
      this.drawLayersCropped(ctx, cropX, cropY, cropWidth, cropHeight);
    }
  }

  public pickColor(
    x: number,
    y: number,
    sampleSource: 'image' | 'layer' = 'image',
    sampleDiameter: number = 1
  ): SKColor {
    const docX = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    const docY = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    const diameter = Math.max(1, Math.round(sampleDiameter));

    // Promień koła próbkowania
    const radius = (diameter - 1) / 2;
    const minX = Math.max(0, Math.floor(docX - radius));
    const maxX = Math.min(this.width - 1, Math.ceil(docX + radius));
    const minY = Math.max(0, Math.floor(docY - radius));
    const maxY = Math.min(this.height - 1, Math.ceil(docY + radius));
    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cropW;
    tempCanvas.height = cropH;
    const ctx = tempCanvas.getContext('2d');
    if (!ctx) return { r: 0, g: 0, b: 0, a: 255 };

    if (sampleSource === 'layer') {
      const layer = this.getActiveLayer();
      if (layer && layer.visible && layer.opacity > 0) {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        layer.drawRenderedCropped(ctx, minX, minY, cropW, cropH);
        ctx.restore();
      }
    } else {
      this.drawLayersCropped(ctx, minX, minY, cropW, cropH);
    }

    const imgData = ctx.getImageData(0, 0, cropW, cropH).data;

    if (diameter <= 1) {
      const idx = ((docY - minY) * cropW + (docX - minX)) * 4;
      return {
        r: imgData[idx],
        g: imgData[idx + 1],
        b: imgData[idx + 2],
        a: imgData[idx + 3],
      };
    }

    let totalR = 0;
    let totalG = 0;
    let totalB = 0;
    let totalA = 0;
    let count = 0;
    const rSq = radius * radius;

    for (let py = minY; py <= maxY; py++) {
      const dy = py - docY;
      for (let px = minX; px <= maxX; px++) {
        const dx = px - docX;
        // Sprawdź czy piksel leży wewnątrz okręgu o podanej średnicy
        if (dx * dx + dy * dy > rSq) continue;

        const idx = ((py - minY) * cropW + (px - minX)) * 4;
        const r = imgData[idx];
        const g = imgData[idx + 1];
        const b = imgData[idx + 2];
        const a = imgData[idx + 3];

        if (a > 0) {
          totalR += r * a;
          totalG += g * a;
          totalB += b * a;
          totalA += a;
          count++;
        }
      }
    }

    if (totalA > 0) {
      return {
        r: Math.round(totalR / totalA),
        g: Math.round(totalG / totalA),
        b: Math.round(totalB / totalA),
        a: Math.round(totalA / count),
      };
    }

    return { r: 0, g: 0, b: 0, a: 0 };
  }

  /**
   * Zwraca wycięty fragment obrazu lub aktywnej warstwy wokół danego punktu (dla lupy / przybliżenia)
   */
  public getLoupeSampleCanvas(
    docX: number,
    docY: number,
    boxSize: number = 21,
    sampleSource: 'image' | 'layer' = 'image'
  ): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = boxSize;
    canvas.height = boxSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    const half = Math.floor(boxSize / 2);
    const cropX = Math.round(docX) - half;
    const cropY = Math.round(docY) - half;

    // Rysuj szachownicę przeźroczystości dla pikseli tła w lupie
    const checkSize = 2;
    for (let cy = 0; cy < boxSize; cy += checkSize) {
      for (let cx = 0; cx < boxSize; cx += checkSize) {
        ctx.fillStyle = ((cx / checkSize + cy / checkSize) % 2 === 0) ? '#ffffff' : '#dcdcdc';
        ctx.fillRect(cx, cy, checkSize, checkSize);
      }
    }

    if (sampleSource === 'layer') {
      const layer = this.getActiveLayer();
      if (layer && layer.visible && layer.opacity > 0) {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        layer.drawRenderedCropped(ctx, cropX, cropY, boxSize, boxSize);
        ctx.restore();
      }
    } else {
      this.drawLayersCropped(ctx, cropX, cropY, boxSize, boxSize);
    }

    return canvas;
  }

  public getCompositeFlatCanvas(): HTMLCanvasElement {
    if (this.gradientPreview) this.commitGradientSession();
    if (this.bucketSeedPoint && !this.fillSampling) this.commitPaintBucketSession();
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    this.drawLayersCropped(ctx, 0, 0, this.width, this.height);

    return canvas;
  }

  public saveToFigFile(): string {
    if (this.gradientPreview) this.commitGradientSession();
    if (this.bucketSeedPoint) this.commitPaintBucketSession();
    const project: FiguraProjectFile = {
      format: 'FIGURA_PROJECT',
      version: '1.0',
      title: this.title.endsWith('.fig') ? this.title : `${this.title.replace(/\.[^/.]+$/, '')}.fig`,
      width: this.width,
      height: this.height,
      tileSize: this.tileSize,
      activeLayerIndex: this.activeLayerIndex,
      layers: this.layers.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.ownVisible,
        locked: l.ownLocked || undefined,
        isGroup: l.isGroup || undefined,
        groupId: l.groupId,
        expanded: l.isGroup ? l.expanded : undefined,
        opacity: l.opacity,
        blendMode: l.blendMode,
        dataUrl: l.isGroup ? '' : l.pixelGrid.compositeToFlatCanvas().toDataURL('image/png'),
        maskDataUrl: l.maskGrid ? l.maskGrid.compositeToFlatCanvas().toDataURL('image/png') : undefined,
        maskEnabled: l.maskGrid ? l.maskEnabled : undefined,
        maskLinked: l.maskGrid ? l.maskLinked : undefined,
      })),
    };
    return JSON.stringify(project, null, 2);
  }

  public async loadFromFigFile(jsonContent: string): Promise<boolean> {
    try {
      const data = JSON.parse(jsonContent);
      if (data.format !== 'FIGURA_PROJECT' && !data.layers) {
        return false;
      }

      this.title = data.title || 'obraz1.fig';
      this.width = data.width || 800;
      this.height = data.height || 600;
      this.tileSize = data.tileSize || DEFAULT_TILE_SIZE;
      this.brushEngine.ensureBufferSize(this.width, this.height);
      this.selectionManager.resize(this.width, this.height);

      const loadedLayers: Layer[] = [];

      for (const lData of data.layers) {
        const isGroupData = lData.isGroup === true;
        const layer = new Layer(
          lData.id || `layer_${Date.now()}`,
          lData.name || (isGroupData ? 'Grupa' : 'Warstwa'),
          this.width,
          this.height,
          this.tileSize
        );
        layer.isGroup = isGroupData;
        layer.groupId = typeof lData.groupId === 'string' ? lData.groupId : null;
        layer.expanded = lData.expanded !== false;
        layer.locked = lData.locked === true;
        layer.visible = lData.visible !== false;
        layer.opacity = typeof lData.opacity === 'number' ? lData.opacity : 1.0;
        layer.blendMode = lData.blendMode || 'SrcOver';
        // grupy z plików sprzed trybu „Przepuszczanie”: Normalne, bez krycia i maski = zwykłe przepuszczanie
        if (isGroupData && (!lData.blendMode || (lData.blendMode === 'SrcOver' && layer.opacity >= 1 && !lData.maskDataUrl))) {
          layer.blendMode = 'PassThrough';
        }

        if (lData.dataUrl) {
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              const tempCanvas = document.createElement('canvas');
              tempCanvas.width = this.width;
              tempCanvas.height = this.height;
              const tctx = tempCanvas.getContext('2d');
              if (tctx) {
                tctx.drawImage(img, 0, 0);
                for (let ty = 0; ty < layer.tileGrid.rows; ty++) {
                  for (let tx = 0; tx < layer.tileGrid.cols; tx++) {
                    const tile = layer.tileGrid.tiles[ty][tx];
                    tile.ctx.drawImage(
                      tempCanvas,
                      tile.pixelX, tile.pixelY, tile.width, tile.height,
                      0, 0, tile.width, tile.height
                    );
                    tile.hasContent = true;
                    tile.isDirty = true;
                  }
                }
              }
              layer.updateThumbnail();
              resolve();
            };
            img.onerror = () => resolve();
            img.src = lData.dataUrl;
          });
        }

        if (lData.maskDataUrl) {
          await new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              layer.createMask(null, this.width, this.height);
              layer.editMask = false;
              const mg = layer.maskGrid!;
              for (const row of mg.tiles) {
                for (const tile of row) {
                  tile.ctx.clearRect(0, 0, tile.width, tile.height);
                  tile.ctx.drawImage(img, tile.pixelX, tile.pixelY, tile.width, tile.height, 0, 0, tile.width, tile.height);
                  tile.hasContent = true;
                  tile.isDirty = true;
                }
              }
              layer.maskEnabled = lData.maskEnabled !== false;
              layer.maskLinked = lData.maskLinked !== false;
              layer.updateThumbnail();
              resolve();
            };
            img.onerror = () => resolve();
            img.src = lData.maskDataUrl;
          });
        }

        loadedLayers.push(layer);
      }
      this.maskView = null;

      this.layers = loadedLayers.length > 0 ? loadedLayers : this.layers;
      this.activeLayerIndex = Math.min(data.activeLayerIndex || 0, this.layers.length - 1);
      this.normalizeLayers(this.layers[this.activeLayerIndex]);
      this.clearHistory();
      this.markAllLayersDirty();
      return true;
    } catch {
      return false;
    }
  }

  public exportPng(): string {
    return this.getCompositeFlatCanvas().toDataURL('image/png');
  }

  public exportJpeg(quality: number = 0.92): string {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.drawImage(this.getCompositeFlatCanvas(), 0, 0);
    }
    return canvas.toDataURL('image/jpeg', quality);
  }

  public importImage(img: HTMLImageElement, layerName: string = 'Zaimportowany obraz'): void {
    this.saveFullSnapshot('Zaimportowanie obrazu');
    const layer = new Layer(`layer_${Date.now()}`, layerName, this.width, this.height, this.tileSize);

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tctx = tempCanvas.getContext('2d');
    if (tctx) {
      tctx.drawImage(img, 0, 0, Math.min(img.width, this.width), Math.min(img.height, this.height));

      for (let ty = 0; ty < layer.tileGrid.rows; ty++) {
        for (let tx = 0; tx < layer.tileGrid.cols; tx++) {
          const tile = layer.tileGrid.tiles[ty][tx];
          tile.ctx.drawImage(
            tempCanvas,
            tile.pixelX, tile.pixelY, tile.width, tile.height,
            0, 0, tile.width, tile.height
          );
          tile.hasContent = true;
          tile.isDirty = true;
        }
      }
    }

    layer.updateThumbnail();
    this.layers.push(layer);
    this.activeLayerIndex = this.layers.length - 1;
    this.markAllLayersDirty();
  }
}
