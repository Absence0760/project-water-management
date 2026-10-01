import { describe, expect, it } from 'vitest';
import { demandBySource, sourceLabel, sourceLine } from './demandSources';

describe('demand by source (engine 1.56.0)', () => {
	it('shares the objects’ demand by source, in the rule’s order, not recorded last', () => {
		const shares = demandBySource([
			{ source: undefined, avgDemandM3Day: 10 },
			{ source: 'perCapita', avgDemandM3Day: 30 },
			{ source: 'meter', avgDemandM3Day: 50 },
			{ source: 'meter', avgDemandM3Day: 10 }
		]);
		expect(shares).toEqual([
			{ source: 'meter', demandM3Day: 60, share: 0.6, objects: 2 },
			{ source: 'perCapita', demandM3Day: 30, share: 0.3, objects: 1 },
			{ source: null, demandM3Day: 10, share: 0.1, objects: 1 }
		]);
		expect(sourceLine(shares)).toBe('Of their demand, 60% is from meter records, 30% from a per-capita norm and 10% not recorded.');
	});

	it('says nothing for a run where no object records a source (every run before engine 1.56.0)', () => {
		expect(demandBySource([{ avgDemandM3Day: 5 }, { avgDemandM3Day: 3 }])).toEqual([]);
		expect(sourceLine([])).toBeNull();
		expect(demandBySource([])).toEqual([]);
	});

	it('one source; no demand at all is 0 %, not NaN', () => {
		const shares = demandBySource([{ source: 'aadd', avgDemandM3Day: 0 }]);
		expect(shares).toEqual([{ source: 'aadd', demandM3Day: 0, share: 0, objects: 1 }]);
		expect(sourceLine(shares)).toBe('Of their demand, 0% is from a strategy’s AADD.');
		expect(sourceLine(demandBySource([{ source: 'other', avgDemandM3Day: 4 }]))).toBe('Of their demand, 100% is from another source.');
	});

	it('labels a source for the table', () => {
		expect(sourceLabel('meter')).toBe('Meter records');
		expect(sourceLabel('perCapita')).toBe('Per-capita norm');
		expect(sourceLabel(undefined)).toBe('not recorded');
		expect(sourceLabel(null)).toBe('not recorded');
	});
});
