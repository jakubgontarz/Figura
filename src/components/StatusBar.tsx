/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { UnitMode, fmtMm } from '../core/skia/Units.ts';

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
  dpi = 96,
  snapEnabled = false,
  onToggleSnap,
  guidesVisible = true,
  onToggleGuides,
}) => {

  return (
    <div className="h-6 bg-[#007acc] text-white select-none flex items-center justify-between px-3 text-[11px] font-normal z-20 shadow-md">
      {/* Lewa sekcja informacyjna */}
      <div className="flex items-center gap-5">
        <span className="font-medium">{statusText || 'Gotowy'}</span>
        <span className="opacity-90">
          {unitMode === 'vec' ? `${fmtMm(docWidth, dpi)} × ${fmtMm(docHeight, dpi)} mm` : `${docWidth} × ${docHeight} px`}
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

      {/* Przełącznik trybu: Piksele / Wektory */}
      <div className="flex items-center gap-1.5">
        <span className="opacity-80">Tryb:</span>
        <div className="flex rounded overflow-hidden border border-white/40" title={unitsLocked ? 'Dokument obiektu inteligentnego jest zawsze w pikselach' : 'Piksele: wymiary w pikselach płótna. Wektory: obiekty wektorowe wyświetlane wektorowo, wymiary w milimetrach'}>
          {(['px', 'vec'] as UnitMode[]).map((m) => (
            <button
              key={m}
              type="button"
              disabled={unitsLocked}
              onClick={() => onUnitModeChange?.(m)}
              className={`px-2 py-px text-[10.5px] ${unitMode === m ? 'bg-white text-[#005a9e] font-semibold' : 'bg-transparent text-white hover:bg-white/20'} ${unitsLocked ? 'opacity-60 cursor-default' : 'cursor-pointer'}`}
            >
              {m === 'px' ? 'Piksele' : 'Wektory'}
            </button>
          ))}
        </div>
      </div>

      {/* Przełączniki: przyciąganie kursora i widoczność prowadnic */}
      <div className="flex items-center gap-1.5">
        {([
          ['snap', 'Przyciąganie', snapEnabled, onToggleSnap, 'Przyciąganie kursora do istniejących punktów obiektów wektorowych i prowadnic'],
          ['guides', 'Prowadnice', guidesVisible, onToggleGuides, 'Pokaż / ukryj prowadnice'],
        ] as const).map(([id, label, on, handler, hint]) => (
          <button
            key={id}
            type="button"
            data-testid={`status-${id}`}
            aria-pressed={on}
            title={hint}
            onClick={() => handler?.()}
            className={`px-2 py-px rounded border text-[10.5px] cursor-pointer ${on ? 'bg-white text-[#005a9e] font-semibold border-white' : 'bg-transparent text-white border-white/40 hover:bg-white/20'}`}
          >
            {label}
          </button>
        ))}
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
