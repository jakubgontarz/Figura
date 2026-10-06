/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef } from 'react';
import {
  Plus,
  Minus,
  Copy,
  ArrowDown,
  ArrowUp,
  Merge,
  Eye,
  EyeOff,
  Lock,
  Unlock,
} from 'lucide-react';
import { Layer } from '../core/skia/Layer.ts';
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
  onReorderLayers: (fromIndex: number, toIndex: number) => void;
  onToggleVisibility: (index: number) => void;
  onToggleLock?: (index: number) => void;
  onChangeOpacity: (index: number, opacity: number, recordOldValue?: number) => void;
  onChangeBlendMode: (index: number, mode: SKBlendMode) => void;
  onRenameLayer: (index: number, newName: string) => void;
}

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
  onReorderLayers,
  onToggleVisibility,
  onToggleLock,
  onChangeOpacity,
  onChangeBlendMode,
  onRenameLayer,
}) => {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const startOpacityRef = useRef<number | null>(null);

  const activeLayer = layers[activeLayerIndex] || layers[0];

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

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (editingIndex !== null) return;
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (editingIndex !== null) return;
    if (draggedIndex !== null && draggedIndex !== targetIndex) {
      onReorderLayers(draggedIndex, targetIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const displayLayers = [...layers].map((layer, index) => ({ layer, index })).reverse();

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
      <div className="space-y-1.5 mb-2 bg-[#181818] p-1.5 rounded border border-[#2a2a2a] shrink-0 w-full">
        {/* Tryb Mieszania */}
        <div className="flex items-center justify-between gap-1.5 w-full">
          <label className="text-[10.5px] text-[#aaa] shrink-0">Tryb:</label>
          <select
            value={activeLayer?.blendMode || 'SrcOver'}
            onChange={(e) => onChangeBlendMode(activeLayerIndex, e.target.value as SKBlendMode)}
            className="h-5 flex-1 min-w-0 bg-[#222] border border-[#444] rounded px-1.5 text-[10.5px] text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
          >
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

      {/* Pasek narzędzi warstw ([+] [-] [duplikuj] [scal] [▲] [▼]) */}
      <div className="flex items-center justify-between gap-1 mb-1.5 shrink-0 w-full">
        <button
          type="button"
          onClick={onAddLayer}
          title="Dodaj nową warstwę"
          className="w-6 h-5.5 flex items-center justify-center bg-[#282828] hover:bg-[#383838] border border-[#3e3e3e] rounded text-[#ccc] hover:text-white transition-colors cursor-pointer"
        >
          <Plus size={12} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={onRemoveLayer}
          disabled={layers.length <= 1}
          title="Usuń warstwę"
          className={`w-6 h-5.5 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
            layers.length > 1 ? 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer' : 'opacity-40 cursor-default'
          }`}
        >
          <Minus size={12} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={onDuplicateLayer}
          title="Duplikuj warstwę"
          className="w-6 h-5.5 flex items-center justify-center bg-[#282828] hover:bg-[#383838] border border-[#3e3e3e] rounded text-[#ccc] hover:text-white transition-colors cursor-pointer"
        >
          <Copy size={11} />
        </button>
        <button
          type="button"
          onClick={onMergeDown}
          disabled={activeLayerIndex <= 0}
          title="Scal warstwę w dół"
          className={`w-6 h-5.5 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
            activeLayerIndex > 0 ? 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer' : 'opacity-40 cursor-default'
          }`}
        >
          <Merge size={11} />
        </button>
        <button
          type="button"
          onClick={onMoveUp}
          disabled={activeLayerIndex >= layers.length - 1}
          title="Przesuń w górę"
          className={`w-6 h-5.5 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
            activeLayerIndex < layers.length - 1
              ? 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer'
              : 'opacity-40 cursor-default'
          }`}
        >
          <ArrowUp size={11} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={activeLayerIndex <= 0}
          title="Przesuń w dół"
          className={`w-6 h-5.5 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
            activeLayerIndex > 0 ? 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer' : 'opacity-40 cursor-default'
          }`}
        >
          <ArrowDown size={11} />
        </button>
      </div>

      {/* Lista Warstw z obsługą Przeciągnij i Upuść */}
      <div className="flex-1 overflow-y-auto border border-[#2a2a2a] rounded bg-[#141414] p-1 space-y-1 min-h-[120px] w-full">
        {displayLayers.map(({ layer, index }) => {
          const isSelected = index === activeLayerIndex;
          const isDragOver = dragOverIndex === index;

          return (
            <div
              key={layer.id}
              draggable={editingIndex === null}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              onClick={() => onSelectLayer(index)}
              className={`flex items-center gap-2 p-1 rounded cursor-pointer border transition-all ${
                isSelected
                  ? 'bg-[#10549c] border-[#2980b9] text-white shadow-sm'
                  : 'bg-[#1e1e1e] hover:bg-[#282828] border-transparent text-[#cccccc]'
              } ${isDragOver ? 'border-t-2 border-t-[#00ffcc]' : ''}`}
            >
              {/* Miniatura Warstwy po lewej z nakładką (Oko + Kłódka) */}
              <div
                className="relative w-11 h-8 rounded-xs border border-[#444] overflow-hidden flex-shrink-0 shadow-inner group"
                style={{
                  backgroundImage: `repeating-conic-gradient(#e4e4e4 0% 25%, #ffffff 0% 50%)`,
                  backgroundSize: '8px 8px',
                }}
              >
                <img
                  src={layer.thumbnailCanvas.toDataURL()}
                  alt=""
                  className="w-full h-full object-contain"
                />

                {/* Nakładka przycisków w lewym dolnym rogu miniaturek */}
                <div className="absolute bottom-0.5 left-0.5 flex items-center gap-0.5 z-10">
                  {/* Przycisk Widoczności (Oko) */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleVisibility(index);
                    }}
                    title={layer.visible ? 'Ukryj warstwę' : 'Pokaż warstwę'}
                    className={`p-0.5 rounded transition-colors cursor-pointer ${
                      layer.visible
                        ? 'bg-black/60 hover:bg-black/80 text-white'
                        : 'bg-black/85 text-[#ff6666]'
                    }`}
                  >
                    {layer.visible ? (
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
                    title={layer.locked ? 'Odblokuj warstwę' : 'Zablokuj warstwę'}
                    className={`p-0.5 rounded transition-colors cursor-pointer ${
                      layer.locked
                        ? 'bg-amber-600/90 text-white shadow-xs'
                        : 'bg-black/50 hover:bg-black/80 text-[#ccc]'
                    }`}
                  >
                    {layer.locked ? (
                      <Lock size={9} strokeWidth={2.2} />
                    ) : (
                      <Unlock size={9} strokeWidth={2} />
                    )}
                  </button>
                </div>
              </div>

              {/* Nazwa Warstwy */}
              <div className="flex-1 min-w-0">
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
                    className="truncate block text-[11px] font-medium select-none"
                    title="Kliknij dwukrotnie, aby zmienić nazwę"
                  >
                    {layer.name}
                  </span>
                )}
              </div>

              {/* Wskaźnik trybu mieszania */}
              <div className="text-[9px] opacity-75 shrink-0">
                {layer.blendMode !== 'SrcOver' && (
                  <span className="bg-[#000]/40 px-1 py-0.5 rounded text-[8.5px] uppercase font-mono">
                    {layer.blendMode.slice(0, 3)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
