/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialogOwnsKey } from '../core/dialogStack.ts';
import React, { useEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { ScrubField } from './ScrubField.tsx';
import { SizeFields } from './SizeFields.tsx';
import { DialogWindow } from './DialogWindow.tsx';
import { DPI_CHOICES, LengthUnit, pxToUnit } from '../core/Units.ts';
import { RESAMPLE_OPTIONS, ResampleMethod } from '../core/Resample.ts';
import { GraphicEngine } from '../core/GraphicEngine.ts';

export interface ImageResizeResult {
  width: number;
  height: number;
  method: ResampleMethod;
  dpi: number;
}

interface Props {
  width: number;
  height: number;
  dpi: number;
  /** Jednostka proponowana na starcie (zgodna z jednostką paska stanu). */
  defaultUnit: LengthUnit;
  onApply: (r: ImageResizeResult) => void;
  onCancel: () => void;
}

/** Okno „Obraz > Zmień rozmiar”: nowe wymiary (procent oraz px, mm, cm, cale), blokada proporcji, rozdzielczość i metoda próbkowania. */
export const ImageResizeDialog: React.FC<Props> = ({ width, height, dpi: dpi0, defaultUnit, onApply, onCancel }) => {
  const [unit, setUnit] = useState<LengthUnit>(defaultUnit);
  const [dpi, setDpi] = useState(dpi0);
  const [wPx, setWPx] = useState(width);
  const [hPx, setHPx] = useState(height);
  const [lock, setLock] = useState(true);
  const [method, setMethod] = useState<ResampleMethod>('bicubic');

  const err = GraphicEngine.checkDocSize(wPx, hPx);
  const unchanged = wPx === width && hPx === height && Math.abs(dpi - dpi0) < 1e-9;
  const canOk = !err && !unchanged;

  const latest = useRef({ wPx, hPx, method, dpi, canOk, onApply, onCancel });
  latest.current = { wPx, hPx, method, dpi, canOk, onApply, onCancel };
  const submit = () => {
    const c = latest.current;
    if (c.canOk) c.onApply({ width: c.wPx, height: c.hPx, method: c.method, dpi: c.dpi });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'resize-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onCancel();
      } else if (e.key === 'Enter') {
        const t = e.target as HTMLElement | null;
        if (t instanceof HTMLSelectElement || t instanceof HTMLButtonElement) return;
        if (t instanceof HTMLInputElement && t.type === 'text') setTimeout(submit, 0);
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

  const sel = 'h-[30px] bg-[color:var(--h-121212,#121212)] border border-[color:var(--h-444444,#444444)] rounded px-1.5 text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]';

  return (
    <DialogWindow
      width={448}
      modal
      testId="resize-dialog"
      autoFocus="input"
      onClose={onCancel}
      title={
        <>
          <Maximize2 size={13} className="text-[color:var(--h-007acc,#007acc)]" />
          Zmień rozmiar obrazu
        </>
      }
    >
        <div className="p-4 space-y-3">
          <div className="text-[11px] text-[color:var(--h-9a9a9a,#9a9a9a)]">
            Obecny rozmiar: <span className="text-[color:var(--t-white,#fff)] font-mono">{width} × {height} px</span>
          </div>

          <SizeFields
            width={width}
            height={height}
            wPx={wPx}
            hPx={hPx}
            dpi={dpi}
            unit={unit}
            onUnit={setUnit}
            lock={lock}
            onLock={setLock}
            onChange={(w, h) => {
              setWPx(w);
              setHPx(h);
            }}
            testPrefix="resize"
          />

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Rozdzielczość (dpi):</label>
              <div className="flex gap-1">
                <ScrubField value={dpi} min={1} max={2400} curve={2} width={80} tall testId="resize-dpi" onChange={setDpi} />
                <select value="" onChange={(e) => e.target.value && setDpi(parseInt(e.target.value, 10))} className={`flex-1 ${sel}`}>
                  <option value="">Typowe…</option>
                  {DPI_CHOICES.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="text-[11px] text-[color:var(--h-9a9a9a,#9a9a9a)] pb-1.5">
              = <span className="text-[color:var(--t-white,#fff)] font-mono">{wPx} × {hPx} px</span>
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Próbkowanie:</label>
            <select data-testid="resize-method" value={method} onChange={(e) => setMethod(e.target.value as ResampleMethod)} className={`w-full ${sel}`}>
              {RESAMPLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value} title={o.hint}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {err && <div className="text-[11px] text-[color:var(--c-err,#ff8a8a)]" data-testid="resize-error">{err}</div>}

          <div className="flex justify-end gap-2 pt-2 border-t border-[color:var(--h-333333,#333333)]">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)]">
              Anuluj
            </button>
            <button
              type="button"
              data-testid="resize-ok"
              disabled={!canOk}
              onClick={submit}
              className="px-4 py-1.5 bg-[color:var(--h-007acc,#007acc)] hover:bg-[color:var(--h-006bb3,#006bb3)] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-medium"
            >
              Zastosuj
            </button>
          </div>
        </div>
    </DialogWindow>
  );
};
