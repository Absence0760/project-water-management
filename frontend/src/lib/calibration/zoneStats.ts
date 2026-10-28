// Calibration zones in a run, a report and an evidence pack (issue #555 round
// 4, docs/model.md §2.10n, docs/ui.md § Runs & results): one row per zone,
// upstream first and the calibration site's own zone last, with its units, its
// parameters, its statistics at its gauge and whether they are in sample by the
// zone's own fit, and, from an evidence pack, its fit record's scores. Pure;
// ZoneCalibrationTable.svelte only lays the rows out.
import type { CalibrationStats, EvidenceCalibrationZone, RunSummary } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { calibrationSample } from '#lib/components/calibration/sample.js';

export interface ZoneStatsRow {
	key: string;
	name: string;
	/** "Upstream zone" or "Calibration site". */
	what: string;
	units: number;
	params: string;
	/** Days scored at its gauge; 0 = none. */
	days: number;
	nse: string;
	kge: string;
	pbias: string;
	/** "in-sample", "parameters not from an automatic fit", …; null when not scored or not recorded. */
	sample: string | null;
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

/** A run's zones (summary.unitRain.zones) with their statistics (summary.calibrationZones, the site's: summary.calibration); [] without zones. */
export function runZoneRows(summary: Pick<RunSummary, 'unitRain' | 'calibration' | 'calibrationZones'>): ZoneStatsRow[] {
	const zones = summary.unitRain?.zones ?? [];
	const at = new Map((summary.calibrationZones ?? []).map((s) => [s.siteNodeId, s]));
	return zones.map((z) => ({
		key: z.nodeId ?? 'site',
		name: z.name,
		what: z.nodeId === null ? 'Calibration site' : 'Upstream zone',
		units: z.units.length,
		params: z.fitted ? paramsText(z.params) : `${paramsText(z.params)} (the catchment’s: not fitted yet)`,
		...scored(z.nodeId === null ? summary.calibration : at.get(z.nodeId))
	}));
}

/** An evidence report's zones (EvidenceReport.calibrationZones, evidence-22), with each fit's scores; [] without. */
export function evidenceZoneRows(zones: readonly EvidenceCalibrationZone[] | null | undefined): ZoneStatsRow[] {
	return (zones ?? []).map((z) => ({
		key: z.nodeId ?? 'site',
		name: z.name,
		what: z.nodeId === null ? 'Calibration site' : 'Upstream zone',
		units: z.units,
		params: z.fitted ? paramsText(z.params) : `${paramsText(z.params)} (the catchment’s: not fitted yet)`,
		...scored(z.stats ? { ...z.stats, fitStatus: z.stats.fitStatus ?? undefined } : null),
		fit: z.fit
			? {
					description: `${z.fit.description}${z.fit.editedParams.length ? `, edited since (${z.fit.editedParams.join(', ')})` : ''}`,
					inSample: num(z.fit.inSample),
					splitSample: z.fit.splitSample === null ? 'not run' : num(z.fit.splitSample),
					dryToWet: z.fit.dryToWet === null ? 'not run' : num(z.fit.dryToWet)
				}
			: null
	}));
}
