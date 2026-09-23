// Formatting run-comparison deltas (b − a) for the compare page. Direction is
// always shown with a sign and ▲/▼, and whether that's better or worse is
// spelled out in text too, so colour is never the only cue (WCAG 1.4.1).
import type { FarmDelta, MetricDelta } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** Which way is good for a metric. 'neutral' = neither (e.g. demand). */
export type Better = 'higher' | 'lower' | 'zero' | 'neutral';

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
	/** "+80", "−1,200", "+5.0 pp", "0", or "–" when unknown. */
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
		case 'zero': {
			// e.g. percent bias: closer to 0 is better.
			if (m.a === null || m.b === null) return 'neutral';
			const d = Math.abs(m.b) - Math.abs(m.a);
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
	{ key: 'ewrShortfallM3Day', label: 'EWR shortfall', unit: 'm³/day', format: 'volume', better: 'lower' },
	{ key: 'daysEwrNotMet', label: 'EWR not met', unit: 'days', format: 'days', better: 'lower' }
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
