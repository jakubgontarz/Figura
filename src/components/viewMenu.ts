import type { MenuEntry } from './MenuBar.tsx';
import { LENGTH_UNITS, LengthUnit, UNIT_LABEL } from '../core/Units.ts';

/** Działania menu „Widok” (App.tsx wiąże je z widokiem aktywnej zakładki). */
export interface ViewMenuActions {
  zoomIn: () => void;
  zoomOut: () => void;
  fitWindow: () => void;
  fitSelection: () => void;
  actualSize: () => void;
  setUnit: (u: LengthUnit) => void;
  toggleGrid: () => void;
  toggleRulers: () => void;
  toggleGuides: () => void;
}

export interface ViewMenuState {
  hasSelection: boolean;
  unit: LengthUnit;
  unitsLocked: boolean;
  gridVisible: boolean;
  rulersVisible: boolean;
  guidesVisible: boolean;
}

const sep: MenuEntry = { sep: true };

/** Menu „Widok”. `state` = null oznacza brak dokumentu: wszystkie pozycje są wyszarzone. */
export function buildViewMenu(state: ViewMenuState | null, act: ViewMenuActions): MenuEntry[] {
  const none = !state;
  return [
    { label: 'Powiększ', onClick: act.zoomIn, disabled: none, hint: 'Ctrl++' },
    { label: 'Zmniejsz', onClick: act.zoomOut, disabled: none, hint: 'Ctrl+−' },
    { label: 'Dopasuj do okna', onClick: act.fitWindow, disabled: none, hint: 'Ctrl+9' },
    { label: 'Dopasuj do zaznaczenia', onClick: act.fitSelection, disabled: none || !state!.hasSelection },
    { label: 'Rozmiar rzeczywisty', onClick: act.actualSize, disabled: none, hint: 'Ctrl+0' },
    sep,
    {
      label: 'Jednostka',
      disabled: none,
      submenu: LENGTH_UNITS.map((u) => ({
        label: UNIT_LABEL[u],
        checked: !!state && state.unit === u,
        disabled: !!state?.unitsLocked,
        onClick: () => act.setUnit(u),
      })),
    },
    { label: 'Siatka', onClick: act.toggleGrid, disabled: none, checked: !!state?.gridVisible },
    { label: 'Linijka', onClick: act.toggleRulers, disabled: none, checked: !!state?.rulersVisible },
    { label: 'Prowadnice', onClick: act.toggleGuides, disabled: none, checked: !!state?.guidesVisible },
  ];
}
