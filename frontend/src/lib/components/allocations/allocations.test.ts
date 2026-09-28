import { compareAllocations } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { AllocationPreviewRow } from '$lib/api/types';
import { allocationsContext, comparisonRows, conditionsFromText, conditionsSummary, MODE_NOTE, monthsText, pickUnit, previewOrder, STATUS_LABEL, statusSentence, TEMPLATE_CSV, unitRows, unitStatusText, waterYearLabel } from './allocations';

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

});

describe('unitRows', () => {
	const many = () =>
		compareAllocations({
			startDate: '2001-10-01',
			nodes: [
				{ nodeId: 'W', name: 'Within', kind: 'farm', supplied: new Array(730).fill(100) },
				{ nodeId: 'U', name: 'Under', kind: 'farm', supplied: new Array(730).fill(50) },
				{ nodeId: 'N', name: 'Nothing', kind: 'farm', supplied: new Array(730).fill(0) },
				{ nodeId: 'O1', name: 'Over a bit', kind: 'farm', supplied: new Array(730).fill(150) },
				{ nodeId: 'R', name: 'Unregistered', kind: 'farm', supplied: new Array(730).fill(20) },
				{ nodeId: 'O2', name: 'Over a lot', kind: 'farm', supplied: new Array(730).fill(300) },
				{ nodeId: 'U2', name: 'Under less', kind: 'farm', supplied: new Array(730).fill(80) }
			],
			allocations: ['W', 'U', 'O1', 'O2', 'U2'].map((n) => ({ id: n, nodeId: n, waterSource: 'surface' as const, volumeM3PerYear: 36_500 }))
		});

	it('puts the rows to look into first: above registered, no registered volume, below, within', () => {
		const rows = unitRows(many());
		expect(rows.map((r) => `${r.name}:${r.status}`)).toEqual([
			'Over a lot:over',
			'Over a bit:over',
			'Unregistered:unregistered',
			'Under:under',
			'Under less:under',
			'Within:within'
		]);
		// Two whole water years: the figures are the mean year.
		expect(rows[0]).toMatchObject({ yearsOver: 2, wholeYears: 2, registeredM3: 36_500, partOnly: false });
		expect(rows[0]!.ratio).toBeCloseTo(3);
		expect(unitStatusText(rows[0]!)).toBe('Above registered in 2 of 2 whole years');
		expect(unitStatusText(rows[3]!)).toBe('Below registered');
	});

	it('is stable, and keeps each source apart', () => {
		const rows = unitRows(comparison());
		expect(rows.map((r) => r.key)).toEqual(['A:surface', 'B:groundwater']);
		expect(unitRows(comparison()).map((r) => r.key)).toEqual(rows.map((r) => r.key));
	});

	it('uses the part year when the run covers no whole water year', () => {
		const c = compareAllocations({
			startDate: '2001-10-01',
			nodes: [{ nodeId: 'A', name: 'Farm A', kind: 'farm', supplied: new Array(120).fill(100) }],
			allocations: [{ id: 'a', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 36_500 }]
		});
		const [r] = unitRows(c);
		expect(r).toMatchObject({ partOnly: true, wholeYears: 0, modelledM3: 12_000, status: 'within' });
		expect(r!.registeredM3).toBeCloseTo(12_000);
	});

	it('picks the unit in the URL, else the first row', () => {
		const rows = unitRows(many());
		expect(pickUnit(rows, 'W')).toBe('W');
		expect(pickUnit(rows, 'gone')).toBe('O2');
		expect(pickUnit(rows, null)).toBe('O2');
		expect(pickUnit([], null)).toBeNull();
	});

	it('says what the header counts', () => {
		const rows = unitRows(many());
		expect(allocationsContext(5, 0, rows)).toBe('5 registered volumes · 2 units above registered');
		expect(allocationsContext(1, 1, [])).toBe('1 registered volume · 1 not matched');
		expect(allocationsContext(0, 0, null)).toBe('No registered volumes yet');
		expect(allocationsContext(0, 0, unitRows(comparison()).filter((r) => r.status !== 'over'))).toBe('No registered volumes yet · no unit above registered');
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
			'registration_no,property_ref,farm,holder,authorisation,purpose,water_source,volume_m3_year,storage_m3,valid_from,valid_to,reference,months,max_rate_m3s,conditions'
		);
	});
});

describe('licence conditions (issue #72)', () => {
	it('writes months as runs over the new year, from the first in the water year', () => {
		expect(monthsText(null)).toBe('');
		expect(monthsText([])).toBe('');
		expect(monthsText([1, 2, 3, 10, 11, 12])).toBe('Oct–Mar');
		expect(monthsText([6, 8])).toBe('Jun, Aug');
		expect(monthsText([9, 10])).toBe('Sep–Oct');
		expect(monthsText([4, 5, 11])).toBe('Nov, Apr–May');
		expect(monthsText([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])).toBe('all year');
	});

	it('sums a volume’s conditions up in one line, or nothing when it states none', () => {
		expect(conditionsSummary({ months: null, maxRateM3s: null, conditions: [] })).toBeNull();
		expect(conditionsSummary({ months: [10, 11], maxRateM3s: 0.05, conditions: ['a', 'b'] })).toBe('Oct–Nov only · at most 0.05 m³/s · 2 conditions');
		expect(conditionsSummary({ months: null, maxRateM3s: 0, conditions: ['a'] })).toBe('at most 0 m³/s · 1 condition');
	});

	it('reads the conditions box one condition a line', () => {
		expect(conditionsFromText('  Stop below 0.2 m³/s \r\n\n Meter monthly\n')).toEqual(['Stop below 0.2 m³/s', 'Meter monthly']);
		expect(conditionsFromText('')).toEqual([]);
	});

	it('says what a run’s allocation mode did, and nothing for compare only', () => {
		expect(MODE_NOTE.none).toBeNull();
		expect(MODE_NOTE.cap).toMatch(/capped each unit’s use at its registered volume/);
		expect(MODE_NOTE.fullAllocation).toMatch(/every registered user took their entitlement/);
		for (const t of [MODE_NOTE.cap!, MODE_NOTE.fullAllocation!]) expect(t).not.toMatch(/lawful|unlawful|illegal|compliant/i);
	});
});
