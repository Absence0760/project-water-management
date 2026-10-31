// The restriction log's CSV (restrictionLogCsvLines, restrictionLog.ts): one notice column per language, English
// first; In force on the newest decision of the current publication only; text a spreadsheet would run as a formula
// is defused, and a comma or line break quoted. Who may read it is restrictionLog.db.test.ts's. Invented values.
import { describe, expect, it } from 'vitest';
import { noticeCodes, restrictionLogCsvLines, type RestrictionDecision } from './restrictionLog.js';

const decision = (over: Partial<RestrictionDecision>): RestrictionDecision => ({
	id: '1',
	kind: 'published',
	at: '2031-01-02T03:04:05.000000Z',
	by: 'Ann',
	auto: false,
	publicationId: 'p',
	runId: 'r',
	restriction: { level: 'advisory', pct: 10, notice: { en: 'Save water.' } },
	farms: 3,
	season: null,
	current: false,
	runKept: true,
	...over
});

describe('restrictionLogCsvLines', () => {
	it('orders the notice languages English first, then by code', () => {
		expect(noticeCodes([decision({ restriction: { level: 'none', pct: null, notice: { xh: 'a', af: 'b' } as never } }), decision({})])).toEqual(['en', 'af', 'xh']);
		expect(noticeCodes([])).toEqual([]);
	});

	it('marks only the newest decision of the current publication in force, and defuses formulas and quotes commas', () => {
		const lines = restrictionLogCsvLines([
			decision({ id: '3', kind: 'notice_changed', fields: ['restriction', 'nextExpectedOn'], current: true, note: '=HYPERLINK("x")', restriction: { level: 'restricted', pct: 25, notice: { en: 'Cut, by a quarter.' } } }),
			decision({ id: '2', current: true, by: null, auto: true }),
			decision({ id: '1', restriction: { level: null, pct: null, notice: null }, farms: null })
		]);
		expect(lines).toHaveLength(4);
		expect(lines[1]).toContain(',notice_changed,restriction | nextExpectedOn,Ann,no,restricted,25,yes,"Cut, by a quarter.",yes,');
		expect(lines[1]).toContain(`,"'=HYPERLINK(""x"")",`);
		expect(lines[2]).toContain(',published,,,yes,advisory,10,no,Save water.,yes,');
		expect(lines[3]).toContain(',published,,Ann,no,,,no,,no,');
	});
});
