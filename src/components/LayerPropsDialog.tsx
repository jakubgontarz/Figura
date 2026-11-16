import { dialogOwnsKey } from '../core/dialogStack.ts';
import React, { useEffect, useRef, useState } from 'react';
import { ScrubField } from './ScrubField.tsx';
import { BLEND_MODES, SKBlendMode } from '../core/types.ts';
import { DialogWindow } from './DialogWindow.tsx';

interface Props {
  kind: 'blend' | 'opacity';
  layerName: string;
  isGroup: boolean;
  initialBlend: SKBlendMode;
  /** 0..1 */
  initialOpacity: number;
  /** Podgląd na żywo (bez wpisu w historii) */
  onPreviewBlend: (mode: SKBlendMode) => void;
  onPreviewOpacity: (opacity: number) => void;
  /** Zatwierdzenie: wartość końcowa; silnik zapisuje jedną zmianę w historii */
  onOk: (value: SKBlendMode | number) => void;
  /** Anulowanie: wywołujący przywraca wartość sprzed otwarcia okna */
  onCancel: () => void;
}

/** Małe okno z menu Warstwy: tryb mieszania (lista) albo przezroczystość (suwak). Zmiany widać od razu na płótnie. */
export const LayerPropsDialog: React.FC<Props> = ({ kind, layerName, isGroup, initialBlend, initialOpacity, onPreviewBlend, onPreviewOpacity, onOk, onCancel }) => {
  const [blend, setBlend] = useState<SKBlendMode>(initialBlend);
  const [pct, setPct] = useState(Math.round(initialOpacity * 100));
  const latest = useRef({ blend, pct, onOk, onCancel });
  latest.current = { blend, pct, onOk, onCancel };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'layer-props-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        latest.current.onCancel();
      } else if (e.key === 'Enter') {
        const inField = e.target instanceof HTMLInputElement && e.target.type === 'text';
        const done = () => latest.current.onOk(kind === 'blend' ? latest.current.blend : latest.current.pct / 100);
        if (inField) {
          // pole najpierw zatwierdza wpisaną wartość (własna obsługa Enter), dopiero potem zamykamy okno
          setTimeout(done, 0);
        } else {
          e.preventDefault();
          e.stopPropagation();
          done();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [kind]);

  const GROUPS: { title: string; ids: SKBlendMode[] }[] = [
    ...(isGroup ? [{ title: 'Grupa', ids: ['PassThrough' as SKBlendMode] }] : []),
    { title: 'Zwykłe', ids: ['SrcOver'] },
    { title: 'Przyciemnianie', ids: ['Darken', 'Multiply', 'ColorBurn'] },
    { title: 'Rozjaśnianie', ids: ['Lighten', 'Screen', 'ColorDodge'] },
    { title: 'Kontrast', ids: ['Overlay', 'SoftLight', 'HardLight'] },
    { title: 'Różnicowe', ids: ['Difference', 'Exclusion'] },
  ];
  const nameOf = (id: SKBlendMode) => (id === 'PassThrough' ? 'Przepuszczanie' : BLEND_MODES.find((m) => m.id === id)?.namePl ?? id);
  const order = GROUPS.flatMap((g) => g.ids);
  const pick = (m: SKBlendMode) => {
    setBlend(m);
    onPreviewBlend(m);
  };
  const OPACITY_PRESETS = [0, 25, 50, 75, 100];

  return (
    <DialogWindow
      width={300}
      modal
      testId="layer-props-dialog"
      autoFocus={kind === 'blend' ? '[role=listbox]' : 'input'}
      onClose={onCancel}
      title={
        <>
          {kind === 'blend' ? 'Tryb mieszania' : 'Przezroczystość'}
          <span className="font-normal text-[color:var(--h-999999,#999999)]"> · {layerName}</span>
        </>
      }
    >
      <div className="px-3 pt-3 pb-2">
        {kind === 'blend' ? (
          <div
            role="listbox"
            tabIndex={0}
            data-testid="blend-list"
            aria-activedescendant={`blend-${blend}`}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              const i = order.indexOf(blend);
              const n = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
              if (n !== blend) pick(n);
              document.getElementById(`blend-${n}`)?.scrollIntoView({ block: 'nearest' });
            }}
            className="max-h-[min(440px,62vh)] overflow-y-auto rounded border border-[color:var(--h-3a3a3a,#3a3a3a)] bg-[color:var(--h-181818,#181818)] py-1 focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]"
          >
            {GROUPS.map((g, gi) => (
              <div key={g.title} className={gi > 0 ? 'mt-1 pt-1 border-t border-[color:var(--h-2a2a2a,#2a2a2a)]' : ''}>
                <div className="px-3 pt-0.5 pb-0.5 text-[9.5px] uppercase tracking-wider text-[color:var(--h-777777,#777777)]">{g.title}</div>
                {g.ids.map((id) => {
                  const on = id === blend;
                  return (
                    <div
                      key={id}
                      id={`blend-${id}`}
                      role="option"
                      aria-selected={on}
                      data-testid={`blend-opt-${id}`}
                      onClick={() => pick(id)}
                      onDoubleClick={() => onOk(id)}
                      className={`mx-1 px-2.5 py-1 rounded text-[12px] cursor-pointer flex items-center justify-between ${
                        on ? 'bg-[color:var(--h-094771,#094771)] text-white' : 'text-[color:var(--h-d4d4d4,#d4d4d4)] hover:bg-[color:var(--h-2a2d2e,#2a2d2e)]'
                      }`}
                    >
                      {nameOf(id)}
                      {on && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-[color:var(--h-aaaaaa,#aaaaaa)]">Krycie warstwy</span>
              <span className="text-[11px] text-[color:var(--h-777777,#777777)]">0 = niewidoczna, 100% = pełna</span>
            </div>
            <ScrubField
              value={pct}
              min={0}
              max={100}
              suffix="%"
              tall
              width="100%"
              testId="opacity-field"
              onChange={(v) => {
                setPct(v);
                onPreviewOpacity(v / 100);
              }}
            />
            <div className="flex gap-1.5">
              {OPACITY_PRESETS.map((v) => (
                <button
                  key={v}
                  type="button"
                  data-testid={`opacity-preset-${v}`}
                  onClick={() => {
                    setPct(v);
                    onPreviewOpacity(v / 100);
                  }}
                  className={`flex-1 py-1 rounded text-[11px] cursor-pointer ${
                    pct === v ? 'bg-[color:var(--h-094771,#094771)] text-white' : 'bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] text-[color:var(--h-cccccc,#cccccc)]'
                  }`}
                >
                  {v}%
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 px-3 py-2.5 border-t border-[color:var(--h-333333,#333333)]">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)] cursor-pointer">
          Anuluj
        </button>
        <button
          type="button"
          onClick={() => onOk(kind === 'blend' ? blend : pct / 100)}
          className="px-4 py-1.5 bg-[color:var(--h-007acc,#007acc)] hover:bg-[color:var(--h-006bb3,#006bb3)] rounded text-xs text-white cursor-pointer"
          data-testid="layer-props-ok"
        >
          OK
        </button>
      </div>
    </DialogWindow>
  );
};
