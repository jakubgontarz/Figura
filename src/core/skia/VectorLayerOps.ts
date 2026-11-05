/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GraphicEngine } from './GraphicEngine.ts';
import type { Layer } from './Layer.ts';
import type { TileSnapshot } from './TileGrid.ts';
import {
  VecBounds,
  VectorObject,
  boundsIntersect,
  cloneVectorObject,
  cloneVectorObjects,
  compositeVectorObject,
  hitTestVectorObject,
  newVectorId,
  translateVectorObject,
  unionBounds,
  vectorObjectBlend,
  vectorObjectBounds,
  vectorObjectTightBounds,
  vectorObjectKey,
  vectorObjectsEqual,
} from './VectorObjects.ts';

/**
 * Stan edycji istniejącego obiektu (Manipulacja). Obiekt NIE opuszcza listy warstwy ani swojego miejsca w kolejności.
 * Tryb `live` (nad obiektem leżą inne): piksele warstwy są przebudowywane przy każdej zmianie obiektu, więc kolejność,
 * tryby mieszania i efekty są takie jak po zatwierdzeniu. Tryb sprite (obiekt na samej górze): obiekt jest pominięty w pikselach,
 * a podgląd rysuje nakładka (jak przy nowym obiekcie).
 */
interface LiveCache {
  below: HTMLCanvasElement;
  above: HTMLCanvasElement;
  filled: Set<number>;
  belowList: VectorObject[];
  aboveList: VectorObject[];
}

const CHUNK = 512;
/** Powyżej tylu pikseli dokumentu pamięci podręcznej sesji nie tworzymy (dwa bufory pełnego rozmiaru) */
const LIVE_CACHE_MAX_PIXELS = 16_000_000;

interface VectorEdit {
  layerId: string;
  /** Pozycja w liście w chwili rozpoczęcia (zapasowa, gdy obiektu nie da się znaleźć po id). */
  index: number;
  original: VectorObject;
  objsBefore: VectorObject[];
  live: boolean;
  /** piksele warstwy nie nadążają za obiektem (przebudowa odroczona do zatwierdzenia) */
  deferred?: boolean;
  /** pamięć podręczna sesji: obiekty pod edytowanym i nad nim złożone osobno, wypełniana kawałkami przy pierwszym użyciu */
  cache?: LiveCache | null;
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

  /** Przebudowuje piksele warstwy w kafelkach przecinających prostokąt, rysując wszystkie widoczne obiekty od dołu do góry. */
  public rebuild(layer: Layer, b: VecBounds): void {
    const r = this.docRect(b);
    if (!r) return;
    const onMask = layer.editMask && !!layer.maskGrid;
    if (onMask && layer.maskRaster) return; // maska rastrowa nie jest pochodną obiektów
    // maska warstwy wektorowej = podkład + jej obiekty; podkład zapamiętujemy przed pierwszą przebudową
    if (onMask && !layer.maskBase) layer.maskBase = layer.maskGrid!.clone();
    const tiles = layer.tileGrid.getTilesIntersectingRect(r);
    if (tiles.length === 0) return;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const t of tiles) {
      x0 = Math.min(x0, t.pixelX);
      y0 = Math.min(y0, t.pixelY);
      x1 = Math.max(x1, t.pixelX + t.width);
      y1 = Math.max(y1, t.pixelY + t.height);
    }
    const w = x1 - x0;
    const h = y1 - y0;
    const region: VecBounds = { x0, y0, x1, y1 };
    const hideId = this.edit && !this.edit.live && this.edit.layerId === layer.id ? this.edit.original.id : null;
    const list = layer.vectorObjects.filter((o) => o.visible && o.id !== hideId);
    const hits = list.filter((o) => boundsIntersect(vectorObjectBounds(o), region));

    const acc = document.createElement('canvas');
    acc.width = w;
    acc.height = h;
    const actx = acc.getContext('2d', { willReadFrequently: true })!;
    const lc = !onMask ? this.liveCache(layer) : null;
    if (lc) {
      // edycja obiektu leżącego pod innymi: obiekty poniżej i powyżej są gotowe w buforach, rysujemy tylko edytowany
      this.fillLiveCache(lc, x0, y0, x1, y1);
      actx.drawImage(lc.below, x0, y0, w, h, 0, 0, w, h);
      const eo = layer.vectorObjects.find((o) => o.id === this.edit!.original.id);
      if (eo && eo.visible) {
        const ob = vectorObjectBounds(eo);
        if (boundsIntersect(ob, region)) compositeVectorObject(actx, eo, w, h, x0, y0, (ob.x1 - ob.x0) * (ob.y1 - ob.y0) > 4 * w * h, true);
      }
      actx.drawImage(lc.above, x0, y0, w, h, 0, 0, w, h);
    }
    // maska: obiekty (także w trybach mieszania, np. Ekran) są składane na podkładzie maski
    if (onMask) {
      for (const t of tiles) {
        const bt = layer.maskBase!.getTile(t.tileX, t.tileY);
        if (bt && bt.hasContent) actx.drawImage(bt.canvas, t.pixelX - x0, t.pixelY - y0);
      }
    }
    // Obiekt wielokrotnie większy od przebudowywanego obszaru (np. tło na całe płótno) rasteryzujemy tylko w tym obszarze,
    // a nie w całości przy każdej klatce edycji. Pozostałe jak dawniej (przycięcie minimalnie zmienia brzegi niektórych ścieżek).
    if (!lc) {
      for (const o of hits) {
        const ob = vectorObjectBounds(o);
        const huge = (ob.x1 - ob.x0) * (ob.y1 - ob.y0) > 4 * w * h;
        compositeVectorObject(actx, o, w, h, x0, y0, huge, true);
      }
    }

    for (const t of tiles) {
      const tb: VecBounds = { x0: t.pixelX, y0: t.pixelY, x1: t.pixelX + t.width, y1: t.pixelY + t.height };
      t.clear();
      const baseHas = onMask && !!layer.maskBase!.getTile(t.tileX, t.tileY)?.hasContent;
      const any = baseHas || hits.some((o) => boundsIntersect(vectorObjectBounds(o), tb));
      if (any) {
        t.ctx.drawImage(acc, t.pixelX - x0, t.pixelY - y0, t.width, t.height, 0, 0, t.width, t.height);
        t.hasContent = true;
        t.isDirty = true;
      }
    }
    layer.updateThumbnail();
  }

  /** Pamięć podręczna sesji edycji na żywo (tylko gdy nad edytowanym leżą wyłącznie zwykłe obiekty, a dokument nie jest ogromny). */
  private liveCache(layer: Layer): LiveCache | null {
    const ed = this.edit;
    if (!ed || !ed.live || ed.layerId !== layer.id) return null;
    if (ed.cache !== undefined) return ed.cache;
    ed.cache = null;
    if (this.engine.width * this.engine.height > LIVE_CACHE_MAX_PIXELS) return null;
    const idx = layer.vectorObjects.findIndex((o) => o.id === ed.original.id);
    if (idx < 0) return null;
    const vis = (o: VectorObject) => o.visible;
    const aboveList = layer.vectorObjects.slice(idx + 1).filter(vis);
    if (aboveList.some((o) => vectorObjectBlend(o) !== 'SrcOver')) return null;
    const mk = () => {
      const c = document.createElement('canvas');
      c.width = this.engine.width;
      c.height = this.engine.height;
      return c;
    };
    ed.cache = { below: mk(), above: mk(), filled: new Set(), belowList: layer.vectorObjects.slice(0, idx).filter(vis), aboveList };
    return ed.cache;
  }

  /** Wypełnia kawałki (CHUNK x CHUNK) buforów pamięci podręcznej, które przecina prostokąt. */
  private fillLiveCache(lc: LiveCache, x0: number, y0: number, x1: number, y1: number): void {
    const W = this.engine.width;
    const H = this.engine.height;
    const perRow = Math.ceil(W / CHUNK);
    for (let cy = Math.floor(y0 / CHUNK); cy <= Math.floor((y1 - 1) / CHUNK); cy++) {
      for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor((x1 - 1) / CHUNK); cx++) {
        const id = cy * perRow + cx;
        if (lc.filled.has(id)) continue;
        lc.filled.add(id);
        const px = cx * CHUNK;
        const py = cy * CHUNK;
        const cw = Math.min(CHUNK, W - px);
        const ch = Math.min(CHUNK, H - py);
        if (cw <= 0 || ch <= 0) continue;
        const rect: VecBounds = { x0: px, y0: py, x1: px + cw, y1: py + ch };
        for (const [list, target] of [[lc.belowList, lc.below], [lc.aboveList, lc.above]] as const) {
          const hits = list.filter((o) => boundsIntersect(vectorObjectBounds(o), rect));
          if (hits.length === 0) continue;
          const c = document.createElement('canvas');
          c.width = cw;
          c.height = ch;
          const cctx = c.getContext('2d', { willReadFrequently: true })!;
          for (const o of hits) {
            const ob = vectorObjectBounds(o);
            compositeVectorObject(cctx, o, cw, ch, px, py, (ob.x1 - ob.x0) * (ob.y1 - ob.y0) > 4 * cw * ch, true);
          }
          target.getContext('2d', { willReadFrequently: true })!.drawImage(c, px, py);
        }
      }
    }
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
    if (!live) this.rebuild(layer, rect); // obiekt na wierzchu: piksele bez niego, podgląd rysuje nakładka
    this.engine.markPixelsChanged();
    return cloneVectorObject(original);
  }

  /** Czy edytowany obiekt jest odtwarzany w pikselach warstwy na bieżąco (a nie nakładką). */
  /** Ustawiane przez widok, gdy podgląd na żywo rysuje wektory bez pikseli warstwy (tryb Wektory, GPU). */
  public deferLiveRebuild = false;

  /** Czy piksele edytowanej warstwy zostały w tyle za obiektem (odroczona przebudowa). */
  public get hasDeferred(): boolean {
    return !!this.edit?.deferred;
  }

  /** Dogania piksele warstwy z edytowanym obiektem (gdy widok przestaje rysować wektory sam). */
  public flushDeferred(): void {
    const ed = this.edit;
    if (!ed || !ed.deferred) return;
    const layer = this.findEditLayer();
    ed.deferred = false;
    if (!layer) return;
    this.rebuild(layer, ed.touched);
    this.engine.markPixelsChanged();
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
    if (this.deferLiveRebuild) {
      // widok wektorowy (GPU) rysuje obiekty z listy, więc piksele warstwy są zbędne do czasu zatwierdzenia (wtedy jedna przebudowa)
      ed.deferred = true;
    } else {
      this.rebuild(layer, ed.deferred ? ed.touched : region);
      ed.deferred = false;
    }
    ed.version++;
    this.engine.markPixelsChanged();
  }

  public cancelEdit(): void {
    const ed = this.edit;
    if (!ed) return;
    this.edit = null;
    const layer = this.engine.layers.find((l) => l.id === ed.layerId);
    if (!layer) return;
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
    if (g.dx === 0 && g.dy === 0) return true;
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

  /** Przebudowuje całą warstwę (po wczytaniu pliku bez pikseli, po zmianie rozmiaru dokumentu). */
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
