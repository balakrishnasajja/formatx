import { analyze, runAction } from '../engine';
import type { WorkerRequest, WorkerResponse } from './protocol';

/**
 * Engine worker: every parser, validator, formatter and converter runs here,
 * off the UI thread. User code is only ever parsed — never evaluated.
 */
interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = async (event) => {
  const req = event.data;
  try {
    if (req.type === 'ping') {
      scope.postMessage({ id: req.id, ok: true, result: 'pong' });
      return;
    }
    if (req.type === 'analyze') {
      const result = await analyze(req.payload);
      scope.postMessage({ id: req.id, ok: true, result });
      return;
    }
    const result = await runAction(req.payload);
    const transfer = result.binary ? [result.binary.buffer as ArrayBuffer] : [];
    scope.postMessage({ id: req.id, ok: true, result }, transfer);
  } catch (err) {
    scope.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
