// Paired bands on the difference between a run and its baseline (issue #4
// phase 9, docs/model.md §2.10e, docs/run-comparison.md): an application's
// extra impact, with its uncertainty.
//
// Every member the baseline's ensemble kept is run again, unchanged (same
// parameters, pan shift and rain source), on the other run's inputs, and the
// difference other − baseline is taken member by member. Pairing cancels the
// part of the uncertainty the two runs share (the catchment's response), so
// the band on the difference is much narrower than the gap between two
// separate bands would suggest, and it is the honest statement of what the
// change itself does. Members are judged once, on the baseline: the
// application changes the network, not the observed history.
import type { ModelInput, ModelOutput } from '../project';
import { runModelWithoutChecks } from '../run';
import { ENGINE_VERSION } from '../version';
import { band, type Band } from './bands';
import {
	ensembleContext,
	ewrSitesOf,
	memberGroupSupply,
	memberSupplyFraction,
	reserveFdcBands,
	unitsOf,
	memberInput,
	memberMetrics,
	type EnsembleHeader,
	type EnsembleMember,
	type EnsembleProgress,
	type EnsembleResult,
	type MemberMetrics,
	type MemberResult
} from './ensemble';
import { prepareRun } from '../prepare';

export interface PairedMember {
	/** The baseline member's index. */
	index: number;
	/** Its outputs on the other run's inputs. */
	metrics: MemberMetrics;
}

export interface PairedResult {
	engineVersion: string;
	/** The other run's header (farm names, sites, water years). */
	header: EnsembleHeader;
	members: PairedMember[];
	cancelled: boolean;
}

/** The baseline members a paired run re-runs: every kept member, in order. */
export const pairedMembers = (baseline: Pick<EnsembleResult, 'members'>): MemberResult[] => baseline.members.filter((m) => m.accepted && m.metrics);

/**
 * Why a paired band can't be built on `other` (null when it can): the two
 * runs must use the same runoff model (bands are never pooled across models)
 * and cover the same days.
 */
export function pairedRefusal(other: ModelInput, baseline: Pick<EnsembleResult, 'options' | 'header'>): string | null {
	const run = prepareRun(other);
	if (run.settings.runoffModel !== baseline.options.model) {
		return `the runs use different runoff models (${baseline.options.model} and ${run.settings.runoffModel}); a paired band needs one model`;
	}
	// The baseline's members shift the pan coefficient; a monthly PE never reads it, so the pairs would not match.
	if (baseline.options.panOffset > 0 && run.settings.pe.kind === 'monthly') {
		return 'the baseline varies the pan coefficient, which this run’s monthly PE row does not use; a paired band needs the same members on both runs';
	}
	if (run.startDate !== baseline.header.startDate || run.days !== baseline.header.days) {
		return `the runs cover different periods (${baseline.header.startDate}, ${baseline.header.days} days, and ${run.startDate}, ${run.days} days)`;
	}
	return null;
}

/** The other run's header: the baseline's days and water years, the other run's farms and Reserve sites. */
export function pairedHeader(baseline: EnsembleHeader, output: ModelOutput): EnsembleHeader {
	return {
		...baseline,
		farms: (output.summary.curtailment?.farms ?? []).map((f) => ({ nodeId: f.nodeId, name: f.name })),
		reserveSites: (output.summary.ewrAssurance ?? []).map((s) => ({ key: s.nodeId ?? 'outlet', name: s.name })),
		units: unitsOf(output),
		ewrSites: ewrSitesOf(output)
	};
}

/** Run the baseline's kept members on another run's inputs. Throws when pairedRefusal refuses. */
export function runPairedEnsemble(
	other: ModelInput,
	baseline: Pick<EnsembleResult, 'options' | 'header' | 'members'>,
	opts: { onProgress?: (p: EnsembleProgress) => boolean | void } = {}
): PairedResult {
	const refusal = pairedRefusal(other, baseline);
	if (refusal) throw new Error(refusal);
	const ctx = ensembleContext(other, baseline.options, false);
	const todo = pairedMembers(baseline);
	const out: PairedMember[] = [];
	let head: EnsembleHeader | null = null;
	let cancelled = false;
	for (const m of todo) {
		const output = runModelWithoutChecks(memberInput(ctx, m as EnsembleMember));
		head ??= pairedHeader(baseline.header, output);
		out.push({ index: m.index, metrics: memberMetrics(ctx, output) });
		if (opts.onProgress?.({ done: out.length, total: todo.length, accepted: out.length }) === true) {
			cancelled = true;
			break;
		}
	}
	return { engineVersion: ENGINE_VERSION, header: head ?? baseline.header, members: out, cancelled };
}

export interface PairedSummary {
	/** Pairs the bands are over. */
	members: number;
	gated: boolean;
	ewrDaysNotMet: Band;
	/** Share of the pairs in which the other run fails the EWR on more days. */
	ewrDaysNotMetWorse: number | null;
	ewrDaysNotMetByMonth: Band[];
	shortfallMm3: Band;
	shortfallWorse: number | null;
	marNaturalMm3: Band;
	marOutflowMm3: Band;
	annual: { waterYear: number; days: number; natural: Band; outflow: Band }[];
	/** Farms in both runs. */
	curtailment: { nodeId: string; name: string; band: Band }[];
	/**
	 * Reserve sites in both runs: the band on the change in the share of
	 * months met, and (`worse`, issue #71; absent on summaries stored before it) the share of the
	 * pairs in which the other run meets fewer months; null below minMembers
	 * pairs or when no pair has a rate at the site.
	 */
	reserve: { key: string; name: string; band: Band; worse?: number | null }[];
	/** Farms in only one of the runs (no difference to take). */
	unpaired: string[];
	decisionRule: string;
	// Engine ≥ 1.33.0 (ENSEMBLE_MEASURES_SINCE, issue #71). Absent on summaries stored before.
	/** Every pair carries the measures below; false when the baseline's members were stored before engine 1.33.0 (their bands then have no pairs). */
	carriesMeasures?: boolean;
	/** The change in no-flow days at the outlet, and the share of the pairs with more. */
	noFlowDays?: Band;
	noFlowDaysWorse?: number | null;
	/** EWR sites in both runs: the change in days the site's EWR is not met, and the share of the pairs with more. */
	ewrSites?: { key: string; name: string; band: Band; worse: number | null }[];
	/** Units in both runs: the change in the share of demand supplied (0–1), and the share of the pairs in which it is lower. */
	supply?: { nodeId: string; name: string; band: Band; worse: number | null }[];
	/** With `own` (the applicant's units): the change in Σ supplied ÷ Σ demand over them, and the share of the pairs in which it is lower. */
	ownSupply?: { band: Band; worse: number | null };
	/** The other run's own Reserve FDC check (ER5; not a difference): per site in both runs, 12 water-year months × the table's points. */
	reserveFdc?: { key: string; name: string; months: Band[][] }[];
	/**
	 * The paired change in that curve (evidence-7, the engine review of ER5):
	 * per site in both runs, 12 water-year months × the table's points, the
	 * band on other − baseline of the impacted flow at the point, and `worse`,
	 * the share of the pairs with a flow on both sides in which the other
	 * run's is lower; null below minMembers such pairs. Unlike two bands on
	 * each run's own curve, which overlap whenever the sets disagree more
	 * than the change moves the curve, this is the change itself. Pairs index
	 * j of both curves: meaningful only where both runs' rule tables read the
	 * site at the same points, in the same unit and component, which this
	 * summary can't see (the evidence report checks it and tables nothing
	 * otherwise). Absent from a summary computed before it.
	 */
	reserveFdcChange?: { key: string; name: string; months: { band: Band; worse: number | null }[][] }[];
}

/** Bands on other − baseline, member by member. */
export function summarisePaired(
	baseline: Pick<EnsembleResult, 'options' | 'header' | 'members'>,
	paired: Pick<PairedResult, 'header' | 'members'>,
	opts: { own?: readonly string[] } = {}
): PairedSummary {
	const byIndex = new Map(pairedMembers(baseline).map((m) => [m.index, m.metrics!]));
	const pairs = paired.members.flatMap((p) => {
		const a = byIndex.get(p.index);
		return a ? [{ a, b: p.metrics }] : [];
	});
	const min = baseline.options.minMembers;
	const d = (f: (x: MemberMetrics) => number | null | undefined) =>
		band(
			pairs.map(({ a, b }) => {
				const x = f(a);
				const y = f(b);
				return typeof x === 'number' && typeof y === 'number' ? y - x : null;
			}),
			min
		);
	/** Share of the pairs with the measure on both sides in which `worse` holds (other, baseline); null below minMembers such pairs. */
	const shareOf = (f: (x: MemberMetrics) => number | null | undefined, worse: (y: number, x: number) => boolean) => {
		const both = pairs.flatMap(({ a, b }) => {
			const x = f(a);
			const y = f(b);
			return typeof x === 'number' && typeof y === 'number' ? [worse(y, x)] : [];
		});
		return both.length < min ? null : both.filter(Boolean).length / both.length;
	};
	/** Share of the pairs in which the other run's value is higher (more days, more shortfall). */
	const share = (f: (x: MemberMetrics) => number | null | undefined) => shareOf(f, (y, x) => y > x);
	/** Share of the pairs with a rate on both sides in which the other run's rate is lower (fewer months met, less supplied). */
	const lowerShare = (f: (x: MemberMetrics) => number | null | undefined) => shareOf(f, (y, x) => y < x);
	const baseFarms = new Map(baseline.header.farms.map((f) => [f.nodeId, f.name]));
	const otherFarms = new Map(paired.header.farms.map((f) => [f.nodeId, f.name]));
	const bothFarms = paired.header.farms.filter((f) => baseFarms.has(f.nodeId));
	const unpaired = [...baseline.header.farms.filter((f) => !otherFarms.has(f.nodeId)), ...paired.header.farms.filter((f) => !baseFarms.has(f.nodeId))].map((f) => f.name);
	const baseSites = new Set(baseline.header.reserveSites.map((s) => s.key));
	const years = baseline.header.waterYears;
	const o = baseline.options;
	const baseUnits = new Set((baseline.header.units ?? []).map((u) => u.nodeId));
	const baseEwrSites = new Set((baseline.header.ewrSites ?? []).map((s) => s.key));
	const fdcSites = paired.header.reserveSites.filter((s) => baseSites.has(s.key));
	const otherMembers = pairs.map((p) => p.b);
	const own = opts.own;
	return {
		members: pairs.length,
		gated: pairs.length < min,
		ewrDaysNotMet: d((x) => x.ewrDaysNotMet),
		ewrDaysNotMetWorse: share((x) => x.ewrDaysNotMet),
		ewrDaysNotMetByMonth: Array.from({ length: 12 }, (_, i) => d((x) => x.ewrDaysNotMetByMonth[i])),
		shortfallMm3: d((x) => x.shortfallMm3),
		shortfallWorse: share((x) => x.shortfallMm3),
		marNaturalMm3: d((x) => x.marNaturalMm3),
		marOutflowMm3: d((x) => x.marOutflowMm3),
		annual: years.map((y, i) => ({ ...y, natural: d((x) => x.annualNaturalMm3[i]), outflow: d((x) => x.annualOutflowMm3[i]) })),
		curtailment: bothFarms.map((f) => ({ ...f, band: d((x) => x.curtailmentM3Day[f.nodeId]) })),
		reserve: paired.header.reserveSites
			.filter((s) => baseSites.has(s.key))
			.map((s) => ({ ...s, band: d((x) => x.reserveRate[s.key]), worse: lowerShare((x) => x.reserveRate[s.key]) })),
		unpaired,
		carriesMeasures: pairs.length > 0 && pairs.every(({ a, b }) => a.noFlowDays !== undefined && b.noFlowDays !== undefined),
		noFlowDays: d((x) => x.noFlowDays),
		noFlowDaysWorse: share((x) => x.noFlowDays),
		// A baseline header stored before engine 1.33.0 has no site or unit list: the other run's, which the pairs then can't fill (n = 0).
		ewrSites: (paired.header.ewrSites ?? [])
			.filter((s) => !baseline.header.ewrSites || baseEwrSites.has(s.key))
			.map((s) => ({ ...s, band: d((x) => x.ewrSiteDaysNotMet?.[s.key]), worse: share((x) => x.ewrSiteDaysNotMet?.[s.key]) })),
		supply: (paired.header.units ?? [])
			.filter((u) => !baseline.header.units || baseUnits.has(u.nodeId))
			.map((u) => ({ ...u, band: d((x) => memberSupplyFraction(x, u.nodeId)), worse: lowerShare((x) => memberSupplyFraction(x, u.nodeId)) })),
		...(own ? { ownSupply: { band: d((x) => memberGroupSupply(x, own)), worse: lowerShare((x) => memberGroupSupply(x, own)) } } : {}),
		reserveFdc: fdcSites.map((s) => ({ ...s, months: reserveFdcBands(otherMembers, s.key, (f) => band(otherMembers.map(f), min)) })),
		reserveFdcChange: fdcSites.map((s) => ({
			...s,
			months: Array.from({ length: 12 }, (_, i) => {
				let points = 0;
				for (const { a, b } of pairs) points = Math.max(points, a.reserveFdc?.[s.key]?.[i]?.length ?? 0, b.reserveFdc?.[s.key]?.[i]?.length ?? 0);
				return Array.from({ length: points }, (_, j) => {
					const at = (x: MemberMetrics) => x.reserveFdc?.[s.key]?.[i]?.[j];
					return { band: d(at), worse: lowerShare(at) };
				});
			})
		})),
		decisionRule:
			`Each of the baseline's ${pairs.length} kept parameter sets (kept by its rule: seed ${o.seed}, ${o.members} sampled) is run on both runs' inputs with the same forcing; ` +
			`the bands are the ${o.percentiles[0]}th to ${o.percentiles[2]}th percentiles of the difference (other − baseline), shown only with at least ${min} pairs.`
	};
}
