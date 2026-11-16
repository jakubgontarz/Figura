/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialogOwnsKey } from '../core/dialogStack.ts';
import React, { useEffect, useRef, useState } from 'react';
import { Expand } from 'lucide-react';
import { DialogWindow } from './DialogWindow.tsx';
import { LengthField, UnitLabel, UnitsContext } from './Units.tsx';
import { LENGTH_UNITS, LengthUnit, UNIT_LABEL } from '../core/Units.ts';

export interface SelectionOffsetResult {
  /** px: dodatnie rozszerza, ujemne zmniejsza */
  delta: number;
  /** px: wtopienie krawędzi */
  feather: number;
}

interface Props {
  dpi: number;
  defaultUnit: LengthUnit;
  /** największa sensowna wartość (px) */
  maxPx: number;
  onApply: (r: SelectionOffsetResult) => void;
  onCancel: () => void;
}

/** Okno „Zaznacz > Rozszerz/zmniejsz”: przesuwa krawędź zaznaczenia o podaną długość, z opcjonalnym wtopieniem. */
export const SelectionOffsetDialog: React.FC<Props> = ({ dpi, defaultUnit, maxPx, onApply, onCancel }) => {
  const [unit, setUnit] = useState<LengthUnit>(defaultUnit);
  const [grow, setGrow] = useState(true);
  const [amount, setAmount] = useState(4);
  const [feather, setFeather] = useState(0);
  const canOk = amount > 0 || feather > 0;
  const latest = useRef({ grow, amount, feather, canOk, onApply, onCancel });
  latest.current = { grow, amount, feather, canOk, onApply, onCancel };
  const submit = () => {
    const c = latest.current;
    if (c.canOk) c.onApply({ delta: c.grow ? c.amount : -c.amount, feather: c.feather });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'selection-offset-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onCancel();
      } else if (e.key === 'Enter') {
        const t = e.target as HTMLElement | null;
        if (t instanceof HTMLButtonElement || t instanceof HTMLSelectElement) return;
        if (t instanceof HTMLInputElement) setTimeout(submit, 0);
        else {
          e.preventDefault();
          e.stopPropagation();
          submit();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const seg = (on: boolean) =>
    `px-3 py-1 text-[11px] cursor-pointer ${on ? 'bg-[color:var(--h-007acc,#007acc)] text-white' : 'bg-[color:var(--h-2d2d2d,#2d2d2d)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)]'}`;
  const unitSeg = (on: boolean) => `px-2 py-px text-[10.5px] cursor-pointer ${on ? 'bg-[color:var(--h-333333,#333333)] text-[color:var(--t-white,#fff)] font-semibold' : 'text-[color:var(--h-a0a0a0,#a0a0a0)] hover:text-[color:var(--t-white,#fff)] hover:bg-[color:var(--h-333333,#333333)]/50'}`;

  return (
    <UnitsContext.Provider value={{ unit, dpi }}>
      <DialogWindow
        width={320}
        modal
        testId="selection-offset-dialog"
        autoFocus="input"
        onClose={onCancel}
        title={
          <>
            <Expand size={13} className="text-[color:var(--h-007acc,#007acc)]" />
            Rozszerz/zmniejsz zaznaczenie
          </>
        }
      >
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex rounded overflow-hidden border border-[color:var(--h-444444,#444444)]">
              <button type="button" data-testid="selo-grow" className={seg(grow)} onClick={() => setGrow(true)}>
                Rozszerz
              </button>
              <button type="button" data-testid="selo-shrink" className={seg(!grow)} onClick={() => setGrow(false)}>
                Zmniejsz
              </button>
            </div>
            <div className="flex rounded overflow-hidden border border-[color:var(--h-444444,#444444)]">
              {LENGTH_UNITS.map((u) => (
                <button key={u} type="button" data-testid={`selo-unit-${u}`} className={unitSeg(unit === u)} onClick={() => setUnit(u)}>
                  {UNIT_LABEL[u]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="text-[color:var(--h-cccccc,#cccccc)]">Wielkość</span>
            <span className="flex items-center gap-1.5" data-testid="selo-amount">
              <LengthField valuePx={amount} minPx={0} maxPx={maxPx} trackMaxPx={Math.min(maxPx, 200)} integerPx={false} onCommitPx={setAmount} onEnter={submit} />
              <UnitLabel />
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[color:var(--h-cccccc,#cccccc)]">Wtopienie krawędzi</span>
            <span className="flex items-center gap-1.5" data-testid="selo-feather">
              <LengthField valuePx={feather} minPx={0} maxPx={Math.min(maxPx, 500)} trackMaxPx={100} integerPx={false} onCommitPx={setFeather} onEnter={submit} />
              <UnitLabel />
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-[color:var(--h-333333,#333333)]">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)] cursor-pointer">
              Anuluj
            </button>
            <button
              type="button"
              data-testid="selo-ok"
              disabled={!canOk}
              onClick={submit}
              className="px-4 py-1.5 bg-[color:var(--h-007acc,#007acc)] hover:bg-[color:var(--h-006bb3,#006bb3)] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-medium cursor-pointer"
            >
              Zastosuj
            </button>
          </div>
        </div>
      </DialogWindow>
    </UnitsContext.Provider>
  );
};
