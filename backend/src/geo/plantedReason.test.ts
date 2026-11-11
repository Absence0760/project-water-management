import { describe, expect, it } from 'vitest';
import { REASON_MAX } from '../history/record.js';
import { plantedReason } from './croplandRoutes.js';

const d = { dataset: 'SANLC-2022', source: 'South African National Land Cover 2022', version: '2022' };
const method = 'Cells counted where the product maps permanent orchards, weighted by their overlap with each parcel, summed per unit. '.repeat(10);

describe('plantedReason', () => {
	it('names what was taken, the whole citation, then the method', () => {
		expect(plantedReason('Planted area of Citrus on Upper from land cover: 1.00 ha cultivated in its 2 parcels', d, 'Weighted by overlap.')).toBe(
			'Planted area of Citrus on Upper from land cover: 1.00 ha cultivated in its 2 parcels; South African National Land Cover 2022 (2022; dataset “SANLC-2022”). Weighted by overlap.'
		);
	});

	it('cuts a long method on a whole word, keeping the citation whole', () => {
		const reason = plantedReason('Planted area of Citrus on Upper from crop types: 1.00 ha of orchards in its 2 parcels', d, method);
		expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
		expect(reason).toContain('; South African National Land Cover 2022 (2022; dataset “SANLC-2022”). Cells counted');
		expect(reason).toMatch(/ [a-z,]*[a-z]…$/);
		const kept = reason.slice(0, -1).split(' ').at(-1)!;
		expect(method.split(/[\s,.]+/)).toContain(kept);
	});

	it('cites the short reference when a long source would crowd out the rest', () => {
		const long = { ...d, source: 's'.repeat(500), version: 'v1' };
		const reason = plantedReason(`Planted area of ${'C'.repeat(200)} on Upper from land cover`, long, method);
		expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
		expect(reason).toContain('; dataset “SANLC-2022” (v1). Cells counted');
	});
});
