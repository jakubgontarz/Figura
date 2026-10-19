/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BucketAlpha, WAND_PAD, bucketAlphaOfFlood, floodSelect, ringsOfFlood } from './WandCore.ts';

/**
 * Obliczenia różdżki i wiadra z farbą na zapamiętanej kopii pikseli. Działa w wątku roboczym (WandWorker.ts), a gdy
 * wątki są niedostępne - w głównym wątku (FillClient.ts). Nie używa DOM.
 */

export interface WandJob {
  id: number;
  key: string;
  sx: number;
  sy: number;
  tol: number;
  global: boolean;
  /** Id zadania, którego wynik jest aktualnie zastosowany po stronie głównej (null = brak); pozwala pominąć przebudowę identycznego obszaru */
  reuseId: number | null;
}

export interface BucketJob {
  id: number;
  key: string;
  /** Klucz płaszczyzny alfa zaznaczenia (null = bez ograniczenia zaznaczeniem) */
  selKey: string | null;
  sx: number;
  sy: number;
  tol: number;
  global: boolean;
  aa: boolean;
}

export type WandResult =
  | { id: number; kind: 'wand'; status: 'same' | 'stale' }
  | { id: number; kind: 'wand'; status: 'ok'; rings: Float64Array[]; count: number };

export type BucketResult =
  | { id: number; kind: 'bucket'; status: 'stale' }
  | { id: number; kind: 'bucket'; status: 'ok'; res: BucketAlpha | null };

export class FillSolver {
  private sample: { key: string; w: number; h: number; data: Uint8ClampedArray } | null = null;
  private sel: { key: string; alpha: Uint8Array } | null = null;
  private last: {
    id: number;
    key: string;
    global: boolean;
    color: number;
    tol: number;
    count: number;
    sx: number;
    sy: number;
    mask: Uint8Array;
    ms: number;
  } | null = null;

  public setSample(key: string, w: number, h: number, data: Uint8ClampedArray): void {
    this.sample = { key, w, h, data };
    this.last = null;
  }

  public setSelection(key: string, alpha: Uint8Array | null): void {
    this.sel = alpha ? { key, alpha } : null;
  }

  public hasSample(key: string): boolean {
    return !!this.sample && this.sample.key === key;
  }

  public release(): void {
    this.sample = null;
    this.sel = null;
    this.last = null;
  }

  public wand(job: WandJob): WandResult {
    const S = this.sample;
    if (!S || S.key !== job.key) return { id: job.id, kind: 'wand', status: 'stale' };
    const { w, h, data } = S;
    const sx = Math.max(0, Math.min(w - 1, job.sx));
    const sy = Math.max(0, Math.min(h - 1, job.sy));
    const p = (sy * w + sx) * 4;
    const color = ((data[p + 3] << 24) | (data[p + 2] << 16) | (data[p + 1] << 8) | data[p]) >>> 0;
    const last = this.last;
    const lastValid = job.reuseId !== null && !!last && last.id === job.reuseId && last.key === job.key && last.global === job.global && last.color === color;
    if (lastValid && last!.tol === job.tol && (job.global || last!.mask[(sy + 1) * last!.ms + WAND_PAD + sx] === 255)) {
      last!.id = job.id;
      return { id: job.id, kind: 'wand', status: 'same' };
    }
    const flood = floodSelect(data, w, h, sx, sy, job.tol, job.global);
    // Obszar identyczny z poprzednim (obszary są zagnieżdżone przy zmianie tolerancji, więc równa liczba pikseli = ten sam obszar)
    if (lastValid && last!.count === flood.count && (job.global || (last!.sx === sx && last!.sy === sy))) {
      last!.tol = job.tol;
      last!.mask = flood.mask;
      last!.id = job.id;
      return { id: job.id, kind: 'wand', status: 'same' };
    }
    const rings = ringsOfFlood(flood, w, h);
    this.last = { id: job.id, key: job.key, global: job.global, color, tol: job.tol, count: flood.count, sx, sy, mask: flood.mask, ms: flood.ms };
    return { id: job.id, kind: 'wand', status: 'ok', rings, count: flood.count };
  }

  public bucket(job: BucketJob): BucketResult {
    const S = this.sample;
    if (!S || S.key !== job.key) return { id: job.id, kind: 'bucket', status: 'stale' };
    let allow: Uint8Array | null = null;
    if (job.selKey !== null) {
      if (!this.sel || this.sel.key !== job.selKey) return { id: job.id, kind: 'bucket', status: 'stale' };
      allow = this.sel.alpha;
    }
    const { w, h, data } = S;
    const sx = Math.max(0, Math.min(w - 1, job.sx));
    const sy = Math.max(0, Math.min(h - 1, job.sy));
    const flood = floodSelect(data, w, h, sx, sy, job.tol, job.global, allow);
    const res = bucketAlphaOfFlood(flood, data, w, sx, sy, job.tol, job.aa);
    return { id: job.id, kind: 'bucket', status: 'ok', res };
  }
}
