/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Minus, Square, X, Plus } from 'lucide-react';

interface TabItem {
  id: string;
  title: string;
  /** Zakładka obiektu inteligentnego: kolor wyróżniający i opis. */
  accent?: string;
  hint?: string;
}

interface TitleBarProps {
  tabs: TabItem[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}) => {
  return (
    <div className="h-8 bg-[color:var(--h-1e1e1e,#1e1e1e)] select-none flex items-center justify-between border-b border-[color:var(--h-111111,#111111)] pl-2 pr-0 text-xs">
      <div className="flex items-center gap-2 overflow-x-auto h-full scrollbar-none">
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
                <span className="truncate max-w-[130px]">{tab.title}</span>
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

      {/* Kontrolki okna */}
      <div className="flex items-center text-[color:var(--h-999999,#999999)] h-full">
        <button
          type="button"
          onClick={() => {}}
          className="h-full px-3 flex items-center justify-center hover:bg-[color:var(--h-333333,#333333)] hover:text-[color:var(--t-white,#fff)] transition-colors"
          title="Minimalizuj"
        >
          <Minus size={12} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (!document.fullscreenElement) {
              document.documentElement.requestFullscreen().catch(() => {});
            } else {
              document.exitFullscreen().catch(() => {});
            }
          }}
          className="h-full px-3 flex items-center justify-center hover:bg-[color:var(--h-333333,#333333)] hover:text-[color:var(--t-white,#fff)] transition-colors"
          title="Maksymalizuj / Pełny ekran"
        >
          <Square size={10} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (tabs.length > 0) {
              onCloseTab(activeTabId);
            }
          }}
          className="h-full px-3 flex items-center justify-center hover:bg-[#e81123] hover:text-white transition-colors"
          title="Zamknij"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
};
