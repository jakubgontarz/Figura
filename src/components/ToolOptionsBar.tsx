/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Scaling, Move, FlipHorizontal, FlipVertical, Pipette, Blend, ArrowLeftRight } from 'lucide-react';
import {
  BLEND_MODES,
  BrushSettings,
  GradientRepeatMode,
  GradientSettings,
  GradientType,
  InterpolationMode,
  PipetteSettings,
  SKBlendMode,
  SKColor,
  SelectionCombineMode,
  SelectionConstraint,
  SelectionSettings,
} from '../core/skia/types.ts';

interface ToolOptionsBarProps {
  brushSettings: BrushSettings;
  onChangeSettings: (newSettings: Partial<BrushSettings>) => void;
  selectionSettings: SelectionSettings;
  onChangeSelectionSettings: (newSettings: Partial<SelectionSettings>) => void;
  pipetteSettings: PipetteSettings;
  onChangePipetteSettings: (newSettings: Partial<PipetteSettings>) => void;
  gradientSettings?: GradientSettings;
  onChangeGradientSettings?: (newSettings: Partial<GradientSettings>) => void;
  primaryColor?: SKColor;
  secondaryColor?: SKColor;
  showTileDebug: boolean;
  onToggleTileDebug: () => void;
  activeTool: string;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
}

function sliderToSize(val: number): number {
  const norm = Math.max(0, Math.min(1000, val)) / 1000;
  const size = Math.round(1 + Math.pow(norm, 2.6) * 1999);
  return Math.max(1, Math.min(2000, size));
}

function sizeToSlider(size: number): number {
  const clean = Math.max(1, Math.min(2000, size));
  const norm = Math.pow((clean - 1) / 1999, 1 / 2.6);
  return Math.round(norm * 1000);
}

function sliderToSpacing(val: number): number {
  const norm = Math.max(0, Math.min(1000, val)) / 1000;
  const spacing = Math.round(1 + Math.pow(norm, 2.2) * 499);
  return Math.max(1, Math.min(500, spacing));
}

function spacingToSlider(spacing: number): number {
  const clean = Math.max(1, Math.min(500, spacing));
  const norm = Math.pow((clean - 1) / 499, 1 / 2.2);
  return Math.round(norm * 1000);
}

export const ToolOptionsBar: React.FC<ToolOptionsBarProps> = ({
  brushSettings,
  onChangeSettings,
  selectionSettings,
  onChangeSelectionSettings,
  pipetteSettings,
  onChangePipetteSettings,
  gradientSettings,
  onChangeGradientSettings,
  primaryColor,
  secondaryColor,
  showTileDebug,
  onToggleTileDebug,
  activeTool,
  onFlipHorizontal,
  onFlipVertical,
}) => {
  const isSelectionTool =
    activeTool === 'select-rect' ||
    activeTool === 'select-ellipse' ||
    activeTool === 'select-lasso' ||
    activeTool === 'magic-wand';

  return (
    <div className="h-8 bg-[#2b2b2b] select-none flex items-center px-3 text-xs text-[#dddddd] border-b border-[#1c1c1c] gap-3.5 overflow-x-auto scrollbar-none">
      <span className="font-semibold text-[#aaaaaa]">Opcje:</span>

      {activeTool === 'pipette' ? (
        /* PASEK OPCJI PIPETY */
        <div className="flex items-center gap-3.5 flex-1">
          <div className="flex items-center gap-1.5 text-[#00bcd4] font-medium text-xs bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#00bcd4]/30">
            <Pipette size={14} />
            <span>Pipeta (Próbnik kolorów)</span>
          </div>

          {/* Próbkowanie: Warstwa / Obraz */}
          <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Próbkowanie:</label>
            <select
              value={pipetteSettings.sampleSource}
              onChange={(e) =>
                onChangePipetteSettings({ sampleSource: e.target.value as 'image' | 'layer' })
              }
              className="h-5 bg-[#252525] border border-[#555] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer font-medium"
            >
              <option value="image">Obraz (Wszystkie warstwy)</option>
              <option value="layer">Warstwa (Tylko aktywna)</option>
            </select>
          </div>

          {/* Średnica obszaru zbierania */}
          <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Średnica obszaru:</label>
            <select
              value={
                [1, 3, 5, 11, 31, 51].includes(pipetteSettings.sampleDiameter)
                  ? pipetteSettings.sampleDiameter
                  : 'custom'
              }
              onChange={(e) => {
                if (e.target.value !== 'custom') {
                  onChangePipetteSettings({ sampleDiameter: parseInt(e.target.value) });
                }
              }}
              className="h-5 bg-[#252525] border border-[#555] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer"
            >
              <option value={1}>1 px (Pojedynczy punkt)</option>
              <option value={3}>3 px (Średnia 3×3)</option>
              <option value={5}>5 px (Średnia 5×5)</option>
              <option value={11}>11 px (Średnia 11×11)</option>
              <option value={31}>31 px (Średnia 31×31)</option>
              <option value={51}>51 px (Średnia 51×51)</option>
              <option value="custom">Własna...</option>
            </select>

            <div className="flex items-center gap-1 ml-1">
              <input
                type="number"
                min="1"
                max="101"
                value={pipetteSettings.sampleDiameter}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val)) {
                    onChangePipetteSettings({ sampleDiameter: Math.max(1, Math.min(101, val)) });
                  }
                }}
                className="w-12 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
              />
              <span className="text-[10px] text-[#888]">px</span>
              <input
                type="range"
                min="1"
                max="101"
                value={pipetteSettings.sampleDiameter}
                onChange={(e) => onChangePipetteSettings({ sampleDiameter: parseInt(e.target.value) })}
                className="w-20 h-1 bg-[#444] accent-[#00bcd4] rounded-lg appearance-none cursor-pointer"
                title="Średnica okręgu uśredniania kolorów wokół kliknięcia"
              />
            </div>
          </div>

          {/* Lupa przybliżenia */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] text-[#ccc] hover:text-white bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
            <input
              type="checkbox"
              checked={pipetteSettings.showLoupe}
              onChange={(e) => onChangePipetteSettings({ showLoupe: e.target.checked })}
              className="rounded bg-[#252525] border-[#555] text-[#00bcd4] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Lupa przybliżenia</span>
          </label>
        </div>
      ) : activeTool === 'transform-content' ? (
        /* PASEK OPCJI MODYFIKACJI ZAWARTOŚCI ZAZNACZENIA */
        <div className="flex items-center gap-3.5 flex-1">
          <div className="flex items-center gap-1.5 text-[#eab308] font-medium text-xs bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#eab308]/30">
            <Move size={14} />
            <span>Modyfikacja zawartości (Piksele)</span>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Próbkowanie (Interpolacja):</label>
            <select
              value={selectionSettings.interpolation || 'bilinear'}
              onChange={(e) =>
                onChangeSelectionSettings({ interpolation: e.target.value as InterpolationMode })
              }
              className="h-5 bg-[#1e1e1e] border border-[#eab308] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#facc15] cursor-pointer"
            >
              <option value="nearest-neighbor">Najbliższe sąsiedztwo (Pikselowe / Pixel Art)</option>
              <option value="bilinear">Dwuliniowe (Płynne / Bilinear)</option>
              <option value="bicubic">Dwusześcienne (Wysoka jakość / Bicubic)</option>
            </select>
          </div>

          <div className="flex items-center gap-1 bg-[#1e1e1e] p-0.5 rounded border border-[#3e3e3e]">
            <button
              type="button"
              onClick={onFlipHorizontal}
              className="flex items-center gap-1.5 px-2 py-0.5 text-xs bg-[#2b2b2b] hover:bg-[#383838] active:bg-[#444] text-white rounded border border-[#555] transition-colors cursor-pointer"
              title="Odbij zawartość w poziomie (Lustrzane odbicie lewo/prawo)"
            >
              <FlipHorizontal size={13} className="text-[#eab308]" />
              <span>Odbij w poziomie</span>
            </button>
            <button
              type="button"
              onClick={onFlipVertical}
              className="flex items-center gap-1.5 px-2 py-0.5 text-xs bg-[#2b2b2b] hover:bg-[#383838] active:bg-[#444] text-white rounded border border-[#555] transition-colors cursor-pointer"
              title="Odbij zawartość w pionie (Lustrzane odbicie góra/dół)"
            >
              <FlipVertical size={13} className="text-[#eab308]" />
              <span>Odbij w pionie</span>
            </button>
          </div>
        </div>
      ) : activeTool === 'transform-selection' ? (
        /* PASEK OPCJI MODYFIKACJI ZAZNACZENIA */
        <div className="flex items-center gap-3.5 flex-1">
          <div className="flex items-center gap-1.5 text-[#00bcd4] font-medium text-xs bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#00bcd4]/30">
            <Scaling size={14} />
            <span>Modyfikacja zaznaczenia</span>
          </div>

          <div className="flex items-center gap-1 bg-[#1e1e1e] p-0.5 rounded border border-[#3e3e3e]">
            <button
              type="button"
              onClick={onFlipHorizontal}
              className="flex items-center gap-1.5 px-2 py-0.5 text-xs bg-[#2b2b2b] hover:bg-[#383838] active:bg-[#444] text-white rounded border border-[#555] transition-colors cursor-pointer"
              title="Odbij zaznaczenie w poziomie (Lustrzane odbicie lewo/prawo)"
            >
              <FlipHorizontal size={13} className="text-[#00bcd4]" />
              <span>Odbij w poziomie</span>
            </button>
            <button
              type="button"
              onClick={onFlipVertical}
              className="flex items-center gap-1.5 px-2 py-0.5 text-xs bg-[#2b2b2b] hover:bg-[#383838] active:bg-[#444] text-white rounded border border-[#555] transition-colors cursor-pointer"
              title="Odbij zaznaczenie w pionie (Lustrzane odbicie góra/dół)"
            >
              <FlipVertical size={13} className="text-[#00bcd4]" />
              <span>Odbij w pionie</span>
            </button>
          </div>
        </div>
      ) : isSelectionTool ? (
        /* PASEK OPCJI ZAZNACZANIA (ZGODNY Z ZAŁĄCZONYM OBRAZKIEM) */
        <div className="flex items-center gap-3.5 flex-1">
          {/* Tryb zaznaczania: Zastąp, Dodaj, Odejmij, Część wspólna, Odwróć */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tryb:</label>
            <select
              value={selectionSettings.mode}
              onChange={(e) =>
                onChangeSelectionSettings({ mode: e.target.value as SelectionCombineMode })
              }
              className="h-5 bg-[#1e1e1e] border border-[#007acc] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#3894dc] cursor-pointer"
            >
              <option value="replace">Zastąp</option>
              <option value="add">Dodaj (Suma)</option>
              <option value="subtract">Odejmij (Różnica)</option>
              <option value="intersect">Część wspólna (Iloczyn)</option>
              <option value="invert">Odwróć (XOR)</option>
            </select>
          </div>

          {/* Ograniczenie rozmiaru: Dowolny, Stały stosunek, Stały rozmiar */}
          {activeTool !== 'select-lasso' && activeTool !== 'magic-wand' && (
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] whitespace-nowrap text-[#aaa]">Rozmiar:</label>
              <select
                value={selectionSettings.constraint}
                onChange={(e) =>
                  onChangeSelectionSettings({ constraint: e.target.value as SelectionConstraint })
                }
                className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
              >
                <option value="normal">Dowolny</option>
                <option value="fixed-ratio">Stały stosunek</option>
                <option value="fixed-size">Stały rozmiar</option>
              </select>

              {selectionSettings.constraint === 'fixed-ratio' && (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="1"
                    value={selectionSettings.ratioW}
                    onChange={(e) =>
                      onChangeSelectionSettings({ ratioW: Math.max(1, parseInt(e.target.value) || 1) })
                    }
                    className="w-10 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
                  />
                  <span>:</span>
                  <input
                    type="number"
                    min="1"
                    value={selectionSettings.ratioH}
                    onChange={(e) =>
                      onChangeSelectionSettings({ ratioH: Math.max(1, parseInt(e.target.value) || 1) })
                    }
                    className="w-10 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
                  />
                </div>
              )}

              {selectionSettings.constraint === 'fixed-size' && (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min="1"
                    value={selectionSettings.fixedW}
                    onChange={(e) =>
                      onChangeSelectionSettings({ fixedW: Math.max(1, parseInt(e.target.value) || 10) })
                    }
                    className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
                  />
                  <span>×</span>
                  <input
                    type="number"
                    min="1"
                    value={selectionSettings.fixedH}
                    onChange={(e) =>
                      onChangeSelectionSettings({ fixedH: Math.max(1, parseInt(e.target.value) || 10) })
                    }
                    className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
                  />
                  <span className="text-[10px] text-[#888]">px</span>
                </div>
              )}
            </div>
          )}

          {/* Piórkowanie (Feathering) */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Piórkowanie:</label>
            <input
              type="number"
              min="0"
              max="100"
              value={selectionSettings.feather}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeSelectionSettings({ feather: Math.max(0, Math.min(100, val)) });
                }
              }}
              className="w-10 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
            />
            <input
              type="range"
              min="0"
              max="100"
              value={selectionSettings.feather}
              onChange={(e) => onChangeSelectionSettings({ feather: parseInt(e.target.value) })}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Opcje Magicznej Różdżki: Próbkowanie, Wypełnianie oraz Czułość / Tolerancja */}
          {activeTool === 'magic-wand' && (
            <>
              <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Próbkowanie:</label>
                <select
                  value={selectionSettings.sampleSource || 'image'}
                  onChange={(e) =>
                    onChangeSelectionSettings({ sampleSource: e.target.value as 'image' | 'layer' })
                  }
                  className="h-5 bg-[#252525] border border-[#555] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer font-medium"
                >
                  <option value="image">Obraz (Wszystkie warstwy)</option>
                  <option value="layer">Warstwa (Tylko aktywna)</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Wypełnianie:</label>
                <select
                  value={selectionSettings.wandMode || 'contiguous'}
                  onChange={(e) =>
                    onChangeSelectionSettings({ wandMode: e.target.value as 'contiguous' | 'global' })
                  }
                  className="h-5 bg-[#252525] border border-[#555] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer"
                >
                  <option value="contiguous">Wskazany obszar (Ciągły)</option>
                  <option value="global">Na całym obrazie (Globalny)</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
                <label className="text-[11px] whitespace-nowrap text-[#00bcd4] font-medium">Czułość (Tolerancja):</label>
                <span className="text-[11px] text-white w-8 text-right font-mono">{selectionSettings.tolerance}%</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={selectionSettings.tolerance}
                  onChange={(e) => onChangeSelectionSettings({ tolerance: parseInt(e.target.value) })}
                  className="w-24 h-1 bg-[#444] accent-[#00bcd4] rounded-lg appearance-none cursor-pointer"
                  title="Dynamicznie przelicza zaznaczenie różdżki na żywo"
                />
              </div>
            </>
          )}
        </div>
      ) : (
        /* PASEK OPCJI NARZĘDZI MALARSKICH (PĘDZEL, GUMKA, KSZTAŁTY, WIADRO) */
        <div className="flex items-center gap-3.5 flex-1">
          {activeTool === 'bucket' ? (
            <>
              {/* Opcje Wiadra z Wodą: Próbkowanie, Wypełnianie, Czułość */}
              <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Próbkowanie:</label>
                <select
                  value={selectionSettings.sampleSource || 'image'}
                  onChange={(e) =>
                    onChangeSelectionSettings({ sampleSource: e.target.value as 'image' | 'layer' })
                  }
                  className="h-5 bg-[#252525] border border-[#555] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#ff9800] cursor-pointer font-medium"
                >
                  <option value="image">Obraz (Wszystkie warstwy)</option>
                  <option value="layer">Warstwa (Tylko aktywna)</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Wypełnianie:</label>
                <select
                  value={selectionSettings.wandMode || 'contiguous'}
                  onChange={(e) =>
                    onChangeSelectionSettings({ wandMode: e.target.value as 'contiguous' | 'global' })
                  }
                  className="h-5 bg-[#252525] border border-[#555] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#ff9800] cursor-pointer"
                >
                  <option value="contiguous">Wskazany obszar (Ciągły)</option>
                  <option value="global">Na całym obrazie (Globalny)</option>
                </select>
              </div>

              <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
                <label className="text-[11px] whitespace-nowrap text-[#ff9800] font-medium">Czułość (Tolerancja):</label>
                <span className="text-[11px] text-white w-8 text-right font-mono">{selectionSettings.tolerance}%</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={selectionSettings.tolerance}
                  onChange={(e) => onChangeSelectionSettings({ tolerance: parseInt(e.target.value) })}
                  className="w-24 h-1 bg-[#444] accent-[#ff9800] rounded-lg appearance-none cursor-pointer"
                  title="Dynamicznie przelicza wypełnienie wiaderkiem na żywo"
                />
              </div>
            </>
          ) : activeTool === 'gradient' ? (
            <>
              {/* Opcje Narzędzia Gradient */}
              <div className="flex items-center gap-1.5 text-[#38bdf8] font-medium text-xs bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#38bdf8]/30">
                <Blend size={14} />
                <span>Gradient</span>
              </div>

              {/* Kształt gradientu */}
              <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Kształt:</label>
                <select
                  value={gradientSettings?.type || 'linear'}
                  onChange={(e) =>
                    onChangeGradientSettings?.({ type: e.target.value as GradientType })
                  }
                  className="h-5 bg-[#252525] border border-[#555] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#38bdf8] cursor-pointer font-medium"
                >
                  <option value="linear">Liniowy</option>
                  <option value="reflected">Liniowy lustrzany</option>
                  <option value="diamond">Diamentowy</option>
                  <option value="radial">Kolisty</option>
                  <option value="conic">Stożkowy</option>
                  <option value="spiral-left">Spirala lewa</option>
                  <option value="spiral-right">Spirala prawa</option>
                </select>
              </div>

              {/* Powtarzanie */}
              <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-2 py-0.5 rounded border border-[#3e3e3e]">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Powtarzanie:</label>
                <select
                  value={gradientSettings?.repeat || 'none'}
                  onChange={(e) =>
                    onChangeGradientSettings?.({ repeat: e.target.value as GradientRepeatMode })
                  }
                  className="h-5 bg-[#252525] border border-[#555] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#38bdf8] cursor-pointer"
                >
                  <option value="none">Nie powtarzaj</option>
                  <option value="repeat">Powtarzaj w nieskończoność</option>
                </select>
              </div>

              {/* Odwróć kolory */}
              <button
                type="button"
                onClick={() => onChangeGradientSettings?.({ reverse: !gradientSettings?.reverse })}
                title="Odwróć kierunek kolorów gradientu"
                className={`flex items-center gap-1 px-2 h-5 rounded text-xs border transition-colors cursor-pointer ${
                  gradientSettings?.reverse
                    ? 'bg-[#0284c7] border-[#38bdf8] text-white font-medium'
                    : 'bg-[#252525] border-[#444] text-[#ccc] hover:bg-[#333]'
                }`}
              >
                <ArrowLeftRight size={12} />
                <span>Odwróć</span>
              </button>

              {/* Miniaturka podglądu gradientu */}
              {primaryColor && secondaryColor && (
                <div
                  className="h-5 w-24 rounded border border-[#555] relative overflow-hidden flex-shrink-0"
                  title="Podgląd przejścia kolorów (kolor główny -> dodatkowy)"
                  style={{
                    backgroundImage: `linear-gradient(45deg, #444 25%, transparent 25%), linear-gradient(-45deg, #444 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #444 75%), linear-gradient(-45deg, transparent 75%, #444 75%)`,
                    backgroundSize: '8px 8px',
                    backgroundColor: '#222',
                  }}
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      background: `linear-gradient(to right, ${
                        gradientSettings?.reverse
                          ? `rgba(${secondaryColor.r}, ${secondaryColor.g}, ${secondaryColor.b}, ${secondaryColor.a / 255}), rgba(${primaryColor.r}, ${primaryColor.g}, ${primaryColor.b}, ${primaryColor.a / 255})`
                          : `rgba(${primaryColor.r}, ${primaryColor.g}, ${primaryColor.b}, ${primaryColor.a / 255}), rgba(${secondaryColor.r}, ${secondaryColor.g}, ${secondaryColor.b}, ${secondaryColor.a / 255})`
                      })`,
                    }}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              {/* Rozmiar pędzla */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Rozmiar:</label>
            <input
              type="number"
              min="1"
              max="2000"
              value={brushSettings.size}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeSettings({ size: Math.max(1, Math.min(2000, val)) });
                }
              }}
              className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <input
              type="range"
              min="0"
              max="1000"
              value={sizeToSlider(brushSettings.size)}
              onChange={(e) => {
                const size = sliderToSize(parseInt(e.target.value));
                onChangeSettings({ size });
              }}
              className="w-24 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
              title={`Rozmiar pędzla: ${brushSettings.size} px`}
            />
          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <span className="text-[11px] text-[#ccc] w-9 text-right font-mono">{brushSettings.hardness}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={brushSettings.hardness}
              onChange={(e) => onChangeSettings({ hardness: parseInt(e.target.value) })}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Wygładzanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white">
            <input
              type="checkbox"
              checked={brushSettings.antiAliasing}
              onChange={(e) => onChangeSettings({ antiAliasing: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#007acc] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Wygładzanie</span>
          </label>

          {/* Odstęp */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Odstęp:</label>
            <input
              type="number"
              min="1"
              max="500"
              value={brushSettings.spacing}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeSettings({ spacing: Math.max(1, Math.min(500, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <span className="text-[10px] text-[#888]">%</span>
            <input
              type="range"
              min="0"
              max="1000"
              value={spacingToSlider(brushSettings.spacing)}
              onChange={(e) => {
                const spacing = sliderToSpacing(parseInt(e.target.value));
                onChangeSettings({ spacing });
              }}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
              title={`Odstęp stempli: ${brushSettings.spacing}% średnicy pędzla`}
            />
          </div>

            </>
          )}

          {/* Tryb mieszania pędzla / wylewania */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Tryb:</label>
            <select
              value={brushSettings.blendMode}
              onChange={(e) => onChangeSettings({ blendMode: e.target.value as SKBlendMode })}
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              {BLEND_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.namePl}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Wizualizacja kafelków Skia / DirtyRect Debug */}
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleTileDebug}
          className={`px-2 py-0.5 text-[10px] rounded border transition-colors cursor-pointer ${
            showTileDebug
              ? 'bg-[#007acc] border-[#3894dc] text-white font-medium'
              : 'bg-[#222222] border-[#444444] text-[#888888] hover:text-[#cccccc]'
          }`}
          title="Przełącz podgląd siatki kafelków pamięci i Dirty-Rect"
        >
          Siatka kafelków
        </button>
      </div>
    </div>
  );
};
