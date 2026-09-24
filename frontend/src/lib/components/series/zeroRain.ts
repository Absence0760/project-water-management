// Which days of the catchment rain a run will treat as missing
// (settings.zeroRainRuns, engine ≥ 0.15.0, docs/model.md §2.4c), for shading
// the Data tab's chart. The engine's own zeroRainMask decides, over the whole
// series, so the chart shows what a run over the full record would do.
import { toEpochDay, zeroRainMask, type DailySeries, type ZeroRainSettings } from '@water-management/engine';

export interface ZeroRainShading {
	/** Inclusive date ranges to shade, clipped to the series. */
	ranges: { start: string; end: string }[];
	/** Days whose reading a run sets aside. */
	days: number;
	/** What the shading means, for the chart caption; null when nothing is shaded. */
	caption: string | null;
}

export function zeroRainShading(series: DailySeries, settings: ZeroRainSettings): ZeroRainShading {
	const m = zeroRainMask(series, settings, toEpochDay(series.startDate), series.values.length);
	const periods = m?.infill.periods ?? [];
	if (!m || periods.length === 0) return { ranges: [], days: 0, caption: null };
	const last = series.values.length - 1;
	const first = series.startDate;
	const lastDate = new Date((toEpochDay(first) + last) * 86_400_000).toISOString().slice(0, 10);
	const ranges = periods.map((p) => ({ start: p.start < first ? first : p.start, end: p.end > lastDate ? lastDate : p.end }));
	const n = periods.length;
	return {
		ranges,
		days: m.infill.days,
		caption:
			`Shaded: ${n === 1 ? '1 period' : `${n} periods`}, ${m.infill.days} days, that a run treats as missing, so CHIRPS fills them ` +
			'(Settings → Zero-rain runs).'
	};
}
