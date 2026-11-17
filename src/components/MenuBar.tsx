/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';

export interface MenuActionHandlers {
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onClearLayer: () => void;
  onFillLayer: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onSelectAll: () => void;
  onDeselect: () => void;
  onInvertSelection: () => void;
  onTransformSelection?: () => void;
  onTransformContent?: () => void;
  onOpenSettings?: () => void;
}

/** Pozycja menu rozwijanego: zwykła, z podmenu albo separator. */
export type MenuEntry =
  | { sep: true }
  | {
      label: string;
      testId?: string;
      onClick?: () => void;
      disabled?: boolean;
      /** Skrót klawiszowy albo krótka wskazówka po prawej stronie */
      hint?: string;
      /** Pozycja przełącznika: zaznaczona (✓) albo nie; undefined = zwykła pozycja */
      checked?: boolean;
      /** Menu zostaje otwarte po kliknięciu (np. przełącznik w podmenu) */
      keepOpen?: boolean;
      submenu?: MenuEntry[];
    };

interface MenuBarProps {
  handlers: MenuActionHandlers;
  /** Zawartość menu „Warstwy” (budowana na podstawie stanu aktywnej warstwy) */
  layersMenu?: MenuEntry[];
  /** Zawartość menu „Plik” */
  fileMenu?: MenuEntry[];
  /** Zawartość menu „Edycja” */
  editMenu?: MenuEntry[];
  /** Zawartość menu „Obraz” */
  imageMenu?: MenuEntry[];
  /** Zawartość menu „Widok” */
  viewMenu?: MenuEntry[];
  /** Zawartość menu „Zaznacz” */
  selectionMenu?: MenuEntry[];
}

const ITEM = 'w-full text-left px-3 py-[2px] flex items-center justify-between gap-4';
const ITEM_ON = 'hover:bg-[color:var(--h-007acc,#007acc)] hover:text-white cursor-pointer';
const ITEM_OFF = 'opacity-40 cursor-default';

/** Lista pozycji menu; podmenu otwierają się z boku po najechaniu (położenie stałe, więc nie są przycinane przez menu). */
const MenuList: React.FC<{ entries: MenuEntry[]; onDone: () => void }> = ({ entries, onDone }) => (
  <>
    {entries.map((e, i) =>
      'sep' in e ? (
        <div key={i} className="h-[1px] bg-[color:var(--h-333333,#333333)] my-1" />
      ) : e.submenu ? (
        <SubMenuItem key={i} entry={e} onDone={onDone} />
      ) : (
        <button
          key={i}
          type="button"
          data-testid={e.testId}
          disabled={e.disabled}
          onClick={() => {
            if (e.disabled) return;
            e.onClick?.();
            if (!e.keepOpen) onDone();
          }}
          className={`${ITEM} ${e.disabled ? ITEM_OFF : ITEM_ON}`}
        >
          <span className="flex items-center gap-1.5">
            {e.checked !== undefined && <span className="w-3 text-center">{e.checked ? '✓' : ''}</span>}
            {e.label}
          </span>
          {e.hint && <span className="text-[color:var(--h-888888,#888888)] text-[11px]">{e.hint}</span>}
        </button>
      )
    )}
  </>
);

const SubMenuItem: React.FC<{ entry: Extract<MenuEntry, { label: string }>; onDone: () => void }> = ({ entry, onDone }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const items = entry.submenu ?? [];
  const open = () => {
    if (entry.disabled || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const want = Math.min(window.innerHeight - 16, items.length * 22 + 12);
    const top = Math.max(8, Math.min(r.top - 4, window.innerHeight - 8 - want));
    const width = 230;
    const left = r.right + width > window.innerWidth ? Math.max(0, r.left - width) : r.right - 1;
    setPos({ left, top, maxHeight: window.innerHeight - top - 8 });
  };
  return (
    <div ref={ref} onMouseEnter={open} onMouseLeave={() => setPos(null)} className="relative">
      <button
        type="button"
        data-testid={entry.testId}
        disabled={entry.disabled}
        onClick={open}
        className={`${ITEM} ${entry.disabled ? ITEM_OFF : pos ? 'bg-[color:var(--h-007acc,#007acc)] text-white cursor-pointer' : ITEM_ON}`}
      >
        <span>{entry.label}</span>
        <span className="text-[10px]">▶</span>
      </button>
      {pos && (
        <div
          className="fixed min-w-[230px] bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[color:var(--h-cccccc,#cccccc)] overflow-y-auto z-[60]"
          style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
        >
          <MenuList entries={items} onDone={onDone} />
        </div>
      )}
    </div>
  );
};

export const MenuBar: React.FC<MenuBarProps> = ({ handlers, fileMenu, editMenu, layersMenu, imageMenu, viewMenu, selectionMenu }) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleAction = (action: () => void) => {
    action();
    setOpenMenu(null);
  };

  return (
    <div
      ref={menuRef}
      className="h-6 bg-[color:var(--h-252526,#252526)] select-none flex items-center px-1 text-[12px] text-[color:var(--h-e0e0e0,#e0e0e0)] border-b border-[color:var(--h-1b1b1b,#1b1b1b)] relative z-50"
    >
      {/* Plik */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'plik' ? null : 'plik')}
          onMouseEnter={() => openMenu && setOpenMenu('plik')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[color:var(--h-383838,#383838)] transition-colors cursor-pointer ${
            openMenu === 'plik' ? 'bg-[color:var(--h-383838,#383838)] text-[color:var(--t-white,#fff)]' : ''
          }`}
        >
          Plik
        </button>
        {openMenu === 'plik' && (
          <div data-testid="file-menu" className="absolute left-0 top-full mt-0.5 min-w-[260px] bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[color:var(--h-cccccc,#cccccc)]">
            <MenuList entries={fileMenu ?? []} onDone={() => setOpenMenu(null)} />
          </div>
        )}
      </div>

      {/* Edycja */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'edycja' ? null : 'edycja')}
          onMouseEnter={() => openMenu && setOpenMenu('edycja')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[color:var(--h-383838,#383838)] transition-colors cursor-pointer ${
            openMenu === 'edycja' ? 'bg-[color:var(--h-383838,#383838)] text-[color:var(--t-white,#fff)]' : ''
          }`}
        >
          Edycja
        </button>
        {openMenu === 'edycja' && (
          <div data-testid="edit-menu" className="absolute left-0 top-full mt-0.5 min-w-[260px] bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[color:var(--h-cccccc,#cccccc)]">
            <MenuList entries={editMenu ?? []} onDone={() => setOpenMenu(null)} />
          </div>
        )}
      </div>

      {/* Zaznacz (Selection Menu) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'zaznacz' ? null : 'zaznacz')}
          onMouseEnter={() => openMenu && setOpenMenu('zaznacz')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[color:var(--h-383838,#383838)] transition-colors cursor-pointer ${
            openMenu === 'zaznacz' ? 'bg-[color:var(--h-383838,#383838)] text-[color:var(--t-white,#fff)]' : ''
          }`}
        >
          Zaznacz
        </button>
        {openMenu === 'zaznacz' && (
          <div
            data-testid="selection-menu"
            className="absolute left-0 top-full mt-0.5 min-w-[250px] bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[color:var(--h-cccccc,#cccccc)]"
          >
            <MenuList entries={selectionMenu ?? []} onDone={() => setOpenMenu(null)} />
          </div>
        )}
      </div>

      {/* Widok */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'widok' ? null : 'widok')}
          onMouseEnter={() => openMenu && setOpenMenu('widok')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[color:var(--h-383838,#383838)] transition-colors cursor-pointer ${
            openMenu === 'widok' ? 'bg-[color:var(--h-383838,#383838)] text-[color:var(--t-white,#fff)]' : ''
          }`}
        >
          Widok
        </button>
        {openMenu === 'widok' && (
          <div
            data-testid="view-menu"
            className="absolute left-0 top-full mt-0.5 min-w-[240px] bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[color:var(--h-cccccc,#cccccc)]"
          >
            <MenuList entries={viewMenu ?? []} onDone={() => setOpenMenu(null)} />
          </div>
        )}
      </div>

      {/* Obraz */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'obraz' ? null : 'obraz')}
          onMouseEnter={() => openMenu && setOpenMenu('obraz')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[color:var(--h-383838,#383838)] transition-colors cursor-pointer ${
            openMenu === 'obraz' ? 'bg-[color:var(--h-383838,#383838)] text-[color:var(--t-white,#fff)]' : ''
          }`}
        >
          Obraz
        </button>
        {openMenu === 'obraz' && (
          <div
            data-testid="image-menu"
            className="absolute left-0 top-full mt-0.5 min-w-[240px] bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[color:var(--h-cccccc,#cccccc)] overflow-y-auto"
            style={{ maxHeight: 'calc(100vh - 64px)' }}
          >
            <MenuList entries={imageMenu ?? []} onDone={() => setOpenMenu(null)} />
          </div>
        )}
      </div>

      {/* Warstwy */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'warstwy' ? null : 'warstwy')}
          onMouseEnter={() => openMenu && setOpenMenu('warstwy')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[color:var(--h-383838,#383838)] transition-colors cursor-pointer ${
            openMenu === 'warstwy' ? 'bg-[color:var(--h-383838,#383838)] text-[color:var(--t-white,#fff)]' : ''
          }`}
        >
          Warstwy
        </button>
        {openMenu === 'warstwy' && (
          <div
            data-testid="layers-menu"
            className="absolute left-0 top-full mt-0.5 min-w-[270px] bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[color:var(--h-cccccc,#cccccc)] overflow-y-auto"
            style={{ maxHeight: 'calc(100vh - 64px)' }}
          >
            <MenuList entries={layersMenu ?? []} onDone={() => setOpenMenu(null)} />
          </div>
        )}
      </div>
    </div>
  );
};
