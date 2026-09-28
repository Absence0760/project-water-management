import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { apanDailyOfInput, apanDailyOfValues, asksFreeProvenance, asksProvenance, freeProvenanceFields, CHIRPS_CHOICES, chirpsSourceOf, chirpsSourceOfInput, describeProvenance, provenanceFields, rebuildingNote, seriesProvenance } from './provenance';

describe('series provenance choices', () => {
	it('asks only for a CHIRPS series, offering v2.0 and v3.0’s two daily products', () => {
		expect(asksProvenance('rain_chirps_mm')).toBe(true);
		expect(asksProvenance('rain_catchment_mm')).toBe(false);
		expect(CHIRPS_CHOICES).toEqual([
			{ value: 'CHIRPS/2.0', label: 'CHIRPS v2.0' },
			{ value: 'CHIRPS sat/3.0', label: 'CHIRPS sat v3.0' },
			{ value: 'CHIRPS rnl/3.0', label: 'CHIRPS rnl v3.0' }
		]);
	});

	it('turns a choice into the request fields and a series back into its label', () => {
		expect(provenanceFields('CHIRPS sat/3.0')).toEqual({ product: 'CHIRPS sat', productVersion: '3.0' });
		expect(provenanceFields('')).toEqual({ product: null, productVersion: null });
		expect(seriesProvenance({ product: 'CHIRPS', productVersion: '2.0' })).toEqual({ product: 'CHIRPS', version: '2.0' });
		expect(seriesProvenance({ product: null, productVersion: null })).toBeNull();
		expect(seriesProvenance(undefined)).toBeNull();
		expect(describeProvenance({ product: 'CHIRPS', productVersion: '2.0' })).toBe('CHIRPS v2.0');
		expect(describeProvenance({})).toBe('version not recorded');
	});

	it('notes a series a feed is replacing, for the Data and Runs tabs', () => {
		const label = (s: { kind: string; name: string }) => s.name || s.kind;
		expect(rebuildingNote([{ kind: 'rain_chirps_mm', name: '', rebuilding: false }], label)).toBeNull();
		expect(rebuildingNote(null, label)).toBeNull();
		expect(rebuildingNote([{ kind: 'rain_chirps_mm', name: 'Grid', rebuilding: true }, { kind: 'rain_catchment_mm', name: '' }], label)).toBe(
			'A data feed is replacing Grid with another CHIRPS product or version. Runs use the current series until the replacement completes; refit after it does.'
		);
	});

	it('finds the CHIRPS label a run would use: the first CHIRPS series, and says when it can’t know', () => {
		const v2 = { product: 'CHIRPS', productVersion: '2.0' };
		expect(chirpsSourceOf([{ kind: 'rain_catchment_mm' }, { kind: 'rain_chirps_mm', ...v2 }, { kind: 'rain_chirps_mm', product: 'CHIRPS sat', productVersion: '3.0' }])).toEqual({
			product: 'CHIRPS',
			version: '2.0'
		});
		expect(chirpsSourceOf([{ kind: 'rain_chirps_mm', product: null, productVersion: null }])).toBeNull();
		expect(chirpsSourceOf([])).toBeNull();
		expect(chirpsSourceOf(null)).toBeUndefined();
		// A run's snapshot: absent provenance is a run from before it was recorded.
		expect(chirpsSourceOfInput({ rain_chirps_mm: { provenance: { product: 'CHIRPS', version: '2.0' } } })).toEqual({ product: 'CHIRPS', version: '2.0' });
		expect(chirpsSourceOfInput({ rain_chirps_mm: { provenance: null } })).toBeNull();
		expect(chirpsSourceOfInput({ rain_chirps_mm: {} })).toBeUndefined();
		expect(chirpsSourceOfInput({})).toBeNull();
		expect(chirpsSourceOfInput(undefined)).toBeUndefined();
	});
});

describe('free product and version (the alternative gauge and the reanalysis, issue #40 (b))', () => {
	it('asks for them on those kinds only, and sends both or neither', () => {
		expect(asksFreeProvenance('rain_catchment_alt_mm')).toBe(true);
		expect(asksFreeProvenance('rain_reanalysis_mm')).toBe(true);
		expect(asksFreeProvenance('rain_chirps_mm')).toBe(false);
		expect(freeProvenanceFields(' SASSCAL AWS ', ' 1 ')).toEqual({ product: 'SASSCAL AWS', productVersion: '1' });
		expect(freeProvenanceFields('ERA5', ' ')).toBeNull();
		expect(freeProvenanceFields('', '')).toBeNull();
	});
});

describe('the daily A-pan fingerprint (issue #45)', () => {
	it('hashes the values as the backend does (SHA-256 of their JSON), so a fit and a run snapshot compare', async () => {
		const values = [5, null, 6.25, 0];
		const want = createHash('sha256').update(JSON.stringify(values)).digest('hex');
		expect(await apanDailyOfValues({ startDate: '2020-10-01', values })).toEqual({ startDate: '2020-10-01', length: 4, valuesSha256: want });
		expect(await apanDailyOfValues(undefined)).toBeNull();
	});

	it('reads it from a run snapshot: null without the series, undefined when unknown or unhashed', () => {
		const snap = { startDate: '2020-10-01', length: 4, valuesSha256: 'e'.repeat(64) };
		expect(apanDailyOfInput({ evap_apan_mm: snap })).toEqual(snap);
		expect(apanDailyOfInput({ rain_catchment_mm: snap })).toBeNull();
		expect(apanDailyOfInput(undefined)).toBeUndefined();
		expect(apanDailyOfInput({ evap_apan_mm: { startDate: '2020-10-01', length: 4 } })).toBeUndefined();
	});
});
