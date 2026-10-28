// The report's Inputs section as rows: the settings, farms, crops and areas
// and transfers the run used (its own snapshot, never today's model), and the
// coverage of each input series over the run's period. Pure, so the page stays
// a thin template.
import { gapRainChoiceText } from '#lib/components/series/gapRain.js';
import { arealRainText, resolveGapRain, runRainCredits, type RainCredit, DEFAULT_UNIT_MAP_PERIOD, defaultProjectSettings, describeEwrDailySource, fitPeriodText, hasMonthlyRates, isRiverOfftake, modelFarmEfficiency, upgradeLegacyModel, resolveArealRain, rainSourceText, toEpochDay, transferRatesM3s, type ProjectModel, type ProjectSettings, type SeriesMeta, type StoredRunoffModelId, type Transfer, type EwrSplitInfo } from '@water-management/engine';
import { findSystem, systemLabel } from '#lib/model/systems.js';
import { describeWindow, FLOW_KIND_LABEL } from '#lib/components/calibration/metrics.js';
import { describeMonths, WATER_YEAR_MONTHS } from '#lib/format/months.js';
import { fmtNum, fmtPct } from '#lib/format/number.js';
import { seriesKindLabel } from '#lib/series/kinds.js';
import { peText } from '#lib/components/settings/peInput.js';
import { dataEnd } from '#lib/components/series/freshness.js';
import { chirpsAtText, correctedByName, pairingFactorsText, pairingPeriodText, ratioText, stationAreas, stationsOf } from '#lib/components/runs/stationRain.js';

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

const RUNOFF_MODEL: Record<StoredRunoffModelId, string> = { gr4j: 'GR4J', legacy: 'Legacy (the original workbook’s, removed in engine 1.0.0): workbook comparison only' };

/**
 * The settings a reader needs to know the run by, as label → value. `run.summary`, when given, says what the
 * run applied where that can differ from what the settings asked for (summary.ewrSplit).
 */
export function settingsRows(s: RunSettings, run: { startDate: string; endDate: string; summary?: { ewrSplit?: EwrSplitInfo } | null }): [string, string][] {
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
		// Rainfall stations (issue #553, docs/model.md §2.4i): only on a run that assigned one; the stations tables below name them.
		const st = s.rainStations;
		const units = Object.keys(st?.units ?? {}).length;
		if (st && (st.catchment || units)) {
			const parts = [st.catchment ? 'the catchment from a station' : 'the catchment rain as before'];
			if (units) parts.push(`${units === 1 ? '1 land unit' : `${fmtNum(units)} land units`} from ${units === 1 ? 'its' : 'their'} stations`);
			parts.push(st.catchmentMapMm != null ? `catchment MAP ${fmtNum(st.catchmentMapMm)} mm${st.catchmentMapSource ? ` (${st.catchmentMapSource})` : ''}` : 'catchment MAP: the units’ area-weighted mean');
			const periods = Object.values(st.unreliable ?? {}).reduce((n, r) => n + r.length, 0);
			if (periods) parts.push(`${periods === 1 ? '1 unreliable period' : `${fmtNum(periods)} unreliable periods`} set aside`);
			// The station rule's own calls are provisional (engine-audit.md RS1–RS4), so a report that used them says so.
			parts.push('the station rule’s choices are provisional, pending the hydrologist’s review');
			rows.push(['Rainfall stations (GR4J rain)', parts.join('; ')]);
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
		// Engine ≥ 1.101.0 (issue #604): only on a run that chose a gap-filling product, so older reports read as before.
		...(resolveGapRain(s.gapRain, []) ? [['Gap-filling product', `${gapRainChoiceText(resolveGapRain(s.gapRain, []))}; each product corrected on its own fit (provisional, pending the hydrologist’s review)`] as [string, string]] : []),
		// Engine ≥ 0.30.0 (issue #40 b); a snapshot without it had none.
		['Rain source periods', rainSourceText(s.rainSource ?? [])],
		['Effective rainfall', `${fmtPct(s.effectiveRainFraction, 0)} of rain, soil-water store ${fmtNum(s.effectiveRainStoreMm, 1, true)} mm`],
		// Engine ≥ 1.105.0 (issue #615): every run records how its EWR was split; 1.94.0 – 1.104.x only a run that asked
		// for the natural MAR, so older reports and that default read as before.
		...(isCurrentSplit(run.summary?.ewrSplit) || (s as { ewrSplit?: unknown }).ewrSplit === 'naturalMar'
			? [['EWR split between units', ewrSplitText(s, run.summary?.ewrSplit)] as [string, string]]
			: []),
		// Engine ≥ 1.77.0; the Reserve table it reads, engine ≥ 1.90.0 (issue #552). Only on a run that had one, so older reports read as before.
		...(s.ewrDailySource ? [['Daily EWR at the outlet', describeEwrDailySource(s.ewrDailySource)] as [string, string]] : []),
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

/** A split recorded by engine ≥ 1.105.0, which has no setting behind it (no `method`). */
const isCurrentSplit = (x: EwrSplitInfo | undefined): boolean => !!x && x.method === undefined;

const NATURAL_MAR_TEXT = 'each unit’s natural MAR (its own GR4J runoff ÷ the units’ total) over the run’s complete water years, or the whole run without one; the period is provisional, pending the hydrologist’s review';

/**
 * How the EWR was split between the units, in words. Engine ≥ 1.105.0 (issue #615): always by each unit's natural
 * MAR (summary.ewrSplit), under Fragmentation from GR4J runs on each unit's own rain made for the shares only.
 * 1.94.0 – 1.104.x, a run that asked for it (settings.ewrSplit 'naturalMar'): what it applied (summary.ewrSplit, which
 * can fall back to the flow share), else what the settings imply.
 */
function ewrSplitText(s: RunSettings, applied?: EwrSplitInfo): string {
	if (applied && isCurrentSplit(applied)) {
		if (applied.applied === 'flowShare')
			return applied.why === 'noLandUnit'
				? 'the flow share: no unit has an area, so there is no natural MAR to split by'
				: applied.why === 'noUnitRunoff'
					? 'the flow share: the natural flow came without the units’ runoff'
					: 'the flow share: the run resumed from a snapshot that pinned no shares';
		if (applied.applied === 'area') return 'each unit’s area: no unit made natural runoff over the run';
		const frag = applied.runoffFrom === 'shareRuns' ? '; under Fragmentation, from GR4J runs on each unit’s own rain made for the shares only (the flow is the catchment’s one run, split by the flow share)' : '';
		const rule4 = applied.catchmentRain?.length ? `; on the catchment rain, so their share follows their area: ${applied.catchmentRain.map((u) => u.name).join(', ')}` : '';
		return NATURAL_MAR_TEXT + frag + rule4;
	}
	if (applied?.applied === 'flowShare' && applied.why === 'noRunoff') return 'the flow share: natural MAR was asked for, but no unit made natural runoff over the run';
	if (applied?.applied === 'flowShare' && applied.why === 'resumed')
		return 'the flow share: natural MAR was asked for, but the run resumed from a snapshot of a run that split the EWR by the flow share';
	const perUnit = applied ? applied.applied === 'naturalMar' : s.runoffModel === 'gr4j' && s.unitRain?.mode === 'perUnit';
	if (perUnit) return NATURAL_MAR_TEXT;
	return 'the flow share: natural MAR was asked for, but GR4J ran once on the catchment rain, so each unit’s natural MAR share is its flow share';
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
			t.toNodeId === null ? 'Outside the catchment' : (name.get(t.toNodeId) ?? '–'),
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
			return [seriesKindLabel(s) + (s.name ? ` · ${s.name}` : ''), s.startDate, dataEnd(s), fmtNum(s.length), fmtNum(inRun)];
		});
}

/** The report's Rainfall stations table (issue #553): its header and which of its columns are numbers. */
export const STATION_HEAD = ['Area', 'Station', 'Area MAP (mm)', 'Station MAP (mm)', 'Ratio', 'Days from the station', 'Days from corrected CHIRPS', 'Days from the fallback', 'CHIRPS corrected against'];
export const STATION_NUMS = [2, 3, 5, 6, 7];

/**
 * Each area the run forced from a rainfall station (summary.stations, engine
 * ≥ 1.91.0): the catchment first, then the units in network order; its
 * station, both MAPs with their sources, the ratio, the days by source and
 * the pairing correcting its CHIRPS. Empty on a run without stations.
 */
export function stationRows(summary: unknown, order: readonly string[] = []): string[][] {
	const s = stationsOf(summary);
	if (!s) return [];
	const src = (mm: number | null, source: string | null) => (mm === null ? '–' : `${fmtNum(mm)}${source ? ` (${source})` : ''}`);
	return stationAreas(s, order).map((a) => [
		a.nodeId === null ? `${a.name} (catchment)` : a.name,
		a.stationName,
		src(a.areaMapMm, a.areaMapSource),
		src(a.stationMapMm, a.stationMapSource),
		ratioText(a) + (a.clamped ? ', held at the bound' : ''),
		fmtNum(a.days.station),
		fmtNum(a.days.chirps),
		fmtNum(a.days.fallback),
		correctedByName(s, a) ?? 'none (gaps from the fallback)'
	]);
}

/** The report's Station CHIRPS pairings table (issue #553): its header and number columns. */
export const PAIRING_HEAD = ['Station', 'CHIRPS at', 'Fit period', 'Shared days', 'Monthly factors'];
export const PAIRING_NUMS = [3];

/** Each station's CHIRPS pairing: where its CHIRPS came from, the fit period, the shared days, the 12 factors or why it was refused. */
export function stationPairingRows(summary: unknown): string[][] {
	return (stationsOf(summary)?.pairings ?? []).map((p) => [p.stationName, chirpsAtText(p), pairingPeriodText(p), fmtNum(p.days), pairingFactorsText(p) + (p.pinned ? ' (pinned)' : '')]);
}

/**
 * The credits a run's report owes (issue #604 R4-E, docs/data-sources.md):
 * ERA5-Land's Copernicus notice and citation and IMERG Late's citation when
 * the run read them, ECMWF's for a forecast an ECMWF feed wrote, each word
 * for word; read on the run's creation day. Empty for a run on CHIRPS alone
 * and an uploaded forecast, whose reports read as before.
 */
export function reportRainCredits(run: { createdAt: string; forecastRainSource?: string | null; forecastRainEcmwf?: boolean; summary?: Parameters<typeof runRainCredits>[0]['summary'] }): RainCredit[] {
	return runRainCredits(run, run.createdAt.slice(0, 10));
}
