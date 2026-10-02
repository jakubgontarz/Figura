/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, FileImage } from 'lucide-react';

interface NewDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (title: string, width: number, height: number) => void;
  defaultTitle?: string;
}

export const NewDocumentModal: React.FC<NewDocumentModalProps> = ({
  isOpen,
  onClose,
  onCreate,
  defaultTitle = 'obraz2.fig',
}) => {
  const [title, setTitle] = useState(defaultTitle);
  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(600);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const w = Math.max(16, Math.min(8000, width));
    const h = Math.max(16, Math.min(8000, height));
    const cleanTitle = title.trim() || 'obraz.fig';
    onCreate(cleanTitle.endsWith('.fig') ? cleanTitle : `${cleanTitle}.fig`, w, h);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 select-none">
      <div className="bg-[#1e1e1e] border border-[#3f3f46] rounded-lg shadow-2xl w-full max-w-sm flex flex-col text-xs text-[#dddddd]">
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#252526] border-b border-[#333] rounded-t-lg">
          <div className="flex items-center gap-2">
            <FileImage size={15} className="text-[#007acc]" />
            <span className="font-semibold text-sm text-white">Nowy dokument</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-[#aaa] hover:text-white hover:bg-[#333] rounded"
          >
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div>
            <label className="block text-[11px] text-[#aaa] mb-1">Nazwa pliku:</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-[#121212] border border-[#444] rounded px-2.5 py-1.5 text-white focus:outline-none focus:border-[#007acc]"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-[#aaa] mb-1">Szerokość (px):</label>
              <input
                type="number"
                min="16"
                max="8000"
                value={width}
                onChange={(e) => setWidth(parseInt(e.target.value) || 16)}
                className="w-full bg-[#121212] border border-[#444] rounded px-2.5 py-1.5 text-white text-center focus:outline-none focus:border-[#007acc]"
              />
            </div>
            <div>
              <label className="block text-[11px] text-[#aaa] mb-1">Wysokość (px):</label>
              <input
                type="number"
                min="16"
                max="8000"
                value={height}
                onChange={(e) => setHeight(parseInt(e.target.value) || 16)}
                className="w-full bg-[#121212] border border-[#444] rounded px-2.5 py-1.5 text-white text-center focus:outline-none focus:border-[#007acc]"
              />
            </div>
          </div>

          {/* Szybkie szablony */}
          <div>
            <label className="block text-[10px] text-[#777] mb-1">Popularne szablony:</label>
            <div className="grid grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => { setWidth(800); setHeight(600); }}
                className="px-2 py-1 bg-[#2a2a2a] hover:bg-[#3a3a3a] border border-[#444] rounded text-[10px] text-[#ccc]"
              >
                800 × 600
              </button>
              <button
                type="button"
                onClick={() => { setWidth(1024); setHeight(768); }}
                className="px-2 py-1 bg-[#2a2a2a] hover:bg-[#3a3a3a] border border-[#444] rounded text-[10px] text-[#ccc]"
              >
                1024 × 768
              </button>
              <button
                type="button"
                onClick={() => { setWidth(1920); setHeight(1080); }}
                className="px-2 py-1 bg-[#2a2a2a] hover:bg-[#3a3a3a] border border-[#444] rounded text-[10px] text-[#ccc]"
              >
                Full HD (1080p)
              </button>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-[#333]">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-[#2d2d2d] hover:bg-[#3d3d3d] rounded text-xs text-[#ccc]"
            >
              Anuluj
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-[#007acc] hover:bg-[#006bb3] text-white rounded text-xs font-medium"
            >
              Utwórz
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
