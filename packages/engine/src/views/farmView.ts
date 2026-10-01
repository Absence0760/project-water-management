// The farmer-facing projection of a published run, and the farm-view payload
// built from it: the contract between WP-2.3 (publication, which computes and
// stores a FarmProjection per farm) and WP-2.6 (the phone-first farmer view,
// which renders a FarmView). Design and field-by-field sources:
// docs/design/farmer-view.md §3 and §4 (asks E1–E10).
//
// Types and shared constants only. farmProjection() (WP-2.3) fills these from
// a run; the frontend (WP-2.6) formats them. Volumes are m³ and m³/day,
// fractions 0–1, dates ISO 'YYYY-MM-DD', months 'YYYY-MM'. Nothing here
// names or counts another farm except FarmContext's anonymised counts.
import type { FarmOutlookProjection } from './farmOutlook';
import type { NoticeText } from './notice';

/** Totals over a window of days (inclusive). */
export interface WindowTotals {
	from: string;
	to: string;
	demandM3: number;
	suppliedM3: number;
	/** supplied ÷ demand; null when demand is under DEMAND_PCT_FLOOR_M3_DAY × days (no % of almost nothing). */
	fraction: number | null;
}

/** The season: 1 Oct (water-year start) to dataUntil. */
export interface SeasonTotals extends WindowTotals {
	/** Days with a deficit (demand not met). */
	shortDays: number;
	/** The months those days fall in, 'YYYY-MM', ascending. */
	shortMonths: string[];
	/** Of shortDays, how many had the dam at or below its stop level (all of them for a dam farm, by the engine's rule). */
	shortDaysAtStopLevel: number;
}

export interface DamState {
	/** Storage ÷ capacity on dataUntil, 0–1. */
	pct: number;
	storageM3: number;
	/** Storage above capacity × damMinPct, floored at 0; null when damMinPct is 0 (no stop level set: design §3 Q3). */
	usableM3: number | null;
	/** Storage ÷ capacity 30 days before dataUntil. */
	pct30dAgo: number;
	/**
	 * Storage 30 days before dataUntil, m³ (engine ≥ 1.30.0): the 30-day change
	 * when the capacity changed between the two days. Absent on a view
	 * published before it.
	 */
	storage30dAgoM3?: number;
	/** Last day with spill > 0 within the run up to dataUntil; null if none. */
	lastSpill: string | null;
	/** Mean supplied over the 14 days to dataUntil (m³/day). */
	use14M3Day: number;
	/** usableM3 ÷ use14M3Day; null when either is null or use is 0. */
	usableDays: number | null;
}

export interface MonthTotals {
	/** 'YYYY-MM'; the last one may be partial (to dataUntil). */
	month: string;
	demandM3: number;
	suppliedM3: number;
	/** Dam storage ÷ capacity at the month's last day (or dataUntil); null without a dam. */
	damPctEnd: number | null;
}

/** An EWR site the farm is upstream of, over the season. */
export interface RiverSite {
	/** The gauge's name, or the outlet's. Gauges are public infrastructure. */
	name: string;
	daysNotMet: number;
	/** Of daysNotMet, days whose shortfall was wholly natural (no charged part). */
	daysOnlyNatural: number;
}

export type ModelBand = 'ok' | 'watch' | 'short';

/** The river's share and the headline (design §3 Q2, §5, §6.2), over the season. Magnitudes are positive. */
export interface RiverShare {
	demandM3Day: number;
	suppliedM3Day: number;
	/** −ewrSupplyCutM3Day, the season average (m³/day, ≥ 0). */
	supplyCutM3Day: number;
	/** −ewrChargeStorageM3Day, the season average (m³/day, ≥ 0). */
	storageM3Day: number;
	/** Days the farm carried an EWR charge (ewr_charge < 0). */
	chargedDays: number;
	/** Days in the season. */
	windowDays: number;
	/** supplyCutM3Day × windowDays ÷ chargedDays; null when chargedDays is 0. */
	perChargedDaySupplyCutM3: number | null;
	/** storageM3Day × windowDays ÷ chargedDays; null when chargedDays is 0. */
	perChargedDayStorageM3: number | null;
	/** E7: (suppliedM3Day − supplyCutM3Day) ÷ demandM3Day, clamped 0–1; null under the demand floor. */
	headline: number | null;
	/** modelBand(headline, storageM3Day); null when headline is null. */
	band: ModelBand | null;
	/** K_tot. null when the viewer's other holders are fewer than FARMER_K − 1 (set per viewer by the API, not stored). */
	equitableFraction: number | null;
	/** N = target − supplied (m³/day): + below the even share, − above. null whenever equitableFraction is. */
	aboveBelowShareM3Day: number | null;
	/** ewrCutBeyondShareM3Day > 0 (design §3 Q2). */
	cutBeyondShare: boolean;
	sites: RiverSite[];
	/** Name of the site that set most of the charge; null when uncharged. */
	bindingSite: string | null;
}

/** What WP-2.3 stores per farm per publication (publication_farm.view). */
export interface FarmProjection {
	nodeId: string;
	name: string;
	/** The dam's capacity on the season's last day (engine ≥ 1.30.0: sediment, an in-service date); 0 without a dam then. */
	damCapacityM3: number;
	damMinPct: number;
	irrigationEfficiency: number;
	/** The run's first day: where "compared with last season" can reach back to. */
	dataFrom: string;
	/** The last day with input data in the run. */
	dataUntil: string;
	season: SeasonTotals;
	last30: WindowTotals;
	/** null when the farm has no dam (damCapacityM3 = 0). */
	dam: DamState | null;
	/** The same season dates one year earlier, from the same run; null when the run doesn't reach back (it starts on dataFrom). */
	lastSeason: { from: string; to: string; fraction: number | null; damPct: number | null } | null;
	/** The 12 calendar months to dataUntil, oldest first. */
	monthly: MonthTotals[];
	river: RiverShare;
	/**
	 * The forecast days after dataUntil (WP-2.12), when the published run is a
	 * forecast run (summary.forecast); absent otherwise. Modelled on forecast
	 * rain, so a guide, never a promise.
	 */
	forecast?: FarmForecast;
}

/** One farm's forecast days (WP-2.12, ../forecast.ts ForecastFarm). Fractions 0–1. */
export interface FarmForecast {
	/** The first and last forecast day (ISO). */
	from: string;
	to: string;
	days: number;
	/** The day the forecast run was made (UTC, ISO). */
	madeOn: string;
	/** Lowest dam storage ÷ capacity on any forecast day; null without a dam. */
	minDamPct: number | null;
	/** The first forecast day at that level (ISO); null without a dam. */
	minDamDate: string | null;
	/** Forecast days the farm is expected to be short. */
	deficitDays: number;
	/** supplied ÷ demand over the days; null without demand. */
	suppliedFraction: number | null;
}

/** Anonymised context (D1 b; app_farm_context). Counts only. */
export interface FarmContext {
	farmsUpstream: number;
	farmsDownstream: number;
	farmCount: number;
}

export type RestrictionLevel = 'none' | 'advisory' | 'restricted';

/** The catchment as the farm pages name it: `wuaName` is the WUA the contact lines name (095_wua_name), null for "your WUA". */
export interface FarmProject {
	id: string;
	name: string;
	wuaName: string | null;
}

/** GET /projects/:id/farm/:nodeId (WP-2.6): everything the farm page renders, in one response. */
export interface FarmView {
	/** `timeZone`: the project's IANA zone (project.time_zone, 058), where "today" is counted. */
	project: FarmProject & { timeZone: string };
	/** Today's date where the catchment is (the project's zone) when the response was built: the page's "today" if it can't work it out itself. */
	today: string;
	farm: FarmProjection;
	context: FarmContext;
	publication: {
		publishedAt: string;
		/** The publisher's display name; null once that account is gone (the page says "A former member" in the reader's language). */
		publishedBy: string | null;
		engineVersion: string;
		restriction: {
			level: RestrictionLevel;
			/** The WUA's percentage, 0–100 (run_publication.restriction_pct), not a fraction. */
			pct: number | null;
			/**
			 * The WUA's notice as it wrote it, by language code (`{}` when it
			 * wrote none). The page shows the one in the reader's language, or
			 * another with a "not translated" line (pickNotice, design §7), so a
			 * language switch or the saved copy on the phone needs no second
			 * request.
			 */
			notice: NoticeText;
		};
		/** E10: when the WUA expects to publish next; null if not set. */
		nextExpectedOn: string | null;
	};
	/** The outlet over the 30 days to dataUntil: days the reserve was not met. Counts, never volumes. */
	outlet30: { name: string; daysNotMet: number; days: number };
	/** dataUntil older than STALE_DAYS (the frontend's freshness rule) when the response was built. */
	stale: boolean;
	/**
	 * The seasonal outlook the WUA published for this farm (issue #53 R5, E3),
	 * with when; absent or null when there is none, it was withdrawn, or its
	 * season has ended.
	 */
	outlook?: (FarmOutlookProjection & { publishedAt: string }) | null;
	/**
	 * The farm's own registered water (issue #72, docs/allocations.md § Who
	 * sees what): the allocations on this farm in force today, summed, never a
	 * name or a registration number. Current, not the publication's: what the
	 * WUA holds on record now. Absent or null when none is in force.
	 */
	registered?: FarmRegistered | null;
}

/** A farm's registered volumes and storage in force on `asOf` (FarmView.registered). Not an entitlement. */
export interface FarmRegistered {
	/** The day they are in force on: today where the catchment is. */
	asOf: string;
	/** Σ of the 21(a) surface-water takes, m³ a year; null when none. */
	surfaceM3PerYear: number | null;
	/** Σ of the 21(a) groundwater takes, m³ a year; null when none. */
	groundwaterM3PerYear: number | null;
	/** Σ of the registered storage (21(b) rows and storage on a take), m³; null when none is stated. */
	storageM3: number | null;
}

/** GET /projects/:id/farm (WP-2.6): the farmer's farms in one project, and whether anything is published. */
export interface FarmIndex {
	project: FarmProject;
	farms: { nodeId: string; name: string }[];
	publication: { publishedAt: string; restriction: { level: RestrictionLevel } } | null;
}

/** GET /projects/:id/farm/:nodeId/series: one of the farm's own daily series (FARMER_SERIES_KEYS) from the published run. */
export interface FarmSeries {
	key: string;
	label: string;
	unit: string | null;
	/** The day of values[0] (ISO). */
	startDate: string;
	/** One per day to the window's end, never past dataUntil; null where the run has no value. */
	values: (number | null)[];
}

/** One publication in GET /projects/:id/farm/:nodeId/history: what it said about this farm, its own figures only. */
export interface FarmHistoryEntry {
	publishedAt: string;
	/** Still the current publication. */
	current: boolean;
	dataUntil: string;
	season: { from: string; to: string; demandM3: number; suppliedM3: number; fraction: number | null; shortDays: number };
	/** The dam on dataUntil (0–1); null without a dam. */
	damPct: number | null;
	/** The model's E7 headline and band (design §6.2): they carry no neighbour's figure, so they show at any k. */
	model: { headline: number | null; band: ModelBand | null };
	/** What the WUA published with it. */
	restriction: { level: RestrictionLevel; pct: number | null };
}

/** k in the aggregate rule (D2, pending the client): catchment aggregates need at least FARMER_K − 1 other holders. */
export const FARMER_K = 5;

/** Band thresholds on the headline (FV-D1, pending the WUA and hydrologist). */
export const MODEL_BAND = { okFrom: 0.9, watchFrom: 0.7 } as const;

/**
 * The model band (design §6.2): ok ≥ 90 % with no storage part above the
 * floor, watch 70–90 % or any storage part at or above the floor, short
 * < 70 %. null when there is no headline. `floorM3Day` is
 * DEMAND_PCT_FLOOR_M3_DAY (1 m³/day), passed in so this file stays free of
 * imports.
 */
export function modelBand(headline: number | null, storageM3Day: number, floorM3Day: number): ModelBand | null {
	if (headline == null || !Number.isFinite(headline)) return null;
	if (headline < MODEL_BAND.watchFrom) return 'short';
	if (headline < MODEL_BAND.okFrom || storageM3Day >= floorM3Day) return 'watch';
	return 'ok';
}
