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
          ? 'bg-[#094771] border-[#007acc] text-white'
          : 'bg-[#282828] border-[#3e3e3e] text-[#ccc] hover:bg-[#383838] hover:text-white'
      }`}
    >
      {children}
    </button>
  );
  return divider ? <div className="flex-shrink-0 border-l border-[#444] pl-2.5">{btn}</div> : btn;
};
