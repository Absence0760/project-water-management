import { describe, expect, it } from 'vitest';
import { newNetworkNode, type NetworkNode } from '@water-management/engine';
import { NODE_FIELDS } from './fields';
import { fieldsLine, fieldValue, sectionSummary, type SummaryContext } from './nodeSummary';

const ctx: SummaryContext = { method: 'area', share: 0.2778, demandNames: [], boreholes: 0, coverPatches: 0, efficiency: null };
const field = (key: string) => NODE_FIELDS.find((f) => f.key === key)!;
/** A unit with a dam, as the Showcase's Vleiplaas. */
function unit(extra: Partial<NetworkNode> = {}): NetworkNode {
	return {
		...newNetworkNode('n1', 0, 'n0'),
		name: 'Vleiplaas',
		kind: 'farm',
		areaKm2: 25,
		damCapacityM3: 300_000,
		damInitialPct: 0.6,
		damMinPct: 0.15,
		damSeepagePerDay: 0,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 0.6,
		irrigationEfficiency: 0.9,
		returnFlowFraction: 0.05,
		...extra
	};
}
// Narrow no-break spaces group thousands (fmtNum).
const plain = (s: string) => s.replace(/ /g, ' ');

describe('fieldValue', () => {
	it('writes a field’s value with its unit, percentages from their 0–1 store', () => {
		const n = unit({ damAreaFullM2: 75_000, damAreaExponent: 0.7, damOutletCapacityM3Day: null });
		expect(fieldValue(field('damInitialPct'), n)).toBe('60 %');
		expect(plain(fieldValue(field('damAreaFullM2'), n))).toBe('75 000 m²');
		expect(fieldValue(field('damAreaExponent'), n)).toBe('0.7');
		expect(fieldValue(field('damOutletCapacityM3Day'), n)).toBe('not set');
		expect(fieldValue(field('damSeepagePerDay'), n)).toBe('0 %/day');
	});

	it('joins a fold’s fields into one line', () => {
		const n = unit({ damAreaExponent: 0.7, damSeepageReturnPct: 1 });
		expect(fieldsLine([field('damAreaExponent'), field('damSeepageReturnPct')], n)).toBe('Area exponent 0.7 · Seepage returning 100 %');
	});
});

describe('sectionSummary', () => {
	it('says a dam’s size and levels, or that there is none', () => {
		expect(plain(sectionSummary('dam', unit(), ctx))).toBe('300 000 m³ · starts 60 % · min 15 % · seepage 0 %/day');
		expect(sectionSummary('dam', unit({ damCapacityM3: 0 }), ctx)).toBe('No dam (capacity 0)');
	});

	it('says the area, with the high/low MAP split only under that method, and the unit’s MAP', () => {
		expect(sectionSummary('area', unit(), ctx)).toBe('25 km² · MAP not set');
		expect(sectionSummary('area', unit({ areaHiKm2: 10, areaLoKm2: 15, mapMm: 650 }), { ...ctx, method: 'hiLo' })).toBe('25 km² · high-MAP 10 · low-MAP 15 km² · MAP 650 mm');
		// A gauge has no MAP of its own.
		expect(sectionSummary('area', unit({ kind: 'gauge' }), ctx)).toBe('25 km²');
	});

	it('says the share in use and the method', () => {
		expect(sectionSummary('share', unit(), ctx)).toBe('27.78 % in use (by area)');
		expect(sectionSummary('share', unit({ flowShareManual: 0.3 }), { ...ctx, method: 'manual', share: 0.3 })).toBe('30 % in use (manual) · manual 30 %');
	});

	it('says how water reaches the dam', () => {
		expect(sectionSummary('routing', unit(), ctx)).toBe('Upstream to dam 100 % · runoff to dam 60 % · river to dam none');
		expect(sectionSummary('routing', unit({ pctUpstreamToDam: 0, divertMonthlyM3Day: new Array(12).fill(100) }), ctx)).toBe('Upstream to dam 0 % · runoff to dam 60 % · river to dam by month');
	});

	it('says the supply rule, the pump and the hands-off flow', () => {
		expect(sectionSummary('supply', unit(), ctx)).toBe('Dam only');
		expect(plain(sectionSummary('supply', unit({ supplyRule: 'riverFirst', pumpCapacityM3Day: 2000, handsOffEwr: true }), ctx))).toMatch(/^River first · pump 2 000 m³\/day · leaves the EWR$|^River first · pump [\d.]+ (m³\/s|l\/s) · leaves the EWR$/);
		expect(sectionSummary('supply', unit({ supplyRule: 'riverFirst', pumpCapacityM3Day: null }), ctx)).toBe('River first · pump no limit');
	});

	it('says the efficiency a run takes and the return flow', () => {
		expect(sectionSummary('irrigation', unit(), { ...ctx, efficiency: 0.9008 })).toBe('Efficiency 90.1 % · return flow 5 %');
		expect(sectionSummary('irrigation', unit({ abstractionFrom: '2015-10-01' }), ctx)).toBe('Efficiency 90 % · return flow 5 % · starts 2015-10-01');
	});

	it('counts and names the demand objects, boreholes and land cover', () => {
		expect(sectionSummary('demand', unit(), ctx)).toBe('None');
		expect(sectionSummary('demand', unit(), { ...ctx, demandNames: ['Packhouse'] })).toBe('1 demand object: Packhouse');
		expect(sectionSummary('demand', unit(), { ...ctx, demandNames: ['A', 'B', 'C', 'D', 'E'] })).toBe('5 demand objects: A, B, C, and 2 more');
		expect(sectionSummary('boreholes', unit(), { ...ctx, boreholes: 2 })).toBe('2 boreholes');
		expect(sectionSummary('cover', unit(), { ...ctx, coverPatches: 1 })).toBe('1 patch');
		expect(sectionSummary('cover', unit(), ctx)).toBe('None');
	});

	it('says the dam’s survey and releases', () => {
		expect(sectionSummary('damSurvey', unit(), ctx)).toBe('No survey curve · no releases');
		expect(sectionSummary('damSurvey', unit({ damReleaseRule: 'fixed', damSedimentPctPerYear: 0.005 }), ctx)).toBe('No survey curve · a fixed release each month · sediment 0.5 % a year');
	});

	it('says the combined boreholes’ capacity and rule, or none', () => {
		expect(sectionSummary('groundwater', unit(), ctx)).toBe('None');
		expect(sectionSummary('groundwater', unit({ boreholeCapacityM3Day: 500, boreholeRule: 'drought', boreholeTriggerPct: 0.3 }), ctx)).toMatch(/ · drought below 30 %$/);
	});

	it('says the bed losses, and that the outlet has no reach', () => {
		expect(sectionSummary('reach', unit(), ctx)).toBe('None lost (0 %)');
		expect(plain(sectionSummary('reach', unit({ reachLossFrac: 0.05, reachLossMaxM3Day: 2000 }), ctx))).toBe('5 % lost, at most 2 000 m³/day');
		expect(sectionSummary('reach', unit({ downstreamNodeId: null }), ctx)).toBe('None: the outlet has no reach below it');
	});

	it('says the base-flow loss and gain, or none (engine 1.86.0)', () => {
		expect(sectionSummary('baseflow', unit(), ctx)).toBe('None');
		expect(plain(sectionSummary('baseflow', unit({ baseflowLossM3Day: 1500 }), ctx))).toBe('loses 1 500 m³/day');
		expect(plain(sectionSummary('baseflow', unit({ baseflowLossM3Day: 1500, baseflowGainM3Day: 20 }), ctx))).toBe('loses 1 500 m³/day · gains 20 m³/day');
	});
});
