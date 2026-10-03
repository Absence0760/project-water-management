import { describe, expect, it } from 'vitest';
import {
	DAM_AREA_EXPONENT,
	defaultProjectSettings,
	estimatedDamAreaForEngine,
	estimatedDamAreaM2,
	IRRIGATION_SYSTEMS,
	irrigationFromReturnFlow,
	NEW_FARM_IRRIGATION,
	NEW_FARM_IRRIGATION_SYSTEM,
	newNetworkNode,
	PAN_COEFFICIENT_PRESETS,
	PAN_COEFFICIENT_TYPICAL_MAX,
	PAN_COEFFICIENT_TYPICAL_MIN,
	panCoefficientOutOfRange,
	returnFlowFromLossReturn,
	runReturnFlow,
	upgradeLegacyModel
} from './project';

describe('panCoefficientOutOfRange', () => {
	it('names no months when every value sits inside 0.6–0.85 (boundaries included)', () => {
		expect(panCoefficientOutOfRange(defaultProjectSettings().panCoefficient)).toEqual([]);
		expect(panCoefficientOutOfRange([PAN_COEFFICIENT_TYPICAL_MIN, PAN_COEFFICIENT_TYPICAL_MAX])).toEqual([]);
	});

	it('names each out-of-range month by water-year index', () => {
		const values = [0.5, 0.7, 0.9, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.59];
		expect(panCoefficientOutOfRange(values)).toEqual([0, 2, 11]);
	});
});

describe('PAN_COEFFICIENT_PRESETS', () => {
	it('has 12 water-year-order values per preset, every one inside the FAO-56 typical range', () => {
		for (const preset of PAN_COEFFICIENT_PRESETS) {
			expect(preset.values, preset.id).toHaveLength(12);
			expect(panCoefficientOutOfRange(preset.values), preset.id).toEqual([]);
		}
		expect(PAN_COEFFICIENT_PRESETS.map((p) => p.id)).toEqual(['generic', 'winter-rainfall', 'summer-rainfall']);
	});

	it('the generic preset matches the flat default', () => {
		const generic = PAN_COEFFICIENT_PRESETS.find((p) => p.id === 'generic')!;
		expect(generic.values).toEqual(defaultProjectSettings().panCoefficient);
	});

	it('winter and summer presets differ from generic and from each other', () => {
		const [generic, winter, summer] = PAN_COEFFICIENT_PRESETS;
		expect(winter!.values).not.toEqual(generic!.values);
		expect(summer!.values).not.toEqual(generic!.values);
		expect(winter!.values).not.toEqual(summer!.values);
	});
});

describe('IRRIGATION_SYSTEMS (SABI 2021 system efficiencies, issue #54 Q10)', () => {
	// SABI Agricultural Design Norms 2021, Table 4, "proposed default system efficiency" min–max (%), pp. 9–10.
	const TABLE_4: Record<string, [number, number]> = {
		drip: [90, 95],
		micro: [80, 85],
		pivot: [80, 90],
		sprinkler: [75, 90],
		movable: [70, 83],
		surface: [60, 95] // piped 80–95, lined canal 70–90, earth canal 60–83
	};
	// Issue #54 Q10's recommended values.
	const Q10: Record<string, number> = { drip: 0.9, micro: 0.82, pivot: 0.85, sprinkler: 0.8, movable: 0.75, surface: 0.7 };

	it('keeps Table 4 ranges and offers the Q10 value, inside its range', () => {
		expect(IRRIGATION_SYSTEMS.map((s) => s.id)).toEqual(Object.keys(TABLE_4));
		for (const s of IRRIGATION_SYSTEMS) {
			expect([s.min * 100, s.max * 100].map(Math.round), s.id).toEqual(TABLE_4[s.id]);
			expect(s.efficiency, s.id).toBe(Q10[s.id]);
			expect(s.efficiency >= s.min && s.efficiency <= s.max, s.id).toBe(true);
		}
	});

	it('offers each efficiency once, so a stored value names at most one system', () => {
		const values = IRRIGATION_SYSTEMS.map((s) => s.efficiency);
		expect(new Set(values).size).toBe(values.length);
	});

	it('starts a new farm on drip (confirmed by the client, issue #90), 10 % of the water supplied returning (all its losses)', () => {
		expect(NEW_FARM_IRRIGATION_SYSTEM).toBe('drip');
		const drip = IRRIGATION_SYSTEMS.find((s) => s.id === NEW_FARM_IRRIGATION_SYSTEM)!;
		expect(NEW_FARM_IRRIGATION).toEqual({ irrigationEfficiency: drip.efficiency, returnFlowFraction: 0.1 });
		expect(NEW_FARM_IRRIGATION.irrigationEfficiency).toBe(0.9);
	});
});

describe('the return flow, a share of the water supplied (engine ≥ 1.71.0)', () => {
	it('runs r as given up to the losses 1 − e, caps it there, and takes float noise at the cap as the cap', () => {
		expect(runReturnFlow(0.05, 0.9)).toBe(0.05);
		expect(runReturnFlow(0.3, 0.9)).toBeCloseTo(0.1, 12);
		expect(runReturnFlow(0.1, 1 - 0.1)).toBe(0.1); // 1 − 0.9 is 0.09999999999999998: not over the cap
		expect(runReturnFlow(-0.1, 0.9)).toBe(0);
		expect(runReturnFlow(Number.NaN, 0.9)).toBe(0);
		expect(runReturnFlow(0.2, 1)).toBe(0); // nothing lost, nothing returns
	});

	it('converts β, the share of the losses engine 0.16.0–1.70.0 stored, to r = β(1 − e)', () => {
		expect(returnFlowFromLossReturn(0.5, 0.9)).toBeCloseTo(0.05, 12);
		expect(returnFlowFromLossReturn(1, 0.8)).toBeCloseTo(0.2, 12);
		expect(returnFlowFromLossReturn(2, 0.8)).toBeCloseTo(0.2, 12); // β clamped to 1, as the run took it
		expect(returnFlowFromLossReturn(0.5, 0)).toBe(0); // e outside (0, 1] ran as 1
	});

	it('upgrades a stored node: β (1.70.0 and before) to r, returnFlowPct (before 0.16.0) to e and r exactly', () => {
		const [b, p] = upgradeLegacyModel({
			nodes: [
				{ id: 'b', irrigationEfficiency: 0.8, lossReturnFraction: 0.5 },
				{ id: 'p', returnFlowPct: 0.1 }
			]
		}).nodes as unknown as Record<string, unknown>[];
		expect(b!.returnFlowFraction).toBeCloseTo(0.1, 12);
		expect('lossReturnFraction' in b!).toBe(false);
		expect([p!.irrigationEfficiency, p!.returnFlowFraction]).toEqual([0.9, 0.1]);
		expect(irrigationFromReturnFlow(1)).toEqual({ irrigationEfficiency: 0.01, returnFlowFraction: 0.99 });
	});
});

describe('estimatedDamAreaM2 (Maaren & Moolman 1985, engine ≥ 1.63.0, issue #90 N2)', () => {
	it('is 7.2 × capacity^0.77 m²: a small dam shallower than a large one', () => {
		expect(estimatedDamAreaM2(100_000)).toBeCloseTo(7.2 * 100_000 ** 0.77, 9);
		const depth = (c: number) => c / estimatedDamAreaM2(c);
		expect(depth(10_000)).toBeCloseTo(1.16, 2);
		expect(depth(100_000)).toBeCloseTo(1.96, 2);
		expect(depth(1_000_000)).toBeCloseTo(3.33, 2);
		expect(estimatedDamAreaM2(0)).toBe(0);
		expect(estimatedDamAreaM2(-5)).toBe(0);
	});

	it('gives a stored run the estimate its own engine used: capacity ÷ 3 m before 1.63.0', () => {
		expect(estimatedDamAreaForEngine(90_000, '1.60.0')).toBe(30_000);
		expect(estimatedDamAreaForEngine(90_000, '1.62.0')).toBe(30_000);
		expect(estimatedDamAreaForEngine(90_000, '0.16.0')).toBe(30_000);
		expect(estimatedDamAreaForEngine(90_000, '1.63.0')).toBe(estimatedDamAreaM2(90_000));
		expect(estimatedDamAreaForEngine(90_000, '2.0.0')).toBe(estimatedDamAreaM2(90_000));
		// Absent or unreadable: this engine's.
		expect(estimatedDamAreaForEngine(90_000)).toBe(estimatedDamAreaM2(90_000));
		expect(estimatedDamAreaForEngine(90_000, 'dev')).toBe(estimatedDamAreaM2(90_000));
	});
});

describe('newNetworkNode (the Network’s Add and the server’s start from the map)', () => {
	it('makes the outflow gauge when it drains nowhere, else a unit, with the creation defaults', () => {
		const g = newNetworkNode('g', 0, null);
		expect(g).toMatchObject({ id: 'g', name: '', kind: 'gauge', downstreamNodeId: null, sortOrder: 0, areaKm2: 0, ewrSite: true });
		const u = newNetworkNode('u', 3, 'g');
		expect(u).toMatchObject({ kind: 'farm', downstreamNodeId: 'g', sortOrder: 3, ...NEW_FARM_IRRIGATION, damAreaExponent: DAM_AREA_EXPONENT, pctUpstreamToDam: 1, pctRunoffToDam: 0 });
		// Two calls share nothing mutable.
		expect(newNetworkNode('a', 0, 'g')).not.toBe(newNetworkNode('a', 0, 'g'));
	});
});
