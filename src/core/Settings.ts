/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LengthUnit } from './Units.ts';
import { THEME_IDS, ThemeId } from './Theme.ts';

/**
 * Ustawienia programu (Edycja > Ustawienia…). Jedno miejsce prawdy dla całego kodu: rdzeń (renderer, historia, silnik)
 * czyta wartości przez `settings.get()`, interfejs przez hook `useSettings()`. Zapis w localStorage przy każdej zmianie.
 */

export type RenderMode = 'performance' | 'balanced' | 'quality';

export interface Settings {
  // --- Nowy dokument ---
  /** Zawartość warstwy „Tło” nowego dokumentu: białe, kolor tła (drugi kolor) albo brak (sama przezroczysta warstwa) */
  newDocBackground: 'white' | 'secondary' | 'none';
  newDocWidth: number;
  newDocHeight: number;
  newDocDpi: number;
  // --- Widok (przełączniki z menu i paska statusu są zapamiętywane) ---
  lengthUnit: LengthUnit;
  rulers: boolean;
  grid: boolean;
  guides: boolean;
  snap: boolean;
  // --- Wygląd ---
  /** Motyw całego interfejsu */
  theme: ThemeId;
  /** Kolor akcentu (#rrggbb) zamiast domyślnego niebieskiego */
  accent: string;
  transparency: 'checker' | 'white' | 'gray' | 'black';
  checkerSize: number;
  checkerStyle: 'light' | 'medium' | 'dark';
  workspace: 'dark' | 'gray' | 'light' | 'black';
  /** Od jakiego powiększenia (×) widać siatkę pikseli */
  gridMinZoom: number;
  gridStrength: 'low' | 'normal' | 'high';
  /** Od jakiego powiększenia (×) piksele są pokazywane ostro (0 = nigdy: zawsze wygładzone) */
  pixelatedZoom: number;
  antsAnimated: boolean;
  antsSpeed: 'slow' | 'normal' | 'fast';
  // --- Wydajność i pamięć ---
  renderMode: RenderMode;
  gpu: 'auto' | 'off';
  /** Przy oddaleniu poniżej 50% pokazuj pomniejszoną, uśrednioną kopię obrazu zamiast skalowania przez przeglądarkę (bez aliasingu) */
  downscaleSmooth: boolean;
  previewCacheMB: number;
  fxCacheMB: number;
  // --- Historia ---
  historyMB: number;
  historySteps: number;
  // --- Narzędzia i widok ---
  snapRadius: number;
  wheelMode: 'zoom' | 'scroll';
  wheelZoomStep: number;
  zoomStep: number;
  defaultInterpolation: 'nearest-neighbor' | 'bilinear' | 'bicubic';
  // --- Skróty klawiszowe narzędzi (tylko zmienione względem domyślnych: id narzędzia -> klawisz) ---
  toolKeys: Record<string, string>;
}

export const DEFAULT_SETTINGS: Settings = {
  newDocBackground: 'white',
  newDocWidth: 800,
  newDocHeight: 600,
  newDocDpi: 96,
  lengthUnit: 'px',
  rulers: false,
  grid: false,
  guides: true,
  snap: false,
  theme: 'dark',
  accent: '#007acc',
  transparency: 'checker',
  checkerSize: 12,
  checkerStyle: 'light',
  workspace: 'gray',
  gridMinZoom: 6,
  gridStrength: 'normal',
  pixelatedZoom: 2,
  antsAnimated: true,
  antsSpeed: 'normal',
  renderMode: 'balanced',
  gpu: 'auto',
  downscaleSmooth: true,
  previewCacheMB: 128,
  fxCacheMB: 420,
  historyMB: 1024,
  historySteps: 20000,
  snapRadius: 8,
  wheelMode: 'zoom',
  wheelZoomStep: 15,
  zoomStep: 25,
  defaultInterpolation: 'bilinear',
  toolKeys: {},
};

/** Parametry renderowania wynikające z trybu (Wydajność / Zrównoważony / Jakość). */
export interface RenderParams {
  /** niska rozdzielczość podglądu podczas przeciągania, gdy pełny render byłby wolny */
  lod: boolean;
  /** po jakim szacowanym koszcie klatki (ms) włącza się niska rozdzielczość */
  lodMinMs: number;
  /** skala niskiej rozdzielczości */
  lodLevel: number;
  /** opóźnienie (ms) ostrego przerysowania po zmianie widoku */
  refineDelayMs: number;
  /** opóźnienie (ms) ostrego przerysowania po ustaniu przeciągania */
  refineExactDelayMs: number;
  /** zwłoka (ms) odświeżania miniatur warstw */
  thumbDebounceMs: number;
  thumbMaxWaitMs: number;
}

const RENDER: Record<RenderMode, RenderParams> = {
  performance: { lod: true, lodMinMs: 22, lodLevel: 0.35, refineDelayMs: 160, refineExactDelayMs: 120, thumbDebounceMs: 450, thumbMaxWaitMs: 2000 },
  balanced: { lod: true, lodMinMs: 45, lodLevel: 0.5, refineDelayMs: 100, refineExactDelayMs: 70, thumbDebounceMs: 150, thumbMaxWaitMs: 900 },
  quality: { lod: false, lodMinMs: 45, lodLevel: 0.5, refineDelayMs: 40, refineExactDelayMs: 30, thumbDebounceMs: 60, thumbMaxWaitMs: 400 },
};

export const RENDER_MODE_LABEL: Record<RenderMode, string> = {
  performance: 'Wydajność',
  balanced: 'Zrównoważony',
  quality: 'Jakość',
};

const KEY = 'figura.settings.v1';

type Listener = () => void;

class SettingsStore {
  private cur: Settings = { ...DEFAULT_SETTINGS, toolKeys: {} };
  private listeners = new Set<Listener>();

  constructor() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
      if (raw) this.cur = this.sanitize(JSON.parse(raw));
    } catch {
      /* uszkodzony zapis: zostają wartości domyślne */
    }
  }

  /** Scala wczytane wartości z domyślnymi: nieznane klucze są pomijane, a wartości złego typu zastępowane domyślnymi. */
  private sanitize(raw: unknown): Settings {
    const out: Settings = { ...DEFAULT_SETTINGS, toolKeys: {} };
    if (!raw || typeof raw !== 'object') return out;
    const r = raw as Record<string, unknown>;
    const o = out as unknown as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      if (k === 'toolKeys') continue;
      const d = DEFAULT_SETTINGS[k];
      if (typeof r[k] === typeof d) o[k] = r[k];
    }
    if (!THEME_IDS.includes(out.theme)) out.theme = DEFAULT_SETTINGS.theme;
    if (!/^#[0-9a-fA-F]{6}$/.test(out.accent)) out.accent = DEFAULT_SETTINGS.accent;
    out.accent = out.accent.toLowerCase();
    const tk = r.toolKeys;
    if (tk && typeof tk === 'object') {
      for (const [id, v] of Object.entries(tk as Record<string, unknown>)) if (typeof v === 'string') out.toolKeys[id] = v;
    }
    return out;
  }

  /** Bieżące ustawienia (obiekt jest niezmienny: każda zmiana tworzy nowy). */
  get(): Settings {
    return this.cur;
  }

  set(patch: Partial<Settings>): void {
    let changed = false;
    for (const k of Object.keys(patch) as (keyof Settings)[]) {
      if (patch[k] !== this.cur[k]) changed = true;
    }
    if (!changed) return;
    this.cur = { ...this.cur, ...patch };
    this.persist();
    this.emit();
  }

  reset(): void {
    this.cur = { ...DEFAULT_SETTINGS, toolKeys: {} };
    this.persist();
    this.emit();
  }

  /** Parametry renderowania dla bieżącego trybu. */
  render(): RenderParams {
    return RENDER[this.cur.renderMode];
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private persist(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.cur));
    } catch {
      /* brak miejsca / tryb prywatny: ustawienia działają do końca sesji */
    }
  }
}

export const settings = new SettingsStore();
