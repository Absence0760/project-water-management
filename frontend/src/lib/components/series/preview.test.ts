import { defaultProjectSettings, SERIES_KINDS, type ProjectSettings, type SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { Daily } from './coverage';
import { helpFor } from '$lib/help/content';
import {
	buildPreviewColumns,
	buildPreviewRows,
	filterPreviewRows,
	headerUnit,
	m3DayColumnId,
	parseValueComparison,
	PREVIEW_DATE_HELP_KEY,
	seriesColumnId,
	type PreviewRow
} from './preview';

const meta = (over: Partial<SeriesMeta>): SeriesMeta => ({
	id: over.id ?? 'id',
	kind: over.kind ?? 'rain_catchment_mm',
	name: over.name ?? '',
	unit: over.unit ?? 'mm',
	startDate: over.startDate ?? '2020-01-01',
	length: over.length ?? 1
});

describe('buildPreviewColumns', () => {
	const list: SeriesMeta[] = [
		meta({ id: 'a', kind: 'rain_catchment_mm', unit: 'mm' }),
		meta({ id: 'b', kind: 'flow_observed_m3s', name: 'Gauge W7', unit: 'm³/s' })
	];

	it('has one column per series, in the same order, before the derived columns', () => {
		const cols = buildPreviewColumns(list);
		expect(cols[0]).toMatchObject({ id: seriesColumnId('a'), label: 'Rainfall — catchment', unit: 'mm', group: 'series', seriesId: 'a' });
		expect(cols[1]).toMatchObject({ id: seriesColumnId('b'), label: 'Flow — observed gauge · Gauge W7', unit: 'm³/s', group: 'series', seriesId: 'b' });
	});

	it('adds a m³/day column for each flow series, none for rain', () => {
		const cols = buildPreviewColumns(list);
		const ids = cols.map((c) => c.id);
		expect(ids).toContain(m3DayColumnId('b'));
		expect(ids).not.toContain(m3DayColumnId('a'));
	});

	it('adds "Rain used" only when a rain series exists, and CHIRPS columns only when a CHIRPS series exists', () => {
		expect(buildPreviewColumns([meta({ id: 'a', kind: 'flow_observed_m3s' })]).map((c) => c.id)).not.toContain('rainUsed');
		expect(buildPreviewColumns([meta({ id: 'a', kind: 'rain_catchment_mm' })]).map((c) => c.id)).toEqual(expect.arrayContaining(['rainUsed']));
		expect(buildPreviewColumns([meta({ id: 'a', kind: 'rain_catchment_mm' })]).map((c) => c.id)).not.toContain('chirpsFactor');
		const withChirps = buildPreviewColumns([meta({ id: 'a', kind: 'rain_chirps_mm' })]).map((c) => c.id);
		expect(withChirps).toEqual(expect.arrayContaining(['chirpsFactor', 'chirpsCorrected']));
	});

	it('always includes the "excluded from calibration" column, even with no series', () => {
		expect(buildPreviewColumns([]).map((c) => c.id)).toEqual(['excluded']);
	});

	it('shows each header unit once: not again after a label that already ends with it', () => {
		const cols = buildPreviewColumns(list);
		const byId = (id: string) => cols.find((c) => c.id === id)!;
		expect(headerUnit(byId(seriesColumnId('b')))).toBe('m³/s');
		expect(byId(m3DayColumnId('b')).label).toBe('Flow — observed gauge · Gauge W7 (m³/day)');
		expect(headerUnit(byId(m3DayColumnId('b')))).toBeNull();
		expect(headerUnit(byId('rainUsed'))).toBe('mm');
		expect(headerUnit(byId('excluded'))).toBeNull();
	});

	it('gives every column, for every series kind, a help key that resolves: series.<kind> for raw series, its own preview.* entry for each derived column', () => {
		const all = SERIES_KINDS.map((kind, i) => meta({ id: `s${i}`, kind }));
		const cols = buildPreviewColumns(all);
		for (const c of cols) expect(helpFor(c.helpKey), `${c.id} → ${c.helpKey}`).toBeDefined();
		for (const c of cols.filter((c) => c.group === 'series')) expect(c.helpKey).toBe(`series.${all.find((s) => s.id === c.seriesId)!.kind}`);
		expect(helpFor(PREVIEW_DATE_HELP_KEY)).toBeDefined();
		// Each derived column explains itself, not a neighbour's (or a raw series') text.
		const derived = [PREVIEW_DATE_HELP_KEY, ...new Set(cols.filter((c) => c.group === 'derived').map((c) => c.helpKey))];
		expect(derived).toEqual(['preview.date', 'preview.flowM3Day', 'preview.rainUsed', 'preview.chirpsFactor', 'preview.chirpsCorrected', 'preview.excluded']);
		expect(new Set(derived.map((k) => helpFor(k)!.id)).size).toBe(derived.length);
	});
});

describe('buildPreviewRows: joining series with different periods', () => {
	// A: 2020-01-01..05 (rain). B: 2020-01-04..07 (flow) — a 2-day overlap, each
	// with 2 days the other doesn't cover, so the union runs 01-01..01-07.
	const a = meta({ id: 'a', kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', length: 5 });
	const b = meta({ id: 'b', kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2020-01-04', length: 4 });
	const valuesById: Record<string, Daily> = {
		a: { startDate: '2020-01-01', values: [1, -2, 3, 4, 5] },
		b: { startDate: '2020-01-04', values: [0.5, 0.6, null, 0.8] }
	};
	const settings = defaultProjectSettings();
	const rows = buildPreviewRows([a, b], valuesById, settings);

	it('spans the union of every series with loaded values', () => {
		expect(rows.map((r) => r.date)).toEqual(['2020-01-01', '2020-01-02', '2020-01-03', '2020-01-04', '2020-01-05', '2020-01-06', '2020-01-07']);
	});

	it('a series column is null (and flagged missing, same as an in-period gap) outside that series’ own period', () => {
		expect(rows[0]!.series.b).toEqual({ value: null, flags: ['missing'], m3Day: null });
		expect(rows[6]!.series.a).toEqual({ value: null, flags: ['missing'], m3Day: null });
	});

	it('carries each series’ own value and quality flags into its column', () => {
		expect(rows[1]!.series.a).toMatchObject({ value: -2, flags: ['negative'] }); // 2020-01-02
		expect(rows[5]!.series.b).toMatchObject({ value: null, flags: ['missing'] }); // 2020-01-06, b[null]
	});

	it('adds a m³/day figure for a flow series’ value, and none for rain', () => {
		expect(rows[3]!.series.b!.m3Day).toBeCloseTo(0.5 * 86_400, 6); // 2020-01-04
		expect(rows[0]!.series.a!.m3Day).toBeNull();
	});
});

describe('buildPreviewRows: rain gap-fill source, via the engine’s own prepareRun', () => {
	// catchment covers 01-01..03 with a gap on 01-02; chirps covers 01-01..04;
	// forecast only covers 01-04..05 — so day 5 falls back all the way to forecast.
	const catchment = meta({ id: 'cat', kind: 'rain_catchment_mm', startDate: '2020-01-01', length: 3 });
	const chirps = meta({ id: 'chi', kind: 'rain_chirps_mm', startDate: '2020-01-01', length: 4 });
	const forecast = meta({ id: 'fc', kind: 'rain_forecast_mm', startDate: '2020-01-04', length: 2 });
	const valuesById: Record<string, Daily> = {
		cat: { startDate: '2020-01-01', values: [5, null, 3] },
		chi: { startDate: '2020-01-01', values: [1, 1, 1, 1] },
		fc: { startDate: '2020-01-04', values: [9, 9] }
	};
	const settings = defaultProjectSettings();
	const rows = buildPreviewRows([catchment, chirps, forecast], valuesById, settings);
	const byDate = new Map(rows.map((r) => [r.date, r]));

	it('picks catchment first when it has a reading', () => {
		expect(byDate.get('2020-01-01')!.derived).toMatchObject({ rainSource: 'catchment', rainUsedMm: 5 });
		expect(byDate.get('2020-01-03')!.derived).toMatchObject({ rainSource: 'catchment', rainUsedMm: 3 });
	});

	it('falls back to CHIRPS when catchment is blank that day', () => {
		expect(byDate.get('2020-01-02')!.derived).toMatchObject({ rainSource: 'chirps', rainUsedMm: 1 });
		expect(byDate.get('2020-01-04')!.derived).toMatchObject({ rainSource: 'chirps', rainUsedMm: 1 });
	});

	it('falls back to forecast when neither catchment nor CHIRPS has a reading', () => {
		expect(byDate.get('2020-01-05')!.derived).toMatchObject({ rainSource: 'forecast', rainUsedMm: 9 });
	});

	it('is null (outside the model’s run window) before/after every rain series, not "none"', () => {
		// The run window here is exactly the rain series' own span (01-01..05); nothing lies outside it.
		expect(rows).toHaveLength(5);
	});

	it('is null when a settings window (simulationEnd) cuts the run short of a series’ own data', () => {
		const cut: ProjectSettings = { ...settings, simulationStart: '2020-01-01', simulationEnd: '2020-01-03' };
		const cutRows = buildPreviewRows([catchment, chirps, forecast], valuesById, cut);
		const cutByDate = new Map(cutRows.map((r) => [r.date, r]));
		expect(cutByDate.get('2020-01-04')!.derived.rainSource).toBeNull();
		expect(cutByDate.get('2020-01-04')!.derived.rainUsedMm).toBeNull();
		// Still within the window: unaffected.
		expect(cutByDate.get('2020-01-01')!.derived.rainSource).toBe('catchment');
	});
});

describe('buildPreviewRows: CHIRPS bias correction, via the engine’s own rain.ts', () => {
	// 100 days, one calendar month each of Jan–Apr: not enough days in any one
	// month to fit that month's own factor, but enough pooled (>= 90 days, >=
	// 50mm CHIRPS) to fit the pooled factor catchment/chirps = 10/5 = 2. One day
	// (index 50) has no catchment reading, so CHIRPS fills in there.
	const days = 100;
	const FALLBACK_INDEX = 50;
	const catchmentValues = Array.from({ length: days }, (_, i) => (i === FALLBACK_INDEX ? null : 10));
	const chirpsValues = Array.from({ length: days }, () => 5);
	const catchment = meta({ id: 'cat', kind: 'rain_catchment_mm', startDate: '2020-01-01', length: days });
	const chirps = meta({ id: 'chi', kind: 'rain_chirps_mm', startDate: '2020-01-01', length: days });
	const valuesById: Record<string, Daily> = {
		cat: { startDate: '2020-01-01', values: catchmentValues },
		chi: { startDate: '2020-01-01', values: chirpsValues }
	};
	const settings = defaultProjectSettings(); // chirpsBiasCorrection: 'monthly'
	const rows = buildPreviewRows([catchment, chirps], valuesById, settings);

	it('bias-corrects CHIRPS only on the fallback day, by the pooled factor', () => {
		expect(rows[FALLBACK_INDEX]!.derived).toMatchObject({ rainSource: 'chirps', chirpsFactor: 2, chirpsCorrectedMm: 10 });
	});

	it('leaves CHIRPS at its raw value on a day it is not the fallback (catchment already has a reading)', () => {
		expect(rows[0]!.derived).toMatchObject({ rainSource: 'catchment', rainUsedMm: 10, chirpsCorrectedMm: 5 });
	});

	it('shows the month’s factor on every day, not only the fallback day (context, not just when applied)', () => {
		expect(rows[0]!.derived.chirpsFactor).toBe(2);
	});

	it('mode "none" leaves CHIRPS raw even on the fallback day (respects settings.chirpsBiasCorrection)', () => {
		const off: ProjectSettings = { ...settings, chirpsBiasCorrection: 'none' };
		const offRows = buildPreviewRows([catchment, chirps], valuesById, off);
		expect(offRows[FALLBACK_INDEX]!.derived.chirpsCorrectedMm).toBe(5);
	});
});

describe('buildPreviewRows: excluded from calibration', () => {
	const a = meta({ id: 'a', kind: 'flow_observed_m3s', startDate: '2020-01-01', length: 5 });
	const valuesById: Record<string, Daily> = { a: { startDate: '2020-01-01', values: [1, 1, 1, 1, 1] } };
	const settings: ProjectSettings = {
		...defaultProjectSettings(),
		calibrationExclusions: [{ start: '2020-01-02', end: '2020-01-03', reason: 'logger fault' }]
	};
	const rows = buildPreviewRows([a], valuesById, settings);
	const byDate = new Map(rows.map((r) => [r.date, r]));

	it('flags only the days inside an exclusion range, with its reason', () => {
		expect(byDate.get('2020-01-01')!.derived).toMatchObject({ excluded: false, exclusionReason: null });
		expect(byDate.get('2020-01-02')!.derived).toMatchObject({ excluded: true, exclusionReason: 'logger fault' });
		expect(byDate.get('2020-01-03')!.derived).toMatchObject({ excluded: true, exclusionReason: 'logger fault' });
		expect(byDate.get('2020-01-04')!.derived).toMatchObject({ excluded: false, exclusionReason: null });
	});
});

describe('parseValueComparison', () => {
	it('parses each supported operator', () => {
		expect(parseValueComparison('> 20')!(21)).toBe(true);
		expect(parseValueComparison('> 20')!(20)).toBe(false);
		expect(parseValueComparison('>=20')!(20)).toBe(true);
		expect(parseValueComparison('< 5')!(4)).toBe(true);
		expect(parseValueComparison('<=5')!(5)).toBe(true);
		expect(parseValueComparison('= 0')!(0)).toBe(true);
		expect(parseValueComparison('==0')!(0)).toBe(true);
		expect(parseValueComparison('=0')!(1)).toBe(false);
	});

	it('accepts a negative or decimal operand', () => {
		expect(parseValueComparison('< -0.5')!(-1)).toBe(true);
		expect(parseValueComparison('>1.5')!(1.6)).toBe(true);
	});

	it('returns null for anything that is not a comparison', () => {
		expect(parseValueComparison('2015')).toBeNull();
		expect(parseValueComparison('2015-03')).toBeNull();
		expect(parseValueComparison('')).toBeNull();
		expect(parseValueComparison('> abc')).toBeNull();
	});
});

describe('filterPreviewRows', () => {
	const row = (date: string, av: number | null, af: PreviewRow['series']['a']['flags'], bv: number | null, bf: PreviewRow['series']['a']['flags']): PreviewRow => ({
		date,
		series: {
			a: { value: av, flags: af, m3Day: null },
			b: { value: bv, flags: bf, m3Day: null }
		},
		derived: { rainUsedMm: null, rainSource: null, chirpsFactor: null, chirpsCorrectedMm: null, excluded: false, exclusionReason: null }
	});
	const rows: PreviewRow[] = [
		row('2015-03-14', 20, [], 1, []),
		row('2015-03-15', null, ['missing'], 1, []),
		row('2015-04-01', -1, ['negative'], null, ['missing']),
		row('2016-01-01', 20, [], 2, [])
	];

	it('with no query and no toggles, returns every row unchanged', () => {
		expect(filterPreviewRows(rows, { query: '', missingOnly: false, flaggedOnly: false, visibleSeriesIds: ['a', 'b'] })).toEqual(rows);
	});

	it('matches a year, year-month or full date prefix, regardless of which series are visible', () => {
		expect(filterPreviewRows(rows, { query: '2015', missingOnly: false, flaggedOnly: false, visibleSeriesIds: ['a'] }).map((r) => r.date)).toEqual([
			'2015-03-14',
			'2015-03-15',
			'2015-04-01'
		]);
		expect(filterPreviewRows(rows, { query: '2015-03', missingOnly: false, flaggedOnly: false, visibleSeriesIds: [] }).map((r) => r.date)).toEqual([
			'2015-03-14',
			'2015-03-15'
		]);
	});

	it('Missing only looks only at the visible series’ columns', () => {
		// Only 'a' visible: row 2015-04-01 (a=-1, not missing) is excluded even though b is missing there.
		expect(filterPreviewRows(rows, { query: '', missingOnly: true, flaggedOnly: false, visibleSeriesIds: ['a'] }).map((r) => r.date)).toEqual(['2015-03-15']);
		// Both visible: both missing-in-any-visible-series rows show.
		expect(filterPreviewRows(rows, { query: '', missingOnly: true, flaggedOnly: false, visibleSeriesIds: ['a', 'b'] }).map((r) => r.date)).toEqual([
			'2015-03-15',
			'2015-04-01'
		]);
	});

	it('Flagged only looks only at the visible series’ columns', () => {
		expect(filterPreviewRows(rows, { query: '', missingOnly: false, flaggedOnly: true, visibleSeriesIds: ['b'] }).map((r) => r.date)).toEqual(['2015-04-01']);
	});

	it('a value comparison tests the visible series only, skipping a missing value', () => {
		expect(filterPreviewRows(rows, { query: '> 0', missingOnly: false, flaggedOnly: false, visibleSeriesIds: ['a'] }).map((r) => r.date)).toEqual([
			'2015-03-14',
			'2016-01-01'
		]);
		expect(filterPreviewRows(rows, { query: '= 2', missingOnly: false, flaggedOnly: false, visibleSeriesIds: ['b'] }).map((r) => r.date)).toEqual(['2016-01-01']);
	});

	it('returns an empty array when nothing matches', () => {
		expect(filterPreviewRows(rows, { query: '2099', missingOnly: false, flaggedOnly: false, visibleSeriesIds: ['a', 'b'] })).toEqual([]);
		expect(filterPreviewRows(rows, { query: '', missingOnly: false, flaggedOnly: false, visibleSeriesIds: [] }).length).toBe(rows.length);
		expect(filterPreviewRows(rows, { query: '> 1000', missingOnly: false, flaggedOnly: false, visibleSeriesIds: ['a', 'b'] })).toEqual([]);
	});
});
