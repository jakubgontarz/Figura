/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { appWindow } from '../platform/index.ts';

/**
 * Niewidoczne uchwyty na krawędziach i w narożnikach okna do zmiany rozmiaru myszą.
 * Potrzebne w aplikacji Tauri, bo okno nie ma systemowej ramki (`decorations: false`).
 * Gdy okno jest zmaksymalizowane, uchwytów nie ma; w przeglądarce komponent nic nie wyświetla.
 */
const E = 4; // grubość krawędzi (px)
const C = 10; // rozmiar narożnika (px)

const HANDLES: { dir: string; cursor: string; style: React.CSSProperties }[] = [
  { dir: 'North', cursor: 'ns-resize', style: { top: 0, left: C, right: C, height: E } },
  { dir: 'South', cursor: 'ns-resize', style: { bottom: 0, left: C, right: C, height: E } },
  { dir: 'West', cursor: 'ew-resize', style: { left: 0, top: C, bottom: C, width: E } },
  { dir: 'East', cursor: 'ew-resize', style: { right: 0, top: C, bottom: C, width: E } },
  { dir: 'NorthWest', cursor: 'nwse-resize', style: { top: 0, left: 0, width: C, height: C } },
  { dir: 'NorthEast', cursor: 'nesw-resize', style: { top: 0, right: 0, width: C, height: C } },
  { dir: 'SouthWest', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: C, height: C } },
  { dir: 'SouthEast', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: C, height: C } },
];

export const WindowResizeHandles: React.FC = () => {
  const native = appWindow.isNative();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!native) return;
    let alive = true;
    const refresh = () => void appWindow.isMaximized().then((m) => alive && setMaximized(m));
    refresh();
    const un = appWindow.onResized(refresh);
    return () => {
      alive = false;
      un();
    };
  }, [native]);
  if (!native || maximized) return null;
  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.dir}
          data-testid={`resize-${h.dir}`}
          onMouseDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            appWindow.startResizeDragging(h.dir);
          }}
          style={{ position: 'fixed', zIndex: 2147483000, cursor: h.cursor, ...h.style }}
        />
      ))}
    </>
  );
};
