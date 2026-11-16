/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { PointerLockDelta } from '../core/pointerLockDelta.ts';

export interface ScrubFieldProps {
  value: number;
  /** Zakres wartości przyjmowanych przy wpisywaniu (i przy przeciąganiu, o ile nie podano `trackMax`). */
  min: number;
  max: number;
  /** Górna granica toru suwaka, gdy jest niższa niż `max` (wpisać można więcej niż da się przeciągnąć). */
  trackMax?: number;
  onChange: (v: number) => void;
  /** Krok wartości (domyślnie 1). Wartości są zaokrąglane do kroku. */
  step?: number;
  /** Wykładnik krzywej suwaka: >1 daje drobniejszą kontrolę przy małych wartościach (np. rozmiar pędzla). */
  curve?: number;
  /** Skala logarytmiczna toru (np. powiększenie); wymaga `min` > 0. */
  logScale?: boolean;
  /** Własne tło toru (np. gradient barwy): zamiast wypełnienia pokazywany jest wtedy znacznik położenia. */
  trackStyle?: string;
  /** Tekst wyświetlany po wartości, gdy pole nie jest edytowane (np. „%”). */
  suffix?: string;
  /** Własne formatowanie i odczyt tekstu (np. jednostki długości). */
  format?: (v: number) => string;
  parse?: (text: string) => number | null;
  /** Najdłuższy możliwy tekst pola w znakach: pole ma być tak szerokie, żeby się w nim zmieścił. Domyślnie z `max`. */
  chars?: number;
  /** Szerokość całego suwaka (tor + pole): px albo napis CSS (np. '100%'). */
  width?: number | string;
  title?: string;
  testId?: string;
  /** Wyższe pole (okna dialogowe z dużymi polami); domyślnie wysokość pól paska opcji. */
  tall?: boolean;
  disabled?: boolean;
  /**
   * Pole bez sensownego toru (zakres bardzo szeroki, np. współrzędne): pole zajmuje całą szerokość, a przeciąganie zmienia
   * wartość o `speed` na każdy piksel ruchu myszy (z Shift 10 razy wolniej).
   */
  openEnded?: boolean;
  speed?: number;
  /** Zmiana wartości o jedno „oczko” kółka myszy. Domyślnie `step` (przy szerokim zakresie z krzywą: ok. 1% długości toru). */
  wheelStep?: number;
  /** Początek i koniec przeciągania (np. do zapisu stanu w historii). */
  onScrubStart?: () => void;
  onScrubEnd?: (finalValue: number) => void;
  onEnter?: () => void;
  className?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Pole liczbowe działające jak suwak: przeciągnięcie po polu w lewo / w prawo zmienia wartość, kliknięcie włącza edycję tekstu,
 * a tor suwaka pod spodem (obszar poza samym polem) ustawia wartość tam, gdzie się kliknie.
 */
export const ScrubField: React.FC<ScrubFieldProps> = ({
  value,
  min,
  max,
  trackMax,
  onChange,
  step = 1,
  curve = 1,
  logScale,
  trackStyle,
  suffix = '',
  format,
  parse,
  chars,
  width = 92,
  title,
  testId,
  tall,
  disabled,
  openEnded,
  speed = 1,
  wheelStep,
  onScrubStart,
  onScrubEnd,
  onEnter,
  className,
}) => {
  const hi = trackMax ?? max;
  const span = Math.max(1e-9, hi - min);
  const decimals = step >= 1 ? 0 : Math.min(4, Math.max(0, Math.ceil(-Math.log10(step))));
  const fmt = (v: number) => (format ? format(v) : v.toFixed(decimals));
  const shown = fmt(value) + suffix;

  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const editBegun = useRef(false);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  /** ostatnia wartość przekazana na zewnątrz (render może jeszcze jej nie odzwierciedlać) */
  const lastEmitted = useRef(value);
  lastEmitted.current = value;

  const toT = (v: number) =>
    logScale ? clamp(Math.log(Math.max(v, min) / min) / Math.log(hi / min), 0, 1) : clamp(Math.pow(clamp((v - min) / span, 0, 1), 1 / curve), 0, 1);
  const fromT = (t: number) => {
    const raw = logScale ? min * Math.pow(hi / min, clamp(t, 0, 1)) : min + Math.pow(clamp(t, 0, 1), curve) * span;
    const snapped = Math.round(raw / step) * step;
    return clamp(Number(snapped.toFixed(6)), min, hi);
  };
  const fill = toT(value);

  const drag = useRef<{ startX: number; startT: number; onField: boolean; moved: boolean; begun: boolean; fine: boolean; startV: number; dx: number; baseDx: number; pl: PointerLockDelta } | null>(null);

  const emit = (v: number) => {
    if (v !== lastEmitted.current) {
      lastEmitted.current = v;
      latest.current.onChange(v);
    }
  };
  const begin = () => {
    const d = drag.current;
    if (d && !d.begun) {
      d.begun = true;
      onScrubStart?.();
    }
  };

  const startEdit = () => {
    setText(fmt(value));
    setEditing(true);
  };
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  // Edycja kończy się (wpisana wartość jest już zatwierdzona) także wtedy, gdy kliknięcie lub przeciągnięcie
  // zaczyna się gdziekolwiek indziej, również w elementach, które same nie zabierają fokusu
  useEffect(() => {
    if (!editing) return;
    const onAnyPointerDown = (e: PointerEvent) => {
      if (e.target !== inputRef.current) inputRef.current?.blur();
    };
    window.addEventListener('pointerdown', onAnyPointerDown, true);
    return () => window.removeEventListener('pointerdown', onAnyPointerDown, true);
  }, [editing]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return;
    // Podczas edycji kliknięcie w pole działa jak w zwykłym polu tekstowym
    if (editing && e.target === inputRef.current) return;
    if (editing) inputRef.current?.blur();
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const onField = !!openEnded || e.target === inputRef.current;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startT: toT(latest.current.value), onField, moved: false, begun: false, fine: e.shiftKey, startV: latest.current.value, dx: 0, baseDx: 0, pl: new PointerLockDelta(e.clientX, e.clientY) };
    if (!onField) {
      // Tor suwaka: kliknięcie ustawia wartość w tym miejscu, dalsze przeciąganie ją śledzi
      begin();
      drag.current.moved = true;
      emit(fromT((e.clientX - rect.left) / rect.width));
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const box = boxRef.current;
    if (!d || !box) return;
    const rect = box.getBoundingClientRect();
    if (!d.onField) {
      emit(fromT((e.clientX - rect.left) / rect.width));
      return;
    }
    // Przesunięcie sumuję z przyrostów: przy zablokowanym wskaźniku (patrz niżej) clientX stoi w miejscu, a ruch podaje movementX
    d.dx += d.pl.next(e, box)[0];
    if (!d.moved) {
      if (Math.abs(d.dx) < 3) return;
      d.moved = true;
      d.baseDx = d.dx;
      d.startT = toT(latest.current.value);
      d.startV = latest.current.value;
      begin();
      // Kursor znika i stoi w miejscu na czas przeciągania, więc wartość da się zmieniać także przy krawędzi ekranu
      d.pl.request(box); // bez blokady wskaźnika przeciąganie działa jak zwykle
    }
    // Przeciąganie po polu jest względne: przesunięcie o szerokość suwaka obejmuje cały zakres (z Shift 10 razy drobniej)
    if (e.shiftKey !== d.fine) {
      d.fine = e.shiftKey;
      d.baseDx = d.dx;
      d.startT = toT(latest.current.value);
      d.startV = latest.current.value;
    }
    // Ruch poza granicami wartości jest ignorowany: przesuwam punkt odniesienia tak, by kursor „stał” na granicy,
    // więc ruch w przeciwną stronę zmienia wartość od razu, a nie dopiero po powrocie przez cały nadmiar
    const move = d.dx - d.baseDx;
    const fineK = d.fine ? 0.1 : 1;
    if (openEnded) {
      const raw = d.startV + move * speed * fineK;
      const bound = raw > max ? max : raw < min ? min : null;
      if (bound !== null) d.baseDx += (raw - bound) / (speed * fineK);
      emit(clamp(Number((Math.round(clamp(raw, min, max) / step) * step).toFixed(6)), min, max));
      return;
    }
    const t = d.startT + move / rect.width / (d.fine ? 10 : 1);
    if (t > 1) d.baseDx += (t - 1) * rect.width * (d.fine ? 10 : 1);
    else if (t < 0) d.baseDx += t * rect.width * (d.fine ? 10 : 1);
    emit(fromT(t));
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    try {
      boxRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* wskaźnik mógł już zostać zwolniony */
    }
    if (document.pointerLockElement === boxRef.current) document.exitPointerLock();
    if (d.begun) onScrubEnd?.(lastEmitted.current);
    if (d.onField && !d.moved) startEdit();
  };

  const commitText = (t: string) => {
    const v = parse ? parse(t) : parseFloat(t.replace(',', '.'));
    if (v === null || v === undefined || isNaN(v)) return;
    const c = clamp(step >= 1 ? Math.round(v / step) * step : Number(v.toFixed(decimals)), min, max);
    if (!editBegun.current && c !== latest.current.value) {
      editBegun.current = true;
      onScrubStart?.();
    }
    emit(c);
  };

  // Kółko myszy nad polem zmienia wartość o jeden krok w górę / w dół (do góry = więcej)
  const wheelAcc = useRef(0);
  const wheelTimer = useRef<number | null>(null);
  const wheelHandler = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandler.current = (e: WheelEvent) => {
    if (disabled) return;
    e.preventDefault();
    const dy = e.deltaY || e.deltaX;
    if (!dy) return;
    // Zwykłe kółko daje duże przyrosty (jedno oczko = jeden krok), gładzik drobne, które sumuję do progu
    wheelAcc.current += dy;
    if (Math.abs(wheelAcc.current) < 50) return;
    const dir = wheelAcc.current < 0 ? 1 : -1;
    wheelAcc.current = 0;
    const cur = lastEmitted.current;
    let next: number;
    if (wheelStep === undefined && !openEnded && hi - min > 300) {
      // Szeroki zakres z krzywą (np. rozmiar pędzla): krok ok. 1% długości toru, ale co najmniej jeden krok wartości
      next = fromT(toT(cur) + dir * 0.01);
      if (dir > 0 && next <= cur) next = cur + step;
      if (dir < 0 && next >= cur) next = cur - step;
    } else {
      next = cur + dir * (wheelStep ?? step) * (e.shiftKey ? 10 : 1);
    }
    next = clamp(Number((Math.round(next / step) * step).toFixed(6)), min, max);
    if (!changeBegun.current) {
      changeBegun.current = true;
      onScrubStart?.();
    }
    emit(next);
    if (editing) setText(fmt(next));
    if (wheelTimer.current) window.clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => {
      wheelTimer.current = null;
      if (changeBegun.current) {
        changeBegun.current = false;
        onScrubEnd?.(lastEmitted.current);
      }
    }, 300);
  };
  const changeBegun = useRef(false);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // Nasłuch natywny (nie pasywny), bo trzeba wstrzymać przewijanie paska opcji
    const onWheel = (e: WheelEvent) => wheelHandler.current(e);
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  const len = chars ?? Math.max(fmt(max).length, fmt(min).length) + suffix.length;

  return (
    <div
      ref={boxRef}
      title={title}
      onPointerDown={onPointerDown}
      // bez przejmowania fokusu (np. edytor tekstu na płótnie zachowuje kursor), poza edycją samego pola
      onMouseDown={(e) => {
        if (!(editing && e.target === inputRef.current)) e.preventDefault();
      }}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{ width, ...(trackStyle ? { background: trackStyle, backgroundClip: 'padding-box', backgroundRepeat: 'no-repeat' } : null) }}
      className={
        className ??
        `relative ${tall ? 'h-[30px] text-sm' : 'h-5'} shrink-0 rounded border overflow-hidden touch-none select-none ${trackStyle ? '' : 'bg-[color:var(--h-1e1e1e,#1e1e1e)]'} ${
          disabled ? 'opacity-40 border-[color:var(--h-3a3a3a,#3a3a3a)]' : editing ? 'border-[color:var(--h-007acc,#007acc)]' : `border-[color:var(--h-444444,#444444)] hover:border-[color:var(--h-666666,#666666)] ${openEnded ? 'cursor-ew-resize' : 'cursor-default'}`
        }`
      }
    >
      {/* Tor suwaka pod polem */}
      {!openEnded && !trackStyle && <div className="absolute inset-y-0 left-0 bg-[color:var(--h-007acc,#007acc)]/40 pointer-events-none" style={{ width: `${fill * 100}%` }} />}
      {!openEnded && trackStyle && (
        <div className="absolute inset-y-0 w-1 -translate-x-1/2 border border-black bg-white pointer-events-none" style={{ left: `${fill * 100}%` }} />
      )}
      <input
        ref={inputRef}
        data-testid={testId}
        data-scrub-editing={editing ? '1' : undefined}
        type="text"
        inputMode="decimal"
        readOnly={!editing}
        tabIndex={editing ? 0 : -1}
        disabled={disabled}
        value={editing ? text : shown}
        onChange={(e) => {
          setText(e.target.value);
          commitText(e.target.value);
        }}
        onBlur={() => {
          setEditing(false);
          if (editBegun.current) {
            editBegun.current = false;
            onScrubEnd?.(lastEmitted.current);
          }
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            inputRef.current?.blur();
            onEnter?.();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const nv = clamp(latest.current.value + (e.key === 'ArrowUp' ? step : -step), min, max);
            emit(nv);
            setText(fmt(nv));
          }
        }}
        style={{ width: openEnded ? '100%' : `${len + 1.5}ch`, maxWidth: '100%' }}
        className={`absolute left-1/2 top-0 h-full -translate-x-1/2 px-0 text-center ${tall ? 'text-sm' : 'text-xs'} font-mono text-[color:var(--t-white,#fff)] focus:outline-none ${
          editing ? 'bg-[color:var(--h-121212,#121212)] cursor-text' : trackStyle ? 'bg-black/55 cursor-ew-resize pointer-events-auto' : 'bg-transparent cursor-ew-resize pointer-events-auto'
        }`}
      />
    </div>
  );
};
