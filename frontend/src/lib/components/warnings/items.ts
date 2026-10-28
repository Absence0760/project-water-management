// The Warnings page's items (issue #611, docs/ui.md § Warnings): every
// flagged period of the stored series (engine checkPeriods), plus what only
// the latest run knows (runCheckPeriods: the catchment rain's accumulations,
// the flow record's double-mass breaks), each with its status read from the
// setting a decision writes to, so this page and Settings can never disagree:
//
//   a rain patch: the catchment gauge's zeroRainRuns.missing, any other rain
//     record's rainStations.unreliable[seriesId];
//   a flow exclusion: flowMissing[seriesId];
//   a keep: zeroRainRuns.keepDry (a catchment zero run), keepReadings (a
//     catchment accumulation), else checksKept (the item's id).
//
// Pure: the page builds the settings patch here, saves it through the usual
// settings PATCH and reads the new status back from what the server answers.
// A bulk decision merges the periods it adds (adjacent and overlapping ones
// become one; days a list already covers aren't added again) and refuses,
// never truncates, past a list's cap.
import {
	CHECKS_KEPT_MAX,
	checkPeriods,
	defaultZeroRainSettings,
	doubleMass,
	EXCLUSION_REASON_MAX,
	EXCLUSIONS_MAX,
	exclusionRange,
	FLOW_MISSING_RECORDS_MAX,
	FLOW_RECORD_KINDS,
	fromEpochDay,
	RAIN_RECORD_KINDS,
	resolveDataQuality,
	resolveZeroRain,
	runCheckPeriods,
	SERIES_KINDS,
	seriesDisplayName,
	toEpochDay,
	type CalibrationExclusion,
	type CheckPeriod,
	type CheckPeriodKind,
	type DailySeries,
	type ProjectSettings,
	type RainStationSettings,
	type RunSummary,
	type SeriesKind,
	waterYearLabel
} from '@water-management/engine';
import { firstOutletSeries } from '#lib/series/pick.js';
import { fmtDay, fmtNum, fmtPct } from '#lib/format/number.js';
import { UNRELIABLE_PERIODS_MAX, withRecordList, withUnreliable } from '#lib/components/settings/recordPeriods.js';

/**
 * What a record is to the page: which decisions it takes and where they're written. 'unreadRain' is a rain record
 * the run doesn't read under the project's rain stations (settings.rainStations): a station no area is assigned to
 * (its unreliable periods are read only while it is), a unit's own gauge whose unit has a station, or the catchment
 * gauge while another station stands in for the catchment (its zeroRainRuns lists then read no gauge, prepare.ts).
 * Patching one would change nothing, so it takes Keep only.
 */
export type RecordRole = 'catchmentRain' | 'rain' | 'unreadRain' | 'flow' | 'other';

/**
 * An item's status:
 * - 'open': flagged, nothing decided, and the run uses the days as recorded (or leaves them out of Fit automatically only);
 * - 'patched': a rain period the run reads as missing (and fills), by this page's or Settings' list;
 * - 'excluded': a flow period the run reads as missing for this record;
 * - 'kept': kept as recorded;
 * - 'handled': the run already handles it by default (a zero run set aside, an accumulation spread, a negative
 *   flow read as missing, a zero run CHIRPS reads as dry too).
 */
export type ItemStatus = 'open' | 'patched' | 'excluded' | 'kept' | 'handled';
export const STATUSES: readonly ItemStatus[] = ['open', 'patched', 'excluded', 'kept', 'handled'];

export type StatusFilter = ItemStatus | 'all';
export const STATUS_FILTERS: readonly StatusFilter[] = ['open', 'patched', 'excluded', 'kept', 'handled', 'all'];
export const STATUS_LABEL: Record<StatusFilter, string> = {
	open: 'Open',
	patched: 'Patched',
	excluded: 'Excluded',
	kept: 'Kept',
	handled: 'Handled by default',
	all: 'All'
};

export const CHECK_LABEL: Record<CheckPeriodKind, string> = {
	negative: 'Negative values',
	outlier: 'Outliers',
	flatline: 'Flat stretch',
	zerorun: 'Zero rain run',
	accumulation: 'Accumulation',
	lowvschirps: 'Low vs CHIRPS',
	doublemass: 'Double mass vs CHIRPS',
	flowdoublemass: 'Flow double mass'
};
/** The checks in the order the chips show them. */
export const CHECK_ORDER: readonly CheckPeriodKind[] = ['flatline', 'outlier', 'negative', 'zerorun', 'accumulation', 'lowvschirps', 'doublemass', 'flowdoublemass'];
const NOUN: Record<CheckPeriodKind, [string, string]> = {
	negative: ['negative period', 'negative periods'],
	outlier: ['outlier period', 'outlier periods'],
	flatline: ['flat stretch', 'flat stretches'],
	zerorun: ['zero rain run', 'zero rain runs'],
	accumulation: ['accumulation', 'accumulations'],
	lowvschirps: ['low water year', 'low water years'],
	doublemass: ['double-mass segment', 'double-mass segments'],
	flowdoublemass: ['flow double-mass segment', 'flow double-mass segments']
};

export interface WarningItem extends CheckPeriod {
	role: RecordRole;
	/** The record as the page names it: its name (else its kind) and, for a gauge's or a unit's own record, the node. */
	record: string;
	status: ItemStatus;
}

export interface SeriesLike {
	id: string;
	kind: string;
	name: string;
	siteNodeId?: string | null;
}

/**
 * The record's role: the catchment gauge (the first outlet catchment rain by name, the one a run reads), another rain
 * record, a rain record the run doesn't read (the stations above), a flow record, or anything else. Under a catchment
 * station that is the catchment gauge itself, the gauge's periods go to its unreliable list, as any station's.
 */
export function recordRole(s: SeriesLike, catchmentId: string | null, stations: RainStationSettings | null | undefined = null): RecordRole {
	const catchmentStation = stations?.catchment?.stationId ?? null;
	const unitStations = Object.entries(stations?.units ?? {});
	if (s.kind === 'rain_catchment_mm' && s.id === catchmentId) {
		if (!catchmentStation) return 'catchmentRain';
		return catchmentStation === s.id ? 'rain' : 'unreadRain';
	}
	if (s.kind === 'rain_catchment_mm' && !s.siteNodeId) {
		// Another outlet catchment rain series: read as a station only while an area is assigned to it.
		const assigned = catchmentStation === s.id || unitStations.some(([, a]) => a?.stationId === s.id);
		return assigned ? 'rain' : 'unreadRain';
	}
	// A unit's own gauge: not read while a station stands in for its unit.
	if (s.kind === 'rain_catchment_mm' && s.siteNodeId && unitStations.some(([unit, a]) => unit === s.siteNodeId && a?.stationId)) return 'unreadRain';
	if ((RAIN_RECORD_KINDS as readonly string[]).includes(s.kind)) return 'rain';
	if ((FLOW_RECORD_KINDS as readonly string[]).includes(s.kind)) return 'flow';
	return 'other';
}

/** The record's name on the page. */
export function recordName(s: SeriesLike, nodeName: (id: string) => string | null | undefined = () => null): string {
	const site = s.siteNodeId ? (nodeName(s.siteNodeId) ?? 'a unit no longer in the model') : null;
	return `${seriesDisplayName(s.kind, s.name)}${site ? ` (${site})` : ''}`;
}

/** What the page reads to list the items. */
export interface ItemSources {
	series: readonly SeriesLike[];
	/** Loaded values by series id; a series without them isn't checked yet. */
	values: Readonly<Record<string, { startDate: string; values: (number | null)[] } | undefined>>;
	settings: ProjectSettings | null | undefined;
	/** The latest run's summary (its accumulation windows and flow double mass); null without a run. */
	run?: Pick<RunSummary, 'rainAccumulation' | 'plausibility' | 'calibration'> | null;
	nodeName?: (id: string) => string | null | undefined;
}

/**
 * Every flagged period, as the Data tab checks them (series/SeriesTab.svelte): checkPeriods on each stored
 * series of a checked kind, with the catchment CHIRPS for a catchment rain series, the low-vs-CHIRPS years and
 * the double-mass breaks for the catchment gauge only, and negatives read as missing on every other rain
 * record; then the run's own periods. In date order.
 */
export function listPeriods(src: ItemSources): CheckPeriod[] {
	const dq = resolveDataQuality(src.settings?.dataQuality ?? null);
	const catchment = firstOutletSeries(src.series, 'rain_catchment_mm') ?? null;
	const chirpsMeta = firstOutletSeries(src.series, 'rain_chirps_mm') ?? null;
	const chirps = (chirpsMeta && (src.values[chirpsMeta.id] as DailySeries | undefined)) || null;
	const out: CheckPeriod[] = [];
	for (const s of src.series) {
		const v = src.values[s.id] as DailySeries | undefined;
		if (!v || !(SERIES_KINDS as readonly string[]).includes(s.kind)) continue;
		const isCatchment = s.id === catchment?.id;
		const rainCatchment = s.kind === 'rain_catchment_mm';
		const dm = isCatchment && chirps ? doubleMass({ rain_catchment_mm: v, rain_chirps_mm: chirps }, resolveZeroRain(src.settings?.zeroRainRuns ?? null, []), dq) : null;
		out.push(
			...checkPeriods(s.id, s.kind as SeriesKind, v, dq, rainCatchment ? chirps : null, {
				lowVsChirps: isCatchment,
				doubleMass: dm,
				negativeAsMissing: rainCatchment && !isCatchment
			})
		);
	}
	if (src.run) {
		const cal = src.run.calibration;
		out.push(
			...runCheckPeriods(src.run, (kind) => {
				if (kind === 'rain_catchment_mm') return catchment?.id ?? null;
				const site = cal?.siteNodeId;
				const hit = site ? src.series.find((s) => s.kind === kind && s.siteNodeId === site) : firstOutletSeries(src.series, kind);
				return hit?.id ?? null;
			})
		);
	}
	return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- periods as inclusive epoch-day ranges ---

type Range = [number, number];
const rangeOf = (p: { start: string; end: string }): Range => [toEpochDay(p.start), toEpochDay(p.end)];

/** Ranges sorted and joined where they overlap or touch. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
	const s = [...ranges].sort((a, b) => a[0] - b[0]);
	const out: Range[] = [];
	for (const r of s) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
		else out.push([r[0], r[1]]);
	}
	return out;
}

/** The parts of `ranges` that `cut` doesn't cover. */
export function subtractRanges(ranges: readonly Range[], cut: readonly Range[]): Range[] {
	let out = mergeRanges(ranges);
	for (const [a, b] of mergeRanges(cut)) {
		const next: Range[] = [];
		for (const [s, e] of out) {
			if (e < a || s > b) next.push([s, e]);
			else {
				if (s < a) next.push([s, a - 1]);
				if (e > b) next.push([b + 1, e]);
			}
		}
		out = next;
	}
	return out;
}

/** Whether `ranges` cover every day of `r`. */
export function covers(ranges: readonly Range[], r: Range): boolean {
	return subtractRanges([r], ranges).length === 0;
}

const exclusionRanges = (list: readonly CalibrationExclusion[] | null | undefined): Range[] => (list ?? []).map((x) => rangeOf(exclusionRange(x)));
const unreliableOf = (settings: ProjectSettings | null | undefined, id: string): Range[] =>
	(settings?.rainStations?.unreliable?.[id] ?? []).filter((p) => Array.isArray(p) && p[0] <= p[1]).map(([a, b]) => [toEpochDay(a), toEpochDay(b)]);

/** The ranges the run reads as missing for this item's record by the user's lists (patched or excluded). */
function missingRanges(role: RecordRole, seriesId: string, settings: ProjectSettings | null | undefined): Range[] {
	if (role === 'catchmentRain') return exclusionRanges(settings?.zeroRainRuns?.missing);
	if (role === 'rain') return unreliableOf(settings, seriesId);
	if (role === 'flow') return exclusionRanges(settings?.flowMissing?.[seriesId]);
	return [];
}

/** Where a keep goes for this item: the catchment gauge's keep-dry or keep-readings list, else the kept items. */
export function keepTarget(p: Pick<CheckPeriod, 'check'>, role: RecordRole): 'keepDry' | 'keepReadings' | 'checksKept' {
	if (role === 'catchmentRain' && p.check === 'zerorun') return 'keepDry';
	if (role === 'catchmentRain' && p.check === 'accumulation') return 'keepReadings';
	return 'checksKept';
}

/** An accumulation is kept when its reading day (the window's last) is in a keep-readings period, as the engine reads it. */
function isKept(p: CheckPeriod, role: RecordRole, settings: ProjectSettings | null | undefined): boolean {
	const t = keepTarget(p, role);
	if (t === 'keepDry') return covers(exclusionRanges(settings?.zeroRainRuns?.keepDry), rangeOf(p));
	if (t === 'keepReadings') {
		const d = toEpochDay(p.end);
		return covers(exclusionRanges(settings?.zeroRainRuns?.keepReadings), [d, d]);
	}
	return (settings?.checksKept ?? []).includes(p.id);
}

/** The item's status, from the settings its decisions write to. */
export function itemStatus(p: CheckPeriod, role: RecordRole, settings: ProjectSettings | null | undefined): ItemStatus {
	if (isKept(p, role, settings)) return 'kept';
	if (role !== 'other' && covers(missingRanges(role, p.seriesId, settings), rangeOf(p))) return role === 'flow' ? 'excluded' : 'patched';
	if (p.severity === 'info' || p.treatment === 'missing' || p.treatment === 'setAside' || p.treatment === 'spread') return 'handled';
	return 'open';
}

/** The page's items: listPeriods with each record's role, name and the status the settings give it. */
export function warningItems(src: ItemSources): WarningItem[] {
	const byId = new Map(src.series.map((s) => [s.id, s]));
	const catchmentId = firstOutletSeries(src.series, 'rain_catchment_mm')?.id ?? null;
	return listPeriods(src).flatMap((p) => {
		const s = byId.get(p.seriesId);
		if (!s) return [];
		const role = recordRole(s, catchmentId, src.settings?.rainStations);
		return [{ ...p, role, record: recordName(s, src.nodeName), status: itemStatus(p, role, src.settings) }];
	});
}

/** Open items: the Data row's badge and the checks panel's link count these. */
export const openCount = (items: readonly Pick<WarningItem, 'status'>[]): number => items.filter((i) => i.status === 'open').length;

/** What the run does with an item, in words, for its row. */
export function statusDetail(i: WarningItem): string {
	switch (i.status) {
		case 'patched':
			return 'Read as missing and filled like any gap in the rain';
		case 'excluded':
			return 'Read as missing for this record: left out of the calibration scores and checks';
		case 'kept':
			if (keepTarget(i, i.role) === 'keepDry') return 'Kept as dry days';
			if (keepTarget(i, i.role) === 'keepReadings') return 'Kept as one day’s reading';
			if (i.role === 'flow' && (i.check === 'outlier' || i.check === 'flatline')) return 'Kept: scored as read, Fit automatically included';
			if (i.treatment === 'missing') return 'Kept: a negative value is still read as missing';
			if (i.treatment === 'setAside' || i.treatment === 'spread') return 'Kept: the run still handles it as before';
			return 'Kept as recorded';
		case 'handled':
			if (i.severity === 'info') return 'CHIRPS reads it as dry too: kept as dry days';
			if (i.treatment === 'missing') return 'Read as missing by default';
			if (i.treatment === 'setAside') return 'Set aside and filled by default';
			if (i.treatment === 'spread') return 'Spread over its days by default';
			return 'Handled by default';
		case 'open':
			if (i.role === 'unreadRain') return 'Not read by the run: a rain station stands in for it, so there is nothing to patch';
			return i.treatment === 'fitExcluded' ? 'Left out of Fit automatically only: the run’s statistics still score it' : 'Used as recorded';
	}
}

const num = (v: unknown) => (typeof v === 'number' ? v : null);
/** A figure in the record's unit: two decimals for a flow (m³/s), one for millimetres. */
const qty = (v: unknown, kind: string) => (kind.endsWith('_m3s') ? `${fmtNum(num(v), 3, true)} m³/s` : `${fmtNum(num(v), 1, true)} mm`);

/** The period and its length: "11 Oct 2021 – 16 Oct 2021", "6 days". */
export const periodText = (p: Pick<CheckPeriod, 'start' | 'end'>) => (p.start === p.end ? fmtDay(p.start) : `${fmtDay(p.start)} – ${fmtDay(p.end)}`);
export const daysText = (n: number) => `${fmtNum(n)} ${n === 1 ? 'day' : 'days'}`;

/** What the check saw in the period, in words from its params. */
export function whatText(p: Pick<CheckPeriod, 'check' | 'seriesKind' | 'days' | 'end' | 'severity' | 'params'>): string {
	const k = p.seriesKind;
	const q = p.params;
	switch (p.check) {
		case 'negative':
			return `Lowest ${qty(q.min, k)}`;
		case 'outlier':
			return `Up to ${qty(q.max, k)}, over the ${qty(q.limit, k)} limit`;
		case 'flatline':
			return `${qty(q.value, k)} on every day`;
		case 'zerorun':
			return p.severity === 'info'
				? `No rain for ${daysText(p.days)}, and CHIRPS reads it as dry too`
				: `No rain for ${daysText(p.days)}, where about ${qty(q.usualMm, k)} is usual`;
		case 'accumulation':
			return `${qty(q.totalMm, k)} read on ${fmtDay(p.end)} for the ${daysText(p.days)} before it`;
		case 'lowvschirps':
			return `WY ${waterYearLabel(Number(q.waterYear))}: ${qty(q.catchmentMm, k)} against ${qty(q.chirpsMm, k)} from CHIRPS (${fmtPct(num(q.ratio), 0)} of it, usually ${fmtPct(num(q.usualRatio), 0)})`;
		case 'doublemass':
		case 'flowdoublemass': {
			const c = num(q.change);
			return `The double-mass slope changes ${c !== null && c > 0 ? '+' : ''}${fmtPct(c, 0)} after WY ${waterYearLabel(Number(q.afterWaterYear))}`;
		}
	}
}

// --- filters (in the URL: check=, series=, status=) ---

export interface Filters {
	check: CheckPeriodKind | null;
	series: string | null;
	status: StatusFilter;
}

const isCheck = (v: string | null): v is CheckPeriodKind => v !== null && Object.hasOwn(CHECK_LABEL, v);

/** The filters a URL asks for; an unknown value is no filter. Status defaults to open. */
export function parseFilters(q: Pick<URLSearchParams, 'get'>): Filters {
	const check = q.get('check');
	const status = q.get('status');
	return {
		check: isCheck(check) ? check : null,
		series: q.get('series') || null,
		status: status && (STATUS_FILTERS as readonly string[]).includes(status) ? (status as StatusFilter) : 'open'
	};
}

const passes = (i: WarningItem, f: Filters, skip?: keyof Filters) =>
	(skip === 'check' || !f.check || i.check === f.check) &&
	(skip === 'series' || !f.series || i.seriesId === f.series) &&
	(skip === 'status' || f.status === 'all' || i.status === f.status);

export const filterItems = (items: readonly WarningItem[], f: Filters): WarningItem[] => items.filter((i) => passes(i, f));

/**
 * The chips' counts: each group counts the items the other two filters leave, so a chip says how many it would
 * show. `records` in name order, every record with an item (the picked one too, even at 0).
 */
export function filterCounts(items: readonly WarningItem[], f: Filters) {
	const status = Object.fromEntries(STATUS_FILTERS.map((s) => [s, 0])) as Record<StatusFilter, number>;
	const check = new Map<CheckPeriodKind, number>();
	const records = new Map<string, { id: string; label: string; count: number }>();
	let checkAll = 0;
	let recordAll = 0;
	for (const i of items) {
		if (passes(i, f, 'status')) {
			status[i.status]++;
			status.all++;
		}
		if (passes(i, f, 'check')) {
			check.set(i.check, (check.get(i.check) ?? 0) + 1);
			checkAll++;
		}
		const r = records.get(i.seriesId) ?? { id: i.seriesId, label: i.record, count: 0 };
		if (passes(i, f, 'series')) {
			r.count++;
			recordAll++;
		}
		records.set(i.seriesId, r);
	}
	return {
		status,
		check: CHECK_ORDER.filter((c) => check.has(c) || c === f.check).map((c) => ({ check: c, count: check.get(c) ?? 0 })),
		checkAll,
		records: [...records.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
		recordAll
	};
}

// --- decisions ---

export type Decision = 'patch' | 'exclude' | 'keep';

/** The decisions an item takes: a rain record's patch, a flow record's exclusion, and a keep for every item; none once decided (reopen first). */
export function decisionsFor(i: Pick<WarningItem, 'role' | 'status'>): Decision[] {
	if (i.status === 'kept' || i.status === 'patched' || i.status === 'excluded') return [];
	const fix: Decision[] = i.role === 'catchmentRain' || i.role === 'rain' ? ['patch'] : i.role === 'flow' ? ['exclude'] : [];
	return [...fix, 'keep'];
}

export const DECISION_LABEL: Record<Decision, string> = { patch: 'Patch', exclude: 'Exclude from calibration', keep: 'Keep' };
const DECISION_VERB: Record<Decision, string> = { patch: 'patched', exclude: 'excluded from calibration', keep: 'kept' };

/** The settings a decision changes, as the PATCH sends them (the replaced-whole keys in full). */
export type SettingsPatch = Partial<Pick<ProjectSettings, 'zeroRainRuns' | 'rainStations' | 'flowMissing' | 'checksKept'>>;

export type DecisionResult = { ok: true; patch: SettingsPatch; count: number; reason: string } | { ok: false; error: string };

/** "3 flat stretches", "1 zero rain run", or "5 periods" across checks. */
export function itemsNoun(items: readonly Pick<CheckPeriod, 'check'>[]): string {
	const kinds = new Set(items.map((i) => i.check));
	const n = items.length;
	if (kinds.size === 1) {
		const [one, many] = NOUN[[...kinds][0]!];
		return `${n} ${n === 1 ? one : many}`;
	}
	return `${n} ${n === 1 ? 'period' : 'periods'}`;
}

/** The reason a period added by this page keeps: its checks, by name. */
function pieceReason(items: readonly CheckPeriod[], r: Range): string {
	const checks = [...new Set(items.filter((i) => rangeOf(i)[0] <= r[1] && rangeOf(i)[1] >= r[0]).map((i) => CHECK_LABEL[i.check].toLowerCase()))];
	return `Warnings: ${checks.join(', ') || 'flagged period'}`.slice(0, EXCLUSION_REASON_MAX);
}

const asIso = ([a, b]: Range) => ({ start: fromEpochDay(a), end: fromEpochDay(b) });

/** `list` with the days of `items` added as new periods: merged among themselves, minus what the list covers already. */
function addExclusions(list: readonly CalibrationExclusion[] | null | undefined, items: readonly CheckPeriod[], ranges: readonly Range[] = items.map(rangeOf)): CalibrationExclusion[] {
	const pieces = subtractRanges(mergeRanges(ranges), exclusionRanges(list));
	return [...(list ?? []), ...pieces.map((r) => ({ ...asIso(r), reason: pieceReason(items, r) }))];
}

const capError = (what: string, n: number, max: number, fix: string) => `This would list ${n} ${what}, past the ${max} the list keeps: ${fix}.`;

/** The saved zeroRainRuns, whole, with `key` replaced (the backend merges one level deep; the defaults fill an absent setting). */
const zeroRain = (settings: ProjectSettings | null | undefined, key: 'missing' | 'keepDry' | 'keepReadings', list: CalibrationExclusion[]) => ({
	...defaultZeroRainSettings(),
	...(settings?.zeroRainRuns ?? {}),
	[key]: list
});

/**
 * The settings patch one decision on `items` writes (one item, or a bulk selection), with the history's reason
 * ("Warnings: patched 3 flat stretches"). Items the decision doesn't apply to are skipped (a bulk Patch leaves the
 * flow items), and so are those already decided; an empty result is an error. Refused, never truncated, past a
 * list's cap: 100 periods a catchment list or a flow record, 50 flow records, 200 unreliable periods a rain
 * record, 300 kept items.
 */
export function decide(all: readonly WarningItem[], decision: Decision, settings: ProjectSettings | null | undefined): DecisionResult {
	const items = all.filter((i) => decisionsFor(i).includes(decision));
	if (!items.length) return { ok: false, error: `None of these can be ${DECISION_VERB[decision]}.` };
	const patch: SettingsPatch = {};
	if (decision === 'patch') {
		const catchment = items.filter((i) => i.role === 'catchmentRain');
		if (catchment.length) {
			const list = addExclusions(settings?.zeroRainRuns?.missing, catchment);
			if (list.length > EXCLUSIONS_MAX) return { ok: false, error: capError('periods the catchment gauge’s rain is treated as missing in', list.length, EXCLUSIONS_MAX, 'patch fewer at once, or merge neighbouring periods in Model settings → Rain gaps') };
			patch.zeroRainRuns = zeroRain(settings, 'missing', list);
		}
		let rs = settings?.rainStations ?? null;
		for (const [id, group] of groupBy(items.filter((i) => i.role === 'rain'))) {
			const merged = mergeRanges([...unreliableOf(settings, id), ...group.map(rangeOf)]);
			if (merged.length > UNRELIABLE_PERIODS_MAX)
				return { ok: false, error: capError(`unreliable periods for ${group[0]!.record}`, merged.length, UNRELIABLE_PERIODS_MAX, 'patch fewer at once, or merge neighbouring periods in Model settings → Rain gaps') };
			rs = withUnreliable(rs, id, merged.map((r) => { const x = asIso(r); return [x.start, x.end] as [string, string]; }));
		}
		if (items.some((i) => i.role === 'rain')) patch.rainStations = rs;
	} else if (decision === 'exclude') {
		let fm = settings?.flowMissing ?? null;
		for (const [id, group] of groupBy(items)) {
			const list = addExclusions(fm?.[id], group);
			if (list.length > EXCLUSIONS_MAX) return { ok: false, error: capError(`missing periods for ${group[0]!.record}`, list.length, EXCLUSIONS_MAX, 'exclude fewer at once, or merge neighbouring periods on Calibration → Calibration record') };
			fm = withRecordList(fm, id, list);
		}
		if (Object.keys(fm ?? {}).length > FLOW_MISSING_RECORDS_MAX) return { ok: false, error: `This would list missing periods for ${Object.keys(fm!).length} flow records, past the ${FLOW_MISSING_RECORDS_MAX} the setting keeps.` };
		patch.flowMissing = fm;
	} else {
		const dry = items.filter((i) => keepTarget(i, i.role) === 'keepDry');
		const readings = items.filter((i) => keepTarget(i, i.role) === 'keepReadings');
		const ids = items.filter((i) => keepTarget(i, i.role) === 'checksKept').map((i) => i.id);
		let zr: ProjectSettings['zeroRainRuns'] | undefined;
		if (dry.length) {
			const list = addExclusions(settings?.zeroRainRuns?.keepDry, dry);
			if (list.length > EXCLUSIONS_MAX) return { ok: false, error: capError('periods kept as dry', list.length, EXCLUSIONS_MAX, 'keep fewer at once, or merge neighbouring periods in Model settings → Rain gaps') };
			zr = zeroRain(settings, 'keepDry', list);
		}
		if (readings.length) {
			// The reading day is what the engine matches: keep each accumulation's last day.
			const list = addExclusions(settings?.zeroRainRuns?.keepReadings, readings, readings.map((i) => { const d = toEpochDay(i.end); return [d, d] as Range; }));
			if (list.length > EXCLUSIONS_MAX) return { ok: false, error: capError('readings kept as one day’s rain', list.length, EXCLUSIONS_MAX, 'keep fewer at once, or merge neighbouring periods in Model settings → Rain gaps') };
			zr = { ...(zr ?? zeroRain(settings, 'keepReadings', list)), keepReadings: list };
		}
		if (zr) patch.zeroRainRuns = zr;
		if (ids.length) {
			const kept = [...new Set([...(settings?.checksKept ?? []), ...ids])];
			if (kept.length > CHECKS_KEPT_MAX) return { ok: false, error: capError('kept checks', kept.length, CHECKS_KEPT_MAX, 'reopen some kept checks before keeping more') };
			patch.checksKept = kept;
		}
	}
	return { ok: true, patch, count: items.length, reason: `Warnings: ${DECISION_VERB[decision]} ${itemsNoun(items)}` };
}

function groupBy(items: readonly WarningItem[]): Map<string, WarningItem[]> {
	const m = new Map<string, WarningItem[]>();
	for (const i of items) m.set(i.seriesId, [...(m.get(i.seriesId) ?? []), i]);
	return m;
}

/** `list` without the days of `r`: an entry inside it goes, one it cuts is trimmed (a water year becomes its dates). */
function cutExclusions(list: readonly CalibrationExclusion[] | null | undefined, r: Range): CalibrationExclusion[] {
	return (list ?? []).flatMap((x) => {
		const xr = rangeOf(exclusionRange(x));
		if (xr[1] < r[0] || xr[0] > r[1]) return [x];
		return subtractRanges([xr], [r]).map((p) => ({ ...asIso(p), reason: x.reason }));
	});
}

/**
 * The settings patch that reopens a decided item: its days out of the list that patched, excluded or kept it
 * (a period of the list that covers more is cut to what is left), or its id out of the kept items. Null when
 * nothing decided it.
 */
export function reopen(i: WarningItem, settings: ProjectSettings | null | undefined): { patch: SettingsPatch; reason: string } | null {
	const r = rangeOf(i);
	const reason = `Warnings: reopened ${itemsNoun([i])}`;
	if (i.status === 'kept') {
		const t = keepTarget(i, i.role);
		if (t === 'keepDry') return { patch: { zeroRainRuns: zeroRain(settings, 'keepDry', cutExclusions(settings?.zeroRainRuns?.keepDry, r)) }, reason };
		if (t === 'keepReadings') {
			const d = toEpochDay(i.end);
			return { patch: { zeroRainRuns: zeroRain(settings, 'keepReadings', cutExclusions(settings?.zeroRainRuns?.keepReadings, [d, d])) }, reason };
		}
		const kept = (settings?.checksKept ?? []).filter((id) => id !== i.id);
		return { patch: { checksKept: kept.length ? kept : null }, reason };
	}
	if (i.status === 'patched' && i.role === 'catchmentRain') return { patch: { zeroRainRuns: zeroRain(settings, 'missing', cutExclusions(settings?.zeroRainRuns?.missing, r)) }, reason };
	if (i.status === 'patched' && i.role === 'rain') {
		const left = subtractRanges(unreliableOf(settings, i.seriesId), [r]).map((p) => { const x = asIso(p); return [x.start, x.end] as [string, string]; });
		return { patch: { rainStations: withUnreliable(settings?.rainStations ?? null, i.seriesId, left) }, reason };
	}
	if (i.status === 'excluded') return { patch: { flowMissing: withRecordList(settings?.flowMissing ?? null, i.seriesId, cutExclusions(settings?.flowMissing?.[i.seriesId], r)) }, reason };
	return null;
}

/** Where Settings shows the list an item's decision is in: the panel's page and anchor. */
export function settingHref(i: Pick<WarningItem, 'role' | 'check' | 'status'>): string | null {
	if (i.status === 'excluded') return '?tab=calibration#set-record';
	if (i.status === 'patched' || (i.status === 'kept' && (keepTarget(i, i.role) !== 'checksKept'))) return '?tab=settings#set-rain';
	return null;
}
