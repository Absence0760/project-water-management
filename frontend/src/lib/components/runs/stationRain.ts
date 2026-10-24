// Runs & results → Rain for each unit, its rainfall stations (issue #553,
// docs/ui.md § Runs & results, docs/model.md §2.4i): which station forced the
// catchment and each land unit, both MAPs and the ratio, the days by source,
// and each station's CHIRPS pairing, as summary.stations reports them (engine
// ≥ 1.91.0). Read defensively: a run from before it has none. The report's
// inputs (report/inputs.ts) word them with the same helpers.
import { AREAL_RAIN_FACTOR_MAX, AREAL_RAIN_FACTOR_MIN, type RainStationSummary, type StationAreaForcing, type StationPairingFit } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

export type StationsResult = RainStationSummary;

/** summary.stations when the run has it (engine ≥ 1.91.0, settings.rainStations assigned an area); null otherwise. */
export function stationsOf(summary: unknown): StationsResult | null {
	// A stored summary is JSON from whichever engine made the run: checked, not trusted to the type.
	const s = (summary as { stations?: unknown } | null | undefined)?.stations as Partial<StationsResult> | null | undefined;
	if (!s || typeof s !== 'object' || !Array.isArray(s.units) || !Array.isArray(s.pairings)) return null;
	if (!s.catchment && !s.units.length) return null;
	return s as StationsResult;
}

/** The catchment first, then the units in the run's farm order (summary.farms); a unit it doesn't name goes last. */
export function stationAreas(s: Pick<StationsResult, 'catchment' | 'units'>, order: readonly string[] = []): StationAreaForcing[] {
	const at = new Map(order.map((id, i) => [id, i]));
	const units = s.units
		.map((u, i) => ({ u, i: at.get(u.nodeId ?? '') ?? order.length + i }))
		.sort((a, b) => a.i - b.i)
		.map((x) => x.u);
	return s.catchment ? [s.catchment, ...units] : units;
}

/** "× 1.16 (863 ÷ 745 mm)", "× 1, not scaled to MAP", or "× 1, no MAP for the unit" (a missing MAP leaves the station's rain as it is). */
export function ratioText(a: Pick<StationAreaForcing, 'ratio' | 'ownRatio' | 'scaleToMap' | 'areaMapMm' | 'stationMapMm' | 'nodeId'>): string {
	if (!a.scaleToMap) return '× 1, not scaled to MAP';
	if (a.ownRatio === null || a.areaMapMm === null || a.stationMapMm === null) {
		const missing = a.stationMapMm === null ? 'the station' : a.nodeId === null ? 'the catchment' : 'the unit';
		return `× 1, no MAP for ${missing}`;
	}
	return `× ${fmtNum(a.ratio, 2, true)} (${fmtNum(a.areaMapMm)} ÷ ${fmtNum(a.stationMapMm)} mm)`;
}

/** Where a pairing read the CHIRPS at its station: its own cell, or the CHIRPS of the unit it stands in. */
export function chirpsAtText(p: Pick<StationPairingFit, 'chirpsAt'>): string {
	return 'unitId' in p.chirpsAt ? `the CHIRPS of ${p.chirpsAt.unitName || p.chirpsAt.unitId}` : 'its own CHIRPS cell';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A pairing's 12 factors in words ("Jan 1.20, Feb 1, …"), or why it was refused. */
export function pairingFactorsText(p: Pick<StationPairingFit, 'refused' | 'months'>): string {
	if (p.refused !== null) return `refused: ${p.refused}`;
	return p.months.map((m) => `${MONTHS[m.month - 1]} ${fmtNum(m.factor, 2, true)}`).join(', ');
}

/** "1995-01-01 to 2020-12-31 (26 complete years)", or "–" without a shared day. */
export function pairingPeriodText(p: Pick<StationPairingFit, 'fitFrom' | 'fitTo' | 'commonYears'>): string {
	if (!p.fitFrom || !p.fitTo) return '–';
	return `${p.fitFrom} to ${p.fitTo} (${p.commonYears === 1 ? '1 complete year' : `${fmtNum(p.commonYears)} complete years`})`;
}

/** The name of the station whose pairing corrects an area's CHIRPS, or null when none does. */
export function correctedByName(s: Pick<StationsResult, 'pairings'>, a: Pick<StationAreaForcing, 'correctedBy'>): string | null {
	if (a.correctedBy === null) return null;
	return s.pairings.find((p) => p.stationId === a.correctedBy)?.stationName ?? a.correctedBy;
}

/** "the units’ area-weighted mean" or "entered", for the catchment MAP's line. */
export function catchmentMapText(s: Pick<StationsResult, 'catchmentMapMm' | 'catchmentMapFromUnits'>): string | null {
	if (s.catchmentMapMm === null) return null;
	return `${fmtNum(s.catchmentMapMm)} mm (${s.catchmentMapFromUnits ? 'the units’ area-weighted mean' : 'entered'})`;
}

/**
 * What the hydrologist should look at, in words: refused pairings, a ratio
 * held at its bound, an area whose ratio is 1 for want of a MAP, and an area
 * whose gap days had no corrected CHIRPS (they fell to the next fallback).
 */
export function stationNotes(s: Pick<StationsResult, 'pairings' | 'catchment' | 'units'>): string[] {
	const out: string[] = [];
	for (const p of s.pairings) if (p.refused !== null) out.push(`${p.stationName}: its CHIRPS pairing was refused (${p.refused}), so the areas it corrects fill their gaps from the next fallback.`);
	for (const a of stationAreas(s)) {
		if (a.clamped) out.push(`${a.name}: the MAP ratio ${fmtNum(a.ownRatio, 2, true)} was held at the ${AREAL_RAIN_FACTOR_MIN}–${AREAL_RAIN_FACTOR_MAX} bound; check its MAP and ${a.stationName}’s.`);
		else if (a.scaleToMap && a.ownRatio === null) out.push(`${a.name}: ${ratioText(a).slice(5)}, so ${a.stationName}’s rain is used as recorded.`);
		if (a.correctedBy === null && a.days.fallback > 0)
			out.push(`${a.name}: no CHIRPS pairing corrects its gaps, so ${a.days.fallback === 1 ? '1 day comes' : `${fmtNum(a.days.fallback)} days come`} from the next fallback (${a.nodeId === null ? 'the forecast rain' : 'the catchment rain'}).`);
	}
	return out;
}
