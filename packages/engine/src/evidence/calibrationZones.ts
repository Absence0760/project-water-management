// The report's calibration zones (report format evidence-22, issue #555;
// docs/evidence-pack.md § Calibration zones, docs/model.md §2.10n): when the
// baseline ran with calibration zones, every zone's GR4J parameters as its land
// units ran on them, its fit record (the fit, its in-sample score and its
// split-sample and dry → wet scores) and the run's statistics at its gauge,
// each in or out of sample by the zone's own fit. The calibration site's own
// zone (the rest of the catchment) is the last row. Null when the baseline ran
// one parameter set (no zone applied), as every run before engine 1.106.0.
//
// Everything here is read from what the run froze (its summary and its
// settings snapshot), so the manifest's hash covers it and a reproduction
// re-derives it. The section lives in its own module so the report builder
// only calls it (report.ts) and the zones' rules stay in one place.
import type { CalibrationFitStatus, CalibrationStats, RunSummary } from '../project';
import type { RunInputsSnapshot } from '../compare';
import { describeFitRecord } from '../compare';
import { editedParams, type FitRecord } from '../calibrate/provenance';
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

type ZoneRow = { nodeId?: unknown; enabled?: unknown; fitRecord?: unknown };

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
	const settings = (run.inputs?.settings ?? {}) as { calibrationZones?: unknown; fitRecord?: unknown };
	const rows = (Array.isArray(settings.calibrationZones) ? settings.calibrationZones : []) as ZoneRow[];
	const area = new Map(((run.inputs?.model?.nodes ?? []) as { id: string; areaKm2?: unknown }[]).map((n) => [n.id, finite(n.areaKm2) ?? 0]));
	const stats = new Map((run.summary.calibrationZones ?? []).map((s) => [s.siteNodeId, s]));
	return zones.map((z) => {
		const record = z.nodeId === null ? settings.fitRecord : rows.find((r) => r.nodeId === z.nodeId && r.enabled === true)?.fitRecord;
		return {
			nodeId: z.nodeId,
			name: z.name,
			units: z.units.length,
			areaKm2: z.units.reduce((a, u) => a + (area.get(u) ?? 0), 0),
			params: { x1: z.params.x1, x2: z.params.x2, x3: z.params.x3, x4: z.params.x4 },
			fitted: z.fitted,
			fit: fitOf(record, z.params),
			stats: statsOf(z.nodeId === null ? run.summary.calibration : stats.get(z.nodeId))
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
	const unvalidated = (zones ?? []).filter((z) => z.nodeId !== null && !z.fit);
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
