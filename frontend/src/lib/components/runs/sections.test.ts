import type { FarmSummary, RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { activeSectionId, resultSections } from './sections';

describe('resultSections', () => {
	it('lists every panel in page order, with farm detail only when there are farms', () => {
		const farm = { nodeId: 'f' } as FarmSummary;
		expect(resultSections({ farms: [farm] }).map((s) => s.id)).toEqual([
			'res-summary',
			'res-water',
			'res-checks',
			'res-curtailment',
			'res-hydrograph',
			'res-calibration',
			'res-notes',
			'res-fdc',
			'res-ewr',
			'res-ewr-grid',
			'res-ewr-agreement',
			'res-farm',
			'res-explore'
		]);
		expect(resultSections({ farms: [] }).map((s) => s.id)).not.toContain('res-farm');
		expect(resultSections({ farms: [] }).map((s) => s.id)).not.toContain('res-runoff');
	});

	it('adds the runoff model panel after calibration for a GR4J run', () => {
		const ids = resultSections({ farms: [], runoff: { model: 'gr4j' } as RunSummary['runoff'] }).map((s) => s.id);
		expect(ids.slice(ids.indexOf('res-calibration'), ids.indexOf('res-calibration') + 3)).toEqual(['res-calibration', 'res-runoff', 'res-notes']);
	});

	it('adds the WR2012 check after the runoff model when the run has one, with the run notes under it', () => {
		const ids = resultSections({ farms: [], runoff: { model: 'gr4j' } as RunSummary['runoff'], wr2012: {} as RunSummary['wr2012'] }).map((s) => s.id);
		expect(ids.slice(ids.indexOf('res-runoff'), ids.indexOf('res-runoff') + 4)).toEqual(['res-runoff', 'res-wr2012', 'res-notes', 'res-fdc']);
		expect(resultSections({ farms: [] }).map((s) => s.id)).not.toContain('res-wr2012');
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
