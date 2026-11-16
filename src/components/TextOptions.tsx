/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToggleButton } from './ToggleButton.tsx';
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
import { LengthField, UnitLabel, useUnits } from './Units.tsx';
import { ScrubField } from './ScrubField.tsx';
import { getAllFontFamilies } from '../core/FontCatalog.ts';
import {
  BLEND_MODES,
  SKBlendMode,
  ShapeFillMode,
  TextAlign,
  TextToolSettings,
} from '../core/types.ts';


interface TextOptionsProps {
  settings: TextToolSettings;
  onChange: (patch: Partial<TextToolSettings>) => void;
  onRequestFocus?: () => void;
  onCommit?: () => void;
  onCancel?: () => void;
}

const inputCls =
  'h-5 bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[color:var(--h-444444,#444444)] rounded px-1.5 text-xs text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]';
const labelCls = 'text-[11px] whitespace-nowrap text-[color:var(--h-aaaaaa,#aaaaaa)]';

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
        ? 'bg-[color:var(--h-094771,#094771)] border-[color:var(--h-007acc,#007acc)] text-white'
        : 'bg-[color:var(--h-1e1e1e,#1e1e1e)] border-[color:var(--h-444444,#444444)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-333333,#333333)]'
    }`}
  >
    {children}
  </button>
);

export const TextOptions: React.FC<TextOptionsProps> = (props) => {
  const uctx = useUnits();
  const fractionalUnits = uctx.unit !== 'px';
  return <TextOptionsInner {...props} fractionalUnits={fractionalUnits} />;
};

const TextOptionsInner: React.FC<TextOptionsProps & { fractionalUnits: boolean }> = ({
  fractionalUnits,
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

  const fonts = getAllFontFamilies(settings.fontFamily);

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
          className={`${inputCls} cursor-pointer w-40`}
          style={{ fontFamily: settings.fontFamily }}
        >
          {fonts.map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
      </div>

      {/* Rozmiar */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <label className={labelCls}>Rozmiar:</label>
        <LengthField
          valuePx={Math.round(settings.fontSize * 100) / 100}
          minPx={1}
          maxPx={2000}
          integerPx={false}
          onCommitPx={(v) => onChange({ fontSize: v })}
          onEnter={onRequestFocus}
        />
        <UnitLabel />
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
        <ScrubField
          value={settings.lineSpacing}
          min={50}
          max={300}
          suffix="%"
          width={80}
          onChange={(v) => onChange({ lineSpacing: Math.round(v) })}
          onEnter={onRequestFocus}
        />
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <label className={labelCls} title="Odstęp poziomy (między znakami)">Poziom:</label>
        <LengthField
          valuePx={settings.letterSpacing}
          minPx={-10}
          maxPx={50}
          integerPx={false}
          onCommitPx={(v) => onChange({ letterSpacing: Math.round(v * 100) / 100 })}
          onEnter={onRequestFocus}
        />
        <UnitLabel />
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
        <LengthField
          valuePx={settings.strokeWidth}
          minPx={0}
          maxPx={200}
          trackMaxPx={100}
          integerPx={!fractionalUnits}
          onCommitPx={(v) => onChange({ strokeWidth: fractionalUnits ? Math.round(v * 100) / 100 : Math.round(v) })}
          onEnter={onRequestFocus}
        />
        <UnitLabel />
      </div>

      {/* Wygładzanie */}
      <ToggleButton
        active={settings.antiAliasing}
        onChange={(v) => {
          onChange({ antiAliasing: v });
          onRequestFocus?.();
        }}
      >
        Wygładzanie
      </ToggleButton>

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
