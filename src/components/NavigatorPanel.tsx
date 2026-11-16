/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Minus, Plus, Maximize2 } from 'lucide-react';
import type { GraphicEngine } from '../core/GraphicEngine.ts';
import { NavigatorPreview } from '../core/NavigatorPreview.ts';
import { ScrubField } from './ScrubField.tsx';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 25;
/** Maksymalny rozmiar ramki miniatury w panelu (szerokość panelu to 208 px). */
const BOX_MAX_W = 208;
const BOX_MAX_H = 190;
/** Czas jednej porcji odświeżania miniatury (ms) i odstęp między porcjami: reszta czasu należy do rysowania. */
const SLICE_MS = 6;
const SLICE_GAP_MS = 24;
const POLL_MS = 250;

interface NavigatorPanelProps {
  engine: GraphicEngine;
  zoom: number;
  panOffset: { x: number; y: number };
  /** Rozmiar obszaru płótna na ekranie (piksele CSS). */
  viewSize: { width: number; height: number };
  onChangeZoom: (z: number) => void;
  onChangePan: (p: { x: number; y: number }) => void;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * Panel „Nawigator”: miniatura całego dokumentu z ramką aktualnie widocznego fragmentu. Ramkę można przeciągać (przesuwa widok),
 * kliknięcie poza nią ustawia widok w tym miejscu, a kółko myszy i suwak zmieniają powiększenie.
 * Miniatura jest odświeżana tylko w bezczynności (nie w trakcie rysowania) i małymi porcjami, więc nie obciąża rysowania.
 */
export const NavigatorPanel: React.FC<NavigatorPanelProps> = ({ engine, zoom, panOffset, viewSize, onChangeZoom, onChangePan }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [aspectKey, setAspectKey] = useState(`${engine.width}x${engine.height}`);
  const W = engine.width;
  const H = engine.height;

  // ---- miniatura: odświeżanie w bezczynności ----
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const preview = new NavigatorPreview(engine);
    const cv = preview.canvas;
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;image-rendering:auto;pointer-events:none';
    box.insertBefore(cv, box.firstChild);

    let pointerDown = false;
    const down = () => { pointerDown = true; };
    const up = () => { pointerDown = false; };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    const tick = () => {
      timer = null;
      if (disposed) return;
      let next = POLL_MS;
      // Podczas rysowania (wciśnięty przycisk, trwa pociągnięcie pędzla) nic nie liczymy: odświeżenie czeka na koniec gestu
      const busy = (pointerDown && !draggingRef.current) || document.hidden || engine.brushEngine.isDrawing;
      if (!busy && preview.dirty) {
        const done = preview.update(SLICE_MS);
        const key = `${engine.width}x${engine.height}`;
        setAspectKey((k) => (k === key ? k : key));
        if (!done) next = SLICE_GAP_MS;
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
      cv.remove();
    };
  }, [engine]);

  // ---- geometria ----
  const aspect = W / H;
  let boxW = Math.min(BOX_MAX_W, BOX_MAX_H * aspect);
  let boxH = boxW / aspect;
  if (boxH > BOX_MAX_H) { boxH = BOX_MAX_H; boxW = boxH * aspect; }
  void aspectKey;

  // Fragment dokumentu widoczny na ekranie (współrzędne dokumentu): środek ekranu = punkt dokumentu leżący pod nim
  const cW = Math.max(1, viewSize.width);
  const cH = Math.max(1, viewSize.height);
  const centerX = W / 2 - panOffset.x / zoom;
  const centerY = H / 2 - panOffset.y / zoom;
  const visW = cW / zoom;
  const visH = cH / zoom;
  const rx = ((centerX - visW / 2) / W) * boxW;
  const ry = ((centerY - visH / 2) / H) * boxH;
  const rw = (visW / W) * boxW;
  const rh = (visH / H) * boxH;
  const coversAll = rw >= boxW && rh >= boxH && rx <= 0 && ry <= 0;

  // ---- przeciąganie ramki ----
  const draggingRef = useRef(false);
  const grabRef = useRef({ dx: 0, dy: 0 });
  const rafRef = useRef<number | null>(null);
  const pendingPan = useRef<{ x: number; y: number } | null>(null);
  const live = useRef({ zoom, W, H, boxW, boxH, onChangePan });
  live.current = { zoom, W, H, boxW, boxH, onChangePan };

  const docPoint = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    const L = live.current;
    return { x: ((e.clientX - r.left) / r.width) * L.W, y: ((e.clientY - r.top) / r.height) * L.H };
  };

  const moveViewTo = (cx: number, cy: number) => {
    const L = live.current;
    const x = clamp(cx, 0, L.W);
    const y = clamp(cy, 0, L.H);
    pendingPan.current = { x: (L.W / 2 - x) * L.zoom, y: (L.H / 2 - y) * L.zoom };
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const p = pendingPan.current;
        pendingPan.current = null;
        if (p) live.current.onChangePan(p);
      });
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    draggingRef.current = true;
    const p = docPoint(e);
    const inside = p.x >= centerX - visW / 2 && p.x <= centerX + visW / 2 && p.y >= centerY - visH / 2 && p.y <= centerY + visH / 2;
    // w ramce: chwyt w miejscu kliknięcia (bez skoku); poza ramką: ramka przeskakuje na kliknięty punkt
    grabRef.current = inside && !coversAll ? { dx: p.x - centerX, dy: p.y - centerY } : { dx: 0, dy: 0 };
    moveViewTo(p.x - grabRef.current.dx, p.y - grabRef.current.dy);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const p = docPoint(e);
    moveViewTo(p.x - grabRef.current.dx, p.y - grabRef.current.dy);
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* wskaźnik już zwolniony */ }
  };

  // ---- powiększenie (z zachowaniem środka widoku) ----
  const setZoomKeepCenter = useCallback(
    (z: number) => {
      const nz = clamp(z, MIN_ZOOM, MAX_ZOOM);
      const L = live.current;
      // punkt dokumentu pod środkiem ekranu zostaje na miejscu: przesunięcie skaluje się razem z powiększeniem
      onChangeZoom(nz);
      const k = nz / L.zoom;
      const cur = pendingPan.current ?? panRef.current;
      L.onChangePan({ x: cur.x * k, y: cur.y * k });
    },
    [onChangeZoom]
  );
  const panRef = useRef(panOffset);
  panRef.current = panOffset;

  const fit = () => {
    const z = clamp(Math.min(cW / W, cH / H) * 0.95, MIN_ZOOM, MAX_ZOOM);
    onChangeZoom(z);
    onChangePan({ x: 0, y: 0 });
  };

  // kółko myszy na miniaturze zmienia powiększenie (natywny nasłuch: React rejestruje wheel jako bierny)
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const setZoomRef = useRef(setZoomKeepCenter);
  setZoomRef.current = setZoomKeepCenter;
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoomRef.current(zoomRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); }, []);

  const sliderValue = Math.log(zoom / MIN_ZOOM) / Math.log(MAX_ZOOM / MIN_ZOOM);

  return (
    <div className="flex flex-col gap-2" data-testid="navigator-panel">
      <div className="flex justify-center">
        <div
          ref={boxRef}
          data-testid="navigator-box"
          className="relative overflow-hidden border border-[color:var(--h-333333,#333333)] cursor-crosshair touch-none"
          style={{
            width: boxW,
            height: boxH,
            backgroundImage: 'repeating-conic-gradient(#d8d8d8 0% 25%, #ffffff 0% 50%)',
            backgroundSize: '10px 10px',
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div
            data-testid="navigator-view-rect"
            className="absolute pointer-events-none"
            style={{
              left: rx,
              top: ry,
              width: rw,
              height: rh,
              border: '1.5px solid #ff3b3b',
              boxShadow: coversAll ? 'none' : '0 0 0 9999px rgba(0,0,0,0.35)',
              boxSizing: 'border-box',
            }}
          />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setZoomKeepCenter(zoom / 1.25)}
          title="Pomniejsz"
          className="p-1 text-[color:var(--h-888888,#888888)] hover:text-[color:var(--t-white,#fff)] hover:bg-[color:var(--h-333333,#333333)] rounded cursor-pointer"
        >
          <Minus size={12} />
        </button>
        <div className="flex-1 min-w-0">
          <ScrubField
            value={zoom * 100}
            min={MIN_ZOOM * 100}
            max={MAX_ZOOM * 100}
            logScale
            wheelStep={5}
            step={0.01}
            format={(v) => String(Math.round(v))}
            suffix="%"
            chars={4}
            width="100%"
            title="Powiększenie"
            onChange={(v) => setZoomKeepCenter(v / 100)}
          />
        </div>
        <button
          type="button"
          onClick={() => setZoomKeepCenter(zoom * 1.25)}
          title="Powiększ"
          className="p-1 text-[color:var(--h-888888,#888888)] hover:text-[color:var(--t-white,#fff)] hover:bg-[color:var(--h-333333,#333333)] rounded cursor-pointer"
        >
          <Plus size={12} />
        </button>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[10.5px] font-mono text-[color:var(--h-bbbbbb,#bbbbbb)] tabular-nums" data-testid="navigator-zoom">
          {Math.round(zoom * 100)}%
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { onChangeZoom(1); onChangePan({ x: 0, y: 0 }); }}
            className="h-5 px-1.5 bg-[color:var(--h-2a2a2a,#2a2a2a)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)] text-[color:var(--h-aaaaaa,#aaaaaa)] hover:text-[color:var(--t-white,#fff)] border border-[color:var(--h-444444,#444444)] rounded text-[9.5px] cursor-pointer"
            title="Powiększenie 100%"
          >
            100%
          </button>
          <button
            type="button"
            onClick={fit}
            className="h-5 px-1.5 bg-[color:var(--h-2a2a2a,#2a2a2a)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)] text-[color:var(--h-aaaaaa,#aaaaaa)] hover:text-[color:var(--t-white,#fff)] border border-[color:var(--h-444444,#444444)] rounded text-[9.5px] cursor-pointer flex items-center gap-1"
            title="Dopasuj cały obraz do okna"
          >
            <Maximize2 size={9} /> Dopasuj
          </button>
        </div>
      </div>
      <div className="text-[9.5px] text-[color:var(--h-777777,#777777)] leading-snug">
        Podgląd orientacyjny: bez korekcji i efektów warstw. Przeciągnij czerwoną ramkę, aby przesunąć widok; kółko myszy zmienia powiększenie.
      </div>
    </div>
  );
};
