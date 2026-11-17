/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { GraphicEngine } from '../core/GraphicEngine.ts';
import { humanBytes } from '../core/Export.ts';
import { DialogWindow } from './DialogWindow.tsx';
import { ScrubField } from './ScrubField.tsx';
import { btnGhost, btnPrimary, SectionTitle } from './formBits.tsx';
import { dialogOwnsKey } from '../core/dialogStack.ts';

export interface DocFileInfo {
  name: string;
  /** Pełna ścieżka (Tauri) albo sama nazwa pliku (przeglądarka); null = dokument jeszcze niezapisany */
  location: string | null;
  fileSize: number | null;
  savedAt: number | null;
  dirty: boolean;
}

interface Props {
  engine: GraphicEngine;
  file: DocFileInfo;
  onClose: () => void;
  /** Zmiana rozdzielczości (bez przeskalowania pikseli) */
  onChangeDpi: (dpi: number) => void;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

const Row: React.FC<{ k: string; v: React.ReactNode; testId?: string }> = ({ k, v, testId }) => (
  <div className="flex justify-between gap-4 py-[3px] text-[12px]" data-testid={testId}>
    <span className="text-[color:var(--h-999999,#999999)] shrink-0">{k}</span>
    <span className="text-[color:var(--h-dddddd,#dddddd)] text-right break-all">{v}</span>
  </div>
);

export const DocPropsDialog: React.FC<Props> = ({ engine, file, onClose, onChangeDpi }) => {
  const [dpi, setDpi] = useState(Math.round(engine.dpi || 96));
  const st = engine.documentStats();
  const w = engine.width;
  const h = engine.height;
  const g = gcd(w, h);
  const cmW = (w / dpi) * 2.54;
  const cmH = (h / dpi) * 2.54;
  const inW = w / dpi;
  const inH = h / dpi;
  const mp = (w * h) / 1e6;
  const dirty = Math.abs(dpi - (engine.dpi || 96)) > 1e-9;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'docprops-dialog')) return;
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const kind = [st.raster && `${st.raster} rastr.`, st.vector && `${st.vector} wekt.`, st.groups && `${st.groups} grup`, st.adjustments && `${st.adjustments} koryg.`].filter(Boolean).join(', ');

  return (
    <DialogWindow title="Właściwości dokumentu" width={470} modal testId="docprops-dialog" onClose={onClose}>
      <div className="px-4 pt-1 pb-3 max-h-[70vh] overflow-y-auto">
        <SectionTitle>Plik</SectionTitle>
        <Row k="Nazwa" v={file.name} testId="dp-name" />
        <Row k="Położenie" v={file.location ?? 'Dokument jeszcze nie został zapisany'} testId="dp-location" />
        <Row k="Rozmiar pliku na dysku" v={file.fileSize !== null ? `${humanBytes(file.fileSize)} (${file.fileSize.toLocaleString('pl-PL')} B)` : '—'} />
        <Row k="Ostatni zapis" v={file.savedAt ? new Date(file.savedAt).toLocaleString('pl-PL') : '—'} />
        <Row k="Stan" v={file.dirty ? 'Zmieniony od ostatniego zapisu' : 'Bez zmian'} testId="dp-state" />

        <SectionTitle>Obraz</SectionTitle>
        <Row k="Wymiary" v={`${w} × ${h} px`} testId="dp-size" />
        <Row k="Liczba megapikseli" v={`${mp.toFixed(2)} Mpx`} />
        <Row k="Proporcje" v={`${w / g} : ${h / g}`} />
        <Row k="Rozmiar wydruku" v={`${cmW.toFixed(2)} × ${cmH.toFixed(2)} cm  (${inW.toFixed(2)} × ${inH.toFixed(2)} cala)`} testId="dp-print" />
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="text-[12px] text-[color:var(--h-999999,#999999)]">Rozdzielczość (PPI / DPI)</span>
          <div className="flex items-center gap-1.5">
            <ScrubField value={dpi} min={1} max={2400} suffix=" dpi" width={150} tall testId="dp-dpi" onChange={setDpi} />
            <button type="button" disabled={!dirty} onClick={() => onChangeDpi(dpi)} className={btnPrimary} data-testid="dp-apply">
              Zastosuj
            </button>
          </div>
        </div>
        <div className="text-[10.5px] text-[color:var(--h-888888,#888888)] pb-1">Zmiana rozdzielczości nie zmienia liczby pikseli, tylko docelowy rozmiar wydruku. Można ją cofnąć.</div>

        <SectionTitle>Kolor</SectionTitle>
        <Row k="Tryb koloru" v="RGB + kanał alfa (przezroczystość)" />
        <Row k="Głębia" v="8 bitów na kanał (32 bity na piksel)" />
        <Row k="Profil koloru" v="sRGB IEC61966-2.1 (wbudowany, bez profili osadzonych)" testId="dp-profile" />
        <Row k="Przestrzeń robocza" v="sRGB" />

        <SectionTitle>Zawartość</SectionTitle>
        <Row k="Warstwy" v={`${st.layers}${kind ? ` (${kind})` : ''}`} testId="dp-layers" />
        <Row k="Maski warstw" v={st.masks} />
        <Row k="Obiekty wektorowe" v={`${st.objects}${st.smartObjects ? ` (w tym inteligentnych: ${st.smartObjects})` : ''}`} />
        <Row k="Korekcje i efekty" v={st.corrections} />

        <SectionTitle>Pamięć</SectionTitle>
        <Row k="Piksele warstw w pamięci" v={humanBytes(st.pixelBytes)} testId="dp-mem" />
        <Row k="Odpowiednik jednej warstwy płótna" v={humanBytes(w * h * 4)} />
        <Row k="Historia (cofnij / ponów)" v={`${st.historySteps} / ${st.redoSteps}`} />
        {mem && <Row k="Pamięć programu (sterta JS)" v={humanBytes(mem.usedJSHeapSize)} />}
      </div>
      <div className="flex justify-end gap-2 px-3 py-2.5 border-t border-[color:var(--h-333333,#333333)]">
        <button type="button" onClick={onClose} className={btnGhost} data-testid="dp-close">
          Zamknij
        </button>
      </div>
    </DialogWindow>
  );
};
