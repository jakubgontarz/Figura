/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialogOwnsKey } from '../core/dialogStack.ts';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DialogWindow } from './DialogWindow.tsx';
import { Eye, EyeOff, Trash2, X } from 'lucide-react';
import {
  BUILTIN_PRESETS,
  GradStop,
  LayerStyles,
  STYLE_BLEND_OPTIONS,
  STYLE_LIST,
  StyleBase,
  StyleBlend,
  StyleKind,
  StylePreset,
  cloneStyles,
  defaultStyles,
  reviveStyles,
} from '../core/Styles.ts';
import { CheckRow } from './CorrectionDialog.tsx';
import { ColorSwatchButton, isColorPopoverOpen } from './ColorPicker.tsx';
import { ScrubField } from './ScrubField.tsx';

interface StylesDialogProps {
  layerName: string;
  /** Stan początkowy zestawu (z warstwy) */
  initial: LayerStyles;
  isNew: boolean;
  /** Każda zmiana jest od razu widoczna na płótnie */
  onChange: (styles: LayerStyles) => void;
  onOk: () => void;
  onCancel: () => void;
}

// --------------------------------------------------------------------------------------------------------------
// Drobne elementy
// --------------------------------------------------------------------------------------------------------------

const fmtNum = (v: number, decimals: number): string => (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v)));

/** Kompaktowy suwak: etykieta, suwak i pole liczbowe w jednej linii. */
const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  unit?: string;
  defaultValue?: number;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, decimals = 0, unit, defaultValue, onChange }) => (
  <div className="mb-1.5 flex items-center gap-1.5">
    <label
      className="w-[108px] shrink-0 truncate text-[10.5px] text-[color:var(--h-bbbbbb,#bbbbbb)] cursor-default"
      title={defaultValue !== undefined ? `${label} (dwukrotne kliknięcie przywraca wartość domyślną)` : label}
      onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
    >
      {label}
    </label>
    <div className="flex-1 min-w-0">
      <ScrubField value={value} min={min} max={max} step={step} format={(v) => fmtNum(v, decimals)} suffix={unit?.trim()} width="100%" title={label} onChange={onChange} />
    </div>
  </div>
);

const SelectRow: React.FC<{
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  /** Etykieta po lewej w tej samej linii (zamiast nad polem) */
  inline?: boolean;
}> = ({ label, value, options, onChange, inline }) => (
  <div className={inline ? 'mb-1.5 flex items-center gap-1.5' : 'mb-1.5 min-w-0'}>
    <label className={inline ? 'w-[108px] shrink-0 text-[10.5px] text-[color:var(--h-bbbbbb,#bbbbbb)]' : 'block text-[10.5px] text-[color:var(--h-bbbbbb,#bbbbbb)] mb-0.5'}>{label}</label>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inline ? 'flex-1' : 'w-full'} min-w-0 h-6 bg-[color:var(--h-222222,#222222)] border border-[color:var(--h-444444,#444444)] rounded px-1.5 text-[10.5px] text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)] cursor-pointer`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  </div>
);

/** Kolor: pole hex + próbka otwierająca mały panel z wybierakiem koloru programu. `stacked` = etykieta nad polami (do siatki obok trybu). */
const ColorRow: React.FC<{ label: string; value: string; onChange: (v: string) => void; stacked?: boolean }> = ({ label, value, onChange, stacked }) => {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className={stacked ? 'mb-1.5 min-w-0' : 'mb-1.5 flex items-center gap-1.5'}>
      <label className={stacked ? 'block text-[10.5px] text-[color:var(--h-bbbbbb,#bbbbbb)] mb-0.5' : 'w-[108px] shrink-0 text-[10.5px] text-[color:var(--h-bbbbbb,#bbbbbb)]'}>{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={draft ?? value}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setDraft(e.target.value);
            if (/^#[0-9a-f]{6}$/i.test(e.target.value.trim())) onChange(e.target.value.trim().toLowerCase());
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setDraft(null);
              (e.target as HTMLInputElement).blur();
              e.stopPropagation();
            }
          }}
          className="w-[68px] h-6 bg-[color:var(--h-111111,#111111)] border border-[color:var(--h-3e3e3e,#3e3e3e)] rounded px-1 text-[10.5px] text-[color:var(--t-white,#fff)] font-mono focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]"
        />
        <ColorSwatchButton value={value} onChange={onChange} className="w-8 h-6 p-0 border border-[color:var(--h-3e3e3e,#3e3e3e)] rounded cursor-pointer shrink-0" />
      </div>
    </div>
  );
};

const BlendRow: React.FC<{ label?: string; value: StyleBlend; onChange: (v: StyleBlend) => void }> = ({ label = 'Tryb mieszania', value, onChange }) => (
  <SelectRow label={label} value={value} options={STYLE_BLEND_OPTIONS} onChange={(v) => onChange(v as StyleBlend)} />
);

/** Dwa pola obok siebie (np. tryb i kolor). */
const Pair: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="grid grid-cols-2 gap-2 items-start">{children}</div>;

const SubTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[9.5px] uppercase tracking-wide text-[color:var(--h-777777,#777777)] mt-2 mb-1 border-t border-[color:var(--h-333333,#333333)] pt-1.5">{children}</div>
);

// --------------------------------------------------------------------------------------------------------------
// Edytor gradientu
// --------------------------------------------------------------------------------------------------------------

const GradientEditor: React.FC<{ stops: GradStop[]; onChange: (s: GradStop[]) => void }> = ({ stops, onChange }) => {
  const [sel, setSel] = useState(0);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<number | null>(null);
  const idx = Math.min(sel, stops.length - 1);
  const sorted = [...stops].map((s, i) => ({ ...s, i })).sort((a, b) => a.pos - b.pos);
  const css = `linear-gradient(to right, ${sorted
    .map((s) => {
      const r = parseInt(s.color.slice(1, 3), 16);
      const g = parseInt(s.color.slice(3, 5), 16);
      const b = parseInt(s.color.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${s.alpha / 100}) ${s.pos}%`;
    })
    .join(',')})`;

  const posFromEvent = (e: React.PointerEvent): number => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(100, Math.round(((e.clientX - r.left) / r.width) * 100)));
  };
  const colorAt = (pos: number): string => {
    let lo = sorted[0];
    let hi = sorted[sorted.length - 1];
    for (let k = 0; k < sorted.length - 1; k++) if (pos >= sorted[k].pos && pos <= sorted[k + 1].pos) { lo = sorted[k]; hi = sorted[k + 1]; }
    const f = hi.pos === lo.pos ? 0 : (pos - lo.pos) / (hi.pos - lo.pos);
    const ch = (o: number) => Math.round(parseInt(lo.color.slice(o, o + 2), 16) * (1 - f) + parseInt(hi.color.slice(o, o + 2), 16) * f);
    return '#' + [1, 3, 5].map((o) => ch(o).toString(16).padStart(2, '0')).join('');
  };
  const cur = stops[idx];

  return (
    <div className="mb-2">
      <div className="text-[10.5px] text-[color:var(--h-bbbbbb,#bbbbbb)] mb-1">Gradient</div>
      <div
        ref={barRef}
        className="relative h-5 rounded border border-[color:var(--h-444444,#444444)] cursor-copy"
        style={{ backgroundImage: `${css}, repeating-conic-gradient(#555 0% 25%, #333 0% 50%)`, backgroundSize: '100% 100%, 8px 8px' }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const p = posFromEvent(e);
          const next = [...stops, { pos: p, color: colorAt(p), alpha: 100 }];
          onChange(next);
          setSel(next.length - 1);
        }}
        title="Kliknij pasek, aby dodać punkt"
      >
        {stops.map((s, i) => (
          <div
            key={i}
            onPointerDown={(e) => {
              e.stopPropagation();
              setSel(i);
              dragRef.current = i;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (dragRef.current !== i) return;
              const p = posFromEvent(e);
              onChange(stops.map((x, k) => (k === i ? { ...x, pos: p } : x)));
            }}
            onPointerUp={() => {
              dragRef.current = null;
            }}
            className={`absolute -bottom-1.5 w-2.5 h-3 -ml-[5px] rounded-sm border cursor-ew-resize ${i === idx ? 'border-white' : 'border-[color:var(--h-888888,#888888)]'}`}
            style={{ left: `${s.pos}%`, background: s.color }}
          />
        ))}
      </div>
      <div className="mt-2.5 flex items-center gap-1.5">
        <ColorSwatchButton value={cur.color} onChange={(c) => onChange(stops.map((x, k) => (k === idx ? { ...x, color: c } : x)))} />
        <span className="text-[10px] text-[color:var(--h-999999,#999999)]">punkt {idx + 1} z {stops.length}</span>
        <button
          type="button"
          disabled={stops.length <= 2}
          onClick={() => {
            onChange(stops.filter((_, k) => k !== idx));
            setSel(0);
          }}
          className="ml-auto h-5 px-1.5 text-[10px] rounded border bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] disabled:opacity-40 cursor-pointer disabled:cursor-default"
        >
          Usuń punkt
        </button>
      </div>
      <div className="mt-1.5">
        <SliderRow label="Położenie punktu" value={cur.pos} min={0} max={100} step={1} unit="%" onChange={(v) => onChange(stops.map((x, k) => (k === idx ? { ...x, pos: v } : x)))} />
        <SliderRow label="Krycie punktu" value={cur.alpha} min={0} max={100} step={1} unit="%" onChange={(v) => onChange(stops.map((x, k) => (k === idx ? { ...x, alpha: v } : x)))} />
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------------------------------------------
// Ustawienia poszczególnych stylizacji
// --------------------------------------------------------------------------------------------------------------

type Patch<T> = (p: Partial<T>) => void;

const LightRow: React.FC<{
  styles: LayerStyles;
  use: boolean;
  angle: number;
  onUse: (v: boolean) => void;
  onAngle: (v: number) => void;
  onGlobalAngle: (v: number) => void;
  label?: string;
}> = ({ styles, use, angle, onUse, onAngle, onGlobalAngle, label = 'Kąt' }) => (
  <>
    <CheckRow label="Użyj światła globalnego" checked={use} onChange={onUse} />
    {use ? (
      <SliderRow label={`${label} (globalny)`} value={styles.globalAngle} min={-180} max={180} step={1} unit="°" defaultValue={120} onChange={onGlobalAngle} />
    ) : (
      <SliderRow label={label} value={angle} min={-180} max={180} step={1} unit="°" defaultValue={120} onChange={onAngle} />
    )}
  </>
);

const StyleEditor: React.FC<{ kind: StyleKind; styles: LayerStyles; set: (fn: (s: LayerStyles) => void) => void }> = ({ kind, styles, set }) => {
  const upd =
    <K extends StyleKind>(k: K): Patch<LayerStyles[K]> =>
    (p) =>
      set((s) => {
        Object.assign(s[k] as object, p);
      });
  const setGlobalAngle = (v: number) => set((s) => void (s.globalAngle = v));
  const setGlobalAlt = (v: number) => set((s) => void (s.globalAltitude = v));

  switch (kind) {
    case 'dropShadow': {
      const x = styles.dropShadow;
      const u = upd('dropShadow');
      return (
        <div>
          <ColorRow label="Kolor" value={x.color} onChange={(v) => u({ color: v })} />
          <SliderRow label="Krycie" value={x.opacity} min={0} max={100} step={1} unit="%" defaultValue={75} onChange={(v) => u({ opacity: v })} />
          <LightRow styles={styles} use={x.useGlobalLight} angle={x.angle} onUse={(v) => u({ useGlobalLight: v })} onAngle={(v) => u({ angle: v })} onGlobalAngle={setGlobalAngle} />
          <SliderRow label="Odległość" value={x.distance} min={0} max={150} step={1} unit=" px" defaultValue={6} onChange={(v) => u({ distance: v })} />
          <SliderRow label="Rozszerzenie" value={x.spread} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(v) => u({ spread: v })} />
          <SliderRow label="Rozmiar (rozmycie)" value={x.size} min={0} max={150} step={1} unit=" px" defaultValue={8} onChange={(v) => u({ size: v })} />
        </div>
      );
    }
    case 'stroke': {
      const x = styles.stroke;
      const u = upd('stroke');
      return (
        <div>
          <SliderRow label="Grubość" value={x.width} min={1} max={100} step={1} unit=" px" defaultValue={3} onChange={(v) => u({ width: v })} />
          <SelectRow
            label="Położenie"
            inline
            value={x.position}
            options={[
              { value: 'outside', label: 'Na zewnątrz' },
              { value: 'center', label: 'Pośrodku' },
              { value: 'inside', label: 'Wewnątrz' },
            ]}
            onChange={(v) => u({ position: v as typeof x.position })}
          />
          <Pair>
            <BlendRow value={x.blend} onChange={(v) => u({ blend: v })} />
            <ColorRow stacked label="Kolor" value={x.color} onChange={(v) => u({ color: v })} />
          </Pair>
          <SliderRow label="Krycie" value={x.opacity} min={0} max={100} step={1} unit="%" defaultValue={100} onChange={(v) => u({ opacity: v })} />
        </div>
      );
    }
    case 'outerGlow': {
      const x = styles.outerGlow;
      const u = upd('outerGlow');
      return (
        <div>
          <ColorRow label="Kolor" value={x.color} onChange={(v) => u({ color: v })} />
          <SliderRow label="Krycie" value={x.opacity} min={0} max={100} step={1} unit="%" defaultValue={75} onChange={(v) => u({ opacity: v })} />
          <SliderRow label="Rozszerzenie" value={x.spread} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(v) => u({ spread: v })} />
          <SliderRow label="Rozmiar" value={x.size} min={0} max={150} step={1} unit=" px" defaultValue={10} onChange={(v) => u({ size: v })} />
        </div>
      );
    }
    case 'innerShadow': {
      const x = styles.innerShadow;
      const u = upd('innerShadow');
      return (
        <div>
          <Pair>
            <BlendRow value={x.blend} onChange={(v) => u({ blend: v })} />
            <ColorRow stacked label="Kolor" value={x.color} onChange={(v) => u({ color: v })} />
          </Pair>
          <SliderRow label="Krycie" value={x.opacity} min={0} max={100} step={1} unit="%" defaultValue={75} onChange={(v) => u({ opacity: v })} />
          <LightRow styles={styles} use={x.useGlobalLight} angle={x.angle} onUse={(v) => u({ useGlobalLight: v })} onAngle={(v) => u({ angle: v })} onGlobalAngle={setGlobalAngle} />
          <SliderRow label="Odległość" value={x.distance} min={0} max={150} step={1} unit=" px" defaultValue={5} onChange={(v) => u({ distance: v })} />
          <SliderRow label="Zwężenie" value={x.choke} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(v) => u({ choke: v })} />
          <SliderRow label="Rozmiar" value={x.size} min={0} max={150} step={1} unit=" px" defaultValue={8} onChange={(v) => u({ size: v })} />
        </div>
      );
    }
    case 'innerGlow': {
      const x = styles.innerGlow;
      const u = upd('innerGlow');
      return (
        <div>
          <Pair>
            <BlendRow value={x.blend} onChange={(v) => u({ blend: v })} />
            <ColorRow stacked label="Kolor" value={x.color} onChange={(v) => u({ color: v })} />
          </Pair>
          <SliderRow label="Krycie" value={x.opacity} min={0} max={100} step={1} unit="%" defaultValue={75} onChange={(v) => u({ opacity: v })} />
          <SelectRow
            label="Źródło"
            inline
            value={x.source}
            options={[
              { value: 'edge', label: 'Od krawędzi' },
              { value: 'center', label: 'Od środka' },
            ]}
            onChange={(v) => u({ source: v as typeof x.source })}
          />
          <SliderRow label="Zwężenie" value={x.choke} min={0} max={100} step={1} unit="%" defaultValue={0} onChange={(v) => u({ choke: v })} />
          <SliderRow label="Rozmiar" value={x.size} min={0} max={150} step={1} unit=" px" defaultValue={8} onChange={(v) => u({ size: v })} />
        </div>
      );
    }
    case 'bevel': {
      const x = styles.bevel;
      const u = upd('bevel');
      return (
        <div>
          <Pair>
          <SelectRow
            label="Styl"
            value={x.kind}
            options={[
              { value: 'inner', label: 'Fazowanie wewnętrzne' },
              { value: 'outer', label: 'Fazowanie zewnętrzne' },
              { value: 'emboss', label: 'Wytłoczenie' },
              { value: 'pillow', label: 'Wytłoczenie poduszkowe' },
            ]}
            onChange={(v) => u({ kind: v as typeof x.kind })}
          />
          <SelectRow
            label="Kierunek"
            value={x.direction}
            options={[
              { value: 'up', label: 'W górę' },
              { value: 'down', label: 'W dół' },
            ]}
            onChange={(v) => u({ direction: v as typeof x.direction })}
          />
          </Pair>
          <SliderRow label="Rozmiar" value={x.size} min={1} max={80} step={1} unit=" px" defaultValue={6} onChange={(v) => u({ size: v })} />
          <SliderRow label="Zmiękczenie" value={x.soften} min={0} max={16} step={0.5} decimals={1} unit=" px" defaultValue={0} onChange={(v) => u({ soften: v })} />
          <SliderRow label="Głębokość" value={x.depth} min={1} max={300} step={1} unit="%" defaultValue={100} onChange={(v) => u({ depth: v })} />
          <LightRow styles={styles} use={x.useGlobalLight} angle={x.angle} onUse={(v) => u({ useGlobalLight: v })} onAngle={(v) => u({ angle: v })} onGlobalAngle={setGlobalAngle} />
          <SliderRow
            label={x.useGlobalLight ? 'Wysokość światła (globalna)' : 'Wysokość światła'}
            value={x.useGlobalLight ? styles.globalAltitude : x.altitude}
            min={1}
            max={90}
            step={1}
            unit="°"
            defaultValue={30}
            onChange={(v) => (x.useGlobalLight ? setGlobalAlt(v) : u({ altitude: v }))}
          />
          <SubTitle>Światło</SubTitle>
          <Pair>
            <BlendRow label="Tryb" value={x.highlightBlend} onChange={(v) => u({ highlightBlend: v })} />
            <ColorRow stacked label="Kolor" value={x.highlightColor} onChange={(v) => u({ highlightColor: v })} />
          </Pair>
          <SliderRow label="Krycie" value={x.highlightOpacity} min={0} max={100} step={1} unit="%" defaultValue={75} onChange={(v) => u({ highlightOpacity: v })} />
          <SubTitle>Cień</SubTitle>
          <Pair>
            <BlendRow label="Tryb" value={x.shadowBlend} onChange={(v) => u({ shadowBlend: v })} />
            <ColorRow stacked label="Kolor" value={x.shadowColor} onChange={(v) => u({ shadowColor: v })} />
          </Pair>
          <SliderRow label="Krycie" value={x.shadowOpacity} min={0} max={100} step={1} unit="%" defaultValue={75} onChange={(v) => u({ shadowOpacity: v })} />
        </div>
      );
    }
    case 'satin': {
      const x = styles.satin;
      const u = upd('satin');
      return (
        <div>
          <Pair>
            <BlendRow value={x.blend} onChange={(v) => u({ blend: v })} />
            <ColorRow stacked label="Kolor" value={x.color} onChange={(v) => u({ color: v })} />
          </Pair>
          <SliderRow label="Krycie" value={x.opacity} min={0} max={100} step={1} unit="%" defaultValue={50} onChange={(v) => u({ opacity: v })} />
          <SliderRow label="Kąt" value={x.angle} min={-180} max={180} step={1} unit="°" defaultValue={19} onChange={(v) => u({ angle: v })} />
          <SliderRow label="Odległość" value={x.distance} min={0} max={100} step={1} unit=" px" defaultValue={11} onChange={(v) => u({ distance: v })} />
          <SliderRow label="Rozmiar" value={x.size} min={0} max={100} step={1} unit=" px" defaultValue={14} onChange={(v) => u({ size: v })} />
          <CheckRow label="Odwróć" checked={x.invert} onChange={(v) => u({ invert: v })} />
        </div>
      );
    }
    case 'colorOverlay': {
      const x = styles.colorOverlay;
      const u = upd('colorOverlay');
      return (
        <div>
          <Pair>
            <BlendRow value={x.blend} onChange={(v) => u({ blend: v })} />
            <ColorRow stacked label="Kolor" value={x.color} onChange={(v) => u({ color: v })} />
          </Pair>
          <SliderRow label="Krycie" value={x.opacity} min={0} max={100} step={1} unit="%" defaultValue={100} onChange={(v) => u({ opacity: v })} />
        </div>
      );
    }
    default: {
      const x = styles.gradientOverlay;
      const u = upd('gradientOverlay');
      return (
        <div>
          <BlendRow value={x.blend} onChange={(v) => u({ blend: v })} />
          <SliderRow label="Krycie" value={x.opacity} min={0} max={100} step={1} unit="%" defaultValue={100} onChange={(v) => u({ opacity: v })} />
          <GradientEditor stops={x.stops} onChange={(stops) => u({ stops })} />
          <CheckRow label="Odwróć kolejność" checked={x.reverse} onChange={(v) => u({ reverse: v })} />
          <Pair>
          <SelectRow
            label="Kształt"
            value={x.shape}
            options={[
              { value: 'linear', label: 'Liniowy' },
              { value: 'radial', label: 'Promienisty' },
              { value: 'angle', label: 'Kątowy' },
              { value: 'reflected', label: 'Odbity' },
              { value: 'diamond', label: 'Diamentowy' },
            ]}
            onChange={(v) => u({ shape: v as typeof x.shape })}
          />
          <SelectRow
            label="Wyrównaj do"
            value={x.align}
            options={[
              { value: 'layer', label: 'Warstwy' },
              { value: 'document', label: 'Dokumentu' },
            ]}
            onChange={(v) => u({ align: v as typeof x.align })}
          />
          </Pair>
          <SliderRow label="Kąt" value={x.angle} min={-180} max={180} step={1} unit="°" defaultValue={90} onChange={(v) => u({ angle: v })} />
          <SliderRow label="Skala" value={x.scale} min={10} max={300} step={1} unit="%" defaultValue={100} onChange={(v) => u({ scale: v })} />
        </div>
      );
    }
  }
};

// --------------------------------------------------------------------------------------------------------------
// Presety użytkownika
// --------------------------------------------------------------------------------------------------------------

const PRESET_KEY = 'figura.stylePresets.v1';

function loadUserPresets(): StylePreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    const out: StylePreset[] = [];
    for (const r of raw) {
      const st = reviveStyles(r?.styles);
      if (st && typeof r.name === 'string' && typeof r.id === 'string') out.push({ id: r.id, name: r.name, styles: st });
    }
    return out;
  } catch {
    return [];
  }
}

function saveUserPresets(list: StylePreset[]): void {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list.map((p) => ({ id: p.id, name: p.name, styles: p.styles }))));
  } catch {
    /* brak dostępu do pamięci przeglądarki: preset działa do końca sesji */
  }
}

/** Miniatura presetu: kolorowe kropki włączonych stylizacji. */
const PresetChips: React.FC<{ styles: LayerStyles }> = ({ styles }) => (
  <span className="flex gap-0.5">
    {STYLE_LIST.filter((e) => (styles[e.kind] as StyleBase).enabled).map((e) => (
      <span key={e.kind} title={e.name} className="w-1.5 h-1.5 rounded-full bg-[#6fd3e6]" />
    ))}
  </span>
);

const PresetsPane: React.FC<{ current: LayerStyles; onApply: (s: LayerStyles) => void }> = ({ current, onApply }) => {
  const [user, setUser] = useState<StylePreset[]>(() => loadUserPresets());
  const [name, setName] = useState('');
  const save = () => {
    const n = name.trim() || `Preset ${user.length + 1}`;
    const st = cloneStyles(current);
    st.visible = true;
    const next = [...user, { id: `u-${Date.now().toString(36)}`, name: n, styles: st }];
    setUser(next);
    saveUserPresets(next);
    setName('');
  };
  const del = (id: string) => {
    const next = user.filter((p) => p.id !== id);
    setUser(next);
    saveUserPresets(next);
  };
  const Row: React.FC<{ p: StylePreset }> = ({ p }) => (
    <div className="flex items-center gap-1.5 mb-1">
      <button
        type="button"
        onClick={() => onApply(p.styles)}
        className="flex-1 min-w-0 flex items-center justify-between gap-2 h-6 px-2 rounded border bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[11px] text-[color:var(--h-dddddd,#dddddd)] hover:bg-[color:var(--h-10549c,#10549c)] hover:border-[color:var(--h-2980b9,#2980b9)] hover:text-white cursor-pointer"
        title="Zastosuj preset (zastępuje ustawienia stylizacji tej warstwy)"
      >
        <span className="truncate">{p.name}</span>
        <PresetChips styles={p.styles} />
      </button>
      {!p.builtin && (
        <button type="button" onClick={() => del(p.id)} title="Usuń preset" className="p-1 rounded text-[color:var(--h-bbbbbb,#bbbbbb)] hover:bg-[#4a2a2a] hover:text-[color:var(--t-white,#fff)] cursor-pointer">
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
  return (
    <div>
      <div className="text-[9.5px] uppercase tracking-wide text-[color:var(--h-777777,#777777)] mb-1.5">Zapisz bieżące ustawienia</div>
      <div className="flex gap-1.5 mb-3">
        <input
          type="text"
          value={name}
          placeholder="Nazwa presetu"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              save();
            }
          }}
          className="flex-1 h-6 bg-[color:var(--h-111111,#111111)] border border-[color:var(--h-3e3e3e,#3e3e3e)] rounded px-1.5 text-[11px] text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]"
        />
        <button type="button" onClick={save} className="h-6 px-2.5 text-[11px] rounded border bg-[color:var(--h-10549c,#10549c)] border-[color:var(--h-2980b9,#2980b9)] text-white hover:bg-[color:var(--h-1465b5,#1465b5)] cursor-pointer">
          Zapisz
        </button>
      </div>
      {user.length > 0 && (
        <>
          <div className="text-[9.5px] uppercase tracking-wide text-[color:var(--h-777777,#777777)] mb-1.5">Moje presety</div>
          {user.map((p) => (
            <Row key={p.id} p={p} />
          ))}
          <div className="h-2" />
        </>
      )}
      <div className="text-[9.5px] uppercase tracking-wide text-[color:var(--h-777777,#777777)] mb-1.5">Wbudowane</div>
      {BUILTIN_PRESETS.map((p) => (
        <Row key={p.id} p={p} />
      ))}
    </div>
  );
};

// --------------------------------------------------------------------------------------------------------------
// Okno
// --------------------------------------------------------------------------------------------------------------

export const StylesDialog: React.FC<StylesDialogProps> = ({ layerName, initial, isNew, onChange, onOk, onCancel }) => {
  const [styles, setStyles] = useState<LayerStyles>(() => cloneStyles(initial));
  const [tab, setTab] = useState<StyleKind | 'presets'>(() => STYLE_LIST.find((e) => (initial[e.kind] as StyleBase).enabled)?.kind ?? 'dropShadow');
  const [preview, setPreview] = useState(true);
  const previewRef = useRef(true);
  previewRef.current = preview;

  const push = (next: LayerStyles, previewOn = previewRef.current) => {
    setStyles(next);
    onChange({ ...next, visible: previewOn });
  };
  const set = (fn: (s: LayerStyles) => void) => {
    const next = cloneStyles(styles);
    fn(next);
    push(next);
  };

  const latest = useRef({ onOk, onCancel });
  latest.current = { onOk, onCancel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'styles-dialog')) return;
      if (isColorPopoverOpen()) return; // Esc / Enter obsługuje mały panel koloru
      if (e.key === 'Escape') {
        e.preventDefault();
        latest.current.onCancel();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement && e.target.type === 'text') && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        latest.current.onOk();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const activeName = useMemo(() => (tab === 'presets' ? 'Presety' : STYLE_LIST.find((e) => e.kind === tab)!.name), [tab]);

  return (
    <DialogWindow
      width={580}
      onClose={onCancel}
      testId="styles-dialog"
      initialPos={() => ({
        x: Math.max(16, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 224 - 580 - 24),
        y: Math.max(8, Math.min(90, (typeof window !== 'undefined' ? window.innerHeight : 800) - 470)),
      })}
      title={
        <>
          Stylizacje warstwy <span className="font-normal text-[color:var(--h-999999,#999999)]">· {layerName}</span>
        </>
      }
    >
      <div className="flex min-h-0 flex-1" style={{ height: 'min(430px, calc(100vh - 110px))' }}>
        {/* lewa kolumna: zakładki z polem wyboru i okiem */}
        <div className="w-[196px] shrink-0 border-r border-[color:var(--h-333333,#333333)] p-1.5 overflow-y-auto">
          <button
            type="button"
            onClick={() => setTab('presets')}
            className={`w-full h-6 mb-1.5 text-left px-2 rounded border text-[11px] cursor-pointer ${
              tab === 'presets' ? 'bg-[color:var(--h-10549c,#10549c)] border-[color:var(--h-2980b9,#2980b9)] text-white' : 'bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-dddddd,#dddddd)] hover:bg-[color:var(--h-333333,#333333)]'
            }`}
          >
            Presety
          </button>
          {STYLE_LIST.map((e) => {
            const x = styles[e.kind] as StyleBase;
            const selected = tab === e.kind;
            return (
              <div
                key={e.kind}
                onClick={() => setTab(e.kind)}
                className={`flex items-center gap-1.5 h-6 mb-0.5 px-1.5 rounded border cursor-pointer ${
                  selected ? 'bg-[color:var(--h-10549c,#10549c)] border-[color:var(--h-2980b9,#2980b9)] text-white' : 'bg-[color:var(--h-252526,#252526)] border-transparent text-[color:var(--h-dddddd,#dddddd)] hover:bg-[color:var(--h-2f2f30,#2f2f30)]'
                }`}
              >
                <input
                  type="checkbox"
                  checked={x.enabled}
                  title="Włącz stylizację"
                  onClick={(ev) => ev.stopPropagation()}
                  onChange={(ev) => {
                    set((s) => {
                      (s[e.kind] as StyleBase).enabled = ev.target.checked;
                      if (ev.target.checked) (s[e.kind] as StyleBase).visible = true;
                    });
                    if (ev.target.checked) setTab(e.kind);
                  }}
                  className="accent-[color:var(--h-007acc,#007acc)] cursor-pointer"
                />
                <span className={`flex-1 min-w-0 truncate text-[11px] ${x.enabled ? '' : 'opacity-70'}`}>{e.name}</span>
                <button
                  type="button"
                  title={x.visible ? 'Ukryj tę stylizację (podgląd)' : 'Pokaż tę stylizację'}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    set((s) => void ((s[e.kind] as StyleBase).visible = !(s[e.kind] as StyleBase).visible));
                  }}
                  className={`p-0.5 rounded cursor-pointer ${x.enabled ? 'text-[color:var(--h-dddddd,#dddddd)] hover:bg-black/30' : 'text-[color:var(--h-666666,#666666)]'}`}
                >
                  {x.visible ? <Eye size={11} strokeWidth={2.2} /> : <EyeOff size={11} strokeWidth={2.2} />}
                </button>
              </div>
            );
          })}
        </div>

        {/* prawa kolumna: ustawienia */}
        <div className="flex-1 min-w-0 px-3 py-2 overflow-y-auto">
          <div className="text-[11px] font-semibold text-[color:var(--t-white,#fff)] mb-2.5 pb-1.5 border-b border-[color:var(--h-333333,#333333)]">{activeName}</div>
          {tab === 'presets' ? (
            <PresetsPane
              current={styles}
              onApply={(p) => {
                const next = cloneStyles(p);
                next.visible = true;
                push(next);
                const first = STYLE_LIST.find((e) => (next[e.kind] as StyleBase).enabled);
                if (first) setTab(first.kind);
              }}
            />
          ) : (
            <>
              <StyleEditor
                kind={tab}
                styles={styles}
                set={(fn) =>
                  set((s) => {
                    fn(s);
                    // zmiana ustawień włącza stylizację (użytkownik od razu widzi efekt)
                    (s[tab] as StyleBase).enabled = true;
                    (s[tab] as StyleBase).visible = true;
                  })
                }
              />
            </>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[color:var(--h-333333,#333333)] shrink-0">
        <label className="flex items-center gap-1.5 text-[10.5px] text-[color:var(--h-cccccc,#cccccc)] cursor-pointer mr-auto" title="Pokaż / ukryj wszystkie stylizacje tej warstwy na płótnie">
          <input
            type="checkbox"
            checked={preview}
            onChange={(e) => {
              setPreview(e.target.checked);
              push(styles, e.target.checked);
            }}
            className="accent-[color:var(--h-007acc,#007acc)]"
          />
          Podgląd
        </label>
        <button
          type="button"
          disabled={tab === 'presets'}
          onClick={() => {
            if (tab === 'presets') return;
            const d = defaultStyles();
            set((s) => {
              const keepEnabled = (s[tab] as StyleBase).enabled;
              (s as any)[tab] = { ...(d as any)[tab], enabled: keepEnabled };
            });
          }}
          className="h-6 px-2.5 text-[11px] rounded border bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] disabled:opacity-40 cursor-pointer disabled:cursor-default"
          title="Przywróć domyślne ustawienia wybranej stylizacji"
        >
          Resetuj
        </button>
        <button type="button" onClick={onCancel} className="h-6 px-2.5 text-[11px] rounded border bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] cursor-pointer">
          Anuluj
        </button>
        <button
          type="button"
          onClick={onOk}
          className="h-6 px-3 text-[11px] rounded border bg-[color:var(--h-10549c,#10549c)] border-[color:var(--h-2980b9,#2980b9)] text-white hover:bg-[color:var(--h-1465b5,#1465b5)] cursor-pointer"
          title={isNew ? 'Dodaj stylizacje do warstwy' : 'Zapisz zmiany'}
        >
          OK
        </button>
      </div>
    </DialogWindow>
  );
};
