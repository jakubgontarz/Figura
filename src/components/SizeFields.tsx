import React from 'react';
import { Link2, Link2Off } from 'lucide-react';
import { ScrubField } from './ScrubField.tsx';
import { LENGTH_UNITS, LengthUnit, UNIT_LABEL, pxToUnit, unitToPx } from '../core/Units.ts';
import { GraphicEngine } from '../core/GraphicEngine.ts';

const DECIMALS: Record<LengthUnit | '%', number> = { px: 0, '%': 2, mm: 2, cm: 3, in: 3 };
const STEP: Record<LengthUnit | '%', number> = { px: 1, '%': 0.01, mm: 0.01, cm: 0.001, in: 0.001 };
const UNIT_NAME: Record<LengthUnit, string> = { px: 'Piksele', mm: 'mm', cm: 'cm', in: 'cal' };

export const fmtSizeValue = (v: number, unit: LengthUnit | '%'): string => {
  const k = 10 ** DECIMALS[unit];
  return String(Math.round(v * k) / k).replace('.', ',');
};

interface Props {
  /** obecny rozmiar dokumentu (px): podstawa procentów */
  width: number;
  height: number;
  /** nowy rozmiar (px) */
  wPx: number;
  hPx: number;
  dpi: number;
  unit: LengthUnit;
  onUnit: (u: LengthUnit) => void;
  lock: boolean;
  onLock: (v: boolean) => void;
  /** Tryb względny (okno płótna): pola pokazują przyrost względem obecnego rozmiaru, a nie rozmiar docelowy. */
  relative?: boolean;
  onChange: (wPx: number, hPx: number) => void;
  testPrefix: string;
}

/**
 * Wspólne pola rozmiaru okien „Zmień rozmiar” i „Rozmiar płótna”: u góry dwa pola procentowe (szerokość, wysokość),
 * niżej te same wymiary w jednostce do wyboru (piksele, mm, cm, cale); blokada proporcji po prawej stronie pól.
 */
export const SizeFields: React.FC<Props> = ({ width, height, wPx, hPx, dpi, unit, onUnit, lock, onLock, relative, onChange, testPrefix }) => {
  const base = (axis: 'w' | 'h') => (axis === 'w' ? width : height);
  const cur = (axis: 'w' | 'h') => (axis === 'w' ? wPx : hPx);

  // wartość pola <-> piksele docelowe
  const pctToPx = (v: number, axis: 'w' | 'h') => (relative ? base(axis) + (v / 100) * base(axis) : (v / 100) * base(axis));
  const pxToPct = (px: number, axis: 'w' | 'h') => ((relative ? px - base(axis) : px) / base(axis)) * 100;
  const unitToPxField = (v: number, axis: 'w' | 'h') => (relative ? base(axis) + unitToPx(v, unit, dpi) : unitToPx(v, unit, dpi));
  const pxToUnitField = (px: number, axis: 'w' | 'h') => pxToUnit(relative ? px - base(axis) : px, unit, dpi);

  const apply = (axis: 'w' | 'h', px: number) => {
    const p = Math.max(1, Math.round(px));
    if (axis === 'w') onChange(p, lock ? Math.max(1, Math.round((p * height) / width)) : hPx);
    else onChange(lock ? Math.max(1, Math.round((p * width) / height)) : wPx, p);
  };

  const lab = 'block text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)] mb-1';
  const sign = (v: number) => (relative && v > 0 ? '+' : '');
  const field = (axis: 'w' | 'h', kind: 'pct' | 'unit') => {
    const isPct = kind === 'pct';
    const key = isPct ? '%' : unit;
    const toField = (px: number) => (isPct ? pxToPct(px, axis) : pxToUnitField(px, axis));
    const fromField = (v: number) => (isPct ? pctToPx(v, axis) : unitToPxField(v, axis));
    const lo = toField(1);
    const hi = toField(GraphicEngine.MAX_DOC_SIDE);
    return (
      <div>
        <label className={lab}>
          {axis === 'w' ? 'Szerokość' : 'Wysokość'} ({isPct ? '%' : UNIT_LABEL[unit]}):
        </label>
        <ScrubField
          key={`${axis}-${key}-${relative ? 'r' : 'a'}`}
          value={toField(cur(axis))}
          min={Math.min(lo, hi)}
          max={Math.max(lo, hi)}
          step={STEP[key]}
          wheelStep={isPct || unit === 'px' ? 1 : unit === 'in' ? 0.01 : 0.1}
          curve={2}
          format={(v) => sign(v) + fmtSizeValue(v, key)}
          width="100%"
          tall
          testId={`${testPrefix}-${axis === 'w' ? 'width' : 'height'}${isPct ? '-pct' : ''}`}
          onChange={(v) => apply(axis, fromField(v))}
        />
      </div>
    );
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
        {field('w', 'pct')}
        {field('h', 'pct')}
        <button
          type="button"
          data-testid={`${testPrefix}-lock`}
          title={lock ? 'Proporcje zablokowane (kliknij, aby odblokować)' : 'Zablokuj proporcje'}
          onClick={() => onLock(!lock)}
          className={`w-8 h-[30px] row-span-2 self-center flex items-center justify-center rounded border ${lock ? 'bg-[color:var(--h-094771,#094771)] border-[color:var(--h-007acc,#007acc)] text-white' : 'bg-[color:var(--h-2a2a2a,#2a2a2a)] border-[color:var(--h-444444,#444444)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)]'}`}
        >
          {lock ? <Link2 size={14} /> : <Link2Off size={14} />}
        </button>
        {field('w', 'unit')}
        {field('h', 'unit')}
      </div>
      <div className="flex rounded overflow-hidden border border-[color:var(--h-444444,#444444)]">
        {LENGTH_UNITS.map((u) => (
          <button
            key={u}
            type="button"
            data-testid={`${testPrefix}-unit-${u}`}
            onClick={() => onUnit(u)}
            className={`flex-1 py-1.5 ${unit === u ? 'bg-[color:var(--h-094771,#094771)] text-white' : 'bg-[color:var(--h-2a2a2a,#2a2a2a)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)]'}`}
          >
            {UNIT_NAME[u]}
          </button>
        ))}
      </div>
    </div>
  );
};
