// Builds the licensing evidence report (issue #71; docs/design/evidence-report.md,
// docs/evidence-report.md) from what the backend read. Pure and deterministic:
// the same input gives the same document, so an issued pack's manifest can be
// rebuilt and hashed. Every figure comes from the runs' own stored summaries
// and the stored ensembles, by the same definitions the compare page and the
// ensemble use (G14): nothing here re-runs the model.
import type { AllocationNodeComparison, AllocationSourceComparison, AllocationWaterSource, AllocationYear } from '../allocations/compare';
import { ALLOCATION_MODE_LABEL } from '../allocations/mode';
import { errataFor, type Erratum } from '../liability/errata';
import type { EwrAssuranceSite } from '../reserve/assurance';
import { ewrSourceConfidence, isEwrCategory } from '../reserve/rules';
import type { Band } from '../uncertainty/bands';
import { calendarMonthOf, monthName } from '../uncertainty/ensemble';
import { declaredRuleError, declaredRuleMismatches, type DeclaredUncertaintyRule } from '../uncertainty/options';
import { ENGINE_VERSION } from '../version';
import {
	EVIDENCE_REPORT_VERSION,
	type EvidenceAllocationCounts,
	type EvidenceAllocations,
	type EvidenceAllocationSource,
	type EvidenceAllocationUnit,
	type EvidenceAllocationYear,
	type EvidenceCheck,
	type EvidenceCumulative,
	type EvidenceCumulativeApplication,
	type EvidenceEnsembleInput,
	type EvidenceEnsembleRef,
	type EvidenceFlag,
	type EvidenceInput,
	type EvidenceMonthChange,
	type EvidenceOtherApplicationInput,
	type EvidenceReport,
	type EvidenceRow,
	type EvidenceRunInput,
	type EvidenceSite,
	type EvidenceSiteMonth,
	type EvidenceUser
} from './types';

const DAYS_PER_YEAR = 365.25;

/** The two EWRs a report measures against, said the same way everywhere (persona E: "label each measure's basis"). */
export const BASIS_PRAGMATIC = 'Pragmatic EWR: the daily requirement the app curtails to, at the outlet';
export const basisReserve = (source: string) => `Reserve rule table (${source}): assurance rules, complete months`;

/** What a band is, and isn't (D-U3): printed beside every rule. */
export const BAND_FOOTNOTE =
	'A band is the range across the parameter sets kept by rule R1, not a confidence interval. "Worse in k of n" counts the sets in which the application is worse. The bands cover the runoff model’s parameters (and the pan coefficient and rain source where the rule varies them) only, not the demand, the EWR tables or the network.';

/** Why a row has no band (D-U1, D-U6). */
export const NO_BAND = {
	notDeclared: 'no band: no uncertainty rule is declared for this project',
	noEnsemble: 'no band: no ensemble on the declared rule',
	noPaired: 'no band: the application has no paired ensemble on the cited one',
	gated: (k: number, n: number) => `no band: not enough accepted parameter sets (${k} of ${n})`,
	notCarried: 'no band: the ensemble doesn’t carry this measure yet',
	baseline: 'no band'
} as const;

/** Which of a project's declared rule the stored settings hold, or null when none is (or it is malformed). */
export function declaredRuleOf(run: Pick<EvidenceRunInput, 'inputs'>): DeclaredUncertaintyRule | null {
	const v = (run.inputs?.settings as { evidenceUncertaintyRule?: unknown } | undefined)?.evidenceUncertaintyRule;
	return v !== undefined && v !== null && declaredRuleError(v) === null ? (v as DeclaredUncertaintyRule) : null;
}

const fitVersion = (run: EvidenceRunInput): string | null =>
	((run.inputs?.settings as { fitRecord?: { engineVersion?: unknown } | null } | undefined)?.fitRecord?.engineVersion as string | undefined) ?? null;

/**
 * The ensemble the report cites (G4): the **first** complete, unpaired
 * ensemble on the baseline that followed the declared rule. Not the newest or
 * the kindest: with the seed drawn by the database, citing the first one
 * leaves nothing to re-roll. Every other start is listed in the ledger.
 */
export function citedEnsemble(rows: readonly EvidenceEnsembleInput[], rule: DeclaredUncertaintyRule | null): EvidenceEnsembleInput | null {
	if (!rule) return null;
	const ok = rows.filter((r) => r.baselineId === null && r.status === 'complete' && r.summary && declaredRuleMismatches(rule, r.options).length === 0);
	return oldestFirst(ok)[0] ?? null;
}

/** The paired ensemble on the application that re-ran the cited one: the first complete one. */
export function citedPaired(rows: readonly EvidenceEnsembleInput[], cited: EvidenceEnsembleInput | null): EvidenceEnsembleInput | null {
	if (!cited) return null;
	return oldestFirst(rows.filter((r) => r.baselineId === cited.id && r.status === 'complete' && r.paired))[0] ?? null;
}

const oldestFirst = <T extends { createdAt: string; id: string }>(rows: readonly T[]): T[] =>
	[...rows].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Every check the report makes on its inputs, in the order the board lists them. */
export function evidenceChecks(input: EvidenceInput): EvidenceCheck[] {
	const b = input.baseline;
	const a = input.application;
	const out: EvidenceCheck[] = [];
	const add = (c: Omit<EvidenceCheck, 'fix'> & { fix?: string }) => out.push({ ...c, fix: c.passed ? null : (c.fix ?? null) });

	const last = input.nominations.at(-1);
	const current = !!last && !last.withdrawn && last.runId === b.id;
	add({
		id: 'nominated',
		label: 'The baseline is the project’s current nominated evidence run',
		passed: current,
		detail: current
			? `Nominated ${day(last!.nominatedAt)}${last!.nominatedBy ? ` by ${last!.nominatedBy}` : ''}.`
			: !last
				? 'No run of this project has been nominated as evidence.'
				: last.withdrawn
					? `The nomination was withdrawn on ${day(last.nominatedAt)}: no run is the evidence now.`
					: `The current nomination is another run${last.runLabel ? ` (“${last.runLabel}”)` : ''}, nominated ${day(last.nominatedAt)}.`,
		refuses: true,
		blocksIssue: true,
		fix: a ? 'Run the application again on the current nominated run (rebase the scenario).' : 'Nominate this run as evidence, with a reason, or open the report of the nominated run.'
	});
	const legacy = b.runoffModel === 'legacy';
	add({
		id: 'notLegacy',
		label: 'The baseline runs a current runoff model',
		passed: !legacy,
		detail: legacy ? 'The legacy (b023 workbook) runoff model does not conserve water at the event scale (audit H1): workbook comparison only.' : `Runoff model ${modelName(b.runoffModel)}.`,
		refuses: true,
		blocksIssue: true,
		fix: 'Run the model again: every run since engine 1.0.0 uses GR4J.'
	});
	const forecast = b.trigger === 'forecast' || a?.trigger === 'forecast';
	add({
		id: 'notForecast',
		label: 'Neither run is a forecast run',
		passed: !forecast,
		detail: forecast ? 'A forecast run’s last days are modelled on forecast rain; evidence is judged on the record.' : 'Both runs are runs of the record.',
		refuses: true,
		blocksIssue: true,
		fix: 'Use an ordinary run of the model.'
	});
	if (a) {
		const sameBase = a.scenario.baseRunId === b.id;
		add({
			id: 'base',
			label: 'The application was run on this baseline',
			passed: sameBase,
			detail: sameBase ? 'Its scenario’s base run is the baseline.' : 'The application’s scenario was run on another base run.',
			refuses: true,
			blocksIssue: true,
			fix: 'Rebase the scenario onto the nominated run and run it again.'
		});
		const sameEngine = a.engineVersion === b.engineVersion;
		add({
			id: 'engine',
			label: 'Both runs use the same engine version',
			passed: sameEngine,
			detail: sameEngine ? `Engine ${b.engineVersion}.` : `Baseline engine ${b.engineVersion}, application engine ${a.engineVersion} (WP-3.15 gaming item 5).`,
			refuses: true,
			blocksIssue: true,
			fix: 'Run the baseline again, nominate the new run, and run the application on it.'
		});
		const samePeriod = a.startDate === b.startDate && a.endDate === b.endDate;
		add({
			id: 'period',
			label: 'Both runs cover the same days',
			passed: samePeriod,
			detail: samePeriod ? `${b.startDate} to ${b.endDate}.` : `Baseline ${b.startDate} to ${b.endDate}, application ${a.startDate} to ${a.endDate}.`,
			refuses: true,
			blocksIssue: true,
			fix: 'Remove the application’s change to the simulation window.'
		});
		const sameModel = a.runoffModel === b.runoffModel;
		add({
			id: 'runoffModel',
			label: 'Both runs use the same runoff model',
			passed: sameModel,
			detail: sameModel ? `${modelName(b.runoffModel)}.` : `Baseline ${modelName(b.runoffModel)}, application ${modelName(a.runoffModel)}: bands are never pooled across models.`,
			refuses: true,
			blocksIssue: true,
			fix: 'Remove the application’s change to the runoff model.'
		});
		const assumptions = a.scenario.classified.filter((c) => c === 'baseline').length;
		add({
			id: 'assumptions',
			label: 'No baseline assumption is changed',
			passed: assumptions === 0,
			detail:
				assumptions === 0
					? `All ${a.scenario.ops.length} change${a.scenario.ops.length === 1 ? ' is a proposal' : 's are proposals'}.`
					: `${assumptions} of ${a.scenario.ops.length} change${a.scenario.ops.length === 1 ? '' : 's'} move${assumptions === 1 ? 's' : ''} a baseline assumption. The report can be previewed, with the red banner on every page, but not issued.`,
		refuses: false,
		blocksIssue: true,
		fix: 'Take the baseline-assumption changes out of the application, or make them in the baseline (a new nominated run) first.'
	});
	}
	const rule = declaredRuleOf(b);
	add({
		id: 'declaredRule',
		label: 'The project declares its uncertainty rule',
		passed: !!rule,
		detail: rule ? 'Settings › Evidence declares the sample and thresholds a cited ensemble must use.' : 'No uncertainty rule is declared in the baseline’s settings.',
		refuses: false,
		blocksIssue: true,
		fix: 'An editor declares the rule under Settings › Evidence, runs the model again and nominates that run.'
	});
	const cited = citedEnsemble(input.ensembles.baseline, rule);
	add({
		id: 'citedEnsemble',
		label: 'An ensemble on the declared rule is cited',
		passed: !!cited,
		detail: cited
			? `Ensemble ${short(cited.id)}, started ${day(cited.createdAt)}: ${cited.accepted ?? 0} of ${cited.members + 1} sets kept.`
			: !rule
				? 'Nothing can be cited without a declared rule.'
				: `None of the ${input.ensembles.baseline.filter((e) => e.baselineId === null).length} ensembles on the baseline is complete and on the declared rule.`,
		refuses: false,
		blocksIssue: true,
		fix: 'Start an ensemble on the declared rule on the baseline (Runs › Uncertainty) and let it complete.'
	});
	if (a) {
		const paired = citedPaired(input.ensembles.paired, cited);
		add({
			id: 'pairedBand',
			label: 'The application has a paired band on the cited ensemble',
			passed: !!paired,
			detail: paired ? `Paired ensemble ${short(paired.id)}: ${paired.paired?.members ?? 0} pairs.` : 'The application run has no complete paired ensemble on the cited one.',
			refuses: false,
			blocksIssue: true,
			fix: 'Start a paired band on the application run against the cited ensemble.'
		});
	}
	const cov = cited?.summary?.coverage ?? [];
	const low = cov.filter((c) => c.warning);
	if (cited) {
		add({
			id: 'coverage',
			label: 'The bands hold enough of the held-out observations',
			passed: low.length === 0,
			detail: cov.length
				? cov.map((c) => `${c.inside ?? '–'} of ${c.heldOutDays} held-out days (${c.fraction === null ? '–' : pct0(c.fraction)}) inside the band`).join('; ') + '.'
				: 'No held-out observations.',
			// Printed, not blocking (§5 D-U5, ER-D4): blocking would push the rule looser until it passes.
			refuses: false,
			blocksIssue: false,
			fix: 'Read every band as a lower bound on the uncertainty; the assessor weighs it.'
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export function evidenceReport(input: EvidenceInput): EvidenceReport {
	const b = input.baseline;
	const a = input.application;
	const checks = evidenceChecks(input);
	const rule = declaredRuleOf(b);
	const cited = citedEnsemble(input.ensembles.baseline, rule);
	const pairedRow = a ? citedPaired(input.ensembles.paired, cited) : null;
	const paired = pairedRow?.paired ?? null;
	const baseSum = cited?.summary ?? null;
	const last = input.nominations.at(-1);
	const isCurrent = !!last && !last.withdrawn && last.runId === b.id;
	const pub = input.publication.current;
	const classes = a?.scenario.classified ?? [];
	const assumptionsChanged = classes.includes('baseline');

	const ledger: EvidenceEnsembleRef[] = oldestFirst(input.ensembles.baseline.filter((e) => e.baselineId === null))
		.reverse()
		.map((e) => ({
			id: e.id,
			status: e.status,
			createdAt: e.createdAt,
			createdBy: e.createdBy,
			completedAt: e.completedAt,
			seed: e.seed,
			members: e.members,
			accepted: e.accepted,
			departsFromDeclared: rule ? declaredRuleMismatches(rule, e.options) : [],
			cited: e.id === cited?.id
		}));

	const allocations = allocationSection(b, a);
	const rows = changeRows(input, cited, paired, allocations);
	const byMonth = a && paired ? monthChanges(b, a, paired.ewrDaysNotMetByMonth) : null;
	const ranked = (byMonth ?? []).filter((m): m is EvidenceMonthChange & { band: Band } => !!m.band && m.band.p50 !== null);
	const worstMonths = ranked
		.filter((m) => m.band.p50! > 0)
		.sort((x, y) => y.band.p50! - x.band.p50! || x.month - y.month)
		.slice(0, 3)
		.map((m) => ({ month: m.month, median: m.band.p50!, band: m.band }));
	const improvingMonths = ranked
		.filter((m) => m.band.p50! < 0)
		.sort((x, y) => x.band.p50! - y.band.p50! || x.month - y.month)
		.map((m) => ({ month: m.month, median: m.band.p50!, band: m.band }));

	const river = sites(b, a);
	const users = userRows(b, a);
	const cumulative = cumulativeOf(b, a, input.otherApplications, input.otherApplicationsTruncated);
	if (a) rows.push(cumulativeRow(cumulative));
	const errata = dedupe([
		...errataFor(b.engineVersion, input.liability.errata, fitVersion(b)),
		...(a ? errataFor(a.engineVersion, input.liability.errata, fitVersion(a)) : [])
	]);
	const coverage = baseSum?.coverage[0]?.fraction ?? null;
	const coverageWarning = !!baseSum?.coverageWarning;
	const flags = evidenceFlags(input, { river, baseSum, coverageWarning, assumptionsChanged, rule, cited, allocations });
	const refused = checks.some((c) => c.refuses && !c.passed);

	return {
		version: EVIDENCE_REPORT_VERSION,
		mode: a ? 'application' : 'baseline',
		builtBy: ENGINE_VERSION,
		identity: {
			title: a ? a.scenario.name : input.project.name,
			project: { ...input.project },
			baseline: {
				runId: b.id,
				label: b.label,
				engineVersion: b.engineVersion,
				runoffModel: b.runoffModel,
				startDate: b.startDate,
				endDate: b.endDate,
				createdAt: b.createdAt,
				createdBy: b.createdBy,
				nomination: isCurrent ? { nominatedAt: last!.nominatedAt, nominatedBy: last!.nominatedBy, reason: last!.reason } : null,
				published: !pub ? 'none' : pub.runId === b.id ? 'this' : 'other',
				publishedAt: pub?.publishedAt ?? null
			},
			application: a
				? {
						runId: a.id,
						label: a.label,
						engineVersion: a.engineVersion,
						createdAt: a.createdAt,
						createdBy: a.createdBy,
						scenarioId: a.scenario.id,
						scenarioName: a.scenario.name,
						scenarioStatus: a.scenario.status,
						ownerName: a.scenario.ownerName,
						opsSha256: a.scenario.opsSha256,
						proposals: classes.filter((c) => c === 'proposal').length,
						assumptions: classes.filter((c) => c === 'baseline').length
					}
				: null
		},
		checks,
		refused,
		assumptionsChanged,
		issuable: !refused && checks.every((c) => c.passed || !c.blocksIssue),
		ops: a ? a.scenario.ops.map((op, index) => ({ index, class: classes[index] ?? 'baseline', op })) : [],
		flags,
		questions: questions(checks, rows, river, input),
		rows,
		byMonth,
		worstMonths,
		improvingMonths,
		rules: { r1: baseSum?.decisionRule ?? null, r2: paired?.decisionRule ?? null, footnote: BAND_FOOTNOTE },
		river,
		uncertainty: {
			declared: rule,
			cited: ledger.find((e) => e.cited) ?? null,
			ledger,
			baseline: baseSum,
			paired,
			coverageWarning,
			coverage
		},
		credibility: { nominations: input.nominations.map((n) => ({ ...n })) },
		users,
		cumulative,
		allocations,
		appendix: {
			baselineInputs: b.inputs,
			changes: a ? input.changes : [],
			series: [...seriesRows('baseline', b), ...(a ? seriesRows('application', a) : [])],
			history: input.history,
			warnings: { baseline: [...b.summary.warnings], application: a ? [...a.summary.warnings] : null },
			applicationRuns: input.applicationRuns.map((r) => ({ ...r }))
		},
		verification: {
			methodology: { version: input.liability.methodology.version, sha256: input.liability.methodology.sha256 },
			limitations: input.liability.limitations,
			errata,
			disclaimerVersion: input.liability.disclaimerVersion
		},
		applicantStatement: a
			? {
					scenarioName: a.scenario.name,
					description: a.scenario.description,
					ownerName: a.scenario.ownerName,
					notes: a.notes,
					notesUpdatedAt: a.notesUpdatedAt,
					notesUpdatedBy: a.notesUpdatedBy
				}
			: null,
		summaries: { baseline: b.summary, application: a?.summary ?? null }
	};
}

// ---------------------------------------------------------------------------
// Page 1: the change table
// ---------------------------------------------------------------------------

/** Σ over the outlet's EWR compliance grid (m³); null without one. */
function outletShortfallMm3(run: EvidenceRunInput): number | null {
	const grid = run.summary.ewrCompliance?.outlet.shortfallM3;
	if (!grid) return null;
	let s = 0;
	for (const row of grid) for (const v of row) s += v;
	return s / 1e6;
}

const marMm3 = (m3Day: number | null | undefined) => (typeof m3Day === 'number' && Number.isFinite(m3Day) ? (m3Day * DAYS_PER_YEAR) / 1e6 : null);
const diff = (x: number | null, y: number | null) => (x === null || y === null ? null : y - x);
const worseOf = (share: number | null | undefined, n: number) => (share === null || share === undefined ? null : { k: Math.round(share * n), n });

function changeRows(input: EvidenceInput, cited: EvidenceEnsembleInput | null, paired: EvidenceReport['uncertainty']['paired'], allocations: EvidenceAllocations): EvidenceRow[] {
	const b = input.baseline;
	const a = input.application;
	const rows: EvidenceRow[] = [];
	const rule = declaredRuleOf(b);
	const n = paired?.members ?? 0;
	/** The change cell for a measure the paired summary bands; `band` null = it doesn't carry the measure. */
	const change = (run: number | null, band: Band | null | undefined, worse: { k: number; n: number } | null, scale = 1): EvidenceRow['change'] => {
		if (!a) return null;
		if (band === undefined || band === null) {
			const note = !rule ? NO_BAND.notDeclared : !cited ? NO_BAND.noEnsemble : !paired ? NO_BAND.noPaired : NO_BAND.notCarried;
			return { run, band: null, bandNote: note, worse: null };
		}
		const scaled = scale === 1 ? band : scaleBand(band, scale);
		if (paired?.gated || scaled.p50 === null) return { run, band: scaled, bandNote: NO_BAND.gated(n, cited?.members ? cited.members + 1 : n), worse: null };
		return { run, band: scaled, bandNote: null, worse };
	};

	// C10: Reserve compliance per site with a rule table, outlet first.
	const sitesA = b.summary.ewrAssurance ?? [];
	if (!sitesA.length) {
		rows.push({
			id: 'reserve',
			label: 'Reserve months met',
			basis: 'Reserve rule table',
			subject: null,
			unit: '% of months',
			higherIsWorse: false,
			baseline: null,
			application: null,
			change: null,
			notAssessed: 'Not assessed: no EWR site has a Reserve rule table, so the Reserve can’t be assessed (G16).',
			note: null
		});
	}
	for (const site of sitesA) {
		const key = site.nodeId ?? 'outlet';
		const other = a ? matchSite(a.summary.ewrAssurance ?? [], site) : null;
		const ra = site.overall.rate;
		const rb = other?.overall.rate ?? null;
		const pr = paired?.reserve.find((r) => r.key === key);
		rows.push({
			id: 'reserve',
			label: 'Reserve months met',
			basis: basisReserve(site.source),
			subject: site.name,
			unit: '% of months',
			higherIsWorse: false,
			baseline: ra === null ? null : ra * 100,
			application: a ? (rb === null ? null : rb * 100) : null,
			change: change(ra === null || rb === null ? null : (rb - ra) * 100, pr ? pr.band : undefined, worseOf(pr?.worse, n), 100),
			notAssessed: site.overall.months ? null : 'Not assessed: the run has no complete month at this site.',
			note: `${site.overall.met} of ${site.overall.months} months${other ? `; application ${other.overall.met} of ${other.overall.months}` : ''}`
		});
	}

	// C11: days below the pragmatic EWR at the outlet.
	const da = b.summary.catchment.ewrDaysNotMet;
	const db = a?.summary.catchment.ewrDaysNotMet ?? null;
	rows.push({
		id: 'ewrDays',
		label: 'Days below the EWR',
		basis: BASIS_PRAGMATIC,
		subject: null,
		unit: 'days',
		higherIsWorse: true,
		baseline: da,
		application: a ? db : null,
		change: change(diff(da, db), paired?.ewrDaysNotMet, worseOf(paired?.ewrDaysNotMetWorse, n)),
		notAssessed: null,
		note: null
	});

	// C11: shortfall volume at the outlet.
	const sa = outletShortfallMm3(b);
	const sb = a ? outletShortfallMm3(a) : null;
	rows.push({
		id: 'shortfall',
		label: 'Volume short of the EWR, whole run',
		basis: BASIS_PRAGMATIC,
		subject: null,
		unit: 'Mm³',
		higherIsWorse: true,
		baseline: sa,
		application: a ? sb : null,
		change: change(diff(sa, sb), paired?.shortfallMm3, worseOf(paired?.shortfallWorse, n)),
		notAssessed: sa === null ? 'Not assessed: the run has no EWR compliance grid (made before engine 0.3.0).' : null,
		note: null
	});

	// C12: outflow MAR, and as a share of the natural MAR.
	const oa = marMm3(b.summary.catchment.meanSimulatedOutflowM3Day);
	const ob = a ? marMm3(a.summary.catchment.meanSimulatedOutflowM3Day) : null;
	const na = marMm3(b.summary.catchment.meanNaturalFlowM3Day);
	const pctN = (o: number | null) => (o === null || !na ? null : (100 * o) / na);
	rows.push({
		id: 'outflowMar',
		label: 'Mean annual outflow at the outlet',
		basis: 'Simulated outflow, whole run, 365.25-day years',
		subject: null,
		unit: 'Mm³/a',
		higherIsWorse: false,
		baseline: oa,
		application: a ? ob : null,
		change: change(diff(oa, ob), paired?.marOutflowMm3, null),
		notAssessed: null,
		note:
			pctN(oa) === null
				? null
				: `${fixed(pctN(oa)!, 1)} % of the natural MAR${a && pctN(ob) !== null ? ` → ${fixed(pctN(ob)!, 1)} %` : ''}${a && oa && ob !== null ? `; ${signed(fixed((100 * (ob - oa)) / oa, 1))} %` : ''}`
	});

	// Registered water use (WP-3.10): one fixed row, after the applicant's own supply; last for baseline evidence.
	const registered = registeredUseRow(allocations, !!a);
	if (!a) {
		rows.push(registered);
		return rows;
	}
	// C15: the applicant's own supply, over the nodes the application owns.
	const owned = new Set(a.scenario.ownedNodeIds);
	const share = (run: EvidenceRunInput) => {
		let d = 0;
		let s = 0;
		for (const f of run.summary.farms) if (owned.has(f.nodeId)) ((d += f.avgDemandM3Day), (s += f.avgSuppliedM3Day));
		for (const u of run.summary.users ?? []) if (owned.has(u.nodeId)) ((d += u.avgDemandM3Day), (s += u.avgSuppliedM3Day));
		return d > 0 ? (100 * s) / d : null;
	};
	const ua = share(b);
	const ub = share(a);
	rows.push({
		id: 'applicantSupply',
		label: 'The applicant’s own supply',
		basis: 'Share of demand supplied, whole run, over the applicant’s own units',
		subject: null,
		unit: '% of demand',
		higherIsWorse: false,
		baseline: ua,
		application: ub,
		change: change(diff(ua, ub), null, null),
		notAssessed: ub === null ? 'Not assessed: the application has no unit of its own with demand.' : null,
		note: null
	});

	rows.push(registered);

	// C14: every other user whose supply changed, largest loss first.
	const users = userRows(b, a).filter((u) => !u.own && u.onlyIn === null && u.suppliedA !== null && u.suppliedB !== null);
	const moved = users
		.map((u) => ({ u, d: (u.suppliedB! - u.suppliedA!) * 100 }))
		.filter((x) => Math.abs(x.d) >= 0.1)
		.sort((x, y) => x.d - y.d || (x.u.name < y.u.name ? -1 : 1));
	if (!moved.length) {
		rows.push({
			id: 'userSupply',
			label: 'Other users’ supply',
			basis: 'Share of demand supplied, whole run',
			subject: null,
			unit: '% of demand',
			higherIsWorse: false,
			baseline: null,
			application: null,
			change: null,
			notAssessed: null,
			note: `No other unit’s supply changed by 0.1 percentage points or more (${users.length} checked).`
		});
	}
	for (const { u, d } of moved) {
		rows.push({
			id: 'userSupply',
			label: 'Other users’ supply',
			basis: 'Share of demand supplied, whole run',
			subject: u.name,
			unit: '% of demand',
			higherIsWorse: false,
			baseline: u.suppliedA! * 100,
			application: u.suppliedB! * 100,
			change: change(d, null, null),
			notAssessed: null,
			note: null
		});
	}
	return rows;
}

function scaleBand(bd: Band, k: number): Band {
	const m = (v: number | null) => (v === null ? null : v * k);
	return { n: bd.n, p5: m(bd.p5), p50: m(bd.p50), p95: m(bd.p95), min: m(bd.min), max: m(bd.max) };
}

/** A site in another run's list: the outlet with the outlet, a gauge by id (as compareRuns matches, name as the fallback). */
function matchSite(list: readonly EwrAssuranceSite[], site: EwrAssuranceSite): EwrAssuranceSite | null {
	if (site.isOutlet) return list.find((s) => s.isOutlet) ?? null;
	return list.find((s) => s.nodeId === site.nodeId) ?? list.find((s) => !s.isOutlet && s.name === site.name) ?? null;
}

/** Days below the outlet EWR by calendar month: each run's own difference and the paired band (water-year order). */
function monthChanges(b: EvidenceRunInput, a: EvidenceRunInput, bands: readonly Band[]): EvidenceMonthChange[] {
	const col = (run: EvidenceRunInput) => {
		const g = run.summary.ewrCompliance?.outlet.daysNotMet;
		if (!g) return null;
		const out = new Array<number>(12).fill(0);
		for (const row of g) row.forEach((v, m) => (out[m]! += v));
		return out;
	};
	const ca = col(b);
	const cb = col(a);
	return Array.from({ length: 12 }, (_, i) => ({
		month: calendarMonthOf(i),
		run: ca && cb ? cb[i]! - ca[i]! : null,
		band: bands[i] ?? null
	}));
}

// ---------------------------------------------------------------------------
// § 1 The river
// ---------------------------------------------------------------------------

/**
 * A Reserve site's REC (ER9): its rule table's `category` in the run's
 * settings, matched by site as the run matches it (the outlet is a table
 * with no site or the outflow node's id). A label the site's report doesn't
 * carry; null when not given.
 */
function siteCategory(run: EvidenceRunInput, site: EwrAssuranceSite): string | null {
	const tables = run.inputs?.settings?.ewrRules;
	if (!Array.isArray(tables)) return null;
	const outflow = run.inputs?.model?.nodes?.find((n) => n.downstreamNodeId === null)?.id;
	const key = (id: unknown) => (id === null || id === undefined || id === outflow ? null : id);
	const t = tables.find((x) => !!x && typeof x === 'object' && key(x.siteNodeId) === site.nodeId);
	return t && isEwrCategory(t.category) ? t.category : null;
}

/** Months whose natural flow is drier than the rule table's driest point (G16): the requirement is scaled with the flow there (model.md §2.9c). */
const belowTable = (site: EwrAssuranceSite | null) => (site ? site.months.filter((m) => m.beyond === 'drier').length : null);

function sites(b: EvidenceRunInput, a: EvidenceRunInput | null): EvidenceSite[] {
	return (b.summary.ewrAssurance ?? []).map((site) => {
		const other = a ? matchSite(a.summary.ewrAssurance ?? [], site) : null;
		const otherMonths = new Map((other?.months ?? []).map((m) => [`${m.year}-${m.month}`, m]));
		const delivered = (actual: number, required: number) => (required > 0 ? actual / required : null);
		const months: EvidenceSiteMonth[] = site.months.map((m) => {
			const o = otherMonths.get(`${m.year}-${m.month}`);
			return {
				year: m.year,
				month: m.month,
				waterYear: m.waterYear,
				deliveredA: delivered(m.actual, m.required),
				deliveredB: o ? delivered(o.actual, o.required) : null,
				metA: m.met,
				metB: a ? (o ? o.met : null) : null
			};
		});
		const lost = months.filter((m) => m.metA && m.metB === false).length;
		const gained = months.filter((m) => !m.metA && m.metB === true).length;
		let worst: EvidenceSite['worst'] = null;
		for (const m of months) {
			const d = a ? m.deliveredB : m.deliveredA;
			if (d !== null && (worst === null || d < worst.delivered)) worst = { year: m.year, month: m.month, delivered: d };
		}
		const otherBy = new Map((other?.byMonth ?? []).map((x) => [x.month, x]));
		const byMonth = site.byMonth.map((x) => ({ month: x.month, years: x.years, metA: x.met, metB: a ? (otherBy.get(x.month)?.met ?? null) : null }));
		// The FDC plotted: the month with the largest drop in months met; without a drop, the one met least often.
		let fdcMonth: number | null = null;
		let drop = 0;
		for (const x of byMonth) {
			const d = x.metB === null ? 0 : x.metA - x.metB;
			if (d > drop) ((drop = d), (fdcMonth = x.month));
		}
		if (fdcMonth === null) {
			let rate = Infinity;
			for (const x of site.byMonth) if (x.rate !== null && x.rate < rate) ((rate = x.rate), (fdcMonth = x.month));
		}
		const fdcDriestMonth = driestMonth(site);
		return {
			key: site.nodeId ?? 'outlet',
			name: site.name,
			isOutlet: site.isOutlet,
			source: site.source,
			sourceKind: ewrSourceConfidence(site.sourceKind) ?? 'kind of source not stated',
			component: site.component === 'lowFlow' ? 'low flows' : 'total flow',
			unit: site.unit,
			category: siteCategory(b, site),
			ewrPctNmar: site.ewrPctNmar?.pct ?? null,
			naturalMar: site.naturalMar ? { ...site.naturalMar } : null,
			months,
			lost,
			gained,
			worst,
			longestA: site.overall.longestNotMetRun,
			longestB: other ? other.overall.longestNotMetRun : null,
			rateA: site.overall.rate,
			rateB: other ? other.overall.rate : null,
			monthsA: site.overall.months,
			belowTableA: belowTable(site)!,
			belowTableB: a ? belowTable(other) : null,
			belowTableExpectedPct: site.naturalSource === 'run' && site.points.length ? 100 - site.points[site.points.length - 1]! : null,
			byMonth,
			fdcMonth,
			fdcDriestMonth
		};
	});
}

/**
 * The calendar month with the lowest mean natural flow over its complete
 * months in the baseline (table unit), ties to the first in water-year
 * order. Natural flow, not the simulated flow or its ratio to the
 * requirement: the driest month is a property of the river, so neither the
 * requirement's shape nor the application can move which month it is.
 */
export function driestMonth(site: Pick<EwrAssuranceSite, 'months' | 'byMonth'>): number | null {
	const sum = new Map<number, { total: number; n: number }>();
	for (const m of site.months) {
		if (!Number.isFinite(m.natural)) continue;
		const x = sum.get(m.month) ?? { total: 0, n: 0 };
		x.total += m.natural;
		x.n += 1;
		sum.set(m.month, x);
	}
	let best: number | null = null;
	let low = Infinity;
	// byMonth is in water-year order (Oct … Sep): the first of equal means wins.
	for (const { month } of site.byMonth) {
		const x = sum.get(month);
		if (!x || !x.n) continue;
		const mean = x.total / x.n;
		if (mean < low) ((low = mean), (best = month));
	}
	return best;
}

// ---------------------------------------------------------------------------
// § 4 Other users
// ---------------------------------------------------------------------------

/** What the cumulative row and table say they are (licensing authority: never read a sum as a combined run). */
export const CUMULATIVE_BASIS = 'Days below the pragmatic EWR at the outlet: other applications’ own changes, added up; not one combined run (WP-3.11)';
export const CUMULATIVE_NONE = 'None: no other submitted or approved application has a run of its ops on this baseline visible to the account that built this report.';
/** Page 1 names at most this many; § 4 lists every one, so the row stays one row high (G6). */
const CUMULATIVE_NAMED = 3;
export const CUMULATIVE_TRUNCATED = (n: number) =>
	`Not assessed: more than ${n} other applications have runs on this baseline; § 4 lists the newest ${n}, and a sum of part of them would understate it.`;
export const CUMULATIVE_NO_BAND = 'no band: a sum of other runs’ own differences';

/** Other applications on the baseline, each one's own change, and their sum (§ 4, and page 1's row). */
function cumulativeOf(b: EvidenceRunInput, a: EvidenceRunInput | null, others: readonly EvidenceOtherApplicationInput[], truncated: boolean): EvidenceCumulative {
	const outlet = (b.summary.ewrAssurance ?? []).find((s) => s.isOutlet) ?? null;
	const baseRate = outlet?.overall.rate ?? null;
	const baseDays = b.summary.catchment.ewrDaysNotMet;
	const pp = (rate: number | null | undefined) => (rate === null || rate === undefined || baseRate === null ? null : (rate - baseRate) * 100);
	const applications: EvidenceCumulativeApplication[] = [...others]
		.sort((x, y) => (x.runCreatedAt < y.runCreatedAt ? -1 : x.runCreatedAt > y.runCreatedAt ? 1 : x.scenarioId < y.scenarioId ? -1 : 1))
		.map((o) => {
			const reason =
				o.engineVersion !== b.engineVersion
					? `not counted: run by engine ${o.engineVersion}, the baseline by ${b.engineVersion}`
					: o.startDate !== b.startDate || o.endDate !== b.endDate
						? 'not counted: another period than the baseline’s'
						: o.runoffModel !== b.runoffModel
							? 'not counted: another runoff model than the baseline’s'
							: null;
			return {
				scenarioId: o.scenarioId,
				scenarioName: o.scenarioName,
				status: o.status,
				outcome: o.outcome,
				runId: o.runId,
				runCreatedAt: o.runCreatedAt,
				comparable: reason === null,
				reason,
				ewrDays: diff(baseDays, o.ewrDaysNotMet),
				reservePp: pp(o.reserveOutlet?.rate)
			};
		});
	const counted = applications.filter((x) => x.comparable);
	const sumOf = (vals: (number | null)[]) => (vals.some((v) => v !== null) ? vals.reduce<number>((t, v) => t + (v ?? 0), 0) : null);
	const total = { ewrDays: sumOf(counted.map((x) => x.ewrDays)), reservePp: sumOf(counted.map((x) => x.reservePp)) };
	let withThis: EvidenceCumulative['withThis'] = null;
	if (a) {
		const own = { ewrDays: diff(baseDays, a.summary.catchment.ewrDaysNotMet), reservePp: pp(outlet ? matchSite(a.summary.ewrAssurance ?? [], outlet)?.overall.rate : null) };
		withThis = { ewrDays: sumOf([total.ewrDays, own.ewrDays]), reservePp: sumOf([total.reservePp, own.reservePp]) };
	}
	if (truncated) return { applications, counted: counted.length, truncated, total: { ewrDays: null, reservePp: null }, withThis: a ? { ewrDays: null, reservePp: null } : null };
	return { applications, counted: counted.length, truncated, total, withThis };
}

/** Page 1's row over the other applications (application reports only). */
function cumulativeRow(c: EvidenceCumulative): EvidenceRow {
	const all = c.applications.filter((x) => x.comparable).map((x) => `“${x.scenarioName}”`);
	const names = all.length > CUMULATIVE_NAMED ? [...all.slice(0, CUMULATIVE_NAMED), `${all.length - CUMULATIVE_NAMED} more in § 4`] : all;
	const left = c.applications.length - c.counted;
	return {
		id: 'otherApplications',
		label: 'Other applications on this baseline, summed',
		basis: CUMULATIVE_BASIS,
		subject: null,
		unit: 'days',
		higherIsWorse: true,
		baseline: null,
		application: null,
		change: c.counted && !c.truncated ? { run: c.total.ewrDays, band: null, bandNote: CUMULATIVE_NO_BAND, worse: null } : null,
		notAssessed: c.truncated ? CUMULATIVE_TRUNCATED(c.applications.length) : !c.applications.length ? CUMULATIVE_NONE : !c.counted ? `Not assessed: none of the ${c.applications.length} other applications ran on this baseline’s engine, period and runoff model (§ 4).` : null,
		note: c.counted && !c.truncated
			? `${c.counted} application${c.counted === 1 ? '' : 's'}: ${names.join(', ')}${left ? `; ${left} more not counted (§ 4)` : ''}.${c.withThis?.ewrDays != null ? ` With this one: ${signed(fixed(c.withThis.ewrDays, 0))} days.` : ''}`
			: null
	};
}

function userRows(b: EvidenceRunInput, a: EvidenceInput['application']): EvidenceUser[] {
	const owned = new Set(a?.scenario.ownedNodeIds ?? []);
	type Node = { nodeId: string; name: string; kind: 'farm' | 'user'; fractionSupplied: number };
	const nodes = (run: EvidenceRunInput): Node[] => [
		...run.summary.farms.map((f) => ({ nodeId: f.nodeId, name: f.name, kind: 'farm' as const, fractionSupplied: f.fractionSupplied })),
		...(run.summary.users ?? []).map((u) => ({ nodeId: u.nodeId, name: u.name, kind: 'user' as const, fractionSupplied: u.fractionSupplied }))
	];
	const rel = (run: EvidenceRunInput | null, id: string) => run?.summary.supplyAssurance?.reliability.find((r) => r.nodeId === id) ?? null;
	const na = nodes(b);
	const nb = a ? nodes(a) : [];
	const inB = new Map(nb.map((x) => [x.nodeId, x]));
	const inA = new Set(na.map((x) => x.nodeId));
	const rows: EvidenceUser[] = na.map((x) => {
		const y = inB.get(x.nodeId);
		const ra = rel(b, x.nodeId);
		const rb = rel(a, x.nodeId);
		return {
			nodeId: x.nodeId,
			name: y?.name ?? x.name,
			kind: x.kind,
			own: owned.has(x.nodeId),
			suppliedA: finite(x.fractionSupplied),
			suppliedB: y ? finite(y.fractionSupplied) : null,
			timeReliabilityA: ra?.timeReliability ?? null,
			timeReliabilityB: rb?.timeReliability ?? null,
			annualReliabilityA: ra?.annualReliability ?? null,
			annualReliabilityB: rb?.annualReliability ?? null,
			onlyIn: a && !y ? 'baseline' : null
		};
	});
	for (const y of nb) {
		if (inA.has(y.nodeId)) continue;
		const rb = rel(a, y.nodeId);
		rows.push({
			nodeId: y.nodeId,
			name: y.name,
			kind: y.kind,
			own: owned.has(y.nodeId),
			suppliedA: null,
			suppliedB: finite(y.fractionSupplied),
			timeReliabilityA: null,
			timeReliabilityB: rb?.timeReliability ?? null,
			annualReliabilityA: null,
			annualReliabilityB: rb?.annualReliability ?? null,
			onlyIn: 'application'
		});
	}
	return rows;
}

// ---------------------------------------------------------------------------
// § 5 Registered water use (WP-3.10)
// ---------------------------------------------------------------------------

/** Why § 5 and its page-1 row have nothing to compare. */
export const ALLOCATIONS_NOT_ASSESSED = {
	none: 'Not assessed: the runs carry no registered volumes (WARMS registrations, licences), so modelled use can’t be compared with a registered volume. An editor adds them on the Allocations tab; the model then has to run again.',
	notMatched: (n: number) =>
		`Not assessed: none of the runs’ ${n} registered volume${n === 1 ? ' is' : 's are'} matched to a farm or water user in them. Match them on the Allocations tab and run the model again.`,
	noWholeYear: 'Not assessed: the runs cover no whole water year, so no year’s use is judged.'
} as const;

const SOURCES: readonly AllocationWaterSource[] = ['surface', 'groundwater'];
const hasVolume = (n: AllocationNodeComparison) => n.surface.allocationIds.length > 0 || n.groundwater.allocationIds.length > 0;
const allocationCount = (c: NonNullable<EvidenceRunInput['allocations']>) =>
	c.nodes.reduce((k, n) => k + n.surface.allocationIds.length + n.groundwater.allocationIds.length, 0) + c.unmatchedAllocationIds.length + c.notInRunAllocationIds.length;

function countsOf(side: AllocationSourceComparison): EvidenceAllocationCounts {
	const whole = side.years.filter((y) => !y.partial);
	const n = (f: (y: AllocationYear) => boolean) => whole.filter(f).length;
	return {
		wholeYears: whole.length,
		over: n((y) => y.status === 'over'),
		within: n((y) => y.status === 'within'),
		under: n((y) => y.status === 'under'),
		noVolume: n((y) => y.status === 'unregistered' || y.status === 'none')
	};
}

/**
 * § 5: per farm or water user with a registered volume in either run, per
 * water source with one, every water year of both runs: the registered
 * volume and the modelled use, and whole years counted over, within and
 * under the band. Units are matched by node id (as § 4 matches them) and
 * named by the unit, never the holder (D3).
 */
function allocationSection(b: EvidenceRunInput, a: EvidenceInput['application']): EvidenceAllocations {
	const ca = b.allocations ?? null;
	const cb = a ? (a.allocations ?? null) : null;
	const owned = new Set(a?.scenario.ownedNodeIds ?? []);
	const unitsA = (ca?.nodes ?? []).filter(hasVolume);
	const unitsB = (cb?.nodes ?? []).filter(hasVolume);
	const total = Math.max(ca ? allocationCount(ca) : 0, cb ? allocationCount(cb) : 0);
	const inA = new Map((ca?.nodes ?? []).map((n) => [n.nodeId, n]));
	const inB = new Map((cb?.nodes ?? []).map((n) => [n.nodeId, n]));
	const ids = [...unitsA.map((n) => n.nodeId), ...unitsB.map((n) => n.nodeId).filter((id) => !unitsA.some((n) => n.nodeId === id))];

	const units: EvidenceAllocationUnit[] = ids.map((nodeId) => {
		const na = inA.get(nodeId) ?? null;
		const nb = inB.get(nodeId) ?? null;
		const sources: EvidenceAllocationSource[] = [];
		for (const src of SOURCES) {
			const sa = na ? na[src] : null;
			const sb = nb ? nb[src] : null;
			if (!sa?.allocationIds.length && !sb?.allocationIds.length) continue;
			const byYearA = new Map((sa?.years ?? []).map((y) => [y.waterYear, y]));
			const byYearB = new Map((sb?.years ?? []).map((y) => [y.waterYear, y]));
			const years = [...new Set([...byYearA.keys(), ...byYearB.keys()])].sort((x, y) => x - y);
			sources.push({
				waterSource: src,
				years: years.map((wy): EvidenceAllocationYear => {
					const ya = byYearA.get(wy) ?? null;
					const yb = byYearB.get(wy) ?? null;
					const any = (ya ?? yb)!;
					return {
						waterYear: wy,
						days: any.days,
						yearDays: any.yearDays,
						partialA: ya ? ya.partial : null,
						partialB: yb ? yb.partial : null,
						registeredA: ya ? ya.registeredM3 : null,
						modelledA: ya ? ya.modelledM3 : null,
						statusA: ya ? ya.status : null,
						registeredB: yb ? yb.registeredM3 : null,
						modelledB: yb ? yb.modelledM3 : null,
						statusB: yb ? yb.status : null
					};
				}),
				countsA: sa?.allocationIds.length ? countsOf(sa) : null,
				countsB: sb?.allocationIds.length ? countsOf(sb) : null,
				meanModelledA: sa ? sa.meanModelledM3PerYear : null,
				meanRegisteredA: sa ? sa.meanRegisteredM3PerYear : null,
				meanModelledB: sb ? sb.meanModelledM3PerYear : null,
				meanRegisteredB: sb ? sb.meanRegisteredM3PerYear : null
			});
		}
		const n = (nb ?? na)!;
		return { nodeId, name: n.name, kind: n.kind, own: owned.has(nodeId), onlyIn: a && !nb ? 'baseline' : a && !na ? 'application' : null, sources };
	});

	return {
		notAssessed: total === 0 ? ALLOCATIONS_NOT_ASSESSED.none : units.length === 0 ? ALLOCATIONS_NOT_ASSESSED.notMatched(total) : null,
		modeA: b.summary.allocations?.mode ?? null,
		modeB: a ? (a.summary.allocations?.mode ?? null) : null,
		toleranceA: ca?.tolerance ?? null,
		toleranceB: cb?.tolerance ?? null,
		units,
		notMatchedA: ca ? ca.unmatchedAllocationIds.length + ca.notInRunAllocationIds.length : 0,
		notMatchedB: a ? (cb ? cb.unmatchedAllocationIds.length + cb.notInRunAllocationIds.length : 0) : null
	};
}

/** Σ over units and sources of a run's whole years over, and of those judged. */
function allocationTotals(al: EvidenceAllocations, run: 'A' | 'B') {
	let over = 0;
	let judged = 0;
	for (const u of al.units)
		for (const s of u.sources) {
			const c = run === 'A' ? s.countsA : s.countsB;
			if (c) ((over += c.over), (judged += c.wholeYears));
		}
	return { over, judged };
}

const bandWords = (tol: number | null) => (tol === null ? 'the band' : `±${fixed(tol * 100, 0)} %`);
/** The band, both runs' when they differ: "±10 %", or "±10 % (baseline), ±15 % (application)". */
const bandsWords = (al: EvidenceAllocations, app: boolean) =>
	app && al.toleranceA !== null && al.toleranceB !== null && al.toleranceA !== al.toleranceB
		? `${bandWords(al.toleranceA)} (baseline), ${bandWords(al.toleranceB)} (application)`
		: bandWords(al.toleranceA ?? al.toleranceB);
const modeWords = (m: EvidenceAllocations['modeA']) => (m === null ? 'not recorded' : ALLOCATION_MODE_LABEL[m]);

/** Page 1's fixed "Registered vs modelled use" row (G6): unit-years above the registered volume, both runs. */
function registeredUseRow(al: EvidenceAllocations, app: boolean): EvidenceRow {
	const A = allocationTotals(al, 'A');
	const B = app ? allocationTotals(al, 'B') : null;
	const judged = A.judged + (B?.judged ?? 0);
	const notAssessed = al.notAssessed ?? (judged === 0 ? ALLOCATIONS_NOT_ASSESSED.noWholeYear : null);
	const mode =
		!app || al.modeA === al.modeB ? `allocation mode: ${modeWords(al.modeA)}` : `allocation mode: baseline ${modeWords(al.modeA)}, application ${modeWords(al.modeB)}`;
	const capped = al.modeA === 'cap' || al.modeB === 'cap' ? '; a capped run’s use can’t go far above its volume' : '';
	return {
		id: 'registeredUse',
		label: 'Registered vs modelled use',
		basis: `Whole water years in which a unit’s modelled use is more than ${bandsWords(al, app)} above its registered volume, summed over units and water sources (modelled, not metered)`,
		subject: null,
		unit: 'unit-years',
		higherIsWorse: true,
		baseline: notAssessed ? null : A.over,
		application: notAssessed || !B ? null : B.over,
		change: app ? { run: notAssessed || !B ? null : B.over - A.over, band: null, bandNote: NO_BAND.notCarried, worse: null } : null,
		notAssessed,
		note: notAssessed ? null : `${A.over} of ${A.judged} unit-years judged${B ? `; application ${B.over} of ${B.judged}` : ''}; ${mode}${capped} (§ 5)`
	};
}

/** The "read these first" line when the reported run's use is above a registered volume; null when it never is. */
function allocationsOverFlag(al: EvidenceAllocations, app: boolean): string | null {
	const items = al.units.flatMap((u) =>
		u.sources.flatMap((s) => {
			const c = app ? s.countsB : s.countsA;
			if (!c || c.over === 0) return [];
			const was = app ? (s.countsA ? ` (baseline ${s.countsA.over} of ${s.countsA.wholeYears})` : ' (no volume in the baseline)') : '';
			return [`${u.name}${u.own ? ' (the applicant’s)' : ''}, ${s.waterSource} water, ${c.over} of ${c.wholeYears} whole water years${was}`];
		})
	);
	if (!items.length) return null;
	const SHOWN = 5;
	const more = items.length > SHOWN ? `; and ${items.length - SHOWN} more` : '';
	const differ = app && al.toleranceA !== null && al.toleranceB !== null && al.toleranceA !== al.toleranceB;
	const tol = `${bandWords(app ? (al.toleranceB ?? al.toleranceA) : al.toleranceA)}${differ ? ` (the application’s band; the baseline’s is ${bandWords(al.toleranceA)})` : ''}`;
	return `The ${app ? 'application' : 'baseline'}’s modelled use is more than ${tol} above the registered volume: ${items.slice(0, SHOWN).join('; ')}${more} (§ 5).`;
}

// ---------------------------------------------------------------------------
// Flags and questions
// ---------------------------------------------------------------------------

function evidenceFlags(
	input: EvidenceInput,
	ctx: {
		river: EvidenceSite[];
		baseSum: EvidenceReport['uncertainty']['baseline'];
		coverageWarning: boolean;
		assumptionsChanged: boolean;
		rule: DeclaredUncertaintyRule | null;
		cited: EvidenceEnsembleInput | null;
		allocations: EvidenceAllocations;
	}
): EvidenceFlag[] {
	const b = input.baseline;
	const a = input.application;
	const out: EvidenceFlag[] = [];
	const add = (id: string, level: EvidenceFlag['level'], text: string, effect: string | null = null) => out.push({ id, level, text, effect });

	if (ctx.assumptionsChanged) add('assumptions', 'red', 'Baseline assumptions changed: this report is a preview and can’t be issued.', 'The change column mixes the application with a changed baseline.');
	if (ctx.baseSum && !ctx.baseSum.referenceAccepted) add('reference', 'red', 'The nominated run fails its own uncertainty rule: it is outside the set of parameter sets the rule keeps.', 'The run’s own figures are not among the plausible ones.');
	// G16: the EWR can't be off.
	const settings = b.inputs?.settings as { ewrRules?: { ewr?: number[][] }[]; ewrPragmaticM3PerDay?: number[] } | undefined;
	const zeroTable = (settings?.ewrRules ?? []).some((t) => Array.isArray(t?.ewr) && t.ewr.every((row) => Array.isArray(row) && row.every((v) => v === 0)));
	const pragmatic = settings?.ewrPragmaticM3PerDay;
	if (zeroTable || (Array.isArray(pragmatic) && pragmatic.length && pragmatic.every((v) => v === 0)))
		add('ewrZero', 'red', 'An EWR is set to 0: a site with a zero requirement always passes.', 'Compliance at that site is overstated.');
	if (!ctx.river.length) add('noReserve', 'caution', 'No Reserve rule table at any EWR site: Reserve compliance is not assessed; only the pragmatic EWR is.', 'The Reserve’s monthly assurance rules are not applied.');
	if (ctx.coverageWarning) {
		const c = ctx.baseSum?.coverage.find((x) => x.warning);
		add(
			'coverage',
			'caution',
			`The bands are too narrow to trust: ${c?.fraction === null || c?.fraction === undefined ? '–' : pct0(c.fraction)} of ${c?.heldOutDays ?? '–'} held-out days fall inside them.`,
			'Read every band as a lower bound on the uncertainty.'
		);
	}
	if (ctx.baseSum?.gated) add('gated', 'caution', `Only ${ctx.baseSum.accepted} parameter sets passed the rule, fewer than the ${ctx.cited?.options.minMembers ?? 30} a band needs: no bands.`, 'Changes are the run’s own difference only.');
	if (!ctx.rule) add('noRule', 'caution', 'No uncertainty rule is declared: no ensemble is cited and no change carries a band.', 'The change column shows the run’s own difference only.');
	for (const run of a ? [b, a] : [b]) {
		const who = run === b ? 'baseline' : 'application';
		const f = run.summary.forecastRain;
		if (f && f.days > 0) add(`forecast-${who}`, 'caution', `The ${who} uses forecast rain on ${f.days} day${f.days === 1 ? '' : 's'} (${f.from} to ${f.to}), ${f.inReport} inside the reporting window.`, 'Those days are modelled, not recorded.');
	}
	const wr = b.summary.wr2012;
	if (wr && wr.flag.level !== 'ok') {
		const dev = wr.flag.deviationPct;
		add(
			'wr2012',
			'caution',
			`WR2012 check: ${wr.flag.level}${dev === null ? '' : `, natural MAR ${signed(fixed(dev, 0))} % against the scaled WR2012 reference`}.`,
			dev === null ? null : dev < 0 ? 'Natural flow reads low: requirements read off the run’s natural flow are low too.' : 'Natural flow reads high: requirements read off it are high too.'
		);
	}
	for (const s of ctx.river) {
		// G16: below the table's driest point the requirement is scaled with the flow (model.md §2.9c), a rule pending the hydrologist.
		const below = Math.max(s.belowTableA, s.belowTableB ?? 0);
		if (below) {
			const counts = s.belowTableB === null || s.belowTableB === s.belowTableA ? `${s.belowTableA} of ${s.monthsA} months` : `${s.belowTableA} of ${s.monthsA} months in the baseline and ${s.belowTableB} in the application`;
			add(
				`belowTable-${s.key}`,
				'caution',
				`At ${s.name} the natural flow is drier than the rule table’s driest point in ${counts}: the requirement there is scaled with the flow, a rule pending the hydrologist.${
					s.belowTableExpectedPct === null ? '' : ` With the percentile from the run, about ${fixed(s.belowTableExpectedPct, 0)} % of months fall there by construction.`
				}`,
				'The requirement shrinks with the flow in those months, below the table’s driest requirement, so they are easier to meet than if it were held at that level.'
			);
		}
		if (s.naturalMar && Math.abs(s.naturalMar.differencePct) > 10)
			add(`nmar-${s.key}`, 'caution', `At ${s.name} the run’s natural MAR differs from the determination’s by ${signed(fixed(s.naturalMar.differencePct, 0))} %.`, 'The requirement read off the run’s natural flow shifts with it.');
	}
	const failed = b.summary.plausibility?.naturalised?.failedYears ?? [];
	const judged = b.summary.plausibility?.naturalised?.judgedYears ?? 0;
	if (failed.length) add('plausibility', 'caution', `Plausibility check 1 fails in ${failed.length} of ${judged} water years (natural flow below observed plus abstraction).`, 'Natural flow is too low in those years.');
	if (!b.summary.calibration || !b.summary.calibration.days) add('noCalibration', 'caution', 'Not assessed: the baseline has no observed flow in its calibration window, so its fit is untested.');
	const fit = (b.inputs?.settings as { fitRecord?: unknown } | undefined)?.fitRecord;
	if (!fit) add('noFit', 'caution', 'Validation not assessed: the runoff parameters don’t come from a stored automatic fit.', 'The scores are in-sample only.');
	const infill = b.summary.chirpsCorrection?.pooled.days;
	if (b.summary.chirpsCorrection && infill) add('chirps', 'count', `CHIRPS satellite rain fills gaps in the catchment rain (bias-corrected; factors fitted on ${infill} shared days).`);
	const dq = b.summary.dataQuality?.seriesChecks?.length ?? 0;
	if (dq) add('dataQuality', 'count', `${dq} data-quality check${dq === 1 ? '' : 's'} fired on the baseline’s inputs (§ 3).`);
	const over = allocationsOverFlag(ctx.allocations, !!a);
	if (over) add('allocationsOver', 'caution', over, 'Modelled, not metered: arithmetic against the registered volume, not a finding on whether a use is lawful.');
	const wa = b.summary.warnings.length;
	const wb = a?.summary.warnings.length ?? 0;
	add('warnings', 'count', a ? `${wa} warning${wa === 1 ? '' : 's'} on the baseline and ${wb} on the application, verbatim in Appendix A.5.` : `${wa} run warning${wa === 1 ? '' : 's'}, verbatim in Appendix A.5.`);
	const order = { red: 0, caution: 1, count: 2 } as const;
	return out.map((f, i) => ({ f, i })).sort((x, y) => order[x.f.level] - order[y.f.level] || x.i - y.i).map((x) => x.f);
}

function questions(checks: readonly EvidenceCheck[], rows: readonly EvidenceRow[], river: readonly EvidenceSite[], input: EvidenceInput): string[] {
	const out: string[] = [];
	for (const c of checks) if (!c.passed && c.fix) out.push(`${c.label}: ${c.fix}`);
	for (const r of rows) if (r.notAssessed) out.push(`${r.label}${r.subject ? ` at ${r.subject}` : ''}: ${r.notAssessed}`);
	const noRec = river.filter((s) => s.category === null).map((s) => s.name);
	if (noRec.length)
		out.push(`The recommended ecological category (REC) is not given at ${noRec.join(', ')}: expect the assessor to ask which Reserve determination applies (ER-D2); enter it on the rule table in Settings.`);
	if (!(input.baseline.inputs?.settings as { fitRecord?: unknown } | undefined)?.fitRecord)
		out.push('Validation is not assessed: an automatic calibration, applied, gives split-sample and dry → wet scores.');
	if (input.baseline.summary.wr2012 && input.baseline.summary.wr2012.flag.level !== 'ok') out.push('The WR2012 check is flagged: write the explanation the assessor will ask for.');
	return out;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function seriesRows(run: 'baseline' | 'application', r: EvidenceRunInput): EvidenceReport['appendix']['series'] {
	return Object.entries(r.inputs?.series ?? {})
		.filter(([, v]) => !!v)
		.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
		.map(([kind, v]) => ({ run, kind, startDate: v!.startDate, days: v!.length, sha256: v!.valuesSha256 ?? null }));
}

const dedupe = (list: Erratum[]): Erratum[] => [...new Map(list.map((e) => [e.id, e])).values()].sort((x, y) => Number(x.id.slice(3)) - Number(y.id.slice(3)));
const finite = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const day = (iso: string) => iso.slice(0, 10);
const short = (id: string) => id.slice(0, 8);
const modelName = (m: string) => (m === 'gr4j' ? 'GR4J' : m === 'legacy' ? 'legacy (b023 recession)' : m);
const fixed = (v: number, d: number) => v.toFixed(d);
const signed = (s: string) => (s.startsWith('-') ? `−${s.slice(1)}` : `+${s}`);
const pct0 = (f: number) => `${Math.round(f * 100)} %`;

/** A calendar month's name (for the page-1 "where the river loses most" line). */
export const evidenceMonthName = monthName;
