import type { LayerTransformOp } from '../core/VectorObjects.ts';
import type { MenuEntry } from './MenuBar.tsx';

/** Działania menu „Obraz” (App.tsx wiąże je z silnikiem i oknami). */
export interface ImageMenuActions {
  cropToSelection: () => void;
  cropToTransparency: () => void;
  openResize: () => void;
  openCanvasSize: () => void;
  transform: (op: LayerTransformOp) => void;
  flatten: () => void;
}

export interface ImageMenuState {
  hasSelection: boolean;
}

const sep: MenuEntry = { sep: true };

/**
 * Menu „Obraz”: operacje na całym obrazie (wszystkie warstwy naraz). `state` = null oznacza brak dokumentu:
 * wszystkie pozycje są wyszarzone.
 */
export function buildImageMenu(state: ImageMenuState | null, act: ImageMenuActions): MenuEntry[] {
  const none = !state;
  return [
    { label: 'Przytnij do zaznaczenia', onClick: act.cropToSelection, disabled: none || !state!.hasSelection },
    { label: 'Przytnij do przezroczystości', onClick: act.cropToTransparency, disabled: none },
    { label: 'Zmień rozmiar...', onClick: act.openResize, disabled: none },
    { label: 'Rozmiar płótna...', onClick: act.openCanvasSize, disabled: none },
    sep,
    { label: 'Odbij w poziomie', onClick: () => act.transform('flipH'), disabled: none },
    { label: 'Odbij w pionie', onClick: () => act.transform('flipV'), disabled: none },
    sep,
    { label: 'Obróć w prawo', onClick: () => act.transform('cw'), disabled: none },
    { label: 'Obróć w lewo', onClick: () => act.transform('ccw'), disabled: none },
    { label: 'Obróć o 180°', onClick: () => act.transform('r180'), disabled: none },
    sep,
    { label: 'Spłaszcz', onClick: act.flatten, disabled: none },
  ];
}
