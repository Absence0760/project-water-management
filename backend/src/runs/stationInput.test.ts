// productFor (runs/stationInput.ts): a station's cell is read in the CHIRPS
// v3 product of the series the run reads for the area its pairing corrects,
// never a feed's on its own (issue #561). The DB side: stations.db.test.ts.
import { CHIRPS_V2, CHIRPS_V3_RNL, CHIRPS_V3_SAT, type DailySeries, type SeriesProvenance } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { productFor } from './stationInput.js';

const chirps = (provenance: SeriesProvenance | null): DailySeries => ({ startDate: '2012-01-01', values: [1], provenance });

describe('productFor', () => {
	it('takes the catchment record’s product when the station corrects the catchment', () => {
		const rs = { catchment: { stationId: 's' } };
		expect(productFor('s', rs, { rain_chirps_mm: chirps(CHIRPS_V3_SAT) })).toBe('sat');
		expect(productFor('s', rs, { rain_chirps_mm: chirps(CHIRPS_V3_RNL) })).toBe('rnl');
	});

	it('prefers the first unit it corrects, by node id, whose own CHIRPS is v3', () => {
		const rs = { catchment: { stationId: 's' }, units: { b: { stationId: 's' }, a: { stationId: 'x', correctAgainst: 's' }, c: { stationId: 's' } } };
		const series = { rain_chirps_mm: chirps(CHIRPS_V3_RNL), 'rain_chirps_mm@a': chirps(CHIRPS_V2), 'rain_chirps_mm@b': chirps(CHIRPS_V3_SAT), 'rain_chirps_mm@c': chirps(CHIRPS_V3_RNL) };
		expect(productFor('s', rs, series)).toBe('sat');
		// A unit that isn't corrected against it doesn't count, however it sorts.
		expect(productFor('s', { units: { a: { stationId: 'x' }, b: { stationId: 's' } } }, { 'rain_chirps_mm@a': chirps(CHIRPS_V3_SAT), 'rain_chirps_mm@b': chirps(CHIRPS_V3_RNL) })).toBe('rnl');
	});

	it('falls back to rnl for a record that isn’t CHIRPS v3, or none, and for a station that corrects nothing', () => {
		const rs = { catchment: { stationId: 's' } };
		expect(productFor('s', rs, { rain_chirps_mm: chirps(CHIRPS_V2) })).toBe('rnl');
		expect(productFor('s', rs, { rain_chirps_mm: chirps(null) })).toBe('rnl');
		expect(productFor('s', rs, {})).toBe('rnl');
		expect(productFor('other', rs, { rain_chirps_mm: chirps(CHIRPS_V3_SAT) })).toBe('rnl');
	});
});
