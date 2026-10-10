import type { FarmSummary, RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { navText } from '$lib/components/common/sectionNav';
import { EWR_MONTHS_HEADING, RESERVE_MONTHS_HEADING, riverAnchor } from '$lib/components/river/links';
import { supplyAnchor } from '$lib/components/supply/links';
import { movedHref, otherPageGroups, resultGroups, resultSections } from './sections';

describe('resultGroups', () => {
	it('groups the panels by the question they answer, in page order', () => {
		const farm = { nodeId: 'f' } as FarmSummary;
		expect(resultGroups({ farms: [farm] }).map((g) => [g.label, g.sections.map((s) => s.id)])).toEqual([
			[null, ['res-summary']],
			['Model quality', ['res-hydrograph', 'res-fdc', 'res-calibration', 'res-water-balance', 'res-ewr-agreement']],
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

	it('adds the optional model-quality panels in order: runoff model (GR4J) after the water balance, WR2012, then plausibility after EWR vs observed', () => {
		const model = (summary: Parameters<typeof resultGroups>[0]) => resultGroups(summary).find((g) => g.label === 'Model quality')!.sections.map((s) => s.id);
		expect(model({ farms: [] })).not.toContain('res-runoff');
		expect(model({ farms: [] })).not.toContain('res-wr2012');
		expect(model({ farms: [] })).not.toContain('res-plausibility');
		expect(
			model({
				farms: [],
				runoff: { model: 'gr4j' } as RunSummary['runoff'],
				wr2012: {} as RunSummary['wr2012'],
				plausibility: {} as RunSummary['plausibility']
			})
		).toEqual(['res-hydrograph', 'res-fdc', 'res-calibration', 'res-water-balance', 'res-runoff', 'res-wr2012', 'res-ewr-agreement', 'res-plausibility']);
	});

	it('lists Rain for each unit after the runoff model, only for a run that ran per unit (issue #482)', () => {
		const model = (summary: Parameters<typeof resultGroups>[0]) => resultGroups(summary).find((g) => g.label === 'Model quality')!.sections.map((s) => s.id);
		const runoff = { model: 'gr4j' } as RunSummary['runoff'];
		expect(model({ farms: [], runoff })).not.toContain('res-unit-rain');
		// A stored summary from another engine: read defensively, whatever its type says.
		expect(model({ farms: [], runoff, unitRain: { mode: 'catchment', units: [] } as unknown as RunSummary['unitRain'] })).not.toContain('res-unit-rain');
		const ids = model({ farms: [], runoff, unitRain: { mode: 'perUnit', gaugeMapMm: null, gaugeMapSource: null, mapPeriod: { start: '1991-01-01', end: '2020-12-31' }, units: [] } });
		expect(ids.indexOf('res-unit-rain')).toBe(ids.indexOf('res-runoff') + 1);
	});

	it('puts the flow-duration curve with the hydrograph', () => {
		const groups = resultGroups({ farms: [] });
		const model = groups.find((g) => g.label === 'Model quality')!.sections.map((s) => s.id);
		expect(model.slice(0, 2)).toEqual(['res-hydrograph', 'res-fdc']);
		expect(resultSections({ farms: [] }).find((s) => s.id === 'res-notes')?.label).toBe('Run notes & evidence');
	});

	it('lists a forecast run’s forecast panel right after the summary, and only for a forecast run (WP-2.12)', () => {
		const opening = (summary: Parameters<typeof resultGroups>[0]) => resultGroups(summary)[0]!.sections.map((s) => s.id);
		expect(opening({ farms: [] })).toEqual(['res-summary']);
		expect(opening({ farms: [], forecast: {} as RunSummary['forecast'] })).toEqual(['res-summary', 'res-forecast']);
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
			['Hydrograph', 'Hydrograph'],
			['Flow-duration curve', 'Flow duration'],
			['Calibration against observed flow', 'Calibration'],
			['Water balance by water year', 'Water balance'],
			['Runoff model: GR4J', 'Runoff model'],
			['WR2012 check: X11A', 'WR2012 check'],
			['EWR test: model against observed flow', 'EWR vs observed'],
			['Plausibility checks', 'Plausibility'],
			['Run notes & evidence', 'Notes & evidence'],
			['Validation statement', 'Validation'],
			['Publication', 'Publication'],
			['Self-checks', 'Self-checks'],
			['Explore any output', 'Outputs']
		]);
	});

	it('uses unique ids', () => {
		const ids = resultSections({ farms: [{ nodeId: 'f' } as FarmSummary] }).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('otherPageGroups', () => {
	it('lists the main moved panels under their pages, by those pages’ headings, linked with the run (issue #462)', () => {
		const groups = otherPageGroups('r 1');
		expect(groups.map((g) => g.label)).toEqual(['On River & reserve', 'On Hydrological units']);
		expect(groups.flatMap((g) => g.sections.map((s) => [s.label, s.href, s.page]))).toEqual([
			[RESERVE_MONTHS_HEADING, '?tab=river&run=r%201#res-reserve', 'River & reserve'],
			[EWR_MONTHS_HEADING, '?tab=river&run=r%201#res-ewr-grid', 'River & reserve'],
			['Water account', '?tab=river&run=r%201#res-water-account', 'River & reserve'],
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

describe('movedHref', () => {
	it('sends a moved panel to its page with the run, and the reporting window to Hydrological units', () => {
		expect(movedHref('res-ewr-grid', 'r1')).toBe('?tab=river&run=r1#res-ewr-grid');
		expect(movedHref('res-curtailment', 'r1', 'last7')).toBe('?tab=supply&run=r1&window=last7#res-curtailment');
		expect(movedHref('res-assurance', null)).toBe('?tab=supply#res-assurance');
	});

	it('sends the old link rows to the page itself, keeping the run', () => {
		expect(movedHref('res-river', 'r1')).toBe('?tab=river&run=r1');
		expect(movedHref('res-units', 'r1')).toBe('?tab=supply&run=r1');
		expect(movedHref('res-units', null, 'last30')).toBe('?tab=supply&window=last30');
	});

	it('leaves the panels still on Runs & results alone', () => {
		for (const s of resultSections({ farms: [], runoff: {} as RunSummary['runoff'], wr2012: {} as RunSummary['wr2012'], plausibility: {} as RunSummary['plausibility'], forecast: {} as RunSummary['forecast'] }))
			expect(movedHref(s.id, 'r1')).toBeNull();
		expect(movedHref('', 'r1')).toBeNull();
	});
});
