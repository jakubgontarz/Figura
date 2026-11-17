/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ColorSwatchButton } from './ColorPicker.tsx';
import { ScrubField } from './ScrubField.tsx';
import { dialogOwnsKey } from '../core/dialogStack.ts';
import { ACCENT_PRESETS, THEME_IDS, THEME_LABEL, mapHex } from '../core/Theme.ts';
import React, { useEffect, useRef, useState } from 'react';
import { Settings2 } from 'lucide-react';
import { DialogWindow } from './DialogWindow.tsx';
import { useSettings } from './useSettings.ts';
import { DEFAULT_SETTINGS, RENDER_MODE_LABEL, settings, type RenderMode, type Settings } from '../core/Settings.ts';
import { RESERVED_TOOL_KEYS, TOOL_KEY_DEFS, toolKey } from '../core/ToolKeys.ts';
import { LENGTH_UNITS, UNIT_LABEL } from '../core/Units.ts';
import { gpuRendererName } from '../core/GpuFx.ts';

type Cat = 'perf' | 'history' | 'look' | 'newdoc' | 'view' | 'keys';

const CATS: { id: Cat; label: string }[] = [
  { id: 'perf', label: 'Wydajność' },
  { id: 'history', label: 'Historia i pamięć' },
  { id: 'look', label: 'Wygląd' },
  { id: 'newdoc', label: 'Nowy dokument' },
  { id: 'view', label: 'Widok i narzędzia' },
  { id: 'keys', label: 'Skróty klawiszowe' },
];

const RENDER_HINT: Record<RenderMode, string> = {
  performance: 'Podczas przeciągania podgląd w mocno obniżonej rozdzielczości, rzadsze odświeżanie miniatur, spokojniejsze ostrzenie po zmianie widoku.',
  balanced: 'Niższa rozdzielczość podglądu tylko wtedy, gdy pełna klatka byłaby wolna; umiarkowane odświeżanie miniatur.',
  quality: 'Podgląd zawsze w pełnej rozdzielczości (bez rozmycia podczas przeciągania), szybkie ostrzenie i częste odświeżanie miniatur — kosztem płynności na dużych obrazach.',
};

const inputCls = 'h-6 bg-[color:var(--h-1e1e1e,#1e1e1e)] border border-[color:var(--h-444444,#444444)] rounded px-1.5 text-xs text-[color:var(--t-white,#fff)] focus:outline-none focus:border-[color:var(--h-007acc,#007acc)]';

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode; testId?: string }> = ({ label, hint, children, testId }) => (
  <div className="flex items-start justify-between gap-4 py-2 border-b border-[color:var(--h-2a2a2a,#2a2a2a)]" data-testid={testId}>
    <div className="min-w-0">
      <div className="text-[color:var(--h-d4d4d4,#d4d4d4)]">{label}</div>
      {hint && <div className="text-[10.5px] text-[color:var(--h-888888,#888888)] mt-0.5 leading-snug">{hint}</div>}
    </div>
    <div className="shrink-0 flex items-center gap-1.5">{children}</div>
  </div>
);

const Toggle: React.FC<{ k: keyof Settings; label: string; hint?: string }> = ({ k, label, hint }) => {
  const c = useSettings();
  const on = c[k] as boolean;
  return (
    <Row label={label} hint={hint} testId={`set-${k}`}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        data-testid={`set-${k}-switch`}
        onClick={() => settings.set({ [k]: !on } as Partial<Settings>)}
        className={`w-9 h-5 rounded-full relative cursor-pointer transition-colors ${on ? 'bg-[color:var(--h-007acc,#007acc)]' : 'bg-[color:var(--h-444444,#444444)]'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
    </Row>
  );
};

const ThemeRows: React.FC = () => {
  const c = useSettings();
  const isPreset = ACCENT_PRESETS.some((p) => p.hex === c.accent);
  return (
    <>
      <Row label="Motyw interfejsu" hint="Dotyczy całego programu: menu, paneli, okien i linijek." testId="set-theme">
        <div className="flex gap-1.5">
          {THEME_IDS.map((t) => {
            const bg = mapHex('#1e1e1e', t, c.accent);
            const pn = mapHex('#2a2a2a', t, c.accent);
            const tx = mapHex('#cccccc', t, c.accent);
            const on = c.theme === t;
            return (
              <button
                key={t}
                type="button"
                data-testid={`set-theme-${t}`}
                aria-pressed={on}
                onClick={() => settings.set({ theme: t })}
                className={`w-[70px] rounded border-2 overflow-hidden text-[10.5px] cursor-pointer ${on ? 'border-[color:var(--accent)]' : 'border-[color:var(--h-444444,#444444)]'}`}
                style={{ background: bg, color: tx }}
              >
                <div className="h-5 flex items-end px-1 pb-0.5 gap-0.5" style={{ background: pn }}>
                  <span className="w-3 h-1.5 rounded-sm" style={{ background: c.accent }} />
                  <span className="w-5 h-1 rounded-sm" style={{ background: tx, opacity: 0.5 }} />
                </div>
                <div className="py-0.5 text-center">{THEME_LABEL[t]}</div>
              </button>
            );
          })}
        </div>
      </Row>
      <Row label="Kolor akcentu" hint="Zastępuje typowy niebieski: zaznaczenia, aktywne narzędzia, przyciski, suwaki." testId="set-accent">
        <div className="flex flex-wrap gap-1.5 justify-end max-w-[290px] items-center">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.hex}
              type="button"
              title={p.name}
              aria-label={p.name}
              aria-pressed={c.accent === p.hex}
              data-testid={`set-accent-${p.hex.slice(1)}`}
              onClick={() => settings.set({ accent: p.hex })}
              className={`w-5 h-5 rounded-full cursor-pointer border-2 ${c.accent === p.hex ? 'border-[color:var(--t-white,#fff)]' : 'border-transparent'}`}
              style={{ background: p.hex, boxShadow: c.accent === p.hex ? '0 0 0 1px ' + p.hex : undefined }}
            />
          ))}
          <span
            title="Własny kolor"
            data-testid="set-accent-custom"
            className={`relative w-5 h-5 rounded-full border-2 ${!isPreset ? 'border-[color:var(--t-white,#fff)]' : 'border-[color:var(--h-444444,#444444)]'}`}
            style={{ background: isPreset ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' : c.accent }}
          >
            {/* ten sam wybierak koloru co w panelu „Kolor” (zamiast systemowego okna) */}
            <ColorSwatchButton value={c.accent} onChange={(hex) => settings.set({ accent: hex.toLowerCase() })} className="absolute inset-0 w-full h-full rounded-full opacity-0 cursor-pointer p-0" />
          </span>
        </div>
      </Row>
    </>
  );
};

const Choice: React.FC<{ k: keyof Settings; label: string; hint?: string; options: { value: string | number; label: string }[] }> = ({ k, label, hint, options }) => {
  const c = useSettings();
  const cur = c[k] as string | number;
  return (
    <Row label={label} hint={hint} testId={`set-${k}`}>
      <select
        data-testid={`set-${k}-select`}
        value={String(cur)}
        onChange={(e) => {
          const raw = e.target.value;
          settings.set({ [k]: typeof DEFAULT_SETTINGS[k] === 'number' ? Number(raw) : raw } as Partial<Settings>);
        }}
        className={`${inputCls} cursor-pointer`}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
};

/** Pole liczbowe jak w reszcie programu: suwak (przeciąganie po polu, kółko, klik = wpisanie wartości), ograniczone do zakresu. */
const NumberRow: React.FC<{ k: keyof Settings; label: string; hint?: string; min: number; max: number; unit?: string; step?: number; log?: boolean }> = ({ k, label, hint, min, max, unit, step = 1, log }) => {
  const c = useSettings();
  const cur = c[k] as number;
  return (
    <Row label={label} hint={hint} testId={`set-${k}`}>
      <ScrubField
        testId={`set-${k}-input`}
        value={cur}
        min={min}
        max={max}
        step={step}
        logScale={log && min > 0}
        suffix={unit ? ` ${unit}` : ''}
        width={170}
        tall
        onChange={(v) => settings.set({ [k]: v } as Partial<Settings>)}
      />
    </Row>
  );
};

/** Tabela skrótów narzędzi: klik w pole i naciśnięcie litery przypisuje klawisz (Backspace usuwa, Esc anuluje). */
const KeysTable: React.FC = () => {
  useSettings();
  const [capturing, setCapturing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string>('');
  const assign = (id: string, key: string) => {
    if (RESERVED_TOOL_KEYS.includes(key)) {
      setMsg(`Klawisz ${key.toUpperCase()} jest zarezerwowany (zamiana kolorów)`);
      return;
    }
    const other = TOOL_KEY_DEFS.find((d) => d.id !== id && toolKey(d.id) === key);
    if (other) {
      setMsg(`Klawisz ${key.toUpperCase()} jest już przypisany: ${other.name}`);
      return;
    }
    const def = TOOL_KEY_DEFS.find((d) => d.id === id)!;
    const next = { ...settings.get().toolKeys };
    if (key === def.key) delete next[id];
    else next[id] = key;
    settings.set({ toolKeys: next });
    setMsg('');
    setCapturing(null);
  };
  return (
    <div data-testid="keys-table">
      <div className="text-[10.5px] text-[color:var(--h-888888,#888888)] pb-2">Kliknij pole i naciśnij literę A–Z. Backspace usuwa skrót, Esc anuluje. Zmiany działają od razu i są widoczne w podpowiedziach paska narzędzi.</div>
      <div className="grid grid-cols-2 gap-x-6">
        {TOOL_KEY_DEFS.map((d) => {
          const k = toolKey(d.id);
          const changed = k !== d.key;
          const cap = capturing === d.id;
          return (
            <div key={d.id} className="flex items-center justify-between py-1 border-b border-[color:var(--h-2a2a2a,#2a2a2a)]">
              <span className="text-[color:var(--h-d4d4d4,#d4d4d4)] truncate pr-2">{d.name}</span>
              <button
                type="button"
                data-testid={`key-${d.id}`}
                data-capturing={cap ? '1' : undefined}
                onClick={() => {
                  setCapturing(cap ? null : d.id);
                  setMsg('');
                }}
                onBlur={() => setCapturing((c) => (c === d.id ? null : c))}
                onKeyDown={(e) => {
                  if (!cap) return;
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    setCapturing(null);
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === 'Backspace' || e.key === 'Delete') {
                    const next = { ...settings.get().toolKeys, [d.id]: '' };
                    if (d.key === '') delete next[d.id];
                    settings.set({ toolKeys: next });
                    setCapturing(null);
                    return;
                  }
                  if (/^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) assign(d.id, e.key.toLowerCase());
                }}
                className={`h-6 min-w-[64px] px-2 rounded border text-xs cursor-pointer ${
                  cap ? 'border-[color:var(--h-007acc,#007acc)] bg-[color:var(--h-094771,#094771)] text-white' : changed ? 'border-[#c9a227] text-[#ffd866] bg-[color:var(--h-1e1e1e,#1e1e1e)]' : 'border-[color:var(--h-444444,#444444)] text-[color:var(--t-white,#fff)] bg-[color:var(--h-1e1e1e,#1e1e1e)]'
                }`}
              >
                {cap ? 'naciśnij…' : k ? k.toUpperCase() : 'brak'}
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between pt-3">
        <span data-testid="keys-msg" className="text-[color:var(--c-err,#ff8a80)] text-[11px]">
          {msg}
        </span>
        <button
          type="button"
          data-testid="keys-reset"
          onClick={() => {
            settings.set({ toolKeys: {} });
            setMsg('');
          }}
          className="px-3 py-1 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)] cursor-pointer"
        >
          Przywróć domyślne skróty
        </button>
      </div>
    </div>
  );
};

interface Props {
  onClose: () => void;
  /** pamięć zajmowana przez historię aktywnego dokumentu (bajty); null = brak dokumentu */
  historyBytes: number | null;
  initialCat?: Cat;
}

/** Edycja > Ustawienia…: wszystkie zmiany działają od razu i są zapamiętywane między sesjami. */
export const SettingsDialog: React.FC<Props> = ({ onClose, historyBytes, initialCat = 'perf' }) => {
  const [cat, setCat] = useState<Cat>(initialCat);
  const c = useSettings();
  const gpuInfo = React.useMemo(() => gpuRendererName().replace(/^ANGLE \((.*)\)$/, '$1'), []);
  const [confirmReset, setConfirmReset] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!dialogOwnsKey(e, 'settings-dialog')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(2)} GB` : `${Math.round(n)} MB`);

  return (
    <DialogWindow
      width={780}
      testId="settings-dialog"
      onClose={onClose}
      title={
        <>
          <Settings2 size={13} className="text-[color:var(--h-007acc,#007acc)]" />
          Ustawienia
        </>
      }
    >
      <div className="flex" style={{ height: 'min(540px, calc(100vh - 140px))' }}>
        <nav className="w-44 shrink-0 border-r border-[color:var(--h-2f2f2f,#2f2f2f)] bg-[color:var(--h-232324,#232324)] py-2">
          {CATS.map((k) => (
            <button
              key={k.id}
              type="button"
              data-testid={`set-cat-${k.id}`}
              onClick={() => setCat(k.id)}
              className={`w-full text-left px-4 py-2 text-xs cursor-pointer ${cat === k.id ? 'bg-[color:var(--h-094771,#094771)] text-white' : 'text-[color:var(--h-bbbbbb,#bbbbbb)] hover:bg-[color:var(--h-2d2d2e,#2d2d2e)]'}`}
            >
              {k.label}
            </button>
          ))}
        </nav>
        <div className="flex-1 min-w-0 overflow-y-auto px-5 py-3" data-testid={`set-page-${cat}`}>
          {cat === 'perf' && (
            <>
              <div className="py-2 border-b border-[color:var(--h-2a2a2a,#2a2a2a)]">
                <div className="text-[color:var(--h-d4d4d4,#d4d4d4)] mb-2">Sposób renderowania</div>
                <div className="flex rounded overflow-hidden border border-[color:var(--h-444444,#444444)] w-fit">
                  {(['performance', 'balanced', 'quality'] as RenderMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      data-testid={`set-render-${m}`}
                      onClick={() => settings.set({ renderMode: m })}
                      className={`px-4 py-1.5 text-xs cursor-pointer ${c.renderMode === m ? 'bg-[color:var(--h-007acc,#007acc)] text-white' : 'bg-[color:var(--h-2d2d2d,#2d2d2d)] text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-3a3a3a,#3a3a3a)]'}`}
                    >
                      {RENDER_MODE_LABEL[m]}
                    </button>
                  ))}
                </div>
                <div className="text-[10.5px] text-[color:var(--h-888888,#888888)] mt-1.5 leading-snug" data-testid="set-render-hint">
                  {RENDER_HINT[c.renderMode]}
                </div>
              </div>
              <Choice
                k="gpu"
                label="Przyspieszenie GPU"
                hint={`Składanie podglądu na karcie graficznej. „Bezpieczne” używa GPU do rysowania, ale edycję obiektów wektorowych leżących pod innymi liczy na procesorze (na niektórych kartach zintegrowanych w Tauri GPU psuje wtedy obraz). „Wyłączone” wymusza tryb procesorowy (wolniejszy, ale niezależny od sterowników).${gpuInfo ? ` Wykryta karta: ${gpuInfo}.` : ''}`}
                options={[
                  { value: 'auto', label: 'Automatyczne' },
                  { value: 'safe', label: 'Bezpieczne' },
                  { value: 'off', label: 'Wyłączone' },
                ]}
              />
              <Toggle k="downscaleSmooth" label="Uśrednianie pikseli przy oddaleniu" hint="Poniżej 50% zoomu pokazuje obraz uśredniony (bez poszarpanych, „schodkowych” krawędzi i mory). Kopia odświeża się po krótkiej chwili bezruchu." />
              <NumberRow k="previewCacheMB" step={16} label="Pamięć podręczna podglądu edycji" hint="Większa = płynniejsze przesuwanie i zoom podczas edycji kształtów i gradientów." min={16} max={1024} unit="MB" />
              <NumberRow k="fxCacheMB" step={32} label="Pamięć podręczna efektów na GPU" hint="Przechowuje wyniki filtrów i stylizacji, by nie liczyć ich przy każdej klatce." min={64} max={2048} unit="MB" />
            </>
          )}
          {cat === 'history' && (
            <>
              <NumberRow k="historyMB" step={64} log label="Limit pamięci historii (cofnij / ponów)" hint="Po przekroczeniu najstarsze kroki są usuwane. Zawsze zostaje ostatni krok." min={64} max={16384} unit="MB" />
              <NumberRow k="historySteps" step={5} log label="Maksymalna liczba kroków historii" min={5} max={20000} unit="kroków" />
              <Row label="Zajęta pamięć historii (aktywny dokument)" testId="set-history-usage">
                <span className="text-[color:var(--t-white,#fff)]" data-testid="set-history-usage-value">
                  {historyBytes === null ? '—' : mb(historyBytes / (1024 * 1024))}
                </span>
              </Row>
            </>
          )}
          {cat === 'look' && (
            <>
              <ThemeRows />
              <Choice
                k="transparency"
                label="Wyświetlanie przezroczystości"
                options={[
                  { value: 'checker', label: 'Szachownica' },
                  { value: 'white', label: 'Biała' },
                  { value: 'gray', label: 'Szara' },
                  { value: 'black', label: 'Czarna' },
                ]}
              />
              <Choice
                k="checkerStyle"
                label="Kontrast szachownicy"
                options={[
                  { value: 'light', label: 'Jasna' },
                  { value: 'medium', label: 'Średnia' },
                  { value: 'dark', label: 'Ciemna' },
                ]}
              />
              <Choice
                k="checkerSize"
                label="Wielkość kratki szachownicy"
                options={[
                  { value: 6, label: 'Mała (6 px)' },
                  { value: 8, label: 'Średnia (8 px)' },
                  { value: 12, label: 'Standardowa (12 px)' },
                  { value: 16, label: 'Duża (16 px)' },
                  { value: 24, label: 'Bardzo duża (24 px)' },
                ]}
              />
              <Choice
                k="workspace"
                label="Kolor obszaru roboczego"
                options={[
                  { value: 'dark', label: 'Ciemny' },
                  { value: 'gray', label: 'Szary' },
                  { value: 'light', label: 'Jasny' },
                  { value: 'black', label: 'Czarny' },
                ]}
              />
              <Choice
                k="pixelatedZoom"
                label="Ostre piksele od powiększenia"
                hint="Poniżej tej wartości obraz jest wygładzany, powyżej pokazywany jako ostre kwadraty."
                options={[
                  { value: 1, label: '100%' },
                  { value: 2, label: '200%' },
                  { value: 4, label: '400%' },
                  { value: 8, label: '800%' },
                  { value: 0, label: 'Nigdy (zawsze wygładzone)' },
                ]}
              />
              <Choice
                k="gridMinZoom"
                label="Siatka pikseli widoczna od powiększenia"
                options={[
                  { value: 4, label: '400%' },
                  { value: 6, label: '600%' },
                  { value: 8, label: '800%' },
                  { value: 12, label: '1200%' },
                  { value: 16, label: '1600%' },
                ]}
              />
              <Choice
                k="gridStrength"
                label="Intensywność siatki pikseli"
                options={[
                  { value: 'low', label: 'Delikatna' },
                  { value: 'normal', label: 'Normalna' },
                  { value: 'high', label: 'Wyraźna' },
                ]}
              />
              <Toggle k="antsAnimated" label="Animacja maszerujących mrówek" hint="Wyłączenie zatrzymuje ruch kresek i odciąża procesor przy dużych zaznaczeniach." />
              <Choice
                k="antsSpeed"
                label="Prędkość maszerujących mrówek"
                options={[
                  { value: 'slow', label: 'Wolna' },
                  { value: 'normal', label: 'Normalna' },
                  { value: 'fast', label: 'Szybka' },
                ]}
              />
            </>
          )}
          {cat === 'newdoc' && (
            <>
              <Choice
                k="newDocBackground"
                label="Warstwa tła w nowym dokumencie"
                options={[
                  { value: 'white', label: 'Tak, białe tło' },
                  { value: 'secondary', label: 'Tak, w kolorze tła (drugi kolor)' },
                  { value: 'none', label: 'Nie (tylko przezroczysta warstwa)' },
                ]}
              />
              <NumberRow k="newDocWidth" log label="Domyślna szerokość" min={16} max={8000} unit="px" />
              <NumberRow k="newDocHeight" log label="Domyślna wysokość" min={16} max={8000} unit="px" />
              <Choice
                k="newDocDpi"
                label="Domyślna rozdzielczość"
                options={[72, 96, 150, 300, 600].map((v) => ({ value: v, label: `${v} DPI` }))}
              />
            </>
          )}
          {cat === 'view' && (
            <>
              <Choice k="lengthUnit" label="Jednostka długości" options={LENGTH_UNITS.map((u) => ({ value: u, label: UNIT_LABEL[u] }))} />
              <Toggle k="rulers" label="Linijki" />
              <Toggle k="grid" label="Siatka pikseli" />
              <Toggle k="guides" label="Prowadnice" />
              <Toggle k="snap" label="Przyciąganie" />
              <NumberRow k="snapRadius" label="Zasięg przyciągania" hint="Odległość od punktu lub prowadnicy (w pikselach ekranu), przy której kursor jest przyciągany." min={2} max={40} unit="px" />
              <Choice
                k="wheelMode"
                label="Kółko myszy"
                hint="W trybie przewijania zoom daje Ctrl + kółko, a Shift + kółko przesuwa poziomo."
                options={[
                  { value: 'zoom', label: 'Powiększa i zmniejsza' },
                  { value: 'scroll', label: 'Przewija obraz' },
                ]}
              />
              <NumberRow k="wheelZoomStep" label="Krok zoomu kółkiem" min={5} max={100} unit="%" />
              <NumberRow k="zoomStep" label="Krok zoomu Powiększ / Zmniejsz" min={5} max={200} unit="%" />
              <Choice
                k="defaultInterpolation"
                label="Domyślne próbkowanie przekształceń"
                options={[
                  { value: 'nearest-neighbor', label: 'Najbliższe sąsiedztwo' },
                  { value: 'bilinear', label: 'Dwuliniowe' },
                  { value: 'bicubic', label: 'Dwusześcienne' },
                ]}
              />
            </>
          )}
          {cat === 'keys' && <KeysTable />}
        </div>
      </div>
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-[color:var(--h-2f2f2f,#2f2f2f)] shrink-0">
        {confirmReset ? (
          <span className="flex items-center gap-2 text-[color:var(--c-err,#ffb4a9)]">
            Przywrócić wszystkie ustawienia?
            <button
              type="button"
              data-testid="settings-reset-yes"
              onClick={() => {
                settings.reset();
                setConfirmReset(false);
              }}
              className="px-2.5 py-1 bg-[#8a2a2a] hover:bg-[#a63333] rounded text-[color:var(--t-white,#fff)] cursor-pointer"
            >
              Tak
            </button>
            <button type="button" onClick={() => setConfirmReset(false)} className="px-2.5 py-1 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-[color:var(--h-cccccc,#cccccc)] cursor-pointer">
              Nie
            </button>
          </span>
        ) : (
          <button type="button" data-testid="settings-reset" onClick={() => setConfirmReset(true)} className="px-3 py-1.5 bg-[color:var(--h-2d2d2d,#2d2d2d)] hover:bg-[color:var(--h-3d3d3d,#3d3d3d)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)] cursor-pointer">
            Przywróć wszystko do domyślnych
          </button>
        )}
        <button type="button" data-testid="settings-close" onClick={onClose} className="px-5 py-1.5 bg-[color:var(--h-007acc,#007acc)] hover:bg-[color:var(--h-006bb3,#006bb3)] text-white rounded text-xs font-medium cursor-pointer">
          Zamknij
        </button>
      </div>
    </DialogWindow>
  );
};
