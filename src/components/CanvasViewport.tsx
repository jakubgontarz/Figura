/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { GraphicEngine } from '../core/skia/GraphicEngine.ts';
import {
  BrushSettings,
  GradientSettings,
  PipetteSettings,
  SKColor,
  SKPoint,
  SelectionSettings,
  ToolType,
  skColorToHex,
  skColorToRgbaString,
} from '../core/skia/types.ts';
import { TransformSelectionState } from '../core/skia/SelectionManager.ts';

interface CanvasViewportProps {
  engine: GraphicEngine;
  engineRevision: number;
  brushSettings: BrushSettings;
  selectionSettings: SelectionSettings;
  pipetteSettings?: PipetteSettings;
  gradientSettings?: GradientSettings;
  primaryColor?: SKColor;
  secondaryColor?: SKColor;
  onChangeSelectionSettings?: (settings: Partial<SelectionSettings>) => void;
  activeTool: ToolType;
  activeShapeType: 'rect' | 'ellipse' | 'line';
  zoom: number;
  panOffset: { x: number; y: number };
  onUpdateZoom: (zoom: number) => void;
  onUpdatePan: (offset: { x: number; y: number }) => void;
  onPipettePick: (color: SKColor) => void;
  onCanvasModified: () => void;
  showTileDebug: boolean;
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
  | 'rotate-nw'
  | 'rotate-ne'
  | 'rotate-se'
  | 'rotate-sw'
  | 'move'
  | null;

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
  const span = (55 * Math.PI) / 180; // 55 stopni w każdą stronę (łącznie 110 stopni wyraźnego łuku)

  const cosSpan = Math.cos(span);
  const sinSpan = Math.sin(span);

  // Punkt 1 (górny): kąt -span
  const p1x = r * cosSpan;
  const p1y = -r * sinSpan;
  const dir1x = -sinSpan;
  const dir1y = -cosSpan;

  // Punkt 2 (dolny): kąt +span
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

    // 1. Wyraźny łuk łączący groty strzałek
    ctx.beginPath();
    ctx.arc(0, 0, r, -span, span, false);
    ctx.stroke();

    // 2. Grot strzałki 1 (górny)
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

    // 3. Grot strzałki 2 (dolny)
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

  // Warstwa 1: Gruba biała sylwetka (zapewnia kontrast na ciemnym, szarym i kolorowym tle)
  drawCursorShape(true);
  // Warstwa 2: Wyrazisty ciemny rdzeń (łuk + wypełnione groty)
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
  selectionSettings,
  pipetteSettings,
  gradientSettings = { type: 'linear', repeat: 'none', reverse: false },
  primaryColor = { r: 0, g: 0, b: 0, a: 255 },
  secondaryColor = { r: 255, g: 255, b: 255, a: 255 },
  activeTool,
  activeShapeType,
  zoom,
  panOffset,
  onUpdateZoom,
  onUpdatePan,
  onPipettePick,
  onCanvasModified,
  showTileDebug,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  const [isDrawing, setIsDrawing] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

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
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const [dragStartPoint, setDragStartPoint] = useState<SKPoint | null>(null);
  const [currentDragPoint, setCurrentDragPoint] = useState<SKPoint | null>(null);
  const [lassoPoints, setLassoPoints] = useState<SKPoint[]>([]);
  const [isDraggingWandHandle, setIsDraggingWandHandle] = useState(false);
  const [isDraggingBucketHandle, setIsDraggingBucketHandle] = useState(false);
  const [isDraggingGradientHandle, setIsDraggingGradientHandle] = useState<0 | 1 | null>(null);
  const [gradientHoverHandle, setGradientHoverHandle] = useState<0 | 1 | null>(null);
  const wandDragInitialSnapshotRef = useRef<{ imgData: ImageData | null; seedPoint: SKPoint | null } | null>(null);

  // Stan manipulacji narzędzia Przekształć Zaznaczenie / Zawartość
  const [transformActiveHandle, setTransformActiveHandle] = useState<TransformHandleType>(null);
  const transformActiveHandleRef = useRef<TransformHandleType>(null);
  const lastTransformPtRef = useRef<SKPoint | null>(null);
  const updateTransformInteractionRef = useRef<((pt: SKPoint, shiftKey: boolean, altKey: boolean) => void) | null>(null);

  const setTransformActiveHandleSynced = (handle: TransformHandleType) => {
    transformActiveHandleRef.current = handle;
    setTransformActiveHandle(handle);
  };

  const [transformHoverHandle, setTransformHoverHandle] = useState<TransformHandleType>(null);
  const transformInitialStateRef = useRef<TransformSelectionState | null>(null);
  const transformDragStartDocPtRef = useRef<SKPoint | null>(null);
  const transformInitialHistorySnapshotRef = useRef<{ imgData: ImageData | null; seedPoint: SKPoint | null } | null>(null);

  const isTransformTool = activeTool === 'transform-selection' || activeTool === 'transform-content';
  const cursorPosRef = useRef<{ x: number; y: number } | null>(null);

  // Inicjalizacja i zamykanie sesji przekształcania (Zaznaczenie vs Zawartość pikselowa)
  useEffect(() => {
    if (activeTool === 'transform-content') {
      if (!engine.transformContentSession) {
        engine.beginTransformContent(selectionSettings.interpolation || 'bilinear');
        onCanvasModified();
      }
    } else if (activeTool === 'transform-selection') {
      if (engine.transformContentSession) {
        engine.commitTransformContent();
        onCanvasModified();
      }
      if (engine.selectionManager.hasActiveSelection && !engine.selectionManager.transformState) {
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
  }, [activeTool, engine, selectionSettings.interpolation, onCanvasModified]);

  // Dynamiczna zmiana próbkowania (interpolacji) dla transformacji zawartości na żywo
  useEffect(() => {
    if (activeTool === 'transform-content' && engine.transformContentSession) {
      engine.updateTransformContentInterpolation(selectionSettings.interpolation || 'bilinear');
      onCanvasModified();
    }
  }, [selectionSettings.interpolation, activeTool, engine, onCanvasModified]);

  // Dynamiczna zmiana czułości, trybu wypełnienia lub próbkowania różdżki na żywo
  useEffect(() => {
    if (
      activeTool === 'magic-wand' &&
      engine.selectionManager.wandSeedPoint &&
      engine.selectionManager.hasActiveSelection
    ) {
      engine.refreshMagicWand(selectionSettings);
      onCanvasModified();
    }
  }, [
    selectionSettings.tolerance,
    selectionSettings.wandMode,
    selectionSettings.sampleSource,
    selectionSettings.mode,
    activeTool,
    engine,
    selectionSettings,
    onCanvasModified,
  ]);

  // Dynamiczna zmiana parametrów, próbkowania, koloru lub trybu mieszania dla wiaderka z wodą na żywo
  useEffect(() => {
    if (activeTool === 'bucket' && engine.bucketSeedPoint) {
      engine.applyPaintBucket(engine.bucketSeedPoint, selectionSettings, brushSettings, false);
      onCanvasModified();
    }
  }, [
    selectionSettings.tolerance,
    selectionSettings.wandMode,
    selectionSettings.sampleSource,
    brushSettings.color.r,
    brushSettings.color.g,
    brushSettings.color.b,
    brushSettings.color.a,
    brushSettings.blendMode,
    activeTool,
    engine,
    selectionSettings,
    brushSettings,
    onCanvasModified,
  ]);

  // Czyszczenie sesji i uchwytu wiaderka przy przełączeniu na inne narzędzie
  useEffect(() => {
    if (activeTool !== 'bucket' && engine.bucketSeedPoint) {
      engine.commitPaintBucketSession();
      onCanvasModified();
    }
  }, [activeTool, engine, onCanvasModified]);

  // Dynamiczna zmiana parametrów, kolorów lub trybu mieszania dla wypełnienia gradientowego na żywo
  useEffect(() => {
    if (activeTool === 'gradient' && engine.gradientStartPoint && engine.gradientEndPoint) {
      engine.applyGradient(
        engine.gradientStartPoint,
        engine.gradientEndPoint,
        gradientSettings,
        primaryColor,
        secondaryColor,
        brushSettings.blendMode,
        false
      );
      onCanvasModified();
    }
  }, [
    gradientSettings.type,
    gradientSettings.repeat,
    gradientSettings.reverse,
    primaryColor.r,
    primaryColor.g,
    primaryColor.b,
    primaryColor.a,
    secondaryColor.r,
    secondaryColor.g,
    secondaryColor.b,
    secondaryColor.a,
    brushSettings.blendMode,
    activeTool,
    engine,
    gradientSettings,
    primaryColor,
    secondaryColor,
    brushSettings,
    onCanvasModified,
  ]);

  // Czyszczenie sesji i zatwierdzanie gradientu przy przełączeniu na inne narzędzie
  useEffect(() => {
    if (activeTool !== 'gradient' && engine.gradientStartPoint) {
      engine.commitGradientSession();
      onCanvasModified();
    }
  }, [activeTool, engine, onCanvasModified]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
      if (e.key === 'Shift' || e.key === 'Alt') {
        if (transformActiveHandleRef.current && lastTransformPtRef.current && updateTransformInteractionRef.current) {
          updateTransformInteractionRef.current(lastTransformPtRef.current, e.shiftKey, e.altKey);
        }
      }
      if (e.code === 'Space' && !isSpacePressed) {
        setIsSpacePressed(true);
      }
      if (e.key === 'Escape') {
        if (engine.transformContentSession) {
          engine.cancelTransformContent();
          onCanvasModified();
        } else if (engine.selectionManager.transformState) {
          engine.selectionManager.cancelTransformSelection();
          onCanvasModified();
        }
      } else if (e.key === 'Enter') {
        if (engine.transformContentSession) {
          engine.commitTransformContent();
          onCanvasModified();
        } else if (engine.selectionManager.transformState) {
          engine.selectionManager.commitTransformSelection();
          onCanvasModified();
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Alt') {
        if (transformActiveHandleRef.current && lastTransformPtRef.current && updateTransformInteractionRef.current) {
          updateTransformInteractionRef.current(lastTransformPtRef.current, e.shiftKey, e.altKey);
        }
      }
      if (e.code === 'Space') {
        setIsSpacePressed(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isSpacePressed, engine, onCanvasModified]);

  useEffect(() => {
    engine.showTileGridDebug = showTileDebug;
    if (canvasRef.current) {
      engine.compositeToViewport(canvasRef.current);
    }
  }, [engine, showTileDebug]);

  const redraw = useCallback(() => {
    if (canvasRef.current) {
      engine.compositeToViewport(canvasRef.current);
    }
  }, [engine]);

  useEffect(() => {
    redraw();
  }, [redraw, engineRevision, engine.width, engine.height, engine.activeLayerIndex]);

  const getDocPoint = useCallback(
    (e: React.PointerEvent | PointerEvent | MouseEvent, clamp: boolean = false): SKPoint | null => {
      if (!canvasRef.current) return null;
      const rect = canvasRef.current.getBoundingClientRect();
      const docX = rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * engine.width : (e.clientX - rect.left) / zoom;
      const docY = rect.height > 0 ? ((e.clientY - rect.top) / rect.height) * engine.height : (e.clientY - rect.top) / zoom;
      if (clamp) {
        return {
          x: Math.max(0, Math.min(engine.width, docX)),
          y: Math.max(0, Math.min(engine.height, docY)),
        };
      }
      return {
        x: docX,
        y: docY,
      };
    },
    [engine.width, engine.height, zoom]
  );

  const updateStatusBarPos = (pt: SKPoint | null) => {
    const el = document.getElementById('status-bar-cursor-pos');
    if (el) {
      el.textContent = pt ? `Pozycja: ${Math.floor(pt.x)}, ${Math.floor(pt.y)}` : 'Pozycja: 0, 0';
    }
  };

  // Oblicza pozycje narożników, uchwytów i środka w przestrzeni ekranowej
  const getTransformScreenGeometry = useCallback(() => {
    const st = engine.selectionManager.transformState;
    const container = containerRef.current;
    if (!st || !container) return null;

    const cWidth = container.clientWidth;
    const cHeight = container.clientHeight;
    const screenCenterX = cWidth / 2 + panOffset.x;
    const screenCenterY = cHeight / 2 + panOffset.y;

    const docToScreen = (pt: SKPoint): SKPoint => {
      return {
        x: (pt.x - engine.width / 2) * zoom + screenCenterX,
        y: (pt.y - engine.height / 2) * zoom + screenCenterY,
      };
    };

    // Znormalizowane punkty w lokalnym układzie ramki (u, v) w [-0.5, 0.5]
    const localCoords: { [key: string]: { u: number; v: number } } = {
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

    const docHandles: { [key: string]: SKPoint } = {};
    const screenHandles: { [key: string]: SKPoint } = {};

    for (const [key, lc] of Object.entries(localCoords)) {
      const lx = lc.u * st.width;
      const ly = lc.v * st.height;
      const rx = lx * cos - ly * sin;
      const ry = lx * sin + ly * cos;

      const dpt: SKPoint = {
        x: st.pos.x + rx,
        y: st.pos.y + ry,
      };
      docHandles[key] = dpt;
      screenHandles[key] = docToScreen(dpt);
    }

    const curPivotDoc: SKPoint = {
      x: st.pivot.x,
      y: st.pivot.y,
    };
    const curPivotScreen = docToScreen(curPivotDoc);

    return {
      docHandles,
      screenHandles,
      pivotDoc: curPivotDoc,
      pivotScreen: curPivotScreen,
    };
  }, [engine, zoom, panOffset]);

  // Wykrywanie uchwytu pod kursorem w pikselach ekranu
  const hitTestTransformHandles = useCallback(
    (e: React.PointerEvent | PointerEvent | MouseEvent): TransformHandleType => {
      const geom = getTransformScreenGeometry();
      const container = containerRef.current;
      if (!geom || !container) return null;

      const rect = container.getBoundingClientRect();
      const mouseScreenX = e.clientX - rect.left;
      const mouseScreenY = e.clientY - rect.top;

      // 1. Sprawdź środek ciężkości (pivot) - promień 8px ekranu
      if (Math.hypot(mouseScreenX - geom.pivotScreen.x, mouseScreenY - geom.pivotScreen.y) <= 8) {
        return 'pivot';
      }

      // 2. Sprawdź 8 uchwytów skalowania - kwadraty 8x8px ekranu
      const handleKeys: (keyof typeof geom.screenHandles)[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      for (const k of handleKeys) {
        const hp = geom.screenHandles[k];
        if (Math.abs(mouseScreenX - hp.x) <= 6 && Math.abs(mouseScreenY - hp.y) <= 6) {
          return k as TransformHandleType;
        }
      }

      // 3. Sprawdź strefę obrotu na zewnątrz 4 narożników (odległość 8px do 26px od naroża)
      const cornerKeys: (keyof typeof geom.screenHandles)[] = ['nw', 'ne', 'se', 'sw'];
      for (const k of cornerKeys) {
        const hp = geom.screenHandles[k];
        const dist = Math.hypot(mouseScreenX - hp.x, mouseScreenY - hp.y);
        if (dist > 6 && dist <= 26) {
          return `rotate-${k}` as TransformHandleType;
        }
      }

      // 4. Sprawdź czy kursor jest wewnątrz przekształcanego wielokąta
      const poly = [
        geom.screenHandles.nw,
        geom.screenHandles.ne,
        geom.screenHandles.se,
        geom.screenHandles.sw,
      ];
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x,
          yi = poly[i].y;
        const xj = poly[j].x,
          yj = poly[j].y;
        const intersect = yi > mouseScreenY !== yj > mouseScreenY && mouseScreenX < ((xj - xi) * (mouseScreenY - yi)) / (yj - yi) + xi;
        if (intersect) inside = !inside;
      }

      if (inside) {
        return 'move';
      }

      return null;
    },
    [getTransformScreenGeometry]
  );

  // RENDEROWANIE NAKŁADKI: MASZERUJĄCE MRÓWKI ORAZ EKRANOWY INTERFEJS TRANSFORMACJI
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

          // 1. MASZERUJĄCE MRÓWKI (Wektorowa ścieżka maski w 1px pikseli ekranu)
          // Podczas manipulacji zawartością (trzymanie przycisku) nie renderujemy mrówek.
          // Dopiero po puszczeniu przycisku myszy lub podczas manipulacji samym zaznaczeniem.
          const isTransformingContentActive = activeTool === 'transform-content' && transformActiveHandle !== null;

          if (engine.selectionManager.hasActiveSelection && !isTransformingContentActive) {
            const time = performance.now();
            const dashOffset = (time / 60) % 8;

            oCtx.save();
            oCtx.lineWidth = 1 / zoom;
            oCtx.setLineDash([4 / zoom, 4 / zoom]);

            // Pass 1: Czarny
            oCtx.lineDashOffset = dashOffset / zoom;
            oCtx.strokeStyle = '#000000';
            oCtx.stroke(engine.selectionManager.contourPath);

            // Pass 2: Biały
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

          // 3. UCHWYT MAGICZNEJ RÓŻDŻKI LUB WIADRA Z WODĄ
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

          // 3b. UCHWYTY WYPEŁNIENIA GRADIENTOWEGO (PUNKT 1 I PUNKT 2 ORAZ LINIA ŁĄCZĄCA)
          if (activeTool === 'gradient' && engine.gradientStartPoint && engine.gradientEndPoint) {
            const p0 = engine.gradientStartPoint;
            const p1 = engine.gradientEndPoint;

            oCtx.save();

            // Cień / obrys linii łączącej
            oCtx.lineWidth = 3 / zoom;
            oCtx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            oCtx.beginPath();
            oCtx.moveTo(p0.x, p0.y);
            oCtx.lineTo(p1.x, p1.y);
            oCtx.stroke();

            // Linia główna
            oCtx.lineWidth = 1.5 / zoom;
            oCtx.strokeStyle = '#ffffff';
            oCtx.beginPath();
            oCtx.moveTo(p0.x, p0.y);
            oCtx.lineTo(p1.x, p1.y);
            oCtx.stroke();

            // Przerywana linia kontrastowa
            oCtx.setLineDash([4 / zoom, 3 / zoom]);
            oCtx.strokeStyle = '#007acc';
            oCtx.beginPath();
            oCtx.moveTo(p0.x, p0.y);
            oCtx.lineTo(p1.x, p1.y);
            oCtx.stroke();
            oCtx.setLineDash([]);

            const c0 = gradientSettings.reverse ? secondaryColor : primaryColor;
            const c1 = gradientSettings.reverse ? primaryColor : secondaryColor;

            // Uchwyt 0 (Start)
            const r0 = (gradientHoverHandle === 0 || isDraggingGradientHandle === 0 ? 9 : 7) / zoom;
            oCtx.fillStyle = `rgba(${c0.r}, ${c0.g}, ${c0.b}, ${c0.a / 255})`;
            oCtx.strokeStyle = '#ffffff';
            oCtx.lineWidth = 2.5 / zoom;
            oCtx.beginPath();
            oCtx.arc(p0.x, p0.y, r0, 0, Math.PI * 2);
            oCtx.fill();
            oCtx.stroke();
            oCtx.strokeStyle = '#111111';
            oCtx.lineWidth = 1 / zoom;
            oCtx.stroke();

            // Etykietka "1"
            oCtx.font = `bold ${Math.max(8, 10 / zoom)}px sans-serif`;
            oCtx.textAlign = 'center';
            oCtx.textBaseline = 'middle';
            oCtx.fillStyle = '#ffffff';
            oCtx.strokeStyle = '#000000';
            oCtx.lineWidth = 2 / zoom;
            oCtx.strokeText('1', p0.x, p0.y - (r0 + 8 / zoom));
            oCtx.fillText('1', p0.x, p0.y - (r0 + 8 / zoom));

            // Uchwyt 1 (Koniec)
            const r1 = (gradientHoverHandle === 1 || isDraggingGradientHandle === 1 ? 9 : 7) / zoom;
            oCtx.fillStyle = `rgba(${c1.r}, ${c1.g}, ${c1.b}, ${c1.a / 255})`;
            oCtx.strokeStyle = '#ffffff';
            oCtx.lineWidth = 2.5 / zoom;
            oCtx.beginPath();
            oCtx.arc(p1.x, p1.y, r1, 0, Math.PI * 2);
            oCtx.fill();
            oCtx.stroke();
            oCtx.strokeStyle = '#111111';
            oCtx.lineWidth = 1 / zoom;
            oCtx.stroke();

            // Etykietka "2"
            oCtx.font = `bold ${Math.max(8, 10 / zoom)}px sans-serif`;
            oCtx.textAlign = 'center';
            oCtx.textBaseline = 'middle';
            oCtx.fillStyle = '#ffffff';
            oCtx.strokeStyle = '#000000';
            oCtx.lineWidth = 2 / zoom;
            oCtx.strokeText('2', p1.x, p1.y - (r1 + 8 / zoom));
            oCtx.fillText('2', p1.x, p1.y - (r1 + 8 / zoom));

            oCtx.restore();
          }

          oCtx.restore();

          // 4. RENDEROWANIE RAMKI I UCHWYTÓW NARZĘDZIA TRANSFORMACJI (ZAZNACZENIA LUB ZAWARTOŚCI) W PIKSELACH EKRANU
          if (isTransformTool && engine.selectionManager.transformState) {
            const geom = getTransformScreenGeometry();
            if (geom) {
              const sh = geom.screenHandles;
              const isContent = activeTool === 'transform-content';
              oCtx.save();

              // Linia ramki (1px na ekranie, cyan dla zaznaczenia, złoty dla zawartości)
              oCtx.lineWidth = 1;
              oCtx.strokeStyle = isContent ? '#facc15' : '#00e5ff';
              oCtx.setLineDash([4, 4]);
              oCtx.beginPath();
              oCtx.moveTo(sh.nw.x, sh.nw.y);
              oCtx.lineTo(sh.ne.x, sh.ne.y);
              oCtx.lineTo(sh.se.x, sh.se.y);
              oCtx.lineTo(sh.sw.x, sh.sw.y);
              oCtx.closePath();
              oCtx.stroke();
              oCtx.setLineDash([]);

              // 8 Uchwytów skalowania w pikselach ekranu (8x8 px)
              const handleSize = 8;
              const handleKeys = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;

              for (const hk of handleKeys) {
                const pt = sh[hk];
                oCtx.fillStyle = '#ffffff';
                oCtx.strokeStyle = isContent ? '#854d0e' : '#003344';
                oCtx.lineWidth = 1.5;

                oCtx.fillRect(pt.x - handleSize / 2, pt.y - handleSize / 2, handleSize, handleSize);
                oCtx.strokeRect(pt.x - handleSize / 2, pt.y - handleSize / 2, handleSize, handleSize);
              }

              // Środek ciężkości (Pivot / Center of Rotation)
              const pv = geom.pivotScreen;
              oCtx.fillStyle = isContent ? '#facc15' : '#00e5ff';
              oCtx.strokeStyle = '#ffffff';
              oCtx.lineWidth = 1.5;

              oCtx.beginPath();
              oCtx.arc(pv.x, pv.y, 4.5, 0, Math.PI * 2);
              oCtx.fill();
              oCtx.stroke();

              // Krzyżyk celownika w środku ciężkości
              oCtx.strokeStyle = '#000000';
              oCtx.lineWidth = 1;
              oCtx.beginPath();
              oCtx.moveTo(pv.x - 7, pv.y);
              oCtx.lineTo(pv.x + 7, pv.y);
              oCtx.moveTo(pv.x, pv.y - 7);
              oCtx.lineTo(pv.x, pv.y + 7);
              oCtx.stroke();

              // Wyświetlanie etykietki kąta obrotu w czasie rzeczywistym
              if (
                transformActiveHandle &&
                transformActiveHandle.startsWith('rotate') &&
                cursorPosRef.current
              ) {
                const curRad = engine.selectionManager.transformState.angle;
                let curDeg = (((curRad * 180) / Math.PI) % 360 + 360) % 360;
                if (curDeg > 180) curDeg -= 360;
                const angleText = `Kąt: ${curDeg.toFixed(1)}°`;

                const tx = cursorPosRef.current.x + 16;
                const ty = cursorPosRef.current.y + 16;

                oCtx.save();
                oCtx.font = '11px sans-serif';
                const textMetrics = oCtx.measureText(angleText);
                const padW = textMetrics.width + 12;
                const padH = 20;

                oCtx.fillStyle = 'rgba(24, 24, 24, 0.9)';
                oCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
                oCtx.lineWidth = 1;
                oCtx.beginPath();
                if (typeof oCtx.roundRect === 'function') {
                  oCtx.roundRect(tx, ty, padW, padH, 4);
                } else {
                  oCtx.rect(tx, ty, padW, padH);
                }
                oCtx.fill();
                oCtx.stroke();

                oCtx.fillStyle = '#ffffff';
                oCtx.textBaseline = 'middle';
                oCtx.textAlign = 'left';
                oCtx.fillText(angleText, tx + 6, ty + padH / 2);
                oCtx.restore();
              }

              oCtx.restore();
            }
          }
        }

        // 5. OBRYS PĘDZLA I GUMKI (3 PIERŚCIENIE WOKÓŁ KURSORA: BIAŁY, CZARNY, BIAŁY)
        if (oCtx && (activeTool === 'brush' || activeTool === 'eraser') && cursorPosRef.current) {
          const { x, y } = cursorPosRef.current;
          const radius = (brushSettings.size / 2) * zoom;

          oCtx.save();

          // Kółko 1 (Zewnętrzne) - Białe 1px
          oCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          oCtx.lineWidth = 1;
          oCtx.beginPath();
          oCtx.arc(x, y, radius + 1, 0, Math.PI * 2);
          oCtx.stroke();

          // Kółko 2 (Środkowe) - Czarne 1px
          oCtx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
          oCtx.lineWidth = 1;
          oCtx.beginPath();
          oCtx.arc(x, y, Math.max(1, radius), 0, Math.PI * 2);
          oCtx.stroke();

          // Kółko 3 (Wewnętrzne) - Białe 1px
          if (radius > 1.5) {
            oCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            oCtx.lineWidth = 1;
            oCtx.beginPath();
            oCtx.arc(x, y, Math.max(0.5, radius - 1), 0, Math.PI * 2);
            oCtx.stroke();
          }

          // Mały celownik 1px w środeczku dla idealnej precyzji
          oCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          oCtx.lineWidth = 1;
          oCtx.beginPath();
          oCtx.moveTo(x - 3, y);
          oCtx.lineTo(x + 3, y);
          oCtx.moveTo(x, y - 3);
          oCtx.lineTo(x, y + 3);
          oCtx.stroke();

          oCtx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
          oCtx.beginPath();
          oCtx.moveTo(x - 1, y);
          oCtx.lineTo(x + 1, y);
          oCtx.moveTo(x, y - 1);
          oCtx.lineTo(x, y + 1);
          oCtx.stroke();

          oCtx.restore();
        }

        // 6. PIPETA: CELOWNIK, OBSZAR ZBIERANIA ORAZ OKRĄGŁA LUPA PRZYBLIŻENIA
        if (oCtx && activeTool === 'pipette' && cursorPosRef.current) {
          const { x, y } = cursorPosRef.current;
          const pSettings = pipetteSettings || { sampleSource: 'image', sampleDiameter: 1, showLoupe: true };
          const diameter = pSettings.sampleDiameter || 1;
          const sampleSource = pSettings.sampleSource || 'image';

          // Przelicz współrzędne ekranowe na współrzędne dokumentu
          const screenCenterX = cWidth / 2 + panOffset.x;
          const screenCenterY = cHeight / 2 + panOffset.y;
          const docX = (x - screenCenterX) / zoom + engine.width / 2;
          const docY = (y - screenCenterY) / zoom + engine.height / 2;

          const isInsideDoc = docX >= 0 && docX < engine.width && docY >= 0 && docY < engine.height;

          // 1. Obrys obszaru zbierania na samym płótnie
          oCtx.save();
          if (diameter > 1) {
            const screenR = (diameter / 2) * zoom;
            // Zewnętrzne kółko 1px białe
            oCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            oCtx.lineWidth = 1;
            oCtx.beginPath();
            oCtx.arc(x, y, screenR + 1, 0, Math.PI * 2);
            oCtx.stroke();

            // Środkowe kółko 1px czarne
            oCtx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
            oCtx.lineWidth = 1;
            oCtx.beginPath();
            oCtx.arc(x, y, screenR, 0, Math.PI * 2);
            oCtx.stroke();

            // Wewnętrzne kółko 1px białe
            if (screenR > 1.5) {
              oCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
              oCtx.lineWidth = 1;
              oCtx.beginPath();
              oCtx.arc(x, y, Math.max(0.5, screenR - 1), 0, Math.PI * 2);
              oCtx.stroke();
            }
          }

          // Precyzyjny krzyżyk celownika pipety w punkcie kliknięcia (biało-czarny)
          oCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          oCtx.lineWidth = 1;
          oCtx.beginPath();
          oCtx.moveTo(x - 6, y);
          oCtx.lineTo(x + 6, y);
          oCtx.moveTo(x, y - 6);
          oCtx.lineTo(x + 6, y);
          oCtx.stroke();

          oCtx.strokeStyle = 'rgba(0, 0, 0, 0.95)';
          oCtx.beginPath();
          oCtx.moveTo(x - 3, y);
          oCtx.lineTo(x + 3, y);
          oCtx.moveTo(x, y - 3);
          oCtx.lineTo(x, y + 3);
          oCtx.stroke();
          oCtx.restore();

          // 2. Okrągły obszar przybliżenia (Lupa)
          if (pSettings.showLoupe && isInsideDoc) {
            const currentLiveColor = engine.pickColor(docX, docY, sampleSource, diameter);
            const outerR = 54;
            const innerR = 40;

            // Ustal pozycję lupy (domyślnie pod kursorem o 72px)
            let loupeX = x;
            let loupeY = y + 72;
            let isFlippedAbove = false;
            // Jeśli kursor jest nisko obszaru rysowania, przenieś lupę nad kursor
            if (loupeY + outerR + 26 > cHeight) {
              loupeY = y - 72;
              isFlippedAbove = true;
            }
            if (loupeX - outerR < 15) loupeX = 15 + outerR;
            if (loupeX + outerR > cWidth - 15) loupeX = cWidth - 15 - outerR;

            oCtx.save();

            // Wskaźnik łączący lupę z punktem pobierania
            oCtx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
            oCtx.lineWidth = 1.5;
            oCtx.beginPath();
            oCtx.moveTo(loupeX, isFlippedAbove ? loupeY + outerR : loupeY - outerR);
            oCtx.lineTo(x, y);
            oCtx.stroke();

            // Cień lupy
            oCtx.shadowColor = 'rgba(0, 0, 0, 0.45)';
            oCtx.shadowBlur = 12;
            oCtx.shadowOffsetY = 4;
            oCtx.beginPath();
            oCtx.arc(loupeX, loupeY, outerR, 0, Math.PI * 2);
            oCtx.fillStyle = '#222222';
            oCtx.fill();
            oCtx.shadowColor = 'transparent';

            // Wycinek przybliżonego obrazu (17x17 px)
            const sampleBoxSize = 17;
            const loupeSampleCanvas = engine.getLoupeSampleCanvas(docX, docY, sampleBoxSize, sampleSource);
            const zoomAreaDiameter = innerR * 2;

            // Obrys okrągłego otworu lupy (clipping mask)
            oCtx.save();
            oCtx.beginPath();
            oCtx.arc(loupeX, loupeY, innerR, 0, Math.PI * 2);
            oCtx.clip();

            oCtx.imageSmoothingEnabled = false;
            oCtx.drawImage(
              loupeSampleCanvas,
              0, 0, sampleBoxSize, sampleBoxSize,
              loupeX - innerR, loupeY - innerR, zoomAreaDiameter, zoomAreaDiameter
            );

            // Siatka pikseli wewnątrz powiększenia
            const pixelStep = zoomAreaDiameter / sampleBoxSize;
            oCtx.lineWidth = 0.5;
            oCtx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
            for (let i = 0; i <= sampleBoxSize; i++) {
              const pos = loupeX - innerR + i * pixelStep;
              oCtx.beginPath();
              oCtx.moveTo(pos, loupeY - innerR);
              oCtx.lineTo(pos, loupeY + innerR);
              oCtx.stroke();

              const posY = loupeY - innerR + i * pixelStep;
              oCtx.beginPath();
              oCtx.moveTo(loupeX - innerR, posY);
              oCtx.lineTo(loupeX + innerR, posY);
              oCtx.stroke();
            }

            // Oznaczenie obszaru zbierania w lupie
            if (diameter > 1) {
              const loupeR = (diameter / 2) * pixelStep;
              oCtx.lineWidth = 2;
              oCtx.strokeStyle = '#000000';
              oCtx.beginPath();
              oCtx.arc(loupeX, loupeY, loupeR, 0, Math.PI * 2);
              oCtx.stroke();

              oCtx.lineWidth = 1;
              oCtx.strokeStyle = '#ffffff';
              oCtx.beginPath();
              oCtx.arc(loupeX, loupeY, loupeR, 0, Math.PI * 2);
              oCtx.stroke();
            } else {
              // Wyróżnienie centralnego pojedynczego piksela
              const centerLeft = loupeX - pixelStep / 2;
              const centerTop = loupeY - pixelStep / 2;
              oCtx.lineWidth = 1.5;
              oCtx.strokeStyle = '#00e5ff';
              oCtx.strokeRect(centerLeft, centerTop, pixelStep, pixelStep);
            }

            // Celownik w centrum lupy
            oCtx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            oCtx.lineWidth = 1;
            oCtx.beginPath();
            oCtx.moveTo(loupeX - 4, loupeY);
            oCtx.lineTo(loupeX + 4, loupeY);
            oCtx.moveTo(loupeX, loupeY - 4);
            oCtx.lineTo(loupeX, loupeY + 4);
            oCtx.stroke();

            oCtx.restore(); // Koniec clip aperture

            // Pierścień próbnika kolorów (Annulus od innerR do outerR)
            // Górna połowa: Nowo pobierany kolor
            oCtx.save();
            oCtx.beginPath();
            oCtx.arc(loupeX, loupeY, outerR, Math.PI, 0, false);
            oCtx.arc(loupeX, loupeY, innerR, 0, Math.PI, true);
            oCtx.closePath();
            oCtx.fillStyle = skColorToRgbaString(currentLiveColor);
            oCtx.fill();

            // Dolna połowa: Poprzedni bieżący kolor podstawowy
            const prevColor = primaryColor || { r: 0, g: 0, b: 0, a: 255 };
            oCtx.beginPath();
            oCtx.arc(loupeX, loupeY, outerR, 0, Math.PI, false);
            oCtx.arc(loupeX, loupeY, innerR, Math.PI, 0, true);
            oCtx.closePath();
            oCtx.fillStyle = skColorToRgbaString(prevColor);
            oCtx.fill();

            // Poziome linie podziału po lewej i prawej stronie pierścienia
            oCtx.strokeStyle = '#222222';
            oCtx.lineWidth = 1.5;
            oCtx.beginPath();
            oCtx.moveTo(loupeX - outerR, loupeY);
            oCtx.lineTo(loupeX - innerR, loupeY);
            oCtx.moveTo(loupeX + innerR, loupeY);
            oCtx.lineTo(loupeX + outerR, loupeY);
            oCtx.stroke();

            // Krawędzie pierścienia (zewnętrzna i wewnętrzna)
            oCtx.lineWidth = 1.5;
            oCtx.strokeStyle = '#ffffff';
            oCtx.beginPath();
            oCtx.arc(loupeX, loupeY, outerR, 0, Math.PI * 2);
            oCtx.stroke();

            oCtx.strokeStyle = '#1e1e1e';
            oCtx.lineWidth = 1;
            oCtx.beginPath();
            oCtx.arc(loupeX, loupeY, outerR + 1, 0, Math.PI * 2);
            oCtx.stroke();

            oCtx.strokeStyle = '#ffffff';
            oCtx.lineWidth = 1.5;
            oCtx.beginPath();
            oCtx.arc(loupeX, loupeY, innerR, 0, Math.PI * 2);
            oCtx.stroke();

            // Etykieta HEX i RGB pod lupą
            const hex = skColorToHex(currentLiveColor);
            const labelText = `${hex} (${currentLiveColor.r}, ${currentLiveColor.g}, ${currentLiveColor.b})`;
            oCtx.font = '10px monospace';
            const textWidth = oCtx.measureText(labelText).width;
            const badgeW = textWidth + 12;
            const badgeH = 18;
            const badgeY = isFlippedAbove ? loupeY - outerR - 22 : loupeY + outerR + 6;

            oCtx.fillStyle = 'rgba(26, 26, 26, 0.9)';
            oCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
            oCtx.lineWidth = 1;
            oCtx.beginPath();
            if (typeof oCtx.roundRect === 'function') {
              oCtx.roundRect(loupeX - badgeW / 2, badgeY, badgeW, badgeH, 4);
            } else {
              oCtx.rect(loupeX - badgeW / 2, badgeY, badgeW, badgeH);
            }
            oCtx.fill();
            oCtx.stroke();

            oCtx.fillStyle = '#ffffff';
            oCtx.textAlign = 'center';
            oCtx.textBaseline = 'middle';
            oCtx.fillText(labelText, loupeX, badgeY + badgeH / 2);

            oCtx.restore();
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
    brushSettings.size,
    pipetteSettings?.sampleDiameter,
    pipetteSettings?.sampleSource,
    pipetteSettings?.showLoupe,
    primaryColor,
    getTransformScreenGeometry,
  ]);

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

  // Interakcja przekształcania ze skrótami klawiszowymi (Shift: kąt 15°, blokada osi, proporcje; Alt: skalowanie z pivotu)
  const updateTransformInteraction = useCallback(
    (pt: SKPoint, shiftKey: boolean, altKey: boolean) => {
      const activeHandle = transformActiveHandleRef.current;
      if (!activeHandle || !transformInitialStateRef.current || !transformDragStartDocPtRef.current) {
        return;
      }

      const init = transformInitialStateRef.current;
      const startPt = transformDragStartDocPtRef.current;

      // 1. Przenoszenie zaznaczenia (wraz ze środkiem ciężkości)
      if (activeHandle === 'move') {
        let dx = pt.x - startPt.x;
        let dy = pt.y - startPt.y;

        // Przytrzymanie SHIFT: ruch ściśle w poziomie lub pionie
        if (shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) {
            dy = 0;
          } else {
            dx = 0;
          }
        }

        engine.selectionManager.updateTransformSelection({
          pos: { x: init.pos.x + dx, y: init.pos.y + dy },
          pivot: { x: init.pivot.x + dx, y: init.pivot.y + dy },
        });
        onCanvasModified();
        return;
      }

      // 2. Przenoszenie środka ciężkości (nie rusza zaznaczenia ani ramki)
      if (activeHandle === 'pivot') {
        engine.selectionManager.updateTransformSelection({
          pivot: { x: pt.x, y: pt.y },
        });
        onCanvasModified();
        return;
      }

      // 3. Obrót wokół środka ciężkości (pivot)
      if (activeHandle === 'rotate' || activeHandle.startsWith('rotate')) {
        const P = init.pivot;
        const startAngle = Math.atan2(startPt.y - P.y, startPt.x - P.x);
        const curAngle = Math.atan2(pt.y - P.y, pt.x - P.x);
        let deltaAngle = curAngle - startAngle;

        let targetAngle = init.angle + deltaAngle;
        // Przytrzymanie SHIFT: przybliżamy kąt obrotu do pełnych wielokrotności 15 stopni
        if (shiftKey) {
          const step = (15 * Math.PI) / 180;
          targetAngle = Math.round(targetAngle / step) * step;
          deltaAngle = targetAngle - init.angle;
        }

        // Środek ramki obraca się wokół pivotu
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

      // 4. Skalowanie z 8 uchwytów
      let uA = 0;
      let vA = 0;

      if (activeHandle === 'e') {
        uA = -0.5;
        vA = 0;
      } else if (activeHandle === 'w') {
        uA = 0.5;
        vA = 0;
      } else if (activeHandle === 's') {
        uA = 0;
        vA = -0.5;
      } else if (activeHandle === 'n') {
        uA = 0;
        vA = 0.5;
      } else if (activeHandle === 'se') {
        uA = -0.5;
        vA = -0.5;
      } else if (activeHandle === 'nw') {
        uA = 0.5;
        vA = 0.5;
      } else if (activeHandle === 'ne') {
        uA = -0.5;
        vA = 0.5;
      } else if (activeHandle === 'sw') {
        uA = 0.5;
        vA = -0.5;
      }

      const uH = -uA;
      const vH = -vA;

      const cos0 = Math.cos(init.angle);
      const sin0 = Math.sin(init.angle);
      const Ux = { x: cos0, y: sin0 };
      const Uy = { x: -sin0, y: cos0 };

      let newW = init.width;
      let newH = init.height;

      // Pozycja punktu kotwiczenia (przeciwległy uchwyt)
      const anchorDocX = init.pos.x + uA * init.width * cos0 - vA * init.height * sin0;
      const anchorDocY = init.pos.y + uA * init.width * sin0 + vA * init.height * cos0;

      if (altKey) {
        // TRYB ALT: Skalowanie względem środka obrotu (init.pivot), a nie przeciwległego uchwytu
        const Vp = { x: pt.x - init.pivot.x, y: pt.y - init.pivot.y };
        const projPivX = Vp.x * Ux.x + Vp.y * Ux.y;
        const projPivY = Vp.x * Uy.x + Vp.y * Uy.y;

        // Początkowa odległość uchwytu od środka obrotu
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
        // STANDARDOWE SKALOWANIE: Względem przeciwległego uchwytu (anchor)
        const V = { x: pt.x - anchorDocX, y: pt.y - anchorDocY };
        const projX = V.x * Ux.x + V.y * Ux.y;
        const projY = V.x * Uy.x + V.y * Uy.y;

        if (uH !== 0) {
          newW = Math.max(2, projX * Math.sign(uH));
        }
        if (vH !== 0) {
          newH = Math.max(2, projY * Math.sign(vH));
        }
      }

      // Przytrzymanie SHIFT: blokujemy proporcje zaznaczenia
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
        // Środek obrotu pozostaje w tym samym punkcie dokumentu
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
        // Pozycja środka wyliczana względem stałego przeciwległego uchwytu (anchor)
        newPosX = anchorDocX - uA * newW * Ux.x - vA * newH * Uy.x;
        newPosY = anchorDocY - uA * newW * Ux.y - vA * newH * Uy.y;

        // Przelicz proporcjonalnie nową pozycję środka obrotu (pivot) wewnątrz przeskalowanej ramki
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

  updateTransformInteractionRef.current = updateTransformInteraction;

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || isSpacePressed || activeTool === 'pan') {
      setIsPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
      return;
    }

    if (e.button !== 0) return;

    const pt = getDocPoint(e);
    if (!pt) return;

    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    // OBSŁUGA NARZĘDZI PRZEKSZTAŁCANIA (ZAZNACZENIA LUB ZAWARTOŚCI)
    if (isTransformTool) {
      if (activeTool === 'transform-content' && !engine.transformContentSession) {
        engine.beginTransformContent(selectionSettings.interpolation || 'bilinear');
      } else if (activeTool === 'transform-selection' && !engine.selectionManager.transformState && engine.selectionManager.hasActiveSelection) {
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

    const layer = engine.getActiveLayer();
    if (!layer || !layer.visible) return;

    if (activeTool === 'pipette') {
      setIsDrawing(true);
      const color = engine.pickColor(
        pt.x,
        pt.y,
        pipetteSettings?.sampleSource || 'image',
        pipetteSettings?.sampleDiameter || 1
      );
      onPipettePick(color);
      return;
    }

    if (activeTool === 'magic-wand') {
      const sp = engine.selectionManager.wandSeedPoint;
      if (sp && Math.hypot(pt.x - sp.x, pt.y - sp.y) * zoom <= 16) {
        wandDragInitialSnapshotRef.current = engine.selectionManager.getMaskSnapshot();
        setIsDraggingWandHandle(true);
        return;
      }

      engine.applyMagicWand(pt, selectionSettings);
      onCanvasModified();
      return;
    }

    if (activeTool === 'select-rect' || activeTool === 'select-ellipse') {
      engine.selectionManager.wandSeedPoint = null;
      setDragStartPoint(pt);
      setCurrentDragPoint(pt);
      setIsDrawing(true);
      return;
    }

    if (activeTool === 'select-lasso') {
      engine.selectionManager.wandSeedPoint = null;
      setDragStartPoint(pt);
      setCurrentDragPoint(pt);
      setLassoPoints([pt]);
      setIsDrawing(true);
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
      // Sprawdź czy użytkownik kliknął w uchwyt początkowy 0 lub końcowy 1
      if (p0 && Math.hypot(pt.x - p0.x, pt.y - p0.y) * zoom <= 14) {
        setIsDraggingGradientHandle(0);
        return;
      }
      if (p1 && Math.hypot(pt.x - p1.x, pt.y - p1.y) * zoom <= 14) {
        setIsDraggingGradientHandle(1);
        return;
      }

      // Nowe przeciąganie gradientu od punktu do punktu
      setDragStartPoint(pt);
      setCurrentDragPoint(pt);
      setIsDrawing(true);
      engine.applyGradient(pt, pt, gradientSettings, primaryColor, secondaryColor, brushSettings.blendMode, true);
      onCanvasModified();
      return;
    }

    if (activeTool === 'shapes' || activeTool === 'line') {
      setDragStartPoint(pt);
      setCurrentDragPoint(pt);
      setIsDrawing(true);
      return;
    }

    if (activeTool === 'brush' || activeTool === 'eraser') {
      setIsDrawing(true);
      const isEraser = activeTool === 'eraser';
      const strokeResult = engine.brushEngine.beginStroke(pt, layer, brushSettings, isEraser);

      if (canvasRef.current && strokeResult.dirtyRect.width > 0) {
        engine.compositeToViewport(canvasRef.current, strokeResult.dirtyRect);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      cursorPosRef.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };
    }

    const pt = getDocPoint(e);
    updateStatusBarPos(pt);

    if (isPanning) {
      onUpdatePan({
        x: e.clientX - panStart.x,
        y: e.clientY - panStart.y,
      });
      return;
    }

    // INTERAKCJA PRZEKSZTAŁCANIA ZAZNACZENIA LUB ZAWARTOŚCI
    if (isTransformTool) {
      if (transformActiveHandle && transformInitialStateRef.current && transformDragStartDocPtRef.current && pt) {
        lastTransformPtRef.current = pt;
        updateTransformInteraction(pt, e.shiftKey, e.altKey);
        return;
      }

      // Aktualizacja hover kursora
      const hoverHit = hitTestTransformHandles(e);
      setTransformHoverHandle(hoverHit);
      return;
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
      if (isDraggingGradientHandle === 0 && pt && engine.gradientEndPoint) {
        engine.applyGradient(pt, engine.gradientEndPoint, gradientSettings, primaryColor, secondaryColor, brushSettings.blendMode, false);
        onCanvasModified();
        return;
      }
      if (isDraggingGradientHandle === 1 && pt && engine.gradientStartPoint) {
        engine.applyGradient(engine.gradientStartPoint, pt, gradientSettings, primaryColor, secondaryColor, brushSettings.blendMode, false);
        onCanvasModified();
        return;
      }
      if (isDrawing && pt && dragStartPoint) {
        setCurrentDragPoint(pt);
        engine.applyGradient(dragStartPoint, pt, gradientSettings, primaryColor, secondaryColor, brushSettings.blendMode, false);
        onCanvasModified();
        return;
      }

      if (pt && engine.gradientStartPoint && Math.hypot(pt.x - engine.gradientStartPoint.x, pt.y - engine.gradientStartPoint.y) * zoom <= 14) {
        setGradientHoverHandle(0);
      } else if (pt && engine.gradientEndPoint && Math.hypot(pt.x - engine.gradientEndPoint.x, pt.y - engine.gradientEndPoint.y) * zoom <= 14) {
        setGradientHoverHandle(1);
      } else {
        setGradientHoverHandle(null);
      }
      return;
    }

    if (activeTool === 'pipette') {
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

    if (activeTool === 'shapes' || activeTool === 'line') {
      setCurrentDragPoint(pt);
      if (canvasRef.current && dragStartPoint) {
        engine.compositeToViewport(
          canvasRef.current,
          null,
          dragStartPoint,
          pt,
          activeTool === 'line' ? 'line' : activeShapeType,
          brushSettings
        );
      }
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
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    if (isPanning) {
      setIsPanning(false);
      return;
    }

    // ZAKOŃCZENIE POJEDYNCZEGO PRZECIĄGNIĘCIA TRANSFORMACJI
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
        engine.pushSelectionAction(wandDragInitialSnapshotRef.current, finalSnapshot, 'Przeniesienie punktu różdżki');
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
        onCanvasModified();
        return;
      }
      if (isDrawing) {
        setIsDrawing(false);
        const pt = getDocPoint(e);
        if (dragStartPoint && pt) {
          engine.applyGradient(dragStartPoint, pt, gradientSettings, primaryColor, secondaryColor, brushSettings.blendMode, false);
        }
        setDragStartPoint(null);
        setCurrentDragPoint(null);
        onCanvasModified();
        return;
      }
    }

    if (!isDrawing) return;
    setIsDrawing(false);

    const layer = engine.getActiveLayer();

    if ((activeTool === 'select-rect' || activeTool === 'select-ellipse') && dragStartPoint && currentDragPoint) {
      engine.applySelectionShape(
        activeTool === 'select-rect' ? 'rect' : 'ellipse',
        [dragStartPoint, currentDragPoint],
        selectionSettings
      );
      setDragStartPoint(null);
      setCurrentDragPoint(null);
      onCanvasModified();
      return;
    }

    if (activeTool === 'select-lasso' && lassoPoints.length > 2) {
      engine.applySelectionShape('lasso', lassoPoints, selectionSettings);
      setDragStartPoint(null);
      setCurrentDragPoint(null);
      setLassoPoints([]);
      onCanvasModified();
      return;
    }

    if ((activeTool === 'shapes' || activeTool === 'line') && dragStartPoint && currentDragPoint) {
      engine.commitShape(
        dragStartPoint,
        currentDragPoint,
        activeTool === 'line' ? 'line' : activeShapeType,
        brushSettings
      );
      setDragStartPoint(null);
      setCurrentDragPoint(null);
      if (canvasRef.current) {
        engine.compositeToViewport(canvasRef.current);
      }
      onCanvasModified();
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
  };

  // Dobór kursora myszy dla narzędzia modyfikacji zaznaczenia i zawartości
  const getCursorStyle = (): string => {
    if (isPanning || isSpacePressed || activeTool === 'pan') {
      return isPanning ? 'grabbing' : 'grab';
    }
    if (activeTool === 'brush' || activeTool === 'eraser' || activeTool === 'pipette') {
      return 'none';
    }
    if (isTransformTool) {
      const h = transformActiveHandle || transformHoverHandle;
      if (h === 'pivot' || h === 'move') return 'move';
      if (h && (h === 'rotate' || h.startsWith('rotate'))) {
        let baseAngle = -45;
        if (h === 'rotate-ne') baseAngle = -45;
        else if (h === 'rotate-se') baseAngle = 45;
        else if (h === 'rotate-sw') baseAngle = 135;
        else if (h === 'rotate-nw') baseAngle = 225;
        const boxAngleDeg = Math.round(
          ((engine.selectionManager.transformState?.angle || 0) * 180) / Math.PI
        );
        return getRotateCursorUrl(baseAngle + boxAngleDeg);
      }
      if (h === 'nw' || h === 'se') return 'nwse-resize';
      if (h === 'ne' || h === 'sw') return 'nesw-resize';
      if (h === 'n' || h === 's') return 'ns-resize';
      if (h === 'e' || h === 'w') return 'ew-resize';
      return 'default';
    }
    if (activeTool.startsWith('select') || activeTool === 'magic-wand') {
      return 'crosshair';
    }
    if (activeTool === 'gradient') {
      if (gradientHoverHandle !== null || isDraggingGradientHandle !== null) {
        return 'move';
      }
      return 'crosshair';
    }
    return 'crosshair';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('image/')) {
        const img = new Image();
        img.onload = () => {
          const cvs = document.createElement('canvas');
          cvs.width = engine.width;
          cvs.height = engine.height;
          const ctx = cvs.getContext('2d')!;
          const dx = Math.max(0, Math.round((engine.width - img.width) / 2));
          const dy = Math.max(0, Math.round((engine.height - img.height) / 2));
          ctx.drawImage(img, dx, dy, Math.min(img.width, engine.width), Math.min(img.height, engine.height));
          engine.pasteCanvas(cvs);
          onCanvasModified();
        };
        img.src = URL.createObjectURL(file);
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
        cursorPosRef.current = null;
      }}
      className="relative flex-1 h-full overflow-hidden select-none bg-[#6f6f6f] touch-none"
      style={{ cursor: getCursorStyle() }}
    >
      {/* JEDNOLITA STRUKTURA PŁÓTNA: SZACHOWNICA + RYSUNEK + 1PX RAMKA W JEDNYM WSPÓLNYM PUDEŁKU */}
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
