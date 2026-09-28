// The Yield panel's pure parts (WP-3.6, docs/ui.md § Yield): the job's
// status line, the stored results split into the latest firm yield and the
// latest curve, and the storage–yield chart's data.
import type { YieldPoint } from '@water-management/engine';
import type { ChartSeries } from '$lib/components/charts/series';
import type { JobMeta, RunMeta, YieldJob, YieldResult } from '$lib/api';
import { fmtNum } from '$lib/format/number';

/** Assurance choices: the firm yield, then the levels South African planning quotes (1 in 50, 1 in 20, 1 in 10, 1 in 5 years). */
export const ASSURANCE_OPTIONS = [
	{ value: 1, label: 'Firm (no failure day in the record)' },
	{ value: 0.98, label: '98 % (fails in at most 1 year in 50)' },
	{ value: 0.95, label: '95 % (1 year in 20)' },
	{ value: 0.9, label: '90 % (1 year in 10)' },
	{ value: 0.8, label: '80 % (1 year in 5)' }
] as const;

export const HISTORICAL_NOTE =
	'Historical: these numbers replay the one rainfall and flow record the project has. A stochastic yield, over many possible records, can be materially lower; it is not computed here.';

/** The runs a yield can use on the Network tab: runs of the model itself, newest first. */
export function modelRuns(runs: readonly RunMeta[] | null | undefined): RunMeta[] {
	return (runs ?? []).filter((r) => !r.scenarioId);
}

/** The status line for a yield job; null once it is done (the results show instead). */
export function jobStatus(job: JobMeta | null): { text: string; busy: boolean; failed: boolean } | null {
	if (!job) return null;
	switch (job.status) {
		case 'queued':
			return { text: 'Queued: waiting for the background worker.', busy: true, failed: false };
		case 'running':
			return { text: job.progress == null ? 'Running…' : `Running: ${job.progress} % done.`, busy: true, failed: false };
		case 'failed':
			return { text: `Failed, will retry: ${job.error ?? 'no reason given'}.`, busy: false, failed: true };
		case 'dead':
			return { text: job.error === 'cancelled' ? 'Cancelled.' : `Failed: ${job.error ?? 'no reason given'}.`, busy: false, failed: true };
		case 'done':
			return null;
	}
}

/**
 * The pending job the panel should follow when it opens (one queued in
 * another tab, before a reload, or by a colleague): a running one first,
 * then a waiting one, then one waiting to retry. The API lists newest first.
 */
export function jobToFollow(jobs: readonly YieldJob[]): YieldJob | null {
	for (const s of ['running', 'queued', 'failed'] as const) {
		const j = jobs.find((x) => x.status === s);
		if (j) return j;
	}
	return null;
}

export type FirmResult = YieldResult & { points: { point: YieldPoint } };
export type CurveResult = YieldResult & { points: { baseCapacityM3: number; assurance: number; points: YieldPoint[]; monotone: boolean } };

/** Newest firm yield and newest curve among a node's results (the API lists newest first). */
export function latestResults(results: readonly YieldResult[]): { firm: FirmResult | null; curve: CurveResult | null } {
	return {
		firm: (results.find((r) => r.kind === 'firm' && 'point' in r.points) as FirmResult | undefined) ?? null,
		curve: (results.find((r) => r.kind === 'curve' && 'points' in r.points) as CurveResult | undefined) ?? null
	};
}

/** "Constant", "This farm's demand shape" or "Custom monthly shape". */
export function patternLabel(p: YieldResult['params']['pattern']): string {
	return p === 'constant' ? 'constant draft' : p === 'demand' ? "this unit's demand shape" : 'custom monthly shape';
}

export function assuranceLabel(a: number): string {
	return a >= 1 ? 'firm' : `${fmtNum(a * 100, 0)} % assurance`;
}

const noDates = { startDate: '', values: [] as (number | null)[] };

/** The storage–yield chart: x = capacity (thousand m³), y = yield (m³/day). */
export function curveChart(curve: CurveResult): { series: ChartSeries[]; xy: { x: number[]; ys: (number | null)[][] } } {
	return {
		series: [{ ...noDates, label: 'Yield (m³/day)', color: '--series-1' }],
		xy: { x: curve.points.points.map((p) => p.capacityM3 / 1000), ys: [curve.points.points.map((p) => p.yieldM3Day)] }
	};
}
