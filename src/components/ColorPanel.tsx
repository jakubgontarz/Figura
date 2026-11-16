/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { ColorPickerBody } from './ColorPicker.tsx';
import { SKColor, hexToSkColor, skColorToHex } from '../core/types.ts';

interface ColorPanelProps {
  primaryColor: SKColor;
  secondaryColor: SKColor;
  onChangePrimaryColor: (color: SKColor) => void;
  onChangeSecondaryColor: (color: SKColor) => void;
  tab?: 'color' | 'props' | 'nav';
  onChangeTab?: (t: 'color' | 'props' | 'nav') => void;
  propsContent?: React.ReactNode;
  /** Zawartość zakładki „Nawigator” (montowana tylko przy otwartej zakładce, więc nic nie kosztuje, gdy jest zamknięta). */
  navContent?: React.ReactNode;
}

export const ColorPanel: React.FC<ColorPanelProps> = ({
  primaryColor,
  secondaryColor,
  onChangePrimaryColor,
  onChangeSecondaryColor,
  tab = 'color',
  onChangeTab,
  propsContent,
  navContent,
}) => {
  const [activeSlot, setActiveSlot] = useState<'primary' | 'secondary'>('primary');
  /** false: kwadrat S-V z paskiem barwy (domyślnie), true: sześć pól R, G, B, H, S, V. Przycisk „Metoda” przełącza. */
  const [fieldsMode, setFieldsMode] = useState(false);

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
      <div className="flex items-center border-b border-[color:var(--h-333333,#333333)] mb-2 pb-0.5">
        {(['color', 'props', 'nav'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChangeTab?.(t)}
            data-testid={`tab-${t}`}
            className={`text-[11px] font-semibold tracking-wide pb-1 px-0.5 mr-3 border-b-2 focus:outline-none cursor-pointer ${tab === t ? 'text-[color:var(--t-white,#fff)] border-[color:var(--h-007acc,#007acc)]' : 'text-[color:var(--h-888888,#888888)] border-transparent hover:text-[color:var(--h-cccccc,#cccccc)]'}`}
          >
            {t === 'color' ? 'Kolor' : t === 'props' ? 'Właściwości' : 'Nawigator'}
          </button>
        ))}
      </div>

      {tab === 'props' ? (
        propsContent
      ) : tab === 'nav' ? (
        navContent
      ) : (
        <>
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
                activeSlot === 'secondary' ? 'border-[color:var(--h-007acc,#007acc)] scale-110 z-20 shadow-md' : 'border-[color:var(--h-333333,#333333)]'
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
                activeSlot === 'primary' ? 'border-[color:var(--h-007acc,#007acc)] scale-110 z-20 shadow-md' : 'border-[color:var(--h-333333,#333333)]'
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
            className="w-6 h-5.5 flex items-center justify-center bg-[color:var(--h-282828,#282828)] border border-[color:var(--h-3e3e3e,#3e3e3e)] rounded transition-colors hover:bg-[color:var(--h-383838,#383838)] text-[color:var(--h-cccccc,#cccccc)] hover:text-[color:var(--t-white,#fff)] cursor-pointer"
          >
            <ArrowLeftRight size={12} />
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
            className="w-16 h-5 bg-[color:var(--h-121212,#121212)] border border-[color:var(--h-444444,#444444)] rounded px-1 text-[10px] font-mono text-[color:var(--t-white,#fff)] text-center focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]"
          />
          <button
            type="button"
            onClick={() => setFieldsMode((v) => !v)}
            aria-pressed={fieldsMode}
            className={`h-5.5 px-2 rounded border text-[11px] cursor-pointer transition-colors ${
              fieldsMode ? 'bg-[color:var(--h-094771,#094771)] border-[color:var(--h-007acc,#007acc)] text-white' : 'bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] hover:text-[color:var(--t-white,#fff)]'
            }`}
            title={fieldsMode ? 'Wróć do kwadratu barw i paska odcienia' : 'Pokaż pola R, G, B, H, S, V'}
          >
            Metoda
          </button>
        </div>
      </div>

      <ColorPickerBody color={currentColor} onChange={updateCurrentColor} onChangeSecondary={onChangeSecondaryColor} fieldsMode={fieldsMode} />
        </>
      )}
    </div>
  );
};
