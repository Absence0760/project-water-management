import { blankEwrRuleTable, type EwrRuleTable } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { applyPaste, newTable, parseGrid, parsePoints, rulesError, setPoints, siteOptions, tableErrors, type ParsedGrid } from './ewrRules';

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
