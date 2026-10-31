// The cumulative assessment behind § 4's combined row, as the reproduction
// bundle carries it (bundle-3; docs/evidence-pack.md § Reproduction,
// docs/followups.md § Cumulative impact): the members (their ops and hashes,
// origin and owned units), the stored report, and the background run's inputs
// when it was assessed at full allocation too. Pure: the re-run here is the
// assessment job's (backend assessments/store.ts computeAssessment and
// background.ts assessBackground), step for step, on the bundle's inputs:
// each member alone (applyScenario, under its applicant's mask), all of them
// together (combineScenarios), cumulativeImpact, and each touched dam's firm
// yield and assurance of supply (scenario/cumulativeYield.ts). A DB test
// (backend/src/evidence/bundle-assessment.db.test.ts) holds the two together:
// a bundle of the job's own assessment re-runs here to the rows it stored.
import { resolveAllocationMode } from '../allocations/mode';
import type { RunInputsSnapshot } from '../compare';
import { canonicalJson } from '../manifest';
import type { ModelInput, ModelOutput } from '../project';
import { runModelChecked } from '../run';
import { applicationMask } from '../scenario/applicant';
import { combineScenarios, type CombineScenario } from '../scenario/combine';
import { cumulativeImpact, type CumulativeMetric, type CumulativeReport, type CumulativeRow } from '../scenario/cumulative';
import { cumulativeDamRows, damFirmYields, touchedDams } from '../scenario/cumulativeYield';
import type { ScenarioOp } from '../scenario/ops';
import { applyScenario } from '../scenario/overrides';
import type { EvidenceCombined, EvidenceCombinedMeasure } from './types';

/** assessment/assessment.json's layout; bumped when it changes. */
export const ASSESSMENT_BUNDLE_VERSION = 'assessment-1';

/** One member of the assessment, as its runs took it (assessment_member, 145: copied from its scenario at insert). */
export interface BundleAssessmentMember {
	/** The id its runs took it under (the report's `scenarios[].id`): its scenario's, else the member row's. */
	id: string;
	/** The scenario it was copied from; null once a team scenario is deleted. */
	scenarioId: string | null;
	name: string;
	/** An application's ops apply under its applicant's mask (scenario/applicant.ts applicationMask). */
	origin: 'team' | 'applicant';
	/** The ops it counted with (a licence in force's terms, 227/228, else its own). */
	ops: ScenarioOp[];
	/** SHA-256 of the ops as RFC 8785 JSON. */
	opsSha256: string;
	/** The units its applicant owns (the mask's own units); [] for a team scenario. */
	ownedNodeIds: string[];
}

/** assessment/assessment.json. */
export interface BundleAssessmentFile {
	version: typeof ASSESSMENT_BUNDLE_VERSION;
	id: string;
	name: string;
	/** The engine that ran every column of its report. */
	engineVersion: string | null;
	/** Its baseline: the pack's baseline run. */
	baseRunId: string;
	/** Its background at full allocation (295), when it had one: its inputs are in assessment/background/input.json. */
	backgroundRunId: string | null;
	/** In the order its runs took them (the report's `scenarios`). */
	members: BundleAssessmentMember[];
}

/** The background row set as the assessment stores it (backend assessments/background.ts AssessmentBackground). */
export interface BundleAssessmentBackground {
	label: string;
	run: { id: string; label: string };
	report: CumulativeReport;
	verdictsOnly?: true;
}

/** The assessment's stored report (assessment/report.json): the baseline's table, the background's beside it. */
export type BundleAssessmentReport = CumulativeReport & { background?: BundleAssessmentBackground };

/** The background run's stored input, as the bundle needs it (its snapshot and checked series values). */
export interface PackBundleBackgroundRun {
	runId: string;
	/** model_run.inputs, as stored: a scenario run's, so it carries `scenario` (its ops, their hash, its base run). */
	inputs: RunInputsSnapshot & { scenario?: { baseRunId?: string; ops?: unknown; opsSha256?: string } & Record<string, unknown> };
	values: Record<string, readonly (number | null)[]>;
}

/** What buildPackBundle takes for the combined row's assessment (the backend reads it as the issuer). */
export interface PackBundleAssessment extends Omit<BundleAssessmentFile, 'version'> {
	report: BundleAssessmentReport;
	/** The background run's inputs; null without one. */
	background: PackBundleBackgroundRun | null;
}

const stored = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const same = (a: unknown, b: unknown) => canonicalJson(stored(a)) === canonicalJson(stored(b));
const DAM_METRICS: ReadonlySet<CumulativeMetric> = new Set<CumulativeMetric>(['dam_firm_yield', 'dam_reliability']);
/** The rows of the baseline's table but the dams' (`dam_firm_yield`, `dam_reliability`): `reproduce:combined` compares these. */
export const isDamRow = (r: Pick<CumulativeRow, 'metric'>) => DAM_METRICS.has(r.metric);

/** A background run's op that isn't the baseline at full allocation (backend background.ts: only the mode and registered volumes may differ). */
export function backgroundOpProblem(op: ScenarioOp): string | null {
	if (op.op === 'settings.set' && op.path === 'allocationMode') return op.value === 'fullAllocation' ? null : `it sets the allocation mode to ${String(op.value)}`;
	if (op.op === 'allocation.set' || op.op === 'allocation.remove') return null;
	return `it changes more than the allocation mode and registered volumes (${op.op})`;
}

/** What combineScenarios and applyScenario take for a member: an application's ops under its applicant's mask on `base`. */
function maskOf(base: ModelInput, m: BundleAssessmentMember): { mask?: ReturnType<typeof applicationMask> } {
	return m.origin === 'applicant' ? { mask: applicationMask(base, m.ownedNodeIds) } : {};
}

const runOf = (input: ModelInput, what: string): ModelOutput => {
	try {
		return runModelChecked(structuredClone(input));
	} catch (e) {
		throw new Error(`${what}: this engine refuses the run (${e instanceof Error ? e.message : String(e)})`);
	}
};

/**
 * The assessment's table on `base` (its baseline, or its background at full
 * allocation), run again as the assessment job ran it: `base`, each member
 * alone, all together, cumulativeImpact; with `dams`, each dam the members
 * touch gets its firm yield and assurance rows and `report.dams`, as
 * computeAssessment adds them. `baseline` is `base`'s own run when the caller
 * has it already. Throws, in words, when an op doesn't apply or the engine
 * refuses a run: the stored report says it applied and ran.
 */
export function replayAssessment(
	base: ModelInput,
	members: readonly BundleAssessmentMember[],
	opts: { dams: boolean | 'reliability'; baseline?: ModelOutput | null; what?: string }
): CumulativeReport {
	const at = opts.what ? `${opts.what}, ` : '';
	const baseline = opts.baseline ?? runOf(base, `${at}the baseline`);
	const singles = members.map((m) => {
		const r = applyScenario(base, m.ops, maskOf(base, m));
		if (r.problems.length) throw new Error(`${at}"${m.name}" alone: its ops don't apply (${r.problems.slice(0, 3).join('; ')})`);
		const out = runOf(r.input, `${at}"${m.name}" alone`);
		return { id: m.id, name: m.name, summary: out.summary, startDate: out.startDate, endDate: out.endDate, input: r.input };
	});
	const entries: CombineScenario[] = members.map((m) => ({ id: m.id, name: m.name, ops: m.ops, ...maskOf(base, m) }));
	const combined = combineScenarios(base, entries);
	if (!combined.input) throw new Error(`${at}they don't combine (${[...combined.conflicts.map((c) => c.message), ...combined.problems].slice(0, 3).join('; ')})`);
	const together = runOf(combined.input, `${at}all together`);
	const report = cumulativeImpact(
		{ summary: baseline.summary, startDate: baseline.startDate, endDate: baseline.endDate },
		singles,
		{ summary: together.summary, startDate: together.startDate, endDate: together.endDate }
	);
	if (opts.dams) {
		const { dams } = touchedDams(base, members, combined.input);
		if (dams.length) {
			// 'reliability': the rows and which dams, the firm yields left empty (each its own search, bundleParts.ts).
			const yields = (input: ModelInput, summary: ModelOutput['summary'], what: string) => {
				if (opts.dams === 'reliability') return { summary, yields: dams.map(() => null) };
				const y = damFirmYields(input, dams, what);
				report.warnings.push(...y.warnings);
				return { summary, yields: y.yields };
			};
			const b = yields(base, baseline.summary, 'The baseline');
			const one = singles.map((s) => yields(s.input, s.summary, `"${s.name}" alone`));
			const c = yields(combined.input, together.summary, 'All together');
			report.rows.push(...cumulativeDamRows(dams, b, one, c));
			const capped = [base, ...singles.map((s) => s.input), combined.input].some((i) => ['cap', 'fullAllocation'].includes(resolveAllocationMode(i.settings.allocationMode, [])));
			report.dams = { nodeIds: dams.map((d) => d.nodeId), onVolumes: capped };
		}
	}
	return report;
}

/** Where two lists of rows differ, for a message: each differing row by its measure and site. */
export function rowDifferences(stored: readonly CumulativeRow[], fresh: readonly CumulativeRow[]): string[] {
	const key = (r: CumulativeRow) => `${r.metric}${r.site ? ` at ${r.site}` : r.isOutlet ? ' at the outlet' : ''}`;
	const out: string[] = [];
	if (stored.length !== fresh.length) out.push(`${fresh.length} rows here, ${stored.length} stored`);
	const by = new Map(fresh.map((r) => [`${r.metric}\u0000${r.siteNodeId ?? ''}\u0000${r.isOutlet}`, r]));
	for (const s of stored) {
		const f = by.get(`${s.metric}\u0000${s.siteNodeId ?? ''}\u0000${s.isOutlet}`);
		if (!f) out.push(`${key(s)} isn't produced`);
		else if (!same(s, f)) out.push(`${key(s)} differs (stored all together ${String(s.combined)}, here ${String(f.combined)})`);
	}
	return out;
}

/** One measure of the combined section from a report row, as the evidence report reads it (report.ts combinedOf). */
const measureOf = (row: CumulativeRow | null | undefined): EvidenceCombinedMeasure | null =>
	row ? { baseline: row.baseline, combined: row.combined, change: row.combinedChange, sumOfSingles: row.sumOfSingles, interaction: row.interaction } : null;

/**
 * Whether § 4's combined section in the manifest is what the stored report
 * gives (report.ts combinedOf, combinedDams): the outlet's days and Reserve
 * months, each application's change alone, each dam's firm yield and
 * assurance, and the background's rows; and the members are the section's
 * applications. Empty when it is.
 */
export function combinedSectionProblems(c: EvidenceCombined, file: Pick<BundleAssessmentFile, 'members'>, report: BundleAssessmentReport): string[] {
	const problems: string[] = [];
	const outlet = (rows: readonly CumulativeRow[], metric: CumulativeMetric) => rows.find((r) => r.metric === metric && r.isOutlet) ?? null;
	const ewr = outlet(report.rows, 'ewr_days_not_met');
	const reserve = outlet(report.rows, 'reserve_months_met');
	if (!same(c.ewrDays, measureOf(ewr))) problems.push("the outlet's days below the EWR aren't the stored report's");
	if (!same(c.reserveMonths, measureOf(reserve))) problems.push("the outlet's Reserve months met aren't the stored report's");
	const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);
	if (!same(ids(report.scenarios), ids(file.members)) || !same(report.scenarios.map((s) => s.name), file.members.map((m) => m.name)))
		problems.push("the members aren't the stored report's scenarios, in its order");
	const want = [...c.applications.map((a) => a.scenarioId)].sort();
	const have = file.members.map((m) => m.scenarioId ?? '').sort();
	if (!same(want, have)) problems.push(`the members' scenarios aren't the ${c.applications.length} applications the manifest's combined row names`);
	const position = new Map(report.scenarios.map((s, i) => [s.id, i]));
	for (const a of c.applications) {
		const i = position.get(a.scenarioId);
		const alone = (row: CumulativeRow | null) => (row && i !== undefined ? (row.singleChanges[i] ?? null) : null);
		if (!same(a.ewrDays, alone(ewr)) || !same(a.reserveMonths, alone(reserve))) problems.push(`"${a.scenarioName}" alone isn't the stored report's change`);
	}
	if (c.dams !== undefined) {
		const ids = (report.dams?.nodeIds ?? []).filter((id) => report.rows.some((r) => isDamRow(r) && r.siteNodeId === id));
		if (!same(c.dams.map((d) => d.nodeId), ids)) problems.push("the dams aren't the stored report's");
		for (const d of c.dams) {
			const row = (metric: CumulativeMetric) => report.rows.find((r) => r.metric === metric && r.siteNodeId === d.nodeId) ?? null;
			if (d.onVolumes !== (report.dams?.onVolumes ?? false)) problems.push(`"${d.name}": whether its yields rest on the registered volumes isn't the stored report's`);
			if (d.withheld) continue;
			if (!same(d.firmYield, measureOf(row('dam_firm_yield'))) || !same(d.reliability, measureOf(row('dam_reliability'))))
				problems.push(`"${d.name}": its firm yield or assurance of supply isn't the stored report's`);
		}
	}
	if (c.background !== undefined) {
		const bg = report.background ?? null;
		if (!c.background !== !bg) problems.push(c.background ? 'the manifest has a background row set the stored report lacks' : 'the stored report has a background row set the manifest lacks');
		else if (c.background && bg) {
			if (c.background.label !== bg.label || c.background.runLabel !== bg.run.label) problems.push("the background's label isn't the stored report's");
			if (!same(c.background.ewrDays, measureOf(outlet(bg.report.rows, 'ewr_days_not_met'))) || !same(c.background.reserveMonths, measureOf(outlet(bg.report.rows, 'reserve_months_met'))))
				problems.push("the background's outlet rows aren't the stored report's");
		}
	}
	return problems;
}

/**
 * Whether the background run's input is the baseline at full allocation
 * (backend background.ts refusal and loadBackground): a scenario run on the
 * pack's baseline run, at full allocation, whose ops change only the mode and
 * registered volumes and, applied to the baseline's input, give its settings
 * and model; its series are the baseline's. Empty when it is.
 */
export function backgroundInputProblems(base: ModelInput, baselineRunId: string, bg: PackBundleBackgroundRun['inputs'], baseSeries: Record<string, string | null>): string[] {
	const problems: string[] = [];
	const sc = bg.scenario;
	if (!sc || sc.baseRunId !== baselineRunId) problems.push("it isn't a scenario run on the pack's baseline run");
	if (bg.settings?.allocationMode !== 'fullAllocation') problems.push("it didn't run at full allocation");
	const ops = Array.isArray(sc?.ops) ? (sc!.ops as ScenarioOp[]) : null;
	if (!ops) problems.push('it records no ops');
	else {
		for (const op of ops) {
			const p = backgroundOpProblem(op);
			if (p) problems.push(`an op isn't the baseline at full allocation: ${p}`);
		}
		const applied = applyScenario(base, ops);
		if (applied.problems.length) problems.push(`its ops don't apply to the baseline (${applied.problems.slice(0, 3).join('; ')})`);
		else {
			if (!same(applied.input.settings, bg.settings)) problems.push("its settings aren't the baseline's with its ops applied");
			if (!same(applied.input.model, bg.model)) problems.push("its model isn't the baseline's with its ops applied");
		}
	}
	const mine = Object.fromEntries(Object.entries(bg.series ?? {}).flatMap(([k, s]) => (s ? [[k, s.valuesSha256 ?? null]] : [])));
	if (!same(mine, baseSeries)) problems.push("its input series aren't the baseline's");
	return problems;
}

/** Which run of an assessment: the baseline, one member alone (its place in the members), or all of them together. */
export type AssessmentRunRef = { run: 'baseline' } | { run: 'single'; memberPosition: number } | { run: 'combined' };

/** A run's input as replayAssessment builds it (and the assessment job did). Throws, in words, when it can't be built. */
export function assessmentRunInput(base: ModelInput, members: readonly BundleAssessmentMember[], ref: AssessmentRunRef): ModelInput {
	if (ref.run === 'baseline') return base;
	if (ref.run === 'single') {
		const m = members[ref.memberPosition];
		if (!m) throw new Error(`the assessment has no application at ${ref.memberPosition}`);
		const r = applyScenario(base, m.ops, maskOf(base, m));
		if (r.problems.length) throw new Error(`"${m.name}" alone: its ops don't apply (${r.problems.slice(0, 3).join('; ')})`);
		return r.input;
	}
	const combined = combineScenarios(base, members.map((m) => ({ id: m.id, name: m.name, ops: m.ops, ...maskOf(base, m) })));
	if (!combined.input) throw new Error(`they don't combine (${[...combined.conflicts.map((c) => c.message), ...combined.problems].slice(0, 3).join('; ')})`);
	return combined.input;
}
