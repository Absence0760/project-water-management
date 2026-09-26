// Summary → Dam levels (issue #17, option A: the results first): each dam's
// storage at the end of the latest run and at its lowest in the run's last
// year, from the run's daily dam_storage series. The run summary carries no
// dam figures, so the series are fetched (runs/cache.ts) and reduced here.
import { fromEpochDay, toEpochDay, type DailySeries } from '@water-management/engine';

const addDays = (iso: string, n: number) => fromEpochDay(toEpochDay(iso) + n);

export interface DamLevel {
	nodeId: string;
	name: string;
	capacityM3: number;
	/** The dam's minimum operating level, % of capacity (0 when none). */
	minPct: number;
	/** Storage on the run's last day with a value, % of capacity, and that day. */
	endPct: number;
	endDate: string;
	/** Lowest storage in the last 365 days of the run, % of capacity, and its first day. */
	lowPct: number;
	lowDate: string;
	/** Days in that year at or below the minimum level (0 when the dam has none). */
	daysAtMin: number;
}

/** The window "the last year" covers: 365 days ending on the series' last day. */
export const YEAR_DAYS = 365;

/**
 * One dam's levels, or null when the series has no finite value or the dam
 * no capacity. Values are m³; the result is % of capacity.
 */
export function damLevel(
	dam: { nodeId: string; name: string; capacityM3: number; minPct: number },
	series: DailySeries
): DamLevel | null {
	if (!(dam.capacityM3 >= 1)) return null;
	const v = series.values;
	let last = -1;
	for (let i = v.length - 1; i >= 0; i--) {
		const x = v[i];
		if (x != null && Number.isFinite(x)) {
			last = i;
			break;
		}
	}
	if (last < 0) return null;
	const pct = (x: number) => (x / dam.capacityM3) * 100;
	const from = Math.max(0, last - YEAR_DAYS + 1);
	// The first day of the lowest level: scan forward, replace only on a lower value.
	let low = -1;
	let daysAtMin = 0;
	for (let i = from; i <= last; i++) {
		const x = v[i];
		if (x == null || !Number.isFinite(x)) continue;
		if (low < 0 || x < v[low]!) low = i;
		// A small tolerance: the engine holds a dam at its minimum as a float.
		if (dam.minPct > 0 && pct(x) <= dam.minPct + 1e-6) daysAtMin++;
	}
	return {
		nodeId: dam.nodeId,
		name: dam.name,
		capacityM3: dam.capacityM3,
		minPct: dam.minPct,
		endPct: pct(v[last]!),
		endDate: addDays(series.startDate, last),
		lowPct: pct(v[low]!),
		lowDate: addDays(series.startDate, low),
		daysAtMin
	};
}

/** Emptiest first (end-of-run %), then by name. */
export function sortDamLevels(levels: readonly DamLevel[]): DamLevel[] {
	return [...levels].sort((a, b) => a.endPct - b.endPct || a.name.localeCompare(b.name));
}

/** How full, in words and a band for the bar (never colour alone: the % is always shown). */
export function levelBand(l: Pick<DamLevel, 'endPct' | 'minPct'>): 'at-min' | 'low' | 'ok' {
	if (l.minPct > 0 && l.endPct <= l.minPct + 1e-6) return 'at-min';
	return l.endPct < LOW_PCT ? 'low' : 'ok';
}

/** Below this share of capacity a dam counts as low on the Summary. */
export const LOW_PCT = 30;
