import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ScrubField } from './ScrubField.tsx';
import { BLEND_MODES, SKBlendMode } from '../core/types.ts';

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
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    boxRef.current?.querySelector<HTMLElement>('select, input')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

  const modes: { id: SKBlendMode; name: string }[] = [
    ...(isGroup ? [{ id: 'PassThrough' as SKBlendMode, name: 'Przepuszczanie' }] : []),
    ...BLEND_MODES.map((m) => ({ id: m.id, name: m.namePl })),
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 select-none" data-testid="layer-props-dialog">
      <div ref={boxRef} className="bg-[#1e1e1e] border border-[#3f3f46] rounded-lg shadow-2xl w-[300px] flex flex-col text-xs text-[#dddddd]">
        <div className="flex items-center justify-between px-3 py-2 bg-[#252526] border-b border-[#333] rounded-t-lg">
          <span className="font-semibold text-[13px] text-white truncate">
            {kind === 'blend' ? 'Tryb mieszania' : 'Przezroczystość'}
            <span className="font-normal text-[#999]"> · {layerName}</span>
          </span>
          <button type="button" onClick={onCancel} title="Anuluj (Esc)" className="p-0.5 rounded text-[#bbb] hover:bg-[#4a2a2a] hover:text-white cursor-pointer">
            <X size={13} />
          </button>
        </div>
        <div className="p-3">
          {kind === 'blend' ? (
            <select
              size={Math.min(modes.length, 13)}
              value={blend}
              onChange={(e) => {
                const m = e.target.value as SKBlendMode;
                setBlend(m);
                onPreviewBlend(m);
              }}
              className="w-full bg-[#121212] border border-[#444] rounded px-1 py-1 text-[12px] text-white focus:outline-none focus:border-[#007acc]"
              data-testid="blend-list"
            >
              {modes.map((m) => (
                <option key={m.id} value={m.id} className="py-0.5">
                  {m.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-[#aaa] shrink-0">Krycie:</span>
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
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-3 pb-3">
          <button
            type="button"
            onClick={() => onOk(kind === 'blend' ? blend : pct / 100)}
            className="px-4 py-1 rounded bg-[#007acc] hover:bg-[#0a8ae0] text-white cursor-pointer"
            data-testid="layer-props-ok"
          >
            OK
          </button>
          <button type="button" onClick={onCancel} className="px-4 py-1 rounded bg-[#333] hover:bg-[#444] text-[#ddd] cursor-pointer">
            Anuluj
          </button>
        </div>
      </div>
    </div>
  );
};
