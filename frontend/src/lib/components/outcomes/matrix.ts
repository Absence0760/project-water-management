// The outcome matrix screen's view model (issue #53 R4, docs/ui.md
// § Outcome matrix): a demand sweep's members (docs/api.md § Sweeps) as the
// rows, the base run's water-year classes as the columns, and each cell's
// risk under the project's cut-offs (settings.outcomes). The numbers are the
// engine's (views/yearClasses.ts classifyWaterYears, views/outcomeMatrix.ts
// outcomeMatrix, describeOutcomeCell); this module adapts the stored sweep to
// them and words the result. It reports what past years did at each demand
// level; it never picks a level.
//
// The Reserve site (settings.outcomes.siteNodeId): the outlet, or a gauge
// with a Reserve rule table (matrixSites). At the outlet the engine picks
// the metric (months met when every level has the table there, else days
// below the pragmatic EWR, which the sweep stores only at the outlet). At a
// gauge only months met can be read, from each member's stored
// summary.ewrAssurance; a sweep without that gauge's results says so
// (siteMissing) instead of falling back to the outlet's numbers.
import {
	classifyWaterYears,
	DEMAND_SCALE_MAX,
	describeOutcomeCell,
	OUTCOME_MIN_YEARS,
	OUTCOME_RISK_CUTOFFS_PENDING_HYDROLOGIST,
	OUTCOME_RISK_LABEL,
	outcomeMatrix,
	type OutcomeLevelInput,
	type OutcomeMetric,
	type OutcomeRisk,
	type OutcomeRiskCutoffs,
	type EwrRuleTable,
	type NetworkNode,
	type RunSeries,
	type WaterYearClasses,
	type YearClassBand
} from '@water-management/engine';
import type { OutcomeSettings, StoredRunSeries, Sweep, SweepMember, SweepRequest } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';
import { effectiveCutoffs } from './outcomeSettings';

/** The demand levels a new sweep starts with, % of today's demand (planning-outputs.md S2). */
export const DEFAULT_DEMAND_LEVELS: readonly number[] = Object.freeze([100, 85, 70]);
/** Most members a sweep may have (backend sweeps/schema.ts SWEEP_MEMBERS_MAX). */
export const SWEEP_MEMBERS_MAX = 12;
/** Highest level, %: demand.scale's factor cap × 100. */
export const DEMAND_LEVEL_MAX = DEMAND_SCALE_MAX * 100;

/** "85" → "85 %", "92.5" → "92.5 %". */
export const levelLabel = (pct: number) => `${fmtNum(pct, 1, true)} %`;

/** Parse the demand-levels field ("100, 85, 70"): 1–12 distinct levels, each 0–200 %, in the order typed. */
export function parseDemandLevels(text: string): { levels: number[]; error: null } | { levels: null; error: string } {
	const parts = text
		.split(/[\s,;]+/)
		.map((p) => p.replace(/%$/, ''))
		.filter((p) => p !== '');
	if (!parts.length) return { levels: null, error: 'Enter at least one demand level, e.g. 100, 85, 70.' };
	const levels: number[] = [];
	for (const p of parts) {
		const v = Number(p);
		if (!Number.isFinite(v) || v < 0 || v > DEMAND_LEVEL_MAX) return { levels: null, error: `“${p}” is not a level from 0 to ${DEMAND_LEVEL_MAX} %.` };
		const r = Math.round(v * 10) / 10;
		if (levels.includes(r)) return { levels: null, error: `${levelLabel(r)} is listed twice.` };
		levels.push(r);
	}
	if (levels.length > SWEEP_MEMBERS_MAX) return { levels: null, error: `A sweep has at most ${SWEEP_MEMBERS_MAX} demand levels.` };
	return { levels, error: null };
}

/** The sweep request for these levels on a base run: one member per level, each one `demand.scale` op on every farm. */
export function demandSweepRequest(baseRunId: string, levels: readonly number[]): SweepRequest {
	return {
		name: `Demand levels ${levels.map(levelLabel).join(' / ')}`,
		baseRunId,
		members: levels.map((pct) => ({ name: levelLabel(pct), ops: [{ op: 'demand.scale', factor: pct / 100 }] }))
	};
}

/** A member's demand level, %, when it is one plain `demand.scale` on every farm; else null. */
export function demandLevelOf(m: Pick<SweepMember, 'ops'>): number | null {
	if (m.ops.length !== 1) return null;
	const op = m.ops[0]! as { op: string; factor?: number; nodeIds?: unknown; months?: unknown; category?: unknown };
	if (op.op !== 'demand.scale' || typeof op.factor !== 'number' || op.nodeIds !== undefined || op.months !== undefined) return null;
	if (op.category !== undefined && op.category !== 'farm') return null;
	return Math.round(op.factor * 1000) / 10;
}

/** Whether a sweep is a demand-level sweep this screen can show (R5's outlook sweeps are not). */
export const isDemandSweep = (s: Pick<Sweep, 'members'>) => s.members.length > 0 && s.members.every((m) => demandLevelOf(m) !== null);

/** The newest demand sweep of a list (the API lists newest first), or null. */
export const latestDemandSweep = (sweeps: readonly Sweep[]): Sweep | null => sweeps.find(isDemandSweep) ?? null;

/** Stored values (JSON has no NaN: a missing value is null) back to the engine's NaN. */
export const toNaN = (values: readonly (number | null)[]): number[] => values.map((v) => (v === null ? Number.NaN : v));

/** A done member as the run outcomeMatrix reads: its start, summary and series, null → NaN. */
export function memberRun(m: SweepMember): OutcomeLevelInput['run'] {
	if (m.status !== 'done' || !m.summary || !m.series || !m.startDate) throw new Error(`member ${m.name} has no stored run`);
	const series: RunSeries[] = m.series.map((s: StoredRunSeries) => ({ ...s, values: toNaN(s.values) }) as RunSeries);
	return { startDate: m.startDate, summary: m.summary, series };
}

/** Where a sweep stands, from its real status and its job's (never a timer). */
export type SweepState =
	| { kind: 'pending'; text: string; progress: number | null }
	| { kind: 'stuck'; text: string }
	| { kind: 'complete' };

export function sweepState(s: Pick<Sweep, 'status' | 'job'>): SweepState {
	if (s.status === 'complete') return { kind: 'complete' };
	const j = s.job;
	if (!j) return { kind: 'stuck', text: 'This sweep did not finish, and its job has been cleared. Start a new one.' };
	if (j.status === 'dead') return { kind: 'stuck', text: `This sweep could not run${j.error ? `: ${j.error}` : '.'}` };
	if (j.status === 'running') return { kind: 'pending', text: 'Running the demand levels…', progress: j.progress ?? null };
	if (j.status === 'failed') return { kind: 'pending', text: `The sweep failed and will be tried again${j.error ? ` (${j.error})` : ''}.`, progress: null };
	// queued, or done a moment before the sweep row reads complete
	return { kind: 'pending', text: 'Queued: waiting for the background worker.', progress: null };
}

/** A site the matrix can read: the outlet (id null) or a gauge with a Reserve rule table. */
export interface MatrixSite {
	id: string | null;
	/** For the picker: "Outlet (Outflow gauge)", "Gauge: Upper gauge". */
	label: string;
	/** In a sentence: "the outlet", "gauge Upper gauge". */
	where: string;
}

export const OUTLET_SITE: Readonly<MatrixSite> = Object.freeze({ id: null, label: 'Outlet', where: 'the outlet' });

/**
 * The sites the matrix can read, the outlet first, then every gauge above it
 * with a Reserve rule table in the project's settings, in network order: the
 * sites the engine assesses a rule table at (and the API accepts for
 * outcomes.siteNodeId).
 */
export function matrixSites(
	nodes: readonly Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId' | 'sortOrder'>[],
	ewrRules: readonly Pick<EwrRuleTable, 'siteNodeId'>[] | null | undefined
): MatrixSite[] {
	const outlet = nodes.find((n) => n.downstreamNodeId === null);
	const out: MatrixSite[] = [{ ...OUTLET_SITE, label: outlet ? `Outlet (${outlet.name})` : 'Outlet' }];
	const withTable = new Set((ewrRules ?? []).map((t) => t.siteNodeId));
	const gauges = nodes.filter((n) => n.kind === 'gauge' && n.downstreamNodeId !== null && withTable.has(n.id)).sort((a, b) => a.sortOrder - b.sortOrder);
	for (const g of gauges) out.push({ id: g.id, label: `Gauge: ${g.name}`, where: `gauge ${g.name}` });
	return out;
}

/**
 * The stored site among `sites`. One that is no longer eligible (its gauge
 * or its rule table has gone since it was chosen) falls back to the outlet,
 * with a notice saying so.
 */
export function chooseSite(stored: string | null | undefined, sites: readonly MatrixSite[]): { site: MatrixSite; notice: string | null } {
	const outlet = sites.find((x) => x.id === null) ?? OUTLET_SITE;
	if (stored == null) return { site: outlet, notice: null };
	const found = sites.find((x) => x.id === stored);
	if (found) return { site: found, notice: null };
	return { site: outlet, notice: 'The Reserve site chosen for this matrix no longer has a rule table (or is no longer in the network), so the matrix reads the outlet.' };
}

/** The measure in words, at the site it is read at (days below the pragmatic EWR are always at the outlet). */
export function metricLabel(metric: OutcomeMetric, site: Pick<MatrixSite, 'where'> = OUTLET_SITE): string {
	return metric === 'reserveMonthsMet' ? `Reserve months met (the rule table at ${site.where})` : 'Days below the pragmatic EWR at the outlet';
}

const pct = (v: number) => `${fmtNum(v * 100, 1, true)} %`;

/** The cut-offs in words, for the metric the matrix uses. */
export function cutoffsText(metric: OutcomeMetric, c: OutcomeRiskCutoffs): string {
	if (metric === 'reserveMonthsMet') {
		const r = c.reserveMonthsMet;
		return `Lower risk: at least ${pct(r.lower)} of months met. Increasing risk: at least ${pct(r.increasing)}. High risk: below that.`;
	}
	const d = c.daysBelowEwr;
	return `Lower risk: below the EWR on at most ${pct(d.lower)} of days. Increasing risk: at most ${pct(d.increasing)}. High risk: more than that.`;
}

/** A class's bounds on the base run's annual natural flow, in m³: "≤ 1 234 567 m³", "1 234 567 – 2 345 678 m³", "> 2 345 678 m³". */
export function boundsText(c: Pick<YearClassBand, 'lowerM3' | 'upperM3'>): string {
	const f = (v: number) => fmtNum(v);
	if (c.lowerM3 === null && c.upperM3 === null) return 'all years';
	if (c.lowerM3 === null) return `≤ ${f(c.upperM3!)} m³`;
	if (c.upperM3 === null) return `> ${f(c.lowerM3)} m³`;
	return `${f(c.lowerM3)} – ${f(c.upperM3)} m³`;
}

export interface MatrixColumn {
	id: string;
	label: string;
	bounds: string;
	nYears: number;
}

export interface MatrixCellView {
	risk: OutcomeRisk | null;
	/** "Lower risk", …; "Not enough years" when there are fewer than OUTCOME_MIN_YEARS. */
	riskLabel: string;
	/** describeOutcomeCell's sentence, counting years. */
	text: string;
	nYears: number;
}

export type MatrixRow =
	| { kind: 'cells'; id: string; label: string; cells: MatrixCellView[] }
	| { kind: 'notRun'; id: string; label: string; status: 'problems' | 'failed' | 'pending'; lines: string[] };

export interface MatrixView {
	metric: OutcomeMetric | null;
	metricLabel: string | null;
	/** The site read (the outlet unless a gauge was chosen). */
	site: MatrixSite;
	/** The sweep has no Reserve results at the chosen gauge: why, and what to do. No rows then, never the outlet's numbers. */
	siteMissing: string | null;
	method: WaterYearClasses['method'];
	/** Complete water years classed. */
	nYears: number;
	/** Water years the base run touches but that aren't classed (part years, or a missing day). */
	excluded: WaterYearClasses['excluded'];
	columns: MatrixColumn[];
	rows: MatrixRow[];
	/** The metric in use still has the engine's placeholder cut-offs, pending the hydrologist. */
	cutoffsPending: boolean;
	cutoffsText: string | null;
	warnings: string[];
}

export interface MatrixInput {
	/** The base run's first day and its catchment natural flow (natural_flow at the outlet), m³/day; null = missing. */
	baseStartDate: string;
	baseNatural: readonly (number | null)[];
	members: readonly SweepMember[];
	settings: OutcomeSettings;
	/** The Reserve site (chooseSite); the outlet by default. */
	site?: MatrixSite;
}

/**
 * The matrix of a complete demand sweep: columns from the base run's natural
 * flow by the project's method, one row per member in sweep order (a member
 * that didn't run is a row saying why), cells by the engine's outcomeMatrix
 * under the project's cut-offs.
 */
export function buildMatrixView(input: MatrixInput): MatrixView {
	const classes = classifyWaterYears({ startDate: input.baseStartDate, naturalM3Day: toNaN(input.baseNatural) }, { method: input.settings.yearClassMethod });
	const columns: MatrixColumn[] = classes.classes.map((c) => ({ id: c.id, label: c.label, bounds: boundsText(c), nYears: c.waterYears.length }));
	const members = [...input.members].sort((a, b) => a.position - b.position);
	const done = members.filter((m) => m.status === 'done');
	const cutoffs = effectiveCutoffs(input.settings.riskCutoffs);
	const site = input.site ?? OUTLET_SITE;
	let siteMissing: string | null = null;
	let matrix: ReturnType<typeof outcomeMatrix> | null = null;
	if (done.length && classes.years.length) {
		const levels = done.map((m) => ({ id: m.id, label: m.name, run: memberRun(m) }));
		if (site.id !== null && !levels.every((l) => l.run.summary.ewrAssurance?.some((a) => a.nodeId === site.id))) {
			// The members are the base run's inputs at other demand levels: without the gauge's table in the base run, no new sweep of it has one either.
			siteMissing = `This sweep has no Reserve results at ${site.where}: its base run was made before that gauge had a rule table. Run the model again, then run a new demand sweep of the new run.`;
		} else {
			// At a gauge only months met can be read (days below the EWR are stored at the outlet only), so the metric is forced.
			matrix = outcomeMatrix(levels, classes, { cutoffs, siteNodeId: site.id, metric: site.id === null ? 'auto' : 'reserveMonthsMet' });
		}
	}
	const cellsOf = new Map(matrix?.levels.map((l, i) => [l.id, matrix.cells[i]!] as const) ?? []);
	const labelOf = new Map(columns.map((c) => [c.id, c.label] as const));

	const rows: MatrixRow[] = siteMissing ? [] : members.map((m) => {
		const cells = cellsOf.get(m.id);
		if (m.status !== 'done' || !cells || !matrix) {
			const status = m.status === 'done' ? 'failed' : m.status;
			const lines = m.status === 'pending' ? ['Not run yet.'] : m.problems.length ? m.problems : ['This demand level could not be run.'];
			return { kind: 'notRun', id: m.id, label: m.name, status, lines };
		}
		return {
			kind: 'cells',
			id: m.id,
			label: m.name,
			cells: cells.map((cell) => ({
				risk: cell.risk,
				riskLabel: cell.risk ? OUTCOME_RISK_LABEL[cell.risk] : 'Not enough years',
				text: describeOutcomeCell(matrix.metric, cell, labelOf.get(cell.classId) ?? cell.classId),
				nYears: cell.nYears
			}))
		};
	});

	const metric = matrix?.metric ?? null;
	const warnings = [...(matrix?.warnings ?? [])];
	if (!classes.years.length) warnings.push('The base run has no complete water year (1 October to 30 September), so its years cannot be classed.');
	else if (classes.years.length < OUTCOME_MIN_YEARS * columns.length) {
		warnings.push(`Only ${classes.years.length} complete water years: some classes have fewer than ${OUTCOME_MIN_YEARS} years, and their cells say so instead of a risk.`);
	}
	return {
		metric,
		metricLabel: metric ? metricLabel(metric, site) : null,
		site,
		siteMissing,
		method: classes.method,
		nYears: classes.years.length,
		excluded: classes.excluded,
		columns,
		rows,
		cutoffsPending: metric !== null && OUTCOME_RISK_CUTOFFS_PENDING_HYDROLOGIST && input.settings.riskCutoffs[metric] === null,
		cutoffsText: metric ? cutoffsText(metric, cutoffs) : null,
		warnings
	};
}
