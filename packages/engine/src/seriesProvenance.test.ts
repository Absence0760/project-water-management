import { describe, expect, it } from 'vitest';
import { CHIRPS_V3_RNL, CHIRPS_V3_SAT, originLabel, provenanceError, provenanceKey, provenanceLabel, sameOrigin, sameProvenance, seriesOrigin, sourceError } from './seriesProvenance';

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

describe('series source and unit (issue #66, 107_series_source.sql)', () => {
	it('reads a row’s columns; none recorded is null, and a factor without a unit is dropped', () => {
		expect(seriesOrigin({})).toBeNull();
		expect(seriesOrigin({ source: 'DWS X1H001' })).toEqual({ source: 'DWS X1H001', unit: null, factor: null });
		expect(seriesOrigin({ sourceUnit: 'l/s', sourceUnitFactor: 0.001 })).toEqual({ source: null, unit: 'l/s', factor: 0.001 });
		expect(seriesOrigin({ source: null, sourceUnit: null, sourceUnitFactor: 5 })).toBeNull();
	});
	it('labels the source and the conversion', () => {
		expect(originLabel({ source: 'DWS X1H001', unit: 'l/s', factor: 0.001 }, 'm³/s')).toBe('DWS X1H001 · given in l/s (× 0.001 to m³/s)');
		expect(originLabel({ source: null, unit: 'm³/s', factor: 1 })).toBe('source not recorded · given in m³/s');
		expect(originLabel(null)).toBe('source not recorded');
	});
	it('compares source, unit and factor; none recorded equals only none', () => {
		const a = { source: 'x', unit: 'l/s', factor: 0.001 };
		expect(sameOrigin(a, { ...a })).toBe(true);
		expect(sameOrigin(a, { ...a, factor: 1 })).toBe(false);
		expect(sameOrigin(null, undefined)).toBe(true);
		expect(sameOrigin(null, a)).toBe(false);
	});
	it('validates a source as the database CHECK does: one line, 1–200 characters', () => {
		expect(sourceError('DWS X1H001')).toBeNull();
		expect(sourceError('  ')).toMatch(/blank/);
		expect(sourceError('x'.repeat(201))).toMatch(/200/);
		expect(sourceError('a\nb')).toMatch(/one line/);
		expect(sourceError(3)).toMatch(/text/);
	});
});
