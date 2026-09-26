import { compareAllocations } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { AllocationPreviewRow } from '$lib/api/types';
import { comparisonRows, overSummary, previewOrder, STATUS_LABEL, statusSentence, TEMPLATE_CSV, waterYearLabel } from './allocations';

const comparison = () =>
	compareAllocations({
		startDate: '2001-10-01',
		nodes: [
			{ nodeId: 'A', name: 'Farm A', kind: 'farm', supplied: new Array(730).fill(100) },
			{ nodeId: 'B', name: 'Farm B', kind: 'farm', supplied: new Array(730).fill(10), groundwater: new Array(730).fill(10) }
		],
		allocations: [
			{ id: 'a', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 30_000 },
			{ id: 'b', nodeId: 'B', waterSource: 'groundwater', volumeM3PerYear: 3650 }
		]
	});

describe('allocation wording', () => {
	it('never uses a legal finding', () => {
		const words = [...Object.values(STATUS_LABEL), ...(['over', 'under', 'within', 'unregistered', 'none'] as const).map((status) => statusSentence({ status, ratio: 1.2, modelledM3: 10, registeredM3: 5 }, 0.1))].join(' ');
		expect(words).not.toMatch(/lawful|unlawful|illegal|legal|complian|violat|breach/i);
	});

	it('states the difference and the band', () => {
		expect(statusSentence({ status: 'over', ratio: 1.217, modelledM3: 36_500, registeredM3: 30_000 }, 0.1)).toBe(
			'Modelled use is 22 % above the registered volume (outside the ±10 % band).'
		);
		expect(statusSentence({ status: 'under', ratio: 0.5, modelledM3: 1, registeredM3: 2 }, 0.1)).toMatch(/50 % below/);
		expect(waterYearLabel(2009)).toBe('2009/10');
		expect(waterYearLabel(1999)).toBe('1999/00');
	});
});

describe('comparisonRows', () => {
	it('lists each farm and source with use or a volume, year by year', () => {
		const rows = comparisonRows(comparison());
		// Farm A: surface only (no groundwater at all); Farm B: groundwater only (all it takes is pumped).
		expect(rows.map((r) => `${r.name}:${r.source}:${r.year.waterYear}:${r.year.status}`)).toEqual([
			'Farm A:surface:2001:over',
			'Farm A:surface:2002:over',
			'Farm B:groundwater:2001:within',
			'Farm B:groundwater:2002:within'
		]);
	});

	it('summarises the years above the registered volume', () => {
		expect(overSummary(comparison())).toEqual([{ name: 'Farm A', source: 'surface', yearsOver: 2, wholeYears: 2 }]);
	});
});

describe('previewOrder', () => {
	const row = (line: number, extra: Partial<AllocationPreviewRow>): AllocationPreviewRow =>
		({ line, errors: [], nodeId: 'n', matchedBy: 'name', ...extra }) as AllocationPreviewRow;
	it('puts problems first, then unmatched rows, then matched ones', () => {
		const rows = [row(2, {}), row(3, { nodeId: null, matchedBy: null }), row(4, { errors: ['bad'] }), row(5, { nodeId: null, matchedBy: null })];
		expect(previewOrder(rows).map((r) => r.line)).toEqual([4, 3, 5, 2]);
	});
});

describe('TEMPLATE_CSV', () => {
	it('has the backend template header', () => {
		expect(TEMPLATE_CSV.split('\r\n')[0]).toBe(
			'registration_no,property_ref,farm,holder,authorisation,purpose,water_source,volume_m3_year,storage_m3,valid_from,valid_to,reference'
		);
	});
});
