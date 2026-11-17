/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialogOwnsKey } from '../core/dialogStack.ts';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DialogWindow } from './DialogWindow.tsx';
import { ScrubField } from './ScrubField.tsx';
import { CorrectionPresetsBar } from './CorrectionPresetsBar.tsx';
import { hasPresetParams } from '../core/CorrectionPresets.ts';
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
} from '../core/Corrections.ts';

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
}> = ({ label, value, min, max, step, decimals = 0, unit, defaultValue, trackStyle, onChange }) => (
  <div className="mb-2">
    <label
      className="block mb-0.5 text-[10.5px] text-[color:var(--h-bbbbbb,#bbbbbb)] cursor-default"
      title={defaultValue !== undefined ? 'Kliknij dwukrotnie, aby przywrócić wartość domyślną' : undefined}
      onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
    >
      {label}
    </label>
    <ScrubField
      value={value}
      min={min}
      max={max}
      step={step}
      format={(v) => fmt(v, decimals)}
      suffix={unit?.trim()}
      trackStyle={trackStyle}
      width="100%"
      title={label}
      onChange={onChange}
    />
  </div>
);

export const CheckRow: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex items-center gap-1.5 mb-1.5 text-[10.5px] text-[color:var(--h-cccccc,#cccccc)] cursor-pointer select-none">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[color:var(--h-007acc,#007acc)]" />
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
          value === t.id ? 'bg-[color:var(--h-10549c,#10549c)] border-[color:var(--h-2980b9,#2980b9)] text-white' : 'bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-333333,#333333)]'
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
  { id: 'r', label: 'R', color: 'var(--c-ch-r, #ff7b72)' },
  { id: 'g', label: 'G', color: 'var(--c-ch-g, #7ee787)' },
  { id: 'b', label: 'B', color: 'var(--c-ch-b, #79c0ff)' },
];

const CHANNEL_COLOR: Record<ChannelId, string> = { rgb: 'var(--c-hist-rgb,#c8c8c8)', r: 'var(--c-hist-r,#ff6b6b)', g: 'var(--c-hist-g,#5fd068)', b: 'var(--c-hist-b,#5aa9ff)' };

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
    <svg viewBox={`0 0 256 ${height}`} className="w-full block bg-[color:var(--c-chart-bg,#151515)] border border-[color:var(--c-chart-border,#6a6a6a)] rounded" style={{ height }} preserveAspectRatio="none">
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
          <line x1={ch.inBlack} x2={ch.inBlack} y1={0} y2={56} stroke="var(--c-chart-mark,#ddd)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={ch.inWhite} x2={ch.inWhite} y1={0} y2={56} stroke="var(--c-chart-mark,#ddd)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </HistogramView>
        <div className="h-2.5 rounded-sm mt-0.5 border border-[color:var(--h-333333,#333333)]" style={{ background: 'linear-gradient(to right, #000, #fff)' }} />
      </div>
      <div className="flex justify-end mb-1.5">
        <button
          type="button"
          onClick={autoLevels}
          disabled={!histogram}
          className="h-5 px-2 text-[10.5px] rounded border bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] disabled:opacity-40 cursor-pointer"
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
        className="w-full block bg-[color:var(--c-chart-bg,#151515)] border border-[color:var(--c-chart-border,#6a6a6a)] rounded touch-none select-none"
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
          <g key={g} stroke="var(--c-chart-grid,#2e2e2e)" strokeWidth={1} vectorEffect="non-scaling-stroke">
            <line x1={g} x2={g} y1={0} y2={SIZE} vectorEffect="non-scaling-stroke" />
            <line x1={0} x2={SIZE} y1={g} y2={g} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} stroke="var(--c-chart-diag,#444)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
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
            fill={drag === i ? CHANNEL_COLOR[channel] : 'var(--c-chart-pt,#111)'}
            stroke="var(--c-chart-ptb,#fff)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="flex justify-between items-center mt-1 mb-1 text-[10px] text-[color:var(--h-888888,#888888)] h-4">
        <span>Klik: dodaj punkt · dwuklik / PPM: usuń</span>
        {sel && (
          <span className="font-mono text-[color:var(--h-cccccc,#cccccc)]">
            {Math.round(sel.x)} → {Math.round(sel.y)}
          </span>
        )}
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setPoints(defaultParams('curves').channels[channel])}
          className="h-5 px-2 text-[10.5px] rounded border bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] cursor-pointer"
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
          <label className="block text-[10.5px] text-[color:var(--h-bbbbbb,#bbbbbb)] mb-0.5">{c.label}</label>
          <select
            value={params[c.key]}
            onChange={(e) => onChange({ ...params, [c.key]: e.target.value })}
            className="w-full h-6 bg-[color:var(--h-222222,#222222)] border border-[color:var(--h-444444,#444444)] rounded px-1.5 text-[10.5px] text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)] cursor-pointer"
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

  const update = (next: any) => {
    setParams(next);
    onChangeParams(next);
  };

  // Enter = OK, Esc = Anuluj (pola tekstowe same obsługują Enter)
  const latest = useRef({ onOk, onCancel });
  latest.current = { onOk, onCancel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'correction-dialog')) return;
      if (e.key === 'Escape') {
        // Esc w polu nazwy presetu anuluje tylko nazwę (obsługuje je samo pole)
        if (e.target instanceof HTMLElement && e.target.dataset.presetName !== undefined) return;
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

  const defaults = defaultParams(correction.type) as unknown as Record<string, any>;

  return (
    <DialogWindow
      width={312}
      onClose={onCancel}
      testId="correction-dialog"
      initialPos={() => ({ x: Math.max(16, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 224 - 312 - 24), y: 120 })}
      title={
        <>
          {def.name}
          {layerName ? <span className="font-normal text-[color:var(--h-999999,#999999)]"> · {layerName}</span> : null}
        </>
      }
    >
      {hasPresetParams(correction.type) && <CorrectionPresetsBar type={correction.type} current={params} onApply={update} />}

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

      <div className="flex items-center gap-1.5 px-3 py-2 border-t border-[color:var(--h-333333,#333333)] shrink-0">
        <label className="flex items-center gap-1.5 text-[10.5px] text-[color:var(--h-cccccc,#cccccc)] cursor-pointer mr-auto">
          <input
            type="checkbox"
            checked={preview}
            onChange={(e) => {
              setPreview(e.target.checked);
              onPreviewToggle(e.target.checked);
            }}
            className="accent-[color:var(--h-007acc,#007acc)]"
          />
          Podgląd
        </label>
        <button
          type="button"
          onClick={() => update(defaultParams(correction.type))}
          className="h-6 px-2.5 text-[11px] rounded border bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] cursor-pointer"
          title="Przywróć ustawienia domyślne"
        >
          Resetuj
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-6 px-2.5 text-[11px] rounded border bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] cursor-pointer"
        >
          Anuluj
        </button>
        <button
          type="button"
          onClick={onOk}
          className="h-6 px-3 text-[11px] rounded border bg-[color:var(--h-10549c,#10549c)] border-[color:var(--h-2980b9,#2980b9)] text-white hover:bg-[color:var(--h-1465b5,#1465b5)] cursor-pointer"
          title={isNew ? 'Dodaj korekcję do warstwy' : 'Zapisz zmiany'}
        >
          OK
        </button>
      </div>
    </DialogWindow>
  );
};
