/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Quad, pointInQuad, drawPerspectivePreview } from '../core/skia/Perspective.ts';
import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { GraphicEngine, drawSolidFragment } from '../core/skia/GraphicEngine.ts';
import { renderGradientPreview } from '../core/skia/GradientRenderer.ts';
import {
  ViewportTileRenderer,
  boundsForPoints,
  boundsForRotatedBox,
  boundsForShape,
} from '../core/skia/ViewportTileRenderer.ts';
import {
  BrushSettings,
  ColorReplaceSettings,
  CorrectionBrushSettings,
  CorrectionSubAction,
  DeformActionType,
  DeformSettings,
  DeformSubAction,
  GradientSettings,
  LineAndCurveSettings,
  PipetteSettings,
  SKColor,
  SKPoint,
  SKRectI,
  SelectionSettings,
  ShapeKind,
  StampSettings,
  TextCharStyle,
  TextToolSettings,
  ToolType,
  VectorShapeSettings,
  skColorToHex,
  skColorToRgbaString,
} from '../core/skia/types.ts';
import { TransformSelectionState } from '../core/skia/SelectionManager.ts';
import {
  RichText,
  findLineForIndex,
  getCaretInfo,
  getSelectionRects,
  getTextInset,
  getTextInnerWidth,
  getTextLayoutOptions,
  hitTestIndex,
  layoutText,
  lineEndCaretIndex,
  nextWordIndex,
  pickCharStyle,
  prevWordIndex,
  renderVectorText,
  wordBoundsAt,
} from '../core/skia/TextEngine.ts';
import {
  renderVectorPath,
  renderVectorLine,
  renderVectorShape,
} from '../core/skia/VectorRenderer.ts';
import {
  PEN_MODES,
  PenHit,
  PenMode,
  PenNode,
  cloneNodes,
  insertNodeAt,
  moveAllBy,
  moveHandle,
  moveNodeBy,
  nearestOnPath,
  normalizeOpenEnds,
  penAllPoints,
  penContentKey,
  penModeAvailable,
  penNodeMode,
  penSegments,
  penShapeKey,
  removeNode,
  setNodeMode,
  setSmoothFromDrag,
} from '../core/skia/PenPath.ts';
import { fitFreehand } from '../core/skia/CurveFit.ts';
import { VectorObject, vectorRichText } from '../core/skia/VectorObjects.ts';
import type { Layer } from '../core/skia/Layer.ts';

interface CanvasViewportProps {
  engine: GraphicEngine;
  engineRevision: number;
  brushSettings: BrushSettings;
  correctionBrushSettings?: CorrectionBrushSettings;
  deformSettings?: DeformSettings;
  colorReplaceSettings?: ColorReplaceSettings;
  stampSettings?: StampSettings;
  stampBasePoint?: { x: number; y: number } | null;
  onSetStampBasePoint?: (pt: { x: number; y: number } | null) => void;
  selectionSettings: SelectionSettings;
  pipetteSettings?: PipetteSettings;
  gradientSettings?: GradientSettings;
  vectorShapeSettings: VectorShapeSettings;
  onChangeVectorShapeSettings?: (settings: Partial<VectorShapeSettings>) => void;
  lineAndCurveSettings: LineAndCurveSettings;
  onChangeLineAndCurveSettings?: (settings: Partial<LineAndCurveSettings>) => void;
  textSettings: TextToolSettings;
  textFormatRequest?: { id: number; patch: Partial<TextToolSettings> } | null;
  onSyncTextSettings?: (patch: Partial<TextToolSettings>) => void;
  textFocusTrigger?: number;
  primaryColor?: SKColor;
  secondaryColor?: SKColor;
  onChangeSelectionSettings?: (settings: Partial<SelectionSettings>) => void;
  activeTool: ToolType;
  activeShapeType: ShapeKind;
  zoom: number;
  panOffset: { x: number; y: number };
  onUpdateZoom: (zoom: number) => void;
  onUpdatePan: (offset: { x: number; y: number }) => void;
  onPipettePick: (color: SKColor, isSecondary?: boolean) => void;
  onCanvasModified: () => void;
  onLiveVectorSessionChange?: (isActive: boolean) => void;
  liveVectorCommitTrigger?: number;
  liveVectorCancelTrigger?: number;
  penCloseToggleTrigger?: number;
  onPenInfoChange?: (info: { active: boolean; closed: boolean; count: number }) => void;
  /** Rodzaj obiektu wektorowego otwartego do edycji narzędziem Manipulacja (null = brak). */
  onVectorEditKind?: (kind: 'line' | 'bezier' | 'shapes' | 'text' | null) => void;
  /** Zmieniło się zaznaczenie obiektów warstwy wektorowej (odśwież panel warstw). */
  onVectorSelectionChange?: () => void;
  /** Żądanie z panelu warstw: otwórz obiekt wektorowy do edycji. */
  vectorEditRequest?: { n: number; layerIndex: number; id: string } | null;
  onShowToast?: (msg: string) => void;
}

type TransformHandleType =
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w'
  | 'pivot'
  | 'rotate'
  | 'move'
  | 'p0'
  | 'p1'
  | 'p2'
  | 'p3'
  | 'pmove'
  | null;

interface ActiveVectorShapeSession {
  center: SKPoint;
  width: number;
  height: number;
  angle: number;
  pivot: SKPoint;
  flipX: boolean;
  flipY: boolean;
}

interface ActiveTextSession extends ActiveVectorShapeSession {
  /** true = wysokość ramki dopasowuje się do tekstu (ramka utworzona kliknięciem) */
  autoHeight: boolean;
}

const TEXT_CHAR_KEYS: (keyof TextCharStyle)[] = ['fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'script'];

interface ActiveVectorLineSession {
  p0: SKPoint;
  p1: SKPoint;
}

/** Krzywa wielowęzłowa: 'drawing' = trwa wyklikiwanie kolejnych węzłów, 'editing' = zakończona, ale jeszcze edytowalna. */
interface ActiveVectorBezierSession {
  nodes: PenNode[];
  closed: boolean;
  phase: 'drawing' | 'editing';
  selected: number;
}

interface PenDrag {
  kind: 'create' | 'node' | 'hin' | 'hout';
  index: number;
  startPt: SKPoint;
  startScreen: { x: number; y: number };
  moved: boolean;
  initNodes: PenNode[];
  /** po wstawieniu węzła na odcinku kliknięcie bez przesunięcia nie otwiera menu */
  inserted?: boolean;
}

const rotateCursorCache = new Map<number, string>();

function getRotateCursorUrl(angleDeg: number): string {
  const normAngle = ((Math.round(angleDeg / 5) * 5) % 360 + 360) % 360;
  const cached = rotateCursorCache.get(normAngle);
  if (cached) return cached;

  if (typeof document === 'undefined') return 'crosshair';

  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return 'crosshair';

  ctx.save();
  ctx.translate(16, 16);
  ctx.rotate((normAngle * Math.PI) / 180);

  const r = 9.5;
  const span = (55 * Math.PI) / 180;

  const cosSpan = Math.cos(span);
  const sinSpan = Math.sin(span);

  const p1x = r * cosSpan;
  const p1y = -r * sinSpan;
  const dir1x = -sinSpan;
  const dir1y = -cosSpan;

  const p2x = r * cosSpan;
  const p2y = r * sinSpan;
  const dir2x = -sinSpan;
  const dir2y = cosSpan;

  const arrowLen = 5.5;
  const arrowHalfW = 3.5;

  const drawCursorShape = (isOutline: boolean) => {
    ctx.lineWidth = isOutline ? 4.5 : 2.0;
    ctx.strokeStyle = isOutline ? '#ffffff' : '#111111';
    ctx.fillStyle = isOutline ? '#ffffff' : '#111111';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.arc(0, 0, r, -span, span, false);
    ctx.stroke();

    const tip1x = p1x + dir1x * 2.5;
    const tip1y = p1y + dir1y * 2.5;
    const norm1x = -dir1y;
    const norm1y = dir1x;
    const base1x = tip1x - dir1x * arrowLen;
    const base1y = tip1y - dir1y * arrowLen;

    ctx.beginPath();
    ctx.moveTo(tip1x, tip1y);
    ctx.lineTo(base1x + norm1x * arrowHalfW, base1y + norm1y * arrowHalfW);
    ctx.lineTo(base1x - norm1x * arrowHalfW, base1y - norm1y * arrowHalfW);
    ctx.closePath();
    ctx.fill();
    if (isOutline) ctx.stroke();

    const tip2x = p2x + dir2x * 2.5;
    const tip2y = p2y + dir2y * 2.5;
    const norm2x = -dir2y;
    const norm2y = dir2x;
    const base2x = tip2x - dir2x * arrowLen;
    const base2y = tip2y - dir2y * arrowLen;

    ctx.beginPath();
    ctx.moveTo(tip2x, tip2y);
    ctx.lineTo(base2x + norm2x * arrowHalfW, base2y + norm2y * arrowHalfW);
    ctx.lineTo(base2x - norm2x * arrowHalfW, base2y - norm2y * arrowHalfW);
    ctx.closePath();
    ctx.fill();
    if (isOutline) ctx.stroke();
  };

  drawCursorShape(true);
  drawCursorShape(false);

  ctx.restore();

  const dataUrl = canvas.toDataURL('image/png');
  const cursorCss = `url("${dataUrl}") 16 16, crosshair`;
  rotateCursorCache.set(normAngle, cursorCss);
  return cursorCss;
}

/** Od tylu pikseli dokument jest zawsze wyświetlany przez płótno kafelków wielkości widoku (patrz `presentIdle`). */
const BIG_DOC_PIXELS = 2_000_000;

export const CanvasViewport: React.FC<CanvasViewportProps> = ({
  engine,
  engineRevision,
  brushSettings,
  correctionBrushSettings = {
    brushType: 'dodge-burn',
    size: 20,
    hardness: 90,
    antiAliasing: true,
    spacing: 15,
    invertAction: false,
  },
  deformSettings = {
    actionType: 'expand-shrink',
    size: 60,
    hardness: 50,
    antiAliasing: true,
    spacing: 15,
    invertAction: false,
  },
  colorReplaceSettings = {
    size: 20,
    hardness: 90,
    antiAliasing: true,
    spacing: 15,
    tolerance: 30,
    mode: 'single',
  },
  stampSettings = {
    size: 30,
    hardness: 85,
    antiAliasing: true,
    spacing: 15,
    blendMode: 'SrcOver',
    sampleSource: 'image',
    sourceMode: 'relative',
  },
  stampBasePoint: externalStampBasePoint,
  onSetStampBasePoint,
  selectionSettings,
  pipetteSettings,
  gradientSettings = { type: 'linear', repeat: 'none', reverse: false },
  vectorShapeSettings,
  onChangeVectorShapeSettings,
  lineAndCurveSettings,
  onChangeLineAndCurveSettings,
  textSettings,
  textFormatRequest,
  onSyncTextSettings,
  textFocusTrigger,
  primaryColor = { r: 0, g: 0, b: 0, a: 255 },
  secondaryColor = { r: 255, g: 255, b: 255, a: 255 },
  onChangeSelectionSettings,
  activeTool: activeToolProp,
  zoom,
  panOffset,
  onUpdateZoom,
  onUpdatePan,
  onPipettePick,
  onCanvasModified,
  onLiveVectorSessionChange,
  liveVectorCommitTrigger,
  liveVectorCancelTrigger,
  penCloseToggleTrigger,
  onPenInfoChange,
  onVectorEditKind,
  onVectorSelectionChange,
  vectorEditRequest,
  onShowToast,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  // Płótno kafelków podglądu edycji (leży nad płótnem dokumentu) i jego renderer
  const tileCanvasRef = useRef<HTMLCanvasElement>(null);
  const tileRendererRef = useRef<ViewportTileRenderer | null>(null);
  const tileViewRef = useRef<{ zoom: number; left: number; top: number; width: number; height: number } | null>(null);
  const tileSessionRef = useRef(false);
  /** Płótno kafelków wyświetla dokument także poza sesją podglądu (duże powiększenie) - patrz `presentIdle`. */
  const tilePresentingRef = useRef(false);
  const tileWasSessionRef = useRef(false);
  const viewOnlyRef = useRef(false);
  const tileRendererEngineRef = useRef<GraphicEngine | null>(null);
  const baseSigRef = useRef<string | null>(null);
  /** Sygnatura, dla której płótno dokumentu jest już aktualne po lokalnej zmianie (patrz koniec pociągnięcia pędzla). */
  const skipRedrawSigRef = useRef<string | null>(null);
  /** Trwa rysowanie na płótnie przy otwartym oknie edycji efektów/stylizacji (patrz enterLiveOverSession). */
  const liveOverSessionRef = useRef(false);

  const baseSelectionModeRef = useRef<SelectionSettings['mode'] | null>(null);

  const [isPanning, setIsPanning] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // SESJE EDYCJI WEKTOROWEJ NA ŻYWO
  const [activeVectorLineSession, setActiveVectorLineSession] = useState<ActiveVectorLineSession | null>(null);
  const [activeVectorBezierSession, setActiveVectorBezierSession] = useState<ActiveVectorBezierSession | null>(null);
  // Lustro sesji krzywej dla obsługi zdarzeń (kilka zdarzeń może nadejść przed ponownym renderem)
  const penRef = useRef<ActiveVectorBezierSession | null>(null);
  penRef.current = activeVectorBezierSession;
  const penDragRef = useRef<PenDrag | null>(null);
  const [penMenu, setPenMenu] = useState<{ index: number } | null>(null);
  const [activeVectorShapeSession, setActiveVectorShapeSession] = useState<ActiveVectorShapeSession | null>(null);

  // SESJA EDYCJI TEKSTU (ramka + tekst z formatowaniem fragmentów)
  const [activeTextSession, setActiveTextSession] = useState<ActiveTextSession | null>(null);
  // Narzędzia Manipulacja i Pisak działają na istniejących sesjach: gdy sesja jest otwarta, obowiązują zasady narzędzia jej rodzaju
  const sessionKindTool: ToolType | null = activeVectorLineSession
    ? 'line'
    : activeVectorBezierSession
      ? 'bezier'
      : activeVectorShapeSession
        ? 'shapes'
        : activeTextSession
          ? 'text'
          : null;
  const activeTool: ToolType =
    (activeToolProp === 'vector-select' || activeToolProp === 'pen') && sessionKindTool ? sessionKindTool : activeToolProp;
  const manipKind = activeToolProp === 'vector-select' ? sessionKindTool : null;
  useEffect(() => {
    onVectorEditKind?.(manipKind as 'line' | 'bezier' | 'shapes' | 'text' | null);
  }, [manipKind, onVectorEditKind]);
  /** Swobodne rysowanie Pisakiem w toku (punkty w układzie dokumentu). */
  const freehandRef = useRef<{ pts: SKPoint[] } | null>(null);
  /** Zaznaczanie obiektów wektorowych obszarem (Manipulacja) i przeciąganie zbiorczej ramki. */
  const vecMarqueeRef = useRef<{ start: SKPoint; cur: SKPoint; base: string[] } | null>(null);
  const vecGroupDragRef = useRef<{ start: SKPoint } | null>(null);
  /** Otwarta krzywa pochodzi z Pisaka (trafia do obiektu z flagą freehand). */
  const penFreehandSessionRef = useRef(false);
  const textRtRef = useRef<RichText>(new RichText());
  const [textVersion, setTextVersion] = useState(0);
  const [textSel, setTextSel] = useState<{ anchor: number; focus: number }>({ anchor: 0, focus: 0 });
  const textSelRef = useRef<{ anchor: number; focus: number }>({ anchor: 0, focus: 0 });
  const textPendingStyleRef = useRef<TextCharStyle>(pickCharStyle(textSettings));
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const textComposingRef = useRef(false);
  const textDragRef = useRef<{ anchor: number } | null>(null);
  const textDesiredXRef = useRef<number | null>(null);
  const textLastClickRef = useRef<{ t: number; x: number; y: number; count: number }>({ t: 0, x: 0, y: 0, count: 0 });
  const textHistoryRef = useRef<{
    undo: { rt: RichText; anchor: number; focus: number }[];
    redo: { rt: RichText; anchor: number; focus: number }[];
  }>({ undo: [], redo: [] });
  const updateVectorHandleInteractionRef = useRef<((pt: SKPoint, shiftKey: boolean, altKey: boolean) => void) | null>(null);
  const updateInitialDrawingDragRef = useRef<((pt: SKPoint, shiftKey: boolean, altKey: boolean) => void) | null>(null);

  const bumpText = () => setTextVersion((v) => v + 1);
  const setTextSelection = (anchor: number, focus: number) => {
    textSelRef.current = { anchor, focus };
    setTextSel({ anchor, focus });
  };
  const resetTextModel = () => {
    textRtRef.current = new RichText();
    textHistoryRef.current = { undo: [], redo: [] };
    textDragRef.current = null;
    textDesiredXRef.current = null;
    textComposingRef.current = false;
    textSelRef.current = { anchor: 0, focus: 0 };
    setTextSel({ anchor: 0, focus: 0 });
    bumpText();
    if (textInputRef.current) {
      textInputRef.current.value = '';
      textInputRef.current.blur();
    }
  };

  const textLayout = useMemo(() => {
    if (!activeTextSession) return null;
    return layoutText(
      textRtRef.current,
      getTextInnerWidth(activeTextSession.width, textSettings),
      getTextLayoutOptions(textSettings, textPendingStyleRef.current)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    !!activeTextSession,
    activeTextSession?.width,
    textVersion,
    textSettings.align,
    textSettings.lineSpacing,
    textSettings.letterSpacing,
    textSettings.strokeWidth,
  ]);
  const textLayoutRef = useRef(textLayout);
  textLayoutRef.current = textLayout;

  // UCHWYTY INTERAKTYWNE WEKTOROWE
  const [activeVectorHandle, setActiveVectorHandle] = useState<string | null>(null);
  const activeVectorHandleRef = useRef<string | null>(null);
  const setActiveVectorHandleSynced = (val: string | null) => {
    activeVectorHandleRef.current = val;
    setActiveVectorHandle(val);
  };
  const [hoverVectorHandle, setHoverVectorHandle] = useState<string | null>(null);
  const vectorDragStartPtRef = useRef<SKPoint | null>(null);
  const vectorInitialSessionStateRef = useRef<any>(null);

  // STAN TRANSFORMACJI ZAZNACZENIA / ZAWARTOŚCI
  const isTransformTool = activeTool === 'transform-selection' || activeTool === 'transform-content';
  const [transformActiveHandle, setTransformActiveHandle] = useState<TransformHandleType>(null);
  const [transformHoverHandle, setTransformHoverHandle] = useState<TransformHandleType>(null);

  const transformActiveHandleRef = useRef<TransformHandleType>(null);
  const perspInitQuadRef = useRef<Quad | null>(null);
  const transformDownScreenRef = useRef<{ x: number; y: number } | null>(null);
  /** Czy wskaźnik oddalił się od punktu wciśnięcia (choćby chwilowo): wtedy puszczenie w tym samym miejscu nie jest kliknięciem. */
  const transformMovedRef = useRef(false);
  const setTransformActiveHandleSynced = (val: TransformHandleType) => {
    transformActiveHandleRef.current = val;
    setTransformActiveHandle(val);
  };

  const transformDragStartDocPtRef = useRef<SKPoint | null>(null);
  const transformInitialStateRef = useRef<TransformSelectionState | null>(null);
  const transformInitialHistorySnapshotRef = useRef<{ imgData: ImageData | null; seedPoint: SKPoint | null } | null>(null);
  const lastTransformPtRef = useRef<SKPoint | null>(null);

  const [dragStartPoint, setDragStartPoint] = useState<SKPoint | null>(null);
  const dragStartPointRef = useRef<SKPoint | null>(null);
  const setDragStartPointSynced = (val: SKPoint | null) => {
    dragStartPointRef.current = val;
    setDragStartPoint(val);
  };
  const [currentDragPoint, setCurrentDragPoint] = useState<SKPoint | null>(null);
  const [lassoPoints, setLassoPoints] = useState<SKPoint[]>([]);
  // Lasso „punkt po punkcie”: sesja trwa między kliknięciami aż do Enter / zamknięcia / Esc
  const lassoPointsRef = useRef<SKPoint[]>([]);
  const lassoMultiRef = useRef(false);
  const lassoPressRef = useRef<{ screen: { x: number; y: number }; moved: boolean; first: boolean } | null>(null);
  const [lassoMultiActive, setLassoMultiActive] = useState(false);
  const setLassoPts = (pts: SKPoint[]) => {
    lassoPointsRef.current = pts;
    setLassoPoints(pts);
  };

  const [isDrawing, setIsDrawing] = useState(false);
  const isDrawingRef = useRef<boolean>(false);
  const setIsDrawingSynced = (val: boolean) => {
    isDrawingRef.current = val;
    setIsDrawing(val);
  };

  const lastDocPtRef = useRef<SKPoint | null>(null);

  const [isDraggingWandHandle, setIsDraggingWandHandle] = useState(false);
  const wandDragInitialSnapshotRef = useRef<{ imgData: ImageData | null; seedPoint: SKPoint | null } | null>(null);
  const [isDraggingBucketHandle, setIsDraggingBucketHandle] = useState(false);
  const [isDraggingGradientHandle, setIsDraggingGradientHandle] = useState<0 | 1 | 'move' | null>(null);
  const [gradientHoverHandle, setGradientHoverHandle] = useState<0 | 1 | 'move' | null>(null);
  const gradientDragInitialStartPtRef = useRef<SKPoint | null>(null);
  const gradientDragInitialEndPtRef = useRef<SKPoint | null>(null);

  const [panStart, setPanStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);
  const lastBrushStrokeDocPointRef = useRef<SKPoint | null>(null);
  const [isShiftKeyDown, setIsShiftKeyDown] = useState<boolean>(false);
  const [isCtrlKeyDown, setIsCtrlKeyDown] = useState<boolean>(false);
  const isSamplingPipetteRef = useRef<boolean>(false);
  const pipetteIsSecondaryRef = useRef<boolean>(false);
  const brushIsSecondaryRef = useRef<boolean>(false);
  const activeCorrectionButtonRef = useRef<number>(0);
  const zoomButtonRef = useRef<number>(0);
  const colorReplaceTargetColorRef = useRef<SKColor>({ r: 0, g: 0, b: 0, a: 255 });
  const stampBasePointRef = useRef<SKPoint | null>(null);
  const stampStrokeStartPointRef = useRef<SKPoint | null>(null);
  const stampRelativeOffsetRef = useRef<SKPoint | null>(null);

  useEffect(() => {
    if (externalStampBasePoint) {
      stampBasePointRef.current = { ...externalStampBasePoint };
    }
  }, [externalStampBasePoint]);

  const getCorrectionSubAction = useCallback(
    (button: number): CorrectionSubAction => {
      const isRightClick = button === 2;
      const isReversed = correctionBrushSettings.invertAction ? !isRightClick : isRightClick;
      const type = correctionBrushSettings.brushType || 'dodge-burn';
      if (type === 'dodge-burn') {
        return isReversed ? 'burn' : 'dodge';
      } else if (type === 'blur-sharpen') {
        return isReversed ? 'sharpen' : 'blur';
      } else {
        return isReversed ? 'desaturate' : 'saturate';
      }
    },
    [correctionBrushSettings]
  );

  const getDeformSubAction = useCallback(
    (button: number): DeformSubAction => {
      const isRightClick = button === 2;
      const isReversed = deformSettings.invertAction ? !isRightClick : isRightClick;
      const action = deformSettings.actionType || 'expand-shrink';
      if (action === 'expand-shrink') {
        return isReversed ? 'shrink' : 'expand';
      } else if (action === 'smudge') {
        return isReversed ? 'smudge-rev' : 'smudge';
      } else {
        return isReversed ? 'twirl-ccw' : 'twirl-cw';
      }
    },
    [deformSettings]
  );

  const isDrawingTool = useCallback((tool: ToolType): boolean => {
    return (
      tool === 'brush' ||
      tool === 'eraser' ||
      tool === 'correction-brush' ||
      tool === 'deform' ||
      tool === 'color-replace' ||
      tool === 'bucket' ||
      tool === 'gradient' ||
      tool === 'line' ||
      tool === 'bezier' ||
      tool === 'shapes' ||
      tool === 'stamp' ||
      tool === 'text'
    );
  }, []);

  const isQuickPipetteActive = isCtrlKeyDown && isDrawingTool(activeTool) && activeTool !== 'stamp';

  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    setContainerSize({ width: el.clientWidth, height: el.clientHeight });

    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Powiadomienie o stanie aktywnej sesji wektorowej
  const isAnyVectorSessionActive = !!(
    activeVectorLineSession ||
    activeVectorBezierSession ||
    activeVectorShapeSession ||
    activeTextSession
  );

  useEffect(() => {
    onLiveVectorSessionChange?.(isAnyVectorSessionActive || lassoMultiActive);
  }, [isAnyVectorSessionActive, lassoMultiActive, onLiveVectorSessionChange]);

  // FUNKCJE ZATWIERDZANIA I ANULOWANIA SESJI WEKTOROWYCH
  const commitActiveVectorSession = useCallback(() => {
    if (activeVectorLineSession) {
      engine.commitVectorLine(
        activeVectorLineSession.p0,
        activeVectorLineSession.p1,
        lineAndCurveSettings
      );
      setActiveVectorLineSession(null);
      onCanvasModified();
    } else if (activeVectorBezierSession) {
      const bs = activeVectorBezierSession;
      engine.commitVectorPath(normalizeOpenEnds(bs.nodes, bs.closed), bs.closed, lineAndCurveSettings, penFreehandSessionRef.current);
      penFreehandSessionRef.current = false;
      penRef.current = null;
      penDragRef.current = null;
      setPenMenu(null);
      setActiveVectorBezierSession(null);
      onCanvasModified();
    } else if (activeVectorShapeSession) {
      engine.commitVectorShape(
        activeVectorShapeSession.center,
        activeVectorShapeSession.width,
        activeVectorShapeSession.height,
        activeVectorShapeSession.angle,
        vectorShapeSettings,
        activeVectorShapeSession.flipX,
        activeVectorShapeSession.flipY
      );
      setActiveVectorShapeSession(null);
      onCanvasModified();
    } else if (activeTextSession) {
      engine.commitVectorText(
        activeTextSession.center,
        activeTextSession.width,
        activeTextSession.height,
        activeTextSession.angle,
        textRtRef.current,
        textSettings,
        textPendingStyleRef.current,
        activeTextSession.autoHeight
      );
      setActiveTextSession(null);
      resetTextModel();
      onCanvasModified();
    }
  }, [
    activeVectorLineSession,
    activeVectorBezierSession,
    activeVectorShapeSession,
    activeTextSession,
    engine,
    lineAndCurveSettings,
    vectorShapeSettings,
    textSettings,
    onCanvasModified,
  ]);

  // silnik wywołuje to przy cofnięciu: otwarty element jest zatwierdzany, a następnie cofany (tak jak gradient)
  const commitVectorRef = useRef(commitActiveVectorSession);
  commitVectorRef.current = commitActiveVectorSession;
  const vectorActiveRef = useRef(false);
  vectorActiveRef.current = isAnyVectorSessionActive;
  useEffect(() => {
    engine.setVectorSessionHook({ active: () => vectorActiveRef.current, commit: () => commitVectorRef.current() });
    return () => engine.setVectorSessionHook(null);
  }, [engine]);

  const cancelActiveVectorSession = useCallback(() => {
    engine.vec.cancelEdit();
    penFreehandSessionRef.current = false;
    freehandRef.current = null;
    setActiveVectorLineSession(null);
    penRef.current = null;
    penDragRef.current = null;
    setPenMenu(null);
    setActiveVectorBezierSession(null);
    setActiveVectorShapeSession(null);
    setActiveTextSession(null);
    resetTextModel();
    setActiveVectorHandleSynced(null);
    vectorDragStartPtRef.current = null;
    vectorInitialSessionStateRef.current = null;
    setIsDrawingSynced(false);
    setDragStartPointSynced(null);
    onCanvasModified();
  }, [engine, onCanvasModified]);

  // ===== EDYCJA TEKSTU: historia, wstawianie, nawigacja, formatowanie =====
  const textSelRange = (): [number, number] => {
    const { anchor, focus } = textSelRef.current;
    return [Math.min(anchor, focus), Math.max(anchor, focus)];
  };

  const snapshotText = () => ({
    rt: textRtRef.current.clone(),
    anchor: textSelRef.current.anchor,
    focus: textSelRef.current.focus,
  });

  const pushTextHistory = () => {
    const h = textHistoryRef.current;
    h.undo.push(snapshotText());
    if (h.undo.length > 200) h.undo.shift();
    h.redo = [];
  };

  const undoText = () => {
    const h = textHistoryRef.current;
    const snap = h.undo.pop();
    if (!snap) return;
    h.redo.push(snapshotText());
    textRtRef.current = snap.rt;
    setTextSelection(snap.anchor, snap.focus);
    bumpText();
  };

  const redoText = () => {
    const h = textHistoryRef.current;
    const snap = h.redo.pop();
    if (!snap) return;
    h.undo.push(snapshotText());
    textRtRef.current = snap.rt;
    setTextSelection(snap.anchor, snap.focus);
    bumpText();
  };

  const insertText = (raw: string) => {
    const str = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    if (!str) return;
    const rt = textRtRef.current;
    const [a, b] = textSelRange();
    const style = pickCharStyle(rt.styleForRange(a, b) ?? textPendingStyleRef.current);
    pushTextHistory();
    if (b > a) rt.delete(a, b);
    rt.insert(a, str, style);
    textPendingStyleRef.current = style;
    setTextSelection(a + str.length, a + str.length);
    textDesiredXRef.current = null;
    bumpText();
  };

  const deleteBackward = (byWord: boolean) => {
    const rt = textRtRef.current;
    const [a, b] = textSelRange();
    let start = a;
    let end = b;
    if (a === b) {
      if (a === 0) return;
      const plain = rt.plainText;
      start = byWord ? prevWordIndex(plain, a) : a - 1;
      const c = plain.charCodeAt(start);
      if (!byWord && c >= 0xdc00 && c <= 0xdfff && start > 0) start--;
    }
    pushTextHistory();
    const style = rt.styleForRange(start, start) ?? textPendingStyleRef.current;
    rt.delete(start, end);
    if (rt.length === 0) textPendingStyleRef.current = pickCharStyle(style);
    setTextSelection(start, start);
    textDesiredXRef.current = null;
    bumpText();
  };

  const deleteForward = (byWord: boolean) => {
    const rt = textRtRef.current;
    const [a, b] = textSelRange();
    let start = a;
    let end = b;
    if (a === b) {
      if (a >= rt.length) return;
      const plain = rt.plainText;
      end = byWord ? nextWordIndex(plain, a) : a + 1;
      const c = plain.charCodeAt(a);
      if (!byWord && c >= 0xd800 && c <= 0xdbff && end < rt.length) end++;
    }
    pushTextHistory();
    rt.delete(start, end);
    setTextSelection(start, start);
    textDesiredXRef.current = null;
    bumpText();
  };

  const moveTextCaret = (idx: number, extend: boolean, keepDesiredX = false) => {
    const len = textRtRef.current.length;
    idx = Math.max(0, Math.min(len, idx));
    const { anchor } = textSelRef.current;
    setTextSelection(extend ? anchor : idx, idx);
    if (!keepDesiredX) textDesiredXRef.current = null;
  };

  const moveTextVertical = (dir: -1 | 1, extend: boolean) => {
    const lay = textLayoutRef.current;
    if (!lay) return;
    const { focus } = textSelRef.current;
    const info = getCaretInfo(lay, focus);
    const x = textDesiredXRef.current ?? info.x;
    textDesiredXRef.current = x;
    const li = info.line + dir;
    let idx: number;
    if (li < 0) idx = 0;
    else if (li >= lay.lines.length) idx = textRtRef.current.length;
    else idx = hitTestIndex(lay, x, lay.lines[li].top + lay.lines[li].height / 2);
    moveTextCaret(idx, extend, true);
  };

  const applyCharStylePatch = (patch: Partial<TextCharStyle>) => {
    const rt = textRtRef.current;
    const [a, b] = textSelRange();
    pushTextHistory();
    // Zaznaczenie → tylko fragment; brak zaznaczenia → cały tekst + styl nowo wpisywanych znaków
    if (b > a) rt.applyStyle(a, b, patch);
    else rt.applyStyle(0, rt.length, patch);
    textPendingStyleRef.current = { ...textPendingStyleRef.current, ...patch };
    bumpText();
  };

  const toggleCharStyle = (key: 'bold' | 'italic' | 'underline') => {
    const [a, b] = textSelRange();
    const cur = textRtRef.current.styleForRange(a, b) ?? textPendingStyleRef.current;
    applyCharStylePatch({ [key]: !cur[key] } as Partial<TextCharStyle>);
  };

  const getTextLocalPoint = (pt: SKPoint): SKPoint | null => {
    const sess = activeTextSession;
    if (!sess) return null;
    const inset = getTextInset(textSettings);
    const dx = pt.x - sess.center.x;
    const dy = pt.y - sess.center.y;
    const cos = Math.cos(sess.angle);
    const sin = Math.sin(sess.angle);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    return { x: lx + sess.width / 2 - inset, y: ly + sess.height / 2 - inset };
  };

  const textIndexAtDocPoint = (pt: SKPoint): number => {
    const lay = textLayoutRef.current;
    const lp = getTextLocalPoint(pt);
    if (!lay || !lp) return 0;
    return hitTestIndex(lay, lp.x, lp.y);
  };

  const createDefaultTextSession = (start: SKPoint) => {
    const inset = getTextInset(textSettings);
    const w = 240;
    const h = Math.max(8, Math.round(textSettings.fontSize * 1.2) + 2 * inset);
    const left = Math.round(start.x);
    const top = Math.round(start.y);
    const center = { x: left + w / 2, y: top + h / 2 };
    setActiveTextSession({
      center,
      width: w,
      height: h,
      angle: 0,
      pivot: { ...center },
      flipX: false,
      flipY: false,
      autoHeight: true,
    });
  };

  const handleTextKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (textComposingRef.current || e.nativeEvent.isComposing) return;
    const key = e.key;

    if (key === 'Shift' || key === 'Alt') {
      const pt = lastDocPtRef.current;
      if (pt) {
        const shiftKey = e.shiftKey || key === 'Shift';
        const altKey = e.altKey || key === 'Alt';
        if (activeVectorHandleRef.current) {
          updateVectorHandleInteractionRef.current?.(pt, shiftKey, altKey);
        } else if (isDrawingRef.current && dragStartPointRef.current) {
          updateInitialDrawingDragRef.current?.(pt, shiftKey, altKey);
        }
      }
      return;
    }

    e.stopPropagation();
    const ctrl = e.ctrlKey || e.metaKey;
    const shift = e.shiftKey;
    const rt = textRtRef.current;
    const lay = textLayoutRef.current;
    const { focus } = textSelRef.current;
    const [selA, selB] = textSelRange();

    if (key === 'Escape') {
      e.preventDefault();
      cancelActiveVectorSession();
      return;
    }
    if (key === 'Enter') {
      e.preventDefault();
      if (ctrl) commitActiveVectorSession();
      else insertText('\n');
      return;
    }
    if (ctrl) {
      const k = key.toLowerCase();
      if (k === 'a') {
        e.preventDefault();
        setTextSelection(0, rt.length);
        return;
      }
      if (k === 'z') {
        e.preventDefault();
        if (shift) redoText();
        else if (textHistoryRef.current.undo.length > 0) undoText();
        else {
          // historia pisania wyczerpana: cofnięcie dotyczy już całego elementu tekstowego
          if (rt.length === 0) cancelActiveVectorSession();
          else {
            engine.undo();
            onCanvasModified();
          }
        }
        return;
      }
      if (k === 'y') {
        e.preventDefault();
        redoText();
        return;
      }
      if (k === 'b' || k === 'i' || k === 'u') {
        e.preventDefault();
        toggleCharStyle(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline');
        return;
      }
    }
    switch (key) {
      case 'Backspace':
        e.preventDefault();
        deleteBackward(ctrl);
        return;
      case 'Delete':
        e.preventDefault();
        deleteForward(ctrl);
        return;
      case 'Tab':
        e.preventDefault();
        insertText('    ');
        return;
      case 'ArrowLeft':
        e.preventDefault();
        if (!shift && selA !== selB) moveTextCaret(selA, false);
        else moveTextCaret(ctrl ? prevWordIndex(rt.plainText, focus) : focus - 1, shift);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (!shift && selA !== selB) moveTextCaret(selB, false);
        else moveTextCaret(ctrl ? nextWordIndex(rt.plainText, focus) : focus + 1, shift);
        return;
      case 'ArrowUp':
        e.preventDefault();
        moveTextVertical(-1, shift);
        return;
      case 'ArrowDown':
        e.preventDefault();
        moveTextVertical(1, shift);
        return;
      case 'Home':
        e.preventDefault();
        if (ctrl || !lay) moveTextCaret(0, shift);
        else moveTextCaret(lay.lines[findLineForIndex(lay, focus)].start, shift);
        return;
      case 'End':
        e.preventDefault();
        if (ctrl || !lay) moveTextCaret(rt.length, shift);
        else moveTextCaret(lineEndCaretIndex(lay.lines[findLineForIndex(lay, focus)]), shift);
        return;
      default:
        break;
    }
  };

  const handleTextKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const key = e.key;
    if (key === 'Shift' || key === 'Alt') {
      const pt = lastDocPtRef.current;
      if (pt) {
        const shiftKey = key === 'Shift' ? false : e.shiftKey;
        const altKey = key === 'Alt' ? false : e.altKey;
        if (activeVectorHandleRef.current) {
          updateVectorHandleInteractionRef.current?.(pt, shiftKey, altKey);
        } else if (isDrawingRef.current && dragStartPointRef.current) {
          updateInitialDrawingDragRef.current?.(pt, shiftKey, altKey);
        }
      }
    }
  };

  const handleTextInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if (textComposingRef.current) return;
    const v = e.currentTarget.value;
    e.currentTarget.value = '';
    if (v) insertText(v);
  };

  const handleTextCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    textComposingRef.current = false;
    const v = e.data || e.currentTarget.value;
    e.currentTarget.value = '';
    if (v) insertText(v);
  };

  const getSelectedPlainText = (): string => {
    const [a, b] = textSelRange();
    return textRtRef.current.plainText.slice(a, b);
  };

  const handleTextCopy = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const t = getSelectedPlainText();
    if (!t) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', t);
  };

  const handleTextCut = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const t = getSelectedPlainText();
    if (!t) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', t);
    deleteBackward(false);
  };

  const handleTextPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    e.stopPropagation();
    insertText(e.clipboardData.getData('text/plain'));
  };

  const focusTextInput = () => {
    textInputRef.current?.focus({ preventScroll: true });
  };

  // Start sesji tekstu: styl początkowy z paska opcji, fokus w edytorze
  const hasTextSession = !!activeTextSession;
  const textOpenedExistingRef = useRef(false);
  useEffect(() => {
    if (hasTextSession) {
      if (textOpenedExistingRef.current) {
        // istniejący obiekt tekstowy: zostaje jego tekst i styl, kursor na końcu
        textOpenedExistingRef.current = false;
        const n = textRtRef.current.length;
        setTextSelection(n, n);
      } else {
        textPendingStyleRef.current = pickCharStyle(textSettings);
        setTextSelection(0, 0);
      }
      bumpText();
      focusTextInput();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasTextSession]);

  useEffect(() => {
    if (textFocusTrigger && hasTextSession) focusTextInput();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textFocusTrigger]);

  // Zmiany formatowania z paska opcji → zaznaczenie albo cały tekst
  const lastTextRequestIdRef = useRef(0);
  useEffect(() => {
    const req = textFormatRequest;
    if (!req || req.id === lastTextRequestIdRef.current) return;
    lastTextRequestIdRef.current = req.id;
    if (!activeTextSession) return;
    const patch: Partial<TextCharStyle> = {};
    for (const k of TEXT_CHAR_KEYS) {
      if (k in req.patch) (patch as any)[k] = (req.patch as any)[k];
    }
    if (Object.keys(patch).length) applyCharStylePatch(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textFormatRequest]);

  // Pasek opcji pokazuje styl w miejscu kursora / zaznaczenia
  useEffect(() => {
    if (!activeTextSession || !onSyncTextSettings) return;
    const [a, b] = textSelRange();
    const st = textRtRef.current.styleForRange(a, b) ?? textPendingStyleRef.current;
    const diff: Partial<TextToolSettings> = {};
    for (const k of TEXT_CHAR_KEYS) {
      if ((st as any)[k] !== (textSettings as any)[k]) (diff as any)[k] = (st as any)[k];
    }
    if (Object.keys(diff).length) onSyncTextSettings(diff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textSel, textVersion, hasTextSession]);

  // Automatyczna wysokość ramki (ramka utworzona kliknięciem)
  useEffect(() => {
    const sess = activeTextSession;
    if (!sess || !sess.autoHeight || !textLayout) return;
    const need = Math.max(4, Math.ceil(textLayout.height) + 2 * getTextInset(textSettings));
    if (need === sess.height) return;
    const dh = need - sess.height;
    const cos = Math.cos(sess.angle);
    const sin = Math.sin(sess.angle);
    const center = { x: sess.center.x - (sin * dh) / 2, y: sess.center.y + (cos * dh) / 2 };
    setActiveTextSession({ ...sess, height: need, center, pivot: { ...center } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textLayout, activeTextSession?.autoHeight, activeTextSession?.height, textSettings.strokeWidth]);

  // Reakcja na zewnętrzne triggery (z paska opcji)
  const prevCommitTriggerRef = useRef(liveVectorCommitTrigger);
  useEffect(() => {
    if (liveVectorCommitTrigger && liveVectorCommitTrigger !== prevCommitTriggerRef.current) {
      prevCommitTriggerRef.current = liveVectorCommitTrigger;
      commitActiveVectorSession();
    }
  }, [liveVectorCommitTrigger, commitActiveVectorSession]);

  const prevCancelTriggerRef = useRef(liveVectorCancelTrigger);
  useEffect(() => {
    if (liveVectorCancelTrigger && liveVectorCancelTrigger !== prevCancelTriggerRef.current) {
      prevCancelTriggerRef.current = liveVectorCancelTrigger;
      cancelActiveVectorSession();
    }
  }, [liveVectorCancelTrigger, cancelActiveVectorSession]);

  // Automatyczne zatwierdzenie przy zmianie narzędzia na inne oraz start/commit sesji transformacji
  useEffect(() => {
    if (activeTool !== 'line' && activeVectorLineSession) {
      commitActiveVectorSession();
    }
    if (activeTool !== 'bezier' && activeVectorBezierSession) {
      commitActiveVectorSession();
    }
    if (activeTool !== 'shapes' && activeVectorShapeSession) {
      commitActiveVectorSession();
    }
    if (activeTool !== 'text' && activeTextSession) {
      commitActiveVectorSession();
    }
    if (activeTool === 'transform-content') {
      if (engine.selectionManager.transformState && !engine.transformContentSession) {
        engine.selectionManager.commitTransformSelection();
      }
      if (!engine.transformContentSession && engine.selectionManager.hasActiveSelection) {
        engine.beginTransformContent(selectionSettings.interpolation || 'bilinear');
        onCanvasModified();
      }
    } else if (activeTool === 'transform-selection') {
      if (engine.transformContentSession) {
        engine.commitTransformContent();
        onCanvasModified();
      }
      if (!engine.selectionManager.transformState && engine.selectionManager.hasActiveSelection) {
        engine.selectionManager.beginTransformSelection();
        onCanvasModified();
      }
    } else {
      if (engine.transformContentSession) {
        engine.commitTransformContent();
        onCanvasModified();
      }
      if (engine.selectionManager.transformState) {
        engine.selectionManager.commitTransformSelection();
        onCanvasModified();
      }
    }
    if (activeTool !== 'magic-wand' && engine.wandBusy) engine.flushPendingFill();
    if (activeTool !== 'bucket' && engine.bucketSeedPoint) {
      engine.commitPaintBucketSession();
      onCanvasModified();
    }
    if (activeTool !== 'gradient' && engine.gradientStartPoint) {
      engine.commitGradientSession();
      onCanvasModified();
    }
    if (activeTool !== 'brush' && activeTool !== 'eraser') {
      lastBrushStrokeDocPointRef.current = null;
    }
  }, [activeTool, engine, selectionSettings.interpolation, onCanvasModified]);

  // Reakcja na zmianę parametrów wiadra z farbą i koloru na żywo (gdy aktywna jest sesja wiadra)
  useEffect(() => {
    if (activeTool === 'bucket' && engine.bucketSeedPoint) {
      const col = engine.bucketColorSource === 'secondary' ? secondaryColor : primaryColor;
      // Liczenie obszaru idzie w tle; silnik sam odświeża widok, gdy wynik jest gotowy
      engine.applyPaintBucket(
        engine.bucketSeedPoint,
        selectionSettings,
        { ...brushSettings, color: col },
        false
      );
    }
  }, [
    activeTool,
    engine,
    selectionSettings.tolerance,
    selectionSettings.wandMode,
    selectionSettings.sampleSource,
    brushSettings.blendMode,
    brushSettings.antiAliasing,
    primaryColor,
    secondaryColor,
    onCanvasModified,
  ]);

  // Reakcja na zmianę parametrów magicznej różdżki na żywo (gdy aktywna jest sesja różdżki)
  // Odświeżenia różdżki (suwak tolerancji, przeciąganie uchwytu) są łączone: najwyżej jedno na klatkę, z najnowszymi
  // wartościami. Przy długim odświeżeniu zdarzenia nie ustawiają się w kolejkę, więc interfejs nie laguje po zatrzymaniu.
  const selectionSettingsLatestRef = useRef(selectionSettings);
  selectionSettingsLatestRef.current = selectionSettings;
  const wandRefreshRafRef = useRef<number | null>(null);
  const wandPendingPointRef = useRef<SKPoint | null>(null);
  const wandRefreshPendingRef = useRef(false);
  const onCanvasModifiedRef = useRef(onCanvasModified);
  onCanvasModifiedRef.current = onCanvasModified;

  // Wyniki liczone w tle (różdżka, wiadro) odświeżają widok, gdy są gotowe
  useEffect(() => {
    const cb = () => onCanvasModifiedRef.current();
    engine.onAsyncUpdate = cb;
    return () => {
      if (engine.onAsyncUpdate === cb) engine.onAsyncUpdate = null;
    };
  }, [engine]);

  const runWandRefresh = useCallback(() => {
    if (wandRefreshRafRef.current !== null) {
      cancelAnimationFrame(wandRefreshRafRef.current);
      wandRefreshRafRef.current = null;
    }
    if (!wandRefreshPendingRef.current) return;
    wandRefreshPendingRef.current = false;
    const pt = wandPendingPointRef.current;
    wandPendingPointRef.current = null;
    if (pt || engine.selectionManager.wandSeedPoint) {
      const st = selectionSettingsLatestRef.current;
      engine.refreshMagicWand(st, pt ?? undefined);
      // Bez piórkowania wynik liczy się w tle i silnik odświeży widok sam; z piórkowaniem jest gotowy od razu
      if (st.feather > 0) onCanvasModifiedRef.current();
    }
  }, [engine]);

  const scheduleWandRefresh = useCallback(
    (pt?: SKPoint) => {
      if (pt) wandPendingPointRef.current = pt;
      wandRefreshPendingRef.current = true;
      if (wandRefreshRafRef.current === null) {
        wandRefreshRafRef.current = requestAnimationFrame(() => {
          wandRefreshRafRef.current = null;
          runWandRefresh();
        });
      }
    },
    [runWandRefresh]
  );

  useEffect(() => {
    if (activeTool === 'magic-wand' && engine.selectionManager.wandSeedPoint) {
      scheduleWandRefresh();
    }
  }, [
    activeTool,
    engine,
    selectionSettings.tolerance,
    selectionSettings.wandMode,
    selectionSettings.sampleSource,
    scheduleWandRefresh,
  ]);

  // Kopia pikseli próbkowanych przez różdżkę zajmuje dużo pamięci - zwalniamy ją po opuszczeniu narzędzia
  useEffect(() => {
    if (activeTool === 'magic-wand' || activeTool === 'bucket') return;
    engine.releaseWandSample();
  }, [activeTool, engine]);

  useEffect(
    () => () => {
      if (wandRefreshRafRef.current !== null) cancelAnimationFrame(wandRefreshRafRef.current);
      wandRefreshRafRef.current = null;
    },
    []
  );

  // Reakcja na zmianę parametrów gradientu na żywo (gdy aktywna jest sesja gradientu)
  useEffect(() => {
    if (activeTool === 'gradient' && engine.gradientStartPoint && engine.gradientEndPoint) {
      engine.applyGradient(
        engine.gradientStartPoint,
        engine.gradientEndPoint,
        gradientSettings,
        primaryColor,
        secondaryColor,
        gradientSettings.blendMode || 'SrcOver',
        false,
        engine.gradientColorSource
      );
      onCanvasModified();
    }
  }, [
    activeTool,
    engine,
    gradientSettings,
    primaryColor,
    secondaryColor,
    onCanvasModified,
  ]);



  // REDRAW & COMPOSITE TO VIEWPORT
  /**
   * Poza sesją podglądu przy dużym powiększeniu (piksele jako duże bloki) dokument wyświetla płótno kafelków - tym samym
   * rastrem co podgląd, więc wypełnienia i zaznaczenia pasują do pikseli bez przesunięć o 1 px i szczelin (zwykłe płótno
   * skalowane przez CSS zaokrągla krawędzie pikseli inaczej). Przy mniejszym powiększeniu płótno kafelków jest puste.
   */
  const presentIdle = (dirty: SKRectI | null, win?: { canvas: HTMLCanvasElement; left: number; top: number } | null): void => {
    const tr = tileRendererRef.current;
    const cv = canvasRef.current;
    const tv = tileViewRef.current;
    if (!tr || !cv || !tv || tileSessionRef.current) return;
    // Duże płótno: każda zmiana płótna dokumentu o rozmiarze całego dokumentu (np. 4000x3000) kosztuje przy wyświetleniu
    // (wysyłanie 12 Mpx do kompozytora), nawet gdy pociągnięcie pędzla dotyka małego obszaru. Dlatego przy dużych
    // dokumentach zawsze pokazujemy płótno kafelków wielkości widoku, odświeżane tylko w zmienionym fragmencie.
    const bigDoc = engine.width * engine.height >= BIG_DOC_PIXELS;
    if (tv.zoom >= 2 || bigDoc) {
      if (tileWasSessionRef.current || !tilePresentingRef.current) {
        tr.clear();
        dirty = null;
      }
      tileWasSessionRef.current = false;
      tilePresentingRef.current = true;
      tr.present(tv, cv, dirty, win);
      cv.style.visibility = 'hidden';
    } else {
      if (tilePresentingRef.current || tileWasSessionRef.current) tr.clear();
      tileWasSessionRef.current = false;
      tilePresentingRef.current = false;
      cv.style.visibility = '';
    }
  };

  useEffect(() => {
    (globalThis as { __figuraEngine?: unknown }).__figuraEngine = engine;
    engine.onViewportComposited = (_target, dirty, win) => presentIdle(dirty, win);
    return () => {
      engine.onViewportComposited = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

  const redraw = useCallback(() => {
    if (!canvasRef.current) return;

    // Przekaż niestandardowy preview renderer dla aktywnej sesji wektorowej
    const customPreview = (ctx: CanvasRenderingContext2D) => {
      if (activeVectorLineSession) {
        renderVectorLine(
          ctx,
          activeVectorLineSession.p0,
          activeVectorLineSession.p1,
          { ...lineAndCurveSettings, blendMode: 'SrcOver' }
        );
      } else if (activeVectorBezierSession) {
        renderVectorPath(
          ctx,
          activeVectorBezierSession.nodes,
          activeVectorBezierSession.closed,
          { ...lineAndCurveSettings, blendMode: 'SrcOver' }
        );
      } else if (activeVectorShapeSession) {
        renderVectorShape(
          ctx,
          activeVectorShapeSession.center,
          activeVectorShapeSession.width,
          activeVectorShapeSession.height,
          activeVectorShapeSession.angle,
          { ...vectorShapeSettings, blendMode: 'SrcOver' },
          activeVectorShapeSession.flipX,
          activeVectorShapeSession.flipY
        );
      } else if (activeTextSession) {
        renderVectorText(
          ctx,
          activeTextSession.center,
          activeTextSession.width,
          activeTextSession.height,
          activeTextSession.angle,
          textRtRef.current,
          { ...textSettings, blendMode: 'SrcOver' },
          textLayout ?? undefined,
          textPendingStyleRef.current
        );
      }
    };

    const currentBlendMode = activeTextSession
      ? textSettings.blendMode
      : activeVectorShapeSession
      ? vectorShapeSettings.blendMode
      : lineAndCurveSettings.blendMode;

    const tileCanvas = tileCanvasRef.current;

    const gradientPreview = engine.gradientPreview;
    const bucketPreview = engine.getBucketPreview();
    if (tileCanvas && tileRendererEngineRef.current !== engine) {
      tileRendererRef.current?.dispose();
      tileRendererRef.current = new ViewportTileRenderer(tileCanvas, engine);
      tileRendererEngineRef.current = engine;
    }
    // Widok kafelków (piksele urządzenia): jedna powierzchnia wyświetlająca dokument zarówno w sesji podglądu, jak i poza nią
    const cW0 = containerSize.width || containerRef.current?.clientWidth || 0;
    const cH0 = containerSize.height || containerRef.current?.clientHeight || 0;
    const dpr0 = window.devicePixelRatio || 1;
    const tileView = {
      zoom: zoom * dpr0,
      left: Math.round((cW0 / 2 + panOffset.x - (engine.width * zoom) / 2) * dpr0),
      top: Math.round((cH0 / 2 + panOffset.y - (engine.height * zoom) / 2) * dpr0),
      width: Math.round(cW0 * dpr0),
      height: Math.round(cH0 * dpr0),
    };
    tileViewRef.current = tileView;
    // Przekształcanie zawartości zaznaczenia (oderwany fragment: przenoszenie, skalowanie, obrót) to też podgląd kafelkowy
    const tcs = engine.transformContentSession;
    const tst = engine.selectionManager.transformState;
    const contentSessionActive = !!tcs && !!tst && tcs.sourceLayerIndex === engine.activeLayerIndex && !!tileCanvas;
    // wycięcie fragmentu z warstwy dopiero po pierwszej zmianie ramki: w stanie początkowym widać nietknięty oryginał
    if (contentSessionActive) engine.syncContentCut();
    const contentIdentity = contentSessionActive && engine.contentTransformIsIdentity();
    engine.floatingContentExternal = contentSessionActive;
    // Okno korekcji nieniszczącej: podgląd na żywo składają kafelki (od lewego górnego rogu), a nie pełna kompozycja dokumentu
    const correctionSessionActive = engine.hasCorrectionSession && !!tileCanvas;
    // Rysowanie pędzlem przy otwartym oknie efektów/stylizacji: podgląd na żywo składa zwykła kompozycja (z efektami edytowanej
    // warstwy), a nie kafelkowy podgląd sesji, który nie zna bieżącego pociągnięcia
    const liveOverSession = liveOverSessionRef.current;
    const sessionNow = (isAnyVectorSessionActive || !!gradientPreview || !!bucketPreview || contentSessionActive || (correctionSessionActive && !liveOverSession)) && !!tileCanvas;
    tileSessionRef.current = sessionNow;
    if (sessionNow) {
      skipRedrawSigRef.current = null;
      tilePresentingRef.current = false;
      tileWasSessionRef.current = true;
      // SZYBKI PODGLĄD EDYCJI: kafelki ekranu renderowane promieniowo od kursora, przerywane przy każdym ruchu.
      const tr = tileRendererRef.current!;

      // Jeśli podkład zmienił się w trakcie sesji (np. cofnięcie), odśwież płótno dokumentu bez podglądu
      const sig = engine.getBaseSignature();
      if (baseSigRef.current !== null && baseSigRef.current !== sig) {
        engine.compositeToViewport(canvasRef.current, null, null, null, null, null, null, null);
        tr.invalidateBase();
      }
      baseSigRef.current = sig;
      tr.setBase(canvasRef.current);
      // Płótno kafelków pracuje w pikselach urządzenia (devicePixelRatio) i samo rysuje dokument, więc podgląd i reszta
      // widoku przechodzą przez ten sam resampler; zwykłe płótno jest wtedy tylko ukryte (zachowuje układ do getDocPoint).
      const dpr = dpr0;

      const cW = containerSize.width || containerRef.current?.clientWidth || 0;
      const cH = containerSize.height || containerRef.current?.clientHeight || 0;
      const left = Math.round((cW / 2 + panOffset.x - (engine.width * zoom) / 2) * dpr);
      const top = Math.round((cH / 2 + panOffset.y - (engine.height * zoom) / 2) * dpr);

      let bounds;
      let centerDoc: SKPoint;
      let contentKey: string | undefined;
      let previewRender: (ctx: CanvasRenderingContext2D) => void = customPreview;
      let previewBlend = currentBlendMode;
      const correctionOnly = correctionSessionActive && !isAnyVectorSessionActive && !gradientPreview && !bucketPreview && !contentSessionActive;
      // Edycja istniejącego obiektu wektorowego, nad którym leżą inne: obiekt jest przebudowywany w pikselach warstwy
      // (właściwa kolejność, tryby mieszania i efekty), więc nakładka niczego nie rysuje - tylko uchwyty
      const vecLive = engine.vec.liveEditing && isAnyVectorSessionActive && !gradientPreview && !bucketPreview && !contentSessionActive;
      if (vecLive) {
        previewRender = () => {};
        previewBlend = 'SrcOver';
        bounds = { left: 0, top: 0, right: engine.width, bottom: engine.height, width: engine.width, height: engine.height };
        centerDoc = { x: 0, y: 0 };
        contentKey = 'vl:' + engine.vec.liveVersion + ':' + engine.activeLayerIndex;
      } else if (correctionOnly) {
        // Sama korekcja: brak własnego rysunku narzędzia, kafelki tylko składają dokument z korekcjami aktywnej warstwy
        previewRender = () => {};
        previewBlend = 'SrcOver';
        bounds = { left: 0, top: 0, right: engine.width, bottom: engine.height, width: engine.width, height: engine.height };
        centerDoc = { x: 0, y: 0 };
        contentKey = 'c:' + engine.correctionSessionSignature;
      } else if (contentSessionActive && !isAnyVectorSessionActive && !gradientPreview && !bucketPreview) {
        // Oderwany fragment zaznaczenia: ten sam rysunek co przy zatwierdzaniu (GraphicEngine.commitTransformContent),
        // z migawką parametrów (stan ramki jest mutowany w miejscu, a renderer rysuje zadania później)
        const sess = tcs!;
        const st0 = tst!;
        const pos = { x: st0.pos.x, y: st0.pos.y };
        const w = st0.width;
        const h = st0.height;
        const ang = st0.angle;
        const fx = st0.flipX ? -1 : 1;
        const fy = st0.flipY ? -1 : 1;
        const iw = st0.initialBounds.width;
        const ih = st0.initialBounds.height;
        const interp = sess.interpolation;
        const src = sess.previewCanvas ?? sess.sourceContentCanvas;
        // Brzeg z konturu zaznaczenia (migawka: ścieżka jest niezmienna, ramka kopiowana) - ten sam rysunek co przy zatwierdzaniu
        const edgePath = engine.solidEdgePath();
        const solidSrc = edgePath ? sess.solidContent : undefined;
        const stSnap = { pos, width: w, height: h, angle: ang, flipX: st0.flipX, flipY: st0.flipY, initialBounds: { width: iw, height: ih } };
        const pq = sess.persp ? (sess.persp.quad.map((p) => ({ x: p.x, y: p.y })) as Quad) : null;
        const perspPv = pq ? engine.getPerspectivePreview() : null;
        previewRender = (ctx) => {
          if (contentIdentity) return;
          if (edgePath && solidSrc) {
            drawSolidFragment(ctx, solidSrc, edgePath, stSnap, interp);
            return;
          }
          if (pq) {
            if (perspPv) drawPerspectivePreview(ctx, perspPv, interp !== 'nearest-neighbor');
            return;
          }
          ctx.save();
          ctx.translate(pos.x, pos.y);
          ctx.rotate(ang);
          ctx.scale((w / Math.max(1, iw)) * fx, (h / Math.max(1, ih)) * fy);
          if (interp === 'nearest-neighbor') {
            ctx.imageSmoothingEnabled = false;
          } else {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = interp === 'bilinear' ? 'medium' : 'high';
          }
          ctx.drawImage(src, -iw / 2, -ih / 2);
          ctx.restore();
        };
        previewBlend = 'SrcOver';
        if (pq) {
          const xs = pq.map((p) => p.x);
          const ys = pq.map((p) => p.y);
          const l = Math.floor(Math.min(...xs)) - 4;
          const t = Math.floor(Math.min(...ys)) - 4;
          const r = Math.ceil(Math.max(...xs)) + 4;
          const bt = Math.ceil(Math.max(...ys)) + 4;
          bounds = { left: l, top: t, right: r, bottom: bt, width: r - l, height: bt - t };
          centerDoc = { x: (l + r) / 2, y: (t + bt) / 2 };
          contentKey = 'tp:' + JSON.stringify([pq, interp, contentIdentity]);
        } else {
          bounds = boundsForRotatedBox(pos, w, h, ang, 4);
          centerDoc = pos;
          contentKey = 'tc:' + JSON.stringify([pos, w, h, ang, fx, fy, interp, contentIdentity, !!solidSrc]);
        }
      } else if (!isAnyVectorSessionActive && !gradientPreview && bucketPreview) {
        // Wiadro: wypełnienie (maska alfa w prostokącie opisanym na obszarze) rysowane tak samo jak przy zatwierdzaniu;
        // warstwa nietknięta do zatwierdzenia
        const bp = bucketPreview;
        previewRender = (ctx) => {
          ctx.drawImage(bp.canvas, bp.x, bp.y);
        };
        previewBlend = bp.blendMode;
        bounds = { left: bp.x, top: bp.y, right: bp.x + bp.w, bottom: bp.y + bp.h, width: bp.w, height: bp.h };
        centerDoc = { x: bp.x + bp.w / 2, y: bp.y + bp.h / 2 };
      } else if (!isAnyVectorSessionActive && gradientPreview) {
        // Gradient: cały dokument (przycięty do widoku i zaznaczenia przez renderer), warstwa nietknięta do zatwierdzenia
        previewRender = (ctx) => renderGradientPreview(ctx, gradientPreview, engine.width, engine.height);
        previewBlend = gradientPreview.blendMode;
        bounds = { left: 0, top: 0, right: engine.width, bottom: engine.height, width: engine.width, height: engine.height };
        centerDoc = { x: (gradientPreview.p0.x + gradientPreview.p1.x) / 2, y: (gradientPreview.p0.y + gradientPreview.p1.y) / 2 };
      } else if (activeVectorLineSession) {
        const { p0, p1 } = activeVectorLineSession;
        bounds = boundsForPoints([p0, p1], lineAndCurveSettings.strokeWidth, lineAndCurveSettings.markerSize);
        centerDoc = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      } else if (activeVectorBezierSession) {
        const allPts = penAllPoints(activeVectorBezierSession.nodes);
        bounds = boundsForPoints(allPts, lineAndCurveSettings.strokeWidth, lineAndCurveSettings.markerSize);
        const pb = boundsForPoints(allPts, 0, 0);
        centerDoc = { x: (pb.left + pb.right) / 2, y: (pb.top + pb.bottom) / 2 };
      } else if (activeVectorShapeSession) {
        const sh = activeVectorShapeSession;
        bounds = boundsForShape(sh.center, sh.width, sh.height, sh.angle, vectorShapeSettings.strokeWidth);
        centerDoc = sh.center;
      } else {
        const tx = activeTextSession!;
        const extH = Math.max(tx.height, (textLayout?.height ?? 0) + 2 * getTextInset(textSettings));
        bounds = boundsForRotatedBox(
          tx.center,
          tx.width,
          extH,
          tx.angle,
          Math.max(0, textSettings.strokeWidth) * 2 + 24
        );
        centerDoc = tx.center;
      }

      const dragging = (!!activeVectorHandleRef.current || !!penDragRef.current || !!gradientPreview || (contentSessionActive && !!transformActiveHandleRef.current)) && !!cursorPosRef.current;
      const focus = correctionOnly || vecLive
        ? { x: 0, y: 0 } // kafelki od lewego górnego rogu ekranu
        : dragging
        ? { x: cursorPosRef.current!.x, y: cursorPosRef.current!.y }
        : { x: left + centerDoc.x * zoom * dpr, y: top + centerDoc.y * zoom * dpr };
      if (dragging && !correctionOnly && !vecLive) {
        focus.x *= dpr;
        focus.y *= dpr;
      }

      // Klucz zawartości podglądu: zmienia się tylko przy modyfikacji (geometria, ustawienia, tryb mieszania), a nie
      // przy zoomie / przesunięciu. Dzięki temu renderer nie regeneruje podglądu przy zmianie widoku.
      // Tekst celowo bez klucza (jego stan żyje w mutowalnych refach), więc zachowuje się jak dotychczas.
      let previewKey: string | undefined;
      // Linia, krzywa i figura: podgląd rasteryzowany raz w rozdzielczości dokumentu (identyczne piksele jak po zatwierdzeniu)
      const docSprite = contentKey === undefined && !gradientPreview && (!!activeVectorLineSession || !!activeVectorBezierSession || !!activeVectorShapeSession);
      if (contentKey !== undefined) {
        previewKey = contentKey;
      } else if (!isAnyVectorSessionActive && !gradientPreview && bucketPreview) {
        previewKey = bucketPreview.key;
      } else if (!isAnyVectorSessionActive && gradientPreview) {
        previewKey = 'g:' + JSON.stringify(gradientPreview);
      } else if (activeVectorLineSession) {
        previewKey = 'l:' + JSON.stringify([activeVectorLineSession, lineAndCurveSettings, previewBlend]);
      } else if (activeVectorBezierSession) {
        previewKey = 'b:' + JSON.stringify([penContentKey(activeVectorBezierSession.nodes, activeVectorBezierSession.closed), lineAndCurveSettings, previewBlend]);
      } else if (activeVectorShapeSession) {
        previewKey = 's:' + JSON.stringify([activeVectorShapeSession, vectorShapeSettings, previewBlend]);
      }

      // Opis czystego przesunięcia (figura, linia, krzywa): klucz zawartości BEZ położenia + punkt odniesienia.
      // Gdy użytkownik tylko przesuwa obiekt, renderer kopiuje gotowy podgląd zamiast rasteryzować go od nowa.
      const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
      let previewMove: { key: string; x: number; y: number } | undefined;
      if (vecLive) {
        previewMove = undefined;
      } else if (activeVectorLineSession) {
        const { p0, p1 } = activeVectorLineSession;
        previewMove = {
          key: 'l:' + JSON.stringify([r4(p1.x - p0.x), r4(p1.y - p0.y), lineAndCurveSettings, previewBlend]),
          x: p0.x,
          y: p0.y,
        };
      } else if (activeVectorBezierSession && activeVectorBezierSession.nodes.length > 0) {
        previewMove = {
          key: 'b:' + penShapeKey(activeVectorBezierSession.nodes, activeVectorBezierSession.closed) + JSON.stringify([lineAndCurveSettings, previewBlend]),
          x: activeVectorBezierSession.nodes[0].x,
          y: activeVectorBezierSession.nodes[0].y,
        };
      } else if (activeVectorShapeSession) {
        const sh = activeVectorShapeSession;
        previewMove = {
          key:
            's:' +
            JSON.stringify([
              r4(sh.width),
              r4(sh.height),
              r4(sh.angle),
              sh.flipX,
              sh.flipY,
              r4(sh.pivot.x - sh.center.x),
              r4(sh.pivot.y - sh.center.y),
              vectorShapeSettings,
              previewBlend,
            ]),
          x: sh.center.x,
          y: sh.center.y,
        };
      }

      tr.request({
        view: { zoom: zoom * dpr, left, top, width: Math.round(cW * dpr), height: Math.round(cH * dpr) },
        preview: { render: previewRender, blendMode: previewBlend, bounds, key: previewKey, move: previewMove, docSprite: docSprite },
        focus,
        // trwa przeciąganie uchwytu / gradientu: renderer może użyć niskiej rozdzielczości i wyostrzyć po pauzie
        interactive: dragging,
      });
      // Nakładka: kafelki zawierają tylko podgląd, a tło to zwykłe płótno dokumentu (identyczne w całym widoku).
      // Gdy podgląd wymaga pełnej kompozycji (tryb mieszania, warstwy nad aktywną), dokument rysują kafelki, a płótno ukrywamy.
      if (canvasRef.current) canvasRef.current.style.visibility = tr.isOverlay() ? '' : 'hidden';
      return;
    }

    if (skipRedrawSigRef.current !== null) {
      const same = skipRedrawSigRef.current === engine.getBaseSignature();
      skipRedrawSigRef.current = null;
      if (same && canvasRef.current && baseSigRef.current === engine.getBaseSignature()) {
        const trs = tileRendererRef.current;
        const tvs = tileViewRef.current;
        if (!(trs && tvs && trs.isShowing(tvs))) presentIdle(null);
        return;
      }
    }
    if (viewOnlyRef.current) {
      presentIdle(null);
      return;
    }
    engine.compositeToViewport(
      canvasRef.current,
      null,
      null,
      null,
      null,
      null,
      null,
      null
    );
    baseSigRef.current = engine.getBaseSignature();
    presentIdle(null);
  }, [
    engine,
    activeVectorLineSession,
    activeVectorBezierSession,
    activeVectorShapeSession,
    activeTextSession,
    textSettings,
    textLayout,
    textVersion,
    lineAndCurveSettings,
    vectorShapeSettings,
    isAnyVectorSessionActive,
    zoom,
    panOffset.x,
    panOffset.y,
    containerSize.width,
    containerSize.height,
  ]);

  // Samo przesunięcie / zoom / zmiana rozmiaru okna poza sesją podglądu nie zmienia pikseli dokumentu:
  // płótno dokumentu skaluje przeglądarka (CSS), więc nie wolno za każdym razem składać wszystkich warstw od nowa.
  // Edycja istniejącego obiektu wektorowego z innymi obiektami nad nim: bieżący stan sesji wraca do pikseli warstwy na
  // właściwe miejsce w kolejności (przed odświeżeniem widoku, więc efekt jest zadeklarowany wcześniej niż rysowanie)
  useEffect(() => {
    if (!engine.vec.liveEditing || !isAnyVectorSessionActive) return;
    const base = { id: 'live', name: null, visible: true };
    let o: VectorObject | null = null;
    if (activeVectorLineSession) {
      o = { ...base, kind: 'line', p0: { ...activeVectorLineSession.p0 }, p1: { ...activeVectorLineSession.p1 }, settings: lineAndCurveSettings };
    } else if (activeVectorBezierSession && activeVectorBezierSession.nodes.length >= 2) {
      const bs = activeVectorBezierSession;
      o = { ...base, kind: 'path', nodes: cloneNodes(normalizeOpenEnds(bs.nodes, bs.closed)), closed: bs.closed, settings: lineAndCurveSettings, freehand: penFreehandSessionRef.current };
    } else if (activeVectorShapeSession) {
      const sh = activeVectorShapeSession;
      o = { ...base, kind: 'shape', center: { ...sh.center }, width: sh.width, height: sh.height, angle: sh.angle, flipX: sh.flipX, flipY: sh.flipY, settings: vectorShapeSettings };
    } else if (activeTextSession && textRtRef.current.length > 0) {
      const tx = activeTextSession;
      o = {
        ...base,
        kind: 'text',
        center: { ...tx.center },
        width: tx.width,
        height: tx.height,
        angle: tx.angle,
        autoHeight: !!tx.autoHeight,
        runs: textRtRef.current.runs.map((r) => ({ text: r.text, style: { ...r.style } })),
        settings: textSettings,
        fallback: textPendingStyleRef.current ?? pickCharStyle(textSettings),
      };
    }
    if (o) engine.vec.updateLive(o);
  }, [
    engine,
    isAnyVectorSessionActive,
    activeVectorLineSession,
    activeVectorBezierSession,
    activeVectorShapeSession,
    activeTextSession,
    lineAndCurveSettings,
    vectorShapeSettings,
    textSettings,
    textVersion,
    textLayout,
  ]);

  const contentKeyRef = useRef<unknown[] | null>(null);
  useEffect(() => {
    // Ustawienia narzędzi wektorowych (App podmienia je przy każdej zmianie koloru) liczą się do klucza tylko wtedy,
    // gdy trwa sesja, która ich używa; inaczej zmiana koloru w palecie wymuszałaby pełne złożenie dużego płótna.
    const vecActive = isAnyVectorSessionActive || !!activeTextSession;
    const contentKey: unknown[] = [
      engine,
      activeVectorLineSession,
      activeVectorBezierSession,
      activeVectorShapeSession,
      activeTextSession,
      vecActive ? textSettings : null,
      textLayout,
      textVersion,
      vecActive ? lineAndCurveSettings : null,
      vecActive ? vectorShapeSettings : null,
      isAnyVectorSessionActive,
      engineRevision,
      engine.width,
      engine.height,
      engine.activeLayerIndex,
      engine.getBaseSignature(),
      !!engine.gradientPreview,
      !!engine.bucketSeedPoint,
    ];
    const prevKey = contentKeyRef.current;
    contentKeyRef.current = contentKey;
    const sameContent = !!prevKey && prevKey.length === contentKey.length && prevKey.every((v, i) => v === contentKey[i]);
    const sessionNow = isAnyVectorSessionActive || !!engine.gradientPreview || !!engine.bucketSeedPoint;
    viewOnlyRef.current = sameContent && !sessionNow && !tileSessionRef.current;
    redraw();
    viewOnlyRef.current = false;
  }, [redraw, engineRevision, engine.width, engine.height, engine.activeLayerIndex]);

  useEffect(() => {
    return () => {
      tileRendererRef.current?.dispose();
      tileRendererRef.current = null;
      tileRendererEngineRef.current = null;
    };
  }, []);

  // PRZELICZANIE WSPÓŁRZĘDNYCH DOKUMENTU
  const getDocPoint = useCallback(
    (e: React.PointerEvent | PointerEvent | MouseEvent, clamp: boolean = false): SKPoint | null => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const docX =
        rect.width > 0
          ? ((e.clientX - rect.left) / rect.width) * engine.width
          : (e.clientX - rect.left) / zoom;
      const docY =
        rect.height > 0
          ? ((e.clientY - rect.top) / rect.height) * engine.height
          : (e.clientY - rect.top) / zoom;
      if (clamp) {
        return {
          x: Math.max(0, Math.min(engine.width, docX)),
          y: Math.max(0, Math.min(engine.height, docY)),
        };
      }
      return { x: docX, y: docY };
    },
    [engine.width, engine.height, zoom]
  );

  const docToScreen = useCallback(
    (pt: SKPoint): SKPoint => {
      const cWidth = containerSize.width || containerRef.current?.clientWidth || 0;
      const cHeight = containerSize.height || containerRef.current?.clientHeight || 0;
      const screenCenterX = cWidth / 2 + panOffset.x;
      const screenCenterY = cHeight / 2 + panOffset.y;
      return {
        x: (pt.x - engine.width / 2) * zoom + screenCenterX,
        y: (pt.y - engine.height / 2) * zoom + screenCenterY,
      };
    },
    [containerSize, panOffset, engine.width, engine.height, zoom]
  );

  const updateStatusBarPos = (pt: SKPoint | null) => {
    const el = document.getElementById('status-bar-cursor-pos');
    if (el) {
      el.textContent = pt
        ? `Pozycja: ${Math.floor(pt.x)}, ${Math.floor(pt.y)}`
        : 'Pozycja: 0, 0';
    }
  };

  const hasShapeModifier = (shapeKind: ShapeKind): boolean => {
    return shapeKind === 'round-rect' || shapeKind === 'star' || shapeKind === 'arrow';
  };

  // OBLICZANIE PUNKTU MODYFIKATORA DLA FIGURY (ŻÓŁTY UCHWYT)
  const getShapeModifierDocPoint = useCallback(
    (sess: ActiveVectorShapeSession, settings: VectorShapeSettings): SKPoint => {
      const { center, width, height, angle } = sess;
      const halfW = width / 2;
      const halfH = height / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      let localX = 0;
      let localY = 0;

      if (settings.shapeKind === 'round-rect') {
        const maxR = Math.min(halfW, halfH);
        const r = Math.max(0, Math.min(maxR, settings.cornerRadius ?? 16));
        localX = halfW - r;
        localY = -halfH;
      } else if (settings.shapeKind === 'star') {
        const numPoints = Math.max(3, settings.starPoints || 5);
        const innerRatio = Math.max(0.1, Math.min(0.9, settings.starInnerRatio || 0.45));
        const outerRadius = Math.min(halfW, halfH);
        const innerRadius = outerRadius * innerRatio;
        const scaleX = halfW / Math.max(1, outerRadius);
        const scaleY = halfH / Math.max(1, outerRadius);
        const angleStar = -Math.PI / 2 + Math.PI / numPoints;
        localX = Math.cos(angleStar) * innerRadius * scaleX;
        localY = Math.sin(angleStar) * innerRadius * scaleY;
      } else if (settings.shapeKind === 'arrow') {
        const headWidth = Math.max(0.15, Math.min(0.85, settings.arrowHeadWidth || 0.45));
        const headLen = width * headWidth;
        const shaftLen = width - headLen;
        localX = -halfW + shaftLen;
        localY = -halfH;
      } else {
        localX = halfW * 0.7;
        localY = -halfH * 0.7;
      }

      return {
        x: center.x + localX * cos - localY * sin,
        y: center.y + localX * sin + localY * cos,
      };
    },
    []
  );

  const getArrowShaftModifierDocPoint = useCallback(
    (sess: ActiveVectorShapeSession, settings: VectorShapeSettings): SKPoint => {
      const { center, width, height, angle } = sess;
      const halfW = width / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const headWidth = Math.max(0.15, Math.min(0.85, settings.arrowHeadWidth || 0.45));
      const headLen = width * headWidth;
      const shaftLen = width - headLen;
      const shaftThickness = Math.max(0.1, Math.min(0.85, settings.arrowShaftThickness || 0.35));
      const halfShaftH = (height * shaftThickness) / 2;

      const localX = -halfW + shaftLen / 2;
      const localY = -halfShaftH;

      return {
        x: center.x + localX * cos - localY * sin,
        y: center.y + localX * sin + localY * cos,
      };
    },
    []
  );

  // HIT TESTING DLA UCHWYTÓW WEKTOROWYCH
  const hitTestVectorHandles = useCallback(
    (e: React.PointerEvent | PointerEvent | MouseEvent): string | null => {
      const container = containerRef.current;
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      if (activeVectorLineSession) {
        const p0Screen = docToScreen(activeVectorLineSession.p0);
        const p1Screen = docToScreen(activeVectorLineSession.p1);
        const midDoc: SKPoint = {
          x: (activeVectorLineSession.p0.x + activeVectorLineSession.p1.x) / 2,
          y: (activeVectorLineSession.p0.y + activeVectorLineSession.p1.y) / 2,
        };
        const midScreen = docToScreen(midDoc);

        if (Math.hypot(mouseX - p0Screen.x, mouseY - p0Screen.y) <= 12) return 'p0';
        if (Math.hypot(mouseX - p1Screen.x, mouseY - p1Screen.y) <= 12) return 'p1';
        if (Math.hypot(mouseX - midScreen.x, mouseY - midScreen.y) <= 12) return 'move';
        return null;
      }

      if (activeVectorBezierSession) return null; // krzywa wielowęzłowa ma własną obsługę (patrz penPointerDown)

      const geomSess = activeVectorShapeSession ?? activeTextSession;
      if (geomSess) {
        const sess = geomSess;
        const isTextSess = !activeVectorShapeSession && !!activeTextSession;
        // 1. Sprawdź punkt modyfikatora TYLKO dla figur które go posiadają (round-rect, star, arrow)
        if (!isTextSess && hasShapeModifier(vectorShapeSettings.shapeKind)) {
          const modDoc = getShapeModifierDocPoint(sess, vectorShapeSettings);
          const modScreen = docToScreen(modDoc);
          if (Math.hypot(mouseX - modScreen.x, mouseY - modScreen.y) <= 12) {
            return 'modifier';
          }
          if (vectorShapeSettings.shapeKind === 'arrow') {
            const shaftDoc = getArrowShaftModifierDocPoint(sess, vectorShapeSettings);
            const shaftScreen = docToScreen(shaftDoc);
            if (Math.hypot(mouseX - shaftScreen.x, mouseY - shaftScreen.y) <= 12) {
              return 'modifier-shaft';
            }
          }
        }

        // 2. Uchwyt obrotu
        const cos = Math.cos(sess.angle);
        const sin = Math.sin(sess.angle);
        const rotOffset = 26 / zoom;
        const rotDocX = sess.center.x - (sess.height / 2 + rotOffset) * (-sin);
        const rotDocY = sess.center.y + (sess.height / 2 + rotOffset) * (-cos);
        const rotScreen = docToScreen({ x: rotDocX, y: rotDocY });
        if (Math.hypot(mouseX - rotScreen.x, mouseY - rotScreen.y) <= 12) {
          return 'rotate';
        }

        // 3. 8 uchwytów skalowania
        const localCoords: Record<string, { u: number; v: number }> = {
          nw: { u: -0.5, v: -0.5 },
          n: { u: 0, v: -0.5 },
          ne: { u: 0.5, v: -0.5 },
          e: { u: 0.5, v: 0 },
          se: { u: 0.5, v: 0.5 },
          s: { u: 0, v: 0.5 },
          sw: { u: -0.5, v: 0.5 },
          w: { u: -0.5, v: 0 },
        };

        for (const [key, lc] of Object.entries(localCoords)) {
          const lx = lc.u * sess.width;
          const ly = lc.v * sess.height;
          const rx = lx * cos - ly * sin;
          const ry = lx * sin + ly * cos;
          const hDoc = { x: sess.center.x + rx, y: sess.center.y + ry };
          const hScreen = docToScreen(hDoc);
          if (Math.abs(mouseX - hScreen.x) <= 8 && Math.abs(mouseY - hScreen.y) <= 8) {
            return key;
          }
        }

        // 4. Przesuwanie wnętrza figury
        const localMouseX = (mouseX - docToScreen(sess.center).x) / zoom;
        const localMouseY = (mouseY - docToScreen(sess.center).y) / zoom;
        const unrotX = localMouseX * cos + localMouseY * sin;
        const unrotY = -localMouseX * sin + localMouseY * cos;
        if (Math.abs(unrotX) <= sess.width / 2 && Math.abs(unrotY) <= sess.height / 2) {
          if (isTextSess) {
            // Wnętrze ramki tekstu = edycja (kursor/zaznaczenie); przesuwanie za obrzeże ramki
            const edgeDist = Math.min(sess.width / 2 - Math.abs(unrotX), sess.height / 2 - Math.abs(unrotY));
            return edgeDist * zoom <= 6 ? 'move' : 'text-body';
          }
          return 'move';
        }
      }

      return null;
    },
    [
      activeVectorLineSession,
      activeVectorBezierSession,
      activeVectorShapeSession,
      activeTextSession,
      docToScreen,
      getShapeModifierDocPoint,
      vectorShapeSettings,
      zoom,
    ]
  );

  // HIT TESTING TRANSFORM SELECTION
  const getTransformScreenGeometry = useCallback(() => {
    const st = engine.selectionManager.transformState;
    const container = containerRef.current;
    if (!st || !container) return null;

    const cWidth = container.clientWidth;
    const cHeight = container.clientHeight;
    const screenCenterX = cWidth / 2 + panOffset.x;
    const screenCenterY = cHeight / 2 + panOffset.y;

    const docToScr = (pt: SKPoint): SKPoint => ({
      x: (pt.x - engine.width / 2) * zoom + screenCenterX,
      y: (pt.y - engine.height / 2) * zoom + screenCenterY,
    });

    const localCoords: Record<string, { u: number; v: number }> = {
      nw: { u: -0.5, v: -0.5 },
      n: { u: 0, v: -0.5 },
      ne: { u: 0.5, v: -0.5 },
      e: { u: 0.5, v: 0 },
      se: { u: 0.5, v: 0.5 },
      s: { u: 0, v: 0.5 },
      sw: { u: -0.5, v: 0.5 },
      w: { u: -0.5, v: 0 },
    };

    const cos = Math.cos(st.angle);
    const sin = Math.sin(st.angle);
    const docHandles: Record<string, SKPoint> = {};
    const screenHandles: Record<string, SKPoint> = {};

    for (const [key, lc] of Object.entries(localCoords)) {
      const lx = lc.u * st.width;
      const ly = lc.v * st.height;
      const rx = lx * cos - ly * sin;
      const ry = lx * sin + ly * cos;
      const dpt: SKPoint = { x: st.pos.x + rx, y: st.pos.y + ry };
      docHandles[key] = dpt;
      screenHandles[key] = docToScr(dpt);
    }

    const curPivotDoc: SKPoint = { x: st.pivot.x, y: st.pivot.y };
    const curPivotScreen = docToScr(curPivotDoc);

    // Uchwyt obrotu na górze (taki sam jak dla figur)
    const rotOffset = 22 / zoom;
    const rotDoc: SKPoint = {
      x: st.pos.x - (st.height / 2 + rotOffset) * (-sin),
      y: st.pos.y + (st.height / 2 + rotOffset) * (-cos),
    };
    const rotScreen = docToScr(rotDoc);

    return {
      docHandles,
      screenHandles,
      pivotDoc: curPivotDoc,
      pivotScreen: curPivotScreen,
      rotDoc,
      rotScreen,
    };
  }, [engine, zoom, panOffset]);

  const hitTestTransformHandles = useCallback(
    (e: React.PointerEvent | MouseEvent): TransformHandleType => {
      // Tryb perspektywy: 4 narożniki + wnętrze czworokąta
      if (activeTool === 'transform-content' && engine.perspectiveActive && containerRef.current) {
        const quad = engine.getPerspectiveQuad();
        if (quad) {
          const crect = containerRef.current.getBoundingClientRect();
          const mx = e.clientX - crect.left;
          const my = e.clientY - crect.top;
          const cx = containerRef.current.clientWidth / 2 + panOffset.x;
          const cy = containerRef.current.clientHeight / 2 + panOffset.y;
          for (let i = 0; i < 4; i++) {
            const sx = (quad[i].x - engine.width / 2) * zoom + cx;
            const sy = (quad[i].y - engine.height / 2) * zoom + cy;
            if (Math.hypot(mx - sx, my - sy) <= 10) return `p${i}` as TransformHandleType;
          }
          const dp = getDocPoint(e);
          if (dp && pointInQuad(quad, dp.x, dp.y)) return 'pmove';
        }
        return null;
      }
      const geom = getTransformScreenGeometry();
      if (!geom || !containerRef.current) return null;

      const rect = containerRef.current.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // 1. Pivot
      if (Math.hypot(mouseX - geom.pivotScreen.x, mouseY - geom.pivotScreen.y) <= 8) {
        return 'pivot';
      }

      // 2. Uchwyt obrotu na górze
      if (Math.hypot(mouseX - geom.rotScreen.x, mouseY - geom.rotScreen.y) <= 9) {
        return 'rotate';
      }

      // 3. 8 uchwytów skalowania
      for (const [key, sPt] of Object.entries(geom.screenHandles)) {
        if (Math.abs(mouseX - sPt.x) <= 8 && Math.abs(mouseY - sPt.y) <= 8) {
          return key as TransformHandleType;
        }
      }

      // 4. Wnętrze zaznaczenia (przesuwanie)
      const st = engine.selectionManager.transformState;
      if (st) {
        const localDocPt = getDocPoint(e);
        if (localDocPt) {
          const dx = localDocPt.x - st.pos.x;
          const dy = localDocPt.y - st.pos.y;
          const cos = Math.cos(st.angle);
          const sin = Math.sin(st.angle);
          const unrotX = dx * cos + dy * sin;
          const unrotY = -dx * sin + dy * cos;
          if (Math.abs(unrotX) <= st.width / 2 && Math.abs(unrotY) <= st.height / 2) {
            return 'move';
          }
        }
      }

      return null;
    },
    [getTransformScreenGeometry, engine.selectionManager.transformState, getDocPoint, activeTool, engine, panOffset, zoom]
  );

  // OBSŁUGA INTERAKCJI TRANSFORMACJI ZAZNACZENIA / ZAWARTOŚCI
  const updateTransformInteraction = useCallback(
    (pt: SKPoint, shiftKey: boolean, altKey: boolean) => {
      const activeHandle = transformActiveHandleRef.current;
      if (!activeHandle || !transformInitialStateRef.current || !transformDragStartDocPtRef.current) {
        return;
      }

      const init = transformInitialStateRef.current;
      const startPt = transformDragStartDocPtRef.current;

      if (activeHandle === 'pmove' || activeHandle.startsWith('p') && activeHandle !== 'pivot') {
        const q0 = perspInitQuadRef.current;
        if (!q0) return;
        let dx = pt.x - startPt.x;
        let dy = pt.y - startPt.y;
        if (shiftKey && activeHandle === 'pmove') {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        dx = Math.round(dx);
        dy = Math.round(dy);
        const nq = q0.map((p) => ({ x: p.x, y: p.y })) as Quad;
        if (activeHandle === 'pmove') {
          for (const p of nq) {
            p.x += dx;
            p.y += dy;
          }
        } else {
          const idx = Number(activeHandle.slice(1));
          nq[idx] = { x: q0[idx].x + dx, y: q0[idx].y + dy };
        }
        if (engine.setPerspectiveQuad(nq)) onCanvasModified();
        return;
      }

      if (activeHandle === 'move') {
        let dx = pt.x - startPt.x;
        let dy = pt.y - startPt.y;

        if (shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }

        dx = Math.round(dx);
        dy = Math.round(dy);

        engine.selectionManager.updateTransformSelection({
          pos: { x: init.pos.x + dx, y: init.pos.y + dy },
          pivot: { x: init.pivot.x + dx, y: init.pivot.y + dy },
        });
        onCanvasModified();
        return;
      }

      if (activeHandle === 'pivot') {
        engine.selectionManager.updateTransformSelection({
          pivot: { x: Math.round(pt.x), y: Math.round(pt.y) },
        });
        onCanvasModified();
        return;
      }

      if (activeHandle === 'rotate') {
        const P = init.pivot;
        const startAngle = Math.atan2(startPt.y - P.y, startPt.x - P.x);
        const curAngle = Math.atan2(pt.y - P.y, pt.x - P.x);
        let deltaAngle = curAngle - startAngle;

        let targetAngle = init.angle + deltaAngle;
        if (shiftKey) {
          const step = (15 * Math.PI) / 180;
          targetAngle = Math.round(targetAngle / step) * step;
          deltaAngle = targetAngle - init.angle;
        }

        const dx = init.pos.x - P.x;
        const dy = init.pos.y - P.y;
        const cos = Math.cos(deltaAngle);
        const sin = Math.sin(deltaAngle);

        const newPosX = P.x + dx * cos - dy * sin;
        const newPosY = P.y + dx * sin + dy * cos;

        engine.selectionManager.updateTransformSelection({
          angle: targetAngle,
          pos: { x: newPosX, y: newPosY },
        });
        onCanvasModified();
        return;
      }

      // Skalowanie z 8 uchwytów
      let uA = 0;
      let vA = 0;

      if (activeHandle === 'e') { uA = -0.5; vA = 0; }
      else if (activeHandle === 'w') { uA = 0.5; vA = 0; }
      else if (activeHandle === 's') { uA = 0; vA = -0.5; }
      else if (activeHandle === 'n') { uA = 0; vA = 0.5; }
      else if (activeHandle === 'se') { uA = -0.5; vA = -0.5; }
      else if (activeHandle === 'nw') { uA = 0.5; vA = 0.5; }
      else if (activeHandle === 'ne') { uA = -0.5; vA = 0.5; }
      else if (activeHandle === 'sw') { uA = 0.5; vA = -0.5; }

      const uH = -uA;
      const vH = -vA;

      const cos0 = Math.cos(init.angle);
      const sin0 = Math.sin(init.angle);
      const Ux = { x: cos0, y: sin0 };
      const Uy = { x: -sin0, y: cos0 };

      let newW = init.width;
      let newH = init.height;

      const anchorDocX = init.pos.x + uA * init.width * cos0 - vA * init.height * sin0;
      const anchorDocY = init.pos.y + uA * init.width * sin0 + vA * init.height * cos0;

      if (altKey) {
        const Vp = { x: pt.x - init.pivot.x, y: pt.y - init.pivot.y };
        const projPivX = Vp.x * Ux.x + Vp.y * Ux.y;
        const projPivY = Vp.x * Uy.x + Vp.y * Uy.y;

        const H0x = init.pos.x + uH * init.width * cos0 - vH * init.height * sin0;
        const H0y = init.pos.y + uH * init.width * sin0 + vH * init.height * cos0;
        const VH0 = { x: H0x - init.pivot.x, y: H0y - init.pivot.y };
        const projH0_X = VH0.x * Ux.x + VH0.y * Ux.y;
        const projH0_Y = VH0.x * Uy.x + VH0.y * Uy.y;

        if (uH !== 0) {
          if (Math.abs(projH0_X) > 0.001) {
            const signX = projH0_X >= 0 ? 1 : -1;
            const scaleX = Math.max(0.01, (projPivX * signX) / Math.abs(projH0_X));
            newW = Math.max(2, init.width * scaleX);
          } else {
            newW = Math.max(2, Math.abs(projPivX) * 2);
          }
        }

        if (vH !== 0) {
          if (Math.abs(projH0_Y) > 0.001) {
            const signY = projH0_Y >= 0 ? 1 : -1;
            const scaleY = Math.max(0.01, (projPivY * signY) / Math.abs(projH0_Y));
            newH = Math.max(2, init.height * scaleY);
          } else {
            newH = Math.max(2, Math.abs(projPivY) * 2);
          }
        }
      } else {
        const V = { x: pt.x - anchorDocX, y: pt.y - anchorDocY };
        const projX = V.x * Ux.x + V.y * Ux.y;
        const projY = V.x * Uy.x + V.y * Uy.y;

        if (uH !== 0) newW = Math.max(2, projX * Math.sign(uH));
        if (vH !== 0) newH = Math.max(2, projY * Math.sign(vH));
      }

      if (shiftKey) {
        const initialAspect = init.width / Math.max(1, init.height);
        if (uH !== 0 && vH !== 0) {
          const scaleW = newW / Math.max(1, init.width);
          const scaleH = newH / Math.max(1, init.height);
          if (Math.abs(scaleW - 1) >= Math.abs(scaleH - 1)) {
            newH = Math.max(2, newW / initialAspect);
          } else {
            newW = Math.max(2, newH * initialAspect);
          }
        } else if (uH !== 0) {
          newH = Math.max(2, newW / initialAspect);
        } else if (vH !== 0) {
          newW = Math.max(2, newH * initialAspect);
        }
      }

      let newPosX: number;
      let newPosY: number;
      let newPivDocX: number;
      let newPivDocY: number;

      if (altKey) {
        newPivDocX = init.pivot.x;
        newPivDocY = init.pivot.y;
        const dxPiv = init.pos.x - init.pivot.x;
        const dyPiv = init.pos.y - init.pivot.y;
        const localCenterFromPivX = dxPiv * cos0 + dyPiv * sin0;
        const localCenterFromPivY = -dxPiv * sin0 + dyPiv * cos0;
        const finalScaleX = newW / Math.max(1, init.width);
        const finalScaleY = newH / Math.max(1, init.height);

        const scaledLocalCenterX = localCenterFromPivX * finalScaleX;
        const scaledLocalCenterY = localCenterFromPivY * finalScaleY;

        newPosX = init.pivot.x + scaledLocalCenterX * cos0 - scaledLocalCenterY * sin0;
        newPosY = init.pivot.y + scaledLocalCenterX * sin0 + scaledLocalCenterY * cos0;
      } else {
        newPosX = anchorDocX - uA * newW * Ux.x - vA * newH * Uy.x;
        newPosY = anchorDocY - uA * newW * Ux.y - vA * newH * Uy.y;

        const dxPiv = init.pivot.x - init.pos.x;
        const dyPiv = init.pivot.y - init.pos.y;
        const localPivX = dxPiv * cos0 + dyPiv * sin0;
        const localPivY = -dxPiv * sin0 + dyPiv * cos0;
        const uPiv = localPivX / Math.max(1, init.width);
        const vPiv = localPivY / Math.max(1, init.height);

        const newLocalPivX = uPiv * newW;
        const newLocalPivY = vPiv * newH;
        newPivDocX = newPosX + newLocalPivX * cos0 - newLocalPivY * sin0;
        newPivDocY = newPosY + newLocalPivX * sin0 + newLocalPivY * cos0;
      }

      if (Math.abs(init.angle) < 0.001) {
        newW = Math.round(newW);
        newH = Math.round(newH);
        const left = Math.round(newPosX - newW / 2);
        const top = Math.round(newPosY - newH / 2);
        newPosX = left + newW / 2;
        newPosY = top + newH / 2;
        newPivDocX = Math.round(newPivDocX);
        newPivDocY = Math.round(newPivDocY);
      } else {
        newW = Math.round(newW * 10) / 10;
        newH = Math.round(newH * 10) / 10;
        newPosX = Math.round(newPosX * 10) / 10;
        newPosY = Math.round(newPosY * 10) / 10;
        newPivDocX = Math.round(newPivDocX * 10) / 10;
        newPivDocY = Math.round(newPivDocY * 10) / 10;
      }

      engine.selectionManager.updateTransformSelection({
        width: newW,
        height: newH,
        pos: { x: newPosX, y: newPosY },
        pivot: { x: newPivDocX, y: newPivDocY },
      });
      onCanvasModified();
    },
    [engine, onCanvasModified]
  );

  // OBSŁUGA INTERAKCJI UCHWYTÓW WEKTOROWYCH (FIGURA, LINIA, BEZIER)
  const updateVectorHandleInteraction = useCallback(
    (pt: SKPoint, shiftKey: boolean, altKey: boolean) => {
      const activeHandle = activeVectorHandleRef.current;
      if (!activeHandle || !vectorDragStartPtRef.current || !vectorInitialSessionStateRef.current) {
        return;
      }

      const startPt = vectorDragStartPtRef.current;
      const dx = Math.round(pt.x - startPt.x);
      const dy = Math.round(pt.y - startPt.y);

      if (activeVectorLineSession) {
        const init = vectorInitialSessionStateRef.current as ActiveVectorLineSession;
        if (activeHandle === 'p0') {
          let p0 = { x: Math.round(pt.x), y: Math.round(pt.y) };
          if (shiftKey) {
            const ldx = p0.x - init.p1.x;
            const ldy = p0.y - init.p1.y;
            const angle = Math.atan2(ldy, ldx);
            const step = Math.PI / 4;
            const snappedAngle = Math.round(angle / step) * step;
            const dist = Math.hypot(ldx, ldy);
            p0 = {
              x: Math.round(init.p1.x + Math.cos(snappedAngle) * dist),
              y: Math.round(init.p1.y + Math.sin(snappedAngle) * dist),
            };
          }
          setActiveVectorLineSession({ p0, p1: init.p1 });
        } else if (activeHandle === 'p1') {
          let p1 = { x: Math.round(pt.x), y: Math.round(pt.y) };
          if (shiftKey) {
            const ldx = p1.x - init.p0.x;
            const ldy = p1.y - init.p0.y;
            const angle = Math.atan2(ldy, ldx);
            const step = Math.PI / 4;
            const snappedAngle = Math.round(angle / step) * step;
            const dist = Math.hypot(ldx, ldy);
            p1 = {
              x: Math.round(init.p0.x + Math.cos(snappedAngle) * dist),
              y: Math.round(init.p0.y + Math.sin(snappedAngle) * dist),
            };
          }
          setActiveVectorLineSession({ p0: init.p0, p1 });
        } else if (activeHandle === 'move') {
          let moveDx = dx;
          let moveDy = dy;
          if (shiftKey) {
            if (Math.abs(moveDx) >= Math.abs(moveDy)) moveDy = 0;
            else moveDx = 0;
          }
          setActiveVectorLineSession({
            p0: { x: init.p0.x + moveDx, y: init.p0.y + moveDy },
            p1: { x: init.p1.x + moveDx, y: init.p1.y + moveDy },
          });
        }
        return;
      }

      if (activeVectorShapeSession || activeTextSession) {
        const isTextSess = !activeVectorShapeSession && !!activeTextSession;
        const setGeomSession = (next: any, handle?: string) => {
          if (isTextSess) {
            const keepAuto = !!(vectorInitialSessionStateRef.current as any)?.autoHeight;
            setActiveTextSession({
              ...next,
              autoHeight: keepAuto && !(handle && /[ns]/.test(handle)),
            });
          } else {
            setActiveVectorShapeSession(next);
          }
        };
        const init = vectorInitialSessionStateRef.current as {
          center: SKPoint;
          width: number;
          height: number;
          angle: number;
          pivot: SKPoint;
          flipX: boolean;
          flipY: boolean;
          settings: VectorShapeSettings;
        };

        if (activeHandle === 'modifier') {
          const { center, width, height, angle } = init;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const relX = pt.x - center.x;
          const relY = pt.y - center.y;
          const localX = relX * cos + relY * sin;

          if (vectorShapeSettings.shapeKind === 'rect' || vectorShapeSettings.shapeKind === 'round-rect') {
            const maxR = Math.min(width, height) / 2;
            const newR = Math.max(0, Math.min(maxR, Math.round(width / 2 - localX)));
            onChangeVectorShapeSettings?.({ cornerRadius: newR });
          } else if (vectorShapeSettings.shapeKind === 'star') {
            const outerR = Math.min(width, height) / 2;
            const localY = -relX * sin + relY * cos;
            const dist = Math.hypot(localX, localY);
            const ratio = Math.max(0.1, Math.min(0.9, dist / Math.max(1, outerR)));
            onChangeVectorShapeSettings?.({ starInnerRatio: Math.round(ratio * 100) / 100 });
          } else if (vectorShapeSettings.shapeKind === 'arrow') {
            const headW = Math.max(0.15, Math.min(0.85, (width / 2 - localX) / Math.max(1, width)));
            onChangeVectorShapeSettings?.({ arrowHeadWidth: Math.round(headW * 100) / 100 });
          }
          redraw();
          return;
        }

        if (activeHandle === 'modifier-shaft') {
          const { center, height, angle } = init;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const relX = pt.x - center.x;
          const relY = pt.y - center.y;
          const localY = -relX * sin + relY * cos;

          const shaftThick = Math.max(0.1, Math.min(0.85, (Math.abs(localY) * 2) / Math.max(1, height)));
          onChangeVectorShapeSettings?.({ arrowShaftThickness: Math.round(shaftThick * 100) / 100 });
          redraw();
          return;
        }

        if (activeHandle === 'move') {
          let moveDx = dx;
          let moveDy = dy;
          if (shiftKey) {
            if (Math.abs(moveDx) >= Math.abs(moveDy)) moveDy = 0;
            else moveDx = 0;
          }
          setGeomSession({
            ...init,
            center: { x: init.center.x + moveDx, y: init.center.y + moveDy },
            pivot: { x: init.pivot.x + moveDx, y: init.pivot.y + moveDy },
          });
          redraw();
          return;
        }

        if (activeHandle === 'rotate') {
          const P = init.center;
          const startAngle = Math.atan2(startPt.y - P.y, startPt.x - P.x);
          const curAngle = Math.atan2(pt.y - P.y, pt.x - P.x);
          let deltaAngle = curAngle - startAngle;
          let targetAngle = init.angle + deltaAngle;

          if (shiftKey) {
            const step = (15 * Math.PI) / 180;
            targetAngle = Math.round(targetAngle / step) * step;
          }

          setGeomSession({ ...init, angle: targetAngle });
          redraw();
          return;
        }

        // 8 Uchwytów skalowania figury (z pełną obsługą Alt = skalowanie symetryczne ze środka, Shift = zachowanie proporcji init.width / init.height)
        let uA = 0;
        let vA = 0;

        if (activeHandle === 'e') { uA = -0.5; vA = 0; }
        else if (activeHandle === 'w') { uA = 0.5; vA = 0; }
        else if (activeHandle === 's') { uA = 0; vA = -0.5; }
        else if (activeHandle === 'n') { uA = 0; vA = 0.5; }
        else if (activeHandle === 'se') { uA = -0.5; vA = -0.5; }
        else if (activeHandle === 'nw') { uA = 0.5; vA = 0.5; }
        else if (activeHandle === 'ne') { uA = -0.5; vA = 0.5; }
        else if (activeHandle === 'sw') { uA = 0.5; vA = -0.5; }

        const uH = -uA;
        const vH = -vA;

        const cos0 = Math.cos(init.angle);
        const sin0 = Math.sin(init.angle);
        const Ux = { x: cos0, y: sin0 };
        const Uy = { x: -sin0, y: cos0 };

        let newW = init.width;
        let newH = init.height;

        const anchorDocX = init.center.x + uA * init.width * cos0 - vA * init.height * sin0;
        const anchorDocY = init.center.y + uA * init.width * sin0 + vA * init.height * cos0;

        if (altKey) {
          const Vp = { x: pt.x - init.center.x, y: pt.y - init.center.y };
          const projPivX = Vp.x * Ux.x + Vp.y * Ux.y;
          const projPivY = Vp.x * Uy.x + Vp.y * Uy.y;

          const H0x = init.center.x + uH * init.width * cos0 - vH * init.height * sin0;
          const H0y = init.center.y + uH * init.width * sin0 + vH * init.height * cos0;
          const VH0 = { x: H0x - init.center.x, y: H0y - init.center.y };
          const projH0_X = VH0.x * Ux.x + VH0.y * Ux.y;
          const projH0_Y = VH0.x * Uy.x + VH0.y * Uy.y;

          if (uH !== 0) {
            if (Math.abs(projH0_X) > 0.001) {
              const signX = projH0_X >= 0 ? 1 : -1;
              const scaleX = Math.max(0.01, (projPivX * signX) / Math.abs(projH0_X));
              newW = Math.max(2, init.width * scaleX);
            } else {
              newW = Math.max(2, Math.abs(projPivX) * 2);
            }
          }

          if (vH !== 0) {
            if (Math.abs(projH0_Y) > 0.001) {
              const signY = projH0_Y >= 0 ? 1 : -1;
              const scaleY = Math.max(0.01, (projPivY * signY) / Math.abs(projH0_Y));
              newH = Math.max(2, init.height * scaleY);
            } else {
              newH = Math.max(2, Math.abs(projPivY) * 2);
            }
          }
        } else {
          const V = { x: pt.x - anchorDocX, y: pt.y - anchorDocY };
          const projX = V.x * Ux.x + V.y * Ux.y;
          const projY = V.x * Uy.x + V.y * Uy.y;

          if (uH !== 0) newW = Math.max(2, projX * Math.sign(uH));
          if (vH !== 0) newH = Math.max(2, projY * Math.sign(vH));
        }

        if (shiftKey) {
          const initialAspect = init.width / Math.max(1, init.height);
          if (uH !== 0 && vH !== 0) {
            const scaleW = newW / Math.max(1, init.width);
            const scaleH = newH / Math.max(1, init.height);
            if (Math.abs(scaleW - 1) >= Math.abs(scaleH - 1)) {
              newH = Math.max(2, newW / initialAspect);
            } else {
              newW = Math.max(2, newH * initialAspect);
            }
          } else if (uH !== 0) {
            newH = Math.max(2, newW / initialAspect);
          } else if (vH !== 0) {
            newW = Math.max(2, newH * initialAspect);
          }
        }

        let newCenterX: number;
        let newCenterY: number;

        if (altKey) {
          newCenterX = init.center.x;
          newCenterY = init.center.y;
        } else {
          newCenterX = anchorDocX - uA * newW * Ux.x - vA * newH * Uy.x;
          newCenterY = anchorDocY - uA * newW * Ux.y - vA * newH * Uy.y;
        }

        if (Math.abs(init.angle) < 0.001) {
          newW = Math.round(newW);
          newH = Math.round(newH);
          const left = Math.round(newCenterX - newW / 2);
          const top = Math.round(newCenterY - newH / 2);
          newCenterX = left + newW / 2;
          newCenterY = top + newH / 2;
        } else {
          newW = Math.round(newW * 10) / 10;
          newH = Math.round(newH * 10) / 10;
          newCenterX = Math.round(newCenterX * 10) / 10;
          newCenterY = Math.round(newCenterY * 10) / 10;
        }

        setGeomSession(
          {
            ...init,
            width: newW,
            height: newH,
            center: { x: newCenterX, y: newCenterY },
            pivot: { x: newCenterX, y: newCenterY },
          },
          activeHandle
        );
      }
    },
    [
      activeVectorLineSession,
      activeVectorBezierSession,
      activeVectorShapeSession,
      activeTextSession,
      onChangeVectorShapeSettings,
      vectorShapeSettings.shapeKind,
      redraw,
    ]
  );

  // OBSŁUGA PIERWOTNEGO PRZECIĄGANIA NOWEJ FIGURY / LINII / KRZYWEJ
  const updateInitialDrawingDrag = useCallback(
    (pt: SKPoint, shiftKey: boolean, altKey: boolean) => {
      const startPt = dragStartPointRef.current;
      if (!isDrawingRef.current || !startPt) return;

      const dist = Math.hypot(pt.x - startPt.x, pt.y - startPt.y);
      if (dist < 3) return;

      setCurrentDragPoint(pt);

      if (activeTool === 'line') {
        let p1 = { ...pt };
        if (shiftKey) {
          const dx = pt.x - startPt.x;
          const dy = pt.y - startPt.y;
          const angle = Math.atan2(dy, dx);
          const step = Math.PI / 4;
          const snappedAngle = Math.round(angle / step) * step;
          const lineDist = Math.hypot(dx, dy);
          p1 = {
            x: Math.round(startPt.x + Math.cos(snappedAngle) * lineDist),
            y: Math.round(startPt.y + Math.sin(snappedAngle) * lineDist),
          };
        }
        setActiveVectorLineSession({
          p0: { x: Math.round(startPt.x), y: Math.round(startPt.y) },
          p1: { x: Math.round(p1.x), y: Math.round(p1.y) },
        });
        return;
      }

      if (activeTool === 'shapes' || activeTool === 'text') {
        const startX = Math.round(startPt.x);
        const startY = Math.round(startPt.y);
        const curX = Math.round(pt.x);
        const curY = Math.round(pt.y);

        let w = 0;
        let h = 0;
        let center = { x: startX, y: startY };

        if (altKey) {
          // Alt key: startPt is the center, pt is a corner
          let halfW = Math.abs(curX - startX);
          let halfH = Math.abs(curY - startY);

          if (shiftKey) {
            const side = Math.max(halfW, halfH);
            halfW = side;
            halfH = side;
          }

          w = halfW * 2;
          h = halfH * 2;
          center = { x: startX, y: startY };
        } else {
          // Normal drag: startPt is a corner, pt is the opposite corner
          w = Math.abs(curX - startX);
          h = Math.abs(curY - startY);
          let minX = Math.min(startX, curX);
          let minY = Math.min(startY, curY);

          if (shiftKey) {
            const side = Math.max(w, h);
            w = side;
            h = side;
            minX = curX >= startX ? startX : startX - side;
            minY = curY >= startY ? startY : startY - side;
          }

          center = { x: minX + w / 2, y: minY + h / 2 };
        }

        w = Math.max(1, w);
        h = Math.max(1, h);

        if (activeTool === 'text') {
          setActiveTextSession({
            center,
            width: w,
            height: h,
            angle: 0,
            pivot: { ...center },
            flipX: false,
            flipY: false,
            autoHeight: false,
          });
        } else {
          setActiveVectorShapeSession({
            center,
            width: w,
            height: h,
            angle: 0,
            pivot: { ...center },
            flipX: false,
            flipY: false,
          });
        }
      }
    },
    [activeTool, redraw]
  );

  updateVectorHandleInteractionRef.current = updateVectorHandleInteraction;
  updateInitialDrawingDragRef.current = updateInitialDrawingDrag;

  // ===== KRZYWA WIELOWĘZŁOWA (narzędzie "Krzywa Beziera"): wyklikiwanie, edycja węzłów i uchwytów =====
  // Klik = węzeł ostry, przeciągnięcie = węzeł gładki. Enter / PPM kończy wyklikiwanie (krzywa pozostaje edytowalna),
  // ponowny Enter zatwierdza. Kliknięcie węzła (po zakończeniu) otwiera menu rodzaju węzła.
  const setPen = (next: ActiveVectorBezierSession) => {
    penRef.current = next;
    setActiveVectorBezierSession(next);
  };

  const penScreenPos = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const hitTestPen = (
    sess: ActiveVectorBezierSession,
    mx: number,
    my: number,
    docPt: SKPoint
  ): { kind: 'node' | 'hin' | 'hout' | 'seg'; index: number; seg?: PenHit } | null => {
    const R = 8;
    const near = (q: SKPoint) => {
      const sp = docToScreen(q);
      return Math.hypot(mx - sp.x, my - sp.y) <= R;
    };
    const { nodes, closed, phase, selected } = sess;
    const nN = nodes.length;
    if (phase === 'drawing') {
      if (nN >= 3 && near(nodes[0])) return { kind: 'node', index: 0 };
      return null;
    }
    const isClosed = closed && nN > 2;
    const order: number[] = [];
    if (selected >= 0 && selected < nN) order.push(selected);
    for (let i = 0; i < nN; i++) if (i !== selected) order.push(i);
    for (const i of order) {
      const nd = nodes[i];
      if (nd.hout && (i < nN - 1 || isClosed) && near(nd.hout)) return { kind: 'hout', index: i };
      if (nd.hin && (i > 0 || isClosed) && near(nd.hin)) return { kind: 'hin', index: i };
    }
    for (let i = nN - 1; i >= 0; i--) if (near(nodes[i])) return { kind: 'node', index: i };
    const hit = nearestOnPath(nodes, closed, docPt);
    if (hit && hit.dist * zoom <= 6) return { kind: 'seg', index: hit.seg.i, seg: hit };
    return null;
  };

  const penFinishDrawing = () => {
    const sess = penRef.current;
    if (!sess || sess.phase !== 'drawing') return;
    if (sess.nodes.length < 2) {
      cancelActiveVectorSession();
      return;
    }
    setPen({
      ...sess,
      nodes: normalizeOpenEnds(sess.nodes, sess.closed),
      phase: 'editing',
      selected: sess.nodes.length - 1,
    });
  };

  const penDeleteNode = (index?: number) => {
    const sess = penRef.current;
    if (!sess) return;
    if (sess.phase === 'drawing') {
      const nodes = sess.nodes.slice(0, -1);
      if (nodes.length === 0) cancelActiveVectorSession();
      else setPen({ ...sess, nodes, selected: nodes.length - 1 });
      return;
    }
    if (sess.nodes.length <= 2) return;
    const idx = Math.max(0, Math.min(index ?? sess.selected, sess.nodes.length - 1));
    const nodes = removeNode(sess.nodes, idx);
    setPenMenu(null);
    setPen({ ...sess, nodes, selected: Math.min(idx, nodes.length - 1) });
  };

  /** Zamyka / otwiera całą krzywą (przycisk na pasku opcji). Otwarcie usuwa odcinek zamykający. */
  const penToggleClosed = () => {
    const sess = penRef.current;
    if (!sess || sess.nodes.length < 3) return;
    setPenMenu(null);
    setPen({ ...sess, closed: !sess.closed, phase: 'editing' });
  };

  /** Otwiera zamkniętą krzywą w wybranym węźle: ten węzeł zostaje początkiem, poprzedni końcem. */
  const penOpenAt = (index: number) => {
    const sess = penRef.current;
    if (!sess || !sess.closed || sess.nodes.length < 3) return;
    const k = Math.max(0, Math.min(index, sess.nodes.length - 1));
    const rot = [...sess.nodes.slice(k), ...sess.nodes.slice(0, k)];
    setPenMenu(null);
    setPen({ ...sess, nodes: normalizeOpenEnds(rot, false), closed: false, phase: 'editing', selected: 0 });
  };

  const penToggleRef = useRef(penToggleClosed);
  penToggleRef.current = penToggleClosed;
  const prevPenToggleRef = useRef(penCloseToggleTrigger);
  useEffect(() => {
    if (penCloseToggleTrigger && penCloseToggleTrigger !== prevPenToggleRef.current) {
      prevPenToggleRef.current = penCloseToggleTrigger;
      penToggleRef.current();
    }
  }, [penCloseToggleTrigger]);

  const penInfoActive = !!activeVectorBezierSession;
  const penInfoClosed = !!activeVectorBezierSession?.closed;
  const penInfoCount = activeVectorBezierSession?.nodes.length ?? 0;
  useEffect(() => {
    onPenInfoChange?.({ active: penInfoActive, closed: penInfoClosed, count: penInfoCount });
  }, [penInfoActive, penInfoClosed, penInfoCount, onPenInfoChange]);

  const penChooseMode = (mode: PenMode) => {
    const sess = penRef.current;
    const m = penMenuRef.current;
    if (!sess || !m) return;
    if (!penModeAvailable(sess.nodes, m.index, sess.closed, mode)) return;
    setPen({ ...sess, nodes: setNodeMode(sess.nodes, m.index, mode, sess.closed), selected: m.index });
    setPenMenu(null);
  };

  const penSnap45 = (origin: SKPoint, p: SKPoint): SKPoint => {
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const step = Math.PI / 4;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    const d = Math.hypot(dx, dy);
    return { x: Math.round(origin.x + Math.cos(a) * d), y: Math.round(origin.y + Math.sin(a) * d) };
  };

  const penPointerDown = (e: React.PointerEvent, pt: SKPoint) => {
    const sess = penRef.current;
    setPenMenu(null);
    if (e.button === 2) {
      if (sess && sess.phase === 'drawing') penFinishDrawing();
      return;
    }
    const ms = penScreenPos(e);
    const rounded = { x: Math.round(pt.x), y: Math.round(pt.y) };
    const startDrag = (kind: PenDrag['kind'], index: number, nodes: PenNode[], inserted?: boolean) => {
      penDragRef.current = { kind, index, startPt: pt, startScreen: ms, moved: false, initNodes: nodes, inserted };
    };

    if (sess) {
      const hit = hitTestPen(sess, ms.x, ms.y, pt);
      if (sess.phase === 'drawing') {
        if (hit && hit.kind === 'node' && hit.index === 0) {
          // kliknięcie pierwszego węzła zamyka krzywą
          setPen({ ...sess, closed: true, phase: 'editing', selected: 0 });
          return;
        }
        let p = rounded;
        if (e.shiftKey && sess.nodes.length > 0) p = penSnap45(sess.nodes[sess.nodes.length - 1], p);
        const nodes = [...sess.nodes, { x: p.x, y: p.y, hin: null, hout: null }];
        setPen({ ...sess, nodes, selected: nodes.length - 1 });
        startDrag('create', nodes.length - 1, nodes);
        return;
      }
      if (hit) {
        if (hit.kind === 'hin' || hit.kind === 'hout') {
          setPen({ ...sess, selected: hit.index });
          startDrag(hit.kind, hit.index, sess.nodes);
          return;
        }
        if (hit.kind === 'node') {
          setPen({ ...sess, selected: hit.index });
          startDrag('node', hit.index, sess.nodes);
          return;
        }
        if (hit.kind === 'seg' && hit.seg) {
          const ins = insertNodeAt(sess.nodes, hit.seg);
          setPen({ ...sess, nodes: ins.nodes, selected: ins.index });
          startDrag('node', ins.index, ins.nodes, true);
          return;
        }
      }
      // Kliknięcie poza krzywą zatwierdza ją i zaczyna nową
      commitActiveVectorSession();
    }
    const nodes: PenNode[] = [{ x: rounded.x, y: rounded.y, hin: null, hout: null }];
    setPen({ nodes, closed: false, phase: 'drawing', selected: 0 });
    startDrag('create', 0, nodes);
  };

  /** Zwraca true, gdy zdarzenie zostało obsłużone przez narzędzie krzywej. */
  const penPointerMove = (e: React.PointerEvent, pt: SKPoint | null): boolean => {
    if (activeTool !== 'bezier' || isSamplingPipetteRef.current) return false;
    const sess = penRef.current;
    const d = penDragRef.current;
    if (!pt) return true;
    const ms = penScreenPos(e);
    if (d && sess) {
      if (!d.moved && Math.hypot(ms.x - d.startScreen.x, ms.y - d.startScreen.y) < 3) return true;
      d.moved = true;
      const rounded = { x: Math.round(pt.x), y: Math.round(pt.y) };
      let nodes = d.initNodes;
      if (d.kind === 'create') {
        const n = d.initNodes[d.index];
        const c = e.shiftKey ? penSnap45(n, rounded) : rounded;
        nodes = setSmoothFromDrag(d.initNodes, d.index, c);
      } else if (d.kind === 'node') {
        let dx = Math.round(pt.x - d.startPt.x);
        let dy = Math.round(pt.y - d.startPt.y);
        if (e.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        nodes = moveNodeBy(d.initNodes, d.index, dx, dy);
      } else {
        const n = d.initNodes[d.index];
        const t = e.shiftKey ? penSnap45(n, rounded) : rounded;
        nodes = moveHandle(d.initNodes, d.index, d.kind, t);
      }
      setPen({ ...sess, nodes });
      return true;
    }
    if (sess) {
      const hit = hitTestPen(sess, ms.x, ms.y, pt);
      const str = !hit ? null : hit.kind === 'seg' ? 'seg' : hit.kind === 'node' ? `n:${hit.index}` : `${hit.kind}:${hit.index}`;
      if (str !== hoverVectorHandle) setHoverVectorHandle(str);
    }
    return true;
  };

  const penPointerUp = (): boolean => {
    if (activeTool !== 'bezier' || isSamplingPipetteRef.current) return false;
    const d = penDragRef.current;
    penDragRef.current = null;
    const sess = penRef.current;
    if (d && !d.moved && d.kind === 'node' && !d.inserted && sess && sess.phase === 'editing') {
      setPenMenu({ index: d.index });
    }
    redraw();
    return true;
  };

  const penApiRef = useRef({ finish: penFinishDrawing, del: () => penDeleteNode() });
  penApiRef.current = { finish: penFinishDrawing, del: () => penDeleteNode() };
  const penMenuRef = useRef<{ index: number } | null>(null);
  penMenuRef.current = penMenu;

  /** Lasso punkt po punkcie: zatwierdzenie (>= 3 punkty), anulowanie i cofnięcie ostatniego punktu. */
  const lassoEnd = () => {
    lassoMultiRef.current = false;
    lassoPressRef.current = null;
    setLassoMultiActive(false);
    setLassoPts([]);
    setIsDrawingSynced(false);
    setDragStartPointSynced(null);
    setCurrentDragPoint(null);
  };
  const lassoApiRef = useRef({
    finish: (_ctrl: boolean, _alt: boolean) => {},
    cancel: () => {},
    undo: () => {},
  });
  lassoApiRef.current = {
    finish: (ctrl, alt) => {
      const pts = lassoPointsRef.current;
      if (pts.length >= 3) {
        let mode = selectionSettings.mode;
        if (ctrl && alt) mode = 'intersect';
        else if (alt) mode = 'subtract';
        else if (ctrl) mode = 'add';
        engine.applySelectionShape('lasso', pts, { ...selectionSettings, mode }, false, true);
        onCanvasModified();
      }
      lassoEnd();
    },
    cancel: lassoEnd,
    undo: () => {
      const pts = lassoPointsRef.current.slice(0, -1);
      if (pts.length === 0) lassoEnd();
      else setLassoPts(pts);
    },
  };

  // Zmiana narzędzia (lub trybu lasso) w trakcie sesji zatwierdza ją albo porzuca
  useEffect(() => {
    if (lassoMultiRef.current && (activeTool !== 'select-lasso' || selectionSettings.lassoMode !== 'polygon')) {
      lassoApiRef.current.finish(false, false);
    }
  }, [activeTool, selectionSettings.lassoMode]);

  // OBSŁUGA SKRÓTÓW KLAWIATUROWYCH (Enter = Zatwierdź, Esc = Anuluj, Natychmiastowa reakcja na Shift / Alt)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isInteracting =
        (isTransformTool && !!transformActiveHandleRef.current) ||
        !!activeVectorHandleRef.current ||
        (isDrawingRef.current && !!dragStartPointRef.current);

      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        if (!isInteracting || (e.key !== 'Shift' && e.key !== 'Alt')) {
          return;
        }
      }
      if (e.code === 'Space' && !isSpacePressed) {
        setIsSpacePressed(true);
      }
      if (e.key === 'Shift') {
        setIsShiftKeyDown(true);
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        setIsCtrlKeyDown(true);
      }

      const isSelectionTool =
        activeTool === 'select-rect' ||
        activeTool === 'select-ellipse' ||
        activeTool === 'select-lasso' ||
        activeTool === 'magic-wand';

      if (isSelectionTool && (e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt')) {
        if (baseSelectionModeRef.current === null) {
          baseSelectionModeRef.current = selectionSettings.mode;
        }

        const ctrlKey = e.ctrlKey || e.metaKey || e.key === 'Control' || e.key === 'Meta';
        const altKey = e.altKey || e.key === 'Alt';

        let targetMode = baseSelectionModeRef.current;
        if (ctrlKey && altKey) {
          targetMode = 'intersect';
        } else if (altKey) {
          targetMode = 'subtract';
        } else if (ctrlKey) {
          targetMode = 'add';
        }

        if (selectionSettings.mode !== targetMode) {
          onChangeSelectionSettings?.({ mode: targetMode });
        }
      }

      if (e.key === 'Shift' || e.key === 'Alt') {
        const pt = lastDocPtRef.current;
        if (pt) {
          const shiftKey = e.shiftKey || e.key === 'Shift';
          const altKey = e.altKey || e.key === 'Alt';
          if (isTransformTool && transformActiveHandleRef.current) {
            updateTransformInteraction(pt, shiftKey, altKey);
          } else if (activeVectorHandleRef.current) {
            updateVectorHandleInteraction(pt, shiftKey, altKey);
          } else if (isDrawingRef.current && dragStartPointRef.current) {
            updateInitialDrawingDrag(pt, shiftKey, altKey);
          }
        }
      }
      if (lassoMultiRef.current && activeTool === 'select-lasso') {
        if (e.key === 'Enter') {
          e.preventDefault();
          lassoApiRef.current.finish(e.ctrlKey || e.metaKey, e.altKey);
          return;
        }
        if (e.key === 'Escape') {
          lassoApiRef.current.cancel();
          return;
        }
        if (e.key === 'Backspace') {
          e.preventDefault();
          lassoApiRef.current.undo();
          return;
        }
      }
      if (penRef.current && activeTool === 'bezier') {
        if (e.key === 'Escape' && penMenuRef.current) {
          setPenMenu(null);
          return;
        }
        if (e.key === 'Enter' && penRef.current.phase === 'drawing') {
          e.preventDefault();
          penApiRef.current.finish();
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          penApiRef.current.del();
          return;
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        if (deleteVecRef.current()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (vecGroupDragRef.current) {
          vecGroupDragRef.current = null;
          engine.vec.cancelGroupMove();
          onCanvasModified();
        } else if (vecMarqueeRef.current) {
          vecMarqueeRef.current = null;
        } else if (isAnyVectorSessionActive) {
          cancelActiveVectorSession();
          engine.vec.clearSelection();
          notifyVecRef.current();
        } else if (engine.vec.getSelection() && engine.getActiveLayer()?.isVector) {
          engine.vec.clearSelection();
          notifyVecRef.current();
        } else if (engine.transformContentSession) {
          engine.cancelTransformContent();
          onCanvasModified();
        } else if (engine.selectionManager.transformState) {
          engine.selectionManager.cancelTransformSelection();
          onCanvasModified();
        } else if (engine.bucketSeedPoint) {
          engine.cancelPaintBucketSession();
          onCanvasModified();
        } else if (engine.gradientStartPoint) {
          engine.cancelGradientSession();
          onCanvasModified();
        }
      } else if (e.key === 'Enter') {
        if (isAnyVectorSessionActive) {
          commitActiveVectorSession();
        } else if (engine.transformContentSession) {
          engine.commitTransformContent();
          onCanvasModified();
        } else if (engine.selectionManager.transformState) {
          engine.selectionManager.commitTransformSelection();
          onCanvasModified();
        } else if (engine.bucketSeedPoint) {
          engine.commitPaintBucketSession();
          onCanvasModified();
        } else if (engine.gradientStartPoint) {
          engine.commitGradientSession();
          onCanvasModified();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
      }
      if (e.key === 'Shift') {
        setIsShiftKeyDown(false);
      }
      if (e.key === 'Control' || e.key === 'Meta') {
        setIsCtrlKeyDown(false);
      }

      const isSelectionTool =
        activeTool === 'select-rect' ||
        activeTool === 'select-ellipse' ||
        activeTool === 'select-lasso' ||
        activeTool === 'magic-wand';

      if (isSelectionTool && (e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt')) {
        const ctrlKey = e.key === 'Control' || e.key === 'Meta' ? false : e.ctrlKey || e.metaKey;
        const altKey = e.key === 'Alt' ? false : e.altKey;

        let targetMode = baseSelectionModeRef.current || 'replace';
        if (ctrlKey && altKey) {
          targetMode = 'intersect';
        } else if (altKey) {
          targetMode = 'subtract';
        } else if (ctrlKey) {
          targetMode = 'add';
        } else {
          targetMode = baseSelectionModeRef.current || 'replace';
          baseSelectionModeRef.current = null;
        }

        if (selectionSettings.mode !== targetMode) {
          onChangeSelectionSettings?.({ mode: targetMode });
        }
      }

      if (e.key === 'Shift' || e.key === 'Alt') {
        const pt = lastDocPtRef.current;
        if (pt) {
          const shiftKey = e.key === 'Shift' ? false : e.shiftKey;
          const altKey = e.key === 'Alt' ? false : e.altKey;
          if (isTransformTool && transformActiveHandleRef.current) {
            updateTransformInteraction(pt, shiftKey, altKey);
          } else if (activeVectorHandleRef.current) {
            updateVectorHandleInteraction(pt, shiftKey, altKey);
          } else if (isDrawingRef.current && dragStartPointRef.current) {
            updateInitialDrawingDrag(pt, shiftKey, altKey);
          }
        }
      }
    };

    const handleBlur = () => {
      setIsSpacePressed(false);
      setIsShiftKeyDown(false);
      setIsCtrlKeyDown(false);
      isSamplingPipetteRef.current = false;
      if (baseSelectionModeRef.current !== null) {
        onChangeSelectionSettings?.({ mode: baseSelectionModeRef.current });
        baseSelectionModeRef.current = null;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [
    isSpacePressed,
    isAnyVectorSessionActive,
    isTransformTool,
    commitActiveVectorSession,
    cancelActiveVectorSession,
    engine,
    onCanvasModified,
    updateTransformInteraction,
    updateVectorHandleInteraction,
    updateInitialDrawingDrag,
    activeTool,
    selectionSettings,
    onChangeSelectionSettings,
  ]);

  // RENDEROWANIE NAKŁADKI: MASZERUJĄCE MRÓWKI, UCHWYTY TRANSFORMACJI, EDYCJA WEKTOROWA
  useEffect(() => {
    let animId: number;

    const renderOverlay = () => {
      const oCanvas = overlayCanvasRef.current;
      const container = containerRef.current;

      if (oCanvas && container) {
        const cWidth = container.clientWidth;
        const cHeight = container.clientHeight;

        if (oCanvas.width !== cWidth || oCanvas.height !== cHeight) {
          oCanvas.width = cWidth;
          oCanvas.height = cHeight;
        }

        const oCtx = oCanvas.getContext('2d');
        if (oCtx) {
          oCtx.clearRect(0, 0, cWidth, cHeight);

          const screenCenterX = cWidth / 2 + panOffset.x;
          const screenCenterY = cHeight / 2 + panOffset.y;

          oCtx.save();
          oCtx.translate(screenCenterX, screenCenterY);
          oCtx.scale(zoom, zoom);
          oCtx.translate(-engine.width / 2, -engine.height / 2);

          // 1. MASZERUJĄCE MRÓWKI DLA ZAZNACZENIA
          if (engine.selectionManager.hasActiveSelection) {
            const time = performance.now();
            const dashOffset = (time / 60) % 8;

            oCtx.save();
            oCtx.lineWidth = 1 / zoom;
            oCtx.setLineDash([4 / zoom, 4 / zoom]);

            // Tylko widoczny fragment konturu: pełny kontur przy dużym zoomie to miliony kresek poza ekranem
            const antsPath = engine.selectionManager.getVisibleContourPath(
              (0 - screenCenterX) / zoom + engine.width / 2,
              (0 - screenCenterY) / zoom + engine.height / 2,
              (cWidth - screenCenterX) / zoom + engine.width / 2,
              (cHeight - screenCenterY) / zoom + engine.height / 2
            );

            oCtx.lineDashOffset = dashOffset / zoom;
            oCtx.strokeStyle = '#000000';
            oCtx.stroke(antsPath);

            oCtx.lineDashOffset = (dashOffset + 4) / zoom;
            oCtx.strokeStyle = '#ffffff';
            oCtx.stroke(antsPath);

            oCtx.restore();
          }

          // 2. PODGLĄD ZAZNACZANIA NA ŻYWO (PROSTOKĄT, ELIPSA, LASSO)
          if (isDrawing && dragStartPoint && currentDragPoint) {
            oCtx.save();
            oCtx.lineWidth = 1 / zoom;
            oCtx.setLineDash([4 / zoom, 4 / zoom]);
            oCtx.lineDashOffset = performance.now() / 60 / zoom;
            oCtx.strokeStyle = '#00e5ff';
            oCtx.fillStyle = 'rgba(0, 229, 255, 0.15)';

            if (activeTool === 'select-rect') {
              const hasMoved = dragStartPoint.x !== currentDragPoint.x || dragStartPoint.y !== currentDragPoint.y;
              const r = engine.selectionManager.calculateConstrainedRect(
                dragStartPoint,
                currentDragPoint,
                selectionSettings,
                isShiftKeyDown,
                hasMoved
              );
              if (r.width > 0 && r.height > 0) {
                oCtx.fillRect(r.left, r.top, r.width, r.height);
                oCtx.strokeRect(r.left, r.top, r.width, r.height);
              }
            } else if (activeTool === 'select-ellipse') {
              const hasMoved = dragStartPoint.x !== currentDragPoint.x || dragStartPoint.y !== currentDragPoint.y;
              const r = engine.selectionManager.calculateConstrainedRect(
                dragStartPoint,
                currentDragPoint,
                selectionSettings,
                isShiftKeyDown,
                hasMoved
              );
              if (r.width > 0 && r.height > 0) {
                oCtx.beginPath();
                oCtx.ellipse(
                  r.left + r.width / 2,
                  r.top + r.height / 2,
                  Math.max(0.5, r.width / 2),
                  Math.max(0.5, r.height / 2),
                  0,
                  0,
                  Math.PI * 2
                );
                oCtx.fill();
                oCtx.stroke();
              }
            } else if (activeTool === 'select-lasso' && lassoPoints.length > 0) {
              oCtx.beginPath();
              oCtx.moveTo(lassoPoints[0].x, lassoPoints[0].y);
              for (let i = 1; i < lassoPoints.length; i++) {
                oCtx.lineTo(lassoPoints[i].x, lassoPoints[i].y);
              }
              oCtx.lineTo(currentDragPoint.x, currentDragPoint.y);
              oCtx.closePath();
              oCtx.fill();
              oCtx.stroke();
            } else if (activeTool === 'zoom') {
              const minX = Math.min(dragStartPoint.x, currentDragPoint.x);
              const minY = Math.min(dragStartPoint.y, currentDragPoint.y);
              const w = Math.abs(currentDragPoint.x - dragStartPoint.x);
              const h = Math.abs(currentDragPoint.y - dragStartPoint.y);

              if (w > 0 && h > 0) {
                oCtx.save();
                // 1. Semi-transparentny niebieski podkład
                oCtx.fillStyle = 'rgba(0, 162, 255, 0.22)';
                oCtx.fillRect(minX, minY, w, h);

                // 2. Pojedynczy niebieski obrys z maszerującymi mrówkami
                oCtx.lineWidth = 1.5 / zoom;
                oCtx.setLineDash([4 / zoom, 4 / zoom]);
                oCtx.lineDashOffset = (performance.now() / 50) / zoom;
                oCtx.strokeStyle = '#00e5ff';
                oCtx.strokeRect(minX, minY, w, h);

                oCtx.restore();
              }
            }

            oCtx.restore();
          }

          // 3. UCHWYT MAGICZNEJ RÓŻDŻKI LUB WIADRA
          const activeHandlePoint =
            activeTool === 'magic-wand'
              ? engine.selectionManager.wandSeedPoint
              : activeTool === 'bucket'
              ? engine.bucketSeedPoint
              : null;

          if (activeHandlePoint) {
            const sp = activeHandlePoint;
            const handleR = 7 / zoom;

            oCtx.save();
            oCtx.fillStyle = activeTool === 'bucket' ? '#ff9800' : '#00e5ff';
            oCtx.strokeStyle = '#ffffff';
            oCtx.lineWidth = 2 / zoom;

            oCtx.beginPath();
            oCtx.arc(sp.x, sp.y, handleR, 0, Math.PI * 2);
            oCtx.fill();
            oCtx.stroke();

            oCtx.strokeStyle = activeTool === 'bucket' ? '#331100' : '#003344';
            oCtx.lineWidth = 1.5 / zoom;
            oCtx.beginPath();
            oCtx.moveTo(sp.x - handleR * 1.5, sp.y);
            oCtx.lineTo(sp.x + handleR * 1.5, sp.y);
            oCtx.moveTo(sp.x, sp.y - handleR * 1.5);
            oCtx.lineTo(sp.x, sp.y + handleR * 1.5);
            oCtx.stroke();

            oCtx.restore();
          }

          // 4. UCHWYTY WYPEŁNIENIA GRADIENTOWEGO
          if (activeTool === 'gradient' && engine.gradientStartPoint && engine.gradientEndPoint) {
            const p0 = engine.gradientStartPoint;
            const p1 = engine.gradientEndPoint;
            const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };

            oCtx.save();
            oCtx.lineWidth = 3 / zoom;
            oCtx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            oCtx.beginPath();
            oCtx.moveTo(p0.x, p0.y);
            oCtx.lineTo(p1.x, p1.y);
            oCtx.stroke();

            oCtx.lineWidth = 1.5 / zoom;
            oCtx.strokeStyle = '#ffffff';
            oCtx.beginPath();
            oCtx.moveTo(p0.x, p0.y);
            oCtx.lineTo(p1.x, p1.y);
            oCtx.stroke();

            const drawHollowRing = (pt: SKPoint, isHover: boolean, rPx: number = 6) => {
              const r = rPx / zoom;
              oCtx.save();
              // Zewnętrzny czarny obrys
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 2.5 / zoom;
              oCtx.beginPath();
              oCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
              oCtx.stroke();
              // Wewnętrzny biały/błękitny obrys
              oCtx.strokeStyle = isHover ? '#00e5ff' : '#ffffff';
              oCtx.lineWidth = 1.2 / zoom;
              oCtx.beginPath();
              oCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
              oCtx.stroke();
              oCtx.restore();
            };

            // P0 i P1 (rozmiar 6 tak jak w narzędziu linia)
            drawHollowRing(p0, gradientHoverHandle === 0 || isDraggingGradientHandle === 0, 6);
            drawHollowRing(p1, gradientHoverHandle === 1 || isDraggingGradientHandle === 1, 6);

            // Środek (rozmiar 4 tak jak w narzędziu linia)
            drawHollowRing(mid, gradientHoverHandle === 'move' || isDraggingGradientHandle === 'move', 4);

            oCtx.restore();
          }

          // 4b. ZAZNACZENIE OBIEKTÓW WEKTOROWYCH: ramka zbiorcza (bez uchwytów obiektów) i zaznaczanie obszarem
          {
            const vl = engine.getActiveLayer();
            if (vl && vl.isVector && !vectorActiveRef.current) {
              const ids = engine.vec.selectedIds(vl);
              const box = ids.length > 0 ? engine.vec.selectionTightBounds(vl) : null;
              if (box) {
                oCtx.save();
                const pad = 3 / zoom;
                const x = box.x0 - pad;
                const y = box.y0 - pad;
                const w = box.x1 - box.x0 + 2 * pad;
                const h = box.y1 - box.y0 + 2 * pad;
                oCtx.lineWidth = 2.5 / zoom;
                oCtx.strokeStyle = 'rgba(0,0,0,0.55)';
                oCtx.setLineDash([]);
                oCtx.strokeRect(x, y, w, h);
                oCtx.lineWidth = 1.2 / zoom;
                oCtx.strokeStyle = '#00e5ff';
                oCtx.setLineDash([5 / zoom, 4 / zoom]);
                oCtx.lineDashOffset = performance.now() / 60 / zoom;
                oCtx.strokeRect(x, y, w, h);
                oCtx.restore();
              }
            }
            const mq = vecMarqueeRef.current;
            if (mq) {
              const mx = Math.min(mq.start.x, mq.cur.x);
              const my = Math.min(mq.start.y, mq.cur.y);
              const mw = Math.abs(mq.cur.x - mq.start.x);
              const mh = Math.abs(mq.cur.y - mq.start.y);
              if (mw > 0 || mh > 0) {
                oCtx.save();
                oCtx.lineWidth = 1 / zoom;
                oCtx.setLineDash([4 / zoom, 4 / zoom]);
                oCtx.lineDashOffset = performance.now() / 60 / zoom;
                oCtx.strokeStyle = '#00e5ff';
                oCtx.fillStyle = 'rgba(0, 229, 255, 0.15)';
                oCtx.fillRect(mx, my, mw, mh);
                oCtx.strokeRect(mx, my, mw, mh);
                oCtx.restore();
              }
            }
          }

          // 5. INTERFEJS EDYCJI LINII NA ŻYWO (P0, P1, ŚRODEK) - PUSTE ZNACZNIKI
          if (activeVectorLineSession) {
            const { p0, p1 } = activeVectorLineSession;
            const mid: SKPoint = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };

            const drawHollowRing = (pt: SKPoint, isHover: boolean, rPx: number = 6) => {
              const r = rPx / zoom;
              oCtx.save();
              // Zewnętrzny czarny obrys
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 2.5 / zoom;
              oCtx.beginPath();
              oCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
              oCtx.stroke();
              // Wewnętrzny biały/błękitny obrys
              oCtx.strokeStyle = isHover ? '#00e5ff' : '#ffffff';
              oCtx.lineWidth = 1.2 / zoom;
              oCtx.beginPath();
              oCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
              oCtx.stroke();
              oCtx.restore();
            };

            // P0 i P1
            drawHollowRing(p0, hoverVectorHandle === 'p0', 6);
            drawHollowRing(p1, hoverVectorHandle === 'p1', 6);

            // Środek (przesuwanie)
            drawHollowRing(mid, hoverVectorHandle === 'move', 4);
          }

          // 6. INTERFEJS EDYCJI KRZYWEJ WIELOWĘZŁOWEJ NA ŻYWO (węzły, uchwyty, linia pomocnicza do kursora)
          if (activeVectorBezierSession && !freehandRef.current) {
            const { nodes, closed, phase, selected } = activeVectorBezierSession;
            const nN = nodes.length;
            const hov = hoverVectorHandle;
            const dragging = penDragRef.current;

            oCtx.save();
            // Linia pomocnicza od ostatniego węzła do kursora (podczas wyklikiwania)
            if (phase === 'drawing' && nN > 0 && !dragging) {
              const cur = lastDocPtRef.current;
              if (cur) {
                const last = nodes[nN - 1];
                const c = { x: Math.round(cur.x), y: Math.round(cur.y) };
                oCtx.lineWidth = 1 / zoom;
                oCtx.strokeStyle = 'rgba(168, 85, 247, 0.9)';
                oCtx.setLineDash([4 / zoom, 3 / zoom]);
                oCtx.beginPath();
                oCtx.moveTo(last.x, last.y);
                if (last.hout) oCtx.bezierCurveTo(last.hout.x, last.hout.y, c.x, c.y, c.x, c.y);
                else oCtx.lineTo(c.x, c.y);
                oCtx.stroke();
                oCtx.setLineDash([]);
              }
            }

            // Które uchwyty pokazujemy: w trakcie wyklikiwania tylko przy ostatnim węźle, potem przy wszystkich
            const showHin = (i: number) => (phase === 'drawing' ? i === nN - 1 : i > 0 || (closed && nN > 2));
            const showHout = (i: number) => (phase === 'drawing' ? i === nN - 1 : i < nN - 1 || (closed && nN > 2));

            oCtx.lineWidth = 1 / zoom;
            oCtx.strokeStyle = 'rgba(168, 85, 247, 0.7)';
            oCtx.setLineDash([3 / zoom, 3 / zoom]);
            oCtx.beginPath();
            for (let i = 0; i < nN; i++) {
              const nd = nodes[i];
              if (nd.hin && showHin(i)) {
                oCtx.moveTo(nd.x, nd.y);
                oCtx.lineTo(nd.hin.x, nd.hin.y);
              }
              if (nd.hout && showHout(i)) {
                oCtx.moveTo(nd.x, nd.y);
                oCtx.lineTo(nd.hout.x, nd.hout.y);
              }
            }
            oCtx.stroke();
            oCtx.setLineDash([]);
            oCtx.restore();

            const diamond = (pt: SKPoint, isHover: boolean) => {
              const d = 5 / zoom;
              const path = () => {
                oCtx.beginPath();
                oCtx.moveTo(pt.x, pt.y - d);
                oCtx.lineTo(pt.x + d, pt.y);
                oCtx.lineTo(pt.x, pt.y + d);
                oCtx.lineTo(pt.x - d, pt.y);
                oCtx.closePath();
              };
              oCtx.save();
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 2.5 / zoom;
              path();
              oCtx.stroke();
              oCtx.strokeStyle = isHover ? '#00e5ff' : '#a855f7';
              oCtx.lineWidth = 1.2 / zoom;
              path();
              oCtx.stroke();
              oCtx.restore();
            };

            const nodeMark = (pt: SKPoint, isHover: boolean, isSel: boolean, isFirstClose: boolean) => {
              const r = 5.5 / zoom;
              oCtx.save();
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 2.5 / zoom;
              oCtx.beginPath();
              oCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
              oCtx.stroke();
              oCtx.strokeStyle = isHover ? '#00e5ff' : '#ffffff';
              oCtx.lineWidth = 1.2 / zoom;
              oCtx.stroke();
              if (isSel || isFirstClose) {
                oCtx.fillStyle = isFirstClose ? '#00e5ff' : '#a855f7';
                oCtx.beginPath();
                oCtx.arc(pt.x, pt.y, r * 0.55, 0, Math.PI * 2);
                oCtx.fill();
              }
              oCtx.restore();
            };

            for (let i = 0; i < nN; i++) {
              const nd = nodes[i];
              if (nd.hin && showHin(i)) diamond(nd.hin, hov === `hin:${i}`);
              if (nd.hout && showHout(i)) diamond(nd.hout, hov === `hout:${i}`);
            }
            for (let i = 0; i < nN; i++) {
              const nd = nodes[i];
              nodeMark(nd, hov === `n:${i}`, phase === 'editing' && i === selected, phase === 'drawing' && i === 0 && nN >= 3 && hov === 'n:0');
            }
          }

          // 7. INTERFEJS EDYCJI FIGURY NA ŻYWO (RAMKA, 8 UCHWYTÓW, OBRÓT, MODYFIKATOR)
          const overlayGeomSess = activeVectorShapeSession ?? activeTextSession;
          if (overlayGeomSess) {
            const sess = overlayGeomSess;
            const cos = Math.cos(sess.angle);
            const sin = Math.sin(sess.angle);

            oCtx.save();

            // Ramka obwiedni (Bounding box)
            oCtx.translate(sess.center.x, sess.center.y);
            oCtx.rotate(sess.angle);

            oCtx.lineWidth = 1 / zoom;
            oCtx.strokeStyle = 'rgba(0, 122, 204, 0.9)';
            oCtx.strokeRect(-sess.width / 2, -sess.height / 2, sess.width, sess.height);

            oCtx.lineWidth = 1 / zoom;
            oCtx.setLineDash([4 / zoom, 4 / zoom]);
            oCtx.strokeStyle = '#ffffff';
            oCtx.strokeRect(-sess.width / 2, -sess.height / 2, sess.width, sess.height);
            oCtx.setLineDash([]);

            // Uchwyt obrotu (ramię + koło)
            const rotStem = 22 / zoom;
            oCtx.strokeStyle = '#007acc';
            oCtx.lineWidth = 1.5 / zoom;
            oCtx.beginPath();
            oCtx.moveTo(0, -sess.height / 2);
            oCtx.lineTo(0, -sess.height / 2 - rotStem);
            oCtx.stroke();

            oCtx.fillStyle = hoverVectorHandle === 'rotate' ? '#00e5ff' : '#ffffff';
            oCtx.strokeStyle = '#007acc';
            oCtx.lineWidth = 2 / zoom;
            oCtx.beginPath();
            oCtx.arc(0, -sess.height / 2 - rotStem, 5.5 / zoom, 0, Math.PI * 2);
            oCtx.fill();
            oCtx.stroke();

            // 8 Uchwytów skalowania
            const handleSize = 7 / zoom;
            const localCoords: Record<string, { u: number; v: number }> = {
              nw: { u: -0.5, v: -0.5 },
              n: { u: 0, v: -0.5 },
              ne: { u: 0.5, v: -0.5 },
              e: { u: 0.5, v: 0 },
              se: { u: 0.5, v: 0.5 },
              s: { u: 0, v: 0.5 },
              sw: { u: -0.5, v: 0.5 },
              w: { u: -0.5, v: 0 },
            };

            for (const [key, lc] of Object.entries(localCoords)) {
              const hx = lc.u * sess.width - handleSize / 2;
              const hy = lc.v * sess.height - handleSize / 2;
              const isHover = hoverVectorHandle === key;

              oCtx.fillStyle = isHover ? '#00e5ff' : '#ffffff';
              oCtx.strokeStyle = '#007acc';
              oCtx.lineWidth = 1.5 / zoom;
              oCtx.fillRect(hx, hy, handleSize, handleSize);
              oCtx.strokeRect(hx, hy, handleSize, handleSize);
            }

            oCtx.restore();

            // 8. ŻÓŁTY PUNKT MODYFIKATORA (TYLKO DLA FIGUR, KTÓRE GO MAJĄ)
            if (activeVectorShapeSession && hasShapeModifier(vectorShapeSettings.shapeKind)) {
              const modDoc = getShapeModifierDocPoint(sess, vectorShapeSettings);
              const modR = 7 / zoom;
              const isModHover = hoverVectorHandle === 'modifier';

              oCtx.save();
              oCtx.fillStyle = isModHover ? '#ffe600' : '#ffb703';
              oCtx.strokeStyle = '#1e1e1e';
              oCtx.lineWidth = 2 / zoom;
              oCtx.shadowColor = 'rgba(255, 183, 3, 0.6)';
              oCtx.shadowBlur = 8 / zoom;

              oCtx.beginPath();
              oCtx.arc(modDoc.x, modDoc.y, modR, 0, Math.PI * 2);
              oCtx.fill();
              oCtx.stroke();

              oCtx.shadowColor = 'transparent';
              oCtx.fillStyle = '#ffffff';
              oCtx.beginPath();
              oCtx.arc(modDoc.x, modDoc.y, modR * 0.4, 0, Math.PI * 2);
              oCtx.fill();

              // Drugi uchwyt modyfikatora dla strzałki (grubość trzonu)
              if (vectorShapeSettings.shapeKind === 'arrow') {
                const shaftDoc = getArrowShaftModifierDocPoint(sess, vectorShapeSettings);
                const isShaftHover = hoverVectorHandle === 'modifier-shaft';

                oCtx.fillStyle = isShaftHover ? '#ffe600' : '#ffb703';
                oCtx.strokeStyle = '#1e1e1e';
                oCtx.lineWidth = 2 / zoom;
                oCtx.shadowColor = 'rgba(255, 183, 3, 0.6)';
                oCtx.shadowBlur = 8 / zoom;

                oCtx.beginPath();
                oCtx.arc(shaftDoc.x, shaftDoc.y, modR, 0, Math.PI * 2);
                oCtx.fill();
                oCtx.stroke();

                oCtx.shadowColor = 'transparent';
                oCtx.fillStyle = '#ffffff';
                oCtx.beginPath();
                oCtx.arc(shaftDoc.x, shaftDoc.y, modR * 0.4, 0, Math.PI * 2);
                oCtx.fill();
              }

              oCtx.restore();
            }
          }

          // 7a. TEKST: ZAZNACZENIE I KURSOR
          if (activeTextSession && textLayoutRef.current) {
            const sess = activeTextSession;
            const lay = textLayoutRef.current;
            const inset = getTextInset(textSettings);
            const { anchor, focus } = textSelRef.current;
            const a = Math.min(anchor, focus);
            const b = Math.max(anchor, focus);

            oCtx.save();
            oCtx.translate(sess.center.x, sess.center.y);
            oCtx.rotate(sess.angle);
            oCtx.translate(-sess.width / 2 + inset, -sess.height / 2 + inset);

            if (b > a) {
              oCtx.fillStyle = 'rgba(0, 120, 215, 0.38)';
              for (const r of getSelectionRects(lay, a, b)) {
                oCtx.fillRect(r.x, r.y, r.w, r.h);
              }
            } else if (Math.floor(performance.now() / 530) % 2 === 0) {
              const c = getCaretInfo(lay, focus);
              oCtx.fillStyle = '#ffffff';
              oCtx.fillRect(c.x - 1.5 / zoom, c.top - 0.5 / zoom, 3 / zoom, c.height + 1 / zoom);
              oCtx.fillStyle = '#000000';
              oCtx.fillRect(c.x - 0.5 / zoom, c.top, 1 / zoom, c.height);
            }
            oCtx.restore();
          }

          // 7b. PODGLĄD LINII PROSTEJ SHIFT+KLIK DLA PĘDZLA I GUMKI
          if (
            (activeTool === 'brush' || activeTool === 'eraser') &&
            isShiftKeyDown &&
            !isQuickPipetteActive &&
            lastBrushStrokeDocPointRef.current &&
            lastDocPtRef.current &&
            !isDrawing
          ) {
            const p0 = lastBrushStrokeDocPointRef.current;
            const p1 = lastDocPtRef.current;
            oCtx.save();
            oCtx.setLineDash([4 / zoom, 4 / zoom]);
            oCtx.strokeStyle = activeTool === 'eraser' ? 'rgba(239, 68, 68, 0.85)' : 'rgba(59, 130, 246, 0.85)';
            oCtx.lineWidth = Math.max(1, Math.min(3, brushSettings.size / 6)) / zoom;
            oCtx.beginPath();
            oCtx.moveTo(p0.x, p0.y);
            oCtx.lineTo(p1.x, p1.y);
            oCtx.stroke();

            // Znacznik punktu początkowego (identyczny jak w narzędziu "linia" - puste kółko z podwójnym obrysem)
            oCtx.setLineDash([]);
            const r = 6 / zoom;
            // Zewnętrzny czarny obrys
            oCtx.strokeStyle = '#000000';
            oCtx.lineWidth = 2.5 / zoom;
            oCtx.beginPath();
            oCtx.arc(p0.x, p0.y, r, 0, Math.PI * 2);
            oCtx.stroke();
            // Wewnętrzny biały obrys
            oCtx.strokeStyle = '#ffffff';
            oCtx.lineWidth = 1.2 / zoom;
            oCtx.beginPath();
            oCtx.arc(p0.x, p0.y, r, 0, Math.PI * 2);
            oCtx.stroke();

            oCtx.restore();
          }

          // 8. INTERFEJS PRZEKSZTAŁCANIA ZAZNACZENIA / ZAWARTOŚCI NA ŻYWO (RAMKA, 8 UCHWYTÓW, PIVOT)
          const perspQuad = activeTool === 'transform-content' ? engine.getPerspectiveQuad() : null;
          if (perspQuad) {
            oCtx.save();
            oCtx.beginPath();
            oCtx.moveTo(perspQuad[0].x, perspQuad[0].y);
            for (let i = 1; i < 4; i++) oCtx.lineTo(perspQuad[i].x, perspQuad[i].y);
            oCtx.closePath();
            oCtx.lineWidth = 1.5 / zoom;
            oCtx.strokeStyle = '#ff9800';
            oCtx.stroke();
            oCtx.setLineDash([4 / zoom, 4 / zoom]);
            oCtx.lineWidth = 1 / zoom;
            oCtx.strokeStyle = '#ffffff';
            oCtx.stroke();
            oCtx.setLineDash([]);
            for (let i = 0; i < 4; i++) {
              const hov = transformHoverHandle === `p${i}` || transformActiveHandle === `p${i}`;
              oCtx.beginPath();
              oCtx.arc(perspQuad[i].x, perspQuad[i].y, 5.5 / zoom, 0, Math.PI * 2);
              oCtx.fillStyle = hov ? '#ffeb3b' : '#ffffff';
              oCtx.fill();
              oCtx.lineWidth = 2 / zoom;
              oCtx.strokeStyle = '#ff9800';
              oCtx.stroke();
            }
            oCtx.restore();
          } else if (isTransformTool && engine.selectionManager.transformState) {
            const st = engine.selectionManager.transformState;
            oCtx.save();

            // Przesunięcie i obrót do środka i kąta transformacji
            oCtx.translate(st.pos.x, st.pos.y);
            oCtx.rotate(st.angle);

            // Podwójna ramka obwiedni (Bounding box): niebieska + biała przerywana
            oCtx.lineWidth = 1.2 / zoom;
            oCtx.strokeStyle = '#007acc';
            oCtx.strokeRect(-st.width / 2, -st.height / 2, st.width, st.height);

            oCtx.lineWidth = 1 / zoom;
            oCtx.setLineDash([4 / zoom, 4 / zoom]);
            oCtx.strokeStyle = '#ffffff';
            oCtx.strokeRect(-st.width / 2, -st.height / 2, st.width, st.height);
            oCtx.setLineDash([]);

            // Uchwyt obrotu na górze (ramię + koło, identyczny jak dla figur)
            const rotStem = 22 / zoom;
            oCtx.strokeStyle = '#007acc';
            oCtx.lineWidth = 1.5 / zoom;
            oCtx.beginPath();
            oCtx.moveTo(0, -st.height / 2);
            oCtx.lineTo(0, -st.height / 2 - rotStem);
            oCtx.stroke();

            const isRotateHover = transformHoverHandle === 'rotate' || transformActiveHandle === 'rotate';
            oCtx.fillStyle = isRotateHover ? '#00e5ff' : '#ffffff';
            oCtx.strokeStyle = '#007acc';
            oCtx.lineWidth = 2 / zoom;
            oCtx.beginPath();
            oCtx.arc(0, -st.height / 2 - rotStem, 5.5 / zoom, 0, Math.PI * 2);
            oCtx.fill();
            oCtx.stroke();

            // 8 Uchwytów skalowania na krawędziach i narożnikach
            const handleSize = 8 / zoom;
            const localCoords: Record<string, { u: number; v: number }> = {
              nw: { u: -0.5, v: -0.5 },
              n: { u: 0, v: -0.5 },
              ne: { u: 0.5, v: -0.5 },
              e: { u: 0.5, v: 0 },
              se: { u: 0.5, v: 0.5 },
              s: { u: 0, v: 0.5 },
              sw: { u: -0.5, v: 0.5 },
              w: { u: -0.5, v: 0 },
            };

            for (const [key, lc] of Object.entries(localCoords)) {
              const hx = lc.u * st.width - handleSize / 2;
              const hy = lc.v * st.height - handleSize / 2;
              const isHover = transformHoverHandle === key || transformActiveHandle === key;

              oCtx.fillStyle = isHover ? '#00e5ff' : '#ffffff';
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 1.5 / zoom;
              oCtx.fillRect(hx, hy, handleSize, handleSize);
              oCtx.strokeRect(hx, hy, handleSize, handleSize);

              oCtx.strokeStyle = isHover ? '#007acc' : '#555555';
              oCtx.lineWidth = 1 / zoom;
              oCtx.strokeRect(hx, hy, handleSize, handleSize);
            }

            // Punkt obrotu / Pivot (celownik)
            const cos = Math.cos(st.angle);
            const sin = Math.sin(st.angle);
            const pdx = st.pivot.x - st.pos.x;
            const pdy = st.pivot.y - st.pos.y;
            const plx = pdx * cos + pdy * sin;
            const ply = -pdx * sin + pdy * cos;
            const isPivotHover = transformHoverHandle === 'pivot' || transformActiveHandle === 'pivot';
            const pr = 5 / zoom;

            oCtx.fillStyle = isPivotHover ? '#ffeb3b' : 'rgba(255, 255, 255, 0.9)';
            oCtx.strokeStyle = '#000000';
            oCtx.lineWidth = 1.5 / zoom;
            oCtx.beginPath();
            oCtx.arc(plx, ply, pr, 0, Math.PI * 2);
            oCtx.fill();
            oCtx.stroke();

            // Krzyżyk w środku pivotu
            oCtx.strokeStyle = '#007acc';
            oCtx.lineWidth = 1 / zoom;
            oCtx.beginPath();
            oCtx.moveTo(plx - pr - 2 / zoom, ply);
            oCtx.lineTo(plx + pr + 2 / zoom, ply);
            oCtx.moveTo(plx, ply - pr - 2 / zoom);
            oCtx.lineTo(plx, ply + pr + 2 / zoom);
            oCtx.stroke();

            oCtx.restore();
          }

          // 7c. WSKAŹNIK PUNKTU BAZOWEGO PIECZĄTKI (CLONE STAMP)
          if (activeTool === 'stamp' && (stampBasePointRef.current || externalStampBasePoint)) {
            const bp = stampBasePointRef.current || externalStampBasePoint!;
            let srcPos: SKPoint = { ...bp };
            const isDrawingStamp = isDrawing && engine.brushEngine.isStamp;

            if (isDrawingStamp) {
              if (stampSettings.sourceMode === 'selected' && stampStrokeStartPointRef.current && lastDocPtRef.current) {
                srcPos = {
                  x: bp.x + (lastDocPtRef.current.x - stampStrokeStartPointRef.current.x),
                  y: bp.y + (lastDocPtRef.current.y - stampStrokeStartPointRef.current.y),
                };
              } else if (stampSettings.sourceMode === 'relative' && stampRelativeOffsetRef.current && lastDocPtRef.current) {
                srcPos = {
                  x: lastDocPtRef.current.x - stampRelativeOffsetRef.current.x,
                  y: lastDocPtRef.current.y - stampRelativeOffsetRef.current.y,
                };
              }
            } else if (stampSettings.sourceMode === 'relative' && stampRelativeOffsetRef.current && lastDocPtRef.current) {
              srcPos = {
                x: lastDocPtRef.current.x - stampRelativeOffsetRef.current.x,
                y: lastDocPtRef.current.y - stampRelativeOffsetRef.current.y,
              };
            }

            const radius = Math.max(0.5, stampSettings.size / 2);
            oCtx.save();

            // 1. Zewnętrzny ciemny obrys
            oCtx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            oCtx.lineWidth = 2.5 / zoom;
            oCtx.beginPath();
            oCtx.arc(srcPos.x, srcPos.y, radius, 0, Math.PI * 2);
            oCtx.stroke();

            // 2. Wewnętrzny biały przerywany obrys
            oCtx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
            oCtx.lineWidth = 1.2 / zoom;
            oCtx.setLineDash([4 / zoom, 4 / zoom]);
            oCtx.beginPath();
            oCtx.arc(srcPos.x, srcPos.y, radius, 0, Math.PI * 2);
            oCtx.stroke();

            oCtx.restore();
          }

          oCtx.restore();

          // 9. KURSOR OKRĘGU I PLUSIKA DLA PĘDZLA, GUMKI, PĘDZLA KOREKCYJNEGO, DEFORMACJI, ZMIANY KOLORU I PIECZĄTKI (W PRZESTRZENI EKRANU)
          if (
            cursorPosRef.current &&
            (activeTool === 'brush' ||
              activeTool === 'eraser' ||
              activeTool === 'correction-brush' ||
              activeTool === 'deform' ||
              activeTool === 'color-replace' ||
              activeTool === 'stamp') &&
            !isQuickPipetteActive
          ) {
            const { x: cx, y: cy } = cursorPosRef.current;
            const currentSize =
              activeTool === 'stamp'
                ? stampSettings.size
                : activeTool === 'deform'
                ? deformSettings.size
                : activeTool === 'color-replace'
                ? colorReplaceSettings.size
                : activeTool === 'correction-brush'
                ? correctionBrushSettings.size
                : brushSettings.size;
            const brushRadiusScreen = (currentSize / 2) * zoom;
            oCtx.save();

            // Okrągły obrys pędzla
            if (brushRadiusScreen >= 1.5) {
              oCtx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
              oCtx.lineWidth = 2.5;
              oCtx.beginPath();
              oCtx.arc(cx, cy, brushRadiusScreen, 0, Math.PI * 2);
              oCtx.stroke();

              oCtx.strokeStyle = '#ffffff';
              oCtx.lineWidth = 1.2;
              oCtx.beginPath();
              oCtx.arc(cx, cy, brushRadiusScreen, 0, Math.PI * 2);
              oCtx.stroke();
            }

            // Standardowy, idealnie ostry czarny plusik 1px z białym obramowaniem 1px w centrum kursora
            const ix = Math.round(cx);
            const iy = Math.round(cy);
            const arm = 4; // długość ramienia w px (łączna rozpiętość 9px)

            // 1. Białe obramowanie 1px (podkład)
            oCtx.fillStyle = '#ffffff';
            oCtx.fillRect(ix - arm - 1, iy - 1, arm * 2 + 3, 3);
            oCtx.fillRect(ix - 1, iy - arm - 1, 3, arm * 2 + 3);

            // 2. Czarny plusik 1px w środku
            oCtx.fillStyle = '#000000';
            oCtx.fillRect(ix - arm, iy, arm * 2 + 1, 1);
            oCtx.fillRect(ix, iy - arm, 1, arm * 2 + 1);

            // Jeśli przytrzymujemy Ctrl w narzędziu pieczątki: dodaj obok małą kotwicę w czarno-białym kwadraciku
            if (activeTool === 'stamp' && isCtrlKeyDown) {
              const bx = ix + 9;
              const by = iy + 9;
              const bw = 13;
              const bh = 13;

              // Czarno-biały kwadracik (podkład biały z czarną ramką)
              oCtx.fillStyle = '#ffffff';
              oCtx.fillRect(bx, by, bw, bh);
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 1;
              oCtx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);

              // Mała czarna kotwica w środku
              oCtx.strokeStyle = '#000000';
              oCtx.fillStyle = '#000000';
              oCtx.lineWidth = 1;

              // 1. Górne kółko kotwicy
              const acx = bx + 6.5;
              oCtx.beginPath();
              oCtx.arc(acx, by + 3.5, 1.2, 0, Math.PI * 2);
              oCtx.stroke();

              // 2. Pionowy trzon
              oCtx.fillRect(bx + 6, by + 4, 1, 5);

              // 3. Pozioma belka
              oCtx.fillRect(bx + 4, by + 5, 5, 1);

              // 4. Dolny łuk kotwicy
              oCtx.beginPath();
              oCtx.arc(acx, by + 8, 3, 0.15 * Math.PI, 0.85 * Math.PI);
              oCtx.stroke();

              // 5. Zadzior / groty łuku
              oCtx.fillRect(bx + 3, by + 7.5, 1, 1);
              oCtx.fillRect(bx + 9, by + 7.5, 1, 1);
            }

            oCtx.restore();
          }

          // 9b. KURSOR I MODYFIKATOR DLA NARZĘDZI ZAZNACZANIA (W PRZESTRZENI EKRANU)
          const isSelectionTool =
            activeTool === 'select-rect' ||
            activeTool === 'select-ellipse' ||
            activeTool === 'select-lasso' ||
            activeTool === 'magic-wand';

          const isPlusTool =
            isSelectionTool ||
            activeTool === 'bucket' ||
            activeTool === 'gradient' ||
            activeTool === 'line' ||
            activeTool === 'bezier' ||
            activeTool === 'shapes' ||
            activeTool === 'text' ||
            activeTool === 'transform-selection' ||
            activeTool === 'transform-content';
          // plusik tylko wtedy, gdy systemowy kursor jest ukryty (przy uchwytach działają kursory zmiany rozmiaru itd.)
          if (cursorPosRef.current && isPlusTool && cursorStyleRef.current === 'none') {
            const { x: cx, y: cy } = cursorPosRef.current;
            oCtx.save();

            // Rysujemy identyczny plusik jak dla pędzla
            const ix = Math.round(cx);
            const iy = Math.round(cy);
            const arm = 4; // długość ramienia w px (rozpiętość 9px)

            // 1. Białe obramowanie 1px (podkład)
            oCtx.fillStyle = '#ffffff';
            oCtx.fillRect(ix - arm - 1, iy - 1, arm * 2 + 3, 3);
            oCtx.fillRect(ix - 1, iy - arm - 1, 3, arm * 2 + 3);

            // 2. Czarny plusik 1px w środku
            oCtx.fillStyle = '#000000';
            oCtx.fillRect(ix - arm, iy, arm * 2 + 1, 1);
            oCtx.fillRect(ix, iy - arm, 1, arm * 2 + 1);

            // 3. Rysujemy modyfikator obok plusika (+ / - / ∩ / X)
            const mode = selectionSettings.mode;
            let badge = '';
            if (!isSelectionTool) badge = '';
            else if (mode === 'add') badge = '+';
            else if (mode === 'subtract') badge = '-';
            else if (mode === 'intersect') badge = '∩';
            else if (mode === 'invert') badge = 'X';

            if (badge) {
              const bx = ix + 7;
              const by = iy + 4;
              const size = 9; // 9x9 pixels

              // 1. Biały kwadracik (podkład)
              oCtx.fillStyle = '#ffffff';
              oCtx.fillRect(bx, by, size, size);

              // 2. Czarna ramka 1px wokół kwadracika
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 1;
              oCtx.strokeRect(bx + 0.5, by + 0.5, size - 1, size - 1);

              // 3. Czarny pixel-art symbol wewnątrz kwadracika (absolutnie ostry, 0% rozmycia)
              oCtx.fillStyle = '#000000';

              if (badge === '+') {
                // Pionowa kreska: szerokość 1px, wysokość 5px
                oCtx.fillRect(bx + 4, by + 2, 1, 5);
                // Pozioma kreska: szerokość 5px, wysokość 1px
                oCtx.fillRect(bx + 2, by + 4, 5, 1);
              } else if (badge === '-') {
                // Pozioma kreska: szerokość 5px, wysokość 1px
                oCtx.fillRect(bx + 2, by + 4, 5, 1);
              } else if (badge === '∩') {
                // Kształt przecięcia (∩) o szerokości 5px i wysokości 5px
                oCtx.fillRect(bx + 2, by + 4, 1, 3); // Lewa nóżka
                oCtx.fillRect(bx + 6, by + 4, 1, 3); // Prawa nóżka
                oCtx.fillRect(bx + 3, by + 2, 3, 1); // Górna pozioma
                oCtx.fillRect(bx + 2, by + 3, 1, 1); // Łącznik lewy
                oCtx.fillRect(bx + 6, by + 3, 1, 1); // Łącznik praw
              } else if (badge === 'X') {
                // Kształt odwrócenia (X) o wielkości 5x5 px
                oCtx.fillRect(bx + 2, by + 2, 1, 1);
                oCtx.fillRect(bx + 6, by + 2, 1, 1);
                oCtx.fillRect(bx + 3, by + 3, 1, 1);
                oCtx.fillRect(bx + 5, by + 3, 1, 1);
                oCtx.fillRect(bx + 4, by + 4, 1, 1);
                oCtx.fillRect(bx + 3, by + 5, 1, 1);
                oCtx.fillRect(bx + 5, by + 5, 1, 1);
                oCtx.fillRect(bx + 2, by + 6, 1, 1);
                oCtx.fillRect(bx + 6, by + 6, 1, 1);
              }
            }

            oCtx.restore();
          }

          // 10. INTERAKTYWNA LUPA DLA PIPETY I SZYBKIEJ PIPETY (W PRZESTRZENI EKRANU)
          const isPipetteTool = activeTool === 'pipette' || isQuickPipetteActive;
          if (isPipetteTool && cursorPosRef.current) {
            const { x: cx, y: cy } = cursorPosRef.current;
            const showLoupe = pipetteSettings?.showLoupe ?? true;
            const docX = (cx - screenCenterX) / zoom + engine.width / 2;
            const docY = (cy - screenCenterY) / zoom + engine.height / 2;
            const isInside = docX >= 0 && docX < engine.width && docY >= 0 && docY < engine.height;

            if (showLoupe && isInside) {
              const sampleDiam = pipetteSettings?.sampleDiameter || 1;
              const sampleSrc = pipetteSettings?.sampleSource || 'image';
              const pickedColor = engine.pickColor(docX, docY, sampleSrc, sampleDiam);

              const loupeRadius = 48;
              const boxSize = 19;
              const loupeCanvas = engine.getLoupeSampleCanvas(docX, docY, boxSize, sampleSrc);

              oCtx.save();
              // Cień zewnętrzny lupy
              oCtx.shadowColor = 'rgba(0, 0, 0, 0.45)';
              oCtx.shadowBlur = 12;
              oCtx.shadowOffsetX = 0;
              oCtx.shadowOffsetY = 4;

              // Okrągły klip powiększenia
              oCtx.beginPath();
              oCtx.arc(cx, cy, loupeRadius, 0, Math.PI * 2);
              oCtx.fillStyle = '#1e1e1e';
              oCtx.fill();

              oCtx.save();
              oCtx.clip();

              // Rysujemy powiększony wycinek pikseli (pixelated)
              oCtx.imageSmoothingEnabled = false;
              oCtx.drawImage(
                loupeCanvas,
                cx - loupeRadius,
                cy - loupeRadius,
                loupeRadius * 2,
                loupeRadius * 2
              );

              // Siatka pikseli
              const pixelStep = (loupeRadius * 2) / boxSize;
              oCtx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
              oCtx.lineWidth = 0.5;
              for (let step = 0; step <= boxSize; step++) {
                const gx = cx - loupeRadius + step * pixelStep;
                const gy = cy - loupeRadius + step * pixelStep;
                oCtx.beginPath();
                oCtx.moveTo(gx, cy - loupeRadius);
                oCtx.lineTo(gx, cy + loupeRadius);
                oCtx.stroke();
                oCtx.beginPath();
                oCtx.moveTo(cx - loupeRadius, gy);
                oCtx.lineTo(cx + loupeRadius, gy);
                oCtx.stroke();
              }

              // Dolny wąski panel z próbnikiem koloru i wartością HEX (przesunięty niżej)
              const h = loupeRadius * 0.48; // Linia podziału na wysokości 48% promienia poniżej środka
              const startAngle = Math.asin(h / loupeRadius);
              const endAngle = Math.PI - startAngle;

              oCtx.beginPath();
              oCtx.arc(cx, cy, loupeRadius, startAngle, endAngle, false);
              oCtx.closePath();
              oCtx.fillStyle = `rgba(${pickedColor.r}, ${pickedColor.g}, ${pickedColor.b}, ${pickedColor.a / 255})`;
              oCtx.fill();
              oCtx.strokeStyle = '#ffffff';
              oCtx.lineWidth = 1.5;
              oCtx.stroke();

              const hex = `#${((1 << 24) + (pickedColor.r << 16) + (pickedColor.g << 8) + pickedColor.b).toString(16).slice(1).toUpperCase()}`;
              oCtx.font = 'bold 9px monospace';
              oCtx.textAlign = 'center';
              oCtx.textBaseline = 'middle';
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 2.5;

              // Precyzyjne centrowanie tekstu wewnątrz wąskiego dolnego segmentu
              const textY = cy + (loupeRadius + h) / 2;
              oCtx.strokeText(hex, cx, textY);
              oCtx.fillStyle = '#ffffff';
              oCtx.fillText(hex, cx, textY);

              oCtx.restore(); // koniec clip

              // Zewnętrzny podwójny pierścień obwódki lupy
              oCtx.shadowColor = 'transparent';
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 3;
              oCtx.beginPath();
              oCtx.arc(cx, cy, loupeRadius, 0, Math.PI * 2);
              oCtx.stroke();

              oCtx.strokeStyle = '#ffffff';
              oCtx.lineWidth = 1.5;
              oCtx.beginPath();
              oCtx.arc(cx, cy, loupeRadius, 0, Math.PI * 2);
              oCtx.stroke();

              // Idealnie ostry celownik środkowy wewnątrz lupy (dopasowany do siatki pikseli za pomocą fillRect)
              const ix = Math.round(cx);
              const iy = Math.round(cy);
              const pArm = 5;

              // 1. Białe obramowanie 1px (podkład pod spodem)
              oCtx.fillStyle = '#ffffff';
              oCtx.fillRect(ix - pArm - 1, iy - 1, pArm * 2 + 3, 3);
              oCtx.fillRect(ix - 1, iy - pArm - 1, 3, pArm * 2 + 3);

              // 2. Czarny plusik 1px w środku
              oCtx.fillStyle = '#000000';
              oCtx.fillRect(ix - pArm, iy, pArm * 2 + 1, 1);
              oCtx.fillRect(ix, iy - pArm, 1, pArm * 2 + 1);

              oCtx.restore();
            } else {
              // Standalone ostry celownik gdy lupa jest wyłączona lub poza płótnem
              oCtx.save();
              const ix = Math.round(cx);
              const iy = Math.round(cy);
              const pArm = 5;

              // 1. Białe obramowanie 1px
              oCtx.fillStyle = '#ffffff';
              oCtx.fillRect(ix - pArm - 1, iy - 1, pArm * 2 + 3, 3);
              oCtx.fillRect(ix - 1, iy - pArm - 1, 3, pArm * 2 + 3);

              // 2. Czarny plusik 1px w środku
              oCtx.fillStyle = '#000000';
              oCtx.fillRect(ix - pArm, iy, pArm * 2 + 1, 1);
              oCtx.fillRect(ix, iy - pArm, 1, pArm * 2 + 1);

              oCtx.restore();
            }
          }
        }
      }

      animId = requestAnimationFrame(renderOverlay);
    };

    animId = requestAnimationFrame(renderOverlay);
    return () => cancelAnimationFrame(animId);
  }, [
    engine,
    zoom,
    panOffset,
    isDrawing,
    dragStartPoint,
    currentDragPoint,
    lassoPoints,
    activeTool,
    isTransformTool,
    selectionSettings,
    pipetteSettings,
    brushSettings.size,
    correctionBrushSettings.size,
    deformSettings.size,
    colorReplaceSettings.size,
    stampSettings.size,
    externalStampBasePoint,
    stampSettings.sourceMode,
    gradientSettings,
    primaryColor,
    secondaryColor,
    activeVectorLineSession,
    activeVectorBezierSession,
    activeVectorShapeSession,
    activeTextSession,
    textSel,
    textVersion,
    textSettings,
    hoverVectorHandle,
    vectorShapeSettings,
    getShapeModifierDocPoint,
    gradientHoverHandle,
    transformHoverHandle,
    transformActiveHandle,
    isShiftKeyDown,
    isCtrlKeyDown,
    isQuickPipetteActive,
  ]);

  // ZOOM I PAN
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - rect.width / 2;
    const mouseY = e.clientY - rect.top - rect.height / 2;

    const docX = (mouseX - panOffset.x) / zoom;
    const docY = (mouseY - panOffset.y) / zoom;

    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const newZoom = Math.max(0.05, Math.min(25.0, Number((zoom * zoomFactor).toFixed(3))));

    const newPanX = mouseX - docX * newZoom;
    const newPanY = mouseY - docY * newZoom;

    onUpdateZoom(newZoom);
    onUpdatePan({ x: newPanX, y: newPanY });
  };

  const getModifiedSelectionSettings = (e: React.PointerEvent) => {
    const isSelectionTool =
      activeTool === 'select-rect' ||
      activeTool === 'select-ellipse' ||
      activeTool === 'select-lasso' ||
      activeTool === 'magic-wand';

    if (!isSelectionTool) return selectionSettings;

    const ctrlKey = e.ctrlKey || e.metaKey;
    const altKey = e.altKey;

    let mode = selectionSettings.mode;
    if (ctrlKey && altKey) {
      mode = 'intersect';
    } else if (altKey) {
      mode = 'subtract';
    } else if (ctrlKey) {
      mode = 'add';
    }

    return {
      ...selectionSettings,
      mode,
    };
  };

  // POINTER DOWN
  const enterLiveOverSession = () => {
    const cv = canvasRef.current;
    if (!cv || liveOverSessionRef.current) return;
    liveOverSessionRef.current = true;
    tileSessionRef.current = false;
    tilePresentingRef.current = false;
    tileWasSessionRef.current = false;
    tileRendererRef.current?.clear();
    cv.style.visibility = '';
    // podkład nie zna jeszcze bieżących ustawień edytowanych efektów: pełne złożenie z nimi
    engine.compositeToViewport(cv, null);
    baseSigRef.current = engine.getBaseSignature();
  };

  /** Otwiera obiekt warstwy wektorowej do edycji: ustawienia paska opcji i sesja odpowiedniego rodzaju. */
  const openVectorObject = (o: VectorObject) => {
    switch (o.kind) {
      case 'line':
        onChangeLineAndCurveSettings?.(o.settings);
        setActiveVectorLineSession({ p0: { ...o.p0 }, p1: { ...o.p1 } });
        break;
      case 'path':
        onChangeLineAndCurveSettings?.(o.settings);
        penFreehandSessionRef.current = !!o.freehand;
        setPen({ nodes: cloneNodes(o.nodes), closed: o.closed, phase: 'editing', selected: 0 });
        break;
      case 'shape':
        onChangeVectorShapeSettings?.(o.settings);
        setActiveVectorShapeSession({
          center: { ...o.center },
          width: o.width,
          height: o.height,
          angle: o.angle,
          pivot: { ...o.center },
          flipX: o.flipX,
          flipY: o.flipY,
        });
        break;
      case 'text': {
        resetTextModel();
        textOpenedExistingRef.current = true;
        textRtRef.current = vectorRichText(o);
        textPendingStyleRef.current = { ...o.fallback };
        onSyncTextSettings?.(o.settings);
        setActiveTextSession({
          center: { ...o.center },
          width: o.width,
          height: o.height,
          angle: o.angle,
          pivot: { ...o.center },
          flipX: false,
          flipY: false,
          autoHeight: o.autoHeight,
        });
        const n = textRtRef.current.length;
        setTextSelection(n, n);
        bumpText();
        break;
      }
    }
    onCanvasModified();
  };

  /** Czy kliknięcie trafia w uchwyty lub ramkę otwartej sesji wektorowej (wtedy obsługuje je zwykła logika narzędzia). */
  const vectorSessionHit = (e: React.PointerEvent, pt: SKPoint): boolean => {
    const bs = penRef.current;
    if (bs) {
      const ms = penScreenPos(e);
      return !!hitTestPen(bs, ms.x, ms.y, pt);
    }
    return !!hitTestVectorHandles(e);
  };

  const lastEditRequestRef = useRef<number>(vectorEditRequest?.n ?? 0);
  useEffect(() => {
    if (!vectorEditRequest || vectorEditRequest.n === lastEditRequestRef.current) return;
    lastEditRequestRef.current = vectorEditRequest.n;
    if (isAnyVectorSessionActive) commitActiveVectorSession();
    const loaded = engine.vec.beginEdit(vectorEditRequest.layerIndex, vectorEditRequest.id);
    if (loaded) openVectorObject(loaded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vectorEditRequest]);

  /** Powiadamia panel warstw o zmianie zaznaczenia obiektów wektorowych. */
  const notifyVecSelection = () => {
    onVectorSelectionChange?.();
    onCanvasModified();
  };

  /** Zaznaczenie obiektów warstwy wektorowej z płótna (bez sesji edycji): ramka zbiorcza. */
  const selectVectorObjects = (layer: Layer, ids: string[]) => {
    engine.vec.setSelection(layer.id, ids);
    notifyVecSelection();
  };

  /** Usuwa zaznaczone obiekty (klawisz Delete): także obiekt otwarty do edycji (linia / kształt). */
  const deleteSelectedVectorObjects = (): boolean => {
    const layer = engine.getActiveLayer();
    if (!layer || !layer.isVector || activeToolProp !== 'vector-select') return false;
    const ids = engine.vec.selectedIds(layer);
    if (ids.length === 0) return false;
    if (isAnyVectorSessionActive) {
      // w sesji tekstu i krzywej Delete należy do edycji (znaki, węzły)
      if (activeTextSession || activeVectorBezierSession) return false;
      cancelActiveVectorSession();
    }
    engine.vec.deleteObjects(engine.layers.indexOf(layer), ids);
    notifyVecSelection();
    return true;
  };

  // klawiatura działa na domknięciu z efektu: funkcje zależne od bieżącego stanu wołamy przez ref
  const deleteVecRef = useRef<() => boolean>(() => false);
  deleteVecRef.current = deleteSelectedVectorObjects;
  const notifyVecRef = useRef<() => void>(() => {});
  notifyVecRef.current = notifyVecSelection;

  /** Manipulacja (wybór i edycja obiektu) i Pisak (rysowanie odręczne). Zwraca true, gdy zdarzenie obsłużone. */
  const vectorToolPointerDown = (e: React.PointerEvent, pt: SKPoint): boolean => {
    const layer = engine.getActiveLayer();
    if (!layer || !layer.isVector) return true;
    if (isAnyVectorSessionActive && vectorSessionHit(e, pt)) return false;
    if (activeToolProp === 'vector-select') {
      const mod = e.shiftKey || e.ctrlKey || e.metaKey;
      const idx = engine.layers.indexOf(layer);
      if (isAnyVectorSessionActive) commitActiveVectorSession();
      const o = engine.vec.hitTest(layer, pt, 6 / Math.max(zoom, 0.05));
      const sel = engine.vec.selectedIds(layer);
      if (mod) {
        // Shift / Ctrl: dodaje obiekt do zaznaczenia albo go z niego zdejmuje; puste miejsce zaczyna zaznaczanie obszarem (dodawanie)
        if (o) {
          selectVectorObjects(layer, sel.includes(o.id) ? sel.filter((x) => x !== o.id) : [...sel, o.id]);
        } else {
          vecMarqueeRef.current = { start: pt, cur: pt, base: sel };
        }
        return true;
      }
      if (o) {
        if (sel.length > 1 && sel.includes(o.id)) {
          if (engine.vec.beginGroupMove(idx, sel)) vecGroupDragRef.current = { start: pt };
          return true;
        }
        const loaded = engine.vec.beginEdit(idx, o.id);
        if (loaded) openVectorObject(loaded);
        notifyVecSelection();
        return true;
      }
      const box = sel.length > 0 ? engine.vec.selectionTightBounds(layer) : null;
      if (box && sel.length > 1 && pt.x >= box.x0 && pt.x <= box.x1 && pt.y >= box.y0 && pt.y <= box.y1) {
        if (engine.vec.beginGroupMove(idx, sel)) vecGroupDragRef.current = { start: pt };
        return true;
      }
      // puste miejsce: zaznaczanie obszarem (nowe zaznaczenie zastępuje stare)
      if (sel.length > 0) {
        engine.vec.clearSelection();
        notifyVecSelection();
      }
      vecMarqueeRef.current = { start: pt, cur: pt, base: [] };
      return true;
    }
    // Pisak: zatwierdź poprzednią krzywą i zacznij rysować odręcznie
    if (isAnyVectorSessionActive) commitActiveVectorSession();
    freehandRef.current = { pts: [pt] };
    return true;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || isSpacePressed || activeTool === 'pan') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
      return;
    }

    // Narzędzia inne niż różdżka i wiadro czytają zaznaczenie i warstwy, więc najpierw dokończ liczenie w tle
    if (activeTool !== 'magic-wand' && activeTool !== 'bucket') engine.flushPendingFill();

    const isQuickPipette = (e.ctrlKey || e.metaKey || isCtrlKeyDown) && isDrawingTool(activeTool) && activeTool !== 'stamp';
    const isRightButtonAllowed =
      e.button === 2 &&
      (activeTool === 'correction-brush' ||
        activeTool === 'deform' ||
        activeTool === 'brush' ||
        activeTool === 'bucket' ||
        activeTool === 'gradient' ||
        activeTool === 'pipette' ||
        activeTool === 'zoom' ||
        (activeTool === 'bezier' && !!penRef.current) ||
        isQuickPipette);

    if (e.button !== 0 && !isRightButtonAllowed) return;

    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      cursorPosRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }

    const pt = getDocPoint(e);
    if (!pt) return;
    lastDocPtRef.current = pt;

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    if (activeTool === 'zoom') {
      zoomButtonRef.current = e.button;
      setDragStartPointSynced(pt);
      setCurrentDragPoint(pt);
      setIsDrawingSynced(true);
      return;
    }

    // SZYBKA PIPETA (Ctrl + Klik / Przeciąganie we wszystkich narzędziach rysowania) lub narzędzie pipety
    if (activeTool === 'pipette' || isQuickPipette) {
      isSamplingPipetteRef.current = true;
      const isSecondary = e.button === 2;
      pipetteIsSecondaryRef.current = isSecondary;
      setIsDrawingSynced(true);
      const color = engine.pickColor(
        pt.x,
        pt.y,
        pipetteSettings?.sampleSource || 'image',
        pipetteSettings?.sampleDiameter || 1
      );
      onPipettePick(color, isSecondary);
      return;
    }

    // PIECZĄTKA: Ctrl+Klik ustala punkt bazowy (próbkowany)
    if (activeTool === 'stamp') {
      if (e.ctrlKey || e.metaKey || isCtrlKeyDown) {
        const basePt = { x: pt.x, y: pt.y };
        stampBasePointRef.current = basePt;
        stampRelativeOffsetRef.current = null;
        onSetStampBasePoint?.(basePt);
        redraw();
        return;
      }

      if (!stampBasePointRef.current) {
        onShowToast?.('Przytrzymaj Ctrl i kliknij na płótnie, aby wybrać punkt bazowy.');
        return;
      }
    }

    // SPRAWDZENIE CZY WARSTWA JEST ZABLOKOWANA DLA NARZĘDZI EDYCYJNYCH
    const activeLayer = engine.getActiveLayer();
    if (activeLayer?.locked) {
      if (isDrawingTool(activeTool) || activeToolProp === 'pen' || activeToolProp === 'vector-select' || activeTool === 'transform-content') {
        onShowToast?.('Warstwa jest zablokowana');
        return;
      }
    }

    // MANIPULACJA / PISAK na warstwie wektorowej
    if ((activeToolProp === 'vector-select' || activeToolProp === 'pen') && vectorToolPointerDown(e, pt)) return;

    // KRZYWA WIELOWĘZŁOWA
    if (activeTool === 'bezier') {
      penPointerDown(e, pt);
      return;
    }

    // OBSŁUGA NARZĘDZI TRANSFORMACJI ZAZNACZENIA / ZAWARTOŚCI
    if (isTransformTool) {
      if (activeTool === 'transform-content' && !engine.transformContentSession) {
        engine.beginTransformContent(selectionSettings.interpolation || 'bilinear');
      } else if (
        activeTool === 'transform-selection' &&
        !engine.selectionManager.transformState &&
        engine.selectionManager.hasActiveSelection
      ) {
        engine.selectionManager.beginTransformSelection();
      }

      const hit = hitTestTransformHandles(e);
      if (hit && engine.selectionManager.transformState) {
        setTransformActiveHandleSynced(hit);
        lastTransformPtRef.current = pt;
        transformDownScreenRef.current = { x: e.clientX, y: e.clientY };
        transformMovedRef.current = false;
        const pq = engine.getPerspectiveQuad();
        perspInitQuadRef.current = pq ? (pq.map((p) => ({ x: p.x, y: p.y })) as Quad) : null;
        transformDragStartDocPtRef.current = pt;
        transformInitialStateRef.current = {
          ...engine.selectionManager.transformState,
          pos: { ...engine.selectionManager.transformState.pos },
          pivot: { ...engine.selectionManager.transformState.pivot },
          initialCenter: { ...engine.selectionManager.transformState.initialCenter },
        };
        transformInitialHistorySnapshotRef.current = engine.selectionManager.getMaskSnapshot();
        return;
      }
      return;
    }

    // OBSŁUGA AKTYWNYCH UCHWYTÓW WEKTOROWYCH (LINIA, BEZIER, FIGURA)
    const vecHit = hitTestVectorHandles(e);
    if (vecHit === 'text-body') {
      // Klik we wnętrzu ramki tekstu: kursor, zaznaczanie przeciąganiem, dwuklik = słowo, trzy kliknięcia = akapit
      const idx = textIndexAtDocPoint(pt);
      const now = performance.now();
      const lc = textLastClickRef.current;
      const near = Math.hypot(e.clientX - lc.x, e.clientY - lc.y) < 5;
      const count = now - lc.t < 450 && near ? lc.count + 1 : 1;
      textLastClickRef.current = { t: now, x: e.clientX, y: e.clientY, count };
      const plain = textRtRef.current.plainText;
      textDesiredXRef.current = null;
      if (count === 2) {
        const [ws, we] = wordBoundsAt(plain, idx);
        setTextSelection(ws, we);
        textDragRef.current = { anchor: ws };
      } else if (count >= 3) {
        const ps = plain.lastIndexOf('\n', Math.max(0, idx - 1)) + 1;
        let pe = plain.indexOf('\n', idx);
        if (pe === -1) pe = plain.length;
        setTextSelection(idx > 0 && plain[idx - 1] === '\n' ? idx : ps, pe);
        textDragRef.current = null;
      } else if (e.shiftKey) {
        setTextSelection(textSelRef.current.anchor, idx);
        textDragRef.current = { anchor: textSelRef.current.anchor };
      } else {
        setTextSelection(idx, idx);
        textDragRef.current = { anchor: idx };
      }
      focusTextInput();
      return;
    }
    if (vecHit) {
      setActiveVectorHandleSynced(vecHit);
      vectorDragStartPtRef.current = pt;
      if (activeVectorLineSession) {
        vectorInitialSessionStateRef.current = { ...activeVectorLineSession };
      } else if (activeVectorShapeSession) {
        vectorInitialSessionStateRef.current = {
          ...activeVectorShapeSession,
          settings: { ...vectorShapeSettings },
        };
      } else if (activeTextSession) {
        vectorInitialSessionStateRef.current = { ...activeTextSession };
      }
      focusTextInput();
      return;
    }

    // JEŚLI KLIKNIĘTO POZA ISTNIEJĄCĄ SESJĄ WEKTOROWĄ LUB TRANSFORMACJĄ, ZATWIERDŹ POPRZEDNIĄ
    if (
      activeTool === 'select-rect' ||
      activeTool === 'select-ellipse' ||
      activeTool === 'select-lasso'
    ) {
      if (activeVectorLineSession || activeVectorBezierSession || activeVectorShapeSession) {
        commitActiveVectorSession();
      }
      if (engine.transformContentSession) {
        engine.commitTransformContent();
        onCanvasModified();
      } else if (engine.selectionManager.transformState) {
        engine.selectionManager.commitTransformSelection();
        onCanvasModified();
      } else if (engine.bucketSeedPoint) {
        engine.commitPaintBucketSession();
        onCanvasModified();
      } else if (engine.gradientStartPoint) {
        engine.commitGradientSession();
        onCanvasModified();
      }
    }

    if (activeTool === 'line' || activeTool === 'shapes' || activeTool === 'text') {
      if (activeVectorLineSession || activeVectorBezierSession || activeVectorShapeSession || activeTextSession) {
        commitActiveVectorSession();
      }
      const p = { x: Math.round(pt.x), y: Math.round(pt.y) };
      setDragStartPointSynced(p);
      setCurrentDragPoint(p);
      setIsDrawingSynced(true);
      return;
    }

    const layer = engine.getActiveLayer();
    if (!layer || !layer.visible) return;

    if (activeTool === 'magic-wand') {
      const sp = engine.selectionManager.wandSeedPoint;
      if (sp && Math.hypot(pt.x - sp.x, pt.y - sp.y) * zoom <= 16) {
        engine.flushPendingFill();
        wandDragInitialSnapshotRef.current = engine.selectionManager.getMaskSnapshot();
        setIsDraggingWandHandle(true);
        return;
      }
      engine.applyMagicWand(pt, getModifiedSelectionSettings(e));
      onCanvasModified();
      return;
    }

    if (activeTool === 'select-rect' || activeTool === 'select-ellipse') {
      engine.selectionManager.wandSeedPoint = null;
      setDragStartPointSynced(pt);
      setCurrentDragPoint(pt);
      setIsDrawingSynced(true);
      return;
    }

    if (activeTool === 'select-lasso') {
      engine.selectionManager.wandSeedPoint = null;
      if (selectionSettings.lassoMode === 'polygon') {
        const ms = penScreenPos(e);
        if (lassoMultiRef.current) {
          const pts = lassoPointsRef.current;
          // kliknięcie w pierwszy punkt zamyka i zatwierdza
          if (pts.length >= 3 && Math.hypot(pt.x - pts[0].x, pt.y - pts[0].y) * zoom <= 8) {
            lassoPressRef.current = null;
            lassoApiRef.current.finish(e.ctrlKey || e.metaKey, e.altKey);
            return;
          }
          lassoPressRef.current = { screen: ms, moved: false, first: false };
          return;
        }
        setDragStartPointSynced(pt);
        setCurrentDragPoint(pt);
        setLassoPts([pt]);
        lassoMultiRef.current = true;
        setLassoMultiActive(true);
        lassoPressRef.current = { screen: ms, moved: false, first: true };
        setIsDrawingSynced(true);
        return;
      }
      setDragStartPointSynced(pt);
      setCurrentDragPoint(pt);
      setLassoPts([pt]);
      setIsDrawingSynced(true);
      return;
    }

    if (activeTool === 'bucket') {
      const sp = engine.bucketSeedPoint;
      if (sp && Math.hypot(pt.x - sp.x, pt.y - sp.y) * zoom <= 16) {
        setIsDraggingBucketHandle(true);
        return;
      }
      const isRight = e.button === 2;
      const colorSrc = isRight ? 'secondary' : 'primary';
      const col = isRight ? secondaryColor : primaryColor;
      engine.applyPaintBucket(pt, selectionSettings, { ...brushSettings, color: col }, true, colorSrc);
      engine.bucketColorSource = colorSrc;
      onCanvasModified();
      return;
    }

    if (activeTool === 'gradient') {
      const p0 = engine.gradientStartPoint;
      const p1 = engine.gradientEndPoint;
      if (p0 && Math.hypot(pt.x - p0.x, pt.y - p0.y) * zoom <= 14) {
        setIsDraggingGradientHandle(0);
        return;
      }
      if (p1 && Math.hypot(pt.x - p1.x, pt.y - p1.y) * zoom <= 14) {
        setIsDraggingGradientHandle(1);
        return;
      }
      if (p0 && p1) {
        const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
        if (Math.hypot(pt.x - mid.x, pt.y - mid.y) * zoom <= 14) {
          setIsDraggingGradientHandle('move');
          dragStartPointRef.current = pt;
          gradientDragInitialStartPtRef.current = { ...p0 };
          gradientDragInitialEndPtRef.current = { ...p1 };
          return;
        }
      }

      // Jeśli kliknięto poza istniejącymi uchwytami, zatwierdź poprzednią sesję gradientu
      if (engine.gradientStartPoint) {
        engine.commitGradientSession();
      }

      const isRight = e.button === 2;
      const colorSrc: 'primary' | 'secondary' = isRight ? 'secondary' : 'primary';
      engine.gradientColorSource = colorSrc;

      setDragStartPointSynced(pt);
      setCurrentDragPoint(pt);
      setIsDrawingSynced(true);
      return;
    }

    if (
      engine.hasCorrectionSession &&
      (activeTool === 'brush' || activeTool === 'eraser' || activeTool === 'correction-brush' || activeTool === 'deform' || activeTool === 'color-replace' || activeTool === 'stamp')
    ) {
      enterLiveOverSession();
    }

    if (activeTool === 'brush' || activeTool === 'eraser') {
      setIsDrawingSynced(true);
      const isEraser = activeTool === 'eraser';
      const isMaskMode = !!engine.maskView || !!(layer.editMask && layer.maskGrid) || layer.grayView;
      const effectiveIsEraser = isEraser && !isMaskMode;
      const isSecondary = !isEraser && e.button === 2;
      brushIsSecondaryRef.current = isSecondary;

      const baseColor = isEraser && isMaskMode
        ? { r: 0, g: 0, b: 0, a: brushSettings.color.a }
        : isSecondary
          ? secondaryColor
          : brushSettings.color;

      const effectiveColor = isMaskMode
        ? {
            r: Math.round(0.299 * baseColor.r + 0.587 * baseColor.g + 0.114 * baseColor.b),
            g: Math.round(0.299 * baseColor.r + 0.587 * baseColor.g + 0.114 * baseColor.b),
            b: Math.round(0.299 * baseColor.r + 0.587 * baseColor.g + 0.114 * baseColor.b),
            a: baseColor.a,
          }
        : baseColor;

      const currentBrushSettings: BrushSettings = {
        ...brushSettings,
        blendMode: isEraser && isMaskMode ? 'SrcOver' : brushSettings.blendMode,
        color: effectiveColor,
      };

      if (e.shiftKey && lastBrushStrokeDocPointRef.current) {
        const fromPt = lastBrushStrokeDocPointRef.current;
        const toPt = pt;
        const strokeResult1 = engine.brushEngine.beginStroke(fromPt, layer, currentBrushSettings, effectiveIsEraser);
        const strokeResult2 = engine.brushEngine.continueStroke(toPt, layer, currentBrushSettings, effectiveIsEraser);

        const left = Math.min(strokeResult1.dirtyRect.left, strokeResult2.dirtyRect.left);
        const top = Math.min(strokeResult1.dirtyRect.top, strokeResult2.dirtyRect.top);
        const right = Math.max(strokeResult1.dirtyRect.right, strokeResult2.dirtyRect.right);
        const bottom = Math.max(strokeResult1.dirtyRect.bottom, strokeResult2.dirtyRect.bottom);
        const combinedDirty: SKRectI = {
          left,
          top,
          right,
          bottom,
          width: Math.max(0, right - left),
          height: Math.max(0, bottom - top),
        };

        if (canvasRef.current && combinedDirty.width > 0) {
          engine.compositeToViewport(canvasRef.current, combinedDirty);
        }
        lastBrushStrokeDocPointRef.current = { ...toPt };
      } else {
        const strokeResult = engine.brushEngine.beginStroke(pt, layer, currentBrushSettings, effectiveIsEraser);

        if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
          engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
        }
        lastBrushStrokeDocPointRef.current = { ...pt };
      }
    }

    if (activeTool === 'correction-brush') {
      setIsDrawingSynced(true);
      activeCorrectionButtonRef.current = e.button;
      const subAction = getCorrectionSubAction(e.button);
      const intensity = primaryColor.a;
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      const strokeResult = engine.brushEngine.beginCorrectionStroke(
        pt,
        layer,
        correctionBrushSettings,
        subAction,
        intensity,
        mask
      );

      if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
        engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
      }
      lastBrushStrokeDocPointRef.current = { ...pt };
    }

    if (activeTool === 'deform') {
      setIsDrawingSynced(true);
      activeCorrectionButtonRef.current = e.button;
      const subAction = getDeformSubAction(e.button);
      const intensity = primaryColor.a;
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      const strokeResult = engine.brushEngine.beginDeformStroke(
        pt,
        layer,
        deformSettings,
        subAction,
        intensity,
        mask
      );

      if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
        engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
      }
      lastBrushStrokeDocPointRef.current = { ...pt };
    }

    if (activeTool === 'color-replace') {
      setIsDrawingSynced(true);
      let targetColor: SKColor;
      if (colorReplaceSettings.mode === 'secondary') {
        targetColor = secondaryColor || { r: 255, g: 255, b: 255, a: 255 };
      } else {
        const sampled = engine.pickColor(pt.x, pt.y, 'layer', 1);
        if (sampled.a === 0) {
          const imgSample = engine.pickColor(pt.x, pt.y, 'image', 1);
          targetColor = imgSample.a > 0 ? imgSample : sampled;
        } else {
          targetColor = sampled;
        }
      }
      colorReplaceTargetColorRef.current = targetColor;

      const repColor = primaryColor || { r: 255, g: 0, b: 0, a: 255 };
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      const strokeResult = engine.brushEngine.beginColorReplaceStroke(
        pt,
        layer,
        colorReplaceSettings,
        targetColor,
        repColor,
        mask
      );

      if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
        engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
      }
      lastBrushStrokeDocPointRef.current = { ...pt };
    }

    if (activeTool === 'stamp' && stampBasePointRef.current) {
      setIsDrawingSynced(true);
      const alpha = (primaryColor.a ?? 255) / 255;
      stampStrokeStartPointRef.current = { ...pt };

      if (stampSettings.sourceMode === 'relative' && !stampRelativeOffsetRef.current) {
        stampRelativeOffsetRef.current = {
          x: pt.x - stampBasePointRef.current.x,
          y: pt.y - stampBasePointRef.current.y,
        };
      }

      const strokeResult = engine.brushEngine.beginStampStroke(
        pt,
        layer,
        engine,
        stampSettings,
        alpha,
        stampBasePointRef.current,
        stampRelativeOffsetRef.current
      );

      if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
        engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
      }
      lastBrushStrokeDocPointRef.current = { ...pt };
    }
  };

  // POINTER MOVE
  const handlePointerMove = (e: React.PointerEvent) => {
    {
      const d0 = transformDownScreenRef.current;
      if (d0 && !transformMovedRef.current && Math.hypot(e.clientX - d0.x, e.clientY - d0.y) >= 4) transformMovedRef.current = true;
    }
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      cursorPosRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }

    const pt = getDocPoint(e);
    lastDocPtRef.current = pt;
    updateStatusBarPos(pt);

    if (isPanning) {
      onUpdatePan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
      return;
    }

    // MANIPULACJA: przeciąganie zaznaczonych obiektów i zaznaczanie obszarem
    if (vecGroupDragRef.current && pt) {
      const g = vecGroupDragRef.current;
      engine.vec.groupMoveTo(pt.x - g.start.x, pt.y - g.start.y);
      onCanvasModified();
      return;
    }
    if (vecMarqueeRef.current && pt) {
      vecMarqueeRef.current.cur = pt;
      return;
    }

    // PISAK: dopasowanie krzywej do rysowanej ścieżki na żywo
    if (freehandRef.current && pt) {
      const f = freehandRef.current;
      const last = f.pts[f.pts.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) * zoom >= 2) {
        f.pts.push(pt);
        const nodes = fitFreehand(f.pts, Math.max(1.2, 2.5 / zoom));
        if (nodes.length >= 2) {
          penFreehandSessionRef.current = true;
          setPen({ nodes, closed: false, phase: 'editing', selected: -1 });
        }
      }
      return;
    }

    if (penPointerMove(e, pt)) return;

    // INTERAKCJA PRZEKSZTAŁCANIA ZAZNACZENIA
    if (isTransformTool) {
      if (
        transformActiveHandle &&
        transformInitialStateRef.current &&
        transformDragStartDocPtRef.current &&
        pt
      ) {
        lastTransformPtRef.current = pt;
        updateTransformInteraction(pt, e.shiftKey, e.altKey);
        return;
      }
      const hoverHit = hitTestTransformHandles(e);
      setTransformHoverHandle(hoverHit);
      return;
    }

    // ZAZNACZANIE TEKSTU PRZECIĄGANIEM
    if (textDragRef.current && pt && activeTextSession) {
      setTextSelection(textDragRef.current.anchor, textIndexAtDocPoint(pt));
      textDesiredXRef.current = null;
      return;
    }

    // INTERAKCJA PRZECIĄGANIA UCHWYTU WEKTOROWEGO
    if (activeVectorHandle && pt) {
      updateVectorHandleInteraction(pt, e.shiftKey, e.altKey);
      return;
    }

    // Aktualizacja podświetlenia uchwytów
    if (isAnyVectorSessionActive) {
      const hover = hitTestVectorHandles(e);
      setHoverVectorHandle(hover);
    }

    // PIERWOTNE ROZCIĄGANIE NOWEJ FIGURY / LINII / KRZYWEJ
    if (isDrawing && pt && dragStartPoint) {
      if (activeTool === 'line' || activeTool === 'bezier' || activeTool === 'shapes' || activeTool === 'text') {
        updateInitialDrawingDrag(pt, e.shiftKey, e.altKey);
        return;
      }
    }

    if (isDraggingWandHandle && pt) {
      // Uchwyt podąża za kursorem od razu; obszar jest liczony w tle (najwyżej jedno zadanie na klatkę)
      engine.selectionManager.wandSeedPoint = { x: pt.x, y: pt.y };
      scheduleWandRefresh(pt);
      return;
    }

    if (isDraggingBucketHandle && pt) {
      // Uchwyt podąża za kursorem od razu; obszar jest liczony w tle (silnik odświeża widok, gdy wynik jest gotowy)
      engine.bucketSeedPoint = { x: pt.x, y: pt.y };
      const col = engine.bucketColorSource === 'secondary' ? secondaryColor : primaryColor;
      engine.applyPaintBucket(pt, selectionSettings, { ...brushSettings, color: col }, false);
      return;
    }

    if (activeTool === 'gradient') {
      if (isDraggingGradientHandle === 'move' && pt && dragStartPointRef.current && gradientDragInitialStartPtRef.current && gradientDragInitialEndPtRef.current) {
        const dx = pt.x - dragStartPointRef.current.x;
        const dy = pt.y - dragStartPointRef.current.y;
        const newP0 = { x: gradientDragInitialStartPtRef.current.x + dx, y: gradientDragInitialStartPtRef.current.y + dy };
        const newP1 = { x: gradientDragInitialEndPtRef.current.x + dx, y: gradientDragInitialEndPtRef.current.y + dy };
        engine.applyGradient(
          newP0,
          newP1,
          gradientSettings,
          primaryColor,
          secondaryColor,
          gradientSettings.blendMode || 'SrcOver',
          false,
          engine.gradientColorSource
        );
        onCanvasModified();
        return;
      }
      if (isDraggingGradientHandle === 0 && pt && engine.gradientEndPoint) {
        engine.applyGradient(
          pt,
          engine.gradientEndPoint,
          gradientSettings,
          primaryColor,
          secondaryColor,
          gradientSettings.blendMode || 'SrcOver',
          false,
          engine.gradientColorSource
        );
        onCanvasModified();
        return;
      }
      if (isDraggingGradientHandle === 1 && pt && engine.gradientStartPoint) {
        engine.applyGradient(
          engine.gradientStartPoint,
          pt,
          gradientSettings,
          primaryColor,
          secondaryColor,
          gradientSettings.blendMode || 'SrcOver',
          false,
          engine.gradientColorSource
        );
        onCanvasModified();
        return;
      }
      if (isDrawing && pt && dragStartPoint) {
        setCurrentDragPoint(pt);
        const dist = Math.hypot(pt.x - dragStartPoint.x, pt.y - dragStartPoint.y);
        if (dist >= 3) {
          const isFirstApply = !engine.gradientStartPoint;
          engine.applyGradient(
            dragStartPoint,
            pt,
            gradientSettings,
            primaryColor,
            secondaryColor,
            gradientSettings.blendMode || 'SrcOver',
            isFirstApply,
            engine.gradientColorSource
          );
          onCanvasModified();
        }
        return;
      }

      if (
        pt &&
        engine.gradientStartPoint &&
        Math.hypot(pt.x - engine.gradientStartPoint.x, pt.y - engine.gradientStartPoint.y) * zoom <= 14
      ) {
        setGradientHoverHandle(0);
      } else if (
        pt &&
        engine.gradientEndPoint &&
        Math.hypot(pt.x - engine.gradientEndPoint.x, pt.y - engine.gradientEndPoint.y) * zoom <= 14
      ) {
        setGradientHoverHandle(1);
      } else if (
        pt &&
        engine.gradientStartPoint &&
        engine.gradientEndPoint
      ) {
        const mid = { x: (engine.gradientStartPoint.x + engine.gradientEndPoint.x) / 2, y: (engine.gradientStartPoint.y + engine.gradientEndPoint.y) / 2 };
        if (Math.hypot(pt.x - mid.x, pt.y - mid.y) * zoom <= 14) {
          setGradientHoverHandle('move');
        } else {
          setGradientHoverHandle(null);
        }
      } else {
        setGradientHoverHandle(null);
      }
      return;
    }

    if (activeTool === 'pipette' || isSamplingPipetteRef.current) {
      if (isDrawing && pt) {
        const color = engine.pickColor(
          pt.x,
          pt.y,
          pipetteSettings?.sampleSource || 'image',
          pipetteSettings?.sampleDiameter || 1
        );
        onPipettePick(color, pipetteIsSecondaryRef.current);
      }
      return;
    }

    if (!isDrawing || !pt) return;

    if (activeTool === 'zoom') {
      setCurrentDragPoint(pt);
      return;
    }

    const layer = engine.getActiveLayer();
    if (!layer) return;

    if (activeTool === 'select-rect' || activeTool === 'select-ellipse') {
      setCurrentDragPoint(pt);
      return;
    }

    if (activeTool === 'select-lasso' && lassoMultiRef.current) {
      setCurrentDragPoint(pt);
      const pr = lassoPressRef.current;
      if (pr && (e.buttons & 1)) {
        const ms = penScreenPos(e);
        if (!pr.moved && Math.hypot(ms.x - pr.screen.x, ms.y - pr.screen.y) < 3) return;
        pr.moved = true;
        const prev = lassoPointsRef.current;
        const last = prev[prev.length - 1];
        if (!last || Math.hypot(pt.x - last.x, pt.y - last.y) * zoom >= 0.5) setLassoPts([...prev, pt]);
      }
      return;
    }

    if (activeTool === 'select-lasso') {
      setCurrentDragPoint(pt);
      // Punkty bliższe niż pół piksela ekranu nie zmieniają kształtu, a niepotrzebnie wydłużają lasso (podgląd, wypełnianie, łączenie wielokątów)
      {
        const prev = lassoPointsRef.current;
        const last = prev[prev.length - 1];
        if (!(last && Math.hypot(pt.x - last.x, pt.y - last.y) * zoom < 0.5)) setLassoPts([...prev, pt]);
      }
      return;
    }

    if (activeTool === 'brush' || activeTool === 'eraser') {
      const isEraser = activeTool === 'eraser';
      const isMaskMode = !!engine.maskView || !!(layer.editMask && layer.maskGrid) || layer.grayView;
      const effectiveIsEraser = isEraser && !isMaskMode;

      const baseColor = isEraser && isMaskMode
        ? { r: 0, g: 0, b: 0, a: brushSettings.color.a }
        : brushIsSecondaryRef.current
          ? secondaryColor
          : brushSettings.color;

      const effectiveColor = isMaskMode
        ? {
            r: Math.round(0.299 * baseColor.r + 0.587 * baseColor.g + 0.114 * baseColor.b),
            g: Math.round(0.299 * baseColor.r + 0.587 * baseColor.g + 0.114 * baseColor.b),
            b: Math.round(0.299 * baseColor.r + 0.587 * baseColor.g + 0.114 * baseColor.b),
            a: baseColor.a,
          }
        : baseColor;

      const currentBrushSettings: BrushSettings = {
        ...brushSettings,
        blendMode: isEraser && isMaskMode ? 'SrcOver' : brushSettings.blendMode,
        color: effectiveColor,
      };

      const native = e.nativeEvent as PointerEvent;
      const events: (React.PointerEvent | PointerEvent)[] =
        typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
          ? native.getCoalescedEvents()
          : [e];

      for (const ev of events) {
        const subPt = getDocPoint(ev);
        if (!subPt) continue;
        const strokeResult = engine.brushEngine.continueStroke(subPt, layer, currentBrushSettings, effectiveIsEraser);

        if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
          engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
        }
        lastBrushStrokeDocPointRef.current = { ...subPt };
      }
    }

    if (activeTool === 'correction-brush') {
      const subAction = getCorrectionSubAction(activeCorrectionButtonRef.current);
      const intensity = primaryColor.a;
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      const native = e.nativeEvent as PointerEvent;
      const events: (React.PointerEvent | PointerEvent)[] =
        typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
          ? native.getCoalescedEvents()
          : [e];

      for (const ev of events) {
        const subPt = getDocPoint(ev);
        if (!subPt) continue;
        const strokeResult = engine.brushEngine.continueCorrectionStroke(
          subPt,
          layer,
          correctionBrushSettings,
          subAction,
          intensity,
          mask
        );

        if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
          engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
        }
        lastBrushStrokeDocPointRef.current = { ...subPt };
      }
    }

    if (activeTool === 'deform') {
      const subAction = getDeformSubAction(activeCorrectionButtonRef.current);
      const intensity = primaryColor.a;
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      const native = e.nativeEvent as PointerEvent;
      const events: (React.PointerEvent | PointerEvent)[] =
        typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
          ? native.getCoalescedEvents()
          : [e];

      for (const ev of events) {
        const subPt = getDocPoint(ev);
        if (!subPt) continue;
        const strokeResult = engine.brushEngine.continueDeformStroke(
          subPt,
          layer,
          deformSettings,
          subAction,
          intensity,
          mask
        );

        if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
          engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
        }
        lastBrushStrokeDocPointRef.current = { ...subPt };
      }
    }

    if (activeTool === 'color-replace' && engine.brushEngine.isColorReplace) {
      const targetColor = colorReplaceTargetColorRef.current;
      const repColor = primaryColor || { r: 255, g: 0, b: 0, a: 255 };
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      const native = e.nativeEvent as PointerEvent;
      const events: (React.PointerEvent | PointerEvent)[] =
        typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
          ? native.getCoalescedEvents()
          : [e];

      for (const ev of events) {
        const subPt = getDocPoint(ev);
        if (!subPt) continue;
        const strokeResult = engine.brushEngine.continueColorReplaceStroke(
          subPt,
          layer,
          colorReplaceSettings,
          targetColor,
          repColor,
          mask
        );

        if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
          engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
        }
        lastBrushStrokeDocPointRef.current = { ...subPt };
      }
    }

    if (activeTool === 'stamp' && engine.brushEngine.isStamp && stampBasePointRef.current) {
      const native = e.nativeEvent as PointerEvent;
      const events: (React.PointerEvent | PointerEvent)[] =
        typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
          ? native.getCoalescedEvents()
          : [e];

      for (const ev of events) {
        const subPt = getDocPoint(ev);
        if (!subPt) continue;
        const strokeResult = engine.brushEngine.continueStampStroke(
          subPt,
          layer,
          engine,
          stampSettings
        );

        if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
          engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
        }
        lastBrushStrokeDocPointRef.current = { ...subPt };
      }
    }
  };

  // POINTER UP
  const handlePointerUp = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    liveOverSessionRef.current = false;

    if (isPanning) {
      setIsPanning(false);
      return;
    }

    if (vecGroupDragRef.current) {
      vecGroupDragRef.current = null;
      engine.vec.endGroupMove();
      notifyVecSelection();
      return;
    }
    if (vecMarqueeRef.current) {
      const m = vecMarqueeRef.current;
      vecMarqueeRef.current = null;
      const layer = engine.getActiveLayer();
      if (layer && layer.isVector) {
        const moved = Math.hypot(m.cur.x - m.start.x, m.cur.y - m.start.y) * zoom >= 3;
        if (moved) {
          const hit = engine.vec.objectsInRect(layer, {
            x0: Math.min(m.start.x, m.cur.x),
            y0: Math.min(m.start.y, m.cur.y),
            x1: Math.max(m.start.x, m.cur.x),
            y1: Math.max(m.start.y, m.cur.y),
          });
          const ids = [...new Set([...m.base, ...hit])];
          if (ids.length === 1 && m.base.length === 0) {
            const loaded = engine.vec.beginEdit(engine.layers.indexOf(layer), ids[0]);
            if (loaded) openVectorObject(loaded);
            notifyVecSelection();
          } else {
            selectVectorObjects(layer, ids);
          }
        } else if (m.base.length === 0) {
          notifyVecSelection();
        }
      }
      return;
    }

    if (freehandRef.current) {
      const f = freehandRef.current;
      freehandRef.current = null;
      const nodes = f.pts.length >= 2 ? fitFreehand(f.pts, Math.max(1.2, 2.5 / zoom)) : [];
      if (nodes.length >= 2) {
        penFreehandSessionRef.current = true;
        setPen({ nodes: normalizeOpenEnds(nodes, false), closed: false, phase: 'editing', selected: nodes.length - 1 });
      } else {
        penRef.current = null;
        setActiveVectorBezierSession(null);
      }
      redraw();
      return;
    }

    if (penPointerUp()) return;

    if (textDragRef.current) {
      textDragRef.current = null;
      focusTextInput();
      return;
    }

    // ZAKOŃCZENIE PRZECIĄGANIA UCHWYTU WEKTOROWEGO
    if (activeVectorHandle) {
      setActiveVectorHandleSynced(null);
      vectorDragStartPtRef.current = null;
      vectorInitialSessionStateRef.current = null;
      redraw();
      if (activeTextSession) focusTextInput();
      return;
    }

    // ZAKOŃCZENIE TRANSFORMACJI ZAZNACZENIA
    if (isTransformTool && transformActiveHandle) {
      const downPos = transformDownScreenRef.current;
      const wasClick = !!downPos && !transformMovedRef.current && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) < 4;
      if (
        activeTool === 'transform-content' &&
        wasClick &&
        (transformActiveHandle === 'move' || transformActiveHandle === 'pmove') &&
        engine.transformContentSession
      ) {
        // Pojedyncze kliknięcie na zaznaczeniu przełącza tryb perspektywy <-> zwykła ramka
        const init = transformInitialStateRef.current;
        if (engine.perspectiveActive) {
          engine.exitPerspective();
        } else {
          if (init) {
            engine.selectionManager.updateTransformSelection({ pos: { ...init.pos }, pivot: { ...init.pivot } });
          }
          engine.enterPerspective();
        }
        setTransformActiveHandleSynced(null);
        lastTransformPtRef.current = null;
        transformDownScreenRef.current = null;
        onCanvasModified();
        return;
      }
      setTransformActiveHandleSynced(null);
      lastTransformPtRef.current = null;
      if (activeTool === 'transform-selection' && transformInitialHistorySnapshotRef.current) {
        const finalSnapshot = engine.selectionManager.getMaskSnapshot();
        engine.pushSelectionAction(
          transformInitialHistorySnapshotRef.current,
          finalSnapshot,
          'Modyfikacja zaznaczenia'
        );
        transformInitialHistorySnapshotRef.current = null;
      }
      return;
    }

    if (isDraggingWandHandle) {
      setIsDraggingWandHandle(false);
      runWandRefresh(); // wyślij ostatnie oczekujące odświeżenie
      const initialSnapshot = wandDragInitialSnapshotRef.current;
      wandDragInitialSnapshotRef.current = null;
      if (initialSnapshot) {
        // Stan do historii zapisujemy dopiero po zakończeniu liczenia w tle
        void engine.whenWandIdle().then(() => {
          const finalSnapshot = engine.selectionManager.getMaskSnapshot();
          engine.pushSelectionAction(initialSnapshot, finalSnapshot, 'Przeniesienie punktu różdżki');
        });
      }
      return;
    }

    if (isDraggingBucketHandle) {
      setIsDraggingBucketHandle(false);
      onCanvasModified();
      return;
    }

    if (activeTool === 'gradient') {
      if (isDraggingGradientHandle !== null) {
        setIsDraggingGradientHandle(null);
        gradientDragInitialStartPtRef.current = null;
        gradientDragInitialEndPtRef.current = null;
        onCanvasModified();
        return;
      }
      if (isDrawing) {
        setIsDrawingSynced(false);
        const pt = getDocPoint(e);
        if (dragStartPoint && pt) {
          const dist = Math.hypot(pt.x - dragStartPoint.x, pt.y - dragStartPoint.y);
          if (dist < 3) {
            if (engine.gradientStartPoint) {
              engine.restoreGradientInitialTiles();
              engine.gradientStartPoint = null;
              engine.gradientEndPoint = null;
              engine.gradientInitialTilesSnapshot = null;
              engine.gradientInitialLayerIndex = -1;
              engine.gradientColorSource = 'primary';
            }
          } else {
            const isFirstApply = !engine.gradientStartPoint;
            engine.applyGradient(
              dragStartPoint,
              pt,
              gradientSettings,
              primaryColor,
              secondaryColor,
              gradientSettings.blendMode || 'SrcOver',
              isFirstApply,
              engine.gradientColorSource
            );
          }
        }
        setDragStartPointSynced(null);
        setCurrentDragPoint(null);
        onCanvasModified();
        return;
      }
    }

    if (activeTool === 'zoom' && isDrawing) {
      setIsDrawingSynced(false);
      const endPt = getDocPoint(e) || currentDragPoint || dragStartPoint;
      const button = zoomButtonRef.current;

      if (dragStartPoint && endPt) {
        const dragW = Math.abs(endPt.x - dragStartPoint.x);
        const dragH = Math.abs(endPt.y - dragStartPoint.y);

        if (dragW >= 5 && dragH >= 5) {
          // Zaznaczenie obszaru prostokątem -> przybliż zaznaczony obszar
          const boxLeft = Math.min(dragStartPoint.x, endPt.x);
          const boxTop = Math.min(dragStartPoint.y, endPt.y);
          const boxCenterX = boxLeft + dragW / 2;
          const boxCenterY = boxTop + dragH / 2;

          const cWidth = containerSize.width || containerRef.current?.clientWidth || 800;
          const cHeight = containerSize.height || containerRef.current?.clientHeight || 600;

          const scaleX = cWidth / Math.max(1, dragW);
          const scaleY = cHeight / Math.max(1, dragH);
          const targetZoom = Math.min(25.0, Math.max(0.05, Number((Math.min(scaleX, scaleY) * 0.92).toFixed(3))));

          const newPanX = -(boxCenterX - engine.width / 2) * targetZoom;
          const newPanY = -(boxCenterY - engine.height / 2) * targetZoom;

          onUpdateZoom(targetZoom);
          onUpdatePan({ x: newPanX, y: newPanY });
        } else {
          // Kliknięcie LPM (przybliża) lub PPM (oddala) względem kursora myszy
          const zoomFactor = button === 2 ? 0.7 : 1.4;
          const newZoom = Math.min(25.0, Math.max(0.05, Number((zoom * zoomFactor).toFixed(3))));

          if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            const mouseX = e.clientX - rect.left - rect.width / 2;
            const mouseY = e.clientY - rect.top - rect.height / 2;

            const newPanX = mouseX - (endPt.x - engine.width / 2) * newZoom;
            const newPanY = mouseY - (endPt.y - engine.height / 2) * newZoom;

            onUpdateZoom(newZoom);
            onUpdatePan({ x: newPanX, y: newPanY });
          }
        }
      }

      setDragStartPointSynced(null);
      setCurrentDragPoint(null);
      return;
    }

    // LASSO PUNKT PO PUNKCIE: puszczenie przycisku nie kończy sesji; zwykłe kliknięcie dodaje odcinek prosty
    if (activeTool === 'select-lasso' && lassoMultiRef.current) {
      const pr = lassoPressRef.current;
      lassoPressRef.current = null;
      if (pr && !pr.moved && !pr.first && true) {
        const p = getDocPoint(e);
        if (p) setLassoPts([...lassoPointsRef.current, p]);
      }
      return;
    }

    // TEKST: zwykłe kliknięcie (bez przeciągania) tworzy domyślną ramkę z automatyczną wysokością
    if (activeTool === 'text' && isDrawingRef.current && !activeTextSession && dragStartPointRef.current) {
      createDefaultTextSession(dragStartPointRef.current);
    }

    // ZAKOŃCZENIE POCZĄTKOWEGO RYSOWANIA WEKTOROWEGO
    if (activeTool === 'line' || activeTool === 'bezier' || activeTool === 'shapes' || activeTool === 'text') {
      setIsDrawingSynced(false);
      setDragStartPointSynced(null);
      setCurrentDragPoint(null);
      redraw();
      return;
    }

    // ZAKOŃCZENIE PRÓBKOWANIA PIPETY / SZYBKIEJ PIPETY
    if (activeTool === 'pipette' || isSamplingPipetteRef.current) {
      isSamplingPipetteRef.current = false;
      pipetteIsSecondaryRef.current = false;
      setIsDrawingSynced(false);
      return;
    }

    if (!isDrawing) return;
    setIsDrawingSynced(false);

    const layer = engine.getActiveLayer();

    if ((activeTool === 'select-rect' || activeTool === 'select-ellipse') && dragStartPoint && currentDragPoint) {
      const hasMoved = dragStartPoint.x !== currentDragPoint.x || dragStartPoint.y !== currentDragPoint.y;
      engine.applySelectionShape(
        activeTool === 'select-rect' ? 'rect' : 'ellipse',
        [dragStartPoint, currentDragPoint],
        getModifiedSelectionSettings(e),
        e.shiftKey || isShiftKeyDown,
        hasMoved
      );
      onCanvasModified();
      setDragStartPointSynced(null);
      setCurrentDragPoint(null);
      return;
    }

    if (activeTool === 'select-lasso') {
      let maxDist = 0;
      if (lassoPoints.length > 1 && dragStartPoint) {
        for (const lp of lassoPoints) {
          const d = Math.hypot(lp.x - dragStartPoint.x, lp.y - dragStartPoint.y);
          if (d > maxDist) maxDist = d;
        }
      }
      const hasMoved = lassoPoints.length > 2 && maxDist > 0;
      engine.applySelectionShape('lasso', lassoPoints, getModifiedSelectionSettings(e), false, hasMoved);
      onCanvasModified();
      setDragStartPointSynced(null);
      setCurrentDragPoint(null);
      setLassoPts([]);
      return;
    }

    if (activeTool === 'brush' || activeTool === 'eraser') {
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      const sigBeforeEnd = engine.getBaseSignature();
      const endResult = engine.brushEngine.endStroke(layer, mask);
      if (endResult) {
        engine.pushTileAction({
          type: 'tiles',
          description: activeTool === 'eraser' ? 'Gumka' : 'Pędzel',
          layerIndex: engine.activeLayerIndex,
          before: endResult.before,
          after: endResult.after,
        });

        if (canvasRef.current) {
          // Przy efektach ostatnia klatka na żywo jest już poprawna: przeliczenie wyników filtrów odkładamy na później
          if (baseSigRef.current === sigBeforeEnd && engine.renderHasFilters) {
            engine.scheduleFilterWarmup(endResult.dirtyRect);
          } else {
            engine.compositeToViewport(canvasRef.current, endResult.dirtyRect);
          }
          // płótno dokumentu jest już aktualne (złożony tylko zmieniony fragment): pełne przerysowanie po stanie React zbędne
          if (baseSigRef.current === sigBeforeEnd) {
            const s2 = engine.getBaseSignature();
            baseSigRef.current = s2;
            skipRedrawSigRef.current = s2;
          }
        }
      }
      brushIsSecondaryRef.current = false;
      onCanvasModified();
    }

    if (activeTool === 'correction-brush') {
      const subAction = getCorrectionSubAction(activeCorrectionButtonRef.current);
      const endResult = engine.brushEngine.endCorrectionStroke(layer);
      if (endResult) {
        let actionName = 'Korekcja';
        if (subAction === 'dodge') actionName = 'Rozjaśnienie';
        else if (subAction === 'burn') actionName = 'Ściemnienie';
        else if (subAction === 'blur') actionName = 'Rozmycie';
        else if (subAction === 'sharpen') actionName = 'Wyostrzenie';
        else if (subAction === 'saturate') actionName = 'Nasycenie';
        else if (subAction === 'desaturate') actionName = 'Odsycenie';

        engine.pushTileAction({
          type: 'tiles',
          description: `Pędzel korekcyjny (${actionName})`,
          layerIndex: engine.activeLayerIndex,
          before: endResult.before,
          after: endResult.after,
        });

        if (canvasRef.current) {
          engine.compositeToViewport(canvasRef.current, endResult.dirtyRect);
        }
      }
      onCanvasModified();
    }

    if (activeTool === 'deform') {
      const subAction = getDeformSubAction(activeCorrectionButtonRef.current);
      const endResult = engine.brushEngine.endDeformStroke(layer);
      if (endResult) {
        let actionName = 'Deformacja';
        if (subAction === 'expand') actionName = 'Powiększenie';
        else if (subAction === 'shrink') actionName = 'Pomniejszenie';
        else if (subAction === 'smudge' || subAction === 'smudge-rev') actionName = 'Przesunięcie';
        else if (subAction === 'twirl-cw' || subAction === 'twirl-ccw') actionName = 'Obrót';

        engine.pushTileAction({
          type: 'tiles',
          description: `Deformacja (${actionName})`,
          layerIndex: engine.activeLayerIndex,
          before: endResult.before,
          after: endResult.after,
        });

        if (canvasRef.current) {
          engine.compositeToViewport(canvasRef.current, endResult.dirtyRect);
        }
      }
      onCanvasModified();
    }

    if (activeTool === 'color-replace') {
      const endResult = engine.brushEngine.endColorReplaceStroke(layer);
      if (endResult) {
        engine.pushTileAction({
          type: 'tiles',
          description: 'Pędzel zmiany koloru',
          layerIndex: engine.activeLayerIndex,
          before: endResult.before,
          after: endResult.after,
        });

        if (canvasRef.current) {
          engine.compositeToViewport(canvasRef.current, endResult.dirtyRect);
        }
      }
      onCanvasModified();
    }

    if (activeTool === 'stamp') {
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      const endResult = engine.brushEngine.endStampStroke(layer, mask);
      if (endResult) {
        engine.pushTileAction({
          type: 'tiles',
          description: 'Pieczątka (Klonowanie)',
          layerIndex: engine.activeLayerIndex,
          before: endResult.before,
          after: endResult.after,
          other: endResult.other,
        });

        if (canvasRef.current) {
          engine.compositeToViewport(canvasRef.current, endResult.dirtyRect);
        }
      }
      onCanvasModified();
    }
  };

  // KURSOR MYSZY
  const cursorStyleRef = useRef('default');
  const getCursorStyle = (): string => {
    if (isPanning || isSpacePressed || activeTool === 'pan') {
      return isPanning ? 'grabbing' : 'grab';
    }
    if (
      activeTool === 'brush' ||
      activeTool === 'eraser' ||
      activeTool === 'correction-brush' ||
      activeTool === 'color-replace' ||
      activeTool === 'stamp' ||
      activeTool === 'deform' ||
      activeTool === 'pipette' ||
      isQuickPipetteActive
    ) {
      return 'none';
    }
    if (isAnyVectorSessionActive && hoverVectorHandle) {
      if (hoverVectorHandle === 'text-body') return 'text';
      if (hoverVectorHandle === 'move') return 'move';
      if (hoverVectorHandle === 'modifier' || hoverVectorHandle === 'modifier-shaft') return 'pointer';
      if (hoverVectorHandle === 'rotate') {
        const boxAngleDeg = Math.round(
          (((activeVectorShapeSession ?? activeTextSession)?.angle || 0) * 180) / Math.PI
        );
        return getRotateCursorUrl(boxAngleDeg - 90);
      }
      if (hoverVectorHandle === 'nw' || hoverVectorHandle === 'se') return 'nwse-resize';
      if (hoverVectorHandle === 'ne' || hoverVectorHandle === 'sw') return 'nesw-resize';
      if (hoverVectorHandle === 'n' || hoverVectorHandle === 's') return 'ns-resize';
      if (hoverVectorHandle === 'e' || hoverVectorHandle === 'w') return 'ew-resize';
      return 'pointer';
    }
    if (isTransformTool) {
      const h = transformActiveHandle || transformHoverHandle;
      if (h === 'pivot' || h === 'move' || h === 'pmove') return 'move';
      if (h === 'p0' || h === 'p1' || h === 'p2' || h === 'p3') return 'pointer';
      if (h === 'rotate') {
        const boxAngleDeg = Math.round(
          ((engine.selectionManager.transformState?.angle || 0) * 180) / Math.PI
        );
        return getRotateCursorUrl(boxAngleDeg - 90);
      }
      if (h === 'nw' || h === 'se') return 'nwse-resize';
      if (h === 'ne' || h === 'sw') return 'nesw-resize';
      if (h === 'n' || h === 's') return 'ns-resize';
      if (h === 'e' || h === 'w') return 'ew-resize';
      return 'none';
    }
    if (activeTool.startsWith('select') || activeTool === 'magic-wand') {
      return 'none';
    }
    // jednolity, mały plusik rysowany na nakładce (patrz sekcja 9b) zamiast systemowych kursorów
    if (activeTool === 'line' || activeTool === 'bezier' || activeTool === 'shapes' || activeTool === 'text' || activeTool === 'bucket') {
      return 'none';
    }
    if (activeTool === 'gradient') {
      if (gradientHoverHandle !== null || isDraggingGradientHandle !== null) {
        return 'move';
      }
      return 'none';
    }
    if (activeTool === 'zoom') {
      return isShiftKeyDown || zoomButtonRef.current === 2 ? 'zoom-out' : 'zoom-in';
    }
    return 'default';
  };
  cursorStyleRef.current = getCursorStyle();

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            engine.importImage(img, file.name);
            onCanvasModified();
          };
          img.src = event.target?.result as string;
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const cWidth = containerSize.width || containerRef.current?.clientWidth || 0;
  const cHeight = containerSize.height || containerRef.current?.clientHeight || 0;
  const screenCenterX = cWidth / 2 + panOffset.x;
  const screenCenterY = cHeight / 2 + panOffset.y;
  const screenWidth = engine.width * zoom;
  const screenHeight = engine.height * zoom;
  // Lewy górny róg przyciągnięty do pikseli urządzenia: płótno dokumentu i płótno kafelków mają ten sam układ współrzędnych
  const devDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const screenLeft = Math.round((screenCenterX - screenWidth / 2) * devDpr) / devDpr;
  const screenTop = Math.round((screenCenterY - screenHeight / 2) * devDpr) / devDpr;

  return (
    <div
      ref={containerRef}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => {
        // Podczas edycji tekstu klik na płótnie nie może zabrać fokusu ukrytemu polu wejściowemu
        if (activeTextSession) e.preventDefault();
      }}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={handleDrop}
      onPointerLeave={() => {
        updateStatusBarPos(null);
        setTransformHoverHandle(null);
        setHoverVectorHandle(null);
        cursorPosRef.current = null;
      }}
      className="relative flex-1 h-full overflow-hidden select-none bg-[#6f6f6f] touch-none"
      style={{ cursor: cursorStyleRef.current }}
    >
      {/* JEDNOLITA STRUKTURA PŁÓTNA: SZACHOWNICA + RYSUNEK + 1PX RAMKA */}
      <div
        className="absolute origin-top-left overflow-hidden"
        style={{
          left: `${screenLeft}px`,
          top: `${screenTop}px`,
          width: `${screenWidth}px`,
          height: `${screenHeight}px`,
          backgroundImage: `
            linear-gradient(45deg, #e4e4e4 25%, transparent 25%),
            linear-gradient(-45deg, #e4e4e4 25%, transparent 25%),
            linear-gradient(45deg, transparent 75%, #e4e4e4 75%),
            linear-gradient(-45deg, transparent 75%, #e4e4e4 75%)
          `,
          backgroundSize: '24px 24px',
          backgroundPosition: `${-screenLeft}px ${-screenTop}px, ${-screenLeft}px ${-screenTop + 12}px, ${-screenLeft + 12}px ${-screenTop - 12}px, ${-screenLeft - 12}px ${-screenTop}px`,
          backgroundColor: '#ffffff',
          boxShadow: '0 0 0 1px #222222, 0 12px 36px -4px rgba(0, 0, 0, 0.45)',
          zIndex: 2,
        }}
      >
        <canvas
          ref={canvasRef}
          width={engine.width}
          height={engine.height}
          className="block w-full h-full bg-transparent flex-shrink-0"
          style={{
            width: '100%',
            height: '100%',
            imageRendering: zoom >= 2.0 ? 'pixelated' : 'auto',
          }}
        />
      </div>

      <canvas
        ref={tileCanvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ zIndex: 3, width: '100%', height: '100%' }}
      />

      <canvas
        ref={overlayCanvasRef}
        className="absolute inset-0 pointer-events-none z-30"
      />

      {/* Menu rodzaju węzła krzywej (po kliknięciu węzła) */}
      {penMenu && activeVectorBezierSession && activeVectorBezierSession.nodes[penMenu.index] && (() => {
        const sess = activeVectorBezierSession;
        const nd = sess.nodes[penMenu.index];
        const sp = docToScreen(nd);
        const cw = containerSize.width || containerRef.current?.clientWidth || 0;
        const ch = containerSize.height || containerRef.current?.clientHeight || 0;
        const left = Math.max(4, Math.min(sp.x + 14, cw - 200));
        const top = Math.max(4, Math.min(sp.y + 14, ch - 140));
        const cur = penNodeMode(nd);
        return (
          <div
            className="absolute z-40 w-48 bg-[#1e1e1e] border border-[#454545] rounded shadow-2xl py-1 text-xs text-[#ddd]"
            style={{ left, top }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {PEN_MODES.map((m) => {
              const ok = penModeAvailable(sess.nodes, penMenu.index, sess.closed, m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  disabled={!ok}
                  title={m.hint}
                  onClick={() => penChooseMode(m.id)}
                  className={`w-full flex items-center gap-2 px-2 py-1 text-left ${
                    cur === m.id ? 'bg-[#094771] text-white' : 'hover:bg-[#2a2d2e]'
                  } ${ok ? 'cursor-pointer' : 'opacity-35 cursor-default'}`}
                >
                  <PenModeIcon mode={m.id} />
                  <span>{m.label}</span>
                </button>
              );
            })}
            <div className="my-1 border-t border-[#333]" />
            {sess.closed && sess.nodes.length >= 3 && (
              <button
                type="button"
                title="Otwiera krzywą w tym węźle: staje się on początkiem, a poprzedni węzeł końcem"
                onClick={() => penOpenAt(penMenu.index)}
                className="w-full flex items-center gap-2 px-2 py-1 text-left cursor-pointer hover:bg-[#2a2d2e]"
              >
                <span className="w-4 text-center shrink-0">✂</span>
                <span>Otwórz krzywą tutaj</span>
              </button>
            )}
            <button
              type="button"
              disabled={sess.nodes.length <= 2}
              title="Usuń węzeł (Delete)"
              onClick={() => penDeleteNode(penMenu.index)}
              className={`w-full flex items-center gap-2 px-2 py-1 text-left ${
                sess.nodes.length > 2 ? 'cursor-pointer hover:bg-[#2a2d2e] text-[#f0a0a0]' : 'opacity-35 cursor-default'
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0">
                <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.8 7v3.5M9.2 7v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>Usuń węzeł</span>
            </button>
          </div>
        );
      })()}

      {/* Ukryte pole wejściowe edytora tekstu (klawiatura, IME, schowek) */}
      <textarea
        ref={textInputRef}
        data-figura-text-editor="1"
        aria-label="Edytor tekstu"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        tabIndex={-1}
        onKeyDown={handleTextKeyDown}
        onKeyUp={handleTextKeyUp}
        onInput={handleTextInput}
        onCompositionStart={() => {
          textComposingRef.current = true;
        }}
        onCompositionEnd={handleTextCompositionEnd}
        onCopy={handleTextCopy}
        onCut={handleTextCut}
        onPaste={handleTextPaste}
        style={{
          position: 'absolute',
          left: activeTextSession ? docToScreen(activeTextSession.center).x : 0,
          top: activeTextSession ? docToScreen(activeTextSession.center).y : 0,
          width: 2,
          height: 2,
          opacity: 0,
          padding: 0,
          border: 0,
          margin: 0,
          resize: 'none',
          overflow: 'hidden',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />
    </div>
  );
};

const PenModeIcon: React.FC<{ mode: PenMode }> = ({ mode }) => {
  const d =
    mode === 'sharp'
      ? 'M2 13 L8 4 L14 13'
      : mode === 'before'
      ? 'M2 13 Q4 4 8 4 L14 4'
      : mode === 'after'
      ? 'M2 4 L8 4 Q12 4 14 13'
      : 'M2 13 C4 7 6 4 8 4 C10 4 12 7 14 13';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0">
      <path d={d} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="6.3" y="2.3" width="3.4" height="3.4" fill="#1e1e1e" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
};

const crosshairSvg = (badge: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <!-- White outline crosshair for dark backgrounds -->
    <path d="M16,5 L16,11 M16,21 L16,27 M5,16 L11,16 M21,16 L27,16" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>
    <!-- Black core lines -->
    <path d="M16,5 L16,11 M16,21 L16,27 M5,16 L11,16 M21,16 L27,16" stroke="#000000" stroke-width="1.2" stroke-linecap="round"/>
    <!-- Central dot -->
    <circle cx="16" cy="16" r="1.5" fill="#ffffff" stroke="#000000" stroke-width="0.8"/>
    
    <!-- Badge text -->
    ${badge ? `
      <text x="24" y="26" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="900" fill="#ffffff" stroke="#ffffff" stroke-width="2.5" paint-order="stroke fill" text-anchor="middle">${badge}</text>
      <text x="24" y="26" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="900" fill="#00bcd4" stroke="#000000" stroke-width="0.5" paint-order="stroke fill" text-anchor="middle">${badge}</text>
    ` : ''}
  </svg>`;
  return 'url("data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '") 16 16, crosshair';
};
