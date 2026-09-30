// The columns of one input series' download (GET …/series/:seriesId/export.csv,
// docs/api.md § Export): the value as stored, then how the data checks and the
// model read it (issue #66, operator decision on #93). Pure: the route loads
// the series, the project's settings and the latest run that read the series,
// and this builds the columns. Unit-tested in series-columns.test.ts.
//
// - Every series: `Flags` (missing, negative, outlier, flat-line), by the
//   project's current data-quality limits (engine seriesRowFlags, the rules the
//   Data tab's checks and Preview use).
// - A flow series: the value in m³/day; a calibration record of the outlet also
//   whether the day is excluded from calibration, and why.
// - From the latest run that read this series (run_input_series.series_id), each
//   header naming the run: for catchment rain, the rain used after gap filling,
//   its source and the rain above the run's rain threshold (plus the days set
//   aside as missing or spread from an accumulation, when the run has them); for
//   CHIRPS, the day's bias factor and the corrected rain; for a calibration flow
//   record, the simulated outflow (a gauge node's record: the flow simulated
//   there). No run read it: none of these, only the value and its checks.
import {
	ACCUMULATION_COLUMN,
	aboveRainThreshold,
	CALIBRATION_FLOW_KINDS,
	exclusionRanges,
	RAIN_SOURCE_CODE,
	RAIN_SOURCE_COLUMN,
	resolveDataQuality,
	SERIES_KINDS,
	seriesRowFlags,
	toEpochDay,
	ZERO_RAIN_COLUMN,
	type ProjectSettings,
	type SeriesKind
} from '@water-management/engine';
import { seriesHeader, type DailyColumn } from './csv.js';

const SEC_PER_DAY = 86_400;

export interface ExportSeries {
	kind: string;
	/** "kind – name", as the value column's header has always read. */
	label: string;
	unit: string;
	startDate: string;
	values: readonly (number | null)[];
	/** The gauge node a flow record belongs to (084_gauge_records); null = the outlet's. */
	siteNodeId: string | null;
}

/** One stored run series (run_series), as the download reads it. */
export interface RunColumn {
	label: string;
	unit: string | null;
	values: readonly (number | null)[];
}

/** The latest run that read the series, and what it stored. */
export interface ReadingRun {
	/** The run's label, else its creation date: what the headers name it by. */
	name: string;
	startDate: string;
	/** The run_input_series key it read the series as: its kind, or `<kind>@<node id>` for a gauge's record. */
	inputKey: string;
	/** settings.calibration.rainThresholdMm as the run stored it; null when it didn't. */
	rainThresholdMm: number | null;
	/** The run's catchment series by key (rain_final, rain_source, chirps_factor, simulated_outflow …). */
	catchment: Readonly<Record<string, RunColumn>>;
	/** A gauge record's simulated flow: the gauge node's `outflow`; null otherwise. */
	gaugeFlow: (RunColumn & { gaugeName: string }) | null;
}

/** The `rain_source` codes in words (engine RAIN_SOURCE_CODE); a missing day is blank. */
const SOURCE_NAME: Record<number, string> = {
	[RAIN_SOURCE_CODE.catchment]: 'catchment',
	[RAIN_SOURCE_CODE.series]: 'alternative gauge',
	[RAIN_SOURCE_CODE.chirps]: 'CHIRPS',
	[RAIN_SOURCE_CODE.reanalysis]: 'reanalysis',
	[RAIN_SOURCE_CODE.forecast]: 'forecast'
};

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** The columns after `date`, the first being the stored value (the file's shape before #66, unchanged). */
export function seriesExportColumns(s: ExportSeries, settings: ProjectSettings, run: ReadingRun | null): DailyColumn[] {
	const cols: DailyColumn[] = [{ header: seriesHeader(s.label, s.unit), values: s.values }];

	const flags = (SERIES_KINDS as readonly string[]).includes(s.kind)
		? seriesRowFlags(s.kind as SeriesKind, { startDate: s.startDate, values: [...s.values] }, resolveDataQuality(settings.dataQuality))
		: null;
	cols.push({
		header: 'Flags',
		values: [],
		text: (i) => {
			const out: string[] = [];
			if (!finite(s.values[i])) out.push('missing');
			if (flags?.negative[i]) out.push('negative');
			if (flags?.outlier[i]) out.push('outlier');
			if (flags?.flatline[i]) out.push('flat-line');
			return out.join('; ');
		}
	});

	if (s.kind.startsWith('flow_')) {
		cols.push({ header: seriesHeader(s.label, 'm³/day'), values: s.values.map((v) => (finite(v) ? v * SEC_PER_DAY : null)) });
		if ((CALIBRATION_FLOW_KINDS as readonly string[]).includes(s.kind) && s.siteNodeId === null) {
			const ranges = exclusionRanges(settings.calibrationExclusions ?? []).map((r) => ({ from: toEpochDay(r.start), to: toEpochDay(r.end), reason: r.reason }));
			const d0 = toEpochDay(s.startDate);
			cols.push({
				header: 'Excluded from calibration (reason)',
				values: [],
				text: (i) => ranges.find((r) => r.from <= d0 + i && d0 + i <= r.to)?.reason ?? ''
			});
		}
	}

	if (run) cols.push(...runColumns(s, run));
	return cols;
}

/** The run's columns for this series, re-indexed from the run's days onto the series' days. */
function runColumns(s: ExportSeries, run: ReadingRun): DailyColumn[] {
	const shift = toEpochDay(s.startDate) - toEpochDay(run.startDate);
	const at = (values: readonly (number | null)[]) => (i: number) => values[i + shift] ?? null;
	const tag = `[run ${run.name}]`;
	const numeric = (c: RunColumn, label = c.label): DailyColumn => {
		const get = at(c.values);
		return { header: seriesHeader(`${label} ${tag}`, c.unit), values: s.values.map((_, i) => get(i)) };
	};
	const out: DailyColumn[] = [];
	const c = run.catchment;

	if (run.inputKey === 'rain_catchment_mm') {
		const final = c.rain_final;
		if (final) out.push(numeric(final, 'Rain used'));
		const source = c[RAIN_SOURCE_COLUMN.key];
		if (source) {
			const get = at(source.values);
			out.push({ header: `Rain source ${tag}`, values: [], text: (i) => { const v = get(i); return finite(v) ? (SOURCE_NAME[v] ?? '') : ''; } });
		}
		if (final && run.rainThresholdMm !== null) {
			const get = at(final.values);
			const thr = run.rainThresholdMm;
			out.push({
				header: seriesHeader(`Rain above the ${thr} mm threshold ${tag}`, 'mm'),
				values: s.values.map((_, i) => { const v = get(i); return finite(v) ? aboveRainThreshold(v, thr) : null; })
			});
		}
		for (const key of [ZERO_RAIN_COLUMN.key, ACCUMULATION_COLUMN.key]) if (c[key]) out.push(numeric(c[key]!));
	} else if (run.inputKey === 'rain_chirps_mm') {
		if (c.chirps_factor) out.push(numeric(c.chirps_factor));
		if (c.rain_chirps_corrected) out.push(numeric(c.rain_chirps_corrected));
		// Engine ≥ 1.53.0 (CR-23): CHIRPS after the gap map, when it was on.
		if (c.rain_chirps_mapped) out.push(numeric(c.rain_chirps_mapped));
	} else if ((CALIBRATION_FLOW_KINDS as readonly string[]).includes(run.inputKey)) {
		if (c.simulated_outflow) out.push(numeric(c.simulated_outflow));
	} else if (run.gaugeFlow) {
		out.push(numeric(run.gaugeFlow, `Simulated flow at ${run.gaugeFlow.gaugeName}`));
	}
	return out;
}

/** The run_series keys runColumns can read from the catchment. */
export const RUN_CATCHMENT_KEYS = ['rain_final', RAIN_SOURCE_COLUMN.key, ZERO_RAIN_COLUMN.key, ACCUMULATION_COLUMN.key, 'chirps_factor', 'rain_chirps_corrected', 'rain_chirps_mapped', 'simulated_outflow'];
