// § 5 of the evidence report (WP-3.10): the over/under-use chart's marks and
// the table's words.
import type { EvidenceAllocationSource, EvidenceAllocationYear } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { bandText, countsText, measuredNote, partNote, ratioText, registeredText, unitSourceLabel, USE_AXIS_MAX, USE_AXIS_MIN, useRows } from './registeredUse';
import { fmtNum } from '#lib/format/number.js';

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

describe('measuredNote (evidence-16, issue #516)', () => {
	const y = { damDrawA: 29_200, damDrawB: null, damLossesA: null, damLossesB: 1_460 };
	it('labels a dam beside the river taken at the intake with its draws, and a dam on the river with its losses, per run', () => {
		expect(measuredNote({ measuredAtA: 'intake', measuredAtB: null }, y, 'A')).toMatch(/^taken at the intake; drawn from the dam 29[\s ]200, not added$/);
		expect(measuredNote({ measuredAtA: 'intake', measuredAtB: null }, y, 'B')).toMatch(/^dam losses 1[\s ]460, not counted$/);
		expect(measuredNote({ measuredAtA: 'intake', measuredAtB: null }, { ...y, damDrawA: null }, 'A')).toBe('taken at the intake');
	});
	it('says nothing for an older pack’s document or a total of other units (no fields)', () => {
		expect(measuredNote({}, {}, 'A')).toBeNull();
		expect(measuredNote({ measuredAtA: null }, { damLossesA: null }, 'A')).toBeNull();
	});
});

describe('a total of other units’ year too few registered users hold (evidence-18, #523 G)', () => {
	it('reads "not shown", never a figure, and the application’s beside it only when it differs', () => {
		const y = { registeredA: null, registeredB: null, withheldA: true as const };
		expect(registeredText(y, false)).toEqual({ main: 'not shown', sub: null });
		expect(registeredText({ ...y, registeredB: 5000 }, true)).toEqual({ main: 'not shown', sub: `application ${fmtNum(5000)}` });
		expect(registeredText({ ...y, withheldB: true }, true)).toEqual({ main: 'not shown', sub: null });
		// Shown in the baseline, withheld in the application.
		expect(registeredText({ registeredA: 5000, registeredB: null, withheldB: true }, true)).toEqual({ main: fmtNum(5000), sub: 'application not shown' });
		// Controls: as before, the baseline's, else the application's, and a difference of half a m³ or less isn't one.
		expect(registeredText({ registeredA: 1000, registeredB: 1000.4 }, true)).toEqual({ main: fmtNum(1000), sub: null });
		expect(registeredText({ registeredA: null, registeredB: 1000 }, true)).toEqual({ main: fmtNum(1000), sub: null });
		expect(registeredText({ registeredA: null, registeredB: null }, false)).toEqual({ main: '–', sub: null });
		// A total of other units served to a viewer kept from each volume carries none (#523 K/L/M).
		expect(registeredText({ registeredA: null, registeredB: null }, true, true)).toEqual({ main: 'not shown', sub: null });
	});

	it('counts the whole years not shown beside the judged ones', () => {
		expect(countsText({ wholeYears: 5, over: 1, within: 1, under: 0, noVolume: 0, withheld: 3 })).toBe('1 above, 1 within, 0 below, 3 not shown, of 5');
		expect(countsText({ wholeYears: 2, over: 1, within: 1, under: 0, noVolume: 0 })).toBe('1 above, 1 within, 0 below, of 2');
	});
});
