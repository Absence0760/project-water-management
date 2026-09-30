// § 5 of the licensing evidence report, registered water use (issue #71,
// WP-3.10, docs/allocations.md § In the evidence report): the over/under-use
// chart's marks and the table's words. Pure, unit-tested in
// registeredUse.test.ts. The words describe arithmetic against a registered
// volume, never a finding on lawfulness, and name the unit, never a holder.
import type { EvidenceAllocationCounts, EvidenceAllocations, EvidenceAllocationSource, EvidenceAllocationUnit } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { SOURCE_LABEL } from '$lib/components/allocations/allocations';
import { useAxis, type UseMark, type UseRow } from '$lib/components/allocations/usePlot';

export { USE_AXIS_MAX, USE_AXIS_MIN, type UseMark, type UseRow } from '$lib/components/allocations/usePlot';

/** A unit–source's row label. */
export const unitSourceLabel = (u: Pick<EvidenceAllocationUnit, 'name' | 'own'>, s: Pick<EvidenceAllocationSource, 'waterSource'>) =>
	`${u.name}${u.own ? ' (the applicant’s)' : ''}, ${SOURCE_LABEL[s.waterSource].toLowerCase()}`;

/**
 * The chart: one row per unit and water source, one mark per water year
 * whole in that run with a registered volume in force (a part year or a year with
 * nothing registered has no ratio, and the table lists it). The axis runs
 * from 0 to the largest ratio, at least USE_AXIS_MIN, at most USE_AXIS_MAX.
 */
export function useRows(al: Pick<EvidenceAllocations, 'units'>): { rows: UseRow[]; axisMax: number; clipped: number } {
	const raw = al.units.flatMap((u) =>
		u.sources.map((s) => {
			const marks: Omit<UseMark, 'clipped'>[] = [];
			for (const y of s.years) {
				for (const [run, reg, mod, part, status] of [
					['baseline', y.registeredA, y.modelledA, y.partialA, y.statusA],
					['application', y.registeredB, y.modelledB, y.partialB, y.statusB]
				] as const) {
					if (part !== false || reg === null || mod === null || !(reg > 0)) continue;
					marks.push({ waterYear: y.waterYear, run, ratio: mod / reg, over: status === 'over' });
				}
			}
			const name = `${u.name}${u.own ? ' (the applicant’s)' : ''}`;
			return { key: `${u.nodeId}:${s.waterSource}`, label: unitSourceLabel(u, s), name, suffix: `, ${SOURCE_LABEL[s.waterSource].toLowerCase()}`, marks };
		})
	);
	return useAxis(raw);
}

/** A run's whole years for a unit–source, in words: "2 above, 1 within, 2 below, of 5"; "–" without a volume. */
export function countsText(c: EvidenceAllocationCounts | null): string {
	if (!c) return '–';
	const parts = [`${c.over} above`, `${c.within} within`, `${c.under} below`];
	if (c.noVolume) parts.push(`${c.noVolume} with no volume`);
	return `${parts.join(', ')}, of ${c.wholeYears}`;
}

/** A volume in m³ with no decimals, "–" when missing. */
export const m3 = (v: number | null) => (v === null || !Number.isFinite(v) ? '–' : fmtNum(v, 0));

/** Modelled ÷ registered as a percentage, "–" without a registered volume. */
export const ratioText = (modelled: number | null, registered: number | null) =>
	modelled === null || registered === null || !(registered > 0) ? '–' : `${fmtNum((100 * modelled) / registered, 0)} %`;

/** The band in words: "±10 %". */
export const bandText = (tol: number | null) => (tol === null ? '–' : `±${fmtNum(tol * 100, 0)} %`);

/** A water year's part-year note, per run when they differ; null when whole in every run that has it. */
export function partNote(y: { days: number; yearDays: number; partialA: boolean | null; partialB: boolean | null }, application: boolean): string | null {
	const a = y.partialA === true;
	const b = application && y.partialB === true;
	if (!a && !b) return null;
	const who = application && a !== b ? (a ? ' in the baseline' : ' in the application') : '';
	return `part${who} (${y.days} of ${y.yearDays} days), not counted`;
}
