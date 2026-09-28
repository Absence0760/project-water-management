// One farm's view of a published outlook (issue #53 R5, E3), on the invented
// catchment (../outlook/testCatchment.ts).
import { describe, expect, it } from 'vitest';
import { runSeasonalOutlook } from '../outlook/outlook';
import { testCatchment } from '../outlook/testCatchment';
import { farmOutlookProjection } from './farmOutlook';

const input = testCatchment({ dailyApan: true });
const outlook = runSeasonalOutlook(input, {
	decisionDate: '2012-10-01',
	seasonEnd: '2013-04-30',
	levels: [
		{ id: '0', label: '100 %', ops: [{ op: 'demand.scale', factor: 1 }] },
		{ id: '1', label: '70 %', ops: [{ op: 'demand.scale', factor: 0.7 }] }
	]
});

describe('farmOutlookProjection', () => {
	it('carries only the farm’s own figures, at the published level', () => {
		const got = farmOutlookProjection(outlook, '1', 'a', '2013-01-01');
		expect(got.problem).toBeNull();
		const p = got.projection!;
		const level = outlook.levels[1]!;
		expect(p).toMatchObject({ decisionDate: '2012-10-01', seasonEnd: '2013-04-30', reviewDate: '2013-01-01', level: { id: '1', label: '70 %' }, nYears: outlook.nYears });
		expect(p.demandMet).toEqual(level.demandMetByFarm.find((f) => f.nodeId === 'a')!.stat);
		const dam = level.storageByDam.find((d) => d.nodeId === 'a')!;
		expect(p.dam!.capacityM3).toBe(300_000);
		expect(p.dam!.seasonEndShare!.p50).toBeCloseTo(dam.stat!.p50 / 300_000, 12);
		// No other farm's id or name anywhere in it, and only its own keys.
		expect(JSON.stringify(p)).not.toMatch(/Farm B|"b"|Farm A/);
		expect(Object.keys(p).sort()).toEqual(['dam', 'decisionDate', 'demandMet', 'demandYears', 'level', 'nYears', 'reviewDate', 'seasonEnd']);
	});

	it('every share is a fraction in 0–1, p10 ≤ p50 ≤ p90', () => {
		for (const l of ['0', '1']) {
			for (const id of ['a', 'b']) {
				const p = farmOutlookProjection(outlook, l, id, null).projection!;
				for (const s of [p.demandMet!, p.dam!.seasonEndShare!]) {
					expect(0 <= s.p10 && s.p10 <= s.p50 && s.p50 <= s.p90 && s.p90 <= 1 + 1e-9).toBe(true);
				}
			}
		}
	});

	it('says why there is no projection', () => {
		expect(farmOutlookProjection(outlook, '9', 'a', null)).toEqual({ projection: null, problem: 'noSuchLevel' });
		const notRun = { ...outlook, levels: [{ ...outlook.levels[0]!, problems: ['op 1 (demand.scale): no such node'] }] };
		expect(farmOutlookProjection(notRun, '0', 'a', null).problem).toBe('levelNotRun');
		// An outlook stored before engine 1.18.0 has no per-farm figures: re-run it.
		const old = { ...outlook, levels: outlook.levels.map(({ demandMetByFarm: _, ...l }) => l) } as unknown as typeof outlook;
		expect(farmOutlookProjection(old, '0', 'a', null).problem).toBe('noFarmFigures');
	});

	it('a farm without a dam or demand gets nulls, not zeros', () => {
		const p = farmOutlookProjection(outlook, '0', 'g', null).projection!;
		expect(p).toMatchObject({ demandYears: 0, demandMet: null, dam: null });
	});
});
