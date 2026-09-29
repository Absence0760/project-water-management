// Which days of the catchment rain a run will treat as missing
// (settings.zeroRainRuns, engine ≥ 0.15.0, docs/model.md §2.4c) or rebuild
// from a multi-day accumulation (engine ≥ 0.20.0, §2.4d), for shading the
// Data tab's chart. The engine's own zeroRainMask and rainAccumulations
// decide, over the whole series, so the chart shows what a run over the full
// record would do.
import {
	claimsDays,
	rainAccumulations,
	toEpochDay,
	zeroRainMask,
	type ChirpsBiasMode,
	type ChirpsFitOptions,
	type DailySeries,
	type ZeroRainSettings
} from '@water-management/engine';

export interface ZeroRainShading {
	/** Inclusive date ranges to shade, clipped to the series. */
	ranges: { start: string; end: string }[];
	/** Days whose reading a run sets aside. */
	days: number;
	/** Days a run takes from a multi-day accumulation spread by CHIRPS. */
	spreadDays: number;
	/** What the shading means, for the chart caption; null when nothing is shaded. */
	caption: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `chirps` is the CHIRPS series a run reads (null without one: no
 * accumulation can be detected then), `chirpsMode` the CHIRPS bias setting,
 * `fit` the CHIRPS fit period
 * (engine ≥ 0.29.0), as a run judges accumulations with it, and the
 * data-quality limits (`fit.dq`, engine ≥ 1.20.0).
 */
export function zeroRainShading(
	series: DailySeries,
	settings: ZeroRainSettings,
	chirps: DailySeries | null = null,
	chirpsMode: ChirpsBiasMode = 'monthly',
	fit: ChirpsFitOptions = {}
): ZeroRainShading {
	const first = series.startDate;
	const d0 = toEpochDay(first);
	const n = series.values.length;
	const lastDate = new Date((d0 + n - 1) * 86_400_000).toISOString().slice(0, 10);
	const clip = (p: { start: string; end: string }) => ({ start: p.start < first ? first : p.start, end: p.end > lastDate ? lastDate : p.end });

	const acc = rainAccumulations({ rain_catchment_mm: series, ...(chirps ? { rain_chirps_mm: chirps } : {}) }, settings, chirpsMode, fit);
	const windows = (acc?.windows ?? []).filter((w) => claimsDays(w.status));
	const claimed = new Set<number>();
	for (const w of windows) for (let d = w.from; d <= w.to; d++) if (d >= d0 && d < d0 + n) claimed.add(d);

	// settings.dataQuality (fit.dq, engine ≥ 1.20.0) decides which zero runs are flagged, as in a run.
	const m = zeroRainMask(series, settings, d0, n, (day) => claimed.has(day), undefined, { dq: fit.dq, chirps });
	const periods = m?.infill.periods ?? [];
	const days = m?.infill.days ?? 0;
	if (periods.length === 0 && windows.length === 0) return { ranges: [], days: 0, spreadDays: 0, caption: null };

	const parts: string[] = [];
	if (periods.length) parts.push(`${plural(periods.length, 'period')}, ${plural(days, 'day')}, that a run treats as missing, so CHIRPS fills them (Settings → Zero-rain runs)`);
	if (windows.length) {
		parts.push(
			`${plural(windows.length, 'multi-day accumulation')}, ${plural(claimed.size, 'day')}, whose recorded total a run spreads over the days it covers by CHIRPS`
		);
	}
	return {
		ranges: [...periods.map(clip), ...windows.map(clip)].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0)),
		days,
		spreadDays: claimed.size,
		caption: `Shaded: ${parts.join('; ')}.`
	};
}
