// Forecast runs in the workspace (WP-2.12, docs/ui.md § Forecast runs): the
// chart band, the Runs tab's forecast panel rows, and the wording. Forecast
// days are modelled on forecast rain, so every figure is worded as a guide:
// "expected", "about", never a promise, and never mixed into the historical
// figures (the engine keeps them out of every other summary).
import type { ForecastSummary } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

/** The band's label on every daily chart of a forecast run. */
export const FORECAST_BAND_LABEL = 'Forecast';

/** The band's text key under the chart. */
export const FORECAST_BAND_NOTE = 'modelled on forecast rain, not recorded rain. A guide to the coming days, not a measurement; the run’s totals and scores leave these days out.';

/** The LineChart band for a run, or undefined for an ordinary run. */
export function forecastBand(forecastFrom: string | null | undefined): { from: string; label: string; note: string } | undefined {
	return forecastFrom ? { from: forecastFrom, label: FORECAST_BAND_LABEL, note: FORECAST_BAND_NOTE } : undefined;
}

/** One farm's row in the forecast panel, as text. */
export interface ForecastRow {
	nodeId: string;
	name: string;
	/** "about 46 %", or "no dam". */
	lowestDam: string;
	/** "none", "3 of 14". */
	shortDays: string;
	/** "about 82 %", or "no demand". */
	supplied: string;
	/** Short on at least one forecast day: the row to look at first. */
	watch: boolean;
}

/** A 0–1 fraction as "about N %" (whole percent: forecast figures carry no more precision than that). */
const about = (f: number) => `about ${fmtNum(Math.round(Math.max(0, f) * 100))} %`;

/** The panel's rows, in the forecast's farm order (the model's), farms short on a forecast day first. */
export function forecastRows(f: ForecastSummary, names: ReadonlyMap<string, string> = new Map()): ForecastRow[] {
	const rows = f.perFarm.map((p) => ({
		nodeId: p.nodeId,
		name: names.get(p.nodeId) ?? p.name,
		lowestDam: p.minDamPct === null ? 'no dam' : about(p.minDamPct),
		shortDays: p.deficitDays === 0 ? 'none' : `${p.deficitDays} of ${f.days}`,
		supplied: p.suppliedFraction === null ? 'no demand' : about(p.suppliedFraction),
		watch: p.deficitDays > 0
	}));
	return [...rows.filter((r) => r.watch), ...rows.filter((r) => !r.watch)];
}

/** The panel's one-line reading of the outlet: counts only, worded as a risk. */
export function outletLine(f: ForecastSummary): string {
	if (f.outletEwrDaysAtRisk === 0) return `The model expects the river’s ecological flow (EWR) at the outlet to be met on all ${f.days} forecast days.`;
	return `The model expects the outlet’s ecological flow (EWR) to be at risk on ${f.outletEwrDaysAtRisk} of the ${f.days} forecast days.`;
}

/** The panel's heading line: which days, and from what. */
export function forecastHeading(f: ForecastSummary): string {
	return `Next ${f.days} ${f.days === 1 ? 'day' : 'days'}: ${f.from} to ${f.to}, modelled on ${fmtNum(f.rainMm, 1)} mm of forecast rain after the last recorded rain on ${f.lastObserved}.`;
}
