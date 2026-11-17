import type { MenuEntry } from './MenuBar.tsx';
import type { RecentItem } from '../core/Recent.ts';

/** Działania menu „Plik” (App.tsx wiąże je ze stanem zakładek). */
export interface FileMenuActions {
  newDoc: () => void;
  newFromClipboard: () => void;
  open: () => void;
  openRecent: (item: RecentItem) => void;
  clearRecent: () => void;
  save: () => void;
  saveAs: () => void;
  saveAll: () => void;
  exportAs: () => void;
  print: () => void;
  properties: () => void;
  close: () => void;
  closeAll: () => void;
  exit: () => void;
}

export interface FileMenuState {
  hasDoc: boolean;
  /** Liczba dokumentów z niezapisanymi zmianami */
  dirtyCount: number;
  activeDirty: boolean;
  recents: RecentItem[];
  /** Wyjście z programu ma sens tylko w aplikacji natywnej (w przeglądarce zamyka się kartę) */
  canExit: boolean;
}

const sep: MenuEntry = { sep: true };

export function buildFileMenu(state: FileMenuState, act: FileMenuActions): MenuEntry[] {
  const none = !state.hasDoc;
  const recent: MenuEntry[] = state.recents.length
    ? [
        ...state.recents.map<MenuEntry>((r, i) => ({
          label: `${i + 1}. ${r.name}`,
          testId: `menu-recent-${i}`,
          onClick: () => act.openRecent(r),
        })),
        sep,
        { label: 'Wyczyść listę', testId: 'menu-recent-clear', onClick: act.clearRecent },
      ]
    : [{ label: 'Brak ostatnio otwartych plików', disabled: true }];
  return [
    { label: 'Nowy...', testId: 'menu-new', onClick: act.newDoc, hint: 'Ctrl+N' },
    { label: 'Nowy ze schowka', testId: 'menu-new-clipboard', onClick: act.newFromClipboard },
    { label: 'Otwórz...', testId: 'menu-open', onClick: act.open, hint: 'Ctrl+O' },
    { label: 'Najnowsze', testId: 'menu-recent', submenu: recent },
    sep,
    { label: 'Zapisz', testId: 'menu-save', onClick: act.save, disabled: none, hint: 'Ctrl+S' },
    { label: 'Zapisz jako...', testId: 'menu-save-as', onClick: act.saveAs, disabled: none, hint: 'Ctrl+Shift+S' },
    { label: 'Zapisz wszystkie', testId: 'menu-save-all', onClick: act.saveAll, disabled: state.dirtyCount === 0, hint: 'Ctrl+Alt+S' },
    sep,
    { label: 'Eksportuj...', testId: 'menu-export', onClick: act.exportAs, disabled: none, hint: 'Ctrl+Shift+E' },
    { label: 'Drukuj...', testId: 'menu-print', onClick: act.print, disabled: none, hint: 'Ctrl+P' },
    { label: 'Właściwości dokumentu...', testId: 'menu-properties', onClick: act.properties, disabled: none, hint: 'Alt+Enter' },
    sep,
    { label: 'Zamknij', testId: 'menu-close', onClick: act.close, disabled: none, hint: 'Ctrl+W' },
    { label: 'Zamknij wszystkie', testId: 'menu-close-all', onClick: act.closeAll, disabled: none, hint: 'Ctrl+Alt+W' },
    sep,
    { label: state.canExit ? 'Wyjdź' : 'Wyjdź (zamknij kartę)', testId: 'menu-exit', onClick: act.exit, hint: 'Ctrl+Q' },
  ];
}
