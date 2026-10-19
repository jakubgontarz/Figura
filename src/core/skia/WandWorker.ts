/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FillSolver, BucketJob, WandJob } from './FillSolver.ts';

/**
 * Wątek roboczy różdżki i wiadra z farbą: wypełnianie i śledzenie konturu poza głównym wątkiem, żeby suwak tolerancji
 * i uchwyt reagowały płynnie także na dużym płótnie. Przy zakolejkowanych zadaniach liczone jest tylko najnowsze.
 */

interface WorkerScope {
  onmessage: ((e: { data: any }) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;
const solver = new FillSolver();
const queue: Array<{ type: 'wand' | 'bucket'; job: WandJob | BucketJob }> = [];
let scheduled = false;

function drain(): void {
  scheduled = false;
  if (queue.length === 0) return;
  // Zadania o tym samym rodzaju: tylko najnowsze (starsze nie mają już znaczenia), pominięte są zgłaszane jako nieaktualne
  const items = queue.splice(0, queue.length);
  const latest = new Map<string, (typeof items)[number]>();
  for (const it of items) latest.set(it.type, it);
  for (const it of items) {
    if (latest.get(it.type) !== it) {
      scope.postMessage({ id: it.job.id, kind: it.type, status: 'stale' });
      continue;
    }
    try {
      if (it.type === 'wand') {
        const r = solver.wand(it.job as WandJob);
        scope.postMessage(r, r.status === 'ok' ? r.rings.map((x) => x.buffer as ArrayBuffer) : []);
      } else {
        const r = solver.bucket(it.job as BucketJob);
        scope.postMessage(r, r.status === 'ok' && r.res ? [r.res.alpha.buffer as ArrayBuffer] : []);
      }
    } catch (err) {
      scope.postMessage({ id: it.job.id, kind: it.type, status: 'error', message: String(err) });
    }
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'sample') solver.setSample(m.key, m.w, m.h, new Uint8ClampedArray(m.buf));
  else if (m.t === 'sel') solver.setSelection(m.key, m.buf ? new Uint8Array(m.buf) : null);
  else if (m.t === 'release') solver.release();
  else if (m.t === 'wand' || m.t === 'bucket') {
    queue.push({ type: m.t, job: m.job });
    if (!scheduled) {
      scheduled = true;
      setTimeout(drain, 0);
    }
  }
};
