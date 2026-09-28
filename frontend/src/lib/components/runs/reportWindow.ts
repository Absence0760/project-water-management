// The reporting-window picker on Runs & results (issue #44): which days the
// curtailment, EWR sites and farm supply tables average over, chosen by the
// reader without touching the project's setting or re-running. Pure: parses
// and writes the `?window=` URL parameter and resolves a choice to day
// indices into one run. Dates are calendar days (engine calendar helpers, UTC
// epoch days), so no time zone can move a window by a day.
import { fromEpochDay, toEpochDay, type ForecastRainDays, type ReportWindow } from '@water-management/engine';

/** The URL search parameter that holds the choice (absent = the run's own window). */
export const WINDOW_PARAM = 'window';

export type WindowPreset = 'project' | 'last7' | 'last14' | 'last30' | 'all' | 'custom';

/** The picker's options, in the order it lists them. */
export const WINDOW_PRESETS: readonly { preset: WindowPreset; label: string }[] = [
	{ preset: 'project', label: 'Project window' },
	{ preset: 'last7', label: 'Last 7 days' },
	{ preset: 'last14', label: 'Last 14 days' },
	{ preset: 'last30', label: 'Last 30 days' },
	{ preset: 'all', label: 'Whole record' },
	{ preset: 'custom', label: 'Custom range' }
];

const LAST_DAYS: Partial<Record<WindowPreset, number>> = { last7: 7, last14: 14, last30: 30 };

export type WindowChoice = { preset: Exclude<WindowPreset, 'custom'> } | { preset: 'custom'; start: string; end: string };

/** A strict ISO calendar date that exists (no 2023-02-30). */
export function isIsoDate(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	try {
		return fromEpochDay(toEpochDay(s)) === s;
	} catch {
		return false;
	}
}

/**
 * The choice a `?window=` value names: a preset name, or `START..END` (ISO,
 * inclusive) for a custom range. Anything else, including no value, is the
 * run's own window.
 */
export function parseWindowParam(value: string | null | undefined): WindowChoice {
	if (!value) return { preset: 'project' };
	if (value === 'last7' || value === 'last14' || value === 'last30' || value === 'all' || value === 'project') return { preset: value };
	const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
	if (m && isIsoDate(m[1]!) && isIsoDate(m[2]!)) return { preset: 'custom', start: m[1]!, end: m[2]! };
	return { preset: 'project' };
}

/** The `?window=` value for a choice; null for the run's own window, the default, so the URL stays clean. */
export function windowParam(choice: WindowChoice): string | null {
	if (choice.preset === 'project') return null;
	if (choice.preset === 'custom') return `${choice.start}..${choice.end}`;
	return choice.preset;
}

/** A resolved window: day indices into the run (inclusive), its dates and length. */
export interface ResolvedWindow extends ReportWindow {
	days: number;
}

export type WindowResolution =
	| {
			ok: true;
			window: ResolvedWindow;
			/** Said to the reader: the range was cut to the run, or the run is shorter than the preset. */
			note: string | null;
	  }
	| { ok: false; error: string };

function fromDays(d0: number, a: number, b: number): ResolvedWindow {
	return { from: a - d0, to: b - d0, reportStart: fromEpochDay(a), reportEnd: fromEpochDay(b), days: b - a + 1 };
}

/** A run as the window needs it: its days, and (GET …/runs/:runId) its input snapshot and forecast. */
export interface WindowRun {
	startDate: string;
	endDate: string;
	inputSeries?: Partial<Record<string, { startDate: string; length: number }>> | null;
	summary?: { forecast?: { from: string } | null } | null;
}

/**
 * The run's last day of recorded rain, clamped to the run: the day before a
 * forecast run's first forecast day, else the last day of the catchment or
 * CHIRPS series in its input snapshot, else (an older payload) its last day.
 * The publication counts its "last 7 / 30 days" to the same day (backend
 * publish.ts loadProjectionRun `observed_until`, publish/recent.ts), so the
 * portfolio's "N short this week" and the page it links to count the same 7
 * days, and days after the rain (run as dry) are never "this week".
 */
export function runDataUntil(run: WindowRun): string {
	const d0 = toEpochDay(run.startDate);
	const d1 = toEpochDay(run.endDate);
	let end: number | null = null;
	const from = run.summary?.forecast?.from;
	if (from) end = toEpochDay(from) - 1;
	else {
		for (const kind of ['rain_catchment_mm', 'rain_chirps_mm']) {
			const s = run.inputSeries?.[kind];
			if (!s || !(s.length > 0)) continue;
			const e = toEpochDay(s.startDate) + s.length - 1;
			if (end === null || e > end) end = e;
		}
	}
	return fromEpochDay(end === null ? d1 : Math.min(d1, Math.max(d0, end)));
}

/**
 * Resolves a choice against one run (its first and last day) and the window
 * the run itself reported over (RunSummary.curtailment's, the project
 * setting as the run applied it). "Last N days" end on the run's last day of
 * recorded rain (runDataUntil), with a note when the run goes on past it.
 */
export function resolveWindow(choice: WindowChoice, run: WindowRun, own: { reportStart: string; reportEnd: string }): WindowResolution {
	const d0 = toEpochDay(run.startDate);
	const d1 = toEpochDay(run.endDate);
	if (choice.preset === 'project') return { ok: true, window: fromDays(d0, toEpochDay(own.reportStart), toEpochDay(own.reportEnd)), note: null };
	if (choice.preset === 'all') return { ok: true, window: fromDays(d0, d0, d1), note: null };
	const n = LAST_DAYS[choice.preset];
	if (n) {
		const until = runDataUntil(run);
		const e = toEpochDay(until);
		const a = Math.max(d0, e - n + 1);
		const w = fromDays(d0, a, e);
		const notes = [
			w.days < n ? `The run has only ${w.days} day${w.days === 1 ? '' : 's'} of recorded rain, so this covers all of it.` : null,
			e < d1 ? `Ends on the last day of recorded rain, ${until}; the run goes on to ${run.endDate} without it.` : null
		].filter((x): x is string => x !== null);
		return { ok: true, window: w, note: notes.length ? notes.join(' ') : null };
	}
	if (choice.preset !== 'custom') return { ok: false, error: 'Unknown window.' };
	const a = toEpochDay(choice.start);
	const b = toEpochDay(choice.end);
	if (a > b) return { ok: false, error: 'The window must start before it ends.' };
	if (b < d0 || a > d1) return { ok: false, error: `The window ${choice.start} to ${choice.end} is outside this run (${run.startDate} to ${run.endDate}).` };
	const ca = Math.max(a, d0);
	const cb = Math.min(b, d1);
	return {
		ok: true,
		window: fromDays(d0, ca, cb),
		note: ca !== a || cb !== b ? `Cut to the run: ${fromEpochDay(ca)} to ${fromEpochDay(cb)}.` : null
	};
}

/** Same days. */
export function sameWindow(a: { reportStart: string; reportEnd: string }, b: { reportStart: string; reportEnd: string }): boolean {
	return a.reportStart === b.reportStart && a.reportEnd === b.reportEnd;
}

/** The picker's name for a choice ("Last 7 days", "Custom range"). */
export function presetLabel(preset: WindowPreset): string {
	return WINDOW_PRESETS.find((p) => p.preset === preset)?.label ?? 'Project window';
}

/** "2022-01-22 to 2022-01-28 (7 days)": the period a figure covers. */
export function describePeriod(w: { reportStart: string; reportEnd: string; days: number }): string {
	return `${w.reportStart} to ${w.reportEnd} (${w.days} day${w.days === 1 ? '' : 's'})`;
}

/** How many days of the window used forecast rain (RunSummary.forecastRain); 0 without any. */
export function forecastDaysIn(w: { reportStart: string; reportEnd: string }, forecast: ForecastRainDays | null | undefined): number {
	if (!forecast || !(forecast.days > 0)) return 0;
	const a = Math.max(toEpochDay(w.reportStart), toEpochDay(forecast.from));
	const b = Math.min(toEpochDay(w.reportEnd), toEpochDay(forecast.to));
	return b >= a ? b - a + 1 : 0;
}
