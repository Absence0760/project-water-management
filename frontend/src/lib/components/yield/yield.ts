// The Yield panel's pure parts (WP-3.6, docs/ui.md § Yield): the job's
// status line, the stored results split into the latest firm yield and the
// latest curve, and the storage–yield chart's data.
import type { ScenarioOp, YieldPoint } from '@water-management/engine';
import type { ChartSeries } from '#lib/components/charts/series.js';
import type { JobMeta, RunMeta, YieldJob, YieldOptions, YieldParams, YieldPatternUnit, YieldResult } from '#lib/api/index.js';
import { fmtNum } from '#lib/format/number.js';
import { isScenarioRun } from '#lib/components/runs/scenarioRun.js';

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

/**
 * The runs a yield can use on the Network tab: runs of the model itself,
 * newest first, never a forecast run (issue #51: a yield is judged on
 * history, and the API refuses a forecast run with 409).
 */
export function modelRuns(runs: readonly RunMeta[] | null | undefined): RunMeta[] {
	return (runs ?? []).filter((r) => !isScenarioRun(r) && r.trigger !== 'forecast');
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
 * jobStatus for a job its page can cancel (§ 8's future yield and the change
 * factors, 284_cancel_future_jobs): `cancelAskedFor` is the id of the job
 * this page asked to cancel, so a running one that hasn't reached its next
 * step yet says so, and a cancelled job is said plainly rather than as a
 * failure. `canCancel`: the Cancel button shows.
 */
export function cancellableJobStatus(
	job: JobMeta | null,
	cancelAskedFor: string | null
): { text: string; busy: boolean; failed: boolean; cancelled: boolean; canCancel: boolean } | null {
	const s = jobStatus(job);
	if (!s || !job) return null;
	const cancelled = job.status === 'dead' && job.error === 'cancelled';
	const asked = cancelAskedFor === job.id && job.status === 'running';
	return {
		text: asked ? 'Cancelling: it stops at its next step.' : s.text,
		busy: s.busy,
		failed: s.failed && !cancelled,
		cancelled,
		canCancel: s.busy && !asked
	};
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
		firm: (results.find((r) => r.kind === 'firm' && r.points && 'point' in r.points) as FirmResult | undefined) ?? null,
		curve: (results.find((r) => r.kind === 'curve' && r.points && 'points' in r.points) as CurveResult | undefined) ?? null
	};
}

/** Whether a result's figures were withheld from this reader: a yield on a cap or full-allocation run, for a viewer kept from the volumes (#523 I). */
export const yieldWithheld = (results: readonly YieldResult[]): boolean => results.some((r) => r.points === null);

/** One Draft pattern choice: `value` is 'constant', 'demand' (the dam's own unit) or `unit:<id>` (another unit's). */
export interface PatternChoice {
	value: string;
	label: string;
	/** Shown but not choosable, the reason in its label (the dam's own unit with no irrigation demand). */
	disabled?: boolean;
}

const UNIT_PREFIX = 'unit:';
const unitName = (name: string) => name.trim() || 'Unnamed unit';

/**
 * The Draft pattern list (docs/ui.md § Yield): Constant; this unit's own
 * irrigation demand (disabled, saying why, when it has none); then each other
 * unit with irrigation demand, in the model's order. `units` null: not known
 * yet (still loading, or the options couldn't be read), so the list is the
 * two it always had.
 */
export function patternChoices(units: readonly YieldPatternUnit[] | null, nodeId: string): PatternChoice[] {
	const out: PatternChoice[] = [{ value: 'constant', label: 'Constant: the same every day' }];
	const own = units?.find((u) => u.nodeId === nodeId);
	if (!units || own?.demand) out.push({ value: 'demand', label: "This hydrological unit's irrigation demand, by month" });
	else out.push({ value: 'demand', label: "This hydrological unit's irrigation demand, by month (it has none: no crops or demand objects)", disabled: true });
	for (const u of units ?? []) {
		if (u.nodeId !== nodeId && u.demand) out.push({ value: UNIT_PREFIX + u.nodeId, label: `${unitName(u.name)}'s irrigation demand, by month` });
	}
	return out;
}

/** A choice's request params: `pattern`, and `patternNodeId` for another unit's demand. */
export function patternParams(value: string): Pick<YieldParams, 'pattern' | 'patternNodeId'> {
	if (value.startsWith(UNIT_PREFIX)) return { pattern: 'demand', patternNodeId: value.slice(UNIT_PREFIX.length) };
	return { pattern: value === 'demand' ? 'demand' : 'constant' };
}

/**
 * "constant draft", "this hydrological unit's demand shape", "custom monthly
 * shape", or "Riverside's irrigation demand shape" for another unit's
 * (patternNodeId), by the name it had when the job ran (patternNodeName).
 * `units`, the model's units now: a unit renamed since, or no longer in the
 * model, is said so rather than hidden.
 */
export function patternLabel(p: Pick<YieldParams, 'pattern' | 'patternNodeId'> & { patternNodeName?: string }, units: readonly YieldPatternUnit[] | null = null): string {
	if (p.pattern === 'constant') return 'constant draft';
	if (p.pattern !== 'demand') return 'custom monthly shape';
	if (p.patternNodeId === undefined) return "this hydrological unit's demand shape";
	const now = units?.find((u) => u.nodeId === p.patternNodeId)?.name;
	const was = p.patternNodeName;
	const base = `${unitName(was ?? now ?? 'another unit')}'s irrigation demand shape`;
	if (units && now === undefined) return `${base} (that unit is no longer in this model)`;
	if (was !== undefined && now !== undefined && now !== was) return `${base} (the unit now called ${unitName(now)})`;
	return base;
}

/** What the panel says for a unit with no dam in the model it reads (capacity 0): no yield of its own until one is set. */
export function noDamText(name: string): string {
	return `${name.trim() || 'This unit'} has no dam in this model (capacity 0 m³). In a scenario, add a change that sets its dam capacity, then work out the yield.`;
}

/**
 * A dam nothing routes water into in the model the panel reads (the API's
 * `inflow`): its yield is 0 at any size, so the panel says why and offers no
 * yield (the API refuses one, 400 yield_no_inflow). Null when it receives water.
 */
export function noInflowText(name: string, inflow: YieldOptions['inflow'] | null | undefined): string | null {
	if (!inflow || inflow.receives) return null;
	const who = name.trim() || 'This unit';
	const upstream =
		inflow.upstreamToDam > 0 && inflow.upstreamUnits === 0
			? `Upstream inflow to dam is ${fmtNum(inflow.upstreamToDam * 100, 0)} % but no unit drains into it`
			: 'Upstream inflow to dam is 0 %';
	return `${who}'s dam receives no water in this model: Runoff to dam is 0 % and ${upstream}. In the scenario, set the share of its runoff (and of the river above it) that the dam catches.`;
}

/**
 * A scenario's stored yield worked out on other changes than the scenario has
 * now: its recorded ops hash differs (320), or, for one from before the app
 * recorded it, the scenario has been changed since. Null otherwise, and for a
 * yield on a run (a run's input never changes).
 */
export function staleNote(r: Pick<YieldResult, 'scenarioId' | 'opsSha256' | 'createdAt'>, scenario: { opsSha256: string; updatedAt: string } | null): string | null {
	if (!r.scenarioId || !scenario) return null;
	if (r.opsSha256) return r.opsSha256 === scenario.opsSha256 ? null : "Worked out before the scenario's latest changes: work it out again.";
	return Date.parse(r.createdAt) < Date.parse(scenario.updatedAt) ? 'Worked out before the scenario was last changed, possibly on other changes: work it out again to be sure.' : null;
}

/** Most a typed largest capacity may be (backend YieldParams.maxCapacityM3). */
export const MAX_CAPACITY_LIMIT_M3 = 1e12;

/**
 * The storage–yield curve's "Up to" field: '' = not given (twice the dam's
 * capacity); a number above 0 (thousands may be spaced or comma-separated);
 * else an error to show.
 */
export function parseMaxCapacity(text: string): { value: number | undefined } | { error: string } {
	const t = text.replace(/[\s\u00a0\u2009\u202f_,]/g, '');
	if (t === '') return { value: undefined };
	const v = Number(t);
	if (!/^\d*\.?\d+$/.test(t) || !(v > 0)) return { error: 'Enter the largest capacity in m³, a number above 0.' };
	if (v > MAX_CAPACITY_LIMIT_M3) return { error: 'Enter at most 1 000 000 000 000 m³.' };
	return { value: v };
}

/** The curve's range in words: to twice the dam's own capacity (every curve before the entered maximum), or to the maximum entered. */
export function curveRangeText(c: CurveResult): string {
	const n = c.points.points.length;
	const max = c.params.maxCapacityM3;
	if (max === undefined) return `at ${n} capacities from 0 to twice the dam's ${fmtNum(c.points.baseCapacityM3)} m³`;
	const own = c.points.baseCapacityM3 > 0 ? `the dam holds ${fmtNum(c.points.baseCapacityM3)} m³` : 'sizing a proposed dam: the unit has no dam in this model';
	return `at ${n} capacities from 0 to ${fmtNum(max)} m³ (${own})`;
}

/** The engine that starts every yield's dam half full (engine YIELD_START_FULL_SHARE, docs/model.md §2.13). */
export const HALF_FULL_SINCE = '1.117.0';

const versionAtLeast = (v: string, min: string): boolean => {
	const a = v.split('.').map(Number);
	const b = min.split('.').map(Number);
	for (let k = 0; k < 3; k++) {
		const x = a[k] ?? 0;
		const y = b[k] ?? 0;
		if (!(Number.isFinite(x) && Number.isFinite(y))) return false;
		if (x !== y) return x > y;
	}
	return true;
};

/** How a stored yield's dam started the record: half full from engine 1.117.0, its own initial storage before. */
export function startLabel(engineVersion: string): string {
	return versionAtLeast(engineVersion, HALF_FULL_SINCE)
		? 'half full'
		: `at the dam's own initial storage (worked out before engine ${HALF_FULL_SINCE}, which starts every yield half full)`;
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

/**
 * The tolerance the preview searches to: the job's default (backend
 * YieldParams, 0.001), which is the engine's YIELD_DEFAULT_TOLERANCE. Written
 * out so the panel doesn't import the engine's yield module (yield.test.ts
 * checks they agree).
 */
export const PREVIEW_TOLERANCE = 0.001;

/**
 * The preview runs the web build's engine and the job the backend's, and the
 * two are released separately (web@, backend@), so between releases a stored
 * yield can come from another engine than the preview. A note naming both
 * when they differ; null when they agree or nothing is stored.
 */
export function engineDiffersNote(previewEngine: string, stored: Pick<YieldResult, 'engineVersion'> | null): string | null {
	if (!stored || stored.engineVersion === previewEngine) return null;
	return `The stored yield below was worked out on engine ${stored.engineVersion} and this preview on engine ${previewEngine}, so the two can differ by what changed between those versions.`;
}

/** A scenario the preview can apply in the browser: its base run and its saved ops. */
export interface PreviewScenario {
	baseRunId: string;
	ops: ScenarioOp[];
	/** The ops' hash (Scenario.opsSha256): a new one means new ops to preview. */
	opsSha256: string;
}

/**
 * What the in-browser preview runs on, matching what the job would: a saved
 * run's own input, or a scenario's ops on its base run's. Null when there is
 * nothing to preview, or for a scenario given no PreviewScenario (an
 * application: the job applies it under the applicant mask, which only the
 * server builds, so the browser can't reproduce it).
 */
export function previewSource(
	scenarioId: string | null,
	runId: string,
	scenario: PreviewScenario | null
): { runId: string; ops: ScenarioOp[] | undefined; key: string } | null {
	if (scenarioId) return scenario ? { runId: scenario.baseRunId, ops: scenario.ops, key: `s:${scenarioId}:${scenario.baseRunId}:${scenario.opsSha256}` } : null;
	return runId ? { runId, ops: undefined, key: `r:${runId}` } : null;
}
