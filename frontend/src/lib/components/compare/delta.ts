// Formatting run-comparison deltas (b − a) for the compare page. Direction is
// always shown with a sign and ▲/▼, and whether that's better or worse is
// spelled out in text too, so colour is never the only cue (WCAG 1.4.1).
import type { FarmDelta, FarmSummary, MetricDelta } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** Which way is good for a metric. 'zero' / 'one' = closer to it; 'neutral' = neither (e.g. demand). */
export type Better = 'higher' | 'lower' | 'zero' | 'one' | 'neutral';

/** How a metric's value is shown. 'fraction' is 0–1 shown as %, deltas in percentage points. */
export type Format = 'volume' | 'days' | 'fraction' | 'percent' | 'ratio' | 'count';

export interface MetricSpec {
	format: Format;
	better: Better;
	/** Decimal places for values and deltas (default per format). */
	digits?: number;
}

export type Tone = 'better' | 'worse' | 'neutral';

export interface FormattedDelta {
	/** "+80", "−1 200", "+5.0 pp", "0", or "–" when unknown. */
	text: string;
	arrow: '▲' | '▼' | '';
	tone: Tone;
	/** For screen readers / tooltips, e.g. "up 80, better". */
	label: string;
}

const DEFAULT_DIGITS: Record<Format, number> = { volume: 0, days: 0, fraction: 1, percent: 1, ratio: 3, count: 0 };

/** Value as it is displayed (fraction → % with a sign-less "%" suffix). */
export function fmtMetric(v: number | null, spec: MetricSpec): string {
	const d = spec.digits ?? DEFAULT_DIGITS[spec.format];
	if (v === null) return '–';
	if (spec.format === 'fraction') return `${fmtNum(v * 100, d)}%`;
	if (spec.format === 'percent') return `${fmtNum(v, d)}%`;
	return fmtNum(v, d);
}

/**
 * The delta rounded the way it is displayed; a change that rounds to zero is
 * shown as "0" with no arrow, so "▲ +0" never appears.
 */
export function formatDelta(m: MetricDelta, spec: MetricSpec): FormattedDelta {
	if (m.delta === null) return { text: '–', arrow: '', tone: 'neutral', label: 'not comparable' };
	const d = spec.digits ?? DEFAULT_DIGITS[spec.format];
	const scaled = spec.format === 'fraction' ? m.delta * 100 : m.delta;
	const rounded = Number(scaled.toFixed(d));
	const unit = spec.format === 'fraction' || spec.format === 'percent' ? ' pp' : '';
	if (rounded === 0) return { text: `0${unit}`, arrow: '', tone: 'neutral', label: 'no change' };
	const up = rounded > 0;
	const text = `${up ? '+' : '−'}${fmtNum(Math.abs(rounded), d)}${unit}`;
	const tone = toneOf(m, spec.better);
	const words = `${up ? 'up' : 'down'} ${fmtNum(Math.abs(rounded), d)}${unit}`;
	return { text, arrow: up ? '▲' : '▼', tone, label: tone === 'neutral' ? words : `${words}, ${tone}` };
}

function toneOf(m: MetricDelta, better: Better): Tone {
	const delta = m.delta ?? 0;
	switch (better) {
		case 'higher':
			return delta > 0 ? 'better' : 'worse';
		case 'lower':
			return delta < 0 ? 'better' : 'worse';
		case 'zero':
		case 'one': {
			// e.g. percent bias: closer to 0 is better; a frequency bias: closer to 1.
			if (m.a === null || m.b === null) return 'neutral';
			const target = better === 'one' ? 1 : 0;
			const d = Math.abs(m.b - target) - Math.abs(m.a - target);
			return d < 0 ? 'better' : d > 0 ? 'worse' : 'neutral';
		}
		default:
			return 'neutral';
	}
}

// ---------------------------------------------------------------------------
// Farm delta table
// ---------------------------------------------------------------------------

export type FarmMetricKey = Exclude<keyof FarmDelta, 'name' | 'nameA' | 'nodeIdA' | 'nodeIdB'>;

export interface FarmColumn extends MetricSpec {
	key: FarmMetricKey;
	label: string;
	unit: string;
}

export const FARM_COLUMNS: readonly FarmColumn[] = [
	{ key: 'demandM3Day', label: 'Demand', unit: 'm³/day', format: 'volume', better: 'neutral' },
	{ key: 'suppliedM3Day', label: 'Supplied', unit: 'm³/day', format: 'volume', better: 'higher' },
	{ key: 'deficitM3Day', label: 'Deficit', unit: 'm³/day', format: 'volume', better: 'lower' },
	{ key: 'fractionSupplied', label: 'Supplied', unit: '% of demand', format: 'fraction', better: 'higher' },
	{ key: 'ewrShortfallM3Day', label: 'EWR charge', unit: 'm³/day', format: 'volume', better: 'lower' },
	{ key: 'daysEwrNotMet', label: 'Days charged for the EWR', unit: 'days', format: 'days', better: 'lower' }
];

export type SortKey = 'name' | FarmMetricKey;
export type SortDir = 'asc' | 'desc';

/**
 * Sort farm rows by name or by a metric's delta. Rows whose delta is unknown
 * always go last, whichever the direction.
 */
export function sortFarms(rows: readonly FarmDelta[], key: SortKey, dir: SortDir): FarmDelta[] {
	const sign = dir === 'asc' ? 1 : -1;
	return [...rows].sort((x, y) => {
		if (key === 'name') return sign * x.name.localeCompare(y.name, undefined, { sensitivity: 'base', numeric: true });
		const a = x[key].delta;
		const b = y[key].delta;
		if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
		return sign * (a - b) || x.name.localeCompare(y.name);
	});
}

/** Next sort state when a column header is clicked: a new metric column starts with the largest increase first. */
export function nextSort(current: { key: SortKey; dir: SortDir }, key: SortKey): { key: SortKey; dir: SortDir } {
	if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
	return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

// ---------------------------------------------------------------------------
// Feature metrics in the farm table (issue #54)
// ---------------------------------------------------------------------------

/** FarmSummary fields a run has only for a farm with the feature (a river pump, boreholes). */
export type FarmFeatureKey = 'avgRiverAbstractionM3Day' | 'avgGroundwaterM3Day' | 'avgGroundwaterToDamM3Day' | 'avgBaseflowDepletionM3Day';

export interface FarmFeatureColumn extends MetricSpec {
	key: FarmFeatureKey;
	label: string;
	unit: string;
	/** What a run without the field lacked at the farm, for the cell and the note under the table. */
	none: string;
}

export const FARM_FEATURE_COLUMNS: readonly FarmFeatureColumn[] = [
	{ key: 'avgRiverAbstractionM3Day', label: 'Pumped from the river', unit: 'm³/day', format: 'volume', better: 'neutral', none: 'no river pump' },
	{ key: 'avgGroundwaterM3Day', label: 'Groundwater', unit: 'm³/day', format: 'volume', better: 'neutral', none: 'no borehole' },
	{
		key: 'avgGroundwaterToDamM3Day', // gitleaks:allow (a field name, not a secret)
		label: 'Groundwater to dam',
		unit: 'm³/day',
		format: 'volume',
		better: 'neutral',
		none: 'no borehole filling the dam'
	},
	{ key: 'avgBaseflowDepletionM3Day', label: 'Stream depletion', unit: 'm³/day', format: 'volume', better: 'lower', none: 'no borehole' }
];

export interface FarmFeatureCell {
	m: MetricDelta;
	/** The run had no such feature at this farm, so its side reads as 0. */
	noneA: boolean;
	noneB: boolean;
}

/**
 * The feature metrics for the farm table's rows. The engine's farm summary
 * holds these only for a farm with the feature (engine project.ts
 * FarmSummary), so a matched farm missing one had none of it in that run:
 * no river pump means 0 pumped, no borehole 0 groundwater. The same rule as
 * the daily overlay's (overlay.ts zeroFillable): the farm is in both runs (a
 * row of `rows`) and the field is a feature field, so its absence is 0, not
 * unknown. A column appears when any matched farm has the field in either
 * run; a farm only one run has stays under "Only in run A / B".
 */
export function farmFeatureMetrics(
	rows: readonly Pick<FarmDelta, 'nodeIdA' | 'nodeIdB'>[],
	farmsA: readonly FarmSummary[],
	farmsB: readonly FarmSummary[]
): { columns: FarmFeatureColumn[]; cells: Map<string, Partial<Record<FarmFeatureKey, FarmFeatureCell>>> } {
	const byA = new Map(farmsA.map((f) => [f.nodeId, f]));
	const byB = new Map(farmsB.map((f) => [f.nodeId, f]));
	const pairs = rows.map((r) => ({ r, a: byA.get(r.nodeIdA), b: byB.get(r.nodeIdB) }));
	const val = (f: FarmSummary | undefined, k: FarmFeatureKey) => {
		const v = f?.[k];
		return v != null && Number.isFinite(v) ? v : null;
	};
	const columns = FARM_FEATURE_COLUMNS.filter((c) => pairs.some(({ a, b }) => val(a, c.key) !== null || val(b, c.key) !== null));
	const cells = new Map<string, Partial<Record<FarmFeatureKey, FarmFeatureCell>>>();
	for (const { r, a, b } of pairs) {
		const row: Partial<Record<FarmFeatureKey, FarmFeatureCell>> = {};
		// A farm whose summary can't be found is unknown, not 0: its cells stay empty.
		if (a && b) {
			for (const c of columns) {
				const x = val(a, c.key);
				const y = val(b, c.key);
				row[c.key] = { m: { a: x ?? 0, b: y ?? 0, delta: (y ?? 0) - (x ?? 0) }, noneA: x === null, noneB: y === null };
			}
		}
		cells.set(r.nodeIdB, row);
	}
	return { columns, cells };
}
