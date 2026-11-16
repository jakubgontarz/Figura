import type { MenuEntry } from './MenuBar.tsx';

/** Działania menu „Edycja” (App.tsx wiąże je z silnikiem aktywnej zakładki). */
export interface EditMenuActions {
  undo: () => void;
  redo: () => void;
  goToHistory: (index: number) => void;
  cut: () => void;
  copy: () => void;
  copyMerged: () => void;
  paste: () => void;
  pasteNewRaster: () => void;
  pasteNewVector: () => void;
  clear: () => void;
  fillPrimary: () => void;
  fillSecondary: () => void;
  toggleSnap: () => void;
  openSettings: () => void;
}

export interface EditMenuState {
  canUndo: boolean;
  canRedo: boolean;
  /** Nazwy kroków historii (najstarszy pierwszy) i liczba kroków wykonanych */
  history: { labels: string[]; current: number };
  snap: boolean;
}

const sep: MenuEntry = { sep: true };
/** Najwięcej kroków historii widocznych w podmenu (okno wokół bieżącego kroku) */
const HISTORY_WINDOW = 24;

/** Menu „Edycja”. `state` = null oznacza brak dokumentu: wszystko poza Ustawieniami jest wyszarzone. */
export function buildEditMenu(state: EditMenuState | null, act: EditMenuActions): MenuEntry[] {
  const none = !state;
  let historySub: MenuEntry[] = [{ label: 'Brak kroków', disabled: true }];
  if (state) {
    const { labels, current } = state.history;
    const total = labels.length;
    const start = Math.max(0, Math.min(current - Math.floor(HISTORY_WINDOW / 2), total - HISTORY_WINDOW));
    const end = Math.min(total, start + HISTORY_WINDOW);
    const rows: MenuEntry[] = [];
    if (start > 0) rows.push({ label: `… ${start} wcześniejszych kroków (panel Historia)`, disabled: true });
    else rows.push({ label: 'Początek historii', checked: current === 0, onClick: () => act.goToHistory(0) });
    for (let i = start; i < end; i++) {
      rows.push({ label: labels[i], checked: current === i + 1, onClick: () => act.goToHistory(i + 1) });
    }
    if (end < total) rows.push({ label: `… ${total - end} dalszych kroków (panel Historia)`, disabled: true });
    if (total > 0) historySub = rows;
  }
  return [
    { label: 'Cofnij', onClick: act.undo, disabled: none || !state!.canUndo, hint: 'Ctrl+Z' },
    { label: 'Ponów', onClick: act.redo, disabled: none || !state!.canRedo, hint: 'Ctrl+Y' },
    { label: 'Historia operacji', submenu: historySub, disabled: none },
    sep,
    { label: 'Wytnij', onClick: act.cut, disabled: none, hint: 'Ctrl+X' },
    { label: 'Kopiuj', onClick: act.copy, disabled: none, hint: 'Ctrl+C' },
    { label: 'Kopiuj spłaszczone', onClick: act.copyMerged, disabled: none, hint: 'Ctrl+Shift+C' },
    { label: 'Wklej', onClick: act.paste, disabled: none, hint: 'Ctrl+V' },
    { label: 'Wklej do nowej warstwy rastrowej', onClick: act.pasteNewRaster, disabled: none },
    { label: 'Wklej do nowej warstwy wektorowej', onClick: act.pasteNewVector, disabled: none },
    sep,
    { label: 'Wyczyść', onClick: act.clear, disabled: none, hint: 'Del' },
    { label: 'Wypełnij kolorem podstawowym', onClick: act.fillPrimary, disabled: none },
    { label: 'Wypełnij kolorem dodatkowym', onClick: act.fillSecondary, disabled: none },
    sep,
    { label: 'Przyciąganie', onClick: act.toggleSnap, disabled: none, checked: !!state?.snap },
    { label: 'Ustawienia...', testId: 'menu-settings', onClick: act.openSettings },
  ];
}
