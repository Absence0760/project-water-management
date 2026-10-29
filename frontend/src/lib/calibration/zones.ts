// Calibration zones in Settings & calibration → Calibration record (issue
// #555, engine 1.106.0, docs/model.md §2.10n): the rows of the gauges table,
// a tick's effect on settings.calibrationZones, the rows' errors, each
// record's coverage, and the stepwise fit's steps as the fit card lists them.
// Pure, so it is unit-tested; CalibrationZonesTable.svelte and FitPanel.svelte
// are thin.
import {
	newCalibrationZone,
	spannedWaterYears,
	type CalibrationFlowKind,
	type CalibrationSite,
	type CalibrationZone,
	type SeriesMeta,
	type ZoneFitStep
} from '@water-management/engine';
import { windowError } from '#lib/components/calibration/metrics.js';
import { fmtNum } from '#lib/format/number.js';

/** One gauge of the table (the site's own row is the form's fields above it). */
export interface ZoneRow {
	site: CalibrationSite;
	/** Its stored row, or null: never ticked. */
	zone: CalibrationZone | null;
}

/** The gauges with a record of their own, the calibration site (Scored at) left out: its zone is the site's own row. */
export function zoneRows(sites: readonly CalibrationSite[], zones: readonly CalibrationZone[] | null | undefined, siteNodeId: string | null): ZoneRow[] {
	return sites.filter((s) => s.nodeId !== siteNodeId).map((site) => ({ site, zone: (zones ?? []).find((z) => z.nodeId === site.nodeId) ?? null }));
}

/** settings.calibrationZones with one gauge ticked or unticked: a first tick adds its row, an untick keeps the row's settings. */
export function withZoneTicked(zones: readonly CalibrationZone[] | null | undefined, nodeId: string, on: boolean): CalibrationZone[] {
	const list = [...(zones ?? [])];
	const i = list.findIndex((z) => z.nodeId === nodeId);
	if (i < 0) return on ? [...list, { ...newCalibrationZone(nodeId), enabled: true }] : list;
	list[i] = { ...list[i]!, enabled: on };
	return list;
}

/** settings.calibrationZones with one row's fields changed (a row is made, unticked, when the gauge has none yet). */
export function withZoneFields(zones: readonly CalibrationZone[] | null | undefined, nodeId: string, patch: Partial<Omit<CalibrationZone, 'nodeId'>>): CalibrationZone[] {
	const list = [...(zones ?? [])];
	const i = list.findIndex((z) => z.nodeId === nodeId);
	if (i < 0) return [...list, { ...newCalibrationZone(nodeId), ...patch }];
	list[i] = { ...list[i]!, ...patch };
	return list;
}

/** The first row whose window can't be saved, as the save bar names it; null when every row is fine. */
export function zonesError(zones: readonly CalibrationZone[] | null | undefined, name: (nodeId: string) => string): string | null {
	for (const z of zones ?? []) {
		const e = windowError(z.calibrationStart, z.calibrationEnd);
		if (e) return `Calibration zone at ${name(z.nodeId)}: ${e}`;
	}
	return null;
}

/**
 * A gauge's record coverage, in complete water years spanned (1 October to
 * 30 September, gaps not counted: the fit's own notes count the observed
 * days): the record the row fits (its kind, else its gauge record, else its
 * logger). null when the series aren't known.
 */
export function zoneCoverage(series: readonly Pick<SeriesMeta, 'kind' | 'siteNodeId' | 'startDate' | 'length' | 'lastValueDate'>[] | null | undefined, site: CalibrationSite, kind: CalibrationFlowKind | null): number | null {
	if (!series) return null;
	const want = kind && site.records.includes(kind) ? kind : site.records[0];
	const s = series.find((x) => x.siteNodeId === site.nodeId && x.kind === want);
	if (!s) return null;
	const end = s.lastValueDate ?? addDays(s.startDate, s.length - 1);
	return spannedWaterYears(s.startDate, end);
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** "3 water years", with the warning the fit will give under 2 (issue #555). */
export function coverageText(years: number | null): string {
	if (years === null) return '–';
	return `${fmtNum(years)} water year${years === 1 ? '' : 's'}${years < 2 ? ' (too short)' : ''}`;
}

/** "X1 900 · X2 0 · X3 220 · X4 3.1", or that the zone has none of its own yet. */
export function zoneParamsText(p: CalibrationZone['gr4j']): string {
	if (!p) return 'Not fitted yet: its units run on the parameters above';
	const f = (v: number) => fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 2);
	return `X1 ${f(p.x1)} · X2 ${f(p.x2)} · X3 ${f(p.x3)} · X4 ${f(p.x4)}`;
}

/** One step of the stepwise fit, as the fit card's steps table shows it. */
export interface StepRow {
	key: string;
	step: number;
	name: string;
	/** "Upstream zone" or "Calibration site". */
	what: string;
	units: number;
	params: string;
	fit: number | null;
	split: number | null;
	dsst: number | null;
	notes: string[];
}

/** The steps of a stepwise fit, upstream first, each with its fit's and validation's score on the fit's objective. */
export function stepRows(steps: readonly ZoneFitStep[]): StepRow[] {
	return steps.map((s, i) => {
		const r = s.report;
		const score = (p: { scores: object } | null | undefined) => {
			const v = (p?.scores as Record<string, unknown> | undefined)?.[r.objective];
			return typeof v === 'number' ? v : null;
		};
		const f = (v: number | undefined) => (v === undefined ? '–' : fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : 2));
		return {
			key: s.zoneNodeId ?? 'site',
			step: i + 1,
			name: s.name,
			what: s.zoneNodeId === null ? 'Calibration site' : 'Upstream zone',
			units: s.units.length,
			params: `X1 ${f(r.params.x1)} · X2 ${f(r.params.x2)} · X3 ${f(r.params.x3)} · X4 ${f(r.params.x4)}`,
			fit: score(r.fit),
			split: score(r.splitSample?.validation),
			dsst: score(r.differential?.validation),
			notes: r.notes
		};
	});
}
