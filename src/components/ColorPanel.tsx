/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { ColorPickerBody } from './ColorPicker.tsx';
import { SKColor, hexToSkColor, skColorToHex } from '../core/skia/types.ts';

interface ColorPanelProps {
  primaryColor: SKColor;
  secondaryColor: SKColor;
  onChangePrimaryColor: (color: SKColor) => void;
  onChangeSecondaryColor: (color: SKColor) => void;
}

export const ColorPanel: React.FC<ColorPanelProps> = ({
  primaryColor,
  secondaryColor,
  onChangePrimaryColor,
  onChangeSecondaryColor,
}) => {
  const [activeSlot, setActiveSlot] = useState<'primary' | 'secondary'>('primary');
  const [colorMode, setColorMode] = useState<'hsv' | 'rgb'>('hsv');

  const currentColor = activeSlot === 'primary' ? primaryColor : secondaryColor;
  const updateCurrentColor = activeSlot === 'primary' ? onChangePrimaryColor : onChangeSecondaryColor;

  const hexString = skColorToHex(currentColor);
  const [hexInput, setHexInput] = useState(hexString);

  useEffect(() => {
    setHexInput(hexString);
  }, [hexString]);

  // Zamiana koloru głównego z dodatkowym
  const swapColors = () => {
    const temp = { ...primaryColor };
    onChangePrimaryColor(secondaryColor);
    onChangeSecondaryColor(temp);
  };

  return (
    <div className="bg-transparent text-xs select-none">
      {/* Pasek Zakładek (Tab Strip) */}
      <div className="flex items-center border-b border-[#333] mb-2 pb-0.5">
        <button
          type="button"
          className="text-[11px] font-semibold tracking-wide text-white border-b-2 border-[#007acc] pb-1 px-0.5 focus:outline-none cursor-pointer"
        >
          Kolor
        </button>
      </div>

      {/* Górny wiersz: Podgląd Kolorów + Hex + Przycisk Metoda */}
      <div className="flex items-center justify-between gap-1 mb-2">
        <div className="flex items-center gap-1">
          {/* Nakładające się kwadraty koloru głównego i dodatkowego */}
          <div className="relative w-8 h-8 shrink-0">
            {/* Dodatkowy (w tle) */}
            <div
              onClick={() => setActiveSlot('secondary')}
              title="Kolor dodatkowy (kliknij, aby edytować)"
              className={`absolute right-0 bottom-0 w-[22px] h-[22px] rounded-xs border cursor-pointer z-0 transition-transform overflow-hidden ${
                activeSlot === 'secondary' ? 'border-[#007acc] scale-110 z-20 shadow-md' : 'border-[#333]'
              }`}
              style={{
                backgroundImage: `repeating-conic-gradient(#e4e4e4 0% 25%, #ffffff 0% 50%)`,
                backgroundSize: '8px 8px',
              }}
            >
              <div
                className="w-full h-full"
                style={{
                  backgroundColor: `rgba(${secondaryColor.r}, ${secondaryColor.g}, ${secondaryColor.b}, ${secondaryColor.a / 255})`,
                }}
              />
            </div>
            {/* Główny (na wierzchu) */}
            <div
              onClick={() => setActiveSlot('primary')}
              title="Kolor główny (kliknij, aby edytować)"
              className={`absolute left-0 top-0 w-[22px] h-[22px] rounded-xs border cursor-pointer z-10 transition-transform overflow-hidden ${
                activeSlot === 'primary' ? 'border-[#007acc] scale-110 z-20 shadow-md' : 'border-[#333]'
              }`}
              style={{
                backgroundImage: `repeating-conic-gradient(#e4e4e4 0% 25%, #ffffff 0% 50%)`,
                backgroundSize: '8px 8px',
              }}
            >
              <div
                className="w-full h-full"
                style={{
                  backgroundColor: `rgba(${primaryColor.r}, ${primaryColor.g}, ${primaryColor.b}, ${primaryColor.a / 255})`,
                }}
              />
            </div>
          </div>

          {/* Przycisk zamiany ⇄ */}
          <button
            type="button"
            onClick={swapColors}
            title="Zamień kolory (X)"
            className="p-1 text-[#888] hover:text-white hover:bg-[#333] rounded cursor-pointer"
          >
            <ArrowLeftRight size={11} />
          </button>
        </div>

        {/* Pole Hex i Przycisk Metoda */}
        <div className="flex items-center gap-1 shrink-0">
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
            className="w-16 h-5 bg-[#121212] border border-[#444] rounded px-1 text-[10px] font-mono text-white text-center focus:outline-none focus:border-[#007acc]"
          />
          <button
            type="button"
            onClick={() => setColorMode(colorMode === 'hsv' ? 'rgb' : 'hsv')}
            className="h-5 px-1.5 bg-[#2a2a2a] hover:bg-[#3a3a3a] text-[#aaa] hover:text-white border border-[#444] rounded text-[9.5px] cursor-pointer"
            title="Przełącz tryb suwaków (HSV / RGB)"
          >
            Metoda
          </button>
        </div>
      </div>

      <ColorPickerBody color={currentColor} onChange={updateCurrentColor} onChangeSecondary={onChangeSecondaryColor} />
    </div>
  );
};
