// A rainfall station's checked record (issue #553, docs/model.md §2.4i).
//
// A station's stored record (ModelInput.series[stationSeriesKey(id)]) gets
// the same checks a unit's own gauge gets (./unitGaugeChecks.ts, issue #500
// decision 6): the catchment's §2.4c zero-run and §2.4d accumulation checks
// (../prepare.ts checkedRain), with the catchment's settings but without the
// catchment gauge's dated lists (missing, keep dry, keep readings, add
// accumulations), its §2.4e rain-source periods or the quantile map: those
// name days of the catchment gauge's record, not a station's. The checks
// compare the station against the CHIRPS at it: its own cell
// (stationChirpsSeriesKey) when the backend has it, else the CHIRPS of the
// unit it stands in (settings.rainStations.sites), else the catchment's
// CHIRPS (rain_chirps_mm), as a unit's gauge falls back to it.
//
// After the checks, the user's unreliable periods
// (settings.rainStations.unreliable[id], inclusive [from, to] ISO dates) are
// blanked. The checks run first, on the record as stored, so an unreliable
// period never looks like a blank outage to §2.4d; a day both set aside is
// counted once, under the checks.
//
// The catchment's own gauge (RainStationInput.isCatchmentGauge, opts
// `isCatchmentGauge`): the dated lists and rain-source periods were made for
// this record, so its checks are the catchment gauge's exactly — checkedRain
// with the catchment's full settings (only the quantile map off, as the
// reference fit has no use for it), against the catchment's CHIRPS
// (rain_chirps_mm), over the span ../prepare.ts checkedCatchmentRainRecord
// reads (the stored record and every rain-source period's replacement days).
// The unreliable periods are blanked after that, as for any station.
import { fromEpochDay, isIsoDate, toEpochDay } from '../calendar';
import { blankFitExcluded, checkedRain } from '../prepare';
import { stationChirpsSeriesKey, stationSeriesKey, unitRainSeriesKey, type DailySeries, type ModelInput, type ProjectSettings } from '../project';
import { warn } from '../warningCodes';

/** Where the CHIRPS at a station is read: its own cell, the unit it stands in, or none. */
export type StationChirpsSource = { at: 'cell'; key: string; series: DailySeries } | { at: 'unit'; unitId: string; key: string; series: DailySeries | null } | { at: 'none' };

/**
 * The CHIRPS at a station: series[stationChirpsSeriesKey(id)] when present,
 * else `rain_chirps_mm@<sites[id].unitId>` (series null when that unit has
 * none), else none.
 */
export function stationChirpsSource(settings: ProjectSettings, series: ModelInput['series'], stationId: string): StationChirpsSource {
	const all = series as Record<string, DailySeries | undefined>;
	const cellKey = stationChirpsSeriesKey(stationId);
	const cell = all[cellKey];
	if (cell) return { at: 'cell', key: cellKey, series: cell };
	const unitId = settings.rainStations?.sites?.[stationId]?.unitId;
	if (typeof unitId === 'string' && unitId) {
		const key = unitRainSeriesKey('rain_chirps_mm', unitId);
		return { at: 'unit', unitId, key, series: all[key] ?? null };
	}
	return { at: 'none' };
}

/** A station's checked record and what was set aside, by the checks and by the unreliable periods. */
export interface CheckedStationRecord {
	/** Over the stored record's span (a catchment gauge's: also its rain-source periods' replacement days): null where it has no reading or a day is set aside; a spread accumulation's share on its days. */
	record: DailySeries;
	/** Days of the stored record with a reading the checks set aside (null after them), and days with a reading after the checks an unreliable period blanked. */
	setAside: { checks: number; unreliable: number };
	/** "station: …" warnings, naming the station, for what the checks and the periods did. */
	warnings: string[];
	/**
	 * With `fitExcludeAccumulations` only: the record as the forcing reads it, the
	 * accumulation windows' spread days kept (unreliable periods blanked as in
	 * `record`). The pairing counts its complete years on it (model.md §2.4i).
	 */
	forcing?: DailySeries;
}

/** The settings the station checks run with: the catchment's, without the catchment gauge's dated lists, rain-source periods or quantile map. */
function stationCheckSettings(settings: ProjectSettings): ProjectSettings {
	return {
		...settings,
		zeroRainRuns: { ...settings.zeroRainRuns, keepDry: [], missing: [], keepReadings: [], addAccumulations: [] },
		rainSource: [],
		chirpsQuantileMap: null,
		gapRain: null
	};
}

/** A rain reading: finite and not negative (a negative is a no-data code). */
const reading = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const keep = (v: number | null): number | null => (reading(v) ? v : null);
const mm = (x: number) => `${Math.round(x)} mm`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A station's stored record with the days it can't be trusted on blanked:
 * the §2.4c/§2.4d checks (as a unit's own gauge gets them, see the header)
 * and settings.rainStations.unreliable[stationId]'s inclusive periods. Null
 * when the input has no record for it (no series, or an empty one). The
 * checks read the whole stored record, so a day's value doesn't depend on any
 * window.
 *
 * `fitExcludeAccumulations` (the pairing fit's record): also blank every
 * accumulation window's days but a kept reading's, as §2.4b's fit and the
 * reference gauge's (checkedReferenceGauge) leave them out; their spread days
 * are CHIRPS-shaped. Those days count under setAside.checks there. The
 * record as the forcing reads it comes back beside it, as `forcing`.
 *
 * `isCatchmentGauge` (RainStationInput.isCatchmentGauge): the catchment
 * gauge's full checks, see the header. Pass the same value for the forcing
 * and the fit, so the two records agree.
 */
export function checkedStationRecord(
	settings: ProjectSettings,
	series: ModelInput['series'],
	stationId: string,
	opts: { fitExcludeAccumulations?: boolean; name?: string; isCatchmentGauge?: boolean } = {}
): CheckedStationRecord | null {
	const stored = (series as Record<string, DailySeries | undefined>)[stationSeriesKey(stationId)];
	if (!stored || !stored.values.length) return null;
	const s0 = toEpochDay(stored.startDate);
	let d0 = s0;
	let n = stored.values.length;
	let r: ReturnType<typeof checkedRain>;
	if (opts.isCatchmentGauge) {
		const full: ProjectSettings = { ...settings, chirpsQuantileMap: null, gapRain: null };
		const sub: ModelInput['series'] = { ...series, rain_catchment_mm: stored };
		// checkedCatchmentRainRecord's span: the record and every rain-source period's replacement days.
		let last = s0 + n - 1;
		for (const p of full.rainSource) {
			const alt = sub[p.series];
			if (!alt || alt.values.length === 0) continue;
			const a0 = toEpochDay(alt.startDate);
			const a = Math.max(a0, toEpochDay(p.start));
			const b = Math.min(a0 + alt.values.length - 1, toEpochDay(p.end));
			if (a > b) continue;
			d0 = Math.min(d0, a);
			last = Math.max(last, b);
		}
		n = last - d0 + 1;
		r = checkedRain(full, sub, d0, n);
	} else {
		const src = stationChirpsSource(settings, series, stationId);
		const chirps = src.at === 'none' || !src.series ? series.rain_chirps_mm : src.series;
		const sub: ModelInput['series'] = { rain_catchment_mm: stored, ...(chirps ? { rain_chirps_mm: chirps } : {}) };
		r = checkedRain(stationCheckSettings(settings), sub, d0, n);
	}
	// The forcing's record, before the fit's exclusions (a copy: blankFitExcluded writes r.catchment in place).
	const forcing = opts.fitExcludeAccumulations ? r.catchment.map(keep) : null;
	if (opts.fitExcludeAccumulations) blankFitExcluded(r, d0);
	const values = r.catchment.map(keep);
	let checks = 0;
	for (let i = 0; i < stored.values.length; i++) if (reading(stored.values[i]) && values[i + s0 - d0] === null) checks++;

	const who = `station: "${opts.name ?? stationId}"`;
	const warnings: string[] = [];
	let unreliable = 0;
	const periods = settings.rainStations?.unreliable?.[stationId] ?? [];
	for (const p of Array.isArray(periods) ? periods : []) {
		const [from, to] = Array.isArray(p) ? p : [];
		if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
			warnings.push(warn('rain.station.unreliableInvalid', { station: stationId }, `${who} has an unreliable period that isn’t two dates in order (${JSON.stringify(p)}): it is ignored`));
			continue;
		}
		const a = Math.max(toEpochDay(from) - d0, 0);
		const b = Math.min(toEpochDay(to) - d0, n - 1);
		for (let i = a; i <= b; i++) {
			if (forcing) forcing[i] = null;
			if (values[i] === null) continue;
			values[i] = null;
			unreliable++;
		}
	}

	const z = r.zeroRain?.infill;
	if (z && z.days > 0)
		warnings.push(warn('rain.station.zeroRun.missing', { station: stationId, days: z.days }, `${who} is treated as missing on ${plural(z.days, 'day')} of flagged zero runs (§2.4c, with the catchment’s settings). The stored series is unchanged.`));
	if (z && z.asRecordedDays > 0)
		warnings.push(
			warn('rain.station.zeroRun.asRecorded', { station: stationId, days: z.asRecordedDays }, `${who} has flagged zero runs on ${plural(z.asRecordedDays, 'day')} run as recorded (dry): Model settings → Rain gaps → Flagged rain → Flagged zero runs is "Run as recorded (dry)".`)
		);
	const acc = r.accumulation?.info;
	if (!opts.fitExcludeAccumulations && acc && acc.spreadWindows > 0)
		warnings.push(
			warn(
				'rain.station.accumulation.spread',
				{ station: stationId, windows: acc.spreadWindows, days: acc.spreadDays, mm: Math.round(acc.spreadMm) },
				`${who} has ${plural(acc.spreadWindows, 'multi-day accumulation')} spread over ${plural(acc.spreadDays, 'day')} (${mm(acc.spreadMm)}) in proportion to CHIRPS (§2.4d, with the catchment’s settings). The stored series is unchanged.`
			)
		);
	const outages = (acc?.windows ?? []).filter((w) => w.status === 'setAside').length;
	if (outages > 0) warnings.push(warn('rain.station.accumulation.setAside', { station: stationId, readings: outages }, `${who} has ${plural(outages, 'reading')} after a blank outage set aside as missing (§2.4d): each may hold the outage’s rain.`));
	const asRecorded = (acc?.windows ?? []).filter((w) => w.status === 'asRecorded').length;
	if (asRecorded > 0)
		warnings.push(
			warn(
				'rain.station.accumulation.asRecorded',
				{ station: stationId, windows: asRecorded },
				`${who} has ${plural(asRecorded, 'multi-day accumulation')} run as recorded, because Model settings → Rain gaps → Flagged rain → Multi-day accumulations → Accumulated readings is "Run as recorded (one day)".`
			)
		);
	if (unreliable > 0) warnings.push(warn('rain.station.unreliable', { station: stationId, days: unreliable }, `${who} is treated as missing on ${plural(unreliable, 'day')} the user marked unreliable. The stored series is unchanged.`));

	return { record: { startDate: fromEpochDay(d0), values }, setAside: { checks, unreliable }, warnings, ...(forcing ? { forcing: { startDate: fromEpochDay(d0), values: forcing } } : {}) };
}
