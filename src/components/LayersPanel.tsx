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
  Sliders,
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

  // Drag and Drop obsługa (zmiana kolejności warstw)
  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.setData('text/plain', index.toString());
    e.dataTransfer.effectAllowed = 'move';
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
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
    <div className="border border-[#3c3c3c] bg-[#1e1e1e] rounded p-2 text-xs select-none flex flex-col flex-1">
      {/* Nagłówek Grupy */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-semibold text-[#c8c8c8] tracking-wide">Warstwy</span>
        <div className="h-[1px] bg-[#3a3a3a] flex-1" />
      </div>

      {/* Opcje aktywnej warstwy: Tryb mieszania i Krycie z pełną obsługą Undo/Redo */}
      <div className="space-y-1.5 mb-2.5 bg-[#181818] p-2 rounded border border-[#2c2c2c]">
        {/* Tryb Mieszania */}
        <div className="flex items-center justify-between gap-1">
          <label className="text-[11px] text-[#aaa] whitespace-nowrap">Tryb:</label>
          <select
            value={activeLayer?.blendMode || 'SrcOver'}
            onChange={(e) => onChangeBlendMode(activeLayerIndex, e.target.value as SKBlendMode)}
            className="h-5 flex-1 max-w-[155px] bg-[#222] border border-[#444] rounded px-1 text-[11px] text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
          >
            {BLEND_MODES.map((mode) => (
              <option key={mode.id} value={mode.id}>
                {mode.namePl}
              </option>
            ))}
          </select>
        </div>

        {/* Suwak Krycia (Opacity) */}
        <div className="flex items-center justify-between gap-2">
          <label className="text-[11px] text-[#aaa] whitespace-nowrap">Krycie:</label>
          <div className="flex items-center gap-1.5 flex-1">
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
              className="flex-1 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
            <span className="text-[11px] text-[#eee] font-mono w-9 text-right">
              {Math.round((activeLayer?.opacity ?? 1) * 100)}%
            </span>
          </div>
        </div>
      </div>

      {/* Pasek narzędzi warstw ([+] [-] [duplikuj] [scal] [▲] [▼]) */}
      <div className="flex items-center justify-end gap-1 mb-2">
        <button
          type="button"
          onClick={onAddLayer}
          title="Dodaj nową warstwę"
          className="w-6 h-6 flex items-center justify-center bg-[#282828] hover:bg-[#383838] border border-[#3e3e3e] rounded text-[#ccc] hover:text-white transition-colors cursor-pointer"
        >
          <Plus size={13} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={onRemoveLayer}
          disabled={layers.length <= 1}
          title="Usuń warstwę"
          className={`w-6 h-6 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
            layers.length > 1 ? 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer' : 'opacity-40 cursor-default'
          }`}
        >
          <Minus size={13} strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={onDuplicateLayer}
          title="Duplikuj warstwę"
          className="w-6 h-6 flex items-center justify-center bg-[#282828] hover:bg-[#383838] border border-[#3e3e3e] rounded text-[#ccc] hover:text-white transition-colors cursor-pointer"
        >
          <Copy size={12} />
        </button>
        <button
          type="button"
          onClick={onMergeDown}
          disabled={activeLayerIndex <= 0}
          title="Scal warstwę w dół"
          className={`w-6 h-6 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
            activeLayerIndex > 0 ? 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer' : 'opacity-40 cursor-default'
          }`}
        >
          <Sliders size={12} className="rotate-90" />
        </button>
        <button
          type="button"
          onClick={onMoveUp}
          disabled={activeLayerIndex >= layers.length - 1}
          title="Przesuń w górę"
          className={`w-6 h-6 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
            activeLayerIndex < layers.length - 1
              ? 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer'
              : 'opacity-40 cursor-default'
          }`}
        >
          <ArrowUp size={12} />
        </button>
        <button
          type="button"
          onClick={onMoveDown}
          disabled={activeLayerIndex <= 0}
          title="Przesuń w dół"
          className={`w-6 h-6 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors ${
            activeLayerIndex > 0 ? 'hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer' : 'opacity-40 cursor-default'
          }`}
        >
          <ArrowDown size={12} />
        </button>
      </div>

      {/* Lista Warstw z obsługą Przeciągnij i Upuść */}
      <div className="flex-1 overflow-y-auto border border-[#333] rounded bg-[#151515] p-1 space-y-1 min-h-[140px] max-h-[220px]">
        {displayLayers.map(({ layer, index }) => {
          const isSelected = index === activeLayerIndex;
          const isDragOver = dragOverIndex === index;

          return (
            <div
              key={layer.id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
              onClick={() => onSelectLayer(index)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer border transition-all ${
                isSelected
                  ? 'bg-[#10549c] border-[#2980b9] text-white shadow'
                  : 'bg-[#1e1e1e] hover:bg-[#282828] border-transparent text-[#cccccc]'
              } ${isDragOver ? 'border-t-2 border-t-[#00ffcc]' : ''}`}
            >
              {/* Checkbox Widoczności */}
              <input
                type="checkbox"
                checked={layer.visible}
                onChange={(e) => {
                  e.stopPropagation();
                  onToggleVisibility(index);
                }}
                className="rounded bg-[#121212] border-[#555] text-[#007acc] focus:ring-0 h-3.5 w-3.5 cursor-pointer"
                title={layer.visible ? 'Ukryj warstwę' : 'Pokaż warstwę'}
              />

              {/* Miniatura Warstwy */}
              <div
                className="w-10 h-7 border border-[#444] rounded-xs overflow-hidden flex-shrink-0 relative shadow-inner"
                style={{
                  backgroundImage: `repeating-conic-gradient(#aaa 0% 25%, #eee 0% 50%) 50% / 6px 6px`,
                }}
              >
                <img
                  src={layer.thumbnailCanvas.toDataURL()}
                  alt=""
                  className="w-full h-full object-contain"
                />
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
                    autoFocus
                    className="w-full bg-[#111] text-white px-1 text-xs border border-[#007acc] rounded focus:outline-none"
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
              <div className="text-[10px] opacity-75">
                {layer.blendMode !== 'SrcOver' && (
                  <span className="bg-[#000]/40 px-1 py-0.5 rounded text-[9px] uppercase font-mono">
                    {layer.blendMode.slice(0, 3)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[10px] text-[#777] text-center">
        Przeciągaj wiersze, aby zmienić kolejność warstw
      </div>
    </div>
  );
};
