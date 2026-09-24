// Web Worker: runs the engine's calibrate() off the main thread, so the page
// stays responsive for the minute or so a fit takes. Progress is posted at
// most every 100 ms. Cancel = the page terminates the worker.
import { calibrate } from '@water-management/engine';
import type { FitRequest, WorkerMessage } from './fit';

const post = (m: WorkerMessage) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<FitRequest>) => {
	const req = e.data;
	let last = 0;
	try {
		const report = calibrate(req.input, {
			model: req.model,
			objective: req.objective,
			bounds: req.bounds,
			budget: req.budget,
			free: req.free,
			validate: req.validate,
			seed: req.seed,
			starts: req.starts,
			validationRecord: req.validationRecord,
			onProgress: (progress) => {
				const now = performance.now();
				if (now - last >= 100 || progress.evaluations === progress.budget) {
					last = now;
					post({ type: 'progress', progress });
				}
			}
		});
		post({ type: 'done', report });
	} catch (err) {
		post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
	}
};
