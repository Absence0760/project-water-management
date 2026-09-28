import { describe, expect, it } from 'vitest';
import { CHIRPS_V3_RNL, CHIRPS_V3_SAT, provenanceError, provenanceKey, provenanceLabel, sameProvenance } from './seriesProvenance';

describe('series provenance', () => {
	const v2 = { product: 'CHIRPS', version: '2.0' };
	it('labels and keys a product and version, and an unrecorded one', () => {
		expect(provenanceLabel(v2)).toBe('CHIRPS v2.0');
		expect(provenanceLabel(null)).toBe('an unrecorded version');
		expect(provenanceKey(v2)).toBe('CHIRPS/2.0');
		expect(provenanceKey(null)).toBe('');
	});
	it('compares by product and version; unrecorded equals only unrecorded', () => {
		expect(sameProvenance(v2, { ...v2 })).toBe(true);
		expect(sameProvenance(v2, { ...v2, version: '3.0' })).toBe(false);
		// The product is part of it: v3.0's sat and rnl daily products are different forcings.
		expect(sameProvenance(CHIRPS_V3_SAT, CHIRPS_V3_RNL)).toBe(false);
		expect(provenanceLabel(CHIRPS_V3_RNL)).toBe('CHIRPS rnl v3.0');
		expect(sameProvenance(null, undefined)).toBe(true);
		expect(sameProvenance(null, v2)).toBe(false);
		expect(sameProvenance(v2, null)).toBe(false);
	});
	it('validates with the same rules as the database CHECKs', () => {
		expect(provenanceError(v2)).toBeNull();
		expect(provenanceError({ product: 'CHIRPS', version: '' })).toMatch(/version/);
		expect(provenanceError({ product: ' CHIRPS', version: '2.0' })).toMatch(/product/);
		expect(provenanceError({ product: 'x'.repeat(41), version: '2.0' })).toMatch(/product/);
		expect(provenanceError({ product: 'CHIRPS', version: '2 0' })).toMatch(/version/);
		expect(provenanceError(null)).toMatch(/not a product/);
	});
});
