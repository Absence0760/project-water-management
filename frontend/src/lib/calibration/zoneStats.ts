// Calibration locations in a run, a report and an evidence pack (issue #555
// round 4; issue #659, docs/model.md §2.10n, docs/ui.md § Runs & results): one
// row per group, the headline location first, then the others upstream first,
// then the units on the catchment parameters, each with its units (and which
// of them borrow its parameters or came by the rule for units outside every
// location), its parameters, its statistics at its own location and whether
// they are in sample by its own fit, and, from an evidence pack, its period
// and its fit record's scores. Pure; ZoneCalibrationTable.svelte only lays
// the rows out.
import type { CalibrationStats, EvidenceCalibrationZone, RunSummary, UnitRainZoneSummary } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { calibrationSample } from '#lib/components/calibration/sample.js';

export interface ZoneStatsRow {
	key: string;
	name: string;
	/** "Headline · outlet", "Gauge", "No location". */
	what: string;
	units: number;
	/**
	 * Its units by where their parameters come from: a run's, those that aren't its own zone's ("Borrowed: Farm C ·
	 * Outside every location: Farm D"); an evidence pack's (evidence-25), every unit ("Own zone: Farm A · Borrowed:
	 * Farm C"). '' = nothing to say.
	 */
	sources: string;
	params: string;
	/** Days scored at its location; 0 = none. */
	days: number;
	nse: string;
	kge: string;
	pbias: string;
	/** "in-sample", "parameters not from an automatic fit", …; null when not scored or not recorded. */
	sample: string | null;
	/** Whether the row is scored at all (the units on the catchment parameters aren't: no location). */
	scored: boolean;
	/** From an evidence pack (evidence-25): its period, "2010-10-01 – 2015-09-30"; absent from a run's rows and older packs. */
	period?: string;
	/** From an evidence pack: its fit and that fit's scores on its own objective (absent from a run's rows). */
	fit?: { description: string; inSample: string; splitSample: string; dryToWet: string } | null;
}

const num = (v: number | null | undefined, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? fmtNum(v, d) : '–');
const p = (v: number) => fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 2);
const paramsText = (x: { x1: number; x2: number; x3: number; x4: number }) => `X1 ${p(x.x1)} · X2 ${p(x.x2)} · X3 ${p(x.x3)} · X4 ${p(x.x4)}`;

function scored(s: Pick<CalibrationStats, 'days' | 'nse' | 'kge' | 'pbias' | 'fitStatus'> | null | undefined) {
	const on = !!s && s.days > 0;
	return {
		days: on ? s!.days : 0,
		nse: on ? num(s!.nse) : '–',
		kge: on ? num(s!.kge) : '–',
		pbias: on ? num(s!.pbias, 1) : '–',
		sample: on && s!.fitStatus ? calibrationSample(s).qualifier : null
	};
}

type Group = Pick<UnitRainZoneSummary, 'nodeId' | 'kind' | 'headline'>;

/** A group's role in words. Before engine 1.110.0 (no `kind`) the null entry was the calibration site's own zone: the headline. */
function whatOf(z: Group): string {
	if (z.kind === 'default') return 'No location';
	const headline = z.headline || (z.kind === undefined && z.nodeId === null);
	const place = z.kind === 'outlet' ? 'outlet' : 'gauge';
	return headline ? `Headline · ${place}` : place.charAt(0).toUpperCase() + place.slice(1);
}

const isHeadline = (z: Group) => !!z.headline || (z.kind === undefined && z.nodeId === null);

/** The headline first, the others in their order, the catchment-parameter units last. */
function headlineFirst<T extends Group>(zones: readonly T[]): T[] {
	const rank = (z: T) => (isHeadline(z) ? 0 : z.kind === 'default' ? 2 : 1);
	return zones.map((z, i) => ({ z, i })).sort((a, b) => rank(a.z) - rank(b.z) || a.i - b.i).map((x) => x.z);
}

const SOURCE_WORDS: [string, string][] = [
	['zone', 'Own zone'],
	['assigned', 'Borrowed'],
	['rest', 'Outside every location'],
	['default', 'On the catchment parameters']
];

/**
 * Each unit's source in words, "Borrowed: Farm C · Outside every location: Farm D"; '' when there is nothing to
 * say. A run's rows name only the units that aren't the group's own; an evidence pack's (`all`) name every unit.
 */
function sourcesText(members: readonly { name: string; how: string }[], all = false): string {
	return SOURCE_WORDS.filter(([how]) => all || how === 'assigned' || how === 'rest')
		.map(([how, words]) => {
			const names = members.filter((m) => m.how === how).map((m) => m.name);
			return names.length ? `${words}: ${names.join(', ')}` : '';
		})
		.filter(Boolean)
		.join(' · ');
}

const keyOf = (z: Group) => (z.kind === 'default' ? 'default' : z.kind === 'outlet' ? 'outlet' : (z.nodeId ?? 'site'));
const paramsOf = (z: Pick<UnitRainZoneSummary, 'params' | 'fitted' | 'kind'>) =>
	z.kind === 'default' ? `${paramsText(z.params)} (the catchment’s)` : z.fitted ? paramsText(z.params) : `${paramsText(z.params)} (the catchment’s: not fitted yet)`;

/**
 * A run's groups (summary.unitRain.zones) with their statistics: the headline's summary.calibration, every other
 * location's summary.calibrationZones (the outlet's by the outlet node's id, the one no gauge group has); [] without.
 */
export function runZoneRows(summary: Pick<RunSummary, 'unitRain' | 'calibration' | 'calibrationZones'>): ZoneStatsRow[] {
	const zones = summary.unitRain?.zones ?? [];
	const at = new Map((summary.calibrationZones ?? []).map((s) => [s.siteNodeId, s]));
	const gauges = new Set(zones.flatMap((z) => (z.nodeId ? [z.nodeId] : [])));
	const outletStats = (summary.calibrationZones ?? []).find((s) => s.siteNodeId && !gauges.has(s.siteNodeId));
	const names = new Map((summary.unitRain?.units ?? []).map((u) => [u.nodeId, u.name]));
	const source = summary.unitRain?.paramSource ?? {};
	return headlineFirst(zones).map((z) => ({
		key: keyOf(z),
		name: z.name,
		what: whatOf(z),
		units: z.units.length,
		sources: sourcesText(z.units.map((u) => ({ name: names.get(u) ?? u, how: source[u]?.how ?? 'zone' })).sort((a, b) => a.name.localeCompare(b.name))),
		params: paramsOf(z),
		scored: z.kind !== 'default',
		...scored(z.kind === 'default' ? null : isHeadline(z) ? summary.calibration : z.kind === 'outlet' ? outletStats : at.get(z.nodeId!))
	}));
}

/** An evidence report's groups (EvidenceReport.calibrationZones, evidence-22; periods and sources from evidence-25), with each fit's scores; [] without. */
export function evidenceZoneRows(zones: readonly EvidenceCalibrationZone[] | null | undefined): ZoneStatsRow[] {
	return headlineFirst(zones ?? []).map((z) => ({
		key: keyOf(z),
		name: z.name,
		what: whatOf(z),
		units: z.units,
		sources: sourcesText(z.members ?? [], true),
		params: paramsOf(z),
		scored: z.kind !== 'default',
		...scored(z.stats ? { ...z.stats, fitStatus: z.stats.fitStatus ?? undefined } : null),
		...(z.window ? { period: `${z.window.start ?? 'start of record'} – ${z.window.end ?? 'end of record'}` } : {}),
		fit:
			z.kind === 'default'
				? undefined
				: z.fit
					? {
							description: `${z.fit.description}${z.fit.editedParams.length ? `, edited since (${z.fit.editedParams.join(', ')})` : ''}`,
							inSample: num(z.fit.inSample),
							splitSample: z.fit.splitSample === null ? 'not run' : num(z.fit.splitSample),
							dryToWet: z.fit.dryToWet === null ? 'not run' : num(z.fit.dryToWet)
						}
					: null
	}));
}
