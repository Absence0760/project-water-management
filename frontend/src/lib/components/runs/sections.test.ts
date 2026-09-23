import type { FarmSummary } from '@water-management/engine';
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
			'res-farm',
			'res-explore'
		]);
		expect(resultSections({ farms: [] }).map((s) => s.id)).not.toContain('res-farm');
	});

	it('uses unique ids', () => {
		const ids = resultSections({ farms: [{ nodeId: 'f' } as FarmSummary] }).map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
