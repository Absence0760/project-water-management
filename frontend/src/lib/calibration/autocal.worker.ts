// Web Worker: runs the engine's heavy loops off the main thread, so the page
// stays responsive: calibrate() for a fit (a minute or so), and the
// uncertainty ensemble (issue #4 phase 9: hundreds of model runs) and its
// paired run on another run's inputs, and the sensitivity runs (CR-21, a
// dozen model runs). One worker for them all, so the engine ships once.
// Progress is posted at most every 100 ms (after each run for the sensitivity
// runs, which are few). Cancel = the page terminates the worker.
import { calibrate, runEnsemble, runPairedEnsemble, sensitivityRuns, type EnsembleProgress } from '@water-management/engine';
import type { EnsembleJob, EnsembleWorkerMessage } from './ensemble';
import type { FitRequest, WorkerMessage } from './fit';
import type { SensitivityJob, SensitivityWorkerMessage } from './sensitivity';

const post = (m: WorkerMessage | EnsembleWorkerMessage | SensitivityWorkerMessage) => (self as unknown as Worker).postMessage(m);

function runJob(job: EnsembleJob) {
	let last = 0;
	const onProgress = (progress: EnsembleProgress) => {
		const now = performance.now();
		if (now - last >= 100 || progress.done === progress.total) {
			last = now;
			post({ type: 'ensemble-progress', progress });
		}
	};
	try {
		const result =
			job.kind === 'ensemble' ? runEnsemble(job.input, job.options, { onProgress }) : runPairedEnsemble(job.input, job.baseline, { onProgress });
		post({ type: 'ensemble-done', result });
	} catch (err) {
		post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
	}
}

function runSensitivity(job: SensitivityJob) {
	try {
		const result = sensitivityRuns(job.input, { ...job.options, onProgress: (progress) => post({ type: 'sensitivity-progress', progress }) });
		post({ type: 'sensitivity-done', result });
	} catch (err) {
		post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
	}
}

self.onmessage = (e: MessageEvent<FitRequest | EnsembleJob | SensitivityJob>) => {
	// A dedicated worker only hears the page that made it (its messages carry
	// an empty origin); refuse anything that names another origin.
	if (e.origin && e.origin !== self.location.origin) return;
	const req = e.data;
	if ('kind' in req) return req.kind === 'sensitivity' ? runSensitivity(req) : runJob(req);
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
