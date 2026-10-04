// Pure helpers for the per-node daily series overlay on the compare page
// (issue #8, docs/run-comparison.md § Daily series). Kept free of Svelte and
// the API so scenario comparison (issue #18) can reuse them for a base run
// against a scenario run.
import {
	beforeForecast,
	FARM_COLUMNS,
	fromEpochDay,
	GAUGE_COLUMNS,
	matchByIdThenName,
	toEpochDay,
	USER_COLUMNS,
	type DailySeries,
	type FarmColumn,
	type NodeKind
} from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** One stored output series of a run (GET …/runs/:runId `series`). */
export interface SeriesRefLike {
	nodeId: string | null;
	key: string;
	label: string;
	unit: string;
}

/** A node as a run's model snapshot holds it. */
export interface NodeLike {
	id: string;
	name: string;
	sortOrder?: number;
	/** Farm, gauge or other user: decides which missing series read as 0 (zeroFillable). */
	kind?: NodeKind;
}

/**
 * One series to overlay: both sides stored it with the same unit, or one side
 * stored it and the other's absence means 0 (`onlyIn`, see zeroFillable).
 */
export interface OverlayOption {
	key: string;
	label: string;
	unit: string;
	/** Only this run stored it; the other run's side is drawn as 0 (it has no such feature there). */
	onlyIn?: 'A' | 'B';
}

/** A place that can be overlaid: the catchment, or one node matched across the two runs. */
export interface OverlayGroup {
	/** Stable id for a <select>: 'catchment', or "<nodeIdA>|<nodeIdB>". */
	id: string;
	nodeIdA: string | null;
	nodeIdB: string | null;
	/** B's name (the model as it is now); the catchment's fixed label. */
	label: string;
	/** A's name when the node was renamed between the runs. */
	wasName: string | null;
	options: OverlayOption[];
}

export interface OverlayNodeRef {
	nodeId: string;
	name: string;
}

export interface OverlayMatch {
	groups: OverlayGroup[];
	/** Nodes with series in run A only: no counterpart in B, so nothing to overlay. */
	onlyA: OverlayNodeRef[];
	onlyB: OverlayNodeRef[];
	/** Nodes in both runs whose series share no key with the same unit. */
	noCommon: OverlayNodeRef[];
}

export const CATCHMENT_GROUP = 'catchment';
export const CATCHMENT_LABEL = 'Catchment (outflow gauge)';

const optionalKeys = (cols: readonly FarmColumn[]) => new Set(cols.filter((c) => c.optional).map((c) => c.key));
const OPTIONAL_BY_KIND: Record<NodeKind, ReadonlySet<string>> = {
	farm: optionalKeys(FARM_COLUMNS),
	user: optionalKeys(USER_COLUMNS),
	gauge: optionalKeys(GAUGE_COLUMNS)
};
// The catchment's one feature column: the engine stores it only when a node
// has land cover (run.ts), so a run without land cover removed nothing.
const OPTIONAL_CATCHMENT: ReadonlySet<string> = new Set(['landcover_reduction']);

/**
 * Whether a series a run didn't store means 0 there, for a node of this kind
 * (null = the catchment; undefined = a node whose kind is unknown or differs
 * between the runs). Only the engine's feature columns qualify, the ones the
 * column registry marks `optional` (packages/engine/src/verify/columns.ts):
 * the run simply had no river pump, borehole, release rule, land cover or
 * senior user there, so nothing was pumped, released or removed. Anything
 * else missing (observed flow, calibration series, a column an older engine
 * didn't compute) is unknown, never 0.
 */
export function zeroFillable(key: string, kind: NodeKind | null | undefined): boolean {
	if (kind === undefined) return false;
	return (kind === null ? OPTIONAL_CATCHMENT : OPTIONAL_BY_KIND[kind]).has(key);
}

/**
 * Series keys in both lists with the same unit, in B's order (B's label).
 * With `kind` given (see zeroFillable), a feature series only one side stored
 * is offered too, after them (B's, then A's), marked `onlyIn`.
 */
export function commonOptions(a: readonly SeriesRefLike[], b: readonly SeriesRefLike[], kind?: NodeKind | null): OverlayOption[] {
	const unitA = new Map(a.map((r) => [r.key, r.unit]));
	const keysB = new Set(b.map((r) => r.key));
	const out: OverlayOption[] = b.filter((r) => unitA.get(r.key) === r.unit).map(({ key, label, unit }) => ({ key, label, unit }));
	if (kind === undefined) return out;
	const only = (refs: readonly SeriesRefLike[], other: { has(k: string): boolean }, side: 'A' | 'B') =>
		refs.filter((r) => !other.has(r.key) && zeroFillable(r.key, kind)).map(({ key, label, unit }) => ({ key, label, unit, onlyIn: side }));
	return [...out, ...only(b, unitA, 'B'), ...only(a, keysB, 'A')];
}

/**
 * The zeros drawn for the run that has no such series: one per day of that
 * run's period (startDate … endDate, inclusive), so the overlay, B − A and
 * the read-out cover exactly the days that run modelled.
 */
export function zeroSeries(startDate: string, endDate: string): DailySeries {
	const n = toEpochDay(endDate) - toEpochDay(startDate) + 1;
	return { startDate, values: new Array<number>(Math.max(0, n)).fill(0) };
}

function byNode(refs: readonly SeriesRefLike[]): Map<string | null, SeriesRefLike[]> {
	const m = new Map<string | null, SeriesRefLike[]>();
	for (const r of refs) {
		if (!m.has(r.nodeId)) m.set(r.nodeId, []);
		m.get(r.nodeId)!.push(r);
	}
	return m;
}

/** The nodes that stored series, in network order; a node missing from the snapshot keeps its id. */
function nodesWithSeries(series: Map<string | null, SeriesRefLike[]>, nodes: readonly NodeLike[]) {
	const known = new Map(nodes.map((n, i) => [n.id, { n, i }]));
	const out: { id: string; name: string; order: number; named: boolean; kind: NodeKind | undefined }[] = [];
	for (const id of series.keys()) {
		if (id === null) continue;
		const k = known.get(id);
		out.push({ id, name: k?.n.name ?? 'Unknown node', order: k ? (k.n.sortOrder ?? k.i) : 1e9, named: !!k, kind: k?.n.kind });
	}
	return out.sort((x, y) => x.order - y.order || x.name.localeCompare(y.name));
}

/**
 * Line up the series two runs stored, node by node, using the comparison's
 * own rule (docs/run-comparison.md § How runs are matched): by id first,
 * then by name (trimmed, case-insensitive), so a renamed node in one project
 * and a node across a copy both match. The catchment comes first. A node only
 * one run has, or whose series share nothing, can't be overlaid and is
 * listed instead. A feature series only one run stored at a matched node (a
 * river pump the scenario added) is offered with the other side read as 0,
 * under zeroFillable's rule.
 */
export function matchOverlay(
	refsA: readonly SeriesRefLike[],
	refsB: readonly SeriesRefLike[],
	nodesA: readonly NodeLike[],
	nodesB: readonly NodeLike[]
): OverlayMatch {
	const sa = byNode(refsA);
	const sb = byNode(refsB);
	const groups: OverlayGroup[] = [];
	const catchment = commonOptions(sa.get(null) ?? [], sb.get(null) ?? [], null);
	if (catchment.length) groups.push({ id: CATCHMENT_GROUP, nodeIdA: null, nodeIdB: null, label: CATCHMENT_LABEL, wasName: null, options: catchment });

	const na = nodesWithSeries(sa, nodesA);
	const nb = nodesWithSeries(sb, nodesB);
	// A node the snapshot doesn't name matches by id only.
	const matchName = (x: { id: string; name: string; named: boolean }) => (x.named ? x.name : `\u0000${x.id}`);
	const { pairs, onlyA, onlyB } = matchByIdThenName(na, nb, (x) => x.id, matchName);
	const noCommon: OverlayNodeRef[] = [];
	for (const [a, b] of pairs) {
		// A feature series one run lacks reads as 0 only for a node both snapshots know as the same kind.
		const kind = a.kind !== undefined && a.kind === b.kind ? a.kind : undefined;
		const options = commonOptions(sa.get(a.id)!, sb.get(b.id)!, kind);
		if (!options.length) {
			noCommon.push({ nodeId: b.id, name: b.name });
			continue;
		}
		// Case and whitespace alone are how a copy matched, not a rename worth naming.
		const renamed = a.name.trim().toLowerCase() !== b.name.trim().toLowerCase();
		groups.push({ id: `${a.id}|${b.id}`, nodeIdA: a.id, nodeIdB: b.id, label: b.name, wasName: renamed ? a.name : null, options });
	}
	const ref = (x: { id: string; name: string }) => ({ nodeId: x.id, name: x.name });
	return { groups, onlyA: onlyA.map(ref), onlyB: onlyB.map(ref), noCommon };
}

/** The series to open on: the same kind as before when the group has it, else outflow, else the first. */
export function pickOption(group: OverlayGroup | undefined, current: string): string {
	if (!group) return '';
	if (group.options.some((o) => o.key === current)) return current;
	for (const k of ['simulated_outflow', 'outflow']) if (group.options.some((o) => o.key === k)) return k;
	return group.options[0]?.key ?? '';
}

const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/**
 * B − A day by day over the days both series cover. A day either side has no
 * value for is a gap (null), never zero. No shared days → no values.
 */
export function seriesDelta(a: DailySeries, b: DailySeries): DailySeries {
	const a0 = toEpochDay(a.startDate);
	const b0 = toEpochDay(b.startDate);
	const start = Math.max(a0, b0);
	const end = Math.min(a0 + a.values.length, b0 + b.values.length);
	const values: (number | null)[] = [];
	for (let d = start; d < end; d++) {
		const x = a.values[d - a0];
		const y = b.values[d - b0];
		values.push(finite(x) && finite(y) ? y - x : null);
	}
	return { startDate: fromEpochDay(start), values };
}

export interface DeltaStats {
	/** Days with a value in both runs. */
	days: number;
	meanA: number | null;
	meanB: number | null;
	/** Mean of B − A over those days. */
	meanDelta: number | null;
	/** The day with the largest |B − A| (the first such day). */
	largest: { date: string; delta: number } | null;
	/** Days on which B is above / below A. */
	daysHigher: number;
	daysLower: number;
}

/**
 * A run's series as the difference and the read-out take it: on a forecast
 * run, the days before its first forecast day (issue #51; a forecast is shown
 * in the overlay's band, never counted as the record). The series itself for
 * an ordinary run.
 */
export function recordOf(d: DailySeries, forecastFrom: string | null | undefined): DailySeries {
	return forecastFrom ? { startDate: d.startDate, values: Array.from(beforeForecast(d.values, d.startDate, forecastFrom)) } : d;
}

/** The overlay's forecast band starts at the earlier first forecast day of the two runs; null when neither is a forecast run. */
export function overlayForecastFrom(a: string | null | undefined, b: string | null | undefined): string | null {
	if (a && b) return a < b ? a : b;
	return a || b || null;
}

/** Relative difference below which two runs' values on a day count as the same (float rounding, not a change). */
export const SAME_VALUE_TOLERANCE = 1e-9;

/** A read-out of the overlay over the days both runs have a value (the text beside the canvas chart). */
export function deltaStats(a: DailySeries, b: DailySeries): DeltaStats {
	const a0 = toEpochDay(a.startDate);
	const b0 = toEpochDay(b.startDate);
	const start = Math.max(a0, b0);
	const end = Math.min(a0 + a.values.length, b0 + b.values.length);
	let days = 0;
	let sa = 0;
	let sb = 0;
	let higher = 0;
	let lower = 0;
	let largest: { date: string; delta: number } | null = null;
	for (let d = start; d < end; d++) {
		const x = a.values[d - a0];
		const y = b.values[d - b0];
		if (!finite(x) || !finite(y)) continue;
		days++;
		sa += x;
		sb += y;
		// A change within float rounding of the values (the same water summed in another order) is no change:
		// counted, it made "B is higher on 10 days … the largest change is 0" for two runs that agree.
		const dv = Math.abs(y - x) <= SAME_VALUE_TOLERANCE * Math.max(Math.abs(x), Math.abs(y)) ? 0 : y - x;
		if (dv > 0) higher++;
		else if (dv < 0) lower++;
		if (dv !== 0 && (!largest || Math.abs(dv) > Math.abs(largest.delta))) largest = { date: fromEpochDay(d), delta: dv };
	}
	return {
		days,
		meanA: days ? sa / days : null,
		meanB: days ? sb / days : null,
		meanDelta: days ? (sb - sa) / days : null,
		largest,
		daysHigher: higher,
		daysLower: lower
	};
}

/**
 * A flow series the m³/s ↔ m³/day switch and log scale apply to: m³/day, and
 * not a demand, supply, deficit or EWR column (same rule as the Runs tab's
 * explorer, RunChart.svelte).
 */
export function isFlowSeries(o: Pick<OverlayOption, 'key' | 'unit'> | undefined): boolean {
	return !!o && o.unit === 'm³/day' && !/demand|supplied|deficit|ewr/.test(o.key);
}

/**
 * A value to three significant figures (whole numbers from 100 up), with a
 * real minus sign, and a "+" when `signed` and above zero. A daily difference
 * is often tiny beside the flow itself, so fixed decimals would round a real
 * change to "0".
 */
export function fmtSig(v: number | null, signed = false): string {
	if (v == null || !Number.isFinite(v)) return '–';
	const a = Math.abs(v);
	const digits = a === 0 ? 0 : Math.min(12, Math.max(0, 2 - Math.floor(Math.log10(a))));
	const s = fmtNum(v, digits, true).replace('-', '−');
	return signed && v > 0 ? `+${s}` : s;
}

/**
 * The overlay's read-out in words (beside a canvas chart a screen reader
 * can't read): the shared days, both means, the mean B − A, how often B is
 * above or below, and the largest change. `scale` converts the stored unit
 * into `unit` (1 / 86 400 for m³/day shown as m³/s).
 */
export function summaryText(s: DeltaStats, unit: string, scale = 1): string {
	if (s.days === 0) return 'The two runs share no day with a value for this series, so there is no difference to show.';
	const f = (v: number | null, signed = false) => fmtSig(v == null ? null : v * scale, signed);
	const u = unit ? ` ${unit}` : '';
	const plural = (n: number) => `${fmtNum(n)} day${n === 1 ? '' : 's'}`;
	const head = `Over the ${plural(s.days)} both runs have: mean A ${f(s.meanA)}, mean B ${f(s.meanB)}, B − A ${f(s.meanDelta, true)}${u}.`;
	if (!s.largest) return `${head} The two runs are identical on every one of those days.`;
	return `${head} B is higher on ${plural(s.daysHigher)} and lower on ${plural(s.daysLower)}; the largest change is ${f(s.largest.delta, true)}${u} on ${s.largest.date}.`;
}
