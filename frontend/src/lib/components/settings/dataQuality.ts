// Client-side check of settings.dataQuality, mirroring the backend's
// SettingsPatch rules (backend/src/projects/settings.ts) and the engine's
// resolveDataQuality ranges, so Save is blocked with a readable message
// instead of a 400.
import {
	defaultDataQualitySettings,
	LOW_VS_CHIRPS_BASELINES,
	LOW_VS_CHIRPS_MINIMUMS,
	RAIN_CHECK_KEYS,
	rainCheckLimits,
	ZERO_RUN_RULES,
	type DataQualitySettings,
	type LowVsChirpsBaseline,
	type LowVsChirpsMinimum,
	type RainCheckLimits,
	type ZeroRunRule
} from '@water-management/engine';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const whole = (v: unknown, lo: number, hi: number) => num(v) && Number.isInteger(v) && v >= lo && v <= hi;

export function dataQualityError(dq: Partial<DataQualitySettings> | null | undefined): string | null {
	const min = dq?.agreementMinRatio;
	const max = dq?.agreementMaxRatio;
	if (!num(min) || !(min > 0 && min <= 1)) return 'The lowest gauge/logger ratio must be above 0 % and at most 100 %.';
	if (!num(max) || !(max >= 1 && max <= 100)) return 'The highest gauge/logger ratio must be between 100 % and 10 000 %.';
	if (!whole(dq?.agreementMinDays, 1, 366)) return 'Minimum shared days must be a whole number from 1 to 366.';
	// The limits added in engine 1.20.0 (issue #66). A field the stored settings
	// don't have yet is filled from the defaults by the API, so every one is present.
	const factor = (v: unknown) => num(v) && v > 1 && v <= 1000;
	if (!factor(dq?.outlierFactorRain)) return 'The rain outlier factor must be above 1 and at most 1000.';
	if (!factor(dq?.outlierFactorFlow)) return 'The flow outlier factor must be above 1 and at most 1000.';
	if (!whole(dq?.flatlineRainDays, 2, 366)) return 'The rain flat stretch must be a whole number of days from 2 to 366.';
	if (!whole(dq?.flatlineEvapDays, 2, 366)) return 'The A-pan flat stretch must be a whole number of days from 2 to 366.';
	if (!whole(dq?.flatlineFlowMinDays, 2, 366)) return 'The shortest flow flat stretch must be a whole number of days from 2 to 366.';
	if (!whole(dq?.flatlineFlowMaxDays, 2, 366)) return 'The longest flow flat stretch must be a whole number of days from 2 to 366.';
	if (dq!.flatlineFlowMaxDays! < dq!.flatlineFlowMinDays!) return 'The longest flow flat stretch can’t be shorter than the shortest.';
	if (!(ZERO_RUN_RULES as readonly unknown[]).includes(dq?.zeroRunRule)) return 'Choose how zero-rain runs are judged.';
	if (!whole(dq?.zeroRunMinWetDays, 1, 366)) return 'Zero-rain runs: the wet-season days must be a whole number from 1 to 366.';
	const share = dq?.zeroRunUsualShare;
	if (!num(share) || !(share > 0 && share <= 1)) return 'Zero-rain runs: the share of the usual annual rain must be above 0 % and at most 100 %.';
	if (!whole(dq?.zeroRunMinDays, 1, 366)) return 'Zero-rain runs: the shortest run must be a whole number of days from 1 to 366.';
	if (typeof dq?.zeroRunChirpsCheck !== 'boolean') return 'Zero-rain runs: the CHIRPS check must be on or off.';
	const ratio = dq?.lowVsChirpsRatio;
	if (!num(ratio) || !(ratio > 0 && ratio < 1)) return 'Low vs CHIRPS: the ratio must be above 0 % and below 100 %.';
	if (!(LOW_VS_CHIRPS_BASELINES as readonly unknown[]).includes(dq?.lowVsChirpsBaseline)) return 'Low vs CHIRPS: choose what the usual ratio is.';
	if (!(LOW_VS_CHIRPS_MINIMUMS as readonly unknown[]).includes(dq?.lowVsChirpsMinimum)) return 'Low vs CHIRPS: choose the CHIRPS minimum.';
	return null;
}

/** The choices of the zero-run rule, for the Settings form. */
export const ZERO_RUN_RULE_OPTIONS: { value: ZeroRunRule; label: string; help: string }[] = [
	{
		value: 'wetDays',
		label: 'Days in the wet season (default)',
		help: 'Flag a run of zero rain with at least this many days in the series’ six wettest calendar months. A dry-season spell never counts.'
	},
	{
		value: 'usualRain',
		label: 'Share of the usual annual rain',
		help: 'Flag a run when the series’ monthly means would have put at least this share of its usual annual rain on its days, and it lasts at least the shortest run. Judges a semi-arid catchment’s runs by the rain they missed, not only their length.'
	}
];

export const LOW_VS_CHIRPS_BASELINE_OPTIONS: { value: LowVsChirpsBaseline; label: string }[] = [
	{ value: 'record', label: 'Median over the whole record (default)' },
	{ value: 'moving', label: 'Moving median of the water years within ±5 years' }
];

export const LOW_VS_CHIRPS_MINIMUM_OPTIONS: { value: LowVsChirpsMinimum; label: string }[] = [
	{ value: 'fixed', label: '50 mm (default)' },
	{ value: 'scaled', label: 'The larger of 50 mm and 25 % of the median annual CHIRPS' }
];

/**
 * The rain-check limits a fit ran under (FitRecord.forcing.rainChecks,
 * engine ≥ 1.20.0), in words. Absent: the fit predates them and ran the
 * defaults, which were engine constants then.
 */
export function describeRainChecks(rc: Partial<RainCheckLimits> | undefined): string {
	const d = rainCheckLimits(defaultDataQualitySettings());
	if (!rc) return `the defaults (fit made before these were settings): ${describeRainChecks(d)}`;
	const r = { ...d, ...rc };
	const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
	const zero =
		r.zeroRunRule === 'usualRain'
			? `zero-rain runs by ${pct(r.zeroRunUsualShare)} of the usual annual rain over ${r.zeroRunMinDays}+ days`
			: `zero-rain runs with ${r.zeroRunMinWetDays}+ wet-season days`;
	const low =
		`low vs CHIRPS below ${pct(r.lowVsChirpsRatio)} of the ${r.lowVsChirpsBaseline === 'moving' ? 'moving (±5 years)' : 'whole-record'} median, ` +
		`${r.lowVsChirpsMinimum === 'scaled' ? 'scaled' : '50 mm'} CHIRPS minimum`;
	const same = RAIN_CHECK_KEYS.every((k) => r[k] === d[k]);
	return `${zero}${r.zeroRunChirpsCheck ? ', checked against CHIRPS' : ''}; ${low}${same ? ' (the defaults)' : ''}`;
}
