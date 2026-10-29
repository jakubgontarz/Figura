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
interface VectorEdit {
  layerId: string;
  /** Pozycja w liście w chwili rozpoczęcia (zapasowa, gdy obiektu nie da się znaleźć po id). */
  index: number;
  original: VectorObject;
  objsBefore: VectorObject[];
  live: boolean;
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
    return l && l.isVector && !l.isGroup && !l.isAdjustment ? l : null;
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

  private snapshot(layer: Layer, b: VecBounds): TileSnapshot[] {
    const r = this.docRect(b);
    if (!r) return [];
    return layer.pixelGrid.getTilesIntersectingRect(r).map((t) => ({
      tx: t.tileX,
      ty: t.tileY,
      imgData: t.ctx.getImageData(0, 0, t.width, t.height),
      hasContent: t.hasContent,
    }));
  }

  /** Przebudowuje piksele warstwy w kafelkach przecinających prostokąt, rysując wszystkie widoczne obiekty od dołu do góry. */
  public rebuild(layer: Layer, b: VecBounds): void {
    const r = this.docRect(b);
    if (!r) return;
    const tiles = layer.pixelGrid.getTilesIntersectingRect(r);
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
    const actx = acc.getContext('2d')!;
    for (const o of hits) compositeVectorObject(actx, o, w, h, x0, y0);

    for (const t of tiles) {
      const tb: VecBounds = { x0: t.pixelX, y0: t.pixelY, x1: t.pixelX + t.width, y1: t.pixelY + t.height };
      t.clear();
      const any = hits.some((o) => boundsIntersect(vectorObjectBounds(o), tb));
      if (any) {
        t.ctx.drawImage(acc, t.pixelX - x0, t.pixelY - y0, t.width, t.height, 0, 0, t.width, t.height);
        t.hasContent = true;
        t.isDirty = true;
      }
    }
    layer.updateThumbnail();
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
    let before: TileSnapshot[] = [];
    let after: TileSnapshot[] = [];
    if (rect) {
      // „przed” = stan sprzed zmiany: migawka z chwili przed przebudową (albo zapamiętana przy wyjęciu obiektu)
      before = knownBefore ?? this.pendingBefore ?? [];
      this.pendingBefore = null;
      this.rebuild(layer, rect);
      after = this.snapshot(layer, rect);
    }
    e.pushTileAction({
      type: 'tiles',
      description,
      layerIndex: this.layerIndexOf(layer),
      onMask: false,
      before,
      after,
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

  private saveTiles(map: Map<number, TileSnapshot>, layer: Layer, b: VecBounds): void {
    for (const t of this.snapshot(layer, b)) {
      const k = t.ty * 65536 + t.tx;
      if (!map.has(k)) map.set(k, t);
    }
  }

  /** Stan „przed” = zapamiętane kafelki + kafelki obszaru `rect`, których edycja jeszcze nie dotknęła. */
  private mergedBefore(layer: Layer, saved: Map<number, TileSnapshot>, rect: VecBounds): TileSnapshot[] {
    const m = new Map(saved);
    this.saveTiles(m, layer, rect);
    return [...m.values()];
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
    this.rebuild(layer, region);
    ed.touched = unionBounds(ed.touched, region);
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

  public setObjectVisible(layerIndex: number, id: string, visible: boolean): void {
    this.settle();
    const layer = this.engine.layers[layerIndex];
    if (!layer || !layer.isVector || layer.locked) return;
    const o = layer.vectorObjects.find((x) => x.id === id);
    if (!o || o.visible === visible) return;
    const b = vectorObjectBounds(o);
    this.applyOp(layer, visible ? 'Pokazanie obiektu' : 'Ukrycie obiektu', b, () => (o.visible = visible));
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
    this.rebuild(layer, { x0: 0, y0: 0, x1: this.engine.width, y1: this.engine.height });
  }
}
