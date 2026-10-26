/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Katalog czcionek narzędzia Tekst: rodziny ogólne oraz typowe czcionki systemowe wykrywane po pomiarze
 * (na liście są tylko zainstalowane). Rysowanie na płótnie używa czcionek po nazwie, więc działa każda zainstalowana.
 */

/** Rodziny ogólne - zawsze dostępne. */
export const GENERIC_FONT_FAMILIES = ['sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];

/** Typowe czcionki Windows / macOS / Linux; na liście pojawiają się tylko te, które są naprawdę zainstalowane. */
const COMMON_SYSTEM_CANDIDATES = [
  'Arial', 'Arial Black', 'Arial Narrow', 'Bahnschrift', 'Book Antiqua', 'Bookman Old Style', 'Calibri', 'Cambria',
  'Candara', 'Century Gothic', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima',
  'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Garamond', 'Georgia', 'Impact', 'Ink Free', 'Lucida Console',
  'Lucida Sans Unicode', 'Malgun Gothic', 'Microsoft Sans Serif', 'Palatino Linotype', 'Segoe Print', 'Segoe Script',
  'Segoe UI', 'Segoe UI Black', 'Segoe UI Light', 'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman',
  'Trebuchet MS', 'Verdana', 'Helvetica', 'Helvetica Neue', 'Avenir', 'Avenir Next', 'Baskerville', 'Didot',
  'Futura', 'Gill Sans', 'Optima', 'Palatino', 'Rockwell', 'American Typewriter', 'Menlo', 'Monaco', 'Courier',
  'Copperplate', 'Papyrus', 'Brush Script MT', 'Snell Roundhand', 'Marker Felt', 'Chalkboard', 'Noteworthy',
  'SF Pro Text', 'San Francisco', 'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans',
  'Liberation Serif', 'Liberation Mono', 'Noto Sans', 'Noto Serif', 'Ubuntu', 'Cantarell', 'Droid Sans',
  'Algerian', 'Baskerville Old Face', 'Bauhaus 93', 'Bell MT', 'Berlin Sans FB', 'Bernard MT Condensed', 'Bodoni MT',
  'Britannic Bold', 'Broadway', 'Calisto MT', 'Castellar', 'Centaur', 'Century', 'Century Schoolbook', 'Colonna MT',
  'Cooper Black', 'Copperplate Gothic Bold', 'Curlz MT', 'Dubai', 'Edwardian Script ITC', 'Elephant', 'Engravers MT',
  'Felix Titling', 'Footlight MT Light', 'Forte', 'Freestyle Script', 'French Script MT', 'Gigi', 'Gill Sans MT',
  'Gloucester MT Extra Condensed', 'Goudy Old Style', 'Haettenschweiler', 'Harlow Solid Italic', 'Harrington',
  'High Tower Text', 'Informal Roman', 'Jokerman', 'Juice ITC', 'Kristen ITC', 'Kunstler Script', 'Leelawadee UI',
  'Lucida Bright', 'Lucida Calligraphy', 'Lucida Fax', 'Lucida Handwriting', 'Lucida Sans', 'Lucida Sans Typewriter',
  'Magneto', 'Maiandra GD', 'Matura MT Script Capitals', 'Mistral', 'Modern No. 20', 'Monotype Corsiva', 'MS Gothic',
  'MS Reference Sans Serif', 'MV Boli', 'Myanmar Text', 'Niagara Engraved', 'Niagara Solid', 'Nirmala UI', 'OCR A Extended',
  'Old English Text MT', 'Onyx', 'Palace Script MT', 'Parchment', 'Perpetua', 'Playbill', 'Poor Richard', 'Pristina',
  'Rage Italic', 'Ravie', 'Rockwell Condensed', 'Script MT Bold', 'Segoe UI Emoji', 'Segoe UI Semibold',
  'Segoe UI Symbol', 'Showcard Gothic', 'SimSun', 'Snap ITC', 'Stencil', 'Tempus Sans ITC', 'Tw Cen MT', 'Verdana Pro',
  'Viner Hand ITC', 'Vivaldi', 'Vladimir Script', 'Wide Latin', 'Wingdings', 'Yu Gothic', 'Yu Mincho',
  'Cascadia Code', 'Cascadia Mono', 'Aptos', 'Aptos Display', 'Aptos Serif', 'Calibri Light', 'Rockwell Extra Bold',
  'Trebuchet', 'Tahoma Bold', 'Open Sans', 'Roboto', 'Lato', 'Montserrat', 'Source Sans Pro', 'Fira Sans', 'Inter',
];

let installedCommon: string[] | null = null;

function detectInstalledCommon(): string[] {
  if (installedCommon) return installedCommon;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  if (!ctx) return (installedCommon = []);
  const probe = 'mmmmmmmmmmlliWWWW@#0123456789ąęśćżźół';
  const bases = ['monospace', 'sans-serif', 'serif'];
  const baseW = bases.map((b) => {
    ctx.font = `72px ${b}`;
    return ctx.measureText(probe).width;
  });
  installedCommon = COMMON_SYSTEM_CANDIDATES.filter((f) =>
    bases.some((b, i) => {
      ctx.font = `72px "${f}", ${b}`;
      return Math.abs(ctx.measureText(probe).width - baseW[i]) > 0.01;
    })
  );
  return installedCommon;
}

/** Czcionki do pokazania na liście: tylko te z listy typowych, które są zainstalowane w systemie. */
export function getSystemFontList(): string[] {
  return detectInstalledCommon();
}

/** Jedna lista alfabetyczna: zainstalowane czcionki + rodziny ogólne (+ aktualnie użyta, gdyby jej brakowało). */
export function getAllFontFamilies(current?: string): string[] {
  const set = new Set<string>([...getSystemFontList(), ...GENERIC_FONT_FAMILIES]);
  if (current) set.add(current);
  return [...set].sort((a, b) => a.localeCompare(b, 'pl', { sensitivity: 'base' }));
}
