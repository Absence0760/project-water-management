import { describe, expect, it } from 'vitest';
import { fmtVolume, hasDam, NODE_FIELDS } from './fields';

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
