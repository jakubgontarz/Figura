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
  PathFillMode,
  VectorShapeSettings,
  SmartObjectSettings,
  TextToolSettings,
} from '../core/types.ts';
import { TextOptions } from './TextOptions.tsx';
import { ScrubField } from './ScrubField.tsx';
import { ToggleButton } from './ToggleButton.tsx';

const isArrowMarker = (m: MarkerType) => m !== 'none' && m !== 'cap-round' && m !== 'cap-square';

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
  selectionSettings: SelectionSettings;
  onChangeSelectionSettings: (newSettings: Partial<SelectionSettings>) => void;
  pipetteSettings: PipetteSettings;
  onChangePipetteSettings: (newSettings: Partial<PipetteSettings>) => void;
  gradientSettings?: GradientSettings;
  onChangeGradientSettings?: (newSettings: Partial<GradientSettings>) => void;
  vectorShapeSettings: VectorShapeSettings;
  onChangeVectorShapeSettings: (newSettings: Partial<VectorShapeSettings>) => void;
  smartSettings?: SmartObjectSettings;
  guideAxis?: 'h' | 'v';
  onChangeGuideAxis?: (a: 'h' | 'v') => void;
  guideCount?: number;
  onClearGuides?: () => void;
  onChangeSmartSettings?: (n: Partial<SmartObjectSettings>) => void;
  /** „Obraz z dysku”: okno wyboru pliku i wstawienie obiektu */
  onInsertDiskImage?: () => void;
  /** ponowne wczytanie wszystkich obrazów z dysku z pliku */
  onRefreshDiskImages?: () => void;
  lineAndCurveSettings: LineAndCurveSettings;
  onChangeLineAndCurveSettings: (newSettings: Partial<LineAndCurveSettings>) => void;
  primaryColor?: SKColor;
  onChangePrimaryColorAlpha?: (alpha: number) => void;
  activeTool: string;
  /** Tryb perspektywy: odbicia są niedostępne */
  flipDisabled?: boolean;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
  textSettings?: TextToolSettings;
  onChangeTextSettings?: (newSettings: Partial<TextToolSettings>) => void;
  onRequestTextFocus?: () => void;
  onCommitLiveVectorSession?: () => void;
  onCancelLiveVectorSession?: () => void;
  penInfo?: { active: boolean; closed: boolean; count: number };
  onTogglePenClosed?: () => void;
}

import { LengthField, UnitLabel, useUnits } from './Units.tsx';

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
  smartSettings = { width: 400, height: 300, blendMode: 'SrcOver' },
  guideAxis = 'v',
  onChangeGuideAxis,
  guideCount = 0,
  onClearGuides,
  onChangeSmartSettings,
  onInsertDiskImage,
  onRefreshDiskImages,
  lineAndCurveSettings,
  onChangeLineAndCurveSettings,
  primaryColor,
  onChangePrimaryColorAlpha,
  activeTool,
  flipDisabled,
  onFlipHorizontal,
  onFlipVertical,
  textSettings,
  onChangeTextSettings,
  onRequestTextFocus,
  onCommitLiveVectorSession,
  onCancelLiveVectorSession,
  penInfo,
  onTogglePenClosed,
}) => {
  const uctx = useUnits();
  const fractionalUnits = uctx.unit !== 'px';
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

      {/* Opcje linii i krzywej beziera */}
      {isLineOrCurve ? (
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Grubość linii */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Grubość:</label>
            <LengthField
              valuePx={lineAndCurveSettings.strokeWidth}
              minPx={activeTool === 'bezier' ? 0 : 1}
              maxPx={200}
              trackMaxPx={100}
              integerPx={!fractionalUnits}
              onCommitPx={(v) => onChangeLineAndCurveSettings({ strokeWidth: v })}
              className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <UnitLabel />
          </div>

          {activeTool === 'bezier' && (
            <>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Narożnik:</label>
                <select
                  value={lineAndCurveSettings.cornerJoin}
                  onChange={(e) => onChangeLineAndCurveSettings({ cornerJoin: e.target.value as StrokeCornerJoin })}
                  className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
                >
                  <option value="miter">Ostry</option>
                  <option value="round">Zaokrąglony</option>
                  <option value="bevel">Ścięty</option>
                </select>
              </div>
              <button
                type="button"
                disabled={!penInfo?.active || (penInfo?.count ?? 0) < 3}
                onClick={onTogglePenClosed}
                title={penInfo?.closed ? 'Otwórz krzywą (usuwa odcinek zamykający). Otwarcie w wybranym węźle: kliknij węzeł.' : 'Zamknij krzywą (łączy ostatni węzeł z pierwszym; można ją wypełnić)'}
                className={`h-5 px-2 rounded border text-[11px] whitespace-nowrap flex-shrink-0 ${
                  penInfo?.active && (penInfo?.count ?? 0) >= 3
                    ? 'bg-[#1e1e1e] border-[#444] text-white hover:bg-[#333] cursor-pointer'
                    : 'bg-[#1e1e1e] border-[#333] text-[#666] cursor-default'
                } ${penInfo?.closed ? '!bg-[#094771] !border-[#007acc]' : ''}`}
              >
                {penInfo?.closed ? 'Otwórz krzywą' : 'Zamknij krzywą'}
              </button>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]" title="Dotyczy zamkniętej krzywej">Wypełnienie:</label>
                <select
                  value={lineAndCurveSettings.fillMode}
                  onChange={(e) => onChangeLineAndCurveSettings({ fillMode: e.target.value as PathFillMode })}
                  className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
                >
                  <option value="none">Brak</option>
                  <option value="primary">Główny</option>
                  <option value="secondary">Dodatkowy</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]" title="Dotyczy zamkniętej krzywej">Wyrównanie:</label>
                <select
                  value={lineAndCurveSettings.strokeAlignment}
                  onChange={(e) => onChangeLineAndCurveSettings({ strokeAlignment: e.target.value as StrokeAlignment })}
                  className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
                >
                  <option value="center">Do środka</option>
                  <option value="inside">Do wewnątrz</option>
                  <option value="outside">Do zewnątrz</option>
                </select>
              </div>
            </>
          )}

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
              <option value="solid">Ciągła</option>
              <option value="dashed">Kreskowana</option>
              <option value="dotted">Kropkowana</option>
              <option value="dash-dot">Kreska-kropka</option>
              <option value="long-dash">Długa kreska</option>
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
              <option value="none">Ostry</option>
              <option value="cap-round">Zaokrąglony</option>
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
              <option value="none">Ostry</option>
              <option value="cap-round">Zaokrąglony</option>
              <option value="arrow">Strzałka</option>
              <option value="stealth-arrow">Grot ostry</option>
              <option value="circle">Koło</option>
              <option value="square">Kwadrat</option>
              <option value="diamond">Romb</option>
            </select>
          </div>

          {/* Rozmiar znacznika */}
          {(isArrowMarker(lineAndCurveSettings.startMarker) || isArrowMarker(lineAndCurveSettings.endMarker)) && (
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
          <ToggleButton active={lineAndCurveSettings.antiAliasing} onChange={(v) => onChangeLineAndCurveSettings({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

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
      ) : activeTool === 'guides' ? (
        /* Prowadnice: kierunek nowej prowadnicy */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-[#aaa]">Kierunek:</span>
            <div className="flex items-center gap-1.5">
              {([['v', 'Pionowa'], ['h', 'Pozioma']] as const).map(([a, label]) => (
                <ToggleButton key={a} radio testId={`guide-axis-${a}`} active={guideAxis === a} onChange={() => onChangeGuideAxis?.(a)}>
                  {label}
                </ToggleButton>
              ))}
            </div>
          </div>
          <button
            type="button"
            disabled={guideCount === 0}
            onClick={() => onClearGuides?.()}
            className="h-5 px-2 text-[11px] bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] hover:text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            Usuń wszystkie ({guideCount})
          </button>
          <span className="text-[11px] text-[#9a9a9a]">Kliknij, aby wstawić. Przeciągnij prowadnicę, aby ją przesunąć; wyciągnięcie poza obraz lub Delete usuwa. Współrzędne: panel Właściwości.</span>
        </div>
      ) : activeTool === 'smart-object' ? (
        /* Obiekt inteligentny: rozmiar płótna obiektu (zawsze w pikselach) i tryb mieszania */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-1.5 py-0.5 rounded border border-[#3e3e3e]">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]" title="Rozmiar płótna obiektu inteligentnego">Płótno obiektu:</label>
            <LengthField
              forcePx
              valuePx={smartSettings.width}
              minPx={1}
              maxPx={16000}
              integerPx
              onCommitPx={(v) => onChangeSmartSettings?.({ width: v })}
              className="w-16 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
            />
            <span className="text-[11px] text-[#aaa]">px</span>
            <label className="text-[11px] whitespace-nowrap text-[#aaa] ml-1">×</label>
            <LengthField
              forcePx
              valuePx={smartSettings.height}
              minPx={1}
              maxPx={16000}
              integerPx
              onCommitPx={(v) => onChangeSmartSettings?.({ height: v })}
              className="w-16 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
            />
            <span className="text-[11px] text-[#aaa]">px</span>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tryb mieszania:</label>
            <select
              value={smartSettings.blendMode}
              onChange={(e) => onChangeSmartSettings?.({ blendMode: e.target.value as SKBlendMode })}
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
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
            onClick={() => onInsertDiskImage?.()}
            title="Wstawia obraz z pliku na dysku. Dokument zapamiętuje tylko położenie pliku, współrzędne, rozmiar, kąt i tryb mieszania, bez bitmapy."
            className="h-5 px-2 text-[11px] bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] hover:text-white cursor-pointer whitespace-nowrap flex-shrink-0"
          >
            Obraz z dysku…
          </button>
          <button
            type="button"
            onClick={() => onRefreshDiskImages?.()}
            title="Wczytuje ponownie z dysku wszystkie obrazy z dysku w tym dokumencie (po zmianie plików w czasie pracy)."
            className="h-5 px-2 text-[11px] bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] hover:text-white cursor-pointer whitespace-nowrap flex-shrink-0"
          >
            Odśwież
          </button>
          <span className="text-[11px] text-[#9a9a9a]">Kliknij lub przeciągnij (Shift – zachowaj proporcje płótna), aby wstawić. Dwuklik na obiekcie otwiera jego dokument w zakładce.</span>
        </div>
      ) : isShapeTool ? (
        /* Opcje figur geometrycznych */
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
            <LengthField
              valuePx={vectorShapeSettings.strokeWidth}
              minPx={0}
              maxPx={200}
              trackMaxPx={100}
              integerPx={!fractionalUnits}
              onCommitPx={(v) => onChangeVectorShapeSettings({ strokeWidth: v })}
              className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <UnitLabel />
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

          {/* Wymiary specyficzne dla kształtu (promień, ramiona, boki, grot, trzon) są w panelu Właściwości */}

          {/* Wygładzanie */}
          <ToggleButton active={lineAndCurveSettings.antiAliasing} onChange={(v) => onChangeLineAndCurveSettings({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

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
      ) : activeTool === 'guides' ? (
        /* Prowadnice: kierunek nowej prowadnicy */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-[#aaa]">Kierunek:</span>
            <div className="flex items-center gap-1.5">
              {([['v', 'Pionowa'], ['h', 'Pozioma']] as const).map(([a, label]) => (
                <ToggleButton key={a} radio testId={`guide-axis-${a}`} active={guideAxis === a} onChange={() => onChangeGuideAxis?.(a)}>
                  {label}
                </ToggleButton>
              ))}
            </div>
          </div>
          <button
            type="button"
            disabled={guideCount === 0}
            onClick={() => onClearGuides?.()}
            className="h-5 px-2 text-[11px] bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] hover:text-white cursor-pointer disabled:opacity-40 disabled:cursor-default"
          >
            Usuń wszystkie ({guideCount})
          </button>
          <span className="text-[11px] text-[#9a9a9a]">Kliknij, aby wstawić. Przeciągnij prowadnicę, aby ją przesunąć; wyciągnięcie poza obraz lub Delete usuwa. Współrzędne: panel Właściwości.</span>
        </div>
      ) : activeTool === 'smart-object' ? (
        /* Obiekt inteligentny: rozmiar płótna obiektu (zawsze w pikselach) i tryb mieszania */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-1.5 py-0.5 rounded border border-[#3e3e3e]">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]" title="Rozmiar płótna obiektu inteligentnego">Płótno obiektu:</label>
            <LengthField
              forcePx
              valuePx={smartSettings.width}
              minPx={1}
              maxPx={16000}
              integerPx
              onCommitPx={(v) => onChangeSmartSettings?.({ width: v })}
              className="w-16 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
            />
            <span className="text-[11px] text-[#aaa]">px</span>
            <label className="text-[11px] whitespace-nowrap text-[#aaa] ml-1">×</label>
            <LengthField
              forcePx
              valuePx={smartSettings.height}
              minPx={1}
              maxPx={16000}
              integerPx
              onCommitPx={(v) => onChangeSmartSettings?.({ height: v })}
              className="w-16 h-5 bg-[#252525] border border-[#555] rounded px-1 text-center text-xs text-white font-mono focus:outline-none focus:border-[#00bcd4]"
            />
            <span className="text-[11px] text-[#aaa]">px</span>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tryb mieszania:</label>
            <select
              value={smartSettings.blendMode}
              onChange={(e) => onChangeSmartSettings?.({ blendMode: e.target.value as SKBlendMode })}
              className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
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
            onClick={() => onInsertDiskImage?.()}
            title="Wstawia obraz z pliku na dysku. Dokument zapamiętuje tylko położenie pliku, współrzędne, rozmiar, kąt i tryb mieszania, bez bitmapy."
            className="h-5 px-2 text-[11px] bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] hover:text-white cursor-pointer whitespace-nowrap flex-shrink-0"
          >
            Obraz z dysku…
          </button>
          <button
            type="button"
            onClick={() => onRefreshDiskImages?.()}
            title="Wczytuje ponownie z dysku wszystkie obrazy z dysku w tym dokumencie (po zmianie plików w czasie pracy)."
            className="h-5 px-2 text-[11px] bg-[#2a2a2a] border border-[#444] rounded text-[#ccc] hover:text-white cursor-pointer whitespace-nowrap flex-shrink-0"
          >
            Odśwież
          </button>
          <span className="text-[11px] text-[#9a9a9a]">Kliknij lub przeciągnij (Shift – zachowaj proporcje płótna), aby wstawić. Dwuklik na obiekcie otwiera jego dokument w zakładce.</span>
        </div>
      ) : isShapeTool ? (
        /* Opcje figur geometrycznych */
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
            <LengthField
              valuePx={vectorShapeSettings.strokeWidth}
              minPx={0}
              maxPx={200}
              trackMaxPx={100}
              integerPx={!fractionalUnits}
              onCommitPx={(v) => onChangeVectorShapeSettings({ strokeWidth: v })}
              className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white focus:outline-none focus:border-[#007acc] font-mono"
            />
            <UnitLabel />
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
              <LengthField
                valuePx={vectorShapeSettings.cornerRadius}
                minPx={0}
                maxPx={2000}
                integerPx={!fractionalUnits}
                onCommitPx={(v) => onChangeVectorShapeSettings({ cornerRadius: v })}
                className="w-14 h-5 bg-[#1e1e1e] border border-[#444] rounded px-1 text-center text-xs text-white font-mono"
              />
              <UnitLabel />
            </div>
          )}

          {vectorShapeSettings.shapeKind === 'star' && (
            <>
              <div className="flex items-center gap-1 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Ramiona:</label>
                <ScrubField
                  value={vectorShapeSettings.starPoints}
                  min={3}
                  max={32}
                  width={64}
                  onChange={(v) => onChangeVectorShapeSettings({ starPoints: v })}
                />
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Ostrość:</label>
                <ScrubField
                  value={Math.round((1 - vectorShapeSettings.starInnerRatio) * 100)}
                  min={10}
                  max={90}
                  suffix="%"
                  width={80}
                  onChange={(v) => onChangeVectorShapeSettings({ starInnerRatio: (100 - v) / 100 })}
                />
              </div>
            </>
          )}

          {vectorShapeSettings.shapeKind === 'polygon' && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <label className="text-[11px] whitespace-nowrap text-[#aaa]">Boki:</label>
              <ScrubField
                value={vectorShapeSettings.polygonSides}
                min={3}
                max={16}
                width={64}
                onChange={(v) => onChangeVectorShapeSettings({ polygonSides: v })}
              />
            </div>
          )}

          {vectorShapeSettings.shapeKind === 'arrow' && (
            <>
              <div className="flex items-center gap-1 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Grot:</label>
                <ScrubField
                  value={Math.round(vectorShapeSettings.arrowHeadWidth * 100)}
                  min={15}
                  max={85}
                  suffix="%"
                  width={80}
                  onChange={(v) => onChangeVectorShapeSettings({ arrowHeadWidth: v / 100 })}
                />
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Trzon:</label>
                <ScrubField
                  value={Math.round(vectorShapeSettings.arrowShaftThickness * 100)}
                  min={10}
                  max={85}
                  suffix="%"
                  width={80}
                  onChange={(v) => onChangeVectorShapeSettings({ arrowShaftThickness: v / 100 })}
                />
              </div>
            </>
          )}

          {/* Wygładzanie */}
          <ToggleButton active={vectorShapeSettings.antiAliasing} onChange={(v) => onChangeVectorShapeSettings({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

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
      ) : activeTool === 'text' && textSettings && onChangeTextSettings ? (
        /* Opcje narzędzia tekstu */
        <TextOptions
          settings={textSettings}
          onChange={onChangeTextSettings}
          onRequestFocus={onRequestTextFocus}
          onCommit={onCommitLiveVectorSession}
          onCancel={onCancelLiveVectorSession}
        />
      ) : activeTool === 'pipette' ? (
        /* Pasek opcji pipety */
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
              <ScrubField
                value={pipetteSettings.sampleDiameter}
                min={1}
                max={101}
                width={92}
                onChange={(v) => onChangePipetteSettings({ sampleDiameter: v })}
              />
              <span className="text-[10px] text-[#888]">px</span>
            </div>
          </div>

          <ToggleButton active={pipetteSettings.showLoupe} onChange={(v) => onChangePipetteSettings({ showLoupe: v })}>
            Pokaż lupę
          </ToggleButton>
        </div>
      ) : activeTool === 'transform-selection' || activeTool === 'transform-content' ? (
        /* Pasek opcji przekształcania */
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
              disabled={flipDisabled}
              title={flipDisabled ? 'Niedostępne w trybie perspektywy' : "Odbij poziomo (Lustro w poziomie)"}
              className={`flex items-center gap-1 px-2 h-5 bg-[#1e1e1e] rounded border border-[#444] text-[11px] ${flipDisabled ? 'opacity-40 cursor-not-allowed text-[#888]' : 'hover:bg-[#333] text-[#ddd] hover:text-white cursor-pointer'}`}
            >
              <FlipHorizontal size={13} />
              <span>Odbij w poziomie</span>
            </button>
            <button
              type="button"
              onClick={onFlipVertical}
              disabled={flipDisabled}
              title={flipDisabled ? 'Niedostępne w trybie perspektywy' : "Odbij pionowo (Lustro w pionie)"}
              className={`flex items-center gap-1 px-2 h-5 bg-[#1e1e1e] rounded border border-[#444] text-[11px] ${flipDisabled ? 'opacity-40 cursor-not-allowed text-[#888]' : 'hover:bg-[#333] text-[#ddd] hover:text-white cursor-pointer'}`}
            >
              <FlipVertical size={13} />
              <span>Odbij w pionie</span>
            </button>
          </div>
        </div>
      ) : isSelectionTool ? (
        /* Pasek opcji zaznaczania */
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
              <option value="add">Dodaj do zaznaczenia (Ctrl)</option>
              <option value="subtract">Odejmij od zaznaczenia (Alt)</option>
              <option value="intersect">Część wspólna (Ctrl+Alt)</option>
              <option value="invert">Odwróć zaznaczenie</option>
            </select>
          </div>

          {activeTool === 'select-lasso' && (
            <div className="flex items-center gap-1.5">
              <label
                className="text-[11px] whitespace-nowrap text-[#aaa]"
                title="Odręczne: jedno pociągnięcie. Punkt po punkcie: klik = odcinek prosty, przeciągnięcie = linia odręczna od ostatniego punktu. Enter lub klik w pierwszy punkt zatwierdza, Backspace cofa punkt, Esc anuluje."
              >
                Lasso:
              </label>
              <select
                value={selectionSettings.lassoMode ?? 'freehand'}
                onChange={(e) => onChangeSelectionSettings({ lassoMode: e.target.value as SelectionSettings['lassoMode'] })}
                className="h-5 bg-[#1e1e1e] border border-[#444] rounded px-1.5 text-xs text-white focus:outline-none focus:border-[#007acc] cursor-pointer"
              >
                <option value="freehand">Odręczne</option>
                <option value="polygon">Punkt po punkcie</option>
              </select>
            </div>
          )}

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
                  <ScrubField
                    value={selectionSettings.ratioW}
                    min={0.1}
                    max={100}
                    step={0.1}
                    openEnded
                    speed={0.05}
                    width={72}
                    title="Szerokość proporcji"
                    onChange={(v) => onChangeSelectionSettings({ ratioW: v })}
                  />
                  <span className="text-xs text-[#888] font-bold">:</span>
                  <ScrubField
                    value={selectionSettings.ratioH}
                    min={0.1}
                    max={100}
                    step={0.1}
                    openEnded
                    speed={0.05}
                    width={72}
                    title="Wysokość proporcji"
                    onChange={(v) => onChangeSelectionSettings({ ratioH: v })}
                  />
                </div>
              )}

              {selectionSettings.constraint === 'fixed-size' && (
                <div className="flex items-center gap-1.5 bg-[#1e1e1e] px-1.5 py-0.5 rounded border border-[#3e3e3e]">
                  <label className="text-[11px] whitespace-nowrap text-[#aaa]">Szer.:</label>
                  <ScrubField
                    value={selectionSettings.fixedW}
                    min={1}
                    max={10000}
                    curve={2.5}
                    width={92}
                    onChange={(v) => onChangeSelectionSettings({ fixedW: v })}
                  />
                  <span className="text-[10px] text-[#888]">px</span>

                  <label className="text-[11px] whitespace-nowrap text-[#aaa] ml-1">Wys.:</label>
                  <ScrubField
                    value={selectionSettings.fixedH}
                    min={1}
                    max={10000}
                    curve={2.5}
                    width={92}
                    onChange={(v) => onChangeSelectionSettings({ fixedH: v })}
                  />
                  <span className="text-[10px] text-[#888]">px</span>
                </div>
              )}
            </>
          )}

          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Wtapianie:</label>
            <ScrubField
              value={selectionSettings.feather}
              min={0}
              max={100}
              width={64}
              onChange={(v) => onChangeSelectionSettings({ feather: v })}
            />
            <span className="text-[10px] text-[#888]">px</span>
          </div>

          {activeTool === 'magic-wand' && (
            <>
              <div className="flex items-center gap-1.5">
                <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tolerancja:</label>
                <ScrubField
                  value={selectionSettings.tolerance}
                  min={0}
                  max={100}
                  width={92}
                  onChange={(v) => onChangeSelectionSettings({ tolerance: v })}
                />

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
        /* Pasek opcji gradientu */
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

          <ToggleButton
            active={!!gradientSettings?.reverse}
            onChange={(v) => onChangeGradientSettings?.({ reverse: v })}
            title="Odwróć kierunek kolorów gradientu"
          >
            <ArrowLeftRight size={12} />
            <span>Odwróć</span>
          </ToggleButton>
        </div>
      ) : activeTool === 'bucket' ? (
        /* Pasek opcji wiadra z farbą */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Tolerancja */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Tolerancja:</label>
            <ScrubField
              value={selectionSettings.tolerance}
              min={0}
              max={100}
              width={92}
              onChange={(v) => onChangeSelectionSettings({ tolerance: v })}
            />

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
          <ToggleButton active={brushSettings.antiAliasing} onChange={(v) => onChangeSettings({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

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
        /* Pasek opcji pędzla korekcyjnego */
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
            <ScrubField
              value={correctionBrushSettings.size}
              min={1}
              max={2000}
              curve={2.6}
              width={92}
              onChange={(v) => onChangeCorrectionBrushSettings?.({ size: v })}
            />

          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <ScrubField value={correctionBrushSettings.hardness} min={0} max={100} suffix="%" width={80} onChange={(v) => onChangeCorrectionBrushSettings?.({ hardness: v })} />
          </div>

          {/* Wygładzanie */}
          <ToggleButton active={correctionBrushSettings.antiAliasing} onChange={(v) => onChangeCorrectionBrushSettings?.({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

          {/* Odstęp */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Odstęp:</label>
            <ScrubField
              value={correctionBrushSettings.spacing}
              min={1}
              max={500}
              curve={2.2}
              width={92}
              onChange={(v) => onChangeCorrectionBrushSettings?.({ spacing: v })}
            />
            <span className="text-[10px] text-[#888]">%</span>

          </div>

          {/* Odwróć działanie */}
          <ToggleButton divider active={correctionBrushSettings.invertAction} onChange={(v) => onChangeCorrectionBrushSettings?.({ invertAction: v })}>
            Odwróć działanie
          </ToggleButton>

          {/* Intensywność (zależna od kanału Alfa) */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Intensywność:</label>
            <ScrubField
              value={Math.round(((primaryColor?.a ?? 255) / 255) * 100)}
              min={1}
              max={100}
              suffix="%"
              width={80}
              onChange={(v) => onChangePrimaryColorAlpha?.(Math.round((v / 100) * 255))}
              title="Intensywność"
            />
          </div>
        </div>
      ) : activeTool === 'color-replace' ? (
        /* Pasek opcji pędzla zmiany koloru */
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
            <ScrubField
              value={colorReplaceSettings.tolerance}
              min={0}
              max={100}
              width={92}
              onChange={(v) => onChangeColorReplaceSettings?.({ tolerance: v })}
            />
            <span className="text-[10px] text-[#888] font-mono w-6">{colorReplaceSettings.tolerance}%</span>

          </div>

          {/* Rozmiar */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Rozmiar:</label>
            <ScrubField
              value={colorReplaceSettings.size}
              min={1}
              max={2000}
              curve={2.6}
              width={92}
              onChange={(v) => onChangeColorReplaceSettings?.({ size: v })}
            />

          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <ScrubField value={colorReplaceSettings.hardness} min={0} max={100} suffix="%" width={80} onChange={(v) => onChangeColorReplaceSettings?.({ hardness: v })} />
          </div>

          {/* Wygładzanie */}
          <ToggleButton active={colorReplaceSettings.antiAliasing} onChange={(v) => onChangeColorReplaceSettings?.({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

          {/* Odstęp */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Odstęp:</label>
            <ScrubField
              value={colorReplaceSettings.spacing}
              min={1}
              max={500}
              curve={2.2}
              width={92}
              onChange={(v) => onChangeColorReplaceSettings?.({ spacing: v })}
            />
            <span className="text-[10px] text-[#888]">%</span>

          </div>
        </div>
      ) : activeTool === 'stamp' ? (
        /* Pasek opcji pieczątki */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Rozmiar */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Rozmiar:</label>
            <ScrubField
              value={stampSettings.size}
              min={1}
              max={2000}
              curve={2.6}
              width={92}
              onChange={(v) => onChangeStampSettings?.({ size: v })}
            />

          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <ScrubField value={stampSettings.hardness} min={0} max={100} suffix="%" width={80} onChange={(v) => onChangeStampSettings?.({ hardness: v })} />
          </div>

          {/* Wygładzanie */}
          <ToggleButton divider active={stampSettings.antiAliasing} onChange={(v) => onChangeStampSettings?.({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

          {/* Odstęp */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap">Odstęp:</label>
            <ScrubField
              value={stampSettings.spacing}
              min={1}
              max={500}
              curve={2.2}
              width={92}
              onChange={(v) => onChangeStampSettings?.({ spacing: v })}
            />
            <span className="text-[10px] text-[#888]">%</span>

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
            <ScrubField
              value={Math.round(((primaryColor?.a ?? 255) / 255) * 100)}
              min={1}
              max={100}
              suffix="%"
              width={80}
              onChange={(v) => onChangePrimaryColorAlpha?.(Math.round((v / 100) * 255))}
              title="Krycie pieczątki (kanał alfa)"
            />
          </div>
        </div>
      ) : activeTool === 'deform' ? (
        /* Pasek opcji deformacji */
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
            <ScrubField
              value={deformSettings.size}
              min={1}
              max={2000}
              curve={2.6}
              width={92}
              onChange={(v) => onChangeDeformSettings?.({ size: v })}
            />

          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <ScrubField value={deformSettings.hardness} min={0} max={100} suffix="%" width={80} onChange={(v) => onChangeDeformSettings?.({ hardness: v })} />
          </div>

          {/* Wygładzanie */}
          <ToggleButton active={deformSettings.antiAliasing} onChange={(v) => onChangeDeformSettings?.({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

          {/* Odstęp */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Odstęp:</label>
            <ScrubField
              value={deformSettings.spacing}
              min={1}
              max={500}
              curve={2.2}
              width={92}
              onChange={(v) => onChangeDeformSettings?.({ spacing: v })}
            />
            <span className="text-[10px] text-[#888]">%</span>

          </div>

          {/* Odwróć działanie */}
          <ToggleButton divider active={deformSettings.invertAction} onChange={(v) => onChangeDeformSettings?.({ invertAction: v })}>
            Odwróć działanie
          </ToggleButton>

          {/* Intensywność (zależna od kanału Alfa) */}
          <div className="flex items-center gap-1.5 border-l border-[#444] pl-2.5">
            <label className="text-[11px] whitespace-nowrap text-[#aaa]">Intensywność:</label>
            <ScrubField
              value={Math.round(((primaryColor?.a ?? 255) / 255) * 100)}
              min={1}
              max={100}
              suffix="%"
              width={80}
              onChange={(v) => onChangePrimaryColorAlpha?.(Math.round((v / 100) * 255))}
              title="Intensywność"
            />
          </div>
        </div>
      ) : activeTool === 'pan' || activeTool === 'zoom' ? (
        /* W narzędziu rączka i lupa nic nie ma być w opcjach */
        <div className="flex-1"></div>
      ) : activeTool === 'vector-select' ? (
        /* Manipulacja: tryb zaznaczania obiektów jak w zaznaczaniu prostokątnym */
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
              <option value="add">Dodaj do zaznaczenia (Ctrl)</option>
              <option value="subtract">Odejmij od zaznaczenia (Alt)</option>
              <option value="intersect">Część wspólna (Ctrl+Alt)</option>
              <option value="invert">Odwróć zaznaczenie</option>
            </select>
          </div>
        </div>
      ) : (
        /* Pasek opcji pędzla i gumki */
        <div className="flex items-center gap-3 flex-1 flex-shrink-0">
          {/* Rozmiar pędzla */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Rozmiar:</label>
            <ScrubField
              value={brushSettings.size}
              min={1}
              max={2000}
              curve={2.6}
              width={92}
              onChange={(v) => onChangeSettings({ size: v })}
            />

          </div>

          {/* Twardość */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Twardość:</label>
            <ScrubField value={brushSettings.hardness} min={0} max={100} suffix="%" width={80} onChange={(v) => onChangeSettings({ hardness: v })} />
          </div>

          {/* Wygładzanie */}
          <ToggleButton active={brushSettings.antiAliasing} onChange={(v) => onChangeSettings({ antiAliasing: v })}>
            Wygładzanie
          </ToggleButton>

          {/* Odstęp */}
          <div className="flex items-center gap-1.5">
            <label className="text-[11px] whitespace-nowrap">Odstęp:</label>
            <ScrubField
              value={brushSettings.spacing}
              min={1}
              max={500}
              curve={2.2}
              width={92}
              onChange={(v) => onChangeSettings({ spacing: v })}
            />
            <span className="text-[10px] text-[#888]">%</span>

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
