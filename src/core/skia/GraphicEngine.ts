/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { PenNode, penAllPoints } from './PenPath.ts';
import { Layer, grayToAlpha } from './Layer.ts';
import { Quad, drawPerspectiveMesh, isConvexQuad, warpPerspectiveExact, WarpResult } from './Perspective.ts';
import { renderGradientPreview } from './GradientRenderer.ts';
import { BrushEngine } from './BrushEngine.ts';
import { SelectionManager, SelectionSnapshot } from './SelectionManager.ts';
import { getTileEpoch } from './Tile.ts';
import { FillClient } from './FillClient.ts';
import { BucketAlpha, bucketAlphaOfFlood, floodSelect } from './WandCore.ts';
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
  /** Tryb perspektywy: aktualny czworokąt (lewy-górny, prawy-górny, prawy-dolny, lewy-dolny) i jego stan początkowy. */
  persp?: { quad: Quad; quad0: Quad; changed: boolean } | null;
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
      // Wyodrębnij piksele bez osłabiania przezroczystości krawędziowej
      const cleanCutMask = document.createElement('canvas');
      cleanCutMask.width = this.width;
      cleanCutMask.height = this.height;
      const cleanCtx = cleanCutMask.getContext('2d')!;
      cleanCtx.drawImage(this.selectionManager.maskCanvas, 0, 0);

      const maskImgData = cleanCtx.getImageData(0, 0, this.width, this.height);
      const mData = maskImgData.data;
      for (let i = 3; i < mData.length; i += 4) {
        mData[i] = mData[i] > 0 ? 255 : 0;
      }
      cleanCtx.putImageData(maskImgData, 0, 0);

      layer.tileGrid.drawToFlatContext(cctx);
      cctx.globalCompositeOperation = 'destination-in';
      cctx.drawImage(cleanCutMask, 0, 0);

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

    if (mask) {
      const cleanCutMask = document.createElement('canvas');
      cleanCutMask.width = this.width;
      cleanCutMask.height = this.height;
      const cctx = cleanCutMask.getContext('2d')!;
      cctx.drawImage(mask, 0, 0);

      const maskImgData = cctx.getImageData(0, 0, this.width, this.height);
      const mData = maskImgData.data;
      for (let i = 3; i < mData.length; i += 4) {
        mData[i] = mData[i] > 0 ? 255 : 0;
      }
      cctx.putImageData(maskImgData, 0, 0);

      layer.clear(cleanCutMask);
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

    this.markAllLayersDirty();
    return true;
  }

  public pasteCanvas(pastedCanvas: HTMLCanvasElement, customMaskCanvas?: HTMLCanvasElement | null): boolean {
    const layer = this.getActiveLayer();
    if (!layer || layer.locked) return false;

    if (this.transformContentSession) {
      this.commitTransformContent();
    }

    const initialTilesSnapshot = layer.tileGrid.getTilesSnapshot();
    const initialSelectionSnapshot = this.selectionManager.getMaskSnapshot();

    // 1. Zachowaj/ustaw dokładny kształt maski zaznaczenia dla wklejanego obiektu
    this.selectionManager.clear();
    const mctx = this.selectionManager.maskCtx;

    if (customMaskCanvas) {
      mctx.drawImage(customMaskCanvas, 0, 0);
    } else {
      const pctx = pastedCanvas.getContext('2d')!;
      const pData = pctx.getImageData(0, 0, pastedCanvas.width, pastedCanvas.height).data;

      let minX = pastedCanvas.width, minY = pastedCanvas.height, maxX = -1, maxY = -1;
      for (let y = 0; y < pastedCanvas.height; y++) {
        for (let x = 0; x < pastedCanvas.width; x++) {
          if (pData[(y * pastedCanvas.width + x) * 4 + 3] > 0) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX >= minX && maxY >= minY) {
        mctx.fillStyle = '#ffffff';
        mctx.fillRect(minX, minY, maxX - minX + 1, maxY - minY + 1);
      } else {
        mctx.fillStyle = '#ffffff';
        mctx.fillRect(0, 0, pastedCanvas.width, pastedCanvas.height);
      }
    }

    this.selectionManager.hasActiveSelection = true;
    this.selectionManager.rebuildContoursFromMask();

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
    pasteSrcMask.getContext('2d')!.drawImage(
      this.selectionManager.maskCanvas,
      bounds.left, bounds.top, bounds.width, bounds.height,
      0, 0, bounds.width, bounds.height
    );

    // 2. Rozpocznij PŁYWAJĄCĄ SESJĘ BEZ ZAPISYWANIA PIKSELI NA WARSTWIE POD SPODEM!
    // Warstwa pod spodem pozostaje w 100% czysta (nic nie zostaje z tyłu przy przenoszeniu)
    this.selectionManager.beginTransformSelection();

    this.transformContentSession = {
      sourceContentCanvas: croppedSourceCanvas,
      sourceBounds: bounds,
      sourceLayerIndex: this.activeLayerIndex,
      initialTilesSnapshot,
      initialSelectionSnapshot,
      interpolation: 'bilinear',
      srcMask: pasteSrcMask,
    };

    this.markAllLayersDirty();
    return true;
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
    return this.layers;
  }

  /** Indeks aktywnej warstwy w `renderLayers`. */
  public get renderActiveIndex(): number {
    return this.maskView ? 0 : this.activeLayerIndex;
  }

  /** Indeks rzeczywistej warstwy odpowiadającej pozycji `i` w `renderLayers`. */
  public realLayerIndex(i: number): number {
    return this.maskView ? this.layers.indexOf(this.maskView) : i;
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
    this.saveFullSnapshot('Dodanie maski');
    layer.createMask(fromSelection && this.selectionManager.hasActiveSelection ? this.selectionManager.maskCanvas : null);
    this.markAllLayersDirty();
    return true;
  }

  /** Usuwa maskę aktywnej warstwy; `apply` wpieka ją w piksele. */
  public removeLayerMask(apply: boolean): boolean {
    const layer = this.getActiveLayer();
    if (!layer || !layer.hasMask) return false;
    this.finishOpenSessions();
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
    this.markAllLayersDirty();
  }

  public toggleMaskLink(index: number): void {
    const layer = this.layers[index];
    if (!layer || !layer.hasMask) return;
    this.pushPropertyAction(index, 'maskLinked', layer.maskLinked, !layer.maskLinked, 'Powiązanie maski z warstwą');
    layer.maskLinked = !layer.maskLinked;
  }

  public markAllLayersDirty(): void {
    this.pixelVersion++;
    for (const layer of this.layers) {
      layer.tileGrid.markAllDirty();
      layer.updateThumbnail(layer === this.layers[this.activeLayerIndex]);
    }
    this.lastDirtyRect = null;
  }

  // --- ZARZĄDZANIE WARSTWAMI ---

  public addLayer(name?: string): Layer {
    this.saveFullSnapshot('Dodanie warstwy');
    const newIdx = this.layers.length + 1;
    const layer = new Layer(
      `layer_${Date.now()}`,
      name || `Warstwa ${newIdx}`,
      this.width,
      this.height,
      this.tileSize
    );
    layer.updateThumbnail();
    this.layers.splice(this.activeLayerIndex + 1, 0, layer);
    this.activeLayerIndex = this.activeLayerIndex + 1;
    this.markAllLayersDirty();
    return layer;
  }

  public removeActiveLayer(): boolean {
    if (this.layers.length <= 1) return false;
    const active = this.getActiveLayer();
    if (active?.locked) return false;
    this.saveFullSnapshot('Usunięcie warstwy');
    this.layers.splice(this.activeLayerIndex, 1);
    this.activeLayerIndex = Math.max(0, this.activeLayerIndex - 1);
    this.markAllLayersDirty();
    return true;
  }

  public duplicateActiveLayer(): Layer {
    this.saveFullSnapshot('Duplikowanie warstwy');
    const active = this.getActiveLayer();
    const cloned = active.clone(`layer_${Date.now()}`, `${active.name} (Kopia)`);
    this.layers.splice(this.activeLayerIndex + 1, 0, cloned);
    this.activeLayerIndex = this.activeLayerIndex + 1;
    this.markAllLayersDirty();
    return cloned;
  }

  public mergeLayerDown(): boolean {
    if (this.activeLayerIndex <= 0) return false;
    const topLayer = this.layers[this.activeLayerIndex];
    const bottomLayer = this.layers[this.activeLayerIndex - 1];
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

  public reorderLayers(fromIndex: number, toIndex: number): void {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      fromIndex >= this.layers.length ||
      toIndex < 0 ||
      toIndex >= this.layers.length
    ) {
      return;
    }
    this.saveFullSnapshot('Zmiana kolejności warstw');
    const [moved] = this.layers.splice(fromIndex, 1);
    this.layers.splice(toIndex, 0, moved);
    this.activeLayerIndex = toIndex;
    this.markAllLayersDirty();
  }

  public moveActiveLayerUp(): boolean {
    if (this.activeLayerIndex >= this.layers.length - 1) return false;
    this.reorderLayers(this.activeLayerIndex, this.activeLayerIndex + 1);
    return true;
  }

  public moveActiveLayerDown(): boolean {
    if (this.activeLayerIndex <= 0) return false;
    this.reorderLayers(this.activeLayerIndex, this.activeLayerIndex - 1);
    return true;
  }

  public setLayerOpacity(index: number, opacity: number, recordOldValue?: number): void {
    if (index >= 0 && index < this.layers.length) {
      const newVal = Math.max(0, Math.min(1, opacity));

      if (recordOldValue !== undefined && Math.abs(recordOldValue - newVal) > 0.001) {
        this.pushPropertyAction(index, 'opacity', recordOldValue, newVal, 'Zmiana krycia');
      }

      this.layers[index].opacity = newVal;
      this.markAllLayersDirty();
    }
  }

  public setLayerBlendMode(index: number, blendMode: SKBlendMode): void {
    if (index >= 0 && index < this.layers.length) {
      const oldVal = this.layers[index].blendMode;
      const newVal = blendMode;
      if (oldVal !== newVal) {
        this.pushPropertyAction(index, 'blendMode', oldVal, newVal, 'Zmiana trybu mieszania');
        this.layers[index].blendMode = newVal;
        this.markAllLayersDirty();
      }
    }
  }

  public toggleLayerVisibility(index: number): void {
    if (index >= 0 && index < this.layers.length) {
      const oldVal = this.layers[index].visible;
      const newVal = !oldVal;
      this.pushPropertyAction(index, 'visible', oldVal, newVal, 'Zmiana widoczności');
      this.layers[index].visible = newVal;
      this.markAllLayersDirty();
    }
  }

  public toggleLayerLock(index: number): void {
    if (index >= 0 && index < this.layers.length) {
      this.layers[index].locked = !this.layers[index].locked;
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

  private onWandResult(r: { id: number; status: string; rings?: Float64Array[] }): void {
    const p = this.wandPending;
    if (!p || p.id !== r.id) return; // wyprzedzone nowszym zadaniem albo już zakończone synchronicznie
    if (r.status !== 'ok' && r.status !== 'same') {
      this.finishWandSync(p); // wątek nie miał próbki / błąd: liczymy w głównym wątku
      return;
    }
    const sm = this.selectionManager;
    if (r.status === 'ok') sm.applyWandRings(r.rings!, p.settings, p.sig);
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

    // Utwórz czystą binarną maskę wycinania (gwarantuje w 100% wyczyszczenie warstwy bez zostawiania obramówek/artefaktów na brzegach)
    const cleanCutMask = document.createElement('canvas');
    cleanCutMask.width = this.width;
    cleanCutMask.height = this.height;
    const cctx = cleanCutMask.getContext('2d')!;
    cctx.drawImage(this.selectionManager.maskCanvas, 0, 0);

    const maskImgData = cctx.getImageData(0, 0, this.width, this.height);
    const mData = maskImgData.data;
    for (let i = 3; i < mData.length; i += 4) {
      mData[i] = mData[i] > 0 ? 255 : 0;
    }
    cctx.putImageData(maskImgData, 0, 0);

    // 2. Wyodrębnij SZYBKA WYCIĘTĄ teksturę zaznaczenia (tylko obszar bounds zamiast pełnego płótna 12MP!)
    const sourceContentCanvas = document.createElement('canvas');
    sourceContentCanvas.width = bounds.width;
    sourceContentCanvas.height = bounds.height;
    const sctx = sourceContentCanvas.getContext('2d')!;

    // Narysuj tylko kafelki przecinające obszar zaznaczenia (100x szybciej niż cała siatka)
    layer.tileGrid.drawCroppedToContext(sctx, bounds.left, bounds.top, bounds.width, bounds.height);

    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(
      cleanCutMask,
      bounds.left, bounds.top, bounds.width, bounds.height,
      0, 0, bounds.width, bounds.height
    );
    sctx.globalCompositeOperation = 'source-over';

    const srcMaskCanvas = document.createElement('canvas');
    srcMaskCanvas.width = bounds.width;
    srcMaskCanvas.height = bounds.height;
    srcMaskCanvas.getContext('2d')!.drawImage(
      cleanCutMask,
      bounds.left, bounds.top, bounds.width, bounds.height,
      0, 0, bounds.width, bounds.height
    );

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

    // 3. Wyczyść wycięty fragment na aktywnej warstwie (otwór pod pływającą zawartością)
    layer.clear(cleanCutMask);

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
    };

    this.markAllLayersDirty();
    return true;
  }

  // --- TRYB PERSPEKTYWY (narzędzie manipulacji zawartością) ---

  public get perspectiveActive(): boolean {
    return !!this.transformContentSession?.persp;
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
    this.markAllLayersDirty();
    return true;
  }

  /** Renderuje przekształcony (przesunięty / przeskalowany / obrócony) fragment do płótna dokumentu, przycięty do maski zaznaczenia. */
  private renderTransformedContent(src: HTMLCanvasElement, interpolation: InterpolationMode): HTMLCanvasElement {
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
    tctx.save();
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
    tctx.restore();
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
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
      tctx.restore();

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
        const moved = this.renderTransformedContent(o.content, sess.interpolation);
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
        for (let i = 0; i < rLayers.length; i++) {
          const layer = rLayers[i];
          if (!layer.visible || layer.opacity <= 0) continue;

          const affectedTiles = layer.pixelGrid.getTilesIntersectingRect(dirtyRect);
          if (affectedTiles.length === 0) continue;

          if (i !== rActive || !isDrawingLive) {
            ctx.save();
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);

            for (const tile of affectedTiles) {
              if (tile.hasContent || layer.grayView) {
                const rc = layer.renderCanvas(tile);
                if (rc) ctx.drawImage(rc, tile.pixelX, tile.pixelY);
              }
            }
            ctx.restore();
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
            ctx.save();
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
            ctx.drawImage(liveSrc, 0, 0, clipW, clipH, clipLeft, clipTop, clipW, clipH);
            ctx.restore();
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
    for (let i = 0; i < rLayersF.length; i++) {
      const layer = rLayersF[i];
      if (!layer.visible || layer.opacity <= 0) continue;

      const isLiveBrushActive = (i === rActiveF && isDrawingLive && (!!this.brushEngine.activeBrushSettings || !!this.brushEngine.activeStampSettings));
      const isCustomPreviewActive = (i === rActiveF && !!customPreviewRenderer);

      if (!isLiveBrushActive && !isCustomPreviewActive) {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.drawRenderedToContext(ctx);
        ctx.restore();
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
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        ctx.drawImage(liveFlat, 0, 0);
        ctx.restore();
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
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        ctx.drawImage(customFlat, 0, 0);
        ctx.restore();
      }

      // Pływająca zawartość podczas aktywnej sesji przekształcania zawartości (SZYBKIE HARDWARE-ACCELERATED RENDEROWANIE CROP TEXTURE)
      if (
        !this.floatingContentExternal &&
        this.transformContentSession &&
        this.transformContentSession.sourceLayerIndex === this.realLayerIndex(i) &&
        this.selectionManager.transformState
      ) {
        const st = this.selectionManager.transformState;
        const sess = this.transformContentSession;

        if (sess.persp) {
          const img = sess.previewCanvas ?? sess.sourceContentCanvas;
          ctx.save();
          ctx.imageSmoothingEnabled = sess.interpolation !== 'nearest-neighbor';
          ctx.imageSmoothingQuality = 'medium';
          drawPerspectiveMesh(ctx, img, img.width, img.height, sess.persp.quad);
          ctx.restore();
          continue;
        }

        ctx.save();
        ctx.translate(st.pos.x, st.pos.y);
        ctx.rotate(st.angle);
        const scaleXMult = st.flipX ? -1 : 1;
        const scaleYMult = st.flipY ? -1 : 1;
        const sx = (st.width / Math.max(1, st.initialBounds.width)) * scaleXMult;
        const sy = (st.height / Math.max(1, st.initialBounds.height)) * scaleYMult;
        ctx.scale(sx, sy);

        if (sess.interpolation === 'nearest-neighbor') {
          ctx.imageSmoothingEnabled = false;
        } else if (sess.interpolation === 'bilinear') {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'medium';
        } else {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
        }

        ctx.drawImage(
          sess.previewCanvas ?? sess.sourceContentCanvas,
          -st.initialBounds.width / 2,
          -st.initialBounds.height / 2
        );
        ctx.restore();
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
      for (const layer of this.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.drawRenderedCropped(ctx, cropX, cropY, cropWidth, cropHeight);
        ctx.restore();
      }
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
      for (const layer of this.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.drawRenderedCropped(ctx, minX, minY, cropW, cropH);
        ctx.restore();
      }
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
      for (const layer of this.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.drawRenderedCropped(ctx, cropX, cropY, boxSize, boxSize);
        ctx.restore();
      }
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

    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;

      const layerFlat = layer.renderFlatCanvas();
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
      ctx.drawImage(layerFlat, 0, 0);
      ctx.restore();
    }

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
        visible: l.visible,
        opacity: l.opacity,
        blendMode: l.blendMode,
        dataUrl: l.pixelGrid.compositeToFlatCanvas().toDataURL('image/png'),
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
        const layer = new Layer(
          lData.id || `layer_${Date.now()}`,
          lData.name || 'Warstwa',
          this.width,
          this.height,
          this.tileSize
        );
        layer.visible = lData.visible !== false;
        layer.opacity = typeof lData.opacity === 'number' ? lData.opacity : 1.0;
        layer.blendMode = lData.blendMode || 'SrcOver';

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
              layer.createMask(null);
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
