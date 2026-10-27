// What the model does with each series kind (see packages/engine run.ts /
// flow.ts), for the Time series tab's explanation and per-series badges.
import type { SeriesMeta } from '@water-management/engine';
import { byKindThenName } from '#lib/series/pick.js';

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
		help: 'A second catchment gauge (mm), e.g. an in-catchment automatic station. Read only inside a rain-source period (Settings → Rain gaps → Flagged rain → Rain source periods), where it replaces the catchment rainfall × monthly factors.',
		driver: true
	},
	rain_reanalysis_mm: {
		role: 'Rain reference',
		help: 'A gauge-free reanalysis such as ERA5 (mm). Read only by a rain-source period (Settings → Rain gaps → Flagged rain → Rain source periods): the reference its factors are fitted against, or the series its gaps fall through to.',
		driver: true
	},
	evap_apan_mm: {
		role: 'Daily evaporation',
		help: 'Daily Class-A pan evaporation (mm), e.g. from a nearby weather station. On the days it has a value it replaces the monthly A-pan means (Settings → Demand) for crop demand, dam evaporation and GR4J\'s potential evaporation (pan coefficient × A-pan); other days use the monthly means, and the run says how many.',
		driver: true
	},
	evap_et0_mm: {
		role: 'Daily reference ET',
		help: 'Daily FAO-56 reference evapotranspiration (mm), e.g. an AgERA5 data feed (NASA POWER on its newest days) or a station\'s own. Read only by GR4J, and only when its potential evaporation is a monthly PE row (Calibration → Flow calibration): on the days it has a value it is that day\'s PE as it stands; other days use the row, and the run says how many. Crop demand and dam evaporation never read it.',
		driver: true
	},
	flow_observed_m3s: {
		role: 'Calibration target',
		help: 'Observed flow at the outflow gauge (m³/s, daily mean). Not an input to the water balance: runs compare simulated outflow with it (NSE, PBIAS). A record attached to a gauge inside the network is checked against the simulated flow there (Plausibility checks), and calibrated against only when Calibration → Calibration record scores the fit at that gauge.',
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
 * Ids of the series a run actually reads: the first of each kind by name, in
 * byte order (the backend's DISTINCT ON (kind) … ORDER BY kind, name COLLATE
 * "C", lib/series/pick.ts), and the logger
 * only when there is no observed-gauge series. A reference gauge is never in
 * use: the engine ignores it. The alternative catchment gauge and the
 * reanalysis are in use only when a rain-source period names them
 * (`periodKinds`, rainSourceKinds). A flow record attached to a gauge node
 * (`siteNodeId`, 084_gauge_records) is never the outlet's; see gaugeRecordsInUse.
 */
export function seriesInUse(list: SeriesMeta[], periodKinds: ReadonlySet<string> = new Set()): Set<string> {
	const first = new Map<string, SeriesMeta>();
	for (const s of byKindThenName(list)) {
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
	for (const s of byKindThenName(list)) {
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
 * reads the first of each kind by name in byte order (seriesInUse), so "Aa
 * station" beside "Station 0021" replaces it in runs, and "Zz station" or
 * "aa station" (lower case sorts after capitals) doesn't. Uploads go to
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
 * What renaming series `id` to `name` changes about the series a run reads
 * (issue #556). Runs read the first series of each kind, at each site, by
 * name, so a new name can move another series to the front or this one behind
 * it. Judged by the same rules as the role badges (seriesInUse,
 * gaugeRecordsInUse), on a renamed copy of the list: a reference gauge, a
 * logger beside an observed gauge, a kind no rain-source period names and a
 * record at a gauge no longer in the model are never read, so renaming them
 * asks nothing. The series read before and after, or null when the same one
 * is read (or none is), when another series of the kind has the name (the
 * server refuses it), or when `id` isn't in the list.
 */
export function renameEffect(
	list: readonly SeriesMeta[],
	id: string,
	name: string,
	periodKinds: ReadonlySet<string> = new Set(),
	gauges: readonly { id: string }[] = []
): { before: SeriesMeta; after: SeriesMeta } | null {
	const self = list.find((s) => s.id === id);
	if (!self || self.name === name) return null;
	if (list.some((s) => s.id !== id && s.kind === self.kind && s.name === name)) return null;
	const site = self.siteNodeId ?? null;
	const read = (l: SeriesMeta[]) => {
		const ids = new Set([...seriesInUse(l, periodKinds), ...gaugeRecordsInUse(l, gauges)]);
		return l.find((s) => ids.has(s.id) && s.kind === self.kind && (s.siteNodeId ?? null) === site) ?? null;
	};
	const before = read([...list]);
	const after = read(list.map((s) => (s.id === id ? { ...s, name } : s)));
	if (!before || !after || before.id === after.id) return null;
	return { before, after: list.find((s) => s.id === after.id)! };
}

/**
 * The rename question's sentence (issue #556): "Runs will read “B” instead of
 * “A” for Rainfall — catchment: …", with `where` after the kind for a record
 * at a gauge ("at gauge Middle weir"). The series read before goes by its
 * stored name, the one read after by the new `name` when it is the renamed
 * one; an unnamed series by its kind's label.
 */
export function renameEffectText(
	change: { before: SeriesMeta; after: SeriesMeta },
	id: string,
	name: string,
	kindLabel: (kind: string) => string,
	where: string | null = null
): string {
	const shown = (x: SeriesMeta, renamed: boolean) => (renamed && x.id === id ? name : x.name || kindLabel(x.kind));
	return `Runs will read “${shown(change.after, true)}” instead of “${shown(change.before, false)}” for ${kindLabel(change.before.kind)}${where ? ` ${where}` : ''}: they read the first series of each kind by name.`;
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
		/** The land units a rain series can be measured at (209_unit_rain_series): node id → name (issue #553). */
		units?: ReadonlyMap<string, string>;
		/** Per-unit rain is on (settings.unitRain `perUnit`): a unit's own rain is read for it. */
		unitRainOn?: boolean;
		/**
		 * Where each rainfall station's rain goes, by series id (groups.ts stationUses, issue #553): the areas a run
		 * reads it for, as their rain or their CHIRPS correction, and the units it is assigned to while per-unit rain
		 * is off. The row's "Rain for …" line reads the same, so the two never disagree (issue #589).
		 */
		stationUses?: ReadonlyMap<string, { rainFor: readonly string[]; corrects: readonly string[]; idle?: readonly string[] }>;
		/** settings.rainStations.catchment's station id: when it is one of the project's stations, it is the catchment rain, not the catchment rain series read by name (docs/model.md §2.4i). */
		catchmentStationId?: string | null;
	}
): { label: string; unused: boolean; why: string | null } | null {
	const role = KIND_ROLES[s.kind];
	if (!role) return null;
	const unused = !ctx.inUse.has(s.id) && !ctx.gaugeInUse.has(s.id);
	const kindRead = (k: string) => ctx.list.some((x) => x.kind === k && ctx.inUse.has(x.id));
	// A unit's own rain (its CHIRPS feed, a migration-209 gauge): read for that unit under per-unit rain, not a gauge record.
	const unit = s.siteNodeId ? ctx.units?.get(s.siteNodeId) : undefined;
	if (unit !== undefined)
		return ctx.unitRainOn ? { label: `${unit}’s own rain`, unused: false, why: null } : { label: 'Not used: per-unit rain is off', unused: true, why: null };
	// A rainfall station (catchment rain at no site, issue #553): the catchment rain a run reads by name keeps its role;
	// any other is read only for the areas settings.rainStations assigns it, as a run reads them (stationUses), and
	// says so in station terms, never as a second catchment rain series (issue #589). Its row's line names the areas.
	// With a station for the catchment, that station's rule is the catchment rain and the series read by name is read
	// only where it is assigned itself (the engine's catchmentStationPlan; a station no longer listed is not one).
	if (!s.siteNodeId && s.kind === 'rain_catchment_mm') {
		const cs = ctx.catchmentStationId;
		const catchmentStation = !!cs && ctx.list.some((x) => x.id === cs && !x.siteNodeId && x.kind === 'rain_catchment_mm');
		if (ctx.inUse.has(s.id) && !catchmentStation) return { label: role.role, unused: false, why: null };
		const uses = ctx.stationUses?.get(s.id);
		if (uses && (uses.rainFor.length > 0 || uses.corrects.length > 0)) return { label: 'Rainfall station', unused: false, why: null };
		if (uses?.idle?.length) return { label: 'Not used: per-unit rain is off', unused: true, why: null };
		if (ctx.inUse.has(s.id)) return { label: 'Not used: the catchment runs on its station', unused: true, why: null };
		return { label: 'Not used: no area is assigned to it', unused: true, why: null };
	}
	if (s.siteNodeId) {
		if (!ctx.gaugeInUse.has(s.id))
			return ctx.gaugeIds.has(s.siteNodeId)
				? { label: 'Not used (another record of this kind is at this gauge)', unused, why: null }
				: { label: 'Not used: its gauge is no longer in the model', unused, why: null };
		return s.siteNodeId === ctx.calibrationSite
			? { label: 'Gauge record (calibration site)', unused, why: 'Checked against the simulated flow at its gauge, and calibration scores it there; the EWR test uses the outlet’s records.' }
			: { label: 'Gauge record (checks only)', unused, why: 'Checked against the simulated flow at its gauge; calibration scores it only if Calibration → Calibration record picks this gauge.' };
	}
	if (ctx.inUse.has(s.id) || s.kind === 'flow_reference_m3s') return { label: role.role, unused, why: null };
	if (s.kind === 'flow_logger_m3s' && !kindRead(s.kind)) return { label: 'Calibration if chosen in settings', unused, why: null };
	if (isPeriodOnly(s.kind) && !kindRead(s.kind)) return { label: 'Not used: no rain-source period names it', unused, why: null };
	return { label: 'Not used (another series of this kind is)', unused, why: null };
}
