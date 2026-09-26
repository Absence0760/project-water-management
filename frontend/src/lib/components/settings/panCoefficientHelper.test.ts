import { describe, expect, it } from 'vitest';
import { applied, newHelperState, provenanceNote, suggest, type HelperState } from './panCoefficientHelper';

function filled(over: Partial<HelperState> = {}): HelperState {
	return {
		...newHelperState(),
		months: Array.from({ length: 12 }, (_, i) => ({ rhPct: i < 7 ? 55 : 80, windMs: i < 7 ? 3 : 1.5 })),
		source: 'Station X, 1991–2020 monthly means',
		...over
	};
}

describe('pan-coefficient helper (FAO-56 Table 5)', () => {
	it('starts empty: Case A, 10 m fetch, no reduction, nothing to apply', () => {
		const s = newHelperState();
		expect(s).toMatchObject({ siting: 'A', fetchM: 10, reductionPct: null, source: '' });
		expect(s.months).toHaveLength(12);
		const r = suggest(s);
		expect(r.results.every((x) => x === null)).toBe(true);
		expect(r.errors.every((x) => x === null)).toBe(true);
		expect(r.blocker).toMatch(/^Enter the mean RH and wind for Oct, Nov/);
		expect(applied(s)).toBeNull();
	});

	it('suggests each month from its own RH and wind and applies them with a note', () => {
		const s = filled();
		const out = applied(s);
		expect(out?.values).toEqual([0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.7, 0.85, 0.85, 0.85, 0.85, 0.85]);
		expect(out?.note).toBe('FAO-56 Table 5, Case A, 10 m green crop fetch; RH and wind: Station X, 1991–2020 monthly means');
		expect(suggest(s).results[0]?.cell).toEqual({ siting: 'A', rhClass: 'medium', windClass: 'moderate', fetchM: 10 });
	});

	it('follows siting and fetch, and applies a stated reduction visibly', () => {
		const s = filled({ siting: 'B', fetchM: 1000, reductionPct: 10 });
		const out = applied(s)!;
		// Case B, 1000 m: moderate/medium 0.55 × 0.9; light/high 0.70 × 0.9.
		expect(out.values[0]).toBe(0.495);
		expect(out.values[11]).toBe(0.63);
		expect(out.note).toBe('FAO-56 Table 5, Case B, 1000 m dry fallow fetch, reduced by 10 %; RH and wind: Station X, 1991–2020 monthly means');
		expect(suggest(s).results[0]?.tableKp).toBe(0.55);
		expect(provenanceNote({ ...s, reductionPct: 0 })).not.toContain('reduced');
	});

	it('needs the source of the RH and wind before it applies', () => {
		const s = filled({ source: '   ' });
		expect(suggest(s).blocker).toBe('Say where the RH and wind came from');
		expect(suggest(s).results.every((r) => r !== null)).toBe(true);
		expect(applied(s)).toBeNull();
	});

	it('names the months with out-of-range RH or wind', () => {
		const s = filled();
		s.months[3] = { rhPct: 120, windMs: 3 };
		s.months[5] = { rhPct: 50, windMs: -1 };
		const r = suggest(s);
		expect(r.results[3]).toBeNull();
		expect(r.errors[3]).toMatch(/relative humidity/);
		expect(r.errors[5]).toMatch(/wind/);
		expect(r.blocker).toBe('Check the RH (0–100 %) and wind (≥ 0 m/s) in Jan, Mar');
		expect(applied(s)).toBeNull();
	});

	it('rejects a reduction outside FAO-56’s 0–20 %', () => {
		const s = filled({ reductionPct: 25 });
		expect(suggest(s).blocker).toBe('The reduction must be 0–20 %');
		expect(suggest(s).results.every((r) => r === null)).toBe(true);
		expect(applied(s)).toBeNull();
	});
});
