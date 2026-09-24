import type { FarmSummary, RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { resultSections } from './sections';

describe('resultSections', () => {
	it('lists every panel in page order, with farm detail only when there are farms', () => {
		const farm = { nodeId: 'f' } as FarmSummary;
		expect(resultSections({ farms: [farm] }).map((s) => s.id)).toEqual([
			'res-summary',
			'res-curtailment',
			'res-hydrograph',
			'res-calibration',
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
		expect(ids.slice(ids.indexOf('res-calibration'), ids.indexOf('res-calibration') + 3)).toEqual(['res-calibration', 'res-runoff', 'res-fdc']);
	});

	it('adds the WR2012 check after the runoff model when the run has one', () => {
		const ids = resultSections({ farms: [], runoff: { model: 'gr4j' } as RunSummary['runoff'], wr2012: {} as RunSummary['wr2012'] }).map((s) => s.id);
		expect(ids.slice(ids.indexOf('res-runoff'), ids.indexOf('res-runoff') + 3)).toEqual(['res-runoff', 'res-wr2012', 'res-fdc']);
		expect(resultSections({ farms: [] }).map((s) => s.id)).not.toContain('res-wr2012');
	});

	it('uses unique ids', () => {
		const ids = resultSections({ farms: [{ nodeId: 'f' } as FarmSummary] }).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
