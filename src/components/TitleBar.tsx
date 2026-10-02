/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Minus, Square, X, Plus } from 'lucide-react';

interface TabItem {
  id: string;
  title: string;
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
    <div className="h-8 bg-[#1e1e1e] select-none flex items-center justify-between border-b border-[#111111] px-2 text-xs">
      <div className="flex items-center gap-2 overflow-x-auto h-full scrollbar-none">
        {/* Nazwa programu FIGURA (App Title Branding) */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 mr-1">
          <span className="font-bold text-[12px] tracking-widest text-[#00a8ff] select-none font-mono">
            FIGURA
          </span>
        </div>

        {/* Zakładki otwartych dokumentów */}
        <div className="flex items-center gap-1 h-full pt-1">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => onSelectTab(tab.id)}
                className={`group flex items-center gap-2 px-3 py-1 text-[11px] font-medium rounded-t cursor-pointer border-t-2 transition-colors ${
                  isActive
                    ? 'bg-[#2b2b2b] text-white border-[#0078d7]'
                    : 'bg-[#181818] text-[#a0a0a0] hover:text-white hover:bg-[#222222] border-transparent'
                }`}
              >
                <span className="truncate max-w-[130px]">{tab.title}</span>
                {tabs.length > 1 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 hover:bg-[#444] rounded p-0.5 text-[#aaa] hover:text-white"
                    title="Zamknij dokument"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            );
          })}

          <button
            type="button"
            onClick={onNewTab}
            className="h-6 w-6 flex items-center justify-center text-[#888] hover:text-white hover:bg-[#333] rounded transition-colors"
            title="Nowy dokument"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>

      {/* Kontrolki okna */}
      <div className="flex items-center text-[#999999] h-full">
        <button
          type="button"
          onClick={() => {}}
          className="h-full px-3 flex items-center justify-center hover:bg-[#333333] hover:text-white transition-colors"
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
          className="h-full px-3 flex items-center justify-center hover:bg-[#333333] hover:text-white transition-colors"
          title="Maksymalizuj / Pełny ekran"
        >
          <Square size={10} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (tabs.length > 1) {
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
