// The importer's note on zero-rain runs in the catchment rain (issue #2).
// The Python importer carries its own copy of the engine's rule
// (extract_project.py zero_rain_runs); this calls the engine's zeroRainRuns
// itself (packages/engine/src/quality.ts, docs/model.md §2.10a), which
// flags the same runs, so there is one copy of the rule in TypeScript.
import { dayText, ZERO_RUN_MIN_WET_DAYS, ZERO_RUN_PLAIN_DAYS, zeroRainRuns } from '@water-management/engine';
import type { ImportedSeries } from './flowData';

/** zero_rain_note(): the note for zero runs in the catchment rain, or null. Its days are day first, as the engine's data check writes them (dayText, engine ≥ 1.99.0). */
export function zeroRainNote(series: readonly Pick<ImportedSeries, 'kind' | 'startDate' | 'values'>[]): string | null {
	const rain = series.find((s) => s.kind === 'rain_catchment_mm');
	if (!rain) return null;
	const { wetMonths, runs } = zeroRainRuns({ startDate: rain.startDate, values: rain.values });
	if (!runs.length) return null;
	const rule = wetMonths ? `${ZERO_RUN_MIN_WET_DAYS}+ days in the wet season (months ${wetMonths.join(',')})` : `${ZERO_RUN_PLAIN_DAYS}+ days`;
	const spans = runs.map((r) => `${dayText(r.startDate)} to ${dayText(r.endDate)} (${r.days} days)`).join('; ');
	return (
		`[Flow data] catchment rain has ${runs.length} run(s) of zero rain covering ${rule}: ${spans}. ` +
		"Runs treat them as missing (engine >= 0.15.0, settings.zeroRainRuns, default mode 'missing'), so " +
		'bias-corrected CHIRPS fills them; if they are real dry spells, keep them dry in Settings -> Rain gaps -> Flagged rain'
	);
}
