/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GraphicEngine } from './GraphicEngine.ts';
import type { Layer } from './Layer.ts';
import type { TileGrid, TileSnapshot } from './TileGrid.ts';
import {
  VecBounds,
  VectorObject,
  boundsIntersect,
  cloneVectorObject,
  cloneVectorObjects,
  hitTestVectorObject,
  newVectorId,
  translateVectorObject,
  unionBounds,
  vectorObjectBlend,
  vectorObjectBounds,
  vectorObjectTightBounds,
  vectorObjectKey,
  vectorObjectsEqual,
  invalidateVectorObject,
} from './VectorObjects.ts';
import { compositeObjectsRegion } from './VectorSprites.ts';
import { CpuStack } from './VectorStackCache.ts';

/**
 * Stan edycji istniejącego obiektu (Manipulacja). Obiekt NIE opuszcza listy warstwy ani swojego miejsca w kolejności.
 * Tryb `live` (nad obiektem leżą inne): obiekt jest na bieżąco podmieniany w liście, a obraz warstwy składany ze sprite'ów
 * w kolejności listy (tryby mieszania i efekty jak po zatwierdzeniu). Tryb sprite (obiekt na samej górze): obiekt jest
 * pominięty w pikselach, a podgląd rysuje nakładka (jak przy nowym obiekcie).
 *
 * Piksele dokumentu warstwy są tylko leniwą pochodną (patrz `Layer.pixelGrid`): zmiana obiektu zapisuje „brudny”
 * prostokąt i nic nie przebudowuje, dopóki ktoś nie odczyta pikseli.
 */
const BAND_PX = 4_000_000;

interface VectorEdit {
  layerId: string;
  /** Pozycja w liście w chwili rozpoczęcia (zapasowa, gdy obiektu nie da się znaleźć po id). */
  index: number;
  original: VectorObject;
  objsBefore: VectorObject[];
  live: boolean;
  /** Podział stosu "pod / edytowany / nad" użyty przy uzupełnianiu pikseli (tworzony leniwie). */
  stack?: CpuStack | null;
  /** Kafelki z chwili przed pierwszą zmianą pikseli (stan do cofnięcia), klucz ty*65536+tx. */
  saved: Map<number, TileSnapshot>;
  /** Suma obszarów, w których piksele mogły się zmienić. */
  touched: VecBounds;
  lastKey: string;
  version: number;
}

/** Przesuwanie zaznaczonych obiektów przeciągnięciem (jedna akcja historii na końcu). */
interface GroupMove {
  layerId: string;
  originals: Map<string, VectorObject>;
  objsBefore: VectorObject[];
  saved: Map<number, TileSnapshot>;
  touched: VecBounds;
  dx: number;
  dy: number;
  stack?: CpuStack | null;
}

/**
 * Warstwy wektorowe: dodawanie, edycja, kolejność i przenoszenie obiektów. Każda zmiana listy przebudowuje piksele
 * warstwy tylko w dotkniętym obszarze (kafelki), a do historii trafia razem z listą obiektów (jedna akcja).
 */
export class VectorLayerOps {
  private edit: VectorEdit | null = null;
  private group: GroupMove | null = null;
  private selLayerId: string | null = null;
  private selIds: string[] = [];
  /** Schowek obiektów (kopiuj / wytnij / wklej) i licznik kolejnych wklejeń (przesunięcie kaskadowe). */
  private clipboard: VectorObject[] = [];
  private pasteCount = 0;

  constructor(private engine: GraphicEngine) {}

  public isVector(layer: Layer | null | undefined): boolean {
    return !!layer && layer.isVector;
  }

  /** Warstwa, do której trafia nowy obiekt (aktywna warstwa wektorowa), albo null. */
  public targetLayer(): Layer | null {
    const l = this.engine.getActiveLayer();
    return l && l.vectorTarget && !l.isGroup && !l.isAdjustment ? l : null;
  }

  public get editing(): boolean {
    return !!this.edit;
  }

  /** Id obiektu aktualnie edytowanego (wyjętego z listy) i jego warstwy. */
  public get editingInfo(): { layerId: string; id: string; index: number } | null {
    return this.edit ? { layerId: this.edit.layerId, id: this.edit.original.id, index: this.edit.index } : null;
  }

  private docRect(b: VecBounds): { left: number; top: number; right: number; bottom: number; width: number; height: number } | null {
    const left = Math.max(0, Math.floor(b.x0));
    const top = Math.max(0, Math.floor(b.y0));
    const right = Math.min(this.engine.width, Math.ceil(b.x1));
    const bottom = Math.min(this.engine.height, Math.ceil(b.y1));
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  /**
   * Historia warstw wektorowych NIE przechowuje bitmap: piksele są pochodną listy obiektów, więc cofnięcie / ponowienie
   * odtwarza zmieniony fragment z obiektów (`rebuildRect`). Dzięki temu zatwierdzenie edycji nie czyta setek kafelków,
   * a historia zajmuje tylko pamięć list obiektów.
   */
  private snapshot(_layer: Layer, _b: VecBounds): TileSnapshot[] {
    return [];
  }

  /** Wiązanie wywołania uzupełniania pikseli (przekazywane warstwie przy pierwszym oznaczeniu jako brudnej). */
  private readonly flushBound = (layer: Layer): void => this.flushPixels(layer);

  /**
   * Zgłasza zmianę listy obiektów w prostokącie dokumentu. Piksele warstwy (cel: warstwa) NIE są przebudowywane od razu:
   * zapisujemy tylko „brudny” prostokąt i podnosimy rewizję (klucz podglądu). Uzupełnienie nastąpi przy pierwszym odczycie
   * pikseli (`Layer.pixelGrid`), a podgląd w trybie Wektory w ogóle ich nie czyta. Maska wektorowa jest uzupełniana od razu
   * (jest mała i rzadka).
   */
  public rebuild(layer: Layer, b: VecBounds): void {
    const r = this.docRect(b);
    if (!r) return;
    const onMask = layer.editMask && !!layer.maskGrid;
    if (onMask && layer.maskRaster) return; // maska rastrowa nie jest pochodną obiektów
    if (onMask) {
      // maska warstwy wektorowej = podkład + jej obiekty; podkład zapamiętujemy przed pierwszą przebudową
      if (!layer.maskBase) layer.maskBase = layer.maskGrid!.clone();
      this.paint(layer, layer.maskGrid!, layer.maskObjects.filter((o) => o.visible), layer.maskBase, r, null);
      layer.updateThumbnail();
      return;
    }
    layer.markVecDirty({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom }, this.flushBound);
    layer.updateThumbnail();
  }

  /** Uzupełnia piksele warstwy w „brudnym” prostokącie z listy obiektów (woła `Layer.pixelGrid` przy pierwszym odczycie). */
  public flushPixels(layer: Layer): void {
    const p = layer.vecPending;
    if (!p) return;
    layer.vecPending = null;
    if (!layer.isVector) return;
    const r = this.docRect(p);
    if (!r) return;
    const ed = this.edit;
    const hideId = ed && !ed.live && ed.layerId === layer.id ? ed.original.id : null;
    const list = layer.layerObjects.filter((o) => o.visible && o.id !== hideId);
    this.paint(layer, layer.pixelGridPeek, list, null, r, this.stackFor(layer));
  }

  /** Podział stosu dla trwającej edycji / przesuwania na tej warstwie (null = zwykłe składanie wszystkich obiektów). */
  private stackFor(layer: Layer): CpuStack | null {
    const ed = this.edit;
    if (ed && ed.live && ed.layerId === layer.id) {
      if (ed.stack === undefined) ed.stack = new CpuStack(layer.layerObjects.filter((o) => o.visible), new Set([ed.original.id]), this.engine.width, this.engine.height);
      return ed.stack;
    }
    const g = this.group;
    if (g && g.layerId === layer.id) {
      if (g.stack === undefined) g.stack = new CpuStack(layer.layerObjects.filter((o) => o.visible), new Set(g.originals.keys()), this.engine.width, this.engine.height);
      return g.stack;
    }
    return null;
  }

  private scratch: HTMLCanvasElement | null = null;

  /**
   * Maluje kafelki `grid` przecinające prostokąt `r` z obiektów `objs` (sprite'y) na podkładzie `base`. Duże obszary
   * składamy pasami kafelków, żeby bufor roboczy miał ograniczony rozmiar.
   */
  private paint(layer: Layer, grid: TileGrid, objs: VectorObject[], base: TileGrid | null, r: { left: number; top: number; right: number; bottom: number }, stack: CpuStack | null): void {
    const tiles = grid.getTilesIntersectingRect({ ...r, width: r.right - r.left, height: r.bottom - r.top });
    if (tiles.length === 0) return;
    let minTx = Infinity;
    let maxTx = -Infinity;
    for (const t of tiles) {
      if (t.tileX < minTx) minTx = t.tileX;
      if (t.tileX > maxTx) maxTx = t.tileX;
    }
    const perRow = Math.max(1, maxTx - minTx + 1);
    const rowsPerBand = Math.max(1, Math.floor(BAND_PX / (perRow * grid.tileSize * grid.tileSize)));
    const bands = new Map<number, typeof tiles>();
    for (const t of tiles) {
      const k = Math.floor(t.tileY / rowsPerBand);
      let a = bands.get(k);
      if (!a) bands.set(k, (a = []));
      a.push(t);
    }
    for (const bt of bands.values()) this.paintBand(grid, objs, base, bt, stack, layer);
  }

  private paintBand(grid: TileGrid, objs: VectorObject[], base: TileGrid | null, tiles: ReturnType<TileGrid['getTilesIntersectingRect']>, stack: CpuStack | null, layer: Layer): void {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const t of tiles) {
      x0 = Math.min(x0, t.pixelX);
      y0 = Math.min(y0, t.pixelY);
      x1 = Math.max(x1, t.pixelX + t.width);
      y1 = Math.max(y1, t.pixelY + t.height);
    }
    const w = x1 - x0;
    const h = y1 - y0;
    const region: VecBounds = { x0, y0, x1, y1 };
    const hits = objs.filter((o) => boundsIntersect(vectorObjectBounds(o), region));

    let acc = this.scratch;
    if (!acc) acc = this.scratch = document.createElement('canvas');
    if (acc.width !== w || acc.height !== h) {
      acc.width = w;
      acc.height = h;
    }
    const actx = acc.getContext('2d', { willReadFrequently: true })!;
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.globalCompositeOperation = 'source-over';
    actx.globalAlpha = 1;
    actx.clearRect(0, 0, w, h);
    if (base) {
      for (const t of tiles) {
        const bt = base.getTile(t.tileX, t.tileY);
        if (bt && bt.hasContent) actx.drawImage(bt.canvas, t.pixelX - x0, t.pixelY - y0);
      }
    }
    if (stack) stack.compose(actx, x0, y0, w, h, layer.layerObjects);
    else compositeObjectsRegion(actx, hits, x0, y0, w, h);

    // które kafelki pasa mają jakąkolwiek zawartość (zachowawczo: ramka obiektu dotyka kafelka)
    const ts = grid.tileSize;
    const tx0 = Math.floor(x0 / ts);
    const ty0 = Math.floor(y0 / ts);
    const cols = Math.ceil(w / ts);
    const rows = Math.ceil(h / ts);
    const touched = new Uint8Array(cols * rows);
    for (const o of hits) {
      const ob = vectorObjectBounds(o);
      const a0 = Math.max(0, Math.floor(ob.x0 / ts) - tx0);
      const a1 = Math.min(cols - 1, Math.floor((ob.x1 - 1e-6) / ts) - tx0);
      const b0 = Math.max(0, Math.floor(ob.y0 / ts) - ty0);
      const b1 = Math.min(rows - 1, Math.floor((ob.y1 - 1e-6) / ts) - ty0);
      for (let yy = b0; yy <= b1; yy++) for (let xx = a0; xx <= a1; xx++) touched[yy * cols + xx] = 1;
    }
    for (const t of tiles) {
      t.clear();
      const baseHas = !!base && !!base.getTile(t.tileX, t.tileY)?.hasContent;
      const any = baseHas || touched[(t.tileY - ty0) * cols + (t.tileX - tx0)] === 1;
      if (any) {
        t.ctx.drawImage(acc, t.pixelX - x0, t.pixelY - y0, t.width, t.height, 0, 0, t.width, t.height);
        t.hasContent = true;
        t.isDirty = true;
      }
    }
  }

  /** Id obiektów edytowanych / przesuwanych w tej chwili na warstwie (puste = brak sesji): podział stosu w podglądzie GPU. */
  public liveIdsOf(layer: Layer): ReadonlySet<string> | null {
    const ed = this.edit;
    if (ed && ed.layerId === layer.id) return new Set([ed.original.id]);
    const g = this.group;
    if (g && g.layerId === layer.id) return new Set(g.originals.keys());
    return null;
  }

  private layerIndexOf(layer: Layer): number {
    return this.engine.layers.indexOf(layer);
  }

  /** Wspólna ścieżka zmiany listy: migawka kafelków, zmiana, przebudowa, jedna akcja historii (kafelki + lista). */
  private mutate(layer: Layer, description: string, change: () => void, boundsOf: () => VecBounds | null): void {
    const objsBefore = cloneVectorObjects(layer.vectorObjects);
    const preBounds = boundsOf();
    change();
    const postBounds = boundsOf();
    const rect = preBounds && postBounds ? unionBounds(preBounds, postBounds) : preBounds ?? postBounds;
    this.finish(layer, description, objsBefore, rect, null);
  }

  private finish(layer: Layer, description: string, objsBefore: VectorObject[], rect: VecBounds | null, knownBefore: TileSnapshot[] | null): void {
    const e = this.engine;
    if (rect) this.rebuild(layer, rect);
    this.pendingBefore = null;
    e.pushTileAction({
      type: 'tiles',
      description,
      layerIndex: this.layerIndexOf(layer),
      onMask: layer.editMask && !!layer.maskGrid,
      before: [],
      after: [],
      rebuildRect: rect ?? undefined,
      vector: { before: objsBefore, after: cloneVectorObjects(layer.vectorObjects) },
    });
    layer.updateThumbnail();
    e.markPixelsChanged();
  }

  private pendingBefore: TileSnapshot[] | null = null;

  // ---- Zaznaczenie obiektów (lista w panelu i płótno) ----

  public getSelection(): { layerId: string; ids: string[] } | null {
    if (!this.selLayerId || this.selIds.length === 0) return null;
    const layer = this.engine.layers.find((l) => l.id === this.selLayerId);
    const ids = this.selectedIds(layer);
    return ids.length > 0 ? { layerId: this.selLayerId, ids } : null;
  }

  /** Zaznaczone id obiektów danej warstwy (tylko istniejące). */
  public selectedIds(layer: Layer | null | undefined): string[] {
    if (!layer || !layer.isVector || layer.id !== this.selLayerId) return [];
    return this.selIds.filter((id) => layer.vectorObjects.some((o) => o.id === id));
  }

  public setSelection(layerId: string | null, ids: string[]): void {
    this.selLayerId = ids.length > 0 ? layerId : null;
    this.selIds = ids.length > 0 ? [...ids] : [];
  }

  public clearSelection(): void {
    this.selLayerId = null;
    this.selIds = [];
  }

  /** Domyka otwartą edycję (zatwierdza przez sesję widoku; gdy to się nie uda, anuluje), żeby operacja z panelu miała spójny stan. */
  public settle(): void {
    if (this.group) this.endGroupMove();
    if (!this.edit) return;
    this.engine.finishOpenSessions();
    if (this.edit) this.cancelEdit();
  }

  // ---- Dodawanie i edycja ----

  /** Dodaje obiekt na szczyt warstwy (albo, przy trwającej edycji, odkłada go na dawne miejsce). */
  public commitObject(obj: VectorObject): boolean {
    if (this.edit) return this.commitEdit(obj);
    const layer = this.targetLayer();
    if (!layer || !layer.ownVisible || layer.locked) return false;
    const o = cloneVectorObject(obj);
    const bounds = vectorObjectBounds(o);
    const objsBefore = cloneVectorObjects(layer.vectorObjects);
    this.pendingBefore = this.snapshot(layer, bounds);
    layer.vectorObjects.push(o);
    this.finish(layer, 'Dodanie obiektu wektorowego', objsBefore, bounds, null);
    if (layer.vectorObjects.length === 1) layer.correctionsExpanded = true;
    this.clearSelection();
    return true;
  }

  private saveTiles(_map: Map<number, TileSnapshot>, _layer: Layer, _b: VecBounds): void {
    /* bitmapy nie są zapamiętywane (patrz snapshot) */
  }

  private mergedBefore(_layer: Layer, _saved: Map<number, TileSnapshot>, _rect: VecBounds): TileSnapshot[] {
    return [];
  }

  private findEditLayer(): Layer | null {
    const ed = this.edit;
    return ed ? this.engine.layers.find((l) => l.id === ed.layerId) ?? null : null;
  }

  /** Czy ponad obiektem o danym indeksie leży jakiś widoczny obiekt (wtedy podgląd edycji musi być w kolejności warstwy). */
  private hasVisibleAbove(layer: Layer, index: number): boolean {
    for (let i = index + 1; i < layer.vectorObjects.length; i++) if (layer.vectorObjects[i].visible) return true;
    return false;
  }

  public beginEdit(layerIndex: number, id: string): VectorObject | null {
    if (this.edit) return null;
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked) return null;
    const index = layer.vectorObjects.findIndex((o) => o.id === id);
    if (index < 0) return null;
    const original = cloneVectorObject(layer.vectorObjects[index]);
    const rect = vectorObjectBounds(original);
    const live = this.hasVisibleAbove(layer, index);
    const saved = new Map<number, TileSnapshot>();
    this.saveTiles(saved, layer, rect);
    this.edit = {
      layerId: layer.id,
      index,
      original,
      objsBefore: cloneVectorObjects(layer.vectorObjects),
      live,
      saved,
      touched: rect,
      lastKey: vectorObjectKey(original),
      version: 0,
    };
    this.setSelection(layer.id, [id]);
    layer.vecHold = true; // miniatura nie odczytuje pikseli w trakcie edycji
    if (!live) this.rebuild(layer, rect); // obiekt na wierzchu: piksele bez niego, podgląd rysuje nakładka
    this.engine.markPixelsChanged();
    return cloneVectorObject(original);
  }

  /**
   * Zachowane dla zgodności: piksele warstwy są teraz zawsze leniwą pochodną obiektów, więc odroczenie przebudowy
   * (dawniej włączane przez widok GPU) nie jest potrzebne.
   */
  public deferLiveRebuild = false;
  public get hasDeferred(): boolean {
    return false;
  }
  public flushDeferred(): void {
    /* nic: nie ma zaległej przebudowy, piksele uzupełniają się przy odczycie */
  }

  public get liveEditing(): boolean {
    return !!this.edit && this.edit.live;
  }

  /** Licznik zmian podglądu na żywo (klucz odświeżania kompozycji w widoku). */
  public get liveVersion(): number {
    return this.edit ? this.edit.version : 0;
  }

  /** Podgląd na żywo edytowanego obiektu: wstawia jego bieżący stan na właściwe miejsce i przebudowuje dotknięty obszar. */
  public updateLive(obj: VectorObject): void {
    const ed = this.edit;
    if (!ed || !ed.live) return;
    const layer = this.findEditLayer();
    if (!layer) return;
    const idx = layer.vectorObjects.findIndex((o) => o.id === ed.original.id);
    if (idx < 0) return;
    const o = cloneVectorObject(obj);
    o.id = ed.original.id;
    o.name = ed.original.name;
    o.visible = true;
    const key = vectorObjectKey(o);
    if (key === ed.lastKey) return;
    ed.lastKey = key;
    const region = unionBounds(vectorObjectBounds(layer.vectorObjects[idx]), vectorObjectBounds(o));
    this.saveTiles(ed.saved, layer, region);
    layer.vectorObjects[idx] = o;
    ed.touched = unionBounds(ed.touched, region);
    // tylko zapis „brudnego” prostokąta: obraz warstwy składa się z obiektów dopiero wtedy, gdy ktoś go potrzebuje
    this.rebuild(layer, region);
    ed.version++;
    this.engine.markPixelsChanged();
  }

  public cancelEdit(): void {
    const ed = this.edit;
    if (!ed) return;
    this.edit = null;
    const layer = this.engine.layers.find((l) => l.id === ed.layerId);
    if (!layer) return;
    layer.vecHold = false;
    const idx = layer.vectorObjects.findIndex((o) => o.id === ed.original.id);
    if (idx >= 0) layer.vectorObjects[idx] = cloneVectorObject(ed.original);
    else layer.vectorObjects.splice(Math.min(ed.index, layer.vectorObjects.length), 0, cloneVectorObject(ed.original));
    this.rebuild(layer, ed.touched);
    this.engine.markPixelsChanged();
  }

  private commitEdit(obj: VectorObject): boolean {
    const ed = this.edit!;
    this.edit = null;
    const layer = this.engine.layers.find((l) => l.id === ed.layerId);
    if (!layer) return false;
    layer.vecHold = false;
    const o = cloneVectorObject(obj);
    o.id = ed.original.id;
    o.name = ed.original.name;
    o.visible = true;
    let idx = layer.vectorObjects.findIndex((x) => x.id === ed.original.id);
    if (idx < 0) {
      idx = Math.min(ed.index, layer.vectorObjects.length);
      layer.vectorObjects.splice(idx, 0, o);
    }
    if (vectorObjectsEqual(o, ed.original)) {
      // nic się nie zmieniło: bez wpisu w historii (piksele wracają do stanu sprzed otwarcia)
      layer.vectorObjects[idx] = cloneVectorObject(ed.original);
      if (!ed.live || ed.version > 0) this.rebuild(layer, ed.touched);
      this.engine.markPixelsChanged();
      return true;
    }
    layer.vectorObjects[idx] = o;
    const rect = unionBounds(ed.touched, vectorObjectBounds(o));
    const before = this.mergedBefore(layer, ed.saved, rect);
    this.finish(layer, 'Edycja obiektu wektorowego', ed.objsBefore, rect, before);
    return true;
  }

  /** Edytowany obiekt zostaje usunięty (np. wyczyszczony tekst): jedna akcja historii. */
  public deleteEdited(): void {
    const ed = this.edit;
    if (!ed) return;
    this.edit = null;
    const layer = this.engine.layers.find((l) => l.id === ed.layerId);
    if (!layer) return;
    layer.vecHold = false;
    const idx = layer.vectorObjects.findIndex((o) => o.id === ed.original.id);
    if (idx >= 0) layer.vectorObjects.splice(idx, 1);
    this.setSelection(null, []);
    this.finish(layer, 'Usunięcie obiektu wektorowego', ed.objsBefore, ed.touched, this.mergedBefore(layer, ed.saved, ed.touched));
  }

  // ---- Operacje z panelu i klawiatury ----

  /** Wspólna ścieżka operacji na liście: migawka kafelków obszaru, zmiana, przebudowa, jedna akcja historii. */
  private applyOp(layer: Layer, description: string, rect: VecBounds, change: () => void): void {
    const objsBefore = cloneVectorObjects(layer.vectorObjects);
    this.pendingBefore = this.snapshot(layer, rect);
    change();
    this.finish(layer, description, objsBefore, rect, null);
  }

  private objectsOf(layer: Layer, ids: string[]): VectorObject[] {
    const set = new Set(ids);
    return layer.vectorObjects.filter((o) => set.has(o.id));
  }

  private boundsOfObjects(list: VectorObject[]): VecBounds | null {
    let b: VecBounds | null = null;
    for (const o of list) b = unionBounds(b, vectorObjectBounds(o));
    return b;
  }

  /** Ramka widocznego rysunku zaznaczonych obiektów (do nakładki na płótnie). */
  public selectionTightBounds(layer: Layer): VecBounds | null {
    const list = this.objectsOf(layer, this.selectedIds(layer)).filter((o) => o.visible);
    let b: VecBounds | null = null;
    for (const o of list) b = unionBounds(b, vectorObjectTightBounds(o));
    return b;
  }

  /** Obiekty (od góry), których widoczny rysunek dotyka prostokąta (zaznaczanie obszarem). */
  public objectsInRect(layer: Layer, r: { x0: number; y0: number; x1: number; y1: number }): string[] {
    if (!layer.isVector) return [];
    return layer.vectorObjects.filter((o) => o.visible && boundsIntersect(vectorObjectTightBounds(o), r)).map((o) => o.id);
  }

  public deleteObjects(layerIndex: number, ids: string[]): boolean {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked) return false;
    const list = this.objectsOf(layer, ids);
    if (list.length === 0) return false;
    const rect = this.boundsOfObjects(list)!;
    const set = new Set(ids);
    this.applyOp(layer, list.length > 1 ? 'Usunięcie obiektów wektorowych' : 'Usunięcie obiektu wektorowego', rect, () => {
      layer.vectorObjects = layer.vectorObjects.filter((o) => !set.has(o.id));
    });
    this.clearSelection();
    return true;
  }

  public removeObject(layerIndex: number, id: string): boolean {
    return this.deleteObjects(layerIndex, [id]);
  }

  /** Duplikuje obiekty tuż nad najwyższym z nich (z przesunięciem), zaznacza kopie i zwraca ich id. */
  public duplicateObjects(layerIndex: number, ids: string[], offset = 10): string[] {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked) return [];
    const list = this.objectsOf(layer, ids);
    if (list.length === 0) return [];
    const copies = list.map((o) => {
      const c = cloneVectorObject(o);
      c.id = newVectorId();
      c.visible = true;
      return translateVectorObject(c, offset, offset);
    });
    const rect = this.boundsOfObjects(copies)!;
    const topIdx = Math.max(...list.map((o) => layer.vectorObjects.indexOf(o)));
    this.applyOp(layer, list.length > 1 ? 'Duplikowanie obiektów' : 'Duplikowanie obiektu', rect, () => {
      layer.vectorObjects.splice(topIdx + 1, 0, ...copies);
    });
    layer.correctionsExpanded = true;
    this.setSelection(layer.id, copies.map((c) => c.id));
    return copies.map((c) => c.id);
  }

  public copyObjects(layerIndex: number, ids: string[]): boolean {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector) return false;
    const list = this.objectsOf(layer, ids);
    if (list.length === 0) return false;
    this.clipboard = cloneVectorObjects(list);
    this.pasteCount = 0;
    return true;
  }

  public cutObjects(layerIndex: number, ids: string[]): boolean {
    if (!this.copyObjects(layerIndex, ids)) return false;
    return this.deleteObjects(layerIndex, ids);
  }

  public get hasClipboard(): boolean {
    return this.clipboard.length > 0;
  }

  /** Wkleja obiekty ze schowka na szczyt warstwy (w to samo miejsce albo z kaskadowym przesunięciem), zaznacza je. */
  public pasteObjects(layerIndex: number, inPlace = false): string[] {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked || this.clipboard.length === 0) return [];
    this.pasteCount += inPlace ? 0 : 1;
    const off = inPlace ? 0 : 10 * this.pasteCount;
    const copies = this.clipboard.map((o) => {
      const c = cloneVectorObject(o);
      c.id = newVectorId();
      c.visible = true;
      return translateVectorObject(c, off, off);
    });
    const rect = this.boundsOfObjects(copies)!;
    this.applyOp(layer, copies.length > 1 ? 'Wklejenie obiektów' : 'Wklejenie obiektu', rect, () => {
      layer.vectorObjects.push(...copies);
    });
    layer.correctionsExpanded = true;
    this.setSelection(layer.id, copies.map((c) => c.id));
    return copies.map((c) => c.id);
  }

  /** Przesuwa zaznaczone obiekty o jedną pozycję w górę (dir=1) albo w dół (dir=-1) listy. */
  public shiftObjects(layerIndex: number, ids: string[], dir: 1 | -1): boolean {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked) return false;
    const set = new Set(ids);
    const arr = [...layer.vectorObjects];
    let changed = false;
    if (dir === 1) {
      for (let i = arr.length - 2; i >= 0; i--) {
        if (set.has(arr[i].id) && !set.has(arr[i + 1].id)) {
          [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
          changed = true;
        }
      }
    } else {
      for (let i = 1; i < arr.length; i++) {
        if (set.has(arr[i].id) && !set.has(arr[i - 1].id)) {
          [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
          changed = true;
        }
      }
    }
    if (!changed) return false;
    const rect = this.boundsOfObjects(layer.vectorObjects)!;
    this.applyOp(layer, 'Zmiana kolejności obiektów', rect, () => {
      layer.vectorObjects = arr;
    });
    return true;
  }

  // ---- Przesuwanie zaznaczonych obiektów ----

  public beginGroupMove(layerIndex: number, ids: string[]): boolean {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked || this.group) return false;
    const list = this.objectsOf(layer, ids);
    if (list.length === 0) return false;
    const originals = new Map<string, VectorObject>();
    for (const o of list) originals.set(o.id, cloneVectorObject(o));
    const rect = this.boundsOfObjects(list)!;
    const saved = new Map<number, TileSnapshot>();
    this.saveTiles(saved, layer, rect);
    this.group = { layerId: layer.id, originals, objsBefore: cloneVectorObjects(layer.vectorObjects), saved, touched: rect, dx: 0, dy: 0 };
    layer.vecHold = true;
    return true;
  }

  public get groupMoving(): boolean {
    return !!this.group;
  }

  /** Ustawia przesunięcie (od stanu początkowego) i przebudowuje dotknięty obszar. */
  public groupMoveTo(dx: number, dy: number): void {
    const g = this.group;
    if (!g) return;
    const layer = this.engine.layers.find((l) => l.id === g.layerId);
    if (!layer) return;
    dx = Math.round(dx);
    dy = Math.round(dy);
    if (dx === g.dx && dy === g.dy) return;
    let region: VecBounds | null = null;
    layer.vectorObjects = layer.vectorObjects.map((o) => {
      const orig = g.originals.get(o.id);
      if (!orig) return o;
      region = unionBounds(region, vectorObjectBounds(o));
      const moved = translateVectorObject(cloneVectorObject(orig), dx, dy);
      region = unionBounds(region, vectorObjectBounds(moved));
      return moved;
    });
    if (!region) return;
    g.dx = dx;
    g.dy = dy;
    this.saveTiles(g.saved, layer, region);
    // zapamiętane kafelki muszą pochodzić sprzed zmiany: migawki robimy zanim przebudujemy (tu już po zmianie listy, ale przed rebuild)
    this.rebuild(layer, region);
    g.touched = unionBounds(g.touched, region);
    this.engine.markPixelsChanged();
  }

  public endGroupMove(): boolean {
    const g = this.group;
    if (!g) return false;
    this.group = null;
    const layer = this.engine.layers.find((l) => l.id === g.layerId);
    if (!layer) return false;
    layer.vecHold = false;
    if (g.dx === 0 && g.dy === 0) {
      layer.updateThumbnail();
      return true;
    }
    const before = this.mergedBefore(layer, g.saved, g.touched);
    this.finish(layer, g.originals.size > 1 ? 'Przesunięcie obiektów' : 'Przesunięcie obiektu', g.objsBefore, g.touched, before);
    return true;
  }

  public cancelGroupMove(): void {
    const g = this.group;
    if (!g) return;
    this.group = null;
    const layer = this.engine.layers.find((l) => l.id === g.layerId);
    if (!layer) return;
    layer.vecHold = false;
    layer.vectorObjects = layer.vectorObjects.map((o) => g.originals.get(o.id) ?? o).map(cloneVectorObject);
    this.rebuild(layer, g.touched);
    this.engine.markPixelsChanged();
  }

  /** Zapisuje nową zawartość obiektu inteligentnego (po zamknięciu jego zakładki): jedna akcja historii. */
  public updateSmartContent(layerId: string, id: string, fig: string, png: string): boolean {
    this.settle();
    const layer = this.engine.layers.find((l) => l.id === layerId);
    if (!layer || !layer.isVector) return false;
    const o = layer.vectorObjects.find((x) => x.id === id);
    if (!o || o.kind !== 'smart') return false;
    if (o.fig === fig && o.png === png) return false;
    this.applyOp(layer, 'Edycja obiektu inteligentnego', vectorObjectBounds(o), () => {
      o.fig = fig;
      o.png = png;
      invalidateVectorObject(o);
    });
    return true;
  }

  /** Obiekt inteligentny o danym id (do otwarcia w zakładce). */
  public findSmart(layerId: string, id: string): import('./VectorObjects.ts').VecSmart | null {
    const layer = this.engine.layers.find((l) => l.id === layerId);
    const o = layer?.vectorObjects.find((x) => x.id === id);
    return o && o.kind === 'smart' ? o : null;
  }

  public setObjectVisible(layerIndex: number, id: string, visible: boolean): void {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked) return;
    const o = layer.vectorObjects.find((x) => x.id === id);
    if (!o || o.visible === visible) return;
    const b = vectorObjectBounds(o);
    this.applyOp(layer, visible ? 'Pokazanie obiektu' : 'Ukrycie obiektu', b, () => (o.visible = visible));
  }

  /** Ukrywa / pokazuje kilka obiektów naraz jako jeden wpis w historii. */
  public setObjectsVisible(layerIndex: number, ids: string[], visible: boolean): void {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked) return;
    const list = this.objectsOf(layer, ids).filter((o) => o.visible !== visible);
    if (list.length === 0) return;
    const rect = this.boundsOfObjects(list);
    if (!rect) return;
    this.applyOp(layer, visible ? 'Pokazanie obiektów' : 'Ukrycie obiektów', rect, () => {
      for (const o of list) o.visible = visible;
    });
  }

  public renameObject(layerIndex: number, id: string, name: string): void {
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector) return;
    const o = layer.vectorObjects.find((x) => x.id === id);
    if (!o) return;
    const nn = name.trim() || null;
    if (o.name === nn) return;
    this.mutate(layer, 'Zmiana nazwy obiektu', () => (o.name = nn), () => null);
    if (this.edit && this.edit.original.id === id) this.edit.original.name = nn;
  }

  /**
   * Przenosi obiekt na pozycję `toPos` (indeks w tablicy docelowej po wyjęciu obiektu) w tej samej albo innej warstwie wektorowej.
   */
  public moveObject(fromLayerIndex: number, id: string, toLayerIndex: number, toPos: number): boolean {
    this.settle();
    const e = this.engine;
    const from = e.layers[fromLayerIndex];
    const to = e.layers[toLayerIndex];
    if (!from || !to || !from.isVector || !to.isVector || from.locked || to.locked) return false;
    const idx = from.vectorObjects.findIndex((o) => o.id === id);
    if (idx < 0) return false;
    if (from === to) {
      const pos = Math.max(0, Math.min(toPos, from.vectorObjects.length - 1));
      if (pos === idx) return false;
      const lo = Math.min(idx, pos);
      const hi = Math.max(idx, pos);
      let b: VecBounds | null = null;
      for (let i = lo; i <= hi; i++) b = unionBounds(b, vectorObjectBounds(from.vectorObjects[i]));
      this.applyOp(from, 'Zmiana kolejności obiektów', b!, () => {
        const [o] = from.vectorObjects.splice(idx, 1);
        from.vectorObjects.splice(pos, 0, o);
      });
      return true;
    }
    // między warstwami: pełna migawka warstw (jedna akcja cofania obejmuje obie)
    e.saveFullSnapshot('Przeniesienie obiektu do innej warstwy');
    const [o] = from.vectorObjects.splice(idx, 1);
    const b = vectorObjectBounds(o);
    const pos = Math.max(0, Math.min(toPos, to.vectorObjects.length));
    to.vectorObjects.splice(pos, 0, o);
    this.rebuild(from, b);
    this.rebuild(to, b);
    this.setSelection(to.id, [o.id]);
    e.markPixelsChanged();
    return true;
  }

  /** Najwyższy obiekt widoczny pod punktem (od góry listy); tol w pikselach dokumentu. */
  public hitTest(layer: Layer, p: { x: number; y: number }, tol: number): VectorObject | null {
    if (!layer.isVector) return null;
    for (let i = layer.vectorObjects.length - 1; i >= 0; i--) {
      const o = layer.vectorObjects[i];
      if (!o.visible) continue;
      const b = vectorObjectBounds(o);
      if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) continue;
      if (hitTestVectorObject(o, p, tol)) return o;
    }
    return null;
  }

  /** Odtwarza całą warstwę (po wczytaniu pliku bez pikseli, po zmianie rozmiaru dokumentu): piksele leniwie, maska od razu. */
  public rebuildAll(layer: Layer): void {
    const all: VecBounds = { x0: 0, y0: 0, x1: this.engine.width, y1: this.engine.height };
    const was = layer.editMask;
    layer.editMask = false;
    this.rebuild(layer, all);
    if (layer.maskGrid && layer.maskObjects.length > 0) {
      layer.editMask = true;
      this.rebuild(layer, all);
    }
    layer.editMask = was;
  }
}
