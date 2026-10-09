import type { FarmSummary, RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { movedHref, resultGroups, resultSections } from './sections';

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
		expect(model({ farms: [], runoff, unitRain: { mode: 'catchment', units: [] } })).not.toContain('res-unit-rain');
		const ids = model({ farms: [], runoff, unitRain: { mode: 'perUnit', units: [] } });
		expect(ids.indexOf('res-unit-rain')).toBe(ids.indexOf('res-runoff') + 1);
	});

	it('puts the flow-duration curve with the hydrograph', () => {
		const groups = resultGroups({ farms: [] });
		const model = groups.find((g) => g.label === 'Model quality')!.sections.map((s) => s.id);
		expect(model.slice(0, 2)).toEqual(['res-hydrograph', 'res-fdc']);
		expect(resultSections({ farms: [] }).find((s) => s.id === 'res-notes')?.label).toBe('Notes & evidence');
	});

	it('lists a forecast run’s forecast panel right after the summary, and only for a forecast run (WP-2.12)', () => {
		const opening = (summary: Parameters<typeof resultGroups>[0]) => resultGroups(summary)[0]!.sections.map((s) => s.id);
		expect(opening({ farms: [] })).toEqual(['res-summary']);
		expect(opening({ farms: [], forecast: {} as RunSummary['forecast'] })).toEqual(['res-summary', 'res-forecast']);
	});

	it('uses unique ids', () => {
		const ids = resultSections({ farms: [{ nodeId: 'f' } as FarmSummary] }).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('movedHref', () => {
	it('sends a moved panel to its page with the run, and the reporting window to Units & supply', () => {
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
