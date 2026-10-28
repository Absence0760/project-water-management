// The rain checks on a per-unit rain gauge and the reference gauge (engine
// issue #500, decisions 1c and 6, docs/model.md §2.4h).
//
// Decision 6: a unit's own gauge (`rain_catchment_mm@<unit>`, rule 1) gets
// the catchment gauge's §2.4c zero-run and §2.4d accumulation checks, with
// the catchment's settings (settings.zeroRainRuns' modes and fill threshold,
// settings.dataQuality's limits, the §2.4b fit the spreading weighs CHIRPS
// with). The same code as the catchment's (../prepare.ts checkedRain) runs
// on the unit's gauge against the unit's own CHIRPS (else the catchment's).
// The dated lists in settings.zeroRainRuns (missing, keep dry, keep
// readings, add accumulations) name days of the catchment gauge's record, so
// they don't apply to a unit's. Its own are settings.rainStations.unreliable
// under the gauge's series id (engine ≥ 1.102.0, issue #611, as a station's,
// ./stationRecord.ts): blanked after the checks, which read the record as
// stored, so a period never looks like a blank outage to §2.4d; a day both
// set aside counts under the checks. A day the checks set aside is blank, so it
// falls to the next link of rule 1's chain (the unit's own CHIRPS, levelled);
// a spread accumulation spreads within the unit's record.
//
// Decision 1c: the reference gauge's monthly factors are fitted on its
// checked rain, the rain rule 2 uses: the catchment gauge after §2.4c, §2.4d
// and §2.4e (checkedCatchmentRainRecord), or a unit's gauge after the checks
// above, over its whole stored record. Accumulation windows are left out of
// the fit as §2.4b's fit leaves them out: their spread days are CHIRPS-shaped.
import { fromEpochDay, toEpochDay } from '../calendar';
import { blankFitExcluded, checkedCatchmentRainRecord, checkedRain } from '../prepare';
import { unitRainSeriesKey, type DailySeries, type ModelInput, type ProjectSettings } from '../project';
import { unreliableRanges } from '../recordPeriods';
import { warn } from '../warningCodes';

/** A unit gauge's checked rain over a window, and what the checks did there. */
export interface CheckedUnitGauge {
	/** The gauge aligned to the window: null where it has no reading or a check set the reading aside; a spread accumulation's share on its days. */
	values: (number | null)[];
	/** Days of the window set aside as a suspect zero run (§2.4c). */
	zeroRunDays: number;
	/** Days of the window in a flagged zero run left as recorded (mode 'asRecorded'). */
	zeroRunAsRecordedDays: number;
	/** Accumulation windows touching the window spread over their days (§2.4d), the days and the rain spread there. */
	spreadWindows: number;
	spreadDays: number;
	spreadMm: number;
	/** Readings after a blank outage set aside (§2.4d 'setAside'). */
	setAside: number;
	/** Detected accumulations left as recorded (mode 'asRecorded'). */
	asRecorded: number;
	/** Days of the window with a reading after the checks that the gauge's unreliable periods blanked (settings.rainStations.unreliable). */
	unreliableDays: number;
}

/** The settings the unit gauge checks run with: the catchment's, without the catchment gauge's dated lists or rain-source periods. */
function unitCheckSettings(settings: ProjectSettings): ProjectSettings {
	return {
		...settings,
		zeroRainRuns: { ...settings.zeroRainRuns, keepDry: [], missing: [], keepReadings: [], addAccumulations: [] },
		rainSource: [],
		chirpsQuantileMap: null,
		gapRain: null
	};
}

/** The series the checks read for a unit: its gauge as the catchment rain, and its own CHIRPS (else the catchment's) as the CHIRPS. */
function unitCheckSeries(series: ModelInput['series'], nodeId: string): ModelInput['series'] | null {
	const all = series as Record<string, DailySeries | undefined>;
	const gauge = all[unitRainSeriesKey('rain_catchment_mm', nodeId)];
	if (!gauge) return null;
	const chirps = all[unitRainSeriesKey('rain_chirps_mm', nodeId)] ?? series.rain_chirps_mm;
	return { rain_catchment_mm: gauge, ...(chirps ? { rain_chirps_mm: chirps } : {}) };
}

/** A rain reading after the checks: finite and not negative (a negative is a no-data code). */
const keep = (v: number | null): number | null => (v !== null && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * A unit's own gauge (`rain_catchment_mm@<nodeId>`) after the catchment's
 * §2.4c and §2.4d checks, aligned to start … start + days − 1 (epoch days).
 * Null without that series. The checks read the whole stored record, so a
 * day's value doesn't depend on the window.
 */
export function checkedUnitGauge(
	settings: ProjectSettings,
	series: ModelInput['series'],
	nodeId: string,
	start: number,
	days: number,
	opts: { fitExcludeAccumulations?: boolean } = {}
): CheckedUnitGauge | null {
	const sub = unitCheckSeries(series, nodeId);
	if (!sub) return null;
	const r = checkedRain(unitCheckSettings(settings), sub, start, days);
	if (opts.fitExcludeAccumulations) blankFitExcluded(r, start);
	const z = r.zeroRain?.infill;
	const windows = r.accumulation?.info.windows ?? [];
	const values = r.catchment.map(keep);
	// The user's unreliable periods for this gauge (engine ≥ 1.102.0, issue #611), after the checks.
	let unreliableDays = 0;
	for (const [a, b] of unreliableRanges(settings, sub.rain_catchment_mm!.seriesId)) {
		for (let t = Math.max(a - start, 0); t <= Math.min(b - start, days - 1); t++) {
			if (values[t] === null) continue;
			values[t] = null;
			unreliableDays++;
		}
	}
	return {
		values,
		zeroRunDays: z?.days ?? 0,
		zeroRunAsRecordedDays: z?.asRecordedDays ?? 0,
		spreadWindows: r.accumulation?.info.spreadWindows ?? 0,
		spreadDays: r.accumulation?.info.spreadDays ?? 0,
		spreadMm: r.accumulation?.info.spreadMm ?? 0,
		setAside: windows.filter((w) => w.status === 'setAside').length,
		asRecorded: windows.filter((w) => w.status === 'asRecorded').length,
		unreliableDays
	};
}

/**
 * A unit gauge's whole stored record after the checks (checkedUnitGauge over
 * its own span); null without one. `fitExcludeAccumulations` as
 * checkedCatchmentRainRecord's.
 */
export function checkedUnitGaugeRecord(settings: ProjectSettings, series: ModelInput['series'], nodeId: string, opts: { fitExcludeAccumulations?: boolean } = {}): DailySeries | null {
	const s = (series as Record<string, DailySeries | undefined>)[unitRainSeriesKey('rain_catchment_mm', nodeId)];
	if (!s || !s.values.length) return null;
	const d0 = toEpochDay(s.startDate);
	return { startDate: fromEpochDay(d0), values: checkedUnitGauge(settings, series, nodeId, d0, s.values.length, opts)!.values };
}

/**
 * The reference gauge's checked record as the reference fit reads it
 * (decision 1c): the catchment gauge's checked rain, or a unit's own gauge
 * after the unit gauge checks, with every accumulation window's days but a
 * kept reading's left out (blank), as §2.4b's fit leaves them out: a spread
 * window's days are shaped from CHIRPS, so they would pull a factor towards
 * 1. Null when the key names neither, or the series is absent.
 */
export function checkedReferenceGauge(settings: ProjectSettings, series: ModelInput['series'], gauge: string): DailySeries | null {
	if (gauge === 'rain_catchment_mm') {
		const rec = checkedCatchmentRainRecord(settings, series, { fitExcludeAccumulations: true });
		return rec ? { startDate: rec.startDate, values: rec.values.map(keep) } : null;
	}
	const prefix = 'rain_catchment_mm@';
	if (!gauge.startsWith(prefix)) return null;
	return checkedUnitGaugeRecord(settings, series, gauge.slice(prefix.length), { fitExcludeAccumulations: true });
}

const mm = (x: number) => `${Math.round(x)} mm`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The run warnings for a unit gauge's checks, naming the unit; none when the checks changed nothing. */
export function unitGaugeCheckWarnings(name: string, c: CheckedUnitGauge): string[] {
	const out: string[] = [];
	const who = `unit rain: "${name}"’s own gauge`;
	if (c.zeroRunDays > 0)
		out.push(
			warn(
				'rain.unitGauge.zeroRun.missing',
				{ unit: name, days: c.zeroRunDays },
				`${who} is treated as missing on ${plural(c.zeroRunDays, 'day')} of flagged zero runs (§2.4c, with the catchment’s settings): its CHIRPS (levelled), then the next link of its rule, stands in. The stored series is unchanged.`
			)
		);
	if (c.zeroRunAsRecordedDays > 0)
		out.push(
			warn(
				'rain.unitGauge.zeroRun.asRecorded',
				{ unit: name, days: c.zeroRunAsRecordedDays },
				`${who} has flagged zero runs on ${plural(c.zeroRunAsRecordedDays, 'day')} run as recorded (dry): Model settings → Rain gaps → Flagged rain → Flagged zero runs is "Run as recorded (dry)".`
			)
		);
	if (c.spreadWindows > 0)
		out.push(
			warn(
				'rain.unitGauge.accumulation.spread',
				{ unit: name, windows: c.spreadWindows, days: c.spreadDays, mm: Math.round(c.spreadMm) },
				`${who} has ${plural(c.spreadWindows, 'multi-day accumulation')} spread over ${plural(c.spreadDays, 'run day')} (${mm(c.spreadMm)}) in proportion to CHIRPS (§2.4d, with the catchment’s settings). The stored series is unchanged.`
			)
		);
	if (c.setAside > 0)
		out.push(
			warn(
				'rain.unitGauge.accumulation.setAside',
				{ unit: name, readings: c.setAside },
				`${who} has ${plural(c.setAside, 'reading')} after a blank outage set aside as missing (§2.4d): each may hold the outage’s rain, so its CHIRPS (levelled), then the next link of its rule, stands in.`
			)
		);
	if (c.asRecorded > 0)
		out.push(
			warn(
				'rain.unitGauge.accumulation.asRecorded',
				{ unit: name, windows: c.asRecorded },
				`${who} has ${plural(c.asRecorded, 'multi-day accumulation')} run as recorded, because Model settings → Rain gaps → Flagged rain → Multi-day accumulations → Accumulated readings is "Run as recorded (one day)".`
			)
		);
	if (c.unreliableDays > 0)
		out.push(
			warn(
				'rain.unitGauge.unreliable',
				{ unit: name, days: c.unreliableDays },
				`${who} is treated as missing on ${plural(c.unreliableDays, 'day')} the user marked unreliable: its CHIRPS (levelled), then the next link of its rule, stands in. The stored series is unchanged.`
			)
		);
	return out;
}
