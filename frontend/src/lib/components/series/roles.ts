// What the model does with each series kind (see packages/engine run.ts /
// flow.ts), for the Time series tab's explanation and per-series badges.
import type { SeriesMeta } from '@water-management/engine';

export interface KindRole {
	/** Short badge text. */
	role: string;
	help: string;
	/** Drives the simulation (vs. calibration only). */
	driver: boolean;
}

export const KIND_ROLES: Record<string, KindRole> = {
	rain_catchment_mm: {
		role: 'Main rainfall',
		help: 'Daily catchment rainfall (mm). Drives natural flow and reduces irrigation demand on rainy days (effective rainfall).',
		driver: true
	},
	rain_chirps_mm: {
		role: 'Rain gap-filler',
		help: 'CHIRPS satellite rainfall (mm). Used on days the catchment rainfall record is missing.',
		driver: true
	},
	rain_forecast_mm: {
		role: 'Forecast rain',
		help: 'Forecast rainfall (mm). Used only on days both catchment and CHIRPS rainfall are missing, e.g. to run into the coming days.',
		driver: true
	},
	rain_catchment_alt_mm: {
		role: 'Rain-source period',
		help: 'A second catchment gauge (mm), e.g. an in-catchment automatic station. Read only inside a rain-source period (Settings → Rain source), where it replaces the catchment rainfall × monthly factors.',
		driver: true
	},
	rain_reanalysis_mm: {
		role: 'Rain reference',
		help: 'A gauge-free reanalysis such as ERA5 (mm). Read only by a rain-source period (Settings → Rain source): the reference its factors are fitted against, or the series its gaps fall through to.',
		driver: true
	},
	evap_apan_mm: {
		role: 'Daily evaporation',
		help: 'Daily Class-A pan evaporation (mm), e.g. from a nearby weather station. On the days it has a value it replaces the monthly A-pan means (Settings → Demand) for crop demand, dam evaporation and GR4J\'s potential evaporation (pan coefficient × A-pan); other days use the monthly means, and the run says how many.',
		driver: true
	},
	flow_observed_m3s: {
		role: 'Calibration target',
		help: 'Observed flow at the outflow gauge (m³/s, daily mean). Not an input to the water balance: runs compare simulated outflow with it (NSE, PBIAS). A record attached to a gauge inside the network is checked against the simulated flow there (Plausibility checks), never calibrated against.',
		driver: false
	},
	flow_logger_m3s: {
		role: 'Calibration (fallback)',
		help: 'Logger flow at the outflow gauge (m³/s). Used for calibration only when there is no observed-gauge series.',
		driver: false
	},
	flow_reference_m3s: {
		role: 'Reference only',
		help: 'A gauge on a different river, e.g. a neighbouring sub-catchment (m³/s). A regional wet/dry index only: Fit automatically ranks water years dry → wet by it for its dry → wet test, but runs never read it, and nothing is calibrated against it or compared with the EWR.',
		driver: false
	}
};

/** Kinds a run never reads, so no series of the kind is ever "in use". */
const NEVER_READ = new Set(['flow_reference_m3s']);
/** Kinds a run reads only when a rain-source period names them (engine ≥ 0.30.0). */
const PERIOD_ONLY = new Set(['rain_catchment_alt_mm', 'rain_reanalysis_mm']);
/** A kind a run reads only when a rain-source period names it. */
export const isPeriodOnly = (kind: string) => PERIOD_ONLY.has(kind);

/** The series kinds settings.rainSource periods name: the period's series, its fit reference and its fallback. */
export function rainSourceKinds(periods: readonly { series: string; fitReference?: { series: string }; fallback?: { series: string } }[] | null | undefined): Set<string> {
	const out = new Set<string>();
	for (const p of periods ?? []) {
		out.add(p.series);
		if (p.fitReference) out.add(p.fitReference.series);
		if (p.fallback) out.add(p.fallback.series);
	}
	return out;
}

/**
 * Ids of the series a run actually reads: the first of each kind by name
 * (the backend's DISTINCT ON (kind) … ORDER BY kind, name), and the logger
 * only when there is no observed-gauge series. A reference gauge is never in
 * use: the engine ignores it. The alternative catchment gauge and the
 * reanalysis are in use only when a rain-source period names them
 * (`periodKinds`, rainSourceKinds). A flow record attached to a gauge node
 * (`siteNodeId`, 084_gauge_records) is never the outlet's; see gaugeRecordsInUse.
 */
export function seriesInUse(list: SeriesMeta[], periodKinds: ReadonlySet<string> = new Set()): Set<string> {
	const first = new Map<string, SeriesMeta>();
	for (const s of [...list].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
		if (s.siteNodeId) continue;
		if (PERIOD_ONLY.has(s.kind) && !periodKinds.has(s.kind)) continue;
		if (!first.has(s.kind) && !NEVER_READ.has(s.kind)) first.set(s.kind, s);
	}
	if (first.has('flow_observed_m3s')) first.delete('flow_logger_m3s');
	return new Set([...first.values()].map((s) => s.id));
}

/** The kinds that can be attached to a gauge node inside the network (engine CALIBRATION_FLOW_KINDS). */
export const SITED_KINDS = new Set(['flow_observed_m3s', 'flow_logger_m3s']);

/**
 * Ids of the gauge records a run checks (engine ≥ 1.4.0): per gauge in
 * `gauges` (the model's gauges above the outlet), the first series of each
 * flow kind by name attached to it, as the backend's loadLiveInput reads them.
 * A record on a node that is no longer such a gauge is not read.
 */
export function gaugeRecordsInUse(list: SeriesMeta[], gauges: readonly { id: string }[]): Set<string> {
	const ids = new Set(gauges.map((g) => g.id));
	const first = new Map<string, SeriesMeta>();
	for (const s of [...list].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
		if (!s.siteNodeId || !ids.has(s.siteNodeId) || !SITED_KINDS.has(s.kind)) continue;
		const k = `${s.siteNodeId}|${s.kind}`;
		if (!first.has(k)) first.set(k, s);
	}
	return new Set([...first.values()].map((s) => s.id));
}
