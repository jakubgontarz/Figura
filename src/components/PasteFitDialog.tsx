/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { DialogWindow } from './DialogWindow.tsx';
import { dialogOwnsKey } from '../core/dialogStack.ts';

interface Props {
  imageW: number;
  imageH: number;
  canvasW: number;
  canvasH: number;
  /** Czy części obrazu poza płótnem zostałyby odcięte (warstwa rastrowa) */
  crops: boolean;
  onChoose: (choice: 'asis' | 'expand' | 'cancel') => void;
}

/** Pytanie przy wklejaniu obrazu większego od płótna: wkleić bez zmian czy rozszerzyć płótno. Obraz nigdy nie jest zmniejszany. */
export const PasteFitDialog: React.FC<Props> = ({ imageW, imageH, canvasW, canvasH, crops, onChoose }) => {
  const newW = Math.max(imageW, canvasW);
  const newH = Math.max(imageH, canvasH);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'paste-fit-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onChoose('cancel');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onChoose('expand');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onChoose]);
  const btn = 'px-3 py-1.5 rounded text-xs cursor-pointer';
  return (
    <DialogWindow title="Wklejany obraz jest większy od płótna" width={420} modal testId="paste-fit-dialog" onClose={() => onChoose('cancel')}>
      <div className="px-4 pt-3 pb-2 text-[12px] leading-relaxed text-[color:var(--h-cccccc,#cccccc)]">
        <p>
          Obraz ma <b className="text-[color:var(--t-white,#fff)]">{imageW} × {imageH} px</b>, a płótno{' '}
          <b className="text-[color:var(--t-white,#fff)]">{canvasW} × {canvasH} px</b>. Obraz nie zostanie zmniejszony.
        </p>
        <ul className="mt-2 flex flex-col gap-1.5 text-[11.5px] text-[color:var(--h-aaaaaa,#aaaaaa)]">
          <li>
            <b className="text-[color:var(--h-dddddd,#dddddd)]">Rozszerz płótno</b>: płótno zostanie powiększone do {newW} × {newH} px (dotychczasowa zawartość wyśrodkowana), a obraz zmieści się w całości.
          </li>
          <li>
            <b className="text-[color:var(--h-dddddd,#dddddd)]">Wklej bez zmian</b>: obraz zachowa swój rozmiar i zostanie wyśrodkowany
            {crops ? '; do zatwierdzenia wystaje poza płótno, a po zatwierdzeniu części poza płótnem zostaną odcięte.' : '; części poza płótnem pozostaną poza nim.'}
          </li>
        </ul>
      </div>
      <div className="flex justify-end gap-2 px-3 py-2.5 border-t border-[color:var(--h-333333,#333333)]">
        <button type="button" data-testid="paste-fit-cancel" onClick={() => onChoose('cancel')} className={`${btn} bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] text-[color:var(--h-cccccc,#cccccc)]`}>
          Anuluj
        </button>
        <button type="button" data-testid="paste-fit-asis" onClick={() => onChoose('asis')} className={`${btn} bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] text-[color:var(--h-cccccc,#cccccc)]`}>
          Wklej bez zmian
        </button>
        <button type="button" data-testid="paste-fit-expand" onClick={() => onChoose('expand')} className={`${btn} px-4 bg-[color:var(--h-007acc,#007acc)] hover:bg-[color:var(--h-006bb3,#006bb3)] text-white`}>
          Rozszerz płótno
        </button>
      </div>
    </DialogWindow>
  );
};
