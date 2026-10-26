/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import {
  ChannelId,
  ColorBalanceParams,
  ColorBalanceRange,
  Correction,
  CorrectionParamsMap,
  ControlDef,
  CurvePoint,
  CurvesParams,
  Histogram,
  LevelsChannelParams,
  LevelsParams,
  TonalRange,
  cloneParams,
  curveLut,
  defaultParams,
  getCorrectionDef,
} from '../core/skia/Corrections.ts';

interface CorrectionDialogProps {
  correction: Correction;
  layerName: string | null;
  isNew: boolean;
  /** Rozkład tonów warstwy przed tą korekcją (Poziomy, Krzywe); null = jeszcze nie policzony */
  histogram: Histogram | null;
  /** Zmiana parametrów: od razu widoczna na płótnie */
  onChangeParams: (params: Correction['params']) => void;
  onPreviewToggle: (on: boolean) => void;
  onOk: () => void;
  onCancel: () => void;
}

// --------------------------------------------------------------------------------------------------------------
// Drobne elementy interfejsu
// --------------------------------------------------------------------------------------------------------------

const fmt = (v: number, decimals: number): string => (decimals > 0 ? v.toFixed(decimals) : String(Math.round(v)));

export const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  unit?: string;
  defaultValue?: number;
  /** Tło ścieżki suwaka (np. gradient barwy) */
  trackStyle?: string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step, decimals = 0, unit, defaultValue, trackStyle, onChange }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between mb-0.5">
        <label
          className="text-[10.5px] text-[#bbb] cursor-default"
          title={defaultValue !== undefined ? 'Kliknij dwukrotnie, aby przywrócić wartość domyślną' : undefined}
          onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
        >
          {label}
        </label>
        <div className="flex items-center gap-0.5">
          <input
            type="text"
            inputMode="decimal"
            value={draft ?? fmt(value, decimals)}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setDraft(e.target.value);
              const v = parseFloat(e.target.value.replace(',', '.'));
              if (!Number.isNaN(v)) onChange(clamp(v));
            }}
            onBlur={() => setDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setDraft(null);
                (e.target as HTMLInputElement).blur();
                e.stopPropagation();
              }
            }}
            className="w-14 h-5 bg-[#111] border border-[#3e3e3e] rounded px-1 text-right text-[10.5px] text-white font-mono focus:outline-none focus:border-[#007acc]"
          />
          {unit && <span className="text-[10px] text-[#888] w-5">{unit.trim()}</span>}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(parseFloat(e.target.value)))}
        className="w-full h-1.5 rounded-lg appearance-none cursor-pointer accent-[#007acc]"
        style={{ background: trackStyle ?? '#444' }}
      />
    </div>
  );
};

export const CheckRow: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex items-center gap-1.5 mb-1.5 text-[10.5px] text-[#ccc] cursor-pointer select-none">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[#007acc]" />
    {label}
  </label>
);

const Tabs: React.FC<{
  tabs: { id: string; label: string; color?: string }[];
  value: string;
  onChange: (id: string) => void;
}> = ({ tabs, value, onChange }) => (
  <div className="flex gap-1 mb-2">
    {tabs.map((t) => (
      <button
        key={t.id}
        type="button"
        onClick={() => onChange(t.id)}
        className={`flex-1 h-5 text-[10.5px] rounded border cursor-pointer ${
          value === t.id ? 'bg-[#10549c] border-[#2980b9] text-white' : 'bg-[#282828] border-[#3e3e3e] text-[#ccc] hover:bg-[#333]'
        }`}
        style={t.color && value !== t.id ? { color: t.color } : undefined}
      >
        {t.label}
      </button>
    ))}
  </div>
);

const CHANNEL_TABS = [
  { id: 'rgb', label: 'RGB' },
  { id: 'r', label: 'R', color: '#ff7b72' },
  { id: 'g', label: 'G', color: '#7ee787' },
  { id: 'b', label: 'B', color: '#79c0ff' },
];

const CHANNEL_COLOR: Record<ChannelId, string> = { rgb: '#c8c8c8', r: '#ff6b6b', g: '#5fd068', b: '#5aa9ff' };

/** Histogram jako wypełniony wykres; skala ograniczona percentylem, żeby pojedyncze piki (czerń, biel) nie spłaszczały reszty. */
const HistogramView: React.FC<{ histogram: Histogram | null; channel: ChannelId; height: number; children?: React.ReactNode }> = ({
  histogram,
  channel,
  height,
  children,
}) => {
  const path = useMemo(() => {
    if (!histogram) return '';
    const bins = channel === 'rgb' ? histogram.lum : histogram[channel];
    const sorted = Array.from(bins).sort((a, b) => a - b);
    const cap = Math.max(1, sorted[Math.floor(255 * 0.985)]);
    let d = `M0 ${height}`;
    for (let i = 0; i < 256; i++) d += ` L${i} ${(height - Math.min(1, bins[i] / cap) * height).toFixed(1)}`;
    return d + ` L255 ${height} Z`;
  }, [histogram, channel, height]);
  return (
    <svg viewBox={`0 0 256 ${height}`} className="w-full block bg-[#101010] border border-[#333] rounded" style={{ height }} preserveAspectRatio="none">
      <path d={path} fill={CHANNEL_COLOR[channel]} opacity={0.55} />
      {children}
    </svg>
  );
};

// --------------------------------------------------------------------------------------------------------------
// Poziomy
// --------------------------------------------------------------------------------------------------------------

const LevelsEditor: React.FC<{
  params: LevelsParams;
  histogram: Histogram | null;
  onChange: (p: LevelsParams) => void;
}> = ({ params, histogram, onChange }) => {
  const [channel, setChannel] = useState<ChannelId>('rgb');
  const ch = params.channels[channel];
  const def = defaultParams('levels').channels[channel];
  const set = (patch: Partial<LevelsChannelParams>) => {
    const next: LevelsChannelParams = { ...ch, ...patch };
    if (next.inBlack >= next.inWhite) {
      if ('inBlack' in patch) next.inBlack = next.inWhite - 1;
      else next.inWhite = next.inBlack + 1;
    }
    onChange({ channels: { ...params.channels, [channel]: next } });
  };

  const autoLevels = () => {
    if (!histogram) return;
    const bins = channel === 'rgb' ? histogram.lum : histogram[channel];
    let total = 0;
    for (let i = 0; i < 256; i++) total += bins[i];
    if (total === 0) return;
    const clip = total * 0.005;
    let acc = 0;
    let lo = 0;
    for (let i = 0; i < 256; i++) {
      acc += bins[i];
      if (acc > clip) {
        lo = i;
        break;
      }
    }
    acc = 0;
    let hi = 255;
    for (let i = 255; i >= 0; i--) {
      acc += bins[i];
      if (acc > clip) {
        hi = i;
        break;
      }
    }
    if (hi <= lo) return;
    set({ inBlack: lo, inWhite: hi, gamma: 1 });
  };

  return (
    <div>
      <Tabs tabs={CHANNEL_TABS} value={channel} onChange={(id) => setChannel(id as ChannelId)} />
      <div className="mb-1">
        <HistogramView histogram={histogram} channel={channel} height={56}>
          {/* znaczniki poziomów wejściowych */}
          <line x1={ch.inBlack} x2={ch.inBlack} y1={0} y2={56} stroke="#ddd" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={ch.inWhite} x2={ch.inWhite} y1={0} y2={56} stroke="#ddd" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </HistogramView>
        <div className="h-2.5 rounded-sm mt-0.5 border border-[#333]" style={{ background: 'linear-gradient(to right, #000, #fff)' }} />
      </div>
      <div className="flex justify-end mb-1.5">
        <button
          type="button"
          onClick={autoLevels}
          disabled={!histogram}
          className="h-5 px-2 text-[10.5px] rounded border bg-[#282828] border-[#3e3e3e] text-[#ccc] hover:bg-[#383838] disabled:opacity-40 cursor-pointer"
          title="Ustaw czerń i biel wejściową według rozkładu tonów (odcina po 0,5% skrajnych pikseli)"
        >
          Auto
        </button>
      </div>
      <SliderRow label="Czerń wejściowa" value={ch.inBlack} min={0} max={254} step={1} defaultValue={def.inBlack} onChange={(v) => set({ inBlack: v })} />
      <SliderRow label="Półtony (gamma)" value={ch.gamma} min={0.1} max={9.99} step={0.01} decimals={2} defaultValue={1} onChange={(v) => set({ gamma: v })} />
      <SliderRow label="Biel wejściowa" value={ch.inWhite} min={1} max={255} step={1} defaultValue={def.inWhite} onChange={(v) => set({ inWhite: v })} />
      <SliderRow label="Czerń wyjściowa" value={ch.outBlack} min={0} max={255} step={1} defaultValue={def.outBlack} onChange={(v) => set({ outBlack: v })} />
      <SliderRow label="Biel wyjściowa" value={ch.outWhite} min={0} max={255} step={1} defaultValue={def.outWhite} onChange={(v) => set({ outWhite: v })} />
    </div>
  );
};

// --------------------------------------------------------------------------------------------------------------
// Krzywe
// --------------------------------------------------------------------------------------------------------------

const CurvesEditor: React.FC<{
  params: CurvesParams;
  histogram: Histogram | null;
  onChange: (p: CurvesParams) => void;
}> = ({ params, histogram, onChange }) => {
  const [channel, setChannel] = useState<ChannelId>('rgb');
  const [drag, setDrag] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pts = params.channels[channel];
  const SIZE = 256;

  const curvePath = useMemo(() => {
    const lut = curveLut(pts);
    let d = '';
    for (let x = 0; x < 256; x++) d += `${x === 0 ? 'M' : 'L'}${x} ${SIZE - lut[x]} `;
    return d;
  }, [pts]);

  // Pozostałe kanały, które już zmodyfikowano (nie są prostą 0,0 → 255,255): rysowane w tle przyciemnionym kolorem
  const otherPaths = useMemo(() => {
    const out: { id: ChannelId; d: string }[] = [];
    (['rgb', 'r', 'g', 'b'] as ChannelId[]).forEach((id) => {
      if (id === channel) return;
      const q = params.channels[id];
      const identity = q.length === 2 && q[0].x === 0 && q[0].y === 0 && q[1].x === 255 && q[1].y === 255;
      if (identity) return;
      const lut = curveLut(q);
      let d = '';
      for (let x = 0; x < 256; x++) d += `${x === 0 ? 'M' : 'L'}${x} ${SIZE - lut[x]} `;
      out.push({ id, d });
    });
    return out;
  }, [params.channels, channel]);

  const setPoints = (next: CurvePoint[]) => onChange({ channels: { ...params.channels, [channel]: next } });

  const toCurve = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 255)),
      y: Math.max(0, Math.min(255, (1 - (e.clientY - r.top) / r.height) * 255)),
    };
  };

  const hitIndex = (e: React.PointerEvent | React.MouseEvent): number => {
    const r = svgRef.current!.getBoundingClientRect();
    const rad = (11 / r.width) * 255;
    const p = toCurve(e);
    let best = -1;
    let bestD = rad;
    pts.forEach((q, i) => {
      const dd = Math.hypot(q.x - p.x, q.y - p.y);
      if (dd <= bestD) {
        bestD = dd;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const hit = hitIndex(e);
    svgRef.current!.setPointerCapture(e.pointerId);
    if (hit >= 0) {
      setDrag(hit);
      return;
    }
    const p = toCurve(e);
    const x = Math.round(Math.max(1, Math.min(254, p.x)));
    if (pts.some((q) => Math.abs(q.x - x) < 1)) return;
    const next = [...pts, { x, y: Math.round(p.y) }].sort((a, b) => a.x - b.x);
    setPoints(next);
    setDrag(next.findIndex((q) => q.x === x));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag === null) return;
    const p = toCurve(e);
    const next = pts.map((q) => ({ ...q }));
    const cur = next[drag];
    cur.y = Math.round(p.y);
    if (drag > 0 && drag < next.length - 1) {
      cur.x = Math.round(Math.max(next[drag - 1].x + 1, Math.min(next[drag + 1].x - 1, p.x)));
    }
    setPoints(next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (drag !== null) {
      try {
        svgRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /* wskaźnik mógł już zostać zwolniony */
      }
    }
    setDrag(null);
  };

  const removeAt = (i: number) => {
    if (i <= 0 || i >= pts.length - 1) return;
    setPoints(pts.filter((_, k) => k !== i));
  };

  const sel = drag !== null ? pts[drag] : null;

  return (
    <div>
      <Tabs tabs={CHANNEL_TABS} value={channel} onChange={(id) => setChannel(id as ChannelId)} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="w-full block bg-[#101010] border border-[#333] rounded touch-none select-none"
        style={{ aspectRatio: '1 / 1', cursor: 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(e) => removeAt(hitIndex(e))}
        onContextMenu={(e) => {
          e.preventDefault();
          removeAt(hitIndex(e));
        }}
      >
        {histogram &&
          (() => {
            const bins = channel === 'rgb' ? histogram.lum : histogram[channel];
            const sorted = Array.from(bins).sort((a, b) => a - b);
            const cap = Math.max(1, sorted[Math.floor(255 * 0.985)]);
            let d = `M0 ${SIZE}`;
            for (let i = 0; i < 256; i++) d += ` L${i} ${(SIZE - Math.min(1, bins[i] / cap) * SIZE * 0.6).toFixed(1)}`;
            return <path d={d + ` L255 ${SIZE} Z`} fill={CHANNEL_COLOR[channel]} opacity={0.22} />;
          })()}
        {[64, 128, 192].map((g) => (
          <g key={g} stroke="#2e2e2e" strokeWidth={1} vectorEffect="non-scaling-stroke">
            <line x1={g} x2={g} y1={0} y2={SIZE} vectorEffect="non-scaling-stroke" />
            <line x1={0} x2={SIZE} y1={g} y2={g} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="#444" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        {otherPaths.map((o) => (
          <path key={o.id} d={o.d} fill="none" stroke={CHANNEL_COLOR[o.id]} strokeWidth={1.2} opacity={0.35} vectorEffect="non-scaling-stroke" pointerEvents="none" />
        ))}
        <path d={curvePath} fill="none" stroke={CHANNEL_COLOR[channel]} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        {pts.map((p, i) => (
          <rect
            key={i}
            x={p.x - 3.5}
            y={SIZE - p.y - 3.5}
            width={7}
            height={7}
            fill={drag === i ? CHANNEL_COLOR[channel] : '#111'}
            stroke="#fff"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="flex justify-between items-center mt-1 mb-1 text-[10px] text-[#888] h-4">
        <span>Klik: dodaj punkt · dwuklik / PPM: usuń</span>
        {sel && (
          <span className="font-mono text-[#ccc]">
            {Math.round(sel.x)} → {Math.round(sel.y)}
          </span>
        )}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setPoints(defaultParams('curves').channels[channel])}
          className="h-5 px-2 text-[10.5px] rounded border bg-[#282828] border-[#3e3e3e] text-[#ccc] hover:bg-[#383838] cursor-pointer"
        >
          Resetuj kanał
        </button>
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------------------------------------------
// Balans kolorów
// --------------------------------------------------------------------------------------------------------------

const RANGE_TABS = [
  { id: 'shadows', label: 'Cienie' },
  { id: 'midtones', label: 'Półtony' },
  { id: 'highlights', label: 'Światła' },
];

const ColorBalanceEditor: React.FC<{ params: ColorBalanceParams; onChange: (p: ColorBalanceParams) => void }> = ({ params, onChange }) => {
  const [range, setRange] = useState<TonalRange>('midtones');
  const r = params[range];
  const set = (patch: Partial<ColorBalanceRange>) => onChange({ ...params, [range]: { ...r, ...patch } });
  return (
    <div>
      <Tabs tabs={RANGE_TABS} value={range} onChange={(id) => setRange(id as TonalRange)} />
      <SliderRow
        label="Cyjan  ↔  Czerwony"
        value={r.cyanRed}
        min={-100}
        max={100}
        step={1}
        defaultValue={0}
        trackStyle="linear-gradient(to right, #00d5d5, #555, #e53935)"
        onChange={(v) => set({ cyanRed: v })}
      />
      <SliderRow
        label="Magenta  ↔  Zielony"
        value={r.magentaGreen}
        min={-100}
        max={100}
        step={1}
        defaultValue={0}
        trackStyle="linear-gradient(to right, #d500d5, #555, #43a047)"
        onChange={(v) => set({ magentaGreen: v })}
      />
      <SliderRow
        label="Żółty  ↔  Niebieski"
        value={r.yellowBlue}
        min={-100}
        max={100}
        step={1}
        defaultValue={0}
        trackStyle="linear-gradient(to right, #e6c800, #555, #1e63e6)"
        onChange={(v) => set({ yellowBlue: v })}
      />
      <CheckRow label="Zachowaj luminancję" checked={params.preserveLuminosity} onChange={(v) => onChange({ ...params, preserveLuminosity: v })} />
    </div>
  );
};

// --------------------------------------------------------------------------------------------------------------
// Kontrolki generowane z opisu
// --------------------------------------------------------------------------------------------------------------

const GenericControls: React.FC<{
  controls: ControlDef[];
  params: Record<string, any>;
  defaults: Record<string, any>;
  onChange: (p: Record<string, any>) => void;
}> = ({ controls, params, defaults, onChange }) => (
  <div>
    {controls.map((c) => {
      if (c.showIf && !c.showIf(params)) return null;
      if (c.kind === 'slider') {
        return (
          <SliderRow
            key={c.key}
            label={c.label}
            value={params[c.key]}
            min={c.min}
            max={c.max}
            step={c.step}
            decimals={c.decimals}
            unit={c.unit}
            defaultValue={defaults[c.key]}
            onChange={(v) => onChange({ ...params, [c.key]: v })}
          />
        );
      }
      if (c.kind === 'checkbox') {
        return <CheckRow key={c.key} label={c.label} checked={!!params[c.key]} onChange={(v) => onChange({ ...params, [c.key]: v })} />;
      }
      return (
        <div key={c.key} className="mb-2">
          <label className="block text-[10.5px] text-[#bbb] mb-0.5">{c.label}</label>
          <select
            value={params[c.key]}
            onChange={(e) => onChange({ ...params, [c.key]: e.target.value })}
            className="w-full h-6 bg-[#222] border border-[#444] rounded px-1.5 text-[10.5px] text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
          >
            {c.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      );
    })}
  </div>
);

// --------------------------------------------------------------------------------------------------------------
// Okno
// --------------------------------------------------------------------------------------------------------------

/**
 * Pływające okno edycji korekcji. Każda zmiana ustawień jest od razu przekazywana silnikowi (podgląd na żywo na płótnie);
 * OK zatwierdza korekcję w historii, Anuluj przywraca stan sprzed otwarcia okna.
 */
export const CorrectionDialog: React.FC<CorrectionDialogProps> = ({
  correction,
  layerName,
  isNew,
  histogram,
  onChangeParams,
  onPreviewToggle,
  onOk,
  onCancel,
}) => {
  const def = getCorrectionDef(correction.type);
  const [params, setParams] = useState<CorrectionParamsMap[typeof correction.type]>(() => cloneParams(correction.params));
  const [preview, setPreview] = useState(true);
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 224 - 312 - 24),
    y: 120,
  }));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const update = (next: any) => {
    setParams(next);
    onChangeParams(next);
  };

  // Enter = OK, Esc = Anuluj (pola tekstowe same obsługują Enter)
  const latest = useRef({ onOk, onCancel });
  latest.current = { onOk, onCancel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        latest.current.onCancel();
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement && e.target.type === 'text') && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        latest.current.onOk();
      }
    };
    // faza przechwytywania: okno reaguje na Esc / Enter także wtedy, gdy fokus jest w jego polach (te zatrzymują propagację)
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const onTitleDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onTitleMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - d.dx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - d.dy)),
    });
  };
  const onTitleUp = () => {
    dragRef.current = null;
  };

  const defaults = defaultParams(correction.type) as unknown as Record<string, any>;

  return (
    <div
      role="dialog"
      aria-label={def.name}
      className="fixed z-[60] w-[312px] bg-[#1e1e1e] border border-[#3a3a3a] rounded-md shadow-2xl text-xs select-none flex flex-col"
      style={{ left: pos.x, top: pos.y, maxHeight: 'calc(100vh - 24px)' }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center justify-between px-2.5 h-7 bg-[#2a2a2b] border-b border-[#3a3a3a] rounded-t-md cursor-move shrink-0"
        onPointerDown={onTitleDown}
        onPointerMove={onTitleMove}
        onPointerUp={onTitleUp}
        onPointerCancel={onTitleUp}
      >
        <span className="text-[11px] font-semibold text-white truncate">
          {def.name}
          {layerName ? <span className="font-normal text-[#999]"> · {layerName}</span> : null}
        </span>
        <button type="button" onClick={onCancel} title="Anuluj (Esc)" className="p-0.5 rounded text-[#bbb] hover:bg-[#4a2a2a] hover:text-white cursor-pointer">
          <X size={13} />
        </button>
      </div>

      <div className="p-3 overflow-y-auto min-h-0">
        {def.editor === 'levels' ? (
          <LevelsEditor params={params as LevelsParams} histogram={histogram} onChange={update} />
        ) : def.editor === 'curves' ? (
          <CurvesEditor params={params as CurvesParams} histogram={histogram} onChange={update} />
        ) : def.editor === 'colorBalance' ? (
          <ColorBalanceEditor params={params as ColorBalanceParams} onChange={update} />
        ) : (
          <GenericControls controls={def.controls ?? []} params={params as Record<string, any>} defaults={defaults} onChange={update} />
        )}
      </div>

      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[#333] shrink-0">
        <label className="flex items-center gap-1.5 text-[10.5px] text-[#ccc] cursor-pointer mr-auto">
          <input
            type="checkbox"
            checked={preview}
            onChange={(e) => {
              setPreview(e.target.checked);
              onPreviewToggle(e.target.checked);
            }}
            className="accent-[#007acc]"
          />
          Podgląd
        </label>
        <button
          type="button"
          onClick={() => update(defaultParams(correction.type))}
          className="h-6 px-2.5 text-[11px] rounded border bg-[#282828] border-[#3e3e3e] text-[#ccc] hover:bg-[#383838] cursor-pointer"
          title="Przywróć ustawienia domyślne"
        >
          Resetuj
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-6 px-2.5 text-[11px] rounded border bg-[#282828] border-[#3e3e3e] text-[#ccc] hover:bg-[#383838] cursor-pointer"
        >
          Anuluj
        </button>
        <button
          type="button"
          onClick={onOk}
          className="h-6 px-3 text-[11px] rounded border bg-[#10549c] border-[#2980b9] text-white hover:bg-[#1465b5] cursor-pointer"
          title={isNew ? 'Dodaj korekcję do warstwy' : 'Zapisz zmiany'}
        >
          OK
        </button>
      </div>
    </div>
  );
};
