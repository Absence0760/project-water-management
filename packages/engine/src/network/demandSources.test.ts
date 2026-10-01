import { describe, expect, it } from 'vitest';
import { demandBySource, demandSourceShares } from './demandSources';

describe('demand by source (engine 1.56.0; the run table and the evidence report’s § 6)', () => {
	it('shares the demand by source in the rule’s order, not recorded last, and counts each', () => {
		expect(
			demandSourceShares([
				{ source: null, avgDemandM3Day: 10 },
				{ source: 'perCapita', avgDemandM3Day: 30 },
				{ source: 'meter', avgDemandM3Day: 50 },
				{ source: 'meter', avgDemandM3Day: 10 }
			])
		).toEqual([
			{ source: 'meter', demandM3Day: 60, share: 0.6, objects: 2 },
			{ source: 'perCapita', demandM3Day: 30, share: 0.3, objects: 1 },
			{ source: null, demandM3Day: 10, share: 0.1, objects: 1 }
		]);
	});

	it('the evidence report’s shares say "not recorded" when nothing is; the run table’s say nothing', () => {
		const none = [{ avgDemandM3Day: 5 }, { source: null, avgDemandM3Day: 3 }];
		expect(demandSourceShares(none)).toEqual([{ source: null, demandM3Day: 8, share: 1, objects: 2 }]);
		expect(demandBySource(none)).toEqual([]);
		expect(demandSourceShares([])).toEqual([]);
	});

	it('no demand at all is 0 %, not NaN', () => {
		expect(demandSourceShares([{ source: 'aadd', avgDemandM3Day: 0 }])).toEqual([{ source: 'aadd', demandM3Day: 0, share: 0, objects: 1 }]);
	});
});
