import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { navText } from '#lib/components/common/sectionNav.js';
import { isModelQualityAnchor } from '#lib/components/calibration/links.js';
import { EWR_MONTHS_HEADING, RESERVE_MONTHS_HEADING, riverAnchor } from '#lib/components/river/links.js';
import { supplyAnchor } from '#lib/components/supply/links.js';
import { anchorMoved } from '#lib/nav/anchorMoves.js';
import { otherPageGroups, resultGroups, resultSections, RUN_SUBSECTIONS } from './sections';

const forecast = {} as RunSummary['forecast'];

describe('resultGroups', () => {
	it('groups the panels by the question they answer, in page order: Model quality is on Calibration now (issue #586 round 3)', () => {
		expect(resultGroups({}).map((g) => [g.label, g.sections.map((s) => s.id)])).toEqual([
			[null, ['res-summary', 'res-water-balance']],
			['Record', ['res-notes', 'res-evidence', 'res-reproduce', 'res-validation', 'res-publication']],
			['Dig deeper', ['res-checks', 'res-explore']]
		]);
	});

	it('flattens the groups for the scroll spy', () => {
		expect(resultSections({}, true)).toEqual(resultGroups({}, true).flatMap((g) => g.sections));
	});

	it('lists no river, unit or Model quality panel: they have their own pages (issue #17, issue #586)', () => {
		for (const rail of [false, true]) {
			const ids = resultSections({ forecast }, rail).map((s) => s.id);
			for (const moved of ['res-river', 'res-units', 'res-ewr', 'res-reserve', 'res-curtailment', 'res-assurance', 'res-farm', 'res-farms']) expect(ids).not.toContain(moved);
			for (const id of ids) expect(isModelQualityAnchor(id), id).toBe(false);
		}
	});

	it('keeps Water balance by water year after the summary (and a forecast run’s forecast, WP-2.12)', () => {
		const opening = (summary: Parameters<typeof resultGroups>[0]) => resultGroups(summary)[0]!.sections.map((s) => s.id);
		expect(opening({})).toEqual(['res-summary', 'res-water-balance']);
		expect(opening({ forecast })).toEqual(['res-summary', 'res-forecast', 'res-water-balance']);
	});

	it('names each link as its panel’s heading word for word, on the bar too: no shorter names (issue #586, D4)', () => {
		const bar = resultSections({ forecast });
		expect(bar.map((s) => navText(s, 'bar'))).toEqual([
			'Summary',
			'Forecast',
			'Water balance by water year',
			'Run notes',
			'Evidence',
			'Reproduction',
			'Validation statement',
			'Publication',
			'Self-checks',
			'Explore any output'
		]);
		for (const s of resultSections({ forecast }, true)) {
			expect(s.bar, s.id).toBeUndefined();
			expect(s.covers, s.id).toBeUndefined();
		}
	});

	it('gives the side index a line for Changes since this run and Trace a day, under their panels; the bar keeps to the panels', () => {
		const rail = resultSections({}, true);
		expect(rail.map((s) => [s.id, s.label])).toEqual([
			['res-summary', 'Summary'],
			['res-water-balance', 'Water balance by water year'],
			['res-notes', 'Run notes'],
			['res-evidence', 'Evidence'],
			['res-reproduce', 'Reproduction'],
			[RUN_SUBSECTIONS.changes, 'Changes since this run'],
			['res-validation', 'Validation statement'],
			['res-publication', 'Publication'],
			['res-checks', 'Self-checks'],
			[RUN_SUBSECTIONS.trace, 'Trace a day'],
			['res-explore', 'Explore any output']
		]);
		const bar = resultSections({}).map((s) => s.id);
		expect(bar).not.toContain(RUN_SUBSECTIONS.changes);
		expect(bar).not.toContain(RUN_SUBSECTIONS.trace);
		// Every bar link is in the rail, in the same order.
		expect(rail.map((s) => s.id).filter((id) => bar.includes(id))).toEqual(bar);
	});

	it('uses unique ids', () => {
		const ids = resultSections({ forecast }, true).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('otherPageGroups', () => {
	it('lists the main moved panels under their pages, by those pages’ headings, linked with the run (issue #462)', () => {
		const groups = otherPageGroups('r 1');
		expect(groups.map((g) => g.label)).toEqual(['On Calibration', 'On EWR', 'On Hydrological units']);
		expect(groups.flatMap((g) => g.sections.map((s) => [s.label, s.href, s.page]))).toEqual([
			['Hydrograph', '?tab=calibration&run=r%201#res-hydrograph', 'Calibration'],
			['Calibration against observed flow', '?tab=calibration&run=r%201#res-calibration', 'Calibration'],
			[RESERVE_MONTHS_HEADING, '?tab=river&run=r%201#res-reserve', 'EWR'],
			[EWR_MONTHS_HEADING, '?tab=river&run=r%201#res-ewr-grid', 'EWR'],
			['Water account', '?tab=river&run=r%201#res-water-account', 'EWR'],
			['Curtailment targets', '?tab=supply&run=r+1#res-curtailment', 'Hydrological units'],
			['Assurance of supply', '?tab=supply&run=r+1#res-assurance', 'Hydrological units']
		]);
	});

	it('links only panels those pages anchor, with ids apart from this page’s', () => {
		const sections = otherPageGroups(null).flatMap((g) => g.sections);
		for (const s of sections) {
			const hash = s.href!.split('#')[1]!;
			expect(riverAnchor(hash) || supplyAnchor(hash) || isModelQualityAnchor(hash), hash).toBe(true);
		}
		const ids = [...resultSections({}, true), ...sections].map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('the moved anchors (nav/anchorMoves.ts)', () => {
	it('moves no panel still on Runs & results', () => {
		for (const s of resultSections({ forecast }, true)) expect(anchorMoved('runs', s.id), s.id).toBe(false);
	});
});
