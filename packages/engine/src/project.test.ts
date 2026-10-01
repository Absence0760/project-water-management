import { describe, expect, it } from 'vitest';
import {
	defaultProjectSettings,
	estimatedDamAreaForEngine,
	estimatedDamAreaM2,
	IRRIGATION_SYSTEMS,
	NEW_FARM_IRRIGATION,
	NEW_FARM_IRRIGATION_SYSTEM,
	PAN_COEFFICIENT_PRESETS,
	PAN_COEFFICIENT_TYPICAL_MAX,
	PAN_COEFFICIENT_TYPICAL_MIN,
	panCoefficientOutOfRange
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

	it('starts a new farm on drip (confirmed by the client, issue #90), half its losses returning', () => {
		expect(NEW_FARM_IRRIGATION_SYSTEM).toBe('drip');
		const drip = IRRIGATION_SYSTEMS.find((s) => s.id === NEW_FARM_IRRIGATION_SYSTEM)!;
		expect(NEW_FARM_IRRIGATION).toEqual({ irrigationEfficiency: drip.efficiency, lossReturnFraction: 0.5 });
		expect(NEW_FARM_IRRIGATION.irrigationEfficiency).toBe(0.9);
	});
});

describe('estimatedDamAreaM2 (Maaren & Moolman 1985, engine ≥ 1.61.0, issue #90 N2)', () => {
	it('is 7.2 × capacity^0.77 m²: a small dam shallower than a large one', () => {
		expect(estimatedDamAreaM2(100_000)).toBeCloseTo(7.2 * 100_000 ** 0.77, 9);
		const depth = (c: number) => c / estimatedDamAreaM2(c);
		expect(depth(10_000)).toBeCloseTo(1.16, 2);
		expect(depth(100_000)).toBeCloseTo(1.96, 2);
		expect(depth(1_000_000)).toBeCloseTo(3.33, 2);
		expect(estimatedDamAreaM2(0)).toBe(0);
		expect(estimatedDamAreaM2(-5)).toBe(0);
	});

	it('gives a stored run the estimate its own engine used: capacity ÷ 3 m before 1.61.0', () => {
		expect(estimatedDamAreaForEngine(90_000, '1.60.0')).toBe(30_000);
		expect(estimatedDamAreaForEngine(90_000, '0.16.0')).toBe(30_000);
		expect(estimatedDamAreaForEngine(90_000, '1.61.0')).toBe(estimatedDamAreaM2(90_000));
		expect(estimatedDamAreaForEngine(90_000, '2.0.0')).toBe(estimatedDamAreaM2(90_000));
		// Absent or unreadable: this engine's.
		expect(estimatedDamAreaForEngine(90_000)).toBe(estimatedDamAreaM2(90_000));
		expect(estimatedDamAreaForEngine(90_000, 'dev')).toBe(estimatedDamAreaM2(90_000));
	});
});
