/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BucketJob, BucketResult, FillSolver, WandJob, WandResult } from './FillSolver.ts';

type AnyResult = (WandResult | BucketResult | { id: number; kind: 'wand' | 'bucket'; status: 'error'; message: string });

/**
 * Klient wątku roboczego różdżki i wiadra. Gdy wątek nie może powstać (np. środowisko bez Worker), te same obliczenia
 * wykonuje FillSolver w głównym wątku, z opóźnieniem zdarzenia (wynik zawsze wraca asynchronicznie).
 */
export class FillClient {
  /** Podmiana fabryki wątku (testy) */
  public static workerFactory: (() => Worker) | null = null;

  private worker: Worker | null = null;
  private local: FillSolver | null = null;
  private seq = 0;
  private waiting = new Map<number, (r: AnyResult) => void>();
  private sampleKey: string | null = null;
  private selKey: string | null = null;
  private localQueue: Array<{ kind: 'wand' | 'bucket'; job: WandJob | BucketJob }> = [];
  private localTimer: ReturnType<typeof setTimeout> | null = null;

  /** Czy obliczenia idą w osobnym wątku (false = w głównym) */
  public get threaded(): boolean {
    this.ensure();
    return this.worker !== null;
  }

  private ensure(): void {
    if (this.worker || this.local) return;
    try {
      const w = FillClient.workerFactory
        ? FillClient.workerFactory()
        : new Worker(new URL('./WandWorker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent) => {
        const r = e.data as AnyResult;
        const cb = this.waiting.get(r.id);
        if (cb) {
          this.waiting.delete(r.id);
          cb(r);
        }
      };
      w.onerror = () => {
        // wątek się wysypał: przełączamy się na obliczenia lokalne, a oczekujące zadania kończymy jako nieaktualne
        this.worker = null;
        this.local = new FillSolver();
        this.sampleKey = null;
        this.selKey = null;
        for (const [id, cb] of this.waiting) cb({ id, kind: 'wand', status: 'stale' });
        this.waiting.clear();
      };
      this.worker = w;
    } catch {
      this.local = new FillSolver();
    }
  }

  public hasSample(key: string): boolean {
    return this.sampleKey === key;
  }

  public hasSelection(key: string): boolean {
    return this.selKey === key;
  }

  /** Przekazuje piksele próbki (bufor jest PRZENOSZONY do wątku, więc `data` po wywołaniu jest pusta). */
  public setSample(key: string, w: number, h: number, data: Uint8ClampedArray): void {
    this.ensure();
    this.sampleKey = key;
    if (this.worker) this.worker.postMessage({ t: 'sample', key, w, h, buf: data.buffer }, [data.buffer]);
    else this.local!.setSample(key, w, h, data);
  }

  public setSelection(key: string, alpha: Uint8Array | null): void {
    this.ensure();
    this.selKey = alpha ? key : null;
    if (this.worker) this.worker.postMessage({ t: 'sel', key, buf: alpha ? alpha.buffer : null }, alpha ? [alpha.buffer] : []);
    else this.local!.setSelection(key, alpha);
  }

  public release(): void {
    this.sampleKey = null;
    this.selKey = null;
    if (this.worker) this.worker.postMessage({ t: 'release' });
    else this.local?.release();
  }

  public nextId(): number {
    return ++this.seq;
  }

  public wand(job: WandJob): Promise<AnyResult> {
    return this.submit('wand', job);
  }

  public bucket(job: BucketJob): Promise<AnyResult> {
    return this.submit('bucket', job);
  }

  private submit(kind: 'wand' | 'bucket', job: WandJob | BucketJob): Promise<AnyResult> {
    this.ensure();
    return new Promise((resolve) => {
      this.waiting.set(job.id, resolve);
      if (this.worker) {
        this.worker.postMessage({ t: kind, job });
        return;
      }
      // Lokalnie: tylko najnowsze zadanie danego rodzaju (jak w wątku roboczym), wykonane po oddaniu sterowania pętli zdarzeń
      this.localQueue.push({ kind, job });
      if (!this.localTimer) {
        this.localTimer = setTimeout(() => {
          this.localTimer = null;
          const q = this.localQueue.splice(0, this.localQueue.length);
          for (let i = 0; i < q.length; i++) {
            const it = q[i];
            const cb = this.waiting.get(it.job.id);
            if (!cb) continue;
            this.waiting.delete(it.job.id);
            if (q.some((o, k) => k > i && o.kind === it.kind)) {
              cb({ id: it.job.id, kind: it.kind, status: 'stale' });
              continue;
            }
            try {
              cb(it.kind === 'wand' ? this.local!.wand(it.job as WandJob) : this.local!.bucket(it.job as BucketJob));
            } catch (err) {
              cb({ id: it.job.id, kind: it.kind, status: 'error', message: String(err) });
            }
          }
        }, 0);
      }
    });
  }
}
