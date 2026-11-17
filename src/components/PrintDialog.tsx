/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GraphicEngine } from '../core/GraphicEngine.ts';
import { ExportScope, exportSourceRect, renderExportSource } from '../core/Export.ts';
import { printHtml } from '../platform/index.ts';
import { DialogWindow } from './DialogWindow.tsx';
import { ScrubField } from './ScrubField.tsx';
import { btnGhost, btnPrimary, CHECKER_STYLE, FormRow, Seg, SectionTitle } from './formBits.tsx';
import { dialogOwnsKey } from '../core/dialogStack.ts';
import { persist } from '../core/Persist.ts';

interface Props {
  engine: GraphicEngine;
  docName: string;
  onClose: () => void;
}

const PAPERS = [
  { id: 'A3', label: 'A3 (297 × 420 mm)', w: 297, h: 420 },
  { id: 'A4', label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  { id: 'A5', label: 'A5 (148 × 210 mm)', w: 148, h: 210 },
  { id: 'B5', label: 'B5 (176 × 250 mm)', w: 176, h: 250 },
  { id: 'Letter', label: 'Letter (216 × 279 mm)', w: 215.9, h: 279.4 },
  { id: 'Legal', label: 'Legal (216 × 356 mm)', w: 215.9, h: 355.6 },
  { id: '10x15', label: 'Zdjęcie 10 × 15 cm', w: 100, h: 150 },
  { id: '13x18', label: 'Zdjęcie 13 × 18 cm', w: 130, h: 180 },
] as const;

type Fit = 'fit' | 'fill' | 'actual' | 'custom';
type Orient = 'auto' | 'portrait' | 'landscape';
type Align = 'center' | 'top';

const KEY = 'figura.printOptions.v1';

interface Remembered {
  paper: string;
  orient: Orient;
  margin: number;
  fit: Fit;
  scale: number;
  align: Align;
  scope: ExportScope;
}

const loadRemembered = (): Remembered => {
  const d: Remembered = { paper: 'A4', orient: 'auto', margin: 10, fit: 'fit', scale: 100, align: 'center', scope: 'document' };
  try {
    const r = JSON.parse(persist.get(KEY) || '{}');
    if (PAPERS.some((p) => p.id === r.paper)) d.paper = r.paper;
    if (['auto', 'portrait', 'landscape'].includes(r.orient)) d.orient = r.orient;
    if (typeof r.margin === 'number') d.margin = Math.max(0, Math.min(50, r.margin));
    if (['fit', 'fill', 'actual', 'custom'].includes(r.fit)) d.fit = r.fit;
    if (typeof r.scale === 'number') d.scale = Math.max(1, Math.min(1000, r.scale));
    if (['center', 'top'].includes(r.align)) d.align = r.align;
  } catch {
    /* domyślne */
  }
  return d;
};

export const PrintDialog: React.FC<Props> = ({ engine, docName, onClose }) => {
  const mem = useMemo(loadRemembered, []);
  const hasSel = engine.selectionManager.hasActiveSelection;
  const [paper, setPaper] = useState(mem.paper);
  const [orient, setOrient] = useState<Orient>(mem.orient);
  const [margin, setMargin] = useState(mem.margin);
  const [fit, setFit] = useState<Fit>(mem.fit);
  const [scale, setScale] = useState(mem.scale);
  const [align, setAlign] = useState<Align>(mem.align);
  const [scope, setScope] = useState<ExportScope>('document');
  const [dpi, setDpi] = useState(Math.round(engine.dpi || 96));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const src = exportSourceRect(engine, scope);

  const p = PAPERS.find((x) => x.id === paper)!;
  // orientacja „auto” dopasowuje papier do proporcji obrazu
  const landscape = orient === 'landscape' || (orient === 'auto' && src.w > src.h);
  const pageW = landscape ? p.h : p.w;
  const pageH = landscape ? p.w : p.h;
  const areaW = Math.max(1, pageW - 2 * margin);
  const areaH = Math.max(1, pageH - 2 * margin);
  const actualW = (src.w / dpi) * 25.4;
  const actualH = (src.h / dpi) * 25.4;
  // rozmiar obrazu na papierze (mm)
  let imgW: number, imgH: number;
  if (fit === 'actual') {
    imgW = actualW;
    imgH = actualH;
  } else if (fit === 'custom') {
    imgW = (actualW * scale) / 100;
    imgH = (actualH * scale) / 100;
  } else {
    const k = fit === 'fit' ? Math.min(areaW / src.w, areaH / src.h) : Math.max(areaW / src.w, areaH / src.h);
    imgW = src.w * k;
    imgH = src.h * k;
  }
  const overflow = imgW > areaW + 0.01 || imgH > areaH + 0.01;
  const effectiveDpi = Math.round((src.w / imgW) * 25.4);

  const previewRef = useRef<HTMLCanvasElement>(null);
  const thumb = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    try {
      const s = renderExportSource(engine, scope);
      const k = Math.min(1, 300 / Math.max(s.width, s.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(s.width * k));
      c.height = Math.max(1, Math.round(s.height * k));
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(s, 0, 0, c.width, c.height);
      thumb.current = c;
    } catch {
      thumb.current = null;
    }
    drawPreview();
  }, [engine, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const PV = 260; // dłuższy bok podglądu strony (px)
  const drawPreview = () => {
    const cv = previewRef.current;
    if (!cv) return;
    const k = PV / Math.max(pageW, pageH);
    cv.width = Math.round(pageW * k);
    cv.height = Math.round(pageH * k);
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    // obszar zadruku
    ctx.strokeStyle = '#bbbbbb';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(margin * k + 0.5, margin * k + 0.5, areaW * k - 1, areaH * k - 1);
    ctx.setLineDash([]);
    const t = thumb.current;
    if (!t) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(margin * k, margin * k, areaW * k, areaH * k);
    ctx.clip();
    const x = margin * k + (areaW - imgW) * k / 2;
    const y = align === 'center' ? margin * k + (areaH - imgH) * k / 2 : margin * k;
    ctx.drawImage(t, x, y, imgW * k, imgH * k);
    ctx.restore();
  };
  useEffect(drawPreview); // eslint-disable-line react-hooks/exhaustive-deps

  const doPrint = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      persist.set(KEY, JSON.stringify({ paper, orient, margin, fit, scale, align }));
      const source = renderExportSource(engine, scope);
      // biała podkładka pod przezroczystością, żeby drukarka nie dawała czarnego tła
      const flat = document.createElement('canvas');
      flat.width = source.width;
      flat.height = source.height;
      const ctx = flat.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, flat.width, flat.height);
      ctx.drawImage(source, 0, 0);
      const url = flat.toDataURL('image/png');
      const top = align === 'center' ? (areaH - imgH) / 2 : 0;
      const left = (areaW - imgW) / 2;
      const title = (docName || 'Figura').replace(/[<>&"]/g, '');
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
@page{size:${pageW}mm ${pageH}mm;margin:0}
html,body{margin:0;padding:0;background:#fff}
.page{position:relative;width:${pageW}mm;height:${pageH}mm;overflow:hidden;page-break-after:avoid}
.area{position:absolute;left:${margin}mm;top:${margin}mm;width:${areaW}mm;height:${areaH}mm;overflow:hidden}
img{position:absolute;left:${left}mm;top:${top}mm;width:${imgW}mm;height:${imgH}mm;image-rendering:auto}
</style></head><body><div class="page"><div class="area"><img src="${url}"></div></div></body></html>`;
      await printHtml(html);
      onClose();
    } catch (e: any) {
      setErr(e?.message || 'Nie udało się rozpocząć drukowania');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'print-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        void doPrint();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  return (
    <DialogWindow title="Drukuj" width={700} modal testId="print-dialog" onClose={onClose}>
      <div className="flex gap-4 px-4 pt-2 pb-3">
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <SectionTitle>Papier</SectionTitle>
          <FormRow label="Rozmiar">
            <select
              value={paper}
              onChange={(e) => setPaper(e.target.value)}
              data-testid="print-paper"
              className="h-7 w-[190px] px-1.5 bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[color:var(--h-444444,#444444)] rounded text-xs text-[color:var(--t-white,#fff)]"
            >
              {PAPERS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label="Orientacja" hint={orient === 'auto' ? `Dobrana do obrazu: ${landscape ? 'pozioma' : 'pionowa'}` : undefined}>
            <Seg
              value={orient}
              onChange={setOrient}
              testId="print-orient"
              options={[
                { id: 'auto', label: 'Auto' },
                { id: 'portrait', label: 'Pionowa' },
                { id: 'landscape', label: 'Pozioma' },
              ]}
            />
          </FormRow>
          <FormRow label="Marginesy">
            <ScrubField value={margin} min={0} max={50} suffix=" mm" width={170} tall testId="print-margin" onChange={setMargin} />
          </FormRow>

          <SectionTitle>Obraz</SectionTitle>
          <FormRow label="Zakres">
            <Seg
              value={scope}
              onChange={setScope}
              testId="print-scope"
              options={[
                { id: 'document', label: 'Cały obraz' },
                { id: 'selection', label: 'Zaznaczenie', disabled: !hasSel },
              ]}
            />
          </FormRow>
          <FormRow label="Skalowanie">
            <Seg
              value={fit}
              onChange={setFit}
              testId="print-fit"
              options={[
                { id: 'fit', label: 'Dopasuj', title: 'Cały obraz mieści się na stronie' },
                { id: 'fill', label: 'Wypełnij', title: 'Strona wypełniona, brzegi obrazu mogą zostać obcięte' },
                { id: 'actual', label: 'Rzeczywisty', title: 'Rozmiar wynikający z rozdzielczości obrazu' },
                { id: 'custom', label: 'Własne' },
              ]}
            />
          </FormRow>
          {(fit === 'actual' || fit === 'custom') && (
            <FormRow label="Rozdzielczość obrazu" hint="Do obliczenia rozmiaru rzeczywistego">
              <ScrubField value={dpi} min={1} max={2400} suffix=" dpi" width={170} tall testId="print-dpi" onChange={setDpi} />
            </FormRow>
          )}
          {fit === 'custom' && (
            <FormRow label="Skala">
              <ScrubField value={scale} min={1} max={1000} logScale suffix="%" width={170} tall testId="print-scale" onChange={setScale} />
            </FormRow>
          )}
          <FormRow label="Położenie">
            <Seg
              value={align}
              onChange={setAlign}
              testId="print-align"
              options={[
                { id: 'center', label: 'Środek' },
                { id: 'top', label: 'Góra' },
              ]}
            />
          </FormRow>
          <div className="text-[10.5px] text-[color:var(--h-888888,#888888)] leading-snug">
            Wybór drukarki, liczby kopii i jakości wydruku następuje w następnym oknie (systemowym).
          </div>
        </div>

        <div className="w-[250px] shrink-0 flex flex-col gap-2">
          <SectionTitle>Podgląd strony</SectionTitle>
          <div className="rounded border border-[color:var(--h-333333,#333333)] p-2 flex items-center justify-center min-h-[200px] bg-[color:var(--h-181818,#181818)]">
            <canvas ref={previewRef} data-testid="print-preview" className="shadow-[0_2px_8px_rgba(0,0,0,0.5)]" />
          </div>
          <div className="text-[11.5px] text-[color:var(--h-cccccc,#cccccc)] leading-relaxed" data-testid="print-info">
            <div>
              Obraz na papierze: {(imgW / 10).toFixed(1)} × {(imgH / 10).toFixed(1)} cm
            </div>
            <div className={effectiveDpi < 150 ? 'text-[color:var(--c-warn,#e5b567)]' : 'text-[color:var(--h-aaaaaa,#aaaaaa)]'}>
              Rozdzielczość wydruku: ok. {effectiveDpi} dpi{effectiveDpi < 150 ? ' (niska)' : ''}
            </div>
            {overflow && <div className="text-[color:var(--c-warn,#e5b567)]">Obraz wykracza poza pole zadruku i zostanie obcięty.</div>}
          </div>
          {err && <div className="text-[11px] text-[color:var(--c-err,#ff8080)]">{err}</div>}
        </div>
      </div>
      <div className="flex justify-end gap-2 px-3 py-2.5 border-t border-[color:var(--h-333333,#333333)]">
        <button type="button" onClick={onClose} className={btnGhost} data-testid="print-cancel">
          Anuluj
        </button>
        <button type="button" onClick={() => void doPrint()} disabled={busy} className={btnPrimary} data-testid="print-ok">
          {busy ? 'Przygotowanie…' : 'Drukuj…'}
        </button>
      </div>
    </DialogWindow>
  );
};
