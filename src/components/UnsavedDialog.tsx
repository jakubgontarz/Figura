/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { DialogWindow } from './DialogWindow.tsx';
import { btnGhost, btnPrimary } from './formBits.tsx';
import { dialogOwnsKey } from '../core/dialogStack.ts';

export type UnsavedAnswer = 'save' | 'discard' | 'cancel';

interface Props {
  /** Nazwy niezapisanych dokumentów (jedna = klasyczne pytanie o ten plik) */
  names: string[];
  /** Co użytkownik próbuje zrobić: do opisu i etykiet */
  action: 'close' | 'exit';
  onAnswer: (a: UnsavedAnswer) => void;
}

/** Standardowe pytanie „Zapisać zmiany?” (Zapisz / Nie zapisuj / Anuluj). */
export const UnsavedDialog: React.FC<Props> = ({ names, action, onAnswer }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'unsaved-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onAnswer('cancel');
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        onAnswer('save');
      } else if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        onAnswer('discard');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const many = names.length > 1;
  return (
    <DialogWindow title="Figura" width={440} modal testId="unsaved-dialog" onClose={() => onAnswer('cancel')} autoFocus="[data-default]">
      <div className="px-5 pt-3 pb-4 text-[13px] text-[color:var(--h-dddddd,#dddddd)]" data-testid="unsaved-text">
        {many ? (
          <>
            <div className="mb-1.5">Niezapisane zmiany w {names.length} dokumentach:</div>
            <ul className="list-disc pl-5 text-[12px] text-[color:var(--h-bbbbbb,#bbbbbb)] max-h-[140px] overflow-y-auto">
              {names.map((n, i) => (
                <li key={i} className="break-all">{n}</li>
              ))}
            </ul>
            <div className="mt-2">{action === 'exit' ? 'Czy zapisać zmiany przed zamknięciem programu?' : 'Czy zapisać zmiany przed zamknięciem?'}</div>
          </>
        ) : (
          <div>
            Czy zapisać zmiany w dokumencie <b className="break-all">„{names[0]}”</b> przed zamknięciem?
            <div className="text-[12px] text-[color:var(--h-999999,#999999)] mt-1.5">Jeśli nie zapiszesz, ostatnie zmiany zostaną utracone.</div>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 px-3 py-2.5 border-t border-[color:var(--h-333333,#333333)]">
        <button type="button" data-default onClick={() => onAnswer('save')} className={btnPrimary} data-testid="unsaved-save">
          {many ? 'Zapisz wszystkie' : 'Zapisz'}
        </button>
        <button type="button" onClick={() => onAnswer('discard')} className={btnGhost} data-testid="unsaved-discard">
          Nie zapisuj
        </button>
        <button type="button" onClick={() => onAnswer('cancel')} className={btnGhost} data-testid="unsaved-cancel">
          Anuluj
        </button>
      </div>
    </DialogWindow>
  );
};
