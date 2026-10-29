// The evidence pack's § 8, Future yield (issue #621 slice 4, report format
// evidence-23; docs/evidence-pack.md § Future yield, docs/model.md §2.17).
//
// Each case is one climate model × SSP × horizon's 24 monthly change factors
// (scenario/climate.ts climateDeltaFactors, frozen in a factor table). For
// each case the pack's baseline and application are run again with the
// `climate.delta` op applied to each, and the applicant's dam's firm yield and
// yield at 98 % assurance (§2.13, network/yield.ts), the applicant's assurance
// of supply and the paired change in EWR days are read off. The section shows
// the historical value (the same inputs, no op) and, per SSP and horizon, the
// median and the range across models: never one number.
//
// Pure: no I/O. The backend's `future_yield` job (280_future_yield) runs it
// once, case by case (runFutureYieldAsync over futureYieldSteps, so it checks
// for a cancel and reports progress between cases), and stores the result;
// the report freezes that result, factor table included, so reproduce:pack
// runs every pair again from the frozen factors (bundle.ts `climate:delta`,
// checkFutureYield) with nothing but the bundle.
import { ENGINE_VERSION } from '../version';
import type { ModelInput } from '../project';
import { runModel } from '../run';
import { firmYield, prepareYield } from '../network/yield';
import { applyScenario } from '../scenario/overrides';
import {
	CLIMATE_BASELINE_WINDOW,
	CLIMATE_DELTA_METHOD,
	CLIMATE_HORIZONS,
	CLIMATE_SSPS,
	climateDeltaFactors,
	climateFactorRowError,
	heldWindowClimate,
	type ClimateDeltaOp,
	type ClimateHorizon,
	type ClimateSsp,
	type ClimateYear
} from '../scenario/climate';
import { canonicalJson } from '../manifest';

/** The builder's version, frozen with its result: bumped whenever what a case measures, or how, changes. */
export const FUTURE_YIELD_VERSION = 'future-1';
/** The fewest climate models a range is read across before § 8 says it is too few (issue #621 acceptance: ≥ 5). */
export const FUTURE_MIN_MODELS = 5;
/** The assurance the second yield is read at (issue #621: yield at 98 %). */
export const FUTURE_YIELD_ASSURANCE = 0.98;
/** Most models a factor table carries (the register's ten, with room). */
export const FUTURE_MAX_MODELS = 20;

/** How an SSP is written in the section. */
export const SSP_LABEL: Record<ClimateSsp, string> = { ssp245: 'SSP2-4.5', ssp585: 'SSP5-8.5' };

export interface FutureWindow {
	from: number;
	to: number;
}

/**
 * One product of the copy the factors rest on (`cmip6/<model>/<scenario>`):
 * its manifest revision, how many of its files fall in the windows, the
 * SHA-256 of their list (each file's URL and values hash, sorted by URL, as
 * canonical JSON: `[{"url":…,"valuesSha256":…},…]`) and the files' versions
 * and `license` attributes, verbatim (null: a file with none). One digest a
 * product, not a row a file: ten models' windows are some 4,500 files.
 */
export interface FutureSourceFile {
	product: string;
	revision: number;
	files: number;
	filesSha256: string;
	versions: string[];
	licenses: (string | null)[];
}

/** One model × SSP × horizon: its 24 factors (calendar months, 0 = January) and the years of each window they rest on. */
export interface FutureFactorCase {
	model: string;
	ssp: ClimateSsp;
	horizon: ClimateHorizon;
	rainFactorByMonth: number[];
	evapFactorByMonth: number[];
	/** Years of the baseline and future windows the copy held; a whole window is to − from + 1. */
	years: { baseline: number; future: number };
	/** climateDeltaFactors's warnings: a clamped factor, a month with no baseline rain. */
	warnings: string[];
}

/** The factor table an evidence pack freezes: every case, the method and windows, and every source file's hash. */
export interface FutureFactorTable {
	method: typeof CLIMATE_DELTA_METHOD;
	windows: { baseline: FutureWindow; mid: FutureWindow; late: FutureWindow };
	cases: FutureFactorCase[];
	/** Every product behind the factors, sorted by name. */
	sources: FutureSourceFile[];
	/** The product's citation and licence, as the copy records them. */
	citation: string;
	licence: string;
}

/** What one run pair gives. */
export interface FutureMeasures {
	/** The applicant's dam's firm yield on the application (m³/a); null when the search failed. */
	firmYieldM3Year: number | null;
	/** Its yield at FUTURE_YIELD_ASSURANCE (m³/a). */
	yieldAtAssuranceM3Year: number | null;
	/** The applicant's annual assurance of supply on the application: water years met ÷ water years, pooled over their units; null without demand. */
	applicantAssurance: number | null;
	/** Days below the pragmatic EWR at the outlet, each run, and the application's change. */
	ewrDaysBaseline: number;
	ewrDaysApplication: number;
	ewrDaysChange: number;
}

export interface FutureCaseResult extends FutureMeasures {
	model: string;
	ssp: ClimateSsp;
	horizon: ClimateHorizon;
}

/** A measure across the models of one SSP and horizon. */
export interface FutureRange {
	/** Models with a value. */
	n: number;
	median: number | null;
	min: number | null;
	max: number | null;
}

export interface FutureGroup {
	ssp: ClimateSsp;
	horizon: ClimateHorizon;
	window: FutureWindow;
	models: string[];
	firmYieldM3Year: FutureRange;
	yieldAtAssuranceM3Year: FutureRange;
	applicantAssurance: FutureRange;
	ewrDaysChange: FutureRange;
}

export interface FutureYieldResult {
	version: typeof FUTURE_YIELD_VERSION;
	method: typeof CLIMATE_DELTA_METHOD;
	/** The engine that ran the pairs. */
	engineVersion: string;
	/** The applicant's dam, as the application input names it. */
	nodeId: string;
	nodeName: string;
	/** The applicant's units the assurance pools over (the application's ownedNodeIds). */
	ownedNodeIds: string[];
	/** The draft shape both yields search with. */
	pattern: 'constant';
	assurance: typeof FUTURE_YIELD_ASSURANCE;
	minModels: typeof FUTURE_MIN_MODELS;
	/** The models, sorted; fewer than minModels and the section says so. */
	models: string[];
	fewModels: boolean;
	factors: FutureFactorTable;
	historical: FutureMeasures;
	cases: FutureCaseResult[];
	groups: FutureGroup[];
	warnings: string[];
}

// ---------------------------------------------------------------------------
// The factor table
// ---------------------------------------------------------------------------

/** One model's catchment cells: each cell's centre latitude, its weight and its yearly monthly aggregates per scenario. */
export interface FutureModelCells {
	model: string;
	cells: { lat: number; weight: number; historical: readonly ClimateYear[]; ssp245: readonly ClimateYear[]; ssp585: readonly ClimateYear[] }[];
}

export const FUTURE_WINDOWS = { baseline: { ...CLIMATE_BASELINE_WINDOW }, mid: { ...CLIMATE_HORIZONS.mid }, late: { ...CLIMATE_HORIZONS.late } } as const;
const HORIZONS = Object.keys(CLIMATE_HORIZONS) as ClimateHorizon[];
const windowLength = (w: FutureWindow) => w.to - w.from + 1;

/**
 * The factor table of `models` over their catchment cells: per model, SSP and
 * horizon, climateDeltaFactors on each cell's window means (heldWindowClimate:
 * over the years of each window the copy holds, counted). Throws when a
 * model holds no year of a window: there is no factor to give.
 */
export function buildFutureFactorTable(models: readonly FutureModelCells[], meta: { sources: readonly FutureSourceFile[]; citation: string; licence: string }): FutureFactorTable {
	if (!models.length) throw new Error('no climate model to work the factors out from');
	if (models.length > FUTURE_MAX_MODELS) throw new Error(`at most ${FUTURE_MAX_MODELS} climate models`);
	const cases: FutureFactorCase[] = [];
	for (const m of [...models].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))) {
		for (const ssp of CLIMATE_SSPS) {
			for (const horizon of HORIZONS) {
				const w = FUTURE_WINDOWS[horizon];
				let by = 0;
				let fy = 0;
				const cells = m.cells.map((c) => {
					const base = heldWindowClimate(c.historical, FUTURE_WINDOWS.baseline.from, FUTURE_WINDOWS.baseline.to);
					const fut = heldWindowClimate(c[ssp], w.from, w.to);
					by = by ? Math.min(by, base.years) : base.years;
					fy = fy ? Math.min(fy, fut.years) : fut.years;
					return { lat: c.lat, weight: c.weight, baseline: base.climate, future: fut.climate };
				});
				const f = climateDeltaFactors(cells);
				cases.push({ model: m.model, ssp, horizon, rainFactorByMonth: f.rainFactorByMonth, evapFactorByMonth: f.evapFactorByMonth, years: { baseline: by, future: fy }, warnings: f.warnings });
			}
		}
	}
	return {
		method: CLIMATE_DELTA_METHOD,
		windows: { baseline: { ...FUTURE_WINDOWS.baseline }, mid: { ...FUTURE_WINDOWS.mid }, late: { ...FUTURE_WINDOWS.late } },
		cases,
		sources: [...meta.sources].sort((a, b) => (a.product < b.product ? -1 : a.product > b.product ? 1 : 0)).map((s) => ({ ...s, versions: [...s.versions], licenses: [...s.licenses] })),
		citation: meta.citation,
		licence: meta.licence
	};
}

/** Every case rests on whole windows (the method's): false for the copy's synthetic fixture, which holds a year or two of each. */
export function futureFactorsComplete(t: Pick<FutureFactorTable, 'windows' | 'cases'>): boolean {
	return t.cases.every((c) => c.years.baseline === windowLength(t.windows.baseline) && c.years.future === windowLength(t.windows[c.horizon]));
}

/** Why a factor table can't be used, or null. */
export function futureFactorTableError(t: unknown): string | null {
	const o = t as Partial<FutureFactorTable> | null;
	if (typeof o !== 'object' || o === null) return 'the factor table is missing';
	if (o.method !== CLIMATE_DELTA_METHOD) return `the factor table's method is ${String(o.method)}; this code reads ${CLIMATE_DELTA_METHOD}`;
	if (canonicalJson(o.windows) !== canonicalJson(FUTURE_WINDOWS)) return 'the factor table’s windows are not the method’s';
	if (!Array.isArray(o.cases) || !o.cases.length) return 'the factor table has no case';
	const seen = new Set<string>();
	for (const c of o.cases) {
		const key = `${c?.model} ${c?.ssp} ${c?.horizon}`;
		if (typeof c?.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(c.model)) return `a case's model ${String(c?.model)} is not a model name`;
		if (!(CLIMATE_SSPS as readonly string[]).includes(c.ssp)) return `${key}: not an SSP the method reads`;
		if (!HORIZONS.includes(c.horizon)) return `${key}: not a horizon the method reads`;
		if (seen.has(key)) return `${key} is listed twice`;
		seen.add(key);
		const e = climateFactorRowError(c.rainFactorByMonth) ?? climateFactorRowError(c.evapFactorByMonth);
		if (e) return `${key}: ${e}`;
		if (!c.years || !Number.isInteger(c.years.baseline) || !Number.isInteger(c.years.future) || c.years.baseline < 1 || c.years.future < 1) return `${key}: no count of the years its windows held`;
	}
	const models = new Set(o.cases.map((c) => c.model));
	if (models.size > FUTURE_MAX_MODELS) return `more than ${FUTURE_MAX_MODELS} models`;
	if (o.cases.length !== models.size * CLIMATE_SSPS.length * HORIZONS.length) return 'every model needs a case for each SSP and horizon';
	if (!Array.isArray(o.sources) || o.sources.some((s) => typeof s?.product !== 'string' || !Number.isInteger(s.files) || !/^[0-9a-f]{64}$/.test(String(s?.filesSha256))))
		return 'a source without its product, file count or a 64-hex hash of its files';
	return null;
}

// ---------------------------------------------------------------------------
// Running the pairs
// ---------------------------------------------------------------------------

/** The op a case applies (scenario/climate.ts): its factors, labelled by model, SSP and horizon. */
export function futureCaseOp(c: Pick<FutureFactorCase, 'model' | 'ssp' | 'horizon' | 'rainFactorByMonth' | 'evapFactorByMonth'>, t: Pick<FutureFactorTable, 'windows'>): ClimateDeltaOp {
	const w = t.windows[c.horizon];
	return {
		op: 'climate.delta',
		rainFactorByMonth: [...c.rainFactorByMonth],
		evapFactorByMonth: [...c.evapFactorByMonth],
		label: `${c.model} ${SSP_LABEL[c.ssp]} ${w.from}–${w.to}`,
		source: `NEX-GDDP-CMIP6 monthly change factors, method ${CLIMATE_DELTA_METHOD}, baseline ${t.windows.baseline.from}–${t.windows.baseline.to}`
	};
}

function withOp(input: ModelInput, op: ClimateDeltaOp, what: string): ModelInput {
	const r = applyScenario(input, [op]);
	if (r.problems.length) throw new Error(`the climate change factors don't apply to the ${what}: ${r.problems.join('; ')}`);
	return r.input;
}

/** The applicant's annual assurance of supply: water years met ÷ water years over their units, pooled; null without a year with demand. */
function applicantAssurance(out: ReturnType<typeof runModel>, owned: ReadonlySet<string>): number | null {
	let met = 0;
	let years = 0;
	for (const r of out.summary.supplyAssurance?.reliability ?? []) {
		if (!owned.has(r.nodeId)) continue;
		met += r.waterYearsMet;
		years += r.waterYears;
	}
	return years > 0 ? met / years : null;
}

function measures(baseline: ModelInput, application: ModelInput, nodeId: string, owned: ReadonlySet<string>, warnings: string[], what: string): FutureMeasures {
	const ob = runModel(structuredClone(baseline));
	const oa = runModel(structuredClone(application));
	const problem = prepareYield(structuredClone(application));
	const yieldOf = (assurance: number): number | null => {
		try {
			return firmYield(problem, nodeId, { assurance }).yieldM3Year;
		} catch (e) {
			warnings.push(`${what}: the yield at ${assurance * 100} % couldn't be found (${e instanceof Error ? e.message : String(e)})`);
			return null;
		}
	};
	const eb = ob.summary.catchment.ewrDaysNotMet;
	const ea = oa.summary.catchment.ewrDaysNotMet;
	return {
		firmYieldM3Year: yieldOf(1),
		yieldAtAssuranceM3Year: yieldOf(FUTURE_YIELD_ASSURANCE),
		applicantAssurance: applicantAssurance(oa, owned),
		ewrDaysBaseline: eb,
		ewrDaysApplication: ea,
		ewrDaysChange: ea - eb
	};
}

/** The median, smallest and largest of the values that are numbers. */
export function futureRange(values: readonly (number | null)[]): FutureRange {
	const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
	if (!v.length) return { n: 0, median: null, min: null, max: null };
	const mid = v.length >> 1;
	return { n: v.length, median: v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2, min: v[0]!, max: v.at(-1)! };
}

/** Each SSP and horizon's ranges across the models, in SSP then horizon order. */
export function futureGroups(cases: readonly FutureCaseResult[], t: Pick<FutureFactorTable, 'windows'>): FutureGroup[] {
	const out: FutureGroup[] = [];
	for (const ssp of CLIMATE_SSPS) {
		for (const horizon of HORIZONS) {
			const cs = cases.filter((c) => c.ssp === ssp && c.horizon === horizon);
			if (!cs.length) continue;
			out.push({
				ssp,
				horizon,
				window: { ...t.windows[horizon] },
				models: cs.map((c) => c.model).sort(),
				firmYieldM3Year: futureRange(cs.map((c) => c.firmYieldM3Year)),
				yieldAtAssuranceM3Year: futureRange(cs.map((c) => c.yieldAtAssuranceM3Year)),
				applicantAssurance: futureRange(cs.map((c) => c.applicantAssurance)),
				ewrDaysChange: futureRange(cs.map((c) => c.ewrDaysChange))
			});
		}
	}
	return out;
}

export interface RunFutureYieldArgs {
	baseline: ModelInput;
	application: ModelInput;
	/** The applicant's dam: a unit of the application with a dam above 0 m³. */
	nodeId: string;
	ownedNodeIds: readonly string[];
	factors: FutureFactorTable;
	/** Called after the historical pair and each case, with how many of all have run; false stops (throws 'cancelled'). */
	onCase?: (done: number, total: number) => boolean | void;
}

/** Why `nodeId` can't be § 8's dam in `application`, or null. */
export function futureDamError(application: ModelInput, nodeId: string): string | null {
	const n = application.model.nodes.find((x) => x.id === nodeId);
	if (!n) return 'that hydrological unit is not in the application';
	if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) return 'the future yield is of a dam: pick a unit of the application with a dam above 0 m³';
	return null;
}

/** How far § 8's runs are: `done` of `total` (the historical pair, then each case). */
export interface FutureYieldStep {
	done: number;
	total: number;
}

/**
 * § 8's runs one at a time: yields after the historical pair and after each
 * case, and returns the result. The one implementation: runFutureYield drives
 * it straight through, runFutureYieldAsync awaits its caller between cases (so
 * the backend's job can check for a cancel and report progress), and both
 * return the same result. Stopping is the caller's: it just stops calling
 * next(). The checks run on the first next().
 */
export function* futureYieldSteps(args: Omit<RunFutureYieldArgs, 'onCase'>): Generator<FutureYieldStep, FutureYieldResult, void> {
	const { baseline, application, nodeId, factors } = args;
	const tableError = futureFactorTableError(factors);
	if (tableError) throw new Error(tableError);
	const damError = futureDamError(application, nodeId);
	if (damError) throw new Error(damError);
	const owned = new Set(args.ownedNodeIds);
	const warnings: string[] = [];
	const total = factors.cases.length + 1;
	const historical = measures(baseline, application, nodeId, owned, warnings, 'the historical record');
	yield { done: 1, total };
	const cases: FutureCaseResult[] = [];
	for (const c of factors.cases) {
		const op = futureCaseOp(c, factors);
		cases.push({
			model: c.model,
			ssp: c.ssp,
			horizon: c.horizon,
			...measures(withOp(baseline, op, 'baseline'), withOp(application, op, 'application'), nodeId, owned, warnings, op.label)
		});
		yield { done: cases.length + 1, total };
	}
	const models = [...new Set(factors.cases.map((c) => c.model))].sort();
	return {
		version: FUTURE_YIELD_VERSION,
		method: CLIMATE_DELTA_METHOD,
		engineVersion: ENGINE_VERSION,
		nodeId,
		nodeName: application.model.nodes.find((n) => n.id === nodeId)!.name,
		ownedNodeIds: [...args.ownedNodeIds].sort(),
		pattern: 'constant',
		assurance: FUTURE_YIELD_ASSURANCE,
		minModels: FUTURE_MIN_MODELS,
		models,
		fewModels: models.length < FUTURE_MIN_MODELS,
		factors: structuredClone(factors),
		historical,
		cases,
		groups: futureGroups(cases, factors),
		warnings
	};
}

/** § 8's result: the historical pair, then every case's, and the ranges (see the file's head). */
export function runFutureYield(args: RunFutureYieldArgs): FutureYieldResult {
	const steps = futureYieldSteps(args);
	for (let s = steps.next(); ; s = steps.next()) {
		if (s.done) return s.value;
		if (args.onCase?.(s.value.done, s.value.total) === false) throw new Error('cancelled');
	}
}

/**
 * runFutureYield, awaiting `onCase` after the historical pair and each case
 * before the next one starts: false stops it there (throws 'cancelled'), so
 * no further case runs. The same result as runFutureYield.
 */
export async function runFutureYieldAsync(
	args: Omit<RunFutureYieldArgs, 'onCase'> & { onCase: (done: number, total: number) => Promise<boolean | void> | boolean | void }
): Promise<FutureYieldResult> {
	const steps = futureYieldSteps(args);
	for (let s = steps.next(); ; s = steps.next()) {
		if (s.done) return s.value;
		if ((await args.onCase(s.value.done, s.value.total)) === false) throw new Error('cancelled');
	}
}

/**
 * reproduce:pack's `climate:delta`: every pair run again from the frozen
 * factors on the bundle's own inputs, and compared with the stored result
 * whole (canonical JSON, as the manifest stores it). The problems, or [].
 * Another builder version or engine is named, not compared blind.
 */
export function checkFutureYield(stored: FutureYieldResult, inputs: { baseline: ModelInput; application: ModelInput }, builtBy: string): string[] {
	if (stored.version !== FUTURE_YIELD_VERSION) return [`§ 8 was built with ${String(stored.version)}; this code builds ${FUTURE_YIELD_VERSION}: check out the engine that built the report (${builtBy})`];
	const e = futureFactorTableError(stored.factors);
	if (e) return [e];
	let fresh: FutureYieldResult;
	try {
		fresh = runFutureYield({ ...inputs, nodeId: stored.nodeId, ownedNodeIds: stored.ownedNodeIds, factors: stored.factors });
	} catch (err) {
		return [`the pairs can't be run again: ${err instanceof Error ? err.message : String(err)}`];
	}
	const asStored = (v: unknown) => canonicalJson(JSON.parse(JSON.stringify(v)));
	const problems: string[] = [];
	if (asStored(fresh.historical) !== asStored(stored.historical)) problems.push('the historical pair gives other values');
	const differ = fresh.cases.filter((c, i) => asStored(c) !== asStored(stored.cases[i]));
	if (fresh.cases.length !== stored.cases.length) problems.push(`it has ${fresh.cases.length} cases, the manifest ${stored.cases.length}`);
	else if (differ.length) problems.push(`${differ.length} of ${fresh.cases.length} cases give other values (${differ.slice(0, 3).map((c) => `${c.model} ${SSP_LABEL[c.ssp]} ${c.horizon}`).join(', ')}${differ.length > 3 ? ', …' : ''})`);
	if (asStored(fresh.groups) !== asStored(stored.groups)) problems.push('the ranges across models differ');
	if (problems.length && stored.engineVersion !== ENGINE_VERSION) problems.push(`the pairs were run with engine ${stored.engineVersion}; this is ${ENGINE_VERSION}: check out that engine (README.md)`);
	return problems;
}

// ---------------------------------------------------------------------------
// The caveat
// ---------------------------------------------------------------------------

/**
 * The words § 8 opens with. `ours` is ours; `nasa` is NASA's own caveat on
 * engineering use of NEX-GDDP-CMIP6, to be quoted **verbatim** from the
 * product's current technical note with its URL and the date it was read.
 * The note the research cited (NEX-GDDP-CMIP6-Tech_Note_4.pdf) returned 404
 * when slice 4 was built (2026-10-29), so `text` is null: the section prints
 * a marked placeholder, and the `futureYield` check stops a pack with § 8
 * being issued until it is filled (report.ts, evidence-pack.md § Future
 * yield). Fill text, url and readOn together, and never paraphrase.
 */
export const FUTURE_YIELD_CAVEAT = {
	ours: [
		'These are projections, not predictions. Each case says what this record would give had its rain and evaporation been changed, month by month, by one climate model’s change between 1985–2014 and a future window under one emissions pathway. No case is more likely than another, and the range across models is not a confidence interval.',
		'The projections are NASA’s NEX-GDDP-CMIP6, downscaled by bias correction and spatial disaggregation (BCSD) against an observed climatology (GMFD). BCSD corrects each model’s statistics at the coarse scale and spreads them over a 0.25° grid; it does not correct a model’s errors in the change itself, in the timing and sequence of weather, or in rain over steep terrain at scales finer than the grid.',
		'Delta change keeps the historical sequence: droughts last as long, and come in the same order, as in the record; only the monthly amounts change. The runoff model keeps its historical parameters, and evaporation changes by the ratio of a temperature-only (Hargreaves–Samani) estimate.'
	],
	nasa: {
		/** NASA's words, verbatim. null until quoted: the section can't be issued without them. */
		text: null as string | null,
		/** Where they are quoted from. */
		source: 'NEX-GDDP-CMIP6 Technical Note, NASA Center for Climate Simulation',
		url: null as string | null,
		/** When the quoted note was read (YYYY-MM-DD). */
		readOn: null as string | null,
		/** Printed where the words go while `text` is null. */
		placeholder:
			'[Placeholder: NASA’s caveat on engineering use of NEX-GDDP-CMIP6 is to be quoted here verbatim from the product’s current technical note, with its address and the date it was read. The note this section was designed against (NEX-GDDP-CMIP6-Tech_Note_4.pdf) could not be found on 2026-10-29. A pack with this section can’t be issued until the caveat is filled.]'
	}
} as const satisfies { ours: readonly string[]; nasa: { text: string | null; source: string; url: string | null; readOn: string | null; placeholder: string } };

export type FutureYieldCaveat = {
	ours: readonly string[];
	nasa: { text: string | null; source: string; url: string | null; readOn: string | null; placeholder: string };
};

/** The caveat still waits for NASA's words (or their source or date). */
export const futureCaveatPending = (c: FutureYieldCaveat = FUTURE_YIELD_CAVEAT): boolean => !c.nasa.text?.trim() || !c.nasa.url || !c.nasa.readOn;
