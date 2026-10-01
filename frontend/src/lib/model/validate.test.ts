import { describe, expect, it } from 'vitest';
import { modelRuleIssues, SUPPLY_RULES, type NetworkNode, type ProjectModel } from '@water-management/engine';
import { ewrSiteIssue, operatingIssues, supplyIssues, validateModel } from './validate';

function node(id: string, name: string, down: string | null): NetworkNode {
	return {
		id,
		name,
		kind: down === null ? 'gauge' : 'farm',
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: 1,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0
	};
}

const model = (nodes: NetworkNode[], extra: Partial<ProjectModel> = {}): ProjectModel => ({
	nodes,
	crops: [],
	cropAreas: [],
	transfers: [],
	...extra
});

const messages = (m: ProjectModel) => validateModel(m).map((i) => i.message);

describe('validateModel', () => {
	it('accepts an empty model', () => {
		expect(validateModel(model([]))).toEqual([]);
	});

	it('accepts a valid tree', () => {
		const m = model([node('g', 'Gauge', null), node('a', 'A', 'g'), node('b', 'B', 'a')]);
		expect(validateModel(m)).toEqual([]);
	});

	it('flags duplicate names case-insensitively', () => {
		const m = model([node('g', 'Gauge', null), node('a', 'Farm', 'g'), node('b', ' farm ', 'g')]);
		expect(messages(m)).toEqual(['Node name "Farm" is used 2 times.']);
	});

	it('flags blank names', () => {
		expect(messages(model([node('g', '  ', null)]))).toContain('Every node needs a name.');
	});

	it('requires exactly one outlet', () => {
		expect(messages(model([node('a', 'A', null), node('b', 'B', null)]))[0]).toMatch(/2 outlets/);
		expect(messages(model([node('a', 'A', 'b'), node('b', 'B', 'a')]))).toContain(
			'The network needs one outlet (a node that drains nowhere).'
		);
	});

	it('detects a cycle once', () => {
		const m = model([node('g', 'G', null), node('a', 'A', 'b'), node('b', 'B', 'c'), node('c', 'C', 'a')]);
		const cycles = messages(m).filter((x) => x.startsWith('Cycle'));
		expect(cycles).toHaveLength(1);
		expect(cycles[0]).toMatch(/A → B → C → A|B → C → A → B|C → A → B → C/);
	});

	it('detects self-drainage and dangling references', () => {
		const m = model([node('g', 'G', null), node('a', 'A', 'a'), node('b', 'B', 'zzz')]);
		expect(messages(m)).toEqual(['"A" drains into itself.', '"B" drains into a node that no longer exists.']);
	});

	it('checks crop and transfer references', () => {
		const m = model([node('g', 'G', null)], {
			crops: [{ id: 'c', name: 'Citrus', cropFactor: [1] }],
			cropAreas: [{ nodeId: 'x', cropId: 'c', areaM2: 1 }],
			transfers: [
				{ id: 't', fromNodeId: 'g', toNodeId: 'g', months: [13], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }
			]
		});
		expect(validateModel(m).map((i) => i.area)).toEqual(['crops', 'crops', 'transfers', 'transfers']);
	});

	it('flags out-of-range fractions and negative quantities', () => {
		const a = node('a', 'A', null);
		a.damMinPct = 1.5;
		a.damCapacityM3 = -1;
		expect(messages(model([a]))).toEqual([
			'"A": percentages must be between 0% and 100%.',
			'"A": areas and capacities can\'t be negative.'
		]);
	});

	it('needs an irrigation efficiency above 0% (abstraction = crop requirement ÷ efficiency, N1)', () => {
		const a = node('a', 'A', null);
		a.irrigationEfficiency = 0;
		expect(messages(model([a]))).toEqual(['"A": irrigation efficiency must be above 0%.']);
	});

	it('needs a whole-number transfer priority (Q18)', () => {
		const g = node('g', 'G', null);
		const f = node('f', 'F', 'g');
		const t = { id: 't', fromNodeId: 'f', toNodeId: 'g', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0.5 };
		expect(messages(model([g, f], { transfers: [t] }))).toContain('Transfer 1: priority must be a whole number.');
		expect(messages(model([g, f], { transfers: [{ ...t, priority: 2 }] }))).not.toContain('Transfer 1: priority must be a whole number.');
	});

	it('checks a river off-take: hydrological unit to hydrological unit, losses below 100 %, no negative hands-off flow (engine 1.14.0)', () => {
		const g = node('g', 'G', null);
		const f = node('f', 'F', 'g');
		const h = node('h', 'H', 'g');
		const t = { id: 't', fromNodeId: 'f', toNodeId: 'h', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, source: 'river' as const };
		expect(messages(model([g, f, h], { transfers: [t] }))).toEqual([]);
		expect(messages(model([g, f, h], { transfers: [{ ...t, toNodeId: 'g' }] }))).toContain('Transfer 1: a river off-take runs from one hydrological unit to another.');
		expect(messages(model([g, f, h], { transfers: [{ ...t, lossPct: 1 }] }))).toContain('Transfer 1: conveyance losses are 0–99%.');
		expect(messages(model([g, f, h], { transfers: [{ ...t, handsOffM3Day: -1 }] }))).toContain("Transfer 1: the hands-off flow can't be negative.");
	});

	it('checks canal seepage back to the river: a share 0–100 %, rejoining below the source or a unit below it (engine 1.42.0)', () => {
		const g = node('g', 'G', null);
		const l = node('l', 'L', 'g');
		const f = node('f', 'F', 'l');
		const h = node('h', 'H', 'g');
		const t = { id: 't', fromNodeId: 'f', toNodeId: 'h', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, source: 'river' as const, lossPct: 0.2 };
		for (const at of [null, 'f', 'l']) expect(messages(model([g, l, f, h], { transfers: [{ ...t, lossReturnPct: 0.5, lossReturnNodeId: at }] })), String(at)).toEqual([]);
		expect(messages(model([g, l, f, h], { transfers: [{ ...t, lossReturnPct: 1.5 }] }))).toContain('Transfer 1: the share of the losses seeping back is 0–100%.');
		for (const at of ['h', 'g'])
			expect(messages(model([g, l, f, h], { transfers: [{ ...t, lossReturnPct: 0.5, lossReturnNodeId: at }] }))).toContain('Transfer 1: the seepage can rejoin the river only below the source or a hydrological unit downstream of it.');
	});

	it('checks the dam evaporation fields: area ≥ 0 or unknown, exponent in (0, 1], seepage 0–100 % (N2)', () => {
		const a = node('a', 'A', null);
		a.damAreaFullM2 = null;
		expect(messages(model([a]))).toEqual([]);
		a.damAreaFullM2 = -1;
		a.damAreaExponent = 0;
		a.damSeepagePerDay = 2;
		expect(messages(model([a]))).toEqual([
			'"A": percentages must be between 0% and 100%.',
			'"A": the dam area exponent must be above 0 and at most 1.',
			'"A": the dam area can\'t be negative.'
		]);
		// No basin has b > 1 (engine ≥ 1.61.0); 1 itself, a vertical-sided pan, is allowed.
		const b = node('b', 'B', null);
		b.damAreaExponent = 1;
		expect(messages(model([b]))).toEqual([]);
		b.damAreaExponent = 1.2;
		expect(messages(model([b]))).toEqual(['"B": the dam area exponent must be above 0 and at most 1.']);
	});

	it('checks an other water user as the API does (WP-1.33)', () => {
		const town: NetworkNode = { ...node('u', 'Town', 'g'), kind: 'user', userDemandM3Day: new Array(12).fill(10), userReturnPct: 0.5, userPriority: 'senior' };
		expect(messages(model([node('g', 'Gauge', null), town, node('a', 'A', 'u')]))).toEqual([]);
		const bad = model([node('g', 'Gauge', null), { ...town, userReturnPct: 2, userDemandM3Day: [1, -1] }, node('a', 'A', 'u')], {
			crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(1) }],
			cropAreas: [{ nodeId: 'u', cropId: 'c', areaM2: 100 }],
			transfers: [{ id: 't', fromNodeId: 'a', toNodeId: 'u', months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }]
		});
		expect(messages(bad)).toEqual([
			'"Town": the share returned must be between 0% and 100%.',
			'"Town": demand needs 12 monthly values, none negative.',
			'"Town" is an other water user: its demand is monthly, so remove its crop areas.',
			'"Town" is an other water user: transfers run between hydrological units’ dams.'
		]);
	});

	it('checks boreholes as the API does (WP-1.34)', () => {
		const g = node('g', 'Gauge', null);
		expect(messages(model([g, { ...node('a', 'A', 'g'), boreholeCapacityM3Day: 100, streamDepletionFrac: 0.5 }]))).toEqual([]);
		expect(messages(model([{ ...g, boreholeCapacityM3Day: 5 }, node('a', 'A', 'g')]))).toEqual(['"Gauge": a gauge can\'t have boreholes.']);
		expect(messages(model([g, { ...node('a', 'A', 'g'), boreholeCapacityM3Day: 5, boreholeRule: 'drought' }]))).toEqual(['"A": the drought borehole rule needs a dam on the hydrological unit to trigger on.']);
		expect(messages(model([g, { ...node('a', 'A', 'g'), streamDepletionFrac: 1.5, streamDepletionLagDays: -1 }]))).toEqual([
			'"A": borehole capacity and depletion lag can\'t be negative.',
			'"A": stream depletion and the drought trigger must be between 0% and 100%.'
		]);
	});

	it('checks the GN 538 property area and rate as the API does (engine 1.12.0)', () => {
		const g = node('g', 'Gauge', null);
		const a = node('a', 'A', 'g');
		expect(messages(model([g, { ...a, gaPropertyAreaHa: 60, gaRateM3HaYear: 45 }]))).toEqual([]);
		expect(messages(model([g, { ...a, gaPropertyAreaHa: null, gaRateM3HaYear: null }]))).toEqual([]);
		expect(messages(model([g, { ...a, gaPropertyAreaHa: -1, gaRateM3HaYear: 100 }]))).toEqual([
			'"A": the GN 538 property area must be between 0 and 10 000 000 ha.',
			'"A": the GN 538 rate must be one of 0, 45, 75, 150, 275, 400 m³/ha/a.'
		]);
	});

	it('checks a dam’s survey curve, release and seepage share as the API does (WP-3.5)', () => {
		const g = node('g', 'Gauge', null);
		const curve = [
			{ levelM: 0, areaM2: 0, volumeM3: 0 },
			{ levelM: 3, areaM2: 9000, volumeM3: 20_000 }
		];
		const a = { ...node('a', 'A', 'g'), damCapacityM3: 20_000 };
		expect(messages(model([g, { ...a, damCurve: curve, damReleaseRule: 'fixed', damReleaseM3Day: new Array(12).fill(5), damSeepageReturnPct: 0.5 }]))).toEqual([]);
		expect(messages(model([g, { ...a, damCurve: [curve[1]!] }]))).toEqual(['"A": dam survey curve: a survey curve needs at least two rows.']);
		expect(messages(model([{ ...g, damCurve: curve }, a]))).toEqual(['"Gauge": dam survey curve: only a hydrological unit has a dam.']);
		expect(messages(model([g, { ...a, damSeepageReturnPct: 1.5, damOutletCapacityM3Day: -1, damReleaseM3Day: [1] }]))).toEqual([
			'"A": the share of seepage returning must be between 0% and 100%.',
			'"A": the dam outlet capacity can\'t be negative.',
			'"A": the dam release needs 12 monthly values, none negative.'
		]);
	});

	it('checks the development fields as the API does (engine 1.30.0, issue #67)', () => {
		const g = node('g', 'Gauge', null);
		const a = { ...node('a', 'A', 'g'), damCapacityM3: 20_000 };
		const u = { ...node('u', 'Town', 'g'), kind: 'user' as const, damCapacityM3: 0 };
		const dev = { damSurveyDate: '2012-02-29', damSedimentPctPerYear: 0.01, damInServiceFrom: '2000-10-01', abstractionFrom: '2001-01-01' };
		expect(messages(model([g, { ...a, ...dev }, { ...u, abstractionFrom: '2005-01-01' }]))).toEqual([]);
		expect(messages(model([g, { ...a, damSedimentPctPerYear: 0.01 }]))).toEqual(['"A": a sediment rate needs the date the capacity was surveyed.']);
		expect(messages(model([g, { ...a, ...dev, damSedimentPctPerYear: 0.3 }]))).toEqual(['"A": the sediment rate must be 0 to 20 % of the capacity a year.']);
		expect(messages(model([g, { ...a, damInServiceFrom: '2001-02-29' }]))).toEqual(['"A": the in-service date must be a date (YYYY-MM-DD).']);
		expect(messages(model([g, a, { ...u, damSurveyDate: '2001-01-01' }]))).toEqual(['"Town": only a hydrological unit has a dam; clear its dam dates and sediment rate.']);
		expect(messages(model([{ ...g, abstractionFrom: '2001-01-01' }, a]))).toEqual(['"Gauge": a gauge takes no water.']);
	});

	it('checks land cover as the API does (WP-1.35)', () => {
		const g = node('g', 'Gauge', null);
		const p = { id: 'p', nodeId: 'a', coverClass: 'pine' as const, areaKm2: 1, densityPct: 0.5, factors: null };
		expect(messages(model([g, node('a', 'A', 'g')], { landCover: [p] }))).toEqual([]);
		expect(messages(model([g, node('a', 'A', 'g')], { landCover: [{ ...p, nodeId: 'g' }] }))).toEqual(['"Gauge": land cover lies on a hydrological unit, not a gauge.']);
		expect(messages(model([g, node('a', 'A', 'g')], { landCover: [{ ...p, densityPct: 2 }] }))).toEqual(['Land cover on "A": area can\'t be negative, cover and reductions are 0–100%.']);
	});

	it('checks individual boreholes as the API does (WP-3.9)', () => {
		const g = node('g', 'Gauge', null);
		const b = { id: 'b', nodeId: 'a', name: 'BH1', capacityM3Day: 100, annualCapM3: null, mode: 'supplemental' as const, emergencyBelowPct: 0.3, target: 'direct' as const, depletionFactor: 0 };
		const nodes = [g, node('a', 'A', 'g')];
		expect(messages(model(nodes, { boreholes: [b] }))).toEqual([]);
		expect(messages(model(nodes, { boreholes: [{ ...b, nodeId: 'g' }] }))).toEqual(['Borehole "BH1" on "Gauge": a gauge can\'t have boreholes.']);
		expect(messages(model(nodes, { boreholes: [{ ...b, nodeId: 'x' }] }))).toEqual(['A borehole refers to a deleted node.']);
		expect(messages(model(nodes, { boreholes: [{ ...b, depletionFactor: 2 }] }))).toEqual([
			'Borehole "BH1" on "A": capacity and annual cap can\'t be negative; the emergency level and depletion are 0–100%.'
		]);
	});

	it('checks the supply rule and river pump as the API does (WP-3.8)', () => {
		const g = node('g', 'Gauge', null);
		const farm = (over: Partial<NetworkNode>) => ({ ...node('a', 'A', 'g'), ...over });
		expect(messages(model([g, farm({ supplyRule: 'riverFirst', pumpCapacityM3Day: 1200 })]))).toEqual([]);
		expect(messages(model([g, farm({ supplyRule: 'runOfRiver', damCapacityM3: 50_000 })]))).toEqual([
			'"A": run of river has no dam; set the dam capacity to 0 or pick another supply rule.'
		]);
		expect(messages(model([g, farm({ supplyRule: 'trigger' })]))).toEqual([
			'"A": the “dam, river when low” supply rule needs a dam to switch on; enter a dam capacity or pick another supply rule.'
		]);
		expect(messages(model([g, farm({ supplyRule: 'trigger', damCapacityM3: 50_000, supplyTriggerPct: 0.6, supplyStopPct: 0.4 })]))).toEqual([
			'"A": the switch-back level must be at least the switch-to-river level.'
		]);
		expect(messages(model([g, farm({ pumpCapacityM3Day: -1 })]))).toEqual(['"A": the river pump capacity can\'t be negative.']);
		expect(messages(model([{ ...g, supplyRule: 'riverFirst' }, farm({})]))).toEqual([
			'"Gauge": only a hydrological unit has a supply rule and river pump; set the supply rule to dam only and clear the pump capacity.'
		]);
	});

	it('refuses a hands-off flow or River to dam by month off a farm, and a bad month, as the API does (engine 1.32.0)', () => {
		const g = node('g', 'Gauge', null);
		const farm = (over: Partial<NetworkNode>) => ({ ...node('a', 'A', 'g'), ...over });
		const twelve = new Array(12).fill(100);
		expect(messages(model([g, farm({ handsOffM3Day: twelve, handsOffEwr: true, divertMonthlyM3Day: twelve })]))).toEqual([]);
		expect(messages(model([g, farm({ handsOffM3Day: [...twelve.slice(1), -1] })]))).toEqual(['"A": the hands-off flow needs 12 monthly values, none negative.']);
		expect(messages(model([g, farm({ divertMonthlyM3Day: [1, 2] })]))).toEqual(['"A": River to dam by month needs 12 monthly values, none negative.']);
		expect(messages(model([{ ...g, handsOffEwr: true }, farm({})]))).toEqual(['"Gauge": only a hydrological unit has a hands-off flow and River to dam by month; clear them.']);
		// Exactly the backend's model rule on the kind (engine operatingKind).
		for (const kind of ['farm', 'user', 'gauge'] as const)
			for (const over of [{}, { handsOffM3Day: twelve }, { handsOffEwr: true }, { handsOffEwr: false }, { divertMonthlyM3Day: twelve }] as Partial<NetworkNode>[]) {
				const n: NetworkNode = { ...node('a', 'A', 'g'), kind, ...over };
				const backend = [...modelRuleIssues(model([g, n])).keys()].some((k) => k.startsWith('operatingKind'));
				expect(operatingIssues(n).length > 0, JSON.stringify({ kind, over })).toBe(backend);
			}
	});

	it('refuses the EWR site flag off the outlet or a hydrological unit, exactly as the backend does (engine 1.5.0)', () => {
		const g = node('g', 'Gauge', null);
		const weir = { ...node('w', 'Weir', 'g'), kind: 'gauge' as const };
		const a = node('a', 'A', 'w');
		for (const [n, ok] of [[{ ...weir, ewrSite: false }, true], [{ ...weir, ewrSite: true }, true], [{ ...g, ewrSite: false }, false], [{ ...a, ewrSite: false }, false]] as const) {
			expect(ewrSiteIssue(n) === null, n.id).toBe(ok);
			const nodes = [g, weir, a].map((x) => (x.id === n.id ? n : x));
			const backend = [...modelRuleIssues(model(nodes)).keys()].some((k) => k.startsWith('ewrSite'));
			expect(backend, n.id).toBe(!ok);
		}
		expect(ewrSiteIssue({ ...g, ewrSite: false })).toMatch(/the outlet is always an EWR site/);
	});

	it('refuses exactly the supply combinations the backend refuses (engine modelRules)', () => {
		const g = node('g', 'Gauge', null);
		for (const kind of ['farm', 'user', 'gauge'] as const)
			for (const supplyRule of SUPPLY_RULES)
				for (const damCapacityM3 of [0, 50_000])
					for (const [supplyTriggerPct, supplyStopPct] of [[0.4, 0.6], [0.6, 0.4]] as const)
						for (const pumpCapacityM3Day of [null, 1200]) {
							const n: NetworkNode = { ...node('a', 'A', 'g'), kind, supplyRule, damCapacityM3, supplyTriggerPct, supplyStopPct, pumpCapacityM3Day };
							const backend = [...modelRuleIssues(model([g, n])).keys()].some((k) => k.startsWith('supply'));
							expect(supplyIssues(n).length > 0, JSON.stringify({ kind, supplyRule, damCapacityM3, supplyTriggerPct, pumpCapacityM3Day })).toBe(backend);
						}
	});

	it('refuses exactly the demand objects the backend refuses (engine 1.7.0)', () => {
		const g = node('g', 'Gauge', null);
		const a = node('a', 'A', 'g');
		const u = { ...node('u', 'U', 'g'), kind: 'user' as const };
		const o = (over: object) => ({ id: 'o', nodeId: 'a', name: 'Town', category: 'municipal', sizing: 'monthly', monthlyM3Day: new Array(12).fill(1), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0, priority: 'first', destination: 'internal', enabled: true, note: '', ...over }) as never;
		for (const [over, bad] of [
			[{}, false],
			[{ nodeId: 'u' }, true],
			[{ monthlyM3Day: [1, 2] }, true],
			[{ sizing: 'perUnit', monthlyM3Day: null }, true],
			[{ sizing: 'perUnit', monthlyM3Day: null, count: 50, litresPerUnitDay: 90 }, false],
			[{ destination: 'external', returnPct: 0.2 }, true],
			// The people it serves, for the basic-needs floor (engine 1.44.0): none, a number, never negative.
			[{ population: null }, false],
			[{ population: 2000 }, false],
			[{ population: -1 }, true],
			// Where its number comes from (engine 1.56.0): none, or a source with the sizing it gives.
			[{ source: null }, false],
			[{ source: 'meter' }, false],
			[{ source: 'aadd' }, false],
			[{ source: 'other' }, false],
			[{ source: 'perCapita' }, true],
			[{ source: 'perCapita', sizing: 'perUnit', monthlyM3Day: null, count: 50, litresPerUnitDay: 90 }, false],
			[{ source: 'other', sizing: 'perUnit', monthlyM3Day: null, count: 50, litresPerUnitDay: 90 }, false],
			[{ source: 'meter', sizing: 'perUnit', monthlyM3Day: null, count: 50, litresPerUnitDay: 90 }, true],
			[{ source: 'aadd', sizing: 'perUnit', monthlyM3Day: null, count: 50, litresPerUnitDay: 90 }, true],
			[{ source: 'survey' }, true],
			// A schedule (engine 1.17.0): a good window, a bad date, too many windows.
			[{ schedule: [{ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0 }] }, false],
			[{ schedule: [{ label: '', span: 'yearly', from: '02-30', to: '03-01', easterFrom: null, easterTo: null, weekdays: null, factor: 0 }] }, true],
			[{ schedule: Array.from({ length: 25 }, () => ({ label: '', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: null, factor: 1 })) }, true]
		] as const) {
			const m = model([g, a, u], { demandObjects: [o(over)] });
			const backend = [...modelRuleIssues(m).keys()].some((k) => k.startsWith('do'));
			expect(backend, JSON.stringify(over)).toBe(bad);
			expect(messages(m).some((x) => /demand object/i.test(x)), JSON.stringify(over)).toBe(bad);
		}
	});
});
