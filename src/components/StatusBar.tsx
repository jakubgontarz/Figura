/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface StatusBarProps {
  statusText: string;
  docWidth: number;
  docHeight: number;
  zoom: number;
  onZoomChange: (newZoom: number) => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  statusText,
  docWidth,
  docHeight,
  zoom,
  onZoomChange,
}) => {

  return (
    <div className="h-6 bg-[#007acc] text-white select-none flex items-center justify-between px-3 text-[11px] font-normal z-20 shadow-md">
      {/* Lewa sekcja informacyjna */}
      <div className="flex items-center gap-5">
        <span className="font-medium">{statusText || 'Gotowy'}</span>
        <span className="opacity-90">
          {docWidth} × {docHeight} px
        </span>

        {/* Kontrolki Zoomu */}
        <div className="flex items-center gap-1.5 opacity-90 hover:opacity-100">
          <span>Zoom: {Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => onZoomChange(Math.max(0.05, Number((zoom - 0.25).toFixed(2))))}
            className="p-0.5 hover:bg-white/20 rounded cursor-pointer"
            title="Pomniejsz"
          >
            <ZoomOut size={11} />
          </button>
          <button
            type="button"
            onClick={() => onZoomChange(1.0)}
            className="p-0.5 hover:bg-white/20 rounded cursor-pointer"
            title="Reset do 100%"
          >
            <RotateCcw size={10} />
          </button>
          <button
            type="button"
            onClick={() => onZoomChange(Math.min(25.0, Number((zoom + 0.25).toFixed(2))))}
            className="p-0.5 hover:bg-white/20 rounded cursor-pointer"
            title="Powiększ"
          >
            <ZoomIn size={11} />
          </button>
        </div>
      </div>

      {/* Prawa sekcja: Współrzędne kursora aktualizowane z 0-opóźnieniem */}
      <div className="flex items-center gap-3 font-mono text-[11px]">
        <span id="status-bar-cursor-pos" className="opacity-90">
          Pozycja: 0, 0
        </span>
      </div>
    </div>
  );
};
