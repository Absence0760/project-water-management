// The page's side of the preview worker (./engine.worker.ts, roadmap
// WP-1.17). A panel imports this module dynamically, so neither it nor the
// worker is in any page chunk until a preview is wanted.
//
// One request at a time, latest wins: a new request while one is computing
// terminates the worker (the engine loop is synchronous and can't be told to
// stop) and rejects the old one with PreviewSuperseded, then starts the new
// one in a fresh worker. cancel() does the same with nothing after it;
// close() ends the session. An answer carrying another request's id is
// dropped, so a late reply never lands on a newer request.
import type { YieldPoint } from '@water-management/engine';
import type { FromWorker, ToWorker, YieldPreviewRequest } from './messages';
// The worker is a chunk of the page build, so it shares the page's engine
// chunks instead of carrying its own copy (frontend/vite.config.ts, workerChunks).
import previewWorkerUrl from 'virtual:preview-worker-url';

/** The request was replaced by a newer one, cancelled, or the session closed: not an error to show. */
export class PreviewSuperseded extends Error {
	constructor() {
		super('superseded');
		this.name = 'PreviewSuperseded';
	}
}

/** A worker-like object: the real Worker, or a fake in the unit tests. */
export interface WorkerLike {
	postMessage(m: ToWorker): void;
	terminate(): void;
	onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
	onerror: ((e: ErrorEvent) => void) | null;
}

export interface PreviewEngine {
	/** A dam's firm yield on this input, as the `yield` job works it out (./compute.ts). */
	firmYield(request: YieldPreviewRequest): Promise<YieldPoint>;
	/** Stop the request in flight, if any (it rejects with PreviewSuperseded). */
	cancel(): void;
	/** cancel(), and no worker is kept. */
	close(): void;
}

export function createPreviewEngine(spawn: () => WorkerLike = () => new Worker(previewWorkerUrl, { type: 'module' }) as unknown as WorkerLike): PreviewEngine {
	let worker: WorkerLike | null = null;
	let nextId = 1;
	let pending: { id: number; resolve: (p: YieldPoint) => void; reject: (e: Error) => void } | null = null;

	const stop = () => {
		worker?.terminate();
		worker = null;
	};
	const settle = (fn: (p: NonNullable<typeof pending>) => void) => {
		const p = pending;
		pending = null;
		if (p) fn(p);
	};
	const ensure = (): WorkerLike => {
		if (worker) return worker;
		const w = spawn();
		w.onmessage = (e) => {
			const m = e.data;
			if (!pending || m.id !== pending.id) return;
			if (m.type === 'yield-done') settle((p) => p.resolve(m.point));
			else settle((p) => p.reject(new Error(m.message)));
		};
		w.onerror = (e) => {
			if (worker === w) stop();
			settle((p) => p.reject(new Error(e.message || 'the preview stopped unexpectedly')));
		};
		worker = w;
		return w;
	};
	const cancel = () => {
		if (!pending) return;
		// The worker is busy with it: only a fresh one is free for the next.
		stop();
		settle((p) => p.reject(new PreviewSuperseded()));
	};

	return {
		firmYield(request) {
			cancel();
			const id = nextId++;
			return new Promise<YieldPoint>((resolve, reject) => {
				pending = { id, resolve, reject };
				try {
					ensure().postMessage({ type: 'yield', id, request });
				} catch (err) {
					// Not posted (an input that can't be cloned): nothing is in flight, the worker stays free.
					pending = null;
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		},
		cancel,
		close() {
			cancel();
			stop();
		}
	};
}
