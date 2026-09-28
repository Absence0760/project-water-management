// The Settings form's areal rainfall correction (settings.arealRain, engine ≥
// 1.13.0, docs/model.md §2.4g): switching it on and off, filling one factor
// into every month, and the check that blocks Save.
import { AREAL_RAIN_FACTOR_MAX, AREAL_RAIN_FACTOR_MIN, PE_SOURCE_MAX, type ArealRain, type ArealRainMethod, type ProjectSettings } from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';

/** The form's mutable copy (the engine's `Monthly` is a readonly tuple). */
export type EditableArealRain = { factors: number[]; method: ArealRainMethod; source: string };

export const AREAL_METHOD_OPTIONS: { value: ArealRainMethod; label: string; hint: string }[] = [
	{ value: 'map', label: 'Independent MAP', hint: 'The catchment’s MAP (WR2012, an isohyetal or gridded MAP) ÷ the forcing’s mean annual rain.' },
	{ value: 'stations', label: 'Rain gauges', hint: 'Ratios against rain gauges in or near the catchment.' },
	{ value: 'fitted', label: 'Fitted to the flow record', hint: 'A calibrated multiplier: it trades off against X1 and the evaporation, and every run warns.' }
];

/**
 * Switch the correction on (from `previous`, a correction the form had before
 * switching it off, else × 1 in every month with the source blank, so the
 * form won't save until it is written) or off (null).
 */
export function withArealRain(on: boolean, previous?: EditableArealRain | null): EditableArealRain | null {
	if (!on) return null;
	if (previous) return { factors: [...previous.factors], method: previous.method, source: previous.source };
	return { factors: new Array(12).fill(1), method: 'map', source: '' };
}

/** The form's copy as the settings hold it (the engine's `Monthly` is a 12-tuple; the form keeps 12). */
export const storedArealRain = (a: EditableArealRain | null): ProjectSettings['arealRain'] => a as unknown as ProjectSettings['arealRain'];

/** One factor in every month (a MAP gives one annual ratio, nothing about the seasons). */
export const withFactorEveryMonth = (a: EditableArealRain, factor: number): EditableArealRain => ({ ...a, factors: new Array(12).fill(factor) });

/** The one factor when every month has the same, else null. */
export const flatFactor = (a: Pick<ArealRain | EditableArealRain, 'factors'>): number | null =>
	a.factors.every((f) => f === a.factors[0]) ? (a.factors[0] ?? null) : null;

/** The first problem with the correction, as the form shows it (and blocks Save on), or null. */
export function arealRainFormError(a: ArealRain | EditableArealRain | null | undefined): string | null {
	if (!a) return null;
	if (a.factors.length !== 12) return `The areal rainfall correction needs 12 factors, Oct to Sep; it has ${a.factors.length}.`;
	const bad = a.factors.flatMap((v, i) =>
		typeof v === 'number' && Number.isFinite(v) && v >= AREAL_RAIN_FACTOR_MIN && v <= AREAL_RAIN_FACTOR_MAX ? [] : [WATER_YEAR_MONTHS[i]]
	);
	if (bad.length) return `Areal rainfall factors must be ${AREAL_RAIN_FACTOR_MIN} to ${AREAL_RAIN_FACTOR_MAX}: check ${bad.join(', ')}.`;
	if (!a.source.trim()) return 'Say where the areal rainfall factors come from: the source is required (the MAP and its reference, and the years compared).';
	if (a.source.length > PE_SOURCE_MAX) return `The areal rainfall source is at most ${PE_SOURCE_MAX} characters; it has ${a.source.length}.`;
	return null;
}
