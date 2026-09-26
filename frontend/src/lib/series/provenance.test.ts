import { describe, expect, it } from 'vitest';
import { asksProvenance, CHIRPS_CHOICES, chirpsSourceOf, chirpsSourceOfInput, describeProvenance, provenanceFields, seriesProvenance } from './provenance';

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
