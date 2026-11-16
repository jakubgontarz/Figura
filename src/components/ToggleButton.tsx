/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * Przycisk-przełącznik z podpisem (zastępuje pole wyboru): wciśnięty = opcja włączona.
 * Styl zgodny z pozostałymi przyciskami programu (zaokrąglona ramka, wciśnięty w kolorze akcentu).
 */
export const ToggleButton: React.FC<{
  active: boolean;
  onChange: (next: boolean) => void;
  children: React.ReactNode;
  title?: string;
  /** Pionowa kreska z lewej, oddzielająca przełącznik od poprzednich opcji. */
  divider?: boolean;
  testId?: string;
  /** Pozycja grupy wyboru jednego z kilku (np. Pionowa / Pozioma): kliknięcie zawsze włącza, a nie przełącza. */
  radio?: boolean;
}> = ({ active, onChange, children, title, divider, testId, radio }) => {
  const btn = (
    <button
      type="button"
      role={radio ? 'radio' : 'switch'}
      aria-checked={active}
      data-testid={testId}
      title={title}
      // bez przejmowania fokusu, żeby np. edytor tekstu na płótnie zachował kursor
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(radio ? true : !active)}
      className={`h-5 px-2 flex items-center gap-1 rounded border text-[11px] whitespace-nowrap cursor-pointer flex-shrink-0 transition-colors ${
        active
          ? 'bg-[color:var(--h-094771,#094771)] border-[color:var(--h-007acc,#007acc)] text-white'
          : 'bg-[color:var(--h-282828,#282828)] border-[color:var(--h-3e3e3e,#3e3e3e)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] hover:text-[color:var(--t-white,#fff)]'
      }`}
    >
      {children}
    </button>
  );
  return divider ? <div className="flex-shrink-0 border-l border-[color:var(--h-444444,#444444)] pl-2.5">{btn}</div> : btn;
};
