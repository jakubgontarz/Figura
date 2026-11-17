/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GraphicEngine } from '../core/GraphicEngine.ts';
import { EXPORT_FORMATS, ExportFormat, ExportOptions, ExportScope, encodeCanvas, exportSourceRect, formatInfo, humanBytes, renderExportCanvas, renderExportSource } from '../core/Export.ts';
import { DialogWindow } from './DialogWindow.tsx';
import { ScrubField } from './ScrubField.tsx';
import { ColorSwatchButton } from './ColorPicker.tsx';
import { btnGhost, btnPrimary, CHECKER_STYLE, FormRow, Seg, SectionTitle } from './formBits.tsx';
import { dialogOwnsKey } from '../core/dialogStack.ts';
import { SizeFields } from './SizeFields.tsx';
import type { LengthUnit } from '../core/Units.ts';
import { persist } from '../core/Persist.ts';

interface Props {
  engine: GraphicEngine;
  baseName: string;
  onClose: () => void;
  /** Zapisuje plik; zwraca true, gdy zapisano (okno się zamyka), false po anulowaniu okna zapisu */
  onExport: (opts: ExportOptions, fileName: string) => Promise<boolean>;
}

const KEY = 'figura.exportOptions.v1';
/** Powyżej tylu pikseli rozmiar pliku liczymy dopiero na życzenie. */
const AUTO_SIZE_PIXELS = 6_000_000;

interface Remembered {
  format: ExportFormat;
  quality: number;
  bgMode: 'transparent' | 'color';
  bgColor: string;
  srgbTag: boolean;
}

const loadRemembered = (): Remembered => {
  const d: Remembered = { format: 'png', quality: 90, bgMode: 'transparent', bgColor: '#ffffff', srgbTag: true };
  try {
    const r = JSON.parse(persist.get(KEY) || '{}');
    if (EXPORT_FORMATS.some((f) => f.id === r.format)) d.format = r.format;
    if (typeof r.quality === 'number') d.quality = Math.max(1, Math.min(100, r.quality));
    if (r.bgMode === 'color' || r.bgMode === 'transparent') d.bgMode = r.bgMode;
    if (typeof r.bgColor === 'string' && /^#[0-9a-f]{6}$/i.test(r.bgColor)) d.bgColor = r.bgColor;
    if (typeof r.srgbTag === 'boolean') d.srgbTag = r.srgbTag;
  } catch {
    /* domyślne */
  }
  return d;
};

export const ExportDialog: React.FC<Props> = ({ engine, baseName, onClose, onExport }) => {
  const mem = useMemo(loadRemembered, []);
  const hasSel = engine.selectionManager.hasActiveSelection;
  const active = engine.getActiveLayer();
  const layerOk = !!active && !active.isGroup && !active.isAdjustment && !active.isVector;
  const [format, setFormat] = useState<ExportFormat>(mem.format);
  const [quality, setQuality] = useState(mem.quality);
  const [scope, setScope] = useState<ExportScope>('document');
  const [bgMode, setBgMode] = useState<'transparent' | 'color'>(mem.bgMode);
  const [bgColor, setBgColor] = useState(mem.bgColor);
  const [srgbTag, setSrgbTag] = useState(mem.srgbTag);
  const [dpi, setDpi] = useState(Math.round(engine.dpi || 96));
  const [name, setName] = useState(baseName);
  const src = exportSourceRect(engine, scope);
  const [w, setW] = useState(src.w);
  const [h, setH] = useState(src.h);
  const [lock, setLock] = useState(true);
  const [unit, setUnit] = useState<LengthUnit>('px');
  const sizeErr = GraphicEngine.checkDocSize(w, h);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [bytes, setBytes] = useState<number | null>(null);
  const [sizing, setSizing] = useState(false);
  const info = formatInfo(format);

  // Zmiana zakresu przywraca rozmiar źródła
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    setW(src.w);
    setH(src.h);
  }, [scope, src.w, src.h]);

  const opts = (): ExportOptions => ({
    format,
    quality,
    scope,
    width: w,
    height: h,
    background: info.alpha ? (bgMode === 'color' ? bgColor : null) : bgMode === 'color' ? bgColor : '#ffffff',
    dpi,
    srgbTag,
  });

  // Podgląd (mały, z szachownicą)
  const previewRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = previewRef.current;
    if (!cv) return;
    const t = setTimeout(() => {
      try {
        const o = opts();
        const source = renderExportSource(engine, scope);
        const bg = !info.alpha || bgMode === 'color' ? (info.alpha ? bgColor : bgMode === 'color' ? bgColor : '#ffffff') : null;
        const maxSide = 240;
        const k = Math.min(1, maxSide / Math.max(source.width, source.height));
        cv.width = Math.max(1, Math.round(source.width * k));
        cv.height = Math.max(1, Math.round(source.height * k));
        const ctx = cv.getContext('2d')!;
        ctx.clearRect(0, 0, cv.width, cv.height);
        if (bg) {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, cv.width, cv.height);
        }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, cv.width, cv.height);
        void o;
      } catch {
        /* podgląd nie jest krytyczny */
      }
    }, 120);
    return () => clearTimeout(t);
  }, [engine, scope, format, bgMode, bgColor, info.alpha]); // eslint-disable-line react-hooks/exhaustive-deps

  // Szacowany rozmiar pliku
  const pixels = w * h;
  const computeSize = async () => {
    setSizing(true);
    try {
      const o = opts();
      const canvas = renderExportCanvas(engine, o);
      const out = await encodeCanvas(canvas, o);
      setBytes(out.length);
    } catch {
      setBytes(null);
    } finally {
      setSizing(false);
    }
  };
  useEffect(() => {
    setBytes(null);
    if (pixels > AUTO_SIZE_PIXELS || sizeErr) return;
    const t = setTimeout(() => void computeSize(), 350);
    return () => clearTimeout(t);
  }, [format, quality, scope, w, h, bgMode, bgColor, dpi, srgbTag]); // eslint-disable-line react-hooks/exhaustive-deps

  const doExport = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      persist.set(KEY, JSON.stringify({ format, quality, bgMode, bgColor, srgbTag }));
      const ok = await onExport(opts(), `${name.trim() || 'obraz'}.${info.ext}`);
      if (ok) onClose();
    } catch (e: any) {
      setErr(e?.message || 'Nie udało się zapisać pliku');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'export-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void doExport();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <DialogWindow title="Eksportuj obraz" width={640} modal testId="export-dialog" onClose={onClose}>
      <div className="flex gap-4 px-4 pt-2 pb-3">
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <SectionTitle>Format</SectionTitle>
          <div className="flex flex-col gap-1.5">
            <Seg value={format} options={EXPORT_FORMATS.map((f) => ({ id: f.id, label: f.label }))} onChange={setFormat} testId="export-format" />
            <div className="text-[10.5px] text-[color:var(--h-888888,#888888)] leading-snug">{info.hint}</div>
          </div>
          {info.lossy && (
            <FormRow label="Jakość" hint={quality >= 95 ? 'Prawie bez strat, duży plik' : quality >= 80 ? 'Dobra jakość' : quality >= 50 ? 'Średnia' : 'Niska, mały plik'}>
              <ScrubField value={quality} min={1} max={100} suffix="%" width={170} tall testId="export-quality" onChange={setQuality} />
            </FormRow>
          )}
          <FormRow label="Zakres">
            <Seg
              value={scope}
              onChange={setScope}
              testId="export-scope"
              options={[
                { id: 'document', label: 'Cały obraz', title: 'Wszystkie widoczne warstwy' },
                { id: 'selection', label: 'Zaznaczenie', disabled: !hasSel, title: hasSel ? 'Prostokąt obejmujący zaznaczenie' : 'Brak zaznaczenia' },
                { id: 'layer', label: 'Aktywna warstwa', disabled: !layerOk, title: layerOk ? 'Tylko aktywna warstwa rastrowa' : 'Wymaga aktywnej warstwy rastrowej' },
              ]}
            />
          </FormRow>

          <SectionTitle>Rozmiar</SectionTitle>
          <SizeFields width={src.w} height={src.h} wPx={w} hPx={h} dpi={dpi} unit={unit} onUnit={setUnit} lock={lock} onLock={setLock} onChange={(nw, nh) => { setW(nw); setH(nh); }} testPrefix="export" />
          <div className="flex items-center justify-between text-[11px] text-[color:var(--h-888888,#888888)]">
            <span>Oryginał: {src.w} × {src.h} px</span>
            {(w !== src.w || h !== src.h) && (
              <button type="button" className="underline cursor-pointer" onClick={() => { setW(src.w); setH(src.h); }}>
                Przywróć oryginał
              </button>
            )}
          </div>
          <FormRow label="Rozdzielczość" hint={info.dpiMeta ? 'Zapisana w pliku (nie zmienia liczby pikseli)' : 'Ten format nie zapisuje rozdzielczości'}>
            <ScrubField value={dpi} min={1} max={2400} suffix=" dpi" width={170} tall disabled={!info.dpiMeta} testId="export-dpi" onChange={setDpi} />
          </FormRow>
          <div className="text-[11px] text-[color:var(--h-888888,#888888)]">
            Rozmiar wydruku: {((w / dpi) * 2.54).toFixed(1)} × {((h / dpi) * 2.54).toFixed(1)} cm
          </div>

          <SectionTitle>Tło i kolor</SectionTitle>
          <FormRow label="Tło pod przezroczystością" hint={info.alpha ? undefined : 'Ten format nie ma przezroczystości'}>
            <div className="flex items-center gap-2">
              <Seg
                value={info.alpha ? bgMode : 'color'}
                onChange={setBgMode}
                testId="export-bg"
                options={[
                  { id: 'transparent', label: 'Brak', disabled: !info.alpha },
                  { id: 'color', label: 'Kolor' },
                ]}
              />
              <span className={`inline-block w-6 h-6 rounded border border-[color:var(--h-555555,#555555)] relative ${info.alpha && bgMode === 'transparent' ? 'opacity-40 pointer-events-none' : ''}`} style={{ background: bgColor }}>
                <ColorSwatchButton value={bgColor} onChange={setBgColor} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer p-0" />
              </span>
            </div>
          </FormRow>
          {format === 'png' && (
            <FormRow label="Znacznik profilu sRGB" hint="Dopisuje do pliku informację, że kolory są w przestrzeni sRGB">
              <input type="checkbox" checked={srgbTag} onChange={(e) => setSrgbTag(e.target.checked)} data-testid="export-srgb" />
            </FormRow>
          )}
          <SectionTitle>Plik</SectionTitle>
          <FormRow label="Nazwa pliku">
            <div className="flex items-center gap-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="export-name"
                className="h-7 w-[170px] px-2 bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[color:var(--h-444444,#444444)] rounded text-xs text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]"
              />
              <span className="text-xs text-[color:var(--h-888888,#888888)]">.{info.ext}</span>
            </div>
          </FormRow>
        </div>

        <div className="w-[240px] shrink-0 flex flex-col gap-2">
          <SectionTitle>Podgląd</SectionTitle>
          <div className="rounded border border-[color:var(--h-333333,#333333)] p-1.5 flex items-center justify-center min-h-[170px] bg-[color:var(--h-181818,#181818)]">
            <canvas ref={previewRef} data-testid="export-preview" className="max-w-full" style={{ imageRendering: 'auto', ...CHECKER_STYLE }} />
          </div>
          <div className="text-[11.5px] text-[color:var(--h-cccccc,#cccccc)] leading-relaxed">
            <div>
              {w} × {h} px · {info.label}
            </div>
            <div data-testid="export-size" className="text-[color:var(--h-aaaaaa,#aaaaaa)]">
              {bytes !== null ? `Rozmiar pliku: ${humanBytes(bytes)}` : sizing ? 'Liczenie rozmiaru pliku…' : pixels > AUTO_SIZE_PIXELS ? 'Duży obraz: rozmiar pliku liczony na życzenie' : '…'}
            </div>
            {pixels > AUTO_SIZE_PIXELS && (
              <button type="button" onClick={() => void computeSize()} disabled={sizing} className={`${btnGhost} mt-1.5`} data-testid="export-calc">
                Oblicz rozmiar pliku
              </button>
            )}
          </div>
          {(err || sizeErr) && <div className="text-[11px] text-[color:var(--c-err,#ff8080)]">{err || sizeErr}</div>}
        </div>
      </div>
      <div className="flex justify-end gap-2 px-3 py-2.5 border-t border-[color:var(--h-333333,#333333)]">
        <button type="button" onClick={onClose} className={btnGhost} data-testid="export-cancel">
          Anuluj
        </button>
        <button type="button" onClick={() => void doExport()} disabled={busy || !!sizeErr} className={btnPrimary} data-testid="export-ok">
          {busy ? 'Zapisywanie…' : 'Eksportuj…'}
        </button>
      </div>
    </DialogWindow>
  );
};
