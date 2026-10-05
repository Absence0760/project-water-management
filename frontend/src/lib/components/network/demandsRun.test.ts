import type { DemandObjectSummary, FarmSummary, RunSummary, UserSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { DemandRow } from './demands';
import { demandRunFigures, runTotal } from './demandsRun';

const row = (key: string, kind: DemandRow['kind'], nodeId: string, enabled = true): DemandRow =>
	({ key, kind, nodeId, enabled }) as unknown as DemandRow;
const obj = (id: string, d: number, s: number): DemandObjectSummary => ({ id, avgDemandM3Day: d, avgSuppliedM3Day: s, avgDeficitM3Day: d - s }) as unknown as DemandObjectSummary;
const farm = (nodeId: string, d: number, s: number, objects?: DemandObjectSummary[]): FarmSummary =>
	({ nodeId, avgDemandM3Day: d, avgSuppliedM3Day: s, avgDeficitM3Day: d - s, demandObjects: objects }) as unknown as FarmSummary;
const user = (nodeId: string, d: number, s: number): UserSummary => ({ nodeId, avgDemandM3Day: d, avgSuppliedM3Day: s, avgDeficitM3Day: d - s }) as unknown as UserSummary;
const summary = (farms: FarmSummary[], users?: UserSummary[]): RunSummary => ({ farms, users }) as unknown as RunSummary;

describe('demandRunFigures', () => {
	const rows = [row('object@town', 'object', 'U'), row('crops@U', 'crops', 'U'), row('user@Q', 'user', 'Q')];
	const run = summary([farm('U', 1000, 700, [obj('town', 200, 200)])], [user('Q', 50, 30)]);

	it('reads an object’s own figures, the crops as the unit less its objects, a user’s own', () => {
		const f = demandRunFigures(rows, run);
		expect(f.get('object@town')).toEqual({ demandM3Day: 200, suppliedM3Day: 200, shortM3Day: 0, shortShare: 0 });
		expect(f.get('crops@U')).toEqual({ demandM3Day: 800, suppliedM3Day: 500, shortM3Day: 300, shortShare: 300 / 800 });
		expect(f.get('user@Q')!.shortShare).toBeCloseTo(0.4, 9);
	});

	it('has no figure for a row the run doesn’t have', () => {
		const f = demandRunFigures([row('object@new', 'object', 'U'), row('crops@V', 'crops', 'V'), row('user@R', 'user', 'R')], run);
		expect(f.size).toBe(0);
	});

	it('takes a unit without objects whole for its crops, and gives no share without demand', () => {
		const f = demandRunFigures([row('crops@U', 'crops', 'U')], summary([farm('U', 0, 0)]));
		expect(f.get('crops@U')).toEqual({ demandM3Day: 0, suppliedM3Day: 0, shortM3Day: 0, shortShare: null });
	});

	it('treats a subtraction’s rounding leftover as zero, never negative', () => {
		const f = demandRunFigures([row('crops@U', 'crops', 'U')], summary([farm('U', 200 + 1e-9, 200, [obj('t', 200, 200)])]));
		expect(f.get('crops@U')!.demandM3Day).toBe(0);
		expect(f.get('crops@U')!.shortShare).toBeNull();
	});
});

describe('runTotal', () => {
	it('sums the modelled rows with a figure', () => {
		const rows = [row('object@town', 'object', 'U'), row('crops@U', 'crops', 'U'), row('object@off', 'object', 'U', false)];
		const f = demandRunFigures(rows, summary([farm('U', 1000, 700, [obj('town', 200, 200)])]));
		expect(runTotal(rows, f)).toEqual({ demandM3Day: 1000, suppliedM3Day: 700, shortM3Day: 300, shortShare: 0.3 });
	});
	it('is null with no figures', () => {
		expect(runTotal([row('crops@U', 'crops', 'U')], new Map())).toBeNull();
	});
});
