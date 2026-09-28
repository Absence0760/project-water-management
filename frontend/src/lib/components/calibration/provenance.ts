// Labels for the fit record display (FitProvenance.svelte). Pure, so it is unit-tested.
import { CALIBRATION_PARAMS, type ApanDailyFingerprint, type RunoffModelId } from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';
import { fmtNum } from '$lib/format/number';

/**
 * "Production store capacity X1" for GR4J's x1; the key itself when unknown,
 * as a stored fit of the legacy model's parameters (removed in engine 1.0.0) is.
 */
export function paramLabel(model: string, key: string): string {
	return CALIBRATION_PARAMS[model as RunoffModelId]?.find((p) => p.key === key)?.label ?? key;
}

/** A fit record's recorded monthly forcing: "0.70 every month" when uniform, else "Oct 0.65, Nov 0.70, …". */
export function monthsText(values: readonly number[], decimals = 2): string {
	return values.every((v) => v === values[0]) ? `${fmtNum(values[0], decimals)} every month` : values.map((v, i) => `${WATER_YEAR_MONTHS[i]} ${fmtNum(v, decimals)}`).join(', ');
}

/**
 * One recorded set of CHIRPS factors (FitRecord.forcing.chirpsFactors, engine
 * ≥ 0.29.0; calendar months Jan … Dec) in water-year order: "1.52 every
 * month", or "Oct 1.40, Nov 1.61, …", a month without a factor as "–".
 */
export function chirpsFactorsText(factors: readonly (number | null)[]): string {
	const wy = [9, 10, 11, 0, 1, 2, 3, 4, 5, 6, 7, 8].map((m) => factors[m] ?? null);
	if (wy.every((v) => v !== null && v === wy[0])) return `${fmtNum(wy[0]!, 2)} every month`;
	return wy.map((v, i) => `${WATER_YEAR_MONTHS[i]} ${v === null ? '–' : fmtNum(v, 2)}`).join(', ');
}

/**
 * "GR4J", or for a fit stored before engine 1.0.0 removed the legacy model
 * (issue #16) "Legacy (removed in engine 1.0.0)": the fit record's model, in
 * the heading of FitProvenance.
 */
export function fitModelLabel(model: string): string {
	return model === 'gr4j' ? 'GR4J' : 'Legacy (removed in engine 1.0.0)';
}

/** A fit record's daily A-pan series (issue #45) in words: 'none', or its first day, length and a short hash. */
export function apanDailyText(f: ApanDailyFingerprint | null | undefined): string {
	if (f === undefined) return 'not recorded (fit made before this was tracked)';
	if (f === null) return 'none (monthly means only)';
	return `from ${f.startDate}, ${fmtNum(f.length, 0)} days (SHA-256 ${f.valuesSha256.slice(0, 12)})`;
}
