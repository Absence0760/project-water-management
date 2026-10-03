import { defaultProjectSettings, PE_SOURCE_MAX } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { annualGr4jPeMm, apanSourceNote, peFormError, peOf, peText, withLakeMonthly, withPeKind, type EditablePe } from './peInput';

const apanMm = [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110]; // Oct … Sep, 1 630 mm a year
const panCoefficient = new Array<number>(12).fill(0.7);
const monthly = (mm: number[], source = 'station FAO-56 ET₀ × 1.0, 2015–2020'): EditablePe => ({ kind: 'monthly', mm, source });

describe('GR4J potential evaporation in the Settings form', () => {
	it('reads a project saved before the input existed as pan coefficient × A-pan', () => {
		expect(peOf({})).toEqual({ kind: 'pan' });
		expect(peOf({ pe: null })).toEqual({ kind: 'pan' });
		expect(defaultProjectSettings().pe).toEqual({ kind: 'pan' });
	});

	it('totals the year under whichever input is active', () => {
		// 0.7 × 1 630 mm under 'pan', with or without a stored pe.
		expect(annualGr4jPeMm({ apanMm, panCoefficient })).toBeCloseTo(1141, 9);
		expect(annualGr4jPeMm({ apanMm, panCoefficient, pe: { kind: 'pan' } })).toBeCloseTo(1141, 9);
		// A monthly row ignores A-pan and the pan coefficient.
		expect(annualGr4jPeMm({ apanMm, panCoefficient, pe: monthly(new Array(12).fill(100)) })).toBe(1200);
		expect(annualGr4jPeMm({ apanMm: new Array(12).fill(0), panCoefficient, pe: monthly(new Array(12).fill(50)) })).toBe(600);
	});

	it('starts a monthly row from the PE GR4J runs on now, with the source to write', () => {
		const pe = withPeKind({ apanMm, panCoefficient: [0.65, ...new Array(11).fill(0.7)] }, 'monthly');
		expect(pe).toEqual({ kind: 'monthly', mm: [97.5, 126, 154, 161, 133, 112, 77, 56, 42, 42, 56, 77], source: '' });
		// The blank source blocks Save.
		expect(peFormError(pe)).toMatch(/source is required/);
	});

	it('switches back to pan, and brings back the monthly row the form had', () => {
		const row = monthly(new Array(12).fill(90), 'my station');
		const s = { apanMm, panCoefficient, pe: row };
		expect(withPeKind(s, 'pan')).toEqual({ kind: 'pan' });
		expect(withPeKind({ apanMm, panCoefficient, pe: { kind: 'pan' } }, 'monthly', row)).toEqual(row);
		// A copy: editing the restored row doesn't reach the remembered one.
		const back = withPeKind({ apanMm, panCoefficient, pe: { kind: 'pan' } }, 'monthly', row);
		if (back.kind === 'monthly') back.mm[0] = 1;
		expect(row.kind === 'monthly' && row.mm[0]).toBe(90);
		// Choosing the kind already active changes nothing.
		expect(withPeKind(s, 'monthly')).toBe(row);
	});

	it('blocks Save on a bad monthly row or source, never on pan', () => {
		expect(peFormError(undefined)).toBeNull();
		expect(peFormError({ kind: 'pan' })).toBeNull();
		expect(peFormError(monthly(new Array(12).fill(100)))).toBeNull();
		// All zeros saves: the run refuses it, as it refuses a zero A-pan row under 'pan'.
		expect(peFormError(monthly(new Array(12).fill(0)))).toBeNull();
		expect(peFormError(monthly(new Array(11).fill(100)))).toBe('Monthly PE needs 12 values, Oct to Sep; it has 11.');
		const bad = new Array(12).fill(100);
		bad[1] = -1;
		bad[3] = 10_001;
		bad[4] = Number.NaN;
		expect(peFormError(monthly(bad))).toBe('Monthly PE must be 0 to 10\u202f000 mm in every month: check Nov, Jan, Feb.');
		expect(peFormError(monthly(new Array(12).fill(10_000)))).toBeNull();
		expect(peFormError(monthly(new Array(12).fill(100), '   '))).toMatch(/source is required/);
		expect(peFormError(monthly(new Array(12).fill(100), 'x'.repeat(PE_SOURCE_MAX)))).toBeNull();
		expect(peFormError(monthly(new Array(12).fill(100), 'x'.repeat(PE_SOURCE_MAX + 1)))).toBe(
			`The PE source is at most ${PE_SOURCE_MAX} characters; it has ${PE_SOURCE_MAX + 1}.`
		);
	});

	it('describes the input in one line for the fit record and the report', () => {
		expect(peText(undefined)).toBe('pan coefficient × A-pan');
		expect(peText({ kind: 'pan' })).toBe('pan coefficient × A-pan');
		expect(peText(monthly(new Array(12).fill(100), ' station ET₀ '))).toBe('monthly, entered directly: 1\u202f200 mm a year (station ET₀)');
		expect(peText(monthly(new Array(12).fill(100), ''))).toBe('monthly, entered directly: 1\u202f200 mm a year');
	});
});

describe('where A-pan comes from (issue #45)', () => {
	it('names the daily series when the project has one, the monthly means otherwise, nothing while loading', () => {
		expect(apanSourceNote(null)).toBeNull();
		const daily = apanSourceNote(['rain_catchment_mm', 'evap_apan_mm'])!;
		expect(daily.daily).toBe(true);
		expect(daily.text).toContain('daily A-pan series');
		expect(daily.text).toContain('monthly means fill the other days');
		const monthlyOnly = apanSourceNote(['rain_catchment_mm'])!;
		expect(monthlyOnly.daily).toBe(false);
		expect(monthlyOnly.text).toContain('monthly means on every day');
	});
});

describe('the monthly dam evaporation factors', () => {
	it('off is null; on brings back the twelve switched off, else the one factor in every month', () => {
		expect(withLakeMonthly(false, 0.75, [0.8, ...new Array(11).fill(0.7)])).toBeNull();
		expect(withLakeMonthly(true, 0.75, null)).toEqual(new Array(12).fill(0.75));
		const kept = [0.8, ...new Array(11).fill(0.7)];
		const back = withLakeMonthly(true, 0.75, kept);
		expect(back).toEqual(kept);
		// A copy: editing it leaves the kept row alone.
		expect(back).not.toBe(kept);
	});
});
