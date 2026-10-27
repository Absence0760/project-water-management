// Settings → Model selection for flow generation (flowGeneration.ts, issue #553 round 3): the
// method from settings.unitRain, the Per unit table's rows and their writes
// into settings.rainStations (a fit made under the other method is the
// engine's FitRecordStatus.methodChanged, tested in stationForcing.test.ts). The
// guard that nothing is migrated: a stored setting the form doesn't touch
// comes back as it was, and assigning a station and taking it away again
// stores what there was (none). The browser flow is pinned by
// e2e/tests/flow-generation.spec.ts.
import { describe, expect, it } from 'vitest';
import type { RainStationSettings } from '@water-management/engine';
import {
	assignmentLine,
	FLOW_METHODS,
	flowMethodOf,
	methodLabel,
	landUnits,
	namesLine,
	stationOptions,
	stationsInUse,
	tidyStations,
	unitRatio,
	unitStationRows,
	withStationSite,
	withUnitCorrectAgainst,
	withUnitScale,
	withUnitStation,
	withUnitsStation,
	type StationOption
} from './flowGeneration';

const unit = (id: string, mapMm: number | null, areaKm2 = 5) => ({ id, name: `Unit ${id}`, kind: 'farm' as const, areaKm2, mapMm, mapSource: mapMm === null ? null : 'invented grid' });
const nodes = [unit('a', 900), unit('b', 600), unit('c', null), { id: 'g', name: 'Gauge', kind: 'gauge' as const, areaKm2: 0, mapMm: null, mapSource: null }, unit('d', 700, 0)];
const station = (id: string, mapMm: number | null, place = false): StationOption => ({ id, name: `Station ${id}`, station: { mapMm, mapSource: mapMm === null ? null : 'its record', lat: place ? -33.9 : null, lon: place ? 18.9 : null } });
const S = station('s', 600);
const T = station('t', 500, true);
const U = station('u', null);

describe('the method', () => {
	it('is Per unit for perUnit and Fragmentation otherwise, as runs read settings.unitRain', () => {
		expect([undefined, null, { mode: 'catchment' }, { mode: 'perUnit' }, { mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'x' }].map(flowMethodOf)).toEqual([
			'fragmentation',
			'fragmentation',
			'fragmentation',
			'perUnit',
			'perUnit'
		]);
	});
});

describe('the methods’ words (issue #586 E14)', () => {
	it('keep the names the engine’s messages use, each with plain words of what it does, no model jargon', () => {
		// The fit record and the engine's "fitted under …" message name the methods by these.
		expect(FLOW_METHODS.map((m) => m.label)).toEqual(['Fragmentation', 'Per unit']);
		expect(methodLabel('perUnit')).toBe('Per unit');
		for (const m of FLOW_METHODS) {
			expect(m.short.length, m.value).toBeGreaterThan(0);
			// Short enough to sit on the name's line at 1440, and lower case after it.
			expect(m.short.length, m.value).toBeLessThanOrEqual(70);
			expect(m.short, m.value).toMatch(/^[a-z]/);
			// Plain words: no model or method name in them (GR4J, the other method's name).
			expect(m.short, m.value).not.toMatch(/GR4J|Fragmentation|Per unit/);
		}
		expect(new Set(FLOW_METHODS.map((m) => m.short)).size).toBe(FLOW_METHODS.length);
	});
});

describe('the stations', () => {
	it('are the catchment rain series without a site, by name; a unit’s own gauge and other kinds are not', () => {
		const list = stationOptions([
			{ id: '2', name: 'Vlei', kind: 'rain_catchment_mm', station: null },
			{ id: '1', name: 'Ridge', kind: 'rain_catchment_mm', station: { mapMm: 820, mapSource: 'r', lat: null, lon: null } },
			{ id: '3', name: 'Own gauge', kind: 'rain_catchment_mm', siteNodeId: 'a', station: null },
			{ id: '4', name: 'Flow', kind: 'flow_observed_m3s', station: null }
		]);
		expect(list.map((s) => s.name)).toEqual(['Ridge', 'Vlei']);
		expect(list[0]).toEqual({ id: '1', name: 'Ridge', station: { mapMm: 820, mapSource: 'r', lat: null, lon: null } });
	});
});

describe('the Per unit table', () => {
	it('lists the land units only (a farm with an area), in the model’s order', () => {
		expect(landUnits(nodes).map((n) => n.id)).toEqual(['a', 'b', 'c']);
		expect(unitStationRows(nodes, null, [S]).map((r) => [r.unit.id, r.assignment, r.station])).toEqual([
			['a', null, null],
			['b', null, null],
			['c', null, null]
		]);
		expect(assignmentLine(unitStationRows(nodes, null, [S]))).toBe('0 of 3 units with land have a rainfall station.');
		expect(assignmentLine([])).toMatch(/^No unit has land yet/);
	});

	it('gives each assigned unit its ratio (unit MAP ÷ station MAP, clamped 0.25–4), × 1 without scaling or a MAP, and says why', () => {
		const rs: RainStationSettings = { units: { a: { stationId: 's' }, b: { stationId: 's', scaleToMap: false }, c: { stationId: 't' } } };
		const rows = unitStationRows(nodes, rs, [S, T]);
		expect(rows[0]).toMatchObject({ scale: true, correctAgainst: 's', ratio: { ratio: 1.5, own: 1.5, clamped: false, outsideBand: false }, noRatioWhy: null });
		expect(rows[1]).toMatchObject({ scale: false, ratio: { ratio: 1, own: null }, noRatioWhy: null });
		expect(rows[2]).toMatchObject({ station: T, ratio: { ratio: 1 }, noRatioWhy: 'the unit has no MAP' });
		expect(unitStationRows([unit('a', 900)], { units: { a: { stationId: 'u' } } }, [U])[0]!.noRatioWhy).toBe('the station has no MAP');
		expect(assignmentLine(rows)).toBe('3 of 3 units with land have a rainfall station.');
		expect(unitRatio(3000, 500, true)).toEqual({ ratio: 4, own: 6, clamped: true, outsideBand: true });
		expect(unitRatio(100, 600, true)).toMatchObject({ ratio: 0.25, clamped: true });
		expect(unitRatio(1300, 600, true)).toMatchObject({ clamped: false, outsideBand: true });
	});

	it('flags a station the project no longer has, keeping its id, so the select can say so', () => {
		const rows = unitStationRows(nodes, { units: { a: { stationId: 'gone' } } }, [S]);
		expect(rows[0]).toMatchObject({ missing: true, station: null, assignment: { stationId: 'gone' } });
		expect(rows[1]!.missing).toBe(false);
	});

	it('lists each station in use once, with the units it runs and those it corrects', () => {
		const rs: RainStationSettings = { units: { a: { stationId: 's' }, b: { stationId: 's', correctAgainst: 't' }, c: { stationId: 's' } } };
		const used = stationsInUse(unitStationRows(nodes, rs, [S, T, U]), [S, T, U]);
		expect(used.map((u) => [u.station.id, u.units, u.corrects])).toEqual([
			['s', ['Unit a', 'Unit b', 'Unit c'], ['Unit a', 'Unit c']],
			['t', [], ['Unit b']]
		]);
		expect(namesLine(['A'])).toBe('A');
		expect(namesLine(['A', 'B', 'C'])).toBe('A, B and C');
		expect(namesLine(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D and 2 more');
	});
});

describe('writing settings.rainStations', () => {
	it('assigns, reassigns and clears a unit’s station, keeping its scaling and correcting station on a reassignment', () => {
		let rs = withUnitStation(null, 'a', 's');
		expect(rs).toEqual({ units: { a: { stationId: 's' } } });
		rs = withUnitScale(rs, 'a', false);
		rs = withUnitCorrectAgainst(rs, 'a', 't');
		expect(rs).toEqual({ units: { a: { stationId: 's', scaleToMap: false, correctAgainst: 't' } } });
		rs = withUnitStation(rs, 'a', 'u');
		expect(rs).toEqual({ units: { a: { stationId: 'u', scaleToMap: false, correctAgainst: 't' } } });
		// Scaling is the default and the unit's own station the default correction: both stored as none.
		rs = withUnitScale(rs, 'a', true);
		rs = withUnitCorrectAgainst(rs, 'a', 'u');
		expect(rs).toEqual({ units: { a: { stationId: 'u' } } });
		expect(withUnitCorrectAgainst(rs, 'a', null)).toEqual({ units: { a: { stationId: 'u' } } });
	});

	it('assigning and taking it away again stores what there was: none (the run as before)', () => {
		expect(withUnitStation(withUnitStation(null, 'a', 's'), 'a', '')).toBeNull();
		expect(withUnitStation(withUnitStation(undefined, 'a', 's'), 'a', null)).toBeNull();
	});

	it('keeps every other part of a stored setting as it was (nothing migrated)', () => {
		const stored: RainStationSettings = {
			catchment: { stationId: 't', scaleToMap: false },
			units: { b: { stationId: 't' } },
			catchmentMapMm: 700,
			catchmentMapSource: 'a study',
			sites: { s: { unitId: 'b' } },
			unreliable: { s: [['2012-01-01', '2012-01-31']] }
		};
		const before = structuredClone(stored);
		const next = withUnitStation(withUnitStation(stored, 'a', 's'), 'a', null);
		expect(next).toEqual(before);
		expect(stored).toEqual(before); // never mutated
		expect(withUnitScale(stored, 'nobody', false)).toBe(stored);
		expect(withUnitCorrectAgainst(stored, 'nobody', 's')).toBe(stored);
	});

	it('sets one station for every ticked unit, or clears them', () => {
		const rs = withUnitsStation({ units: { a: { stationId: 't', scaleToMap: false } } }, ['a', 'b', 'c'], 's');
		expect(rs).toEqual({ units: { a: { stationId: 's', scaleToMap: false }, b: { stationId: 's' }, c: { stationId: 's' } } });
		expect(withUnitsStation(rs, ['a', 'b', 'c'], null)).toBeNull();
		expect(withUnitsStation(null, [], 's')).toBeNull();
	});

	it('sets and clears the unit a station without coordinates stands in', () => {
		const rs = withStationSite({ units: { a: { stationId: 's' } } }, 's', 'b');
		expect(rs).toEqual({ units: { a: { stationId: 's' } }, sites: { s: { unitId: 'b' } } });
		expect(withStationSite(rs, 's', null)).toEqual({ units: { a: { stationId: 's' } } });
		expect(withStationSite(null, 's', '')).toBeNull();
	});

	it('tidies an emptied setting to null, keeping any part still set', () => {
		expect(tidyStations({ units: {}, sites: {}, unreliable: {}, catchment: null, catchmentMapMm: null })).toBeNull();
		expect(tidyStations({ units: {}, catchmentMapMm: 650, catchmentMapSource: 'x' })).toEqual({ catchmentMapMm: 650, catchmentMapSource: 'x' });
	});
});
