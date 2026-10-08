/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Subscript,
  Superscript,
  Underline,
} from 'lucide-react';
import {
  BLEND_MODES,
  SKBlendMode,
  ShapeFillMode,
  TextAlign,
  TextToolSettings,
} from '../core/skia/types.ts';

export const TEXT_FONTS = [
  'Arial',
  'Calibri',
  'Cambria',
  'Comic Sans MS',
  'Consolas',
  'Courier New',
  'Georgia',
  'Impact',
  'Segoe UI',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'serif',
  'sans-serif',
  'monospace',
];

interface TextOptionsProps {
  settings: TextToolSettings;
  onChange: (patch: Partial<TextToolSettings>) => void;
  onRequestFocus?: () => void;
  isSessionActive?: boolean;
  onCommit?: () => void;
  onCancel?: () => void;
}

const inputCls =
  'h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc]';
const labelCls = 'text-[11px] whitespace-nowrap text-[#aaa]';

/** Pole liczbowe z lokalnym stanem tekstowym (pozwala wyczyścić pole i wpisać nową wartość). */
const NumField: React.FC<{
  value: number;
  min: number;
  max: number;
  width?: string;
  onCommit: (v: number) => void;
  onEnter?: () => void;
}> = ({ value, min, max, width = 'w-12', onCommit, onEnter }) => {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value);
        if (!isNaN(v)) onCommit(Math.max(min, Math.min(max, v)));
      }}
      onBlur={() => setText(String(value))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Tab') {
          if (e.key === 'Enter') e.preventDefault();
          onEnter?.();
        }
        e.stopPropagation();
      }}
      className={`${width} ${inputCls} px-1 text-center font-mono`}
    />
  );
};

const ToggleBtn: React.FC<{
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, title, onClick, children }) => (
  <button
    type="button"
    title={title}
    // onMouseDown/preventDefault: przycisk nie odbiera fokusu, więc edytor tekstu zachowuje kursor i zaznaczenie
    onMouseDown={(e) => e.preventDefault()}
    onClick={onClick}
    className={`w-5 h-5 flex items-center justify-center rounded border cursor-pointer flex-shrink-0 ${
      active
        ? 'bg-[#094771] border-[#007acc] text-white'
        : 'bg-[#1e1e1e] border-[#444] text-[#ccc] hover:bg-[#333]'
    }`}
  >
    {children}
  </button>
);

export const TextOptions: React.FC<TextOptionsProps> = ({
  settings,
  onChange,
  onRequestFocus,
}) => {
  const aligns: { id: TextAlign; title: string; icon: React.ReactNode }[] = [
    { id: 'left', title: 'Do lewej', icon: <AlignLeft size={12} /> },
    { id: 'center', title: 'Do środka', icon: <AlignCenter size={12} /> },
    { id: 'right', title: 'Do prawej', icon: <AlignRight size={12} /> },
    { id: 'justify', title: 'Wyjustuj', icon: <AlignJustify size={12} /> },
  ];

  const fontInList = TEXT_FONTS.includes(settings.fontFamily);

  return (
    <div className="flex items-center gap-3 flex-1 flex-shrink-0">
      {/* Czcionka */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <label className={labelCls}>Czcionka:</label>
        <select
          value={settings.fontFamily}
          onChange={(e) => {
            onChange({ fontFamily: e.target.value });
            onRequestFocus?.();
          }}
          className={`${inputCls} cursor-pointer`}
          style={{ fontFamily: settings.fontFamily }}
        >
          {!fontInList && <option value={settings.fontFamily}>{settings.fontFamily}</option>}
          {TEXT_FONTS.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
      </div>

      {/* Rozmiar */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <label className={labelCls}>Rozmiar:</label>
        <NumField
          value={Math.round(settings.fontSize * 10) / 10}
          min={1}
          max={2000}
          onCommit={(v) => onChange({ fontSize: v })}
          onEnter={onRequestFocus}
        />
        <span className="text-[10px] text-[#888]">px</span>
      </div>

      {/* B / I / U / indeksy */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <ToggleBtn active={settings.bold} title="Pogrubienie (Ctrl+B)" onClick={() => onChange({ bold: !settings.bold })}>
          <Bold size={12} strokeWidth={2.8} />
        </ToggleBtn>
        <ToggleBtn active={settings.italic} title="Kursywa (Ctrl+I)" onClick={() => onChange({ italic: !settings.italic })}>
          <Italic size={12} />
        </ToggleBtn>
        <ToggleBtn
          active={settings.underline}
          title="Podkreślenie (Ctrl+U)"
          onClick={() => onChange({ underline: !settings.underline })}
        >
          <Underline size={12} />
        </ToggleBtn>
        <ToggleBtn
          active={settings.script === 'sub'}
          title="Indeks dolny"
          onClick={() => onChange({ script: settings.script === 'sub' ? 'normal' : 'sub' })}
        >
          <Subscript size={12} />
        </ToggleBtn>
        <ToggleBtn
          active={settings.script === 'super'}
          title="Indeks górny"
          onClick={() => onChange({ script: settings.script === 'super' ? 'normal' : 'super' })}
        >
          <Superscript size={12} />
        </ToggleBtn>
      </div>

      {/* Wyrównanie */}
      <div className="flex items-center gap-1 flex-shrink-0">
        {aligns.map((a) => (
          <ToggleBtn key={a.id} active={settings.align === a.id} title={a.title} onClick={() => onChange({ align: a.id })}>
            {a.icon}
          </ToggleBtn>
        ))}
      </div>

      {/* Odstępy */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <label className={labelCls} title="Odstęp pionowy (interlinia)">Pion:</label>
        <NumField
          value={settings.lineSpacing}
          min={50}
          max={300}
          onCommit={(v) => onChange({ lineSpacing: Math.round(v) })}
          onEnter={onRequestFocus}
        />
        <span className="text-[10px] text-[#888]">%</span>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <label className={labelCls} title="Odstęp poziomy (między znakami)">Poziom:</label>
        <NumField
          value={settings.letterSpacing}
          min={-10}
          max={50}
          onCommit={(v) => onChange({ letterSpacing: Math.round(v * 10) / 10 })}
          onEnter={onRequestFocus}
        />
        <span className="text-[10px] text-[#888]">px</span>
      </div>

      {/* Wypełnienie liter */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <label className={labelCls} title="Wypełnienie liter">Wypełnienie:</label>
        <select
          value={settings.fillMode}
          onChange={(e) => {
            const nextMode = e.target.value as ShapeFillMode;
            if (nextMode === 'none' && settings.strokeWidth === 0) {
              onChange({ fillMode: nextMode, strokeWidth: 2 });
            } else {
              onChange({ fillMode: nextMode });
            }
            onRequestFocus?.();
          }}
          className={`${inputCls} cursor-pointer font-medium`}
        >
          <option value="none">tylko obrys</option>
          <option value="primary">kolor główny</option>
          <option value="stroke-and-fill">kolor dodatkowy</option>
        </select>
      </div>

      {/* Obrys liter */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <label className={labelCls} title="Grubość obramowania liter">Obrys:</label>
        <NumField
          value={settings.strokeWidth}
          min={0}
          max={200}
          onCommit={(v) => onChange({ strokeWidth: Math.round(v) })}
          onEnter={onRequestFocus}
        />
        <span className="text-[10px] text-[#888]">px</span>
        <input
          type="range"
          min="0"
          max="100"
          value={Math.min(100, settings.strokeWidth)}
          onChange={(e) => onChange({ strokeWidth: parseInt(e.target.value) })}
          className="w-16 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
        />
      </div>

      {/* Wygładzanie */}
      <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white flex-shrink-0">
        <input
          type="checkbox"
          checked={settings.antiAliasing}
          onChange={(e) => {
            onChange({ antiAliasing: e.target.checked });
            onRequestFocus?.();
          }}
          className="rounded bg-[#1e1e1e] border-[#555] text-[#007acc] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
        />
        <span>Wygładzanie</span>
      </label>

      {/* Tryb mieszania */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <label className={labelCls}>Mieszanie:</label>
        <select
          value={settings.blendMode}
          onChange={(e) => {
            onChange({ blendMode: e.target.value as SKBlendMode });
            onRequestFocus?.();
          }}
          className={`${inputCls} cursor-pointer`}
        >
          {BLEND_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.namePl}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
