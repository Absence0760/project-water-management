// The report's observed wet days (§ 7; docs/evidence-pack.md § Observed wet
// days): for each of the applicant's own traced dams, how many dates in the
// baseline run's period a satellite saw it wet, how many dry, and how many
// were inconclusive. Satellite evidence beside the model, never an input to it.
//
// Two counting versions, both checked by reproduce:pack:
//
//   dam-obs-1  report formats evidence-21 to evidence-23 (issue #604 R5-C):
//              Digital Earth Africa's WOfS (Landsat, 30 m) alone, one check
//              (`observations:wofs`). Kept so an issued pack still verifies;
//              no report is built with it any more.
//   dam-obs-2  evidence-24 (issue #624 step 7): Sentinel-2 (10 m, ~5-day, our
//              own MNDWI classification) beside WOfS, each source's dates
//              frozen and counted under its own rule, and the dates either
//              source saw counted together, each date read by the sharper
//              source that could call it. One check per source
//              (`observations:s2`, `observations:wofs`) and one for the
//              dates together (`observations:days`).
//
// The backend reads the dams' rows (dam_observation, sources 'wofs' and 's2',
// under the reader's RLS) for the period; this freezes every one into the
// report, so the manifest's hash covers them and reproduce:pack classifies
// them again. The rule per source (provisional, evidence-pack.md says why):
//
//   WET           at least wetMinPixels wet pixels, at any clear share: proof
//                 of water needs no full view, and the minimum screens out
//                 single-pixel shoreline, shadow or wet-soil noise
//                   WOfS  2 pixels of 900 m² (30 m)
//                   S2    8 pixels of 100 m² (10 m): MNDWI reads B11 and the
//                         SCL cloud mask at 20 m, one 20 m cell holds four
//                         10 m pixels, so 8 is at least two 20 m cells, the
//                         same two-pixel screen at the resolution the water
//                         test is really made at
//   DRY           no wet pixel, with at least 99 % of the outline seen clearly
//                 (both sources): a 90 %-clear view can miss the last pool at
//                 the wall, the low-storage case an assessor cares about
//   INCONCLUSIVE  anything else, counted apart
//
// A row holds the wet area, not the pixel count: the count is the wet area
// over the source's nominal pixel area, rounded. The UTM scale moves a pixel's
// ground area by under 0.2 % across a zone, so the rounding gives back the
// pass's own count.
//
// The dates together (dam-obs-2): every date either source saw, read by the
// first source in EVIDENCE_OBSERVED_SOURCES (Sentinel-2, then WOfS, the
// order of backend dams/observed/compare.ts SOURCE_PRECEDENCE) whose call is
// wet or dry, else inconclusive. So a date both saw counts once, and a
// clouded Sentinel-2 view leaves the date to a clear Landsat one.
//
// Sentinel-1 radar and Waterbodies are not counted: radar is never alone the
// reason a dam is called full or empty (wind roughens water, wet sand reads as
// water), and a Waterbodies polygon is DE Africa's outline, not the dam's.
//
// Only an applicant's own units' dams are listed, by the same rule as § 5
// (decision D3): a team scenario's units are an editor's choice, and
// baseline evidence names no one's farm, so neither has the section (null).
import type { RunInputsSnapshot } from '../compare';
import { SENTINEL_CITATION, sentinelCitation } from './sentinelCredit';

export { SENTINEL_CITATION, sentinelCitation };

/** The counting this code builds: bumped when the section's shape or its counting changes. */
export const DAM_OBSERVATIONS_VERSION = 'dam-obs-2';
/** The counting of evidence-21 to evidence-23 (WOfS alone), still checked so issued packs verify. */
export const DAM_OBSERVATIONS_V1 = 'dam-obs-1';
/** WOfS's attribution, printed wherever its counts show (CC BY 4.0). */
export const WOFS_CITATION = 'Digital Earth Africa WOfS, CC BY 4.0';
/** WOfS: a date is wet when at least this many pixels of the outline were water, at any clear share. */
export const WET_MIN_PIXELS = 2;
/** A date is dry when no pixel was water and at least this share (%) of the outline was seen clearly (both sources). */
export const DRY_MIN_CLEAR_PCT = 99;
/** A WOfS pixel's nominal ground area (30 m × 30 m). */
export const WOFS_PIXEL_AREA_M2 = 900;
/** A Sentinel-2 pixel's nominal ground area (10 m × 10 m): the s2 pass sums 10 m pixels. */
export const S2_PIXEL_AREA_M2 = 100;
/** Sentinel-2: at least two 20 m cells' worth of 10 m pixels (see the header). */
export const S2_WET_MIN_PIXELS = 8;

/** A source counted in § 7 (dam-obs-2). */
export type EvidenceObservedSource = 's2' | 'wofs';
/** The sources, best first: a date both call goes to the sharper one (see the header). */
export const EVIDENCE_OBSERVED_SOURCES: readonly EvidenceObservedSource[] = ['s2', 'wofs'];
/** How each source names itself in the report and the checks. */
export const EVIDENCE_OBSERVED_SOURCE_LABEL: Record<EvidenceObservedSource, string> = { s2: 'Sentinel-2', wofs: 'WOfS' };

/** One source's rule. */
export interface DamObservationRule {
	wetMinPixels: number;
	dryMinClearPct: number;
	pixelAreaM2: number;
}

/** Each source's rule (see the header). */
export const DAM_OBSERVATION_RULES: Record<EvidenceObservedSource, DamObservationRule> = {
	s2: { wetMinPixels: S2_WET_MIN_PIXELS, dryMinClearPct: DRY_MIN_CLEAR_PCT, pixelAreaM2: S2_PIXEL_AREA_M2 },
	wofs: { wetMinPixels: WET_MIN_PIXELS, dryMinClearPct: DRY_MIN_CLEAR_PCT, pixelAreaM2: WOFS_PIXEL_AREA_M2 }
};

/** One of the project's traced dams, with its rows inside the period, as the backend read them. */
export interface EvidenceDamObservationInput {
	/** The dam's map feature (152 map_feature, kind 'dam'). */
	featureId: string;
	/** '' = unnamed. */
	name: string;
	nodeId: string | null;
	/** dam_observation rows (sources 'wofs' and 's2'), any order, one a source and date. */
	rows: { source: EvidenceObservedSource; date: string; wetAreaM2: number; pctObserved: number }[];
}

/** How one date reads under a rule (see the header). */
export type DamDateClass = 'wet' | 'dry' | 'inconclusive';

/** A row's wet pixel count: its wet area over the nominal pixel area (WOfS's by default), rounded. */
export const wetPixels = (wetAreaM2: number, pixelAreaM2: number = WOFS_PIXEL_AREA_M2) => Math.round(wetAreaM2 / pixelAreaM2);

/** One date under a source's rule (WOfS's by default; see the header). */
export function classifyDamDate(wetAreaM2: number, pctObserved: number, rule: DamObservationRule = DAM_OBSERVATION_RULES.wofs): DamDateClass {
	if (wetPixels(wetAreaM2, rule.pixelAreaM2) >= rule.wetMinPixels) return 'wet';
	if (wetAreaM2 === 0 && pctObserved >= rule.dryMinClearPct) return 'dry';
	return 'inconclusive';
}

/** A frozen date: [ISO date, wet area m², % of the outline seen clearly]. */
export type EvidenceDamDate = [string, number, number];

/** The four counts of a list of dates. */
export interface DamDateCounts {
	/** Dates in the list. */
	observedDates: number;
	wetDates: number;
	dryDates: number;
	/** The rest: neither wet nor dry under the rule. */
	inconclusiveDates: number;
}

/** One source's dates for one dam (dam-obs-2), with their counts under that source's rule. */
export interface EvidenceDamSourceDates extends DamDateCounts {
	/** Every date the source saw in the period, oldest first. Frozen, so the counts can be checked. */
	dates: EvidenceDamDate[];
}

/** One dam (dam-obs-2): the dates together, then each source's. */
export interface EvidenceDamObservation extends DamDateCounts {
	featureId: string;
	/** The feature's name, else its unit's, else ''. */
	name: string;
	nodeId: string | null;
	/** Each source's dates and counts; the top-level counts are the dates together (see the header). */
	sources: Record<EvidenceObservedSource, EvidenceDamSourceDates>;
}

/** One source as the section names it (dam-obs-2), in EVIDENCE_OBSERVED_SOURCES order. */
export interface EvidenceDamObservationSource extends DamObservationRule {
	source: EvidenceObservedSource;
	/** Printed wherever its counts show: WOfS's always, Sentinel-2's with the years of its dates (null when it has none). */
	citation: string | null;
}

/** § 7 as evidence-24 freezes it. */
export interface EvidenceDamObservations {
	version: typeof DAM_OBSERVATIONS_VERSION;
	/** The period counted: the baseline run's. */
	startDate: string;
	endDate: string;
	/** The sources, best first, each with its rule, frozen with the counts. */
	sources: EvidenceDamObservationSource[];
	/** The applicant's own dams, by name then id; [] when they have none traced. */
	dams: EvidenceDamObservation[];
}

/** One dam as dam-obs-1 froze it (evidence-21 to evidence-23): WOfS alone. */
export interface EvidenceDamObservationV1 extends DamDateCounts {
	featureId: string;
	name: string;
	nodeId: string | null;
	dates: EvidenceDamDate[];
}

/** § 7 as evidence-21 to evidence-23 froze it: WOfS alone. */
export interface EvidenceDamObservationsV1 {
	version: typeof DAM_OBSERVATIONS_V1;
	source: 'wofs';
	citation: typeof WOFS_CITATION;
	startDate: string;
	endDate: string;
	wetMinPixels: number;
	dryMinClearPct: number;
	pixelAreaM2: number;
	dams: EvidenceDamObservationV1[];
}

/** § 7 in any report: dam-obs-2 from evidence-24, dam-obs-1 in a pack drafted from evidence-21 to evidence-23. */
export type EvidenceDamObservationsAny = EvidenceDamObservations | EvidenceDamObservationsV1;

/** Whether a frozen § 7 is the WOfS-only counting of evidence-21 to evidence-23. */
export const isDamObservationsV1 = (s: EvidenceDamObservationsAny): s is EvidenceDamObservationsV1 => s.version === DAM_OBSERVATIONS_V1;

/** A node's name in the runs' stored models (the application's first), or null. */
const nodeName = (models: (RunInputsSnapshot['model'] | undefined)[], id: string | null) =>
	id ? (models.flatMap((m) => ((m as { nodes?: { id: string; name: string }[] } | undefined)?.nodes ?? []).filter((n) => n.id === id).map((n) => n.name)).at(0) ?? null) : null;

const counts = (dates: readonly (readonly [string, number, number])[], rule: DamObservationRule): DamDateCounts => {
	let wet = 0;
	let dry = 0;
	for (const [, w, p] of dates) {
		const c = classifyDamDate(w, p, rule);
		if (c === 'wet') wet++;
		else if (c === 'dry') dry++;
	}
	return { observedDates: dates.length, wetDates: wet, dryDates: dry, inconclusiveDates: dates.length - wet - dry };
};

/** The dates either source saw, each read by the first source (best first) that calls it wet or dry (see the header). */
export function combinedDamDates(bySource: Record<EvidenceObservedSource, readonly (readonly [string, number, number])[]>): DamDateCounts {
	const calls = new Map<string, DamDateClass>();
	// Worst first, so a better source's call replaces it; an inconclusive one never replaces a call.
	for (const source of [...EVIDENCE_OBSERVED_SOURCES].reverse()) {
		for (const [date, w, p] of bySource[source]) {
			const c = classifyDamDate(w, p, DAM_OBSERVATION_RULES[source]);
			if (c !== 'inconclusive' || !calls.has(date)) calls.set(date, c);
		}
	}
	let wet = 0;
	let dry = 0;
	for (const c of calls.values()) {
		if (c === 'wet') wet++;
		else if (c === 'dry') dry++;
	}
	return { observedDates: calls.size, wetDates: wet, dryDates: dry, inconclusiveDates: calls.size - wet - dry };
}

const ownDams = (dams: readonly EvidenceDamObservationInput[] | null | undefined, ownNodeIds: readonly string[]) => {
	const own = new Set(ownNodeIds);
	return (dams ?? []).filter((d) => d.nodeId && own.has(d.nodeId));
};

/** A dam's rows of one source inside the period, oldest first; throws on a date given twice. */
const periodDates = (d: EvidenceDamObservationInput, source: EvidenceObservedSource, startDate: string, endDate: string): EvidenceDamDate[] => {
	const byDate = new Map<string, { wetAreaM2: number; pctObserved: number }>();
	for (const r of d.rows) {
		if (r.source !== source) continue;
		// dam_observation holds one row a dam, source and date (UNIQUE (feature_id, source, obs_date)): a repeat is a bug upstream, never settled by the last row.
		if (byDate.has(r.date)) throw new Error(`dam ${d.featureId} has two ${EVIDENCE_OBSERVED_SOURCE_LABEL[source]} rows for ${r.date}`);
		byDate.set(r.date, r);
	}
	return [...byDate]
		.filter(([date]) => date >= startDate && date <= endDate)
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([date, r]): EvidenceDamDate => [date, r.wetAreaM2, r.pctObserved]);
};

const byNameThenId = <T extends { name: string; featureId: string }>(a: T, b: T) =>
	a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.featureId < b.featureId ? -1 : 1;

/** The section (dam-obs-2, see the header), or null when the report isn't an applicant's application. Throws on a date given twice for one dam and source. */
export function damObservationsSection(
	dams: readonly EvidenceDamObservationInput[] | null | undefined,
	ctx: { applicant: boolean; ownNodeIds: readonly string[]; startDate: string; endDate: string; models: (RunInputsSnapshot['model'] | undefined)[] }
): EvidenceDamObservations | null {
	if (!ctx.applicant) return null;
	const out: EvidenceDamObservation[] = [];
	for (const d of ownDams(dams, ctx.ownNodeIds)) {
		const s2 = periodDates(d, 's2', ctx.startDate, ctx.endDate);
		const wofs = periodDates(d, 'wofs', ctx.startDate, ctx.endDate);
		out.push({
			featureId: d.featureId,
			name: d.name || nodeName(ctx.models, d.nodeId) || '',
			nodeId: d.nodeId,
			...combinedDamDates({ s2, wofs }),
			sources: {
				s2: { ...counts(s2, DAM_OBSERVATION_RULES.s2), dates: s2 },
				wofs: { ...counts(wofs, DAM_OBSERVATION_RULES.wofs), dates: wofs }
			}
		});
	}
	out.sort(byNameThenId);
	return {
		version: DAM_OBSERVATIONS_VERSION,
		startDate: ctx.startDate,
		endDate: ctx.endDate,
		sources: EVIDENCE_OBSERVED_SOURCES.map((source) => ({
			source,
			citation: source === 'wofs' ? WOFS_CITATION : sentinelCitation(out.flatMap((d) => d.sources.s2.dates.map(([date]) => date))),
			...DAM_OBSERVATION_RULES[source]
		})),
		dams: out
	};
}

/**
 * The section as dam-obs-1 built it (evidence-21 to evidence-23: WOfS rows
 * alone, other sources ignored). No report is built with it any more; it
 * makes the fixtures of a pack drafted then, which must still verify.
 */
export function damObservationsSectionV1(
	dams: readonly EvidenceDamObservationInput[] | null | undefined,
	ctx: { applicant: boolean; ownNodeIds: readonly string[]; startDate: string; endDate: string; models: (RunInputsSnapshot['model'] | undefined)[] }
): EvidenceDamObservationsV1 | null {
	if (!ctx.applicant) return null;
	const out = ownDams(dams, ctx.ownNodeIds).map((d): EvidenceDamObservationV1 => {
		const dates = periodDates(d, 'wofs', ctx.startDate, ctx.endDate);
		return { featureId: d.featureId, name: d.name || nodeName(ctx.models, d.nodeId) || '', nodeId: d.nodeId, ...counts(dates, DAM_OBSERVATION_RULES.wofs), dates };
	});
	out.sort(byNameThenId);
	return {
		version: DAM_OBSERVATIONS_V1,
		source: 'wofs',
		citation: WOFS_CITATION,
		startDate: ctx.startDate,
		endDate: ctx.endDate,
		wetMinPixels: WET_MIN_PIXELS,
		dryMinClearPct: DRY_MIN_CLEAR_PCT,
		pixelAreaM2: WOFS_PIXEL_AREA_M2,
		dams: out
	};
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
type CheckCtx = { period?: { startDate: string; endDate: string }; builtBy?: string };

/** Problems with a frozen period: not ISO, or not the baseline run's. */
function periodProblems(s: { startDate: unknown; endDate: unknown }, ctx: CheckCtx): string[] {
	const problems: string[] = [];
	if (!ISO_DAY.test(String(s.startDate)) || !ISO_DAY.test(String(s.endDate))) problems.push(`the period ${String(s.startDate)}–${String(s.endDate)} is not two ISO dates`);
	if (ctx.period && (s.startDate !== ctx.period.startDate || s.endDate !== ctx.period.endDate)) {
		problems.push(`the observed wet days count ${String(s.startDate)}–${String(s.endDate)}, not the baseline run's period ${ctx.period.startDate}–${ctx.period.endDate} the manifest records`);
	}
	return problems;
}

/** Problems with one frozen date list ([] when it reads), prefixed by `who`. `ok` is false when its dates can't be read at all. */
function datesProblems(who: string, dates: unknown, startDate: string, endDate: string): { problems: string[]; ok: boolean } {
	if (!Array.isArray(dates)) return { problems: [`${who}: its dates are not a list`], ok: false };
	const list = dates as unknown[];
	const shapeOk = list.every((r) => Array.isArray(r) && r.length === 3 && typeof r[0] === 'string' && ISO_DAY.test(r[0]));
	if (!shapeOk) return { problems: [`${who}: a date is not an ISO date with its wet area and share seen`], ok: false };
	const rows = list as [string, unknown, unknown][];
	const problems: string[] = [];
	const ds = rows.map(([date]) => date);
	if (ds.some((x, i) => i > 0 && x <= ds[i - 1]!)) problems.push(`${who}: its dates are not in order, or repeat`);
	if (ds.some((x) => x < startDate || x > endDate)) problems.push(`${who}: a date is outside ${startDate}–${endDate}`);
	if (rows.some(([, w]) => !(typeof w === 'number' && Number.isFinite(w) && w >= 0))) problems.push(`${who}: a wet area is not a number of square metres`);
	if (rows.some(([, , p]) => !(typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 100))) problems.push(`${who}: a share seen is not a percentage`);
	return { problems, ok: true };
}

/** Problems with named counts against the counts the dates give, prefixed by `who`. */
function countProblems(who: string, named: Record<keyof DamDateCounts, unknown>, again: DamDateCounts, listed: number | null): string[] {
	const bad = Object.entries(named).filter(([, n]) => !isCount(n));
	if (bad.length) return [`${who}: ${bad.map(([k, n]) => `${k} ${String(n)}`).join(', ')} not a whole number of dates`];
	const problems: string[] = [];
	const n = named as DamDateCounts;
	if (n.observedDates !== (listed ?? again.observedDates)) problems.push(`${who}: ${n.observedDates} dates observed named, ${listed ?? again.observedDates} listed`);
	if (n.wetDates !== again.wetDates) problems.push(`${who}: ${n.wetDates} wet dates named, ${again.wetDates} counted`);
	if (n.dryDates !== again.dryDates) problems.push(`${who}: ${n.dryDates} dry dates named, ${again.dryDates} counted`);
	if (n.inconclusiveDates !== again.inconclusiveDates) problems.push(`${who}: ${n.inconclusiveDates} inconclusive dates named, ${again.inconclusiveDates} counted`);
	return problems;
}

const pickCounts = (d: DamDateCounts) => ({ observedDates: d.observedDates, wetDates: d.wetDates, dryDates: d.dryDates, inconclusiveDates: d.inconclusiveDates });

/** A version neither counting reads: names the engine that built the report. */
const otherVersion = (version: unknown, ctx: CheckCtx) =>
	`the observed wet days were counted by ${String(version)}; this code counts ${DAM_OBSERVATIONS_V1} and ${DAM_OBSERVATIONS_VERSION}${ctx.builtBy ? `: check out the engine that built the report (${ctx.builtBy})` : ''}`;

/** dam-obs-1's problems (WOfS alone; see checkDamObservations). */
function checkV1(s: EvidenceDamObservationsV1, ctx: CheckCtx): string[] {
	const problems: string[] = [];
	if (s.wetMinPixels !== WET_MIN_PIXELS || s.dryMinClearPct !== DRY_MIN_CLEAR_PCT || s.pixelAreaM2 !== WOFS_PIXEL_AREA_M2) {
		problems.push(
			`the rule is ${String(s.wetMinPixels)} wet pixels of ${String(s.pixelAreaM2)} m² and ${String(s.dryMinClearPct)} % clear for dry, not ${WET_MIN_PIXELS} of ${WOFS_PIXEL_AREA_M2} m² and ${DRY_MIN_CLEAR_PCT} %`
		);
	}
	problems.push(...periodProblems(s, ctx));
	if (!Array.isArray(s.dams)) return [...problems, 'the dams are not a list'];
	for (const d of s.dams) {
		const who = `dam ${String(d.featureId)}`;
		const read = datesProblems(who, d.dates, s.startDate, s.endDate);
		problems.push(...read.problems);
		if (!read.ok) continue;
		problems.push(...countProblems(who, pickCounts(d), counts(d.dates, DAM_OBSERVATION_RULES.wofs), d.dates.length));
	}
	return problems;
}

/** The checks of a dam-obs-2 section: one per source, and one for the dates together. */
export type DamObservationCheckKey = EvidenceObservedSource | 'days';

/**
 * Problems with a dam-obs-2 section, per check (see the header): each
 * source's dates classified again under its rule, its rule and citation the
 * code's, and the dates together counted again from both. A problem with the
 * period or the dams' list belongs to every check, since every count rests on it.
 */
export function checkDamObservationsBySource(s: EvidenceDamObservations, ctx: CheckCtx = {}): Record<DamObservationCheckKey, string[]> {
	const out: Record<DamObservationCheckKey, string[]> = { s2: [], wofs: [], days: [] };
	const all = (p: string) => (Object.keys(out) as DamObservationCheckKey[]).forEach((k) => out[k].push(p));
	if (s.version !== DAM_OBSERVATIONS_VERSION) {
		all(otherVersion(s.version, ctx));
		return out;
	}
	periodProblems(s, ctx).forEach(all);
	const listed = Array.isArray(s.sources) ? s.sources.map((x) => x?.source) : [];
	if (listed.join(',') !== EVIDENCE_OBSERVED_SOURCES.join(',')) all(`the sources are ${listed.map(String).join(', ') || 'none'}, not ${EVIDENCE_OBSERVED_SOURCES.join(', ')}`);
	for (const src of Array.isArray(s.sources) ? s.sources : []) {
		const rule = src && DAM_OBSERVATION_RULES[src.source as EvidenceObservedSource];
		if (!rule) continue;
		if (src.wetMinPixels !== rule.wetMinPixels || src.dryMinClearPct !== rule.dryMinClearPct || src.pixelAreaM2 !== rule.pixelAreaM2) {
			const msg = `the ${EVIDENCE_OBSERVED_SOURCE_LABEL[src.source]} rule is ${String(src.wetMinPixels)} wet pixels of ${String(src.pixelAreaM2)} m² and ${String(src.dryMinClearPct)} % clear for dry, not ${rule.wetMinPixels} of ${rule.pixelAreaM2} m² and ${rule.dryMinClearPct} %`;
			out[src.source].push(msg);
			out.days.push(msg);
		}
	}
	if (!Array.isArray(s.dams)) {
		all('the dams are not a list');
		return out;
	}
	const s2Dates: string[] = [];
	for (const d of s.dams) {
		const who = `dam ${String(d.featureId)}`;
		const frozen = (d as { sources?: Partial<Record<EvidenceObservedSource, EvidenceDamSourceDates>> }).sources;
		const readable: Partial<Record<EvidenceObservedSource, EvidenceDamDate[]>> = {};
		for (const source of EVIDENCE_OBSERVED_SOURCES) {
			const label = `${who} (${EVIDENCE_OBSERVED_SOURCE_LABEL[source]})`;
			const x = frozen?.[source];
			if (!x || typeof x !== 'object') {
				out[source].push(`${label}: no dates`);
				continue;
			}
			const read = datesProblems(label, x.dates, s.startDate, s.endDate);
			out[source].push(...read.problems);
			if (!read.ok) continue;
			readable[source] = x.dates;
			if (source === 's2') s2Dates.push(...x.dates.map(([date]) => date));
			out[source].push(...countProblems(label, pickCounts(x), counts(x.dates, DAM_OBSERVATION_RULES[source]), x.dates.length));
		}
		const missing = EVIDENCE_OBSERVED_SOURCES.filter((src) => !readable[src]);
		if (missing.length) {
			out.days.push(`${who}: the dates together can't be counted without its ${missing.map((m) => EVIDENCE_OBSERVED_SOURCE_LABEL[m]).join(' and ')} dates`);
			continue;
		}
		out.days.push(...countProblems(who, pickCounts(d), combinedDamDates(readable as Record<EvidenceObservedSource, EvidenceDamDate[]>), null));
	}
	// The credit names the years of the dates it covers, so a credit for other years (or none for Sentinel values) is a problem.
	const s2 = Array.isArray(s.sources) ? s.sources.find((x) => x?.source === 's2') : undefined;
	const credit = sentinelCitation(s2Dates);
	if (s2 && s2.citation !== credit) out.s2.push(`the Sentinel-2 credit is ${JSON.stringify(s2.citation)}, not ${JSON.stringify(credit)} for the dates it covers`);
	const wofs = Array.isArray(s.sources) ? s.sources.find((x) => x?.source === 'wofs') : undefined;
	if (wofs && wofs.citation !== WOFS_CITATION) out.wofs.push(`the WOfS credit is ${JSON.stringify(wofs.citation)}, not ${JSON.stringify(WOFS_CITATION)}`);
	return out;
}

/**
 * Problems with a frozen section, classified again from its own dates: []
 * when it holds. Either counting: dam-obs-1 (evidence-21 to evidence-23) as
 * it was, dam-obs-2 every check's problems together. reproduce:pack runs it
 * on the manifest (bundle.ts), with the baseline's period as the manifest
 * records it (`identity.baseline`) and the engine that built the report
 * (`builtBy`).
 */
export function checkDamObservations(s: EvidenceDamObservationsAny, ctx: CheckCtx = {}): string[] {
	if (isDamObservationsV1(s)) return checkV1(s, ctx);
	const version: unknown = s.version;
	if (version !== DAM_OBSERVATIONS_VERSION) return [otherVersion(version, ctx)];
	const by = checkDamObservationsBySource(s, ctx);
	return [...new Set([...by.s2, ...by.wofs, ...by.days])];
}
