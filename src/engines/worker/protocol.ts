import type { ActionRequest, ActionResult, AnalysisResult, AnalyzeRequest } from '../../types/engine';

export type WorkerRequest =
  | { id: number; type: 'analyze'; payload: AnalyzeRequest }
  | { id: number; type: 'action'; payload: ActionRequest }
  | { id: number; type: 'ping'; payload: null };

export type WorkerResponse =
  | { id: number; ok: true; result: AnalysisResult | ActionResult | 'pong' }
  | { id: number; ok: false; error: string };
