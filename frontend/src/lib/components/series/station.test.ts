// A rainfall station's details in Series details (issue #553): which series
// are stations, the draft the form saves, and its problems, which must agree
// with the API's rule (engine rainStationError). The form in the browser:
// e2e/tests/flow-share-hint.spec.ts.
import { rainStationError, type SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asksStation, stationChanged, stationDraft, stationFromDraft, stationMapText, stationPlaceText, stationProblem } from './station';

const meta = (kind: string, more: Partial<SeriesMeta> = {}): Pick<SeriesMeta, 'kind' | 'siteNodeId'> => ({ kind, ...more });
const draft = (more: Partial<ReturnType<typeof stationDraft>> = {}) => ({ ...stationDraft(null), ...more });

describe('asksStation', () => {
	it('is a catchment rain series with no site only', () => {
		expect(asksStation(meta('rain_catchment_mm'))).toBe(true);
		expect(asksStation(meta('rain_catchment_mm', { siteNodeId: null }))).toBe(true);
		expect(asksStation(meta('rain_catchment_mm', { siteNodeId: 'u1' }))).toBe(false);
		expect(asksStation(meta('rain_chirps_mm'))).toBe(false);
		expect(asksStation(meta('flow_observed_m3s'))).toBe(false);
	});
});

describe('stationFromDraft', () => {
	it('is null once every field is empty, and drops a source without a MAP', () => {
		expect(stationFromDraft(draft())).toBeNull();
		expect(stationFromDraft(draft({ mapSource: 'orphan' }))).toBeNull();
		expect(stationFromDraft(draft({ lat: -33.9, lon: 18.9, mapSource: 'orphan' }))).toEqual({ mapMm: null, mapSource: null, lat: -33.9, lon: 18.9 });
	});

	it('trims the source and round-trips a stored station', () => {
		const stored = { mapMm: 745, mapSource: 'station record', lat: -33.9, lon: 18.9 };
		expect(stationFromDraft(draft({ mapMm: 745, mapSource: '  station record ' }))).toEqual({ ...stored, lat: null, lon: null });
		expect(stationFromDraft(stationDraft(stored))).toEqual(stored);
		expect(stationChanged(stationDraft(stored), stored)).toBe(false);
		expect(stationChanged(draft({ ...stored, mapMm: 750 }), stored)).toBe(true);
		expect(stationChanged(draft(), null)).toBe(false);
		expect(stationChanged(draft({ mapSource: 'typed alone' }), null)).toBe(false);
	});
});

describe('stationProblem', () => {
	it('names the field: a MAP out of range, a MAP without its source, half a position', () => {
		expect(stationProblem(draft({ mapMm: 0, mapSource: 's' }))).toEqual({ field: 'map', message: 'The station’s MAP must be 1 to 12000 mm.' });
		expect(stationProblem(draft({ mapMm: 745, mapSource: ' ' }))?.field).toBe('source');
		expect(stationProblem(draft({ mapMm: 745, mapSource: 'x'.repeat(601) }))).toEqual({ field: 'source', message: 'MAP source longer than 600 characters.' });
		expect(stationProblem(draft({ lat: -33.9 }))).toEqual({ field: 'coords', message: 'A station’s coordinates need both a latitude and a longitude, or neither.' });
		expect(stationProblem(draft({ lat: -91, lon: 18 }))?.field).toBe('coords');
		expect(stationProblem(draft({ mapMm: 745, mapSource: 'record', lat: -33.9, lon: 18.9 }))).toBeNull();
		expect(stationProblem(draft())).toBeNull();
	});

	it('blocks exactly what the API refuses', () => {
		for (const d of [
			draft({ mapMm: 745, mapSource: 'record' }),
			draft({ mapMm: 0, mapSource: 'record' }),
			draft({ mapMm: 12_001, mapSource: 'record' }),
			draft({ mapMm: 745 }),
			draft({ lat: 10 }),
			draft({ lon: 10 }),
			draft({ lat: 10, lon: 181 }),
			draft({ lat: 10, lon: -180 })
		]) {
			const st = stationFromDraft(d);
			expect(stationProblem(d) === null, JSON.stringify(d)).toBe(st === null || rainStationError(st) === null);
		}
	});
});

describe('read-outs', () => {
	it('say the MAP with its source and the position, or nothing when not recorded', () => {
		expect(stationMapText({ mapMm: 745.25, mapSource: 'record', lat: null, lon: null })).toBe('745.3 mm (record)');
		expect(stationMapText({ mapMm: null, mapSource: null, lat: 1, lon: 2 })).toBeNull();
		expect(stationMapText(null)).toBeNull();
		expect(stationPlaceText({ mapMm: null, mapSource: null, lat: -33.92, lon: 18.86 })).toBe('−33.9200, 18.8600');
		expect(stationPlaceText({ mapMm: 1, mapSource: 's', lat: null, lon: null })).toBeNull();
	});
});
