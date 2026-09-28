// Plain-language readings of the calibration statistics shown on a run.
// No pass marks: Moriasi et al.'s (2007) thresholds were set for monthly
// flows and don't carry over to daily fits (calibration research CR-6).

/** Plain-language reading of PBIAS (positive = model under-estimates, per the engine's sign). */
export function describePbias(pbias: number | null | undefined): string {
	if (pbias == null || !Number.isFinite(pbias)) return '';
	if (Math.abs(pbias) < 0.05) return 'no overall bias';
	return pbias > 0 ? 'model under-estimates total flow' : 'model over-estimates total flow';
}

export const NSE_HELP =
	'Nash–Sutcliffe efficiency: 1 is a perfect fit, 0 is no better than the mean observed flow, below 0 is worse.';
export const PBIAS_HELP =
	'Percent bias: 100 × Σ(observed − simulated) / Σ observed. Positive means the model under-estimates total flow.';
