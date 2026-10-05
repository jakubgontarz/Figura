/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GraphicEngine } from './core/skia/GraphicEngine.ts';
import {
  BrushSettings,
  GradientSettings,
  LineAndCurveSettings,
  PipetteSettings,
  SKBlendMode,
  SKColor,
  SelectionSettings,
  ShapeKind,
  ToolType,
  VectorShapeSettings,
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
    }));
  }, [primaryColor, secondaryColor]);

  // Stan aktywnej sesji wektorowej (linia, krzywa, figura)
  const [isLiveVectorSessionActive, setIsLiveVectorSessionActive] = useState(false);
  const [liveVectorCommitTrigger, setLiveVectorCommitTrigger] = useState(0);
  const [liveVectorCancelTrigger, setLiveVectorCancelTrigger] = useState(0);

  // Narzędzia
  const [activeTool, setActiveTool] = useState<ToolType>('brush');

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

  const handleCut = useCallback(() => {
    if (engine.cut()) {
      bumpEngineRevision();
    }
  }, [engine, bumpEngineRevision]);

  const handleCopy = useCallback(() => {
    engine.copy();
  }, [engine]);

  const pasteImageBlob = useCallback((file: File | Blob) => {
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
  }, [engine, bumpEngineRevision]);

  const handlePaste = useCallback(() => {
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

  // Skróty klawiszowe
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement as HTMLElement | null;
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
          handlePaste();
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
      else if (key === 'k') setActiveTool('pipette');
      else if (key === 'f') setActiveTool('bucket');
      else if (key === 'g') setActiveTool('gradient');
      else if (key === 'o') setActiveTool('shapes');
      else if (key === 'u') setActiveTool('line');
      else if (key === 'h') setActiveTool('pan');
      else if (key === 'x') {
        setPrimaryColor(secondaryColor);
        setSecondaryColor(primaryColor);
      } else if (e.key === 'Delete') {
        const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
        engine.getActiveLayer()?.clear(mask);
        bumpEngineRevision();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [engine, primaryColor, secondaryColor, bumpEngineRevision, handleCut, handleCopy, handlePaste]);

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
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.clear(mask);
      bumpEngineRevision();
    },
    onFillLayer: () => {
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.fill(primaryColor, mask);
      bumpEngineRevision();
    },
    onCut: handleCut,
    onCopy: handleCopy,
    onPaste: handlePaste,
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
      engine.getActiveLayer()?.flipHorizontal();
      bumpEngineRevision();
    },
    onFlipVertical: () => {
      engine.getActiveLayer()?.flipVertical();
      bumpEngineRevision();
    },
    onInvertColors: () => {
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.invertColors(mask);
      bumpEngineRevision();
    },
    onGrayscale: () => {
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.toGrayscale(mask);
      bumpEngineRevision();
    },
    onBrightnessUp: () => {
      const mask = engine.selectionManager.hasActiveSelection ? engine.selectionManager.maskCanvas : null;
      engine.getActiveLayer()?.adjustBrightnessContrast(20, 0, mask);
      bumpEngineRevision();
    },
    onContrastUp: () => {
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
        primaryColor={primaryColor}
        secondaryColor={secondaryColor}
        activeTool={activeTool}
        onFlipHorizontal={() => {
          engine.selectionManager.flipHorizontal();
          bumpEngineRevision();
        }}
        onFlipVertical={() => {
          engine.selectionManager.flipVertical();
          bumpEngineRevision();
        }}
        isLiveVectorSessionActive={isLiveVectorSessionActive}
        onCommitLiveVectorSession={() => setLiveVectorCommitTrigger((c) => c + 1)}
        onCancelLiveVectorSession={() => setLiveVectorCancelTrigger((c) => c + 1)}
      />

      {/* 4. Główny obszar roboczy */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        <Toolbox
          activeTool={activeTool}
          onSelectTool={setActiveTool}
          activeShapeType={vectorShapeSettings.shapeKind}
          onSelectShapeType={(sh) => setVectorShapeSettings((prev) => ({ ...prev, shapeKind: sh }))}
        />

        <CanvasViewport
          engine={engine}
          engineRevision={engineRevision}
          brushSettings={brushSettings}
          selectionSettings={selectionSettings}
          onChangeSelectionSettings={handleUpdateSelectionSettings}
          pipetteSettings={pipetteSettings}
          gradientSettings={gradientSettings}
          vectorShapeSettings={vectorShapeSettings}
          onChangeVectorShapeSettings={handleUpdateVectorShapeSettings}
          lineAndCurveSettings={lineAndCurveSettings}
          onChangeLineAndCurveSettings={handleUpdateLineAndCurveSettings}
          primaryColor={primaryColor}
          secondaryColor={secondaryColor}
          activeTool={activeTool}
          activeShapeType={vectorShapeSettings.shapeKind}
          zoom={zoom}
          panOffset={panOffset}
          onUpdateZoom={setZoom}
          onUpdatePan={setPanOffset}
          onPipettePick={(color) => {
            setPrimaryColor(color);
            setBrushSettings((prev) => ({ ...prev, color }));
          }}
          onCanvasModified={bumpEngineRevision}
          onLiveVectorSessionChange={setIsLiveVectorSessionActive}
          liveVectorCommitTrigger={liveVectorCommitTrigger}
          liveVectorCancelTrigger={liveVectorCancelTrigger}
        />

        {/* Prawy panel boczny: Kolor + Warstwy */}
        <div className="w-[280px] bg-[#252526] border-l border-[#1a1a1a] p-1.5 flex flex-col gap-2 overflow-y-auto z-10 select-none flex-shrink-0">
          <ColorPanel
            primaryColor={primaryColor}
            secondaryColor={secondaryColor}
            onChangePrimaryColor={(c) => {
              setPrimaryColor(c);
              bumpEngineRevision();
            }}
            onChangeSecondaryColor={(c) => {
              setSecondaryColor(c);
              bumpEngineRevision();
            }}
          />

          <LayersPanel
            layers={engine.layers}
            activeLayerIndex={engine.activeLayerIndex}
            onSelectLayer={(idx) => {
              engine.activeLayerIndex = idx;
              bumpEngineRevision();
            }}
            onAddLayer={() => {
              engine.addLayer();
              bumpEngineRevision();
            }}
            onRemoveLayer={() => {
              engine.removeActiveLayer();
              bumpEngineRevision();
            }}
            onDuplicateLayer={() => {
              engine.duplicateActiveLayer();
              bumpEngineRevision();
            }}
            onMergeDown={() => {
              engine.mergeLayerDown();
              bumpEngineRevision();
            }}
            onMoveUp={() => {
              engine.moveActiveLayerUp();
              bumpEngineRevision();
            }}
            onMoveDown={() => {
              engine.moveActiveLayerDown();
              bumpEngineRevision();
            }}
            onReorderLayers={(from, to) => {
              engine.reorderLayers(from, to);
              bumpEngineRevision();
            }}
            onToggleVisibility={(idx) => {
              engine.toggleLayerVisibility(idx);
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
