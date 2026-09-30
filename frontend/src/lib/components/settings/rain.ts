// CHIRPS fallback bias correction picker (settings.chirpsBiasCorrection,
// engine ≥ 0.7.0; docs/model.md §2.4b).
import { QM_WET_DAY_MM_DEFAULT, resolveChirpsFitPeriod, type AccumulationMode, type ChirpsBiasMode, type ChirpsFitRange, type ChirpsQuantileMap, type ZeroRainMode, type ZeroRainSettings } from '@water-management/engine';

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

// The CHIRPS gap map (settings.chirpsQuantileMap, engine ≥ 1.53.0, CR-23;
// docs/model.md §2.4b *Quantile map*): off (null) by default. Turning it on
// starts from the threshold it was turned off with, else the default.
export function withChirpsQuantileMap(on: boolean, last: ChirpsQuantileMap | null): ChirpsQuantileMap | null {
	return on ? { wetDayMm: last?.wetDayMm ?? QM_WET_DAY_MM_DEFAULT } : null;
}

// Which part of the record the CHIRPS factors are fitted on
// (settings.chirpsFitPeriod, engine ≥ 0.29.0, issue #40; docs/model.md §2.4b).
// 'ranges' stands for a list of water-year ranges in the picker. There is no
// automatic mode: the double-mass breaks only propose ranges to confirm.
export type ChirpsFitChoice = 'all' | 'ranges';
export const CHIRPS_FIT_OPTIONS: { value: ChirpsFitChoice; label: string; help: string }[] = [
	{
		value: 'all',
		label: 'Whole record (default)',
		help: 'One set of monthly factors fitted over every year. When the Data tab’s double-mass check finds a break, a gap in one era is filled with a blend of every era’s catchment ÷ CHIRPS ratio.'
	},
	{
		value: 'ranges',
		label: 'Listed water years',
		help: 'One set of factors per range, each fitted only on its own years; years outside every range stay out of every fit, and a gap there takes the nearest range’s factors. Put each break where the station records or the CHIRPS version say it is. “Propose from the double-mass breaks” fills the list from the check, but its break years are estimates that can be a year or two off, and a CHIRPS change moves them too: check each range, and its reason, before saving.'
	}
];
export const chirpsFitChoice = (v: unknown): ChirpsFitChoice => (Array.isArray(v) ? 'ranges' : 'all');

/** Why a list of CHIRPS fit ranges can't be saved, or null: the engine's rules (each a real range with a reason, none overlapping), one message. */
export function chirpsFitRangesError(list: ChirpsFitRange[]): string | null {
	if (!list.length) return 'List at least one water-year range, or fit on the whole record';
	for (const [i, r] of list.entries()) {
		const n = `Fit range ${i + 1}`;
		if (!Number.isInteger(r.fromWaterYear) || !Number.isInteger(r.toWaterYear)) return `${n}: enter both water years`;
		if (r.fromWaterYear > r.toWaterYear) return `${n}: ends before it starts`;
		if (!r.reason.trim()) return `${n}: needs a reason`;
	}
	const w: string[] = [];
	const kept = resolveChirpsFitPeriod(list, w);
	if (Array.isArray(kept) && kept.length === list.length && !w.length) return null;
	const clash = w.find((x) => x.includes('overlaps'));
	return clash ? `Fit ranges overlap: ${clash.replace(/^CHIRPS fit range /, '').replace(/; ignored$/, '')}` : (w[0] ?? 'Invalid fit ranges');
}

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

// Multi-day accumulations (settings.zeroRainRuns.accumulationMode, engine ≥
// 0.20.0; docs/model.md §2.4d).
export const ACCUMULATION_OPTIONS: { value: AccumulationMode; label: string; help: string }[] = [
	{
		value: 'spread',
		label: 'Spread over the days they cover (default)',
		help: 'A large reading after days of 0 or blank, on a day CHIRPS was dry although it rained over those days, looks like several days read at once. The recorded total is kept and spread over the days in proportion to bias-corrected CHIRPS, instead of all on one day. The stored series is not changed, and each run lists what it spread.'
	},
	{
		value: 'asRecorded',
		label: 'Run as recorded (one day)',
		help: 'Each reading stays on its day, as the workbook runs it. The days before it stay 0, or are filled from CHIRPS when they are part of a flagged zero run, so that rain is counted twice. To keep only some readings as recorded, list them below instead.'
	}
];

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * A zero-rain setting in one line, for fit provenance: "treated as missing;
 * 1 keep-dry period; accumulations spread". A setting saved before engine
 * 0.20.0 has no accumulation mode: it ran them as recorded.
 */
export function describeZeroRain(z: Partial<ZeroRainSettings> & Pick<ZeroRainSettings, 'mode' | 'keepDry' | 'missing'>): string {
	const parts = [z.mode === 'missing' ? 'flagged runs treated as missing' : 'flagged runs run as recorded (dry)'];
	if (z.mode === 'missing' && z.keepDry.length) parts.push(count(z.keepDry.length, 'keep-dry period'));
	if (z.missing.length) parts.push(count(z.missing.length, 'extra missing period'));
	const spread = z.accumulationMode === 'spread';
	parts.push(spread ? 'accumulations spread' : 'accumulations as recorded');
	if (spread && z.keepReadings?.length) parts.push(count(z.keepReadings.length, 'reading kept as recorded'));
	if (z.addAccumulations?.length) parts.push(count(z.addAccumulations.length, 'listed accumulation'));
	return parts.join('; ');
}
