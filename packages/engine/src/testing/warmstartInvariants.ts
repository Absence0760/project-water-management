// Capture and resume (engine ≥ 1.1.0, ../warmstart, docs/model.md §2.16)
// as checks on any input: capturing leaves the run as it was, and a run
// resumed from the snapshot is the same days of the uninterrupted run, every
// series to the bit, in the same order, and every Reserve month it assesses
// is the uninterrupted run's month to the bit (base flow included, engine ≥
// 1.6.0).
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { runModelCapturing, runModelFrom, runModelWithoutChecks } from '../run';

/** Where `tail` (resumed at run day `k` of `full`) differs from `full`'s days k …; null when it doesn't. */
export function tailDifference(full: Pick<ModelOutput, 'series' | 'days' | 'endDate'>, tail: Pick<ModelOutput, 'series' | 'days' | 'endDate'>, k: number): string | null {
	if (tail.days !== full.days - k) return `the resumed run has ${tail.days} days, not ${full.days - k}`;
	if (tail.endDate !== full.endDate) return `the resumed run ends ${tail.endDate}, not ${full.endDate}`;
	const names = (o: Pick<ModelOutput, 'series'>) => o.series.map((x) => `${x.nodeId ?? ''}/${x.key}`).join(', ');
	if (names(tail) !== names(full)) return `series differ: [${names(tail)}] vs [${names(full)}]`;
	for (const [j, s] of full.series.entries()) {
		const t = tail.series[j]!;
		if (t.label !== s.label || t.unit !== s.unit) return `${s.nodeId}/${s.key}: label or unit differs`;
		for (let i = 0; i < t.values.length; i++) {
			if (!Object.is(t.values[i], s.values[k + i])) return `${s.nodeId}/${s.key} on ${i} days after the snapshot: ${t.values[i]} vs ${s.values[k + i]}`;
		}
	}
	return null;
}

/**
 * Where a Reserve month of `tail` (a resumed run) differs from the same
 * site's same month in `full`, every field to the bit (base flow included,
 * engine ≥ 1.6.0); null when none does. A resumed run assesses the month it
 * starts inside (from the snapshot's carry) and every later complete one.
 */
export function reserveMonthsDifference(full: Pick<ModelOutput, 'summary'>, tail: Pick<ModelOutput, 'summary'>): string | null {
	const sites = tail.summary.ewrAssurance ?? [];
	if (sites.length !== (full.summary.ewrAssurance ?? []).length) return `the resumed run assesses ${sites.length} Reserve sites, not ${full.summary.ewrAssurance?.length ?? 0}`;
	for (const [i, site] of sites.entries()) {
		const whole = full.summary.ewrAssurance![i]!;
		if (site.nodeId !== whole.nodeId || site.lowFlowMeasure !== whole.lowFlowMeasure) return `Reserve site ${i} differs`;
		for (const m of site.months) {
			const w = whole.months.find((x) => x.year === m.year && x.month === m.month);
			if (!w) return `Reserve site ${site.nodeId ?? 'outlet'}: ${m.year}-${m.month} is not a month of the uninterrupted run`;
			const keys = new Set([...Object.keys(m), ...Object.keys(w)]) as Set<keyof typeof m>;
			for (const k of keys) if (!Object.is(m[k], w[k])) return `Reserve site ${site.nodeId ?? 'outlet'} ${m.year}-${m.month} ${k}: ${String(m[k])} vs ${String(w[k])}`;
		}
	}
	return null;
}

/**
 * Capture `input`'s state at the start of run day `k` (0 … days) and resume
 * from the snapshot after a JSON round trip: null when the capture run is
 * runModelWithoutChecks' to the bit and the resumed run is its tail (every
 * series, and every Reserve month it assesses).
 * `full` is runModelWithoutChecks(input), when already run.
 */
export function checkResume(input: ModelInput, k: number, full: ModelOutput = runModelWithoutChecks(input)): string | null {
	const at = fromEpochDay(toEpochDay(full.startDate) + k);
	const { output, snapshot } = runModelCapturing(input, at);
	if (JSON.stringify(output) !== JSON.stringify(full)) return `capturing at ${at} changed the run`;
	const stored = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
	if (k === full.days) return null;
	const tail = runModelFrom(stored, input);
	const d = tailDifference(full, tail, k) ?? reserveMonthsDifference(full, tail);
	return d && `resumed at ${at}: ${d}`;
}
