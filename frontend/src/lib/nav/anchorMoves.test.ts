import { describe, expect, it } from 'vitest';
import { MODEL_QUALITY_ANCHORS as CALIBRATION_RESULT_ANCHORS } from '#lib/components/calibration/links.js';
import { CALIBRATION_SETTINGS_ANCHORS } from '#lib/components/settings/sections.js';
import { PROJECT_ANCHORS } from '#lib/components/project/links.js';
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
		for (const hash of ['', '#res-summary', '#res-water-balance', '#res-validation', '#res-notes', '#constructor']) expect(fwd('?tab=runs&run=r1', hash), hash).toBeNull();
	});
});

describe('anchorForward: Settings and Runs & results → Calibration (issue #586 round 3)', () => {
	it('sends each moved settings panel to Calibration, every parameter kept in its place', () => {
		for (const id of CALIBRATION_SETTINGS_ANCHORS) {
			expect(anchorForward('settings', at(`/projects/p1?tab=settings#${id}`)), id).toBe(`/projects/p1?tab=calibration#${id}`);
		}
		expect(CALIBRATION_SETTINGS_ANCHORS).toEqual(['set-flow', 'set-record', 'set-fit', 'set-wr2012', 'set-evaporation', 'set-evaporation-station', 'set-prior']);
		expect(anchorForward('settings', at('/app/projects/p1?ref=mail&tab=settings&run=r2#set-fit'))).toBe('/app/projects/p1?ref=mail&tab=calibration&run=r2#set-fit');
		expect(anchorForward('settings', at('/projects/p1?tab=settings#set%2Dfit'))).toBe('/projects/p1?tab=calibration#set-fit');
	});

	it('sends each Model quality panel to Calibration for the same run, dropping the runs filter and the rest', () => {
		for (const id of CALIBRATION_RESULT_ANCHORS) {
			expect(anchorForward('runs', at(`/projects/p1?tab=runs&run=r1#${id}`)), id).toBe(`/projects/p1?tab=calibration&run=r1#${id}`);
		}
		expect(anchorForward('runs', at('/projects/p1?q=dry&tab=results&x=1&run=r%2F1#res-calibration'))).toBe('/projects/p1?tab=calibration&run=r%2F1#res-calibration');
		// No run picked: Calibration shows its default, as Runs would have.
		expect(anchorForward('runs', at('/projects/p1?tab=runs#res-fdc'))).toBe('/projects/p1?tab=calibration#res-fdc');
	});

	it('leaves the panels that stayed on Model settings and Runs & results', () => {
		for (const id of ['set-share', 'set-period', 'set-rain', 'set-demand', 'set-ewr', 'set-judge', 'set-auto', 'set-unit-rain']) expect(anchorMoved('settings', id), id).toBe(false);
		for (const id of ['res-summary', 'res-forecast', 'res-water-balance', 'res-notes', 'res-evidence', 'res-reproduce', 'res-validation', 'res-publication', 'res-checks', 'res-explore']) {
			expect(anchorMoved('runs', id), id).toBe(false);
		}
	});
});

describe('anchorForward: old ?tab=calibration links to Model settings (issue #586 rounds 2 and 3)', () => {
	const fwd = (path: string) => anchorForward('calibration', at(path));

	it('sends a panel that stayed on Model settings there, every parameter kept', () => {
		expect(fwd('/projects/p1?tab=calibration#set-ewr')).toBe('/projects/p1?tab=settings#set-ewr');
		expect(fwd('/projects/p1?tab=calibration&rain=units#set%2Dfeeds')).toBe('/projects/p1?tab=settings&rain=units#set-feeds');
		// Settings then sends a panel that moved on again.
		expect(anchorForward('settings', at('/projects/p1?tab=settings&rain=units#set-feeds'))).toBe('/projects/p1?tab=series&rain=units#data-feeds');
	});

	it('keeps the calibration panels, the page’s own parts and its results here', () => {
		for (const id of [...CALIBRATION_SETTINGS_ANCHORS, ...CALIBRATION_RESULT_ANCHORS, 'cal-setup', 'cal-fit', '', '%E0']) {
			expect(fwd(`/projects/p1?tab=calibration#${id}`), id).toBeNull();
		}
	});
});

describe('anchorForward: the Summary’s old panels (issue #17, issue #558)', () => {
	const fwd = (path: string, run?: string | null) => anchorForward('overview', at(path), undefined, { run });

	it('sends the model’s facts, details, notes and access to Project, with nothing else', () => {
		for (const id of PROJECT_ANCHORS) expect(fwd(`/projects/p1#${id}`, 'r1'), id).toBe(`/projects/p1?tab=project#${id}`);
		expect(fwd('/projects/p1?tab=overview&x=1#members-h')).toBe('/projects/p1?tab=project#members-h');
	});

	it('sends the reserve strip (by its old ids too) and the EWR panels to EWR, for the run the Summary shows', () => {
		expect(fwd('/projects/p1#strip-h', 'r1')).toBe('/projects/p1?tab=river&run=r1#res-reserve-strip');
		expect(fwd('/projects/p1?tab=overview#reserve-strip', 'r 1')).toBe('/projects/p1?tab=river&run=r+1#res-reserve-strip');
		expect(fwd('/projects/p1#res-reserve-strip', null)).toBe('/projects/p1?tab=river#res-reserve-strip');
		for (const id of RIVER_ANCHORS) expect(fwd(`/projects/p1#${id}`, 'r1'), id).toBe(`/projects/p1?tab=river&run=r1#${id}`);
		// A run the link names wins over the one shown.
		expect(fwd('/projects/p1?run=r9#res-reserve', 'r1')).toBe('/projects/p1?tab=river&run=r9#res-reserve');
	});

	it('leaves the Summary’s own anchors, and no hash', () => {
		for (const id of ['', 'res-curtailment', 'res-calibration', 'set-fit', 'summary-h']) expect(fwd(`/projects/p1#${id}`, 'r1'), id).toBeNull();
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

	it('takes a new row with nothing else to change (Round 3 added Calibration this way)', () => {
		const rows: AnchorMove[] = [...ANCHOR_MOVES, { from: 'settings', hash: ['set-outlook', 'set-outcomes'], tab: 'scenarios', keep: ['run'] }];
		expect(anchorForward('settings', at('/projects/p1?tab=settings&run=r2&x=1#set-outlook'), rows)).toBe('/projects/p1?tab=scenarios&run=r2#set-outlook');
		expect(anchorForward('settings', at('/projects/p1?tab=settings#set-outcomes'), rows)).toBe('/projects/p1?tab=scenarios#set-outcomes');
		expect(anchorMoved('settings', 'set-outlook', rows)).toBe(true);
		expect(anchorMoved('settings', 'set-outlook')).toBe(false);
	});

	it('fills a kept parameter the link lacks, never one it carries, and never past a list', () => {
		const rows: AnchorMove[] = [
			{ from: 'settings', hash: 'a', tab: 'runs', keep: ['run'] },
			{ from: 'settings', hash: 'b', tab: 'runs', keep: 'all' }
		];
		expect(anchorForward('settings', at('/p?tab=settings#a'), rows, { run: 'r1', x: '1' })).toBe('/p?tab=runs&run=r1#a');
		expect(anchorForward('settings', at('/p?tab=settings&run=r2#a'), rows, { run: 'r1' })).toBe('/p?tab=runs&run=r2#a');
		expect(anchorForward('settings', at('/p?tab=settings#a'), rows, { run: null })).toBe('/p?tab=runs#a');
		// 'all' keeps the link's own parameters, adding none.
		expect(anchorForward('settings', at('/p?tab=settings#b'), rows, { run: 'r1' })).toBe('/p?tab=runs#b');
	});
});

describe('anchorMoved', () => {
	it('is true for a moved anchor only, never for no hash (a bare row needs the query)', () => {
		expect(anchorMoved('runs', 'res-reserve')).toBe(true);
		expect(anchorMoved('settings', 'set-feeds')).toBe(true);
		expect(anchorMoved('settings', 'set-fit')).toBe(true);
		expect(anchorMoved('runs', 'res-calibration')).toBe(true);
		expect(anchorMoved('calibration', 'set-ewr')).toBe(true);
		expect(anchorMoved('calibration', 'set-fit')).toBe(false);
		expect(anchorMoved('runs', 'res-summary')).toBe(false);
		expect(anchorMoved('settings', '')).toBe(false);
	});
});
