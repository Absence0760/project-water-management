// The report's observed wet days (report format evidence-21, issue #604
// R5-C; docs/evidence-pack.md § Observed wet days): for each of the
// applicant's own traced dams, how many dates in the baseline run's period
// Digital Earth Africa's WOfS saw it wet, how many dry, and how many were
// inconclusive. Satellite evidence beside the model, never an input to it.
//
// The backend reads the dams' WOfS rows (249 dam_observation, source 'wofs',
// under the reader's RLS) for the period; this freezes every one into the
// report, so the manifest's hash covers them and reproduce:pack classifies
// them again from the manifest (checkDamObservations). The rule (provisional,
// docs/evidence-pack.md § Observed wet days says why):
//
//   WET           at least WET_MIN_PIXELS (2) wet pixels, at any clear share:
//                 proof of water needs no full view, and two pixels screen
//                 out single-pixel shoreline, shadow or wet-soil noise
//   DRY           no wet pixel, with at least DRY_MIN_CLEAR_PCT (99) % of the
//                 outline seen clearly: a 90 %-clear view can miss the last
//                 pool at the wall, the low-storage case an assessor cares about
//   INCONCLUSIVE  anything else (one wet pixel, or no water seen on a view
//                 under 99 % clear), counted apart
//
// A row holds the wet area, not the pixel count: the count is the wet area
// over WOFS_PIXEL_AREA_M2 (a 30 m pixel's nominal 900 m²), rounded. The UTM
// scale moves a pixel's ground area by under 0.2 % across a zone, so the
// rounding gives the pass's own count; 2 pixels is about 1,800 m².
//
// Only an applicant's own units' dams are listed, by the same rule as § 5
// (decision D3): a team scenario's units are an editor's choice, and
// baseline evidence names no one's farm, so neither has the section (null).
import type { RunInputsSnapshot } from '../compare';

/** Bumped when the section's shape or its counting changes. */
export const DAM_OBSERVATIONS_VERSION = 'dam-obs-1';
/** The attribution printed wherever the counts show (CC BY 4.0). */
export const WOFS_CITATION = 'Digital Earth Africa WOfS, CC BY 4.0';
/** A date is wet when at least this many pixels of the outline were water, at any clear share. */
export const WET_MIN_PIXELS = 2;
/** A date is dry when no pixel was water and at least this share (%) of the outline was seen clearly. */
export const DRY_MIN_CLEAR_PCT = 99;
/** A WOfS pixel's nominal ground area (30 m × 30 m): a row's wet area over it, rounded, is its wet pixel count. */
export const WOFS_PIXEL_AREA_M2 = 900;

/** One of the project's traced dams, with its WOfS rows inside the period, as the backend read them. */
export interface EvidenceDamObservationInput {
	/** The dam's map feature (152 map_feature, kind 'dam'). */
	featureId: string;
	/** '' = unnamed. */
	name: string;
	nodeId: string | null;
	/** dam_observation rows (source 'wofs'), any order, one a date. */
	rows: { date: string; wetAreaM2: number; pctObserved: number }[];
}

/** How one date reads under the rule (see the header). */
export type DamDateClass = 'wet' | 'dry' | 'inconclusive';

/** A row's wet pixel count: its wet area over the nominal pixel area, rounded. */
export const wetPixels = (wetAreaM2: number) => Math.round(wetAreaM2 / WOFS_PIXEL_AREA_M2);

/** One date under the rule (see the header). */
export function classifyDamDate(wetAreaM2: number, pctObserved: number): DamDateClass {
	const px = wetPixels(wetAreaM2);
	if (px >= WET_MIN_PIXELS) return 'wet';
	if (wetAreaM2 === 0 && pctObserved >= DRY_MIN_CLEAR_PCT) return 'dry';
	return 'inconclusive';
}

export interface EvidenceDamObservation {
	featureId: string;
	/** The feature's name, else its unit's, else ''. */
	name: string;
	nodeId: string | null;
	/** Dates with a WOfS row in the period: `dates`' length. */
	observedDates: number;
	/** Dates with at least WET_MIN_PIXELS wet pixels. */
	wetDates: number;
	/** Dates with no wet pixel, seen at least DRY_MIN_CLEAR_PCT % clearly. */
	dryDates: number;
	/** The rest: neither wet nor dry under the rule. */
	inconclusiveDates: number;
	/** Every observed date, oldest first: [ISO date, wet area m², % of the outline seen clearly]. Frozen, so the counts can be checked. */
	dates: [string, number, number][];
}

export interface EvidenceDamObservations {
	version: typeof DAM_OBSERVATIONS_VERSION;
	source: 'wofs';
	citation: typeof WOFS_CITATION;
	/** The period counted: the baseline run's. */
	startDate: string;
	endDate: string;
	/** The rule the counts follow (see the header), frozen with them. */
	wetMinPixels: number;
	dryMinClearPct: number;
	pixelAreaM2: number;
	/** The applicant's own dams, by name then id; [] when they have none traced. */
	dams: EvidenceDamObservation[];
}

/** A node's name in the runs' stored models (the application's first), or null. */
const nodeName = (models: (RunInputsSnapshot['model'] | undefined)[], id: string | null) =>
	id ? (models.flatMap((m) => ((m as { nodes?: { id: string; name: string }[] } | undefined)?.nodes ?? []).filter((n) => n.id === id).map((n) => n.name)).at(0) ?? null) : null;

const counts = (dates: readonly (readonly [string, number, number])[]) => {
	let wet = 0;
	let dry = 0;
	for (const [, w, p] of dates) {
		const c = classifyDamDate(w, p);
		if (c === 'wet') wet++;
		else if (c === 'dry') dry++;
	}
	return { wetDates: wet, dryDates: dry, inconclusiveDates: dates.length - wet - dry };
};

/** The section (see the header), or null when the report isn't an applicant's application. Throws on a date given twice for one dam. */
export function damObservationsSection(
	dams: readonly EvidenceDamObservationInput[] | null | undefined,
	ctx: { applicant: boolean; ownNodeIds: readonly string[]; startDate: string; endDate: string; models: (RunInputsSnapshot['model'] | undefined)[] }
): EvidenceDamObservations | null {
	if (!ctx.applicant) return null;
	const own = new Set(ctx.ownNodeIds);
	const out: EvidenceDamObservation[] = [];
	for (const d of dams ?? []) {
		if (!d.nodeId || !own.has(d.nodeId)) continue;
		const byDate = new Map<string, { wetAreaM2: number; pctObserved: number }>();
		for (const r of d.rows) {
			// dam_observation holds one row a dam and date (UNIQUE (feature_id, source, obs_date)): a repeat is a bug upstream, never settled by the last row.
			if (byDate.has(r.date)) throw new Error(`dam ${d.featureId} has two WOfS rows for ${r.date}`);
			byDate.set(r.date, r);
		}
		const dates = [...byDate]
			.filter(([date]) => date >= ctx.startDate && date <= ctx.endDate)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([date, r]): [string, number, number] => [date, r.wetAreaM2, r.pctObserved]);
		out.push({
			featureId: d.featureId,
			name: d.name || nodeName(ctx.models, d.nodeId) || '',
			nodeId: d.nodeId,
			observedDates: dates.length,
			...counts(dates),
			dates
		});
	}
	out.sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.featureId < b.featureId ? -1 : 1));
	return {
		version: DAM_OBSERVATIONS_VERSION,
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

/**
 * Problems with a frozen section, classified again from its own dates: []
 * when it holds. reproduce:pack runs it on the manifest (bundle.ts), with the
 * baseline's period as the manifest records it (`identity.baseline`) and the
 * engine that built the report (`builtBy`).
 */
export function checkDamObservations(s: EvidenceDamObservations, ctx: { period?: { startDate: string; endDate: string }; builtBy?: string } = {}): string[] {
	const problems: string[] = [];
	if (s.version !== DAM_OBSERVATIONS_VERSION) {
		return [`the observed wet days were counted by ${String(s.version)}; this code counts ${DAM_OBSERVATIONS_VERSION}${ctx.builtBy ? `: check out the engine that built the report (${ctx.builtBy})` : ''}`];
	}
	if (s.wetMinPixels !== WET_MIN_PIXELS || s.dryMinClearPct !== DRY_MIN_CLEAR_PCT || s.pixelAreaM2 !== WOFS_PIXEL_AREA_M2) {
		problems.push(
			`the rule is ${String(s.wetMinPixels)} wet pixels of ${String(s.pixelAreaM2)} m² and ${String(s.dryMinClearPct)} % clear for dry, not ${WET_MIN_PIXELS} of ${WOFS_PIXEL_AREA_M2} m² and ${DRY_MIN_CLEAR_PCT} %`
		);
	}
	if (!ISO_DAY.test(String(s.startDate)) || !ISO_DAY.test(String(s.endDate))) problems.push(`the period ${String(s.startDate)}–${String(s.endDate)} is not two ISO dates`);
	if (ctx.period && (s.startDate !== ctx.period.startDate || s.endDate !== ctx.period.endDate)) {
		problems.push(`the observed wet days count ${String(s.startDate)}–${String(s.endDate)}, not the baseline run's period ${ctx.period.startDate}–${ctx.period.endDate} the manifest records`);
	}
	if (!Array.isArray(s.dams)) return [...problems, 'the dams are not a list'];
	for (const d of s.dams) {
		const id = String(d.featureId);
		if (!Array.isArray(d.dates)) {
			problems.push(`dam ${id}: its dates are not a list`);
			continue;
		}
		const shapeOk = d.dates.every((r) => Array.isArray(r) && r.length === 3 && typeof r[0] === 'string' && ISO_DAY.test(r[0]));
		if (!shapeOk) {
			problems.push(`dam ${id}: a date is not an ISO date with its wet area and share seen`);
			continue;
		}
		const dates = d.dates.map(([date]) => date);
		if (dates.some((x, i) => i > 0 && x <= dates[i - 1]!)) problems.push(`dam ${id}: its dates are not in order, or repeat`);
		if (dates.some((x) => x < s.startDate || x > s.endDate)) problems.push(`dam ${id}: a date is outside ${s.startDate}–${s.endDate}`);
		if (d.dates.some(([, w]) => !(typeof w === 'number' && Number.isFinite(w) && w >= 0))) problems.push(`dam ${id}: a wet area is not a number of square metres`);
		if (d.dates.some(([, , p]) => !(typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 100))) problems.push(`dam ${id}: a share seen is not a percentage`);
		const named = { observedDates: d.observedDates, wetDates: d.wetDates, dryDates: d.dryDates, inconclusiveDates: d.inconclusiveDates };
		const bad = Object.entries(named).filter(([, n]) => !isCount(n));
		if (bad.length) {
			problems.push(`dam ${id}: ${bad.map(([k, n]) => `${k} ${String(n)}`).join(', ')} not a whole number of dates`);
			continue;
		}
		if (d.observedDates !== d.dates.length) problems.push(`dam ${id}: ${d.observedDates} dates observed named, ${d.dates.length} listed`);
		const again = counts(d.dates);
		if (d.wetDates !== again.wetDates) problems.push(`dam ${id}: ${d.wetDates} wet dates named, ${again.wetDates} counted`);
		if (d.dryDates !== again.dryDates) problems.push(`dam ${id}: ${d.dryDates} dry dates named, ${again.dryDates} counted`);
		if (d.inconclusiveDates !== again.inconclusiveDates) problems.push(`dam ${id}: ${d.inconclusiveDates} inconclusive dates named, ${again.inconclusiveDates} counted`);
	}
	return problems;
}
