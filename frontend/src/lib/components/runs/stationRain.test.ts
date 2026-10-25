// Runs & results → Rain for each unit, its rainfall stations (issue #553):
// reading summary.stations defensively, each area's station, MAPs, ratio and
// days, each pairing's fit or refusal, and the panel showing them with and
// without rain for each unit.
import type { StationAreaForcing, StationPairingFit } from '@water-management/engine';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import UnitRainPanel from './UnitRainPanel.svelte';
import { catchmentMapText, chirpsAtText, correctedByName, pairingFactorsText, pairingPeriodText, ratioText, stationAreas, stationNotes, stationsOf, type StationsResult } from './stationRain';
import type { UnitRainResult } from './unitRain';
import { withoutComments } from '../__fixtures__/withoutComments';

vi.mock('$app/paths', () => ({ base: '' }));

const area = (over: Partial<StationAreaForcing> = {}): StationAreaForcing => ({
	nodeId: 'u1',
	name: 'Upper unit',
	stationId: 's1',
	stationName: 'Hill station',
	areaMapMm: 863.1,
	areaMapSource: 'a synthetic MAP grid',
	stationMapMm: 745,
	stationMapSource: 'station record',
	ownRatio: 1.1585,
	ratio: 1.1585,
	clamped: false,
	scaleToMap: true,
	correctedBy: 's1',
	days: { station: 3000, chirps: 120, fallback: 0, none: 2 },
	setAside: { checks: 14, unreliable: 30 },
	...over
});
const month = (m: number, factor = 1.2) => ({ month: m, sharedDays: 300, gaugeMm: 600, chirpsMm: 500, ownFactor: factor, factor, clamped: false, fitted: true, outsideBand: false });
const pairing = (over: Partial<StationPairingFit> = {}): StationPairingFit => ({
	stationId: 's1',
	stationName: 'Hill station',
	chirpsAt: { cell: true },
	refused: null,
	fitFrom: '1995-01-01',
	fitTo: '2020-12-31',
	commonYears: 26,
	days: 9400,
	pinned: false,
	months: Array.from({ length: 12 }, (_, i) => month(i + 1, i === 0 ? 1.25 : 1)),
	...over
});
const stations = (over: Partial<StationsResult> = {}): StationsResult => ({
	pairings: [pairing()],
	catchment: area({ nodeId: null, name: 'Synthetic catchment', areaMapMm: 800, areaMapSource: null, ownRatio: 1.0738, ratio: 1.0738 }),
	units: [area()],
	catchmentMapMm: 800,
	catchmentMapFromUnits: true,
	...over
});

describe('stationsOf', () => {
	it('reads summary.stations only when it is whole and assigns an area', () => {
		expect(stationsOf({ farms: [] })).toBeNull();
		expect(stationsOf(null)).toBeNull();
		expect(stationsOf({ stations: { units: [] } })).toBeNull();
		expect(stationsOf({ stations: { pairings: [], units: [], catchment: null } })).toBeNull();
		const s = stations();
		expect(stationsOf({ stations: s })).toBe(s);
	});
});

describe('station helpers', () => {
	it('puts the catchment first, then the units in the run’s farm order', () => {
		const s = stations({ units: [area({ nodeId: 'a', name: 'A' }), area({ nodeId: 'b', name: 'B' }), area({ nodeId: 'c', name: 'C' })] });
		expect(stationAreas(s, ['c', 'a']).map((a) => a.name)).toEqual(['Synthetic catchment', 'C', 'A', 'B']);
		expect(stationAreas({ ...s, catchment: null }).map((a) => a.name)).toEqual(['A', 'B', 'C']);
	});

	it('words the ratio: both MAPs, not scaled, or a missing MAP', () => {
		expect(ratioText(area())).toBe('× 1.16 (863 ÷ 745 mm)');
		expect(ratioText(area({ scaleToMap: false, ownRatio: null, ratio: 1 }))).toBe('× 1, not scaled to MAP');
		expect(ratioText(area({ areaMapMm: null, ownRatio: null, ratio: 1 }))).toBe('× 1, no MAP for the unit');
		expect(ratioText(area({ nodeId: null, areaMapMm: null, ownRatio: null, ratio: 1 }))).toBe('× 1, no MAP for the catchment');
		expect(ratioText(area({ stationMapMm: null, ownRatio: null, ratio: 1 }))).toBe('× 1, no MAP for the station');
	});

	it('words a pairing: where its CHIRPS came from, the period, the factors or the refusal', () => {
		expect(chirpsAtText(pairing())).toBe('its own CHIRPS cell');
		expect(chirpsAtText(pairing({ chirpsAt: { unitId: 'u1', unitName: 'Upper unit' } }))).toBe('the CHIRPS of Upper unit');
		expect(pairingPeriodText(pairing())).toBe('1995-01-01 to 2020-12-31; 26 complete years (accumulations counted)');
		expect(pairingPeriodText(pairing({ fitFrom: null, fitTo: null }))).toBe('–');
		// The years count accumulation days the fit's dates leave out (engine ≥ 1.96.0): 5 complete years inside a span
		// shorter than 5 calendar years, so the text never writes them as one period.
		expect(pairingPeriodText(pairing({ fitFrom: '2016-01-03', fitTo: '2020-12-30', commonYears: 5 }))).toBe('2016-01-03 to 2020-12-30; 5 complete years (accumulations counted)');
		expect(pairingPeriodText(pairing({ commonYears: 1 }))).toBe('1995-01-01 to 2020-12-31; 1 complete year (accumulations counted)');
		expect(pairingFactorsText(pairing())).toMatch(/^Jan 1\.25, Feb 1, Mar 1, .*, Dec 1$/);
		expect(pairingFactorsText(pairing({ refused: 'only 3 complete years in common (5 needed)', months: [] }))).toBe('refused: only 3 complete years in common (5 needed)');
	});

	it('names the correcting station from its pairing, and the catchment MAP’s origin', () => {
		const s = stations();
		expect(correctedByName(s, area())).toBe('Hill station');
		expect(correctedByName(s, area({ correctedBy: null }))).toBeNull();
		expect(catchmentMapText(s)).toBe('800 mm (the units’ area-weighted mean)');
		expect(catchmentMapText({ catchmentMapMm: 750, catchmentMapFromUnits: false })).toBe('750 mm (entered)');
		expect(catchmentMapText({ catchmentMapMm: null, catchmentMapFromUnits: true })).toBeNull();
	});

	it('notes a refused pairing, a held ratio, a missing MAP and gaps no pairing corrects', () => {
		const notes = stationNotes(
			stations({
				pairings: [pairing({ stationId: 's2', stationName: 'Short station', refused: 'only 3 complete years in common (5 needed)', months: [] })],
				units: [
					area({ name: 'Held unit', ownRatio: 4.6, ratio: 4, clamped: true }),
					area({ name: 'Bare unit', areaMapMm: null, ownRatio: null, ratio: 1 }),
					area({ name: 'Gap unit', correctedBy: null, days: { station: 100, chirps: 0, fallback: 12, none: 0 } })
				]
			})
		);
		expect(notes).toEqual([
			'Short station: its CHIRPS pairing was refused (only 3 complete years in common (5 needed)), so the areas it corrects fill their gaps from the next fallback.',
			'Held unit: the MAP ratio 4.6 was held at the 0.25–4 bound; check its MAP and Hill station’s.',
			'Bare unit: no MAP for the unit, so Hill station’s rain is used as recorded.',
			'Gap unit: no CHIRPS pairing corrects its gaps, so 12 days come from the next fallback (the catchment rain).'
		]);
		expect(stationNotes(stations())).toEqual([]);
	});
});

const unitRain: UnitRainResult = { mode: 'perUnit', gaugeMapMm: null, gaugeMapSource: null, mapPeriod: { start: '1991-01-01', end: '2020-12-31' }, units: [] };

describe('UnitRainPanel with rainfall stations', () => {
	it('shows the catchment’s station forcing on a run without rain for each unit', () => {
		const body = withoutComments(render(UnitRainPanel, { props: { result: null, stations: stations({ units: [] }) } }).body);
		expect(body).toContain('Rain from rainfall stations');
		expect(body).not.toContain('Rain for each unit');
		expect(body).not.toContain('<h4');
		expect((body.match(/data-testid="run-station-row"/g) ?? []).length).toBe(1);
		expect(body).toContain('Synthetic catchment (catchment)');
		expect(body).toContain('Catchment MAP 800 mm (the units’ area-weighted mean).');
		expect(body).toContain('× 1.07 (800 ÷ 745 mm)');
		expect(body).toContain('gaps from CHIRPS corrected against Hill station');
	});

	it('lists each area’s station, MAPs, ratio, days and set-aside days, and each pairing, under the units’ own rain', () => {
		const s = stations({
			pairings: [pairing(), pairing({ stationId: 's2', stationName: 'Short station', chirpsAt: { unitId: 'u1', unitName: 'Upper unit' }, refused: 'only 3 complete years in common (5 needed)', fitFrom: null, fitTo: null, commonYears: 3, days: 1000, months: [] })]
		});
		const body = withoutComments(render(UnitRainPanel, { props: { result: unitRain, stations: s, order: ['u1'] } }).body);
		expect(body).toContain('Rain for each unit');
		expect(body).toMatch(/<h4[^>]*>Rainfall stations<\/h4>/);
		expect((body.match(/data-testid="run-station-row"/g) ?? []).length).toBe(2);
		expect(body.indexOf('Synthetic catchment')).toBeLessThan(body.indexOf('Upper unit'));
		expect(body).toContain('× 1.16 (863 ÷ 745 mm)');
		expect(body).toMatch(/<td class="num">3\D000<\/td><td class="num">120<\/td>/);
		expect(body).toContain('<td class="num">44<span');
		expect(body).toContain('14 by the checks, 30 unreliable');
		expect(body).toContain('<strong>Upper unit</strong>: a synthetic MAP grid; Hill station: station record');
		expect((body.match(/data-testid="run-station-pairing"/g) ?? []).length).toBe(2);
		expect(body).toContain('1995-01-01 to 2020-12-31; 26 complete years (accumulations counted)');
		expect(body).toContain('Jan 1.25, Feb 1');
		expect(body).toContain('the CHIRPS of Upper unit');
		expect(body).toContain('refused: only 3 complete years in common (5 needed)');
		expect(body).toContain('data-testid="run-station-notes"');
	});

	it('leaves the stations out on a run without them', () => {
		const body = withoutComments(render(UnitRainPanel, { props: { result: unitRain } }).body);
		expect(body).not.toContain('run-station-row');
	});
});
