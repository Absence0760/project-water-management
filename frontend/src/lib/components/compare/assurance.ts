// Assurance of supply in both runs (WP-3.4, engine ≥ 0.32.0, docs/model.md
// §2.11a; issue #70), for the compare and scenario views: per farm and other
// water user, matched by name like the farm table (ids differ across a copied
// project), the share of demand days fully met, the volume supplied, the
// complete water years that reached the annual threshold and the longest run
// of days not fully met, each with the change B − A. Read off the two runs'
// summary.supplyAssurance; a run from before engine 0.32.0 has none.
import type { MetricDelta, SupplyAssurance, SupplyReliability } from '@water-management/engine';

export interface AssuranceDeltaRow {
	/** Name in run B. */
	name: string;
	kind: 'farm' | 'user';
	/** Share of demand days fully met (timeReliability). */
	time: MetricDelta;
	/** Σ supplied ÷ Σ demand (volumetricReliability). */
	volumetric: MetricDelta;
	/** Complete water years that reached the threshold ÷ complete water years (annualReliability). */
	annual: MetricDelta;
	/** "3 of 4" per run: the annual measure's counts, "–" without a complete water year. */
	yearsA: string;
	yearsB: string;
	longestFailureDays: MetricDelta;
}

export interface AssuranceComparison {
	rows: AssuranceDeltaRow[];
	onlyInA: string[];
	onlyInB: string[];
	/** The run with no supplyAssurance (an older engine), or null when both have it. */
	missing: 'a' | 'b' | null;
	/** Each run's annual threshold, when they differ (the annual measure then counts against different bars). */
	thresholds: { a: number; b: number } | null;
	/** Each run's reporting window, when they differ. */
	windows: { a: string; b: string } | null;
}

const delta = (a: number | null, b: number | null): MetricDelta => ({ a, b, delta: a === null || b === null ? null : b - a });
const years = (r: SupplyReliability) => (r.waterYears > 0 ? `${r.waterYearsMet} of ${r.waterYears}` : '–');
const window = (s: SupplyAssurance) => `${s.reportStart} to ${s.reportEnd}`;

/** Null when neither run has an assurance of supply, or neither has a farm or water user in it. */
export function compareAssurance(a: SupplyAssurance | undefined, b: SupplyAssurance | undefined): AssuranceComparison | null {
	if (!a?.reliability.length && !b?.reliability.length) return null;
	const missing = !a ? 'a' : !b ? 'b' : null;
	const listA = a?.reliability ?? [];
	const listB = b?.reliability ?? [];
	// First unmatched namesake in A, so two farms sharing a name pair off in order.
	const used = new Set<number>();
	const rows: AssuranceDeltaRow[] = [];
	const onlyInB: string[] = [];
	for (const rb of listB) {
		const i = listA.findIndex((ra, j) => !used.has(j) && ra.name === rb.name);
		if (i < 0) {
			if (!missing) onlyInB.push(rb.name);
			continue;
		}
		used.add(i);
		const ra = listA[i]!;
		rows.push({
			name: rb.name,
			kind: rb.kind,
			time: delta(ra.timeReliability, rb.timeReliability),
			volumetric: delta(ra.volumetricReliability, rb.volumetricReliability),
			annual: delta(ra.annualReliability, rb.annualReliability),
			yearsA: years(ra),
			yearsB: years(rb),
			longestFailureDays: delta(ra.longestFailureDays, rb.longestFailureDays)
		});
	}
	const onlyInA = missing ? [] : listA.filter((_, j) => !used.has(j)).map((r) => r.name);
	return {
		rows,
		onlyInA,
		onlyInB,
		missing,
		thresholds: a && b && a.annualThreshold !== b.annualThreshold ? { a: a.annualThreshold, b: b.annualThreshold } : null,
		windows: a && b && window(a) !== window(b) ? { a: window(a), b: window(b) } : null
	};
}
