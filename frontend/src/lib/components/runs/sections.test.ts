import type { FarmSummary, RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { navText } from '#lib/components/common/sectionNav.js';
import { EWR_MONTHS_HEADING, RESERVE_MONTHS_HEADING, riverAnchor } from '#lib/components/river/links.js';
import { supplyAnchor } from '#lib/components/supply/links.js';
import { anchorMoved } from '#lib/nav/anchorMoves.js';
import { otherPageGroups, resultGroups, resultSections } from './sections';
import { MODEL_QUALITY_ANCHORS } from './modelQuality';

describe('resultGroups', () => {
	it('groups the panels by the question they answer, in page order', () => {
		const farm = { nodeId: 'f' } as FarmSummary;
		expect(resultGroups({ farms: [farm] }).map((g) => [g.label, g.sections.map((s) => s.id)])).toEqual([
			[null, ['res-summary', 'res-water-balance']],
			['Record', ['res-notes', 'res-validation', 'res-publication']],
			['Dig deeper', ['res-checks', 'res-explore']]
		]);
	});

	it('flattens the groups for the scroll spy', () => {
		const summary = { farms: [{ nodeId: 'f' } as FarmSummary] };
		expect(resultSections(summary)).toEqual(resultGroups(summary).flatMap((g) => g.sections));
	});

	it('lists no river or unit panel: they have their own pages, which the run header links to (issue #17)', () => {
		for (const farms of [[], [{ nodeId: 'f' } as FarmSummary]]) {
			const ids = resultSections({ farms }).map((s) => s.id);
			for (const moved of ['res-river', 'res-units', 'res-ewr', 'res-reserve', 'res-curtailment', 'res-assurance', 'res-farm', 'res-farms']) expect(ids).not.toContain(moved);
		}
	});

	it('lists none of Model quality’s panels: they moved to Calibration (issue #586 Round 3), the water balance stays', () => {
		const full = { farms: [], runoff: { model: 'gr4j' } as RunSummary['runoff'], wr2012: {} as RunSummary['wr2012'], plausibility: { gauges: [{ nodeId: 'g' }] } as RunSummary['plausibility'] };
		for (const rail of [false, true]) {
			const ids = resultSections(full, rail).map((s) => s.id);
			for (const moved of MODEL_QUALITY_ANCHORS) expect(ids, moved).not.toContain(moved);
			expect(ids).toContain('res-water-balance');
		}
		expect(resultSections({ farms: [] }).find((s) => s.id === 'res-notes')?.label).toBe('Run notes & evidence');
	});

	it('lists a forecast run’s forecast panel right after the summary, and only for a forecast run (WP-2.12)', () => {
		const opening = (summary: Parameters<typeof resultGroups>[0]) => resultGroups(summary)[0]!.sections.map((s) => s.id);
		expect(opening({ farms: [] })).toEqual(['res-summary', 'res-water-balance']);
		expect(opening({ farms: [], forecast: {} as RunSummary['forecast'] })).toEqual(['res-summary', 'res-forecast', 'res-water-balance']);
	});

	it('names each link as its panel’s heading, the long ones shorter on the bar, as they were (issue #462)', () => {
		const summary = {
			farms: [],
			runoff: { model: 'gr4j' } as RunSummary['runoff'],
			wr2012: { quaternary: 'X11A' } as RunSummary['wr2012'],
			plausibility: {} as RunSummary['plausibility']
		};
		const names = resultSections(summary).map((s) => [s.label, navText(s, 'bar')]);
		expect(names).toEqual([
			['Summary', 'Summary'],
			['Water balance by water year', 'Water balance'],
			['Run notes & evidence', 'Notes & evidence'],
			['Validation statement', 'Validation'],
			['Publication', 'Publication'],
			['Self-checks', 'Self-checks'],
			['Explore any output', 'Outputs']
		]);
	});

	it('gives Run notes, Evidence and Reproduction a line each in the rail, and one link standing for the three on the bar (issue #521)', () => {
		const record = (rail: boolean) => resultGroups({ farms: [] }, rail).find((g) => g.label === 'Record')!.sections;
		expect(record(true).map((s) => [s.id, s.label])).toEqual([
			['res-notes', 'Run notes'],
			['res-evidence', 'Evidence'],
			['res-reproduce', 'Reproduction'],
			['res-validation', 'Validation statement'],
			['res-publication', 'Publication']
		]);
		expect(record(false)[0]).toEqual({ id: 'res-notes', label: 'Run notes & evidence', bar: 'Notes & evidence', covers: ['res-evidence', 'res-reproduce'] });
		const ids = resultSections({ farms: [] }, true).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('uses unique ids', () => {
		const ids = resultSections({ farms: [{ nodeId: 'f' } as FarmSummary] }).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('otherPageGroups', () => {
	it('lists the main moved panels under their pages, by those pages’ headings, linked with the run (issue #462)', () => {
		const groups = otherPageGroups('r 1');
		expect(groups.map((g) => g.label)).toEqual(['On EWR', 'On Hydrological units']);
		expect(groups.flatMap((g) => g.sections.map((s) => [s.label, s.href, s.page]))).toEqual([
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
			expect(riverAnchor(hash) || supplyAnchor(hash)).toBe(true);
		}
		const ids = [...resultSections({ farms: [] }), ...sections].map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('the moved anchors (nav/anchorMoves.ts)', () => {
	it('moves no panel still on Runs & results', () => {
		for (const s of resultSections({ farms: [], runoff: {} as RunSummary['runoff'], wr2012: {} as RunSummary['wr2012'], plausibility: {} as RunSummary['plausibility'], forecast: {} as RunSummary['forecast'] }))
			expect(anchorMoved('runs', s.id), s.id).toBe(false);
	});
});
