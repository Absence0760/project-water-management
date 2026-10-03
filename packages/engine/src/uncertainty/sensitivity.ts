// Sensitivity runs and EWR compliance as a range (calibration research CR-21,
// docs/model.md §2.10g). One factor at a time: the run at the project's own
// settings (the central run), then each factor at its low and at its high
// with everything else as the project has it:
//
// - rain × 0.9 / × 1.1 (every rain series: station, CHIRPS, forecast);
// - the pan coefficient × 0.85 / × 1.15 (GR4J's PE, under `pe.kind: 'pan'`);
// - the dam lake-evaporation factor × 0.85 / × 1.15 (A-pan → open water, audit N2);
// - abstraction × 0.7 / × 1.3 (every unit's and other water user's demand);
// - initial dam storage empty / full.
//
// Each change is a scenario op (../scenario, applyScenario), so it is checked
// and applied exactly as a scenario would apply it. The runoff parameters are
// held at the project's: a rain or PE multiplier is a sensitivity factor on the
// forcing, never a free parameter refitted with it (Renard et al. 2010). The
// result gives, per EWR site, the central value, each factor's low and high,
// the envelope over all of them and a verdict against a decision threshold:
// an envelope that crosses it is "not determinable with current data".
//
// Pure and deterministic (no sampling): the same input and options give the
// same result. Nothing here is stored; it is a live diagnostic.
import type { ModelInput, ModelOutput } from '../project';
import { prepareRun } from '../prepare';
import { runModelWithoutChecks } from '../run';
import { applyScenario } from '../scenario/overrides';
import type { ScenarioOp, ScalableSeriesKind } from '../scenario/ops';
import { ENGINE_VERSION } from '../version';
import {
	SENSITIVITY_FACTOR_LABELS,
	SENSITIVITY_FACTORS,
	SENSITIVITY_METRIC_LABELS,
	SENSITIVITY_RANGES,
	SENSITIVITY_THRESHOLDS,
	siteVerdict,
	type FactorRange,
	type FactorResult,
	type ScaledFactor,
	type SensitivityCase,
	type SensitivityFactor,
	type SensitivityMetric,
	type SensitivityOptions,
	type SensitivityResult,
	type SensitivitySite,
	type SiteValues
} from './sensitivityVerdict';

const r6 = (v: number): number => (Number.isFinite(v) && v !== 0 ? Number(v.toPrecision(6)) : v === 0 ? 0 : v);
// Every rain series, a rain-source period's series and the reanalysis included (§2.10g: "so the whole
// forcing moves"); a fitted period factor or reanalysis fallback re-fits to the same ratio under one factor.
const RAIN_KINDS: ScalableSeriesKind[] = ['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm', 'rain_catchment_alt_mm', 'rain_reanalysis_mm'];
const fmtFactor = (f: number) => `× ${Number(f.toPrecision(4))}`;

/** The EWR sites of a run and their values, from its summary (the curtailment table's sites, the Reserve rates). */
export function siteValues(out: ModelOutput): { sites: SensitivitySite[]; values: SiteValues[]; reportStart: string; reportEnd: string; days: number } {
	const c = out.summary.curtailment;
	if (!c?.ewrSites?.length) throw new Error('the run reports no EWR site (it has no curtailment summary)');
	const rates = new Map<string, number | null>();
	for (const s of out.summary.ewrAssurance ?? []) rates.set(s.nodeId ?? 'outlet', s.overall.rate);
	const sites: SensitivitySite[] = [];
	const values: SiteValues[] = [];
	for (const s of c.ewrSites) {
		const key = s.isOutlet ? 'outlet' : s.nodeId;
		const rate = rates.get(key);
		sites.push({ key, name: s.name, isOutlet: s.isOutlet, hasRuleTable: rate !== undefined && rate !== null });
		values.push({
			daysNotMet: s.daysNotMet,
			daysMet: c.days > 0 ? r6(1 - s.daysNotMet / c.days) : 0,
			shortfallMm3: r6(Math.max(0, (-s.shortfallM3Day * c.days) / 1e6)),
			reserveRate: rate === undefined || rate === null ? null : r6(rate)
		});
	}
	return { sites, values, reportStart: c.reportStart, reportEnd: c.reportEnd, days: c.days };
}


function checkRange(f: ScaledFactor, r: FactorRange): FactorRange {
	const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 2;
	if (!ok(r.low) || !ok(r.high)) throw new Error(`${SENSITIVITY_FACTOR_LABELS[f]}: each multiplier must be above 0 and at most 2`);
	if (r.low === r.high) throw new Error(`${SENSITIVITY_FACTOR_LABELS[f]}: the low and high multipliers must differ`);
	return { low: r.low, high: r.high };
}

interface Plan {
	factor: SensitivityFactor;
	low: { setting: number; label: string; ops: ScenarioOp[] };
	high: { setting: number; label: string; ops: ScenarioOp[] };
	notes: string[];
}

/**
 * The ops of each factor that applies to the project, and why the others
 * don't. `central` is the central run (abstraction needs its demand).
 */
export function sensitivityPlan(
	input: ModelInput,
	central: ModelOutput,
	ranges: Record<ScaledFactor, FactorRange>
): { plans: Plan[]; skipped: { factor: SensitivityFactor; reason: string }[] } {
	const run = prepareRun(input);
	const s = run.settings;
	const nodes = input.model.nodes;
	const plans: Plan[] = [];
	const skipped: { factor: SensitivityFactor; reason: string }[] = [];
	const scaled = (f: ScaledFactor, make: (k: number) => ScenarioOp[], notes: string[]): Plan => ({
		factor: f,
		low: { setting: ranges[f].low, label: fmtFactor(ranges[f].low), ops: make(ranges[f].low) },
		high: { setting: ranges[f].high, label: fmtFactor(ranges[f].high), ops: make(ranges[f].high) },
		notes
	});

	// Rain: every rain series the project has, the same factor, so CHIRPS's bias-correction factors are unchanged.
	const rainKinds = RAIN_KINDS.filter((k) => input.series?.[k]?.values.some((v) => typeof v === 'number' && v > 0));
	if (rainKinds.length) {
		plans.push(scaled('rain', (k) => rainKinds.map((kind) => ({ op: 'series.scale', kind, factor: k }) as ScenarioOp), [`${rainKinds.length} rain series scaled`]));
	} else skipped.push({ factor: 'rain', reason: 'the project has no rain' });

	// Pan coefficient: GR4J's PE under pe.kind 'pan' only.
	if (s.pe.kind === 'monthly') {
		skipped.push({ factor: 'pan', reason: 'GR4J’s potential evaporation comes from the monthly PE row (Settings), which does not use the pan coefficient' });
	} else if (!s.panCoefficient.some((v) => v > 0)) {
		skipped.push({ factor: 'pan', reason: 'the pan coefficient is 0 in every month' });
	} else {
		const row = [...s.panCoefficient];
		plans.push(scaled('pan', (k) => [{ op: 'settings.set', path: 'panCoefficient', value: row.map((v) => Math.min(2, v * k)) }], []));
	}

	// Dam lake-evaporation factor: only with a dam, and only when dam evaporation is on.
	const dams = nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
	const monthlyLake = s.lakeEvapFactorMonthly ? [...s.lakeEvapFactorMonthly] : null;
	if (!dams.length) skipped.push({ factor: 'lakeEvap', reason: 'the model has no dam' });
	else if (!(monthlyLake ? monthlyLake.some((v) => v > 0) : s.lakeEvapFactor > 0)) skipped.push({ factor: 'lakeEvap', reason: 'dam evaporation is off (factor 0)' });
	else {
		plans.push(
			scaled(
				'lakeEvap',
				(k) =>
					monthlyLake
						? [{ op: 'settings.set', path: 'lakeEvapFactorMonthly', value: monthlyLake.map((v) => Math.min(2, v * k)) }]
						: [{ op: 'settings.set', path: 'lakeEvapFactor', value: Math.min(2, s.lakeEvapFactor * k) }],
				[monthlyLake ? 'the monthly factors scaled' : `factor ${s.lakeEvapFactor}`]
			)
		);
	}

	// Abstraction: every unit's demand (crops and demand objects) and every other water user's.
	const c = central.summary.curtailment;
	const farmDemand = (c?.totals.demandM3Day ?? 0) > 0;
	const userDemand = (c?.otherUsers ?? []).some((u) => u.demandM3Day > 0);
	if (!farmDemand && !userDemand) skipped.push({ factor: 'abstraction', reason: 'no unit or other water user has any demand over the reporting window' });
	else {
		const cats = [...(farmDemand ? (['farm'] as const) : []), ...(userDemand ? (['user'] as const) : [])];
		plans.push(
			scaled(
				'abstraction',
				(k) => cats.map((category) => ({ op: 'demand.scale', factor: k, category }) as ScenarioOp),
				[cats.map((c) => (c === 'farm' ? 'units’ demand' : 'other water users’ demand')).join(' and ')]
			)
		);
	}

	// Initial dam storage: every dam empty, then every dam full.
	if (!dams.length) skipped.push({ factor: 'damStorage', reason: 'the model has no dam' });
	else {
		const set = (v: number): ScenarioOp[] => dams.map((n) => ({ op: 'node.set', nodeId: n.id, field: 'damInitialPct', value: v }) as ScenarioOp);
		plans.push({
			factor: 'damStorage',
			low: { setting: 0, label: 'empty', ops: set(0) },
			high: { setting: 1, label: 'full', ops: set(1) },
			notes: [`${dams.length} dam${dams.length === 1 ? '' : 's'}`]
		});
	}
	return { plans, skipped };
}

/**
 * Run the sensitivity cases: the central run, then each applicable factor's
 * low and high (at most 11 model runs). Throws when a factor's op can't be
 * applied (it would be a bug in the plan, not a project state).
 */
export function sensitivityRuns(input: ModelInput, opts: SensitivityOptions = {}): SensitivityResult {
	const ranges = Object.fromEntries(
		(Object.keys(SENSITIVITY_RANGES) as ScaledFactor[]).map((f) => [f, checkRange(f, { ...SENSITIVITY_RANGES[f], ...(opts.ranges?.[f] ?? {}) })])
	) as Record<ScaledFactor, FactorRange>;
	const thresholds = { ...SENSITIVITY_THRESHOLDS, ...(opts.thresholds ?? {}) };
	for (const [m, v] of Object.entries(thresholds)) {
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`the ${SENSITIVITY_METRIC_LABELS[m as SensitivityMetric]} threshold must be from 0 to 1`);
	}
	const centralOut = runModelWithoutChecks(input);
	const base = siteValues(centralOut);
	const { plans, skipped: notApplicable } = sensitivityPlan(input, centralOut, ranges);
	const skip = new Set(opts.skip ?? []);
	const chosen = plans.filter((p) => !skip.has(p.factor));
	const skipped = [
		...notApplicable,
		...plans.filter((p) => skip.has(p.factor)).map((p) => ({ factor: p.factor, reason: 'left out by request' }))
	]
		.sort((a, b) => SENSITIVITY_FACTORS.indexOf(a.factor) - SENSITIVITY_FACTORS.indexOf(b.factor))
		.map((x) => ({ ...x, label: SENSITIVITY_FACTOR_LABELS[x.factor] }));
	const total = 1 + chosen.length * 2;
	let done = 1;
	opts.onProgress?.({ done, total });

	const runCase = (factor: SensitivityFactor, c: Plan['low']): SensitivityCase => {
		const applied = applyScenario(input, c.ops);
		if (applied.problems.length) throw new Error(`${SENSITIVITY_FACTOR_LABELS[factor]} ${c.label}: ${applied.problems.join('; ')}`);
		const v = siteValues(runModelWithoutChecks(applied.input));
		done++;
		opts.onProgress?.({ done, total });
		return { setting: c.setting, label: c.label, values: v.values };
	};
	const factors: FactorResult[] = chosen.map((p) => ({
		factor: p.factor,
		label: SENSITIVITY_FACTOR_LABELS[p.factor],
		low: runCase(p.factor, p.low),
		high: runCase(p.factor, p.high),
		notes: p.notes
	}));

	const verdicts = base.sites.map((site, i) =>
		siteVerdict(site, [base.values[i]!, ...factors.flatMap((f) => [f.low.values[i]!, f.high.values[i]!])], base.values[i]!, thresholds)
	);
	return {
		engineVersion: ENGINE_VERSION,
		reportStart: base.reportStart,
		reportEnd: base.reportEnd,
		days: base.days,
		sites: base.sites,
		central: base.values,
		factors,
		skipped,
		ranges,
		thresholds,
		verdicts
	};
}
