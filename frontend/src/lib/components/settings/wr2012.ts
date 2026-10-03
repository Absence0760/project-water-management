// The WR2012 check in Settings (issue #4 phase 8): an empty reference to fill
// in, the checks that block Save (the engine's own plausibility rules, which
// the backend applies too), and unit helpers for the form.
import { wr2012FlagIssues, wr2012PenaltyIssues, wr2012ReferenceIssues, type Wr2012Reference, type Wr2012Settings } from '@water-management/engine';

/** A reference as the form edits it: numbers may still be blank (null). */
export type Wr2012Draft = Omit<Wr2012Reference, 'areaKm2' | 'marMm3' | 'monthlyMm3' | 'periodStart' | 'periodEnd'> & {
	areaKm2: number | null;
	marMm3: number | null;
	monthlyMm3: (number | null)[];
	periodStart: number | null;
	periodEnd: number | null;
};

export function blankReference(): Wr2012Draft {
	return {
		quaternary: '',
		areaKm2: null,
		marMm3: null,
		monthlyMm3: new Array(12).fill(null),
		periodStart: null,
		periodEnd: null,
		mapMm: null,
		source: ''
	};
}

const BLANK: Record<string, string> = {
	areaKm2: 'Enter the quaternary area.',
	marMm3: 'Enter the naturalised MAR.',
	monthlyMm3: 'Enter all 12 monthly means.',
	periodEnd: 'Enter the first and last year of the reference period.'
};

/**
 * Problems that block Save, keyed by field (a reference field, or a flags /
 * penalty field). Empty when the WR2012 settings can be saved.
 */
export function wr2012Errors(ws: Wr2012Settings | { reference: Wr2012Draft | null } & Omit<Wr2012Settings, 'reference'>): Record<string, string> {
	const out: Record<string, string> = {};
	const r = ws.reference as Wr2012Draft | null;
	if (r) {
		const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
		if (blank(r.areaKm2)) out.areaKm2 = BLANK.areaKm2!;
		if (blank(r.marMm3)) out.marMm3 = BLANK.marMm3!;
		if (r.monthlyMm3.some(blank)) out.monthlyMm3 = BLANK.monthlyMm3!;
		if (blank(r.periodStart) || blank(r.periodEnd)) out.periodEnd = BLANK.periodEnd!;
		for (const i of wr2012ReferenceIssues(r as Wr2012Reference)) out[i.field] ??= i.message;
	}
	if (ws.lowFlowMonths && ws.lowFlowMonths.length === 0) out.lowFlowMonths = 'Pick at least one dry-season month, or untick “Choose the dry-season months”.';
	for (const i of wr2012FlagIssues(ws.flags)) out[i.field] ??= i.message;
	for (const i of wr2012PenaltyIssues(ws.calibrationPenalty)) out[i.field] ??= i.message;
	return out;
}

/** Sum of the monthly means (Mm³), or null while any is blank. */
export function monthlySum(monthly: readonly (number | null)[]): number | null {
	let s = 0;
	for (const v of monthly) {
		if (v === null || !Number.isFinite(v)) return null;
		s += v;
	}
	return s;
}

const MONTH_DAYS = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30];

/** A month's volume (Mm³) as a mean flow (m³/s), water-year month index 0 = Oct (Feb 28.25 days). */
export function mm3MonthToM3s(mm3: number, wyIndex: number): number {
	return (mm3 * 1e6) / (MONTH_DAYS[wyIndex]! * 86_400);
}

/** Water year label: 1990 → "1990/91". */
export const waterYearLabel = (y: number) => `${y}/${String((y + 1) % 100).padStart(2, '0')}`;

/**
 * The reference switched on or off. On brings back the one switched off
 * (`last`, kept until the form is saved or discarded), else a blank one, so
 * a mis-click on the check never throws typed values away.
 */
export function withReference(on: boolean, last: Wr2012Draft | null | undefined): Wr2012Draft | null {
	if (!on) return null;
	return last ? (JSON.parse(JSON.stringify(last)) as Wr2012Draft) : blankReference();
}

export interface MarBand {
	marLowMm3: number | null;
	marHighMm3: number | null;
}

/** The MAR band's bounds switched on or off: on brings back the pair switched off (`last`), else both blank; off clears them. */
export function withMarBand(on: boolean, last: MarBand | null | undefined): MarBand {
	return on && last ? { marLowMm3: last.marLowMm3, marHighMm3: last.marHighMm3 } : { marLowMm3: null, marHighMm3: null };
}
