// Cumulative flow at each unit (Runs & results, `#res-cumulative`; docs/ui.md
// § Runs & results): the running total of each hydrological unit's daily
// outflow, and the catchment's simulated outflow, in Mm³, either from the
// run's first day or from the first day in the chart's view. Pure, unit-tested
// (cumulative.test.ts); CumulativeFlows.svelte draws it.
import { fromEpochDay, toEpochDay } from '@water-management/engine';
import type { RunSeriesRef } from '#lib/api/types.js';

const SEC_PER_DAY = 86_400;

/** The stored series charted for a unit: what leaves it downstream (model.md §2.7, column U), upstream inflow included. */
export const UNIT_FLOW_KEY = 'outflow';
/** The catchment's: the simulated outflow at the outflow gauge. */
export const CATCHMENT_FLOW_KEY = 'simulated_outflow';

/** One line of the chart: a unit (its node), or the catchment (nodeId null). */
export interface CumulativeLine {
	/** Stable per line: the node id, or '__catchment'. */
	id: string;
	nodeId: string | null;
	key: string;
	label: string;
	/** Its colour token, by its place in the whole list, so hiding another line never recolours it. */
	color: string;
	/** Past the seventh line the palette repeats, dashed (then solid again), and the legend and pick-list name each. */
	style: 'line' | 'dashed';
}

export const CATCHMENT_LINE_ID = '__catchment';

/**
 * The lines' colours, in order: the categorical palette's tokens that hold 3:1 on the card as a line in both themes
 * (WCAG 1.4.11; `--series-5` and `-6` are 2.1 and 2.7 on the light card, fine as a filled crop swatch, not as a
 * 1.5 px line), ordered so each neighbour stays ΔE00 ≥ 12 apart for every reader (cumulative.test.ts computes both
 * from app.css). `--series-4` is LineChart's own.
 */
export const LINE_TOKENS = ['--series-1', '--series-2', '--series-10', '--series-7', '--series-9', '--series-8', '--series-3'] as const;

/**
 * The lines to draw: the catchment first (the outlet's simulated outflow), then each hydrological unit (a node of
 * kind `farm`) with a stored outflow, in network order. A unit's kind comes from the run's own model snapshot, else
 * today's model (`liveKinds`); a node of neither (removed since, with no snapshot) is left out, as are gauges (their
 * flow is the sum of the units above) and other water users (not hydrological units).
 */
export function cumulativeLines(
	refs: readonly Pick<RunSeriesRef, 'key' | 'nodeId'>[],
	runNodes: readonly { id: string; kind?: unknown }[] | undefined,
	liveKinds: ReadonlyMap<string, string>,
	order: ReadonlyMap<string, number>,
	names: ReadonlyMap<string, string>
): CumulativeLine[] {
	const snapKind = new Map((runNodes ?? []).map((n) => [n.id, typeof n.kind === 'string' ? n.kind : undefined]));
	const kindOf = (id: string) => snapKind.get(id) ?? liveKinds.get(id);
	const out: Omit<CumulativeLine, 'color' | 'style'>[] = [];
	if (refs.some((r) => r.nodeId === null && r.key === CATCHMENT_FLOW_KEY)) {
		out.push({ id: CATCHMENT_LINE_ID, nodeId: null, key: CATCHMENT_FLOW_KEY, label: 'Catchment outlet (simulated outflow)' });
	}
	const units = refs.filter((r): r is typeof r & { nodeId: string } => r.nodeId !== null && r.key === UNIT_FLOW_KEY && kindOf(r.nodeId) === 'farm');
	const seen = new Set<string>();
	const sorted = units
		.filter((r) => !seen.has(r.nodeId) && !!seen.add(r.nodeId))
		.sort((a, b) => (order.get(a.nodeId) ?? 1e9) - (order.get(b.nodeId) ?? 1e9) || (names.get(a.nodeId) ?? '').localeCompare(names.get(b.nodeId) ?? ''));
	for (const r of sorted) out.push({ id: r.nodeId, nodeId: r.nodeId, key: UNIT_FLOW_KEY, label: names.get(r.nodeId) ?? 'Unknown hydrological unit' });
	return out.map((l, i) => ({ ...l, color: LINE_TOKENS[i % LINE_TOKENS.length]!, style: Math.floor(i / LINE_TOKENS.length) % 2 ? 'dashed' : 'line' }));
}

/** A running total, in Mm³, of daily volumes in m³/day, and the days with no value. */
export interface RunningTotal {
	/** The total at the end of each day, Mm³. A day with no value carries the day before's total (0 before the first). */
	totals: number[];
	/** Days with no value (null or not finite): counted as nothing, the total carried across them. */
	gapDays: number;
}

/** m³/day summed over days → Mm³: a day's volume is its m³/day × 1 day. */
export const m3ToMm3 = (m3: number) => m3 / 1e6;

export function runningTotal(values: readonly (number | null | undefined)[]): RunningTotal {
	const totals = new Array<number>(values.length);
	let sum = 0;
	let gapDays = 0;
	for (let i = 0; i < values.length; i++) {
		const v = values[i];
		if (v == null || !Number.isFinite(v)) gapDays++;
		else sum += v;
		totals[i] = m3ToMm3(sum);
	}
	return { totals, gapDays };
}

/**
 * The totals counted from day `from` instead of the first: each day's total less the total at the end of the day
 * before `from`, so day `from` shows its own volume and the line starts from 0. Days before `from` are null (not
 * drawn: they aren't in the period being counted). `from` 0 returns the totals unchanged.
 */
export function rebase(totals: readonly number[], from: number): (number | null)[] {
	if (from <= 0) return totals.slice();
	const base = totals[Math.min(from, totals.length) - 1] ?? 0;
	return totals.map((t, i) => (i < from ? null : t - base));
}

/**
 * The first day whose point (00:00 UTC) is at or after `minSec` (a view's left edge, epoch seconds), as an index
 * from `startDate`, within 0 … days − 1. A zoom box can start mid-day: that day's point is outside the view.
 */
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

/** The ISO day `index` days after `startDate`. */
export const dayAt = (startDate: string, index: number) => fromEpochDay(toEpochDay(startDate) + index);

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

/**
 * The days a line counts over, as indices: from the run's first day (or, with `fromView`, the first day in the
 * view) to the last day in the view (the last day, with no view yet).
 */
export function countWindow(startDate: string, days: number, view: { min: number; max: number } | null, fromView: boolean): { from: number; to: number } {
	return {
		from: fromView && view ? firstDayInView(startDate, days, view.min) : 0,
		to: view ? lastDayInView(startDate, days, view.max) : Math.max(0, days - 1)
	};
}

/** The volume from the start of day `from` to the end of day `to`, Mm³; null when the window is empty. */
export function volumeBetween(totals: readonly number[], from: number, to: number): number | null {
	if (!totals.length || to < from) return null;
	return (totals[to] ?? 0) - (from > 0 ? (totals[from - 1] ?? 0) : 0);
}
