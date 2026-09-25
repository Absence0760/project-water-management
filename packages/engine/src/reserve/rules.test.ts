import { describe, expect, it } from 'vitest';
import {
	blankEwrRuleTable,
	DEFAULT_ASSURANCE_POINTS,
	ewrRuleListIssues,
	ewrRuleTableIssues,
	ewrRuleTableNotes,
	resolveEwrRules,
	type EwrRuleTable
} from './rules';

/** A valid synthetic table: EWR = half the natural flow, falling with the % point. */
function table(over: Partial<EwrRuleTable> = {}): EwrRuleTable {
	const points = [10, 50, 90];
	return {
		siteNodeId: null,
		source: 'Synthetic test table',
		component: 'total',
		unit: 'mcm',
		points,
		ewr: Array.from({ length: 12 }, () => [1.5, 1, 0.5]),
		naturalSource: 'table',
		natural: Array.from({ length: 12 }, () => [3, 2, 1]),
		scale: 1,
		...over
	};
}
const fields = (t: EwrRuleTable) => ewrRuleTableIssues(t).map((i) => i.field);

describe('ewrRuleTableIssues', () => {
	it('accepts a complete table, and a blank one once it has a source', () => {
		expect(ewrRuleTableIssues(table())).toEqual([]);
		const blank = blankEwrRuleTable();
		expect(blank.points).toEqual([...DEFAULT_ASSURANCE_POINTS]);
		expect(fields(blank)).toEqual(['source']);
		expect(ewrRuleTableIssues({ ...blank, source: 'x' })).toEqual([]);
	});

	it('needs a source, known choices and a scale above 0', () => {
		expect(fields(table({ source: '  ' }))).toEqual(['source']);
		expect(fields(table({ source: 'x'.repeat(501) }))).toEqual(['source']);
		expect(fields(table({ unit: 'litres' as never }))).toEqual(['unit']);
		expect(fields(table({ component: 'floods' as never }))).toEqual(['component']);
		expect(fields(table({ naturalSource: 'gauge' as never }))).toEqual(['naturalSource']);
		for (const scale of [0, -1, NaN, 1001]) expect(fields(table({ scale }))).toEqual(['scale']);
	});

	it('needs 2–20 rising % points in (0, 100]', () => {
		expect(fields(table({ points: [50] }))).toEqual(['points']);
		expect(fields(table({ points: Array.from({ length: 21 }, (_, i) => i + 1) }))).toEqual(['points']);
		expect(ewrRuleTableIssues(table({ points: [0, 50, 90] }))[0]!.message).toBe('Each % point must be above 0 and at most 100.');
		expect(ewrRuleTableIssues(table({ points: [10, 50, 101] }))[0]!.message).toBe('Each % point must be above 0 and at most 100.');
		expect(ewrRuleTableIssues(table({ points: [10, 90, 50] }))[0]!.message).toBe('The % points must rise from left to right, each once.');
		expect(ewrRuleTableIssues(table({ points: [10, 50, 50] }))[0]!.message).toBe('The % points must rise from left to right, each once.');
	});

	it('needs 12 rows × points of numbers 0 … 1e6 for the EWR, and for the natural flow when it is the source', () => {
		const t = table();
		expect(ewrRuleTableIssues({ ...t, ewr: t.ewr.slice(1) })[0]).toEqual({ field: 'ewr', message: 'Enter 12 rows of EWR values (Oct … Sep).' });
		const short = t.ewr.map((r, m) => (m === 3 ? r.slice(1) : r));
		expect(ewrRuleTableIssues({ ...t, ewr: short })[0]!.message).toBe('Each EWR row needs one value per % point (Jan has 2 of 3).');
		const neg = t.ewr.map((r, m) => (m === 4 ? [1, -1, 0] : r));
		expect(ewrRuleTableIssues({ ...t, ewr: neg })[0]!.message).toBe('EWR values must be numbers from 0 to 1,000,000 (Feb has one that isn’t).'.replace('’', "'"));
		expect(fields({ ...t, natural: null })).toEqual(['natural']);
		// From the run: no natural grid needed, but one that is there must still fit.
		expect(ewrRuleTableIssues({ ...t, naturalSource: 'run', natural: null })).toEqual([]);
		expect(fields({ ...t, naturalSource: 'run', natural: [[1]] })).toEqual(['natural']);
	});
});

describe('ewrRuleListIssues', () => {
	it('allows one table per site, outlet included', () => {
		expect(ewrRuleListIssues([{ siteNodeId: null }, { siteNodeId: 'g1' }])).toBeNull();
		expect(ewrRuleListIssues([{ siteNodeId: null }, { siteNodeId: null }])).toBe('Each EWR site can have one rule table.');
		expect(ewrRuleListIssues([{ siteNodeId: 'g1' }, { siteNodeId: 'g1' }])).toBe('Each EWR site can have one rule table.');
		expect(ewrRuleListIssues(Array.from({ length: 21 }, (_, i) => ({ siteNodeId: `g${i}` })))).toBe('At most 20 rule tables.');
	});
});

describe('ewrRuleTableNotes', () => {
	it('is quiet for a consistent table', () => {
		expect(ewrRuleTableNotes(table())).toEqual([]);
	});

	it('notes rows that rise with the % point and an EWR above the natural flow', () => {
		const t = table();
		t.ewr[0] = [0.5, 1, 1.5];
		t.natural![1] = [1, 2, 3];
		t.ewr[2] = [4, 1, 0.5];
		const notes = ewrRuleTableNotes(t);
		expect(notes[0]).toBe('the EWR rises with the % point in Oct (a drought flow above a wetter one); check the table');
		expect(notes[1]).toBe("the natural flow rises with the % point in Nov; the run uses each row's running minimum");
		expect(notes[2]).toMatch(/^the EWR is above the natural flow at 3 points \(Oct 90 %, Nov 10 %, Dec 10 %\), so even natural flow fails there$/);
	});

	it('does not compare with a natural grid the run ignores', () => {
		const t = table({ naturalSource: 'run' });
		t.natural![0] = [0, 0, 0];
		expect(ewrRuleTableNotes(t)).toEqual([]);
	});
});

describe('resolveEwrRules', () => {
	it('is empty for none, and warns about a value that is not a list', () => {
		const w: string[] = [];
		expect(resolveEwrRules(undefined, w)).toEqual([]);
		expect(resolveEwrRules(null, w)).toEqual([]);
		expect(w).toEqual([]);
		expect(resolveEwrRules({ siteNodeId: null }, w)).toEqual([]);
		expect(w).toEqual(['EWR rule tables are not a list; ignored']);
	});

	it('drops an unusable table and a second one for a site, with a warning each', () => {
		const w: string[] = [];
		const out = resolveEwrRules([table(), table({ source: '' }), table({ siteNodeId: 'g1', points: [5] }), table({ ewr: [] }), 'junk'], w);
		expect(out).toHaveLength(1);
		expect(w).toEqual([
			expect.stringMatching(/^EWR rule table for the outlet skipped: it isn't usable \(Say where the table comes from/),
			expect.stringMatching(/^EWR rule table for site g1 skipped: it isn't usable \(Enter 2 to 20 % points\.\)$/),
			expect.stringMatching(/^EWR rule table for the outlet skipped/)
		]);
		// Two tables for one site: neither is used, in either order (engine 0.24.1; keeping the
		// first made a run depend on the list's order).
		for (const list of [[table(), table({ scale: 2 })], [table({ scale: 2 }), table()]]) {
			const w2: string[] = [];
			expect(resolveEwrRules([...list, table({ siteNodeId: 'g1' })], w2)).toEqual([table({ siteNodeId: 'g1' })]);
			expect(w2).toEqual(['2 EWR rule tables for the outlet: none is used, because each site has one']);
		}
	});

	it('defaults a missing scale to 1 and drops a natural grid the run ignores', () => {
		const { scale: _scale, ...noScale } = table({ naturalSource: 'run' });
		const [t] = resolveEwrRules([noScale], []);
		expect(t!.scale).toBe(1);
		expect(t!.natural).toBeNull();
	});
});
