/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
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
} from 'lucide-react';
import { Layer, subscribeThumbnails } from '../core/skia/Layer.ts';
import { BLEND_MODES, SKBlendMode } from '../core/skia/types.ts';

interface LayersPanelProps {
  layers: Layer[];
  activeLayerIndex: number;
  onSelectLayer: (index: number) => void;
  onAddLayer: () => void;
  onRemoveLayer: () => void;
  onDuplicateLayer: () => void;
  onMergeDown: () => void;
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

export const LayersPanel: React.FC<LayersPanelProps> = ({
  layers,
  activeLayerIndex,
  onSelectLayer,
  onAddLayer,
  onRemoveLayer,
  onDuplicateLayer,
  onMergeDown,
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
}) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<{ index: number; place: 'before' | 'after' | 'into' } | null>(null);

  const startOpacityRef = useRef<number | null>(null);

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

  const handleDragOver = (e: React.DragEvent, targetLayer: Layer, index: number) => {
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
              className="flex-1 min-w-0 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
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
          title={activeLayer?.isGroup ? 'Scal grupę w jedną warstwę' : 'Połącz w dół'}
          onClick={onMergeDown}
          disabled={activeLayerIndex <= 0 && !activeLayer?.isGroup}
        >
          <GitMerge size={12} />
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
          disabled={layers.filter((l) => !l.isGroup).length <= 1 && !maskSelected && !activeLayer?.isGroup}
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
          const dropHere = dragOver && dragOver.index === index && draggedIndex !== null && draggedIndex !== index ? dragOver.place : null;
          const dimmed = !layer.ownVisible || layer.groupHidden;

          return (
            <div
              key={layer.id}
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
              } ${dropHere === 'into' ? 'ring-2 ring-[#00ffcc]' : ''}`}
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
                    <img
                      src={layer.getThumbnailDataUrl()}
                      alt=""
                      className="w-full h-full object-contain"
                    />
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
                    <img
                      src={layer.getMaskThumbnailDataUrl() ?? ''}
                      alt=""
                      className="w-full h-full object-contain"
                    />
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

              {/* Nazwa Warstwy */}
              <div className={`flex-1 min-w-0 ${dimmed ? 'opacity-60' : ''}`}>
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

              {/* Wskaźnik trybu mieszania */}
              {(
                <div className="text-[9px] opacity-75 shrink-0">
                  {layer.blendMode !== 'SrcOver' && layer.blendMode !== 'PassThrough' && (
                    <span className="bg-[#000]/40 px-1 py-0.5 rounded text-[8.5px] uppercase font-mono">
                      {layer.blendMode.slice(0, 3)}
                    </span>
                  )}
                </div>
              )}

              {/* Etykieta operacji Upuść w środek */}
              {dropHere === 'into' && (
                <span className="absolute right-2 text-[9.5px] font-bold text-[#00ffcc] bg-black/90 border border-[#00ffcc]/50 px-1.5 py-0.5 rounded shadow-md pointer-events-none z-20">
                  {isGroup ? '+ Do grupy' : '+ Jako maska'}
                </span>
              )}

              {/* Rozwiń / zwiń grupę: prawy dolny róg wiersza, tuż pod nazwą */}
              {isGroup && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand(index);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={layer.expanded ? 'Zwiń grupę' : 'Rozwiń grupę'}
                  className="absolute right-1 bottom-0.5 p-0.5 rounded bg-black/40 hover:bg-black/70 text-[#ddd] cursor-pointer"
                >
                  {layer.expanded ? <ChevronDown size={11} strokeWidth={2.4} /> : <ChevronRight size={11} strokeWidth={2.4} />}
                </button>
              )}
            </div>
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
        {activeLayer?.isGroup && activeLayer.hasMask ? (
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
        <IconBtn title="Dodaj stylizację - wkrótce" placeholder>
          <Sparkles size={12} />
        </IconBtn>
        <IconBtn title="Dodaj korekcję - wkrótce" placeholder>
          <SlidersHorizontal size={12} />
        </IconBtn>
        <IconBtn title="Dodaj filtr - wkrótce" placeholder>
          <Filter size={12} />
        </IconBtn>
      </div>
    </div>
  );
};
