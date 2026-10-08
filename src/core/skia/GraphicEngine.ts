/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Layer } from './Layer.ts';
import { BrushEngine } from './BrushEngine.ts';
import { SelectionManager, SelectionSnapshot } from './SelectionManager.ts';
import { DEFAULT_TILE_SIZE } from './TileGrid.ts';
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
  renderVectorBezier,
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
}

export type HistoryAction =
  | {
      type: 'tiles';
      description: string;
      layerIndex: number;
      before: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
      after: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[];
    }
  | {
      type: 'layerProperty';
      description: string;
      layerIndex: number;
      property: 'opacity' | 'blendMode' | 'visible';
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

  // Stan interaktywnego narzedzia Wiadro z woda (Paint Bucket)
  public bucketSeedPoint: SKPoint | null = null;
  public bucketInitialTilesSnapshot: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] | null = null;
  public bucketInitialLayerIndex: number = -1;
  public bucketColorSource: 'primary' | 'secondary' = 'primary';

  // Stan interaktywnego narzędzia Wypełnienie gradientowe (Gradient Fill)
  public gradientStartPoint: SKPoint | null = null;
  public gradientEndPoint: SKPoint | null = null;
  public gradientInitialTilesSnapshot: { tx: number; ty: number; imgData: ImageData; hasContent: boolean }[] | null = null;
  public gradientInitialLayerIndex: number = -1;
  public gradientColorSource: 'primary' | 'secondary' = 'primary';

  // Wewnętrzny schowek aplikacji FIGURA
  public clipboardCanvas: HTMLCanvasElement | null = null;
  public clipboardMaskCanvas: HTMLCanvasElement | null = null;

  private undoStack: HistoryAction[] = [];
  private redoStack: HistoryAction[] = [];
  private maxHistory: number = 30;

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

  public saveFullSnapshot(description: string): void {
    const snapshotLayers = this.layers.map((l) => l.clone(l.id, l.name));
    this.undoStack.push({
      type: 'layers',
      description,
      layers: snapshotLayers,
      activeLayerIndex: this.activeLayerIndex,
    });
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  public pushTileAction(action: HistoryAction): void {
    this.undoStack.push(action);
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  public pushPropertyAction(
    layerIndex: number,
    property: 'opacity' | 'blendMode' | 'visible',
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
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
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
          const tile = layer.tileGrid.getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
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
          const tile = layer.tileGrid.getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
        layer.updateThumbnail();
      }
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

      this.layers = action.layers.map((l) => l.clone(l.id, l.name));
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
          const tile = layer.tileGrid.getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
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
          const tile = layer.tileGrid.getTile(t.tx, t.ty);
          if (tile) {
            tile.ctx.putImageData(t.imgData, 0, 0);
            tile.hasContent = t.hasContent;
            tile.isDirty = true;
          }
        }
        layer.updateThumbnail();
      }
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

      this.layers = action.layers.map((l) => l.clone(l.id, l.name));
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

  public markAllLayersDirty(): void {
    for (const layer of this.layers) {
      layer.tileGrid.markAllDirty();
      layer.updateThumbnail();
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

    const topFlat = topLayer.tileGrid.compositeToFlatCanvas();
    const mergedCanvas = document.createElement('canvas');
    mergedCanvas.width = this.width;
    mergedCanvas.height = this.height;
    const mctx = mergedCanvas.getContext('2d')!;

    bottomLayer.tileGrid.drawToFlatContext(mctx);
    mctx.save();
    mctx.globalAlpha = topLayer.opacity;
    mctx.globalCompositeOperation = getCanvasCompositeOperation(topLayer.blendMode);
    mctx.drawImage(topFlat, 0, 0);
    mctx.restore();

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
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = [];
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

  private getMagicWandSampleCanvas(sampleSource?: WandSampleSource): HTMLCanvasElement {
    if (sampleSource === 'layer') {
      const activeLayer = this.getActiveLayer();
      if (activeLayer) {
        return activeLayer.tileGrid.compositeToFlatCanvas();
      }
    }
    return this.getCompositeFlatCanvas();
  }

  public applyMagicWand(seedPoint: SKPoint, settings: SelectionSettings): void {
    const before = this.selectionManager.getMaskSnapshot();
    const sampleCanvas = this.getMagicWandSampleCanvas(settings.sampleSource);
    this.selectionManager.applyMagicWand(seedPoint, sampleCanvas, settings, true);
    const after = this.selectionManager.getMaskSnapshot();
    this.pushSelectionAction(before, after, 'Magiczna różdżka');
    this.markAllLayersDirty();
  }

  public refreshMagicWand(settings: SelectionSettings, seedPoint?: SKPoint): void {
    if (seedPoint) {
      this.selectionManager.wandSeedPoint = seedPoint;
    }
    if (!this.selectionManager.wandSeedPoint) return;

    const sampleCanvas = this.getMagicWandSampleCanvas(settings.sampleSource);
    this.selectionManager.applyMagicWand(this.selectionManager.wandSeedPoint, sampleCanvas, settings, false);
    this.markAllLayersDirty();
  }

  // --- INTERAKTYWNE WIADRO Z WODĄ (PAINT BUCKET) ---

  public restoreBucketInitialTiles(): void {
    if (
      this.bucketInitialTilesSnapshot &&
      this.bucketInitialLayerIndex >= 0 &&
      this.bucketInitialLayerIndex < this.layers.length
    ) {
      const layer = this.layers[this.bucketInitialLayerIndex];
      if (layer) {
        for (const t of this.bucketInitialTilesSnapshot) {
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
      this.bucketInitialTilesSnapshot = layer.tileGrid.getTilesSnapshot();
      this.bucketSeedPoint = { ...seedPoint };
      if (colorSource) {
        this.bucketColorSource = colorSource;
      }
    } else {
      // Przy modyfikacji parametrów na żywo lub przesuwaniu uchwytu:
      // Zawsze najpierw przywróć czysty, pierwotny stan warstwy przed próbkowaniem!
      this.restoreBucketInitialTiles();
      if (seedPoint) {
        this.bucketSeedPoint = { ...seedPoint };
      }
    }

    if (!this.bucketSeedPoint) return false;

    // Pobierz czyste płótno próbkowania koloru (Obraz vs Warstwa) z czystego stanu dokumentu
    const sampleCanvas = this.getMagicWandSampleCanvas(selectionSettings.sampleSource);
    const w = this.width;
    const h = this.height;

    const sx = Math.max(0, Math.min(w - 1, Math.floor(this.bucketSeedPoint.x)));
    const sy = Math.max(0, Math.min(h - 1, Math.floor(this.bucketSeedPoint.y)));

    const sCtx = sampleCanvas.getContext('2d');
    if (!sCtx) return false;

    const sampleImgData = sCtx.getImageData(0, 0, w, h);
    const sData = sampleImgData.data;

    const startIndex = (sy * w + sx) * 4;
    const targetR = sData[startIndex];
    const targetG = sData[startIndex + 1];
    const targetB = sData[startIndex + 2];
    const targetA = sData[startIndex + 3];

    const maxDist = ((selectionSettings.tolerance ?? 15) / 100) * 441.67;

    let selectionMaskData: Uint8ClampedArray | null = null;
    if (this.selectionManager.hasActiveSelection) {
      const mctx = this.selectionManager.maskCanvas.getContext('2d');
      if (mctx) {
        selectionMaskData = mctx.getImageData(0, 0, w, h).data;
      }
    }

    const fillMask = new Uint8Array(w * h);
    const mode = selectionSettings.wandMode || 'contiguous';

    if (mode === 'global') {
      for (let i = 0; i < w * h; i++) {
        if (selectionMaskData && selectionMaskData[i * 4 + 3] === 0) continue;
        const p = i * 4;
        const dr = sData[p] - targetR;
        const dg = sData[p + 1] - targetG;
        const db = sData[p + 2] - targetB;
        const da = sData[p + 3] - targetA;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db + (da * da) / 4);
        if (dist <= maxDist) {
          if (brushSettings.antiAliasing && maxDist > 0 && dist > maxDist * 0.75) {
            const factor = 1 - (dist - maxDist * 0.75) / (maxDist * 0.25);
            fillMask[i] = Math.max(1, Math.round(factor * 255));
          } else {
            fillMask[i] = 255;
          }
        }
      }
    } else {
      const queue: number[] = [sy * w + sx];
      fillMask[sy * w + sx] = 255;

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
          if (nIdx >= 0 && !fillMask[nIdx]) {
            if (selectionMaskData && selectionMaskData[nIdx * 4 + 3] === 0) continue;

            const p = nIdx * 4;
            const dr = sData[p] - targetR;
            const dg = sData[p + 1] - targetG;
            const db = sData[p + 2] - targetB;
            const da = sData[p + 3] - targetA;
            const dist = Math.sqrt(dr * dr + dg * dg + db * db + (da * da) / 4);

            if (dist <= maxDist) {
              if (brushSettings.antiAliasing && maxDist > 0 && dist > maxDist * 0.75) {
                const factor = 1 - (dist - maxDist * 0.75) / (maxDist * 0.25);
                fillMask[nIdx] = Math.max(1, Math.round(factor * 255));
              } else {
                fillMask[nIdx] = 255;
              }
              queue.push(nIdx);
            }
          }
        }
      }
    }

    let minX = w, minY = h, maxX = -1, maxY = -1;

    // Utwórz bufor dla wylewanego koloru
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = w;
    fillCanvas.height = h;
    const fctx = fillCanvas.getContext('2d')!;
    const fillImgData = fctx.createImageData(w, h);
    const fData = fillImgData.data;

    const fillColor = brushSettings.color;

    for (let i = 0; i < w * h; i++) {
      if (fillMask[i] > 0) {
        const px = i % w;
        const py = Math.floor(i / w);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;

        const p = i * 4;
        let alpha = Math.round((fillColor.a * fillMask[i]) / 255);
        if (selectionMaskData) {
          alpha = Math.round((alpha * selectionMaskData[p + 3]) / 255);
        }
        fData[p] = fillColor.r;
        fData[p + 1] = fillColor.g;
        fData[p + 2] = fillColor.b;
        fData[p + 3] = alpha;
      }
    }

    if (maxX >= minX && maxY >= minY) {
      fctx.putImageData(fillImgData, 0, 0);

      const layerFlat = layer.tileGrid.compositeToFlatCanvas();
      const lctx = layerFlat.getContext('2d')!;

      lctx.save();
      lctx.globalCompositeOperation = getCanvasCompositeOperation(brushSettings.blendMode || 'SrcOver');
      lctx.drawImage(fillCanvas, 0, 0);
      lctx.restore();

      const dirtyRect: SKRectI = {
        left: minX,
        top: minY,
        right: maxX + 1,
        bottom: maxY + 1,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      };

      const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirtyRect);
      for (const tile of affectedTiles) {
        tile.ctx.clearRect(0, 0, tile.width, tile.height);
        tile.ctx.drawImage(
          layerFlat,
          tile.pixelX, tile.pixelY, tile.width, tile.height,
          0, 0, tile.width, tile.height
        );
        tile.hasContent = true;
        tile.isDirty = true;
      }
    }

    layer.updateThumbnail();
    this.markAllLayersDirty();
    return true;
  }

  public commitPaintBucketSession(): void {
    if (this.bucketInitialTilesSnapshot && this.bucketInitialLayerIndex >= 0) {
      const layer = this.layers[this.bucketInitialLayerIndex];
      if (layer) {
        const tilesAfter = layer.tileGrid.getTilesSnapshot();
        this.pushTileAction({
          type: 'tiles',
          description: 'Wypełnienie wiaderkiem',
          layerIndex: this.bucketInitialLayerIndex,
          before: this.bucketInitialTilesSnapshot,
          after: tilesAfter,
        });
      }
    }
    this.bucketInitialTilesSnapshot = null;
    this.bucketInitialLayerIndex = -1;
    this.bucketSeedPoint = null;
    this.bucketColorSource = 'primary';
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
      this.gradientInitialTilesSnapshot = layer.tileGrid.getTilesSnapshot();
      this.gradientStartPoint = { ...p0 };
      this.gradientEndPoint = { ...p1 };
    } else {
      if (colorSource) {
        this.gradientColorSource = colorSource;
      }
      this.restoreGradientInitialTiles();
      this.gradientStartPoint = { ...p0 };
      this.gradientEndPoint = { ...p1 };
    }

    const w = this.width;
    const h = this.height;

    // Pobierz maskę zaznaczenia jeśli istnieje
    let selectionMaskData: Uint8ClampedArray | null = null;
    let startX = 0;
    let startY = 0;
    let endX = w;
    let endY = h;

    if (this.selectionManager.hasActiveSelection) {
      const mctx = this.selectionManager.maskCanvas.getContext('2d');
      if (mctx) {
        selectionMaskData = mctx.getImageData(0, 0, w, h).data;
      }
      const bounds = this.selectionManager.getSelectionBounds();
      if (bounds) {
        startX = Math.max(0, Math.floor(bounds.left));
        startY = Math.max(0, Math.floor(bounds.top));
        endX = Math.min(w, Math.ceil(bounds.right));
        endY = Math.min(h, Math.ceil(bounds.bottom));
      }
    }

    const sx = p0.x;
    const sy = p0.y;
    const ex = p1.x;
    const ey = p1.y;

    const dx = ex - sx;
    const dy = ey - sy;
    let L = Math.hypot(dx, dy);
    if (L < 0.001) L = 0.001;

    const ux = dx / L;
    const uy = dy / L;
    const vx = -uy;
    const vy = ux;

    // Kolory początkowy i końcowy (z uwzględnieniem prawego przycisku myszy / koloru dodatkowego i odwrócenia)
    const isSecondary = this.gradientColorSource === 'secondary';
    const effectivePrimary = isSecondary ? secondaryColor : primaryColor;
    const effectiveSecondary = isSecondary ? primaryColor : secondaryColor;

    const c0 = settings.reverse ? effectiveSecondary : effectivePrimary;
    const c1 = settings.reverse ? effectivePrimary : effectiveSecondary;

    // Tablica LUT dla 1024 próbek koloru (dla maksymalnej płynności)
    const lutR = new Uint8Array(1024);
    const lutG = new Uint8Array(1024);
    const lutB = new Uint8Array(1024);
    const lutA = new Uint8Array(1024);

    for (let k = 0; k < 1024; k++) {
      const frac = k / 1023;
      lutR[k] = Math.round(c0.r + (c1.r - c0.r) * frac);
      lutG[k] = Math.round(c0.g + (c1.g - c0.g) * frac);
      lutB[k] = Math.round(c0.b + (c1.b - c0.b) * frac);
      lutA[k] = Math.round(c0.a + (c1.a - c0.a) * frac);
    }

    const gradCanvas = document.createElement('canvas');
    gradCanvas.width = w;
    gradCanvas.height = h;
    const gctx = gradCanvas.getContext('2d')!;
    const gradImgData = gctx.createImageData(w, h);
    const gData = gradImgData.data;

    const shape = settings.type;
    const isRepeat = settings.repeat === 'repeat';
    const twoPi = Math.PI * 2;

    for (let y = startY; y < endY; y++) {
      const py = y - sy;
      const rowOffset = y * w;

      for (let x = startX; x < endX; x++) {
        const p = (rowOffset + x) * 4;

        let maskAlpha = 1.0;
        if (selectionMaskData) {
          maskAlpha = selectionMaskData[p + 3] / 255;
          if (maskAlpha === 0) continue;
        }

        const px = x - sx;
        let t = 0;

        switch (shape) {
          case 'linear': {
            const projU = px * ux + py * uy;
            t = projU / L;
            break;
          }
          case 'reflected': {
            const projU = px * ux + py * uy;
            t = Math.abs(projU) / L;
            break;
          }
          case 'diamond': {
            const projU = Math.abs(px * ux + py * uy);
            const projV = Math.abs(px * vx + py * vy);
            t = (projU + projV) / L;
            break;
          }
          case 'radial': {
            const dist = Math.hypot(px, py);
            t = dist / L;
            break;
          }
          case 'conic': {
            const projU = px * ux + py * uy;
            const projV = px * vx + py * vy;
            let ang = Math.atan2(projV, projU);
            if (ang < 0) ang += twoPi;
            t = ang / twoPi;
            break;
          }
          case 'spiral-left': {
            const dist = Math.hypot(px, py);
            const projU = px * ux + py * uy;
            const projV = px * vx + py * vy;
            let ang = Math.atan2(projV, projU);
            if (ang < 0) ang += twoPi;
            t = dist / L - ang / twoPi;
            break;
          }
          case 'spiral-right': {
            const dist = Math.hypot(px, py);
            const projU = px * ux + py * uy;
            const projV = px * vx + py * vy;
            let ang = Math.atan2(projV, projU);
            if (ang < 0) ang += twoPi;
            t = dist / L + ang / twoPi;
            break;
          }
        }

        if (isRepeat) {
          t = t - Math.floor(t);
          if (t < 0) t += 1;
        } else {
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
        }

        const lutIdx = Math.min(1023, Math.max(0, Math.floor(t * 1023)));
        gData[p] = lutR[lutIdx];
        gData[p + 1] = lutG[lutIdx];
        gData[p + 2] = lutB[lutIdx];
        gData[p + 3] = Math.round(lutA[lutIdx] * maskAlpha);
      }
    }

    gctx.putImageData(gradImgData, 0, 0);

    const layerFlat = layer.tileGrid.compositeToFlatCanvas();
    const lctx = layerFlat.getContext('2d')!;

    lctx.save();
    lctx.globalCompositeOperation = getCanvasCompositeOperation(blendMode);
    lctx.drawImage(gradCanvas, 0, 0);
    lctx.restore();

    const dirtyRect: SKRectI = {
      left: startX,
      top: startY,
      right: endX,
      bottom: endY,
      width: endX - startX,
      height: endY - startY,
    };

    const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirtyRect);
    for (const tile of affectedTiles) {
      tile.ctx.clearRect(0, 0, tile.width, tile.height);
      tile.ctx.drawImage(
        layerFlat,
        tile.pixelX, tile.pixelY, tile.width, tile.height,
        0, 0, tile.width, tile.height
      );
      tile.hasContent = true;
      tile.isDirty = true;
    }

    layer.updateThumbnail();
    this.markAllLayersDirty();
    return true;
  }

  public commitGradientSession(): void {
    if (this.gradientInitialTilesSnapshot && this.gradientInitialLayerIndex >= 0) {
      const layer = this.layers[this.gradientInitialLayerIndex];
      if (layer) {
        const tilesAfter = layer.tileGrid.getTilesSnapshot();
        this.pushTileAction({
          type: 'tiles',
          description: 'Wypełnienie gradientowe',
          layerIndex: this.gradientInitialLayerIndex,
          before: this.gradientInitialTilesSnapshot,
          after: tilesAfter,
        });
      }
    }
    this.gradientInitialTilesSnapshot = null;
    this.gradientInitialLayerIndex = -1;
    this.gradientStartPoint = null;
    this.gradientEndPoint = null;
    this.gradientColorSource = 'primary';
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
    };

    this.markAllLayersDirty();
    return true;
  }

  public updateTransformContentInterpolation(interpolation: InterpolationMode): void {
    if (this.transformContentSession) {
      this.transformContentSession.interpolation = interpolation;
      this.markAllLayersDirty();
    }
  }

  public commitTransformContent(): boolean {
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
      layer.updateThumbnail();

      const tilesAfter = layer.tileGrid.getTilesSnapshot();
      const selectionAfter = this.selectionManager.getMaskSnapshot();

      this.pushTileAction({
        type: 'transformContent',
        description: 'Przekształcenie zawartości',
        layerIndex: sess.sourceLayerIndex,
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

        for (let i = 0; i < this.layers.length; i++) {
          const layer = this.layers[i];
          if (!layer.visible || layer.opacity <= 0) continue;

          const affectedTiles = layer.tileGrid.getTilesIntersectingRect(dirtyRect);
          if (affectedTiles.length === 0) continue;

          if (i !== this.activeLayerIndex || !isDrawingLive) {
            ctx.save();
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);

            for (const tile of affectedTiles) {
              if (tile.hasContent) {
                ctx.drawImage(tile.canvas, tile.pixelX, tile.pixelY);
              }
            }
            ctx.restore();
          } else {
            // Aktywna warstwa podczas rysowania pędzlem na żywo
            const { canvas: scratch, ctx: sctx } = this.getDirtyScratch(clipW, clipH);
            sctx.clearRect(0, 0, clipW, clipH);

            // 1. Narysuj oryginalne kafelki aktywnej warstwy
            for (const tile of affectedTiles) {
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
              const brushScratch = document.createElement('canvas');
              brushScratch.width = clipW;
              brushScratch.height = clipH;
              const bsCtx = brushScratch.getContext('2d')!;

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
              sctx.drawImage(brushScratch, 0, 0);
              sctx.restore();
            }

            // 3. Połącz aktywną warstwę z płótnem dokumentu
            ctx.save();
            ctx.globalAlpha = layer.opacity;
            ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
            ctx.drawImage(scratch, 0, 0, clipW, clipH, clipLeft, clipTop, clipW, clipH);
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

    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      if (!layer.visible || layer.opacity <= 0) continue;

      const isLiveBrushActive = (i === this.activeLayerIndex && isDrawingLive && (!!this.brushEngine.activeBrushSettings || !!this.brushEngine.activeStampSettings));
      const isCustomPreviewActive = (i === this.activeLayerIndex && !!customPreviewRenderer);

      if (!isLiveBrushActive && !isCustomPreviewActive) {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.tileGrid.drawToFlatContext(ctx);
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

        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        ctx.drawImage(activeFlat, 0, 0);
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
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        ctx.drawImage(activeFlat, 0, 0);
        ctx.restore();
      }

      // Pływająca zawartość podczas aktywnej sesji przekształcania zawartości (SZYBKIE HARDWARE-ACCELERATED RENDEROWANIE CROP TEXTURE)
      if (
        this.transformContentSession &&
        this.transformContentSession.sourceLayerIndex === i &&
        this.selectionManager.transformState
      ) {
        const st = this.selectionManager.transformState;
        const sess = this.transformContentSession;

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
          sess.sourceContentCanvas,
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

  public commitVectorBezier(
    p0: SKPoint,
    p1: SKPoint,
    p2: SKPoint,
    p3: SKPoint,
    settings: LineAndCurveSettings
  ): void {
    const layer = this.getActiveLayer();
    if (!layer || !layer.visible) return;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = this.width;
    tempCanvas.height = this.height;
    const tctx = tempCanvas.getContext('2d');
    if (!tctx) return;

    renderVectorBezier(tctx, p0, p1, p2, p3, { ...settings, blendMode: 'SrcOver' });

    if (this.selectionManager.hasActiveSelection) {
      tctx.save();
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(this.selectionManager.maskCanvas, 0, 0);
      tctx.restore();
    }

    const pad = Math.max(20, settings.strokeWidth * (settings.markerSize || 1.0) * 4 + 20);
    const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x, p3.x) - pad));
    const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y, p3.y) - pad));
    const maxX = Math.min(this.width, Math.ceil(Math.max(p0.x, p1.x, p2.x, p3.x) + pad));
    const maxY = Math.min(this.height, Math.ceil(Math.max(p0.y, p1.y, p2.y, p3.y) + pad));

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
      if (layer && layer.visible && layer.opacity > 0) {
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        layer.tileGrid.drawCroppedToContext(ctx, cropX, cropY, cropWidth, cropHeight);
        ctx.restore();
      }
    } else {
      for (const layer of this.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.tileGrid.drawCroppedToContext(ctx, cropX, cropY, cropWidth, cropHeight);
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
        layer.tileGrid.drawCroppedToContext(ctx, minX, minY, cropW, cropH);
        ctx.restore();
      }
    } else {
      for (const layer of this.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.tileGrid.drawCroppedToContext(ctx, minX, minY, cropW, cropH);
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
        layer.tileGrid.drawCroppedToContext(ctx, cropX, cropY, boxSize, boxSize);
        ctx.restore();
      }
    } else {
      for (const layer of this.layers) {
        if (!layer.visible || layer.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = layer.opacity;
        ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
        layer.tileGrid.drawCroppedToContext(ctx, cropX, cropY, boxSize, boxSize);
        ctx.restore();
      }
    }

    return canvas;
  }

  public getCompositeFlatCanvas(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;

      const layerFlat = layer.tileGrid.compositeToFlatCanvas();
      ctx.save();
      ctx.globalAlpha = layer.opacity;
      ctx.globalCompositeOperation = getCanvasCompositeOperation(layer.blendMode);
      ctx.drawImage(layerFlat, 0, 0);
      ctx.restore();
    }

    return canvas;
  }

  public saveToFigFile(): string {
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
        dataUrl: l.tileGrid.compositeToFlatCanvas().toDataURL('image/png'),
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

        loadedLayers.push(layer);
      }

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
