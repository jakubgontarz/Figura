/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_DPI, LengthUnit, UNIT_LABEL, UnitMode, fmtMm, fmtUnit, pxToMm, pxToUnit, unitToPx } from '../core/skia/Units.ts';

export interface UnitsValue {
  /** tryb wyświetlania (Piksele / Wektory) */
  mode: UnitMode;
  /** jednostka pól liczbowych i współrzędnych */
  unit: LengthUnit;
  dpi: number;
}

export const UnitsContext = createContext<UnitsValue>({ mode: 'px', unit: 'px', dpi: DEFAULT_DPI });
export const useUnits = (): UnitsValue => useContext(UnitsContext);

/**
 * Pole długości: wartość w pikselach dokumentu, wyświetlana i wpisywana w wybranej jednostce (px, mm, cm, cal).
 * Lokalny tekst pozwala swobodnie kasować i wpisywać; wartość jest zatwierdzana na bieżąco, gdy da się ją odczytać.
 */
export const LengthField: React.FC<{
  valuePx: number;
  minPx: number;
  maxPx: number;
  onCommitPx: (px: number) => void;
  /** w trybie pikseli: liczby całkowite (domyślnie tak) */
  integerPx?: boolean;
  /** wymusza piksele niezależnie od trybu (wymiary płótna obiektów inteligentnych) */
  forcePx?: boolean;
  className?: string;
  title?: string;
  onEnter?: () => void;
}> = ({ valuePx, minPx, maxPx, onCommitPx, integerPx = true, forcePx, className, title, onEnter }) => {
  const { mode, unit: ctxUnit, dpi } = useUnits();
  const unit: LengthUnit = forcePx ? 'px' : ctxUnit;
  const mm = unit !== 'px';
  // piksele całkowite tylko w trybie Piksele; w trybie Wektory położenia i wymiary mogą być ułamkowe
  const intPx = integerPx && (forcePx || mode !== 'vec');
  const shown = mm ? fmtUnit(valuePx, unit, dpi) : String(intPx ? Math.round(valuePx) : Math.round(valuePx * 100) / 100);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  return (
    <input
      type="number"
      step={mm ? (unit === 'mm' ? 0.01 : 0.001) : intPx ? 1 : 0.01}
      title={title}
      value={focused ? text : shown}
      onFocus={() => {
        setFocused(true);
        setText(shown);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value);
        if (isNaN(v)) return;
        let px = mm ? unitToPx(v, unit, dpi) : v;
        if (!mm && intPx) px = Math.round(px);
        onCommitPx(Math.max(minPx, Math.min(maxPx, px)));
      }}
      onBlur={() => {
        setFocused(false);
        setText(shown);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onEnter?.();
        }
        e.stopPropagation();
      }}
      className={className ?? 'w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono'}
    />
  );
};

/** Etykieta jednostki obok pola długości. */
export const UnitLabel: React.FC<{ forcePx?: boolean }> = ({ forcePx }) => {
  const { unit } = useUnits();
  return <span className="text-[10px] text-[#888]">{forcePx ? 'px' : UNIT_LABEL[unit]}</span>;
};

export { fmtMm, pxToMm, pxToUnit };
