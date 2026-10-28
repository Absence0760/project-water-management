// patchChoices.ts (issue #612): the engine's patch usability over the model input, fetched once per project and set
// of stations until forgotten, with any station the stored input lacks (the form ahead of the saved setting) read
// from its series; a failed fetch is tried again. Synthetic input: invented values only (public repo).
import { describe, expect, it, vi } from 'vitest';
import { stationSeriesKey, toEpochDay, type ModelInput } from '@water-management/engine';
import { forgetPatchChoices, patchChoices } from './patchChoices';

vi.mock('#lib/api/index.js', () => ({ api: { runs: { modelInput: () => Promise.reject(new Error('not in this test')) }, series: { get: () => Promise.reject(new Error('not in this test')) } } }));

const START = '2015-01-01';
const DAYS = toEpochDay('2018-01-01') - toEpochDay(START);
const rain = (k: number) => Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? 4 * k : 0));
const main: (number | null)[] = rain(1);
for (let t = 100; t < 110; t++) main[t] = null;
const late: (number | null)[] = rain(2).map((v, t) => (t < 200 ? null : v));
function input(withStations = true): ModelInput {
	return {
		settings: { runoffModel: 'gr4j' },
		model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
		series: {
			rain_chirps_mm: { startDate: START, values: rain(0.8) },
			...(withStations ? { [stationSeriesKey('M')]: { startDate: START, values: main }, [stationSeriesKey('P')]: { startDate: START, values: rain(1.5) }, [stationSeriesKey('L')]: { startDate: START, values: late } } : {})
		},
		...(withStations
			? { stations: { M: { name: 'Main', mapMm: 600, mapSource: 'x', lat: null, lon: null }, P: { name: 'Patch', mapMm: 500, mapSource: 'x', lat: null, lon: null }, L: { name: 'Late', mapMm: null, mapSource: null, lat: null, lon: null } } }
			: {})
	} as unknown as ModelInput;
}
const SERIES: Record<string, { name: string; startDate: string; values: (number | null)[]; station: { mapMm: number | null; mapSource: string | null; lat: null; lon: null } }> = {
	M: { name: 'Main', startDate: START, values: main, station: { mapMm: 600, mapSource: 'x', lat: null, lon: null } },
	P: { name: 'Patch', startDate: START, values: rain(1.5), station: { mapMm: 500, mapSource: 'x', lat: null, lon: null } },
	L: { name: 'Late', startDate: START, values: late, station: { mapMm: null, mapSource: null, lat: null, lon: null } }
};
const IDS = ['L', 'M', 'P'];

describe('patchChoices', () => {
	it('gives every station’s usability against the main one, fetching the input once', async () => {
		const modelInput = vi.fn(() => Promise.resolve(input()));
		const series = vi.fn(() => Promise.reject(new Error('not needed')));
		forgetPatchChoices('p1');
		const c = await patchChoices('p1', 'M', true, IDS, { modelInput, series });
		expect(c.M).toMatchObject({ usable: false, reason: 'it is the main station' });
		expect(c.P).toMatchObject({ usable: true, gapDays: 10, fills: 10 });
		expect(c.L).toMatchObject({ usable: false, reason: 'it has no MAP to scale its rain to the unit’s MAP' });
		expect((await patchChoices('p1', 'M', false, IDS, { modelInput, series })).L).toMatchObject({ usable: false, fills: 0 });
		expect(modelInput).toHaveBeenCalledTimes(1);
		expect(series).not.toHaveBeenCalled();
		forgetPatchChoices('p1');
		await patchChoices('p1', 'M', true, IDS, { modelInput, series });
		expect(modelInput).toHaveBeenCalledTimes(2);
	});

	it('reads a station the stored input lacks (the setting not saved yet) from its series', async () => {
		const series = vi.fn((_p: string, id: string) => Promise.resolve(SERIES[id]!));
		forgetPatchChoices('p3');
		const c = await patchChoices('p3', 'M', true, IDS, { modelInput: () => Promise.resolve(input(false)), series });
		expect(series).toHaveBeenCalledTimes(3);
		expect(c.P).toMatchObject({ usable: true, gapDays: 10, fills: 10 });
		expect(c.L!.usable).toBe(false);
	});

	it('a failed fetch is tried again next time', async () => {
		forgetPatchChoices('p2');
		const series = () => Promise.reject(new Error('not needed'));
		await expect(patchChoices('p2', 'M', true, IDS, { modelInput: () => Promise.reject(new Error('offline')), series })).rejects.toThrow('offline');
		expect((await patchChoices('p2', 'M', true, IDS, { modelInput: () => Promise.resolve(input()), series })).P!.usable).toBe(true);
	});
});
