import { describe, expect, it } from 'vitest';
import { damHints, fmtVolume, hasDam, isVolume, NODE_FIELDS, systemOf, TABLE_FIELDS } from './fields';

describe('node fields', () => {
	it('keeps the table accessible names the editor and tests rely on', () => {
		const aria = Object.fromEntries(NODE_FIELDS.map((f) => [f.key, f.aria('Hilltop')]));
		expect(aria.areaKm2).toBe('Area of Hilltop, km²');
		expect(aria.damCapacityM3).toBe('Dam capacity of Hilltop, m³');
		expect(aria.damInitialPct).toBe('Dam initial storage of Hilltop, %');
	});

	it('gives every field help text and a unit', () => {
		for (const f of NODE_FIELDS) {
			expect(f.help.length).toBeGreaterThan(20);
			expect(f.unit).toBeTruthy();
		}
	});
});

describe('hasDam / fmtVolume', () => {
	it('ignores placeholder dams under 1 m³ and gauges', () => {
		expect(hasDam({ kind: 'farm', damCapacityM3: 0.15 })).toBe(false);
		expect(hasDam({ kind: 'farm', damCapacityM3: 40_000 })).toBe(true);
		expect(hasDam({ kind: 'gauge', damCapacityM3: 40_000 })).toBe(false);
	});

	it('uses Mm³ for large dams', () => {
		expect(fmtVolume(1_050_000)).toBe('1.05 Mm³');
		expect(fmtVolume(40_000)).toBe('40,000 m³');
	});
});

describe('damHints', () => {
	it('flags a dam irrigation may empty (minimum operating level 0 %), as a hint (Q5)', () => {
		expect(damHints({ kind: 'farm', damCapacityM3: 40_000, damMinPct: 0, damAreaFullM2: 15_000 })).toEqual(['Irrigation may empty this dam: its minimum operating level is 0 %.']);
	});

	it('says when evaporation uses an estimated surface area (N2)', () => {
		expect(damHints({ kind: 'farm', damCapacityM3: 90_000, damMinPct: 0.1, damAreaFullM2: null })).toEqual([
			"No surface area: evaporation uses capacity ÷ 3 m, about 3.0 ha. Enter the dam's area when full for a better figure."
		]);
		expect(damHints({ kind: 'farm', damCapacityM3: 40_000, damMinPct: 0.1, damAreaFullM2: 15_000 })).toEqual([]);
	});

	it('says nothing for a farm without a dam or a gauge', () => {
		expect(damHints({ kind: 'farm', damCapacityM3: 0, damMinPct: 0 })).toEqual([]);
		expect(damHints({ kind: 'gauge', damCapacityM3: 40_000, damMinPct: 0 })).toEqual([]);
	});
});

describe('systemOf (irrigation system helper, N1)', () => {
	it('names the system whose indicative efficiency this is; the first listed wins a tie', () => {
		expect(systemOf(0.9)).toBe('drip');
		expect(systemOf(0.85)).toBe('micro');
		expect(systemOf(0.75)).toBe('sprinkler');
		expect(systemOf(0.65)).toBe('flood');
		expect(systemOf(0.8)).toBeNull();
	});
});

describe('TABLE_FIELDS', () => {
	it('keeps the rarely edited dam physics in the one-node form only, so the table fits a laptop screen', () => {
		const keys = TABLE_FIELDS.map((f) => f.key);
		expect(keys).not.toContain('damAreaFullM2');
		expect(keys).not.toContain('damAreaExponent');
		expect(keys).not.toContain('damSeepagePerDay');
		expect(keys).toContain('irrigationEfficiency');
		expect(TABLE_FIELDS.length).toBe(NODE_FIELDS.length - 3);
	});
});

describe('isVolume', () => {
	it('marks the m³ and m³/day fields, whose columns need room for large values', () => {
		expect(NODE_FIELDS.filter(isVolume).map((f) => f.key)).toEqual(['damCapacityM3', 'divertCapacityM3Day']);
	});
});
