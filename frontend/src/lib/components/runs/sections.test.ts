import type { FarmSummary, RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { activeSectionId, resultGroups, resultSections } from './sections';

describe('resultGroups', () => {
	it('groups the panels by the question they answer, in page order', () => {
		const farm = { nodeId: 'f' } as FarmSummary;
		expect(resultGroups({ farms: [farm] }).map((g) => [g.label, g.sections.map((s) => s.id)])).toEqual([
			[null, ['res-summary', 'res-notes']],
			['River & Reserve', ['res-ewr', 'res-ewr-grid']],
			['Farms & users', ['res-curtailment', 'res-farm']],
			['Model quality', ['res-hydrograph', 'res-calibration', 'res-ewr-agreement']],
			['Dig deeper', ['res-checks', 'res-explore']]
		]);
	});

	it('flattens the groups for the scroll spy', () => {
		const summary = { farms: [{ nodeId: 'f' } as FarmSummary] };
		expect(resultSections(summary)).toEqual(resultGroups(summary).flatMap((g) => g.sections));
	});

	it('shows farm detail only when there are farms', () => {
		expect(resultSections({ farms: [] }).map((s) => s.id)).not.toContain('res-farm');
	});

	it('adds the optional model-quality panels in order: runoff model (GR4J), WR2012, then plausibility after EWR vs observed', () => {
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
		).toEqual(['res-hydrograph', 'res-calibration', 'res-runoff', 'res-wr2012', 'res-ewr-agreement', 'res-plausibility']);
	});

	it('names the entries that cover two panels', () => {
		const all = resultSections({ farms: [] });
		expect(all.find((s) => s.id === 'res-calibration')?.label).toBe('Calibration & uncertainty');
		expect(all.find((s) => s.id === 'res-notes')?.label).toBe('Notes & evidence');
		// The flow-duration curve sits beside EWR vs outflow, so it has no entry of its own.
		expect(all.find((s) => s.id === 'res-ewr')?.label).toBe('EWR & flow duration');
		expect(all.map((s) => s.id)).not.toContain('res-fdc');
	});

	it('uses unique ids', () => {
		const ids = resultSections({ farms: [{ nodeId: 'f' } as FarmSummary] }).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('activeSectionId', () => {
	const tops = (...t: number[]) => t.map((top, i) => ({ id: `s${i}`, top }));

	it('marks the last section whose top has reached the line under the header', () => {
		expect(activeSectionId(tops(-900, -200, 60, 700), 68)).toBe('s2');
		expect(activeSectionId(tops(-900, -200, 69, 700), 68)).toBe('s1');
	});

	it('marks the first section before any has reached the line', () => {
		expect(activeSectionId(tops(300, 900), 68)).toBe('s0');
	});

	it('marks the last section at the bottom of the page, even if it never reached the line', () => {
		expect(activeSectionId(tops(-900, -200, 400), 68, true)).toBe('s2');
	});

	it('has nothing to mark before any section is on the page', () => {
		expect(activeSectionId([], 68)).toBeNull();
	});
});
