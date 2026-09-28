// Pure logic for the EWR compliance heat map: binning, legend and summaries.
import type { EwrCompliance, EwrComplianceGrid } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

export type HeatMetric = 'pct' | 'volume';

/** Bin 0 = fully met; 1–4 = increasingly bad; null = no simulated days. */
export type Bin = 0 | 1 | 2 | 3 | 4;

/** Upper bounds (inclusive) of bins 1–3 for "% of days not met"; bin 4 is the rest. */
export const PCT_BREAKS = [10, 25, 50] as const;

/** Share of days in a cell with the EWR not met, 0–100; null when no days were simulated. */
export function cellPct(daysNotMet: number, days: number): number | null {
	return days > 0 ? (100 * daysNotMet) / days : null;
}

/** % of days → bin: 0 → 0, (0,10] → 1, (10,25] → 2, (25,50] → 3, (50,100] → 4. */
export function binPct(pct: number | null): Bin | null {
	if (pct == null || !Number.isFinite(pct)) return null;
	if (pct <= 0) return 0;
	if (pct <= PCT_BREAKS[0]) return 1;
	if (pct <= PCT_BREAKS[1]) return 2;
	if (pct <= PCT_BREAKS[2]) return 3;
	return 4;
}

/**
 * Shortfall volume → bin, relative to the grid's largest monthly shortfall so
 * the scale fits any catchment: (0, 10%] → 1, (10, 25%] → 2, (25, 50%] → 3,
 * above 50% → 4. Zero → 0.
 */
export function binVolume(m3: number, max: number): Bin {
	if (!(m3 > 0) || !(max > 0)) return 0;
	const f = (100 * m3) / max;
	return binPct(f) as Bin;
}

export interface LegendEntry {
	bin: Bin;
	label: string;
}

/** Legend entries for the current metric (volume labels use the grid's max). */
export function legend(metric: HeatMetric, max = 0): LegendEntry[] {
	if (metric === 'pct') {
		return [
			{ bin: 0, label: 'Met every day' },
			{ bin: 1, label: '≤ 10% of days' },
			{ bin: 2, label: '10–25%' },
			{ bin: 3, label: '25–50%' },
			{ bin: 4, label: '> 50%' }
		];
	}
	const v = (f: number) => fmtVolume(max * f);
	return [
		{ bin: 0, label: 'No shortfall' },
		{ bin: 1, label: `≤ ${v(0.1)}` },
		{ bin: 2, label: `${v(0.1)}–${v(0.25)}` },
		{ bin: 3, label: `${v(0.25)}–${v(0.5)}` },
		{ bin: 4, label: `> ${v(0.5)}` }
	];
}

/** m³ → "12 345 m³" below 1 Mm³, else "1.23 Mm³". */
export function fmtVolume(m3: number): string {
	if (!Number.isFinite(m3)) return '–';
	if (Math.abs(m3) >= 1e6) return `${fmtNum(m3 / 1e6, 2)} Mm³`;
	return `${fmtNum(m3)} m³`;
}

/** Short cell text: 45 → "45", 1234 → "1.2k", 45_600 → "46k", 2_300_000 → "2.3M". */
export function fmtCompact(v: number): string {
	if (!Number.isFinite(v)) return '–';
	const a = Math.abs(v);
	if (a >= 1e6) return `${fmtNum(v / 1e6, a >= 1e7 ? 0 : 1)}M`;
	if (a >= 1e3) return `${fmtNum(v / 1e3, a >= 1e4 ? 0 : 1)}k`;
	return fmtNum(v);
}

/** Largest monthly shortfall in a grid (m³). */
export function maxShortfall(g: EwrComplianceGrid): number {
	let m = 0;
	for (const row of g.shortfallM3) for (const v of row) if (v > m) m = v;
	return m;
}

export interface GridTotals {
	daysNotMet: number;
	days: number;
	shortfallM3: number;
	/** Months with at least one day not met / months simulated. */
	monthsFailed: number;
	months: number;
}

export function totals(c: EwrCompliance, g: EwrComplianceGrid): GridTotals {
	const t: GridTotals = { daysNotMet: 0, days: 0, shortfallM3: 0, monthsFailed: 0, months: 0 };
	c.days.forEach((row, r) =>
		row.forEach((d, m) => {
			if (d === 0) return;
			const n = g.daysNotMet[r]?.[m] ?? 0;
			t.days += d;
			t.months++;
			t.daysNotMet += n;
			t.shortfallM3 += g.shortfallM3[r]?.[m] ?? 0;
			if (n > 0) t.monthsFailed++;
		})
	);
	return t;
}

/** Per water-year-month column: % of all simulated days not met (the "typical year"). */
export function monthProfile(c: EwrCompliance, g: EwrComplianceGrid): (number | null)[] {
	return Array.from({ length: 12 }, (_, m) => {
		let d = 0;
		let n = 0;
		c.days.forEach((row, r) => {
			d += row[m] ?? 0;
			n += g.daysNotMet[r]?.[m] ?? 0;
		});
		return cellPct(n, d);
	});
}

/** The water years with the most days not met, worst first (ties: larger shortfall first). */
export function worstYears(c: EwrCompliance, g: EwrComplianceGrid, n = 3): { waterYear: number; daysNotMet: number; shortfallM3: number }[] {
	return c.waterYears
		.map((waterYear, r) => ({
			waterYear,
			daysNotMet: (g.daysNotMet[r] ?? []).reduce((a, b) => a + b, 0),
			shortfallM3: (g.shortfallM3[r] ?? []).reduce((a, b) => a + b, 0)
		}))
		.filter((y) => y.daysNotMet > 0)
		.sort((a, b) => b.daysNotMet - a.daysNotMet || b.shortfallM3 - a.shortfallM3)
		.slice(0, n);
}
