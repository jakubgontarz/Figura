/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Palette } from 'lucide-react';
import { SKColor, hexToSkColor, skColorToHex } from '../core/skia/types.ts';

// Domyślna 32-kolorowa paleta Paint.NET
export const DEFAULT_PALETTE_HEX = [
  '#000000', '#404040', '#FF0000', '#FF6A00', '#FFD800', '#B6FF00', '#4CFF00', '#00FF21',
  '#00FF90', '#00FFFF', '#0094FF', '#0026FF', '#4800FF', '#B200FF', '#FF00DC', '#FF006E',
  '#FFFFFF', '#808080', '#7F0000', '#7F3300', '#7F6A00', '#5B7F00', '#267F00', '#007F0E',
  '#007F46', '#007F7F', '#004A7F', '#00137F', '#24007F', '#59007F', '#7F006E', '#7F0037',
];

// Konwersje RGB <-> HSV
export function rgbToHsv(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h: h * 360, s, v };
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  h = (h % 360) / 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));

  let r = 0, g = 0, b = 0;
  switch (i) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  };
}


// Wspólna paleta próbek: ten sam zestaw w panelu kolorów i w oknach, które otwierają wybierak
let sharedPalette: string[] = DEFAULT_PALETTE_HEX;

/**
 * Wybierak koloru (kwadrat S-V, pasek barwy, przezroczystość, próbki) - ten sam w głównym panelu kolorów
 * i w małych panelach otwieranych z okien dialogowych.
 */
export const ColorPickerBody: React.FC<{
  color: SKColor;
  onChange: (c: SKColor) => void;
  onChangeSecondary?: (c: SKColor) => void;
  showAlpha?: boolean;
}> = ({ color: currentColor, onChange: updateCurrentColor, onChangeSecondary, showAlpha = true }) => {
  const [palette, setPaletteState] = useState<string[]>(sharedPalette);
  const setPalette = (p: string[]) => {
    sharedPalette = p;
    setPaletteState(p);
  };
  const hexString = skColorToHex(currentColor);
  const hsv = rgbToHsv(currentColor.r, currentColor.g, currentColor.b);
  const [hue, setHue] = useState(hsv.h);
  useEffect(() => {
    const newHsv = rgbToHsv(currentColor.r, currentColor.g, currentColor.b);
    if (newHsv.s > 0.05) setHue(newHsv.h);
  }, [currentColor.r, currentColor.g, currentColor.b]);

  const svBoxRef = useRef<HTMLDivElement>(null);
  const hueStripRef = useRef<HTMLDivElement>(null);
  const alphaTrackRef = useRef<HTMLDivElement>(null);
  const [isDraggingSv, setIsDraggingSv] = useState(false);
  const [isDraggingHue, setIsDraggingHue] = useState(false);
  const [isDraggingAlpha, setIsDraggingAlpha] = useState(false);
  // Obsługa przeciągania w kwadracie S-V
  const handleSvPointer = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!svBoxRef.current) return;
    const rect = svBoxRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    const s = x / rect.width;
    const v = 1 - y / rect.height;

    const rgb = hsvToRgb(hue, s, v);
    updateCurrentColor({
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      a: currentColor.a,
    });
  }, [hue, currentColor.a, updateCurrentColor]);

  // Obsługa paska Hue
  const handleHuePointer = useCallback((e: MouseEvent | React.MouseEvent) => {
    if (!hueStripRef.current) return;
    const rect = hueStripRef.current.getBoundingClientRect();
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const newHue = Math.max(0, Math.min(360, (y / rect.height) * 360));
    setHue(newHue);

    const currentHsv = rgbToHsv(currentColor.r, currentColor.g, currentColor.b);
    const rgb = hsvToRgb(newHue, Math.max(0.1, currentHsv.s), Math.max(0.1, currentHsv.v));
    updateCurrentColor({
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      a: currentColor.a,
    });
  }, [currentColor, updateCurrentColor]);

  // Obsługa paska Przezroczystości (Alpha)
  const handleAlphaPointer = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      if (!alphaTrackRef.current) return;
      const rect = alphaTrackRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const newAlpha = Math.round((x / rect.width) * 255);
      if (newAlpha !== currentColor.a) {
        updateCurrentColor({
          ...currentColor,
          a: newAlpha,
        });
      }
    },
    [currentColor, updateCurrentColor]
  );

  useEffect(() => {
    // Ruchy myszy są łączone: najwyżej jedna zmiana koloru na klatkę (każda przerysowuje całą aplikację)
    let raf: number | null = null;
    let lastEv: MouseEvent | null = null;
    const apply = () => {
      raf = null;
      const e = lastEv;
      lastEv = null;
      if (!e) return;
      if (isDraggingSv) handleSvPointer(e);
      if (isDraggingHue) handleHuePointer(e);
      if (isDraggingAlpha) handleAlphaPointer(e);
    };
    const onMouseMove = (e: MouseEvent) => {
      lastEv = e;
      if (raf === null) raf = requestAnimationFrame(apply);
    };
    const onMouseUp = () => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        apply();
      }
      setIsDraggingSv(false);
      setIsDraggingHue(false);
      setIsDraggingAlpha(false);
    };

    if (isDraggingSv || isDraggingHue || isDraggingAlpha) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDraggingSv, isDraggingHue, isDraggingAlpha, handleSvPointer, handleHuePointer, handleAlphaPointer]);

  // Dodanie koloru do palety
  const addColorToPalette = () => {
    if (!palette.includes(hexString)) {
      setPalette([hexString, ...palette.slice(0, 31)]);
    }
  };

  return (
    <div>
      {/* 2D Saturation-Value + Pasek Hue (CSS Grid, zredukowana wysokość 2:1) */}
      <div className="grid grid-cols-[1fr_14px] gap-2 mb-2 items-stretch">
        {/* Saturation-Value Box */}
        <div
          ref={svBoxRef}
          onMouseDown={(e) => {
            setIsDraggingSv(true);
            handleSvPointer(e);
          }}
          className="relative w-full aspect-[2/1] rounded-xs cursor-crosshair overflow-hidden border border-[#333]"
          style={{
            backgroundColor: `hsl(${hue}, 100%, 50%)`,
          }}
        >
          {/* Gradient nasycenia (biały do przezroczystego) */}
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(to right, #ffffff, transparent)',
            }}
          />
          {/* Gradient jasności (przezroczysty do czarnego) */}
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(to bottom, transparent, #000000)',
            }}
          />
          {/* Wskaźnik wybranego koloru */}
          <div
            className="absolute w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white pointer-events-none shadow"
            style={{
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
            }}
          />
        </div>

        {/* Pasek Tęczy (Hue Slider - ciągnący się na pełną wysokość) */}
        <div
          ref={hueStripRef}
          onMouseDown={(e) => {
            setIsDraggingHue(true);
            handleHuePointer(e);
          }}
          className="relative w-full h-full min-h-0 rounded-xs cursor-ns-resize border border-[#333]"
          style={{
            background:
              'linear-gradient(to bottom, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
          }}
        >
          <div
            className="absolute left-0 right-0 h-1 -translate-y-1/2 border border-black bg-white shadow-sm pointer-events-none"
            style={{ top: `${(hue / 360) * 100}%` }}
          />
        </div>
      </div>

      {/* Suwak przezroczystości (Alpha / Krycie pędzla) */}
      {showAlpha && (
      <div className="mb-2">
        <div className="flex justify-between text-[10px] text-[#999] mb-0.5">
          <span>Przezroczystość:</span>
          <span className="font-mono text-[#ccc]">{Math.round((currentColor.a / 255) * 100)}%</span>
        </div>
        <div
          ref={alphaTrackRef}
          onMouseDown={(e) => {
            setIsDraggingAlpha(true);
            handleAlphaPointer(e);
          }}
          className="relative h-3.5 rounded-xs border border-[#333] overflow-hidden cursor-pointer touch-none"
          style={{
            backgroundImage: `repeating-conic-gradient(#e4e4e4 0% 25%, #ffffff 0% 50%)`,
            backgroundSize: '8px 8px',
          }}
        >
          {/* Gradient koloru od alfa 0 do 255 */}
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(to right, rgba(${currentColor.r},${currentColor.g},${currentColor.b},0), rgba(${currentColor.r},${currentColor.g},${currentColor.b},1))`,
            }}
          />
          {/* Pionowy znacznik */}
          <div
            className="absolute top-0 bottom-0 w-1 -translate-x-1/2 border border-black bg-white shadow-sm pointer-events-none z-10"
            style={{ left: `${(currentColor.a / 255) * 100}%` }}
          />
        </div>
      </div>
      )}

      {/* Paleta próbek kolorów (kwadratowe próbki barw) */}
      <div className="border-t border-[#2a2a2a] pt-1.5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] text-[#888]">Próbki barw</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={addColorToPalette}
              title="Dodaj obecny kolor do palety"
              className="p-0.5 text-[#888] hover:text-white hover:bg-[#333] rounded cursor-pointer"
            >
              <Plus size={11} />
            </button>
            <button
              type="button"
              onClick={() => setPalette(DEFAULT_PALETTE_HEX)}
              title="Przywróć domyślną paletę"
              className="p-0.5 text-[#888] hover:text-white hover:bg-[#333] rounded cursor-pointer"
            >
              <Palette size={11} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-8 gap-1">
          {palette.slice(0, 32).map((c, i) => (
            <div
              key={`swatch-${i}`}
              onClick={() => updateCurrentColor(hexToSkColor(c, currentColor.a))}
              onContextMenu={(e) => {
                e.preventDefault();
                onChangeSecondary?.(hexToSkColor(c, currentColor.a));
              }}
              className="w-full aspect-[2/1] rounded-xs border border-[#222] cursor-pointer hover:scale-110 hover:border-white transition-transform"
              style={{ backgroundColor: c }}
              title={`${c} (LPM: kolor aktywny, PPM: kolor dodatkowy)`}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

let colorPopoverOpen = false;
/** Czy otwarty jest mały panel koloru (okna dialogowe nie powinny wtedy reagować na Esc / Enter). */
export const isColorPopoverOpen = (): boolean => colorPopoverOpen;

const hexOk = (v: string): boolean => /^#[0-9a-f]{6}$/i.test(v);

/**
 * Próbka koloru, która po kliknięciu otwiera mały panel z tym samym wybierakiem co główny panel kolorów
 * (zamiast systemowego okna wyboru koloru).
 */
export const ColorSwatchButton: React.FC<{ value: string; onChange: (hex: string) => void; className?: string }> = ({ value, onChange, className }) => {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const color = hexToSkColor(hexOk(value) ? value : '#000000', 255);
  const [hexInput, setHexInput] = useState(skColorToHex(color));
  useEffect(() => setHexInput(skColorToHex(color)), [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPanel = () => {
    const r = btnRef.current!.getBoundingClientRect();
    const W = 232;
    const H = 300;
    let x = r.right - W;
    let y = r.bottom + 4;
    if (y + H > window.innerHeight - 8) y = Math.max(8, r.top - H - 4);
    x = Math.max(8, Math.min(window.innerWidth - W - 8, x));
    setPos({ x, y });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    colorPopoverOpen = true;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && !(e.target instanceof HTMLInputElement))) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      colorPopoverOpen = false;
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openPanel())}
        title="Wybierz kolor"
        className={className ?? 'w-7 h-5 p-0 border border-[#3e3e3e] rounded cursor-pointer shrink-0'}
        style={{ backgroundColor: hexOk(value) ? value : '#000000' }}
      />
      {open &&
        createPortal(
          <div
            ref={panelRef}
            data-color-popover
            className="fixed z-[80] w-[232px] p-2 bg-[#1e1e1e] border border-[#3a3a3a] rounded-md shadow-2xl text-xs select-none"
            style={{ left: pos.x, top: pos.y }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5 mb-2">
              <div className="w-6 h-5 rounded-xs border border-[#444]" style={{ backgroundColor: skColorToHex(color) }} />
              <input
                type="text"
                value={hexInput}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  const v = e.target.value.toUpperCase();
                  setHexInput(v);
                  if (hexOk(v)) onChange(v.toLowerCase());
                }}
                onBlur={() => setHexInput(skColorToHex(color))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="flex-1 h-5 bg-[#121212] border border-[#444] rounded px-1 text-[10px] font-mono text-white text-center focus:outline-none focus:border-[#007acc]"
              />
            </div>
            <ColorPickerBody color={color} onChange={(c) => onChange(skColorToHex(c).toLowerCase())} showAlpha={false} />
          </div>,
          document.body
        )}
    </>
  );
};
