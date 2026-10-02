/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ArrowLeftRight, Plus, Palette } from 'lucide-react';
import { SKColor, hexToSkColor, skColorToHex } from '../core/skia/types.ts';

interface ColorPanelProps {
  primaryColor: SKColor;
  secondaryColor: SKColor;
  onChangePrimaryColor: (color: SKColor) => void;
  onChangeSecondaryColor: (color: SKColor) => void;
}

// Domyślna 32-kolorowa paleta Paint.NET
const DEFAULT_PALETTE_HEX = [
  '#000000', '#404040', '#FF0000', '#FF6A00', '#FFD800', '#B6FF00', '#4CFF00', '#00FF21',
  '#00FF90', '#00FFFF', '#0094FF', '#0026FF', '#4800FF', '#B200FF', '#FF00DC', '#FF006E',
  '#FFFFFF', '#808080', '#7F0000', '#7F3300', '#7F6A00', '#5B7F00', '#267F00', '#007F0E',
  '#007F46', '#007F7F', '#004A7F', '#00137F', '#24007F', '#59007F', '#7F006E', '#7F0037',
];

// Konwersje RGB <-> HSV
function rgbToHsv(r: number, g: number, b: number) {
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

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
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

export const ColorPanel: React.FC<ColorPanelProps> = ({
  primaryColor,
  secondaryColor,
  onChangePrimaryColor,
  onChangeSecondaryColor,
}) => {
  const [activeSlot, setActiveSlot] = useState<'primary' | 'secondary'>('primary');
  const [colorMode, setColorMode] = useState<'hsv' | 'rgb'>('hsv');
  const [palette, setPalette] = useState<string[]>(DEFAULT_PALETTE_HEX);

  const currentColor = activeSlot === 'primary' ? primaryColor : secondaryColor;
  const updateCurrentColor = activeSlot === 'primary' ? onChangePrimaryColor : onChangeSecondaryColor;

  const hexString = skColorToHex(currentColor);
  const [hexInput, setHexInput] = useState(hexString);

  useEffect(() => {
    setHexInput(hexString);
  }, [hexString]);

  // HSV State
  const hsv = rgbToHsv(currentColor.r, currentColor.g, currentColor.b);
  const [hue, setHue] = useState(hsv.h);

  // Aktualizacja Hue tylko gdy faktycznie zmieniono kolor o wyraźnym nasyceniu
  useEffect(() => {
    const newHsv = rgbToHsv(currentColor.r, currentColor.g, currentColor.b);
    if (newHsv.s > 0.05) {
      setHue(newHsv.h);
    }
  }, [currentColor.r, currentColor.g, currentColor.b]);

  const svBoxRef = useRef<HTMLDivElement>(null);
  const hueStripRef = useRef<HTMLDivElement>(null);
  const [isDraggingSv, setIsDraggingSv] = useState(false);
  const [isDraggingHue, setIsDraggingHue] = useState(false);

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

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (isDraggingSv) handleSvPointer(e);
      if (isDraggingHue) handleHuePointer(e);
    };
    const onMouseUp = () => {
      setIsDraggingSv(false);
      setIsDraggingHue(false);
    };

    if (isDraggingSv || isDraggingHue) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDraggingSv, isDraggingHue, handleSvPointer, handleHuePointer]);

  // Zamiana koloru głównego z dodatkowym
  const swapColors = () => {
    const temp = { ...primaryColor };
    onChangePrimaryColor(secondaryColor);
    onChangeSecondaryColor(temp);
  };

  // Dodanie koloru do palety
  const addColorToPalette = () => {
    if (!palette.includes(hexString)) {
      setPalette([hexString, ...palette.slice(0, 31)]);
    }
  };

  return (
    <div className="border border-[#3c3c3c] bg-[#1e1e1e] rounded p-2 text-xs select-none">
      {/* Nagłówek Grupy w stylu Paint.NET / WPF GroupBox */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-semibold text-[#c8c8c8] tracking-wide">Kolor</span>
        <div className="h-[1px] bg-[#3a3a3a] flex-1" />
      </div>

      {/* Górny wiersz: Podgląd Kolorów + Hex + Przycisk Metoda */}
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-1.5">
          {/* Nakładające się kwadraty koloru głównego i dodatkowego */}
          <div className="relative w-8 h-8">
            {/* Dodatkowy (w tle) */}
            <div
              onClick={() => setActiveSlot('secondary')}
              title="Kolor dodatkowy (kliknij, aby edytować)"
              className={`absolute right-0 bottom-0 w-5 h-5 rounded-xs border cursor-pointer z-0 transition-transform ${
                activeSlot === 'secondary' ? 'border-[#007acc] scale-110 z-20 shadow-md' : 'border-[#222]'
              }`}
              style={{
                backgroundColor: `rgba(${secondaryColor.r}, ${secondaryColor.g}, ${secondaryColor.b}, ${secondaryColor.a / 255})`,
              }}
            />
            {/* Główny (na wierzchu) */}
            <div
              onClick={() => setActiveSlot('primary')}
              title="Kolor główny (kliknij, aby edytować)"
              className={`absolute left-0 top-0 w-5 h-5 rounded-xs border cursor-pointer z-10 transition-transform ${
                activeSlot === 'primary' ? 'border-[#007acc] scale-110 z-20 shadow-md' : 'border-[#222]'
              }`}
              style={{
                backgroundColor: `rgba(${primaryColor.r}, ${primaryColor.g}, ${primaryColor.b}, ${primaryColor.a / 255})`,
              }}
            />
          </div>

          {/* Przycisk zamiany ⇄ */}
          <button
            type="button"
            onClick={swapColors}
            title="Zamień kolory (X)"
            className="p-1 text-[#888] hover:text-white hover:bg-[#333] rounded"
          >
            <ArrowLeftRight size={12} />
          </button>
        </div>

        {/* Pole Hex */}
        <div className="flex items-center gap-1">
          <input
            type="text"
            value={hexInput}
            onChange={(e) => {
              const val = e.target.value.toUpperCase();
              setHexInput(val);
              if (/^#[0-9A-F]{6}$/i.test(val)) {
                const parsed = hexToSkColor(val, currentColor.a);
                updateCurrentColor(parsed);
              }
            }}
            onBlur={() => setHexInput(hexString)}
            className="w-18 h-5 bg-[#121212] border border-[#444] rounded px-1.5 text-[11px] font-mono text-white text-center focus:outline-none focus:border-[#007acc]"
          />
          <button
            type="button"
            onClick={() => setColorMode(colorMode === 'hsv' ? 'rgb' : 'hsv')}
            className="h-5 px-2 bg-[#2a2a2a] hover:bg-[#3a3a3a] text-[#aaa] hover:text-white border border-[#444] rounded text-[10px]"
            title="Przełącz tryb suwaków (HSV / RGB)"
          >
            Metoda
          </button>
        </div>
      </div>

      {/* Kwadrat 2D Saturation-Value + Pasek Hue */}
      <div className="flex gap-2 mb-2">
        {/* Saturation-Value Box */}
        <div
          ref={svBoxRef}
          onMouseDown={(e) => {
            setIsDraggingSv(true);
            handleSvPointer(e);
          }}
          className="relative flex-1 h-[140px] rounded-xs cursor-crosshair overflow-hidden border border-[#333]"
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
            className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white pointer-events-none shadow"
            style={{
              left: `${hsv.s * 100}%`,
              top: `${(1 - hsv.v) * 100}%`,
            }}
          />
        </div>

        {/* Pasek Tęczy (Hue Slider) */}
        <div
          ref={hueStripRef}
          onMouseDown={(e) => {
            setIsDraggingHue(true);
            handleHuePointer(e);
          }}
          className="relative w-4 h-[140px] rounded-xs cursor-ns-resize border border-[#333]"
          style={{
            background:
              'linear-gradient(to bottom, #ff0000 0%, #ffff00 17%, #00ff00 33%, #00ffff 50%, #0000ff 67%, #ff00ff 83%, #ff0000 100%)',
          }}
        >
          <div
            className="absolute left-0 right-0 h-1.5 -translate-y-1/2 border border-black bg-white shadow-sm pointer-events-none"
            style={{ top: `${(hue / 360) * 100}%` }}
          />
        </div>
      </div>

      {/* Suwak przezroczystości (Alpha / Krycie pędzla) */}
      <div className="mb-2.5">
        <div className="flex justify-between text-[10px] text-[#999] mb-1">
          <span>Przezroczystość (Alfa):</span>
          <span className="font-mono text-[#ccc]">{currentColor.a} ({Math.round((currentColor.a / 255) * 100)}%)</span>
        </div>
        <div
          className="relative h-4 rounded-xs border border-[#333] overflow-hidden"
          style={{
            backgroundImage: `repeating-conic-gradient(#bbb 0% 25%, #eee 0% 50%) 50% / 8px 8px`,
          }}
        >
          {/* Gradient koloru od alfa 0 do 255 */}
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(to right, rgba(${currentColor.r},${currentColor.g},${currentColor.b},0), rgba(${currentColor.r},${currentColor.g},${currentColor.b},1))`,
            }}
          />
          <input
            type="range"
            min="0"
            max="255"
            value={currentColor.a}
            onChange={(e) => updateCurrentColor({ ...currentColor, a: parseInt(e.target.value) })}
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
          />
        </div>
      </div>

      {/* Paleta próbek kolorów (32 kolory w dwóch wierszach) */}
      <div className="border-t border-[#333] pt-2">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-[#888]">Próbki barw</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={addColorToPalette}
              title="Dodaj obecny kolor do palety"
              className="p-0.5 text-[#888] hover:text-white hover:bg-[#333] rounded"
            >
              <Plus size={11} />
            </button>
            <button
              type="button"
              onClick={() => setPalette(DEFAULT_PALETTE_HEX)}
              title="Przywróć domyślną paletę"
              className="p-0.5 text-[#888] hover:text-white hover:bg-[#333] rounded"
            >
              <Palette size={11} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-8 gap-1">
          {palette.slice(0, 16).map((c, i) => (
            <div
              key={`row1-${i}`}
              onClick={() => updateCurrentColor(hexToSkColor(c, currentColor.a))}
              className="w-full h-3.5 rounded-xs border border-[#222] cursor-pointer hover:scale-110 hover:border-white transition-transform"
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
          {palette.slice(16, 32).map((c, i) => (
            <div
              key={`row2-${i}`}
              onClick={() => updateCurrentColor(hexToSkColor(c, currentColor.a))}
              className="w-full h-3.5 rounded-xs border border-[#222] cursor-pointer hover:scale-110 hover:border-white transition-transform"
              style={{ backgroundColor: c }}
              title={c}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
