/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { GraphicEngine } from '../core/skia/GraphicEngine.ts';
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
  ToolType,
  VectorShapeSettings,
  skColorToHex,
  skColorToRgbaString,
} from '../core/skia/types.ts';
import { TransformSelectionState } from '../core/skia/SelectionManager.ts';
import {
  renderVectorBezier,
  renderVectorLine,
  renderVectorShape,
} from '../core/skia/VectorRenderer.ts';

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
  primaryColor?: SKColor;
  secondaryColor?: SKColor;
  onChangeSelectionSettings?: (settings: Partial<SelectionSettings>) => void;
  activeTool: ToolType;
  activeShapeType: ShapeKind;
  zoom: number;
  panOffset: { x: number; y: number };
  onUpdateZoom: (zoom: number) => void;
  onUpdatePan: (offset: { x: number; y: number }) => void;
  onPipettePick: (color: SKColor) => void;
  onCanvasModified: () => void;
  onLiveVectorSessionChange?: (isActive: boolean) => void;
  liveVectorCommitTrigger?: number;
  liveVectorCancelTrigger?: number;
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

interface ActiveVectorLineSession {
  p0: SKPoint;
  p1: SKPoint;
}

interface ActiveVectorBezierSession {
  p0: SKPoint;
  p1: SKPoint;
  p2: SKPoint;
  p3: SKPoint;
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
  primaryColor = { r: 0, g: 0, b: 0, a: 255 },
  secondaryColor = { r: 255, g: 255, b: 255, a: 255 },
  onChangeSelectionSettings,
  activeTool,
  zoom,
  panOffset,
  onUpdateZoom,
  onUpdatePan,
  onPipettePick,
  onCanvasModified,
  onLiveVectorSessionChange,
  liveVectorCommitTrigger,
  liveVectorCancelTrigger,
  onShowToast,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  const baseSelectionModeRef = useRef<SelectionSettings['mode'] | null>(null);

  const [isPanning, setIsPanning] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // SESJE EDYCJI WEKTOROWEJ NA ŻYWO
  const [activeVectorLineSession, setActiveVectorLineSession] = useState<ActiveVectorLineSession | null>(null);
  const [activeVectorBezierSession, setActiveVectorBezierSession] = useState<ActiveVectorBezierSession | null>(null);
  const [activeVectorShapeSession, setActiveVectorShapeSession] = useState<ActiveVectorShapeSession | null>(null);

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
  const activeCorrectionButtonRef = useRef<number>(0);
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
    activeVectorShapeSession
  );

  useEffect(() => {
    onLiveVectorSessionChange?.(isAnyVectorSessionActive);
  }, [isAnyVectorSessionActive, onLiveVectorSessionChange]);

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
      engine.commitVectorBezier(
        activeVectorBezierSession.p0,
        activeVectorBezierSession.p1,
        activeVectorBezierSession.p2,
        activeVectorBezierSession.p3,
        lineAndCurveSettings
      );
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
    }
  }, [
    activeVectorLineSession,
    activeVectorBezierSession,
    activeVectorShapeSession,
    engine,
    lineAndCurveSettings,
    vectorShapeSettings,
    onCanvasModified,
  ]);

  const cancelActiveVectorSession = useCallback(() => {
    setActiveVectorLineSession(null);
    setActiveVectorBezierSession(null);
    setActiveVectorShapeSession(null);
    setActiveVectorHandleSynced(null);
    vectorDragStartPtRef.current = null;
    vectorInitialSessionStateRef.current = null;
    setIsDrawingSynced(false);
    setDragStartPointSynced(null);
    onCanvasModified();
  }, [onCanvasModified]);

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
    if (activeTool === 'transform-content') {
      if (!engine.transformContentSession && engine.selectionManager.hasActiveSelection) {
        engine.beginTransformContent(selectionSettings.interpolation || 'bilinear');
        onCanvasModified();
      }
    } else if (activeTool === 'transform-selection') {
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
    if (activeTool !== 'bucket' && engine.bucketSeedPoint) {
      engine.commitPaintBucketSession();
      onCanvasModified();
    }
    if (activeTool !== 'brush' && activeTool !== 'eraser') {
      lastBrushStrokeDocPointRef.current = null;
    }
  }, [activeTool, engine, selectionSettings.interpolation, onCanvasModified]);

  // Reakcja na zmianę parametrów wiadra z farbą i koloru na żywo (gdy aktywna jest sesja wiadra)
  useEffect(() => {
    if (activeTool === 'bucket' && engine.bucketSeedPoint) {
      engine.applyPaintBucket(
        engine.bucketSeedPoint,
        selectionSettings,
        { ...brushSettings, color: primaryColor },
        false
      );
      onCanvasModified();
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
    onCanvasModified,
  ]);

  // Reakcja na zmianę parametrów magicznej różdżki na żywo (gdy aktywna jest sesja różdżki)
  useEffect(() => {
    if (activeTool === 'magic-wand' && engine.selectionManager.wandSeedPoint) {
      engine.refreshMagicWand(selectionSettings);
      onCanvasModified();
    }
  }, [
    activeTool,
    engine,
    selectionSettings.tolerance,
    selectionSettings.wandMode,
    selectionSettings.sampleSource,
    onCanvasModified,
  ]);

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
        false
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
        renderVectorBezier(
          ctx,
          activeVectorBezierSession.p0,
          activeVectorBezierSession.p1,
          activeVectorBezierSession.p2,
          activeVectorBezierSession.p3,
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
      }
    };

    const currentBlendMode = activeVectorShapeSession
      ? vectorShapeSettings.blendMode
      : lineAndCurveSettings.blendMode;

    engine.compositeToViewport(
      canvasRef.current,
      null,
      null,
      null,
      null,
      null,
      isAnyVectorSessionActive ? customPreview : null,
      isAnyVectorSessionActive ? currentBlendMode : null
    );
  }, [
    engine,
    activeVectorLineSession,
    activeVectorBezierSession,
    activeVectorShapeSession,
    lineAndCurveSettings,
    vectorShapeSettings,
    isAnyVectorSessionActive,
  ]);

  useEffect(() => {
    redraw();
  }, [redraw, engineRevision, engine.width, engine.height, engine.activeLayerIndex]);

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

      if (activeVectorBezierSession) {
        const p0Screen = docToScreen(activeVectorBezierSession.p0);
        const p1Screen = docToScreen(activeVectorBezierSession.p1);
        const p2Screen = docToScreen(activeVectorBezierSession.p2);
        const p3Screen = docToScreen(activeVectorBezierSession.p3);
        const midDoc: SKPoint = {
          x: (activeVectorBezierSession.p0.x + activeVectorBezierSession.p3.x) / 2,
          y: (activeVectorBezierSession.p0.y + activeVectorBezierSession.p3.y) / 2,
        };
        const midScreen = docToScreen(midDoc);

        if (Math.hypot(mouseX - p0Screen.x, mouseY - p0Screen.y) <= 12) return 'p0';
        if (Math.hypot(mouseX - p1Screen.x, mouseY - p1Screen.y) <= 12) return 'p1';
        if (Math.hypot(mouseX - p2Screen.x, mouseY - p2Screen.y) <= 12) return 'p2';
        if (Math.hypot(mouseX - p3Screen.x, mouseY - p3Screen.y) <= 12) return 'p3';
        if (Math.hypot(mouseX - midScreen.x, mouseY - midScreen.y) <= 12) return 'move';
        return null;
      }

      if (activeVectorShapeSession) {
        const sess = activeVectorShapeSession;
        // 1. Sprawdź punkt modyfikatora TYLKO dla figur które go posiadają (round-rect, star, arrow)
        if (hasShapeModifier(vectorShapeSettings.shapeKind)) {
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
          return 'move';
        }
      }

      return null;
    },
    [
      activeVectorLineSession,
      activeVectorBezierSession,
      activeVectorShapeSession,
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
    [getTransformScreenGeometry, engine.selectionManager.transformState, getDocPoint]
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
        redraw();
        return;
      }

      if (activeVectorBezierSession) {
        const init = vectorInitialSessionStateRef.current as ActiveVectorBezierSession;
        if (activeHandle === 'p0') {
          let moveX = Math.round(pt.x) - init.p0.x;
          let moveY = Math.round(pt.y) - init.p0.y;
          if (shiftKey) {
            if (Math.abs(moveX) >= Math.abs(moveY)) moveY = 0;
            else moveX = 0;
          }
          const newP0 = { x: init.p0.x + moveX, y: init.p0.y + moveY };
          const newP1 = { x: init.p1.x + moveX, y: init.p1.y + moveY };
          setActiveVectorBezierSession({ ...init, p0: newP0, p1: newP1 });
        } else if (activeHandle === 'p3') {
          let moveX = Math.round(pt.x) - init.p3.x;
          let moveY = Math.round(pt.y) - init.p3.y;
          if (shiftKey) {
            if (Math.abs(moveX) >= Math.abs(moveY)) moveY = 0;
            else moveX = 0;
          }
          const newP3 = { x: init.p3.x + moveX, y: init.p3.y + moveY };
          const newP2 = { x: init.p2.x + moveX, y: init.p2.y + moveY };
          setActiveVectorBezierSession({ ...init, p3: newP3, p2: newP2 });
        } else if (activeHandle === 'p1') {
          let targetX = Math.round(pt.x);
          let targetY = Math.round(pt.y);
          if (shiftKey) {
            const hdx = targetX - init.p0.x;
            const hdy = targetY - init.p0.y;
            const angle = Math.atan2(hdy, hdx);
            const step = Math.PI / 4;
            const snappedAngle = Math.round(angle / step) * step;
            const dist = Math.hypot(hdx, hdy);
            targetX = Math.round(init.p0.x + Math.cos(snappedAngle) * dist);
            targetY = Math.round(init.p0.y + Math.sin(snappedAngle) * dist);
          }
          setActiveVectorBezierSession({ ...init, p1: { x: targetX, y: targetY } });
        } else if (activeHandle === 'p2') {
          let targetX = Math.round(pt.x);
          let targetY = Math.round(pt.y);
          if (shiftKey) {
            const hdx = targetX - init.p3.x;
            const hdy = targetY - init.p3.y;
            const angle = Math.atan2(hdy, hdx);
            const step = Math.PI / 4;
            const snappedAngle = Math.round(angle / step) * step;
            const dist = Math.hypot(hdx, hdy);
            targetX = Math.round(init.p3.x + Math.cos(snappedAngle) * dist);
            targetY = Math.round(init.p3.y + Math.sin(snappedAngle) * dist);
          }
          setActiveVectorBezierSession({ ...init, p2: { x: targetX, y: targetY } });
        } else if (activeHandle === 'move') {
          let moveDx = dx;
          let moveDy = dy;
          if (shiftKey) {
            if (Math.abs(moveDx) >= Math.abs(moveDy)) moveDy = 0;
            else moveDx = 0;
          }
          setActiveVectorBezierSession({
            p0: { x: init.p0.x + moveDx, y: init.p0.y + moveDy },
            p1: { x: init.p1.x + moveDx, y: init.p1.y + moveDy },
            p2: { x: init.p2.x + moveDx, y: init.p2.y + moveDy },
            p3: { x: init.p3.x + moveDx, y: init.p3.y + moveDy },
          });
        }
        redraw();
        return;
      }

      if (activeVectorShapeSession) {
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
          setActiveVectorShapeSession({
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

          setActiveVectorShapeSession({ ...init, angle: targetAngle });
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

        setActiveVectorShapeSession({
          ...init,
          width: newW,
          height: newH,
          center: { x: newCenterX, y: newCenterY },
          pivot: { x: newCenterX, y: newCenterY },
        });
        redraw();
      }
    },
    [
      activeVectorLineSession,
      activeVectorBezierSession,
      activeVectorShapeSession,
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
        redraw();
        return;
      }

      if (activeTool === 'bezier') {
        const p0 = { x: Math.round(startPt.x), y: Math.round(startPt.y) };
        const p3 = { x: Math.round(pt.x), y: Math.round(pt.y) };
        const dx = p3.x - p0.x;
        const dy = p3.y - p0.y;
        const p1 = {
          x: Math.round(p0.x + dx * 0.33 - dy * 0.25),
          y: Math.round(p0.y + dy * 0.33 + dx * 0.25),
        };
        const p2 = {
          x: Math.round(p0.x + dx * 0.66 - dy * 0.25),
          y: Math.round(p0.y + dy * 0.66 + dx * 0.25),
        };
        setActiveVectorBezierSession({ p0, p1, p2, p3 });
        redraw();
        return;
      }

      if (activeTool === 'shapes') {
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

        setActiveVectorShapeSession({
          center,
          width: w,
          height: h,
          angle: 0,
          pivot: { ...center },
          flipX: false,
          flipY: false,
        });
        redraw();
      }
    },
    [activeTool, redraw]
  );

  // OBSŁUGA SKRÓTÓW KLAWIATUROWYCH (Enter = Zatwierdź, Esc = Anuluj, Natychmiastowa reakcja na Shift / Alt)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
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

      if (isSelectionTool && (e.key === 'Shift' || e.key === 'Alt')) {
        if (baseSelectionModeRef.current === null) {
          baseSelectionModeRef.current = selectionSettings.mode;
        }

        const shiftKey = e.shiftKey || e.key === 'Shift';
        const altKey = e.altKey || e.key === 'Alt';

        let targetMode = baseSelectionModeRef.current;
        if (shiftKey && altKey) {
          targetMode = 'intersect';
        } else if (altKey) {
          targetMode = 'subtract';
        } else if (shiftKey) {
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
      if (e.key === 'Escape') {
        if (isAnyVectorSessionActive) {
          cancelActiveVectorSession();
        } else if (engine.transformContentSession) {
          engine.cancelTransformContent();
          onCanvasModified();
        } else if (engine.selectionManager.transformState) {
          engine.selectionManager.cancelTransformSelection();
          onCanvasModified();
        } else if (engine.bucketSeedPoint) {
          engine.restoreBucketInitialTiles();
          engine.bucketSeedPoint = null;
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

      if (isSelectionTool && (e.key === 'Shift' || e.key === 'Alt')) {
        const shiftKey = e.key === 'Shift' ? false : e.shiftKey;
        const altKey = e.key === 'Alt' ? false : e.altKey;

        let targetMode = baseSelectionModeRef.current || 'replace';
        if (shiftKey && altKey) {
          targetMode = 'intersect';
        } else if (altKey) {
          targetMode = 'subtract';
        } else if (shiftKey) {
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
          const isTransformingContentActive = activeTool === 'transform-content' && transformActiveHandle !== null;
          if (engine.selectionManager.hasActiveSelection && !isTransformingContentActive) {
            const time = performance.now();
            const dashOffset = (time / 60) % 8;

            oCtx.save();
            oCtx.lineWidth = 1 / zoom;
            oCtx.setLineDash([4 / zoom, 4 / zoom]);

            oCtx.lineDashOffset = dashOffset / zoom;
            oCtx.strokeStyle = '#000000';
            oCtx.stroke(engine.selectionManager.contourPath);

            oCtx.lineDashOffset = (dashOffset + 4) / zoom;
            oCtx.strokeStyle = '#ffffff';
            oCtx.stroke(engine.selectionManager.contourPath);

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
              const r = engine.selectionManager.calculateConstrainedRect(
                dragStartPoint,
                currentDragPoint,
                selectionSettings
              );
              oCtx.fillRect(r.left, r.top, r.width, r.height);
              oCtx.strokeRect(r.left, r.top, r.width, r.height);
            } else if (activeTool === 'select-ellipse') {
              const r = engine.selectionManager.calculateConstrainedRect(
                dragStartPoint,
                currentDragPoint,
                selectionSettings
              );
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

          // 6. INTERFEJS EDYCJI KRZYWEJ BEZIERA NA ŻYWO (P0, P1, P2, P3, ŚRODEK) - PUSTE ZNACZNIKI
          if (activeVectorBezierSession) {
            const { p0, p1, p2, p3 } = activeVectorBezierSession;
            const mid: SKPoint = { x: (p0.x + p3.x) / 2, y: (p0.y + p3.y) / 2 };

            oCtx.save();

            // Linie pomocnicze stycznych (P0-P1 oraz P3-P2)
            oCtx.lineWidth = 1 / zoom;
            oCtx.strokeStyle = 'rgba(168, 85, 247, 0.7)';
            oCtx.setLineDash([3 / zoom, 3 / zoom]);

            oCtx.beginPath();
            oCtx.moveTo(p0.x, p0.y);
            oCtx.lineTo(p1.x, p1.y);
            oCtx.moveTo(p3.x, p3.y);
            oCtx.lineTo(p2.x, p2.y);
            oCtx.stroke();
            oCtx.setLineDash([]);
            oCtx.restore();

            const drawHollowRing = (pt: SKPoint, isHover: boolean, rPx: number = 6) => {
              const r = rPx / zoom;
              oCtx.save();
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 2.5 / zoom;
              oCtx.beginPath();
              oCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
              oCtx.stroke();

              oCtx.strokeStyle = isHover ? '#00e5ff' : '#ffffff';
              oCtx.lineWidth = 1.2 / zoom;
              oCtx.beginPath();
              oCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
              oCtx.stroke();
              oCtx.restore();
            };

            const drawHollowDiamond = (pt: SKPoint, isHover: boolean, rPx: number = 6) => {
              const d = rPx / zoom;
              oCtx.save();
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 2.5 / zoom;
              oCtx.beginPath();
              oCtx.moveTo(pt.x, pt.y - d);
              oCtx.lineTo(pt.x + d, pt.y);
              oCtx.lineTo(pt.x, pt.y + d);
              oCtx.lineTo(pt.x - d, pt.y);
              oCtx.closePath();
              oCtx.stroke();

              oCtx.strokeStyle = isHover ? '#00e5ff' : '#a855f7';
              oCtx.lineWidth = 1.2 / zoom;
              oCtx.beginPath();
              oCtx.moveTo(pt.x, pt.y - d);
              oCtx.lineTo(pt.x + d, pt.y);
              oCtx.lineTo(pt.x, pt.y + d);
              oCtx.lineTo(pt.x - d, pt.y);
              oCtx.closePath();
              oCtx.stroke();
              oCtx.restore();
            };

            // P0 i P3 (kotwice - puste okręgi)
            drawHollowRing(p0, hoverVectorHandle === 'p0', 6);
            drawHollowRing(p3, hoverVectorHandle === 'p3', 6);

            // P1 i P2 (uchwyty kontrolne - puste romby)
            drawHollowDiamond(p1, hoverVectorHandle === 'p1', 6);
            drawHollowDiamond(p2, hoverVectorHandle === 'p2', 6);

            // Środek
            drawHollowRing(mid, hoverVectorHandle === 'move', 4);
          }

          // 7. INTERFEJS EDYCJI FIGURY NA ŻYWO (RAMKA, 8 UCHWYTÓW, OBRÓT, MODYFIKATOR)
          if (activeVectorShapeSession) {
            const sess = activeVectorShapeSession;
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
            if (hasShapeModifier(vectorShapeSettings.shapeKind)) {
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
          if (isTransformTool && engine.selectionManager.transformState) {
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

          if (cursorPosRef.current && isSelectionTool) {
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

            // 3. Rysujemy modyfikator obok plusika (+ / - / ∩)
            const mode = selectionSettings.mode;
            let badge = '';
            if (mode === 'add') badge = '+';
            else if (mode === 'subtract') badge = '-';
            else if (mode === 'intersect') badge = '∩';

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

    let mode = selectionSettings.mode;
    if (e.shiftKey && e.altKey) {
      mode = 'intersect';
    } else if (e.altKey) {
      mode = 'subtract';
    } else if (e.shiftKey) {
      mode = 'add';
    }

    return {
      ...selectionSettings,
      mode,
    };
  };

  // POINTER DOWN
  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || isSpacePressed || activeTool === 'pan') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
      return;
    }

    if (e.button !== 0 && !((activeTool === 'correction-brush' || activeTool === 'deform') && e.button === 2)) return;

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

    // SZYBKA PIPETA (Ctrl + Klik / Przeciąganie we wszystkich narzędziach rysowania) lub narzędzie pipety
    const isQuickPipette = (e.ctrlKey || e.metaKey || isCtrlKeyDown) && isDrawingTool(activeTool) && activeTool !== 'stamp';
    if (activeTool === 'pipette' || isQuickPipette) {
      isSamplingPipetteRef.current = true;
      setIsDrawingSynced(true);
      const color = engine.pickColor(
        pt.x,
        pt.y,
        pipetteSettings?.sampleSource || 'image',
        pipetteSettings?.sampleDiameter || 1
      );
      onPipettePick(color);
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
      if (isDrawingTool(activeTool) || activeTool === 'transform-content') {
        onShowToast?.('Warstwa jest zablokowana');
        return;
      }
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
    if (vecHit) {
      setActiveVectorHandleSynced(vecHit);
      vectorDragStartPtRef.current = pt;
      if (activeVectorLineSession) {
        vectorInitialSessionStateRef.current = { ...activeVectorLineSession };
      } else if (activeVectorBezierSession) {
        vectorInitialSessionStateRef.current = { ...activeVectorBezierSession };
      } else if (activeVectorShapeSession) {
        vectorInitialSessionStateRef.current = {
          ...activeVectorShapeSession,
          settings: { ...vectorShapeSettings },
        };
      }
      return;
    }

    // JEŚLI KLIKNIĘTO POZA ISTNIEJĄCĄ SESJĄ WEKTOROWĄ LUB TRANSFORMACJĄ, ZATWIERDŹ POPRZEDNIĄ
    if (
      activeTool === 'line' ||
      activeTool === 'bezier' ||
      activeTool === 'shapes' ||
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
      }
    }

    if (activeTool === 'line' || activeTool === 'bezier' || activeTool === 'shapes') {
      if (activeVectorLineSession || activeVectorBezierSession || activeVectorShapeSession) {
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
      setDragStartPointSynced(pt);
      setCurrentDragPoint(pt);
      setLassoPoints([pt]);
      setIsDrawingSynced(true);
      return;
    }

    if (activeTool === 'bucket') {
      const sp = engine.bucketSeedPoint;
      if (sp && Math.hypot(pt.x - sp.x, pt.y - sp.y) * zoom <= 16) {
        setIsDraggingBucketHandle(true);
        return;
      }
      engine.applyPaintBucket(pt, selectionSettings, brushSettings, true);
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

      setDragStartPointSynced(pt);
      setCurrentDragPoint(pt);
      setIsDrawingSynced(true);
      engine.applyGradient(
        pt,
        pt,
        gradientSettings,
        primaryColor,
        secondaryColor,
        gradientSettings.blendMode || 'SrcOver',
        true
      );
      onCanvasModified();
      return;
    }

    if (activeTool === 'brush' || activeTool === 'eraser') {
      setIsDrawingSynced(true);
      const isEraser = activeTool === 'eraser';

      if (e.shiftKey && lastBrushStrokeDocPointRef.current) {
        const fromPt = lastBrushStrokeDocPointRef.current;
        const toPt = pt;
        const strokeResult1 = engine.brushEngine.beginStroke(fromPt, layer, brushSettings, isEraser);
        const strokeResult2 = engine.brushEngine.continueStroke(toPt, layer, brushSettings, isEraser);

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
        const strokeResult = engine.brushEngine.beginStroke(pt, layer, brushSettings, isEraser);

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
      if (activeTool === 'line' || activeTool === 'bezier' || activeTool === 'shapes') {
        updateInitialDrawingDrag(pt, e.shiftKey, e.altKey);
        return;
      }
    }

    if (isDraggingWandHandle && pt) {
      engine.refreshMagicWand(selectionSettings, pt);
      onCanvasModified();
      return;
    }

    if (isDraggingBucketHandle && pt) {
      engine.applyPaintBucket(pt, selectionSettings, brushSettings, false);
      onCanvasModified();
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
          false
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
          false
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
          false
        );
        onCanvasModified();
        return;
      }
      if (isDrawing && pt && dragStartPoint) {
        setCurrentDragPoint(pt);
        engine.applyGradient(
          dragStartPoint,
          pt,
          gradientSettings,
          primaryColor,
          secondaryColor,
          gradientSettings.blendMode || 'SrcOver',
          false
        );
        onCanvasModified();
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
        onPipettePick(color);
      }
      return;
    }

    if (!isDrawing || !pt) return;

    const layer = engine.getActiveLayer();
    if (!layer) return;

    if (activeTool === 'select-rect' || activeTool === 'select-ellipse') {
      setCurrentDragPoint(pt);
      return;
    }

    if (activeTool === 'select-lasso') {
      setCurrentDragPoint(pt);
      setLassoPoints((prev) => [...prev, pt]);
      return;
    }

    if (activeTool === 'brush' || activeTool === 'eraser') {
      const isEraser = activeTool === 'eraser';
      const native = e.nativeEvent as PointerEvent;
      const events: (React.PointerEvent | PointerEvent)[] =
        typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
          ? native.getCoalescedEvents()
          : [e];

      for (const ev of events) {
        const subPt = getDocPoint(ev);
        if (!subPt) continue;
        const strokeResult = engine.brushEngine.continueStroke(subPt, layer, brushSettings, isEraser);

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

    if (isPanning) {
      setIsPanning(false);
      return;
    }

    // ZAKOŃCZENIE PRZECIĄGANIA UCHWYTU WEKTOROWEGO
    if (activeVectorHandle) {
      setActiveVectorHandleSynced(null);
      vectorDragStartPtRef.current = null;
      vectorInitialSessionStateRef.current = null;
      redraw();
      return;
    }

    // ZAKOŃCZENIE TRANSFORMACJI ZAZNACZENIA
    if (isTransformTool && transformActiveHandle) {
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
      if (wandDragInitialSnapshotRef.current) {
        const finalSnapshot = engine.selectionManager.getMaskSnapshot();
        engine.pushSelectionAction(
          wandDragInitialSnapshotRef.current,
          finalSnapshot,
          'Przeniesienie punktu różdżki'
        );
        wandDragInitialSnapshotRef.current = null;
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
          engine.applyGradient(
            dragStartPoint,
            pt,
            gradientSettings,
            primaryColor,
            secondaryColor,
            gradientSettings.blendMode || 'SrcOver',
            false
          );
        }
        setDragStartPointSynced(null);
        setCurrentDragPoint(null);
        onCanvasModified();
        return;
      }
    }

    // ZAKOŃCZENIE POCZĄTKOWEGO RYSOWANIA WEKTOROWEGO
    if (activeTool === 'line' || activeTool === 'bezier' || activeTool === 'shapes') {
      setIsDrawingSynced(false);
      setDragStartPointSynced(null);
      setCurrentDragPoint(null);
      redraw();
      return;
    }

    // ZAKOŃCZENIE PRÓBKOWANIA PIPETY / SZYBKIEJ PIPETY
    if (activeTool === 'pipette' || isSamplingPipetteRef.current) {
      isSamplingPipetteRef.current = false;
      setIsDrawingSynced(false);
      return;
    }

    if (!isDrawing) return;
    setIsDrawingSynced(false);

    const layer = engine.getActiveLayer();

    if ((activeTool === 'select-rect' || activeTool === 'select-ellipse') && dragStartPoint && currentDragPoint) {
      const dist = Math.hypot(
        currentDragPoint.x - dragStartPoint.x,
        currentDragPoint.y - dragStartPoint.y
      );
      const isFixedSize = selectionSettings.constraint === 'fixed-size';
      // W trybie ustalonych wymiarów pojedyncze kliknięcie lub przeciągnięcie wyznacza lewy górny narożnik
      // W trybie dowolnym i ustalonych proporcji pojedyncze kliknięcie (< 3 px) nie tworzy zaznaczenia
      if (isFixedSize || dist >= 3) {
        engine.applySelectionShape(
          activeTool === 'select-rect' ? 'rect' : 'ellipse',
          [dragStartPoint, currentDragPoint],
          getModifiedSelectionSettings(e)
        );
        onCanvasModified();
      }
      setDragStartPointSynced(null);
      setCurrentDragPoint(null);
      return;
    }

    if (activeTool === 'select-lasso') {
      let maxDist = 0;
      if (lassoPoints.length > 2 && dragStartPoint) {
        for (const lp of lassoPoints) {
          const d = Math.hypot(lp.x - dragStartPoint.x, lp.y - dragStartPoint.y);
          if (d > maxDist) maxDist = d;
        }
      }
      // Pojedyncze kliknięcie / brak przeciągnięcia nie modyfikuje zaznaczenia
      if (lassoPoints.length > 2 && maxDist >= 3) {
        engine.applySelectionShape('lasso', lassoPoints, getModifiedSelectionSettings(e));
        onCanvasModified();
      }
      setDragStartPointSynced(null);
      setCurrentDragPoint(null);
      setLassoPoints([]);
      return;
    }

    if (activeTool === 'brush' || activeTool === 'eraser') {
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
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
          engine.compositeToViewport(canvasRef.current, endResult.dirtyRect);
        }
      }
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
        });

        if (canvasRef.current) {
          engine.compositeToViewport(canvasRef.current, endResult.dirtyRect);
        }
      }
      onCanvasModified();
    }
  };

  // KURSOR MYSZY
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
      activeTool === 'pipette' ||
      isQuickPipetteActive
    ) {
      return 'none';
    }
    if (isAnyVectorSessionActive && hoverVectorHandle) {
      if (hoverVectorHandle === 'move') return 'move';
      if (hoverVectorHandle === 'modifier' || hoverVectorHandle === 'modifier-shaft') return 'crosshair';
      if (hoverVectorHandle === 'rotate') {
        const boxAngleDeg = Math.round(
          ((activeVectorShapeSession?.angle || 0) * 180) / Math.PI
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
      if (h === 'pivot' || h === 'move') return 'move';
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
      return 'default';
    }
    if (activeTool.startsWith('select') || activeTool === 'magic-wand') {
      return 'none';
    }
    if (activeTool === 'line' || activeTool === 'bezier' || activeTool === 'shapes') {
      return 'crosshair';
    }
    if (activeTool === 'gradient') {
      if (gradientHoverHandle !== null || isDraggingGradientHandle !== null) {
        return 'move';
      }
      return 'crosshair';
    }
    return 'default';
  };

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
  const screenLeft = screenCenterX - screenWidth / 2;
  const screenTop = screenCenterY - screenHeight / 2;

  return (
    <div
      ref={containerRef}
      onContextMenu={(e) => e.preventDefault()}
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
      style={{ cursor: getCursorStyle() }}
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
        ref={overlayCanvasRef}
        className="absolute inset-0 pointer-events-none z-30"
      />
    </div>
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
