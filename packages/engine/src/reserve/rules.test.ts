import { describe, expect, it } from 'vitest';
import {
	blankEwrRuleTable,
	DEFAULT_ASSURANCE_POINTS,
	EWR_RULE_SOURCE_KINDS,
	ewrSourceConfidence,
	ewrRuleListIssues,
	ewrRuleTableIssues,
	isEwrCategory,
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
		expect(ewrRuleTableIssues({ ...t, ewr: neg })[0]!.message).toBe('EWR values must be numbers from 0 to 1\u202f000\u202f000 (Feb has one that isn’t).'.replace('’', "'"));
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
			expect(resolveEwrRules([...list, table({ siteNodeId: 'g1' })], w2)).toEqual([table({ siteNodeId: 'g1', lowFlow: null, highFlows: [] })]);
			expect(w2).toEqual(['2 EWR rule tables for the outlet: none is used, because each site has one']);
		}
	});

	it('defaults a missing scale to 1 and drops a natural grid the run ignores', () => {
		const { scale: _scale, ...noScale } = table({ naturalSource: 'run' });
		const [t] = resolveEwrRules([noScale], []);
		expect(t!.scale).toBe(1);
		expect(t!.natural).toBeNull();
		// Engine ≥ 0.33.0: a table stored before low and high flows existed has neither.
		expect(t!.lowFlow).toBeNull();
		expect(t!.highFlows).toEqual([]);
	});

	it('copies the high-flow components with their months sorted', () => {
		const e = { label: 'Freshet', months: [12, 1, 11], peakM3s: 5, durationDays: 2, perYear: 1 };
		const [t] = resolveEwrRules([table({ highFlows: [e] })], []);
		expect(t!.highFlows).toEqual([{ ...e, months: [1, 11, 12] }]);
		expect(e.months).toEqual([12, 1, 11]);
	});
});

describe('low flows and high-flow components (engine ≥ 0.33.0)', () => {
	const freshet = { label: 'Class I freshet', months: [11, 12], peakM3s: 12.5, durationDays: 3, perYear: 2 };

	it('accepts a low-flow grid on a total table and valid high-flow components', () => {
		expect(ewrRuleTableIssues(table({ lowFlow: Array.from({ length: 12 }, () => [1, 0.6, 0.2]), highFlows: [freshet] }))).toEqual([]);
		expect(blankEwrRuleTable()).toMatchObject({ lowFlow: null, highFlows: [] });
	});

	it('refuses a low-flow grid on a low-flow table, or one of the wrong shape', () => {
		const low = Array.from({ length: 12 }, () => [1, 0.6, 0.2]);
		expect(ewrRuleTableIssues(table({ component: 'lowFlow', lowFlow: low }))[0]!.field).toBe('lowFlow');
		expect(ewrRuleTableIssues(table({ lowFlow: low.slice(1) }))[0]).toEqual({ field: 'lowFlow', message: 'Enter 12 rows of low-flow values (Oct … Sep).' });
		expect(ewrRuleTableIssues(table({ lowFlow: low.map((r, m) => (m === 0 ? [1, -1, 0] : r)) }))[0]!.message).toMatch(/^Low-flow values must be numbers from 0/);
	});

	it('refuses high-flow components that are unnamed, out of range or cannot fit in a year', () => {
		const msg = (e: object) => ewrRuleTableIssues(table({ highFlows: [e as never] })).map((i) => [i.field, i.message]);
		expect(msg({ ...freshet, label: ' ' })).toEqual([['highFlows', 'High flow 1: name it (e.g. “Class II freshet”).']]);
		expect(msg({ ...freshet, months: [] })[0]![1]).toMatch(/pick the months/);
		expect(msg({ ...freshet, months: [11, 11] })[0]![1]).toMatch(/pick the months/);
		expect(msg({ ...freshet, months: [13] })[0]![1]).toMatch(/pick the months/);
		expect(msg({ ...freshet, peakM3s: 0 })[0]![1]).toMatch(/the peak must be above 0/);
		expect(msg({ ...freshet, durationDays: 1.5 })[0]![1]).toMatch(/whole number of days/);
		expect(msg({ ...freshet, durationDays: 91 })[0]![1]).toMatch(/whole number of days from 1 to 90/);
		expect(msg({ ...freshet, perYear: 0 })[0]![1]).toMatch(/events per year/);
		expect(msg({ ...freshet, durationDays: 90, perYear: 5 })[0]![1]).toBe("High flow 1: 5 events of 90 days don't fit in a year.");
		expect(ewrRuleTableIssues(table({ highFlows: Array.from({ length: 13 }, () => freshet) }))[0]!.message).toBe('At most 12 high-flow components per table.');
		expect(ewrRuleTableIssues(table({ highFlows: 'x' as never }))[0]!.field).toBe('highFlows');
	});

	it('notes low flows that rise or sit above the total', () => {
		const t = table({ lowFlow: Array.from({ length: 12 }, (_, m) => (m === 0 ? [0.2, 0.6, 0.1] : m === 1 ? [2, 0.5, 0.1] : [1, 0.5, 0.1])) });
		const notes = ewrRuleTableNotes(t);
		expect(notes).toContain('the low flows rise with the % point in Oct (a drought flow above a maintenance one); check the table');
		expect(notes).toContain('the low flows are above the total flow at 1 point (Nov 10 %), so the high flows there count as 0');
	});
});

describe("the determination's natural MAR (engine ≥ 1.11.0, issue #46)", () => {
	it('is optional: absent, null or a number above 0 up to the value ceiling; anything else is refused on its own field', () => {
		expect(ewrRuleTableIssues(table())).toEqual([]);
		for (const v of [null, 0.001, 12.5, 1e6]) expect(ewrRuleTableIssues(table({ naturalMarMcm: v }))).toEqual([]);
		for (const v of [0, -1, 1e6 + 1, Number.NaN, Number.POSITIVE_INFINITY, '12' as never]) expect(fields(table({ naturalMarMcm: v }))).toEqual(['naturalMarMcm']);
	});

	it('is carried through resolve only when set, so an older table resolves unchanged', () => {
		expect(resolveEwrRules([table({ naturalMarMcm: 12.5 })], [])[0]!.naturalMarMcm).toBe(12.5);
		expect(resolveEwrRules([table()], [])[0]).not.toHaveProperty('naturalMarMcm');
		expect(resolveEwrRules([table({ naturalMarMcm: null })], [])[0]).not.toHaveProperty('naturalMarMcm');
		const w: string[] = [];
		expect(resolveEwrRules([table({ naturalMarMcm: -3 })], w)).toEqual([]);
		expect(w).toEqual([expect.stringMatching(/^EWR rule table for the outlet skipped: it isn't usable \(The natural MAR must be above 0/)]);
	});
});

describe('recommended ecological category (REC, ER9)', () => {
	it('accepts one class A … F, a band of two neighbouring ones, absent and null', () => {
		for (const c of ['A', 'B', 'C', 'D', 'E', 'F', 'A/B', 'B/C', 'E/F']) expect(ewrRuleTableIssues(table({ category: c }))).toEqual([]);
		expect(ewrRuleTableIssues(table({ category: null }))).toEqual([]);
		expect(ewrRuleTableIssues(table())).toEqual([]);
	});

	it('refuses anything else on its own field', () => {
		for (const c of ['', 'G', 'b', 'B/D', 'C/B', 'B-C', 'B/', 'AB', ' B', 'B/C/D', 'Class B', 3 as never]) {
			expect(fields(table({ category: c })), String(c)).toEqual(['category']);
		}
		expect(isEwrCategory('B/C')).toBe(true);
		expect(isEwrCategory('C/B')).toBe(false);
	});

	it('is carried through resolve only when set, so an older table resolves unchanged', () => {
		expect(resolveEwrRules([table({ category: 'B/C' })], [])[0]!.category).toBe('B/C');
		expect(resolveEwrRules([table()], [])[0]).not.toHaveProperty('category');
		expect(resolveEwrRules([table({ category: null })], [])[0]).not.toHaveProperty('category');
		const w: string[] = [];
		expect(resolveEwrRules([table({ category: 'Z' })], w)).toEqual([]);
		expect(w).toEqual([expect.stringMatching(/^EWR rule table for the outlet skipped: it isn't usable \(The REC is one category/)]);
	});
});

describe('source kind (engine ≥ 1.5.0, WP-3.7)', () => {
	it('accepts each kind, absent and null, and refuses anything else on its own field', () => {
		for (const k of EWR_RULE_SOURCE_KINDS) expect(ewrRuleTableIssues(table({ sourceKind: k }))).toEqual([]);
		expect(ewrRuleTableIssues(table({ sourceKind: null }))).toEqual([]);
		expect(fields(table({ sourceKind: 'guess' as never }))).toEqual(['sourceKind']);
	});

	it('is carried through resolve only when set, so an older table resolves unchanged', () => {
		const [set] = resolveEwrRules([table({ sourceKind: 'desktop' })], []);
		expect(set!.sourceKind).toBe('desktop');
		const [plain] = resolveEwrRules([table()], []);
		expect(plain).not.toHaveProperty('sourceKind');
		const [nulled] = resolveEwrRules([table({ sourceKind: null })], []);
		expect(nulled).not.toHaveProperty('sourceKind');
		const w: string[] = [];
		expect(resolveEwrRules([table({ sourceKind: 'guess' as never })], w)).toEqual([]);
		expect(w).toEqual([expect.stringMatching(/^EWR rule table for the outlet skipped: it isn't usable \(Pick what kind of source/)]);
	});

	it('gives the confidence line for each kind, and none when unstated', () => {
		expect(ewrSourceConfidence('gazetted')).toBe('Gazetted Reserve');
		expect(ewrSourceConfidence('desktop')).toBe('Desktop estimate, low confidence');
		expect(ewrSourceConfidence('other')).toBe('Other source, confidence not stated');
		expect(ewrSourceConfidence(undefined)).toBeNull();
		expect(ewrSourceConfidence(null)).toBeNull();
		expect(ewrSourceConfidence('toString' as never)).toBeNull();
	});
});
