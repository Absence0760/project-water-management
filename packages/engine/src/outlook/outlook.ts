// The seasonal outlook (issue #53 R5, docs/design/planning-outputs.md §3.5,
// docs/model.md §2.15): an ESP (historical-analogue) ensemble from the
// model's state on a decision date, at a few demand levels.
//
// For each analogue water year and each demand level, one member: the base
// run's state at the start of the decision date, then the season driven by
// that analogue year's rain and evaporation (the analogue's rain in
// `rain_forecast_mm`, as forecast mode's tail, ../forecast.ts), with the
// level's demand.scale ops applied from the decision date on. The history
// runs once: the base input is run to the decision date and its state
// captured (../warmstart, model.md §2.16), and each member runs only the
// season from that snapshot (outlookSeasonInput + runModelFrom). The
// snapshot pins the record-wide statistics (the land-cover low-flow
// threshold, the Reserve's natural duration curves, the CHIRPS and
// rain-source factors) from the base run, so a member's history is the
// base run's to the bit and the analogue never refits it.
//
// The older path (`warmStart: false`, outlookMemberInput + a full run per
// member) re-runs the history in every member and refits those statistics
// on each member's own history, up to the decision date (engine ≥ 1.28.0:
// the analogue season is the run's forecast tail, which no record-wide
// statistic reads; before, they took in the season too); it is kept for
// comparison, and the backend reads its input problems.
//
// Per demand level, across the analogue years: season-end dam storage, the
// share of demand met, and the river's requirement (Reserve months met with
// a rule table, else the share of days below the pragmatic EWR: the same
// choice as the outcome matrix, ../views/outcomeMatrix.ts), each as the
// median and 10th–90th percentiles, with every year's values. The planning
// figure is the highest demand level that met the requirement in at least a
// set share of the years, reported as data ("in 17 of 21 analogue years"),
// never as advice.
//
// Not part of runModel: a derived view. The one engine change it needs is
// settings.demandFactorFrom (engine 0.44.0), so a level's demand factors
// start on the decision date. Pure: no I/O. Deterministic.
import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import { damCapacityOn } from '../network/development';
import type { DailySeries, ModelInput, ModelOutput, SeriesKind } from '../project';
import { captureModelState, runModelCapturing, runModelFrom, runModelWithoutChecks } from '../run';
import type { ModelStateSnapshot } from '../warmstart/snapshot';
import type { ScenarioOp } from '../scenario/ops';
import { applyScenario } from '../scenario/overrides';
import { quantileSorted } from '../uncertainty/bands';
import type { OutcomeMetric } from '../views/outcomeMatrix';
import { outlookAnalogue, resolveSeason, seasonWaterYear, type OutlookAnalogue, type OutlookSeason, type ResolvedSeason } from './season';

/** A demand level: an id, a label ("85 %") and its ops (demand.scale only, e.g. one at factor 0.85, or R1's `months` form for a monthly plan). */
export interface OutlookLevel {
	id: string;
	label: string;
	ops: readonly ScenarioOp[];
}

/**
 * The share of analogue years a demand level must meet the river's
 * requirement in to be the planning figure. Confirmed by the client (O6,
 * issue #90; plan.md § Decision-support outputs; design §3.5, after Kaune et
 * al. 2020's finding that a cautious percentile with a review beats an
 * optimistic one); a project may set its own (settings.outlook.planningShare).
 */
export const DEFAULT_PLANNING_SHARE = 0.8;

/**
 * Fewest analogue years for percentiles and a planning figure (judgement,
 * pending the hydrologist): with fewer, the 10th and 90th percentiles are
 * set by one or two years. Every year's values are still returned.
 */
export const OUTLOOK_MIN_YEARS = 10;
/** The percentiles every outlook statistic reports (linear, type 7, as the uncertainty bands). */
export const OUTLOOK_PERCENTILES = [10, 50, 90] as const;

/** Why a water year isn't an analogue. */
export type OutlookExclusionReason =
	/** Its stretch isn't all inside the base run. */
	| 'outsideRecord'
	/** A day of its stretch has no rain from any source in the base run. */
	| 'missingRain'
	/** It is the season itself (left out by default; list it to include it, e.g. a hindcast check). */
	| 'theSeason'
	/** Listed twice. */
	| 'duplicate'
	/** Not a whole number. */
	| 'notAYear';

export interface OutlookExcluded {
	waterYear: number;
	reason: OutlookExclusionReason;
}

/** What a base run must carry: its window and series (rain_final, farm dam storage). */
export type OutlookBaseRun = Pick<ModelOutput, 'startDate' | 'days' | 'series'>;

const seriesOf = (run: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string) => run.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;

/** The run's final catchment rain, or throws. */
function finalRain(run: OutlookBaseRun): number[] {
	const r = seriesOf(run, null, 'rain_final');
	if (!r) throw new Error('the base run has no rain_final series (no rainfall): an outlook needs historical rain');
	return r;
}

/**
 * The analogue years for a season. `years` absent: every water year whose
 * stretch (season.ts) lies inside the base run with rain on every day,
 * except the season's own. `years` given: those, in the order given, the
 * season's own allowed. Each one left out is listed with its reason.
 */
export function outlookAnalogues(baseRun: OutlookBaseRun, season: OutlookSeason, years?: readonly number[]): { analogues: OutlookAnalogue[]; excluded: OutlookExcluded[] } {
	const s = resolveSeason(season);
	const rain = finalRain(baseRun);
	const r0 = toEpochDay(baseRun.startDate);
	const r1 = r0 + baseRun.days - 1;
	const own = seasonWaterYear(season);
	const analogues: OutlookAnalogue[] = [];
	const excluded: OutlookExcluded[] = [];
	const check = (wy: number): OutlookExclusionReason | null => {
		const a = outlookAnalogue(s, wy);
		const from = toEpochDay(a.from);
		const to = toEpochDay(a.to);
		if (from < r0 || to > r1) return 'outsideRecord';
		for (let d = from; d <= to; d++) if (!Number.isFinite(rain[d - r0]!)) return 'missingRain';
		return null;
	};
	if (years === undefined) {
		for (let wy = waterYearOf(r0) - 1; wy <= waterYearOf(r1); wy++) {
			const a = outlookAnalogue(s, wy);
			// A stretch wholly outside the record isn't a candidate at all.
			if (toEpochDay(a.to) < r0 || toEpochDay(a.from) > r1) continue;
			const why = check(wy);
			if (why === null && wy !== own) analogues.push(a);
			else excluded.push({ waterYear: wy, reason: why ?? 'theSeason' });
		}
	} else {
		const seen = new Set<number>();
		for (const wy of years) {
			if (!Number.isInteger(wy)) {
				excluded.push({ waterYear: wy, reason: 'notAYear' });
				continue;
			}
			if (seen.has(wy)) {
				excluded.push({ waterYear: wy, reason: 'duplicate' });
				continue;
			}
			seen.add(wy);
			const why = check(wy);
			if (why === null) analogues.push(outlookAnalogue(s, wy));
			else excluded.push({ waterYear: wy, reason: why });
		}
	}
	return { analogues, excluded };
}

/** `s` without its values from epoch day `cut` on; undefined when nothing is left. */
function cutAt(s: DailySeries, cut: number): DailySeries | undefined {
	const keep = Math.min(s.values.length, cut - toEpochDay(s.startDate));
	if (keep <= 0) return undefined;
	return keep === s.values.length ? s : { ...s, values: s.values.slice(0, keep) };
}

/** `s`'s history up to the day before `from`, then `tail` from `from` on (null padding between). */
function historyThen(s: DailySeries | undefined, from: number, tail: (number | null)[]): DailySeries {
	const h = s ? cutAt(s, from) : undefined;
	if (!h) return { startDate: fromEpochDay(from), values: tail };
	const pad = from - (toEpochDay(h.startDate) + h.values.length);
	return { startDate: h.startDate, values: [...h.values, ...new Array<null>(pad).fill(null), ...tail] };
}

/** The values of `s` on epoch days a … a + n − 1 (null where it has none). */
function valuesOn(s: DailySeries | undefined, a: number, n: number): (number | null)[] {
	const out = new Array<number | null>(n).fill(null);
	if (!s) return out;
	const off = a - toEpochDay(s.startDate);
	for (let i = 0; i < n; i++) {
		const v = s.values[off + i];
		if (off + i >= 0 && typeof v === 'number' && Number.isFinite(v)) out[i] = v;
	}
	return out;
}

/**
 * Check a level's ops: demand.scale only, since any other op would change
 * the history too, and so the state the season starts from. Returns the
 * problems (empty when every op is a demand.scale).
 */
export function outlookLevelProblems(level: OutlookLevel): string[] {
	return level.ops.flatMap((op, i) =>
		op?.op === 'demand.scale' ? [] : [`op ${i + 1} (${typeof op?.op === 'string' ? op.op : 'unknown'}): only demand.scale ops make a demand level; any other op would change the history the season starts from`]
	);
}

/**
 * One member's input: `input`'s record cut at the decision date (every
 * series ends the day before it), the analogue's rain (the base run's
 * rain_final on the analogue's days, which is already gap-filled and
 * bias-corrected) as the forecast rain of the season, its daily A-pan when
 * the project has one, the run window pinned to the base run's start and the
 * season end, rain-source periods clipped to the history, and the level's
 * ops applied with their demand factors from the decision date on
 * (settings.demandFactorFrom). With `start.storageM3` (the review triggers,
 * ./triggers.ts) the farm dams listed start the decision date holding those
 * volumes instead of the history's (settings.damStorageReset, engine
 * 0.46.0); every other part of the state is still the history's. Throws
 * when the base input already carries a demand factor (a scenario run: its
 * factor would be dropped from the history) or a storage reset, or the base
 * run doesn't hold the day before the decision date.
 */
export function outlookMemberInput(
	input: ModelInput,
	baseRun: OutlookBaseRun,
	season: OutlookSeason,
	analogue: OutlookAnalogue,
	ops: readonly ScenarioOp[] = [],
	start: { storageM3?: Readonly<Record<string, number>> } = {}
): { input: ModelInput; problems: string[] } {
	const { s, a, seasonRain } = memberSeason(input, baseRun, season, analogue);

	const series: ModelInput['series'] = {};
	for (const [k, v] of Object.entries(input.series) as [SeriesKind, DailySeries | undefined][]) {
		if (!v) continue;
		const c = cutAt(v, s.from);
		if (c) series[k] = c;
	}
	series.rain_forecast_mm = historyThen(input.series.rain_forecast_mm, s.from, seasonRain);
	if (input.series.evap_apan_mm) series.evap_apan_mm = historyThen(input.series.evap_apan_mm, s.from, valuesOn(input.series.evap_apan_mm, a, s.days));

	return withLevel({ settings: memberSettings(input, s, baseRun.startDate, start), model: input.model, series }, ops);
}

/**
 * One member's season alone, for a run from a snapshot of the base input at
 * the decision date (runModelFrom(captureModelState(input, decisionDate),
 * …), engine ≥ 1.1.0): outlookMemberInput's member without the history. Its
 * only series are the season's: the analogue's rain as the forecast rain and
 * its daily A-pan when the project has one, both from the decision date; the
 * window is the season; the settings, the ops (demand factors from the
 * decision date) and the storage `start` are outlookMemberInput's, so a
 * member run from the snapshot is that member's season with the history's
 * state and statistics pinned from the base run. Throws as
 * outlookMemberInput does.
 */
export function outlookSeasonInput(
	input: ModelInput,
	baseRun: OutlookBaseRun,
	season: OutlookSeason,
	analogue: OutlookAnalogue,
	ops: readonly ScenarioOp[] = [],
	start: { storageM3?: Readonly<Record<string, number>> } = {}
): { input: ModelInput; problems: string[] } {
	const { s, a, seasonRain } = memberSeason(input, baseRun, season, analogue);
	const series: ModelInput['series'] = { rain_forecast_mm: { startDate: s.decisionDate, values: seasonRain } };
	if (input.series.evap_apan_mm) series.evap_apan_mm = { startDate: s.decisionDate, values: valuesOn(input.series.evap_apan_mm, a, s.days) };
	return withLevel({ settings: memberSettings(input, s, s.decisionDate, start), model: input.model, series }, ops);
}

/** Check a member's base, season and analogue (outlookMemberInput's throws), and take the analogue's rain from the base run. */
function memberSeason(input: ModelInput, baseRun: OutlookBaseRun, season: OutlookSeason, analogue: OutlookAnalogue): { s: ResolvedSeason; a: number; seasonRain: (number | null)[] } {
	const s = resolveSeason(season);
	const r0 = toEpochDay(baseRun.startDate);
	const r1 = r0 + baseRun.days - 1;
	if (s.from <= r0) throw new RangeError(`the decision date ${s.decisionDate} is not after the base run's first day (${baseRun.startDate}): there is no history to start from`);
	if (s.from - 1 > r1) throw new RangeError(`the base run ends on ${fromEpochDay(r1)}, before ${fromEpochDay(s.from - 1)}, the day before the decision date: the state there isn't known`);
	// A part's factor too (engine ≥ 1.45.0, demand.scale with a part).
	if (input.model.nodes.some((n) => n.demandFactor != null || n.partDemandFactor != null)) throw new Error('the base input carries a demand factor (a scenario run): run the outlook on an ordinary run');
	if (input.settings.damStorageReset != null) throw new Error('the base input carries a dam storage reset: run the outlook on an ordinary run');
	const a = toEpochDay(analogue.from);
	if (toEpochDay(analogue.to) - a + 1 !== s.days) throw new RangeError(`analogue ${analogue.label} is not as long as the season`);
	const rain = finalRain(baseRun);
	const seasonRain: (number | null)[] = new Array(s.days);
	for (let i = 0; i < s.days; i++) {
		const v = rain[a + i - r0];
		seasonRain[i] = typeof v === 'number' && Number.isFinite(v) ? v : null;
	}
	return { s, a, seasonRain };
}

/** A member's settings: the window from `from` to the season end, demand factors from the decision date, the storage reset, and rain-source periods clipped to the history. */
function memberSettings(input: ModelInput, s: ResolvedSeason, from: string, start: { storageM3?: Readonly<Record<string, number>> }): ModelInput['settings'] {
	const settings: ModelInput['settings'] = {
		...input.settings,
		simulationStart: from,
		simulationEnd: s.seasonEnd,
		demandFactorFrom: s.decisionDate,
		...(start.storageM3 ? { damStorageReset: { date: s.decisionDate, storageM3: { ...start.storageM3 } } } : {})
	};
	if (Array.isArray(input.settings.rainSource)) {
		const last = fromEpochDay(s.from - 1);
		settings.rainSource = input.settings.rainSource.flatMap((p) => {
			if (!p || typeof p !== 'object' || typeof p.start !== 'string' || typeof p.end !== 'string') return [p];
			if (p.start > last) return [];
			return [p.end > last ? { ...p, end: last } : p];
		});
	}
	return settings;
}

/** The member with a level's ops applied. */
function withLevel(member: ModelInput, ops: readonly ScenarioOp[]): { input: ModelInput; problems: string[] } {
	if (!ops.length) return { input: member, problems: [] };
	const r = applyScenario(member, ops);
	return { input: r.input, problems: r.problems };
}

/** One member's season, as measured (before the metric is chosen). Volumes m³ over the season. */
export interface OutlookMember {
	waterYear: number;
	label: string;
	/** The analogue's stretch of the record. */
	analogueFrom: string;
	analogueTo: string;
	/** Σ dam storage on the season's last day, over every farm with a dam; null without one. */
	seasonEndStorageM3: number | null;
	/** Per farm dam, node id → storage on the season's last day. */
	storageM3ByDam: Record<string, number>;
	/** The farms' irrigation demand and supply (the `demand` and `supplied` series) over the season. */
	demandM3: number;
	/**
	 * The same per farm (node id → demand and supply over the season), every
	 * farm node with any demand in the season (engine ≥ 1.19.0): the farmer
	 * view's own-farm figures (issue #53 R5, E3).
	 */
	farms: Record<string, { demandM3: number; suppliedM3: number }>;
	suppliedM3: number;
	/** supplied ÷ demand; null without demand. */
	demandMet: number | null;
	/** The same for the other water users (WP-1.33); 0 / null without any. */
	userDemandM3: number;
	userSuppliedM3: number;
	userDemandMet: number | null;
	/** Season days, and days the outlet's pragmatic EWR is not met (`ewr_shortfall` < 0, as ewrDaysNotMet). */
	ewrDays: { days: number; below: number };
	/** The Reserve at the site: whole calendar months inside the season, and months met; null without a rule table there. */
	reserve: { months: number; met: number } | null;
}

const fin = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Measure a member run's season. `output` is the run of
 * outlookMemberInput(…).input (`model` its model); `siteNodeId` the Reserve
 * site (null = the outlet).
 */
export function outlookMember(
	output: Pick<ModelOutput, 'startDate' | 'days' | 'series' | 'summary'>,
	model: ModelInput['model'],
	season: OutlookSeason,
	analogue: OutlookAnalogue,
	siteNodeId: string | null = null
): OutlookMember {
	const s = resolveSeason(season);
	const d0 = toEpochDay(output.startDate);
	const i0 = s.from - d0;
	const i1 = s.to - d0;
	if (i0 < 0 || i1 !== output.days - 1) throw new Error(`the member run (${output.startDate}, ${output.days} days) does not end on the season end ${s.seasonEnd}`);
	const storageM3ByDam: Record<string, number> = {};
	const farms: OutlookMember['farms'] = {};
	let storage = 0;
	let dams = 0;
	let demand = 0;
	let supplied = 0;
	let userDemand = 0;
	let userSupplied = 0;
	for (const n of model.nodes) {
		if (n.kind === 'gauge') continue;
		const d = seriesOf(output, n.id, 'demand');
		const g = seriesOf(output, n.id, 'supplied');
		let dn = 0;
		let gn = 0;
		for (let t = i0; t <= i1; t++) {
			dn += fin(d?.[t]);
			gn += fin(g?.[t]);
		}
		if (n.kind === 'farm') {
			demand += dn;
			supplied += gn;
			if (dn > 0) farms[n.id] = { demandM3: dn, suppliedM3: gn };
			if (n.damCapacityM3 > 0) {
				const v = fin(seriesOf(output, n.id, 'dam_storage')?.[i1]);
				storageM3ByDam[n.id] = v;
				storage += v;
				dams++;
			}
		} else {
			userDemand += dn;
			userSupplied += gn;
		}
	}
	const short = seriesOf(output, null, 'ewr_shortfall');
	if (!short) throw new Error('the member run has no ewr_shortfall series');
	let below = 0;
	for (let t = i0; t <= i1; t++) if (short[t]! < 0) below++;
	const site = output.summary.ewrAssurance?.find((x) => (siteNodeId === null ? x.isOutlet : x.nodeId === siteNodeId));
	let reserve: OutlookMember['reserve'] = null;
	if (site) {
		let months = 0;
		let met = 0;
		for (const m of site.months) {
			const first = Date.UTC(m.year, m.month - 1, 1) / 86_400_000;
			if (first < s.from || first + m.days - 1 > s.to) continue;
			months++;
			if (m.met) met++;
		}
		reserve = { months, met };
	}
	return {
		waterYear: analogue.waterYear,
		label: analogue.label,
		analogueFrom: analogue.from,
		analogueTo: analogue.to,
		seasonEndStorageM3: dams ? storage : null,
		storageM3ByDam,
		demandM3: demand,
		farms,
		suppliedM3: supplied,
		demandMet: demand > 0 ? supplied / demand : null,
		userDemandM3: userDemand,
		userSuppliedM3: userSupplied,
		userDemandMet: userDemand > 0 ? userSupplied / userDemand : null,
		ewrDays: { days: s.days, below },
		reserve
	};
}

/** Median and 10th–90th percentiles across the years. */
export interface OutlookStat {
	p10: number;
	p50: number;
	p90: number;
}

/** One analogue year of a level, with the river's requirement under the outlook's metric. */
export interface OutlookYear extends OutlookMember {
	/** Reserve: months assessed and met; days: season days and days below the EWR. */
	ewr: {
		units: number;
		count: number;
		/** count ÷ units: the share of months met (Reserve), or of days below the EWR (days). */
		share: number;
		/** Reserve: every month met; days: no day below the EWR. */
		met: boolean;
	};
}

export interface OutlookLevelResult {
	id: string;
	label: string;
	/** Why the level wasn't run (ops that aren't demand.scale, or don't apply); empty when it ran. */
	problems: string[];
	nYears: number;
	/** nYears ≥ OUTLOOK_MIN_YEARS; when false every statistic is null. */
	enoughYears: boolean;
	/** Mean season demand (farms + other users), m³: how the levels are ranked for the planning figure. */
	meanDemandM3: number | null;
	seasonEndStorageM3: OutlookStat | null;
	demandMet: OutlookStat | null;
	userDemandMet: OutlookStat | null;
	/** The ewr share (months met, or days below) across the years. */
	ewr: OutlookStat | null;
	/** Years the requirement was met in full (OutlookYear.ewr.met). */
	yearsEwrMet: number;
	/** Each farm dam's season-end storage. */
	storageByDam: { nodeId: string; name: string; capacityM3: number; stat: OutlookStat | null }[];
	/**
	 * Each farm's share of its own demand met (supplied ÷ demand over the
	 * season; a year with no demand on the farm left out), for every farm with
	 * demand in any analogue year (engine ≥ 1.19.0; issue #53 R5, the farmer
	 * view E3). `nYears` counts the years it had demand in; the statistic is
	 * null below OUTLOOK_MIN_YEARS of them.
	 */
	demandMetByFarm: { nodeId: string; name: string; nYears: number; stat: OutlookStat | null }[];
	/** In the order of the analogues. */
	years: OutlookYear[];
}

export type PlanningReason = 'met' | 'noLevelMeets' | 'notEnoughYears' | 'noLevels';

/**
 * The planning figure: the highest demand level (by mean season demand)
 * whose requirement was met in full in at least `share` of the analogue
 * years. Data, not a recommendation: the WUA decides.
 */
export interface PlanningFigure {
	share: number;
	/** DEFAULT_PLANNING_SHARE was used (the project set no share of its own). */
	shareIsDefault: boolean;
	reason: PlanningReason;
	/** The level, when reason is `met`. */
	levelId: string | null;
	label: string | null;
	yearsMet: number | null;
	nYears: number;
	/** Every level that ran, highest demand first, with its count and whether it clears the share. */
	ranked: { levelId: string; label: string; yearsMet: number; nYears: number; meets: boolean }[];
}

export interface SeasonalOutlook {
	decisionDate: string;
	seasonEnd: string;
	days: number;
	metric: OutcomeMetric;
	/** The Reserve site (reserveMonthsMet), null = outlet; always null for daysBelowEwr. */
	siteNodeId: string | null;
	/** Σ farm dam storage at the end of the day before the decision date (the base run's): the state the season starts from. */
	startStorageM3: number | null;
	/** Σ farm dam capacity. */
	capacityM3: number;
	analogues: OutlookAnalogue[];
	excluded: OutlookExcluded[];
	nYears: number;
	/** nYears ≥ OUTLOOK_MIN_YEARS. */
	enoughYears: boolean;
	levels: OutlookLevelResult[];
	planning: PlanningFigure;
	warnings: string[];
}

export interface SeasonalOutlookOptions extends OutlookSeason {
	levels: readonly OutlookLevel[];
	/** Analogue water years; default every one the record holds but the season's own (outlookAnalogues). */
	analogueYears?: readonly number[];
	/** The base input's run (runModel / runModelChecked / runModelWithoutChecks of it); run here when absent. */
	baseRun?: OutlookBaseRun;
	/** `auto` (default): Reserve months met when every member has a rule table at the site and a whole month in the season, else days below the EWR. */
	metric?: 'auto' | OutcomeMetric;
	/** The Reserve site: null (default) = the outlet, else a gauge's node id. Days below the EWR are always at the outlet. */
	siteNodeId?: string | null;
	/** Share of analogue years for the planning figure, in (0, 1]; default DEFAULT_PLANNING_SHARE. */
	planningShare?: number;
	/**
	 * Run each member from a snapshot of the base input at the decision date
	 * (default true, engine ≥ 1.1.0): the history runs once. false: every
	 * member re-runs the history (outlookMemberInput), the older path.
	 */
	warmStart?: boolean;
	/** The snapshot to start from (captureModelState(input, decisionDate)); captured here when absent. */
	snapshot?: ModelStateSnapshot;
}

/**
 * The base run and the snapshot at `date` for an outlook: the ones given, or
 * one run that gives both (runModelCapturing), or a plain run when the date
 * is outside it (the member builders then say why).
 */
export function outlookBaseAndSnapshot(input: ModelInput, date: string, given: { baseRun?: OutlookBaseRun; snapshot?: ModelStateSnapshot } = {}): { baseRun: OutlookBaseRun; snapshot: ModelStateSnapshot | null } {
	if (given.snapshot && given.snapshot.date !== date) throw new RangeError(`the snapshot is of ${given.snapshot.date}, not ${date}`);
	if (given.baseRun && given.snapshot) return { baseRun: given.baseRun, snapshot: given.snapshot };
	const tryCapture = () => {
		try {
			return runModelCapturing(input, date);
		} catch (e) {
			if (e instanceof RangeError) return null;
			throw e;
		}
	};
	if (given.baseRun) {
		const r0 = toEpochDay(given.baseRun.startDate);
		const inside = toEpochDay(date) > r0 && toEpochDay(date) <= r0 + given.baseRun.days;
		return { baseRun: given.baseRun, snapshot: given.snapshot ?? (inside ? captureModelState(input, date) : null) };
	}
	const cap = tryCapture();
	return cap ? { baseRun: cap.output, snapshot: given.snapshot ?? cap.snapshot } : { baseRun: runModelWithoutChecks(input), snapshot: given.snapshot ?? null };
}

/**
 * One member's measures, run from a snapshot of the base input at the
 * season's first day (engine ≥ 1.1.0): outlookSeasonInput, runModelFrom
 * and outlookMember in one. `problems` when the ops don't apply (then no
 * member). What the backend job runs per member once it holds a snapshot.
 */
export function runOutlookMember(
	snapshot: ModelStateSnapshot,
	input: ModelInput,
	baseRun: OutlookBaseRun,
	season: OutlookSeason,
	analogue: OutlookAnalogue,
	ops: readonly ScenarioOp[] = [],
	siteNodeId: string | null = null
): { member: OutlookMember | null; problems: string[] } {
	if (snapshot.date !== resolveSeason(season).decisionDate) throw new RangeError(`the snapshot is of ${snapshot.date}, not the season's first day ${season.decisionDate}`);
	const m = outlookSeasonInput(input, baseRun, season, analogue, ops);
	if (m.problems.length) return { member: null, problems: m.problems };
	return { member: outlookMember(runModelFrom(snapshot, m.input), m.input.model, season, analogue, siteNodeId), problems: [] };
}

function stat(values: readonly (number | null)[], enough: boolean): OutlookStat | null {
	if (!enough) return null;
	const v = Float64Array.from(values.filter((x): x is number => x !== null && Number.isFinite(x))).sort();
	if (!v.length) return null;
	return { p10: quantileSorted(v, 10)!, p50: quantileSorted(v, 50)!, p90: quantileSorted(v, 90)! };
}

/** The input to summariseOutlook: each level's members (one per analogue, in the analogues' order), or its problems. */
export interface OutlookSummaryInput {
	season: OutlookSeason;
	model: ModelInput['model'];
	analogues: OutlookAnalogue[];
	excluded: OutlookExcluded[];
	levels: { id: string; label: string; problems: string[]; members: OutlookMember[] }[];
	startStorageM3: number | null;
	metric?: 'auto' | OutcomeMetric;
	siteNodeId?: string | null;
	planningShare?: number;
}

/** Choose the metric, work out every level's statistics and the planning figure. */
export function summariseOutlook(x: OutlookSummaryInput): SeasonalOutlook {
	const s = resolveSeason(x.season);
	const share = x.planningShare ?? DEFAULT_PLANNING_SHARE;
	if (!(Number.isFinite(share) && share > 0 && share <= 1)) throw new RangeError(`planning share ${String(share)} must be in (0, 1]`);
	const ids = new Set<string>();
	for (const l of x.levels) {
		if (ids.has(l.id)) throw new Error(`duplicate level id: ${l.id}`);
		ids.add(l.id);
	}
	const siteNodeId = x.siteNodeId ?? null;
	const warnings: string[] = [];
	const ran = x.levels.filter((l) => !l.problems.length);
	const members = ran.flatMap((l) => l.members);
	const withTable = members.filter((m) => m.reserve && m.reserve.months > 0).length;
	const requested = x.metric ?? 'auto';
	let metric: OutcomeMetric;
	if (requested === 'reserveMonthsMet') {
		if (withTable < members.length) throw new Error('reserveMonthsMet needs a Reserve rule table at the site and a whole calendar month in the season, for every member');
		metric = 'reserveMonthsMet';
	} else if (requested === 'daysBelowEwr') metric = 'daysBelowEwr';
	else {
		metric = members.length > 0 && withTable === members.length ? 'reserveMonthsMet' : 'daysBelowEwr';
		if (withTable > 0 && withTable < members.length) warnings.push('Only some members have a Reserve rule table at the site with a whole month in the season, so every figure uses days below the pragmatic EWR, to keep the levels comparable.');
		else if (withTable === 0 && members.some((m) => m.reserve)) warnings.push('The season holds no whole calendar month, so the Reserve rule table cannot be read; every figure uses days below the pragmatic EWR.');
	}

	const nYears = x.analogues.length;
	const enoughYears = nYears >= OUTLOOK_MIN_YEARS;
	if (!enoughYears) warnings.push(`Only ${nYears} analogue year${nYears === 1 ? '' : 's'}: at least ${OUTLOOK_MIN_YEARS} are needed for percentiles and a planning figure.`);
	for (const l of x.levels) if (l.problems.length) warnings.push(`${l.label}: not run (${l.problems.join('; ')})`);
	const dams = x.model.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
	const farmNodes = x.model.nodes.filter((n) => n.kind === 'farm');

	const levels: OutlookLevelResult[] = x.levels.map((l) => {
		if (l.problems.length) {
			return { id: l.id, label: l.label, problems: l.problems, nYears: 0, enoughYears: false, meanDemandM3: null, seasonEndStorageM3: null, demandMet: null, userDemandMet: null, ewr: null, yearsEwrMet: 0, storageByDam: [], demandMetByFarm: [], years: [] };
		}
		if (l.members.length !== nYears) throw new Error(`level ${l.id} has ${l.members.length} members for ${nYears} analogue years`);
		const years: OutlookYear[] = l.members.map((m) => {
			const [units, count] = metric === 'reserveMonthsMet' ? [m.reserve!.months, m.reserve!.met] : [m.ewrDays.days, m.ewrDays.below];
			return { ...m, ewr: { units, count, share: units ? count / units : 0, met: metric === 'reserveMonthsMet' ? count === units : count === 0 } };
		});
		return {
			id: l.id,
			label: l.label,
			problems: [],
			nYears,
			enoughYears,
			meanDemandM3: nYears ? years.reduce((a, y) => a + y.demandM3 + y.userDemandM3, 0) / nYears : null,
			seasonEndStorageM3: stat(years.map((y) => y.seasonEndStorageM3), enoughYears),
			demandMet: stat(years.map((y) => y.demandMet), enoughYears),
			userDemandMet: stat(years.map((y) => y.userDemandMet), enoughYears),
			ewr: stat(years.map((y) => y.ewr.share), enoughYears),
			yearsEwrMet: years.filter((y) => y.ewr.met).length,
			storageByDam: dams.map((n) => ({ nodeId: n.id, name: n.name, capacityM3: damCapacityOn(n, s.to), stat: stat(years.map((y) => y.storageM3ByDam[n.id] ?? null), enoughYears) })),
			demandMetByFarm: farmNodes.flatMap((n) => {
				const got = years.flatMap((y) => {
					const f = y.farms[n.id];
					return f && f.demandM3 > 0 ? [f.suppliedM3 / f.demandM3] : [];
				});
				return got.length ? [{ nodeId: n.id, name: n.name, nYears: got.length, stat: stat(got, got.length >= OUTLOOK_MIN_YEARS) }] : [];
			}),
			years
		};
	});

	const ranked = levels
		.map((l, i) => ({ l, i }))
		.filter(({ l }) => !l.problems.length)
		.sort((a, b) => b.l.meanDemandM3! - a.l.meanDemandM3! || a.i - b.i)
		// yearsMet ÷ n ≥ share, allowing for float noise in share × n (0.56 × 25 is 14.000000000000002).
		.map(({ l }) => ({ levelId: l.id, label: l.label, yearsMet: l.yearsEwrMet, nYears, meets: nYears > 0 && l.yearsEwrMet >= share * nYears - 1e-9 }));
	const best = ranked.find((r) => r.meets);
	const reason: PlanningReason = !ranked.length ? 'noLevels' : !enoughYears ? 'notEnoughYears' : best ? 'met' : 'noLevelMeets';
	const pick = reason === 'met' ? best! : null;
	return {
		decisionDate: s.decisionDate,
		seasonEnd: s.seasonEnd,
		days: s.days,
		metric,
		siteNodeId: metric === 'reserveMonthsMet' ? siteNodeId : null,
		startStorageM3: x.startStorageM3,
		// On the season's last day, which the season-end storage is (engine ≥ 1.30.0: a dam's capacity can change).
		capacityM3: dams.reduce((a, n) => a + damCapacityOn(n, s.to), 0),
		analogues: x.analogues,
		excluded: x.excluded,
		nYears,
		enoughYears,
		levels,
		planning: {
			share,
			shareIsDefault: x.planningShare === undefined,
			reason,
			levelId: pick?.levelId ?? null,
			label: pick?.label ?? null,
			yearsMet: pick?.yearsMet ?? null,
			nYears,
			ranked
		},
		warnings
	};
}

/** Σ farm dam storage at the end of the day before the decision date in the base run; null without a dam. */
function storageBefore(input: ModelInput, baseRun: OutlookBaseRun, s: ResolvedSeason): number | null {
	const t = s.from - 1 - toEpochDay(baseRun.startDate);
	let sum = 0;
	let dams = 0;
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) continue;
		sum += fin(seriesOf(baseRun, n.id, 'dam_storage')?.[t]);
		dams++;
	}
	return dams ? sum : null;
}

/**
 * The seasonal outlook: every analogue × every level, run and summarised.
 * Members = analogue years × levels that run, each a run of the season from
 * the base run's snapshot at the decision date (warmStart, the default), or
 * with warmStart false a full run of the history and the season. Levels
 * whose ops aren't all demand.scale, or don't apply, are reported with
 * their problems and not run.
 */
export function runSeasonalOutlook(input: ModelInput, options: SeasonalOutlookOptions): SeasonalOutlook {
	const season: OutlookSeason = { decisionDate: options.decisionDate, seasonEnd: options.seasonEnd };
	const s = resolveSeason(season);
	const warm = options.warmStart !== false;
	const got = warm ? outlookBaseAndSnapshot(input, s.decisionDate, options) : null;
	const baseRun = got?.baseRun ?? options.baseRun ?? runModelWithoutChecks(input);
	const snapshot = got?.snapshot ?? null;
	const { analogues, excluded } = outlookAnalogues(baseRun, season, options.analogueYears);
	const siteNodeId = options.siteNodeId ?? null;
	// A member: from the snapshot, or (warmStart false) the history re-run.
	const memberOf = (a: OutlookAnalogue, m: { input: ModelInput }) => outlookMember(snapshot ? runModelFrom(snapshot, m.input) : runModelWithoutChecks(m.input), m.input.model, season, a, siteNodeId);
	const build = snapshot ? outlookSeasonInput : outlookMemberInput;
	const levels = options.levels.map((level) => {
		let problems = outlookLevelProblems(level);
		const members: OutlookMember[] = [];
		if (!problems.length && analogues.length) {
			// The ops apply alike to every member (the same model); check them once.
			const first = build(input, baseRun, season, analogues[0]!, level.ops);
			problems = first.problems;
			if (!problems.length) {
				for (const [k, a] of analogues.entries()) members.push(memberOf(a, k === 0 ? first : build(input, baseRun, season, a, level.ops)));
			}
		} else if (!problems.length) {
			// No analogue to run: still check the member input can be built (the dates, the base).
			problems = outlookMemberInput(input, baseRun, season, { waterYear: 0, label: '', from: s.decisionDate, to: s.seasonEnd }, level.ops).problems;
		}
		return { id: level.id, label: level.label, problems, members };
	});
	return summariseOutlook({
		season,
		model: input.model,
		analogues,
		excluded,
		levels,
		startStorageM3: storageBefore(input, baseRun, s),
		...(options.metric !== undefined ? { metric: options.metric } : {}),
		siteNodeId,
		...(options.planningShare !== undefined ? { planningShare: options.planningShare } : {})
	});
}

const pct = (v: number) => `${Math.round(v * 100)} %`;

/**
 * The planning figure in words, counting years, never "likely" or
 * "recommended": "85 %: met the EWR on every day of the season in 17 of 21
 * analogue years, the highest demand level to do so in at least 80 % of
 * them."
 */
export function describePlanningFigure(outlook: Pick<SeasonalOutlook, 'metric' | 'planning'>): string {
	const p = outlook.planning;
	const what = outlook.metric === 'reserveMonthsMet' ? 'met the Reserve in every month of the season' : 'met the EWR on every day of the season';
	const need = `at least ${pct(p.share)}`;
	switch (p.reason) {
		case 'noLevels':
			return 'No demand level could be run.';
		case 'notEnoughYears':
			return `Only ${p.nYears} analogue year${p.nYears === 1 ? '' : 's'} in the record: not enough to judge (at least ${OUTLOOK_MIN_YEARS} are needed).`;
		case 'met':
			return `${p.label}: ${what} in ${p.yearsMet} of ${p.nYears} analogue years, the highest demand level to do so in ${need} of them.`;
		case 'noLevelMeets': {
			const most = p.ranked.reduce((a, r) => (r.yearsMet > a.yearsMet ? r : a), p.ranked[0]!);
			return `No demand level ${what} in ${need} of the ${p.nYears} analogue years; the most was ${most.yearsMet} of ${p.nYears}, at ${most.label}.`;
		}
	}
}
