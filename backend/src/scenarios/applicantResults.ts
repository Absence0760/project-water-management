// What an applicant (the `contributor` role, WP-3.3) sees of a run of their
// application against its base: D2's recommended default, **pending the
// client** (docs/roadmap/step-3-licensing.md § 11, docs/scenarios.md
// § Applications, issue #90). Pure: the server reads the run and its base
// past RLS (app_application_run_results, 118) and projects them here before
// anything leaves, as applicant.ts does for the base.
//
//  - every EWR site: months met, rate and longest run not met, base beside
//    application; the deficit volume only past the k rule (and on the
//    application's side only when every op was a proposal);
//  - the catchment, base beside application: its natural flow and daily EWR
//    requirement (the river, made from natural flow) at any holder count;
//    its outflow, the outflow series and the EWR deficit volume only at 5 or
//    more farm holders, since natural minus outflow is the farms' use (the k
//    rule of the share links and the contributor's series, 025/046, split in
//    164); its EWR days not met always (as the share link). The
//    application's side only when every op was a proposal (below); the
//    base's side always, since it is the published baseline, whose river
//    (and use, past k) a contributor reads anyway (app_contributor_published_runs,
//    app_contributor_catchment_runs, 164);
//  - their own units (their farm links as they read them now, and the nodes
//    the application's ops add), in full, when every op was a proposal;
//  - every other farm or water user downstream of those units, under the
//    anonymous name the base projection gives it ("Farm 3"), with only the
//    change in its share of demand supplied, in whole percentage points (the
//    measure its evidence pack prints, evidence/applicantPacks.ts
//    `changePts`), when every op was a proposal;
//  - what ran on their units: their nodes, crops, crop areas, transfers, land
//    cover, boreholes and demand objects, as in the base projection. An item
//    an op added under a hidden item's id runs under a fresh one (the
//    check's `reIds`); it is shown by the id the applicant gave it.
//
// "Every op was a proposal" (app_run_all_proposals, the share link's rule):
// a baseline assumption can change another unit's inputs (its demand set to
// 0, a neighbour's dam removed), and every figure that moves with it (the
// catchment's flow, the applicant's own supply, a neighbour's change) could
// read that unit's values out. So of such a run the application's side shows
// the EWR sites' months and the catchment's EWR days only, which the share
// link shows to anyone, and RLS hands over none of its series (118); the
// base's side stays, as RLS serves it (issue #523 G9 (d)).
import type { EwrAssuranceSite, FarmSummary, MaskedReId, ModelInput, NetworkNode, NodeKind, ProjectModel, RunSummary, UserSummary } from '@water-management/engine';
import { projectBaseForApplicant } from './applicant.js';

/** One EWR site's months, base or application. */
export interface ApplicantEwrFigures {
	months: number;
	met: number;
	/** met ÷ months; null without a complete month. */
	rate: number | null;
	longestNotMetRun: number;
	/** Only past the k rule, and on the application's side only when every op was a proposal; else null. */
	deficitM3: number | null;
}

export interface ApplicantEwrSite {
	/** null = the catchment outlet. */
	nodeId: string | null;
	/** null for the outlet; a gauge's or their own node's name; else the node's anonymous name. */
	name: string | null;
	isOutlet: boolean;
	base: ApplicantEwrFigures | null;
	application: ApplicantEwrFigures | null;
}

export interface ApplicantCatchmentFigures {
	meanNaturalFlowM3Day: number;
	/** The use's figure: only at 5 or more farm holders (164); else null. */
	meanSimulatedOutflowM3Day: number | null;
	ewrDaysNotMet: number;
	ewrFractionDaysNotMet: number;
}

/** A daily series of the catchment. */
export interface ApplicantSeries {
	startDate: string;
	values: (number | null)[];
}

/** A catchment series of both runs: the application's null when an op was a baseline assumption. */
export interface ApplicantSeriesPair {
	base: ApplicantSeries;
	application: ApplicantSeries | null;
}

export interface ApplicantUnitFigures {
	avgDemandM3Day: number;
	avgSuppliedM3Day: number;
	avgDeficitM3Day: number;
	fractionSupplied: number;
	/** Its EWR charge (a farm's avgEwrShortfallM3Day, a water user's avgEwrChargeM3Day). */
	avgEwrChargeM3Day: number;
	daysEwrNotMet: number;
	/** A farm's dam on the run's last day, and its lowest in the last year; null without a dam. */
	damEndM3: number | null;
	damLowM3: number | null;
}

export interface ApplicantUnit {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** Added by the application's ops (no base figures). */
	added: boolean;
	base: ApplicantUnitFigures | null;
	application: ApplicantUnitFigures | null;
}

export interface ApplicantDownstream {
	nodeId: string;
	/** Its anonymous name in the base projection ("Farm 3", "Water user 1"). */
	name: string;
	kind: 'farm' | 'user';
	/**
	 * The change in its share of demand supplied, application − base, in whole
	 * percentage points: the pack's measure (`changePts`, the engine's
	 * `users[].change.run` rounded). Null when either run has no share (no demand).
	 */
	supplyChangePts: number | null;
}

/** Why the catchment figures or the per-unit figures are left out. */
export type ApplicantWithheld = 'baseline_assumptions' | 'few_farm_holders';

export interface ApplicantResults {
	/** Every op of the run was a proposal on their own units. */
	allProposals: boolean;
	ewrSites: ApplicantEwrSite[];
	catchment: {
		/** EWR days not met at the outlet, always. */
		ewrDaysNotMet: { base: number; application: number };
		ewrFractionDaysNotMet: { base: number; application: number };
		/**
		 * The flows. The base's always (the published baseline: the outflow in it null below the k rule); the
		 * application's null when an op was a baseline assumption, its outflow null below the k rule (`withheld`).
		 */
		figures: { base: ApplicantCatchmentFigures; application: ApplicantCatchmentFigures | null };
		/** The EWR requirement's series at any holder count, the outflow's only past the k rule; each pair's application side as `figures`'. Null when not read. */
		series: { outflow: ApplicantSeriesPair | null; ewr: ApplicantSeriesPair | null } | null;
		/** Why the application's catchment figures (`baseline_assumptions`) or the use's (the outflow, its series, the EWR deficit: `few_farm_holders`) are left out; null when they show. */
		withheld: ApplicantWithheld | null;
	};
	/** Their own units and those the ops add; [] with `unitsWithheld` when an op was a baseline assumption. */
	units: ApplicantUnit[];
	/** Other farms and water users downstream of their units; [] when an op was a baseline assumption. */
	downstream: ApplicantDownstream[];
	unitsWithheld: ApplicantWithheld | null;
	/** What ran on their units (the application run's model as the base projection shows a model), by the ids the applicant gave. */
	model: Omit<ProjectModel, 'nodes'> & { nodes: NetworkNode[] };
}

export interface ApplicantResultsInput {
	/** The full published base (server-side only). */
	base: ModelInput;
	baseSummary: RunSummary;
	/** The application run's stored model and summary (server-side only). */
	runModel: ProjectModel;
	runSummary: RunSummary;
	/** The check that made the run's input again: its reIds map the fresh ids back. */
	reIds: readonly MaskedReId[];
	/** The application's own units as the caller reads them (a contributor: those still their farm links). */
	ownNodeIds: readonly string[];
	/** app_run_all_proposals. */
	allProposals: boolean;
	/** At least 5 farm holders (the k rule). */
	farmHoldersOk: boolean;
	/** The catchment series, read under the caller's RLS (the application's side only when every op was a proposal); null when not read. */
	series: { outflow: ApplicantSeriesPair | null; ewr: ApplicantSeriesPair | null } | null;
}

const ewrFigures = (s: EwrAssuranceSite | undefined, volumes: boolean): ApplicantEwrFigures | null =>
	s
		? {
				months: s.overall.months,
				met: s.overall.met,
				rate: s.overall.rate,
				longestNotMetRun: s.overall.longestNotMetRun,
				deficitM3: volumes ? s.overall.deficitM3 : null
			}
		: null;

const catchmentFigures = (s: RunSummary, impacted: boolean): ApplicantCatchmentFigures => ({
	meanNaturalFlowM3Day: s.catchment.meanNaturalFlowM3Day,
	meanSimulatedOutflowM3Day: impacted ? s.catchment.meanSimulatedOutflowM3Day : null,
	ewrDaysNotMet: s.catchment.ewrDaysNotMet,
	ewrFractionDaysNotMet: s.catchment.ewrFractionDaysNotMet
});

function unitFigures(f: FarmSummary | undefined, u: UserSummary | undefined): ApplicantUnitFigures | null {
	if (f)
		return {
			avgDemandM3Day: f.avgDemandM3Day,
			avgSuppliedM3Day: f.avgSuppliedM3Day,
			avgDeficitM3Day: f.avgDeficitM3Day,
			fractionSupplied: f.fractionSupplied,
			avgEwrChargeM3Day: f.avgEwrShortfallM3Day,
			daysEwrNotMet: f.daysEwrNotMet,
			damEndM3: f.damEndM3 ?? null,
			damLowM3: f.damLowM3 ?? null
		};
	if (u)
		return {
			avgDemandM3Day: u.avgDemandM3Day,
			avgSuppliedM3Day: u.avgSuppliedM3Day,
			avgDeficitM3Day: u.avgDeficitM3Day,
			fractionSupplied: u.fractionSupplied,
			avgEwrChargeM3Day: u.avgEwrChargeM3Day,
			daysEwrNotMet: u.daysEwrNotMet,
			damEndM3: null,
			damLowM3: null
		};
	return null;
}

/** A unit's share of demand supplied (0–1) in a summary: undefined when the summary doesn't have the unit, null when it has no finite share. */
function shareSupplied(s: RunSummary, nodeId: string): number | null | undefined {
	const u = s.farms.find((f) => f.nodeId === nodeId) ?? s.users?.find((x) => x.nodeId === nodeId);
	if (!u) return undefined;
	return Number.isFinite(u.fractionSupplied) ? u.fractionSupplied : null;
}

/**
 * The pack's whole percentage points of a change in share supplied: the engine's evidence report's
 * `(B − A) × 100` (users[].change.run), rounded as Postgres's round(numeric) rounds it in
 * app_applicant_pack_units (half away from zero, where Math.round takes −2.5 to −2).
 */
export const wholePoints = (pp: number): number => Math.sign(pp) * Math.round(Math.abs(pp));

/** A series pair with the application's side kept only when it may show. */
const pairShown = (p: ApplicantSeriesPair | null, app: boolean): ApplicantSeriesPair | null => (p ? { base: p.base, application: app ? p.application : null } : null);

/** The nodes below any of `from` in the network (following downstreamNodeId), `from` excluded. */
export function downstreamOf(nodes: readonly Pick<NetworkNode, 'id' | 'downstreamNodeId'>[], from: Iterable<string>): Set<string> {
	const down = new Map(nodes.map((n) => [n.id, n.downstreamNodeId]));
	const start = new Set(from);
	const out = new Set<string>();
	for (const id of start) {
		let next = down.get(id) ?? null;
		// A cycle can't pass a save, but a walk never loops on one.
		while (next && !out.has(next) && !start.has(next)) {
			out.add(next);
			next = down.get(next) ?? null;
		}
	}
	return out;
}

/** An item's id as the applicant gave it: the fresh id a masked op's new item runs under, mapped back. */
function unReId<T extends { id: string }>(items: readonly T[], kind: MaskedReId['kind'], back: Map<string, string>): T[] {
	return items.map((x) => {
		const id = back.get(`${kind}:${x.id}`);
		return id === undefined ? x : { ...x, id };
	});
}

/** The applicant's view of one application run against its base (module comment). */
export function projectResultsForApplicant(i: ApplicantResultsInput): ApplicantResults {
	const baseIds = new Set(i.base.model.nodes.map((n) => n.id));
	const runNodes = new Map(i.runModel.nodes.map((n) => [n.id, n]));
	const added = i.runModel.nodes.filter((n) => !baseIds.has(n.id)).map((n) => n.id);
	const mine = new Set([...i.ownNodeIds, ...added]);

	// The anonymous names the applicant knows the other units by: the base projection's, so "Farm 3" here is "Farm 3" there.
	const baseView = projectBaseForApplicant(i.base, i.ownNodeIds);
	const anonymous = new Set(baseView.anonymisedNodeIds);
	const anonName = new Map(baseView.model.nodes.filter((n) => anonymous.has(n.id)).map((n) => [n.id, n.name]));
	const kindOf = new Map<string, NodeKind>([...i.base.model.nodes, ...i.runModel.nodes].map((n) => [n.id, n.kind]));

	// The k rule, split (164): the river (natural flow, the EWR requirement) at any holder count; the use (outflow,
	// its series, the EWR deficit) only past k. The base is the published baseline, which a contributor reads anyway;
	// the application's side only when every op was a proposal (module comment).
	const appShown = i.allProposals;
	const impactedShown = i.farmHoldersOk;
	const catchmentWithheld: ApplicantWithheld | null = !i.allProposals ? 'baseline_assumptions' : !i.farmHoldersOk ? 'few_farm_holders' : null;

	// --- EWR sites: the base's and the application's, paired by site ---
	const siteKey = (s: EwrAssuranceSite) => (s.isOutlet || s.nodeId === null ? 'outlet' : s.nodeId);
	const baseSites = new Map((i.baseSummary.ewrAssurance ?? []).map((s) => [siteKey(s), s]));
	const runSites = new Map((i.runSummary.ewrAssurance ?? []).map((s) => [siteKey(s), s]));
	const siteName = (s: EwrAssuranceSite): string | null => {
		if (s.isOutlet || s.nodeId === null) return null;
		if (anonName.has(s.nodeId)) return anonName.get(s.nodeId)!;
		// A gauge (public, shown in full), or one of their own or added nodes.
		const n = runNodes.get(s.nodeId) ?? i.base.model.nodes.find((x) => x.id === s.nodeId);
		return n && (n.kind === 'gauge' || mine.has(n.id)) ? n.name : 'EWR site';
	};
	const ewrSites: ApplicantEwrSite[] = [...new Set([...baseSites.keys(), ...runSites.keys()])].map((key) => {
		const b = baseSites.get(key);
		const a = runSites.get(key);
		const any = (a ?? b)!;
		return {
			nodeId: key === 'outlet' ? null : key,
			name: siteName(any),
			isOutlet: key === 'outlet',
			base: ewrFigures(b, impactedShown),
			application: ewrFigures(a, impactedShown && appShown)
		};
	});

	// --- their own units ---
	const units: ApplicantUnit[] = !i.allProposals
		? []
		: [...mine]
				.filter((id) => {
					const k = kindOf.get(id);
					return k === 'farm' || k === 'user';
				})
				.map((id) => {
					const node = runNodes.get(id) ?? i.base.model.nodes.find((n) => n.id === id)!;
					const fig = (s: RunSummary) => unitFigures(s.farms.find((f) => f.nodeId === id), s.users?.find((u) => u.nodeId === id));
					return {
						nodeId: id,
						name: node.name,
						kind: node.kind as 'farm' | 'user',
						added: !baseIds.has(id),
						base: baseIds.has(id) ? fig(i.baseSummary) : null,
						application: runNodes.has(id) ? fig(i.runSummary) : null
					};
				});

	// --- the other units downstream, anonymous, as whole percentage points of share supplied (the pack's measure) ---
	const below = downstreamOf(i.runModel.nodes, [...mine].filter((id) => runNodes.has(id)));
	const downstream: ApplicantDownstream[] = !i.allProposals
		? []
		: baseView.model.nodes
				.filter((n) => anonymous.has(n.id) && below.has(n.id) && (n.kind === 'farm' || n.kind === 'user'))
				.flatMap((n) => {
					const b = shareSupplied(i.baseSummary, n.id);
					const a = shareSupplied(i.runSummary, n.id);
					if (b === undefined || a === undefined) return [];
					const pts = b === null || a === null ? null : wholePoints((a - b) * 100);
					// -0 reads as "−0 pp".
					return [{ nodeId: n.id, name: n.name, kind: n.kind as 'farm' | 'user', supplyChangePts: pts === 0 ? 0 : pts }];
				});

	// --- what ran on their units, by the ids the applicant gave ---
	const back = new Map(i.reIds.map((r) => [`${r.kind}:${r.as}`, r.id]));
	const cropBack = new Map(i.reIds.filter((r) => r.kind === 'crop').map((r) => [r.as, r.id]));
	const ran = projectBaseForApplicant({ settings: i.base.settings, model: i.runModel, series: {} } as ModelInput, mine).model;
	const model = {
		...ran,
		// Their own and added nodes only: the others are in the base projection already, under the same anonymous names.
		nodes: ran.nodes.filter((n) => mine.has(n.id)),
		crops: unReId(ran.crops, 'crop', back),
		cropAreas: ran.cropAreas.map((a) => (cropBack.has(a.cropId) ? { ...a, cropId: cropBack.get(a.cropId)! } : a)),
		transfers: unReId(ran.transfers, 'transfer', back),
		landCover: unReId(ran.landCover ?? [], 'landCover', back),
		boreholes: unReId(ran.boreholes ?? [], 'borehole', back),
		demandObjects: unReId(ran.demandObjects ?? [], 'demandObject', back)
	};

	return {
		allProposals: i.allProposals,
		ewrSites,
		catchment: {
			ewrDaysNotMet: { base: i.baseSummary.catchment.ewrDaysNotMet, application: i.runSummary.catchment.ewrDaysNotMet },
			ewrFractionDaysNotMet: { base: i.baseSummary.catchment.ewrFractionDaysNotMet, application: i.runSummary.catchment.ewrFractionDaysNotMet },
			figures: { base: catchmentFigures(i.baseSummary, impactedShown), application: appShown ? catchmentFigures(i.runSummary, impactedShown) : null },
			series: i.series ? { ewr: pairShown(i.series.ewr, appShown), outflow: impactedShown ? pairShown(i.series.outflow, appShown) : null } : null,
			withheld: catchmentWithheld
		},
		units,
		downstream,
		unitsWithheld: i.allProposals ? null : 'baseline_assumptions',
		model
	};
}
