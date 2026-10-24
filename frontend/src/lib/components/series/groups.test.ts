// The Data tab's grouped series list (issue #553 round 5). Synthetic names only.
import { describe, expect, it } from 'vitest';
import type { NetworkNode, ProjectSettings, SeriesMeta } from '@water-management/engine';
import { areaSentence, groupOf, groupSeries, itemOfSeries, listedUnits, stationsOf, stationUses, stationUsesText, unitItemId } from './groups';

const node = (id: string, kind: NetworkNode['kind'], areaKm2: number, mapMm: number | null = null) =>
	({ id, name: `Unit ${id}`, kind, areaKm2, mapMm, downstreamNodeId: 'G' }) as unknown as NetworkNode;
const NODES = [node('G', 'gauge', 0), node('A', 'farm', 10, 863.1), node('B', 'farm', 5, 600), node('W', 'farm', 0)];

const ser = (id: string, kind: string, extra: Partial<SeriesMeta> = {}) => ({ id, kind, name: id, unit: kind.endsWith('_mm') ? 'mm' : 'm³/s', startDate: '2020-01-01', length: 10, siteNodeId: null, ...extra }) as SeriesMeta;

const LIST = [
	ser('evap', 'evap_apan_mm'),
	ser('Bergwater', 'rain_catchment_mm', { station: { mapMm: 745, mapSource: 'record', lat: null, lon: null } }),
	ser('chirps', 'rain_chirps_mm'),
	ser('chirpsA', 'rain_chirps_mm', { siteNodeId: 'A' }),
	ser('flow', 'flow_observed_m3s'),
	ser('weir', 'flow_observed_m3s', { siteNodeId: 'G' }),
	ser('Kloof', 'rain_catchment_mm'),
	ser('forecast', 'rain_forecast_mm')
];

describe('groupOf', () => {
	it('stations, catchment rain, a unit’s own series, flow (a gauge’s record too), the rest', () => {
		const units = new Set(['A']);
		expect(LIST.map((s) => groupOf(s, units))).toEqual(['other', 'stations', 'catchment', 'units', 'flow', 'flow', 'stations', 'catchment']);
		// Rain measured at a node that isn't a listed unit is not catchment rain.
		expect(groupOf(ser('x', 'rain_chirps_mm', { siteNodeId: 'B' }), units)).toBe('other');
	});
});

describe('groupSeries', () => {
	it('groups in order, the list’s order kept within each, a unit holding its own series, empty groups left out', () => {
		const groups = groupSeries(LIST, NODES, null);
		expect(groups.map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
			['Rainfall stations', ['Bergwater', 'Kloof']],
			['Catchment rainfall', ['chirps', 'forecast']],
			['Hydrological units', [unitItemId('A')]],
			['Flow records', ['flow', 'weir']],
			['Other inputs', ['evap']]
		]);
		const unit = groups[2]!.items[0]!;
		expect(unit.type === 'unit' && unit.series.map((s) => s.id)).toEqual(['chirpsA']);
		expect(groupSeries([ser('flow', 'flow_observed_m3s')], NODES, null).map((g) => g.id)).toEqual(['flow']);
	});

	it('with per-unit rain or a unit’s station every land unit is listed (never a node without land); the catchment’s station adds its row', () => {
		const settings = { unitRain: { mode: 'perUnit' }, rainStations: { catchment: { stationId: 'Bergwater' } } } as unknown as ProjectSettings;
		expect(listedUnits(NODES, settings, []).map((n) => n.id)).toEqual(['A', 'B']);
		expect(listedUnits(NODES, { rainStations: { units: { B: { stationId: 'Kloof' } } } } as unknown as ProjectSettings, []).map((n) => n.id)).toEqual(['A', 'B']);
		expect(listedUnits(NODES, null, []).map((n) => n.id)).toEqual([]);
		const groups = groupSeries(LIST, NODES, settings);
		expect(groups.find((g) => g.id === 'catchment')!.items.map((i) => i.id)).toEqual(['area:catchment', 'chirps', 'forecast']);
		expect(groups.find((g) => g.id === 'units')!.items.map((i) => i.id)).toEqual(['unit:A', 'unit:B']);
	});

	it('itemOfSeries finds a unit’s series in its unit', () => {
		const groups = groupSeries(LIST, NODES, null);
		expect(itemOfSeries(groups, 'chirpsA')).toBe('unit:A');
		expect(itemOfSeries(groups, 'flow')).toBe('flow');
		expect(itemOfSeries(groups, 'gone')).toBeNull();
		expect(itemOfSeries(groups, null)).toBeNull();
	});
});

describe('areaSentence', () => {
	const stations = stationsOf(LIST);
	it('the station × the MAP ratio, and what corrects its gaps', () => {
		expect(areaSentence({ name: 'Unit A', mapMm: 863.1, catchment: false }, { stationId: 'Bergwater' }, stations)).toBe(
			'Bergwater × 1.16 (unit MAP 863.1 mm ÷ station MAP 745.0 mm); gaps from CHIRPS corrected against Bergwater.'
		);
		expect(areaSentence({ name: 'the catchment', mapMm: 800, catchment: true, mapFromUnits: true }, { stationId: 'Bergwater', correctAgainst: 'Kloof' }, stations)).toBe(
			'Bergwater × 1.07 (catchment MAP, the units’ area-weighted mean 800.0 mm ÷ station MAP 745.0 mm); gaps from CHIRPS corrected against Kloof.'
		);
	});
	it('says when the ratio is 1, clamped or off, when there is no CHIRPS, and when the station is gone', () => {
		expect(areaSentence({ name: 'Unit A', mapMm: 863.1, catchment: false }, { stationId: 'Kloof' }, stations)).toBe('Kloof × 1: the station has no MAP to scale it by; gaps from CHIRPS corrected against Kloof.');
		expect(areaSentence({ name: 'Unit A', mapMm: null, catchment: false }, { stationId: 'Bergwater' }, stations)).toMatch(/^Bergwater × 1: Unit A has no MAP to scale it by;/);
		expect(areaSentence({ name: 'Unit A', mapMm: 4000, catchment: false }, { stationId: 'Bergwater' }, stations)).toMatch(/^Bergwater × 4 \(clamped\)|^Bergwater × 4\.00 \(clamped\)/);
		expect(areaSentence({ name: 'Unit A', mapMm: 863.1, catchment: false }, { stationId: 'Bergwater', scaleToMap: false }, stations)).toMatch(/^Bergwater as recorded \(not scaled by MAP\);/);
		expect(areaSentence({ name: 'Unit B', mapMm: 600, catchment: false, hasChirps: false }, { stationId: 'Bergwater' }, stations)).toMatch(/gaps from the catchment’s rain: the unit has no CHIRPS series of its own\.$/);
		expect(areaSentence({ name: 'Unit A', mapMm: 863.1, catchment: false }, { stationId: 'gone' }, stations)).toMatch(/no longer one of the project’s series/);
		expect(areaSentence({ name: 'Unit A', mapMm: 863.1, catchment: false }, null, stations)).toBeNull();
	});
});

describe('stationUses', () => {
	it('names the areas a station is the rain of, and those whose gaps it only corrects', () => {
		const settings = {
			rainStations: { catchment: { stationId: 'Bergwater' }, units: { A: { stationId: 'Bergwater' }, B: { stationId: 'Kloof', correctAgainst: 'Bergwater' } } }
		} as unknown as ProjectSettings;
		const uses = stationUses('Bergwater', settings, NODES);
		expect(uses).toEqual({ rainFor: ['the catchment', 'Unit A'], corrects: ['Unit B'] });
		expect(stationUsesText(uses)).toBe('Rain for the catchment and Unit A. Corrects the CHIRPS gaps of Unit B.');
		expect(stationUsesText(stationUses('Kloof', settings, NODES))).toBe('Rain for Unit B.');
		expect(stationUsesText(stationUses('Bergwater', null, NODES))).toBe('Not assigned to the catchment or a unit.');
	});
});
