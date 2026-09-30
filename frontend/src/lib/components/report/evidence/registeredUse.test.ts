// § 5 of the evidence report (WP-3.10): the over/under-use chart's marks and
// the table's words.
import type { EvidenceAllocationSource, EvidenceAllocationYear } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { bandText, countsText, partNote, ratioText, unitSourceLabel, USE_AXIS_MAX, USE_AXIS_MIN, useRows } from './registeredUse';

const year = (waterYear: number, over: Partial<EvidenceAllocationYear> = {}): EvidenceAllocationYear => ({
	waterYear,
	days: 365,
	yearDays: 365,
	partialA: false,
	partialB: false,
	registeredA: 1000,
	modelledA: 500,
	statusA: 'under',
	registeredB: 1000,
	modelledB: 1200,
	statusB: 'over',
	...over
});
const source = (years: EvidenceAllocationYear[]): EvidenceAllocationSource => ({
	waterSource: 'surface',
	years,
	countsA: null,
	countsB: null,
	meanModelledA: null,
	meanRegisteredA: null,
	meanModelledB: null,
	meanRegisteredB: null
});
const unit = (name: string, own: boolean, years: EvidenceAllocationYear[]) => ({ nodeId: name, name, kind: 'farm' as const, own, onlyIn: null, sources: [source(years)] });

describe('useRows', () => {
	it('marks each whole year of each run at modelled ÷ registered, one row per unit and source', () => {
		const { rows, axisMax, clipped } = useRows({ units: [unit('Upper', true, [year(2001), year(2002)])] });
		expect(rows).toHaveLength(1);
		expect(rows[0]!.label).toBe('Upper (the applicant’s), surface water');
		expect([rows[0]!.name, rows[0]!.suffix]).toEqual(['Upper (the applicant’s)', ', surface water']);
		expect(rows[0]!.marks.map((m) => [m.waterYear, m.run, m.ratio])).toEqual([
			[2001, 'baseline', 0.5],
			[2001, 'application', 1.2],
			[2002, 'baseline', 0.5],
			[2002, 'application', 1.2]
		]);
		expect(axisMax).toBe(USE_AXIS_MIN);
		expect(clipped).toBe(0);
	});

	it('leaves out part years and years with nothing registered (the table lists them), and a run without the unit', () => {
		const { rows } = useRows({ units: [unit('U', false, [year(2000, { partialA: true, partialB: true }), year(2001, { registeredA: 0 }), year(2002, { registeredB: null, modelledB: null })])] });
		expect(rows[0]!.marks.map((m) => `${m.waterYear}-${m.run}`)).toEqual(['2001-application', '2002-baseline']);
	});

	it('leaves out a year only for the run it is a part year of (runs of unequal length)', () => {
		const { rows } = useRows({ units: [unit('U', false, [year(2003, { partialB: true })])] });
		expect(rows[0]!.marks.map((m) => m.run)).toEqual(['baseline']);
	});

	it('stretches the axis to the largest ratio up to its cap, and draws a year past the cap at the edge', () => {
		expect(useRows({ units: [unit('U', false, [year(2001, { modelledB: 2210 })])] }).axisMax).toBe(2.3);
		const far = useRows({ units: [unit('U', false, [year(2001, { modelledB: 9000 })])] });
		expect(far.axisMax).toBe(USE_AXIS_MAX);
		expect(far.clipped).toBe(1);
		expect(far.rows[0]!.marks.find((m) => m.run === 'application')!.clipped).toBe(true);
		// Control: the baseline's year inside the axis isn't clipped.
		expect(far.rows[0]!.marks.find((m) => m.run === 'baseline')!.clipped).toBe(false);
	});

	it('has no rows without units', () => {
		expect(useRows({ units: [] })).toEqual({ rows: [], axisMax: USE_AXIS_MIN, clipped: 0 });
	});
});

describe('the table’s words', () => {
	it('counts whole years in words, never a verdict', () => {
		expect(countsText({ wholeYears: 5, over: 2, within: 1, under: 2, noVolume: 0 })).toBe('2 above, 1 within, 2 below, of 5');
		expect(countsText({ wholeYears: 5, over: 0, within: 0, under: 3, noVolume: 2 })).toBe('0 above, 0 within, 3 below, 2 with no volume, of 5');
		expect(countsText(null)).toBe('–');
		for (const w of [countsText({ wholeYears: 1, over: 1, within: 0, under: 0, noVolume: 0 })]) expect(w).not.toMatch(/lawful|illegal|complian/i);
	});

	it('prints ratios, the band and the unit–source label', () => {
		expect(ratioText(1200, 1000)).toBe('120 %');
		expect(ratioText(5, 0)).toBe('–');
		expect(ratioText(null, 1000)).toBe('–');
		expect(bandText(0.1)).toBe('±10 %');
		expect(bandText(null)).toBe('–');
		expect(unitSourceLabel({ name: 'Lower', own: false }, { waterSource: 'groundwater' })).toBe('Lower, groundwater');
	});
});

describe('partNote', () => {
	const y = { days: 120, yearDays: 365 };
	it('says a part year is not counted, and for which run when only one has it part', () => {
		expect(partNote({ ...y, partialA: true, partialB: true }, true)).toBe('part (120 of 365 days), not counted');
		expect(partNote({ ...y, partialA: false, partialB: true }, true)).toBe('part in the application (120 of 365 days), not counted');
		expect(partNote({ ...y, partialA: true, partialB: null }, false)).toBe('part (120 of 365 days), not counted');
		// Control: a whole year has no note.
		expect(partNote({ ...y, partialA: false, partialB: false }, true)).toBeNull();
	});
});
