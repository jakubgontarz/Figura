/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ZoomIn, ZoomOut, RotateCcw, Magnet, Grid } from 'lucide-react';
import { LENGTH_UNITS, LengthUnit, UNIT_LABEL, UnitMode, fmtUnit } from '../core/skia/Units.ts';

interface StatusBarProps {
  statusText: string;
  docWidth: number;
  docHeight: number;
  zoom: number;
  onZoomChange: (newZoom: number) => void;
  unitMode?: UnitMode;
  onUnitModeChange?: (m: UnitMode) => void;
  /** Dokument obiektu inteligentnego: wymiary zawsze w pikselach, przełącznik nieaktywny. */
  unitsLocked?: boolean;
  unit?: LengthUnit;
  onUnitChange?: (u: LengthUnit) => void;
  dpi?: number;
  snapEnabled?: boolean;
  onToggleSnap?: () => void;
  guidesVisible?: boolean;
  onToggleGuides?: () => void;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  statusText,
  docWidth,
  docHeight,
  zoom,
  onZoomChange,
  unitMode = 'px',
  onUnitModeChange,
  unitsLocked = false,
  unit = 'px',
  onUnitChange,
  dpi = 96,
  snapEnabled = false,
  onToggleSnap,
  guidesVisible = true,
  onToggleGuides,
}) => {

  const seg = (active: boolean, locked: boolean) =>
    `px-2 py-px text-[10.5px] ${active ? 'bg-[#333333] text-white font-semibold' : 'bg-transparent text-[#a0a0a0] hover:text-white hover:bg-[#333333]/50'} ${locked ? 'opacity-60 cursor-default' : 'cursor-pointer'}`;

  return (
    <div className="h-6 bg-[#1e1e1e] text-[#cccccc] border-t border-[#111111] select-none flex items-center gap-4 px-3 text-[11px] font-normal z-20 shadow-md">
      {/* Lewa sekcja: wymiary obrazu i zoom */}
      <span className="opacity-90 whitespace-nowrap">
        {`${fmtUnit(docWidth, unit, dpi)} × ${fmtUnit(docHeight, unit, dpi)} ${UNIT_LABEL[unit]}`}
      </span>

      {/* Kontrolki Zoomu */}
      <div className="flex items-center gap-1.5 opacity-90 hover:opacity-100 whitespace-nowrap">
        <span>Zoom: {Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => onZoomChange(Math.max(0.05, Number((zoom - 0.25).toFixed(2))))} className="p-0.5 hover:bg-[#333333] rounded cursor-pointer" title="Pomniejsz">
          <ZoomOut size={11} />
        </button>
        <button type="button" onClick={() => onZoomChange(1.0)} className="p-0.5 hover:bg-[#333333] rounded cursor-pointer" title="Reset do 100%">
          <RotateCcw size={10} />
        </button>
        <button type="button" onClick={() => onZoomChange(Math.min(25.0, Number((zoom + 0.25).toFixed(2))))} className="p-0.5 hover:bg-[#333333] rounded cursor-pointer" title="Powiększ">
          <ZoomIn size={11} />
        </button>
      </div>

      {/* Podpowiedź narzędzia */}
      <div id="status-bar-hint" data-testid="status-hint" className="flex-1 min-w-0 truncate font-medium" title={statusText || undefined}>
        {statusText}
      </div>

      {/* Przełączniki wyrównane do prawej */}
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <div className="flex rounded overflow-hidden border border-[#444444]" title={unitsLocked ? 'Dokument obiektu inteligentnego jest zawsze wyświetlany w pikselach' : 'Tryb wyświetlania'}>
          {(['px', 'vec'] as UnitMode[]).map((m) => (
            <button key={m} type="button" disabled={unitsLocked} onClick={() => onUnitModeChange?.(m)} className={seg(unitMode === m, unitsLocked)}>
              {m === 'px' ? 'Piksele' : 'Wektory'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <div className="flex rounded overflow-hidden border border-[#444444]" title="Jednostka wymiarów">
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
              ? 'bg-[#333333] text-white border-[#444444]'
              : 'bg-transparent text-[#a0a0a0] border-[#444444] hover:bg-[#333333]/50 hover:text-white'
          }`}
        >
          <Magnet size={12} />
        </button>

        <button
          type="button"
          data-testid="status-guides"
          aria-pressed={guidesVisible}
          title="Prowadnice"
          onClick={() => onToggleGuides?.()}
          className={`p-1 rounded border text-[10.5px] cursor-pointer transition-colors ${
            guidesVisible
              ? 'bg-[#333333] text-white border-[#444444]'
              : 'bg-transparent text-[#a0a0a0] border-[#444444] hover:bg-[#333333]/50 hover:text-white'
          }`}
        >
          <Grid size={12} />
        </button>
      </div>

      {/* Współrzędne kursora */}
      <span id="status-bar-cursor-pos" className="w-[230px] shrink-0 overflow-hidden whitespace-nowrap text-right font-mono text-[11px] opacity-90">
        Pozycja: 0, 0
      </span>
    </div>
  );
};