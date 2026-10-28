// Which CHIRPS series a run read, against the others of that kind (engine ≥
// 1.90.0, issue #561; docs/model.md § Which CHIRPS series the run reads).
//
// A run reads the first series of each kind by name (seriesNames.ts), so a new
// series that sorts first takes over without anyone choosing it: a boundary
// feed's 60-day series once replaced a workbook's 16-year CHIRPS record that
// way, and the gap-filler (§2.4b) shrank to two months with no word. The
// backend names the others (ModelInput.seriesChoice, runs/execute.ts); the run
// warns when one of them spans more of the run than the series it read.
import { dayText, fromEpochDay, isIsoDate, toEpochDay } from './calendar';
import { type DailySeries, type ModelInput, type SeriesPick, type SeriesSpan, unitRainSeriesKey, type UnitRainSettings } from './project';
import { unitRainOn } from './runoff/unitRain';
import { compareSeriesNames } from './seriesNames';
import { warn } from './warningCodes';

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

const spanText = (first: number | null, last: number | null) => (first === null || last === null ? 'no values' : `${dayText(fromEpochDay(first))} to ${dayText(fromEpochDay(last))}`);

/** The widest other series of a pick against the one read, or null when none spans more (ties go to the one read). */
function shadowed(pick: unknown, read: DailySeries | undefined, start: number, days: number) {
	const choice = pick as Partial<SeriesPick> | null | undefined;
	if (!choice || typeof choice.name !== 'string' || !Array.isArray(choice.others)) return null;
	// From a stored run or a pack's input.json, which no hash covers: what isn't a named span is left out, never thrown on.
	const others = choice.others.filter((s): s is SeriesSpan => !!s && typeof s === 'object' && typeof s.name === 'string');
	const [f0, l0] = valueSpan(read);
	const n0 = spanDays(f0, l0, start, days);
	let best: { s: SeriesSpan; n: number; first: number | null; last: number | null } | null = null;
	for (const s of others) {
		const first = dayOf(s.firstDay);
		const last = dayOf(s.lastDay);
		const n = spanDays(first, last, start, days);
		// The widest; between equals, the one a run would read first.
		if (!best || n > best.n || (n === best.n && compareSeriesNames(s.name, best.s.name) < 0)) best = { s, n, first, last };
	}
	if (!best || best.n <= n0) return null;
	return `“${choice.name}” (${spanText(f0, l0)}), which spans ${n0} of its ${days} days, but “${best.s.name}” (${spanText(best.first, best.last)}) spans ${best.n}`;
}

/**
 * The warnings when another CHIRPS series spans more of the run's days than
 * the one the run read (ties go to the one read), naming both: the outlet's
 * CHIRPS first, then each land unit's own under per-unit rain (the only
 * time the run reads it), for the units the model has, in its node order. None when none does or the input names no others. The run is
 * `days` days from epoch day `start`.
 */
export function chirpsChoiceWarnings(
	input: Pick<ModelInput, 'series' | 'seriesChoice'> & { model?: Pick<ModelInput['model'], 'nodes'>; settings?: { unitRain?: UnitRainSettings | null } },
	start: number,
	days: number
): string[] {
	const out: string[] = [];
	const choice = input.seriesChoice;
	if (!choice || typeof choice !== 'object') return out;
	const outlet = shadowed(choice.rain_chirps_mm, input.series.rain_chirps_mm, start, days);
	if (outlet) {
		out.push(
			warn(
				'rain.chirpsShadowed',
				{ where: 'catchment' },
				`the run read the CHIRPS series ${outlet}: ` +
					'a run reads the first CHIRPS series by name and uses only that one wherever it reads CHIRPS (the fill of catchment rain’s blank days included). Rename or remove one of them so the run reads the record you mean'
			)
		);
	}
	const units = choice.unitChirps;
	// A unit's own CHIRPS is read only under per-unit rain (§2.4h): otherwise the run reads none of them, so nothing to say.
	if (!units || typeof units !== 'object' || !unitRainOn(input.settings)) return out;
	const nodes = input.model?.nodes ?? [];
	// Only units the run models, in the model's order: a pick for a node a scenario removed is about nothing the run read.
	const ids = nodes.map((n) => n.id).filter((id) => Object.hasOwn(units, id));
	for (const id of ids) {
		const unit = shadowed(units[id], input.series[unitRainSeriesKey('rain_chirps_mm', id)], start, days);
		if (!unit) continue;
		const name = nodes.find((n) => n.id === id)!.name;
		out.push(
			warn(
				'rain.chirpsShadowed',
				{ where: 'unit', unit: id, name },
				`for the unit “${name}”, the run read the CHIRPS series ${unit}: ` +
					'a run reads a unit’s first CHIRPS series by name and uses only that one for the unit’s own rain. Rename or remove one of them so the run reads the record you mean'
			)
		);
	}
	return out;
}
