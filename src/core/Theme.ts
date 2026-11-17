/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { THEME_HEXES } from './ThemeHexes.ts';

/**
 * Motywy interfejsu. Klasy w komponentach używają zmiennych CSS `--h-RRGGBB` z domyślną (ciemną) wartością,
 * więc motyw „ciemny” to po prostu brak nadpisań, a pozostałe motywy podmieniają każdy szary i kolor akcentu.
 */
export type ThemeId = 'white' | 'light' | 'dark' | 'black';

export const THEME_IDS: ThemeId[] = ['white', 'light', 'dark', 'black'];
export const THEME_LABEL: Record<ThemeId, string> = { white: 'Biały', light: 'Jasny', dark: 'Ciemny', black: 'Czarny' };

export const DEFAULT_ACCENT = '#007acc';

export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: 'Niebieski', hex: '#007acc' },
  { name: 'Błękitny', hex: '#0d8bd9' },
  { name: 'Turkusowy', hex: '#0e9aa7' },
  { name: 'Zielony', hex: '#2e9e48' },
  { name: 'Limonkowy', hex: '#6a9a1f' },
  { name: 'Żółty', hex: '#b8860b' },
  { name: 'Pomarańczowy', hex: '#d9730d' },
  { name: 'Czerwony', hex: '#d63f3f' },
  { name: 'Różowy', hex: '#d6458f' },
  { name: 'Fioletowy', hex: '#8a52d6' },
  { name: 'Indygo', hex: '#5b5fd6' },
  { name: 'Grafitowy', hex: '#6b7a8c' },
];

/** Punkty (jasność oryginału → jasność w motywie) interpolowane liniowo. */
const CURVES: Record<Exclude<ThemeId, 'dark'>, [number, number][]> = {
  light: [[0, 252], [30, 243], [42, 237], [51, 232], [62, 226], [68, 222], [80, 214], [110, 150], [136, 112], [170, 78], [204, 48], [221, 34], [255, 17]],
  white: [[0, 255], [30, 255], [42, 249], [51, 244], [62, 238], [68, 232], [80, 222], [110, 150], [136, 112], [170, 78], [204, 48], [221, 34], [255, 17]],
  black: [[0, 0], [30, 8], [42, 16], [51, 22], [62, 30], [68, 36], [80, 48], [110, 84], [136, 136], [255, 255]],
};

const interp = (pts: [number, number][], v: number): number => {
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
};

const toRgb = (hex: string): [number, number, number] => {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};
const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Odcienie akcentu odpowiadające oryginalnym niebieskim (kolor główny, jego hover, zaznaczenie…). */
const ACCENT_ROLES: Record<string, (a: [number, number, number]) => [number, number, number]> = {
  '007acc': (a) => a,
  '006bb3': (a) => mix(a, [0, 0, 0], 0.14),
  '1465b5': (a) => mix(a, [0, 0, 0], 0.18),
  '10549c': (a) => mix(a, [0, 0, 0], 0.3),
  '2980b9': (a) => mix(a, [255, 255, 255], 0.12),
  '094771': (a) => mix(a, [0, 0, 0], 0.55),
};

/** Kolor, jaki dany oryginalny kolor (np. '#2a2a2a') przyjmuje w motywie z akcentem. */
export function mapHex(hex: string, theme: ThemeId, accent: string = DEFAULT_ACCENT): string {
  let h = hex.replace('#', '').toLowerCase();
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  const role = ACCENT_ROLES[h];
  if (role) return toHex(...role(toRgb(accent)));
  if (theme === 'dark') return '#' + h;
  const [r, g, b] = toRgb(h);
  if (Math.max(r, g, b) - Math.min(r, g, b) > 6) return '#' + h;
  const v = interp(CURVES[theme], (r + g + b) / 3);
  return toHex(v, v, v);
}

/** Kolor tekstu „białego” (nagłówki, aktywne etykiety) w danym motywie. */
export const themeText = (theme: ThemeId): string => (theme === 'white' ? '#111111' : theme === 'light' ? '#1b1b1b' : '#ffffff');

/**
 * Kolory „semantyczne” panelu warstw (ikony i liczniki w wierszach, przyciski oka, zaznaczone korekcje).
 * W ciemnych motywach obowiązują wartości domyślne z klas, w jasnych te przyciemnione.
 */
const LIGHT_VARS: Record<string, string> = {
  '--c-ch-r': '#c4312a',
  '--c-ch-g': '#1e7d2f',
  '--c-ch-b': '#1d5fa8',
  '--c-cyan': '#0b7285',
  '--c-blue': '#1c6ea4',
  '--c-amber': '#8a6200',
  '--c-red': '#c62828',
  '--c-teal': '#0b8f73',
  '--c-selbg': '#cfeaf1',
  '--c-selborder': '#19a3bd',
  '--c-selfg': '#0f2d36',
  '--c-rowbg': '#e4f1f4',
  '--c-rowbg-h': '#d6e9ee',
  '--c-rowborder': '#b4d3db',
  '--c-rowfg': '#1d3a42',
  '--c-editbg': '#f6ecc6',
  '--c-edit-bg': '#d3eef5',
  '--c-edit-border': '#0097b2',
  '--c-btn': 'rgba(0,0,0,.09)',
  '--c-btn-h': 'rgba(0,0,0,.18)',
  '--c-btn-fg': '#222222',
  '--c-btn-off': 'rgba(0,0,0,.09)',
  '--c-chart-bg': '#f7f9fa',
  '--c-chart-border': '#7d8a90',
  '--c-chart-mark': '#333333',
  '--c-chart-grid': '#d3dadd',
  '--c-chart-diag': '#a3adb1',
  '--c-chart-pt': '#ffffff',
  '--c-chart-ptb': '#1b1b1b',
  '--c-hist-rgb': '#5f6a6f',
  '--c-hist-r': '#d23b34',
  '--c-hist-g': '#2b9a3c',
  '--c-hist-b': '#2a6fd0',
  '--c-err': '#c62828',
  '--c-warn': '#8a5a00',
  '--c-badge': 'rgba(0,0,0,.07)',
  '--c-badge-h': 'rgba(0,0,0,.15)',
};

/** Nakłada motyw i akcent na całą aplikację (zmienne CSS na <html>). */
export function applyTheme(theme: ThemeId, accent: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  for (const h of THEME_HEXES) {
    const orig = '#' + h;
    const m = mapHex(orig, theme, accent);
    if (m === orig) root.style.removeProperty(`--h-${h}`);
    else root.style.setProperty(`--h-${h}`, m);
  }
  if (theme === 'dark' || theme === 'black') root.style.removeProperty('--t-white');
  else root.style.setProperty('--t-white', themeText(theme));
  const light = theme === 'white' || theme === 'light';
  for (const [k, v] of Object.entries(LIGHT_VARS)) {
    if (light) root.style.setProperty(k, v);
    else root.style.removeProperty(k);
  }
  root.style.setProperty('--accent', accent);
  root.style.colorScheme = theme === 'white' || theme === 'light' ? 'light' : 'dark';
  root.dataset.theme = theme;
}
