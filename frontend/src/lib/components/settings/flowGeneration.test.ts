// Settings → Flow generation (flowGeneration.ts, issue #553 round 3): the
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
	catchmentMapFormError,
	catchmentMapReadout,
	FLOW_METHOD,
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
	withCatchmentMap,
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

describe('the method’s words (issue #586 E14, issue #658)', () => {
	it('names Per unit, the only method, with plain words of what it does, no model jargon', () => {
		expect(FLOW_METHOD.label).toBe('Per unit');
		// Short enough to sit on the name's line at 1440, and lower case after it.
		expect(FLOW_METHOD.short.length).toBeGreaterThan(0);
		expect(FLOW_METHOD.short.length).toBeLessThanOrEqual(70);
		expect(FLOW_METHOD.short).toMatch(/^[a-z]/);
		expect(FLOW_METHOD.short).not.toMatch(/GR4J|Fragmentation|Per unit/);
		// No choice left: the help never offers the retired method.
		expect(FLOW_METHOD.help).not.toMatch(/Fragmentation/);
		expect(FLOW_METHOD.help).toMatch(/Run readiness/);
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
		expect(patchUsabilityText({ usable: false, reason: 'it has no MAP to scale its rain by', gapDays: 52, fills: 30, from: null, to: null })).toBe(
			'can’t help: it has no MAP to scale its rain by; fills 30 of the main station’s 52 gap days (58 %)'
		);
	});

	it('says which days the gaps are counted over, and that a forecast tail is left out (issue #612)', () => {
		const w = { windowFrom: '2015-01-01', windowTo: '2020-12-31' };
		expect(patchUsabilityText({ usable: true, reason: null, gapDays: 52, fills: 40, from: '1990-01-01', to: '2004-12-31', ...w, forecastDays: 30 })).toBe(
			'fills 40 of the main station’s 52 gap days (77 %); gaps counted 2015-01-01 to 2020-12-31, the run’s 30 forecast days left out; record 1990-01-01 to 2004-12-31'
		);
		expect(patchUsabilityText({ usable: true, reason: null, gapDays: 1, fills: 1, from: null, to: null, ...w, forecastDays: 0 })).toBe('fills 1 of the main station’s 1 gap day (100 %); gaps counted 2015-01-01 to 2020-12-31');
		expect(patchUsabilityText({ usable: false, reason: 'it has no reading on any of the main station’s 3 gap days before the forecast', gapDays: 3, fills: 0, from: null, to: null, ...w, forecastDays: 1 })).toBe(
			'can’t help: it has no reading on any of the main station’s 3 gap days before the forecast; gaps counted 2015-01-01 to 2020-12-31, the run’s 1 forecast day left out'
		);
		expect(patchUsabilityText({ usable: false, reason: 'the main station has no gap before the forecast', gapDays: 0, fills: 0, from: null, to: null, forecastDays: 4 })).toBe(
			'can’t help: the main station has no gap before the forecast; the run’s 4 forecast days left out'
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

describe('the catchment MAP (issue #612 follow-up)', () => {
	const mapped = [unit('a', 900, 10), unit('b', 600, 6)];
	const mean = (900 * 10 + 600 * 6) / 16;

	it('stores a MAP with its source, trims the source, and stores none when both are cleared', () => {
		const rs: RainStationSettings = { catchment: { stationId: 's' } };
		const set = withCatchmentMap(rs, 700, '  an invented study  ');
		expect(set).toEqual({ catchment: { stationId: 's' }, catchmentMapMm: 700, catchmentMapSource: 'an invented study' });
		// Cleared: the pair goes, so the engine takes the units' mean again, and the rest of the setting is untouched.
		expect(withCatchmentMap(set, null, '')).toEqual(rs);
		// A setting with nothing else in it tidies to none.
		expect(withCatchmentMap({ catchmentMapMm: 700, catchmentMapSource: 'x' }, null, null)).toBeNull();
		// Half entered is kept as typed (the API refuses it), never saved as something else.
		expect(withCatchmentMap(rs, 700, ' ')).toEqual({ catchment: { stationId: 's' }, catchmentMapMm: 700 });
		expect(withCatchmentMap(rs, null, 'a study')).toEqual({ catchment: { stationId: 's' }, catchmentMapSource: 'a study' });
	});

	it('says what the API would refuse, and nothing for none or a complete pair', () => {
		expect(catchmentMapFormError(null)).toBeNull();
		expect(catchmentMapFormError({ catchmentMapMm: 700, catchmentMapSource: 'a study' })).toBeNull();
		expect(catchmentMapFormError({ catchmentMapMm: 700 })).toMatch(/needs its source/);
		expect(catchmentMapFormError({ catchmentMapMm: 700, catchmentMapSource: '  ' })).toMatch(/needs its source/);
		expect(catchmentMapFormError({ catchmentMapSource: 'a study' })).toMatch(/source needs its MAP/);
		expect(catchmentMapFormError({ catchmentMapMm: 0.5, catchmentMapSource: 'x' })).toBe('The catchment MAP must be a number from 1 to 12000 mm.');
		expect(catchmentMapFormError({ catchmentMapMm: 700, catchmentMapSource: 'x'.repeat(601) })).toMatch(/longer than 600/);
	});

	it('takes the units’ area-weighted mean when blank, and the entered MAP over it, for the ratio', () => {
		const blank = catchmentMapReadout({ catchment: { stationId: 's' } }, mapped, S);
		expect(blank.entered).toBeNull();
		expect(blank.unitsMean).toBeCloseTo(mean, 12);
		expect(blank.inUse).toBeCloseTo(mean, 12);
		expect(blank.ratio.ratio).toBeCloseTo(mean / 600, 12);
		expect(blank.noRatioWhy).toBeNull();
		const entered = catchmentMapReadout({ catchment: { stationId: 's' }, catchmentMapMm: 1200, catchmentMapSource: 'a study' }, mapped, S);
		expect(entered).toMatchObject({ entered: 1200, inUse: 1200, ratio: { ratio: 2, own: 2, clamped: false, outsideBand: false } });
		expect(entered.unitsMean).toBeCloseTo(mean, 12);
		// Clamped as the engine clamps it (0.25–4), and outside 0.5–2 flagged.
		expect(catchmentMapReadout({ catchment: { stationId: 's' }, catchmentMapMm: 3000, catchmentMapSource: 'x' }, mapped, S).ratio).toMatchObject({ ratio: 4, own: 5, clamped: true });
		// A stored MAP out of range is the engine's fallback to the units' mean.
		expect(catchmentMapReadout({ catchment: { stationId: 's' }, catchmentMapMm: 50_000, catchmentMapSource: 'x' }, mapped, S).inUse).toBeCloseTo(mean, 12);
	});

	it('says why the station’s rain isn’t scaled', () => {
		const rs = (extra: Partial<RainStationSettings> = {}): RainStationSettings => ({ catchment: { stationId: 's' }, ...extra });
		expect(catchmentMapReadout(rs(), [unit('a', 900), unit('c', null)], S)).toMatchObject({ unitsMean: null, missing: ['Unit c'], noRatioWhy: 'the units’ mean needs every land unit’s MAP, and Unit c has none', ratio: { ratio: 1 } });
		// An entered MAP stands in for the units' missing ones.
		expect(catchmentMapReadout(rs({ catchmentMapMm: 600, catchmentMapSource: 'x' }), [unit('c', null)], S)).toMatchObject({ noRatioWhy: null, ratio: { ratio: 1, own: 1 } });
		expect(catchmentMapReadout(rs(), [], S).noRatioWhy).toBe('there is no land unit to take a mean MAP from');
		expect(catchmentMapReadout(rs(), mapped, station('n', null)).noRatioWhy).toBe('the station has no MAP');
		expect(catchmentMapReadout({ catchment: { stationId: 's', scaleToMap: false } }, mapped, S)).toMatchObject({ noRatioWhy: 'scaling is off, so the station’s rain is taken as recorded', ratio: { ratio: 1, own: null } });
		// Without the nodes the mean is unknown, not missing.
		expect(catchmentMapReadout(rs(), undefined, S)).toMatchObject({ unitsMean: undefined, inUse: undefined, noRatioWhy: null });
		expect(catchmentMapReadout(rs(), mapped, null).noRatioWhy).toBeNull();
	});
});
