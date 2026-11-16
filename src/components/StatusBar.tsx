/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Magnet, Hash, Ruler, Grid3x3 } from 'lucide-react';
import { LENGTH_UNITS, LengthUnit, UNIT_LABEL, fmtUnit } from '../core/Units.ts';

interface StatusBarProps {
  statusText: string;
  docWidth: number;
  docHeight: number;
  zoom: number;
  onZoomChange: (newZoom: number) => void;
  /** Dokument obiektu inteligentnego: wymiary zawsze w pikselach, przełącznik jednostek nieaktywny. */
  unitsLocked?: boolean;
  unit?: LengthUnit;
  onUnitChange?: (u: LengthUnit) => void;
  dpi?: number;
  snapEnabled?: boolean;
  onToggleSnap?: () => void;
  guidesVisible?: boolean;
  onToggleGuides?: () => void;
  rulersVisible?: boolean;
  onToggleRulers?: () => void;
  gridVisible?: boolean;
  onToggleGrid?: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  statusText,
  docWidth,
  docHeight,
  zoom,
  onZoomChange,
  unitsLocked = false,
  unit = 'px',
  onUnitChange,
  dpi = 96,
  snapEnabled = false,
  onToggleSnap,
  guidesVisible = true,
  onToggleGuides,
  rulersVisible = false,
  onToggleRulers,
  gridVisible = false,
  onToggleGrid,
}) => {

  const seg = (active: boolean, locked: boolean) =>
    `px-2 py-px text-[10.5px] ${active ? 'bg-[color:var(--h-333333,#333333)] text-[color:var(--t-white,#fff)] font-semibold' : 'bg-transparent text-[color:var(--h-a0a0a0,#a0a0a0)] hover:text-[color:var(--t-white,#fff)] hover:bg-[color:var(--h-333333,#333333)]/50'} ${locked ? 'opacity-60 cursor-default' : 'cursor-pointer'}`;

  return (
    <div className="h-6 bg-[color:var(--h-1e1e1e,#1e1e1e)] text-[color:var(--h-cccccc,#cccccc)] border-t border-[color:var(--h-111111,#111111)] select-none flex items-center gap-4 px-3 text-[11px] font-normal z-20 shadow-md">
      {/* Lewa sekcja: wymiary obrazu i zoom */}
      <span className="opacity-90 whitespace-nowrap">
        {`${fmtUnit(docWidth, unit, dpi)} × ${fmtUnit(docHeight, unit, dpi)} ${UNIT_LABEL[unit]}`}
      </span>

      {/* Kontrolki Zoomu */}
      <div className="flex items-center gap-1.5 opacity-90 hover:opacity-100 whitespace-nowrap">
        <span>Zoom: {Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => onZoomChange(Math.max(0.05, Number((zoom - 0.25).toFixed(2))))} className="p-0.5 hover:bg-[color:var(--h-333333,#333333)] rounded cursor-pointer" title="Pomniejsz">
          <ZoomOut size={11} />
        </button>
        <button type="button" onClick={() => onZoomChange(1.0)} className="p-0.5 hover:bg-[color:var(--h-333333,#333333)] rounded cursor-pointer" title="Reset do 100%">
          <RotateCcw size={10} />
        </button>
        <button type="button" onClick={() => onZoomChange(Math.min(25.0, Number((zoom + 0.25).toFixed(2))))} className="p-0.5 hover:bg-[color:var(--h-333333,#333333)] rounded cursor-pointer" title="Powiększ">
          <ZoomIn size={11} />
        </button>
      </div>

      {/* Podpowiedź narzędzia */}
      <div id="status-bar-hint" data-testid="status-hint" className="flex-1 min-w-0 truncate font-medium" title={statusText || undefined}>
        {statusText}
      </div>

      {/* Przełącznik jednostki wymiarów */}
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <div className="flex rounded overflow-hidden border border-[color:var(--h-444444,#444444)]" title="Jednostka wymiarów">
          {LENGTH_UNITS.map((u) => (
            <button key={u} type="button" data-testid={`status-unit-${u}`} disabled={unitsLocked} onClick={() => onUnitChange?.(u)} className={seg(unit === u, unitsLocked)}>
              {UNIT_LABEL[u]}
            </button>
          ))}
        </div>
      </div>

      {/* Przyciski ikonowe (spójny styl z resztą przełączników) */}
      <div className="flex items-center gap-1 whitespace-nowrap">
        <button
          type="button"
          data-testid="status-snap"
          aria-pressed={snapEnabled}
          title="Przyciąganie"
          onClick={() => onToggleSnap?.()}
          className={`p-1 rounded border text-[10.5px] cursor-pointer transition-colors ${
            snapEnabled
              ? 'bg-[color:var(--h-333333,#333333)] text-[color:var(--t-white,#fff)] border-[color:var(--h-444444,#444444)]'
              : 'bg-transparent text-[color:var(--h-a0a0a0,#a0a0a0)] border-[color:var(--h-444444,#444444)] hover:bg-[color:var(--h-333333,#333333)]/50 hover:text-[color:var(--t-white,#fff)]'
          }`}
        >
          <Magnet size={12} />
        </button>

        <button
          type="button"
          data-testid="status-rulers"
          aria-pressed={rulersVisible}
          title="Linijka"
          onClick={() => onToggleRulers?.()}
          className={`p-1 rounded border text-[10.5px] cursor-pointer transition-colors ${
            rulersVisible
              ? 'bg-[color:var(--h-333333,#333333)] text-[color:var(--t-white,#fff)] border-[color:var(--h-444444,#444444)]'
              : 'bg-transparent text-[color:var(--h-a0a0a0,#a0a0a0)] border-[color:var(--h-444444,#444444)] hover:bg-[color:var(--h-333333,#333333)]/50 hover:text-[color:var(--t-white,#fff)]'
          }`}
        >
          <Ruler size={12} />
        </button>

        <button
          type="button"
          data-testid="status-grid"
          aria-pressed={gridVisible}
          title="Siatka pikseli (przy dużym powiększeniu)"
          onClick={() => onToggleGrid?.()}
          className={`p-1 rounded border text-[10.5px] cursor-pointer transition-colors ${
            gridVisible
              ? 'bg-[color:var(--h-333333,#333333)] text-[color:var(--t-white,#fff)] border-[color:var(--h-444444,#444444)]'
              : 'bg-transparent text-[color:var(--h-a0a0a0,#a0a0a0)] border-[color:var(--h-444444,#444444)] hover:bg-[color:var(--h-333333,#333333)]/50 hover:text-[color:var(--t-white,#fff)]'
          }`}
        >
          <Grid3x3 size={12} />
        </button>

        <button
          type="button"
          data-testid="status-guides"
          aria-pressed={guidesVisible}
          title="Prowadnice"
          onClick={() => onToggleGuides?.()}
          className={`p-1 rounded border text-[10.5px] cursor-pointer transition-colors ${
            guidesVisible
              ? 'bg-[color:var(--h-333333,#333333)] text-[color:var(--t-white,#fff)] border-[color:var(--h-444444,#444444)]'
              : 'bg-transparent text-[color:var(--h-a0a0a0,#a0a0a0)] border-[color:var(--h-444444,#444444)] hover:bg-[color:var(--h-333333,#333333)]/50 hover:text-[color:var(--t-white,#fff)]'
          }`}
        >
          <Hash size={12} />
        </button>
      </div>

      {/* Współrzędne kursora */}
      <span id="status-bar-cursor-pos" className="w-[230px] shrink-0 overflow-hidden whitespace-nowrap text-right font-mono text-[11px] opacity-90">
        Pozycja: 0, 0
      </span>
    </div>
  );
};