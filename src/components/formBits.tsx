/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/** Wiersz formularza: podpis po lewej, kontrolka po prawej. */
export const FormRow: React.FC<{ label: string; hint?: string; children: React.ReactNode; testId?: string }> = ({ label, hint, children, testId }) => (
  <div className="flex items-center justify-between gap-3 min-h-[28px]" data-testid={testId}>
    <div className="min-w-0">
      <div className="text-[12px] text-[color:var(--h-cccccc,#cccccc)]">{label}</div>
      {hint && <div className="text-[10.5px] text-[color:var(--h-888888,#888888)] leading-snug">{hint}</div>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

/** Grupa przycisków wyboru jednej opcji. */
export function Seg<T extends string>({ value, options, onChange, testId, disabled }: { value: T; options: { id: T; label: string; disabled?: boolean; title?: string }[]; onChange: (v: T) => void; testId?: string; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded overflow-hidden border border-[color:var(--h-444444,#444444)]" data-testid={testId}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            title={o.title}
            disabled={disabled || o.disabled}
            aria-pressed={on}
            data-testid={testId ? `${testId}-${o.id}` : undefined}
            onClick={() => onChange(o.id)}
            className={`px-2.5 py-1 text-[11.5px] cursor-pointer disabled:opacity-40 disabled:cursor-default ${
              on ? 'bg-[color:var(--h-094771,#094771)] text-white' : 'bg-[color:var(--h-2d2d2d,#2d2d2d)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)]'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10px] uppercase tracking-wider text-[color:var(--h-777777,#777777)] pt-2 pb-0.5 border-b border-[color:var(--h-333333,#333333)]">{children}</div>
);

export const btnGhost = 'px-3 py-1.5 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)] cursor-pointer disabled:opacity-40';
export const btnPrimary = 'px-4 py-1.5 bg-[color:var(--h-007acc,#007acc)] hover:bg-[color:var(--h-006bb3,#006bb3)] rounded text-xs text-white cursor-pointer disabled:opacity-50';

/** Szachownica pod podglądem z przezroczystością. */
export const CHECKER_STYLE: React.CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage: 'linear-gradient(45deg,#cfcfcf 25%,transparent 25%,transparent 75%,#cfcfcf 75%),linear-gradient(45deg,#cfcfcf 25%,transparent 25%,transparent 75%,#cfcfcf 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0,6px 6px',
};
