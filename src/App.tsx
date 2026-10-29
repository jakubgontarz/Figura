/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Lock } from 'lucide-react';
import { GraphicEngine } from './core/skia/GraphicEngine.ts';
import {
  BrushSettings,
  ColorReplaceSettings,
  CorrectionBrushSettings,
  DeformSettings,
  GradientSettings,
  LineAndCurveSettings,
  PipetteSettings,
  SKBlendMode,
  SKColor,
  SelectionSettings,
  ShapeKind,
  StampSettings,
  ToolType,
  VectorShapeSettings,
  TextToolSettings,
} from './core/skia/types.ts';
import { TitleBar } from './components/TitleBar.tsx';
import { MenuBar, MenuActionHandlers } from './components/MenuBar.tsx';
import { ToolOptionsBar } from './components/ToolOptionsBar.tsx';
import { Toolbox } from './components/Toolbox.tsx';
import { CanvasViewport } from './components/CanvasViewport.tsx';
import { ColorPanel } from './components/ColorPanel.tsx';
import { LayersPanel } from './components/LayersPanel.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { NewDocumentModal } from './components/NewDocumentModal.tsx';
import { CorrectionDialog } from './components/CorrectionDialog.tsx';
import { StylesDialog } from './components/StylesDialog.tsx';
import { LayerStyles } from './core/skia/Styles.ts';
import { Correction, CorrectionType, Histogram } from './core/skia/Corrections.ts';
import type { Layer } from './core/skia/Layer.ts';

/** Narzędzia dostępne na warstwie wektorowej (reszta działa na pikselach). */
const VECTOR_LAYER_TOOLS = new Set<ToolType>(['vector-select', 'pen', 'shapes', 'line', 'bezier', 'text', 'pipette', 'pan', 'zoom']);
const VECTOR_ONLY_TOOLS = new Set<ToolType>(['vector-select', 'pen']);

interface DocumentTab {
  id: string;
  title: string;
  engine: GraphicEngine;
}

export default function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>(() => {
    const doc1 = new GraphicEngine('obraz1.fig', 800, 600);
    return [{ id: 'tab_1', title: 'obraz1', engine: doc1 }];
  });

  const [activeTabId, setActiveTabId] = useState<string>('tab_1');
  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  const engine = activeTab.engine;

  const [engineRevision, setEngineRevision] = useState(0);
  const bumpEngineRevision = useCallback(() => {
    setEngineRevision((r) => r + 1);
  }, []);

  // Okno edycji korekcji nieniszczącej: zmiany są na żywo na warstwie (silnik), a OK / Anuluj kończą sesję edycji
  const [correctionDlg, setCorrectionDlg] = useState<{
    engine: GraphicEngine;
    layer: Layer;
    correction: Correction;
    isNew: boolean;
    histogram: Histogram | null;
    token: number;
  } | null>(null);
  // Okno stylizacji warstwy (ta sama sesja podglądu na żywo co przy korekcjach)
  const [stylesDlg, setStylesDlg] = useState<{
    engine: GraphicEngine;
    layer: Layer;
    initial: LayerStyles;
    isNew: boolean;
    token: number;
  } | null>(null);
  const liveRefreshRaf = useRef(0);
  // Suwak może strzelać częściej niż klatki: odświeżenie płótna scalamy do jednego na klatkę
  const scheduleLiveRefresh = useCallback(() => {
    if (liveRefreshRaf.current) return;
    liveRefreshRaf.current = requestAnimationFrame(() => {
      liveRefreshRaf.current = 0;
      setEngineRevision((r) => r + 1);
    });
  }, []);

  // Stan powiadomień Toast (np. dla zablokowanej warstwy)
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
  }, []);

  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 2500);
      return () => clearTimeout(timer);
    }
  }, [toastMessage]);

  const startCorrectionEdit = useCallback(
    (layerIndex: number, opts: { type?: CorrectionType; id?: string; onlyActive?: boolean }) => {
      const layer = engine.layers[layerIndex];
      if (!layer) return;
      if (engine.correctionsLocked(layer)) {
        showToast('Nie można dodać korekcji: warstwa jest zablokowana');
        return;
      }
      let target: Layer = layer;
      let correction: Correction | null = null;
      if (opts.type && !opts.id && (layer.isGroup || layer.isAdjustment || opts.onlyActive === false)) {
        // grupa / korekcja w stosie zaznaczona: nowa korekcja trafia do stosu (działa na warstwy pod nią)
        const r = engine.beginNewAdjustmentEdit(opts.type, opts.onlyActive === false || layer.isAdjustment);
        if (r) {
          target = r.layer;
          correction = r.correction;
        }
      } else {
        correction = engine.beginCorrectionEdit(layer, opts);
      }
      if (!correction) return;
      setStylesDlg(null);
      const wantsHistogram = correction.type === 'levels' || correction.type === 'curves';
      setCorrectionDlg({
        engine,
        layer: target,
        correction,
        isNew: !opts.id,
        histogram: wantsHistogram
          ? target.isAdjustment
            ? engine.computeBackdropHistogram(target)
            : engine.computeLayerHistogram(target, correction.id)
          : null,
        token: Date.now(),
      });
      bumpEngineRevision();
    },
    [engine, showToast, bumpEngineRevision]
  );

  const finishCorrectionEdit = useCallback(
    (commit: boolean) => {
      const dlg = correctionDlg;
      if (!dlg) return;
      if (commit) dlg.engine.commitCorrectionEdit();
      else dlg.engine.cancelCorrectionEdit();
      setCorrectionDlg(null);
      bumpEngineRevision();
    },
    [correctionDlg, bumpEngineRevision]
  );

  const startStylesEdit = useCallback(
    (layerIndex: number) => {
      const layer = engine.layers[layerIndex];
      if (!layer) return;
      if (!engine.canHaveStyles(layer)) {
        showToast('Stylizacje działają tylko na zwykłych warstwach rastrowych');
        return;
      }
      if (engine.correctionsLocked(layer)) {
        showToast('Nie można dodać stylizacji: warstwa jest zablokowana');
        return;
      }
      const hadStyles = !!layer.styles;
      const st = engine.beginStylesEdit(layer);
      if (!st) return;
      setCorrectionDlg(null);
      setStylesDlg({ engine, layer, initial: JSON.parse(JSON.stringify(st)) as LayerStyles, isNew: !hadStyles, token: Date.now() });
      bumpEngineRevision();
    },
    [engine, showToast, bumpEngineRevision]
  );

  const finishStylesEdit = useCallback(
    (commit: boolean) => {
      const dlg = stylesDlg;
      if (!dlg) return;
      if (commit) dlg.engine.commitCorrectionEdit();
      else dlg.engine.cancelCorrectionEdit();
      setStylesDlg(null);
      bumpEngineRevision();
    },
    [stylesDlg, bumpEngineRevision]
  );

  // Sesja edycji zakończona z zewnątrz (cofnięcie, zmiana warstwy, inna operacja na warstwach): zamknij okno
  useEffect(() => {
    if (correctionDlg && (!correctionDlg.engine.hasCorrectionSession || correctionDlg.engine.stylesEditing)) setCorrectionDlg(null);
    if (stylesDlg && !stylesDlg.engine.stylesEditing) setStylesDlg(null);
  }, [correctionDlg, stylesDlg, engineRevision]);

  // Przełączenie na inny dokument zatwierdza trwającą edycję w dokumencie, w którym została rozpoczęta
  useEffect(() => {
    if (correctionDlg && correctionDlg.engine !== engine) {
      correctionDlg.engine.commitCorrectionEdit();
      setCorrectionDlg(null);
    }
  }, [engine, correctionDlg]);

  useEffect(() => {
    if (stylesDlg && stylesDlg.engine !== engine) {
      stylesDlg.engine.commitCorrectionEdit();
      setStylesDlg(null);
    }
  }, [engine, stylesDlg]);

  // Kolory
  const [primaryColor, setPrimaryColor] = useState<SKColor>({ r: 255, g: 0, b: 0, a: 255 });
  const [secondaryColor, setSecondaryColor] = useState<SKColor>({ r: 255, g: 255, b: 255, a: 255 });

  // Ustawienia pędzla
  const [brushSettings, setBrushSettings] = useState<BrushSettings>({
    size: 20,
    hardness: 90,
    antiAliasing: true,
    spacing: 15,
    blendMode: 'SrcOver',
    color: { r: 255, g: 0, b: 0, a: 255 },
  });

  useEffect(() => {
    setBrushSettings((prev) => ({ ...prev, color: primaryColor }));
  }, [primaryColor]);

  // Ustawienia pędzla korekcyjnego
  const [correctionBrushSettings, setCorrectionBrushSettings] = useState<CorrectionBrushSettings>({
    brushType: 'dodge-burn',
    size: 20,
    hardness: 90,
    antiAliasing: true,
    spacing: 15,
    invertAction: false,
  });

  const handleUpdateCorrectionBrushSettings = (newSettings: Partial<CorrectionBrushSettings>) => {
    setCorrectionBrushSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Ustawienia pędzla podmiany koloru
  const [colorReplaceSettings, setColorReplaceSettings] = useState<ColorReplaceSettings>({
    size: 20,
    hardness: 90,
    antiAliasing: true,
    spacing: 15,
    tolerance: 30,
    mode: 'single',
  });

  const handleUpdateColorReplaceSettings = (newSettings: Partial<ColorReplaceSettings>) => {
    setColorReplaceSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Ustawienia pieczątki (klonowania)
  const [stampSettings, setStampSettings] = useState<StampSettings>({
    size: 30,
    hardness: 85,
    antiAliasing: true,
    spacing: 15,
    blendMode: 'SrcOver',
    sampleSource: 'image',
    sourceMode: 'relative',
  });
  const [stampBasePoint, setStampBasePoint] = useState<{ x: number; y: number } | null>(null);

  const handleUpdateStampSettings = (newSettings: Partial<StampSettings>) => {
    setStampSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Ustawienia deformacji
  const [deformSettings, setDeformSettings] = useState<DeformSettings>({
    actionType: 'expand-shrink',
    size: 60,
    hardness: 50,
    antiAliasing: true,
    spacing: 15,
    invertAction: false,
  });

  const handleUpdateDeformSettings = (newSettings: Partial<DeformSettings>) => {
    setDeformSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Ustawienia zaznaczania
  const [selectionSettings, setSelectionSettings] = useState<SelectionSettings>({
    mode: 'replace',
    constraint: 'normal',
    ratioW: 16,
    ratioH: 9,
    fixedW: 400,
    fixedH: 300,
    feather: 0,
    tolerance: 15,
    wandMode: 'contiguous',
    sampleSource: 'image',
    interpolation: 'bilinear',
    lassoMode: 'freehand',
  });

  const handleUpdateSelectionSettings = (newSettings: Partial<SelectionSettings>) => {
    setSelectionSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Ustawienia pipety
  const [pipetteSettings, setPipetteSettings] = useState<PipetteSettings>({
    sampleSource: 'image',
    sampleDiameter: 1,
    showLoupe: true,
  });

  const handleUpdatePipetteSettings = (newSettings: Partial<PipetteSettings>) => {
    setPipetteSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Ustawienia gradientu
  const [gradientSettings, setGradientSettings] = useState<GradientSettings>({
    type: 'linear',
    repeat: 'none',
    reverse: false,
    blendMode: 'SrcOver',
  });

  const handleUpdateGradientSettings = (newSettings: Partial<GradientSettings>) => {
    setGradientSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Ustawienia figur wektorowych
  const [vectorShapeSettings, setVectorShapeSettings] = useState<VectorShapeSettings>({
    shapeKind: 'rect',
    fillMode: 'stroke-and-fill',
    strokeWidth: 4,
    strokeColor: { r: 255, g: 0, b: 0, a: 255 },
    fillColor: { r: 255, g: 255, b: 255, a: 255 },
    strokeCornerJoin: 'miter',
    strokeAlignment: 'center',
    antiAliasing: true,
    hardness: 100,
    blendMode: 'SrcOver',
    cornerRadius: 16,
    starPoints: 5,
    starInnerRatio: 0.45,
    polygonSides: 6,
    arrowHeadWidth: 0.45,
    arrowShaftThickness: 0.35,
  });

  const handleUpdateVectorShapeSettings = (newSettings: Partial<VectorShapeSettings>) => {
    setVectorShapeSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Ustawienia narzędzia tekstu
  const [textSettings, setTextSettings] = useState<TextToolSettings>({
    fontFamily: 'Arial',
    fontSize: 32,
    bold: false,
    italic: false,
    underline: false,
    script: 'normal',
    align: 'left',
    lineSpacing: 100,
    letterSpacing: 0,
    padding: 0,
    antiAliasing: true,
    fillMode: 'primary',
    strokeWidth: 0,
    strokeColor: { r: 255, g: 0, b: 0, a: 255 },
    fillColor: { r: 255, g: 255, b: 255, a: 255 },
    blendMode: 'SrcOver',
  });
  // Zmiana ustawień przez użytkownika (pasek opcji) – edytor tekstu stosuje ją do zaznaczenia / całego tekstu
  const [textFormatRequest, setTextFormatRequest] = useState<{ id: number; patch: Partial<TextToolSettings> } | null>(null);
  const handleUpdateTextSettings = (patch: Partial<TextToolSettings>) => {
    setTextSettings((prev) => ({ ...prev, ...patch }));
    setTextFormatRequest((prev) => ({ id: (prev?.id ?? 0) + 1, patch }));
  };
  // Synchronizacja paska opcji ze stylem w miejscu kursora (bez ponownego stosowania do tekstu)
  const handleSyncTextSettings = useCallback((patch: Partial<TextToolSettings>) => {
    setTextSettings((prev) => ({ ...prev, ...patch }));
  }, []);
  const [textFocusTrigger, setTextFocusTrigger] = useState(0);

  // Ustawienia linii i krzywych Beziera
  const [lineAndCurveSettings, setLineAndCurveSettings] = useState<LineAndCurveSettings>({
    strokeWidth: 4,
    strokeColor: { r: 255, g: 0, b: 0, a: 255 },
    dashStyle: 'solid',
    startMarker: 'none',
    endMarker: 'none',
    markerSize: 1.0,
    antiAliasing: true,
    hardness: 100,
    blendMode: 'SrcOver',
    lineCap: 'round',
    cornerJoin: 'round',
    fillMode: 'none',
    fillColor: { r: 255, g: 255, b: 255, a: 255 },
    strokeAlignment: 'center',
  });

  const handleUpdateLineAndCurveSettings = (newSettings: Partial<LineAndCurveSettings>) => {
    setLineAndCurveSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // Synchronizacja kolorów
  useEffect(() => {
    setVectorShapeSettings((prev) => ({
      ...prev,
      strokeColor: primaryColor,
      fillColor: secondaryColor,
    }));
    setLineAndCurveSettings((prev) => ({
      ...prev,
      strokeColor: primaryColor,
      fillColor: secondaryColor,
    }));
    setTextSettings((prev) => ({
      ...prev,
      strokeColor: primaryColor,
      fillColor: secondaryColor,
    }));
  }, [primaryColor, secondaryColor]);

  // Stan aktywnej sesji wektorowej (linia, krzywa, figura)
  const [isLiveVectorSessionActive, setIsLiveVectorSessionActive] = useState(false);
  const [liveVectorCommitTrigger, setLiveVectorCommitTrigger] = useState(0);
  const [liveVectorCancelTrigger, setLiveVectorCancelTrigger] = useState(0);
  const [penCloseToggleTrigger, setPenCloseToggleTrigger] = useState(0);
  const [penInfo, setPenInfo] = useState({ active: false, closed: false, count: 0 });

  // Narzędzia
  const [activeTool, setActiveToolRaw] = useState<ToolType>('brush');
  // Stan edycji obiektu wektorowego z narzędzia Manipulacja: rodzaj otwartej sesji (decyduje o opcjach narzędzia)
  const [vectorEditKind, setVectorEditKind] = useState<'line' | 'bezier' | 'shapes' | 'text' | null>(null);
  const activeIsVector = !!engine.getActiveLayer()?.isVector;
  // Żądanie otwarcia obiektu wektorowego do edycji (kliknięcie wiersza w panelu warstw)
  const [vectorEditRequest, setVectorEditRequest] = useState<{ n: number; layerIndex: number; id: string } | null>(null);
  /** Wybór narzędzia z uwzględnieniem rodzaju aktywnej warstwy (wektorowa ma własny zestaw narzędzi). */
  const setActiveTool = useCallback(
    (tool: ToolType) => {
      const vec = !!engine.getActiveLayer()?.isVector;
      if (vec && !VECTOR_LAYER_TOOLS.has(tool)) {
        showToast('Warstwa wektorowa: dostępne są tylko narzędzia obiektów wektorowych');
        return;
      }
      if (!vec && VECTOR_ONLY_TOOLS.has(tool)) {
        showToast('To narzędzie działa tylko na warstwie wektorowej');
        return;
      }
      setActiveToolRaw(tool);
    },
    [engine, showToast]
  );
  // Zmiana aktywnej warstwy na wektorową / rastrową: narzędzie spoza zestawu zamieniane na domyślne
  useEffect(() => {
    if (activeIsVector && !VECTOR_LAYER_TOOLS.has(activeTool)) setActiveToolRaw('vector-select');
    else if (!activeIsVector && VECTOR_ONLY_TOOLS.has(activeTool)) setActiveToolRaw('brush');
  }, [activeIsVector, activeTool]);

  // Zaznaczenie obiektów wektorowych istnieje tylko przy narzędziu Manipulacja
  useEffect(() => {
    if (activeTool !== 'vector-select' && engine.vec.getSelection()) {
      engine.vec.clearSelection();
      bumpEngineRevision();
    }
  }, [activeTool, engine, bumpEngineRevision]);

  // Widok (Zoom i Pan)
  const [zoom, setZoom] = useState<number>(1.0);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const [isNewDocModalOpen, setIsNewDocModalOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpdateBrushSettings = (newSettings: Partial<BrushSettings>) => {
    setBrushSettings((prev) => ({ ...prev, ...newSettings }));
  };

  const handleSelectTab = (id: string) => {
    setActiveTabId(id);
    const selectedTab = tabs.find((t) => t.id === id);
    if (selectedTab) {
      const maxDim = Math.max(selectedTab.engine.width, selectedTab.engine.height);
      if (maxDim > 1600) {
        setZoom(0.3);
      } else if (maxDim > 1000) {
        setZoom(0.6);
      } else {
        setZoom(1.0);
      }
    }
    setPanOffset({ x: 0, y: 0 });
    bumpEngineRevision();
  };

  const handleCloseTab = (id: string) => {
    if (tabs.length <= 1) return;
    const remaining = tabs.filter((t) => t.id !== id);
    setTabs(remaining);
    if (activeTabId === id) {
      setActiveTabId(remaining[0].id);
    }
    bumpEngineRevision();
  };

  const handleCreateNewDocument = (title: string, width: number, height: number) => {
    const newDoc = new GraphicEngine(title, width, height);
    const newTab: DocumentTab = {
      id: `tab_${Date.now()}`,
      title: title.replace(/\.fig$/, ''),
      engine: newDoc,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);

    const maxDim = Math.max(width, height);
    if (maxDim >= 3000) {
      setZoom(0.25);
    } else if (maxDim >= 1800) {
      setZoom(0.4);
    } else if (maxDim >= 1200) {
      setZoom(0.7);
    } else {
      setZoom(1.0);
    }

    setPanOffset({ x: 0, y: 0 });
    bumpEngineRevision();
  };

  const handleOpenFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleFileLoaded = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.name.endsWith('.fig') || file.type === 'application/json') {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const text = ev.target?.result as string;
        const newEngine = new GraphicEngine(file.name, 800, 600);
        const success = await newEngine.loadFromFigFile(text);
        if (success) {
          const newTab: DocumentTab = {
            id: `tab_${Date.now()}`,
            title: file.name.replace(/\.fig$/, ''),
            engine: newEngine,
          };
          setTabs((prev) => [...prev, newTab]);
          setActiveTabId(newTab.id);
          const maxDim = Math.max(newEngine.width, newEngine.height);
          setZoom(maxDim >= 2000 ? 0.35 : 1.0);
          setPanOffset({ x: 0, y: 0 });
          bumpEngineRevision();
        }
      };
      reader.readAsText(file);
    } else {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target?.result as string;
        const img = new Image();
        img.onload = () => {
          engine.importImage(img, file.name);
          bumpEngineRevision();
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    }
    e.target.value = '';
  };

  const handleSaveFig = () => {
    const jsonStr = engine.saveToFigFile();
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = engine.title.replace(/\.[^/.]+$/, '');
    a.download = `${baseName}.fig`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPng = () => {
    const dataUrl = engine.exportPng();
    const a = document.createElement('a');
    a.href = dataUrl;
    const baseName = engine.title.replace(/\.[^/.]+$/, '');
    a.download = `${baseName}.png`;
    a.click();
  };

  const handleExportJpg = () => {
    const dataUrl = engine.exportJpeg();
    const a = document.createElement('a');
    a.href = dataUrl;
    const baseName = engine.title.replace(/\.[^/.]+$/, '');
    a.download = `${baseName}.jpg`;
    a.click();
  };

  /** Aktywna warstwa wektorowa: jej indeks i zaznaczone obiekty (z otwartą edycją włącznie). */
  const vectorSelection = useCallback((): { idx: number; ids: string[] } | null => {
    const l = engine.getActiveLayer();
    if (!l || !l.isVector) return null;
    const ids = engine.vec.selectedIds(l);
    return ids.length > 0 ? { idx: engine.layers.indexOf(l), ids } : null;
  }, [engine]);

  const handleCut = useCallback(() => {
    if (engine.getActiveLayer()?.isVector) {
      const vs = vectorSelection();
      if (!vs) showToast('Zaznacz obiekty wektorowe, aby je wyciąć');
      else if (!engine.vec.cutObjects(vs.idx, vs.ids)) showToast('Nie można wyciąć: warstwa jest zablokowana');
      bumpEngineRevision();
      return;
    }
    {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
    }
    if (engine.cut()) {
      bumpEngineRevision();
    }
  }, [engine, bumpEngineRevision, showToast, vectorSelection]);

  const handleCopy = useCallback(() => {
    if (engine.getActiveLayer()?.isVector) {
      const vs = vectorSelection();
      if (!vs) showToast('Zaznacz obiekty wektorowe, aby je skopiować');
      else engine.vec.copyObjects(vs.idx, vs.ids);
      return;
    }
    engine.copy();
  }, [engine, vectorSelection, showToast]);

  const pasteExternalBlob = useCallback((file: File | Blob) => {
    const img = new Image();
    img.onload = () => {
      const cvs = document.createElement('canvas');
      cvs.width = engine.width;
      cvs.height = engine.height;
      const ctx = cvs.getContext('2d')!;

      // Wyśrodkuj wklejany obraz na płótnie dokumentu
      const dx = Math.max(0, Math.round((engine.width - img.width) / 2));
      const dy = Math.max(0, Math.round((engine.height - img.height) / 2));
      ctx.drawImage(img, dx, dy, Math.min(img.width, engine.width), Math.min(img.height, engine.height));

      engine.pasteCanvas(cvs);
      setActiveTool('transform-content');
      bumpEngineRevision();
    };
    img.src = URL.createObjectURL(file);
  }, [engine, bumpEngineRevision, showToast]);

  const pasteImageBlob = useCallback((file: File | Blob) => {
    {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
    }
    // Własna kopia aplikacji: wklejamy bufor wewnętrzny (dokładne piksele i maska), a nie obraz zdekodowany z PNG
    engine.isOwnClipboardBlob(file).then((own) => {
      if (own && engine.paste()) {
        setActiveTool('transform-content');
        bumpEngineRevision();
        return;
      }
      pasteExternalBlob(file);
    });
  }, [engine, bumpEngineRevision, showToast, pasteExternalBlob]);

  const handlePaste = useCallback((inPlace?: boolean) => {
    if (engine.getActiveLayer()?.isVector) {
      const idx = engine.layers.indexOf(engine.getActiveLayer()!);
      if (!engine.vec.hasClipboard) showToast('Schowek obiektów jest pusty: zaznacz obiekty i skopiuj je (Ctrl+C)');
      else if (engine.vec.pasteObjects(idx, inPlace === true).length === 0) showToast('Nie można wkleić: warstwa jest zablokowana');
      else setActiveToolRaw('vector-select');
      bumpEngineRevision();
      return;
    }
    {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
    }
    // 1. Najpierw spróbuj odczytać aktualny obraz ze schowka systemowego (zrzuty ekranu, skopiowane obrazy z przeglądarki/OS)
    if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
      navigator.clipboard
        .read()
        .then((items) => {
          let foundImage = false;
          for (const item of items) {
            const imageType = item.types.find((t) => t.startsWith('image/'));
            if (imageType) {
              foundImage = true;
              item.getType(imageType).then((blob) => {
                pasteImageBlob(blob);
              });
              break;
            }
          }
          // Jeśli w schowku systemowym NIE MA obrazu, wklej bufor wewnętrzny aplikacji
          if (!foundImage && engine.paste()) {
            setActiveTool('transform-content');
            bumpEngineRevision();
          }
        })
        .catch(() => {
          if (engine.paste()) {
            setActiveTool('transform-content');
            bumpEngineRevision();
          }
        });
    } else {
      if (engine.paste()) {
        setActiveTool('transform-content');
        bumpEngineRevision();
      }
    }
  }, [engine, pasteImageBlob, bumpEngineRevision]);

  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      const clipboardData = e.clipboardData;
      if (clipboardData) {
        // 1. Sprawdź e.clipboardData.items (standard dla zrzutów ekranu / obrazów z OS - BEZ wyskakującego przycisku zgody!)
        if (clipboardData.items && clipboardData.items.length > 0) {
          for (const item of Array.from(clipboardData.items)) {
            if (item.type.startsWith('image/')) {
              const file = item.getAsFile();
              if (file) {
                e.preventDefault();
                e.stopPropagation();
                pasteImageBlob(file);
                return;
              }
            }
          }
        }

        // 2. Sprawdź e.clipboardData.files
        if (clipboardData.files && clipboardData.files.length > 0) {
          for (const file of Array.from(clipboardData.files)) {
            if (file.type.startsWith('image/')) {
              e.preventDefault();
              e.stopPropagation();
              pasteImageBlob(file);
              return;
            }
          }
        }
      }

      // 3. Jeśli brak obrazu w zdarzeniu schowka, wklej ze schowka wewnętrznego aplikacji (również BEZ przycisku zgody!)
      if (engine.clipboardCanvas) {
        e.preventDefault();
        e.stopPropagation();
        if (engine.paste()) {
          setActiveTool('transform-content');
          bumpEngineRevision();
        }
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => window.removeEventListener('paste', handleGlobalPaste);
  }, [engine, pasteImageBlob, bumpEngineRevision]);

  const isLiveVectorSessionActiveRef = useRef(false);
  isLiveVectorSessionActiveRef.current = isLiveVectorSessionActive;

  // Skróty klawiszowe
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      // Edytor tekstu na płótnie sam obsługuje wszystkie skróty (Ctrl+Z, Ctrl+A, Ctrl+C/V/X...)
      if (activeEl?.dataset?.figuraTextEditor === '1') return;
      const isTextEditing =
        activeEl?.tagName === 'TEXTAREA' ||
        (activeEl?.tagName === 'INPUT' &&
          (activeEl as HTMLInputElement).type === 'text' &&
          !(e.ctrlKey || e.metaKey));

      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'z' || e.key === 'Z') {
          e.preventDefault();
          if (activeEl?.tagName === 'SELECT' || (activeEl?.tagName === 'INPUT' && (activeEl as HTMLInputElement).type === 'range')) {
            activeEl.blur();
          }
          if (e.shiftKey) {
            engine.redo();
          } else {
            engine.undo();
          }
          bumpEngineRevision();
          return;
        } else if (e.key === 'y' || e.key === 'Y') {
          e.preventDefault();
          if (activeEl?.tagName === 'SELECT' || (activeEl?.tagName === 'INPUT' && (activeEl as HTMLInputElement).type === 'range')) {
            activeEl.blur();
          }
          engine.redo();
          bumpEngineRevision();
          return;
        } else if (e.key === 'a' || e.key === 'A') {
          e.preventDefault();
          engine.selectAll();
          bumpEngineRevision();
          return;
        } else if (e.key === 'd' || e.key === 'D') {
          e.preventDefault();
          engine.deselect();
          bumpEngineRevision();
          return;
        } else if (e.key === 'i' || e.key === 'I') {
          e.preventDefault();
          engine.invertSelection();
          bumpEngineRevision();
          return;
        } else if (e.key === 'x' || e.key === 'X') {
          e.preventDefault();
          handleCut();
          return;
        } else if (e.key === 'c' || e.key === 'C') {
          e.preventDefault();
          handleCopy();
          return;
        } else if (e.key === 'v' || e.key === 'V') {
          e.preventDefault();
          handlePaste(e.shiftKey);
          return;
        } else if (e.key === 't' || e.key === 'T') {
          e.preventDefault();
          setActiveTool('transform-content');
          return;
        } else if (e.key === 's' || e.key === 'S') {
          e.preventDefault();
          handleSaveFig();
          return;
        } else if (e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          setIsNewDocModalOpen(true);
          return;
        } else if (e.key === 'o' || e.key === 'O') {
          e.preventDefault();
          handleOpenFilePicker();
          return;
        } else if (e.key === '0') {
          e.preventDefault();
          setZoom(1.0);
          setPanOffset({ x: 0, y: 0 });
          return;
        }
      }

      if (isTextEditing) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 's') setActiveTool('select-rect');
      else if (key === 'm') setActiveTool('select-ellipse');
      else if (key === 'l') setActiveTool('select-lasso');
      else if (key === 'w') setActiveTool('magic-wand');
      else if (key === 't') setActiveTool('transform-selection');
      else if (key === 'b') setActiveTool('brush');
      else if (key === 'e') setActiveTool('eraser');
      else if (key === 'j') setActiveTool('correction-brush');
      else if (key === 'r') setActiveTool('color-replace');
      else if (key === 'c') setActiveTool('stamp');
      else if (key === 'd' && !(e.ctrlKey || e.metaKey)) setActiveTool('deform');
      else if (key === 'k') setActiveTool('pipette');
      else if (key === 'f') setActiveTool('bucket');
      else if (key === 'g') setActiveTool('gradient');
      else if (key === 'o') setActiveTool('shapes');
      else if (key === 'u') setActiveTool('line');
      else if (key === 'y') setActiveTool('text');
      else if (key === 'h') setActiveTool('pan');
      else if (key === 'z') setActiveTool('zoom');
      else if (key === 'v' && engine.getActiveLayer()?.isVector) setActiveTool('vector-select');
      else if (key === 'n' && engine.getActiveLayer()?.isVector) setActiveTool('pen');
      else if (key === 'p') setActiveTool('bezier');
      else if (key === 'x') {
        setPrimaryColor(secondaryColor);
        setSecondaryColor(primaryColor);
      } else if (e.key === '[' || e.key === ']') {
        const delta = e.key === ']' ? 5 : -5;
        if (activeTool === 'brush' || activeTool === 'eraser') {
          setBrushSettings((prev) => ({ ...prev, size: Math.max(1, Math.min(2000, prev.size + delta)) }));
        } else if (activeTool === 'correction-brush') {
          setCorrectionBrushSettings((prev) => ({ ...prev, size: Math.max(1, Math.min(2000, prev.size + delta)) }));
        } else if (activeTool === 'color-replace') {
          setColorReplaceSettings((prev) => ({ ...prev, size: Math.max(1, Math.min(2000, prev.size + delta)) }));
        } else if (activeTool === 'stamp') {
          setStampSettings((prev) => ({ ...prev, size: Math.max(1, Math.min(2000, prev.size + delta)) }));
        } else if (activeTool === 'deform') {
          setDeformSettings((prev) => ({ ...prev, size: Math.max(1, Math.min(2000, prev.size + delta)) }));
        }
      } else if (e.key === 'Delete' && !isLiveVectorSessionActiveRef.current && !engine.getActiveLayer()?.isVector) {
        // Przy aktywnej sesji (np. krzywa) Delete należy do sesji (usuwa węzeł), a nie czyści warstwy
        const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
        engine.getActiveLayer()?.clear(mask);
        bumpEngineRevision();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [engine, primaryColor, secondaryColor, activeTool, bumpEngineRevision, handleCut, handleCopy, handlePaste]);

  const menuHandlers: MenuActionHandlers = {
    onNew: () => setIsNewDocModalOpen(true),
    onOpen: handleOpenFilePicker,
    onSaveFig: handleSaveFig,
    onExportPng: handleExportPng,
    onExportJpg: handleExportJpg,
    onUndo: () => {
      engine.undo();
      bumpEngineRevision();
    },
    onRedo: () => {
      engine.redo();
      bumpEngineRevision();
    },
    canUndo: engine.canUndo(),
    canRedo: engine.canRedo(),
    onClearLayer: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.clear(mask);
      bumpEngineRevision();
    },
    onFillLayer: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.fill(primaryColor, mask);
      bumpEngineRevision();
    },
    onCut: handleCut,
    onCopy: handleCopy,
    onPaste: () => handlePaste(),
    onSelectAll: () => {
      engine.selectAll();
      bumpEngineRevision();
    },
    onDeselect: () => {
      engine.deselect();
      bumpEngineRevision();
    },
    onInvertSelection: () => {
      engine.invertSelection();
      bumpEngineRevision();
    },
    onTransformSelection: () => {
      setActiveTool('transform-selection');
    },
    onTransformContent: () => {
      setActiveTool('transform-content');
    },
    onZoomIn: () => setZoom((z) => Math.min(25.0, Number((z * 1.25).toFixed(2)))),
    onZoomOut: () => setZoom((z) => Math.max(0.05, Number((z / 1.25).toFixed(2)))),
    onZoomReset: () => {
      setZoom(1.0);
      setPanOffset({ x: 0, y: 0 });
    },
    onFlipHorizontal: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      engine.getActiveLayer()?.flipHorizontal();
      bumpEngineRevision();
    },
    onFlipVertical: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      engine.getActiveLayer()?.flipVertical();
      bumpEngineRevision();
    },
    onInvertColors: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.invertColors(mask);
      bumpEngineRevision();
    },
    onGrayscale: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.toGrayscale(mask);
      bumpEngineRevision();
    },
    onBrightnessUp: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.adjustBrightnessContrast(20, 0, mask);
      bumpEngineRevision();
    },
    onContrastUp: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.adjustBrightnessContrast(0, 20, mask);
      bumpEngineRevision();
    },
    onAddLayer: () => {
      engine.addLayer();
      bumpEngineRevision();
    },
    onRemoveLayer: () => {
      engine.removeActiveLayer();
      bumpEngineRevision();
    },
    onDuplicateLayer: () => {
      engine.duplicateActiveLayer();
      bumpEngineRevision();
    },
    onMergeLayerDown: () => {
      engine.mergeLayerDown();
      bumpEngineRevision();
    },
    onMoveLayerUp: () => {
      engine.moveActiveLayerUp();
      bumpEngineRevision();
    },
    onMoveLayerDown: () => {
      engine.moveActiveLayerDown();
      bumpEngineRevision();
    },
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#1e1e1e] text-[#dddddd] font-sans">
      <input
        ref={fileInputRef}
        type="file"
        accept=".fig,application/json,image/*"
        onChange={handleFileLoaded}
        className="hidden"
      />

      {/* 1. Pasek tytułu: FIGURA + Zakładki */}
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        onNewTab={() => setIsNewDocModalOpen(true)}
      />

      {/* 2. Menu główne z sekcją Zaznacz */}
      <MenuBar handlers={menuHandlers} />

      {/* 3. Pasek opcji narzędzi z opcjami zaznaczania, transformacji i figur/linii */}
      <ToolOptionsBar
        brushSettings={brushSettings}
        onChangeSettings={handleUpdateBrushSettings}
        correctionBrushSettings={correctionBrushSettings}
        onChangeCorrectionBrushSettings={handleUpdateCorrectionBrushSettings}
        colorReplaceSettings={colorReplaceSettings}
        onChangeColorReplaceSettings={handleUpdateColorReplaceSettings}
        stampSettings={stampSettings}
        onChangeStampSettings={handleUpdateStampSettings}
        stampBasePoint={stampBasePoint}
        onResetStampBasePoint={() => setStampBasePoint(null)}
        deformSettings={deformSettings}
        onChangeDeformSettings={handleUpdateDeformSettings}
        selectionSettings={selectionSettings}
        onChangeSelectionSettings={handleUpdateSelectionSettings}
        pipetteSettings={pipetteSettings}
        onChangePipetteSettings={handleUpdatePipetteSettings}
        gradientSettings={gradientSettings}
        onChangeGradientSettings={handleUpdateGradientSettings}
        vectorShapeSettings={vectorShapeSettings}
        onChangeVectorShapeSettings={handleUpdateVectorShapeSettings}
        lineAndCurveSettings={lineAndCurveSettings}
        onChangeLineAndCurveSettings={handleUpdateLineAndCurveSettings}
        textSettings={textSettings}
        onChangeTextSettings={handleUpdateTextSettings}
        onRequestTextFocus={() => setTextFocusTrigger((c) => c + 1)}
        primaryColor={primaryColor}
        secondaryColor={secondaryColor}
        onChangePrimaryColorAlpha={(a) => setPrimaryColor((prev) => ({ ...prev, a }))}
        activeTool={activeTool === 'vector-select' ? (vectorEditKind ?? activeTool) : activeTool === 'pen' ? 'bezier' : activeTool}
        flipDisabled={engine.perspectiveActive}
        onFlipHorizontal={() => {
          if (engine.perspectiveActive) return;
          engine.selectionManager.flipHorizontal();
          bumpEngineRevision();
        }}
        onFlipVertical={() => {
          if (engine.perspectiveActive) return;
          engine.selectionManager.flipVertical();
          bumpEngineRevision();
        }}
        isLiveVectorSessionActive={isLiveVectorSessionActive}
        onCommitLiveVectorSession={() => setLiveVectorCommitTrigger((c) => c + 1)}
        onCancelLiveVectorSession={() => setLiveVectorCancelTrigger((c) => c + 1)}
        penInfo={penInfo}
        onTogglePenClosed={() => setPenCloseToggleTrigger((c) => c + 1)}
      />

      {/* 4. Główny obszar roboczy */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* Pływające powiadomienie Toast dla zablokowanej warstwy */}
        {toastMessage && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-[#2d1b10] border border-amber-500/80 text-amber-200 px-4 py-2 rounded-md shadow-2xl text-xs font-semibold flex items-center gap-2 z-50 backdrop-blur-md pointer-events-none animate-bounce">
            <Lock size={15} className="text-amber-400 shrink-0" />
            <span>{toastMessage}</span>
          </div>
        )}

        <Toolbox
          vectorMode={activeIsVector}
          activeTool={activeTool}
          onSelectTool={setActiveTool}
          activeShapeType={vectorShapeSettings.shapeKind}
          onSelectShapeType={(sh) => setVectorShapeSettings((prev) => ({ ...prev, shapeKind: sh }))}
        />

        <CanvasViewport
          engine={engine}
          engineRevision={engineRevision}
          brushSettings={brushSettings}
          correctionBrushSettings={correctionBrushSettings}
          colorReplaceSettings={colorReplaceSettings}
          stampSettings={stampSettings}
          stampBasePoint={stampBasePoint}
          onSetStampBasePoint={setStampBasePoint}
          deformSettings={deformSettings}
          selectionSettings={selectionSettings}
          onChangeSelectionSettings={handleUpdateSelectionSettings}
          pipetteSettings={pipetteSettings}
          gradientSettings={gradientSettings}
          vectorShapeSettings={vectorShapeSettings}
          onChangeVectorShapeSettings={handleUpdateVectorShapeSettings}
          lineAndCurveSettings={lineAndCurveSettings}
          onChangeLineAndCurveSettings={handleUpdateLineAndCurveSettings}
          textSettings={textSettings}
          textFormatRequest={textFormatRequest}
          onSyncTextSettings={handleSyncTextSettings}
          textFocusTrigger={textFocusTrigger}
          primaryColor={primaryColor}
          secondaryColor={secondaryColor}
          activeTool={activeTool}
          activeShapeType={vectorShapeSettings.shapeKind}
          zoom={zoom}
          panOffset={panOffset}
          onUpdateZoom={setZoom}
          onUpdatePan={setPanOffset}
          onPipettePick={(color, isSecondary) => {
            if (isSecondary) {
              setSecondaryColor(color);
            } else {
              setPrimaryColor(color);
              setBrushSettings((prev) => ({ ...prev, color }));
            }
          }}
          onCanvasModified={bumpEngineRevision}
          onLiveVectorSessionChange={setIsLiveVectorSessionActive}
          liveVectorCommitTrigger={liveVectorCommitTrigger}
          liveVectorCancelTrigger={liveVectorCancelTrigger}
          penCloseToggleTrigger={penCloseToggleTrigger}
          onPenInfoChange={setPenInfo}
          onVectorEditKind={setVectorEditKind}
              onVectorSelectionChange={bumpEngineRevision}
          vectorEditRequest={vectorEditRequest}
          onShowToast={showToast}
        />

        {/* Prawy panel boczny: Kolor + Warstwy */}
        <div className="w-[224px] bg-[#1e1e1e] border-l border-[#2c2c2d] p-2 flex flex-col gap-3 overflow-y-auto z-10 select-none flex-shrink-0">
          <ColorPanel
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            // Sama zmiana koloru nie zmienia pikseli dokumentu, więc nie wymusza ponownego złożenia warstw
            // (sesje gradientu, wiadra i figur odświeżają się same, bo zależą od koloru)
            onChangePrimaryColor={setPrimaryColor}
            onChangeSecondaryColor={setSecondaryColor}
          />

          <LayersPanel
            layers={engine.layers}
            activeLayerIndex={engine.activeLayerIndex}
            onSelectLayer={(idx) => {
              if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
              if (engine.gradientStartPoint) engine.commitGradientSession();
              // zachowuje cel edycji (piksele / maska) wybranej warstwy; zmiana warstwy kończy podgląd maski
              engine.setEditTarget(idx, engine.layers[idx]?.editMask ? 'mask' : 'pixels');
              engine.selectedCorrection = null;
              bumpEngineRevision();
            }}
            onSelectTarget={(idx, target) => {
              engine.setEditTarget(idx, target);
              bumpEngineRevision();
            }}
            onViewMask={(idx) => {
              engine.setMaskView(idx);
              bumpEngineRevision();
            }}
            maskViewIndex={engine.maskView ? engine.layers.indexOf(engine.maskView) : null}
            onAddMask={() => {
              engine.addLayerMask(engine.selectionManager.hasActiveSelection);
              bumpEngineRevision();
            }}
            onApplyMask={() => {
              engine.removeLayerMask(true);
              bumpEngineRevision();
            }}
            onToggleMaskEnabled={(idx) => {
              engine.toggleMaskEnabled(idx);
              bumpEngineRevision();
            }}
            onToggleMaskLink={(idx) => {
              engine.toggleMaskLink(idx);
              bumpEngineRevision();
            }}
            hasSelection={engine.selectionManager.hasActiveSelection}
            editingCorrectionId={correctionDlg ? correctionDlg.correction.id : null}
            editingStylesLayerId={stylesDlg ? stylesDlg.layer.id : null}
            onOpenStyles={(idx) => startStylesEdit(idx)}
            onToggleStylesVisible={(idx) => {
              if (!engine.toggleStylesVisible(idx)) showToast('Nie można zmienić stylizacji: warstwa jest zablokowana');
              bumpEngineRevision();
            }}
            onOpenCorrection={(idx, type, onlyActive) => startCorrectionEdit(idx, { type, onlyActive })}
            onEditCorrection={(idx, id) => startCorrectionEdit(idx, { id })}
            onToggleCorrection={(idx, id) => {
              if (!engine.toggleCorrection(idx, id)) showToast('Nie można zmienić korekcji: warstwa jest zablokowana');
              bumpEngineRevision();
            }}
            onRemoveCorrection={(idx, id) => {
              if (!engine.removeCorrection(idx, id)) showToast('Nie można usunąć korekcji: warstwa jest zablokowana');
              bumpEngineRevision();
            }}
            onDuplicateCorrection={(idx, id) => {
              if (!engine.duplicateCorrection(idx, id)) showToast('Nie można zduplikować korekcji: warstwa jest zablokowana');
              bumpEngineRevision();
            }}
            onMoveCorrection={(from, id, to, at) => {
              const a = engine.layers[from];
              const b = engine.layers[to];
              if ((a && engine.correctionsLocked(a)) || (b && engine.correctionsLocked(b))) {
                showToast('Nie można przenieść korekcji: warstwa jest zablokowana');
                return;
              }
              engine.moveCorrection(from, id, to, at);
              bumpEngineRevision();
            }}
            onToggleCorrectionsExpanded={(idx) => {
              engine.setCorrectionsExpanded(idx, !engine.layers[idx]?.correctionsExpanded);
              bumpEngineRevision();
            }}
            onAddGroup={() => {
              if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
              if (engine.gradientStartPoint) engine.commitGradientSession();
              engine.addGroup();
              bumpEngineRevision();
            }}
            onToggleExpand={(idx) => {
              const g = engine.layers[idx];
              const act = engine.getActiveLayer();
              // zwijana grupa z aktywną warstwą w środku: zaznaczamy grupę (ukryta warstwa nie może być celem przycisków panelu)
              const hidesActive = !!g && g.isGroup && g.expanded && !!act && act !== g && act.groupId === g.id;
              if (hidesActive) {
                if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
                if (engine.gradientStartPoint) engine.commitGradientSession();
              }
              engine.toggleGroupExpanded(idx);
              if (hidesActive) {
                engine.setEditTarget(idx, g.editMask ? 'mask' : 'pixels');
                engine.selectedCorrection = null;
              }
              bumpEngineRevision();
            }}
            onAddVectorLayer={() => {
              if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
              if (engine.gradientStartPoint) engine.commitGradientSession();
              engine.addVectorLayer();
              setActiveToolRaw('vector-select');
              bumpEngineRevision();
            }}
            editingVectorObject={engine.vec.editingInfo}
            selectedVectorObjects={engine.vec.getSelection()}
            pendingVectorObject={(() => {
              const act = engine.getActiveLayer();
              if (!isLiveVectorSessionActive || !act?.isVector || engine.vec.editing) return null;
              const names: Record<string, string> = { line: 'Linia', bezier: 'Krzywa', shapes: 'Kształt', text: 'Tekst', pen: 'Pisak' };
              return { layerId: act.id, label: names[activeTool] ?? 'Obiekt' };
            })()}
            onSelectVectorObjects={(idx, ids) => {
              engine.setEditTarget(idx, 'pixels');
              setActiveToolRaw('vector-select');
              engine.vec.settle();
              engine.vec.setSelection(engine.layers[idx]?.id ?? null, ids);
              bumpEngineRevision();
            }}
            onEditVectorObject={(idx, id) => {
              engine.setEditTarget(idx, 'pixels');
              setActiveToolRaw('vector-select');
              setVectorEditRequest((r) => ({ n: (r?.n ?? 0) + 1, layerIndex: idx, id }));
              bumpEngineRevision();
            }}
            onToggleVectorObject={(idx, id, vis) => {
              engine.vec.setObjectVisible(idx, id, vis);
              bumpEngineRevision();
            }}
            onRemoveVectorObject={(idx, id) => {
              if (!engine.vec.removeObject(idx, id)) showToast('Nie można usunąć obiektu: warstwa jest zablokowana albo obiekt jest właśnie edytowany');
              bumpEngineRevision();
            }}
            onRenameVectorObject={(idx, id, name) => {
              engine.vec.renameObject(idx, id, name);
              bumpEngineRevision();
            }}
            onMoveVectorObject={(from, id, to, pos) => {
              if (!engine.vec.moveObject(from, id, to, pos)) showToast('Nie można przenieść obiektu: warstwa jest zablokowana albo nie jest wektorowa');
              bumpEngineRevision();
            }}
            onAddLayer={() => {
              if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
              if (engine.gradientStartPoint) engine.commitGradientSession();
              engine.addLayer();
              bumpEngineRevision();
            }}
            onRemoveLayer={() => {
              const vs = vectorSelection();
              if (vs) {
                // zaznaczone obiekty wektorowe: przycisk usuwa je, a nie całą warstwę
                if (!engine.vec.deleteObjects(vs.idx, vs.ids)) showToast('Nie można usunąć obiektów: warstwa jest zablokowana');
                bumpEngineRevision();
                return;
              }
              if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
              if (engine.gradientStartPoint) engine.commitGradientSession();
              const act = engine.getActiveLayer();
              // zaznaczona maska: usuwa tylko maskę; zaznaczona warstwa: warstwę razem z ewentualną maską
              if (!engine.selectedCorrection && act?.hasMask && act.editMask) {
                engine.removeLayerMask(false);
                bumpEngineRevision();
                return;
              }
              if (!engine.selectedCorrection && act && engine.correctionsLocked(act) && (act.isGroup || act.isAdjustment || act.locked)) {
                showToast(act.isGroup ? 'Nie można usunąć zablokowanej grupy' : 'Nie można usunąć zablokowanej warstwy');
                return;
              }
              engine.removeActiveLayer();
              bumpEngineRevision();
            }}
            onDuplicateLayer={() => {
              const vs = vectorSelection();
              if (vs) {
                if (engine.vec.duplicateObjects(vs.idx, vs.ids).length === 0) showToast('Nie można zduplikować obiektów: warstwa jest zablokowana');
                else setActiveToolRaw('vector-select');
                bumpEngineRevision();
                return;
              }
              if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
              if (engine.gradientStartPoint) engine.commitGradientSession();
              engine.duplicateActiveLayer();
              bumpEngineRevision();
            }}
            mergeDownApplies={engine.applyEffectsMode !== 'none'}
            applyEffectsMode={engine.applyEffectsMode}
            selectedCorrection={engine.selectedCorrection}
            onSelectCorrection={(idx, id) => {
              engine.setEditTarget(idx, 'pixels');
              engine.selectCorrection(idx, id);
              bumpEngineRevision();
            }}
            onMoveCorrectionToStack={(from, id, target, place) => {
              const a = engine.layers[from];
              if (a && engine.correctionsLocked(a)) {
                showToast('Nie można przenieść korekcji: warstwa jest zablokowana');
                return;
              }
              engine.moveCorrectionToStack(from, id, target, place);
              bumpEngineRevision();
            }}
            onMergeDown={() => {
              // Zaznaczony efekt / warstwa z korekcjami / korekcja w stosie: „Zastosuj efekty” wpieka je w piksele;
              // bez efektów przycisk łączy warstwę w dół
              if (engine.applyEffectsMode !== 'none') {
                if (!engine.applyEffects()) showToast('Nie można zastosować efektów: warstwa jest zablokowana albo pod korekcją leży warstwa wektorowa (jej piksele są wyliczane z obiektów)');
                bumpEngineRevision();
                return;
              }
              if (!engine.mergeLayerDown()) {
                showToast('Nie można scalić: warstwa jest zablokowana, poniżej jest granica grupy albo warstwa wektorowa');
                return;
              }
              bumpEngineRevision();
            }}
            onMoveUp={() => {
              const vs = vectorSelection();
              if (vs) {
                engine.vec.shiftObjects(vs.idx, vs.ids, 1);
                bumpEngineRevision();
                return;
              }
              engine.moveActiveLayerUp();
              bumpEngineRevision();
            }}
            onMoveDown={() => {
              const vs = vectorSelection();
              if (vs) {
                engine.vec.shiftObjects(vs.idx, vs.ids, -1);
                bumpEngineRevision();
                return;
              }
              engine.moveActiveLayerDown();
              bumpEngineRevision();
            }}
            onMoveAdjustmentToLayer={(a, t, i) => {
              engine.moveAdjustmentToLayer(a, t, i);
              bumpEngineRevision();
            }}
            onMoveLayerTo={(from, to, place) => {
              engine.moveLayerTo(from, to, place);
              bumpEngineRevision();
            }}
            onToggleVisibility={(idx) => {
              engine.toggleLayerVisibility(idx);
              bumpEngineRevision();
            }}
            onToggleLock={(idx) => {
              engine.toggleLayerLock(idx);
              bumpEngineRevision();
            }}
            onChangeOpacity={(idx, opacity, recordOldValue) => {
              engine.setLayerOpacity(idx, opacity, recordOldValue);
              bumpEngineRevision();
            }}
            onChangeBlendMode={(idx, mode: SKBlendMode) => {
              engine.setLayerBlendMode(idx, mode);
              bumpEngineRevision();
            }}
            onRenameLayer={(idx, newName) => {
              if (engine.layers[idx]) {
                engine.layers[idx].name = newName;
                bumpEngineRevision();
              }
            }}
          />
        </div>
      </div>

      {/* 5. Dolny pasek stanu */}
      <StatusBar
        statusText="Gotowy"
        docWidth={engine.width}
        docHeight={engine.height}
        zoom={zoom}
        onZoomChange={setZoom}
      />

      {/* Pływające okno korekcji (podgląd na żywo na płótnie) */}
      {correctionDlg && correctionDlg.engine === engine && (
        <CorrectionDialog
          key={correctionDlg.correction.id + correctionDlg.token}
          correction={correctionDlg.correction}
          layerName={correctionDlg.layer.isAdjustment ? null : correctionDlg.layer.name}
          isNew={correctionDlg.isNew}
          histogram={correctionDlg.histogram}
          onChangeParams={(params) => {
            engine.updateCorrectionLive({ params });
            scheduleLiveRefresh();
          }}
          onPreviewToggle={(on) => {
            engine.updateCorrectionLive({ enabled: on });
            scheduleLiveRefresh();
          }}
          onOk={() => finishCorrectionEdit(true)}
          onCancel={() => finishCorrectionEdit(false)}
        />
      )}

      {/* Pływające okno stylizacji warstwy (podgląd na żywo na płótnie) */}
      {stylesDlg && stylesDlg.engine === engine && (
        <StylesDialog
          key={stylesDlg.layer.id + stylesDlg.token}
          layerName={stylesDlg.layer.name}
          initial={stylesDlg.initial}
          isNew={stylesDlg.isNew}
          onChange={(styles) => {
            engine.updateStylesLive(styles);
            scheduleLiveRefresh();
          }}
          onOk={() => finishStylesEdit(true)}
          onCancel={() => finishStylesEdit(false)}
        />
      )}

      {/* Modal Nowego Dokumentu */}
      <NewDocumentModal
        isOpen={isNewDocModalOpen}
        onClose={() => setIsNewDocModalOpen(false)}
        onCreate={handleCreateNewDocument}
        defaultTitle={`obraz${tabs.length + 1}.fig`}
      />
    </div>
  );
}
