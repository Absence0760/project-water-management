// Review triggers from the seasonal outlook (issue #53 R6,
// docs/design/planning-outputs.md §3.6, docs/model.md §2.15a): S3's table
// ("above x m³ at the review date → 100 %, between → 85 %, below → 70 %"),
// computed rather than asserted.
//
// For each storage band, the outlook (./outlook.ts) runs from the review
// date to the season end with the farm dams set to a representative storage
// in the band on the review date, every other part of the state the base
// run's history: the base run's snapshot at the review date with the band's
// storage in its dams (withDamStorage, ../warmstart, engine 1.1.0), or with
// warmStart false settings.damStorageReset (engine 0.46.0, through
// outlookMemberInput's `start`) in a full re-run of the history. Each band's row is the outlook's planning figure: the
// highest demand level that met the river's requirement in at least the
// planning share of the analogue years. Reported as data ("level L met the
// EWR in a of b years"), never as advice; a band where no level meets the
// rule, too few analogue years and a table that isn't monotone in storage
// are reported, never smoothed.
//
// Cost: one run of the history (to capture the snapshot), then bands ×
// analogue years × levels member runs of the season alone; every band
// shares the one history, since a band only changes the dams' storage on
// the review date (model.md §2.15a, §2.16).
//
// Pure: no I/O. Deterministic.
import { damCapacityOn } from '../network/development';
import { fromEpochDay, toEpochDay } from '../calendar';
import { DEMAND_PARTS, type DemandPart, type DroughtRestrictionLevel, type DroughtRestrictionRule, type ModelInput } from '../project';
import { droughtRestrictionIssues, RESTRICTION_LEVELS_MAX } from '../network/restriction';
import { runModelFrom, runModelWithoutChecks } from '../run';
import { withDamStorage, type ModelStateSnapshot } from '../warmstart/snapshot';
import type { ScenarioOp } from '../scenario/ops';
import { quantileSorted } from '../uncertainty/bands';
import type { OutcomeMetric } from '../views/outcomeMatrix';
import {
	OUTLOOK_MIN_YEARS,
	outlookAnalogues,
	outlookBaseAndSnapshot,
	outlookLevelProblems,
	outlookMember,
	outlookMemberInput,
	outlookSeasonInput,
	summariseOutlook,
	withoutDroughtRestriction,
	assertUnrestrictedBase,
	type OutlookBaseRun,
	type OutlookLevel,
	type OutlookMember,
	type OutlookStat,
	type PlanningReason,
	type SeasonalOutlook
} from './outlook';
import { analogueStart, resolveSeason, type OutlookSeason } from './season';

/**
 * The default review date for a season: the first day of the calendar month
 * holding the season's middle day (1 January for the default 1 October –
 * 30 April season), or the middle day itself when that month starts on or
 * before the decision date. Confirmed by the client (O3, issue #90: review
 * on 1 January): half the season left to act on a cut, and a month's first day so a monthly plan
 * (R1's `months` form) and the Reserve's whole months start there.
 */
export function defaultReviewDate(season: OutlookSeason): string {
	const s = resolveSeason(season);
	if (s.days < 2) throw new RangeError('a season of one day has no day to review on');
	const mid = s.from + Math.floor((s.days - 1) / 2);
	const iso = fromEpochDay(mid);
	const first = toEpochDay(`${iso.slice(0, 8)}01`);
	return fromEpochDay(first > s.from ? first : Math.max(mid, s.from + 1));
}

/** Farm dams with a capacity, the ones a band's storage is shared over. */
function farmDams(input: ModelInput) {
	return input.model.nodes.filter((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
}

const seriesOf = (run: OutlookBaseRun, nodeId: string, key: string) => run.series.find((s) => s.nodeId === nodeId && s.key === key)?.values;

/** One year's total farm dam storage at the start of the review date's day (the end of the day before). */
export interface ReviewStorageSample {
	/** The water year the day falls in (as season.ts maps a date to a year). */
	waterYear: number;
	/** The review day in that year (ISO). */
	date: string;
	storageM3: number;
}

/**
 * The base run's total farm dam storage at the end of the day before the
 * review date's month and day, in every water year the run holds that day
 * (the day before inside the run). The same day mapping as the analogues
 * (season.ts analogueStart: 29 February → 28 February in a common year).
 */
export function reviewStorageHistory(input: ModelInput, baseRun: OutlookBaseRun, reviewDate: string): ReviewStorageSample[] {
	resolveSeason({ decisionDate: reviewDate, seasonEnd: reviewDate });
	const dams = farmDams(input).map((n) => seriesOf(baseRun, n.id, 'dam_storage'));
	if (!dams.length) return [];
	const r0 = toEpochDay(baseRun.startDate);
	const r1 = r0 + baseRun.days - 1;
	const out: ReviewStorageSample[] = [];
	const wy0 = Number(baseRun.startDate.slice(0, 4)) - 1;
	for (let wy = wy0; ; wy++) {
		const day = analogueStart(reviewDate, wy);
		if (day - 1 > r1) break;
		if (day - 1 < r0) continue;
		let sum = 0;
		for (const q of dams) {
			const v = q?.[day - 1 - r0];
			sum += typeof v === 'number' && Number.isFinite(v) ? v : 0;
		}
		out.push({ waterYear: wy, date: fromEpochDay(day), storageM3: sum });
	}
	return out;
}

/** A storage band on the review date: total farm dam storage from `fromM3` (inclusive) to `toM3` (exclusive; the top band's is its capacity, inclusive). */
export interface StorageBand {
	fromM3: number;
	toM3: number;
}

/** Where a table's band edges came from. */
export type TriggerBandSource = 'explicit' | 'historicalTerciles' | 'wholeRange';

/**
 * Fewest years of history on the review date for tercile edges (judgement,
 * as OUTLOOK_MIN_YEARS): with fewer, a tercile is set by one or two years.
 * Below three the edges can't be drawn and the table has one band.
 */
export const TRIGGER_MIN_HISTORY_YEARS = OUTLOOK_MIN_YEARS;

/**
 * The default band edges: the terciles (33⅓ and 66⅔ percentiles, linear,
 * type 7, as the outlook's percentiles) of the base run's total storage on
 * the review date across the years. Three bands, as S3's table ("above,
 * between, below"), and terciles because that is how a seasonal forecast is
 * stated (SAWS's below / near / above normal, design §2 finding 3): a
 * **judgement** following that convention, pending the hydrologist. Empty
 * with fewer than three years (one band over the whole range).
 */
export function tercileEdges(samples: readonly ReviewStorageSample[]): number[] {
	if (samples.length < 3) return [];
	const v = Float64Array.from(samples.map((x) => x.storageM3)).sort();
	return [quantileSorted(v, 100 / 3)!, quantileSorted(v, 200 / 3)!];
}

/**
 * The bands from inner edges (thresholds) over 0 … capacity: edges sorted,
 * with an edge ≤ 0, above the capacity, repeated, or not a number left out
 * (and said so). An edge at the capacity makes a top band of full dams only.
 */
export function storageBands(edgesM3: readonly number[], capacityM3: number): { bands: StorageBand[]; warnings: string[] } {
	const warnings: string[] = [];
	const kept: number[] = [];
	for (const e of [...edgesM3].sort((a, b) => a - b)) {
		if (typeof e !== 'number' || !Number.isFinite(e)) warnings.push(`band edge ${String(e)} is not a number; left out`);
		else if (e <= 0) warnings.push(`band edge ${e} m³ is not above empty; left out (the lowest band starts at 0)`);
		else if (e > capacityM3) warnings.push(`band edge ${e} m³ is above the dams' capacity ${capacityM3} m³; left out`);
		else if (kept.length && e === kept[kept.length - 1]) warnings.push(`band edge ${e} m³ is repeated; left out`);
		else kept.push(e);
	}
	const at = [0, ...kept];
	return { bands: at.map((from, i) => ({ fromM3: from, toM3: i + 1 < at.length ? at[i + 1]! : capacityM3 })), warnings };
}

/**
 * Which storage in a band each band is run from. `lowerEdge` (default): the
 * band's lowest storage, so a row's "at or above X" is what was run for the
 * band's least favourable start, the cautious reading (design §2 finding 4,
 * [Kaune 2020]). `midpoint`: the band's middle. A **judgement, pending the
 * hydrologist**. From engine 1.11.0 (issue #46) the lowest band's floor is
 * not empty dams but the lowest total storage on record for the review date
 * (lowestBandFloor), so it runs from the driest start the record had.
 */
export type TriggerRepresentative = 'lowerEdge' | 'midpoint';

/**
 * The start storage for a band: the total (the band's lower edge or middle)
 * and its split over the farm dams pro rata to capacity, so every dam is at
 * the same share of its capacity. A total inside 0 … Σ capacity then never
 * puts a dam over its capacity or below empty; a dam's dead storage is not
 * treated apart (below it the dam just can't irrigate). **Judgement**: with
 * no per-dam level on the review date, the same fill everywhere is the
 * plain reading of "the dams hold x m³".
 */
export function bandStartStorage(
	input: ModelInput,
	band: StorageBand,
	representative: TriggerRepresentative = 'lowerEdge',
	/** The review date (epoch day): each dam's capacity is that day's (engine ≥ 1.30.0: sediment, an in-service date); absent = as entered. */
	day?: number
): { totalM3: number; storageM3ByDam: Record<string, number> } {
	const dams = farmDams(input);
	const capOf = (n: ModelInput['model']['nodes'][number]) => (day === undefined ? n.damCapacityM3 : damCapacityOn(n, day));
	const cap = dams.reduce((a, n) => a + capOf(n), 0);
	const want = representative === 'midpoint' ? (band.fromM3 + band.toM3) / 2 : band.fromM3;
	const total = Math.min(Math.max(want, 0), cap);
	const f = cap > 0 ? total / cap : 0;
	const storageM3ByDam: Record<string, number> = {};
	for (const n of dams) storageM3ByDam[n.id] = f * capOf(n);
	return { totalM3: total, storageM3ByDam };
}

/**
 * Where the lowest band's start comes from (engine ≥ 1.11.0, issue #46,
 * model.md §2.15a): the lowest total farm dam storage the base run had on
 * the review date in any year (reviewStorageHistory), when that is below
 * the band's upper edge; else empty dams (0), with a warning. A band from
 * 0 to X read as "below X" is most cautiously run from the worst start the
 * catchment actually had on that date, not from a start it may never have
 * had. **Judgement, pending the hydrologist** (the persona draft offered a
 * 5th percentile with ≥ 20 years instead of the minimum).
 */
export function lowestBandFloor(history: readonly ReviewStorageSample[], lowest: StorageBand): { floorM3: number; fromRecord: boolean; warning: string | null } {
	if (!history.length) return { floorM3: 0, fromRecord: false, warning: 'No year of the record holds the review date, so the lowest band runs from empty dams.' };
	const min = Math.min(...history.map((x) => x.storageM3));
	if (min < lowest.toM3) return { floorM3: Math.max(min, 0), fromRecord: true, warning: null };
	return { floorM3: 0, fromRecord: false, warning: `No year of the record had less than ${m3(lowest.toM3)} in the dams on the review date, so the lowest band runs from empty dams.` };
}

/** One level of a band's outlook, in the table's terms. */
export interface TriggerLevelSummary {
	levelId: string;
	label: string;
	yearsMet: number;
	nYears: number;
	/** Clears the planning share. */
	meets: boolean;
	seasonEndStorageM3: OutlookStat | null;
	demandMet: OutlookStat | null;
}

/** One row of the trigger table. */
export interface ReviewTriggerRow {
	band: StorageBand;
	/** The total storage the band was run from, and its split over the dams. */
	startStorageM3: number;
	storageM3ByDam: Record<string, number>;
	/** 'lowestOnRecord' on the lowest band when it ran from the lowest storage on record for the review date (engine ≥ 1.11.0, lowestBandFloor); absent otherwise. */
	startFrom?: 'lowestOnRecord';
	/** The highest level meeting the planning rule; null when none does (or too few years). */
	level: { id: string; label: string } | null;
	reason: PlanningReason;
	/** The level's years met; null without a level. */
	metYears: number | null;
	nYears: number;
	/** Every level that ran, highest demand first. */
	perLevel: TriggerLevelSummary[];
	/** The band's whole outlook (every level and year). */
	outlook: SeasonalOutlook;
}

export interface ReviewTriggers {
	reviewDate: string;
	seasonEnd: string;
	days: number;
	metric: OutcomeMetric;
	capacityM3: number;
	representative: TriggerRepresentative;
	bandSource: TriggerBandSource;
	/** The history the default edges came from (empty with explicit edges). */
	history: ReviewStorageSample[];
	/** The lowest total storage on record for the review date, which the lowest band ran from (engine ≥ 1.11.0); null when it ran from empty dams. */
	lowestOnRecordM3?: number | null;
	share: number;
	shareIsDefault: boolean;
	nYears: number;
	enoughYears: boolean;
	/** Fullest band first, as S3's table reads. */
	rows: ReviewTriggerRow[];
	/** A fuller band never picked a lower level than an emptier one (nothing to compare: true). */
	monotone: boolean;
	/** Where the table or a level's years met fall as storage rises, band by band. */
	notes: string[];
	warnings: string[];
}

/** One band's measured members per level, for reviewTriggerTable (a job that runs them one by one). */
export interface TriggerBandMembers {
	band: StorageBand;
	startStorageM3: number;
	storageM3ByDam: Record<string, number>;
	/** The lowest band ran from the lowest storage on record (engine ≥ 1.11.0). */
	startFrom?: 'lowestOnRecord';
	levels: { id: string; label: string; problems: string[]; members: OutlookMember[] }[];
}

export interface ReviewTriggerTableInput {
	reviewDate: string;
	seasonEnd: string;
	model: ModelInput['model'];
	analogues: Parameters<typeof summariseOutlook>[0]['analogues'];
	excluded: Parameters<typeof summariseOutlook>[0]['excluded'];
	/** Emptiest band first. */
	bands: TriggerBandMembers[];
	representative: TriggerRepresentative;
	bandSource: TriggerBandSource;
	history: ReviewStorageSample[];
	/** The lowest storage on record the lowest band ran from; null or absent = empty dams. */
	lowestOnRecordM3?: number | null;
	/** Warnings from drawing the bands. */
	bandWarnings?: string[];
	metric?: 'auto' | OutcomeMetric;
	siteNodeId?: string | null;
	planningShare?: number;
}

/** "250 000 m³": whole m³, digits grouped in threes by a space (no locale, so no machine changes it). */
const m3 = (v: number) => `${String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} m³`;

/** Summarise every band's outlook and build the table, its monotonicity notes and warnings. */
export function reviewTriggerTable(x: ReviewTriggerTableInput): ReviewTriggers {
	if (!x.bands.length) throw new Error('a trigger table needs at least one band');
	const season: OutlookSeason = { decisionDate: x.reviewDate, seasonEnd: x.seasonEnd };
	const s = resolveSeason(season);
	const summarise = (b: TriggerBandMembers, metric: 'auto' | OutcomeMetric | undefined) =>
		summariseOutlook({
			season,
			model: x.model,
			analogues: x.analogues,
			excluded: x.excluded,
			levels: b.levels,
			startStorageM3: b.startStorageM3,
			...(metric !== undefined ? { metric } : {}),
			siteNodeId: x.siteNodeId ?? null,
			...(x.planningShare !== undefined ? { planningShare: x.planningShare } : {})
		});
	// The metric follows the first band's choice, so every band is judged alike.
	const first = summarise(x.bands[0]!, x.metric);
	const outlooks = [first, ...x.bands.slice(1).map((b) => summarise(b, first.metric))];
	const warnings = [...(x.bandWarnings ?? [])];
	for (const o of outlooks) for (const w of o.warnings) if (!warnings.includes(w)) warnings.push(w);

	const ascending: ReviewTriggerRow[] = x.bands.map((b, i) => {
		const o = outlooks[i]!;
		const byId = new Map(o.levels.map((l) => [l.id, l]));
		return {
			band: b.band,
			startStorageM3: b.startStorageM3,
			storageM3ByDam: b.storageM3ByDam,
			...(b.startFrom ? { startFrom: b.startFrom } : {}),
			level: o.planning.levelId !== null ? { id: o.planning.levelId, label: o.planning.label! } : null,
			reason: o.planning.reason,
			metYears: o.planning.yearsMet,
			nYears: o.nYears,
			perLevel: o.planning.ranked.map((r) => ({ ...r, seasonEndStorageM3: byId.get(r.levelId)!.seasonEndStorageM3, demandMet: byId.get(r.levelId)!.demandMet })),
			outlook: o
		};
	});

	// Monotonicity, emptiest band first: the pick's place in the demand ranking (0 = highest; none = below every level).
	const notes: string[] = [];
	let monotone = true;
	const order = first.planning.ranked.map((r) => r.levelId);
	const place = (r: ReviewTriggerRow) => (r.level ? order.indexOf(r.level.id) : order.length);
	const judged = ascending.filter((r) => r.reason === 'met' || r.reason === 'noLevelMeets');
	for (let i = 1; i < judged.length; i++) {
		const [lo, hi] = [judged[i - 1]!, judged[i]!];
		if (place(hi) > place(lo)) {
			monotone = false;
			notes.push(`From ${m3(hi.band.fromM3)} the level picked is ${hi.level?.label ?? 'none'}, lower than ${lo.level?.label ?? 'none'} from ${m3(lo.band.fromM3)}: a fuller start picked a lower level.`);
		}
	}
	for (const id of order) {
		for (let i = 1; i < ascending.length; i++) {
			const [a, b] = [ascending[i - 1]!.perLevel.find((l) => l.levelId === id), ascending[i]!.perLevel.find((l) => l.levelId === id)];
			if (a && b && b.yearsMet < a.yearsMet) notes.push(`${b.label}: met in ${b.yearsMet} of ${b.nYears} years from ${m3(ascending[i]!.band.fromM3)}, fewer than ${a.yearsMet} from ${m3(ascending[i - 1]!.band.fromM3)}.`);
		}
	}
	if (!monotone) warnings.push('The table is not monotone in storage: a fuller band picked a lower demand level than an emptier one (see the notes). It is reported as run, not smoothed.');
	for (const r of ascending) if (r.reason === 'noLevelMeets') warnings.push(`From ${m3(r.band.fromM3)}: no demand level met the requirement in at least ${Math.round(first.planning.share * 100)} % of the analogue years.`);
	return {
		reviewDate: s.decisionDate,
		seasonEnd: s.seasonEnd,
		days: s.days,
		metric: first.metric,
		capacityM3: first.capacityM3,
		representative: x.representative,
		bandSource: x.bandSource,
		history: x.history,
		lowestOnRecordM3: x.lowestOnRecordM3 ?? null,
		share: first.planning.share,
		shareIsDefault: first.planning.shareIsDefault,
		nYears: first.nYears,
		enoughYears: first.enoughYears,
		rows: [...ascending].reverse(),
		monotone,
		notes,
		warnings
	};
}

export interface ReviewTriggerOptions {
	/** The review date (ISO): the bands' storage is set at the start of this day (defaultReviewDate gives one). */
	reviewDate: string;
	seasonEnd: string;
	/** The season's decision date, when known: the review date must fall after it (inside the season). */
	decisionDate?: string;
	levels: readonly OutlookLevel[];
	/** Inner band edges, m³ of total farm dam storage (thresholds); default the terciles of the base run's storage on the review date. */
	edgesM3?: readonly number[];
	representative?: TriggerRepresentative;
	analogueYears?: readonly number[];
	baseRun?: OutlookBaseRun;
	metric?: 'auto' | OutcomeMetric;
	siteNodeId?: string | null;
	planningShare?: number;
	/** Run each member from the base run's snapshot at the review date with the band's storage (default true, engine ≥ 1.1.0); false: re-run the history per member with a storage reset. */
	warmStart?: boolean;
	/** The snapshot at the review date (captureModelState(input, reviewDate)); captured here when absent. */
	snapshot?: ModelStateSnapshot;
}

/** What reviewTriggerBands needs: the options that set the bands. */
export type ReviewTriggerBandOptions = Pick<ReviewTriggerOptions, 'reviewDate' | 'seasonEnd' | 'decisionDate' | 'edgesM3' | 'representative'>;

/** The bands a trigger table runs from, before any member runs (reviewTriggerBands). */
export interface ReviewTriggerBandPlan {
	/** Σ farm dam capacity. */
	capacityM3: number;
	/** Emptiest band first, each with the storage it starts from and its split over the dams. */
	bands: Omit<TriggerBandMembers, 'levels'>[];
	representative: TriggerRepresentative;
	bandSource: TriggerBandSource;
	/** The history the default edges came from (empty with explicit edges). */
	history: ReviewStorageSample[];
	/** The lowest storage on record the lowest band runs from; null = empty dams. */
	lowestOnRecordM3: number | null;
	bandWarnings: string[];
}

/** Throw when the review date isn't after the season's decision date, or there is no farm dam. */
function checkReview(input: ModelInput, options: ReviewTriggerBandOptions): void {
	resolveSeason({ decisionDate: options.reviewDate, seasonEnd: options.seasonEnd });
	if (options.decisionDate !== undefined && toEpochDay(resolveSeason({ decisionDate: options.decisionDate, seasonEnd: options.seasonEnd }).decisionDate) >= toEpochDay(options.reviewDate))
		throw new RangeError(`the review date ${options.reviewDate} is not after the season's decision date ${options.decisionDate}`);
	if (!farmDams(input).length) throw new Error('review triggers need a farm dam: the bands are dam storage');
}

/**
 * The storage bands on the review date and the storage each starts from,
 * from the base run: the first half of runReviewTriggers, for a job that
 * then runs the members one by one and hands them to reviewTriggerTable
 * (the backend's outlook job, issue #53 R6). Throws as runReviewTriggers
 * does for the dates and the dams.
 */
export function reviewTriggerBands(raw: ModelInput, baseRun: OutlookBaseRun, options: ReviewTriggerBandOptions): ReviewTriggerBandPlan {
	// Without the drought restriction rule, on a base run without it (engine ≥ 1.46.0), as the outlook.
	const input = withoutDroughtRestriction(raw);
	assertUnrestrictedBase(baseRun);
	checkReview(input, options);
	// The dams' capacity on the review date (engine ≥ 1.30.0: it can change over the run).
	const reviewDay = toEpochDay(options.reviewDate);
	const capacity = farmDams(input).reduce((a, n) => a + damCapacityOn(n, reviewDay), 0);
	const representative = options.representative ?? 'lowerEdge';
	const bandWarnings: string[] = [];
	let history: ReviewStorageSample[] = [];
	let bandSource: TriggerBandSource;
	let edges: readonly number[];
	if (options.edgesM3) {
		edges = options.edgesM3;
		bandSource = 'explicit';
	} else {
		history = reviewStorageHistory(input, baseRun, options.reviewDate);
		edges = tercileEdges(history);
		bandSource = edges.length ? 'historicalTerciles' : 'wholeRange';
		if (!edges.length) bandWarnings.push(`Only ${history.length} year${history.length === 1 ? '' : 's'} of storage on the review date in the record: too few for tercile bands, so the table has one band.`);
		else if (history.length < TRIGGER_MIN_HISTORY_YEARS) bandWarnings.push(`The tercile bands come from only ${history.length} years of storage on the review date (at least ${TRIGGER_MIN_HISTORY_YEARS} are needed for them to mean much).`);
	}
	const drawn = storageBands(edges, capacity);
	bandWarnings.push(...drawn.warnings);
	// The lowest band's floor (engine ≥ 1.11.0): the lowest storage on record for the review date, whatever drew the edges.
	const floor = lowestBandFloor(bandSource === 'explicit' ? reviewStorageHistory(input, baseRun, options.reviewDate) : history, drawn.bands[0]!);
	if (floor.warning) bandWarnings.push(floor.warning);
	const bands = drawn.bands.map((band, i) => {
		const fromRecord = i === 0 && floor.fromRecord;
		const start = bandStartStorage(input, fromRecord ? { fromM3: floor.floorM3, toM3: band.toM3 } : band, representative, reviewDay);
		return { band, startStorageM3: start.totalM3, storageM3ByDam: start.storageM3ByDam, ...(fromRecord ? { startFrom: 'lowestOnRecord' as const } : {}) };
	});
	return { capacityM3: capacity, bands, representative, bandSource, history, lowestOnRecordM3: floor.fromRecord ? floor.floorM3 : null, bandWarnings };
}

/**
 * The review triggers: the outlook from every storage band at the review
 * date, bands × analogue years × levels member runs of the season, from the
 * one snapshot of the history (warmStart). Needs a farm dam.
 */
export function runReviewTriggers(raw: ModelInput, options: ReviewTriggerOptions): ReviewTriggers {
	// Without the drought restriction rule, as the outlook (withoutDroughtRestriction).
	const input = withoutDroughtRestriction(raw);
	const season: OutlookSeason = { decisionDate: options.reviewDate, seasonEnd: options.seasonEnd };
	// The dates and the dams first, before the history runs.
	checkReview(input, options);
	const warm = options.warmStart !== false;
	const got = warm ? outlookBaseAndSnapshot(input, options.reviewDate, options) : null;
	const baseRun = got?.baseRun ?? options.baseRun ?? runModelWithoutChecks(input);
	const snapshot = got?.snapshot ?? null;
	const plan = reviewTriggerBands(input, baseRun, options);
	const { analogues, excluded } = outlookAnalogues(baseRun, season, options.analogueYears);
	const bands: TriggerBandMembers[] = plan.bands.map((b) => {
		// The band's storage in the snapshot's dams: every band shares the one history.
		const bandSnapshot = snapshot ? withDamStorage(snapshot, input, b.storageM3ByDam) : null;
		const levels = options.levels.map((level) => {
			let problems = outlookLevelProblems(level);
			const members: OutlookMember[] = [];
			for (const a of problems.length ? [] : analogues) {
				const m = bandSnapshot ? outlookSeasonInput(input, baseRun, season, a, level.ops) : outlookMemberInput(input, baseRun, season, a, level.ops, { storageM3: b.storageM3ByDam });
				if (m.problems.length) {
					problems = m.problems;
					members.length = 0;
					break;
				}
				members.push(outlookMember(bandSnapshot ? runModelFrom(bandSnapshot, m.input) : runModelWithoutChecks(m.input), m.input.model, season, a, options.siteNodeId ?? null));
			}
			return { id: level.id, label: level.label, problems, members };
		});
		return { ...b, levels };
	});
	return reviewTriggerTable({
		reviewDate: options.reviewDate,
		seasonEnd: options.seasonEnd,
		model: input.model,
		analogues,
		excluded,
		bands,
		representative: plan.representative,
		bandSource: plan.bandSource,
		history: plan.history,
		lowestOnRecordM3: plan.lowestOnRecordM3,
		bandWarnings: plan.bandWarnings,
		...(options.metric !== undefined ? { metric: options.metric } : {}),
		siteNodeId: options.siteNodeId ?? null,
		...(options.planningShare !== undefined ? { planningShare: options.planningShare } : {})
	});
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

/**
 * A row in words, counting years, never "recommend", "likely" or "should":
 * "At or above 250 000 m³ on 1 January 2027: 85 % met the EWR on every day
 * of the season in 17 of 21 analogue years." The lowest band reads "Below
 * X m³ … (run from the lowest storage on record for the date, Y m³)" (engine
 * ≥ 1.11.0), or "(run from empty dams)" without one; a midpoint band names
 * the storage it ran from.
 */
export function describeTriggerRow(table: Pick<ReviewTriggers, 'reviewDate' | 'metric' | 'share' | 'representative'>, row: Omit<ReviewTriggerRow, 'outlook'>): string {
	const on = `on ${longDate(table.reviewDate)}`;
	const where =
		row.band.fromM3 > 0
			? `At or above ${m3(row.band.fromM3)} ${on}${table.representative === 'midpoint' ? ` (run from ${m3(row.startStorageM3)})` : ''}`
			: `Below ${m3(row.band.toM3)} ${on} (run from ${
					row.startFrom === 'lowestOnRecord' && table.representative !== 'midpoint'
						? `the lowest storage on record for the date, ${m3(row.startStorageM3)}`
						: row.startStorageM3 > 0
							? m3(row.startStorageM3)
							: 'empty dams'
				})`;
	const what = table.metric === 'reserveMonthsMet' ? 'met the Reserve in every month of the season' : 'met the EWR on every day of the season';
	switch (row.reason) {
		case 'met':
			return `${where}: ${row.level!.label} ${what} in ${row.metYears} of ${row.nYears} analogue years.`;
		case 'noLevelMeets': {
			const most = row.perLevel.reduce((a, r) => (r.yearsMet > a.yearsMet ? r : a), row.perLevel[0]!);
			return `${where}: no demand level ${what} in at least ${Math.round(table.share * 100)} % of the ${row.nYears} analogue years; the most was ${most.yearsMet} of ${row.nYears}, at ${most.label}.`;
		}
		case 'notEnoughYears':
			return `${where}: only ${row.nYears} analogue year${row.nYears === 1 ? '' : 's'}, not enough to judge (at least ${OUTLOOK_MIN_YEARS} are needed).`;
		case 'noLevels':
			return `${where}: no demand level could be run.`;
	}
}

/**
 * A trigger table as WP-3.8's drought restriction rule (engine ≥ 1.46.0,
 * docs/model.md §2.15a and §2.7i): so a run, or a scenario, simulates
 * following the table. The review date's month and day is the rule's review
 * date and the day after the season end its lift date; each row, fullest
 * first, is a level from the band above's lower edge (as a share of the
 * total capacity) down, cutting each part of demand by 1 − its level's
 * demand.scale factor. What the rule can't carry is said in `notes`, never
 * dropped silently: a level op limited to some nodes or months, or on the
 * other water users (the rule cuts every unit's demand all year); a factor
 * above 1 (no cut); a row where no level met the planning rule (the WUA
 * decides: it takes the band above's cuts); a table that isn't monotone (a
 * deeper level cuts at least as much, so each part takes the largest cut of
 * the rows above it); and a fullest band whose level cuts (the rule applies
 * it below 100 %). Rows with the same cuts as the one above merge; rows at
 * the top that cut nothing are no level. `rule` is null when no row cuts
 * anything.
 */
export function restrictionRuleFromTriggers(
	table: Pick<ReviewTriggers, 'reviewDate' | 'seasonEnd' | 'capacityM3'> & { rows: readonly Pick<ReviewTriggerRow, 'band' | 'level'>[] },
	levels: readonly { id: string; label: string; ops: readonly ScenarioOp[] }[]
): { rule: DroughtRestrictionRule | null; notes: string[] } {
	const notes: string[] = [];
	const byId = new Map(levels.map((l) => [l.id, l]));
	const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
	/** A level's cut per part: 1 − the product of its demand.scale factors on every farm, all year. */
	const cutsOf = (id: string): Partial<Record<DemandPart, number>> => {
		const lv = byId.get(id);
		const factor = new Map<DemandPart, number>(DEMAND_PARTS.map((p) => [p, 1]));
		for (const op of lv?.ops ?? []) {
			if (op.op !== 'demand.scale') {
				notes.push(`${lv!.label}: a ${op.op} change isn't a demand level, so the rule doesn't carry it`);
				continue;
			}
			if (op.category === 'user' || (op.nodeIds && op.nodeIds.length) || (op.months && op.months.length)) {
				notes.push(`${lv!.label}: a demand change ${op.category === 'user' ? 'on the other water users' : 'limited to some hydrological units or months'} isn't carried; the rule cuts every unit's demand whatever the month`);
				continue;
			}
			for (const p of op.part ? [op.part] : DEMAND_PARTS) factor.set(p, factor.get(p)! * op.factor);
		}
		const cuts: Partial<Record<DemandPart, number>> = {};
		for (const [p, f] of factor) {
			if (f > 1) notes.push(`${lv?.label ?? id}: raises ${p === 'crops' ? 'the crops’' : `the ${p} demand objects’`} demand (× ${f}), which a restriction can't; not cut`);
			if (f < 1) cuts[p] = Math.min(1, Math.max(0, 1 - f));
		}
		return cuts;
	};
	const cap = table.capacityM3;
	const steps: DroughtRestrictionLevel[] = [];
	let prev: Partial<Record<DemandPart, number>> = {};
	table.rows.forEach((row, i) => {
		// A top band of full dams only (storageBands allows an edge at capacity): no storage share is below 100 %
		// there, so its level never applies; the band below it starts below 100 %.
		if (cap > 0 && row.band.fromM3 >= cap) {
			if (row.level && Object.keys(cutsOf(row.level.id)).length) notes.push(`The band of full dams only (${row.level.label}) is no level: a rule reads its levels below a share of capacity`);
			return;
		}
		const below = i === 0 ? 1 : cap > 0 ? Math.min(1, table.rows[i - 1]!.band.fromM3 / cap) : 0;
		let cuts: Partial<Record<DemandPart, number>>;
		if (!row.level) {
			cuts = { ...prev };
			notes.push(`${i === 0 ? 'The fullest band' : `The band below ${pct(below)}`}: no demand level met the planning rule, so it takes the cuts of the band above, for the WUA to decide`);
		} else cuts = cutsOf(row.level.id);
		// A deeper level cuts each part at least as much as the one above (reported, then made so).
		for (const [p, c] of Object.entries(prev) as [DemandPart, number][]) {
			if ((cuts[p] ?? 0) < c) {
				if (row.level) notes.push(`The table isn't monotone: ${row.level.label} below ${pct(below)} cuts ${p === 'crops' ? 'the crops' : `the ${p} demand objects`} less than the band above; the rule keeps the band above's ${pct(c)}`);
				cuts[p] = c;
			}
		}
		const same = DEMAND_PARTS.every((p) => (cuts[p] ?? 0) === (prev[p] ?? 0));
		prev = cuts;
		if (same || !(below > 0)) return;
		// Two bands with one lower edge (a zero-width band) give no storage between them: the deeper band's cuts
		// replace the level above, whose threshold is the same.
		const last = steps.at(-1);
		if (last && !(below < last.belowPct)) {
			notes.push(`Two bands start at ${pct(below)} of capacity: the deeper one's cuts are used from there`);
			steps[steps.length - 1] = { ...(row.level ? { label: row.level.label.trim().slice(0, 60) } : {}), belowPct: last.belowPct, cuts };
			return;
		}
		if (i === 0) notes.push(`The fullest band's level (${row.level?.label ?? 'none'}) cuts demand too: the rule applies it whenever the dams are below 100 %`);
		steps.push({ ...(row.level ? { label: row.level.label.trim().slice(0, 60) } : {}), belowPct: Math.min(1, below), cuts });
	});
	if (!steps.length) return { rule: null, notes: [...notes, 'No band’s level cuts demand, so there is no restriction to apply'] };
	const md = (iso: string) => iso.slice(5);
	// The lift date: the day after the season end; 29 February is no setting, so a season ending 28 February lifts 1 March.
	let lift = md(fromEpochDay(toEpochDay(table.seasonEnd) + 1));
	if (lift === '02-29') lift = '03-01';
	const review = md(table.reviewDate) === '02-29' ? '03-01' : md(table.reviewDate);
	const rule: DroughtRestrictionRule = {
		reviewDates: [review],
		...(lift !== review ? { liftDates: [lift] } : {}),
		levels: steps.slice(0, RESTRICTION_LEVELS_MAX),
		source: `Review triggers from the seasonal outlook, reviewed on ${review}, season to ${md(table.seasonEnd)}`
	};
	if (steps.length > RESTRICTION_LEVELS_MAX) notes.push(`Only the first ${RESTRICTION_LEVELS_MAX} levels are kept`);
	// A rule a save would refuse is never offered: its first problem is said instead.
	const bad = droughtRestrictionIssues(rule)[0];
	if (bad) return { rule: null, notes: [...notes, `The table doesn't make a rule that can be saved: ${bad.field ? `${bad.field} ` : ''}${bad.message}`] };
	return { rule, notes };
}
