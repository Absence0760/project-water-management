// § 8 Future yield as the report prints it (issue #621 slice 4, evidence-23;
// engine evidence/future.ts): one row for the historical record, then one per
// SSP and horizon with each measure's median and its range across the
// models, never one number. Pure, for EvidenceReport.svelte and its test.
import { SSP_LABEL, type EvidenceFutureYield, type FutureMeasures, type FutureRange } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { pct } from './format';

type Ok = Extract<EvidenceFutureYield, { status: 'ok' }>;

export interface FutureRow {
	label: string;
	/** The models the row reads across; 0 for the historical record. */
	models: number;
	cells: [string, string, string, string];
}

const m3a = (v: number | null) => (v === null ? '–' : `${fmtNum(v)} m³/a`);
const days = (v: number | null) => (v === null ? '–' : `${v > 0 ? '+' : ''}${fmtNum(v)} days`);
const asPct = (v: number | null) => pct(v, 0);

/** "median (min to max)", or the one value when every model gives it, in `fmt`. */
export function rangeText(r: FutureRange, fmt: (v: number | null) => string): string {
	if (!r.n) return '–';
	return r.min === r.max ? fmt(r.median) : `${fmt(r.median)} (${fmt(r.min)} to ${fmt(r.max)})`;
}

const historicalCells = (m: FutureMeasures): FutureRow['cells'] => [m3a(m.firmYieldM3Year), m3a(m.yieldAtAssuranceM3Year), asPct(m.applicantAssurance), days(m.ewrDaysChange)];

/** The table's rows: the record, then each SSP and horizon. */
export function futureRows(s: Ok): FutureRow[] {
	return [
		{ label: 'Historical record', models: 0, cells: historicalCells(s.historical) },
		...s.groups.map((g) => ({
			label: `${SSP_LABEL[g.ssp]}, ${g.window.from}–${g.window.to}`,
			models: g.models.length,
			cells: [rangeText(g.firmYieldM3Year, m3a), rangeText(g.yieldAtAssuranceM3Year, m3a), rangeText(g.applicantAssurance, asPct), rangeText(g.ewrDaysChange, days)] as FutureRow['cells']
		}))
	];
}

/** A case's 12 factors as printed: "0.95 0.97 …" (January first). */
export const factorText = (f: readonly number[]) => f.map((x) => x.toFixed(2)).join(' ');
