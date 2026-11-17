/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Minus, Square, Copy, X, Plus } from 'lucide-react';
import { appWindow } from '../platform/index.ts';

interface TabItem {
  id: string;
  title: string;
  /** Zakładka obiektu inteligentnego: kolor wyróżniający i opis. */
  accent?: string;
  hint?: string;
  /** Dokument ma niezapisane zmiany */
  dirty?: boolean;
}

interface TitleBarProps {
  tabs: TabItem[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  /** Przycisk „Zamknij” okna w aplikacji natywnej: zamyka program (z pytaniem o zapis) */
  onCloseWindow?: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onCloseWindow,
}) => {
  const native = appWindow.isNative();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => void appWindow.isMaximized().then((m) => alive && setMaximized(m));
    refresh();
    const un = appWindow.onResized(refresh);
    return () => {
      alive = false;
      un();
    };
  }, []);
  return (
    <div data-tauri-drag-region data-testid="title-bar" className="h-8 bg-[color:var(--h-1e1e1e,#1e1e1e)] select-none flex items-center justify-between border-b border-[color:var(--h-111111,#111111)] pl-2 pr-0 text-xs">
      <div className="flex items-center gap-2 overflow-x-auto h-full scrollbar-none min-w-0">
        {/* Ikona programu */}
        <div className="flex items-center px-1.5 py-0.5 mr-1 shrink-0" title="Figura">
          <img src={`${import.meta.env.BASE_URL}figuraIcon64.png`} alt="Figura" data-testid="app-icon" width={20} height={20} draggable={false} className="w-5 h-5 select-none" />
        </div>

        {/* Zakładki otwartych dokumentów */}
        <div className="flex items-center gap-1 h-full pt-1">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                title={tab.hint}
                style={tab.accent ? { borderTopColor: tab.accent, backgroundColor: isActive ? '#3a2f1c' : '#25201a', color: isActive ? '#fff' : '#d9c08a' } : undefined}
                className={`group flex items-center gap-2 px-3 py-1 text-[11px] font-medium rounded-t cursor-pointer border-t-2 transition-colors ${
                  isActive
                    ? 'bg-[color:var(--h-2b2b2b,#2b2b2b)] text-[color:var(--t-white,#fff)] border-[#0078d7]'
                    : 'bg-[color:var(--h-181818,#181818)] text-[color:var(--h-a0a0a0,#a0a0a0)] hover:text-[color:var(--t-white,#fff)] hover:bg-[color:var(--h-222222,#222222)] border-transparent'
                }`}
              >
                <span className="truncate max-w-[130px]" data-testid="tab-title">{tab.title}</span>
                {tab.dirty && <span data-testid="tab-dirty" title="Niezapisane zmiany" className="w-1.5 h-1.5 rounded-full bg-[color:var(--h-e5c07b,#e5c07b)] shrink-0" />}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 hover:bg-[color:var(--h-444444,#444444)] rounded p-0.5 text-[color:var(--h-aaaaaa,#aaaaaa)] hover:text-[color:var(--t-white,#fff)]"
                  title="Zamknij dokument"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}

          <button
            type="button"
            onClick={onNewTab}
            className="h-6 w-6 flex items-center justify-center text-[color:var(--h-888888,#888888)] hover:text-[color:var(--t-white,#fff)] hover:bg-[color:var(--h-333333,#333333)] rounded transition-colors"
            title="Nowy dokument"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* Wolne miejsce na pasku: uchwyt do przeciągania okna (Tauri) */}
      <div data-tauri-drag-region className="flex-1 h-full min-w-[24px]" />

      {/* Kontrolki okna */}
      <div className="flex items-center text-[color:var(--h-999999,#999999)] h-full">
        <button
          type="button"
          onClick={() => appWindow.minimize()}
          data-testid="win-min"
          className="h-full px-3 flex items-center justify-center hover:bg-[color:var(--h-333333,#333333)] hover:text-[color:var(--t-white,#fff)] transition-colors"
          title="Minimalizuj"
        >
          <Minus size={12} />
        </button>
        <button
          type="button"
          onClick={() => void appWindow.toggleMaximize()}
          data-testid="win-max"
          className="h-full px-3 flex items-center justify-center hover:bg-[color:var(--h-333333,#333333)] hover:text-[color:var(--t-white,#fff)] transition-colors"
          title={native ? (maximized ? 'Przywróć w dół' : 'Maksymalizuj') : 'Pełny ekran'}
        >
          {maximized ? <Copy size={10} /> : <Square size={10} />}
        </button>
        <button
          type="button"
          onClick={() => {
            if (native && onCloseWindow) onCloseWindow();
            else if (tabs.length > 0) onCloseTab(activeTabId);
          }}
          data-testid="win-close"
          className="h-full px-3 flex items-center justify-center hover:bg-[#e81123] hover:text-white transition-colors"
          title={native ? 'Zamknij program' : 'Zamknij dokument'}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
};
