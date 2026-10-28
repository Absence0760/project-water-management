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
	patchAdd,
	patchFromValues,
	patchMove,
	patchOf,
	patchRemove,
	patchSet,
	patchUsabilityText,
	patchValues,
	stationOptions,
	stationsInUse,
	tidyStations,
	unitRatio,
	unitStationRows,
	unitsOnCatchmentRain,
	withStationSite,
	withUnitCorrectAgainst,
	withUnitPatch,
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
		// A station only patching a unit's gaps is in use too (issue #612).
		const patched = stationsInUse(unitStationRows(nodes, { units: { a: { stationId: 's', patch: [{ source: 'station', stationId: 'u' }, { source: 'chirps' }] } } }, [S, T, U]), [S, T, U]);
		expect(patched.map((u) => [u.station.id, u.patches])).toEqual([
			['s', []],
			['u', ['Unit a']]
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

	it('sets a unit’s patching priority (issue #612): the default [CHIRPS] stored as none, its own station never in it', () => {
		const base: RainStationSettings = { units: { a: { stationId: 's', scaleToMap: false } } };
		const chain = patchFromValues(['t', 'chirps']);
		const rs = withUnitPatch(base, 'a', chain);
		expect(rs).toEqual({ units: { a: { stationId: 's', scaleToMap: false, patch: [{ source: 'station', stationId: 't' }, { source: 'chirps' }] } } });
		expect(unitStationRows(nodes, rs, [S, T, U])[0]!.patch).toEqual(['t', 'chirps']);
		expect(withUnitPatch(rs, 'a', [{ source: 'chirps' }])).toEqual(base);
		expect(withUnitPatch(base, 'a', [])).toEqual({ units: { a: { stationId: 's', scaleToMap: false, patch: [] } } });
		expect(withUnitPatch(base, 'a', patchFromValues(['s', 't']))!.units!.a!.patch).toEqual([{ source: 'station', stationId: 't' }]);
		expect(withUnitPatch(base, 'nobody', chain)).toBe(base);
		// A unit's new main station leaves its patching priority; the others stay.
		expect(withUnitStation(rs, 'a', 't')!.units!.a).toEqual({ stationId: 't', scaleToMap: false });
		expect(withUnitStation(rs, 'a', 'u')!.units!.a).toEqual({ stationId: 'u', scaleToMap: false, patch: [{ source: 'station', stationId: 't' }, { source: 'chirps' }] });
	});

	it('the bulk action gives every ticked unit the same chain, without its own station', () => {
		const rs = withUnitsStation(null, ['a', 'b'], 's', patchFromValues(['t', 's', 'chirps']));
		expect(rs).toEqual({ units: { a: { stationId: 's', patch: [{ source: 'station', stationId: 't' }, { source: 'chirps' }] }, b: { stationId: 's', patch: [{ source: 'station', stationId: 't' }, { source: 'chirps' }] } } });
		expect(withUnitsStation(rs, ['a'], 's', [{ source: 'chirps' }])!.units!.a).toEqual({ stationId: 's' });
	});

	it('edits the list: set (no source twice), move, remove, add the next free station, then CHIRPS', () => {
		expect(patchOf(undefined)).toEqual([{ source: 'chirps' }]);
		expect(patchValues(patchOf({ patch: [{ source: 'station', stationId: 't' }] }))).toEqual(['t']);
		expect(patchSet(['t', 'chirps'], 0, 'u')).toEqual(['u', 'chirps']);
		expect(patchSet(['t', 'chirps', 'u'], 0, 'u')).toEqual(['u', 'chirps']);
		expect(patchMove(['t', 'chirps', 'u'], 2, -1)).toEqual(['t', 'u', 'chirps']);
		expect(patchMove(['t', 'chirps'], 0, -1)).toEqual(['t', 'chirps']);
		expect(patchMove(['t', 'chirps'], 1, 1)).toEqual(['t', 'chirps']);
		expect(patchRemove(['t', 'chirps'], 0)).toEqual(['chirps']);
		expect(patchAdd(['chirps'], [S, T, U], 's')).toEqual(['chirps', 't']);
		expect(patchAdd(['chirps'], [S, T, U], 's', (id) => id === 'u')).toEqual(['chirps', 'u']);
		expect(patchAdd(['t', 'u'], [S, T, U], 's')).toEqual(['t', 'u', 'chirps']);
		expect(patchAdd(['t', 'u', 'chirps'], [S, T, U], 's')).toBeNull();
		expect(patchAdd(Array.from({ length: 8 }, (_, i) => `x${i}`), [S, T, U], 's')).toBeNull();
	});

	it('says what a patch station fills, or why it can’t help, always with the counts', () => {
		expect(patchUsabilityText({ usable: true, reason: null, gapDays: 52, fills: 40, from: '1990-01-01', to: '2004-12-31' })).toBe('fills 40 of the main station’s 52 gap days (77 %); record 1990-01-01 to 2004-12-31');
		expect(patchUsabilityText({ usable: false, reason: 'it has no reading on any of the main station’s 52 gap days in the run window', gapDays: 52, fills: 0, from: '2010-01-01', to: '2011-12-31' })).toBe(
			'can’t help: it has no reading on any of the main station’s 52 gap days in the run window; record 2010-01-01 to 2011-12-31'
		);
		expect(patchUsabilityText({ usable: false, reason: 'it has no MAP to scale its rain to the unit’s MAP', gapDays: 52, fills: 30, from: null, to: null })).toBe(
			'can’t help: it has no MAP to scale its rain to the unit’s MAP; fills 30 of the main station’s 52 gap days (58 %)'
		);
	});

	it('tidies an emptied setting to null, keeping any part still set', () => {
		expect(tidyStations({ units: {}, sites: {}, unreliable: {}, catchment: null, catchmentMapMm: null })).toBeNull();
		expect(tidyStations({ units: {}, catchmentMapMm: 650, catchmentMapSource: 'x' })).toEqual({ catchmentMapMm: 650, catchmentMapSource: 'x' });
	});
});

describe('the units on the catchment rain (issue #615)', () => {
	const rain = (kind: string, siteNodeId: string | null = null, mapMm: number | null = null) => ({ kind, siteNodeId, station: { mapMm } });
	it('names each land unit with no station, no record of its own and no MAP to scale a gauge with a MAP by', () => {
		// a has a MAP, b a MAP, c none; d has no land. No gauge MAP: a MAP alone doesn't give a unit rain of its own.
		expect(unitsOnCatchmentRain(nodes, {}, [rain('rain_catchment_mm')]).map((n) => n.id)).toEqual(['a', 'b', 'c']);
		// The catchment station's MAP (or a gauge MAP in the settings) makes a unit with a MAP run on gauge × MAP ratio.
		expect(unitsOnCatchmentRain(nodes, {}, [rain('rain_catchment_mm', null, 600)]).map((n) => n.id)).toEqual(['c']);
		expect(unitsOnCatchmentRain(nodes, { unitRain: { gaugeMapMm: 640 } }, [rain('rain_catchment_mm')]).map((n) => n.id)).toEqual(['c']);
		// Without a catchment gauge there is nothing to scale.
		expect(unitsOnCatchmentRain(nodes, { unitRain: { gaugeMapMm: 640 } }, []).map((n) => n.id)).toEqual(['a', 'b', 'c']);
		// A station, or a gauge or CHIRPS series of its own.
		const series = [rain('rain_catchment_mm'), rain('rain_chirps_mm', 'b'), rain('rain_catchment_mm', 'c')];
		expect(unitsOnCatchmentRain(nodes, { rainStations: { units: { a: { stationId: 's' } } } }, series)).toEqual([]);
	});
});
