// What the calibration worker is given for the sensitivity runs (CR-21,
// docs/model.md §2.10g), and what it posts back. Nothing is stored: the
// browser runs them from the run's own inputs and shows the result.
import type { ModelInput, SensitivityOptions, SensitivityResult } from '@water-management/engine';

export interface SensitivityJob {
	kind: 'sensitivity';
	input: ModelInput;
	options: Pick<SensitivityOptions, 'ranges' | 'skip'>;
}

export type SensitivityWorkerMessage =
	| { type: 'sensitivity-progress'; progress: { done: number; total: number } }
	| { type: 'sensitivity-done'; result: SensitivityResult }
	| { type: 'error'; message: string };
