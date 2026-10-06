/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  FlipHorizontal,
  FlipVertical,
  ArrowLeftRight,
} from 'lucide-react';
import {
  BLEND_MODES,
  BrushSettings,
  ColorReplaceMode,
  ColorReplaceSettings,
  CorrectionBrushSettings,
  CorrectionBrushType,
  DeformActionType,
  DeformSettings,
  GradientSettings,
  LineAndCurveSettings,
  MarkerType,
  PipetteSettings,
  SKBlendMode,
  SKColor,
  SelectionSettings,
  ShapeFillMode,
  ShapeKind,
  StampSampleSource,
  StampSettings,
  StampSourceMode,
  StrokeAlignment,
  StrokeCornerJoin,
  StrokeDashStyle,
  VectorShapeSettings,
} from '../core/skia/types.ts';

interface ToolOptionsBarProps {
  brushSettings: BrushSettings;
  onChangeSettings: (newSettings: Partial<BrushSettings>) => void;
  correctionBrushSettings?: CorrectionBrushSettings;
  onChangeCorrectionBrushSettings?: (newSettings: Partial<CorrectionBrushSettings>) => void;
  deformSettings?: DeformSettings;
  onChangeDeformSettings?: (newSettings: Partial<DeformSettings>) => void;
  colorReplaceSettings?: ColorReplaceSettings;
  onChangeColorReplaceSettings?: (newSettings: Partial<ColorReplaceSettings>) => void;
  stampSettings?: StampSettings;
  onChangeStampSettings?: (newSettings: Partial<StampSettings>) => void;
  stampBasePoint?: { x: number; y: number } | null;
  onResetStampBasePoint?: () => void;
  selectionSettings: SelectionSettings;
  onChangeSelectionSettings: (newSettings: Partial<SelectionSettings>) => void;
  pipetteSettings: PipetteSettings;
  onChangePipetteSettings: (newSettings: Partial<PipetteSettings>) => void;
  gradientSettings?: GradientSettings;
  onChangeGradientSettings?: (newSettings: Partial<GradientSettings>) => void;
  vectorShapeSettings: VectorShapeSettings;
  onChangeVectorShapeSettings: (newSettings: Partial<VectorShapeSettings>) => void;
  lineAndCurveSettings: LineAndCurveSettings;
  onChangeLineAndCurveSettings: (newSettings: Partial<LineAndCurveSettings>) => void;
  primaryColor?: SKColor;
  secondaryColor?: SKColor;
  onChangePrimaryColorAlpha?: (alpha: number) => void;
  activeTool: string;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
  isLiveVectorSessionActive?: boolean;
  onCommitLiveVectorSession?: () => void;
  onCancelLiveVectorSession?: () => void;
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
  correctionBrushSettings = {
    brushType: 'dodge-burn',
    size: 20,
    hardness: 90,
    antiAliasing: true,
    spacing: 15,
    invertAction: false,
  },
  onChangeCorrectionBrushSettings,
  colorReplaceSettings = {
    size: 20,
    hardness: 90,
    antiAliasing: true,
    spacing: 15,
    tolerance: 30,
    mode: 'single',
  },
  onChangeColorReplaceSettings,
  stampSettings = {
    size: 30,
    hardness: 85,
    antiAliasing: true,
    spacing: 15,
    blendMode: 'SrcOver',
    sampleSource: 'image',
    sourceMode: 'relative',
  },
  onChangeStampSettings,
  stampBasePoint,
  onResetStampBasePoint,
  deformSettings = {
    actionType: 'expand-shrink',
    size: 60,
    hardness: 50,
    antiAliasing: true,
    spacing: 15,
    invertAction: false,
  },
  onChangeDeformSettings,
  selectionSettings,
  onChangeSelectionSettings,
  pipetteSettings,
  onChangePipetteSettings,
  gradientSettings,
  onChangeGradientSettings,
  vectorShapeSettings,
  onChangeVectorShapeSettings,
  lineAndCurveSettings,
  onChangeLineAndCurveSettings,
  primaryColor,
  secondaryColor,
  onChangePrimaryColorAlpha,
  activeTool,
  onFlipHorizontal,
  onFlipVertical,
  isLiveVectorSessionActive = false,
  onCommitLiveVectorSession,
  onCancelLiveVectorSession,
}) => {
  const isSelectionTool =
    activeTool === 'select-rect' ||
    activeTool === 'select-ellipse' ||
    activeTool === 'select-lasso' ||
    activeTool === 'magic-wand';

  const isLineOrCurve = activeTool === 'line' || activeTool === 'bezier';
  const isShapeTool = activeTool === 'shapes';

  return (
    <div className="h-8 bg-[#2b2b2b] select-none flex items-center px-3 text-xs text-[#dddddd] border-b border-[#1c1c1c] gap-3.5 overflow-x-auto scrollbar-none flex-nowrap">
      <span className="font-semibold text-[#aaaaaa] flex-shrink-0">Opcje:</span>

      {/* 1. OPCJE LINII I KRZYWEJ BEZIERA */}
      {isLineOrCurve ? (
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Grubość linii */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Grubość:</label>
            <input
              type="number"
              min="1"
              max="200"
              value={lineAndCurveSettings.strokeWidth}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeLineAndCurveSettings({ strokeWidth: Math.max(1, Math.min(200, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <span className="text-[10px] text-[#888]">px</span>
            <input
              type="range"
              min="1"
              max="100"
              value={lineAndCurveSettings.strokeWidth}
              onChange={(e) => onChangeLineAndCurveSettings({ strokeWidth: parseInt(e.target.value) })}
              className="w-16 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Kreskowanie */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Kreskowanie:</label>
            <select
              value={lineAndCurveSettings.dashStyle}
              onChange={(e) =>
                onChangeLineAndCurveSettings({ dashStyle: e.target.value as StrokeDashStyle })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              <option value="solid">Ciągła ──────</option>
              <option value="dashed">Kreskowana ── ──</option>
              <option value="dotted">Kropkowana ••••••</option>
              <option value="dash-dot">Kreska-kropka ── • ──</option>
              <option value="long-dash">Długa kreska ──── ────</option>
            </select>
          </div>

          {/* Znacznik początku */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Początek:</label>
            <select
              value={lineAndCurveSettings.startMarker}
              onChange={(e) =>
                onChangeLineAndCurveSettings({ startMarker: e.target.value as MarkerType })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              <option value="none">Brak</option>
              <option value="arrow">Strzałka</option>
              <option value="stealth-arrow">Grot ostry</option>
              <option value="circle">Koło</option>
              <option value="square">Kwadrat</option>
              <option value="diamond">Romb</option>
            </select>
          </div>

          {/* Znacznik końca */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Koniec:</label>
            <select
              value={lineAndCurveSettings.endMarker}
              onChange={(e) =>
                onChangeLineAndCurveSettings({ endMarker: e.target.value as MarkerType })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              <option value="none">Brak</option>
              <option value="arrow">Strzałka</option>
              <option value="stealth-arrow">Grot ostry</option>
              <option value="circle">Koło</option>
              <option value="square">Kwadrat</option>
              <option value="diamond">Romb</option>
            </select>
          </div>

          {/* Rozmiar znacznika */}
          {(lineAndCurveSettings.startMarker !== 'none' || lineAndCurveSettings.endMarker !== 'none') && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <label className="text-[11px] whitespace-nowrap text-[#aaa]">Grot:</label>
              <select
                value={lineAndCurveSettings.markerSize}
                onChange={(e) =>
                  onChangeLineAndCurveSettings({ markerSize: parseFloat(e.target.value) })
                }
                className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer font-mono"
              >
                <option value={0.7}>Mały (0.7x)</option>
                <option value={1.0}>Średni (1.0x)</option>
                <option value={1.5}>Duży (1.5x)</option>
                <option value={2.2}>Bardzo duży (2.2x)</option>
              </select>
            </div>
          )}

          {/* Wygładzanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white flex-shrink-0">
            <input
              type="checkbox"
              checked={lineAndCurveSettings.antiAliasing}
              onChange={(e) => onChangeLineAndCurveSettings({ antiAliasing: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#007acc] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Wygładzanie</span>
          </label>

          {/* Tryb mieszania */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Mieszanie:</label>
            <select
              value={lineAndCurveSettings.blendMode}
              onChange={(e) => onChangeLineAndCurveSettings({ blendMode: e.target.value as SKBlendMode })}
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
      ) : isShapeTool ? (
        /* 2. OPCJE FIGUR GEOMETRYCZNYCH */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Wybór kształtu */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Kształt:</label>
            <select
              value={vectorShapeSettings.shapeKind}
              onChange={(e) =>
                onChangeVectorShapeSettings({ shapeKind: e.target.value as ShapeKind })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer font-medium"
            >
              <option value="rect">Prostokąt</option>
              <option value="round-rect">Zaokrąglony prostokąt</option>
              <option value="ellipse">Elipsa / Koło</option>
              <option value="triangle">Trójkąt</option>
              <option value="star">Gwiazda</option>
              <option value="polygon">Wielokąt</option>
              <option value="arrow">Strzałka</option>
              <option value="heart">Serce</option>
              <option value="diamond">Romb</option>
            </select>
          </div>

          {/* Sposób wypełnienia */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Wypełnienie:</label>
            <select
              value={vectorShapeSettings.fillMode}
              onChange={(e) =>
                onChangeVectorShapeSettings({ fillMode: e.target.value as ShapeFillMode })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer font-medium"
            >
              <option value="none">tylko obrys</option>
              <option value="primary">kolor główny</option>
              <option value="stroke-and-fill">kolor dodatkowy</option>
            </select>
          </div>

          {/* Grubość obrysu */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Obrys:</label>
            <input
              type="number"
              min="0"
              max="200"
              value={vectorShapeSettings.strokeWidth}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeVectorShapeSettings({ strokeWidth: Math.max(0, Math.min(200, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <span className="text-[10px] text-[#888]">px</span>
            <input
              type="range"
              min="0"
              max="100"
              value={vectorShapeSettings.strokeWidth}
              onChange={(e) => onChangeVectorShapeSettings({ strokeWidth: parseInt(e.target.value) })}
              className="w-16 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Narożnik */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Narożnik:</label>
            <select
              value={vectorShapeSettings.strokeCornerJoin}
              onChange={(e) =>
                onChangeVectorShapeSettings({ strokeCornerJoin: e.target.value as StrokeCornerJoin })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              <option value="miter">Prosty / Ostry</option>
              <option value="round">Zaokrąglony</option>
              <option value="bevel">Ścięty</option>
            </select>
          </div>

          {/* Wyrównanie obrysu */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Wyrównanie:</label>
            <select
              value={vectorShapeSettings.strokeAlignment}
              onChange={(e) =>
                onChangeVectorShapeSettings({ strokeAlignment: e.target.value as StrokeAlignment })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              <option value="center">Do środka</option>
              <option value="inside">Do wewnątrz</option>
              <option value="outside">Do zewnątrz</option>
            </select>
          </div>

          {/* Opcje specyficzne dla kształtu */}
          {vectorShapeSettings.shapeKind === 'round-rect' && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <label className="text-[11px] whitespace-nowrap text-[#aaa]">Promień:</label>
              <input
                type="number"
                min="0"
                max="200"
                value={vectorShapeSettings.cornerRadius}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val)) onChangeVectorShapeSettings({ cornerRadius: Math.max(0, val) });
                }}
                className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
              />
              <span className="text-[10px] text-[#888]">px</span>
            </div>
          )}

          {vectorShapeSettings.shapeKind === 'star' && (
            <>
              <div className="flex items-center gap-1 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Ramiona:</label>
                <input
                  type="number"
                  min="3"
                  max="32"
                  value={vectorShapeSettings.starPoints}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val)) onChangeVectorShapeSettings({ starPoints: Math.max(3, Math.min(32, val)) });
                  }}
                  className="w-10 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
                />
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Ostrość:</label>
                <span className="text-[10px] text-[#ccc] font-mono">{Math.round((1 - vectorShapeSettings.starInnerRatio) * 100)}%</span>
                <input
                  type="range"
                  min="10"
                  max="90"
                  value={Math.round(vectorShapeSettings.starInnerRatio * 100)}
                  onChange={(e) => onChangeVectorShapeSettings({ starInnerRatio: parseInt(e.target.value) / 100 })}
                  className="w-14 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </>
          )}

          {vectorShapeSettings.shapeKind === 'polygon' && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <label className="text-[11px] whitespace-nowrap text-[#aaa]">Boki:</label>
              <input
                type="number"
                min="3"
                max="16"
                value={vectorShapeSettings.polygonSides}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  if (!isNaN(val)) onChangeVectorShapeSettings({ polygonSides: Math.max(3, Math.min(16, val)) });
                }}
                className="w-10 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
              />
            </div>
          )}

          {vectorShapeSettings.shapeKind === 'arrow' && (
            <>
              <div className="flex items-center gap-1 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Grot:</label>
                <span className="text-[10px] text-[#ccc] font-mono">{Math.round(vectorShapeSettings.arrowHeadWidth * 100)}%</span>
                <input
                  type="range"
                  min="15"
                  max="85"
                  value={Math.round(vectorShapeSettings.arrowHeadWidth * 100)}
                  onChange={(e) => onChangeVectorShapeSettings({ arrowHeadWidth: parseInt(e.target.value) / 100 })}
                  className="w-14 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
                />
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Trzon:</label>
                <span className="text-[10px] text-[#ccc] font-mono">{Math.round(vectorShapeSettings.arrowShaftThickness * 100)}%</span>
                <input
                  type="range"
                  min="10"
                  max="85"
                  value={Math.round(vectorShapeSettings.arrowShaftThickness * 100)}
                  onChange={(e) => onChangeVectorShapeSettings({ arrowShaftThickness: parseInt(e.target.value) / 100 })}
                  className="w-14 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
                />
              </div>
            </>
          )}

          {/* Wygładzanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white flex-shrink-0">
            <input
              type="checkbox"
              checked={vectorShapeSettings.antiAliasing}
              onChange={(e) => onChangeVectorShapeSettings({ antiAliasing: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#007acc] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Wygładzanie</span>
          </label>

          {/* Tryb mieszania */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Mieszanie:</label>
            <select
              value={vectorShapeSettings.blendMode}
              onChange={(e) => onChangeVectorShapeSettings({ blendMode: e.target.value as SKBlendMode })}
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
      ) : activeTool === 'pipette' ? (
        /* 3. PASEK OPCJI PIPETY */
        <div className="flex items-center gap-3.5 flex-1 flex-shrink-0">
          {/* Próbkowanie: Warstwa / Obraz */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Próbkowanie:</label>
            <select
              value={pipetteSettings.sampleSource}
              onChange={(e) =>
                onChangePipetteSettings({ sampleSource: e.target.value as 'image' | 'layer' })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer font-medium"
            >
              <option value="image">Obraz</option>
              <option value="layer">Warstwa</option>
            </select>
          </div>

          {/* Średnica obszaru zbierania */}
          <div className="flex items-center gap-1.5">
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
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer"
            >
              <option value={1}>1 px</option>
              <option value={3}>3 px</option>
              <option value={5}>5 px</option>
              <option value={11}>11 px</option>
              <option value={31}>31 px</option>
              <option value={51}>51 px</option>
              <option value="custom">Własna...</option>
            </select>

            <div className="flex items-center gap-1">
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
                className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
              />
              <span className="text-[10px] text-[#888]">px</span>
            </div>
          </div>

          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white">
            <input
              type="checkbox"
              checked={pipetteSettings.showLoupe}
              onChange={(e) => onChangePipetteSettings({ showLoupe: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#00bcd4] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Pokaż lupę</span>
          </label>
        </div>
      ) : activeTool === 'transform-selection' || activeTool === 'transform-content' ? (
        /* 4. PASEK OPCJI PRZEKSZTAŁCANIA */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {activeTool === 'transform-content' && (
            <div className="flex items-center gap-1.5">
              <label className="text-[11px] whitespace-nowrap text-[#aaa]">Próbkowanie:</label>
              <select
                value={selectionSettings.interpolation || 'bilinear'}
                onChange={(e) =>
                  onChangeSelectionSettings({
                    interpolation: e.target.value as 'nearest-neighbor' | 'bilinear' | 'bicubic',
                  })
                }
                className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer font-medium"
              >
                <option value="nearest-neighbor">Najbliższe sąsiedztwo</option>
                <option value="bilinear">Dwuliniowe</option>
                <option value="bicubic">Dwusześcienne</option>
              </select>
            </div>
          )}

          <div className="flex items-center gap-1 border-l border-[#444] pl-2">
            <button
              type="button"
              onClick={onFlipHorizontal}
              title="Odbij poziomo (Lustro w poziomie)"
              className="flex items-center gap-1 px-2 h-5 bg-[#1e1e1e] hover:bg-[#333] text-[#ddd] hover:text-white rounded border border-[#444] text-[11px] cursor-pointer"
            >
              <FlipHorizontal size={13} />
              <span>Odbij w poziomie</span>
            </button>
            <button
              type="button"
              onClick={onFlipVertical}
              title="Odbij pionowo (Lustro w pionie)"
              className="flex items-center gap-1 px-2 h-5 bg-[#1e1e1e] hover:bg-[#333] text-[#ddd] hover:text-white rounded border border-[#444] text-[11px] cursor-pointer"
            >
              <FlipVertical size={13} />
              <span>Odbij w pionie</span>
            </button>
          </div>
        </div>
      ) : isSelectionTool ? (
        /* 5. PASEK OPCJI ZAZNACZANIA */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tryb:</label>
            <select
              value={selectionSettings.mode}
              onChange={(e) =>
                onChangeSelectionSettings({ mode: e.target.value as SelectionSettings['mode'] })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              <option value="replace">Zastąp zaznaczenie</option>
              <option value="add">Dodaj do zaznaczenia (Shift)</option>
              <option value="subtract">Odejmij od zaznaczenia (Alt)</option>
              <option value="intersect">Część wspólna (Shift+Alt)</option>
              <option value="invert">Odwróć zaznaczenie</option>
            </select>
          </div>

          {/* Opcje ograniczenia rozmiaru dla zaznaczenia prostokątnego i eliptycznego */}
          {(activeTool === 'select-rect' || activeTool === 'select-ellipse') && (
            <>
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Rozmiar:</label>
                <select
                  value={selectionSettings.constraint || 'normal'}
                  onChange={(e) =>
                    onChangeSelectionSettings({
                      constraint: e.target.value as SelectionSettings['constraint'],
                    })
                  }
                  className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer font-medium"
                >
                  <option value="normal">Dowolny rozmiar</option>
                  <option value="fixed-ratio">Ustalone proporcje</option>
                  <option value="fixed-size">Ustalone wymiary</option>
                </select>
              </div>

              {selectionSettings.constraint === 'fixed-ratio' && (
                <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-1.5 py-0.5 rounded border border-[#3e3e3e]">
                  <label className="text-[11px] whitespace-nowrap text-[#aaa]">Proporcja:</label>
                  <input
                    type="number"
                    min="0.1"
                    step="0.5"
                    value={selectionSettings.ratioW}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val) && val > 0) {
                        onChangeSelectionSettings({ ratioW: val });
                      }
                    }}
                    className="w-11 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
                    title="Szerokość proporcji"
                  />
                  <span className="text-xs text-[#888] font-bold">:</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.5"
                    value={selectionSettings.ratioH}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      if (!isNaN(val) && val > 0) {
                        onChangeSelectionSettings({ ratioH: val });
                      }
                    }}
                    className="w-11 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
                    title="Wysokość proporcji"
                  />
                </div>
              )}

              {selectionSettings.constraint === 'fixed-size' && (
                <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-1.5 py-0.5 rounded border border-[#3e3e3e]">
                  <label className="text-[11px] whitespace-nowrap text-[#aaa]">Szer.:</label>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={selectionSettings.fixedW}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      if (!isNaN(val) && val > 0) {
                        onChangeSelectionSettings({ fixedW: val });
                      }
                    }}
                    className="w-14 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
                  />
                  <span className="text-[10px] text-[#888]">px</span>

                  <label className="text-[11px] whitespace-nowrap text-[#aaa] ml-1">Wys.:</label>
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={selectionSettings.fixedH}
                    onChange={(e) => {
                      const val = parseInt(e.target.value);
                      if (!isNaN(val) && val > 0) {
                        onChangeSelectionSettings({ fixedH: val });
                      }
                    }}
                    className="w-14 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
                  />
                  <span className="text-[10px] text-[#888]">px</span>
                </div>
              )}
            </>
          )}

          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Wtapianie:</label>
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
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
            />
            <span className="text-[10px] text-[#888]">px</span>
          </div>

          {activeTool === 'magic-wand' && (
            <>
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tolerancja:</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={selectionSettings.tolerance}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    if (!isNaN(val)) {
                      onChangeSelectionSettings({ tolerance: Math.max(0, Math.min(100, val)) });
                    }
                  }}
                  className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
                />
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={selectionSettings.tolerance}
                  onChange={(e) => {
                    onChangeSelectionSettings({ tolerance: parseInt(e.target.value) });
                  }}
                  className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
                  title={`Tolerancja próbkowania: ${selectionSettings.tolerance}%`}
                />
                <span className="text-[10px] text-[#888] font-mono w-6">{selectionSettings.tolerance}%</span>
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Zakres:</label>
                <select
                  value={selectionSettings.wandMode}
                  onChange={(e) =>
                    onChangeSelectionSettings({
                      wandMode: e.target.value as SelectionSettings['wandMode'],
                    })
                  }
                  className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white"
                >
                  <option value="contiguous">Obszar ciągły</option>
                  <option value="global">Cały obraz</option>
                </select>
              </div>

              {/* Próbkowanie dla Magicznej różdżki (Obraz / Warstwa) */}
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Próbkowanie:</label>
                <select
                  value={selectionSettings.sampleSource || 'image'}
                  onChange={(e) =>
                    onChangeSelectionSettings({
                      sampleSource: e.target.value as 'image' | 'layer',
                    })
                  }
                  className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
                >
                  <option value="image">Obraz</option>
                  <option value="layer">Warstwa</option>
                </select>
              </div>
            </>
          )}
        </div>
      ) : activeTool === 'gradient' ? (
        /* 6. PASEK OPCJI GRADIENTU */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Kształt:</label>
            <select
              value={gradientSettings?.type || 'linear'}
              onChange={(e) =>
                onChangeGradientSettings?.({ type: e.target.value as GradientSettings['type'] })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer"
            >
              <option value="linear">Liniowy</option>
              <option value="radial">Kolisty</option>
              <option value="reflected">Lustrzany</option>
              <option value="diamond">Diamentowy</option>
              <option value="conic">Stożkowy</option>
              <option value="spiral-left">Spirala lewa</option>
              <option value="spiral-right">Spirala prawa</option>
            </select>
          </div>

          {/* Powtarzanie */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Powtarzanie:</label>
            <select
              value={gradientSettings?.repeat || 'none'}
              onChange={(e) =>
                onChangeGradientSettings?.({ repeat: e.target.value as any })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer"
            >
              <option value="none">Nie powtarzaj</option>
              <option value="repeat">Powtarzaj</option>
            </select>
          </div>

          {/* Mieszanie */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Mieszanie:</label>
            <select
              value={gradientSettings?.blendMode || 'SrcOver'}
              onChange={(e) =>
                onChangeGradientSettings?.({ blendMode: e.target.value as SKBlendMode })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#00bcd4] cursor-pointer"
            >
              {BLEND_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.namePl}
                </option>
              ))}
            </select>
          </div>

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
        </div>
      ) : activeTool === 'bucket' ? (
        /* 7. PASEK OPCJI WIADRA Z FARBĄ */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Tolerancja */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tolerancja:</label>
            <input
              type="number"
              min="0"
              max="100"
              value={selectionSettings.tolerance}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeSelectionSettings({ tolerance: Math.max(0, Math.min(100, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
            />
            <input
              type="range"
              min="0"
              max="100"
              value={selectionSettings.tolerance}
              onChange={(e) => {
                onChangeSelectionSettings({ tolerance: parseInt(e.target.value) });
              }}
              className="w-20 h-1 bg-[#444] accent-[#ff9800] rounded-lg appearance-none cursor-pointer"
              title={`Tolerancja próbkowania: ${selectionSettings.tolerance}%`}
            />
            <span className="text-[10px] text-[#888] font-mono w-6">{selectionSettings.tolerance}%</span>
          </div>

          {/* Zakres / Ciągłość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Zakres:</label>
            <select
              value={selectionSettings.wandMode || 'contiguous'}
              onChange={(e) =>
                onChangeSelectionSettings({
                  wandMode: e.target.value as SelectionSettings['wandMode'],
                })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#ff9800] cursor-pointer"
            >
              <option value="contiguous">Obszar ciągły</option>
              <option value="global">Cały obraz</option>
            </select>
          </div>

          {/* Próbkowanie */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Próbkowanie:</label>
            <select
              value={selectionSettings.sampleSource || 'image'}
              onChange={(e) =>
                onChangeSelectionSettings({
                  sampleSource: e.target.value as SelectionSettings['sampleSource'],
                })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#ff9800] cursor-pointer font-medium"
            >
              <option value="image">Obraz</option>
              <option value="layer">Warstwa</option>
            </select>
          </div>

          {/* Wygładzanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white">
            <input
              type="checkbox"
              checked={brushSettings.antiAliasing}
              onChange={(e) => onChangeSettings({ antiAliasing: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#ff9800] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Wygładzanie</span>
          </label>

          {/* Tryb mieszania */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Mieszanie:</label>
            <select
              value={brushSettings.blendMode}
              onChange={(e) => onChangeSettings({ blendMode: e.target.value as SKBlendMode })}
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#ff9800] cursor-pointer"
            >
              {BLEND_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.namePl}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : activeTool === 'correction-brush' ? (
        /* 7b. PASEK OPCJI PĘDZLA KOREKCYJNEGO */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Rodzaj korekcji */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Działanie:</label>
            <select
              value={correctionBrushSettings.brushType}
              onChange={(e) =>
                onChangeCorrectionBrushSettings?.({
                  brushType: e.target.value as CorrectionBrushType,
                })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer font-medium"
            >
              <option value="dodge-burn">Rozjaśnij / Ściemnij</option>
              <option value="blur-sharpen">Rozmyj / Wyostrz</option>
              <option value="saturate-desaturate">Saturuj / Desaturuj</option>
            </select>
          </div>

          {/* Rozmiar */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Rozmiar:</label>
            <input
              type="number"
              min="1"
              max="2000"
              value={correctionBrushSettings.size}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeCorrectionBrushSettings?.({ size: Math.max(1, Math.min(2000, val)) });
                }
              }}
              className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <input
              type="range"
              min="0"
              max="1000"
              value={sizeToSlider(correctionBrushSettings.size)}
              onChange={(e) => {
                const size = sliderToSize(parseInt(e.target.value));
                onChangeCorrectionBrushSettings?.({ size });
              }}
              className="w-24 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
              title={`Rozmiar: ${correctionBrushSettings.size} px`}
            />
          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <span className="text-[11px] text-[#ccc] w-9 text-right font-mono">{correctionBrushSettings.hardness}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={correctionBrushSettings.hardness}
              onChange={(e) => onChangeCorrectionBrushSettings?.({ hardness: parseInt(e.target.value) })}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Wygładzanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white">
            <input
              type="checkbox"
              checked={correctionBrushSettings.antiAliasing}
              onChange={(e) => onChangeCorrectionBrushSettings?.({ antiAliasing: e.target.checked })}
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
              value={correctionBrushSettings.spacing}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeCorrectionBrushSettings?.({ spacing: Math.max(1, Math.min(500, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <span className="text-[10px] text-[#888]">%</span>
            <input
              type="range"
              min="0"
              max="1000"
              value={spacingToSlider(correctionBrushSettings.spacing)}
              onChange={(e) => {
                const spacing = sliderToSpacing(parseInt(e.target.value));
                onChangeCorrectionBrushSettings?.({ spacing });
              }}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Odwróć działanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white border-l border-[#444] pl-2.5">
            <input
              type="checkbox"
              checked={correctionBrushSettings.invertAction}
              onChange={(e) => onChangeCorrectionBrushSettings?.({ invertAction: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#007acc] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Odwróć działanie</span>
          </label>

          {/* Intensywność (zależna od kanału Alfa) */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Intensywność:</label>
            <span className="text-[11px] text-[#ccc] w-9 text-right font-mono">
              {Math.round(((primaryColor?.a ?? 255) / 255) * 100)}%
            </span>
            <input
              type="range"
              min="1"
              max="255"
              value={primaryColor?.a ?? 255}
              onChange={(e) => {
                const a = parseInt(e.target.value);
                onChangePrimaryColorAlpha?.(a);
              }}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
              title={`Intensywność: ${Math.round(((primaryColor?.a ?? 255) / 255) * 100)}%`}
            />
          </div>
        </div>
      ) : activeTool === 'color-replace' ? (
        /* 7c. PASEK OPCJI PĘDZLA ZMIANY KOLORU */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Tryb: Pojedynczy / Kolor dodatkowy */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tryb:</label>
            <select
              value={colorReplaceSettings.mode}
              onChange={(e) =>
                onChangeColorReplaceSettings?.({
                  mode: e.target.value as ColorReplaceMode,
                })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#10b981] cursor-pointer font-medium"
            >
              <option value="single">Pojedynczy (próbkowany)</option>
              <option value="secondary">Kolor dodatkowy</option>
            </select>
          </div>

          {/* Tolerancja */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tolerancja:</label>
            <input
              type="number"
              min="0"
              max="100"
              value={colorReplaceSettings.tolerance}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeColorReplaceSettings?.({ tolerance: Math.max(0, Math.min(100, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#10b981] font-mono"
            />
            <span className="text-[10px] text-[#888] font-mono w-6">{colorReplaceSettings.tolerance}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={colorReplaceSettings.tolerance}
              onChange={(e) =>
                onChangeColorReplaceSettings?.({ tolerance: parseInt(e.target.value) })
              }
              className="w-20 h-1 bg-[#444] accent-[#10b981] rounded-lg appearance-none cursor-pointer"
              title={`Tolerancja koloru: ${colorReplaceSettings.tolerance}%`}
            />
          </div>

          {/* Rozmiar */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Rozmiar:</label>
            <input
              type="number"
              min="1"
              max="2000"
              value={colorReplaceSettings.size}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeColorReplaceSettings?.({ size: Math.max(1, Math.min(2000, val)) });
                }
              }}
              className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#10b981] font-mono"
            />
            <input
              type="range"
              min="0"
              max="1000"
              value={sizeToSlider(colorReplaceSettings.size)}
              onChange={(e) => {
                const size = sliderToSize(parseInt(e.target.value));
                onChangeColorReplaceSettings?.({ size });
              }}
              className="w-24 h-1 bg-[#444] accent-[#10b981] rounded-lg appearance-none cursor-pointer"
              title={`Rozmiar: ${colorReplaceSettings.size} px`}
            />
          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <span className="text-[11px] text-[#ccc] w-9 text-right font-mono">{colorReplaceSettings.hardness}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={colorReplaceSettings.hardness}
              onChange={(e) => onChangeColorReplaceSettings?.({ hardness: parseInt(e.target.value) })}
              className="w-20 h-1 bg-[#444] accent-[#10b981] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Wygładzanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white">
            <input
              type="checkbox"
              checked={colorReplaceSettings.antiAliasing}
              onChange={(e) => onChangeColorReplaceSettings?.({ antiAliasing: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#10b981] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
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
              value={colorReplaceSettings.spacing}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeColorReplaceSettings?.({ spacing: Math.max(1, Math.min(500, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#10b981] font-mono"
            />
            <span className="text-[10px] text-[#888]">%</span>
            <input
              type="range"
              min="0"
              max="1000"
              value={spacingToSlider(colorReplaceSettings.spacing)}
              onChange={(e) => {
                const spacing = sliderToSpacing(parseInt(e.target.value));
                onChangeColorReplaceSettings?.({ spacing });
              }}
              className="w-20 h-1 bg-[#444] accent-[#10b981] rounded-lg appearance-none cursor-pointer"
            />
          </div>
        </div>
      ) : activeTool === 'stamp' ? (
        /* 7d. PASEK OPCJI PIECZĄTKI (CLONE STAMP) */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Rozmiar */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Rozmiar:</label>
            <input
              type="number"
              min="1"
              max="2000"
              value={stampSettings.size}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeStampSettings?.({ size: Math.max(1, Math.min(2000, val)) });
                }
              }}
              className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <input
              type="range"
              min="0"
              max="1000"
              value={sizeToSlider(stampSettings.size)}
              onChange={(e) => {
                const size = sliderToSize(parseInt(e.target.value));
                onChangeStampSettings?.({ size });
              }}
              className="w-24 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
              title={`Rozmiar: ${stampSettings.size} px`}
            />
          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <span className="text-[11px] text-[#ccc] w-9 text-right font-mono">{stampSettings.hardness}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={stampSettings.hardness}
              onChange={(e) => onChangeStampSettings?.({ hardness: parseInt(e.target.value) })}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Wygładzanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white border-l border-[#444] pl-2.5">
            <input
              type="checkbox"
              checked={stampSettings.antiAliasing}
              onChange={(e) => onChangeStampSettings?.({ antiAliasing: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#007acc] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Wygładzanie</span>
          </label>

          {/* Odstęp */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Odstęp:</label>
            <input
              type="number"
              min="1"
              max="500"
              value={stampSettings.spacing}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeStampSettings?.({ spacing: Math.max(1, Math.min(500, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <span className="text-[10px] text-[#888]">%</span>
            <input
              type="range"
              min="0"
              max="1000"
              value={spacingToSlider(stampSettings.spacing)}
              onChange={(e) => {
                const spacing = sliderToSpacing(parseInt(e.target.value));
                onChangeStampSettings?.({ spacing });
              }}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Tryb mieszania */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Mieszanie:</label>
            <select
              value={stampSettings.blendMode}
              onChange={(e) => onChangeStampSettings?.({ blendMode: e.target.value as SKBlendMode })}
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              {BLEND_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.namePl}
                </option>
              ))}
            </select>
          </div>

          {/* Próbkowanie (obraz / warstwa) */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Próbkowanie:</label>
            <select
              value={stampSettings.sampleSource}
              onChange={(e) => onChangeStampSettings?.({ sampleSource: e.target.value as StampSampleSource })}
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              <option value="image">Obraz</option>
              <option value="layer">Warstwa</option>
            </select>
          </div>

          {/* Punkt bazowy (nieruchomy / wybrany / względny) */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Punkt bazowy:</label>
            <select
              value={stampSettings.sourceMode}
              onChange={(e) => onChangeStampSettings?.({ sourceMode: e.target.value as StampSourceMode })}
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
            >
              <option value="relative">Względny</option>
              <option value="selected">Wybrany</option>
              <option value="fixed">Nieruchomy</option>
            </select>
          </div>

          {/* Krycie (z kanału alfa koloru) */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Krycie:</label>
            <span className="text-[11px] text-[#ccc] w-9 text-right font-mono">
              {Math.round(((primaryColor?.a ?? 255) / 255) * 100)}%
            </span>
            <input
              type="range"
              min="1"
              max="255"
              value={primaryColor?.a ?? 255}
              onChange={(e) => {
                const a = parseInt(e.target.value);
                onChangePrimaryColorAlpha?.(a);
              }}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
              title={`Krycie pieczątki (kanał alfa): ${Math.round(((primaryColor?.a ?? 255) / 255) * 100)}%`}
            />
          </div>
        </div>
      ) : activeTool === 'deform' ? (
        /* 7e. PASEK OPCJI DEFORMACJI */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Rodzaj działania */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Działanie:</label>
            <select
              value={deformSettings.actionType}
              onChange={(e) =>
                onChangeDeformSettings?.({
                  actionType: e.target.value as DeformActionType,
                })
              }
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer font-medium"
            >
              <option value="expand-shrink">Zwiększ / Zmniejsz</option>
              <option value="smudge">Przesuń</option>
              <option value="twirl">Obróć</option>
            </select>
          </div>

          {/* Rozmiar */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Rozmiar:</label>
            <input
              type="number"
              min="1"
              max="2000"
              value={deformSettings.size}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeDeformSettings?.({ size: Math.max(1, Math.min(2000, val)) });
                }
              }}
              className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <input
              type="range"
              min="0"
              max="1000"
              value={sizeToSlider(deformSettings.size)}
              onChange={(e) => {
                const size = sliderToSize(parseInt(e.target.value));
                onChangeDeformSettings?.({ size });
              }}
              className="w-24 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
              title={`Rozmiar: ${deformSettings.size} px`}
            />
          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <span className="text-[11px] text-[#ccc] w-9 text-right font-mono">{deformSettings.hardness}%</span>
            <input
              type="range"
              min="0"
              max="100"
              value={deformSettings.hardness}
              onChange={(e) => onChangeDeformSettings?.({ hardness: parseInt(e.target.value) })}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Wygładzanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white">
            <input
              type="checkbox"
              checked={deformSettings.antiAliasing}
              onChange={(e) => onChangeDeformSettings?.({ antiAliasing: e.target.checked })}
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
              value={deformSettings.spacing}
              onChange={(e) => {
                const val = parseInt(e.target.value);
                if (!isNaN(val)) {
                  onChangeDeformSettings?.({ spacing: Math.max(1, Math.min(500, val)) });
                }
              }}
              className="w-12 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <span className="text-[10px] text-[#888]">%</span>
            <input
              type="range"
              min="0"
              max="1000"
              value={spacingToSlider(deformSettings.spacing)}
              onChange={(e) => {
                const spacing = sliderToSpacing(parseInt(e.target.value));
                onChangeDeformSettings?.({ spacing });
              }}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
            />
          </div>

          {/* Odwróć działanie */}
          <label className="flex items-center gap-1.5 cursor-pointer text-[11px] hover:text-white border-l border-[#444] pl-2.5">
            <input
              type="checkbox"
              checked={deformSettings.invertAction}
              onChange={(e) => onChangeDeformSettings?.({ invertAction: e.target.checked })}
              className="rounded bg-[#1e1e1e] border-[#555] text-[#007acc] focus:ring-0 focus:ring-offset-0 h-3.5 w-3.5 cursor-pointer"
            />
            <span>Odwróć działanie</span>
          </label>

          {/* Intensywność (zależna od kanału Alfa) */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Intensywność:</label>
            <span className="text-[11px] text-[#ccc] w-9 text-right font-mono">
              {Math.round(((primaryColor?.a ?? 255) / 255) * 100)}%
            </span>
            <input
              type="range"
              min="1"
              max="255"
              value={primaryColor?.a ?? 255}
              onChange={(e) => {
                const a = parseInt(e.target.value);
                onChangePrimaryColorAlpha?.(a);
              }}
              className="w-20 h-1 bg-[#444] accent-[#007acc] rounded-lg appearance-none cursor-pointer"
              title={`Intensywność: ${Math.round(((primaryColor?.a ?? 255) / 255) * 100)}%`}
            />
          </div>
        </div>
      ) : activeTool === 'pan' ? (
        /* W narzędziu rączka nic nie ma być w opcjach */
        <div className="flex-1"></div>
      ) : (
        /* 8. PASEK OPCJI PĘDZLA I GUMKI */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
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
            />
          </div>

          {/* Tryb mieszania */}
          {activeTool !== 'eraser' && (
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
          )}
        </div>
      )}


    </div>
  );
};
