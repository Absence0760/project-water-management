import { describe, expect, it } from 'vitest';
import { defaultUnit, kindLabel, KIND_OPTIONS, seriesKindLabel } from './kinds';

describe('series kinds', () => {
	it('labels every engine kind and infers units', () => {
		expect(KIND_OPTIONS.every((o) => o.label !== o.value)).toBe(true);
		expect(kindLabel('unknown_kind')).toBe('unknown_kind');
		expect(defaultUnit('rain_catchment_mm')).toBe('mm');
		expect(defaultUnit('flow_observed_m3s')).toBe('m³/s');
		expect(defaultUnit('other')).toBe('');
	});

	it('names a rainfall station as a station, not the catchment rain kind it is stored as (issue #589)', () => {
		const details = { mapMm: 745, mapSource: 'Station record', lat: null, lon: null };
		expect(seriesKindLabel({ kind: 'rain_catchment_mm', siteNodeId: null, station: details })).toBe('Rainfall — station');
		// Catchment rain without a station's details keeps its label, as does a unit's or a gauge's own rain.
		expect(seriesKindLabel({ kind: 'rain_catchment_mm', siteNodeId: null, station: null })).toBe('Rainfall — catchment');
		expect(seriesKindLabel({ kind: 'rain_catchment_mm' })).toBe('Rainfall — catchment');
		expect(seriesKindLabel({ kind: 'rain_catchment_mm', siteNodeId: 'u1', station: details })).toBe('Rainfall — catchment');
		expect(seriesKindLabel({ kind: 'rain_chirps_mm', station: details })).toBe(kindLabel('rain_chirps_mm'));
	});
});
