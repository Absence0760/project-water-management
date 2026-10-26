import { describe, expect, it } from 'vitest';
import { RIVER_ANCHORS, RIVER_STRIP_ANCHOR } from '#lib/components/river/links.js';
import { SUPPLY_ANCHORS } from '#lib/components/supply/links.js';
import { ANCHOR_MOVES, anchorForward, anchorMoved, type AnchorMove } from './anchorMoves';

const at = (path: string) => new URL(path, 'https://example.org');

describe('anchorForward: Settings (issue #586 round 1)', () => {
	const fwd = (path: string) => anchorForward('settings', at(path));

	it('sends each moved anchor to its new page and anchor', () => {
		expect(fwd('/projects/p1?tab=settings#set-feeds')).toBe('/projects/p1?tab=series#data-feeds');
		expect(fwd('/projects/p1?tab=settings#set-api-keys')).toBe('/projects/p1?tab=project#project-api-keys');
		expect(fwd('/projects/p1?tab=settings#set-report-schedules')).toBe('/projects/p1?tab=project#project-report-schedules');
	});

	it('keeps every other parameter, in its place', () => {
		expect(fwd('/projects/p1?tab=settings&rain=boundary#set-feeds')).toBe('/projects/p1?tab=series&rain=boundary#data-feeds');
		expect(fwd('/projects/p1?rain=units&tab=settings&run=r9#set-feeds')).toBe('/projects/p1?rain=units&tab=series&run=r9#data-feeds');
		// The calibration alias forwards too, and a percent-encoded hash is read as its id.
		expect(fwd('/projects/p1?tab=calibration#set%2Dfeeds')).toBe('/projects/p1?tab=series#data-feeds');
		// A base path (a production deploy under a prefix) stays.
		expect(fwd('/app/projects/p1?tab=settings#set-api-keys')).toBe('/app/projects/p1?tab=project#project-api-keys');
	});

	it('sends a map proposal’s link (?rain=boundary, ?rain=units) to Data feeds without its #', () => {
		expect(fwd('/projects/p1?tab=settings&rain=boundary')).toBe('/projects/p1?tab=series&rain=boundary#data-feeds');
		expect(fwd('/projects/p1?tab=settings&rain=units')).toBe('/projects/p1?tab=series&rain=units#data-feeds');
		expect(fwd('/projects/p1?tab=settings&rain=other')).toBeNull();
		// Another panel's anchor wins: the rain= is for Data feeds only.
		expect(fwd('/projects/p1?tab=settings&rain=boundary#set-ewr')).toBeNull();
	});

	it('leaves every other anchor here', () => {
		for (const hash of ['', '#set-auto', '#set-ewr', '#set-feeds-x', '#data-feeds', '#%E0', '#constructor', '#toString']) {
			expect(fwd(`/projects/p1?tab=settings${hash}`), hash).toBeNull();
		}
	});
});

describe('anchorForward: Runs & results (issue #17)', () => {
	const fwd = (search: string, hash: string) => anchorForward('runs', { pathname: '/projects/p1', search, hash });

	it('sends a moved panel to its page with the run, and the reporting window to Hydrological units', () => {
		expect(fwd('?tab=runs&run=r1', '#res-ewr-grid')).toBe('/projects/p1?tab=river&run=r1#res-ewr-grid');
		expect(fwd('?tab=runs&run=r1&window=last7', '#res-curtailment')).toBe('/projects/p1?tab=supply&run=r1&window=last7#res-curtailment');
		expect(fwd('?tab=runs', '#res-assurance')).toBe('/projects/p1?tab=supply#res-assurance');
	});

	it('keeps only the run (and window) in that order, whatever the old link carried', () => {
		// EWR has no reporting window; the old `tab=results` spelling and stray parameters go.
		expect(fwd('?window=last7&tab=results&x=1&run=r1', '#res-reserve')).toBe('/projects/p1?tab=river&run=r1#res-reserve');
		expect(fwd('?window=last7&tab=runs&run=r1', '#res-farms')).toBe('/projects/p1?tab=supply&run=r1&window=last7#res-farms');
	});

	it('sends the old link rows to the page itself, keeping the run', () => {
		expect(fwd('?tab=runs&run=r1', '#res-river')).toBe('/projects/p1?tab=river&run=r1');
		expect(fwd('?tab=runs&run=r1', '#res-units')).toBe('/projects/p1?tab=supply&run=r1');
		expect(fwd('?tab=runs&window=last30', '#res-units')).toBe('/projects/p1?tab=supply&window=last30');
	});

	it('forwards every river and unit panel, the reserve strip too', () => {
		for (const id of [...RIVER_ANCHORS, RIVER_STRIP_ANCHOR]) expect(fwd('?tab=runs&run=r1', `#${id}`), id).toBe(`/projects/p1?tab=river&run=r1#${id}`);
		for (const id of SUPPLY_ANCHORS) expect(fwd('?tab=runs&run=r1', `#${id}`), id).toBe(`/projects/p1?tab=supply&run=r1#${id}`);
	});

	it('leaves the panels still here, and no hash', () => {
		for (const hash of ['', '#res-summary', '#res-hydrograph', '#res-validation', '#constructor']) expect(fwd('?tab=runs&run=r1', hash), hash).toBeNull();
	});
});

describe('anchorForward: the table', () => {
	it('forwards only from the page a row names', () => {
		expect(anchorForward('series', at('/projects/p1?tab=series#set-feeds'))).toBeNull();
		expect(anchorForward('project', at('/projects/p1?tab=project#res-curtailment'))).toBeNull();
		expect(anchorForward('settings', at('/projects/p1?tab=settings#res-curtailment'))).toBeNull();
	});

	it('has each old anchor once per page, and never sends one to the page it left', () => {
		const seen = new Set<string>();
		for (const m of ANCHOR_MOVES) {
			expect(m.tab, String(m.hash)).not.toBe(m.from);
			if (typeof m.hash === 'function') continue;
			for (const h of typeof m.hash === 'string' ? [m.hash] : m.hash) {
				expect(seen.has(`${m.from}#${h}`), h).toBe(false);
				seen.add(`${m.from}#${h}`);
			}
		}
		// A row that tests for a family of anchors (every `set-…`) is its page's only row: no named one hides behind it.
		for (const m of ANCHOR_MOVES.filter((r) => typeof r.hash === 'function')) {
			expect(ANCHOR_MOVES.filter((r) => r.from === m.from), m.from).toHaveLength(1);
		}
	});

	it('takes a new row with nothing else to change (Round 3 adds Calibration this way)', () => {
		const rows: AnchorMove[] = [...ANCHOR_MOVES, { from: 'settings', hash: ['set-fit', 'set-flow'], tab: 'scenarios', keep: ['run'] }];
		expect(anchorForward('settings', at('/projects/p1?tab=settings&run=r2&x=1#set-fit'), rows)).toBe('/projects/p1?tab=scenarios&run=r2#set-fit');
		expect(anchorForward('settings', at('/projects/p1?tab=settings#set-flow'), rows)).toBe('/projects/p1?tab=scenarios#set-flow');
		expect(anchorMoved('settings', 'set-fit', rows)).toBe(true);
		expect(anchorMoved('settings', 'set-fit')).toBe(false);
	});
});

describe('anchorMoved', () => {
	it('is true for a moved anchor only, never for no hash (a bare row needs the query)', () => {
		expect(anchorMoved('runs', 'res-reserve')).toBe(true);
		expect(anchorMoved('settings', 'set-feeds')).toBe(true);
		expect(anchorMoved('runs', 'res-summary')).toBe(false);
		expect(anchorMoved('settings', '')).toBe(false);
	});
});
