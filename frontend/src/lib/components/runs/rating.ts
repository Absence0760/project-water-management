// Qualitative ratings for calibration statistics, after Moriasi et al. (2007),
// "Model evaluation guidelines for systematic quantification of accuracy in
// watershed simulations" — the thresholds hydrologists quote for streamflow.
// They were set for monthly flow; for daily flow they are a strict yardstick.

export type Rating = 'very good' | 'good' | 'satisfactory' | 'unsatisfactory';

/** NSE > 0.75 very good; 0.65–0.75 good; 0.50–0.65 satisfactory; else unsatisfactory. */
export function rateNse(nse: number | null | undefined): Rating | null {
	if (nse == null || !Number.isFinite(nse)) return null;
	if (nse > 0.75) return 'very good';
	if (nse > 0.65) return 'good';
	if (nse > 0.5) return 'satisfactory';
	return 'unsatisfactory';
}

/** |PBIAS| < 10 very good; 10–15 good; 15–25 satisfactory; ≥ 25 unsatisfactory (percent). */
export function ratePbias(pbias: number | null | undefined): Rating | null {
	if (pbias == null || !Number.isFinite(pbias)) return null;
	const a = Math.abs(pbias);
	if (a < 10) return 'very good';
	if (a < 15) return 'good';
	if (a < 25) return 'satisfactory';
	return 'unsatisfactory';
}

/** Plain-language reading of PBIAS (positive = model under-estimates, per the engine's sign). */
export function describePbias(pbias: number | null | undefined): string {
	if (pbias == null || !Number.isFinite(pbias)) return '';
	if (Math.abs(pbias) < 0.05) return 'no overall bias';
	return pbias > 0 ? 'model under-estimates total flow' : 'model over-estimates total flow';
}

export const NSE_HELP =
	'Nash–Sutcliffe efficiency: 1 is a perfect fit, 0 is no better than the mean observed flow, below 0 is worse. Moriasi et al. (2007): > 0.75 very good, 0.65–0.75 good, 0.50–0.65 satisfactory.';
export const PBIAS_HELP =
	'Percent bias: 100 × Σ(observed − simulated) / Σ observed. Positive means the model under-estimates total flow. Moriasi et al. (2007): within ±10 % very good, ±15 % good, ±25 % satisfactory.';
