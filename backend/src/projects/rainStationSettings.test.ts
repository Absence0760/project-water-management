// settings.rainStations's shape (issue #553): what a save may send, the
// plain-language refusals, and how a copy's or import's fresh ids follow.
import { describe, expect, it } from 'vitest';
import { RainStations, remapRainStations } from './rainStationSettings.js';
import { remapSettingNodeIds, SettingsPatch } from './settings.js';

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const U1 = 'c0000000-0000-4000-8000-000000000001';
const U2 = 'c0000000-0000-4000-8000-000000000002';

const messages = (v: unknown) => {
	const r = RainStations.safeParse(v);
	return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('RainStations', () => {
	it('takes a full setting, and null through SettingsPatch', () => {
		const full = {
			catchment: { stationId: A, scaleToMap: true, correctAgainst: B },
			units: { [U1]: { stationId: A }, [U2]: { stationId: B, correctAgainst: null } },
			catchmentMapMm: 700,
			catchmentMapSource: 'area-weighted mean, 1991–2020',
			sites: { [B]: { unitId: U2 } },
			unreliable: { [A]: [['2020-01-01', '2020-01-31'], ['2021-02-01', '2021-02-01']] }
		};
		expect(RainStations.parse(full)).toEqual(full);
		expect(SettingsPatch.parse({ rainStations: null })).toEqual({ rainStations: null });
		expect(SettingsPatch.parse({ rainStations: { units: {} } })).toEqual({ rainStations: { units: {} } });
	});

	it('refuses pinned factors, the engine’s own', () => {
		expect(messages({ pinnedFactors: { [A]: Array(12).fill(1) } })).toEqual([expect.stringMatching(/^rainfall stations: pinned factors are the engine’s own/)]);
	});

	it('refuses a catchment MAP out of the engine’s bounds or without its source, and a source without a MAP', () => {
		expect(messages({ catchmentMapMm: 700 })).toEqual(['rainfall stations: the catchment’s a MAP needs its source']);
		expect(messages({ catchmentMapMm: 700, catchmentMapSource: '  ' })).toEqual(['rainfall stations: the catchment’s a MAP needs its source']);
		expect(messages({ catchmentMapSource: 'a study' })).toEqual(['rainfall stations: the catchment’s a MAP source needs its MAP']);
		expect(messages({ catchmentMapMm: 0.5, catchmentMapSource: 'x' })).not.toEqual([]);
		expect(messages({ catchmentMapMm: 20_000, catchmentMapSource: 'x' })).not.toEqual([]);
		// A blank source with no MAP is none.
		expect(RainStations.parse({ catchmentMapMm: null, catchmentMapSource: '' })).toEqual({ catchmentMapMm: null, catchmentMapSource: null });
	});

	it('refuses an unreliable period that ends before it starts, or a date that isn’t one', () => {
		expect(messages({ unreliable: { [A]: [['2020-02-01', '2020-01-01']] } })).toEqual(['rainfall stations: an unreliable period runs from 2020-02-01 to 2020-01-01, which ends before it starts']);
		expect(messages({ unreliable: { [A]: [['2021-02-30', '2021-03-01']] } })).toEqual(['not a calendar date']);
		expect(messages({ unreliable: { [A]: [['2021/02/01', '2021-03-01']] } })).toEqual(['a date is YYYY-MM-DD']);
	});

	it('refuses ids that aren’t ids, and fields it doesn’t know', () => {
		expect(messages({ catchment: { stationId: 'gauge' } })).toEqual(['a rainfall station is named by its series id']);
		expect(messages({ units: { 'unit 1': { stationId: A } } })).toEqual(['a land unit is named by its node id']);
		expect(messages({ sites: { [A]: { unitId: 'x' } } })).toEqual(['a land unit is named by its node id']);
		expect(messages({ catchment: { stationId: A, ratio: 2 } })).not.toEqual([]);
		expect(messages({ gaugeMapMm: 700 })).not.toEqual([]);
	});
});

describe('remapRainStations', () => {
	const rs = {
		catchment: { stationId: A, correctAgainst: B },
		units: { [U1]: { stationId: A }, [U2]: { stationId: B, correctAgainst: A } },
		sites: { [B]: { unitId: U2 } },
		unreliable: { [A]: [['2020-01-01', '2020-01-02']] }
	};
	const N1 = 'd0000000-0000-4000-8000-000000000001';
	const N2 = 'd0000000-0000-4000-8000-000000000002';
	const A2 = 'e0000000-0000-4000-8000-00000000000a';

	it('follows fresh node ids and, given them, fresh station ids; an id not in a map stays', () => {
		const nodes = new Map([
			[U1, N1],
			[U2, N2]
		]);
		expect(remapRainStations(rs, nodes, new Map([[A, A2]]))).toEqual({
			catchment: { stationId: A2, correctAgainst: B },
			units: { [N1]: { stationId: A2 }, [N2]: { stationId: B, correctAgainst: A2 } },
			sites: { [B]: { unitId: N2 } },
			unreliable: { [A2]: [['2020-01-01', '2020-01-02']] }
		});
		// remapSettingNodeIds (a copy, an import) moves the units only.
		expect(remapSettingNodeIds({ rainStations: rs }, nodes).rainStations).toEqual({ ...rs, units: { [N1]: rs.units[U1], [N2]: rs.units[U2] }, sites: { [B]: { unitId: N2 } } });
		expect(remapRainStations(null, nodes)).toBeNull();
	});
});
