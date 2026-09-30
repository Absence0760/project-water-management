// How the licensing evidence report prints its numbers (issue #71,
// docs/design/evidence-report.md §4–§5): every banded change as the paired
// median with its 5–95 % range and the run's own difference beside it
// (D-U2), "worse in k of n" as a count (D-U3), "no band" said in words
// (D-U1, D-U6), and direction by sign only (G15: no verdict colour).
// Pure: the page and the tests read the same text.
import type { Band, EvidenceChange, EvidenceRow } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** Decimal places per unit. */
export function digitsFor(unit: string): number {
	if (unit === 'days') return 0;
	if (unit === 'Mm³/a') return 3;
	if (unit === 'Mm³') return 2;
	return 1;
}

/** A unit as it follows a number. */
function suffix(unit: string, change = false): string {
	if (unit.startsWith('%')) return change ? ' pp' : ' %';
	return ` ${unit}`;
}

/** A signed number with a true minus sign: +3.2, −1.0, 0. */
export function signed(v: number, digits: number): string {
	const s = fmtNum(v, digits);
	if (s === '0' || /^[-−]?0(\.0+)?$/.test(s)) return s.replace('-', '');
	return s.startsWith('-') ? `−${s.slice(1)}` : `+${s}`;
}

/** A row's value in one run: "61.7 %", "786 days", "–" when missing. */
export function valueText(row: Pick<EvidenceRow, 'unit'>, v: number | null): string {
	if (v === null || !Number.isFinite(v)) return '–';
	return `${fmtNum(v, digitsFor(row.unit))}${suffix(row.unit)}`;
}

/**
 * The Change cell: `main` is the paired median (or, without a band, the
 * run's own difference and "no band"), `sub` the 5–95 % range and the run's
 * own difference, or why there is no band.
 */
export function changeText(row: Pick<EvidenceRow, 'unit'>, c: EvidenceChange | null): { main: string; sub: string | null; banded: boolean } {
	if (!c) return { main: '–', sub: null, banded: false };
	const d = digitsFor(row.unit);
	const u = suffix(row.unit, true);
	const run = c.run === null ? null : `${signed(c.run, d)}${u}`;
	const b = c.band;
	if (b && b.p50 !== null && b.p5 !== null && b.p95 !== null && !c.bandNote) {
		return { main: `${signed(b.p50, d)}${u}`, sub: `${signed(b.p5, d)} to ${signed(b.p95, d)}${run ? ` · run: ${run}` : ''}`, banded: true };
	}
	return { main: run ? `run: ${run}` : '–', sub: c.bandNote ?? 'no band', banded: false };
}

/** "71 of 77 sets (92 %)", or "—" without a count (ER-D8: both, pending the pilot CMA). */
export function worseText(c: EvidenceChange | null): string {
	if (!c?.worse || !c.worse.n) return '—';
	const { k, n } = c.worse;
	return `${fmtNum(k)} of ${fmtNum(n)} sets (${fmtNum((100 * k) / n)} %)`;
}

/** A band in one line: "median +98 (−9 to +175)"; "no band" when it has no percentiles. */
export function bandText(b: Band | null | undefined, digits: number, unit = ''): string {
	if (!b || b.p50 === null || b.p5 === null || b.p95 === null) return 'no band';
	return `median ${signed(b.p50, digits)}${unit} (${signed(b.p5, digits)} to ${signed(b.p95, digits)})`;
}

/** A band's plain (unsigned) percentiles, for a baseline's own bands: "3 125 – 3 937 – 4 394". */
export function bandRange(b: Band | null | undefined, digits: number): string {
	if (!b || b.p50 === null || b.p5 === null || b.p95 === null) return 'no band';
	return `${fmtNum(b.p5, digits)} – ${fmtNum(b.p50, digits)} – ${fmtNum(b.p95, digits)}`;
}

/** A share 0–1 as a percentage, "–" when missing. */
export const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${fmtNum(v * 100, digits)} %`);

/** The report's short verification code (§4.1): the first eight hex digits of a hash, grouped "b70c-9949". */
export const shortCode = (sha256: string) => `${sha256.slice(0, 4)}-${sha256.slice(4, 8)}`;
