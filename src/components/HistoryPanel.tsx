/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';

interface HistoryPanelProps {
  /** Nazwy kroków: najstarszy pierwszy, na końcu kroki do ponowienia */
  labels: string[];
  /** Liczba wykonanych kroków (0 = początek historii) */
  current: number;
  onGoTo: (index: number) => void;
}

/** Zakładka „Historia”: lista kroków cofania i ponawiania; kliknięcie kroku przenosi dokument do tego punktu. */
export const HistoryPanel: React.FC<HistoryPanelProps> = ({ labels, current, onGoTo }) => {
  const curRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    curRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current, labels.length]);

  const row = (index: number, text: string) => {
    const isCurrent = index === current;
    const undone = index > current;
    return (
      <button
        key={index}
        ref={isCurrent ? curRef : undefined}
        type="button"
        data-testid={`history-item-${index}`}
        onClick={() => !isCurrent && onGoTo(index)}
        title={undone ? 'Krok cofnięty: kliknij, aby do niego przejść' : isCurrent ? 'Bieżący stan' : 'Kliknij, aby wrócić do tego kroku'}
        className={`w-full text-left px-2 py-1 text-[11px] border-b border-[color:var(--h-262626,#262626)] cursor-pointer truncate ${
          isCurrent ? 'bg-[color:var(--h-094771,#094771)] text-white' : undone ? 'text-[color:var(--h-777777,#777777)] italic hover:bg-[color:var(--h-262626,#262626)]' : 'text-[color:var(--h-dddddd,#dddddd)] hover:bg-[color:var(--h-2a2a2a,#2a2a2a)]'
        }`}
      >
        {text}
      </button>
    );
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-[color:var(--h-181818,#181818)] border border-[color:var(--h-2a2a2a,#2a2a2a)] rounded" data-testid="history-panel">
      {row(0, 'Początek historii')}
      {labels.map((l, i) => row(i + 1, l))}
    </div>
  );
};
