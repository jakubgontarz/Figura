/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Główny komponent edytora Figura: zarządza zakładkami dokumentów, ustawieniami narzędzi, schowkiem i skrótami klawiszowymi
 * oraz składa interfejs z pasków, płótna i paneli bocznych.
 */

import { VectorObject, newVectorId, vectorObjectLabel } from './core/VectorObjects.ts';
import { ensureDiskImage, pickDiskImage, reconnectDiskImage, setDiskReadyHook } from './core/DiskImages.ts';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Lock, FilePlus, FolderOpen } from 'lucide-react';
import { registerSmartBitmap, setSmartReadyHook } from './core/SmartObjects.ts';
import { GraphicEngine } from './core/GraphicEngine.ts';
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
  StampSettings,
  ToolType,
  VectorShapeSettings,
  SmartObjectSettings,
  TextToolSettings,
} from './core/types.ts';
import { TitleBar } from './components/TitleBar.tsx';
import { MenuBar, MenuActionHandlers } from './components/MenuBar.tsx';
import { ToolOptionsBar } from './components/ToolOptionsBar.tsx';
import { Toolbox } from './components/Toolbox.tsx';
import { CanvasViewport } from './components/CanvasViewport.tsx';
import { PropertiesPanel, PropsDescriptor, PropsApi } from './components/PropertiesPanel.tsx';
import { ColorPanel } from './components/ColorPanel.tsx';
import { NavigatorPanel } from './components/NavigatorPanel.tsx';
import { LayersPanel } from './components/LayersPanel.tsx';
import { LayerPropsDialog } from './components/LayerPropsDialog.tsx';
import { buildLayersMenu, LayersMenuState } from './components/layersMenu.ts';
import { buildImageMenu } from './components/imageMenu.ts';
import { buildEditMenu } from './components/editMenu.ts';
import { PasteFitDialog } from './components/PasteFitDialog.tsx';
import { buildViewMenu } from './components/viewMenu.ts';
import { buildSelectionMenu } from './components/selectionMenu.ts';
import { SelectionOffsetDialog } from './components/SelectionOffsetDialog.tsx';
import { SettingsDialog } from './components/SettingsDialog.tsx';
import { buildFileMenu } from './components/fileMenu.ts';
import { ExportDialog } from './components/ExportDialog.tsx';
import { PrintDialog } from './components/PrintDialog.tsx';
import { DocPropsDialog } from './components/DocPropsDialog.tsx';
import { UnsavedDialog, UnsavedAnswer } from './components/UnsavedDialog.tsx';
import { appWindow, canWriteInPlace, FileRef, isTauri, openFiles, OpenedFile, pickFileNear, readRef, saveFile, readClipboardItems, canReadClipboard } from './platform/index.ts';
import { recents, RecentItem } from './core/Recent.ts';
import { saveWindowStateNow } from './platform/windowState.ts';
import { encodeExport, ExportOptions, formatInfo, sniffDpi } from './core/Export.ts';
import { ImageResizeDialog } from './components/ImageResizeDialog.tsx';
import { CanvasSizeDialog } from './components/CanvasSizeDialog.tsx';
import { settings, type Settings } from './core/Settings.ts';
import { toolForKey } from './core/ToolKeys.ts';
import { useSettings } from './components/useSettings.ts';
import { HistoryPanel } from './components/HistoryPanel.tsx';
import { ChannelsPanel } from './components/ChannelsPanel.tsx';
import { UnitsContext } from './components/Units.tsx';
import type { LengthUnit } from './core/Units.ts';
import { StatusBar } from './components/StatusBar.tsx';
import { NewDocumentModal } from './components/NewDocumentModal.tsx';
import { CorrectionDialog } from './components/CorrectionDialog.tsx';
import { StylesDialog } from './components/StylesDialog.tsx';
import { LayerStyles } from './core/Styles.ts';
import { Correction, CorrectionType, Histogram } from './core/Corrections.ts';
import type { LayerTransformOp } from './core/VectorObjects.ts';
import type { Layer } from './core/Layer.ts';
import { BrushAdjustFns, clampSize, clampPct, clampSpacing, pctToAlpha, alphaToPct, stepSize, supportsOpacity } from './core/brushAdjust.ts';

/** Narzędzia dostępne na warstwie wektorowej (reszta działa na pikselach). */
const VECTOR_LAYER_TOOLS = new Set<ToolType>(['vector-select', 'pen', 'smart-object', 'guides', 'shapes', 'line', 'bezier', 'text', 'pipette', 'pan', 'zoom']);
/** Narzędzia działające wyłącznie na warstwie wektorowej. */
const VECTOR_ONLY_TOOLS = new Set<ToolType>(['vector-select', 'pen']);

/** Zakładka dokumentu z własnym silnikiem graficznym. */
interface DocumentTab {
  id: string;
  title: string;
  engine: GraphicEngine;
  /** Zakładka obiektu inteligentnego: skąd pochodzi (zakładka nadrzędna, warstwa, obiekt) i zawartość wyjściowa. */
  smart?: { parentTabId: string; layerId: string; objectId: string; origFig: string | null };
  /** Plik .fig, z którego dokument pochodzi albo w którym został zapisany (brak = jeszcze nie zapisany) */
  file?: FileRef | null;
  /** Stan historii i metadanych w chwili ostatniego zapisu (do wykrywania niezapisanych zmian) */
  savedMark?: object | null;
  savedMeta?: number;
  savedAt?: number | null;
  fileSize?: number | null;
}

/** Czy dokument ma zmiany od ostatniego zapisu. Zakładki obiektów inteligentnych nie mają własnego pliku, więc nigdy nie są „zmienione”. */
const tabDirty = (t: DocumentTab): boolean => !t.smart && (t.engine.historyMark() !== (t.savedMark ?? null) || t.engine.metaRevision !== (t.savedMeta ?? 0));

const FIG_FILTERS = [{ name: 'Projekt Figura (*.fig)', extensions: ['fig'] }];
const OPEN_FILTERS = [
  { name: 'Projekty i obrazy', extensions: ['fig', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
  { name: 'Projekt Figura (*.fig)', extensions: ['fig'] },
  { name: 'Obrazy', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
];
/** Nazwa pliku bez znaków niedozwolonych w systemie plików. */
const safeFileName = (n: string): string => n.replace(/[\\/:*?"<>|]/g, '_').trim() || 'bez-tytulu';

/** Powiększenie i przesunięcie widoku jednej zakładki. */
interface TabView {
  zoom: number;
  pan: { x: number; y: number };
}
const ZERO_PAN = { x: 0, y: 0 };

/** Początkowe powiększenie dużych dokumentów, żeby mieściły się w widoku. */
const initialZoomFor = (w: number, h: number): number => {
  const maxDim = Math.max(w, h);
  return maxDim > 1600 ? 0.3 : maxDim > 1000 ? 0.6 : 1.0;
};

/** Kolor akcentu zakładek obiektów inteligentnych. */
const SMART_TAB_COLOR = '#e0a43a';

/** Korzeń aplikacji: renderuje cały interfejs edytora i przechowuje jego stan. */
export default function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>(() => {
    const st0 = settings.get();
    const doc1 = new GraphicEngine('obraz1.fig', st0.newDocWidth, st0.newDocHeight);
    doc1.dpi = st0.newDocDpi;
    if (st0.newDocBackground === 'none') doc1.initDefaultLayers('none');
    return [{ id: 'tab_1', title: 'obraz1', engine: doc1, file: null, savedMark: doc1.historyMark(), savedMeta: doc1.metaRevision }];
  });

  const [activeTabId, setActiveTabId] = useState<string>('tab_1');
  /** Jednostka wymiarów i pól liczbowych (px / mm / cm / cal). Dokumenty obiektów inteligentnych są zawsze w pikselach. */
  const cfg = useSettings();
  /** Wartość ustawienia z funkcją aktualizującą jak w `useState` (zapamiętywane w ustawieniach programu). */
  const settingState = <K extends 'rulers' | 'grid' | 'guides' | 'snap'>(key: K) => (v: boolean | ((p: boolean) => boolean)) =>
    settings.set({ [key]: typeof v === 'function' ? v(settings.get()[key]) : v } as Partial<Settings>);
  const lengthUnit: LengthUnit = cfg.lengthUnit;
  const setLengthUnit = (u: LengthUnit) => settings.set({ lengthUnit: u });
  const tabsRef = useRef<DocumentTab[]>([]);
  tabsRef.current = tabs;
  // Zmiana domyślnego próbkowania w ustawieniach przestawia też bieżący wybór na pasku opcji
  useEffect(() => {
    setSelectionSettings((prev) => ({ ...prev, interpolation: cfg.defaultInterpolation }));
  }, [cfg.defaultInterpolation]);
  // Zmiana limitów historii działa od razu: nadmiarowe kroki otwartych dokumentów są usuwane
  useEffect(() => {
    for (const t of tabsRef.current) t.engine.trimHistory();
  }, [cfg.historyMB, cfg.historySteps]);
  const activeTabIdRef = useRef('tab_1');
  activeTabIdRef.current = activeTabId;
  /** Aktywna zakładka; po zamknięciu wszystkich zakładek jej nie ma (wtedy pokazywany jest pusty obszar roboczy). */
  const activeTab: DocumentTab | undefined = tabs.find((t) => t.id === activeTabId) || tabs[0];
  /** Pusty, nigdy niepokazywany dokument: pozwala hookom działać, gdy nie ma otwartych zakładek. */
  const [idleEngine] = useState(() => new GraphicEngine('', 1, 1));
  const engine = activeTab ? activeTab.engine : idleEngine;
  const effectiveUnit: LengthUnit = activeTab?.smart ? 'px' : lengthUnit;

  const [engineRevision, setEngineRevision] = useState(0);
  const bumpEngineRevision = useCallback(() => {
    setEngineRevision((r) => r + 1);
  }, []);

  // Okno edycji korekcji: zmiany są stosowane na żywo na warstwie, a OK / Anuluj kończą sesję edycji
  const [correctionDlg, setCorrectionDlg] = useState<{
    engine: GraphicEngine;
    layer: Layer;
    correction: Correction;
    isNew: boolean;
    histogram: Histogram | null;
    token: number;
  } | null>(null);
  // Okno stylizacji warstwy: korzysta z tej samej sesji podglądu na żywo co korekcje
  const [stylesDlg, setStylesDlg] = useState<{
    engine: GraphicEngine;
    layer: Layer;
    initial: LayerStyles;
    isNew: boolean;
    token: number;
  } | null>(null);
  const liveRefreshRaf = useRef(0);
  // Suwak może generować zdarzenia częściej niż klatki animacji, więc odświeżenie płótna jest scalane do jednego na klatkę
  const scheduleLiveRefresh = useCallback(() => {
    if (liveRefreshRaf.current) return;
    liveRefreshRaf.current = requestAnimationFrame(() => {
      liveRefreshRaf.current = 0;
      setEngineRevision((r) => r + 1);
    });
  }, []);

  // ---- Powiadomienia ----
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Okno „Tryb mieszania…” / „Przezroczystość…” z menu Warstwy i wspólna opcja „tylko aktywna warstwa” przy dodawaniu efektów
  const [imageDlg, setImageDlg] = useState<'resize' | 'canvas' | null>(null);
  const [selOffsetDlg, setSelOffsetDlg] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [layerPropsDlg, setLayerPropsDlg] = useState<{ kind: 'blend' | 'opacity'; layer: Layer; blend: SKBlendMode; opacity: number } | null>(null);
  const [corrOnlyActive, setCorrOnlyActive] = useState(true);

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
        // Zaznaczona grupa lub korekcja w stosie: nowa korekcja trafia do stosu i działa na warstwy pod nią
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

  // Sesja edycji zakończona z zewnątrz (cofnięcie, zmiana warstwy, inna operacja na warstwach) zamyka okno
  useEffect(() => {
    if (correctionDlg && (!correctionDlg.engine.hasCorrectionSession || correctionDlg.engine.stylesEditing)) setCorrectionDlg(null);
    if (stylesDlg && !stylesDlg.engine.stylesEditing) setStylesDlg(null);
  }, [correctionDlg, stylesDlg, engineRevision]);

  // Przełączenie na inny dokument zatwierdza edycję trwającą w dokumencie, w którym została rozpoczęta
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

  // ---- Kolory ----
  const [primaryColor, setPrimaryColor] = useState<SKColor>({ r: 255, g: 0, b: 0, a: 255 });
  const [secondaryColor, setSecondaryColor] = useState<SKColor>({ r: 255, g: 255, b: 255, a: 255 });

  // ---- Ustawienia pędzla ----
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

  // ---- Ustawienia pędzla korekcyjnego ----
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

  // ---- Ustawienia pędzla podmiany koloru ----
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

  // ---- Ustawienia pieczątki (klonowania) ----
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

  // ---- Ustawienia deformacji ----
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

  // ---- Ustawienia zaznaczania ----
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
    interpolation: settings.get().defaultInterpolation,
    lassoMode: 'freehand',
  });

  const handleUpdateSelectionSettings = (newSettings: Partial<SelectionSettings>) => {
    setSelectionSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // ---- Ustawienia pipety ----
  const [pipetteSettings, setPipetteSettings] = useState<PipetteSettings>({
    sampleSource: 'image',
    sampleDiameter: 1,
    showLoupe: true,
  });

  const handleUpdatePipetteSettings = (newSettings: Partial<PipetteSettings>) => {
    setPipetteSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // ---- Ustawienia gradientu ----
  const [gradientSettings, setGradientSettings] = useState<GradientSettings>({
    type: 'linear',
    repeat: 'none',
    reverse: false,
    blendMode: 'SrcOver',
  });

  const handleUpdateGradientSettings = (newSettings: Partial<GradientSettings>) => {
    setGradientSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // ---- Ustawienia figur wektorowych ----
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

  const [smartSettings, setSmartSettings] = useState<SmartObjectSettings>({ width: 400, height: 300, blendMode: 'SrcOver' });
  const handleUpdateSmartSettings = useCallback((n: Partial<SmartObjectSettings>) => setSmartSettings((p) => ({ ...p, ...n })), []);
  const handleUpdateVectorShapeSettings = (newSettings: Partial<VectorShapeSettings>) => {
    setVectorShapeSettings((prev) => ({ ...prev, ...newSettings }));
  };

  // ---- Ustawienia narzędzia tekstu ----
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
  // Żądanie zmiany ustawień z paska opcji: edytor tekstu stosuje ją do zaznaczenia lub całego tekstu (id odróżnia kolejne żądania)
  const [textFormatRequest, setTextFormatRequest] = useState<{ id: number; patch: Partial<TextToolSettings> } | null>(null);
  const handleUpdateTextSettings = (patch: Partial<TextToolSettings>) => {
    setTextSettings((prev) => ({ ...prev, ...patch }));
    setTextFormatRequest((prev) => ({ id: (prev?.id ?? 0) + 1, patch }));
  };
  // Synchronizuje pasek opcji ze stylem w miejscu kursora, bez ponownego stosowania go do tekstu
  const handleSyncTextSettings = useCallback((patch: Partial<TextToolSettings>) => {
    setTextSettings((prev) => ({ ...prev, ...patch }));
  }, []);
  const [textFocusTrigger, setTextFocusTrigger] = useState(0);

  // ---- Ustawienia linii i krzywych Beziera ----
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

  // Obrys i wypełnienie narzędzi wektorowych oraz tekstu podążają za kolorem głównym i dodatkowym
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

  // ---- Sesja wektorowa (linia, krzywa, figura) ----
  const [isLiveVectorSessionActive, setIsLiveVectorSessionActive] = useState(false);
  const [liveVectorCommitTrigger, setLiveVectorCommitTrigger] = useState(0);
  const [liveVectorCancelTrigger, setLiveVectorCancelTrigger] = useState(0);
  const [penCloseToggleTrigger, setPenCloseToggleTrigger] = useState(0);
  const [penInfo, setPenInfo] = useState({ active: false, closed: false, count: 0 });

  // ---- Narzędzia ----
  const [activeTool, setActiveToolRaw] = useState<ToolType>('brush');
  const [guideAxis, setGuideAxis] = useState<'h' | 'v'>('v');
  const snapEnabled = cfg.snap;
  const setSnapEnabled = settingState('snap');
  const guidesVisible = cfg.guides;
  const setGuidesVisible = settingState('guides');
  /** Siatka pikseli (przy dużym powiększeniu) i linijki na krawędziach obszaru rysowania */
  const gridVisible = cfg.grid;
  const setGridVisible = settingState('grid');
  const rulersVisible = cfg.rulers;
  const setRulersVisible = settingState('rulers');
  const [rightTab, setRightTab] = useState<'color' | 'props' | 'nav'>('color');
  // Rozmiar obszaru płótna na ekranie (dla ramki widoku w Nawigatorze)
  const [viewSize, setViewSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [bottomTab, setBottomTab] = useState<'layers' | 'channels' | 'history'>('layers');
  const [propsState, setPropsState] = useState<{ desc: PropsDescriptor; api: PropsApi | null }>({ desc: null, api: null });
  const handlePropertiesChange = useCallback((desc: PropsDescriptor, api: PropsApi) => setPropsState({ desc, api }), []);
  // Rodzaj otwartej sesji edycji obiektu wektorowego z narzędzia Manipulacja (decyduje o opcjach narzędzia)
  const [vectorEditKind, setVectorEditKind] = useState<'line' | 'bezier' | 'shapes' | 'text' | 'smart-object' | null>(null);
  const activeIsVector = !!engine.getActiveLayer()?.vectorTarget;
  // Żądanie otwarcia obiektu wektorowego do edycji (kliknięcie wiersza w panelu warstw); n odróżnia kolejne żądania
  const [vectorEditRequest, setVectorEditRequest] = useState<{ n: number; layerIndex: number; id: string } | null>(null);
  /** Wklejony obiekt do otwarcia na płótnie jak świeżo narysowany. */
  const [vectorPasteRequest, setVectorPasteRequest] = useState<{ n: number; object: VectorObject } | null>(null);
  /** Wybiera narzędzie z uwzględnieniem rodzaju aktywnej warstwy (wektorowa ma własny zestaw narzędzi); niedozwolone narzędzie jest odrzucane z powiadomieniem. */
  const setActiveTool = useCallback(
    (tool: ToolType) => {
      const vec = !!engine.getActiveLayer()?.vectorTarget;
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
  // Narzędzie spoza zestawu aktywnej warstwy (wektorowej lub rastrowej) jest zastępowane domyślnym
  useEffect(() => {
    if (activeIsVector && !VECTOR_LAYER_TOOLS.has(activeTool)) setActiveToolRaw('vector-select');
    else if (!activeIsVector && VECTOR_ONLY_TOOLS.has(activeTool)) setActiveToolRaw('brush');
  }, [activeIsVector, activeTool]);
  // Przełączenie na zakładkę z aktywną warstwą rastrową przy narzędziu obiektu inteligentnego zmienia je na pędzel.
  // Po powrocie do zakładki, z której narzędzie zostało w ten sposób zabrane (np. po wstawieniu obiektu otwiera się jego zakładka),
  // wraca narzędzie obiektu inteligentnego. Efekt następuje po efekcie powyżej, więc jego ustawienie narzędzia ma pierwszeństwo.
  const prevTabRef = useRef(activeTabId);
  const smartToolLeftRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = activeTabId;
    if (prev === activeTabId) return;
    if (activeTool === 'smart-object' && !activeIsVector) {
      smartToolLeftRef.current.add(prev);
      setActiveToolRaw('brush');
    } else if (smartToolLeftRef.current.delete(activeTabId) && activeIsVector && (activeTool === 'brush' || activeTool === 'vector-select')) {
      setActiveToolRaw('smart-object');
    }
    // Tylko przy zmianie zakładki
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId]);

  // Zaznaczenie obiektów wektorowych istnieje tylko przy narzędziu Manipulacja
  useEffect(() => {
    if (activeTool !== 'vector-select' && engine.vec.getSelection()) {
      engine.vec.clearSelection();
      bumpEngineRevision();
    }
  }, [activeTool, engine, bumpEngineRevision]);

  // ---- Widok (powiększenie i przesunięcie) ----
  // Każda zakładka ma własne powiększenie i przesunięcie: zmiana widoku w jednym dokumencie nie rusza pozostałych
  const [views, setViews] = useState<Record<string, TabView>>({ tab_1: { zoom: 1, pan: ZERO_PAN } });
  const activeView = views[activeTabId];
  const zoom = activeView?.zoom ?? 1;
  const panOffset = activeView?.pan ?? ZERO_PAN;
  const setZoom = useCallback((z: number | ((prev: number) => number)) => {
    const id = activeTabIdRef.current;
    setViews((prev) => {
      const cur = prev[id] ?? { zoom: 1, pan: ZERO_PAN };
      const next = typeof z === 'function' ? z(cur.zoom) : z;
      return next === cur.zoom && prev[id] ? prev : { ...prev, [id]: { ...cur, zoom: next } };
    });
  }, []);
  const setPanOffset = useCallback((p: { x: number; y: number }) => {
    const id = activeTabIdRef.current;
    setViews((prev) => {
      const cur = prev[id] ?? { zoom: 1, pan: ZERO_PAN };
      return prev[id] && cur.pan.x === p.x && cur.pan.y === p.y ? prev : { ...prev, [id]: { ...cur, pan: p } };
    });
  }, []);
  /** Ustawia widok konkretnej zakładki (także takiej, która dopiero staje się aktywna). */
  const setViewOf = useCallback((id: string, zoomValue: number) => {
    setViews((prev) => ({ ...prev, [id]: { zoom: zoomValue, pan: ZERO_PAN } }));
  }, []);

  const ZOOM_MIN = 0.05;
  const ZOOM_MAX = 25;
  /** Ustawia powiększenie tak, by prostokąt dokumentu (x, y, w, h) mieścił się w widoku, i wyśrodkowuje go. */
  const fitRect = (x: number, y: number, w: number, h: number) => {
    const vw = viewSize.width;
    const vh = viewSize.height;
    if (vw <= 0 || vh <= 0 || w <= 0 || h <= 0) return;
    const margin = 24;
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.min((vw - margin * 2) / w, (vh - margin * 2) / h)));
    const zr = Math.floor(z * 1000) / 1000;
    setZoom(zr);
    setPanOffset({ x: -(x + w / 2 - engine.width / 2) * zr, y: -(y + h / 2 - engine.height / 2) * zr });
  };
  const viewFitWindow = () => fitRect(0, 0, engine.width, engine.height);
  const viewFitSelection = () => {
    const b = engine.selectionManager.getSelectionBounds();
    if (b) fitRect(b.left, b.top, b.width, b.height);
  };
  const viewZoomIn = () => setZoom((z) => Math.min(ZOOM_MAX, Number((z * (1 + settings.get().zoomStep / 100)).toFixed(3))));
  const viewZoomOut = () => setZoom((z) => Math.max(ZOOM_MIN, Number((z / (1 + settings.get().zoomStep / 100)).toFixed(3))));
  const viewActualSize = () => {
    setZoom(1.0);
    setPanOffset(ZERO_PAN);
  };
  /** Najnowsze działania widoku dla obsługi klawiatury (efekt klawiszy nie zależy od rozmiaru widoku). */
  const viewActRef = useRef({ viewFitWindow, viewZoomIn, viewZoomOut, viewActualSize });
  viewActRef.current = { viewFitWindow, viewZoomIn, viewZoomOut, viewActualSize };

  const [isNewDocModalOpen, setIsNewDocModalOpen] = useState(false);

  const handleUpdateBrushSettings = (newSettings: Partial<BrushSettings>) => {
    setBrushSettings((prev) => ({ ...prev, ...newSettings }));
  };

  /** Szybka regulacja rozmiaru, twardości, odstępów i krycia aktywnego narzędzia pędzlowego (mysz i klawiatura). */
  const adjustBrushParams = useCallback((tool: ToolType, f: BrushAdjustFns) => {
    const apply = <T extends { size: number; hardness: number; spacing: number }>(s: T): T => ({
      ...s,
      ...(f.size ? { size: clampSize(f.size(s.size)) } : {}),
      ...(f.hardness ? { hardness: clampPct(f.hardness(s.hardness)) } : {}),
      ...(f.spacing ? { spacing: clampSpacing(f.spacing(s.spacing)) } : {}),
    });
    // przezroczystość (w narzędziach: Intensywność, Krycie) to alfa koloru głównego, wspólna dla wszystkich narzędzi pędzlowych
    if (f.opacity && supportsOpacity(tool)) {
      const fo = f.opacity;
      setPrimaryColor((prev) => ({ ...prev, a: pctToAlpha(Math.max(1, fo(alphaToPct(prev.a)))) }));
    }
    if (tool === 'brush' || tool === 'eraser') {
      setBrushSettings(apply);
    } else if (tool === 'correction-brush') setCorrectionBrushSettings(apply);
    else if (tool === 'color-replace') setColorReplaceSettings(apply);
    else if (tool === 'stamp') setStampSettings(apply);
    else if (tool === 'deform') setDeformSettings(apply);
  }, []);

  /** Składa dokument obiektu inteligentnego do jednej bitmapy i zapisuje go w obiekcie dokumentu nadrzędnego; nic nie robi, gdy zawartość się nie zmieniła. */
  const flushSmartTab = useCallback((tab: DocumentTab | undefined): void => {
    if (!tab?.smart) return;
    const parent = tabsRef.current.find((t) => t.id === tab.smart!.parentTabId);
    if (!parent) return;
    const fig = tab.engine.saveToFigFile();
    if (fig === tab.smart.origFig) return;
    const canvas = tab.engine.getCompositeFlatCanvas();
    const png = canvas.toDataURL('image/png');
    registerSmartBitmap(png, canvas);
    if (parent.engine.vec.updateSmartContent(tab.smart.layerId, tab.smart.objectId, fig, png)) {
      tab.smart.origFig = fig;
      parent.engine.metaRevision++;
      if (parent.id === activeTabIdRef.current) bumpEngineRevision();
    }
  }, [bumpEngineRevision]);

  /** Otwiera zawartość obiektu inteligentnego w osobnej zakładce tuż za zakładką nadrzędną albo przełącza na już otwartą. */
  const handleOpenSmartObject = useCallback((layerId: string, objectId: string) => {
    const cur = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (!cur) return;
    cur.engine.finishOpenSessions();
    // „Obraz z dysku” nie ma zakładki: dwuklik przywraca dostęp do pliku albo pozwala wskazać inny
    const dobj = cur.engine.vec.findDiskImage(layerId, objectId);
    if (dobj?.disk) {
      void reconnectDiskImage(dobj.disk).then((ref) => {
        if (ref && cur.engine.vec.relinkDiskImage(layerId, objectId, ref)) bumpEngineRevision();
      });
      return;
    }
    const existing = tabsRef.current.find((t) => t.smart && t.smart.parentTabId === cur.id && t.smart.objectId === objectId);
    if (existing) {
      setActiveTabId(existing.id);
      bumpEngineRevision();
      return;
    }
    const obj = cur.engine.vec.findSmart(layerId, objectId);
    if (!obj) return;
    void (async () => {
      const child = new GraphicEngine('Obiekt inteligentny.fig', obj.docW, obj.docH);
      child.dpi = cur.engine.dpi;
      if (obj.fig) {
        const ok = await child.loadFromFigFile(obj.fig);
        if (!ok) child.initTransparentDocument();
      } else {
        child.initTransparentDocument();
      }
      const tab: DocumentTab = {
        id: `tab_${Date.now()}`,
        title: `Obiekt inteligentny`,
        engine: child,
        smart: { parentTabId: cur.id, layerId, objectId, origFig: obj.fig ? child.saveToFigFile() : child.saveToFigFile() },
      };
      setTabs((prev) => {
        const at = prev.findIndex((t) => t.id === cur.id);
        let ins = at + 1;
        while (ins < prev.length && prev[ins].smart?.parentTabId === cur.id) ins++;
        return [...prev.slice(0, ins), tab, ...prev.slice(ins)];
      });
      setViewOf(tab.id, initialZoomFor(child.width, child.height));
      setActiveTabId(tab.id);
      bumpEngineRevision();
    })();
  }, [bumpEngineRevision, setViewOf]);

  /** Zwraca tytuł zakładki; zakładka obiektu inteligentnego nosi nazwę obiektu z dokumentu nadrzędnego i zmienia się razem z nią. */
  const smartTabTitle = (t: DocumentTab): string => {
    if (!t.smart) return t.title;
    const parent = tabs.find((x) => x.id === t.smart!.parentTabId);
    const obj = parent ? parent.engine.vec.findSmart(t.smart.layerId, t.smart.objectId) : null;
    return obj ? vectorObjectLabel(obj) : t.title;
  };

  useEffect(() => {
    setDiskReadyHook((key) => {
      for (const t of tabsRef.current) t.engine.vec.refreshDiskImage(key);
      bumpEngineRevision();
    });
    return () => setDiskReadyHook(null);
  }, [bumpEngineRevision]);

  /** Ponownie wczytuje z dysku wszystkie obrazy z dysku użyte w bieżącym dokumencie (po zmianie plików w czasie pracy). */
  const refreshDiskImages = useCallback(() => {
    const seen = new Set<string>();
    for (const l of engine.layers) {
      for (const o of [...l.vectorObjects, ...l.maskObjects]) {
        if (o.kind === 'smart' && o.disk && !seen.has(o.disk.key)) {
          seen.add(o.disk.key);
          void ensureDiskImage(o.disk, true);
        }
      }
    }
    showToast(seen.size ? `Odświeżanie obrazów z dysku: ${seen.size}` : 'W dokumencie nie ma obrazów z dysku.');
  }, [engine, showToast]);

  /** „Obraz z dysku”: okno wyboru pliku, potem wstawienie obiektu jak świeżo narysowanego (z uchwytami, na wierzchu). */
  const insertDiskImage = useCallback(async () => {
    const act = engine.getActiveLayer();
    if (!act || !act.vectorTarget || act.locked || !act.ownVisible) {
      showToast('Obraz z dysku można wstawić tylko do widocznej, odblokowanej warstwy wektorowej.');
      return;
    }
    const ref = await pickDiskImage();
    if (!ref) return;
    if (engine.getActiveLayer() !== act) return;
    engine.finishOpenSessions();
    engine.vec.settle();
    engine.vec.clearSelection();
    const fit = Math.min(1, (engine.width * 0.6) / ref.w, (engine.height * 0.6) / ref.h);
    const obj: VectorObject = {
      id: newVectorId(), name: null, visible: true, kind: 'smart',
      center: { x: engine.width / 2, y: engine.height / 2 },
      width: Math.max(1, ref.w * fit), height: Math.max(1, ref.h * fit), angle: 0, flipX: false, flipY: false,
      docW: ref.w, docH: ref.h, fig: null, png: null, disk: ref, settings: { blendMode: smartSettings.blendMode },
    };
    setVectorPasteRequest((r) => ({ n: (r?.n ?? 0) + 1, object: obj }));
    setActiveToolRaw('smart-object');
    bumpEngineRevision();
  }, [engine, showToast, bumpEngineRevision, smartSettings.blendMode]);

  useEffect(() => {
    setSmartReadyHook(() => {
      for (const t of tabsRef.current) for (const l of t.engine.layers) if (l.isVector) t.engine.vec.rebuildAll(l);
      bumpEngineRevision();
    });
    return () => setSmartReadyHook(null);
  }, [bumpEngineRevision]);

  const handleSelectTab = (id: string) => {
    if (id !== activeTabId) {
      engine.finishOpenSessions();
      flushSmartTab(tabs.find((t) => t.id === activeTabId));
    }
    // Widok (powiększenie i przesunięcie) zostaje zapamiętany osobno dla każdej zakładki
    setActiveTabId(id);
    bumpEngineRevision();
  };

  /**
   * Zatwierdza wszystko, co jest w toku w aktywnej zakładce (rysowany obiekt, przekształcenie, gradient, wiadro),
   * zanim aktywna stanie się inna zakładka. Dzięki temu rozpoczęty obiekt zostaje w dokumencie, w którym go zaczęto.
   */
  const leaveActiveTab = () => {
    const cur = tabsRef.current.find((t) => t.id === activeTabIdRef.current);
    if (!cur) return;
    cur.engine.finishOpenSessions();
    flushSmartTab(cur);
  };

  const handleCloseTab = (id: string) => {
    const tabsNow = tabsRef.current;
    const closing = tabsNow.find((t) => t.id === id);
    if (!closing) return;
    closing?.engine.finishOpenSessions();
    flushSmartTab(closing);
    // Zamknięcie dokumentu zamyka też jego obiekty inteligentne (ich zawartość jest już zapisana w obiektach)
    const dropped = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of tabsNow) if (t.smart && dropped.has(t.smart.parentTabId) && !dropped.has(t.id)) { dropped.add(t.id); grew = true; }
    }
    for (const t of tabsNow) if (dropped.has(t.id) && t.id !== id) flushSmartTab(t);
    const remaining = tabsNow.filter((t) => !dropped.has(t.id));
    setTabs(remaining);
    setViews((prev) => {
      const next = { ...prev };
      for (const d of dropped) delete next[d];
      return next;
    });
    if (dropped.has(activeTabIdRef.current)) {
      // Zamknięcie ostatniej zakładki zostawia pusty obszar roboczy (bez aktywnego dokumentu)
      const back = closing.smart && remaining.find((t) => t.id === closing.smart!.parentTabId);
      setActiveTabId((back ?? remaining[0])?.id ?? '');
    }
    bumpEngineRevision();
  };

  const handleCreateNewDocument = (title: string, width: number, height: number, dpi: number = 96) => {
    leaveActiveTab();
    const newDoc = new GraphicEngine(title, width, height);
    newDoc.dpi = dpi;
    const bgMode = settings.get().newDocBackground;
    if (bgMode !== 'white') newDoc.initDefaultLayers(bgMode === 'none' ? 'none' : { r: secondaryColor.r, g: secondaryColor.g, b: secondaryColor.b });
    const newTab: DocumentTab = {
      id: `tab_${Date.now()}`,
      title: title.replace(/\.fig$/, ''),
      engine: newDoc,
      file: null,
      savedMark: newDoc.historyMark(),
      savedMeta: newDoc.metaRevision,
    };
    setTabs((prev) => [...prev, newTab]);

    const maxDim = Math.max(width, height);
    setViewOf(newTab.id, maxDim >= 3000 ? 0.25 : maxDim >= 1800 ? 0.4 : maxDim >= 1200 ? 0.7 : 1.0);
    setActiveTabId(newTab.id);
    bumpEngineRevision();
  };

  // ---------------------------------------------------------------------------------------------
  // Plik: otwieranie, zapis, eksport, zamykanie. Te same reguły w przeglądarce i w Tauri, różnice kryje `platform`.
  // ---------------------------------------------------------------------------------------------
  const tabSeq = useRef(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [propsOpen, setPropsOpen] = useState(false);
  const [unsavedDlg, setUnsavedDlg] = useState<{ names: string[]; action: 'close' | 'exit'; resolve: (a: UnsavedAnswer) => void } | null>(null);
  const [recentList, setRecentList] = useState<RecentItem[]>(() => recents.list());
  useEffect(() => recents.subscribe(() => setRecentList(recents.list())), []);
  /** Trwa pytanie o zapis albo zamykanie: kolejne próby zamknięcia są ignorowane. */
  const closingRef = useRef(false);
  /** Program się zamyka: `beforeunload` nie pyta już o niezapisane zmiany. */
  const exitingRef = useRef(false);

  const handleOpenFilePicker = () => void handleOpen();

  /** Dodaje gotowy silnik jako nową zakładkę i ją uaktywnia. */
  const addDocumentTab = (eng: GraphicEngine, title: string, file: FileRef | null, extra?: { size?: number | null; savedAt?: number | null }) => {
    leaveActiveTab();
    const tab: DocumentTab = {
      id: `tab_${Date.now()}_${tabSeq.current++}`,
      title,
      engine: eng,
      file,
      savedMark: eng.historyMark(),
      savedMeta: eng.metaRevision,
      savedAt: extra?.savedAt ?? null,
      fileSize: extra?.size ?? null,
    };
    setTabs((prev) => [...prev, tab]);
    setViewOf(tab.id, initialZoomFor(eng.width, eng.height));
    setActiveTabId(tab.id);
    bumpEngineRevision();
    return tab;
  };

  /** Otwiera obraz rastrowy jako nowy dokument (jedna warstwa, rozmiar obrazu). */
  const openImageBytes = async (data: Uint8Array, baseName: string): Promise<boolean> => {
    const url = URL.createObjectURL(new Blob([data as BlobPart]));
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error('decode'));
        i.src = url;
      });
      const doc = new GraphicEngine(baseName, img.naturalWidth || img.width, img.naturalHeight || img.height);
      doc.initDefaultLayers('none');
      doc.importImage(img, baseName);
      // obraz jest jedyną warstwą: pusta „Warstwa 1” z inicjalizacji i historia importu są zbędne
      doc.layers.splice(0, 1);
      doc.activeLayerIndex = 0;
      doc.clearHistory();
      const dpi = sniffDpi(data);
      if (dpi && dpi > 1 && dpi < 5000) doc.dpi = dpi;
      addDocumentTab(doc, baseName, null, { size: data.length });
      return true;
    } catch {
      showToast(`Nie udało się wczytać obrazu „${baseName}”`);
      return false;
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  /** Otwiera wczytany plik: .fig jako dokument, obraz jako nowy dokument. */
  const openFileData = async (f: OpenedFile): Promise<boolean> => {
    const name = f.ref.name;
    const lower = name.toLowerCase();
    const base = name.replace(/\.[^/.]+$/, '');
    if (f.ref.path) {
      const existing = tabsRef.current.find((t) => t.file?.path === f.ref.path);
      if (existing) {
        leaveActiveTab();
        setActiveTabId(existing.id);
        bumpEngineRevision();
        return true;
      }
    }
    if (lower.endsWith('.fig') || lower.endsWith('.json')) {
      const eng = new GraphicEngine(name, 800, 600);
      let ok = false;
      try {
        ok = await eng.loadFromFigFile(new TextDecoder().decode(f.data));
      } catch {
        ok = false;
      }
      if (!ok) {
        showToast(`Nie udało się otworzyć „${name}” (plik uszkodzony lub w nieobsługiwanym formacie)`);
        return false;
      }
      addDocumentTab(eng, base, f.ref, { size: f.data.length, savedAt: f.modified ?? null });
      void recents.add(f.ref);
      return true;
    }
    return openImageBytes(f.data, base);
  };

  const handleOpen = async () => {
    try {
      const files = await openFiles(OPEN_FILTERS, true);
      for (const f of files) await openFileData(f);
    } catch (e: any) {
      showToast(`Nie udało się otworzyć pliku: ${e?.message ?? e}`);
    }
  };

  const handleOpenRecent = async (item: RecentItem) => {
    try {
      const ref = await recents.resolve(item);
      let f: OpenedFile | null = null;
      try {
        f = ref ? await readRef(ref) : null;
      } catch (err: any) {
        // Tauri: brak dostępu do ścieżki z poprzedniej sesji (zakres fs) albo plik zniknął: pozwól wskazać plik w oknie wyboru, które daje dostęp
        if (isTauri() && item.path) {
          showToast(`Brak dostępu do „${item.name}” (${err?.message ?? err}). Wskaż plik w oknie, aby go otworzyć.`);
          f = await pickFileNear(item.path, OPEN_FILTERS);
          if (!f) return;
        } else throw err;
      }
      if (!f) {
        showToast(`Nie można otworzyć „${item.name}”: plik został przeniesiony, usunięty albo brak dostępu`);
        if (!ref || !(item.hasHandle && ref.handle)) recents.remove(item.id);
        return;
      }
      await openFileData(f);
    } catch (e: any) {
      showToast(`Nie udało się otworzyć pliku: ${e?.message ?? e}`);
    }
  };

  const handleNewFromClipboard = async () => {
    try {
      const items = await readClipboardItems();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (!type) continue;
        const blob = await it.getType(type);
        await openImageBytes(new Uint8Array(await blob.arrayBuffer()), 'Schowek');
        return;
      }
      showToast('W schowku nie ma obrazu');
    } catch {
      showToast('Nie można odczytać schowka (brak zgody albo w schowku nie ma obrazu)');
    }
  };

  /** Zapisuje dokument jako .fig. `forceAsk` = „Zapisz jako”. Zwraca false po anulowaniu albo błędzie. */
  const saveTab = async (tab: DocumentTab, forceAsk = false): Promise<boolean> => {
    if (tab.smart) {
      // Obiekt inteligentny nie ma własnego pliku: jego zawartość trafia do dokumentu nadrzędnego, który zapisujemy
      flushSmartTab(tab);
      const parent = tabsRef.current.find((t) => t.id === tab.smart!.parentTabId);
      return parent ? saveTab(parent, forceAsk) : true;
    }
    tab.engine.finishOpenSessions();
    for (const t of tabsRef.current) if (t.smart && t.smart.parentTabId === tab.id) flushSmartTab(t);
    try {
      const bytes = new TextEncoder().encode(tab.engine.saveToFigFile());
      const ref = await saveFile(bytes, `${safeFileName(tab.title)}.fig`, FIG_FILTERS, tab.file ?? null, forceAsk || !canWriteInPlace(tab.file));
      if (!ref) return false;
      tab.file = ref;
      tab.title = ref.name.replace(/\.[^/.]+$/, '');
      tab.engine.title = ref.name;
      tab.savedMark = tab.engine.historyMark();
      tab.savedMeta = tab.engine.metaRevision;
      tab.savedAt = Date.now();
      tab.fileSize = bytes.length;
      void recents.add(ref);
      bumpEngineRevision();
      return true;
    } catch (e: any) {
      showToast(`Nie udało się zapisać pliku: ${e?.message ?? e}`);
      return false;
    }
  };

  const handleSave = () => {
    const t = tabsRef.current.find((x) => x.id === activeTabIdRef.current);
    if (t) void saveTab(t);
  };
  const handleSaveAs = () => {
    const t = tabsRef.current.find((x) => x.id === activeTabIdRef.current);
    if (t) void saveTab(t, true);
  };
  const handleSaveAll = async () => {
    for (const t of tabsRef.current.filter((x) => !x.smart)) {
      if (!tabDirty(t)) continue;
      if (!(await saveTab(t))) return;
    }
  };

  const askUnsaved = (names: string[], action: 'close' | 'exit') => new Promise<UnsavedAnswer>((resolve) => setUnsavedDlg({ names, action, resolve }));

  /**
   * Pyta o zapis zmian w podanych dokumentach i w razie zgody zapisuje je.
   * Zwraca true, gdy można je zamknąć (zapisane albo odrzucone), false po anulowaniu.
   */
  const resolveUnsaved = async (list: DocumentTab[], action: 'close' | 'exit'): Promise<boolean> => {
    for (const t of tabsRef.current) if (t.smart) flushSmartTab(t);
    const dirty = list.filter(tabDirty);
    if (!dirty.length) return true;
    const ans = await askUnsaved(dirty.map((t) => t.title), action);
    if (ans === 'cancel') return false;
    if (ans === 'discard') return true;
    for (const t of dirty) {
      if (!t.file) {
        // dokument bez pliku zapisze się przez okno „Zapisz jako”: pokaż go, żeby było wiadomo, o który chodzi
        leaveActiveTab();
        setActiveTabId(t.id);
        bumpEngineRevision();
      }
      if (!(await saveTab(t))) return false;
    }
    return true;
  };

  const requestCloseTab = async (id: string) => {
    if (closingRef.current) return;
    closingRef.current = true;
    try {
      const t = tabsRef.current.find((x) => x.id === id);
      if (!t) return;
      if (!t.smart && !(await resolveUnsaved([t], 'close'))) return;
      handleCloseTab(id);
    } finally {
      closingRef.current = false;
    }
  };

  const requestCloseAll = async (): Promise<boolean> => {
    if (closingRef.current) return false;
    closingRef.current = true;
    try {
      if (!(await resolveUnsaved(tabsRef.current.filter((t) => !t.smart), 'close'))) return false;
      for (const t of tabsRef.current) t.engine.finishOpenSessions();
      setTabs([]);
      setViews({});
      setActiveTabId('');
      bumpEngineRevision();
      return true;
    } finally {
      closingRef.current = false;
    }
  };

  const requestExit = async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    try {
      if (!(await resolveUnsaved(tabsRef.current.filter((t) => !t.smart), 'exit'))) return;
      exitingRef.current = true;
      if (appWindow.isNative()) {
        await saveWindowStateNow();
        await appWindow.destroy();
      }
      else {
        window.close();
        // przeglądarka zwykle nie pozwala zamknąć karty, której nie otworzył skrypt
        setTimeout(() => {
          exitingRef.current = false;
          showToast('Przeglądarka nie pozwala programowi zamknąć tej karty. Zamknij ją ręcznie.');
        }, 300);
      }
    } finally {
      closingRef.current = false;
    }
  };

  /** Zapisuje plik wyeksportowany z okna „Eksportuj”. */
  const handleExportFile = async (opts: ExportOptions, fileName: string): Promise<boolean> => {
    const info = formatInfo(opts.format);
    const bytes = await encodeExport(engine, opts);
    const ref = await saveFile(bytes, fileName, [{ name: `${info.label} (*.${info.ext})`, extensions: [info.ext] }], null, true);
    if (ref) showToast(`Wyeksportowano: ${ref.name}`);
    return !!ref;
  };

  const openFileDialog = (which: 'export' | 'print' | 'props') => {
    if (!activeTab) return;
    engine.finishOpenSessions();
    for (const t of tabsRef.current) if (t.smart) flushSmartTab(t);
    bumpEngineRevision();
    if (which === 'export') setExportOpen(true);
    else if (which === 'print') setPrintOpen(true);
    else setPropsOpen(true);
  };

  /** Najnowsze działania menu „Plik” dla obsługi klawiatury i zdarzeń okna. */
  const fileActRef = useRef<Record<string, () => void>>({});
  fileActRef.current = {
    newDoc: () => setIsNewDocModalOpen(true),
    open: handleOpenFilePicker,
    save: handleSave,
    saveAs: handleSaveAs,
    saveAll: () => void handleSaveAll(),
    exportAs: () => openFileDialog('export'),
    print: () => openFileDialog('print'),
    properties: () => openFileDialog('props'),
    close: () => void requestCloseTab(activeTabIdRef.current),
    closeAll: () => void requestCloseAll(),
    exit: () => void requestExit(),
  };

  // Tytuł okna: nazwa dokumentu, gwiazdka przy niezapisanych zmianach
  const docWindowTitle = activeTab ? `${tabDirty(activeTab) ? '* ' : ''}${activeTab.title} – Figura` : 'Figura';
  useEffect(() => {
    document.title = docWindowTitle;
  }, [docWindowTitle]);

  // Zamknięcie okna programu (krzyżyk, Alt+F4) i odświeżenie / zamknięcie karty: pytanie o niezapisane zmiany
  useEffect(() => appWindow.onCloseRequested(() => fileActRef.current.exit()), []);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (exitingRef.current) return;
      for (const t of tabsRef.current) if (t.smart) flushSmartTab(t);
      if (tabsRef.current.some(tabDirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [flushSmartTab]);

  /** Zwraca indeks aktywnej warstwy wektorowej i zaznaczone na niej obiekty (z otwartą edycją włącznie) albo null, gdy nic nie zaznaczono. */
  const vectorSelection = useCallback((): { idx: number; ids: string[] } | null => {
    const l = engine.getActiveLayer();
    if (!l || !l.vectorTarget) return null;
    const ids = engine.vec.selectedIds(l);
    return ids.length > 0 ? { idx: engine.layers.indexOf(l), ids } : null;
  }, [engine]);

  /** Co skopiowano ostatnio w programie: obiekty wektorowe czy raster (decyduje, co wkleić na warstwę wektorową). */
  const lastCopyRef = useRef<'objects' | 'raster' | null>(null);

  const blobToCanvas = useCallback((blob: Blob): Promise<HTMLCanvasElement | null> => new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d')!.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      resolve(c);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  }), []);

  /** Wkleja raster na warstwę wektorową jako obiekt inteligentny; gdy to niemożliwe, pokazuje powiadomienie. */
  /** Pytanie „wkleić bez zmian czy rozszerzyć płótno” dla obrazu większego od płótna (obraz nigdy nie jest zmniejszany). */
  const [pasteFitDlg, setPasteFitDlg] = useState<{ iw: number; ih: number; crops: boolean; resolve: (c: 'asis' | 'expand' | 'cancel') => void } | null>(null);
  const askPasteFit = useCallback(
    (iw: number, ih: number, crops: boolean): Promise<'asis' | 'expand' | 'cancel'> =>
      iw <= engine.width && ih <= engine.height ? Promise.resolve('asis') : new Promise((resolve) => setPasteFitDlg({ iw, ih, crops, resolve })),
    [engine]
  );
  /** Rozszerza płótno tak, by zmieścił się obraz `iw`×`ih` (dotychczasowa zawartość wyśrodkowana). */
  const expandCanvasForPaste = useCallback(
    (iw: number, ih: number): boolean => {
      const r = engine.resizeCanvas(Math.max(engine.width, iw), Math.max(engine.height, ih), 0.5, 0.5);
      if (!r.ok) {
        showToast(r.reason);
        return false;
      }
      return true;
    },
    [engine, showToast]
  );

  const pasteAsSmart = useCallback((canvas: HTMLCanvasElement | null) => {
    if (!canvas || !engine.pasteCanvasAsSmart(canvas)) {
      showToast('Nie można wkleić obrazu jako obiektu inteligentnego (warstwa zablokowana lub pusty obraz)');
      return;
    }
    setActiveToolRaw('vector-select');
    bumpEngineRevision();
  }, [engine, showToast, bumpEngineRevision]);

  /** Obraz spoza programu na warstwie wektorowej: przy większym od płótna najpierw pytanie, potem obiekt inteligentny. */
  const pasteExternalAsSmart = useCallback(
    async (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return pasteAsSmart(null);
      const choice = await askPasteFit(canvas.width, canvas.height, false);
      if (choice === 'cancel') return;
      if (choice === 'expand' && !expandCanvasForPaste(canvas.width, canvas.height)) return;
      pasteAsSmart(canvas);
    },
    [askPasteFit, expandCanvasForPaste, pasteAsSmart]
  );

  const handleConvertLayer = useCallback(() => {
    const r = engine.convertLayerKind(engine.activeLayerIndex);
    if (!r) showToast('Tej warstwy nie można przekształcić (grupa, warstwa korekcyjna, warstwa zablokowana albo maska już rastrowa)');
    else showToast(r === 'rasterized' ? 'Warstwa wektorowa (i jej maska) została zrasteryzowana' : r === 'mask-rasterized' ? 'Maska warstwy wektorowej jest teraz rastrowa' : 'Warstwa jest teraz wektorowa z jednym obiektem inteligentnym');
    bumpEngineRevision();
  }, [engine, showToast, bumpEngineRevision]);

  const handleCut = useCallback(() => {
    // obiekt rysowany lub edytowany na płótnie (jeszcze niezatwierdzony): kopia i usunięcie
    const pending = engine.pendingVectorObject();
    if (pending && engine.cutPendingObject(pending)) {
      lastCopyRef.current = 'objects';
      bumpEngineRevision();
      return;
    }
    if (engine.getActiveLayer()?.vectorTarget) {
      const vs = vectorSelection();
      if (!vs) showToast('Zaznacz obiekty wektorowe, aby je wyciąć');
      else if (!engine.vec.cutObjects(vs.idx, vs.ids)) showToast('Nie można wyciąć: warstwa jest zablokowana');
      else lastCopyRef.current = 'objects';
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
      lastCopyRef.current = 'raster';
      bumpEngineRevision();
    }
  }, [engine, bumpEngineRevision, showToast, vectorSelection]);

  const handleCopy = useCallback(() => {
    // obiekt rysowany lub edytowany na płótnie (jeszcze niezatwierdzony) kopiujemy od razu, w jego bieżącym stanie
    const pending = engine.pendingVectorObject();
    if (pending && engine.copyPendingObject(pending)) {
      lastCopyRef.current = 'objects';
      return;
    }
    if (engine.getActiveLayer()?.vectorTarget) {
      const vs = vectorSelection();
      if (!vs) showToast('Zaznacz obiekty wektorowe, aby je skopiować');
      else if (engine.vec.copyObjects(vs.idx, vs.ids)) lastCopyRef.current = 'objects';
      return;
    }
    lastCopyRef.current = 'raster';
    engine.copy();
  }, [engine, vectorSelection, showToast]);

  /** „Kopiuj spłaszczone”: kopiuje widoczny, złożony obraz ze wszystkich warstw (w zaznaczeniu, jeśli jest). */
  const handleCopyMerged = useCallback(() => {
    lastCopyRef.current = 'raster';
    engine.copyMerged();
    showToast('Skopiowano spłaszczony obraz');
  }, [engine, showToast]);

  /** Wkleja obraz spoza aplikacji jako nową zawartość wyśrodkowaną na płótnie dokumentu. */
  const pasteExternalBlob = useCallback((file: File | Blob) => {
    const img = new Image();
    img.onload = async () => {
      const choice = await askPasteFit(img.width, img.height, true);
      if (choice === 'cancel') return;
      if (choice === 'expand' && !expandCanvasForPaste(img.width, img.height)) return;
      // Obraz w swoim rozmiarze (bez skalowania), wyśrodkowany na płótnie
      const dx = Math.round((engine.width - img.width) / 2);
      const dy = Math.round((engine.height - img.height) / 2);
      const oversize = img.width > engine.width || img.height > engine.height;
      const cvs = document.createElement('canvas');
      if (oversize) {
        // Większy od płótna: pełny obraz pływa w ramce i wystaje za płótno do zatwierdzenia
        cvs.width = img.width;
        cvs.height = img.height;
        cvs.getContext('2d')!.drawImage(img, 0, 0);
        if (!engine.pasteCanvasOverhang(cvs, dx, dy)) {
          showToast(engine.pixelEditBlockReason() || 'Nie można wkleić obrazu na tej warstwie');
          return;
        }
        setActiveTool('transform-content');
        bumpEngineRevision();
        return;
      }
      cvs.width = engine.width;
      cvs.height = engine.height;
      cvs.getContext('2d')!.drawImage(img, dx, dy);

      engine.pasteCanvas(cvs);
      setActiveTool('transform-content');
      bumpEngineRevision();
    };
    img.src = URL.createObjectURL(file);
  }, [engine, bumpEngineRevision, showToast, askPasteFit, expandCanvasForPaste]);

  /** Wkleja obraz: własny bufor aplikacji z dokładnymi pikselami i maską albo obraz zewnętrzny (na warstwie wektorowej jako obiekt inteligentny). */
  const pasteImageBlob = useCallback((file: File | Blob) => {
    if (engine.getActiveLayer()?.vectorTarget) {
      void blobToCanvas(file).then(pasteExternalAsSmart);
      return;
    }
    {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
    }
    // Własna kopia aplikacji: wklejany jest bufor wewnętrzny (dokładne piksele i maska), a nie obraz zdekodowany z PNG
    engine.isOwnClipboardBlob(file).then((own) => {
      if (own && engine.paste()) {
        setActiveTool('transform-content');
        bumpEngineRevision();
        return;
      }
      pasteExternalBlob(file);
    });
  }, [engine, bumpEngineRevision, showToast, pasteExternalBlob, blobToCanvas, pasteExternalAsSmart]);

  /** Wkleja ze schowka systemowego lub wewnętrznego bufora aplikacji; na warstwie wektorowej wkleja obiekty albo raster jako obiekt inteligentny. */
  /**
   * Wkleja jeden skopiowany obiekt jak świeżo narysowany: zatwierdza obiekt (lub obiekty) dotychczas edytowany, a wklejony
   * otwiera na płótnie z uchwytami, w narzędziu jego rodzaju, gotowy do przesuwania i edycji. Zwraca false, gdy to niemożliwe.
   */
  const pasteAsNewObject = useCallback((inPlace: boolean): boolean => {
    const act = engine.getActiveLayer();
    if (!act || engine.vec.clipboardCount !== 1) return false;
    if (act.vectorTarget ? act.locked || !act.ownVisible : !!engine.pixelEditBlockReason()) return false;
    // obiekt inteligentny istnieje tylko na warstwie wektorowej; na rastrowej wklejany jest jako obraz
    if (!act.vectorTarget && engine.vec.clipboardSingleKind === 'smart') return false;
    engine.finishOpenSessions();
    engine.vec.settle();
    engine.vec.clearSelection();
    const obj = engine.vec.takePasteCopy(inPlace);
    if (!obj) return false;
    const tool: ToolType = obj.kind === 'line' ? 'line' : obj.kind === 'path' ? 'bezier' : obj.kind === 'smart' ? 'smart-object' : obj.kind === 'text' ? 'text' : 'shapes';
    setVectorPasteRequest((r) => ({ n: (r?.n ?? 0) + 1, object: obj }));
    setActiveToolRaw(tool);
    bumpEngineRevision();
    return true;
  }, [engine, bumpEngineRevision]);

  const handlePaste = useCallback((inPlace?: boolean) => {
    if (lastCopyRef.current === 'objects' && engine.vec.hasClipboard && pasteAsNewObject(inPlace === true)) return;
    if (engine.getActiveLayer()?.vectorTarget) {
      const idx = engine.layers.indexOf(engine.getActiveLayer()!);
      const pasteObjs = () => {
        if (!engine.vec.hasClipboard) showToast('Schowek jest pusty: skopiuj obiekty (Ctrl+C) albo obraz');
        else if (engine.vec.pasteObjects(idx, inPlace === true).length === 0) showToast('Nie można wkleić: warstwa jest zablokowana');
        else setActiveToolRaw('vector-select');
        bumpEngineRevision();
      };
      // Ostatnio skopiowane obiekty wektorowe są wklejane jako obiekty
      if (lastCopyRef.current === 'objects' && engine.vec.hasClipboard) {
        pasteObjs();
        return;
      }
      // Raster (ze schowka systemowego lub wewnętrznego) trafia na warstwę wektorową jako obiekt inteligentny
      const fallback = () => {
        if (engine.clipboardCanvas) pasteAsSmart(engine.clipboardCanvas);
        else pasteObjs();
      };
      if (canReadClipboard()) {
        readClipboardItems()
          .then(async (items) => {
            for (const item of items) {
              const imageType = item.types.find((t) => t.startsWith('image/'));
              if (imageType) {
                const blob = await item.getType(imageType);
                if (lastCopyRef.current === 'raster' && engine.clipboardCanvas && (await engine.isOwnClipboardBlob(blob))) {
                  pasteAsSmart(engine.clipboardCanvas);
                } else {
                  void pasteExternalAsSmart(await blobToCanvas(blob));
                }
                return;
              }
            }
            fallback();
          })
          .catch(fallback);
      } else {
        fallback();
      }
      return;
    }
    {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
    }
    // Najpierw próba odczytu obrazu ze schowka systemowego (zrzuty ekranu, obrazy skopiowane z przeglądarki lub systemu)
    if (canReadClipboard()) {
      readClipboardItems()
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
          // Brak obrazu w schowku systemowym: wklejany jest bufor wewnętrzny aplikacji
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
  }, [engine, pasteImageBlob, bumpEngineRevision, pasteAsSmart, pasteExternalAsSmart, blobToCanvas, showToast]);

  useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      if (!tabsRef.current.length) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;

      const clipboardData = e.clipboardData;
      if (clipboardData) {
        // Elementy clipboardData.items: standardowe źródło zrzutów ekranu i obrazów z systemu, odczyt nie wymaga zgody użytkownika
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

        // Pliki z clipboardData.files
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

      // Brak obrazu w zdarzeniu schowka: wklejany jest bufor wewnętrzny aplikacji (również bez zgody użytkownika)
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

  // ---- Skróty klawiszowe ----
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
      // Edytor tekstu na płótnie sam obsługuje wszystkie skróty (Ctrl+Z, Ctrl+A, Ctrl+C/V/X itd.)
      if (activeEl?.dataset?.figuraTextEditor === '1') return;
      const fa = fileActRef.current;
      // Bez otwartych dokumentów działają tylko skróty Nowy, Otwórz i Wyjdź
      if (!tabsRef.current.length) {
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyQ') {
          e.preventDefault();
          fa.exit();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
          e.preventDefault();
          setIsNewDocModalOpen(true);
        } else if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
          e.preventDefault();
          handleOpenFilePicker();
        }
        return;
      }
      const isTextEditing =
        activeEl?.tagName === 'TEXTAREA' ||
        (activeEl?.tagName === 'INPUT' &&
          (activeEl as HTMLInputElement).type === 'text' &&
          !(e.ctrlKey || e.metaKey));

      // Plik: kody klawiszy zamiast znaków, bo Ctrl+Alt to na polskiej klawiaturze AltGr (Ctrl+Alt+S wysyła „ś”)
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        fa.properties();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.code === 'KeyS') {
          e.preventDefault();
          if (e.altKey) fa.saveAll();
          else if (e.shiftKey) fa.saveAs();
          else fa.save();
          return;
        } else if (e.code === 'KeyW') {
          e.preventDefault();
          if (e.altKey || e.shiftKey) fa.closeAll();
          else fa.close();
          return;
        } else if (e.code === 'KeyP' && !e.altKey) {
          e.preventDefault();
          fa.print();
          return;
        } else if (e.code === 'KeyQ') {
          e.preventDefault();
          fa.exit();
          return;
        } else if (e.code === 'KeyE' && e.shiftKey) {
          e.preventDefault();
          fa.exportAs();
          return;
        }
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
          if (e.shiftKey) handleCopyMerged();
          else handleCopy();
          return;
        } else if (e.key === 'v' || e.key === 'V') {
          e.preventDefault();
          handlePaste(e.shiftKey);
          return;
        } else if (e.key === 't' || e.key === 'T') {
          e.preventDefault();
          setActiveTool('transform-content');
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
          viewActRef.current.viewActualSize();
          return;
        } else if (e.key === '9') {
          e.preventDefault();
          viewActRef.current.viewFitWindow();
          return;
        } else if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          viewActRef.current.viewZoomIn();
          return;
        } else if (e.key === '-' || e.key === '_') {
          e.preventDefault();
          viewActRef.current.viewZoomOut();
          return;
        }
      }

      if (isTextEditing) {
        return;
      }

      const key = e.key.toLowerCase();
      const keyTool = e.ctrlKey || e.metaKey ? null : toolForKey(key, !!engine.getActiveLayer()?.vectorTarget);
      if (keyTool) setActiveTool(keyTool);
      else if (key === 'x') {
        setPrimaryColor(secondaryColor);
        setSecondaryColor(primaryColor);
      } else if (e.code === 'BracketLeft' || e.code === 'BracketRight' || e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') {
        // [ ] = rozmiar (proporcjonalnie), Shift + [ ] = twardość ±10; kod klawisza działa też na układach, gdzie nawiasy wymagają AltGr
        const dir: 1 | -1 = e.code === 'BracketRight' || e.key === ']' || e.key === '}' ? 1 : -1;
        if (e.altKey) return;
        if (e.shiftKey) adjustBrushParams(activeTool, { hardness: (v) => v + dir * 10 });
        else adjustBrushParams(activeTool, { size: (v) => stepSize(v, dir) });
      } else if (e.key === 'Delete' && !isLiveVectorSessionActiveRef.current && !engine.getActiveLayer()?.vectorTarget) {
        // Przy aktywnej sesji (np. krzywej) Delete należy do sesji (usuwa węzeł), a nie czyści warstwy
        engine.fillOrClearActive(null);
        bumpEngineRevision();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [engine, primaryColor, secondaryColor, activeTool, bumpEngineRevision, handleCut, handleCopy, handleCopyMerged, handlePaste, adjustBrushParams]);

  // ---- Operacje na warstwach: wspólne dla panelu warstw i menu „Warstwy” ----
  const flushPendingSessions = () => {
    if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
    if (engine.gradientStartPoint) engine.commitGradientSession();
  };
  const opAddLayer = () => {
    flushPendingSessions();
    engine.addLayer();
    bumpEngineRevision();
  };
  const opAddVectorLayer = () => {
    flushPendingSessions();
    engine.addVectorLayer();
    setActiveToolRaw('vector-select');
    bumpEngineRevision();
  };
  const opAddGroup = () => {
    flushPendingSessions();
    engine.addGroup();
    bumpEngineRevision();
  };
  const opRemove = () => {
    const vs = vectorSelection();
    if (vs) {
      // Przy zaznaczonych obiektach wektorowych usuwane są one, a nie cała warstwa
      if (!engine.vec.deleteObjects(vs.idx, vs.ids)) showToast('Nie można usunąć obiektów: warstwa jest zablokowana');
      bumpEngineRevision();
      return;
    }
    flushPendingSessions();
    const act = engine.getActiveLayer();
    // Zaznaczona maska: usuwa tylko maskę. Zaznaczona warstwa: usuwa warstwę razem z ewentualną maską
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
  };
  const opDuplicate = () => {
    const vs = vectorSelection();
    if (vs) {
      if (engine.vec.duplicateObjects(vs.idx, vs.ids).length === 0) showToast('Nie można zduplikować obiektów: warstwa jest zablokowana');
      else setActiveToolRaw('vector-select');
      bumpEngineRevision();
      return;
    }
    flushPendingSessions();
    engine.duplicateActiveLayer();
    bumpEngineRevision();
  };
  /** Przycisk panelu: „Zastosuj efekty” (gdy są efekty) albo scalenie z warstwą poniżej. */
  const opMergeDown = () => {
    if (engine.applyEffectsMode !== 'none') {
      if (!engine.applyEffects()) showToast('Nie można zastosować efektów: warstwa jest zablokowana albo pod korekcją leży warstwa wektorowa (jej piksele są wyliczane z obiektów)');
      bumpEngineRevision();
      return;
    }
    if (!engine.mergeLayerDown()) {
      showToast('Nie można scalić: warstwa jest zablokowana albo poniżej jest granica grupy lub korekcja');
      return;
    }
    bumpEngineRevision();
  };
  const opMoveUp = () => {
    const vs = vectorSelection();
    if (vs) {
      engine.vec.shiftObjects(vs.idx, vs.ids, 1);
      bumpEngineRevision();
      return;
    }
    engine.moveActiveLayerUp();
    bumpEngineRevision();
  };
  const opMoveDown = () => {
    const vs = vectorSelection();
    if (vs) {
      engine.vec.shiftObjects(vs.idx, vs.ids, -1);
      bumpEngineRevision();
      return;
    }
    engine.moveActiveLayerDown();
    bumpEngineRevision();
  };
  /** Menu „Spłaszcz w dół”: efekty i maska warstwy (oraz warstwy poniżej) są wpiekane w scalony obraz jednym krokiem historii. */
  const opFlattenDown = () => {
    flushPendingSessions();
    const act = engine.getActiveLayer();
    if (!act) return;
    if (act.isAdjustment) {
      if (!engine.applyEffects()) showToast('Nie można wpiec korekcji: jest zablokowana albo pod nią leży warstwa wektorowa');
    } else if (!engine.mergeLayerDown()) {
      showToast(act.isGroup ? 'Nie można spłaszczyć: grupa jest zablokowana' : 'Nie można spłaszczyć w dół: warstwa jest zablokowana albo poniżej jest granica grupy lub korekcja');
    }
    bumpEngineRevision();
  };
  const opFlattenAll = () => {
    flushPendingSessions();
    const hidden = engine.layers.filter((l) => !l.isGroup && !l.isAdjustment && !l.visible).length;
    if (hidden > 0 && !window.confirm(`Spłaszczenie usunie ukryte warstwy (${hidden}). Kontynuować?`)) return;
    const r = engine.flattenImage();
    if (!r.ok) showToast(r.reason);
    else if (r.dropped > 0) showToast(`Obraz spłaszczony; usunięto ukryte warstwy: ${r.dropped}`);
    bumpEngineRevision();
  };
  const opTransform = (op: LayerTransformOp) => {
    flushPendingSessions();
    const r = engine.transformLayerContent(engine.activeLayerIndex, op);
    if ('error' in r) showToast(r.error);
    else if (r.clipped) showToast('Część zawartości po obrocie wyszła poza obraz');
    bumpEngineRevision();
  };
  // ---- Menu „Obraz”: operacje na całym obrazie ----
  const opImageTransform = (op: LayerTransformOp) => {
    flushPendingSessions();
    engine.transformImage(op);
    bumpEngineRevision();
  };
  const opCropSelection = () => {
    flushPendingSessions();
    const r = engine.cropToSelection();
    if (!r.ok) showToast(r.reason);
    else showToast(`Przycięto do zaznaczenia: ${r.w} × ${r.h} px`);
    bumpEngineRevision();
  };
  const opCropTransparency = () => {
    flushPendingSessions();
    const r = engine.cropToTransparency();
    if (!r.ok) showToast(r.reason);
    else showToast(`Przycięto przezroczyste brzegi: ${r.w} × ${r.h} px`);
    bumpEngineRevision();
  };
  const opOpenImageDialog = (kind: 'resize' | 'canvas') => {
    flushPendingSessions();
    setImageDlg(kind);
  };
  const imageMenu = buildImageMenu(
    activeTab ? { hasSelection: engine.selectionManager.hasActiveSelection } : null,
    {
      cropToSelection: opCropSelection,
      cropToTransparency: opCropTransparency,
      openResize: () => opOpenImageDialog('resize'),
      openCanvasSize: () => opOpenImageDialog('canvas'),
      transform: opImageTransform,
      flatten: opFlattenAll,
    }
  );
  const viewMenu = buildViewMenu(
    activeTab
      ? {
          hasSelection: engine.selectionManager.hasActiveSelection,
          unit: effectiveUnit,
          unitsLocked: !!activeTab.smart,
          gridVisible,
          rulersVisible,
          guidesVisible,
        }
      : null,
    {
      zoomIn: viewZoomIn,
      zoomOut: viewZoomOut,
      fitWindow: viewFitWindow,
      fitSelection: viewFitSelection,
      actualSize: viewActualSize,
      setUnit: setLengthUnit,
      toggleGrid: () => setGridVisible((v) => !v),
      toggleRulers: () => setRulersVisible((v) => !v),
      toggleGuides: () => setGuidesVisible((v) => !v),
    }
  );
  const openLayerProps = (kind: 'blend' | 'opacity') => {
    const l = engine.getActiveLayer();
    if (!l || l.isAdjustment) return;
    setLayerPropsDlg({ kind, layer: l, blend: l.blendMode || (l.isGroup ? 'PassThrough' : 'SrcOver'), opacity: l.opacity });
  };
  const opMaskTarget = () => {
    const l = engine.getActiveLayer();
    if (!l || !l.hasMask) return;
    if (engine.vec.editing || engine.vec.getSelection()) {
      engine.vec.settle();
      engine.vec.clearSelection();
    }
    engine.selectedCorrection = null;
    engine.setEditTarget(engine.activeLayerIndex, l.editMask ? 'pixels' : 'mask');
    bumpEngineRevision();
  };
  const menuAfter = (fn: () => unknown) => () => {
    fn();
    bumpEngineRevision();
  };
  const layersMenuActions = {
    addRaster: opAddLayer,
    addVector: opAddVectorLayer,
    addGroup: opAddGroup,
    remove: opRemove,
    duplicate: opDuplicate,
    flattenDown: opFlattenDown,
    flattenAll: opFlattenAll,
    toggleVisible: menuAfter(() => engine.toggleLayerVisibility(engine.activeLayerIndex)),
    toggleLock: menuAfter(() => engine.toggleLayerLock(engine.activeLayerIndex)),
    convert: handleConvertLayer,
    transform: opTransform,
    openBlend: () => openLayerProps('blend'),
    openOpacity: () => openLayerProps('opacity'),
    moveUp: opMoveUp,
    moveDown: opMoveDown,
    addRasterMask: menuAfter(() => engine.addLayerMask(false, true)),
    addVectorMask: menuAfter(() => engine.addLayerMask(false)),
    removeMask: menuAfter(() => engine.removeLayerMask(false)),
    maskFromSelection: menuAfter(() => engine.addLayerMask(true)),
    bakeMask: () => {
      if (!engine.removeLayerMask(true)) showToast('Nie można wypiec maski tej warstwy');
      bumpEngineRevision();
    },
    toggleEditTarget: opMaskTarget,
    toggleMaskView: menuAfter(() => {
      const l = engine.getActiveLayer();
      engine.setMaskView(l && engine.maskView === l ? null : engine.activeLayerIndex);
    }),
    toggleMaskLink: menuAfter(() => engine.toggleMaskLink(engine.activeLayerIndex)),
    toggleMaskEnabled: menuAfter(() => engine.toggleMaskEnabled(engine.activeLayerIndex)),
    rasterizeMask: () => {
      if (!engine.rasterizeLayerMask(engine.activeLayerIndex)) showToast('Nie można zrasteryzować maski: warstwa jest zablokowana albo maska jest już rastrowa');
      bumpEngineRevision();
    },
    addCorrection: (type: CorrectionType) => startCorrectionEdit(engine.activeLayerIndex, { type, onlyActive: corrOnlyActive }),
    addStyles: () => startStylesEdit(engine.activeLayerIndex),
    bakeEffects: () => {
      if (!engine.applyEffects()) showToast('Nie można wypiec efektów: warstwa jest zablokowana albo pod korekcją leży warstwa wektorowa');
      bumpEngineRevision();
    },
    setOnlyActive: setCorrOnlyActive,
  };
  const activeForMenu = activeTab ? engine.getActiveLayer() : null;
  const layersMenu = buildLayersMenu(
    activeForMenu
      ? ({
          layer: activeForMenu,
          index: engine.activeLayerIndex,
          layerCount: engine.layers.length,
          plainLayerCount: engine.layers.filter((l) => !l.isGroup && !l.isAdjustment).length,
          hasSelection: engine.selectionManager.hasActiveSelection,
          maskViewOn: engine.maskView === activeForMenu,
          objectSelection: !!vectorSelection(),
          correctionSelected: !!engine.selectedCorrection,
          canEffects: true,
          canStyles: engine.canHaveStyles(activeForMenu),
          canBakeEffects: engine.applyEffectsMode !== 'none',
          onlyActive: corrOnlyActive,
        } as LayersMenuState)
      : null,
    layersMenuActions
  );

  const fileMenu = buildFileMenu(
    { hasDoc: !!activeTab, dirtyCount: tabs.filter(tabDirty).length, activeDirty: !!activeTab && tabDirty(activeTab), recents: recentList, canExit: appWindow.isNative() },
    {
      newDoc: () => setIsNewDocModalOpen(true),
      newFromClipboard: () => void handleNewFromClipboard(),
      open: handleOpenFilePicker,
      openRecent: (r) => void handleOpenRecent(r),
      clearRecent: () => recents.clear(),
      save: handleSave,
      saveAs: handleSaveAs,
      saveAll: () => void handleSaveAll(),
      exportAs: () => openFileDialog('export'),
      print: () => openFileDialog('print'),
      properties: () => openFileDialog('props'),
      close: () => void requestCloseTab(activeTabIdRef.current),
      closeAll: () => void requestCloseAll(),
      exit: () => void requestExit(),
    }
  );

  const menuHandlers: MenuActionHandlers = {
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
      engine.fillOrClearActive(null);
      bumpEngineRevision();
    },
    onFillLayer: () => {
      const why = engine.pixelEditBlockReason();
      if (why) {
        showToast(why);
        return;
      }
      engine.fillOrClearActive(primaryColor);
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
    onOpenSettings: () => setSettingsOpen(true),
    onTransformContent: () => {
      setActiveTool('transform-content');
    },
  };

  const selectionMenu = buildSelectionMenu(
    activeTab
      ? { hasSelection: engine.selectionManager.hasActiveSelection, channels: engine.channels.alpha.map((c) => ({ id: c.id, name: c.name })) }
      : null,
    {
      selectAll: menuHandlers.onSelectAll,
      deselect: menuHandlers.onDeselect,
      invert: menuHandlers.onInvertSelection,
      openOffset: () => {
        flushPendingSessions();
        setSelOffsetDlg(true);
      },
      saveSelection: () => {
        flushPendingSessions();
        const id = engine.saveSelectionToChannel('replace', null);
        if (id) showToast(`Zapisano zaznaczenie jako „${engine.channels.find(id)?.name ?? 'kanał'}” (panel Kanały)`);
        bumpEngineRevision();
      },
      loadSelection: (id) => {
        flushPendingSessions();
        engine.loadChannelAsSelection(id, 'replace');
        bumpEngineRevision();
      },
    }
  );

  const fillSelectionWith = (color: SKColor) => {
    const why = engine.pixelEditBlockReason();
    if (why) {
      showToast(why);
      return;
    }
    engine.fillOrClearActive(color);
    bumpEngineRevision();
  };
  const editMenu = buildEditMenu(
    activeTab
      ? { canUndo: engine.canUndo(), canRedo: engine.canRedo(), history: engine.historyEntries(), snap: snapEnabled }
      : null,
    {
      undo: () => {
        engine.undo();
        bumpEngineRevision();
      },
      redo: () => {
        engine.redo();
        bumpEngineRevision();
      },
      goToHistory: (i) => {
        engine.goToHistory(i);
        bumpEngineRevision();
      },
      cut: handleCut,
      copy: handleCopy,
      copyMerged: handleCopyMerged,
      paste: () => handlePaste(),
      pasteNewRaster: () => {
        opAddLayer();
        handlePaste();
      },
      pasteNewVector: () => {
        opAddVectorLayer();
        handlePaste();
      },
      clear: () => {
        const why = engine.pixelEditBlockReason();
        if (why) {
          showToast(why);
          return;
        }
        engine.fillOrClearActive(null);
        bumpEngineRevision();
      },
      fillPrimary: () => fillSelectionWith(primaryColor),
      fillSecondary: () => fillSelectionWith(secondaryColor),
      toggleSnap: () => setSnapEnabled((v) => !v),
      openSettings: () => setSettingsOpen(true),
    }
  );

  if (!activeTab) {
    // Wszystkie zakładki zamknięte: tylko Nowy i Otwórz mają sens, reszta menu jest wyłączona
    const idleHandlers = Object.fromEntries(
      Object.entries(menuHandlers).map(([k, v]) => [k, typeof v === 'function' && k !== 'onOpenSettings' ? () => {} : v])
    ) as unknown as MenuActionHandlers;
    idleHandlers.canUndo = false;
    idleHandlers.canRedo = false;
    return (
      <UnitsContext.Provider value={{ unit: lengthUnit, dpi: engine.dpi }}>
        <div className="flex flex-col h-screen w-screen overflow-hidden bg-[color:var(--h-1e1e1e,#1e1e1e)] text-[color:var(--h-dddddd,#dddddd)] font-sans">
          <TitleBar tabs={[]} activeTabId="" onSelectTab={handleSelectTab} onCloseTab={requestCloseTab} onNewTab={() => setIsNewDocModalOpen(true)} onCloseWindow={() => void requestExit()} />
          <MenuBar handlers={idleHandlers} fileMenu={fileMenu} editMenu={editMenu} layersMenu={layersMenu} imageMenu={imageMenu} viewMenu={viewMenu} selectionMenu={selectionMenu} />
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 select-none bg-[color:var(--h-252526,#252526)]">
            <div className="text-[color:var(--h-888888,#888888)] text-sm">Brak otwartych dokumentów</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIsNewDocModalOpen(true)}
                className="h-8 px-4 flex items-center gap-2 bg-[color:var(--h-282828,#282828)] border border-[color:var(--h-3e3e3e,#3e3e3e)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] hover:text-[color:var(--t-white,#fff)] cursor-pointer transition-colors"
              >
                <FilePlus size={14} /> Nowy dokument <span className="text-[color:var(--h-777777,#777777)]">Ctrl+N</span>
              </button>
              <button
                type="button"
                onClick={handleOpenFilePicker}
                className="h-8 px-4 flex items-center gap-2 bg-[color:var(--h-282828,#282828)] border border-[color:var(--h-3e3e3e,#3e3e3e)] rounded text-xs text-[color:var(--h-cccccc,#cccccc)] hover:bg-[color:var(--h-383838,#383838)] hover:text-[color:var(--t-white,#fff)] cursor-pointer transition-colors"
              >
                <FolderOpen size={14} /> Otwórz <span className="text-[color:var(--h-777777,#777777)]">Ctrl+O</span>
              </button>
            </div>
          </div>
          <NewDocumentModal
            isOpen={isNewDocModalOpen}
            onClose={() => setIsNewDocModalOpen(false)}
            onCreate={handleCreateNewDocument}
            defaultTitle="obraz1.fig"
            defaultUnit={lengthUnit}
          />
          {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} historyBytes={null} />}
          {unsavedDlg && (
            <UnsavedDialog
              names={unsavedDlg.names}
              action={unsavedDlg.action}
              onAnswer={(a) => {
                const r = unsavedDlg.resolve;
                setUnsavedDlg(null);
                r(a);
              }}
            />
          )}
        </div>
      </UnitsContext.Provider>
    );
  }

  return (
    <UnitsContext.Provider value={{ unit: effectiveUnit, dpi: engine.dpi }}>
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[color:var(--h-1e1e1e,#1e1e1e)] text-[color:var(--h-dddddd,#dddddd)] font-sans">
      <TitleBar
        tabs={tabs.map((t) => ({ id: t.id, title: smartTabTitle(t), accent: t.smart ? SMART_TAB_COLOR : undefined, hint: t.smart ? 'Obiekt inteligentny: po zamknięciu lub powrocie do głównej zakładki zawartość jest składana do bitmapy' : undefined, dirty: tabDirty(t) }))}
        activeTabId={activeTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={requestCloseTab}
        onNewTab={() => setIsNewDocModalOpen(true)}
        onCloseWindow={() => void requestExit()}
      />

      <MenuBar handlers={menuHandlers} fileMenu={fileMenu} editMenu={editMenu} layersMenu={layersMenu} imageMenu={imageMenu} viewMenu={viewMenu} selectionMenu={selectionMenu} />

      <ToolOptionsBar
        brushSettings={brushSettings}
        onChangeSettings={handleUpdateBrushSettings}
        correctionBrushSettings={correctionBrushSettings}
        onChangeCorrectionBrushSettings={handleUpdateCorrectionBrushSettings}
        colorReplaceSettings={colorReplaceSettings}
        onChangeColorReplaceSettings={handleUpdateColorReplaceSettings}
        stampSettings={stampSettings}
        onChangeStampSettings={handleUpdateStampSettings}
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
        smartSettings={smartSettings}
        onChangeSmartSettings={handleUpdateSmartSettings}
        onInsertDiskImage={insertDiskImage}
        onRefreshDiskImages={refreshDiskImages}
        guideAxis={guideAxis}
        onChangeGuideAxis={setGuideAxis}
        guideCount={engine.guides.length}
        onClearGuides={() => {
          engine.clearGuides();
          bumpEngineRevision();
        }}
        lineAndCurveSettings={lineAndCurveSettings}
        onChangeLineAndCurveSettings={handleUpdateLineAndCurveSettings}
        textSettings={textSettings}
        onChangeTextSettings={handleUpdateTextSettings}
        onRequestTextFocus={() => setTextFocusTrigger((c) => c + 1)}
        primaryColor={primaryColor}
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
        onCommitLiveVectorSession={() => setLiveVectorCommitTrigger((c) => c + 1)}
        onCancelLiveVectorSession={() => setLiveVectorCancelTrigger((c) => c + 1)}
        penInfo={penInfo}
        onTogglePenClosed={() => setPenCloseToggleTrigger((c) => c + 1)}
      />

      <div className="flex flex-1 min-h-0 overflow-hidden relative">
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
          smartSettings={smartSettings}
          onChangeSmartSettings={handleUpdateSmartSettings}
          guideAxis={guideAxis}
          snapEnabled={snapEnabled}
          guidesVisible={guidesVisible}
          gridVisible={gridVisible}
          rulersVisible={rulersVisible}
          rulerUnit={effectiveUnit}
          onOpenSmartObject={handleOpenSmartObject}
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
          onContainerSize={setViewSize}
          onPipettePick={(color, isSecondary) => {
            if (isSecondary) {
              setSecondaryColor(color);
            } else {
              setPrimaryColor(color);
              setBrushSettings((prev) => ({ ...prev, color }));
            }
          }}
          onAdjustBrush={adjustBrushParams}
          onCanvasModified={bumpEngineRevision}
          onLiveVectorSessionChange={setIsLiveVectorSessionActive}
          liveVectorCommitTrigger={liveVectorCommitTrigger}
          liveVectorCancelTrigger={liveVectorCancelTrigger}
          penCloseToggleTrigger={penCloseToggleTrigger}
          onPenInfoChange={setPenInfo}
          onVectorEditKind={setVectorEditKind}
          onPropertiesChange={handlePropertiesChange}
              onVectorSelectionChange={bumpEngineRevision}
          vectorEditRequest={vectorEditRequest}
          vectorPasteRequest={vectorPasteRequest}
          onShowToast={showToast}
        />

        <div className="w-[224px] bg-[color:var(--h-1e1e1e,#1e1e1e)] border-l border-[color:var(--h-2c2c2d,#2c2c2d)] p-2 flex flex-col gap-3 overflow-y-auto z-10 select-none flex-shrink-0">
          <ColorPanel
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            // Zmiana koloru nie zmienia pikseli dokumentu, więc nie wymusza ponownego złożenia warstw
            // (sesje gradientu, wiadra i figur odświeżają się same, bo zależą od koloru)
            onChangePrimaryColor={setPrimaryColor}
            onChangeSecondaryColor={setSecondaryColor}
            tab={rightTab}
            onChangeTab={setRightTab}
            propsContent={<PropertiesPanel desc={propsState.desc} api={propsState.api} />}
            navContent={
              <NavigatorPanel
                engine={engine}
                zoom={zoom}
                panOffset={panOffset}
                viewSize={viewSize}
                onChangeZoom={setZoom}
                onChangePan={setPanOffset}
              />
            }
          />

          <LayersPanel
            tab={bottomTab}
            onChangeTab={(t) => {
              // powrót do panelu Warstwy kończy edycję kanału alfa: narzędzia znów rysują na warstwie
              if (t === 'layers' && engine.channelEdit) {
                engine.exitChannelEdit();
                bumpEngineRevision();
              }
              setBottomTab(t);
            }}
            channelsContent={bottomTab === 'channels' ? <ChannelsPanel engine={engine} onChanged={bumpEngineRevision} /> : null}
            historyContent={(() => {
              const h = engine.historyEntries();
              return (
                <HistoryPanel
                  labels={h.labels}
                  current={h.current}
                  onGoTo={(i) => {
                    engine.goToHistory(i);
                    bumpEngineRevision();
                  }}
                />
              );
            })()}
            layers={engine.layers}
            activeLayerIndex={engine.activeLayerIndex}
            onSelectLayer={(idx) => {
              if (engine.bucketSeedPoint) engine.commitPaintBucketSession();
              if (engine.gradientStartPoint) engine.commitGradientSession();
              // Kliknięcie samej warstwy odznacza obiekty (także otwarty do edycji na płótnie) i efekty wewnątrz niej
              if (engine.vec.editing || engine.vec.getSelection()) {
                engine.vec.settle();
                engine.vec.clearSelection();
              }
              // Zachowuje cel edycji (piksele lub maska) wybranej warstwy. Zmiana warstwy kończy podgląd maski
              engine.setEditTarget(idx, engine.layers[idx]?.editMask ? 'mask' : 'pixels');
              engine.selectedCorrection = null;
              bumpEngineRevision();
            }}
            onSelectTarget={(idx, target) => {
              // wybór miniatury warstwy albo maski to też kliknięcie warstwy: zaznaczenie obiektów i efektów znika
              if (engine.vec.editing || engine.vec.getSelection()) {
                engine.vec.settle();
                engine.vec.clearSelection();
              }
              engine.selectedCorrection = null;
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
            corrOnlyActive={corrOnlyActive}
            onChangeCorrOnlyActive={setCorrOnlyActive}
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
            onAddGroup={opAddGroup}
            onToggleExpand={(idx) => {
              const g = engine.layers[idx];
              const act = engine.getActiveLayer();
              // Zwijana grupa z aktywną warstwą w środku: zaznaczana jest grupa (ukryta warstwa nie może być celem przycisków panelu)
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
            onAddVectorLayer={opAddVectorLayer}
            selectedVectorObjects={engine.vec.getSelection()}
            pendingVectorObject={(() => {
              const act = engine.getActiveLayer();
              if (!isLiveVectorSessionActive || !act?.vectorTarget || engine.vec.editing) return null;
              const names: Record<string, string> = { line: 'Linia', bezier: 'Krzywa', shapes: 'Kształt', text: 'Tekst', pen: 'Pisak' };
              return { layerId: act.id, label: names[activeTool] ?? 'Obiekt' };
            })()}
            onSelectVectorObjects={(idx, ids) => {
              // Lista pokazuje obiekty bieżącego celu edycji warstwy (maska albo piksele), więc cel zostaje bez zmian
              engine.setEditTarget(idx, engine.layers[idx]?.editMask && engine.layers[idx]?.hasMask ? 'mask' : 'pixels');
              setActiveToolRaw('vector-select');
              engine.vec.settle();
              engine.vec.setSelection(engine.layers[idx]?.id ?? null, ids);
              bumpEngineRevision();
            }}
            onOpenSmartObject={handleOpenSmartObject}
            onEditVectorObject={(idx, id) => {
              // Lista pokazuje obiekty bieżącego celu edycji warstwy (maska albo piksele), więc cel zostaje bez zmian
              engine.setEditTarget(idx, engine.layers[idx]?.editMask && engine.layers[idx]?.hasMask ? 'mask' : 'pixels');
              setActiveToolRaw('vector-select');
              setVectorEditRequest((r) => ({ n: (r?.n ?? 0) + 1, layerIndex: idx, id }));
              bumpEngineRevision();
            }}
            onToggleVectorObject={(idx, id, vis, ids) => {
              if (ids && ids.length > 1) engine.vec.setObjectsVisible(idx, ids, vis);
              else engine.vec.setObjectVisible(idx, id, vis);
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
            onAddLayer={opAddLayer}
            onRemoveLayer={opRemove}
            onDuplicateLayer={opDuplicate}
            mergeDownApplies={engine.applyEffectsMode !== 'none'}
            applyEffectsMode={engine.applyEffectsMode}
            selectedCorrection={engine.selectedCorrection}
            selectedCorrectionIds={engine.selectedCorrectionIds}
            onSelectCorrection={(idx, id, mode) => {
              engine.setEditTarget(idx, 'pixels');
              engine.selectCorrection(idx, id, mode);
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
            onConvertLayer={handleConvertLayer}
            onMergeDown={opMergeDown}
            onMoveUp={opMoveUp}
            onMoveDown={opMoveDown}
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

      {imageDlg === 'resize' && (
        <ImageResizeDialog
          width={engine.width}
          height={engine.height}
          dpi={engine.dpi}
          defaultUnit={effectiveUnit}
          onCancel={() => setImageDlg(null)}
          onApply={(r) => {
            const res = engine.resizeImage(r.width, r.height, r.method, r.dpi !== engine.dpi ? r.dpi : undefined);
            setImageDlg(null);
            if (!res.ok) showToast(res.reason);
            else showToast(`Rozmiar obrazu: ${engine.width} × ${engine.height} px`);
            bumpEngineRevision();
          }}
        />
      )}
      {imageDlg === 'canvas' && (
        <CanvasSizeDialog
          width={engine.width}
          height={engine.height}
          dpi={engine.dpi}
          defaultUnit={effectiveUnit}
          onCancel={() => setImageDlg(null)}
          onApply={(r) => {
            const res = engine.resizeCanvas(r.width, r.height, r.ax, r.ay);
            setImageDlg(null);
            if (!res.ok) showToast(res.reason);
            else showToast(`Rozmiar płótna: ${engine.width} × ${engine.height} px`);
            bumpEngineRevision();
          }}
        />
      )}

      {pasteFitDlg && (
        <PasteFitDialog
          imageW={pasteFitDlg.iw}
          imageH={pasteFitDlg.ih}
          canvasW={engine.width}
          canvasH={engine.height}
          crops={pasteFitDlg.crops}
          onChoose={(c) => {
            const r = pasteFitDlg.resolve;
            setPasteFitDlg(null);
            r(c);
          }}
        />
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} historyBytes={activeTab ? engine.getHistoryBytes() : null} />}
      {exportOpen && activeTab && <ExportDialog engine={engine} baseName={activeTab.title} onClose={() => setExportOpen(false)} onExport={handleExportFile} />}
      {printOpen && activeTab && <PrintDialog engine={engine} docName={activeTab.title} onClose={() => setPrintOpen(false)} />}
      {propsOpen && activeTab && (
        <DocPropsDialog
          engine={engine}
          file={{ name: activeTab.smart ? `${activeTab.title} (obiekt inteligentny)` : activeTab.file?.name ?? `${activeTab.title}.fig`, location: activeTab.smart ? 'Część dokumentu nadrzędnego' : activeTab.file ? activeTab.file.path ?? activeTab.file.name : null, fileSize: activeTab.fileSize ?? null, savedAt: activeTab.savedAt ?? null, dirty: tabDirty(activeTab) }}
          onClose={() => setPropsOpen(false)}
          onChangeDpi={(dpi) => {
            const r = engine.resizeImage(engine.width, engine.height, 'bicubic', dpi);
            if (!r.ok) showToast(r.reason);
            bumpEngineRevision();
          }}
        />
      )}
      {unsavedDlg && (
        <UnsavedDialog
          names={unsavedDlg.names}
          action={unsavedDlg.action}
          onAnswer={(a) => {
            const r = unsavedDlg.resolve;
            setUnsavedDlg(null);
            r(a);
          }}
        />
      )}

      {selOffsetDlg && (
        <SelectionOffsetDialog
          dpi={engine.dpi}
          defaultUnit={effectiveUnit}
          maxPx={Math.max(engine.width, engine.height)}
          onCancel={() => setSelOffsetDlg(false)}
          onApply={(r) => {
            const res = engine.offsetSelection(r.delta, r.feather);
            setSelOffsetDlg(false);
            if (!res.ok) showToast(res.reason ?? 'Nie udało się zmienić zaznaczenia');
            else if (!engine.selectionManager.hasActiveSelection) showToast('Zaznaczenie zniknęło po zmniejszeniu');
            bumpEngineRevision();
          }}
        />
      )}

      {layerPropsDlg && (() => {
        const dlg = layerPropsDlg;
        const idx = () => engine.layers.indexOf(dlg.layer);
        const close = () => setLayerPropsDlg(null);
        return (
          <LayerPropsDialog
            kind={dlg.kind}
            layerName={dlg.layer.name}
            isGroup={dlg.layer.isGroup}
            initialBlend={dlg.blend}
            initialOpacity={dlg.opacity}
            onPreviewBlend={(m) => {
              engine.previewLayerBlendMode(idx(), m);
              bumpEngineRevision();
            }}
            onPreviewOpacity={(v) => {
              engine.setLayerOpacity(idx(), v);
              bumpEngineRevision();
            }}
            onOk={(value) => {
              if (dlg.kind === 'blend') {
                // podgląd zmienił już warstwę bez historii: wraca stary tryb, a zmiana trafia do historii jednym wpisem
                engine.previewLayerBlendMode(idx(), dlg.blend);
                engine.setLayerBlendMode(idx(), value as SKBlendMode);
              } else {
                engine.setLayerOpacity(idx(), value as number, dlg.opacity);
              }
              close();
              bumpEngineRevision();
            }}
            onCancel={() => {
              if (dlg.kind === 'blend') engine.previewLayerBlendMode(idx(), dlg.blend);
              else engine.setLayerOpacity(idx(), dlg.opacity);
              close();
              bumpEngineRevision();
            }}
          />
        );
      })()}

      <StatusBar
        statusText=""
        docWidth={engine.width}
        docHeight={engine.height}
        zoom={zoom}
        onZoomChange={setZoom}
        unit={effectiveUnit}
        onUnitChange={setLengthUnit}
        unitsLocked={!!activeTab?.smart}
        dpi={engine.dpi}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled((v) => !v)}
        guidesVisible={guidesVisible}
        onToggleGuides={() => setGuidesVisible((v) => !v)}
        rulersVisible={rulersVisible}
        onToggleRulers={() => setRulersVisible((v) => !v)}
        gridVisible={gridVisible}
        onToggleGrid={() => setGridVisible((v) => !v)}
      />

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

      <NewDocumentModal
        isOpen={isNewDocModalOpen}
        onClose={() => setIsNewDocModalOpen(false)}
        onCreate={handleCreateNewDocument}
        defaultTitle={`obraz${tabs.length + 1}.fig`}
        defaultUnit={lengthUnit}
      />
    </div>
    </UnitsContext.Provider>
  );
}
