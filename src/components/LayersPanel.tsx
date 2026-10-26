/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Component,
  Copy,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FilePlus,
  Filter,
  FolderOpen,
  Folder,
  FolderPlus,
  GitMerge,
  Link2,
  Link2Off,
  Lock,
  PenTool,
  SlidersHorizontal,
  Sparkles,
  Split,
  SquareDashed,
  Trash2,
  Unlock,
  Wand2,
} from 'lucide-react';
import { Layer, subscribeThumbnails } from '../core/skia/Layer.ts';
import { BLEND_MODES, SKBlendMode } from '../core/skia/types.ts';
import { CORRECTION_DEFS, FILTER_DEFS, CorrectionType, correctionName, isFilterType } from '../core/skia/Corrections.ts';
import { stylesCount } from '../core/skia/Styles.ts';

interface LayersPanelProps {
  layers: Layer[];
  activeLayerIndex: number;
  onSelectLayer: (index: number) => void;
  onAddLayer: () => void;
  onRemoveLayer: () => void;
  onDuplicateLayer: () => void;
  onMergeDown: () => void;
  /** Aktywna warstwa ma korekcje: przycisk „Połącz w dół” działa jako „Zastosuj efekty” (wpieka korekcje bez łączenia). */
  mergeDownApplies?: boolean;
  applyEffectsMode?: 'none' | 'layer' | 'correction' | 'stack';
  /** Zaznaczony efekt wewnątrz warstwy (podświetlenie wiersza) */
  selectedCorrection?: { layerId: string; id: string } | null;
  onSelectCorrection?: (layerIndex: number, id: string) => void;
  /** Korekcja z listy wewnątrz warstwy -> samodzielny wpis stosu (before = nad, after = pod, into = szczyt grupy) */
  onMoveAdjustmentToLayer?: (adjIndex: number, toLayerIndex: number, insertIndex: number) => void;
  onMoveCorrectionToStack?: (fromLayerIndex: number, id: string, targetIndex: number, place: 'before' | 'after' | 'into') => void;
  /** Stylizacje warstwy: okno edycji (przycisk na dole panelu i przycisk efektu na pasku warstwy) */
  onOpenStyles?: (layerIndex: number) => void;
  /** Wspólne oko stylizacji na pasku warstwy */
  onToggleStylesVisible?: (layerIndex: number) => void;
  /** Warstwa, której stylizacje są właśnie edytowane w oknie */
  editingStylesLayerId?: string | null;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Przeciągnij i upuść: `before` = nad celem, `after` = pod celem, `into` = do wnętrza grupy. */
  onMoveLayerTo: (fromIndex: number, toIndex: number, place: 'before' | 'after' | 'into') => void;
  onAddGroup: () => void;
  onToggleExpand: (index: number) => void;
  onToggleVisibility: (index: number) => void;
  onToggleLock?: (index: number) => void;
  onChangeOpacity: (index: number, opacity: number, recordOldValue?: number) => void;
  onChangeBlendMode: (index: number, mode: SKBlendMode) => void;
  onRenameLayer: (index: number, newName: string) => void;
  /** Wybór celu edycji: piksele warstwy albo jej maska. */
  onSelectTarget: (index: number, target: 'pixels' | 'mask') => void;
  /** Podgląd maski w skali szarości na płótnie (null = powrót do zwykłego widoku). */
  onViewMask: (index: number | null) => void;
  maskViewIndex: number | null;
  onAddMask: () => void;
  onApplyMask: () => void;
  onToggleMaskEnabled: (index: number) => void;
  onToggleMaskLink: (index: number) => void;
  hasSelection: boolean;
  /** Korekcje nieniszczące: dodanie (otwiera okno), edycja, włączenie, usunięcie, przeniesienie (drag and drop), rozwijanie listy. */
  onOpenCorrection: (layerIndex: number, type: CorrectionType, onlyActive: boolean) => void;
  onEditCorrection: (layerIndex: number, id: string) => void;
  onToggleCorrection: (layerIndex: number, id: string) => void;
  onRemoveCorrection: (layerIndex: number, id: string) => void;
  onDuplicateCorrection: (layerIndex: number, id: string) => void;
  /** `insertIndex`: pozycja w tablicy docelowej warstwy liczona przed wyjęciem (duża liczba = na koniec) */
  onMoveCorrection: (fromLayerIndex: number, id: string, toLayerIndex: number, insertIndex: number) => void;
  onToggleCorrectionsExpanded: (layerIndex: number) => void;
  /** Id korekcji otwartej w oknie edycji (podświetlenie wiersza) */
  editingCorrectionId: string | null;
}

const IconBtn: React.FC<{
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  placeholder?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, disabled, placeholder, danger, children }) => {
  const inactive = disabled || placeholder;
  return (
    <button
      type="button"
      title={title}
      onClick={placeholder || disabled ? undefined : onClick}
      aria-disabled={inactive}
      className={`w-6 h-5.5 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
        disabled
          ? 'opacity-40 cursor-default text-[#ccc]'
          : placeholder
            ? 'opacity-60 cursor-default text-[#999]'
            : danger
              ? 'hover:bg-[#4a2a2a] text-[#e8a0a0] hover:text-white cursor-pointer'
              : 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer'
      }`}
    >
      {children}
    </button>
  );
};

/**
 * Miniatura warstwy jako element <canvas> kopiowany z płótna miniatury. Wcześniej był to <img> z adresem data: z
 * toDataURL, a ten odczyt wymusza synchroniczne dokończenie wszystkich zaległych operacji płótna (na dużym płótnie
 * to setki ms zacięcia tuż po pociągnięciu pędzlem).
 */
const ThumbCanvas: React.FC<{ source: HTMLCanvasElement; version: number }> = ({ source, version }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (c.width !== source.width) c.width = source.width;
    if (c.height !== source.height) c.height = source.height;
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(source, 0, 0);
  }, [source, version, source.width, source.height]);
  return <canvas ref={ref} width={source.width} height={source.height} className="w-full h-full object-contain" />;
};

export const LayersPanel: React.FC<LayersPanelProps> = ({
  layers,
  activeLayerIndex,
  onSelectLayer,
  onAddLayer,
  onRemoveLayer,
  onDuplicateLayer,
  onMergeDown,
  mergeDownApplies,
  applyEffectsMode,
  selectedCorrection,
  onSelectCorrection,
  onMoveCorrectionToStack,
  onMoveAdjustmentToLayer,
  onOpenStyles,
  onToggleStylesVisible,
  editingStylesLayerId,
  onMoveUp,
  onMoveDown,
  onMoveLayerTo,
  onAddGroup,
  onToggleExpand,
  onToggleVisibility,
  onToggleLock,
  onChangeOpacity,
  onChangeBlendMode,
  onRenameLayer,
  onSelectTarget,
  onViewMask,
  maskViewIndex,
  onAddMask,
  onApplyMask,
  onToggleMaskEnabled,
  onToggleMaskLink,
  hasSelection,
  onOpenCorrection,
  onEditCorrection,
  onToggleCorrection,
  onRemoveCorrection,
  onDuplicateCorrection,
  onMoveCorrection,
  onToggleCorrectionsExpanded,
  editingCorrectionId,
}) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<{ index: number; place: 'before' | 'after' | 'into' } | null>(null);

  const startOpacityRef = useRef<number | null>(null);

  // Korekcje: przeciągana korekcja, cel upuszczenia i menu dodawania
  const [corrDrag, setCorrDrag] = useState<{ layerIndex: number; id: string } | null>(null);
  const [corrOver, setCorrOver] = useState<{ layerIndex: number; id: string | null; place: 'before' | 'after' | 'into' } | null>(null);
  const [corrOnlyActive, setCorrOnlyActive] = useState(true);
  const [corrMenu, setCorrMenu] = useState<{ left: number; bottom: number; maxHeight: number; kind: 'corr' | 'filter' } | null>(null);
  const corrBtnRef = useRef<HTMLDivElement | null>(null);
  const filterBtnRef = useRef<HTMLDivElement | null>(null);

  // Miniatury odświeżają się z opóźnieniem (po zakończeniu edycji), więc panel musi zostać o tym powiadomiony
  const [, setThumbTick] = useState(0);
  useEffect(() => subscribeThumbnails(() => setThumbTick((t) => t + 1)), []);

  const activeLayer = layers[activeLayerIndex] || layers[0];
  const maskSelected = !!activeLayer?.hasMask && activeLayer.editMask;

  const handleStartRename = (index: number, currentName: string) => {
    setEditingIndex(index);
    setEditingName(currentName);
  };

  const handleFinishRename = (index: number) => {
    if (editingName.trim()) {
      onRenameLayer(index, editingName.trim());
    }
    setEditingIndex(null);
  };

  // Drag and Drop obsługa (blokowana podczas edycji nazwy warstwy)
  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (editingIndex !== null) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', index.toString());
    e.dataTransfer.effectAllowed = 'move';
    setDraggedIndex(index);
  };

  const canAcceptInto = (targetLayer: Layer): boolean => {
    if (draggedIndex === null) return false;
    const dragged = layers[draggedIndex];
    if (!dragged) return false;
    if (targetLayer === dragged) return false;
    if (targetLayer.isAdjustment) return false;
    // korekcja samodzielna: na grupę (szczyt grupy) albo na zwykłą warstwę (do jej listy efektów)
    if (dragged.isAdjustment) return true;
    if (targetLayer.isGroup) {
      return !dragged.isGroup;
    }
    // Zwykła warstwa może przyjąć inną warstwę jako maskę, jeśli sama nie ma jeszcze maski
    return !targetLayer.hasMask && !dragged.isGroup;
  };

  const placeFromEvent = (e: React.DragEvent, canInto: boolean): 'before' | 'after' | 'into' => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - rect.top) / Math.max(1, rect.height);
    if (canInto) return f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'into';
    return f < 0.5 ? 'before' : 'after';
  };

  /** Miejsce upuszczenia efektu na wierszu warstwy: brzegi = między warstwami, środek = do jej listy efektów (grupa: szczyt grupy). */
  const corrPlaceOnLayerRow = (e: React.DragEvent, target: Layer): 'before' | 'after' | 'into' => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = (e.clientY - rect.top) / Math.max(1, rect.height);
    if (target.isAdjustment) return f < 0.5 ? 'before' : 'after';
    return f < 0.28 ? 'before' : f > 0.72 ? 'after' : 'into';
  };

  const handleDragOver = (e: React.DragEvent, targetLayer: Layer, index: number) => {
    if (corrDrag) {
      // przeciągany jest efekt z listy warstwy: środek wiersza = do listy tej warstwy (grupy: na szczyt grupy), brzegi = między warstwy
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const place = corrPlaceOnLayerRow(e, targetLayer);
      if (place === 'into') {
        if (dragOver) setDragOver(null);
        if (!corrOver || corrOver.layerIndex !== index || corrOver.id !== null) setCorrOver({ layerIndex: index, id: null, place: 'into' });
      } else {
        if (corrOver) setCorrOver(null);
        if (!dragOver || dragOver.index !== index || dragOver.place !== place) setDragOver({ index, place });
      }
      return;
    }
    e.preventDefault();
    if (editingIndex !== null) return;
    e.dataTransfer.dropEffect = 'move';
    const canInto = canAcceptInto(targetLayer);
    const place = placeFromEvent(e, canInto);
    if (!dragOver || dragOver.index !== index || dragOver.place !== place) {
      setDragOver({ index, place });
    }
  };

  const handleDrop = (e: React.DragEvent, targetLayer: Layer, targetIndex: number) => {
    e.preventDefault();
    if (corrDrag) {
      const place = corrPlaceOnLayerRow(e, targetLayer);
      if (place === 'into' && !targetLayer.isGroup && !targetLayer.isAdjustment) {
        onMoveCorrection(corrDrag.layerIndex, corrDrag.id, targetIndex, Number.MAX_SAFE_INTEGER);
      } else {
        onMoveCorrectionToStack?.(corrDrag.layerIndex, corrDrag.id, targetIndex, place);
      }
      setCorrDrag(null);
      setCorrOver(null);
      setDragOver(null);
      return;
    }
    if (editingIndex !== null) return;
    const canInto = canAcceptInto(targetLayer);
    const place = placeFromEvent(e, canInto);
    if (draggedIndex !== null && draggedIndex !== targetIndex) {
      onMoveLayerTo(draggedIndex, targetIndex, place);
    }
    setDraggedIndex(null);
    setDragOver(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOver(null);
    setCorrDrag(null);
    setCorrOver(null);
  };

  const openCorrMenu = (kind: 'corr' | 'filter' = 'corr') => {
    const el = (kind === 'filter' ? filterBtnRef : corrBtnRef).current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = 214;
    setCorrMenu({
      kind,
      left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)),
      bottom: window.innerHeight - r.top + 4,
      maxHeight: Math.max(120, r.top - 12),
    });
  };

  // Wiersz korekcji pod warstwą: przeciąganie, zmiana kolejności, przenoszenie do innej warstwy
  const corrPlaceFromEvent = (e: React.DragEvent): 'before' | 'after' => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY - rect.top < rect.height / 2 ? 'before' : 'after';
  };


  // Widoczne wiersze (od góry): dzieci zwiniętych grup są pomijane
  const collapsedGroupIds = new Set(layers.filter((l) => l.isGroup && !l.expanded).map((l) => l.id));
  const displayLayers = [...layers]
    .map((layer, index) => ({ layer, index }))
    .reverse()
    .filter(({ layer }) => !(layer.groupId && collapsedGroupIds.has(layer.groupId)));

  return (
    <div className="bg-transparent text-xs select-none flex flex-col flex-1 min-h-0">
      {/* Pasek Zakładek (Tab Strip) */}
      <div className="flex items-center border-b border-[#333] mb-2 pb-0.5 shrink-0">
        <button
          type="button"
          className="text-[11px] font-semibold tracking-wide text-white border-b-2 border-[#007acc] pb-1 px-0.5 focus:outline-none cursor-pointer"
        >
          Warstwy
        </button>
      </div>

      {/* Opcje aktywnej warstwy: Tryb mieszania i Krycie */}
      <div
        className="space-y-1.5 mb-2 bg-[#181818] p-1.5 rounded border border-[#2a2a2a] shrink-0 w-full"
        title={
          activeLayer?.isGroup
            ? 'Przepuszczanie: warstwy grupy mieszają się z tym, co pod grupą (krycie i maska grupy dozują wynik). Inny tryb (np. Normalny): grupa jest najpierw składana osobno, potem nakładana tym trybem'
            : undefined
        }
      >
        {/* Tryb Mieszania */}
        <div className="flex items-center justify-between gap-1.5 w-full">
          <label className="text-[10.5px] text-[#aaa] shrink-0">Tryb:</label>
          <select
            value={activeLayer?.blendMode || (activeLayer?.isGroup ? 'PassThrough' : 'SrcOver')}
            onChange={(e) => onChangeBlendMode(activeLayerIndex, e.target.value as SKBlendMode)}
            disabled={!!activeLayer?.isAdjustment}
            className="h-5 flex-1 min-w-0 bg-[#222] border border-[#444] rounded px-1.5 text-[10.5px] text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
          >
            {activeLayer?.isGroup && (
              <option value="PassThrough">Przepuszczanie</option>
            )}
            {BLEND_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.namePl}
              </option>
            ))}
          </select>
        </div>

        {/* Suwak Krycia (Opacity) */}
        <div className="flex items-center justify-between gap-1.5 w-full">
          <label className="text-[10.5px] text-[#aaa] shrink-0">Krycie:</label>
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            <input
              type="range"
              min="0"
              max="100"
              value={Math.round((activeLayer?.opacity ?? 1) * 100)}
              onPointerDown={() => {
                startOpacityRef.current = activeLayer?.opacity ?? 1.0;
              }}
              onChange={(e) => {
                const val = parseInt(e.target.value) / 100;
                onChangeOpacity(activeLayerIndex, val, undefined);
              }}
              onPointerUp={(e) => {
                const val = parseInt((e.target as HTMLInputElement).value) / 100;
                if (startOpacityRef.current !== null) {
                  onChangeOpacity(activeLayerIndex, val, startOpacityRef.current);
                  startOpacityRef.current = null;
                }
              }}
              disabled={!!activeLayer?.isAdjustment}
              className="flex-1 min-w-0 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer disabled:opacity-40"
            />
            <span className="text-[10px] text-[#eee] font-mono w-8 text-right shrink-0">
              {Math.round((activeLayer?.opacity ?? 1) * 100)}%
            </span>
          </div>
        </div>
      </div>

      {/* Górny pasek: operacje na aktywnej warstwie */}
      <div className="flex items-center gap-1 mb-1.5 shrink-0 w-full">
        <IconBtn title="Przesuń w górę" onClick={onMoveUp}>
          <ArrowUp size={12} />
        </IconBtn>
        <IconBtn title="Przesuń w dół" onClick={onMoveDown}>
          <ArrowDown size={12} />
        </IconBtn>
        <IconBtn title={activeLayer?.isGroup ? 'Duplikuj grupę' : 'Duplikuj warstwę'} onClick={onDuplicateLayer}>
          <Copy size={12} />
        </IconBtn>
        <IconBtn
          title={
            activeLayer?.isGroup
              ? 'Scal grupę w jedną warstwę'
              : applyEffectsMode === 'stack'
                ? 'Zastosuj efekt (wpieka korekcję w warstwy pod nią: w grupie - w tej grupie, na poziomie głównym - we wszystkie)'
                : applyEffectsMode === 'correction'
                  ? 'Zastosuj efekt (wpieka zaznaczony efekt w piksele warstwy)'
                  : mergeDownApplies
                    ? 'Zastosuj efekty (wpieka wszystkie efekty warstwy w jej piksele, bez łączenia; kolejne kliknięcie połączy warstwę w dół)'
                    : 'Połącz w dół'
          }
          onClick={onMergeDown}
          disabled={activeLayerIndex <= 0 && !activeLayer?.isGroup && !mergeDownApplies}
        >
          {mergeDownApplies && !activeLayer?.isGroup ? <Wand2 size={12} /> : <GitMerge size={12} />}
        </IconBtn>
        <IconBtn title="Przekształć warstwę (rasteryzuj / obiekt inteligentny) - wkrótce" placeholder>
          <Component size={12} />
        </IconBtn>
        <div className="flex-1" />
        <IconBtn
          title={
            maskSelected
              ? 'Usuń maskę (zaznaczona jest maska)'
              : activeLayer?.isGroup
                ? 'Usuń grupę razem z jej warstwami'
                : activeLayer?.hasMask
                  ? 'Usuń warstwę razem z maską'
                  : 'Usuń warstwę'
          }
          onClick={onRemoveLayer}
          disabled={!selectedCorrection && layers.filter((l) => !l.isGroup && !l.isAdjustment).length <= 1 && !maskSelected && !activeLayer?.isGroup && !activeLayer?.isAdjustment}
          danger
        >
          <Trash2 size={12} />
        </IconBtn>
      </div>

      {/* Lista Warstw z obsługą Przeciągnij i Upuść */}
      <div className="flex-1 overflow-y-auto border border-[#2a2a2a] rounded bg-[#141414] p-1 space-y-1 min-h-[120px] w-full">
        {displayLayers.map(({ layer, index }) => {
          const isSelected = index === activeLayerIndex;
          const isGroup = layer.isGroup;
          const isChild = !!layer.groupId;
          const dropHere = dragOver && dragOver.index === index && ((draggedIndex !== null && draggedIndex !== index) || !!corrDrag) ? dragOver.place : null;
          const dimmed = !layer.ownVisible || layer.groupHidden;

          const corrInto = corrOver && corrOver.layerIndex === index && corrOver.id === null;
          const hasCorr = !isGroup && !layer.isAdjustment && layer.corrections.length > 0;
          // grupa pokazuje listę korekcji razem z listą swoich warstw (jeden przycisk rozwijania)
          const corrListOpen = hasCorr && layer.correctionsExpanded;
          const showBlend = layer.blendMode !== 'SrcOver' && layer.blendMode !== 'PassThrough';
          const nStyles = !isGroup && !layer.isAdjustment ? stylesCount(layer.styles) : 0;

          if (layer.isAdjustment) {
            // Korekcja samodzielna w stosie: działa na wszystko pod nią w tym kontenerze (grupie / całym obrazie)
            const adjDrop = dragOver && dragOver.index === index && draggedIndex !== null && draggedIndex !== index ? dragOver.place : null;
            const adjDropC = dragOver && dragOver.index === index && corrDrag ? dragOver.place : null;
            const dp = adjDrop ?? adjDropC;
            const adjHidden = !layer.ownVisible || layer.groupHidden;
            return (
              <div
                key={layer.id}
                draggable={editingIndex === null}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, layer, index)}
                onDrop={(e) => handleDrop(e, layer, index)}
                onDragEnd={handleDragEnd}
                onClick={() => onSelectLayer(index)}
                onDoubleClick={() => onEditCorrection(index, layer.corrections[0]?.id ?? '')}
                style={isChild ? { marginLeft: 14 } : undefined}
                title="Korekcja w stosie: działa na wszystko pod nią (w grupie: na warstwy pod nią w tej grupie). Dwukrotne kliknięcie: edytuj. Przeciągnij, aby przenieść między warstwy lub do listy efektów warstwy"
                className={`group flex items-center gap-1.5 h-[26px] pl-1 pr-1.5 rounded border cursor-pointer text-[10.5px] transition-all ${
                  isSelected ? 'bg-[#17454f] border-[#19b5cf] text-white' : 'bg-[#1b2a2e] hover:bg-[#223a40] border-[#25444c] text-[#cfe9ee]'
                } ${dp === 'before' ? 'border-t-2 border-t-[#00ffcc]' : ''} ${dp === 'after' ? 'border-b-2 border-b-[#00ffcc]' : ''}`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleVisibility(index);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={layer.ownVisible ? 'Wyłącz korekcję' : 'Włącz korekcję'}
                  className={`p-0.5 rounded cursor-pointer shrink-0 ${layer.ownVisible ? 'bg-black/60 hover:bg-black/90 text-white' : 'bg-black/80 text-[#ff6666]'}`}
                >
                  {layer.ownVisible ? <Eye size={10} strokeWidth={2.2} /> : <EyeOff size={10} strokeWidth={2.2} />}
                </button>
                {isFilterType(layer.corrections[0]?.type ?? 'invert') ? (
                  <Filter size={11} strokeWidth={2.2} className="shrink-0 text-[#6fd3e6]" />
                ) : (
                  <SlidersHorizontal size={11} strokeWidth={2.2} className="shrink-0 text-[#6fd3e6]" />
                )}
                <span className={`flex-1 min-w-0 truncate ${adjHidden || !layer.corrections[0]?.enabled ? 'opacity-50' : ''}`}>{correctionName(layer.corrections[0]?.type ?? 'invert')}</span>
              </div>
            );
          }

          return (
            <React.Fragment key={layer.id}>
            <div
              draggable={editingIndex === null}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, layer, index)}
              onDrop={(e) => handleDrop(e, layer, index)}
              onDragEnd={handleDragEnd}
              onClick={() => onSelectLayer(index)}
              style={isChild ? { marginLeft: 14 } : undefined}
              className={`relative flex items-center gap-2 p-1 rounded cursor-pointer border transition-all ${
                isSelected
                  ? 'bg-[#10549c] border-[#2980b9] text-white shadow-sm'
                  : 'bg-[#1e1e1e] hover:bg-[#282828] border-transparent text-[#cccccc]'
              } ${dropHere === 'before' ? 'border-t-2 border-t-[#00ffcc]' : ''} ${
                dropHere === 'after' ? 'border-b-2 border-b-[#00ffcc]' : ''
              } ${dropHere === 'into' || corrInto ? 'ring-2 ring-[#00ffcc]' : ''}`}
            >
              {/* Miniatura Warstwy: slot 35x35 bez szarej ramki i czarnego tła; ramka tylko wokół samej miniaturki */}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectTarget(index, 'pixels');
                }}
                title={layer.hasMask ? 'Edytuj piksele warstwy (przywraca zwykły widok)' : undefined}
                className={`relative w-[35px] h-[35px] min-w-[35px] min-h-[35px] max-w-[35px] max-h-[35px] flex items-center justify-center flex-shrink-0 cursor-pointer ${
                  dimmed ? 'opacity-60' : ''
                }`}
              >
                {isGroup ? (
                  <div
                    className={`w-[35px] h-[35px] rounded-xs border overflow-hidden flex items-center justify-center text-[#e0b84a] pb-2 ${
                      isSelected && !layer.editMask && layer.hasMask
                        ? 'border-[#00e5ff] ring-1 ring-[#00e5ff]'
                        : 'border-[#444] bg-[#242424]'
                    }`}
                  >
                    {layer.expanded ? <FolderOpen size={18} strokeWidth={1.6} /> : <Folder size={18} strokeWidth={1.6} />}
                  </div>
                ) : (
                  <div
                    style={{
                      width: layer.thumbW,
                      height: layer.thumbH,
                    }}
                    className={`relative rounded-xs border overflow-hidden shadow-xs flex items-center justify-center box-border ${
                      isSelected && !layer.editMask && layer.hasMask
                        ? 'border-[#00e5ff] ring-1 ring-[#00e5ff]'
                        : 'border-[#555]'
                    }`}
                  >
                    <ThumbCanvas source={layer.thumbnailCanvas} version={layer.thumbVersion} />
                  </div>
                )}

                {/* Nakładka przycisków w lewym dolnym rogu kwadracika 35x35 */}
                <div className="absolute bottom-0.5 left-0.5 flex items-center gap-0.5 z-10 pointer-events-auto">
                  {/* Przycisk Widoczności (Oko) */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleVisibility(index);
                    }}
                    title={
                      isGroup
                        ? layer.ownVisible ? 'Ukryj grupę' : 'Pokaż grupę'
                        : layer.ownVisible ? 'Ukryj warstwę' : 'Pokaż warstwę'
                    }
                    className={`p-0.5 rounded transition-colors cursor-pointer shadow-xs ${
                      layer.ownVisible
                        ? 'bg-black/70 hover:bg-black/90 text-white'
                        : 'bg-black/85 text-[#ff6666]'
                    }`}
                  >
                    {layer.ownVisible ? (
                      <Eye size={10} strokeWidth={2.2} />
                    ) : (
                      <EyeOff size={10} strokeWidth={2.2} />
                    )}
                  </button>

                  {/* Przycisk Blokady (Kłódka) */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleLock?.(index);
                    }}
                    title={
                      isGroup
                        ? layer.ownLocked ? 'Odblokuj grupę' : 'Zablokuj grupę (blokuje wszystkie jej warstwy)'
                        : layer.ownLocked ? 'Odblokuj warstwę' : 'Zablokuj warstwę'
                    }
                    className={`p-0.5 rounded transition-colors cursor-pointer shadow-xs ${
                      layer.ownLocked
                        ? 'bg-amber-600/90 text-white'
                        : layer.groupLocked
                          ? 'bg-amber-900/70 text-[#e8c46a]'
                          : 'bg-black/60 hover:bg-black/90 text-[#ccc]'
                    }`}
                  >
                    {layer.ownLocked || layer.groupLocked ? (
                      <Lock size={9} strokeWidth={2.2} />
                    ) : (
                      <Unlock size={9} strokeWidth={2} />
                    )}
                  </button>
                </div>
              </div>

              {/* Maska: slot 35x35 bez szarej ramki i czarnego tła; ramka tylko wokół samej miniaturki */}
              {layer.hasMask && (
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectTarget(index, 'mask');
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onViewMask(maskViewIndex === index ? null : index);
                  }}
                  title="Kliknij: edytuj maskę. Dwukrotne kliknięcie: pokaż maskę w skali szarości na płótnie"
                  className="relative w-[35px] h-[35px] min-w-[35px] min-h-[35px] max-w-[35px] max-h-[35px] flex items-center justify-center flex-shrink-0 cursor-pointer"
                >
                  <div
                    style={{
                      width: layer.thumbW,
                      height: layer.thumbH,
                    }}
                    className={`relative rounded-xs border overflow-hidden shadow-xs bg-black flex items-center justify-center box-border ${
                      isSelected && layer.editMask
                        ? 'border-[#00e5ff] ring-1 ring-[#00e5ff]'
                        : 'border-[#555]'
                    }`}
                  >
                    <ThumbCanvas source={layer.maskThumbnailCanvas} version={layer.thumbVersion} />
                  </div>
                  {maskViewIndex === index && (
                    <span className="absolute top-0 right-0 bg-[#00e5ff] text-black text-[7px] font-bold px-0.5 leading-tight z-10 rounded-xs shadow-xs pointer-events-none">
                      MASKA
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleMaskEnabled(index);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title={layer.maskEnabled ? 'Wyłącz maskę (pokaż warstwę bez maski)' : 'Włącz maskę'}
                    className={`absolute bottom-0.5 left-0.5 p-0.5 rounded cursor-pointer z-10 shadow-xs ${
                      layer.maskEnabled ? 'bg-black/70 hover:bg-black/90 text-white' : 'bg-black/85 text-[#ff6666]'
                    }`}
                  >
                    {layer.maskEnabled ? <Eye size={10} strokeWidth={2.2} /> : <EyeOff size={10} strokeWidth={2.2} />}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleMaskLink(index);
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                    title={
                      layer.maskLinked
                        ? 'Powiązana: przekształcenia zawartości zaznaczenia obejmują piksele i maskę (kliknij, aby rozłączyć)'
                        : 'Rozłączona: przekształcenia dotyczą tylko edytowanego elementu (kliknij, aby powiązać)'
                    }
                    className={`absolute bottom-0.5 right-0.5 p-0.5 rounded cursor-pointer z-10 shadow-xs bg-black/70 hover:bg-black/90 ${
                      layer.maskLinked ? 'text-[#9cdcfe]' : 'text-[#999]'
                    }`}
                  >
                    {layer.maskLinked ? <Link2 size={10} strokeWidth={2.2} /> : <Link2Off size={10} strokeWidth={2.2} />}
                  </button>
                </div>
              )}

              {/* Nazwa warstwy (1. linia) + skrót trybu mieszania, liczba efektów i rozwijanie (2. linia) */}
              <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
                <div className={dimmed ? 'opacity-60' : ''}>
                  {editingIndex === index ? (
                    <input
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onBlur={() => handleFinishRename(index)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleFinishRename(index);
                        if (e.key === 'Escape') setEditingIndex(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      className="w-full bg-[#111] text-white px-1 text-[11px] border border-[#007acc] rounded focus:outline-none"
                    />
                  ) : (
                    <span
                      onDoubleClick={() => handleStartRename(index, layer.name)}
                      className={`truncate block text-[11px] select-none ${isGroup ? 'font-semibold' : 'font-medium'}`}
                      title="Kliknij dwukrotnie, aby zmienić nazwę"
                    >
                      {layer.name}
                    </span>
                  )}
                </div>

                {(showBlend || hasCorr || isGroup || nStyles > 0) && (
                  <div className="flex items-center gap-1.5 h-[16px] min-w-0">
                    {showBlend && (
                      <span className="bg-[#000]/40 px-1 py-0.5 rounded text-[8.5px] uppercase font-mono opacity-75 shrink-0" title={`Tryb mieszania: ${layer.blendMode}`}>
                        {layer.blendMode.slice(0, 3)}
                      </span>
                    )}
                    {hasCorr && layer.corrections.some((c) => !isFilterType(c.type)) && (
                      <span
                        title={`Korekcje na warstwie: ${layer.corrections.filter((c) => !isFilterType(c.type)).length}`}
                        className="flex items-center gap-0.5 text-[9px] text-[#9cdcfe] shrink-0 opacity-90"
                      >
                        <SlidersHorizontal size={9} strokeWidth={2.2} />
                        {layer.corrections.filter((c) => !isFilterType(c.type)).length}
                      </span>
                    )}
                    {hasCorr && layer.corrections.some((c) => isFilterType(c.type)) && (
                      <span
                        title={`Filtry na warstwie: ${layer.corrections.filter((c) => isFilterType(c.type)).length}`}
                        className="flex items-center gap-0.5 text-[9px] text-[#9cdcfe] shrink-0 opacity-90"
                      >
                        <Filter size={9} strokeWidth={2.2} />
                        {layer.corrections.filter((c) => isFilterType(c.type)).length}
                      </span>
                    )}
                    {nStyles > 0 && (
                      <span className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectLayer(index);
                            onOpenStyles?.(index);
                          }}
                          onDoubleClick={(e) => e.stopPropagation()}
                          title={`Stylizacje warstwy: ${nStyles}. Kliknij, aby edytować`}
                          className={`flex items-center gap-0.5 px-0.5 rounded text-[9px] cursor-pointer hover:bg-black/40 ${
                            layer.styles?.visible === false ? 'text-[#777]' : 'text-[#ffd479]'
                          } ${editingStylesLayerId === layer.id ? 'bg-black/40' : ''}`}
                        >
                          <Sparkles size={9} strokeWidth={2.2} />
                          {nStyles}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleStylesVisible?.(index);
                          }}
                          onDoubleClick={(e) => e.stopPropagation()}
                          title={layer.styles?.visible === false ? 'Pokaż stylizacje warstwy' : 'Ukryj stylizacje warstwy'}
                          className="p-0.5 rounded text-[#ddd] hover:bg-black/40 cursor-pointer"
                        >
                          {layer.styles?.visible === false ? <EyeOff size={10} strokeWidth={2.2} /> : <Eye size={10} strokeWidth={2.2} />}
                        </button>
                      </span>
                    )}
                    <div className="flex-1" />
                    {/* Rozwiń / zwiń grupę */}
                    {isGroup && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleExpand(index);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={layer.expanded ? 'Zwiń grupę' : 'Rozwiń grupę'}
                        className="p-0.5 rounded bg-black/40 hover:bg-black/70 text-[#ddd] cursor-pointer shrink-0"
                      >
                        {layer.expanded ? <ChevronDown size={11} strokeWidth={2.4} /> : <ChevronRight size={11} strokeWidth={2.4} />}
                      </button>
                    )}
                    {/* Rozwiń / zwiń listę korekcji warstwy (ten sam przycisk co przy grupach) */}
                    {hasCorr && !isGroup && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleCorrectionsExpanded(index);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                        title={layer.correctionsExpanded ? 'Zwiń listę korekcji' : 'Rozwiń listę korekcji'}
                        className="p-0.5 rounded bg-black/40 hover:bg-black/70 text-[#ddd] cursor-pointer shrink-0"
                      >
                        {layer.correctionsExpanded ? <ChevronDown size={11} strokeWidth={2.4} /> : <ChevronRight size={11} strokeWidth={2.4} />}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Etykieta operacji Upuść w środek */}
              {corrInto && (
                <span className="absolute right-2 text-[9.5px] font-bold text-[#00ffcc] bg-black/90 border border-[#00ffcc]/50 px-1.5 py-0.5 rounded shadow-md pointer-events-none z-20">
                  {isGroup ? '+ Do grupy' : '+ Do warstwy'}
                </span>
              )}
              {dropHere === 'into' && (
                <span className="absolute right-2 text-[9.5px] font-bold text-[#00ffcc] bg-black/90 border border-[#00ffcc]/50 px-1.5 py-0.5 rounded shadow-md pointer-events-none z-20">
                  {isGroup ? '+ Do grupy' : draggedIndex !== null && layers[draggedIndex]?.isAdjustment ? '+ Do warstwy' : '+ Jako maska'}
                </span>
              )}
            </div>

            {/* Lista korekcji pod warstwą: od góry ostatnio stosowana. Przeciąganie zmienia kolejność lub przenosi do innej warstwy */}
            {corrListOpen && (
              <div style={{ marginLeft: (isChild ? 14 : 0) + 12 }} className="space-y-0.5">
                {layer.corrections
                  .map((c, ci) => ({ c, ci }))
                  .reverse()
                  .map(({ c, ci }) => {
                    const over = corrOver && corrOver.layerIndex === index && corrOver.id === c.id ? corrOver.place : null;
                    const beingDragged = !!corrDrag && corrDrag.layerIndex === index && corrDrag.id === c.id;
                    const editing = editingCorrectionId === c.id;
                    const picked = !!selectedCorrection && selectedCorrection.layerId === layer.id && selectedCorrection.id === c.id;
                    return (
                      <div
                        key={c.id}
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation();
                          e.dataTransfer.setData('text/plain', `correction:${c.id}`);
                          e.dataTransfer.effectAllowed = 'move';
                          setCorrDrag({ layerIndex: index, id: c.id });
                        }}
                        onDragOver={(e) => {
                          if (!corrDrag) {
                            if (draggedIndex !== null && layers[draggedIndex]?.isAdjustment && layers[draggedIndex] !== layer) {
                              e.preventDefault();
                              e.stopPropagation();
                              e.dataTransfer.dropEffect = 'move';
                              const place = corrPlaceFromEvent(e);
                              if (!corrOver || corrOver.layerIndex !== index || corrOver.id !== c.id || corrOver.place !== place) {
                                setCorrOver({ layerIndex: index, id: c.id, place });
                              }
                            }
                            return;
                          }
                          e.preventDefault();
                          e.stopPropagation();
                          e.dataTransfer.dropEffect = 'move';
                          const place = corrPlaceFromEvent(e);
                          if (!corrOver || corrOver.layerIndex !== index || corrOver.id !== c.id || corrOver.place !== place) {
                            setCorrOver({ layerIndex: index, id: c.id, place });
                          }
                        }}
                        onDrop={(e) => {
                          if (!corrDrag) {
                            if (draggedIndex !== null && layers[draggedIndex]?.isAdjustment) {
                              e.preventDefault();
                              e.stopPropagation();
                              const place = corrPlaceFromEvent(e);
                              onMoveAdjustmentToLayer?.(draggedIndex, index, place === 'before' ? ci + 1 : ci);
                              setDraggedIndex(null);
                              setDragOver(null);
                              setCorrOver(null);
                            }
                            return;
                          }
                          e.preventDefault();
                          e.stopPropagation();
                          const place = corrPlaceFromEvent(e);
                          // lista jest wyświetlana od końca: „nad” wierszem = później w tablicy
                          onMoveCorrection(corrDrag.layerIndex, corrDrag.id, index, place === 'before' ? ci + 1 : ci);
                          setCorrDrag(null);
                          setCorrOver(null);
                        }}
                        onDragEnd={handleDragEnd}
                        onClick={() => {
                          if (index !== activeLayerIndex) onSelectLayer(index);
                          onSelectCorrection?.(index, c.id);
                        }}
                        onDoubleClick={() => onEditCorrection(index, c.id)}
                        title="Dwukrotne kliknięcie: edytuj. Przeciągnij, aby zmienić kolejność lub przenieść na inną warstwę"
                        className={`group flex items-center gap-1.5 h-[22px] pl-1 pr-0.5 rounded border cursor-pointer text-[10.5px] ${
                          editing
                            ? 'border-[#00e5ff] bg-[#17313a]'
                            : picked
                              ? 'border-[#19b5cf] bg-[#17454f] text-white'
                              : 'border-[#2a2a2a] bg-[#191919] hover:bg-[#242424]'
                        } ${beingDragged ? 'opacity-40' : ''} ${over === 'before' ? 'border-t-2 border-t-[#00ffcc]' : ''} ${
                          over === 'after' ? 'border-b-2 border-b-[#00ffcc]' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleCorrection(index, c.id);
                          }}
                          onDoubleClick={(e) => e.stopPropagation()}
                          title={c.enabled ? 'Wyłącz korekcję' : 'Włącz korekcję'}
                          className={`p-0.5 rounded cursor-pointer shrink-0 ${
                            c.enabled ? 'bg-black/60 hover:bg-black/90 text-white' : 'bg-black/80 text-[#ff6666]'
                          }`}
                        >
                          {c.enabled ? <Eye size={10} strokeWidth={2.2} /> : <EyeOff size={10} strokeWidth={2.2} />}
                        </button>
                        {isFilterType(c.type) ? (
                          <Filter size={9} strokeWidth={2.2} className="shrink-0 text-[#6fd3e6] opacity-80" />
                        ) : (
                          <SlidersHorizontal size={9} strokeWidth={2.2} className="shrink-0 text-[#6fd3e6] opacity-80" />
                        )}
                        <span className={`flex-1 min-w-0 truncate ${c.enabled ? 'text-[#d4d4d4]' : 'text-[#777]'}`}>{correctionName(c.type)}</span>
                      </div>
                    );
                  })}
              </div>
            )}
            </React.Fragment>
          );
        })}
      </div>


      {/* Dolny pasek: tworzenie warstw i elementów warstwy */}
      <div className="flex items-center gap-1 mt-1.5 shrink-0 w-full">
        <IconBtn title="Nowa warstwa rastrowa" onClick={onAddLayer}>
          <FilePlus size={12} />
        </IconBtn>
        <IconBtn title="Nowa warstwa wektorowa - wkrótce" placeholder>
          <PenTool size={12} />
        </IconBtn>
        <IconBtn title="Nowa grupa warstw" onClick={onAddGroup}>
          <FolderPlus size={12} />
        </IconBtn>
        <div className="w-px h-4 bg-[#3a3a3a] mx-0.5" />
        {activeLayer?.isAdjustment ? (
          <IconBtn title="Korekcja w stosie nie ma maski" disabled>
            <SquareDashed size={12} />
          </IconBtn>
        ) : activeLayer?.isGroup && activeLayer.hasMask ? (
          <IconBtn
            title="Maski grupy nie da się wypiec w piksele (dotyczy złożenia warstw grupy). Zaznacz maskę i użyj kosza, aby ją usunąć, albo scal grupę"
            disabled
          >
            <Split size={12} />
          </IconBtn>
        ) : activeLayer?.hasMask ? (
          <IconBtn title="Wypiecz maskę (wpieka ją w piksele warstwy i usuwa)" onClick={onApplyMask}>
            <Split size={12} />
          </IconBtn>
        ) : (
          <IconBtn
            title={
              activeLayer?.isGroup
                ? hasSelection ? 'Dodaj maskę grupy z zaznaczenia (zaznaczone = widoczne)' : 'Dodaj maskę przezroczystości grupy'
                : hasSelection ? 'Dodaj maskę z zaznaczenia (zaznaczone = widoczne)' : 'Dodaj maskę przezroczystości'
            }
            onClick={onAddMask}
          >
            <SquareDashed size={12} />
          </IconBtn>
        )}
        <IconBtn
          title={
            activeLayer && (activeLayer.isGroup || activeLayer.isAdjustment)
              ? 'Stylizacje działają tylko na zwykłych warstwach rastrowych'
              : 'Stylizacje warstwy: cień, obrys, poświata, fazowanie, nakładki'
          }
          disabled={!activeLayer || activeLayer.isGroup || activeLayer.isAdjustment}
          onClick={() => onOpenStyles?.(activeLayerIndex)}
        >
          <Sparkles size={12} />
        </IconBtn>
        <div ref={corrBtnRef} className="relative">
          <IconBtn
            title={
              activeLayer?.isGroup
                ? 'Dodaj korekcję na szczyt grupy (działa na wszystkie warstwy grupy)'
                : activeLayer?.isAdjustment
                  ? 'Dodaj korekcję w stosie nad zaznaczoną (działa na warstwy pod nią)'
                  : 'Dodaj korekcję (nieniszczącą) do aktywnej warstwy'
            }
            onClick={() => (corrMenu?.kind === 'corr' ? setCorrMenu(null) : openCorrMenu('corr'))}
          >
            <SlidersHorizontal size={12} />
          </IconBtn>
        </div>
        <div ref={filterBtnRef} className="relative">
          <IconBtn
            title={
              activeLayer?.isGroup
                ? 'Dodaj filtr na szczyt grupy (działa na wszystkie warstwy grupy)'
                : activeLayer?.isAdjustment
                  ? 'Dodaj filtr w stosie nad zaznaczonym efektem (działa na warstwy pod nim)'
                  : 'Dodaj filtr (nieniszczący) do aktywnej warstwy'
            }
            onClick={() => (corrMenu?.kind === 'filter' ? setCorrMenu(null) : openCorrMenu('filter'))}
          >
            <Filter size={12} />
          </IconBtn>
        </div>
      </div>

      {/* Lista rozwijana korekcji (pozycjonowana względem okna, żeby nie była przycinana przez panel boczny) */}
      {corrMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setCorrMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCorrMenu(null); }} />
          <div
            role="menu"
            className="fixed z-50 w-[214px] overflow-y-auto bg-[#252526] border border-[#3e3e3e] rounded shadow-2xl py-1"
            style={{ left: corrMenu.left, bottom: corrMenu.bottom, maxHeight: corrMenu.maxHeight }}
          >
            <label className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] text-[#ddd] cursor-pointer border-b border-[#3e3e3e] mb-1" title="Włączone: efekt trafia do wnętrza warstwy (lub grupy). Wyłączone: efekt dodawany jest nad aktywną warstwą lub grupą i działa na warstwy pod nim">
              <input type="checkbox" checked={corrOnlyActive} onChange={(e) => setCorrOnlyActive(e.target.checked)} className="cursor-pointer" />
              tylko aktywna warstwa
            </label>
            <div className="px-2.5 pb-1 pt-0.5 text-[9.5px] uppercase tracking-wide text-[#777]">{corrMenu.kind === 'filter' ? 'Filtry' : 'Korekcje'}</div>
            {(corrMenu.kind === 'filter' ? FILTER_DEFS : CORRECTION_DEFS).map((d) => (
              <button
                key={d.type}
                type="button"
                role="menuitem"
                onClick={() => {
                  setCorrMenu(null);
                  onOpenCorrection(activeLayerIndex, d.type, corrOnlyActive);
                }}
                className="w-full text-left px-2.5 py-1 text-[11px] text-[#ddd] hover:bg-[#10549c] hover:text-white cursor-pointer"
              >
                {d.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
