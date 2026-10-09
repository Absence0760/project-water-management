// Settings → Flow generation → Rain for each unit (settings.unitRain, issue
// #482, docs/model.md §2.4h, docs/ui.md § Settings & calibration): the switch,
// the catchment gauge's MAP and its source, the MAP period in whole years, and
// the check that blocks Save. The engine's unitRainError is the API's rule;
// this says the same problems in the form's words.
import {
	DEFAULT_UNIT_MAP_PERIOD,
	MAP_MM_MAX,
	MAP_MM_MIN,
	PE_SOURCE_MAX,
	unitRainError,
	type NetworkNode,
	type UnitRainSettings
} from '@water-management/engine';

/** The first year a unit's CHIRPS can cover (rnl, 1981) and the fewest complete years the MAP factor wants before it warns (§2.4h). */
export const UNIT_MAP_FIRST_YEAR = 1981;
export const UNIT_MAP_MIN_YEARS = 5;

/**
 * Switch rain for each unit on (from `previous`, the setting the form had
 * before it was switched off, else per unit with no gauge MAP and the default
 * period) or off (null: the catchment rain, as before; absent, null and
 * `catchment` run the same).
 */
export function withUnitRain(on: boolean, previous?: UnitRainSettings | null): UnitRainSettings | null {
	if (!on) return null;
	if (previous) return { ...previous, mode: 'perUnit', ...(previous.mapPeriod ? { mapPeriod: { ...previous.mapPeriod } } : {}) };
	return { mode: 'perUnit' };
}

export const unitRainOn = (v: UnitRainSettings | null | undefined): v is UnitRainSettings => v?.mode === 'perUnit';

/** The MAP period as whole calendar years (the engine counts complete years inside it), from the stored dates or the default. */
export function mapPeriodYears(v: Partial<UnitRainSettings> | null | undefined): { from: number; to: number } {
	const p = v?.mapPeriod ?? DEFAULT_UNIT_MAP_PERIOD;
	return { from: Number(p.start.slice(0, 4)), to: Number(p.end.slice(0, 4)) };
}

/**
 * The setting with its MAP period set to whole years `from`–`to` (1 Jan to
 * 31 Dec). The default years are stored as none, so a project left on them
 * follows the default.
 */
export function withMapPeriodYears(v: UnitRainSettings, from: number, to: number): UnitRainSettings {
	const start = `${String(from).padStart(4, '0')}-01-01`;
	const end = `${String(to).padStart(4, '0')}-12-31`;
	const { mapPeriod: _p, ...rest } = v;
	if (start === DEFAULT_UNIT_MAP_PERIOD.start && end === DEFAULT_UNIT_MAP_PERIOD.end) return rest;
	return { ...rest, mapPeriod: { start, end } };
}

/** The gauge MAP set (a number, or null to clear it); clearing it clears its source too. */
export function withGaugeMap(v: UnitRainSettings, mm: number | null): UnitRainSettings {
	if (mm === null) {
		const { gaugeMapMm: _m, gaugeMapSource: _s, ...rest } = v;
		return rest;
	}
	return { ...v, gaugeMapMm: mm, gaugeMapSource: v.gaugeMapSource ?? '' };
}

/** The first problem, as the form shows it (and blocks Save on), and the field it is in; null when it can be saved. */
export function unitRainProblem(v: UnitRainSettings | null | undefined): { field: 'gaugeMap' | 'gaugeSource' | 'period'; message: string } | null {
	if (!unitRainOn(v)) {
		const e = unitRainError(v);
		return e ? { field: 'period', message: `Rain for each unit can’t be saved: ${e}.` } : null;
	}
	const mm = v.gaugeMapMm;
	if (mm !== null && mm !== undefined) {
		if (!(Number.isFinite(mm) && mm >= MAP_MM_MIN && mm <= MAP_MM_MAX)) return { field: 'gaugeMap', message: `The rain gauge’s MAP must be ${MAP_MM_MIN} to ${MAP_MM_MAX} mm.` };
		const src = v.gaugeMapSource ?? '';
		if (!src.trim()) return { field: 'gaugeSource', message: 'Say where the rain gauge’s MAP comes from: the source is required (the record or study, and its years).' };
		if (src.length > PE_SOURCE_MAX) return { field: 'gaugeSource', message: `The rain gauge’s MAP source is at most ${PE_SOURCE_MAX} characters; it has ${src.length}.` };
	}
	const { from, to } = mapPeriodYears(v);
	if (!(Number.isInteger(from) && Number.isInteger(to))) return { field: 'period', message: 'The MAP period needs a first and a last year.' };
	if (from > to) return { field: 'period', message: 'The MAP period’s first year must not be after its last.' };
	const e = unitRainError(v);
	return e ? { field: 'period', message: `Rain for each unit can’t be saved: ${e}.` } : null;
}

export const unitRainFormError = (v: UnitRainSettings | null | undefined): string | null => unitRainProblem(v)?.message ?? null;

/** A note (not a blocker) when the MAP period is shorter than the factor wants, or starts before CHIRPS. */
export function mapPeriodNote(v: UnitRainSettings | null | undefined): string | null {
	if (!unitRainOn(v)) return null;
	const { from, to } = mapPeriodYears(v);
	if (from > to) return null;
	if (from < UNIT_MAP_FIRST_YEAR) return `CHIRPS begins in ${UNIT_MAP_FIRST_YEAR}: the years before it add nothing to the MAP factor.`;
	const years = to - from + 1;
	if (years < UNIT_MAP_MIN_YEARS)
		return `${years === 1 ? '1 year' : `${years} years`}: the MAP factor wants at least ${UNIT_MAP_MIN_YEARS} complete years of CHIRPS, so the run uses what there is and warns.`;
	return null;
}

/** "3 of 5 units with land have a MAP": what the switch has to work with, from the model. */
export function unitMapCoverage<N extends Pick<NetworkNode, 'kind' | 'areaKm2' | 'mapMm'>>(nodes: readonly N[]): { land: number; withMap: number; text: string; without: N[] } {
	const land = nodes.filter((n) => n.kind === 'farm' && n.areaKm2 > 0);
	const without = land.filter((n) => n.mapMm === null || n.mapMm === undefined);
	const withMap = land.length - without.length;
	const text = !land.length
		? 'No unit has land yet.'
		: `${withMap} of ${land.length === 1 ? '1 unit' : `${land.length} units`} with land ${withMap === 1 ? 'has' : 'have'} a MAP.`;
	return { land: land.length, withMap, text, without };
}
