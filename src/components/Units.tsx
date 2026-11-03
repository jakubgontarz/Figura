/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useState } from 'react';
import { DEFAULT_DPI, UnitMode, fmtMm, mmToPx, pxToMm } from '../core/skia/Units.ts';

export interface UnitsValue {
  mode: UnitMode;
  dpi: number;
}

export const UnitsContext = createContext<UnitsValue>({ mode: 'px', dpi: DEFAULT_DPI });
export const useUnits = (): UnitsValue => useContext(UnitsContext);

/**
 * Pole długości: wartość w pikselach dokumentu, a w trybie wektorowym wyświetlana i wpisywana w milimetrach (2 miejsca).
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
  const { mode, dpi } = useUnits();
  const mm = mode === 'vec' && !forcePx;
  const shown = mm ? fmtMm(valuePx, dpi) : String(integerPx ? Math.round(valuePx) : Math.round(valuePx * 100) / 100);
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  return (
    <input
      type="number"
      step={mm ? 0.01 : 1}
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
        let px = mm ? mmToPx(v, dpi) : v;
        if (!mm && integerPx) px = Math.round(px);
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
  const { mode } = useUnits();
  return <span className="text-[10px] text-[#888]">{mode === 'vec' && !forcePx ? 'mm' : 'px'}</span>;
};

export { fmtMm, pxToMm };
