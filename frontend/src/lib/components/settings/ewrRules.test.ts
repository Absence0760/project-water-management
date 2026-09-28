import { blankEwrRuleTable, type EwrRuleTable } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import {
	applyPaste,
	EXAMPLE_HIGH_FLOWS_CSV,
	exampleGridCsv,
	naturalComplete,
	newTable,
	parseGrid,
	parseHighFlows,
	parseMonths,
	parsePoints,
	rulesError,
	setLowFlowSplit,
	setPoints,
	siteOptions,
	tableErrors,
	type ParsedGrid
} from './ewrRules';

// Synthetic tables only: invented, round numbers (public repo).
const WY = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'];
const row = (m: number) => [3 + m, 2 + m, 1 + m].map((v) => v / 10);

function table(over: Partial<EwrRuleTable> = {}): EwrRuleTable {
	return { ...blankEwrRuleTable(), source: 'Synthetic', points: [10, 50, 90], ewr: WY.map((_, m) => row(m)), ...over };
}

const parsed = (text: string): ParsedGrid => {
	const r = parseGrid(text);
	if ('error' in r) throw new Error(r.error);
	return r;
};

describe('siteOptions', () => {
	const nodes = [
		{ id: 'o', name: 'Lower weir', kind: 'gauge' as const, downstreamNodeId: null, sortOrder: 0 },
		{ id: 'g2', name: 'Upper gauge', kind: 'gauge' as const, downstreamNodeId: 'o', sortOrder: 2 },
		{ id: 'f', name: 'Farm', kind: 'farm' as const, downstreamNodeId: 'o', sortOrder: 1 },
		{ id: 'g1', name: 'Mid gauge', kind: 'gauge' as const, downstreamNodeId: 'o', sortOrder: 1 }
	];
	it('lists the outlet, then the other gauges in network order, never a farm', () => {
		expect(siteOptions(nodes)).toEqual([
			{ id: null, label: 'Outlet (Lower weir)' },
			{ id: 'g1', label: 'Gauge: Mid gauge' },
			{ id: 'g2', label: 'Gauge: Upper gauge' }
		]);
	});
	it('keeps an option for a stored site whose node is gone', () => {
		expect(siteOptions(nodes, [null, 'gone']).at(-1)).toEqual({ id: 'gone', label: 'A node no longer in the network' });
	});
	it('offers a new table at the first site without one', () => {
		const opts = siteOptions(nodes);
		expect(newTable(opts, [{ siteNodeId: null }])!.siteNodeId).toBe('g1');
		expect(newTable(opts, [{ siteNodeId: null }, { siteNodeId: 'g1' }, { siteNodeId: 'g2' }])).toBeNull();
	});
});

describe('errors', () => {
	it('names the field with the engine’s message, and summarises the list', () => {
		expect(tableErrors(table())).toEqual({});
		expect(tableErrors(table({ source: '' }))).toEqual({ source: 'Say where the table comes from (Reserve determination, gazette notice, table).' });
		expect(rulesError([table()])).toBeNull();
		expect(rulesError([table({ source: '' }), table({ siteNodeId: 'g', points: [10] })])).toBe('2 rule tables have a problem to fix.');
		expect(rulesError([table(), table()])).toBe('Each EWR site can have one rule table.');
	});

	it('the determination’s natural MAR (engine ≥ 1.11.0) is optional; a cleared input (null) is fine, 0 is not', () => {
		expect(tableErrors(table({ naturalMarMcm: 12.5 }))).toEqual({});
		expect(tableErrors(table({ naturalMarMcm: null }))).toEqual({});
		expect(tableErrors(table({ naturalMarMcm: 0 }))).toEqual({ naturalMarMcm: 'The natural MAR must be above 0 and at most 1\u202f000\u202f000 Mm³ a year, or left blank.' });
	});
});

describe('points', () => {
	it('parses a list with commas, spaces, semicolons or % signs', () => {
		expect(parsePoints('10, 20 30;40%')).toEqual([10, 20, 30, 40]);
		expect(parsePoints('10, x')).toBeNull();
		expect(parsePoints('  ')).toBeNull();
	});
	it('keeps each value under its point when the points change, and leaves new points blank', () => {
		const t = setPoints(table({ naturalSource: 'table', natural: WY.map(() => [9, 8, 7]) }), [10, 70, 90]);
		expect(t.points).toEqual([10, 70, 90]);
		expect(t.ewr[0]).toEqual([0.3, NaN, 0.1]);
		expect(t.natural![0]).toEqual([9, NaN, 7]);
		expect(tableErrors(t).ewr).toMatch(/must be numbers/);
	});
});

describe('parseGrid', () => {
	it('reads a tab-separated paste with a heading row and month names, in any month order', () => {
		// Calendar order Jan … Dec, as a spreadsheet might have it.
		const cal = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		const text = ['Month\t10%\t50%\t90%', ...cal.map((m) => `${m}\t${row(WY.indexOf(m)).join('\t')}`)].join('\n');
		const g = parsed(text);
		expect(g.points).toEqual([10, 50, 90]);
		expect(g.monthLabels).toBe(true);
		expect(g.rows).toEqual(WY.map((_, m) => row(m)));
		expect(g.notes).toEqual([]);
	});

	it('reads range headings as their upper bound, and says so', () => {
		const text = ['\t0-10\t40-50\t90-99', ...WY.map((m, i) => `${m}\t${row(i).join('\t')}`)].join('\n');
		const g = parsed(text);
		expect(g.points).toEqual([10, 50, 99]);
		expect(g.notes[0]).toMatch(/^Range headings/);
	});

	it('reads decimal commas in a tab- or semicolon-separated paste, and commas as separators in a CSV', () => {
		const tab = parsed(WY.map((m) => `${m}\t1,25\t0,5\t0`).join('\n'));
		expect(tab.rows[0]).toEqual([1.25, 0.5, 0]);
		expect(tab.notes).toEqual(['Decimal commas were read as decimal points (1,207 = 1.207).']);
		const semi = parsed(WY.map(() => '1,25;0,5;0').join('\n'));
		expect(semi.rows[11]).toEqual([1.25, 0.5, 0]);
		const csv = parsed(WY.map((m) => `${m},1.25,0.5,0`).join('\n'));
		expect(csv.rows[3]).toEqual([1.25, 0.5, 0]);
		expect(csv.notes).toEqual([]);
	});

	it('reads a space-separated paste (a PDF) without labels as Oct … Sep, full month names too', () => {
		const plain = parsed(WY.map((_, i) => row(i).join('   ')).join('\n'));
		expect(plain.monthLabels).toBe(false);
		expect(plain.rows[5]).toEqual(row(5));
		const full = ['October', 'November', 'December', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September'];
		expect(parsed(full.map((m, i) => `${m} ${row(i).join(' ')}`).join('\n')).rows[9]).toEqual(row(9));
	});

	it('says what is wrong with a paste that isn’t a 12-month table', () => {
		expect(parseGrid('')).toEqual({ error: 'Paste the table first.' });
		expect(parseGrid(WY.slice(1).map(() => '1 2 3').join('\n'))).toEqual({ error: 'Expected 12 rows, one per month (Oct … Sep); the paste has 11.' });
		expect(parseGrid(WY.map((m, i) => `${m} ${i === 2 ? '1 2' : '1 2 3'}`).join('\n'))).toEqual({ error: 'Every row needs the same number of values.' });
		expect(parseGrid(WY.map((m, i) => `${m} ${i === 4 ? '1 x 3' : '1 2 3'}`).join('\n'))).toEqual({ error: "Feb has a value that isn't a number." });
		expect(parseGrid([...WY.slice(0, 11), 'Oct'].map((m) => `${m} 1 2 3`).join('\n'))).toEqual({ error: 'Oct appears twice.' });
		const head = ['10% 50%', ...WY.map(() => '1 2 3')].join('\n');
		expect(parseGrid(head)).toEqual({ error: 'The heading has 2 % points but the rows have 3 values.' });
	});
});

describe('applyPaste', () => {
	it('fills the EWR or natural grid, taking the heading’s points', () => {
		const t = table();
		const g = parsed(['10% 30% 50% 90%', ...WY.map(() => '4 3 2 1')].join('\n'));
		const out = applyPaste(t, 'natural', g) as EwrRuleTable;
		expect(out.points).toEqual([10, 30, 50, 90]);
		expect(out.natural![0]).toEqual([4, 3, 2, 1]);
		// The EWR columns stay under their points; 30 % is new and blank.
		expect(out.ewr[0]).toEqual([0.3, NaN, 0.2, 0.1]);
	});
	it('needs one value per point without a heading', () => {
		expect(applyPaste(table(), 'ewr', parsed(WY.map(() => '1 2').join('\n')))).toEqual({
			error: 'The paste has 2 values a row but the table has 3 % points: paste the heading row too, or change the points first.'
		});
		expect((applyPaste(table(), 'ewr', parsed(WY.map(() => '3 2 1').join('\n'))) as EwrRuleTable).ewr[11]).toEqual([3, 2, 1]);
	});
});

describe('low flows of a total table (engine ≥ 0.33.0)', () => {
	it('splits a blank low-flow grid out of a total table, keeps one it has, and drops it on request', () => {
		const on = setLowFlowSplit(table(), true);
		expect(on.lowFlow).toHaveLength(12);
		expect(on.lowFlow![0]).toEqual([null, null, null]);
		// Blank cells block Save until filled.
		expect(tableErrors(on).lowFlow).toMatch(/^Low-flow values must be numbers/);
		const filled = { ...on, lowFlow: WY.map(() => [0.2, 0.1, 0.05]) };
		expect(tableErrors(filled)).toEqual({});
		expect(setLowFlowSplit(filled, true).lowFlow).toBe(filled.lowFlow);
		expect(setLowFlowSplit(filled, false).lowFlow).toBeNull();
		// A low-flow table has no separate low-flow grid.
		expect(setLowFlowSplit(table({ component: 'lowFlow' }), true).lowFlow).toBeNull();
	});

	it('pastes the low flows, and keeps them under their points when the points change', () => {
		const t = setLowFlowSplit(table(), true);
		const out = applyPaste(t, 'lowFlow', parsed(WY.map(() => '0.3 0.2 0.1').join('\n'))) as EwrRuleTable;
		expect(out.lowFlow![5]).toEqual([0.3, 0.2, 0.1]);
		expect(setPoints(out, [10, 90]).lowFlow![0]).toEqual([0.3, 0.1]);
	});

	it('reads the synthetic example CSVs back as full tables at the DRM points', () => {
		for (const kind of ['total', 'lowFlow'] as const) {
			const g = parsed(exampleGridCsv(kind));
			expect(g.points).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 99]);
			expect(g.monthLabels).toBe(true);
			expect(g.rows).toHaveLength(12);
			// Falling with the % point, as a duration curve does.
			for (const r of g.rows) expect(r.every((v, i) => i === 0 || v <= r[i - 1]!)).toBe(true);
		}
		const total = parsed(exampleGridCsv('total')).rows;
		const low = parsed(exampleGridCsv('lowFlow')).rows;
		expect(low.every((r, m) => r.every((v, i) => v <= total[m]![i]!))).toBe(true);
	});
});

describe('high-flow components (engine ≥ 0.33.0)', () => {
	it('parseMonths reads names, numbers and ranges that wrap the year', () => {
		expect(parseMonths('Nov, Dec, Jan')).toEqual([11, 12, 1]);
		expect(parseMonths('11 12 1')).toEqual([11, 12, 1]);
		expect(parseMonths('Nov-Jan')).toEqual([11, 12, 1]);
		expect(parseMonths('Nov–Jan')).toEqual([11, 12, 1]);
		expect(parseMonths('October/march')).toEqual([10, 3]);
		expect(parseMonths('Jan Jan')).toEqual([1]);
		expect(parseMonths('')).toBeNull();
		expect(parseMonths('13')).toBeNull();
		expect(parseMonths('Nov-Foo')).toBeNull();
	});

	it('parseHighFlows reads the example CSV, a tab-separated paste and a quoted months cell', () => {
		expect(parseHighFlows(EXAMPLE_HIGH_FLOWS_CSV)).toEqual([
			{ label: 'Class I freshet', months: [10, 11], peakM3s: 2.5, durationDays: 2, perYear: 2 },
			{ label: 'Class II flood', months: [12, 1, 2, 3], peakM3s: 8, durationDays: 3, perYear: 1 }
		]);
		expect(parseHighFlows('Freshet\tNov Dec\t1,5\t2\t1')).toEqual([{ label: 'Freshet', months: [11, 12], peakM3s: 1.5, durationDays: 2, perYear: 1 }]);
		expect(parseHighFlows('Flood,"Dec, Jan",9,3,1')).toEqual([{ label: 'Flood', months: [12, 1], peakM3s: 9, durationDays: 3, perYear: 1 }]);
	});

	it('parseHighFlows says what is wrong with a row', () => {
		expect(parseHighFlows('')).toEqual({ error: 'Paste the high flows first.' });
		expect(parseHighFlows('Flood,Dec,9')).toEqual({ error: 'Row 1 needs five cells: name, months, peak (m³/s), duration (days), events per year.' });
		expect(parseHighFlows('Flood,Decx,9,3,1')).toEqual({ error: 'Row 1: “Decx” isn\'t a list of months (e.g. Nov-Jan, or Nov Dec Jan).' });
		expect(parseHighFlows('Name,Months,Peak,Days,Per year\nFlood,Dec,x,3,1')).toEqual({ error: "Row 2 has a value that isn't a number." });
		expect(parseHighFlows('Name,Months,Peak,Days,Per year')).toEqual({ error: 'No high-flow rows under the heading.' });
		expect(parseHighFlows(Array.from({ length: 13 }, () => 'F,Dec,1,1,1').join('\n'))).toEqual({ error: 'At most 12 high-flow components per table; the paste has 13.' });
	});

	it('a component that cannot fit in a year blocks Save through the engine check', () => {
		expect(tableErrors(table({ highFlows: [{ label: 'F', months: [1], peakM3s: 1, durationDays: 90, perYear: 5 }] })).highFlows).toBe("High flow 1: 5 events of 90 days don't fit in a year.");
		expect(rulesError([table({ highFlows: [{ label: '', months: [1], peakM3s: 1, durationDays: 1, perYear: 1 }] })])).toBe('1 rule table has a problem to fix.');
	});
});

describe('naturalComplete', () => {
	it('is true only when every cell is a number of 0 or more', () => {
		expect(naturalComplete([[1, 0], [2, 3]])).toBe(true);
		expect(naturalComplete([[1, null], [2, 3]])).toBe(false);
		expect(naturalComplete([[1, NaN]])).toBe(false);
		expect(naturalComplete([[-1]])).toBe(false);
	});
});
