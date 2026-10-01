import { describe, expect, it } from 'vitest';
import { DEMAND_OBJECT_SOURCES, modelRuleIssues, type DemandObject, type ProjectModel } from '@water-management/engine';
import { setSizing, setSource, sizingFixedBy, SOURCE_OPTION_LABEL } from './demandObjectSource';

const object = (over: Partial<DemandObject> = {}): DemandObject => ({
	id: 'o',
	nodeId: 'a',
	name: 'Town',
	category: 'municipal',
	sizing: 'monthly',
	monthlyM3Day: new Array(12).fill(40),
	count: null,
	litresPerUnitDay: null,
	lossPct: 0,
	monthlyFactor: null,
	returnPct: 0,
	priority: 'first',
	destination: 'internal',
	enabled: true,
	note: '',
	...over
});

const model = (o: DemandObject) =>
	({
		nodes: [{ id: 'a', name: 'A', kind: 'farm', downstreamNodeId: null }],
		crops: [],
		cropAreas: [],
		transfers: [],
		demandObjects: [o]
	}) as unknown as ProjectModel;

describe('demand object source in the node form (engine 1.56.0)', () => {
	it('has words for every source', () => {
		expect(Object.keys(SOURCE_OPTION_LABEL)).toEqual([...DEMAND_OBJECT_SOURCES]);
	});

	it('a per-capita source gives the demand as a count × litres, with the norm for a new count', () => {
		const o = object({ category: 'domestic' });
		setSource(o, 'perCapita');
		expect(o).toMatchObject({ source: 'perCapita', sizing: 'perUnit', count: 0, litresPerUnitDay: 230 });
		// The monthly values stay, so switching back loses nothing.
		expect(o.monthlyM3Day).toEqual(new Array(12).fill(40));
		expect(sizingFixedBy(o)).toBe('perUnit');
		expect(modelRuleIssues(model(o)).size).toBe(0);
	});

	it('a meter record or an AADD gives it as m³/day by month; livestock keep their own norm', () => {
		for (const source of ['meter', 'aadd'] as const) {
			const o = object({ category: 'livestock', sizing: 'perUnit', monthlyM3Day: null, count: 300, litresPerUnitDay: 45 });
			setSource(o, source);
			expect(o).toMatchObject({ source, sizing: 'monthly', monthlyM3Day: new Array(12).fill(0), count: 300 });
			expect(sizingFixedBy(o)).toBe('monthly');
			expect(modelRuleIssues(model(o)).size).toBe(0);
		}
		const cattle = object({ category: 'livestock' });
		setSizing(cattle, 'perUnit');
		expect(cattle.litresPerUnitDay).toBe(45);
	});

	it('other, or none, leaves the sizing as it was and to the modeller', () => {
		for (const source of ['other', null] as const) {
			for (const sizing of ['monthly', 'perUnit'] as const) {
				const o = object(sizing === 'perUnit' ? { sizing, monthlyM3Day: null, count: 10, litresPerUnitDay: 90 } : {});
				setSource(o, source);
				expect(o.source).toBe(source);
				expect(o.sizing).toBe(sizing);
				expect(sizingFixedBy(o)).toBeNull();
				expect(modelRuleIssues(model(o)).size).toBe(0);
			}
		}
		expect(sizingFixedBy(object())).toBeNull();
	});
});
