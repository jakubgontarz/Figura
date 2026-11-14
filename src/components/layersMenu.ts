import type { Layer } from '../core/Layer.ts';
import { CORRECTION_DEFS, FILTER_DEFS, CorrectionType } from '../core/Corrections.ts';
import type { LayerTransformOp } from '../core/VectorObjects.ts';
import type { MenuEntry } from './MenuBar.tsx';

/** Działania menu „Warstwy”: te same, które wykonuje panel warstw (App.tsx wiąże je z silnikiem). */
export interface LayersMenuActions {
  addRaster: () => void;
  addVector: () => void;
  addGroup: () => void;
  remove: () => void;
  duplicate: () => void;
  flattenDown: () => void;
  flattenAll: () => void;
  toggleVisible: () => void;
  toggleLock: () => void;
  convert: () => void;
  transform: (op: LayerTransformOp) => void;
  openBlend: () => void;
  openOpacity: () => void;
  moveUp: () => void;
  moveDown: () => void;
  addRasterMask: () => void;
  addVectorMask: () => void;
  removeMask: () => void;
  maskFromSelection: () => void;
  bakeMask: () => void;
  toggleEditTarget: () => void;
  toggleMaskView: () => void;
  toggleMaskLink: () => void;
  toggleMaskEnabled: () => void;
  rasterizeMask: () => void;
  addCorrection: (type: CorrectionType) => void;
  addStyles: () => void;
  bakeEffects: () => void;
  setOnlyActive: (v: boolean) => void;
}

/** Stan potrzebny do ustalenia, które pozycje są dostępne i jak się nazywają. */
export interface LayersMenuState {
  layer: Layer;
  index: number;
  layerCount: number;
  /** liczba zwykłych warstw (bez grup i korekcji w stosie): ostatniej nie można usunąć */
  plainLayerCount: number;
  hasSelection: boolean;
  maskViewOn: boolean;
  objectSelection: boolean;
  correctionSelected: boolean;
  canEffects: boolean;
  canStyles: boolean;
  canBakeEffects: boolean;
  onlyActive: boolean;
}

const sep: MenuEntry = { sep: true };

/**
 * Menu „Warstwy”. Pozycje zmieniające stan (ukryj / pokaż, zablokuj / odblokuj, edytuj maskę / warstwę…) pokazują działanie,
 * które wykona kliknięcie. `state` = null oznacza brak dokumentu: wszystko jest wyszarzone.
 */
export function buildLayersMenu(state: LayersMenuState | null, act: LayersMenuActions): MenuEntry[] {
  const none = !state;
  const L = state?.layer;
  const isGroup = !!L?.isGroup;
  const isAdj = !!L?.isAdjustment;
  const isVec = !!L?.isVector && !isGroup && !isAdj;
  const hasMask = !!L?.hasMask;
  const noun = isGroup ? 'grupę' : isAdj ? 'korekcję' : 'warstwę';
  const editingMask = !!L && L.editMask && hasMask;
  const maskRaster = !!L?.maskRaster;

  const removeLabel = state?.objectSelection
    ? 'Usuń zaznaczone obiekty'
    : state?.correctionSelected
      ? 'Usuń zaznaczony efekt'
      : editingMask
        ? 'Usuń maskę'
        : isGroup
          ? 'Usuń grupę'
          : isAdj
            ? 'Usuń korekcję'
            : 'Usuń warstwę';
  const removeDisabled =
    none ||
    (!state!.objectSelection && !state!.correctionSelected && !editingMask && !isGroup && !isAdj && state!.plainLayerCount <= 1);

  const convertLabel = isVec && editingMask && !maskRaster ? 'Przekształć maskę na rastrową' : isVec ? 'Przekształć na warstwę rastrową' : 'Przekształć na warstwę wektorową';
  const convertDisabled = none || isGroup || isAdj || (isVec && editingMask && maskRaster);

  const flattenDownDisabled = none || (state!.index <= 0 && !isGroup && !isAdj);
  const flattenAllDisabled = none || state!.layerCount < 1;

  const noContent = none || isAdj;
  const effectEntries = (defs: typeof CORRECTION_DEFS): MenuEntry[] => [
    { label: 'tylko aktywna warstwa', checked: !!state?.onlyActive, keepOpen: true, onClick: () => act.setOnlyActive(!state?.onlyActive) },
    sep,
    ...defs.map((d): MenuEntry => ({ label: d.name, onClick: () => act.addCorrection(d.type) })),
  ];

  return [
    { label: 'Dodaj warstwę rastrową', onClick: act.addRaster, disabled: none },
    { label: 'Dodaj warstwę wektorową', onClick: act.addVector, disabled: none },
    { label: 'Dodaj grupę', onClick: act.addGroup, disabled: none },
    { label: removeLabel, onClick: act.remove, disabled: removeDisabled },
    { label: state?.objectSelection ? 'Duplikuj zaznaczone obiekty' : isGroup ? 'Duplikuj grupę' : 'Duplikuj', onClick: act.duplicate, disabled: none },
    { label: 'Spłaszcz w dół', onClick: act.flattenDown, disabled: flattenDownDisabled, hint: 'z efektami i maską' },
    { label: 'Spłaszcz wszystko', onClick: act.flattenAll, disabled: flattenAllDisabled },
    { label: L && !L.ownVisible ? `Pokaż ${noun}` : `Ukryj ${noun}`, onClick: act.toggleVisible, disabled: none },
    { label: L && L.ownLocked ? `Odblokuj ${noun}` : `Zablokuj ${noun}`, onClick: act.toggleLock, disabled: none },
    { label: convertLabel, onClick: act.convert, disabled: convertDisabled },
    sep,
    { label: 'Odbij w poziomie', onClick: () => act.transform('flipH'), disabled: noContent },
    { label: 'Odbij w pionie', onClick: () => act.transform('flipV'), disabled: noContent },
    sep,
    { label: 'Obróć w prawo', onClick: () => act.transform('cw'), disabled: noContent },
    { label: 'Obróć w lewo', onClick: () => act.transform('ccw'), disabled: noContent },
    { label: 'Obróć o 180°', onClick: () => act.transform('r180'), disabled: noContent },
    sep,
    { label: 'Tryb mieszania...', onClick: act.openBlend, disabled: noContent },
    { label: 'Przezroczystość...', onClick: act.openOpacity, disabled: noContent },
    sep,
    { label: 'Przesuń w górę', onClick: act.moveUp, disabled: none || (!state!.objectSelection && state!.index >= state!.layerCount - 1) },
    { label: 'Przesuń w dół', onClick: act.moveDown, disabled: none || (!state!.objectSelection && state!.index <= 0) },
    sep,
    { label: 'Dodaj maskę rastrową', onClick: act.addRasterMask, disabled: none || isAdj || hasMask },
    { label: 'Dodaj maskę wektorową', onClick: act.addVectorMask, disabled: none || !isVec || hasMask },
    { label: 'Usuń maskę', onClick: act.removeMask, disabled: none || !hasMask },
    { label: 'Stwórz maskę z zaznaczenia', onClick: act.maskFromSelection, disabled: none || isAdj || hasMask || !state!.hasSelection },
    { label: 'Wypiecz maskę', onClick: act.bakeMask, disabled: none || !hasMask || isGroup },
    { label: editingMask ? 'Edytuj warstwę' : 'Edytuj maskę', onClick: act.toggleEditTarget, disabled: none || !hasMask },
    { label: state?.maskViewOn ? 'Pokaż warstwę' : 'Pokaż maskę', onClick: act.toggleMaskView, disabled: none || !hasMask },
    { label: L && L.maskEnabled ? 'Wyłącz maskę' : 'Włącz maskę', onClick: act.toggleMaskEnabled, disabled: none || !hasMask },
    { label: L && L.maskLinked ? 'Odblokuj maskę' : 'Zablokuj maskę', onClick: act.toggleMaskLink, disabled: none || !hasMask, hint: L && L.maskLinked ? 'rozłącza z warstwą' : 'łączy z warstwą' },
    { label: 'Rasteryzuj maskę', onClick: act.rasterizeMask, disabled: none || !isVec || !hasMask || maskRaster },
    sep,
    { label: 'Dodaj filtr', submenu: effectEntries(FILTER_DEFS), disabled: none },
    { label: 'Dodaj korekcję', submenu: effectEntries(CORRECTION_DEFS), disabled: none },
    { label: 'Dodaj stylizacje', onClick: act.addStyles, disabled: none || !state!.canStyles },
    { label: 'Wypiecz efekty', onClick: act.bakeEffects, disabled: none || !state!.canBakeEffects },
  ];
}
