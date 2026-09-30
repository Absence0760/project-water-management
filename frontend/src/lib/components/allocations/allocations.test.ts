import { compareAllocations } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { AllocationPreviewRow } from '$lib/api/types';
import { allocationsContext, capYearsText, comparisonRows, conditionsFromText, conditionsSummary, foldYears, MODE_NOTE, monthsText, pickUnit, previewOrder, rowsInListOrder, STATUS_LABEL, statusSentence, TEMPLATE_CSV, unitRows, unitStatusText, waterYearLabel } from './allocations';

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

	it('picks the hydrological unit in the URL, else the first row', () => {
		const rows = unitRows(many());
		expect(pickUnit(rows, 'W')).toBe('W');
		expect(pickUnit(rows, 'gone')).toBe('O2');
		expect(pickUnit(rows, null)).toBe('O2');
		expect(pickUnit([], null)).toBeNull();
	});

	it('says what the header counts', () => {
		const rows = unitRows(many());
		expect(allocationsContext(5, 0, rows)).toBe('5 registered volumes · 2 hydrological units above registered');
		expect(allocationsContext(1, 1, [])).toBe('1 registered volume · 1 not matched');
		expect(allocationsContext(0, 0, null)).toBe('No registered volumes yet');
		expect(allocationsContext(0, 0, unitRows(comparison()).filter((r) => r.status !== 'over'))).toBe('No registered volumes yet · no hydrological unit above registered');
	});
});

describe('the long tables, folded', () => {
	it('orders every unit\'s water years as the list does, each unit\'s years together and in order', () => {
		const c = compareAllocations({
			startDate: '2001-10-01',
			nodes: [
				{ nodeId: 'W', name: 'Within', kind: 'farm', supplied: new Array(730).fill(100) },
				{ nodeId: 'O', name: 'Over', kind: 'farm', supplied: new Array(730).fill(300), groundwater: new Array(730).fill(10) }
			],
			allocations: [
				{ id: 'w', nodeId: 'W', waterSource: 'surface', volumeM3PerYear: 36_500 },
				{ id: 'o', nodeId: 'O', waterSource: 'surface', volumeM3PerYear: 36_500 }
			]
		});
		const rows = rowsInListOrder(comparisonRows(c), unitRows(c));
		expect(rows.map((r) => `${r.nodeId}:${r.source}:${r.year.waterYear}`)).toEqual([
			'O:surface:2001',
			'O:surface:2002',
			'O:groundwater:2001',
			'O:groundwater:2002',
			'W:surface:2001',
			'W:surface:2002'
		]);
		// A row whose unit isn't on the list keeps its place after it.
		expect(rowsInListOrder(comparisonRows(c), []).map((r) => r.nodeId)).toEqual(['W', 'W', 'O', 'O', 'O', 'O']);
	});

	it('shows the picked unit\'s latest water years, both sources of each, until opened', () => {
		const c = compareAllocations({
			startDate: '2001-10-01',
			nodes: [{ nodeId: 'A', name: 'Farm A', kind: 'farm', supplied: new Array(365 * 10).fill(100), groundwater: new Array(365 * 10).fill(10) }],
			allocations: [{ id: 'a', nodeId: 'A', waterSource: 'surface', volumeM3PerYear: 36_500 }]
		});
		const rows = comparisonRows(c);
		const years = new Set(rows.map((r) => r.year.waterYear)).size;
		const f = foldYears(rows, false, 6);
		expect(f.folded).toBe(true);
		expect(f.years).toBe(years);
		expect(new Set(f.shown.map((r) => r.year.waterYear)).size).toBe(6);
		expect(Math.min(...f.shown.map((r) => r.year.waterYear))).toBe(Math.max(...rows.map((r) => r.year.waterYear)) - 5);
		expect(f.shown.filter((r) => r.source === 'groundwater')).toHaveLength(6);
		expect(foldYears(rows, true, 6)).toMatchObject({ shown: rows, folded: false });
		// One year more than the cap isn't worth a button.
		expect(foldYears(rows, false, years - 1).folded).toBe(false);
		expect(foldYears([], false, 6)).toEqual({ shown: [], years: 0, folded: false });
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

describe('capYearsText (engine 1.40.0)', () => {
	const at = (limitBound: { waterYear: number; days: number; volumeDays: number; rateDays: number; monthsDays: number }[] | null, reached: number[] = []) =>
		capYearsText({ nodeId: 'a', waterSource: 'surface', capReached: reached.map((waterYear) => ({ waterYear, budgetM3: 1, usedM3: 1 })), limitBound });

	it('says on how many days each limit held use back, then the years the volume was used up', () => {
		expect(
			at(
				[
					{ waterYear: 2003, days: 40, volumeDays: 30, rateDays: 4, monthsDays: 6 },
					{ waterYear: 2004, days: 200, volumeDays: 200, rateDays: 0, monthsDays: 0 }
				],
				[2003, 2004]
			)
		).toBe('The cap held use back on 240 days in 2 water years: 230 with the volume used up, 4 at the maximum rate, 6 outside the months of use. The registered volume was used up in 2003/04 and 2004/05.');
	});

	it('names a run held only to its months, which the volume alone reads as never reached', () => {
		expect(at([{ waterYear: 2005, days: 1, volumeDays: 0, rateDays: 0, monthsDays: 1 }])).toBe(
			'The cap held use back on 1 day in 1 water year: 1 outside the months of use. The registered volume was never used up.'
		);
	});

	it('says when the cap never held use back, and what an older run can’t say', () => {
		expect(at([])).toBe('The cap never held use back. The registered volume was never used up.');
		expect(capYearsText({ nodeId: 'a', waterSource: 'surface', capReached: [], limitBound: [] }, true)).toBe(
			'The cap never held use back. The registered volume was never used up. These counts include the run’s forecast days, which the comparison above leaves out.'
		);
		expect(at(null, [2003, 2004, 2006])).toBe(
			'The registered volume was used up in 2003/04, 2004/05 and 2006/07. (This run is from before the app counted the days the licence held use back; run the model again to see them.)'
		);
	});
});
