// CHIRPS fallback bias correction picker (settings.chirpsBiasCorrection,
// engine ≥ 0.7.0; docs/model.md §2.4b).
import type { ChirpsBiasMode, ZeroRainMode, ZeroRainSettings } from '@water-management/engine';

export const CHIRPS_BIAS_OPTIONS: { value: ChirpsBiasMode; label: string; help: string }[] = [
	{
		value: 'monthly',
		label: 'Bias-corrected per month (default)',
		help: 'Where catchment rain is blank, CHIRPS is scaled by catchment ÷ CHIRPS rain for the calendar month, fitted on the days both have a reading. Each run lists the factors in its warnings.'
	},
	{
		value: 'none',
		label: 'Raw CHIRPS',
		help: 'CHIRPS is used as stored. Only for a CHIRPS series that is already corrected to the catchment; raw CHIRPS can read well below catchment rain.'
	}
];

// Flagged zero-rain runs (settings.zeroRainRuns.mode, engine ≥ 0.15.0;
// docs/model.md §2.4c).
export const ZERO_RAIN_OPTIONS: { value: ZeroRainMode; label: string; help: string }[] = [
	{
		value: 'missing',
		label: 'Treat as missing (default)',
		help: 'Long runs of zero catchment rain in the wet season (the Data tab flags them) count as blank days, so bias-corrected CHIRPS, then forecast rain, fills them. The stored series is not changed, and each run lists what it filled.'
	},
	{
		value: 'asRecorded',
		label: 'Run as recorded (dry)',
		help: 'Flagged zero runs stay 0 mm, as the workbook runs them. Only if every flagged run is a real dry spell; to keep just some of them, list those below as keep-dry instead.'
	}
];

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A zero-rain setting in one line, for fit provenance: "treated as missing; 1 keep-dry period". */
export function describeZeroRain(z: ZeroRainSettings): string {
	const parts = [z.mode === 'missing' ? 'flagged runs treated as missing' : 'flagged runs run as recorded (dry)'];
	if (z.mode === 'missing' && z.keepDry.length) parts.push(count(z.keepDry.length, 'keep-dry period'));
	if (z.missing.length) parts.push(count(z.missing.length, 'extra missing period'));
	return parts.join('; ');
}
