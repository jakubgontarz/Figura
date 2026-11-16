/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { dialogStack, useDialogLayer } from '../core/dialogStack.ts';
import { X } from 'lucide-react';

interface DialogWindowProps {
  /** Tytuł na pasku (może zawierać ikonę i dopisek, np. nazwę warstwy). */
  title: React.ReactNode;
  onClose: () => void;
  /** Szerokość okna (px). */
  width: number;
  /** Położenie startowe (lewy górny róg); domyślnie okno jest wyśrodkowane. */
  initialPos?: () => { x: number; y: number };
  /** Okno modalne: tło przyciemnia i blokuje resztę programu (okno nadal można przesuwać). */
  modal?: boolean;
  testId?: string;
  /** Selektor elementu, który dostaje fokus po otwarciu (np. 'input'). */
  autoFocus?: string;
  /** Wysokość całej treści (np. okno ze stałą wysokością, jak stylizacje). */
  children: React.ReactNode;
}

/**
 * Wspólna powłoka wszystkich okien dialogowych (korekcje, filtry, stylizacje, „Nowy”, „Zmień rozmiar” itd.): jedno
 * okno `fixed`, jeden pasek tytułu (przeciąganie za pasek, ograniczone do ekranu), ten sam wygląd i obsługa klawiszy
 * (klawisze w oknie nie uruchamiają skrótów programu). Escape / Enter obsługuje zawartość okna.
 */
export const DialogWindow: React.FC<DialogWindowProps> = ({ title, onClose, width, initialPos, modal, testId, autoFocus, children }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => (initialPos ? initialPos() : null));
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  // identyfikator w stosie okien: testId, a gdy go brak, unikalny numer
  const fallbackId = useRef('dlg-' + Math.random().toString(36).slice(2));
  const id = testId ?? fallbackId.current;
  useLayoutEffect(() => {
    dialogStack.open(id);
    return () => dialogStack.close(id);
  }, [id]);
  const layer = Math.max(0, useDialogLayer(id));
  const z = 60 + layer * 2;

  // domyślnie: środek ekranu (po zmierzeniu okna, przed pierwszym narysowaniem)
  useLayoutEffect(() => {
    if (pos || !boxRef.current) return;
    const r = boxRef.current.getBoundingClientRect();
    setPos({ x: Math.max(0, (window.innerWidth - r.width) / 2), y: Math.max(8, (window.innerHeight - r.height) / 2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (autoFocus) boxRef.current?.querySelector<HTMLElement>(autoFocus)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onTitleDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button') || !pos) return;
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onTitleMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - 80, e.clientX - d.dx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, e.clientY - d.dy)),
    });
  };
  const onTitleUp = () => {
    drag.current = null;
  };

  return (
    <>
      {modal && <div className="fixed inset-0 bg-black/40" style={{ zIndex: z - 1 }} />}
      <div
        ref={boxRef}
        role="dialog"
        data-testid={testId}
        className="fixed bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[color:var(--h-3a3a3a,#3a3a3a)] rounded-md shadow-2xl text-xs text-[color:var(--h-dddddd,#dddddd)] select-none flex flex-col"
        style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, width, maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100vh - 24px)', zIndex: z, visibility: pos ? 'visible' : 'hidden' }}
        onKeyDown={(e) => e.stopPropagation()}
        onPointerDownCapture={() => dialogStack.raise(id)}
        onFocusCapture={() => dialogStack.raise(id)}
      >
        <div
          data-testid={testId ? `${testId}-title` : undefined}
          className="flex items-center justify-between pl-2.5 pr-0 h-7 bg-[color:var(--h-2a2a2b,#2a2a2b)] border-b border-[color:var(--h-3a3a3a,#3a3a3a)] rounded-t-md cursor-move shrink-0"
          onPointerDown={onTitleDown}
          onPointerMove={onTitleMove}
          onPointerUp={onTitleUp}
          onPointerCancel={onTitleUp}
        >
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[color:var(--t-white,#fff)] truncate">{title}</span>
          <button
            type="button"
            onClick={onClose}
            title="Zamknij (Esc)"
            aria-label="Zamknij"
            data-testid={testId ? `${testId}-close` : undefined}
            className="h-full px-3 -mr-px flex items-center justify-center rounded-tr-md text-[color:var(--h-999999,#999999)] hover:bg-[#e81123] hover:text-white transition-colors cursor-pointer"
          >
            <X size={12} />
          </button>
        </div>
        {children}
      </div>
    </>
  );
};
