/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext } from 'react';
import { ScrubField } from './ScrubField.tsx';
import { DEFAULT_DPI, LengthUnit, UNIT_LABEL, fmtMm, fmtUnit, pxPerUnit, pxToMm, pxToUnit, unitToPx } from '../core/Units.ts';

export interface UnitsValue {
  /** jednostka pól liczbowych i współrzędnych */
  unit: LengthUnit;
  dpi: number;
}

export const UnitsContext = createContext<UnitsValue>({ unit: 'px', dpi: DEFAULT_DPI });
export const useUnits = (): UnitsValue => useContext(UnitsContext);

/**
 * Pole długości: wartość w pikselach dokumentu, wyświetlana i wpisywana w wybranej jednostce (px, mm, cm, cal).
 * Działa jak suwak (przeciąganie po polu) i jak pole tekstowe (kliknięcie); wartość jest zatwierdzana na bieżąco.
 * Przy bardzo szerokim zakresie (współrzędne, wymiary) nie ma toru suwaka, a przeciąganie zmienia wartość o 1 px na piksel ruchu.
 */
export const LengthField: React.FC<{
  valuePx: number;
  minPx: number;
  maxPx: number;
  onCommitPx: (px: number) => void;
  /** w pikselach: liczby całkowite (domyślnie tak) */
  integerPx?: boolean;
  /** wymusza piksele niezależnie od wybranej jednostki (wymiary płótna obiektów inteligentnych) */
  forcePx?: boolean;
  /** górna granica toru suwaka (wpisać można do `maxPx`) */
  trackMaxPx?: number;
  /** szerokość pola w px; domyślnie dopasowana do najdłuższego możliwego tekstu */
  width?: number;
  /** pozostawione dla zgodności: wygląd pola jest wspólny */
  className?: string;
  title?: string;
  onEnter?: () => void;
}> = ({ valuePx, minPx, maxPx, onCommitPx, integerPx = true, forcePx, trackMaxPx, width, title, onEnter }) => {
  const { unit: ctxUnit, dpi } = useUnits();
  const unit: LengthUnit = forcePx ? 'px' : ctxUnit;
  const mm = unit !== 'px';
  const range = maxPx - minPx;
  const openEnded = range > 5000 && trackMaxPx === undefined;
  const fmt = (px: number) => (mm ? fmtUnit(px, unit, dpi) : String(integerPx ? Math.round(px) : Math.round(px * 100) / 100));
  // Najdłuższy tekst: skrajna wartość zakresu albo szersza z liczb, które mogą się zdarzyć przy edycji
  const longest = Math.max(fmt(Math.min(maxPx, 99999)).length, fmt(Math.max(minPx, -99999)).length);
  return (
    <ScrubField
      value={valuePx}
      min={minPx}
      max={maxPx}
      trackMax={trackMaxPx}
      step={!mm && integerPx ? 1 : 0.01}
      wheelStep={mm ? pxPerUnit(unit, dpi) : 1}
      curve={range > 1000 ? 2.2 : 1}
      openEnded={openEnded}
      format={fmt}
      parse={(t) => {
        const v = parseFloat(t.replace(',', '.'));
        if (isNaN(v)) return null;
        const px = mm ? unitToPx(v, unit, dpi) : v;
        return !mm && integerPx ? Math.round(px) : px;
      }}
      chars={longest}
      width={width ?? Math.max(56, Math.round((longest + 1.5) * 7.4 + 12))}
      title={title}
      onChange={onCommitPx}
      onEnter={onEnter}
    />
  );
};

/** Etykieta jednostki obok pola długości. */
export const UnitLabel: React.FC<{ forcePx?: boolean }> = ({ forcePx }) => {
  const { unit } = useUnits();
  return <span className="text-[10px] text-[#888]">{forcePx ? 'px' : UNIT_LABEL[unit]}</span>;
};

export { fmtMm, pxToMm, pxToUnit };
