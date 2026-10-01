// Words for the nearest-gauging-stations proposal in Settings → Data feeds
// (issue #326 Part B "B-gauge"; docs/ui.md § Data feeds, docs/maps.md §
// Gauging stations). Pure, so the rule each sentence states is unit-tested.
import type { GaugeStationLookup, GaugeStationProposal } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';

/** Which point the stations are measured from, as one sentence (the rule: the outlet gauge on the map, else the boundary's centre). */
export function pointLine(l: GaugeStationLookup): string {
	const within = `within ${fmtNum(l.withinKm, 1, true)} km`;
	const named = (s: string | null) => (s ? ` “${s}”` : '');
	switch (l.pointFrom) {
		case 'outlet_gauge':
			return `River gauges ${within} of the outlet gauge${named(l.pointName)} on the map, nearest first.`;
		case 'boundary_centre':
			return `River gauges ${within} of the centre of the catchment boundary${named(l.pointName)}, nearest first. The outflow gauge has no point on the map; place it there to measure from the outlet instead.`;
		case 'query':
			return `River gauges ${within} of the point, nearest first.`;
		default:
			return 'Put the catchment boundary or the outflow gauge on the map (the Map tab) to see the gauging stations nearest the outlet.';
	}
}

/** "1968–2024 (56 years)", "1931 to now (95.7 years)", or "Record dates not given". */
export function recordText(s: Pick<GaugeStationProposal, 'recordStart' | 'recordEnd' | 'recordYears'>): string {
	if (!s.recordStart) return 'Record dates not given';
	const span = `${s.recordStart.slice(0, 4)}${s.recordEnd ? `–${s.recordEnd.slice(0, 4)}` : ' to now'}`;
	return s.recordYears === null ? span : `${span} (${fmtNum(s.recordYears, 1, true)} ${s.recordYears === 1 ? 'year' : 'years'})`;
}

/** "2.8 km" (one decimal under 10 km, whole kilometres beyond). */
export function distanceText(km: number): string {
	return `${km < 10 ? fmtNum(km, 1, true) : fmtNum(km)} km`;
}

/** Why the list is empty, or null when it isn't. */
export function emptyLine(l: GaugeStationLookup): string | null {
	if (l.stations.length) return null;
	if (!l.datasets.length) return 'No list of gauging stations is loaded on this server, so there is nothing to propose. Type the station code instead.';
	if (!l.point) return null;
	return `No river gauge in the loaded list lies within ${fmtNum(l.withinKm, 1, true)} km. Type the station code instead.`;
}
