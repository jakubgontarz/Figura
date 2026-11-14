/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { CircleDashed, Copy, Eye, EyeOff, Plus, Save, Trash2 } from 'lucide-react';
import type { GraphicEngine } from '../core/GraphicEngine.ts';
import { NavigatorPreview } from '../core/NavigatorPreview.ts';
import { COLOR_CHANNELS, gridSignature, type ChannelCombine, type ColorChannel } from '../core/Channels.ts';

/** Dłuższy bok miniatury kanału (piksele rastra) i pole miniatury w wierszu (piksele CSS). */
const THUMB_RASTER = 96;
const BOX_W = 40;
const BOX_H = 30;
const SLICE_MS = 5;
const SLICE_GAP_MS = 24;
const POLL_MS = 300;

interface ChannelsPanelProps {
  engine: GraphicEngine;
  /** Wywoływane po każdej zmianie kanałów (odświeża płótno i panele). */
  onChanged: () => void;
}

const LABEL: Record<ColorChannel, string> = { r: 'Czerwony', g: 'Zielony', b: 'Niebieski' };
const SHORT: Record<ColorChannel, string> = { r: 'R', g: 'G', b: 'B' };
const MODES: { id: ChannelCombine; label: string }[] = [
  { id: 'replace', label: 'Zamień' },
  { id: 'add', label: 'Dodaj' },
  { id: 'subtract', label: 'Odejmij' },
  { id: 'intersect', label: 'Część wspólna' },
];

/** Miniatura jednego kanału: płótno rastra rysowane przez rodzica, w polu o stałym rozmiarze. */
const Thumb: React.FC<{ canvasRef: (el: HTMLCanvasElement | null) => void; w: number; h: number; checker?: boolean }> = ({ canvasRef, w, h, checker }) => (
  <div
    className="shrink-0 flex items-center justify-center border border-[#3a3a3a] bg-black overflow-hidden"
    style={{
      width: BOX_W + 2,
      height: BOX_H + 2,
      backgroundImage: checker ? 'conic-gradient(#d8d8d8 25%, #fff 0 50%, #d8d8d8 0 75%, #fff 0)' : undefined,
      backgroundSize: checker ? '8px 8px' : undefined,
    }}
  >
    <canvas ref={canvasRef} style={{ width: w, height: h, display: 'block' }} />
  </div>
);

/**
 * Panel „Kanały”: kompozyt RGB, kanały koloru (R, G, B) i kanały alfa (zapisane zaznaczenia).
 * Oko steruje widocznością na płótnie (filtr kolorów po stronie GPU przeglądarki + nakładka kanału alfa), zaznaczenie wiersza
 * wybiera kanały przyjmujące zmiany pikseli. Miniatury odświeżane są tylko w bezczynności i małymi porcjami.
 */
export const ChannelsPanel: React.FC<ChannelsPanelProps> = ({ engine, onChanged }) => {
  const ch = engine.channels;
  const [mode, setMode] = useState<ChannelCombine>('replace');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [thumbTick, setThumbTick] = useState(0);

  // rozmiar miniatury z zachowaniem proporcji dokumentu
  const aspect = engine.width / engine.height;
  let tw = BOX_W;
  let th = tw / aspect;
  if (th > BOX_H) { th = BOX_H; tw = th * aspect; }
  tw = Math.max(4, Math.round(tw));
  th = Math.max(4, Math.round(th));

  const canvases = useRef<Record<string, HTMLCanvasElement | null>>({});
  const drawnGrid = useRef<Record<string, { sig: string; el: HTMLCanvasElement }>>({});
  const setCanvas = (key: string) => (el: HTMLCanvasElement | null) => {
    canvases.current[key] = el;
  };

  // ---- miniatury kanałów koloru: odświeżanie w bezczynności ----
  useEffect(() => {
    const preview = new NavigatorPreview(engine, THUMB_RASTER);
    let pointerDown = false;
    const down = () => { pointerDown = true; };
    const up = () => { pointerDown = false; };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);

    const extract = () => {
      const src = preview.canvas;
      const w = src.width;
      const h = src.height;
      const comp = canvases.current['rgb'];
      if (comp) {
        if (comp.width !== w || comp.height !== h) { comp.width = w; comp.height = h; }
        const c = comp.getContext('2d')!;
        c.clearRect(0, 0, w, h);
        c.drawImage(src, 0, 0);
      }
      const data = src.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h);
      const d = data.data;
      COLOR_CHANNELS.forEach((k, idx) => {
        const el = canvases.current[k];
        if (!el) return;
        if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
        const out = new ImageData(w, h);
        const o = out.data;
        for (let i = 0; i < d.length; i += 4) {
          // odcień kanału (przezroczystość jako czerń, jak podgląd samego kanału)
          const v = Math.round((d[i + idx] * d[i + 3]) / 255);
          o[i] = o[i + 1] = o[i + 2] = v;
          o[i + 3] = 255;
        }
        el.getContext('2d')!.putImageData(out, 0, 0);
      });
    };

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const tick = () => {
      timer = null;
      if (disposed) return;
      let next = POLL_MS;
      const busy = pointerDown || document.hidden || engine.brushEngine.isDrawing;
      if (!busy && preview.dirty) {
        const done = preview.update(SLICE_MS);
        if (done) extract();
        else next = SLICE_GAP_MS;
      }
      timer = setTimeout(tick, next);
    };
    timer = setTimeout(tick, 0);
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, [engine]);

  // ---- miniatury kanałów alfa: rysowane przy zmianie siatki ----
  useEffect(() => {
    for (const c of ch.alpha) {
      const el = canvases.current['a:' + c.id];
      const prev = drawnGrid.current[c.id];
      // kanał jest edytowany w miejscu (pędzel), więc o odświeżeniu miniatury decyduje zawartość, nie tożsamość siatki
      const sig = el ? gridSignature(c.grid) : '';
      if (!el || (prev && prev.sig === sig && prev.el === el)) continue;
      drawnGrid.current[c.id] = { sig, el };
      const rw = aspect >= 1 ? THUMB_RASTER : Math.max(1, Math.round(THUMB_RASTER * aspect));
      const rh = aspect >= 1 ? Math.max(1, Math.round(THUMB_RASTER / aspect)) : THUMB_RASTER;
      el.width = rw;
      el.height = rh;
      const ctx = el.getContext('2d')!;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, rw, rh);
      c.grid.drawThumbnail(ctx, rw, rh);
    }
  });

  const changed = () => {
    setThumbTick((t) => t + 1);
    onChanged();
  };
  void thumbTick;

  // ---- zachowanie wierszy ----
  const clickComposite = () => {
    engine.exitChannelEdit();
    ch.selectComposite();
    changed();
  };
  const clickColor = (k: ColorChannel, e: React.MouseEvent) => {
    engine.exitChannelEdit();
    ch.selectColor(k, e.ctrlKey || e.metaKey || e.shiftKey);
    changed();
  };
  const modeFromEvent = (e: React.MouseEvent): ChannelCombine => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');
  const clickAlpha = (id: string, e: React.MouseEvent) => {
    // Ctrl / Cmd + klik: wczytanie kanału jako zaznaczenia (Shift: dodaj, Alt: odejmij, Shift + Alt: część wspólna)
    if (e.ctrlKey || e.metaKey) {
      engine.loadChannelAsSelection(id, modeFromEvent(e));
      changed();
      return;
    }
    ch.selectAlphaChannel(id);
    engine.beginChannelEdit(id);
    changed();
  };

  const selAlpha = ch.find(ch.selectedAlpha);
  const hasSelection = engine.selectionManager.hasActiveSelection;

  const onSave = () => {
    const id = engine.saveSelectionToChannel(mode, selAlpha ? selAlpha.id : null);
    if (id && !selAlpha) {
      ch.selectAlphaChannel(id);
      engine.beginChannelEdit(id);
    }
    changed();
  };
  const onLoad = () => {
    if (!selAlpha) return;
    engine.loadChannelAsSelection(selAlpha.id, mode);
    changed();
  };
  const onNew = () => {
    const id = engine.addEmptyChannel();
    ch.selectAlphaChannel(id);
    engine.beginChannelEdit(id);
    changed();
  };
  const onDup = () => {
    if (!selAlpha) return;
    const id = engine.duplicateChannel(selAlpha.id);
    if (id) {
      ch.selectAlphaChannel(id);
      engine.beginChannelEdit(id);
    }
    changed();
  };
  const onDel = () => {
    if (!selAlpha) return;
    engine.deleteChannel(selAlpha.id);
    changed();
  };

  const commitRename = () => {
    if (renaming) engine.renameChannel(renaming, draft);
    setRenaming(null);
    changed();
  };

  const allVisible = ch.visible.r && ch.visible.g && ch.visible.b;
  const compSelected = ch.isDefaultEdit() && ch.selectedAlpha === null;

  const rowBase = 'flex items-center gap-1.5 px-1 py-0.5 rounded border cursor-pointer';
  const rowCls = (sel: boolean) => `${rowBase} ${sel ? 'bg-[#10549c] border-[#2980b9] text-white' : 'bg-[#1e1e1e] hover:bg-[#282828] border-transparent text-[#ccc]'}`;
  const editing = !!engine.channelEdit;
  const eyeBtn = (on: boolean, onClick: () => void, testId: string, title: string, disabled = false) => (
    <button
      type="button"
      data-testid={testId}
      title={disabled ? 'Podczas edycji kanału alfa widać tylko ten kanał. Wybierz RGB, by wrócić do obrazu.' : title}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      className={`w-5 h-5 flex items-center justify-center shrink-0 text-[#bbb] ${disabled ? 'opacity-40 cursor-default' : 'hover:text-white cursor-pointer'}`}
    >
      {on ? <Eye size={13} /> : <EyeOff size={13} className="opacity-50" />}
    </button>
  );

  const restricted = !ch.isDefaultEdit();
  const editNames = COLOR_CHANNELS.filter((k) => ch.selected[k]).map((k) => SHORT[k]);

  const tbBtn = 'w-6 h-5.5 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors text-[#ccc] hover:bg-[#383838] hover:text-white cursor-pointer disabled:opacity-35 disabled:cursor-default disabled:hover:bg-[#282828] disabled:hover:text-[#ccc]';

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-1.5" data-testid="channels-panel">
      <div className="flex-1 overflow-y-auto border border-[#2a2a2a] rounded bg-[#141414] p-1 space-y-0.5 min-h-[120px] w-full">
        {/* kompozyt RGB */}
        <div data-testid="channels-row-composite" className={rowCls(compSelected)} onClick={clickComposite}>
          {eyeBtn(allVisible, () => { ch.toggleCompositeEye(); changed(); }, 'channels-eye-composite', 'Pokaż / ukryj wszystkie kanały koloru', editing)}
          <Thumb canvasRef={setCanvas('rgb')} w={tw} h={th} checker />
          <span className="text-[11px] truncate flex-1">RGB</span>
        </div>
        {COLOR_CHANNELS.map((k) => (
          <div key={k} data-testid={`channels-row-${k}`} className={rowCls(ch.selected[k] && !compSelected)} onClick={(e) => clickColor(k, e)}>
            {eyeBtn(ch.visible[k], () => { ch.toggleColorEye(k); changed(); }, `channels-eye-${k}`, `Pokaż / ukryj kanał: ${LABEL[k]}`, editing)}
            <Thumb canvasRef={setCanvas(k)} w={tw} h={th} />
            <span className="text-[11px] truncate flex-1">{LABEL[k]}</span>
          </div>
        ))}
        {ch.alpha.length > 0 && <div className="h-px bg-[#2a2a2a] my-1" />}
        {ch.alpha.map((c) => (
          <div
            key={c.id}
            data-testid={`channels-row-${c.id}`}
            className={rowCls(ch.selectedAlpha === c.id)}
            onClick={(e) => clickAlpha(c.id, e)}
            title="Klik: pokaż kanał. Ctrl+klik: wczytaj jako zaznaczenie (Shift: dodaj, Alt: odejmij, Shift+Alt: część wspólna)"
          >
            {eyeBtn(ch.alphaVisible.has(c.id), () => { ch.toggleAlphaEye(c.id); changed(); }, `channels-eye-${c.id}`, 'Pokaż / ukryj kanał alfa')}
            <Thumb canvasRef={setCanvas('a:' + c.id)} w={tw} h={th} />
            {renaming === c.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 h-5 bg-[#222] border border-[#007acc] rounded px-1 text-[11px] text-white focus:outline-none"
              />
            ) : (
              <span
                className="text-[11px] truncate flex-1"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setDraft(c.name);
                  setRenaming(c.id);
                }}
              >
                {c.name}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="text-[10px] leading-snug text-[#8a8a8a] min-h-[26px]" data-testid="channels-hint">
        {selAlpha
          ? 'Edycja kanału: pędzel, gumka, wiadro i gradient malują w kanale (biel = zaznaczone, czerń = niezaznaczone). Wybierz RGB, by wrócić do warstw.'
          : restricted
          ? `Zmiany pikseli trafiają tylko do kanałów: ${editNames.join(', ')}.`
          : 'Oko steruje widocznością na płótnie, zaznaczenie wiersza wybiera kanały do edycji.'}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <select
          data-testid="channels-mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as ChannelCombine)}
          title="Sposób łączenia przy zapisie do zaznaczonego kanału i przy wczytywaniu zaznaczenia"
          className="h-5.5 flex-1 min-w-0 bg-[#222] border border-[#444] rounded px-1 text-[10.5px] text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
        >
          {MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button type="button" data-testid="channels-load" className={tbBtn} disabled={!selAlpha} onClick={onLoad} title="Wczytaj zaznaczony kanał jako zaznaczenie">
          <CircleDashed size={13} />
        </button>
        <button type="button" data-testid="channels-save" className={tbBtn} disabled={!hasSelection} onClick={onSave} title={selAlpha ? 'Zapisz zaznaczenie w zaznaczonym kanale (wg trybu)' : 'Zapisz zaznaczenie jako nowy kanał'}>
          <Save size={13} />
        </button>
        <button type="button" data-testid="channels-new" className={tbBtn} onClick={onNew} title="Nowy, pusty kanał alfa">
          <Plus size={13} />
        </button>
        <button type="button" data-testid="channels-dup" className={tbBtn} disabled={!selAlpha} onClick={onDup} title="Duplikuj kanał">
          <Copy size={13} />
        </button>
        <button type="button" data-testid="channels-del" className={tbBtn} disabled={!selAlpha} onClick={onDel} title="Usuń kanał">
          <Trash2 size={13} />
        </button>
      </div>

      <label className="flex items-center gap-1.5 text-[10.5px] text-[#aaa] cursor-pointer select-none shrink-0">
        <input
          type="checkbox"
          data-testid="channels-gray"
          checked={ch.singleAsGray}
          onChange={(e) => {
            ch.singleAsGray = e.target.checked;
            ch.touch();
            changed();
          }}
          className="accent-[#007acc]"
        />
        Pojedynczy kanał w szarości
      </label>
    </div>
  );
};
