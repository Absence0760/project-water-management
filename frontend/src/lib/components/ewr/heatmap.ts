// Pure logic for the EWR compliance heat map: binning, legend and summaries.
import { ewrBand, type EwrBand, type EwrCompliance, type EwrComplianceGrid } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { bandLabels, EWR_BANDS } from './bands';

export type HeatMetric = 'pct' | 'volume';

/**
 * A cell's class: `% of days not met` is read by the EWR traffic light (green,
 * amber, red: the portfolio's bands, engine reserve/trafficLight.ts); the
 * shortfall volume, which has no pass mark, by a blue ramp relative to the
 * grid's largest month (`v0`–`v4`).
 */
export type HeatClass = EwrBand | 'v0' | 'v1' | 'v2' | 'v3' | 'v4';

/** Bin 0 = no shortfall; 1–4 = increasingly large; the volume ramp's steps. */
export type Bin = 0 | 1 | 2 | 3 | 4;

/** Upper bounds (inclusive) of the volume ramp's bins 1–3, in % of the grid's largest month; bin 4 is the rest. */
export const VOLUME_BREAKS = [10, 25, 50] as const;

/** Share of days in a cell with the EWR not met, 0–100; null when no days were simulated. */
export function cellPct(daysNotMet: number, days: number): number | null {
	return days > 0 ? (100 * daysNotMet) / days : null;
}

/** A month's band by the share of its days not met; null when it has no simulated days. */
export function bandPct(daysNotMet: number, days: number): EwrBand | null {
	return ewrBand(daysNotMet, days);
}

/**
 * Shortfall volume → bin, relative to the grid's largest monthly shortfall so
 * the scale fits any catchment: (0, 10%] → 1, (10, 25%] → 2, (25, 50%] → 3,
 * above 50% → 4. Zero → 0.
 */
export function binVolume(m3: number, max: number): Bin {
	if (!(m3 > 0) || !(max > 0)) return 0;
	const f = (100 * m3) / max;
	if (f <= VOLUME_BREAKS[0]) return 1;
	if (f <= VOLUME_BREAKS[1]) return 2;
	if (f <= VOLUME_BREAKS[2]) return 3;
	return 4;
}

export interface LegendEntry {
	cls: HeatClass;
	label: string;
}

/** Legend entries for the current metric (volume labels use the grid's max). */
export function legend(metric: HeatMetric, max = 0): LegendEntry[] {
	if (metric === 'pct') {
		const l = bandLabels();
		return EWR_BANDS.map((cls) => ({ cls, label: l[cls] }));
	}
	const v = (f: number) => fmtVolume(max * f);
	return [
		{ cls: 'v0', label: 'No shortfall' },
		{ cls: 'v1', label: `≤ ${v(0.1)}` },
		{ cls: 'v2', label: `${v(0.1)}–${v(0.25)}` },
		{ cls: 'v3', label: `${v(0.25)}–${v(0.5)}` },
		{ cls: 'v4', label: `> ${v(0.5)}` }
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
