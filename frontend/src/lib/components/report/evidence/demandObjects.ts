// § 6 of the licensing evidence report, the applicant's demand objects
// (evidence-9, issue #259): how each one's sizing and what the application
// does to it print. Pure, so the page and the tests read the same text; the
// source's label and the by-source line are the run table's
// (runs/demandSources.ts).
import { DEMAND_MONTHLY_UNIT_LABEL, DEMAND_MONTHLY_UNIT_SCALE, type EvidenceDemandObject } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** What the application does to it. */
export const CHANGE_LABEL: Record<EvidenceDemandObject['change'], string> = {
	added: 'Added',
	changed: 'Changed',
	removed: 'Removed',
	unchanged: 'Unchanged'
};

/**
 * Its sizing in one line: "20 m³/day every month", "10–50 m³/day by month
 * (mean 25)", or "400 × 230 l a day, 10 % losses".
 */
export function sizingText(o: Pick<EvidenceDemandObject, 'sizing' | 'monthlyM3Day' | 'monthlyUnit' | 'count' | 'litresPerUnitDay' | 'lossPct'>): string {
	if (o.sizing === 'perUnit') {
		const loss = o.lossPct > 0 ? `, ${fmtNum(o.lossPct * 100, 1, true)} % losses` : '';
		return `${fmtNum(o.count, 0)} × ${fmtNum(o.litresPerUnitDay, 0)} l a day${loss}`;
	}
	// In the unit it was entered in (engine ≥ 1.72.0): l/s or m³/s, else m³/day.
	const scale = o.monthlyUnit ? DEMAND_MONTHLY_UNIT_SCALE[o.monthlyUnit] : 1;
	const unit = o.monthlyUnit ? DEMAND_MONTHLY_UNIT_LABEL[o.monthlyUnit] : 'm³/day';
	const dp = o.monthlyUnit === 'm3s' ? 4 : o.monthlyUnit === 'ls' ? 2 : 1;
	const m = (o.monthlyM3Day ?? []).filter((v) => Number.isFinite(v)).map((v) => v * scale);
	if (!m.length) return 'no monthly demand entered';
	const lo = Math.min(...m);
	const hi = Math.max(...m);
	if (lo === hi) return `${fmtNum(lo, dp, true)} ${unit} every month`;
	return `${fmtNum(lo, dp, true)}–${fmtNum(hi, dp, true)} ${unit} by month (mean ${fmtNum(m.reduce((s, v) => s + v, 0) / m.length, dp, true)})`;
}
