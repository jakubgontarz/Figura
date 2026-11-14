import React, { useEffect, useRef, useState } from 'react';
import { Check, Save, Trash2, X } from 'lucide-react';
import { CorrectionType, cloneParams } from '../core/Corrections.ts';
import { CorrectionPreset, loadCorrectionPresets, sameParams, saveCorrectionPresets } from '../core/CorrectionPresets.ts';

const BTN =
  'w-6 h-6 shrink-0 flex items-center justify-center bg-[#282828] border border-[#3e3e3e] rounded transition-colors hover:bg-[#383838] text-[#ccc] hover:text-white cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-[#282828] disabled:hover:text-[#ccc]';

/**
 * Jeden wiersz: lista rozwijana z presetami użytkownika + przycisk zapisu (dyskietka) + przycisk usuwania (kosz).
 * Presety są zapamiętywane w przeglądarce osobno dla każdego typu korekcji lub filtru.
 *
 *  - wybór pozycji z listy stosuje preset,
 *  - dyskietka przy wybranym presecie zapisuje w nim bieżące ustawienia,
 *  - dyskietka bez wybranego presetu zamienia listę (w tym samym wierszu) na pole nazwy: Enter lub dyskietka zapisują, Esc anuluje,
 *  - kosz usuwa wybrany preset.
 */
export const CorrectionPresetsBar: React.FC<{
  type: CorrectionType;
  current: unknown;
  onApply: (params: any) => void;
}> = ({ type, current, onApply }) => {
  const [list, setList] = useState<CorrectionPreset[]>(() => loadCorrectionPresets(type));
  const [selectedId, setSelectedId] = useState<string>('');
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  const selected = list.find((p) => p.id === selectedId) ?? null;
  const modified = !!selected && !sameParams(selected.params, current);

  const commit = (next: CorrectionPreset[]) => {
    setList(next);
    saveCorrectionPresets(type, next);
  };

  const onSelect = (id: string) => {
    setSelectedId(id);
    const p = list.find((x) => x.id === id);
    if (p) onApply(cloneParams(p.params));
  };

  const finishNaming = () => {
    const n = name.trim();
    if (!n) {
      setNaming(false);
      return;
    }
    const params = cloneParams(current);
    const existing = list.find((p) => p.name.toLowerCase() === n.toLowerCase());
    let id: string;
    if (existing) {
      id = existing.id;
      commit(list.map((p) => (p.id === id ? { ...p, params } : p)));
    } else {
      id = `p-${Date.now().toString(36)}`;
      commit([...list, { id, name: n, params }]);
    }
    setSelectedId(id);
    setName('');
    setNaming(false);
  };

  const onSave = () => {
    if (naming) {
      finishNaming();
    } else if (selected) {
      commit(list.map((p) => (p.id === selected.id ? { ...p, params: cloneParams(current) } : p)));
    } else {
      setName('');
      setNaming(true);
    }
  };

  const onDelete = () => {
    if (naming) {
      setNaming(false);
      return;
    }
    if (!selected) return;
    commit(list.filter((p) => p.id !== selected.id));
    setSelectedId('');
  };

  return (
    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[#333] shrink-0">
      <span className="text-[11px] text-[#999] shrink-0">Preset:</span>
      {naming ? (
        <input
          ref={nameRef}
          data-preset-name=""
          type="text"
          value={name}
          placeholder="Nazwa nowego presetu"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              finishNaming();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setNaming(false);
            }
          }}
          className="flex-1 min-w-0 h-6 bg-[#111] border border-[#007acc] rounded px-1.5 text-[11px] text-white focus:outline-none"
        />
      ) : (
        <select
          value={selectedId}
          onChange={(e) => onSelect(e.target.value)}
          className="flex-1 min-w-0 h-6 bg-[#282828] border border-[#3e3e3e] rounded px-1 text-[11px] text-[#ddd] focus:outline-none focus:border-[#007acc] cursor-pointer"
          title="Presety użytkownika dla tego okna"
        >
          <option value="">{list.length ? '(wybierz preset)' : '(brak zapisanych presetów)'}</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.id === selectedId && modified ? ' *' : ''}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={onSave}
        className={BTN}
        title={naming ? 'Zapisz preset pod tą nazwą' : selected ? `Zapisz bieżące ustawienia w presecie „${selected.name}”` : 'Zapisz bieżące ustawienia jako nowy preset'}
      >
        {naming ? <Check size={13} /> : <Save size={13} />}
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={!naming && !selected}
        className={BTN}
        title={naming ? 'Anuluj' : selected ? `Usuń preset „${selected.name}”` : 'Usuń preset (najpierw wybierz go z listy)'}
      >
        {naming ? <X size={13} /> : <Trash2 size={13} />}
      </button>
    </div>
  );
};
