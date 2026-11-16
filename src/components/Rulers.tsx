/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import { LengthUnit, pxPerUnit } from '../core/Units.ts';
import { mapHex } from '../core/Theme.ts';
import { useSettings } from './useSettings.ts';

/** Grubość linijki (px CSS). */
export const RULER_SIZE = 18;

const BASE = { bg: '#2a2a2a', bgDoc: '#3a3a3a', tick: '#8c8c8c', text: '#b4b4b4', edge: '#111111' };

/** Najmniejszy „ładny” krok (1, 2, 5 × 10^k) w jednostkach, dla którego odstęp na ekranie nie spada poniżej `minScreen`. */
export function niceStep(screenPerUnit: number, minScreen = 56): number {
  for (let e = -5; e <= 9; e++) {
    for (const m of [1, 2, 5]) {
      const step = m * Math.pow(10, e);
      if (step * screenPerUnit >= minScreen) return step;
    }
  }
  return Math.pow(10, 9);
}

const fmtTick = (v: number, step: number): string => {
  const dec = Math.min(5, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  const t = Number(v.toFixed(dec));
  return String(Object.is(t, -0) ? 0 : t);
};

interface RulerBarProps {
  axis: 'x' | 'y';
  /** długość linijki (px CSS) = rozmiar obszaru rysowania w tym kierunku */
  length: number;
  /** położenie początku dokumentu (0) na linijce, w px CSS od jej początku */
  origin: number;
  zoom: number;
  /** rozmiar dokumentu w tym kierunku (px dokumentu) */
  docSize: number;
  unit: LengthUnit;
  dpi: number;
  /** położenia prowadnic prostopadłych do tej linijki (px dokumentu) */
  guides: number[];
  selectedGuide?: number | null;
  markRef: React.Ref<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  testId: string;
}

/** Cienka linijka na krawędzi obszaru rysowania: podziałka w wybranej jednostce, znacznik kursora, prowadnice. */
export const RulerBar: React.FC<RulerBarProps> = ({ axis, length, origin, zoom, docSize, unit, dpi, guides, selectedGuide, markRef, onPointerDown, testId }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const horizontal = axis === 'x';
  const cfg = useSettings();
  const col = (k: keyof typeof BASE) => mapHex(BASE[k], cfg.theme, cfg.accent);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || length <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const W = horizontal ? length : RULER_SIZE;
    const H = horizontal ? RULER_SIZE : length;
    cv.width = Math.max(1, Math.round(W * dpr));
    cv.height = Math.max(1, Math.round(H * dpr));
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    // rysujemy w układzie (a = wzdłuż linijki, b = w poprzek); dla pionowej zamieniamy osie
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toAB = () => {
      if (horizontal) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      else ctx.setTransform(0, dpr, dpr, 0, 0, 0);
    };
    toAB();
    const a = (v: number) => Math.round(v * dpr) / dpr;
    const along = length;
    const thick = RULER_SIZE;

    ctx.fillStyle = col('bg');
    ctx.fillRect(0, 0, along, thick);
    const d0 = a(origin);
    const d1 = a(origin + docSize * zoom);
    ctx.fillStyle = col('bgDoc');
    ctx.fillRect(Math.max(0, d0), 0, Math.max(0, Math.min(along, d1) - Math.max(0, d0)), thick);

    const spu = pxPerUnit(unit, dpi) * zoom; // px ekranu na jednostkę
    const step = niceStep(spu);
    const minor = step / 10;
    const u0 = (0 - origin) / spu;
    const u1 = (along - origin) / spu;
    const k0 = Math.floor(u0 / minor) - 1;
    const k1 = Math.ceil(u1 / minor) + 1;
    const showMinor = minor * spu >= 4;
    ctx.strokeStyle = col('tick');
    ctx.lineWidth = 1 / dpr;
    ctx.fillStyle = col('text');
    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const labels: { x: number; text: string }[] = [];
    ctx.beginPath();
    for (let k = k0; k <= k1; k++) {
      const major = k % 10 === 0;
      const mid = k % 10 === 5 || k % 10 === -5;
      if (!major && !showMinor) continue;
      const s = origin + k * minor * spu;
      if (s < -1 || s > along + 1) continue;
      const x = Math.round(s * dpr) / dpr + 0.5 / dpr;
      const len = major ? thick : mid ? 8 : 4;
      ctx.moveTo(x, thick - len);
      ctx.lineTo(x, thick);
      if (major) labels.push({ x, text: fmtTick(k * minor, step) });
    }
    ctx.stroke();
    // podpisy w zwykłym układzie ekranu (pionowa linijka: tekst obrócony o -90°)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const l of labels) {
      ctx.save();
      if (horizontal) {
        ctx.translate(l.x + 3, 1);
      } else {
        const w = ctx.measureText(l.text).width;
        ctx.translate(1, l.x + 3 + w);
        ctx.rotate(-Math.PI / 2);
      }
      ctx.fillText(l.text, 0, 0);
      ctx.restore();
    }
    toAB();

    // znaczniki prowadnic
    for (const g of guides) {
      const s = origin + g * zoom;
      if (s < 0 || s > along) continue;
      const x = Math.round(s * dpr) / dpr + 0.5 / dpr;
      ctx.strokeStyle = g === selectedGuide ? '#ff9f1a' : '#00c8ff';
      ctx.beginPath();
      ctx.moveTo(x, thick - 6);
      ctx.lineTo(x, thick);
      ctx.stroke();
    }

    // krawędź od strony obszaru rysowania
    ctx.fillStyle = col('edge');
    ctx.fillRect(0, thick - 1 / dpr, along, 1 / dpr);
  }, [axis, length, origin, zoom, docSize, unit, dpi, guides, selectedGuide, horizontal, cfg.theme, cfg.accent]);

  return (
    <div
      data-testid={testId}
      onPointerDown={onPointerDown}
      className="relative shrink-0 overflow-hidden select-none touch-none"
      style={horizontal ? { height: RULER_SIZE, flex: '1 1 0%', minWidth: 0, cursor: 'crosshair' } : { width: RULER_SIZE, height: '100%', cursor: 'crosshair' }}
    >
      <canvas ref={canvasRef} style={{ width: horizontal ? length : RULER_SIZE, height: horizontal ? RULER_SIZE : length, display: 'block' }} />
      <div
        ref={markRef}
        className="absolute pointer-events-none"
        style={horizontal ? { top: 0, bottom: 0, width: 1, background: '#ffb020', display: 'none' } : { left: 0, right: 0, height: 1, background: '#ffb020', display: 'none' }}
      />
    </div>
  );
};
