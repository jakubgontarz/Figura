/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';

export interface MenuActionHandlers {
  onNew: () => void;
  onOpen: () => void;
  onSaveFig: () => void;
  onExportPng: () => void;
  onExportJpg: () => void;
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
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
}

/** Pozycja menu rozwijanego: zwykła, z podmenu albo separator. */
export type MenuEntry =
  | { sep: true }
  | {
      label: string;
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
}

const ITEM = 'w-full text-left px-3 py-[2px] flex items-center justify-between gap-4';
const ITEM_ON = 'hover:bg-[#007acc] hover:text-white cursor-pointer';
const ITEM_OFF = 'opacity-40 cursor-default';

/** Lista pozycji menu; podmenu otwierają się z boku po najechaniu (położenie stałe, więc nie są przycinane przez menu). */
const MenuList: React.FC<{ entries: MenuEntry[]; onDone: () => void }> = ({ entries, onDone }) => (
  <>
    {entries.map((e, i) =>
      'sep' in e ? (
        <div key={i} className="h-[1px] bg-[#333333] my-1" />
      ) : e.submenu ? (
        <SubMenuItem key={i} entry={e} onDone={onDone} />
      ) : (
        <button
          key={i}
          type="button"
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
          {e.hint && <span className="text-[#888] text-[11px]">{e.hint}</span>}
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
        disabled={entry.disabled}
        onClick={open}
        className={`${ITEM} ${entry.disabled ? ITEM_OFF : pos ? 'bg-[#007acc] text-white cursor-pointer' : ITEM_ON}`}
      >
        <span>{entry.label}</span>
        <span className="text-[10px]">▶</span>
      </button>
      {pos && (
        <div
          className="fixed min-w-[230px] bg-[#1e1e1e] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[#cccccc] overflow-y-auto z-[60]"
          style={{ left: pos.left, top: pos.top, maxHeight: pos.maxHeight }}
        >
          <MenuList entries={items} onDone={onDone} />
        </div>
      )}
    </div>
  );
};

export const MenuBar: React.FC<MenuBarProps> = ({ handlers, layersMenu }) => {
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
      className="h-6 bg-[#252526] select-none flex items-center px-1 text-[12px] text-[#e0e0e0] border-b border-[#1b1b1b] relative z-50"
    >
      {/* Plik */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'plik' ? null : 'plik')}
          onMouseEnter={() => openMenu && setOpenMenu('plik')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[#383838] transition-colors cursor-pointer ${
            openMenu === 'plik' ? 'bg-[#383838] text-white' : ''
          }`}
        >
          Plik
        </button>
        {openMenu === 'plik' && (
          <div className="absolute left-0 top-full mt-0.5 min-w-[210px] bg-[#1e1e1e] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[#cccccc]">
            <button
              onClick={() => handleAction(handlers.onNew)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Nowy...</span>
              <span className="text-[#888] text-[11px]">Ctrl+N</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onOpen)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Otwórz (.fig, obrazy)...</span>
              <span className="text-[#888] text-[11px]">Ctrl+O</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onSaveFig)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between font-medium text-white cursor-pointer"
            >
              <span>Zapisz projekt (.fig)</span>
              <span className="text-[#888] text-[11px]">Ctrl+S</span>
            </button>
            <div className="h-[1px] bg-[#333333] my-1" />
            <button
              onClick={() => handleAction(handlers.onExportPng)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Eksportuj jako PNG</span>
              <span className="text-[#888] text-[10px]">PNG</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onExportJpg)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Eksportuj jako JPG</span>
              <span className="text-[#888] text-[10px]">JPG</span>
            </button>
          </div>
        )}
      </div>

      {/* Edycja */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'edycja' ? null : 'edycja')}
          onMouseEnter={() => openMenu && setOpenMenu('edycja')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[#383838] transition-colors cursor-pointer ${
            openMenu === 'edycja' ? 'bg-[#383838] text-white' : ''
          }`}
        >
          Edycja
        </button>
        {openMenu === 'edycja' && (
          <div className="absolute left-0 top-full mt-0.5 min-w-[200px] bg-[#1e1e1e] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[#cccccc]">
            <button
              onClick={() => handleAction(handlers.onUndo)}
              disabled={!handlers.canUndo}
              className={`w-full text-left px-3 py-1 flex justify-between cursor-pointer ${
                handlers.canUndo ? 'hover:bg-[#007acc] hover:text-white' : 'opacity-40 cursor-default'
              }`}
            >
              <span>Cofnij</span>
              <span className="text-[#888] text-[11px]">Ctrl+Z</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onRedo)}
              disabled={!handlers.canRedo}
              className={`w-full text-left px-3 py-1 flex justify-between cursor-pointer ${
                handlers.canRedo ? 'hover:bg-[#007acc] hover:text-white' : 'opacity-40 cursor-default'
              }`}
            >
              <span>Ponów</span>
              <span className="text-[#888] text-[11px]">Ctrl+Y</span>
            </button>
            <div className="h-[1px] bg-[#333333] my-1" />
            <button
              onClick={() => handleAction(handlers.onCut || (() => {}))}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Wytnij</span>
              <span className="text-[#888] text-[11px]">Ctrl+X</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onCopy || (() => {}))}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Kopiuj</span>
              <span className="text-[#888] text-[11px]">Ctrl+C</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onPaste || (() => {}))}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Wklej (Przejdź do modyfikacji)</span>
              <span className="text-[#888] text-[11px]">Ctrl+V</span>
            </button>
            <div className="h-[1px] bg-[#333333] my-1" />
            <button
              onClick={() => handleAction(handlers.onClearLayer)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Wyczyść</span>
              <span className="text-[#888] text-[11px]">Del</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onFillLayer)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white cursor-pointer"
            >
              Wypełnij kolorem pędzla
            </button>
            <div className="h-[1px] bg-[#333333] my-1" />
            <button
              onClick={() => handleAction(handlers.onTransformContent || (() => {}))}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Przekształć swobodnie (Piksele)</span>
              <span className="text-[#888] text-[11px]">Ctrl+T</span>
            </button>
          </div>
        )}
      </div>

      {/* Zaznacz (Selection Menu) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'zaznacz' ? null : 'zaznacz')}
          onMouseEnter={() => openMenu && setOpenMenu('zaznacz')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[#383838] transition-colors cursor-pointer ${
            openMenu === 'zaznacz' ? 'bg-[#383838] text-white' : ''
          }`}
        >
          Zaznacz
        </button>
        {openMenu === 'zaznacz' && (
          <div className="absolute left-0 top-full mt-0.5 min-w-[210px] bg-[#1e1e1e] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[#cccccc]">
            <button
              onClick={() => handleAction(handlers.onSelectAll)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Zaznacz wszystko</span>
              <span className="text-[#888] text-[11px]">Ctrl+A</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onDeselect)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Odznacz</span>
              <span className="text-[#888] text-[11px]">Ctrl+D</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onInvertSelection)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Odwróć zaznaczenie</span>
              <span className="text-[#888] text-[11px]">Ctrl+I</span>
            </button>
            <div className="h-[1px] bg-[#333333] my-1" />
            <button
              onClick={() => handleAction(handlers.onTransformSelection || (() => {}))}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Przekształć zaznaczenie</span>
              <span className="text-[#888] text-[11px]">T</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onTransformContent || (() => {}))}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Przekształć zawartość zaznaczenia</span>
              <span className="text-[#888] text-[11px]">Ctrl+T</span>
            </button>
          </div>
        )}
      </div>

      {/* Widok */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'widok' ? null : 'widok')}
          onMouseEnter={() => openMenu && setOpenMenu('widok')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[#383838] transition-colors cursor-pointer ${
            openMenu === 'widok' ? 'bg-[#383838] text-white' : ''
          }`}
        >
          Widok
        </button>
        {openMenu === 'widok' && (
          <div className="absolute left-0 top-full mt-0.5 min-w-[220px] bg-[#1e1e1e] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[#cccccc]">
            <button
              onClick={() => handleAction(handlers.onZoomIn)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Powiększ</span>
              <span className="text-[#888] text-[11px]">Kółko myszy w górę</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onZoomOut)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Pomniejsz</span>
              <span className="text-[#888] text-[11px]">Kółko myszy w dół</span>
            </button>
            <button
              onClick={() => handleAction(handlers.onZoomReset)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white flex justify-between cursor-pointer"
            >
              <span>Rozmiar rzeczywisty (100%)</span>
              <span className="text-[#888] text-[11px]">Ctrl+0</span>
            </button>
          </div>
        )}
      </div>

      {/* Obraz */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'obraz' ? null : 'obraz')}
          onMouseEnter={() => openMenu && setOpenMenu('obraz')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[#383838] transition-colors cursor-pointer ${
            openMenu === 'obraz' ? 'bg-[#383838] text-white' : ''
          }`}
        >
          Obraz
        </button>
        {openMenu === 'obraz' && (
          <div className="absolute left-0 top-full mt-0.5 min-w-[200px] bg-[#1e1e1e] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[#cccccc]">
            <button
              onClick={() => handleAction(handlers.onFlipHorizontal)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white cursor-pointer"
            >
              Odbij w poziomie
            </button>
            <button
              onClick={() => handleAction(handlers.onFlipVertical)}
              className="w-full text-left px-3 py-1 hover:bg-[#007acc] hover:text-white cursor-pointer"
            >
              Odbij w pionie
            </button>
          </div>
        )}
      </div>

      {/* Warstwy */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === 'warstwy' ? null : 'warstwy')}
          onMouseEnter={() => openMenu && setOpenMenu('warstwy')}
          className={`px-2.5 py-0.5 rounded-sm hover:bg-[#383838] transition-colors cursor-pointer ${
            openMenu === 'warstwy' ? 'bg-[#383838] text-white' : ''
          }`}
        >
          Warstwy
        </button>
        {openMenu === 'warstwy' && (
          <div
            data-testid="layers-menu"
            className="absolute left-0 top-full mt-0.5 min-w-[270px] bg-[#1e1e1e] border border-[#3f3f46] shadow-xl py-1 text-[12px] text-[#cccccc] overflow-y-auto"
            style={{ maxHeight: 'calc(100vh - 64px)' }}
          >
            <MenuList entries={layersMenu ?? []} onDone={() => setOpenMenu(null)} />
          </div>
        )}
      </div>
    </div>
  );
};
