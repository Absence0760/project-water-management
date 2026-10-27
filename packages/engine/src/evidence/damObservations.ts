// The report's observed wet days (report format evidence-21, issue #604
// R5-C; docs/evidence-pack.md § Observed wet days): for each of the
// applicant's own traced dams, how many dates in the baseline run's period
// Digital Earth Africa's WOfS saw it clearly, and on how many of those it
// held water. Satellite evidence beside the model, never an input to it.
//
// The backend reads the dams' WOfS rows (249 dam_observation, source 'wofs',
// under the reader's RLS) for the period; this freezes the clear ones into
// the report, so the manifest's hash covers them and reproduce:pack counts
// them again from the manifest (checkDamObservations). A date is CLEAR when
// at least CLEAR_MIN_PCT % of the outline was seen clearly that day (DE
// Africa Waterbodies' own rule for a valid observation), and WET when, on a
// clear date, any of it was water. A date seen less clearly is counted in
// `observedDates` only: a partial view can't say the dam was dry.
//
// Only an applicant's own units' dams are listed, by the same rule as § 5
// (decision D3): a team scenario's units are an editor's choice, and
// baseline evidence names no one's farm, so neither has the section (null).
import type { RunInputsSnapshot } from '../compare';

/** Bumped when the section's shape or its counting changes. */
export const DAM_OBSERVATIONS_VERSION = 'dam-obs-1';
/** The attribution printed wherever the counts show (CC BY 4.0). */
export const WOFS_CITATION = 'Digital Earth Africa WOfS, CC BY 4.0';
/** A date is clear when at least this share of the outline was seen clearly. */
export const CLEAR_MIN_PCT = 90;

/** One of the project's traced dams, with its WOfS rows inside the period, as the backend read them. */
export interface EvidenceDamObservationInput {
	/** The dam's map feature (152 map_feature, kind 'dam'). */
	featureId: string;
	/** '' = unnamed. */
	name: string;
	nodeId: string | null;
	/** dam_observation rows (source 'wofs'), any order. */
	rows: { date: string; wetAreaM2: number; pctObserved: number }[];
}

export interface EvidenceDamObservation {
	featureId: string;
	/** The feature's name, else its unit's, else ''. */
	name: string;
	nodeId: string | null;
	/** Dates with any WOfS row in the period. */
	observedDates: number;
	/** Dates seen at least CLEAR_MIN_PCT % clearly: `clear`'s length. */
	clearDates: number;
	/** Clear dates with water: `clear`'s rows with a wet area above 0. */
	wetDates: number;
	/** The clear dates, oldest first: [ISO date, wet area m²]. Frozen, so the counts can be checked. */
	clear: [string, number][];
}

export interface EvidenceDamObservations {
	version: typeof DAM_OBSERVATIONS_VERSION;
	source: 'wofs';
	citation: typeof WOFS_CITATION;
	/** The period counted: the baseline run's. */
	startDate: string;
	endDate: string;
	clearMinPct: number;
	/** The applicant's own dams, by name then id; [] when they have none traced. */
	dams: EvidenceDamObservation[];
}

/** A node's name in the runs' stored models (the application's first), or null. */
const nodeName = (models: (RunInputsSnapshot['model'] | undefined)[], id: string | null) =>
	id ? (models.flatMap((m) => ((m as { nodes?: { id: string; name: string }[] } | undefined)?.nodes ?? []).filter((n) => n.id === id).map((n) => n.name)).at(0) ?? null) : null;

/** The section (see the header), or null when the report isn't an applicant's application. */
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
		for (const r of d.rows) if (r.date >= ctx.startDate && r.date <= ctx.endDate) byDate.set(r.date, r);
		const clear = [...byDate]
			.filter(([, r]) => r.pctObserved >= CLEAR_MIN_PCT)
			.sort(([a], [b]) => (a < b ? -1 : 1))
			.map(([date, r]): [string, number] => [date, r.wetAreaM2]);
		out.push({
			featureId: d.featureId,
			name: d.name || nodeName(ctx.models, d.nodeId) || '',
			nodeId: d.nodeId,
			observedDates: byDate.size,
			clearDates: clear.length,
			wetDates: clear.filter(([, w]) => w > 0).length,
			clear
		});
	}
	out.sort((a, b) => (a.name !== b.name ? (a.name < b.name ? -1 : 1) : a.featureId < b.featureId ? -1 : 1));
	return { version: DAM_OBSERVATIONS_VERSION, source: 'wofs', citation: WOFS_CITATION, startDate: ctx.startDate, endDate: ctx.endDate, clearMinPct: CLEAR_MIN_PCT, dams: out };
}

/**
 * Problems with a frozen section, counted again from its own clear dates: []
 * when it holds. reproduce:pack runs it on the manifest (bundle.ts).
 */
export function checkDamObservations(s: EvidenceDamObservations): string[] {
	const problems: string[] = [];
	if (s.version !== DAM_OBSERVATIONS_VERSION) return [`the observed wet days were counted by ${String(s.version)}; this code counts ${DAM_OBSERVATIONS_VERSION}`];
	if (s.clearMinPct !== CLEAR_MIN_PCT) problems.push(`the clear threshold is ${s.clearMinPct} %, not ${CLEAR_MIN_PCT} %`);
	for (const d of s.dams) {
		const dates = d.clear.map(([date]) => date);
		if (dates.some((x, i) => i > 0 && x <= dates[i - 1]!)) problems.push(`dam ${d.featureId}: its clear dates are not in order, or repeat`);
		if (dates.some((x) => x < s.startDate || x > s.endDate)) problems.push(`dam ${d.featureId}: a clear date is outside ${s.startDate}–${s.endDate}`);
		if (d.clear.some(([, w]) => !(Number.isFinite(w) && w >= 0))) problems.push(`dam ${d.featureId}: a wet area is not a number of square metres`);
		if (d.clearDates !== d.clear.length) problems.push(`dam ${d.featureId}: ${d.clearDates} clear dates named, ${d.clear.length} listed`);
		const wet = d.clear.filter(([, w]) => w > 0).length;
		if (d.wetDates !== wet) problems.push(`dam ${d.featureId}: ${d.wetDates} wet dates named, ${wet} counted`);
		if (d.observedDates < d.clearDates) problems.push(`dam ${d.featureId}: fewer dates observed than clear`);
	}
	return problems;
}
