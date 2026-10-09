// The report's Inputs section as rows: the settings, farms, crops and areas
// and transfers the run used (its own snapshot, never today's model), and the
// coverage of each input series over the run's period. Pure, so the page stays
// a thin template.
import { arealRainText, DEFAULT_UNIT_MAP_PERIOD, defaultProjectSettings, fitPeriodText, hasMonthlyRates, isRiverOfftake, modelFarmEfficiency, upgradeLegacyModel, resolveArealRain, rainSourceText, toEpochDay, transferRatesM3s, type ProjectModel, type ProjectSettings, type SeriesMeta, type StoredRunoffModelId, type Transfer } from '@water-management/engine';
import { findSystem, systemLabel } from '$lib/model/systems';
import { describeWindow, FLOW_KIND_LABEL } from '$lib/components/calibration/metrics';
import { describeMonths, WATER_YEAR_MONTHS } from '$lib/format/months';
import { fmtNum, fmtPct } from '$lib/format/number';
import { kindLabel } from '$lib/series/kinds';
import { peText } from '$lib/components/settings/peInput';
import { dataEnd } from '$lib/components/series/freshness';

type RawSettings = Partial<Omit<ProjectSettings, 'runoffModel'>> & { runoffModel?: StoredRunoffModelId } & Record<string, unknown>;

/** A stored run's settings: its runoff model may be the legacy one, removed in engine 1.0.0. */
export type RunSettings = Omit<ProjectSettings, 'runoffModel'> & { runoffModel: StoredRunoffModelId };

/**
 * The run's settings over the defaults, as the engine read them (one level
 * deep for GR4J). A run whose settings don't name GR4J ran the legacy runoff
 * model (the backend's "absent → legacy"), so it is never read as GR4J.
 */
export function effectiveSettings(raw: RawSettings | undefined): RunSettings {
	const d = defaultProjectSettings();
	const s = { ...d, ...(raw ?? {}) } as unknown as RunSettings;
	s.gr4j = { ...d.gr4j, ...((raw?.gr4j as object | undefined) ?? {}) };
	s.runoffModel = raw?.runoffModel === 'gr4j' ? 'gr4j' : 'legacy';
	return s;
}

const RUNOFF_MODEL: Record<StoredRunoffModelId, string> = { gr4j: 'GR4J', legacy: 'Legacy (b023 workbook, removed in engine 1.0.0): workbook comparison only' };

/** The settings a reader needs to know the run by, as label → value. */
export function settingsRows(s: RunSettings, run: { startDate: string; endDate: string }): [string, string][] {
	const rows: [string, string][] = [
		['Simulated period', `${run.startDate} – ${run.endDate}`],
		['Runoff model', RUNOFF_MODEL[s.runoffModel]]
	];
	if (s.runoffModel === 'gr4j') {
		const g = s.gr4j;
		rows.push(['GR4J parameters', `X1 ${fmtNum(g.x1, 1, true)} mm · X2 ${fmtNum(g.x2, 2, true)} mm/day · X3 ${fmtNum(g.x3, 1, true)} mm · X4 ${fmtNum(g.x4, 2, true)} days · warm-up ${fmtNum(g.warmupDays)} days`]);
		// Engine ≥ 0.31.0 (issue #39); a snapshot without it ran on pan coefficient × A-pan.
		// Engine ≥ 0.31.1: under pan × A-pan, where the pan-coefficient row came from, when noted.
		const kpSource = s.pe?.kind !== 'monthly' && s.panCoefficientSource ? ` (pan coefficient: ${s.panCoefficientSource})` : '';
		rows.push(['GR4J potential evaporation', peText(s.pe) + kpSource]);
		// Engine ≥ 1.13.0 (docs/model.md §2.4g); a snapshot without it ran with none.
		rows.push(['Areal rainfall correction (GR4J rain)', arealRainText(resolveArealRain(s.arealRain, []))]);
		// Rain for each unit (issue #482, docs/model.md §2.4h): only on a run that had it, so older reports read as before.
		const u = s.unitRain;
		if (u?.mode === 'perUnit') {
			const p = u.mapPeriod ?? DEFAULT_UNIT_MAP_PERIOD;
			const gauge = u.gaugeMapMm != null ? `; rain gauge’s MAP ${fmtNum(u.gaugeMapMm)} mm${u.gaugeMapSource ? ` (${u.gaugeMapSource})` : ''}` : '; no rain gauge MAP';
			rows.push(['Rain for each unit (GR4J rain)', `on: GR4J ran once per unit with land on its own rain; MAP period ${p.start.slice(0, 4)}–${p.end.slice(0, 4)}${gauge}`]);
		}
	}
	rows.push(
		['Calibration window', describeWindow(s.calibrationStart, s.calibrationEnd)],
		['Calibration record', s.calibrationFlowKind ? (FLOW_KIND_LABEL[s.calibrationFlowKind] ?? s.calibrationFlowKind) : 'observed gauge flow, else logger'],
		['Reporting window (curtailment)', describeWindow(s.reportStart, s.reportEnd)],
		[
			'CHIRPS bias correction',
			s.chirpsBiasCorrection === 'none'
				? 'none (raw CHIRPS)'
				: // Engine ≥ 1.53.0 (CR-23): the gap map; a snapshot without it ran without.
					`monthly factors, fit period: ${fitPeriodText(s.chirpsFitPeriod)}${s.chirpsQuantileMap ? `; gap days quantile-mapped onto the catchment rain (wet days ≥ ${s.chirpsQuantileMap.wetDayMm} mm)` : ''}`
		],
		// Engine ≥ 0.30.0 (issue #40 b); a snapshot without it had none.
		['Rain source periods', rainSourceText(s.rainSource ?? [])],
		['Effective rainfall', `${fmtPct(s.effectiveRainFraction, 0)} of rain, soil-water store ${fmtNum(s.effectiveRainStoreMm, 1, true)} mm`],
		// Monthly factors (engine ≥ 0.35.0, WP-3.5) are listed with the monthly rows; engine ≥ 1.49.0 adds where
		// the factors came from (a lake-factor preset's note), when noted.
		[
			'Dam evaporation factor',
			(s.lakeEvapFactorMonthly ? 'by month (see the monthly table)' : fmtNum(s.lakeEvapFactor, 2, true)) +
				(s.lakeEvapFactorSource ? ` (source: ${s.lakeEvapFactorSource})` : '')
		]
	);
	return rows;
}

/** Monthly settings in water-year order (Oct … Sep). */
export function monthlyRows(s: RunSettings): { label: string; values: string[] }[] {
	const row = (label: string, v: readonly number[], digits: number) => ({ label, values: Array.from({ length: 12 }, (_, i) => fmtNum(v[i], digits, true)) });
	const monthlyPe = s.runoffModel === 'gr4j' && s.pe?.kind === 'monthly' ? s.pe : null;
	return [
		row('A-pan evaporation (mm)', s.apanMm, 1),
		// Under a monthly PE (issue #39) GR4J runs on its own row and the pan coefficient is unused.
		...(monthlyPe ? [row('GR4J monthly PE (mm)', monthlyPe.mm, 1)] : [row('Pan coefficient', s.panCoefficient, 2)]),
		...(s.lakeEvapFactorMonthly ? [row('Dam evaporation factor (× A-pan)', s.lakeEvapFactorMonthly, 3)] : []),
		row('Pragmatic EWR (m³/day)', s.ewrPragmaticM3PerDay, 0)
	];
}

const KIND: Record<string, string> = { farm: 'Hydrological unit', gauge: 'Gauge', user: 'Other water user' };

/** Every node in network order: kind, what it drains into, area, dam and irrigation efficiency. */
export function nodeRows(model: Partial<ProjectModel>, apanMm: readonly number[] = []): string[][] {
	const nodes = [...(model.nodes ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
	const name = new Map(nodes.map((n) => [n.id, n.name || '(unnamed)']));
	return nodes.map((n) => [
		n.name || '(unnamed)',
		KIND[n.kind] ?? n.kind,
		n.downstreamNodeId ? (name.get(n.downstreamNodeId) ?? '–') : 'outlet',
		n.kind === 'user' ? '–' : fmtNum(n.areaKm2, 2),
		n.damCapacityM3 >= 1 ? fmtNum(n.damCapacityM3) : '–',
		// As the run used it: its crops' irrigation systems blended (engine ≥ 1.72.0), else its own.
		n.kind === 'farm'
			? fmtPct(
					modelFarmEfficiency(n.irrigationEfficiency > 0 && n.irrigationEfficiency <= 1 ? n.irrigationEfficiency : 1, n.id, model.crops ?? [], model.cropAreas ?? [], apanMm, upgradeLegacyModel({ nodes: [], crops: model.crops ?? [], irrigationSystems: model.irrigationSystems }).irrigationSystems),
					0
				)
			: '–'
	]);
}

/** Planted area per farm and crop, in hectares, in network then crop order. */
/**
 * A planting's irrigation system as the run had it (engine ≥ 1.72.0): its own on
 * the unit, else its crop's default, "Drip, 90 %"; a crop's own efficiency
 * (a run before 1.72.0) as a percentage; else the unit's own.
 */
function plantingSystemText(model: Partial<ProjectModel>, a: { cropId: string; irrigationSystemId?: string | null }): string {
	const up = upgradeLegacyModel({ nodes: [], crops: model.crops ?? [], irrigationSystems: model.irrigationSystems });
	const c = (up.crops ?? []).find((x) => x.id === a.cropId);
	const s = findSystem({ irrigationSystems: up.irrigationSystems }, a.irrigationSystemId ?? c?.irrigationSystemId ?? null);
	return s ? systemLabel(s) : "the unit's own";
}

export function cropAreaRows(model: Partial<ProjectModel>): string[][] {
	const order = new Map((model.nodes ?? []).map((n) => [n.id, n.sortOrder]));
	const farm = new Map((model.nodes ?? []).map((n) => [n.id, n.name || '(unnamed)']));
	const crops = model.crops ?? [];
	const crop = new Map(crops.map((c) => [c.id, c.name]));
	const cropOrder = new Map(crops.map((c, i) => [c.id, i]));
	return (model.cropAreas ?? [])
		.filter((a) => a.areaM2 > 0)
		.sort((a, b) => (order.get(a.nodeId) ?? 1e9) - (order.get(b.nodeId) ?? 1e9) || (cropOrder.get(a.cropId) ?? 1e9) - (cropOrder.get(b.cropId) ?? 1e9))
		.map((a) => [farm.get(a.nodeId) ?? '(removed)', crop.get(a.cropId) ?? '(removed)', fmtNum(a.areaM2 / 10_000, 2), plantingSystemText(model, a)]);
}

/**
 * Each transfer: from (a river off-take says so), to, months, maximum rate, daily cap, a river off-take's
 * conveyance losses and the share of them seeping back to the river with the unit it rejoins below (engine
 * ≥ 1.42.0; '–' on a dam transfer, which has neither), and whether it was on.
 */
export function transferRows(model: Partial<ProjectModel>): string[][] {
	const name = new Map((model.nodes ?? []).map((n) => [n.id, n.name || '(unnamed)']));
	return [...(model.transfers ?? [])]
		.sort((a, b) => a.priority - b.priority)
		.map((t) => [
			`${name.get(t.fromNodeId) ?? '–'}${isRiverOfftake(t) ? ' (river off-take)' : ''}`,
			name.get(t.toNodeId) ?? '–',
			describeMonths(t.months),
			// A rule with its own rate per month (engine ≥ 1.14.0) lists each month it runs in with its rate.
			hasMonthlyRates(t) && new Set(transferRatesM3s(t).filter((r) => r > 0)).size > 1
				? transferRatesM3s(t)
						.flatMap((r, k) => (r > 0 ? [`${WATER_YEAR_MONTHS[k]} ${fmtNum(r, 3, true)}`] : []))
						.join(', ')
				: fmtNum(t.maxRateM3s, 3, true),
			t.dailyCapM3 == null ? 'none' : fmtNum(t.dailyCapM3),
			isRiverOfftake(t) ? fmtPct(t.lossPct ?? 0) : '–',
			isRiverOfftake(t) ? seepingBack(t, name) : '–',
			t.enabled ? 'on' : 'off'
		]);
}

/** A river off-take's canal seepage back to the river (engine ≥ 1.42.0): its share of the losses and where it rejoins (null = below the source). */
function seepingBack(t: Transfer, name: ReadonlyMap<string, string>): string {
	const r = t.lossReturnPct ?? 0;
	if (!(r > 0) || !((t.lossPct ?? 0) > 0)) return 'none';
	const at = t.lossReturnNodeId ?? t.fromNodeId;
	return `${fmtPct(r)} of them, below ${name.get(at) ?? '(removed)'}`;
}

/**
 * Each input series as stored now, with the days of it inside the run's
 * period. A run doesn't keep a copy of its series, so a series extended since
 * the run reaches past the run's end. "Ends" is the last day with a value
 * (series/freshness.ts dataEnd): blank days stored after it are no data.
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
			return [kindLabel(s.kind) + (s.name ? ` · ${s.name}` : ''), s.startDate, dataEnd(s), fmtNum(s.length), fmtNum(inRun)];
		});
}
