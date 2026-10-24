// Which CHIRPS series a run read, against the others of that kind (engine ≥
// 1.90.0, issue #561; docs/model.md § Which CHIRPS series the run reads).
//
// A run reads the first series of each kind by name (seriesNames.ts), so a new
// series that sorts first takes over without anyone choosing it: a boundary
// feed's 60-day series once replaced a workbook's 16-year CHIRPS record that
// way, and the gap-filler (§2.4b) shrank to two months with no word. The
// backend names the others (ModelInput.seriesChoice, runs/execute.ts); the run
// warns when one of them spans more of the run than the series it read.
import { fromEpochDay, isIsoDate, toEpochDay } from './calendar';
import type { DailySeries, ModelInput, SeriesSpan } from './project';
import { compareSeriesNames } from './seriesNames';

/** How many of the run's days [start, start + days) lie between `first` and `last` (epoch days, inclusive; null: none). */
function spanDays(first: number | null, last: number | null, start: number, days: number): number {
	if (first === null || last === null) return 0;
	const from = Math.max(first, start);
	const to = Math.min(last, start + days - 1);
	return to < from ? 0 : to - from + 1;
}

/** A reading the run takes: present, finite and not negative, as prepare.ts reads a rain series (anything else is blank). */
const isReading = (v: number | null | undefined) => typeof v === 'number' && v >= 0 && Number.isFinite(v);

/** The first and last epoch day a series holds a reading on (null when it holds none). */
function valueSpan(s: DailySeries | undefined): [number | null, number | null] {
	if (!s || !isIsoDate(s.startDate)) return [null, null];
	const first = s.values.findIndex(isReading);
	if (first < 0) return [null, null];
	let last = s.values.length - 1;
	while (!isReading(s.values[last])) last--;
	const d0 = toEpochDay(s.startDate);
	return [d0 + first, d0 + last];
}

/** A day of the input's seriesChoice, or null for anything that isn't a real calendar day (it only feeds a warning: never throws). */
const dayOf = (s: unknown): number | null => (isIsoDate(s) ? toEpochDay(s) : null);

const spanText = (first: number | null, last: number | null) => (first === null || last === null ? 'no values' : `${fromEpochDay(first)} to ${fromEpochDay(last)}`);

/**
 * The warning when another CHIRPS series spans more of the run's days than
 * the one the run read (ties go to the one read), naming both; null when none
 * does or the input names no others. The run is `days` days from epoch day `start`.
 */
export function chirpsChoiceWarning(input: Pick<ModelInput, 'series' | 'seriesChoice'>, start: number, days: number): string | null {
	const choice = input.seriesChoice?.rain_chirps_mm;
	if (!choice || typeof choice.name !== 'string' || !Array.isArray(choice.others)) return null;
	// From a stored run or a pack's input.json, which no hash covers: what isn't a named span is left out, never thrown on.
	const others = choice.others.filter((s): s is SeriesSpan => !!s && typeof s === 'object' && typeof s.name === 'string');
	if (others.length === 0) return null;
	const [f0, l0] = valueSpan(input.series.rain_chirps_mm);
	const read = spanDays(f0, l0, start, days);
	let best: { s: SeriesSpan; n: number; first: number | null; last: number | null } | null = null;
	for (const s of others) {
		const first = dayOf(s.firstDay);
		const last = dayOf(s.lastDay);
		const n = spanDays(first, last, start, days);
		// The widest; between equals, the one a run would read first.
		if (!best || n > best.n || (n === best.n && compareSeriesNames(s.name, best.s.name) < 0)) best = { s, n, first, last };
	}
	if (!best || best.n <= read) return null;
	return (
		`the run read the CHIRPS series “${choice.name}” (${spanText(f0, l0)}), which spans ${read} of its ${days} days, but “${best.s.name}” (${spanText(best.first, best.last)}) spans ${best.n}: ` +
		'a run reads the first CHIRPS series by name and uses only that one wherever it reads CHIRPS (the fill of catchment rain’s blank days included). Rename or remove one of them so the run reads the record you mean'
	);
}
