import type { ActionRequest, ActionResult, AnalysisResult, AnalyzeRequest } from '../../types/engine';
import type { WorkerRequest, WorkerResponse } from './protocol';

export type EngineStatus = 'starting' | 'ready' | 'busy' | 'restarting' | 'main-thread';

export class EngineTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Processing took longer than ${seconds} s and was stopped. The engine was restarted; try a smaller input or another format.`);
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Talks to the engine worker. Hung or crashed workers are terminated and
 * restarted automatically; if workers are unavailable the engine runs on the
 * main thread as a fallback.
 */
export class EngineClient {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private fallback: Promise<typeof import('../engine')> | null = null;
  private statusValue: EngineStatus = 'starting';
  private readonly listeners = new Set<(s: EngineStatus) => void>();

  constructor() {
    this.spawn();
  }

  get status(): EngineStatus {
    return this.statusValue;
  }

  onStatus(fn: (s: EngineStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.statusValue);
    return () => this.listeners.delete(fn);
  }

  private setStatus(s: EngineStatus) {
    this.statusValue = s;
    for (const l of this.listeners) l(s);
  }

  private spawn() {
    try {
      this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'formatx-engine' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      this.worker.onerror = (e) => {
        e.preventDefault();
        console.error('[FormatX] engine worker error', e.message);
        this.restart('The processing engine crashed and was restarted.');
      };
      this.setStatus('ready');
    } catch (err) {
      console.warn('[FormatX] Web Workers unavailable, using the main thread', err);
      this.worker = null;
      this.setStatus('main-thread');
    }
  }

  restart(reason = 'Engine restarted.') {
    this.setStatus('restarting');
    this.worker?.terminate();
    this.worker = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    this.spawn();
  }

  private onMessage(msg: WorkerResponse) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (this.pending.size === 0 && this.statusValue === 'busy') this.setStatus('ready');
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  private async direct<T>(req: WorkerRequest): Promise<T> {
    this.fallback ??= import('../engine');
    const engine = await this.fallback;
    if (req.type === 'analyze') return (await engine.analyze(req.payload)) as T;
    if (req.type === 'action') return (await engine.runAction(req.payload)) as T;
    return 'pong' as T;
  }

  private call<T>(type: WorkerRequest['type'], payload: unknown, timeoutMs: number): Promise<T> {
    const id = ++this.seq;
    const req = { id, type, payload } as WorkerRequest;
    if (!this.worker) return this.direct<T>(req);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineTimeoutError(Math.round(timeoutMs / 1000)));
        this.restart('A long-running task was stopped.');
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.setStatus('busy');
      this.worker!.postMessage(req);
    });
  }

  analyze(req: AnalyzeRequest): Promise<AnalysisResult> {
    return this.call<AnalysisResult>('analyze', req, 45_000);
  }

  run(req: ActionRequest): Promise<ActionResult> {
    // first use of some formats downloads large modules (e.g. the 10 MB Ruff WebAssembly)
    return this.call<ActionResult>('action', req, 120_000);
  }
}

export const engine = new EngineClient();
