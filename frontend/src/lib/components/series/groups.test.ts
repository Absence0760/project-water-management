// The Data tab's grouped series list (issue #553 round 5). Synthetic names only.
import { describe, expect, it } from 'vitest';
import type { NetworkNode, ProjectSettings, SeriesMeta } from '@water-management/engine';
import { areaNames, areaRowInfo, areaSentence, groupOf, groupSeries, itemOfSeries, listedUnits, stationsOf, stationUses, stationUsesText, unitItemId, type AreaItem } from './groups';

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

	it('a unit holding a series behind comes first in its group', () => {
		const settings = { unitRain: { mode: 'perUnit' } } as unknown as ProjectSettings;
		const list = [ser('chirpsB', 'rain_chirps_mm', { siteNodeId: 'B' })];
		expect(groupSeries(list, NODES, settings).find((g) => g.id === 'units')!.items.map((i) => i.id)).toEqual(['unit:A', 'unit:B']);
		expect(groupSeries(list, NODES, settings, new Set(['chirpsB'])).find((g) => g.id === 'units')!.items.map((i) => i.id)).toEqual(['unit:B', 'unit:A']);
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
		expect(areaSentence({ name: 'Unit A', mapMm: 4000, catchment: false }, { stationId: 'Bergwater' }, stations)).toMatch(/^Bergwater × 4\.00 \(clamped\) \(unit MAP 4.000\.0 mm ÷ station MAP 745\.0 mm\);/);
		expect(areaSentence({ name: 'the catchment', mapMm: 745, catchment: true, mapFromUnits: false, hasChirps: false }, { stationId: 'Bergwater' }, stations)).toBe(
			'Bergwater × 1.00 (catchment MAP 745.0 mm ÷ station MAP 745.0 mm); gaps from the forecast, if any: the catchment has no CHIRPS series.'
		);
		expect(areaSentence({ name: 'Unit A', mapMm: 745, catchment: false }, { stationId: 'Bergwater', correctAgainst: 'gone' }, stations)).toMatch(/gaps from CHIRPS corrected against a station that is no longer in the project\.$/);
		expect(areaSentence({ name: 'Unit A', mapMm: 863.1, catchment: false }, { stationId: 'Bergwater', scaleToMap: false }, stations)).toMatch(/^Bergwater as recorded \(not scaled by MAP\);/);
		expect(areaSentence({ name: 'Unit B', mapMm: 600, catchment: false, hasChirps: false }, { stationId: 'Bergwater' }, stations)).toMatch(/gaps from the catchment’s rain: the unit has no CHIRPS series of its own\.$/);
		expect(areaSentence({ name: 'Unit A', mapMm: 863.1, catchment: false }, { stationId: 'gone' }, stations)).toMatch(/no longer one of the project’s series/);
		expect(areaSentence({ name: 'Unit A', mapMm: 863.1, catchment: false }, null, stations)).toBeNull();
	});
});

describe('stationUses', () => {
	it('names the areas a station is the rain of, and those whose gaps it only corrects', () => {
		const settings = {
			unitRain: { mode: 'perUnit' },
			rainStations: { catchment: { stationId: 'Bergwater' }, units: { A: { stationId: 'Bergwater' }, B: { stationId: 'Kloof', correctAgainst: 'Bergwater' } } }
		} as unknown as ProjectSettings;
		const uses = stationUses('Bergwater', settings, NODES);
		expect(uses).toEqual({ rainFor: ['the catchment', 'Unit A'], corrects: ['Unit B'], idle: [] });
		expect(stationUsesText(uses)).toBe('Rain for the catchment and Unit A. Corrects the CHIRPS gaps of Unit B.');
		expect(stationUsesText(stationUses('Kloof', settings, NODES))).toBe('Rain for Unit B.');
		expect(stationUsesText(stationUses('Bergwater', null, NODES))).toBe('Not assigned to the catchment or a unit.');
		// Past three areas the units are counted, so the row stays short.
		const many = { rainFor: ['the catchment', ...Array.from({ length: 30 }, (_, i) => `Unit ${i}`)], corrects: ['U1', 'U2', 'U3', 'U4'] };
		expect(stationUsesText(many)).toBe('Rain for the catchment and 30 units. Corrects the CHIRPS gaps of 4 units.');
		expect(stationUsesText({ rainFor: ['A', 'B', 'C'], corrects: [] })).toBe('Rain for A, B and C.');
	});

	it('reads a unit’s assignment only under per-unit rain, and only for a land unit, as a run does (issue #589)', () => {
		const rainStations = { catchment: { stationId: 'Bergwater' }, units: { A: { stationId: 'Kloof' }, B: { stationId: 'Bergwater', correctAgainst: 'Kloof' }, gone: { stationId: 'Kloof' } } };
		const fragmentation = { rainStations } as unknown as ProjectSettings;
		// Fragmentation: the catchment's station is read; the units' assignments wait for per-unit rain.
		expect(stationUses('Bergwater', fragmentation, NODES)).toEqual({ rainFor: ['the catchment'], corrects: [], idle: ['Unit B'] });
		expect(stationUses('Kloof', fragmentation, NODES)).toEqual({ rainFor: [], corrects: [], idle: ['Unit A', 'Unit B'] });
		expect(stationUsesText(stationUses('Kloof', fragmentation, NODES))).toBe('Assigned to Unit A and Unit B, read only under per-unit rain.');
		expect(stationUsesText(stationUses('Bergwater', fragmentation, NODES))).toBe('Rain for the catchment. Assigned to Unit B, read only under per-unit rain.');
		// Per unit: a unit no longer in the model ("gone") is not an area it serves.
		const perUnit = { unitRain: { mode: 'perUnit' }, rainStations } as unknown as ProjectSettings;
		expect(stationUses('Kloof', perUnit, NODES)).toEqual({ rainFor: ['Unit A'], corrects: ['Unit B'], idle: [] });
	});
});

describe('areaRowInfo and areaNames', () => {
	const stations = stationsOf(LIST);
	const unitA = NODES[1]!;
	const unitItem = (series: SeriesMeta[] = []): AreaItem<SeriesMeta> => ({ type: 'unit', id: 'unit:A', unit: unitA, series });
	const catchmentItem: AreaItem<SeriesMeta> = { type: 'catchment', id: 'area:catchment' };
	const ctx = (settings: unknown, extra: Partial<Parameters<typeof areaRowInfo>[1]> = {}) => ({
		settings: settings as ProjectSettings,
		nodes: NODES,
		stations,
		behind: new Set<string>(),
		catchmentChirps: true,
		...extra
	});

	it('a unit on its station: its sentence, its series, behind when one of them is, and Show rain used', () => {
		const settings = { unitRain: { mode: 'perUnit' }, rainStations: { units: { A: { stationId: 'Bergwater', correctAgainst: 'Kloof' } } } };
		const chirps = ser('chirpsA', 'rain_chirps_mm', { siteNodeId: 'A' });
		const info = areaRowInfo(unitItem([chirps]), ctx(settings, { behind: new Set(['chirpsA']) }));
		expect(info).toEqual({
			kind: 'Hydrological unit',
			name: 'Unit A',
			map: 'MAP 863.1 mm',
			sentence: 'Bergwater × 1.16 (unit MAP 863.1 mm ÷ station MAP 745.0 mm); gaps from CHIRPS corrected against Kloof.',
			seriesNote: '1 series measured here: chirpsA',
			behind: true,
			toggle: 'rain used'
		});
		expect(areaNames(unitItem(), ctx(settings))).toEqual({ name: 'Unit A', stationName: 'Bergwater', correctingName: 'Kloof' });
	});

	it('a unit without a station says what its rain is instead, and offers its series only when it has some', () => {
		expect(areaRowInfo(unitItem(), ctx({ unitRain: { mode: 'perUnit' } }))).toMatchObject({ sentence: 'No rainfall station assigned: its rain follows Model settings → Model selection for flow generation → Units without a station.', toggle: null });
		const off = { rainStations: { units: { A: { stationId: 'Bergwater' } } } };
		expect(areaRowInfo(unitItem([ser('x', 'rain_chirps_mm', { siteNodeId: 'A' })]), ctx(off))).toMatchObject({
			sentence: 'Runs split the catchment’s flow by the flow share (per-unit rain is off), so its station isn’t read.',
			toggle: 'its series'
		});
		expect(areaNames(unitItem(), ctx(off))).toBeNull();
		expect(areaRowInfo(unitItem(), ctx(null)).sentence).toBe('Runs split the catchment’s flow by the flow share; this unit has no rain of its own.');
		expect(areaRowInfo({ type: 'unit', id: 'unit:A', series: [], unit: { ...unitA, mapMm: null } as NetworkNode }, ctx(null)).map).toBe('No MAP');
	});

	it('the catchment: its MAP, entered or the units’ mean, and its station', () => {
		const rs = { catchment: { stationId: 'Bergwater' } };
		expect(areaRowInfo(catchmentItem, ctx({ rainStations: rs }))).toMatchObject({
			kind: 'Catchment average (derived)',
			name: 'Average catchment rainfall',
			map: 'MAP 775.4 mm (the units’ area-weighted mean)',
			toggle: 'rain used'
		});
		expect(areaRowInfo(catchmentItem, ctx({ rainStations: { ...rs, catchmentMapMm: 800, catchmentMapSource: 'a study' } })).map).toBe('MAP 800.0 mm (a study)');
		expect(areaRowInfo(catchmentItem, ctx({ rainStations: rs }, { nodes: [NODES[0]!] })).map).toBe('No catchment MAP');
		expect(areaRowInfo(catchmentItem, ctx({ rainStations: { catchment: { stationId: 'gone' } } })).toggle).toBeNull();
		expect(areaNames(catchmentItem, ctx({ rainStations: { catchment: { stationId: 'Bergwater', correctAgainst: 'gone' } } }))?.correctingName).toBe('a station no longer in the project');
	});
});
