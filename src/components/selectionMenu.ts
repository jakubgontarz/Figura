import type { MenuEntry } from './MenuBar.tsx';

/** Działania menu „Zaznacz” (App.tsx wiąże je z silnikiem i oknami). */
export interface SelectionMenuActions {
  selectAll: () => void;
  deselect: () => void;
  invert: () => void;
  openOffset: () => void;
  saveSelection: () => void;
  loadSelection: (channelId: string) => void;
}

export interface SelectionMenuState {
  hasSelection: boolean;
  /** zapisane zaznaczenia = kanały alfa dokumentu */
  channels: { id: string; name: string }[];
}

const sep: MenuEntry = { sep: true };

/** Menu „Zaznacz”. `state` = null oznacza brak dokumentu: wszystkie pozycje są wyszarzone. */
export function buildSelectionMenu(state: SelectionMenuState | null, act: SelectionMenuActions): MenuEntry[] {
  const none = !state;
  const sel = !!state?.hasSelection;
  const chans = state?.channels ?? [];
  return [
    { label: 'Zaznacz wszystko', onClick: act.selectAll, disabled: none, hint: 'Ctrl+A' },
    { label: 'Odznacz', onClick: act.deselect, disabled: none || !sel, hint: 'Ctrl+D' },
    { label: 'Odwróć zaznaczenie', onClick: act.invert, disabled: none, hint: 'Ctrl+I' },
    sep,
    { label: 'Rozszerz/zmniejsz zaznaczenie...', onClick: act.openOffset, disabled: none || !sel },
    sep,
    { label: 'Zapisz zaznaczenie', onClick: act.saveSelection, disabled: none || !sel },
    {
      label: 'Wczytaj zaznaczenie',
      disabled: none || chans.length === 0,
      submenu: chans.map((c) => ({ label: c.name, onClick: () => act.loadSelection(c.id) })),
    },
  ];
}
