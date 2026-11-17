/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialogOwnsKey } from '../core/dialogStack.ts';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUp, ArrowUpLeft, ArrowUpRight, Frame } from 'lucide-react';
import { SizeFields } from './SizeFields.tsx';
import { DialogWindow } from './DialogWindow.tsx';
import { LengthUnit, pxToUnit } from '../core/Units.ts';
import { GraphicEngine } from '../core/GraphicEngine.ts';

export interface CanvasSizeResult {
  width: number;
  height: number;
  /** położenie dotychczasowego obrazu w nowym płótnie: 0 = lewa / górna krawędź, 0.5 = środek, 1 = prawa / dolna */
  ax: number;
  ay: number;
}

interface Props {
  width: number;
  height: number;
  dpi: number;
  defaultUnit: LengthUnit;
  onApply: (r: CanvasSizeResult) => void;
  onCancel: () => void;
}

/** Strzałki na przyciskach sąsiadujących z wciśniętym (kierunek od kotwicy); dalsze przyciski zostają puste. */
const ARROWS: Record<string, React.ComponentType<{ size?: number }>> = {
  '-1,-1': ArrowUpLeft,
  '0,-1': ArrowUp,
  '1,-1': ArrowUpRight,
  '-1,0': ArrowLeft,
  '1,0': ArrowRight,
  '-1,1': ArrowDownLeft,
  '0,1': ArrowDown,
  '1,1': ArrowDownRight,
};

/**
 * Okno „Obraz > Rozmiar płótna”: nowe wymiary płótna bez skalowania zawartości; kotwica określa, od której krawędzi lub narożnika
 * (albo od środka) obraz zostaje powiększony lub przycięty.
 */
export const CanvasSizeDialog: React.FC<Props> = ({ width, height, dpi, defaultUnit, onApply, onCancel }) => {
  const [unit, setUnit] = useState<LengthUnit>(defaultUnit);
  const [wPx, setWPx] = useState(width);
  const [hPx, setHPx] = useState(height);
  const [lock, setLock] = useState(false);
  const [relative, setRelative] = useState(false);
  const [anchor, setAnchor] = useState<{ x: 0 | 1 | 2; y: 0 | 1 | 2 }>({ x: 1, y: 1 });

  const err = GraphicEngine.checkDocSize(wPx, hPx);
  const canOk = !err && (wPx !== width || hPx !== height);

  const latest = useRef({ wPx, hPx, anchor, canOk, onApply, onCancel });
  latest.current = { wPx, hPx, anchor, canOk, onApply, onCancel };
  const submit = () => {
    const c = latest.current;
    if (c.canOk) c.onApply({ width: c.wPx, height: c.hPx, ax: c.anchor.x / 2, ay: c.anchor.y / 2 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'canvas-dialog')) return;
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

  const shrinks = wPx < width || hPx < height;

  return (
    <DialogWindow
      width={448}
      modal
      testId="canvas-dialog"
      autoFocus="input"
      onClose={onCancel}
      title={
        <>
          <Frame size={13} className="text-[color:var(--h-007acc,#007acc)]" />
          Rozmiar płótna
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
            relative={relative}
            onChange={(w, h) => {
              setWPx(w);
              setHPx(h);
            }}
            testPrefix="canvas"
          />

          <label className="flex items-center gap-2 cursor-pointer text-[color:var(--h-cccccc,#cccccc)]">
            <input type="checkbox" data-testid="canvas-relative" checked={relative} onChange={(e) => setRelative(e.target.checked)} />
            Względnie (przyrost względem obecnego rozmiaru)
          </label>

          <div className="grid grid-cols-[auto_1fr] gap-4 items-start">
            <div>
              <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Kotwica:</label>
              <div className="grid grid-cols-3 gap-1" data-testid="canvas-anchor">
                {([0, 1, 2] as const).flatMap((y) =>
                  ([0, 1, 2] as const).map((x) => {
                    const on = anchor.x === x && anchor.y === y;
                    const near = Math.abs(x - anchor.x) <= 1 && Math.abs(y - anchor.y) <= 1;
                    const Icon = !on && near ? ARROWS[`${Math.sign(x - anchor.x)},${Math.sign(y - anchor.y)}`] : null;
                    return (
                      <button
                        key={`${x}${y}`}
                        type="button"
                        data-testid={`canvas-anchor-${x}${y}`}
                        title={['górny', 'środkowy', 'dolny'][y] + ' ' + ['lewy', 'środkowy', 'prawy'][x]}
                        onClick={() => setAnchor({ x, y })}
                        className={`w-8 h-8 flex items-center justify-center rounded border ${on ? 'bg-[color:var(--h-094771,#094771)] border-[color:var(--h-007acc,#007acc)] text-white' : 'bg-[color:var(--h-2a2a2a,#2a2a2a)] border-[color:var(--h-444444,#444444)] text-[color:var(--h-999999,#999999)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)]'}`}
                      >
                        {on ? <span className="block w-3 h-3 bg-white rounded-[2px]" /> : Icon ? <Icon size={13} /> : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div className="text-[11px] text-[color:var(--h-9a9a9a,#9a9a9a)] leading-4 pt-4">
              Nowy rozmiar: <span className="text-[color:var(--t-white,#fff)] font-mono" data-testid="canvas-newsize">{wPx} × {hPx} px</span>
              <br />
              {pxToUnit(wPx, 'cm', dpi).toFixed(2)} × {pxToUnit(hPx, 'cm', dpi).toFixed(2)} cm
              {shrinks && (
                <>
                  <br />
                  <span className="text-[color:var(--c-warn,#e6c36a)]">Zawartość zostanie przycięta</span>
                </>
              )}
            </div>
          </div>

          {err && <div className="text-[11px] text-[color:var(--c-err,#ff8a8a)]" data-testid="canvas-error">{err}</div>}

          <div className="flex justify-end gap-2 pt-2 border-t border-[color:var(--h-333333,#333333)]">
            <button type="button" onClick={onCancel} className="px-3 py-1.5 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)]">
              Anuluj
            </button>
            <button
              type="button"
              data-testid="canvas-ok"
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
