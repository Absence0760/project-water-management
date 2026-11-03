// Accumulated flow at each unit (Runs & results, `#res-cumulative`; docs/ui.md § Runs & results): each hydrological
// unit's daily flow accumulated down the network, so 20 from unit 1 and 25 of unit 2's own runoff below it is 45 at
// unit 2 (operator, 2026-11-03). Four ways to show it (FLOW_SHOWN); the lines, the series each adds up, the sums
// with their gaps, and the numbers over the days in view. Pure, unit-tested (accumulated.test.ts);
// AccumulatedFlows.svelte draws it.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import type { RunSeriesRef } from '#lib/api/types.js';
import { upstreamOf } from '#lib/components/network/reorder.js';

const SEC_PER_DAY = 86_400;

/** A unit's own runoff, column I (model.md §2.7): fragmented natural flow less any land-cover reduction, m³/day. */
export const RUNOFF_KEY = 'runoff';
/** Column H: the outflow of the elements directly upstream (less reach losses), m³/day. */
export const INFLOW_KEY = 'inflow_upstream';
/** Column U: what leaves the unit downstream, m³/day. */
export const OUTFLOW_KEY = 'outflow';
/** The catchment's simulated outflow at the outflow gauge, m³/day. */
export const CATCHMENT_FLOW_KEY = 'simulated_outflow';

export type FlowShown = 'natural' | 'arriving' | 'leaving' | 'incremental';

/** The "Flow shown" choices, in the select's order, each with what its lines are. */
export const FLOW_SHOWN: readonly { id: FlowShown; label: string; note: string }[] = [
	{
		id: 'natural',
		label: 'Natural, accumulated',
		note: 'Each line is the unit’s own runoff plus the runoff of every hydrological unit upstream of it, every branch included: the flow that would reach it with no dam or abstraction above it. The outlet’s line adds up every unit.'
	},
	{
		id: 'arriving',
		label: 'Modelled, arriving at the unit',
		note: 'Each line is the flow from upstream plus the unit’s own runoff: what reaches the unit after the dams and abstractions above it, before its own. The outlet’s line is the simulated outflow.'
	},
	{
		id: 'leaving',
		label: 'Modelled, leaving the unit',
		note: 'Each line is the unit’s outflow: what leaves it downstream after its own dam and abstraction. The outlet’s line is the simulated outflow.'
	},
	{
		id: 'incremental',
		label: 'Incremental only',
		note: 'Each line is the unit’s own runoff alone, the piece it adds to the river. The outlet has none of its own.'
	}
];

/** A stored series a line adds up: its key and node (null: the catchment's). */
export interface SeriesPart {
	key: string;
	nodeId: string | null;
}

export const partId = (p: SeriesPart) => `${p.nodeId ?? ''}|${p.key}`;

/** One line of the chart: a unit (its node), or the outlet (nodeId null). */
export interface FlowLine {
	/** Stable per line: the node id, or '__outlet'. */
	id: string;
	nodeId: string | null;
	label: string;
	/** Its colour token, by its place among every line, so neither hiding a line nor another choice recolours one. */
	color: string;
	/** Past the seventh line the palette repeats, dashed (then solid again); the legend and pick-list name each. */
	style: 'line' | 'dashed';
	/** The series summed into it, day by day. */
	parts: SeriesPart[];
	/** Natural, accumulated: the unit's own runoff (its share of the line, in the numbers). */
	own?: SeriesPart;
}

export const OUTLET_LINE_ID = '__outlet';
export const OUTLET_LABEL = 'Catchment outlet';

/**
 * The lines' colours, in order: the categorical palette's tokens that hold 3:1 on the card as a line in both themes
 * (WCAG 1.4.11; `--series-5` and `-6` are 2.1 and 2.7 on the light card, fine as a filled crop swatch, not as a
 * 1.5 px line), ordered so each neighbour stays ΔE00 ≥ 12 apart for every reader (accumulated.test.ts computes both
 * from app.css). `--series-4` is LineChart's own.
 */
export const LINE_TOKENS = ['--series-1', '--series-2', '--series-10', '--series-7', '--series-9', '--series-8', '--series-3'] as const;

/** A node as the network gives it: the run's model snapshot's or today's. */
export interface NetNode {
	id: string;
	kind?: unknown;
	downstreamNodeId?: unknown;
}

/**
 * The network the run used: its model snapshot's nodes when they carry the drains-into links, else today's model
 * (a run stored before the snapshot had them).
 */
export function runNetwork(runNodes: readonly NetNode[] | undefined, liveNodes: readonly NetNode[]): { id: string; kind: string | null; downstreamNodeId: string | null }[] {
	const snap = runNodes?.length && runNodes.every((n) => n.downstreamNodeId === null || typeof n.downstreamNodeId === 'string') ? runNodes : liveNodes;
	return snap.map((n) => ({ id: n.id, kind: typeof n.kind === 'string' ? n.kind : null, downstreamNodeId: typeof n.downstreamNodeId === 'string' ? n.downstreamNodeId : null }));
}

/**
 * Each hydrological unit (kind `farm`) the run stored an outflow for, in network order, with the units upstream of
 * it: every unit draining into it directly or through gauges, other users or other units, every branch
 * (network/reorder.ts upstreamOf, which a loop can't trap).
 */
export function unitsUpstream(
	refs: readonly Pick<RunSeriesRef, 'key' | 'nodeId'>[],
	network: readonly { id: string; kind: string | null; downstreamNodeId: string | null }[],
	order: ReadonlyMap<string, number>,
	names: ReadonlyMap<string, string>
): { id: string; label: string; upstream: string[] }[] {
	const stored = new Set(refs.filter((r) => r.key === OUTFLOW_KEY && r.nodeId !== null).map((r) => r.nodeId!));
	const units = network.filter((n) => n.kind === 'farm' && stored.has(n.id));
	const isUnit = new Set(units.map((u) => u.id));
	units.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || (names.get(a.id) ?? '').localeCompare(names.get(b.id) ?? ''));
	const rank = new Map(units.map((u, i) => [u.id, i]));
	return units.map((u) => ({
		id: u.id,
		label: names.get(u.id) ?? 'Unknown hydrological unit',
		upstream: [...upstreamOf(network, u.id)].filter((id) => isUnit.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!)
	}));
}

/**
 * The lines for a choice of flow: the outlet first (none for Incremental only), then each unit. A line whose series
 * the run didn't store is left out (an older run without one).
 */
export function flowLines(shown: FlowShown, units: readonly { id: string; label: string; upstream: string[] }[], refs: readonly Pick<RunSeriesRef, 'key' | 'nodeId'>[]): FlowLine[] {
	const have = new Set(refs.map((r) => partId({ key: r.key, nodeId: r.nodeId })));
	const runoff = (id: string): SeriesPart => ({ key: RUNOFF_KEY, nodeId: id });
	const all: Omit<FlowLine, 'color' | 'style'>[] = [];
	// The outlet's place comes first whatever the choice, so a unit keeps its colour across the choices.
	const outletParts: SeriesPart[] | null =
		shown === 'natural' ? units.map((u) => runoff(u.id)) : shown === 'incremental' ? null : [{ key: CATCHMENT_FLOW_KEY, nodeId: null }];
	all.push({ id: OUTLET_LINE_ID, nodeId: null, label: OUTLET_LABEL, parts: outletParts ?? [] });
	for (const u of units) {
		const parts =
			shown === 'natural'
				? [runoff(u.id), ...u.upstream.map(runoff)]
				: shown === 'arriving'
					? [{ key: INFLOW_KEY, nodeId: u.id }, runoff(u.id)]
					: shown === 'leaving'
						? [{ key: OUTFLOW_KEY, nodeId: u.id }]
						: [runoff(u.id)];
		all.push({ id: u.id, nodeId: u.id, label: u.label, parts, ...(shown === 'natural' ? { own: runoff(u.id) } : {}) });
	}
	return all
		.map((l, i) => ({ ...l, color: LINE_TOKENS[i % LINE_TOKENS.length]!, style: (Math.floor(i / LINE_TOKENS.length) % 2 ? 'dashed' : 'line') as FlowLine['style'] }))
		.filter((l) => l.parts.length > 0 && l.parts.every((p) => have.has(partId(p))));
}

/** A line's daily values, m³/day, and the days it has none. */
export interface SummedFlow {
	values: (number | null)[];
	/** Days on which any series the line adds up has no value: the line has none that day, never a smaller sum. */
	gapDays: number;
}

/** Day-by-day sum of series of the same days; a day missing (null, NaN, Infinity) from any of them is null. */
export function sumParts(parts: readonly (readonly (number | null | undefined)[])[]): SummedFlow {
	const n = parts.length ? Math.max(...parts.map((p) => p.length)) : 0;
	const values = new Array<number | null>(n);
	let gapDays = 0;
	for (let t = 0; t < n; t++) {
		let sum = 0;
		let ok = true;
		for (const p of parts) {
			const v = p[t];
			if (v == null || !Number.isFinite(v)) {
				ok = false;
				break;
			}
			sum += v;
		}
		values[t] = ok ? sum : null;
		if (!ok) gapDays++;
	}
	return { values, gapDays };
}

/** The first day whose point (00:00 UTC) is at or after `minSec` (a view's left edge), as an index within 0 … days − 1. */
export function firstDayInView(startDate: string, days: number, minSec: number): number {
	if (days <= 0) return 0;
	const d = Math.ceil((minSec - toEpochDay(startDate) * SEC_PER_DAY) / SEC_PER_DAY - 1e-6);
	return Math.min(days - 1, Math.max(0, d));
}

/** The last day whose point is at or before `maxSec` (a view's right edge), as an index from `startDate`. */
export function lastDayInView(startDate: string, days: number, maxSec: number): number {
	if (days <= 0) return 0;
	const d = Math.floor((maxSec - toEpochDay(startDate) * SEC_PER_DAY) / SEC_PER_DAY + 1e-6);
	return Math.min(days - 1, Math.max(0, d));
}

/** The days in view as indices (the whole record with no view yet). */
export function viewDays(startDate: string, days: number, view: { min: number; max: number } | null): { from: number; to: number } {
	return view ? { from: firstDayInView(startDate, days, view.min), to: lastDayInView(startDate, days, view.max) } : { from: 0, to: Math.max(0, days - 1) };
}

/** The ISO day `index` days after `startDate`. */
export const dayAt = (startDate: string, index: number) => fromEpochDay(toEpochDay(startDate) + index);

/** Mean, lowest and highest of the days from..to that have a value; nulls when none has. */
export function lineStats(values: readonly (number | null)[], from: number, to: number): { mean: number | null; min: number | null; max: number | null; days: number } {
	let sum = 0;
	let days = 0;
	let min = Infinity;
	let max = -Infinity;
	for (let t = Math.max(0, from); t <= to && t < values.length; t++) {
		const v = values[t];
		if (v == null) continue;
		sum += v;
		days++;
		if (v < min) min = v;
		if (v > max) max = v;
	}
	return days ? { mean: sum / days, min, max, days } : { mean: null, min: null, max: null, days: 0 };
}

/** The share of a line's volume over from..to that is the unit's own runoff, 0–1, over the days the line has; null with no flow. */
export function ownShare(own: readonly (number | null)[], line: readonly (number | null)[], from: number, to: number): number | null {
	let o = 0;
	let l = 0;
	for (let t = Math.max(0, from); t <= to && t < line.length; t++) {
		const v = line[t];
		if (v == null) continue;
		l += v;
		o += own[t] ?? 0;
	}
	return l > 0 ? o / l : null;
}

/**
 * Run `get` over `items`, `atOnce` at a time (the Runs cache's pattern, overview/damLevels.ts), resolving with the
 * results in the items' order; the first failure rejects. `onDone` reports each one finished.
 */
export async function eachAtOnce<T, R>(items: readonly T[], get: (item: T) => Promise<R>, atOnce = 4, onDone?: (done: number) => void): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	let done = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await get(items[i]!);
			onDone?.(++done);
		}
	};
	await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
	return out;
}
