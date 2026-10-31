// The report's calibration zones (report format evidence-22, issue #555; each
// location's period and each unit's parameter source from evidence-25, issue #659;
// docs/evidence-pack.md § Calibration zones, docs/model.md §2.10n): when the
// baseline ran with calibration zones, every zone's GR4J parameters as its land
// units ran on them, its fit record (the fit, its in-sample score and its
// split-sample and dry → wet scores) and the run's statistics at its gauge,
// each in or out of sample by the zone's own fit, its period, and each of its
// land units with where its parameters come from (its own zone, borrowed by
// Parameters from, or the rule for units outside every location). Rows run
// upstream first, the headline location last, then the units on the catchment
// parameters. Null when the baseline ran one parameter set (no zone applied),
// as every run before engine 1.106.0.
//
// Everything here is read from what the run froze (its summary and its
// settings snapshot), so the manifest's hash covers it and a reproduction
// re-derives it. The section lives in its own module so the report builder
// only calls it (report.ts) and the zones' rules stay in one place.
import type { CalibrationFitStatus, CalibrationStats, RunSummary } from '../project';
import type { RunInputsSnapshot } from '../compare';
import { describeFitRecord } from '../compare';
import { editedParams, type FitRecord } from '../calibrate/provenance';
import { headlineCalibrationSettings, outletNode, pathDown, type UnitParamSource } from '../calibrate/locations';
import { mergeSettings } from '../prepare';
import type { ModelInput } from '../project';
import type { Gr4jParams } from '../runoff/params';

/** One calibration zone in the report (EvidenceReport.calibrationZones). */
export interface EvidenceCalibrationZone {
	/** The zone's gauge node; null = the calibration site's own zone (the outlet's, or Scored at's gauge). */
	nodeId: string | null;
	/** The gauge's name (the site's zone: the site's). */
	name: string;
	/** Its land units: how many, and their area (km², the run's model). */
	units: number;
	areaKm2: number;
	/** The GR4J X1–X4 its units ran on. */
	params: Gr4jParams;
	/** False: the zone had no parameters of its own and its units ran on the catchment's. */
	fitted: boolean;
	/** The fit its parameters came from; null = set by hand, imported or never fitted. */
	fit: EvidenceZoneFit | null;
	/** The run's statistics at the zone's gauge (the site's: the run's calibration statistics); null = none scored. */
	stats: EvidenceZoneStats | null;
	/** A gauge's location, the outlet's, or the units on the catchment's parameters (engine 1.110.0; absent before). */
	kind?: 'gauge' | 'outlet' | 'default';
	/** The headline location (engine 1.110.0): its statistics are the run's calibration statistics. */
	headline?: boolean;
	/**
	 * Its calibration period as the run froze it (evidence-25, issue #659): the gauge row's window, the top level's
	 * for the outlet; null ends are the record's own. Absent on the catchment-parameter units, and before evidence-25.
	 */
	window?: { start: string | null; end: string | null };
	/**
	 * Each land unit in the group and where its parameters come from (evidence-25, summary.unitRain.paramSource):
	 * 'zone' its own zone, 'assigned' borrowed by Parameters from, 'rest' the rule for units outside every
	 * location, 'default' the catchment parameters. Name order. Absent before evidence-25.
	 */
	members?: EvidenceZoneMember[];
}

/** One land unit of a group in the report (EvidenceCalibrationZone.members, evidence-25). */
export interface EvidenceZoneMember {
	nodeId: string;
	name: string;
	how: UnitParamSource['how'];
}

/**
 * A run's settings snapshot in the calibration locations' shape (engine 1.110.0,
 * normalizeCalibrationLocations), or null when the snapshot has no network to
 * read it by (then the stored top level is the site's, as before).
 */
function locatedSettings(inputs: RunInputsSnapshot | null | undefined) {
	const nodes = (inputs?.model as { nodes?: ModelInput['model']['nodes'] } | undefined)?.nodes;
	if (!Array.isArray(nodes)) return null;
	return { settings: mergeSettings((inputs?.settings ?? {}) as ModelInput['settings'], [], nodes), nodes };
}

/**
 * The fit record the run's headline parameters came from (engine 1.110.0,
 * issue #659): the headline location's (a gauge's row, or the top level for
 * the outlet). For a snapshot from before, the top level's, as stored.
 */
export function headlineFitRecord(inputs: RunInputsSnapshot | null | undefined): unknown {
	return (headlineSnapshotSettings(inputs) as { fitRecord?: unknown }).fitRecord ?? null;
}

/**
 * A run's settings as its headline location reads them (engine 1.110.0, issue #659,
 * headlineCalibrationSettings): its window, record, exclusions, parameters and fit record at the top level, the
 * rest the project's. For a snapshot with no network to read it by, its settings as stored (the top level was the
 * site's). What the evidence report's calibration record and validation read.
 */
function headlineSnapshotSettings(inputs: RunInputsSnapshot | null | undefined): RunInputsSnapshot['settings'] {
	const l = locatedSettings(inputs);
	if (!l) return (inputs?.settings ?? {}) as RunInputsSnapshot['settings'];
	return headlineCalibrationSettings(l.settings, l.nodes) as unknown as RunInputsSnapshot['settings'];
}

export interface EvidenceZoneFit {
	/** "GR4J fit of 2026-10-28 10:05 UTC (KGE′, seed 1)" (describeFitRecord). */
	description: string;
	engineVersion: string;
	objective: string;
	/** The fit's objective in sample, on its own window; null when not recorded. */
	inSample: number | null;
	/** The split-sample validation's score on the fit's objective; null = not run. */
	splitSample: number | null;
	/** The dry → wet test's score on the fit's objective; null = not run. */
	dryToWet: number | null;
	/** Parameters edited by hand since the fit (their keys); [] = as fitted. */
	editedParams: string[];
}

export interface EvidenceZoneStats {
	days: number;
	nse: number | null;
	kge: number | null;
	pbias: number | null;
	/** In sample (`fitted`) or not, by the zone's own fit record; null on a run that didn't record it. */
	fitStatus: CalibrationFitStatus | null;
}

type ZoneRow = { nodeId?: unknown; enabled?: unknown; fitRecord?: unknown; calibrationStart?: unknown; calibrationEnd?: unknown };

const isoOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The fit's score on its own objective in a scored period (`{ scores }`), else null. */
function scoreOf(p: unknown, objective: string): number | null {
	const scores = p && typeof p === 'object' ? (p as { scores?: Record<string, unknown> }).scores : undefined;
	return finite(scores?.[objective]);
}

function fitOf(v: unknown, params: Gr4jParams): EvidenceZoneFit | null {
	if (!v || typeof v !== 'object') return null;
	const r = v as FitRecord;
	// Edited since the fit: against the parameters the units ran on, as the run's fitStatus judges it (a stored
	// record's own list is only as fresh as its last save).
	const edited = Array.isArray(r.free) && r.params && typeof r.params === 'object' ? editedParams({ gr4j: { ...params, warmupDays: 0 } }, r) : Array.isArray(r.editedParams) ? r.editedParams.map(String) : [];
	const objective = String(r.objective);
	return {
		description: describeFitRecord(r),
		engineVersion: typeof r.engineVersion === 'string' ? r.engineVersion : '',
		objective,
		inSample: scoreOf(r.fit, objective),
		splitSample: scoreOf(r.splitSample?.validation, objective),
		dryToWet: scoreOf(r.differential?.validation, objective),
		editedParams: edited
	};
}

function statsOf(s: CalibrationStats | null | undefined): EvidenceZoneStats | null {
	if (!s || !(s.days > 0)) return null;
	return { days: s.days, nse: finite(s.nse), kge: finite(s.kge), pbias: finite(s.pbias), fitStatus: s.fitStatus ?? null };
}

/**
 * The baseline's calibration zones, upstream first and the site's own zone last
 * (summary.unitRain.zones' order), or null when the run applied none.
 */
export function calibrationZonesSection(run: { summary: RunSummary; inputs: RunInputsSnapshot }): EvidenceCalibrationZone[] | null {
	const zones = run.summary.unitRain?.zones;
	if (!zones?.length) return null;
	// One location and nothing else (a site at a gauge with no zone, engine 1.110.0): one parameter set, as before.
	if (zones.length === 1 && zones[0]!.headline) return null;
	const raw = (run.inputs?.settings ?? {}) as { calibrationZones?: unknown; fitRecord?: unknown; calibrationStart?: unknown; calibrationEnd?: unknown };
	// Since engine 1.110.0 the rows are read in the locations' shape, so a site's moved fit record is its row's.
	const located = locatedSettings(run.inputs);
	const settings = (located?.settings ?? raw) as typeof raw;
	const rows = (Array.isArray(settings.calibrationZones) ? settings.calibrationZones : []) as ZoneRow[];
	const headlineFit = headlineFitRecord(run.inputs);
	const outletId = located ? (outletNode(located.nodes)?.id ?? null) : null;
	const modelNodes = (run.inputs?.model?.nodes ?? []) as { id: string; name?: unknown; areaKm2?: unknown }[];
	const area = new Map(modelNodes.map((n) => [n.id, finite(n.areaKm2) ?? 0]));
	const nameOf = new Map(modelNodes.map((n) => [n.id, typeof n.name === 'string' ? n.name : n.id]));
	const source = run.summary.unitRain?.paramSource ?? {};
	// A run from before engine 1.110.0 recorded no sources: its calibration site's own zone held the units draining
	// through the site and, as "the rest", every unit below or beside it; read them so from the run's network.
	const legacySiteId = typeof (raw as { calibrationSiteNodeId?: unknown }).calibrationSiteNodeId === 'string' ? (raw as { calibrationSiteNodeId: string }).calibrationSiteNodeId : null;
	const byId = new Map(modelNodes.map((n) => [n.id, n as unknown as { id: string; name: string; kind: 'farm'; downstreamNodeId: string | null }]));
	const legacyHow = (u: string): UnitParamSource['how'] => (legacySiteId === null || !byId.has(legacySiteId) || pathDown(byId as never, u).includes(legacySiteId) ? 'zone' : 'rest');
	const stats = new Map((run.summary.calibrationZones ?? []).map((s) => [s.siteNodeId, s]));
	return zones.map((z) => {
		// Before engine 1.110.0 (no `kind`) the null entry was the site's own zone: the top level and the run's statistics.
		const legacySite = z.nodeId === null && z.kind === undefined;
		const record =
			z.kind === 'default' ? null : z.headline ? headlineFit : legacySite || z.kind === 'outlet' ? settings.fitRecord : rows.find((r) => r.nodeId === z.nodeId && r.enabled === true)?.fitRecord;
		const stat =
			z.kind === 'default' ? null : z.headline || legacySite ? run.summary.calibration : z.kind === 'outlet' ? (outletId ? stats.get(outletId) : undefined) : stats.get(z.nodeId!);
		// The period it fitted and is scored on: a gauge's row, the outlet's (and a legacy site's) top level.
		const row = z.nodeId === null ? null : rows.find((r) => r.nodeId === z.nodeId && r.enabled === true);
		const win = z.kind === 'default' ? null : z.nodeId === null ? settings : (row ?? null);
		const members = z.units
			.map((u): EvidenceZoneMember => ({ nodeId: u, name: nameOf.get(u) ?? u, how: source[u]?.how ?? (z.kind === 'default' ? 'default' : legacySite ? legacyHow(u) : 'zone') }))
			.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : x.nodeId < y.nodeId ? -1 : 1));
		return {
			nodeId: z.nodeId,
			name: z.name,
			units: z.units.length,
			areaKm2: z.units.reduce((a, u) => a + (area.get(u) ?? 0), 0),
			params: { x1: z.params.x1, x2: z.params.x2, x3: z.params.x3, x4: z.params.x4 },
			fitted: z.fitted,
			fit: fitOf(record, z.params),
			stats: statsOf(stat),
			...(z.kind ? { kind: z.kind } : {}),
			...(z.headline ? { headline: true } : {}),
			...(win ? { window: { start: isoOrNull(win.calibrationStart), end: isoOrNull(win.calibrationEnd) } } : {}),
			members
		};
	});
}

/** The engine versions of every zone's fit (the site's own included), for the errata the report lists. */
export function calibrationZoneFitVersions(zones: readonly EvidenceCalibrationZone[] | null): string[] {
	return [...new Set((zones ?? []).flatMap((z) => (z.fit?.engineVersion ? [z.fit.engineVersion] : [])))];
}

/**
 * The flags a zoned baseline raises (report.ts evidenceFlags): a zone above the
 * site whose parameters don't come from a stored fit, so it has no validation.
 */
export function calibrationZoneFlags(zones: readonly EvidenceCalibrationZone[] | null): { key: string; text: string; why: string }[] {
	// Every location but the headline (whose fit the report's own noFit flag judges) and the catchment-parameter units.
	const unvalidated = (zones ?? []).filter((z) => !z.headline && z.kind !== 'default' && !(z.nodeId === null && z.kind === undefined) && !z.fit);
	if (!unvalidated.length) return [];
	const names = unvalidated.map((z) => z.name).join(', ');
	return [
		{
			key: 'zoneNoFit',
			text: `Validation not assessed for ${unvalidated.length === 1 ? 'the calibration zone at' : `${unvalidated.length} calibration zones, at`} ${names}: ${unvalidated.length === 1 ? 'its parameters don’t' : 'their parameters don’t'} come from a stored automatic fit.`,
			why: 'Those units’ runoff rests on parameters with no split-sample or dry → wet scores.'
		}
	];
}
