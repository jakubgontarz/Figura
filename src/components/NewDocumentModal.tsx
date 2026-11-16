/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialogOwnsKey } from '../core/dialogStack.ts';
import React, { useEffect, useState } from 'react';
import { DialogWindow } from './DialogWindow.tsx';
import { ScrubField } from './ScrubField.tsx';
import { X, FileImage, Link2, Link2Off, RotateCw } from 'lucide-react';
import { settings } from '../core/Settings.ts';
import { DPI_CHOICES, LENGTH_UNITS, LengthUnit, MM_PER_INCH, MM_PRESETS, PIXEL_PRESETS, UNIT_LABEL, pxToUnit, unitToPx } from '../core/Units.ts';

interface NewDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (title: string, width: number, height: number, dpi: number) => void;
  defaultTitle?: string;
  /** Jednostka proponowana na starcie (zgodna z jednostką wymiarów wybraną na pasku stanu). */
  defaultUnit?: LengthUnit;
}

const MAX_PX = 8000;
const MIN_PX = 16;
type Unit = LengthUnit;

const UNIT_NAME: Record<Unit, string> = { px: 'Piksele', mm: 'mm', cm: 'cm', in: 'cal' };
const DECIMALS: Record<Unit, number> = { px: 0, mm: 2, cm: 3, in: 3 };
const fmt = (v: number, unit: Unit) => {
  const k = 10 ** DECIMALS[unit];
  return String(Math.round(v * k) / k);
};
/** Rozmiar domyślny z zestawu milimetrowego w wybranej jednostce. */
const mmTo = (mm: number, unit: Unit): number => (unit === 'cm' ? mm / 10 : unit === 'in' ? mm / MM_PER_INCH : mm);

export const NewDocumentModal: React.FC<NewDocumentModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  defaultTitle = 'obraz2.fig',
  defaultUnit = 'px',
}) => {
  const [title, setTitle] = useState(defaultTitle);
  const [unit, setUnit] = useState<Unit>(defaultUnit);
  const [dpi, setDpi] = useState(defaultUnit === 'px' ? 96 : 300);
  // wartości w bieżących jednostkach (tekst, żeby można było swobodnie edytować)
  const [width, setWidth] = useState(defaultUnit === 'px' ? '800' : fmt(mmTo(210, defaultUnit), defaultUnit));
  const [height, setHeight] = useState(defaultUnit === 'px' ? '600' : fmt(mmTo(297, defaultUnit), defaultUnit));
  const [lock, setLock] = useState(false);
  const [preset, setPreset] = useState(defaultUnit === 'px' ? 'p800' : 'a4');

  // po otwarciu okna: jednostki i wartości domyślne zgodne z trybem programu
  useEffect(() => {
    if (!isOpen) return;
    setTitle(defaultTitle);
    setUnit(defaultUnit);
    if (defaultUnit !== 'px') {
      setDpi(300);
      setWidth(fmt(mmTo(210, defaultUnit), defaultUnit));
      setHeight(fmt(mmTo(297, defaultUnit), defaultUnit));
      setPreset('a4');
    } else {
      const st = settings.get();
      setDpi(st.newDocDpi);
      setWidth(String(st.newDocWidth));
      setHeight(String(st.newDocHeight));
      setPreset(PIXEL_PRESETS.find((p) => p.w === st.newDocWidth && p.h === st.newDocHeight)?.id ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Esc zamyka okno
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'new-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const num = (s: string, fb: number) => {
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : fb;
  };
  const w = num(width, unit === 'px' ? 800 : mmTo(210, unit));
  const h = num(height, unit === 'px' ? 600 : mmTo(297, unit));
  const wPx = Math.round(unitToPx(w, unit, dpi));
  const hPx = Math.round(unitToPx(h, unit, dpi));
  const tooBig = wPx > MAX_PX || hPx > MAX_PX;
  const tooSmall = wPx < MIN_PX || hPx < MIN_PX;
  const other = unit === 'px' ? `${pxToUnit(wPx, 'mm', dpi).toFixed(2)} × ${pxToUnit(hPx, 'mm', dpi).toFixed(2)} mm` : `${wPx} × ${hPx} px`;

  const switchUnit = (u: Unit) => {
    if (u === unit) return;
    // przy przejściu z pikseli na jednostkę fizyczną niska rozdzielczość ekranu (96 dpi) zamieniana jest na drukarską
    let d = dpi;
    if (u !== 'px' && unit === 'px' && d < 150) {
      d = 300;
      setDpi(d);
    }
    const nwPx = unit === 'px' ? wPx : Math.round(unitToPx(w, unit, dpi));
    const nhPx = unit === 'px' ? hPx : Math.round(unitToPx(h, unit, dpi));
    if (u === 'px') {
      setWidth(String(nwPx));
      setHeight(String(nhPx));
    } else {
      // fizyczny rozmiar zostaje taki sam przy zmianie jednostki; z pikseli liczony jest przy nowej rozdzielczości
      const physW = unit === 'px' ? pxToUnit(nwPx, u, d) : pxToUnit(unitToPx(w, unit, dpi), u, dpi);
      const physH = unit === 'px' ? pxToUnit(nhPx, u, d) : pxToUnit(unitToPx(h, unit, dpi), u, dpi);
      setWidth(fmt(physW, u));
      setHeight(fmt(physH, u));
    }
    setPreset('');
    setUnit(u);
  };

  const applyPreset = (id: string) => {
    setPreset(id);
    const list = unit === 'px' ? PIXEL_PRESETS : MM_PRESETS;
    const p = list.find((x) => x.id === id);
    if (p) {
      setWidth(fmt(unit === 'px' ? p.w : mmTo(p.w, unit), unit));
      setHeight(fmt(unit === 'px' ? p.h : mmTo(p.h, unit), unit));
    }
  };

  const onWidthChange = (v: string) => {
    setWidth(v);
    setPreset('');
    if (lock) {
      const nv = num(v, 0);
      if (nv > 0 && w > 0) setHeight(fmt((nv * h) / w, unit));
    }
  };
  const onHeightChange = (v: string) => {
    setHeight(v);
    setPreset('');
    if (lock) {
      const nv = num(v, 0);
      if (nv > 0 && h > 0) setWidth(fmt((nv * w) / h, unit));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tooBig || tooSmall) return;
    const cleanTitle = title.trim() || 'obraz.fig';
    onCreate(cleanTitle.endsWith('.fig') ? cleanTitle : `${cleanTitle}.fig`, wPx, hPx, dpi);
    onClose();
  };

  const presets = unit === 'px' ? PIXEL_PRESETS : MM_PRESETS;
  const field =
    'w-full bg-[color:var(--h-121212,#121212)] border border-[color:var(--h-444444,#444444)] rounded px-2.5 py-1.5 text-[color:var(--t-white,#fff)] text-center focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]';

  return (
    <DialogWindow
      width={448}
      modal
      testId="new-dialog"
      onClose={onClose}
      title={
        <>
          <FileImage size={13} className="text-[color:var(--h-007acc,#007acc)]" />
          Nowy dokument
        </>
      }
    >
        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div>
            <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Nazwa pliku:</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-[color:var(--h-121212,#121212)] border border-[color:var(--h-444444,#444444)] rounded px-2.5 py-1.5 text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Jednostki:</label>
              <div className="flex rounded overflow-hidden border border-[color:var(--h-444444,#444444)]">
                {LENGTH_UNITS.map((u) => (
                  <button
                    key={u}
                    type="button"
                    data-testid={`newdoc-unit-${u}`}
                    onClick={() => switchUnit(u)}
                    className={`flex-1 py-1.5 ${unit === u ? 'bg-[color:var(--h-094771,#094771)] text-white' : 'bg-[color:var(--h-2a2a2a,#2a2a2a)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)]'}`}
                  >
                    {UNIT_NAME[u]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Rozmiar domyślny:</label>
              <select
                value={preset}
                onChange={(e) => applyPreset(e.target.value)}
                className="w-full h-[30px] bg-[color:var(--h-121212,#121212)] border border-[color:var(--h-444444,#444444)] rounded px-2 text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]"
              >
                <option value="">Własny</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
            <div>
              <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Szerokość ({UNIT_LABEL[unit]}):</label>
              <ScrubField
                value={w}
                min={pxToUnit(MIN_PX, unit, dpi)}
                max={pxToUnit(MAX_PX, unit, dpi)}
                step={unit === 'px' ? 1 : unit === 'mm' ? 0.01 : 0.001}
                wheelStep={1}
                curve={2}
                format={(v) => fmt(v, unit)}
                width="100%"
                tall
                onChange={(v) => onWidthChange(fmt(v, unit))}
              />
            </div>
            <div>
              <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Wysokość ({UNIT_LABEL[unit]}):</label>
              <ScrubField
                value={h}
                min={pxToUnit(MIN_PX, unit, dpi)}
                max={pxToUnit(MAX_PX, unit, dpi)}
                step={unit === 'px' ? 1 : unit === 'mm' ? 0.01 : 0.001}
                wheelStep={1}
                curve={2}
                format={(v) => fmt(v, unit)}
                width="100%"
                tall
                onChange={(v) => onHeightChange(fmt(v, unit))}
              />
            </div>
            <div className="flex gap-1 pb-0.5">
              <button
                type="button"
                data-testid="newdoc-lock"
                title={lock ? 'Proporcje zablokowane (kliknij, aby odblokować)' : 'Zablokuj proporcje'}
                onClick={() => setLock((l) => !l)}
                className={`w-8 h-[30px] flex items-center justify-center rounded border ${lock ? 'bg-[color:var(--h-094771,#094771)] border-[color:var(--h-007acc,#007acc)] text-white' : 'bg-[color:var(--h-2a2a2a,#2a2a2a)] border-[color:var(--h-444444,#444444)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)]'}`}
              >
                {lock ? <Link2 size={14} /> : <Link2Off size={14} />}
              </button>
              <button
                type="button"
                data-testid="newdoc-swap"
                title="Zamień szerokość z wysokością (obróć orientację)"
                onClick={() => {
                  setWidth(height);
                  setHeight(width);
                  setPreset('');
                }}
                className="w-8 h-[30px] flex items-center justify-center rounded border bg-[color:var(--h-2a2a2a,#2a2a2a)] border-[color:var(--h-444444,#444444)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)]"
              >
                <RotateCw size={14} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className="block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1">Rozdzielczość (dpi):</label>
              <div className="flex gap-1">
                <ScrubField value={dpi} min={1} max={2400} curve={2} width={80} tall onChange={setDpi} />
                <select
                  value=""
                  onChange={(e) => e.target.value && setDpi(parseInt(e.target.value, 10))}
                  className="flex-1 h-[30px] bg-[color:var(--h-121212,#121212)] border border-[color:var(--h-444444,#444444)] rounded px-1 text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]"
                >
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
              = <span className="text-[color:var(--t-white,#fff)] font-mono">{other}</span>
            </div>
          </div>

          {(tooBig || tooSmall) && (
            <div className="text-[11px] text-[#ff8a8a]">
              {tooBig ? `Obraz jest za duży (najwyżej ${MAX_PX} px na bok przy tej rozdzielczości: ${wPx} × ${hPx} px).` : `Obraz jest za mały (co najmniej ${MIN_PX} px na bok).`}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-[color:var(--h-333333,#333333)]">
            <button type="button" onClick={onClose} className="px-3 py-1.5 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)]">
              Anuluj
            </button>
            <button
              type="submit"
              disabled={tooBig || tooSmall}
              className="px-4 py-1.5 bg-[color:var(--h-007acc,#007acc)] hover:bg-[color:var(--h-006bb3,#006bb3)] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-medium"
            >
              Utwórz
            </button>
          </div>
        </form>
    </DialogWindow>
  );
};
