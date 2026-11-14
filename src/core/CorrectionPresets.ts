import { CorrectionType, cloneParams, defaultParams } from './Corrections.ts';

/** Preset użytkownika dla jednej korekcji lub jednego filtru. */
export interface CorrectionPreset {
  id: string;
  name: string;
  params: any;
}

const KEY = 'figura.correctionPresets.v1';

type Store = Partial<Record<CorrectionType, CorrectionPreset[]>>;

/**
 * Dopasowuje zapisane parametry do aktualnego kształtu parametrów domyślnych: pola obce są pomijane,
 * brakujące i błędne zastępują wartości domyślne. Dzięki temu preset zapisany w starszej wersji nie psuje okna.
 */
function revive(def: any, raw: any): any {
  if (Array.isArray(def)) return Array.isArray(raw) ? cloneParams(raw) : cloneParams(def);
  if (def && typeof def === 'object') {
    const out: Record<string, any> = {};
    for (const k of Object.keys(def)) out[k] = revive(def[k], raw && typeof raw === 'object' ? raw[k] : undefined);
    return out;
  }
  if (typeof def === 'number') return typeof raw === 'number' && Number.isFinite(raw) ? raw : def;
  if (typeof def === 'boolean') return typeof raw === 'boolean' ? raw : def;
  if (typeof def === 'string') return typeof raw === 'string' ? raw : def;
  return def;
}

function readStore(): Record<string, any> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** Czy dana korekcja ma jakiekolwiek parametry (np. „Negatyw” nie ma, więc presety nic by nie dawały). */
export function hasPresetParams(type: CorrectionType): boolean {
  const d = defaultParams(type) as unknown;
  return !!d && typeof d === 'object' && Object.keys(d as object).length > 0;
}

export function loadCorrectionPresets(type: CorrectionType): CorrectionPreset[] {
  const list = readStore()[type];
  if (!Array.isArray(list)) return [];
  const def = defaultParams(type);
  const out: CorrectionPreset[] = [];
  for (const r of list) {
    if (r && typeof r.id === 'string' && typeof r.name === 'string') out.push({ id: r.id, name: r.name, params: revive(def, r.params) });
  }
  return out;
}

export function saveCorrectionPresets(type: CorrectionType, list: CorrectionPreset[]): void {
  try {
    const store = readStore();
    if (list.length) store[type] = list.map((p) => ({ id: p.id, name: p.name, params: p.params }));
    else delete store[type];
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* brak dostępu do pamięci przeglądarki: presety działają do końca sesji okna */
  }
}

export const sameParams = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
