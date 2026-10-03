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
		help: 'Observed flow at the outflow gauge (m³/s, daily mean). Not an input to the water balance: runs compare simulated outflow with it (NSE, PBIAS). A record attached to a gauge inside the network is checked against the simulated flow there (Plausibility checks), and calibrated against only when Settings → Calibration record scores the fit at that gauge.',
		driver: false
	},
	flow_logger_m3s: {
		role: 'Calibration (fallback)',
		help: 'Logger flow at the outflow gauge (m³/s). Used for calibration only when there is no observed-gauge series.',
		driver: false
	},
	flow_reference_m3s: {
		role: 'Reference only',
		help: 'A gauge on a different river, e.g. a neighbouring sub-catchment (m³/s). A wet/dry index only: Fit ranks water years by it; runs never read it, calibrate against it or compare it with the EWR.',
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

/** What a new series of `kind` named `name` does to the series a run reads (UploadForm's "Creates a new series"). */
export interface NewSeriesEffect {
	/**
	 * `first`: the kind has no series yet. `replaces`: a run will read the new
	 * one instead of `current`. `keeps`: a run keeps reading `current`.
	 * `unread`: a run reads no series of the kind either way (a reference
	 * gauge, a logger beside an observed gauge, a kind only a rain-source
	 * period reads), so there is nothing to say about which.
	 */
	effect: 'first' | 'replaces' | 'keeps' | 'unread';
	current: SeriesMeta | null;
	/** A series of the kind whose name differs from `name` only in case or spacing, the likely meant one. */
	didYouMean: SeriesMeta | null;
}

/**
 * Whether a new upload's series takes over from the one a run reads: a run
 * reads the first of each kind by name (seriesInUse), so "Aa station" beside
 * "Station 0021" replaces it in runs, and "Zz station" doesn't. Uploads go to
 * the outlet, so a gauge's records (siteNodeId) don't count. Rain-source
 * periods aren't known here, so a period-only kind is `unread` unless it is
 * read anyway (never, today).
 */
export function newSeriesEffect(list: readonly SeriesMeta[], kind: string, name: string): NewSeriesEffect {
	const n = name.trim();
	const key = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
	const same = list.filter((s) => s.kind === kind && !s.siteNodeId);
	const didYouMean = (n && same.find((s) => s.name !== n && key(s.name) === key(n))) || null;
	if (same.length === 0) return { effect: 'first', current: null, didYouMean };
	const before = seriesInUse([...list]);
	const current = same.find((s) => before.has(s.id)) ?? null;
	const added: SeriesMeta = { id: '\0new', kind, name: n, unit: '', startDate: '2000-01-01', length: 0 };
	const after = seriesInUse([...list, added]);
	if (after.has(added.id)) return { effect: 'replaces', current, didYouMean };
	return current && after.has(current.id) ? { effect: 'keeps', current, didYouMean } : { effect: 'unread', current: null, didYouMean };
}

/**
 * A series row's role badge on the Data page, and the words that say why
 * when the badge alone doesn't (a gauge record: where it is checked and
 * scored). `why` shows on the page, not in a hover title, so keyboard, touch
 * and screen-reader users get it too; the kind's own role is its HelpTip
 * (`series.<kind>`).
 */
export function roleBadge(
	s: SeriesMeta,
	ctx: {
		list: readonly SeriesMeta[];
		inUse: ReadonlySet<string>;
		gaugeInUse: ReadonlySet<string>;
		gaugeIds: ReadonlySet<string>;
		calibrationSite: string | null;
	}
): { label: string; unused: boolean; why: string | null } | null {
	const role = KIND_ROLES[s.kind];
	if (!role) return null;
	const unused = !ctx.inUse.has(s.id) && !ctx.gaugeInUse.has(s.id);
	const kindRead = (k: string) => ctx.list.some((x) => x.kind === k && ctx.inUse.has(x.id));
	if (s.siteNodeId) {
		if (!ctx.gaugeInUse.has(s.id))
			return ctx.gaugeIds.has(s.siteNodeId)
				? { label: 'Not used (another record of this kind is at this gauge)', unused, why: null }
				: { label: 'Not used: its gauge is no longer in the model', unused, why: null };
		return s.siteNodeId === ctx.calibrationSite
			? { label: 'Gauge record (calibration site)', unused, why: 'Checked against the simulated flow at its gauge, and calibration scores it there; the EWR test uses the outlet’s records.' }
			: { label: 'Gauge record (checks only)', unused, why: 'Checked against the simulated flow at its gauge; calibration scores it only if Settings → Calibration record picks this gauge.' };
	}
	if (ctx.inUse.has(s.id) || s.kind === 'flow_reference_m3s') return { label: role.role, unused, why: null };
	if (s.kind === 'flow_logger_m3s' && !kindRead(s.kind)) return { label: 'Calibration if chosen in settings', unused, why: null };
	if (isPeriodOnly(s.kind) && !kindRead(s.kind)) return { label: 'Not used: no rain-source period names it', unused, why: null };
	return { label: 'Not used (another series of this kind is)', unused, why: null };
}
