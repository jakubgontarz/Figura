/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Link2, Link2Off } from 'lucide-react';
import { LengthField, UnitLabel } from './Units.tsx';

/** Opis zaznaczonego obiektu wektorowego przekazywany z widoku płótna do panelu (współrzędne w pikselach dokumentu). */
export type PropsDescriptor =
  | { kind: 'guide'; guides: { id: string; axis: 'h' | 'v'; pos: number }[]; selected: string | null }
  | { kind: 'box'; label: string; cx: number; cy: number; w: number; h: number; angle: number }
  | { kind: 'line'; p0: { x: number; y: number }; p1: { x: number; y: number } }
  | { kind: 'path'; box: { cx: number; cy: number; w: number; h: number; angle: number } | null; nodes: { x: number; y: number; hin: { x: number; y: number } | null; hout: { x: number; y: number } | null }[]; selected: number }
  | null;

export interface PropsApi {
  selectGuide: (id: string) => void;
  setGuidePos: (id: string, pos: number) => void;
  removeGuide: (id: string) => void;
  setBox: (next: { cx: number; cy: number; w: number; h: number; angle: number }) => void;
  setLinePoint: (index: 0 | 1, x: number, y: number) => void;
  selectNode: (index: number) => void;
  setNodePoint: (index: number, part: 'anchor' | 'hin' | 'hout', x: number, y: number) => void;
}

const INPUT = 'w-[62px] h-5 bg-[#252525] border border-[#444] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#007acc]';
const BIG = 1e6;

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-1.5">
    <span className="w-[34px] text-[10.5px] text-[#aaa] shrink-0">{label}</span>
    {children}
  </div>
);

const XY: React.FC<{ x: number; y: number; onChange: (x: number, y: number) => void; xl?: string; yl?: string }> = ({ x, y, onChange, xl = 'X', yl = 'Y' }) => (
  <div className="flex flex-col gap-1">
    <Row label={xl}>
      <LengthField valuePx={x} minPx={-BIG} maxPx={BIG} integerPx={false} className={INPUT} onCommitPx={(v) => onChange(v, y)} />
      <UnitLabel />
    </Row>
    <Row label={yl}>
      <LengthField valuePx={y} minPx={-BIG} maxPx={BIG} integerPx={false} className={INPUT} onCommitPx={(v) => onChange(x, v)} />
      <UnitLabel />
    </Row>
  </div>
);

const rot = (x: number, y: number, a: number) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });

const BoxEditor: React.FC<{ label: string; box: { cx: number; cy: number; w: number; h: number; angle: number }; api: PropsApi }> = ({ label, box, api }) => {
  // punkt odniesienia: -1/0/1 w poziomie i w pionie (środek ramki = 0,0)
  const [anchor, setAnchor] = useState<{ ax: number; ay: number }>({ ax: 0, ay: 0 });
  const [lock, setLock] = useState(false);
    const { cx, cy, w, h, angle } = box;
    const a = { x: (anchor.ax * w) / 2, y: (anchor.ay * h) / 2 };
    const ra = rot(a.x, a.y, angle);
    const P = { x: cx + ra.x, y: cy + ra.y };
    const apply = (nw: number, nh: number, nang: number, Pn: { x: number; y: number }) => {
      nw = nw === w ? w : Math.max(1, nw);
      nh = nh === h ? h : Math.max(1, nh);
      const an = rot((anchor.ax * nw) / 2, (anchor.ay * nh) / 2, nang);
      api.setBox({ cx: Pn.x - an.x, cy: Pn.y - an.y, w: nw, h: nh, angle: nang });
    };
    const deg = (angle * 180) / Math.PI;
    return (
      <div className="flex flex-col gap-2.5 text-xs" data-testid="props-box">
        <div className="text-[11px] text-[#ccc] font-semibold">{label}</div>
        <div className="flex gap-3 items-start">
          <div title="Punkt odniesienia ramki" className="grid grid-cols-3 gap-[3px] p-1 bg-[#252525] border border-[#444] rounded">
            {[-1, 0, 1].map((ay) =>
              [-1, 0, 1].map((ax) => (
                <button
                  key={`${ax}${ay}`}
                  type="button"
                  data-anchor={`${ax},${ay}`}
                  onClick={() => setAnchor({ ax, ay })}
                  className={`w-3.5 h-3.5 border cursor-pointer ${anchor.ax === ax && anchor.ay === ay ? 'bg-[#007acc] border-[#4db2ff]' : 'bg-[#1a1a1a] border-[#555] hover:bg-[#333]'}`}
                />
              ))
            )}
          </div>
          <XY x={P.x} y={P.y} onChange={(x, y) => apply(w, h, angle, { x, y })} />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-1">
            <Row label="H">
              <LengthField valuePx={w} minPx={1} maxPx={BIG} integerPx={false} className={INPUT} title="Wymiar poziomy (H)" onCommitPx={(v) => apply(v, lock ? (v * h) / w : h, angle, P)} />
              <UnitLabel />
            </Row>
            <Row label="V">
              <LengthField valuePx={h} minPx={1} maxPx={BIG} integerPx={false} className={INPUT} title="Wymiar pionowy (V)" onCommitPx={(v) => apply(lock ? (v * w) / h : w, v, angle, P)} />
              <UnitLabel />
            </Row>
          </div>
          <button
            type="button"
            onClick={() => setLock((l) => !l)}
            title={lock ? 'Proporcje zablokowane' : 'Zablokuj proporcje'}
            data-testid="props-lock"
            className={`h-7 w-7 flex items-center justify-center rounded border cursor-pointer ${lock ? 'bg-[#094771] border-[#007acc] text-white' : 'bg-[#252525] border-[#444] text-[#aaa] hover:text-white'}`}
          >
            {lock ? <Link2 size={14} /> : <Link2Off size={14} />}
          </button>
        </div>
        <Row label="Kąt">
          <input
            type="number"
            step={0.1}
            title="Kąt obrotu (stopnie)"
            data-testid="props-angle"
            value={Math.round(deg * 100) / 100}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) apply(w, h, (v * Math.PI) / 180, P);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            className={INPUT}
          />
          <span className="text-[10px] text-[#888]">°</span>
        </Row>
      </div>
    );
};

const PathEditor: React.FC<{ desc: Extract<PropsDescriptor, { kind: 'path' }>; api: PropsApi }> = ({ desc, api }) => {
  // -1 = cały kształt, 0.. = numer punktu
  const [target, setTarget] = useState<number>(-1);
  const [lastSel, setLastSel] = useState(desc.selected);
  // kliknięcie punktu na płótnie przełącza listę na ten punkt
  if (desc.selected !== lastSel) {
    setLastSel(desc.selected);
    setTarget(desc.selected);
  }
  const count = desc.nodes.length;
  const t = desc.box ? Math.min(target, count - 1) : Math.max(0, Math.min(target, count - 1));
  const go = (i: number) => {
    const v = Math.max(desc.box ? -1 : 0, Math.min(count - 1, i));
    setTarget(v);
    if (v >= 0) api.selectNode(v);
  };
  const n = t >= 0 ? desc.nodes[t] : null;
  const btn = 'h-5 px-1.5 flex items-center bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] cursor-pointer disabled:opacity-40';
  return (
    <div className="flex flex-col gap-2.5 text-xs" data-testid="props-path">
      <div className="flex items-center gap-1">
        <button type="button" className={btn} disabled={t <= (desc.box ? -1 : 0)} onClick={() => go(t - 1)} title="Poprzedni" data-testid="node-prev"><ChevronLeft size={14} /></button>
        <select
          value={t}
          onChange={(e) => go(parseInt(e.target.value, 10))}
          data-testid="path-select"
          title="Kształt krzywej lub jej punkt"
          className="h-5 flex-1 min-w-0 bg-[#222] border border-[#444] rounded px-1 text-[11px] text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
        >
          {desc.box && <option value={-1}>Kształt</option>}
          {desc.nodes.map((_, i) => (
            <option key={i} value={i}>{`Punkt ${i + 1}`}</option>
          ))}
        </select>
        <button type="button" className={btn} disabled={t >= count - 1} onClick={() => go(t + 1)} title="Następny" data-testid="node-next"><ChevronRight size={14} /></button>
      </div>
      {t < 0 && desc.box && <BoxEditor label="Krzywa" box={desc.box} api={api} />}
      {n && (
        <>
          <div>
            <div className="text-[10.5px] text-[#888] mb-1">Punkt węzła</div>
            <XY x={n.x} y={n.y} onChange={(x, y) => api.setNodePoint(t, 'anchor', x, y)} />
          </div>
          {n.hin && (
            <div>
              <div className="text-[10.5px] text-[#888] mb-1">Uchwyt przed punktem</div>
              <XY x={n.hin.x} y={n.hin.y} onChange={(x, y) => api.setNodePoint(t, 'hin', x, y)} />
            </div>
          )}
          {n.hout && (
            <div>
              <div className="text-[10.5px] text-[#888] mb-1">Uchwyt po punkcie</div>
              <XY x={n.hout.x} y={n.hout.y} onChange={(x, y) => api.setNodePoint(t, 'hout', x, y)} />
            </div>
          )}
        </>
      )}
    </div>
  );
};

const GuideEditor: React.FC<{ desc: Extract<PropsDescriptor, { kind: 'guide' }>; api: PropsApi }> = ({ desc, api }) => {
  const idx = desc.guides.findIndex((g) => g.id === desc.selected);
  const sel = idx >= 0 ? desc.guides[idx] : null;
  const name = (g: { axis: 'h' | 'v' }, i: number) => `${g.axis === 'v' ? 'Pionowa' : 'Pozioma'} ${i + 1}`;
  return (
    <div className="flex flex-col gap-2.5 text-xs" data-testid="props-guide">
      <div className="text-[11px] text-[#ccc] font-semibold">Prowadnice obrazu</div>
      <div className="flex items-center gap-1">
        <button type="button" data-testid="guide-prev" title="Poprzednia prowadnica" disabled={idx <= 0} onClick={() => api.selectGuide(desc.guides[idx - 1].id)} className="h-5 px-1.5 flex items-center bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] cursor-pointer disabled:opacity-40"><ChevronLeft size={14} /></button>
      <select
        data-testid="guide-select"
        value={sel?.id ?? ''}
        onChange={(e) => api.selectGuide(e.target.value)}
        className="h-5 flex-1 min-w-0 bg-[#222] border border-[#444] rounded px-1 text-[11px] text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
      >
        {!sel && <option value="">(wybierz prowadnicę)</option>}
        {desc.guides.map((g, i) => (
          <option key={g.id} value={g.id}>{name(g, i)}</option>
        ))}
      </select>
        <button type="button" data-testid="guide-next" title="Następna prowadnica" disabled={idx >= desc.guides.length - 1} onClick={() => api.selectGuide(desc.guides[idx + 1].id)} className="h-5 px-1.5 flex items-center bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] cursor-pointer disabled:opacity-40"><ChevronRight size={14} /></button>
      </div>
      {sel && (
        <>
          <Row label={sel.axis === 'v' ? 'X' : 'Y'}>
            <LengthField valuePx={sel.pos} minPx={-BIG} maxPx={BIG} integerPx={false} className={INPUT} onCommitPx={(v) => api.setGuidePos(sel.id, v)} />
            <UnitLabel />
          </Row>
          <button
            type="button"
            data-testid="guide-delete"
            onClick={() => api.removeGuide(sel.id)}
            className="h-5 px-2 self-start text-[11px] bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] hover:text-white cursor-pointer"
          >
            Usuń prowadnicę
          </button>
        </>
      )}
    </div>
  );
};

export const PropertiesPanel: React.FC<{ desc: PropsDescriptor; api: PropsApi | null }> = ({ desc, api }) => {
  if (!desc || !api) {
    return <div className="text-[11px] text-[#888] px-1 py-3">Zaznacz pojedynczy obiekt wektorowy narzędziem Manipulacja, aby edytować jego właściwości.</div>;
  }

  if (desc.kind === 'guide') return <GuideEditor desc={desc} api={api} />;

  if (desc.kind === 'box') {
    return <BoxEditor label={desc.label} box={desc} api={api} />;
  }

  if (desc.kind === 'line') {
    return (
      <div className="flex flex-col gap-3 text-xs" data-testid="props-line">
        <div className="text-[11px] text-[#ccc] font-semibold">Linia prosta</div>
        <div>
          <div className="text-[10.5px] text-[#888] mb-1">Początek</div>
          <XY x={desc.p0.x} y={desc.p0.y} onChange={(x, y) => api.setLinePoint(0, x, y)} />
        </div>
        <div>
          <div className="text-[10.5px] text-[#888] mb-1">Koniec</div>
          <XY x={desc.p1.x} y={desc.p1.y} onChange={(x, y) => api.setLinePoint(1, x, y)} />
        </div>
      </div>
    );
  }

  return <PathEditor desc={desc} api={api} />;
};
