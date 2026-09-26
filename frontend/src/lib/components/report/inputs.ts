// The report's Inputs section as rows: the settings, farms, crops and areas
// and transfers the run used (its own snapshot, never today's model), and the
// coverage of each input series over the run's period. Pure, so the page stays
// a thin template.
import { defaultProjectSettings, fitPeriodText, fromEpochDay, toEpochDay, type ProjectModel, type ProjectSettings, type SeriesMeta } from '@water-management/engine';
import { describeWindow, FLOW_KIND_LABEL } from '$lib/components/calibration/metrics';
import { describeMonths } from '$lib/format/months';
import { fmtNum, fmtPct } from '$lib/format/number';
import { kindLabel } from '$lib/series/kinds';

type RawSettings = Partial<ProjectSettings> & Record<string, unknown>;

/** The run's settings over the defaults, as the engine reads them (one level deep for GR4J). */
export function effectiveSettings(raw: RawSettings | undefined): ProjectSettings {
	const d = defaultProjectSettings();
	const s = { ...d, ...(raw ?? {}) } as ProjectSettings;
	s.gr4j = { ...d.gr4j, ...((raw?.gr4j as object | undefined) ?? {}) };
	return s;
}

const RUNOFF_MODEL: Record<string, string> = { gr4j: 'GR4J', legacy: 'Legacy (b023 workbook): workbook comparison only' };

/** The settings a reader needs to know the run by, as label → value. */
export function settingsRows(s: ProjectSettings, run: { startDate: string; endDate: string }): [string, string][] {
	const rows: [string, string][] = [
		['Simulated period', `${run.startDate} – ${run.endDate}`],
		['Runoff model', RUNOFF_MODEL[s.runoffModel] ?? s.runoffModel]
	];
	if (s.runoffModel === 'gr4j') {
		const g = s.gr4j;
		rows.push(['GR4J parameters', `X1 ${fmtNum(g.x1, 1, true)} mm · X2 ${fmtNum(g.x2, 2, true)} mm/day · X3 ${fmtNum(g.x3, 1, true)} mm · X4 ${fmtNum(g.x4, 2, true)} days · warm-up ${fmtNum(g.warmupDays)} days`]);
	}
	rows.push(
		['Calibration window', describeWindow(s.calibrationStart, s.calibrationEnd)],
		['Calibration record', s.calibrationFlowKind ? (FLOW_KIND_LABEL[s.calibrationFlowKind] ?? s.calibrationFlowKind) : 'observed gauge flow, else logger'],
		['Reporting window (curtailment)', describeWindow(s.reportStart, s.reportEnd)],
		['CHIRPS bias correction', s.chirpsBiasCorrection === 'none' ? 'none (raw CHIRPS)' : `monthly factors, fit period: ${fitPeriodText(s.chirpsFitPeriod)}`],
		['Effective rainfall', `${fmtPct(s.effectiveRainFraction, 0)} of rain, soil-water store ${fmtNum(s.effectiveRainStoreMm, 1, true)} mm`],
		['Dam evaporation factor', fmtNum(s.lakeEvapFactor, 2, true)]
	);
	return rows;
}

/** Monthly settings in water-year order (Oct … Sep). */
export function monthlyRows(s: ProjectSettings): { label: string; values: string[] }[] {
	const row = (label: string, v: readonly number[], digits: number) => ({ label, values: Array.from({ length: 12 }, (_, i) => fmtNum(v[i], digits, true)) });
	return [
		row('A-pan evaporation (mm)', s.apanMm, 1),
		row('Pan coefficient', s.panCoefficient, 2),
		row('Pragmatic EWR (m³/day)', s.ewrPragmaticM3PerDay, 0)
	];
}

const KIND: Record<string, string> = { farm: 'Farm', gauge: 'Gauge', user: 'Other water user' };

/** Every node in network order: kind, what it drains into, area, dam and irrigation efficiency. */
export function nodeRows(model: Partial<ProjectModel>): string[][] {
	const nodes = [...(model.nodes ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
	const name = new Map(nodes.map((n) => [n.id, n.name || '(unnamed)']));
	return nodes.map((n) => [
		n.name || '(unnamed)',
		KIND[n.kind] ?? n.kind,
		n.downstreamNodeId ? (name.get(n.downstreamNodeId) ?? '–') : 'outlet',
		n.kind === 'user' ? '–' : fmtNum(n.areaKm2, 2),
		n.damCapacityM3 >= 1 ? fmtNum(n.damCapacityM3) : '–',
		n.kind === 'farm' ? fmtPct(n.irrigationEfficiency, 0) : '–'
	]);
}

/** Planted area per farm and crop, in hectares, in network then crop order. */
export function cropAreaRows(model: Partial<ProjectModel>): string[][] {
	const order = new Map((model.nodes ?? []).map((n) => [n.id, n.sortOrder]));
	const farm = new Map((model.nodes ?? []).map((n) => [n.id, n.name || '(unnamed)']));
	const crops = model.crops ?? [];
	const crop = new Map(crops.map((c) => [c.id, c.name]));
	const cropOrder = new Map(crops.map((c, i) => [c.id, i]));
	return (model.cropAreas ?? [])
		.filter((a) => a.areaM2 > 0)
		.sort((a, b) => (order.get(a.nodeId) ?? 1e9) - (order.get(b.nodeId) ?? 1e9) || (cropOrder.get(a.cropId) ?? 1e9) - (cropOrder.get(b.cropId) ?? 1e9))
		.map((a) => [farm.get(a.nodeId) ?? '(removed)', crop.get(a.cropId) ?? '(removed)', fmtNum(a.areaM2 / 10_000, 2)]);
}

/** Each transfer: from, to, months, maximum rate, daily cap, and whether it was on. */
export function transferRows(model: Partial<ProjectModel>): string[][] {
	const name = new Map((model.nodes ?? []).map((n) => [n.id, n.name || '(unnamed)']));
	return [...(model.transfers ?? [])]
		.sort((a, b) => a.priority - b.priority)
		.map((t) => [
			name.get(t.fromNodeId) ?? '–',
			name.get(t.toNodeId) ?? '–',
			describeMonths(t.months),
			fmtNum(t.maxRateM3s, 3, true),
			t.dailyCapM3 == null ? 'none' : fmtNum(t.dailyCapM3),
			t.enabled ? 'on' : 'off'
		]);
}

/**
 * Each input series as stored now, with the days of it inside the run's
 * period. A run doesn't keep a copy of its series, so a series extended since
 * the run reaches past the run's end.
 */
export function coverageRows(series: readonly SeriesMeta[], run: { startDate: string; endDate: string }): string[][] {
	const r0 = toEpochDay(run.startDate);
	const r1 = toEpochDay(run.endDate);
	return [...series]
		.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
		.map((s) => {
			const s0 = toEpochDay(s.startDate);
			const s1 = s0 + Math.max(s.length, 1) - 1;
			const inRun = Math.max(0, Math.min(s1, r1) - Math.max(s0, r0) + 1);
			return [kindLabel(s.kind) + (s.name ? ` · ${s.name}` : ''), s.startDate, fromEpochDay(s1), fmtNum(s.length), fmtNum(inRun)];
		});
}
