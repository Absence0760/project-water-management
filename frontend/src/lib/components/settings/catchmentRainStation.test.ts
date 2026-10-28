// catchmentRainStation.ts (issue #612 follow-up): the catchment's station and its patching priority as the form reads
// and writes them, with the same stored defaults as a unit's. Invented ids only.
import { describe, expect, it } from 'vitest';
import { catchmentStationRow, withCatchmentCorrectAgainst, withCatchmentPatch, withCatchmentScale, withCatchmentStation } from './catchmentRainStation';
import type { StationOption } from './flowGeneration';

const S: StationOption = { id: 's', name: 'Station S', station: { mapMm: 600, mapSource: 'x', lat: null, lon: null } };
const T: StationOption = { id: 't', name: 'Station T', station: null };

describe('catchmentStationRow', () => {
	it('reads none as the rain series, a station with the default priority, and a deleted station as missing', () => {
		expect(catchmentStationRow(null, [S, T])).toEqual({ assignment: null, station: null, missing: false, scale: true, correctAgainst: null, patch: [] });
		expect(catchmentStationRow({ catchment: { stationId: 's' } }, [S, T])).toMatchObject({ station: S, missing: false, scale: true, correctAgainst: 's', patch: ['chirps'] });
		expect(catchmentStationRow({ catchment: { stationId: 's', scaleToMap: false, patch: [{ source: 'station', stationId: 't' }, { source: 'chirps' }] } }, [S, T])).toMatchObject({
			scale: false,
			patch: ['t', 'chirps']
		});
		expect(catchmentStationRow({ catchment: { stationId: 'gone' } }, [S, T])).toMatchObject({ station: null, missing: true });
	});
});

describe('withCatchmentStation and withCatchmentPatch', () => {
	it('assigning and taking the station away again stores what was there', () => {
		const set = withCatchmentStation(null, 's');
		expect(set).toEqual({ catchment: { stationId: 's' } });
		expect(withCatchmentStation(set, null)).toBeNull();
		const units = { units: { a: { stationId: 't' } } };
		expect(withCatchmentStation(withCatchmentStation(units, 's'), '')).toEqual(units);
	});

	it('another station keeps the scaling, the correcting station and the priority, less the new main station', () => {
		const rs = { catchment: { stationId: 's', scaleToMap: false, correctAgainst: 't', patch: [{ source: 'station' as const, stationId: 't' }, { source: 'chirps' as const }] } };
		expect(withCatchmentStation(rs, 't')).toEqual({ catchment: { stationId: 't', scaleToMap: false, correctAgainst: 't' } });
		// [CHIRPS] left is the default, so it stores none; another station keeps its list as is.
		expect(withCatchmentStation(rs, 'u')!.catchment!.patch).toEqual(rs.catchment.patch);
		expect(withCatchmentStation({ catchment: { stationId: 's', patch: [{ source: 'station', stationId: 't' }] } }, 't')).toEqual({ catchment: { stationId: 't', patch: [] } });
	});

	it('sets the priority, the default stored as none, the main station left out; nothing without a station', () => {
		const rs = { catchment: { stationId: 's' } };
		expect(withCatchmentPatch(rs, [{ source: 'station', stationId: 't' }, { source: 'chirps' }])).toEqual({
			catchment: { stationId: 's', patch: [{ source: 'station', stationId: 't' }, { source: 'chirps' }] }
		});
		expect(withCatchmentPatch(rs, [{ source: 'chirps' }])).toEqual(rs);
		expect(withCatchmentPatch(rs, [])).toEqual({ catchment: { stationId: 's', patch: [] } });
		expect(withCatchmentPatch(rs, [{ source: 'station', stationId: 's' }, { source: 'chirps' }])).toEqual(rs);
		expect(withCatchmentPatch({ units: { a: { stationId: 's' } } }, [])).toEqual({ units: { a: { stationId: 's' } } });
		expect(withCatchmentPatch(null, [])).toBeNull();
	});
});

describe('withCatchmentScale and withCatchmentCorrectAgainst', () => {
	it('store the defaults as none, so the catchment keeps what it had; nothing without a station', () => {
		const rs = { catchment: { stationId: 's' } };
		expect(withCatchmentScale(rs, false)).toEqual({ catchment: { stationId: 's', scaleToMap: false } });
		expect(withCatchmentScale(withCatchmentScale(rs, false), true)).toEqual(rs);
		expect(withCatchmentCorrectAgainst(rs, 't')).toEqual({ catchment: { stationId: 's', correctAgainst: 't' } });
		expect(withCatchmentCorrectAgainst(withCatchmentCorrectAgainst(rs, 't'), 's')).toEqual(rs);
		expect(withCatchmentCorrectAgainst(withCatchmentCorrectAgainst(rs, 't'), '')).toEqual(rs);
		expect(withCatchmentScale(null, false)).toBeNull();
		expect(withCatchmentCorrectAgainst({ units: {} }, 't')).toEqual({ units: {} });
	});
});
