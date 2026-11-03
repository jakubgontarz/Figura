/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { X, FileImage, Link2, Link2Off, RotateCw } from 'lucide-react';
import { DPI_CHOICES, MM_PRESETS, PIXEL_PRESETS, mmToPx, pxToMm } from '../core/skia/Units.ts';

interface NewDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (title: string, width: number, height: number, dpi: number) => void;
  defaultTitle?: string;
  /** Jednostki proponowane na starcie (zgodne z przełącznikiem Piksele / Wektory na pasku stanu). */
  defaultUnit?: 'px' | 'mm';
}

const MAX_PX = 8000;
const MIN_PX = 16;
type Unit = 'px' | 'mm';

const fmt = (v: number, unit: Unit) => (unit === 'px' ? String(Math.round(v)) : String(Math.round(v * 100) / 100));

export const NewDocumentModal: React.FC<NewDocumentModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  defaultTitle = 'obraz2.fig',
  defaultUnit = 'px',
}) => {
  const [title, setTitle] = useState(defaultTitle);
  const [unit, setUnit] = useState<Unit>(defaultUnit);
  const [dpi, setDpi] = useState(defaultUnit === 'mm' ? 300 : 96);
  // wartości w bieżących jednostkach (tekst, żeby można było swobodnie edytować)
  const [width, setWidth] = useState(defaultUnit === 'mm' ? '210' : '800');
  const [height, setHeight] = useState(defaultUnit === 'mm' ? '297' : '600');
  const [lock, setLock] = useState(false);
  const [preset, setPreset] = useState(defaultUnit === 'mm' ? 'a4' : 'p800');

  // po otwarciu okna: jednostki i wartości domyślne zgodne z trybem programu
  useEffect(() => {
    if (!isOpen) return;
    setTitle(defaultTitle);
    setUnit(defaultUnit);
    if (defaultUnit === 'mm') {
      setDpi(300);
      setWidth('210');
      setHeight('297');
      setPreset('a4');
    } else {
      setDpi(96);
      setWidth('800');
      setHeight('600');
      setPreset('p800');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const num = (s: string, fb: number) => {
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : fb;
  };
  const w = num(width, unit === 'px' ? 800 : 210);
  const h = num(height, unit === 'px' ? 600 : 297);
  const wPx = unit === 'px' ? Math.round(w) : Math.round(mmToPx(w, dpi));
  const hPx = unit === 'px' ? Math.round(h) : Math.round(mmToPx(h, dpi));
  const tooBig = wPx > MAX_PX || hPx > MAX_PX;
  const tooSmall = wPx < MIN_PX || hPx < MIN_PX;
  const other = unit === 'px' ? `${pxToMm(wPx, dpi).toFixed(2)} × ${pxToMm(hPx, dpi).toFixed(2)} mm` : `${wPx} × ${hPx} px`;

  const switchUnit = (u: Unit) => {
    if (u === unit) return;
    if (u === 'mm') {
      setWidth(fmt(pxToMm(wPx, dpi), 'mm'));
      setHeight(fmt(pxToMm(hPx, dpi), 'mm'));
      setDpi((d) => (d < 150 ? 300 : d));
    } else {
      setWidth(String(wPx));
      setHeight(String(hPx));
    }
    setPreset('');
    setUnit(u);
  };

  const applyPreset = (id: string) => {
    setPreset(id);
    const list = unit === 'px' ? PIXEL_PRESETS : MM_PRESETS;
    const p = list.find((x) => x.id === id);
    if (p) {
      setWidth(fmt(p.w, unit));
      setHeight(fmt(p.h, unit));
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
    'w-full bg-[#121212] border border-[#444] rounded px-2.5 py-1.5 text-white text-center focus:outline-none focus:border-[#007acc]';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 select-none">
      <div className="bg-[#1e1e1e] border border-[#3f3f46] rounded-lg shadow-2xl w-full max-w-md flex flex-col text-xs text-[#dddddd]">
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#252526] border-b border-[#333] rounded-t-lg">
          <div className="flex items-center gap-2">
            <FileImage size={15} className="text-[#007acc]" />
            <span className="font-semibold text-sm text-white">Nowy dokument</span>
          </div>
          <button onClick={onClose} className="p-1 text-[#aaa] hover:text-white hover:bg-[#333] rounded">
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div>
            <label className="block text-[11px] text-[#aaa] mb-1">Nazwa pliku:</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-[#121212] border border-[#444] rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-[#007acc]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-[#aaa] mb-1">Jednostki:</label>
              <div className="flex rounded overflow-hidden border border-[#444]">
                {(['px', 'mm'] as Unit[]).map((u) => (
                  <button
                    key={u}
                    type="button"
                    onClick={() => switchUnit(u)}
                    className={`flex-1 py-1.5 ${unit === u ? 'bg-[#094771] text-white' : 'bg-[#2a2a2a] text-[#ccc] hover:bg-[#3a3a3a]'}`}
                  >
                    {u === 'px' ? 'Piksele' : 'Milimetry'}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-[11px] text-[#aaa] mb-1">Rozmiar domyślny:</label>
              <select
                value={preset}
                onChange={(e) => applyPreset(e.target.value)}
                className="w-full h-[30px] bg-[#121212] border border-[#444] rounded px-2 text-white focus:outline-none focus:border-[#007acc]"
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

          <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
            <div>
              <label className="block text-[11px] text-[#aaa] mb-1">Szerokość ({unit}):</label>
              <input
                type="text"
                inputMode="decimal"
                value={width}
                onChange={(e) => onWidthChange(e.target.value.replace(/[^\d.,]/g, '').slice(0, 8))}
                onFocus={(e) => e.target.select()}
                className={field}
              />
            </div>
            <div className="flex gap-1 pb-0.5">
              <button
                type="button"
                title={lock ? 'Proporcje zablokowane (kliknij, aby odblokować)' : 'Zablokuj proporcje'}
                onClick={() => setLock((l) => !l)}
                className={`w-8 h-[30px] flex items-center justify-center rounded border ${lock ? 'bg-[#094771] border-[#007acc] text-white' : 'bg-[#2a2a2a] border-[#444] text-[#ccc] hover:bg-[#3a3a3a]'}`}
              >
                {lock ? <Link2 size={14} /> : <Link2Off size={14} />}
              </button>
              <button
                type="button"
                title="Zamień szerokość z wysokością (obróć orientację)"
                onClick={() => {
                  setWidth(height);
                  setHeight(width);
                  setPreset('');
                }}
                className="w-8 h-[30px] flex items-center justify-center rounded border bg-[#2a2a2a] border-[#444] text-[#ccc] hover:bg-[#3a3a3a]"
              >
                <RotateCw size={14} />
              </button>
            </div>
            <div>
              <label className="block text-[11px] text-[#aaa] mb-1">Wysokość ({unit}):</label>
              <input
                type="text"
                inputMode="decimal"
                value={height}
                onChange={(e) => onHeightChange(e.target.value.replace(/[^\d.,]/g, '').slice(0, 8))}
                onFocus={(e) => e.target.select()}
                className={field}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 items-end">
            <div>
              <label className="block text-[11px] text-[#aaa] mb-1">Rozdzielczość (dpi):</label>
              <div className="flex gap-1">
                <input
                  type="text"
                  inputMode="numeric"
                  value={dpi}
                  onChange={(e) => {
                    const n = parseInt(e.target.value.replace(/\D/g, '').slice(0, 4) || '0', 10);
                    setDpi(Math.max(1, Math.min(2400, n)));
                  }}
                  onFocus={(e) => e.target.select()}
                  className={`${field} w-16`}
                />
                <select
                  value=""
                  onChange={(e) => e.target.value && setDpi(parseInt(e.target.value, 10))}
                  className="flex-1 h-[30px] bg-[#121212] border border-[#444] rounded px-1 text-white focus:outline-none focus:border-[#007acc]"
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
            <div className="text-[11px] text-[#9a9a9a] pb-1.5">
              = <span className="text-white font-mono">{other}</span>
            </div>
          </div>

          {(tooBig || tooSmall) && (
            <div className="text-[11px] text-[#ff8a8a]">
              {tooBig ? `Obraz jest za duży (najwyżej ${MAX_PX} px na bok przy tej rozdzielczości: ${wPx} × ${hPx} px).` : `Obraz jest za mały (co najmniej ${MIN_PX} px na bok).`}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-[#333]">
            <button type="button" onClick={onClose} className="px-3 py-1.5 bg-[#2d2d2d] hover:bg-[#3d3d3d] rounded text-xs text-[#ccc]">
              Anuluj
            </button>
            <button
              type="submit"
              disabled={tooBig || tooSmall}
              className="px-4 py-1.5 bg-[#007acc] hover:bg-[#006bb3] disabled:opacity-40 disabled:cursor-not-allowed text-white rounded text-xs font-medium"
            >
              Utwórz
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
