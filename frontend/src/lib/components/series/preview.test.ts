import { defaultProjectSettings, SERIES_KINDS, type NetworkNode, type ProjectSettings, type SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { Daily } from './coverage';
import { helpFor } from '#lib/help/content.js';
import type { AreaRainLines } from './derivedRain';
import {
	areaCell,
	areaColumnId,
	areaViewColumns,
	buildAreaColumns,
	buildPreviewColumns,
	buildPreviewRows,
	columnsForView,
	filterPreviewRows,
	headerUnit,
	m3DayColumnId,
	parseValueComparison,
	PREVIEW_DATE_HELP_KEY,
	previewViews,
	resolveView,
	seriesColumnId,
	shownSeriesIds,
	type PreviewRow
} from './preview';

const meta = (over: Partial<SeriesMeta>): SeriesMeta => ({
	...(over.siteNodeId ? { siteNodeId: over.siteNodeId } : {}),
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

	it('flags flat stretches by the project’s data-quality limits (engine 1.20.0), not only the defaults', () => {
		const flat = { c: { startDate: '2020-01-01', values: [1, 3, 3, 3, 3, 2] } };
		const c = meta({ id: 'c', kind: 'rain_catchment_mm' });
		const flags = (s: ProjectSettings) => buildPreviewRows([c], flat, s).map((r) => r.series.c!.flags.includes('flatline'));
		expect(flags(settings)).toEqual([false, false, false, false, false, false]); // 4 days: under the default 5
		const three = { ...settings, dataQuality: { ...settings.dataQuality, flatlineRainDays: 3 } };
		expect(flags(three)).toEqual([false, true, true, true, true, false]);
	});

	it('adds a m³/day figure for a flow series’ value, and none for rain', () => {
		expect(rows[3]!.series.b!.m3Day).toBeCloseTo(0.5 * 86_400, 6); // 2020-01-04
		expect(rows[0]!.series.a!.m3Day).toBeNull();
	});
});

describe('buildPreviewRows: a rain-source period’s series is the rain (engine ≥ 1.69.0)', () => {
	const alt = meta({ id: 'alt', kind: 'rain_catchment_alt_mm', startDate: '2020-01-01', length: 3 });
	const valuesById: Record<string, Daily> = { alt: { startDate: '2020-01-01', values: [4, 6, 2] } };
	const period = { start: '2020-01-01', end: '2020-01-03', series: 'rain_catchment_alt_mm' as const, factors: Array(12).fill(1), provenance: { source: 'invented', fittedFrom: '2019-01-01', fittedTo: '2019-12-31', method: 'invented' }, reason: 'invented' };

	it('fills "Rain used" from the period’s series when it is the only rain', () => {
		const rows = buildPreviewRows([alt], valuesById, { ...defaultProjectSettings(), rainSource: [period] } as never);
		expect(rows.map((r) => r.derived?.rainUsedMm)).toEqual([4, 6, 2]);
	});

	it('leaves it empty when no period uses the series (positive control)', () => {
		const rows = buildPreviewRows([alt], valuesById, defaultProjectSettings());
		expect(rows.map((r) => r.derived?.rainUsedMm ?? null)).toEqual([null, null, null]);
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

describe('buildPreviewRows: of two series of a kind, the one a run reads (issue #523)', () => {
	it('uses the first by the name’s bytes, as the backend’s COLLATE "C", not localeCompare', () => {
		// localeCompare puts "average gauge" first; byte order (and so every run) puts "RAIN-B logger" first.
		const gauge = meta({ id: 'g', kind: 'rain_catchment_mm', name: 'average gauge', startDate: '2020-01-01', length: 1 });
		const logger = meta({ id: 'l', kind: 'rain_catchment_mm', name: 'RAIN-B logger', startDate: '2020-01-01', length: 1 });
		const valuesById: Record<string, Daily> = { g: { startDate: '2020-01-01', values: [5] }, l: { startDate: '2020-01-01', values: [8] } };
		const rows = buildPreviewRows([gauge, logger], valuesById, defaultProjectSettings());
		expect(rows[0]!.derived).toMatchObject({ rainSource: 'catchment', rainUsedMm: 8 });
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

	it('finds days as the table shows them, day first: a month or a whole day', () => {
		const dates = (query: string) => filterPreviewRows(rows, { query, missingOnly: false, flaggedOnly: false, visibleSeriesIds: ['a'] }).map((r) => r.date);
		expect(dates('Mar 2015')).toEqual(['2015-03-14', '2015-03-15']);
		expect(dates('03/2015')).toEqual(['2015-03-14', '2015-03-15']);
		expect(dates('14 Mar 2015')).toEqual(['2015-03-14']);
		expect(dates('1/4/2015')).toEqual(['2015-04-01']);
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

describe('each area’s derived rain (issue #553)', () => {
	const lines = (over: Partial<AreaRainLines> = {}): AreaRainLines =>
		({
			startDate: '2020-01-01',
			rainUsed: [4, 0, 2.5],
			source: ['station', 'none', 'chirps'],
			stationRaw: [3, null, null],
			stationScaled: [4, null, null],
			chirpsRaw: [1, 0, 2],
			chirpsCorrected: [1.25, 0, 2.5],
			factors: null,
			refused: null,
			correctAgainst: 'st',
			forcing: {} as AreaRainLines['forcing'],
			warnings: [],
			...over
		}) as AreaRainLines;

	it('has the Full CSV’s columns per area, in its order and words, each its own help key and marked derived', () => {
		const cols = buildAreaColumns([
			{ nodeId: null, name: 'ignored', lines: lines() },
			{ nodeId: 'u1', name: 'Upper unit', lines: lines({ chirpsCorrected: null }) },
			{ nodeId: 'u2', name: 'Lower unit', lines: null, error: 'unavailable' }
		]);
		expect(cols.map((c) => c.label)).toEqual([
			'Average catchment rainfall: station × ratio',
			'Average catchment rainfall: CHIRPS corrected',
			'Average catchment rainfall: rain used',
			'Average catchment rainfall: rain used from',
			// No CHIRPS of its own: no corrected column.
			'Upper unit: station × ratio',
			'Upper unit: rain used',
			'Upper unit: rain used from'
		]);
		expect(cols.every((c) => c.group === 'area')).toBe(true);
		expect(cols[0]).toMatchObject({ id: areaColumnId(null, 'stationScaled'), unit: 'mm', area: { nodeId: null, line: 'stationScaled' } });
		expect(cols[3]).toMatchObject({ id: 'area:catchment:source', unit: '' });
		expect(cols[4]!.id).toBe('area:u1:stationScaled');
		for (const c of cols) expect(helpFor(c.helpKey), c.helpKey).toBeTruthy();
	});

	it('reads a day’s value by date, the source in words, blank outside the run window', () => {
		const l = lines();
		expect(areaCell(l, 'rainUsed', '2020-01-01')).toBe(4);
		expect(areaCell(l, 'stationScaled', '2020-01-02')).toBeNull();
		expect(areaCell(l, 'chirpsCorrected', '2020-01-03')).toBe(2.5);
		expect(areaCell(l, 'source', '2020-01-02')).toBe('no source (dry)');
		expect(areaCell(l, 'source', '2020-01-03')).toBe('corrected CHIRPS');
		expect(areaCell(l, 'rainUsed', '2019-12-31')).toBeNull();
		expect(areaCell(l, 'rainUsed', '2020-01-04')).toBeNull();
		expect(areaCell(lines({ chirpsCorrected: null }), 'chirpsCorrected', '2020-01-01')).toBeNull();
	});
});

describe('the View select’s views and their columns (issue #613)', () => {
	const unit = (id: string, name: string, kind = 'farm'): NetworkNode => ({ id, name, kind, areaKm2: 10 }) as unknown as NetworkNode;
	const nodes = [unit('g', 'Outflow gauge', 'gauge'), unit('u1', 'Upper unit'), unit('u2', 'Lower unit')];
	const list = [
		meta({ id: 'berg', kind: 'rain_catchment_mm', name: 'Bergwater' }),
		meta({ id: 'kloof', kind: 'rain_catchment_mm', name: 'Kloof' }),
		meta({ id: 'chc', kind: 'rain_chirps_mm', name: 'CHIRPS catchment' }),
		meta({ id: 'chu1', kind: 'rain_chirps_mm', name: 'CHIRPS Upper', siteNodeId: 'u1' }),
		meta({ id: 'gu1', kind: 'flow_observed_m3s', name: 'Upper weir', unit: 'm³/s', siteNodeId: 'u1' }),
		meta({ id: 'weir', kind: 'flow_observed_m3s', name: 'Outlet weir', unit: 'm³/s' })
	];
	const lines = (over: Partial<AreaRainLines> = {}): AreaRainLines =>
		({
			startDate: '2020-01-01',
			rainUsed: [4, 0],
			source: ['station', 'chirps'],
			stationRaw: [3.45, null],
			stationScaled: [4, null],
			chirpsRaw: [1, 0],
			chirpsCorrected: [1.25, 0],
			factors: Array.from({ length: 12 }, () => 1.25),
			refused: null,
			correctAgainst: 'berg',
			forcing: { stationId: 'berg', stationName: 'Bergwater', ratio: 863.1 / 745 } as AreaRainLines['forcing'],
			warnings: [],
			...over
		}) as AreaRainLines;
	const areas = [
		{ nodeId: null, name: 'Average catchment rainfall', lines: lines() },
		{ nodeId: 'u1', name: 'Upper unit', lines: lines() }
	];
	const all = [...buildPreviewColumns(list), ...buildAreaColumns(areas)];
	const ctx = { list, areas };
	const settings = { ...defaultProjectSettings(), rainStations: { catchment: { stationId: 'berg' } } } as ProjectSettings;

	it('lists All, each land unit in the model’s order, then the groups; the catchment only when it has a station', () => {
		expect(previewViews(nodes, settings, list).map((v) => [v.id, v.label, v.kind])).toEqual([
			['all', 'All', 'all'],
			['unit:u1', 'Upper unit', 'unit'],
			['unit:u2', 'Lower unit', 'unit'],
			['stations', 'All rainfall stations', 'group'],
			['catchment', 'Average catchment rainfall', 'group'],
			['flow', 'All flow', 'group']
		]);
		// No station assigned to the catchment, no station or flow stored: those groups aren't offered.
		expect(previewViews(nodes, defaultProjectSettings(), [list[2]!]).map((v) => v.id)).toEqual(['all', 'unit:u1', 'unit:u2']);
	});

	it('reads a view it doesn’t offer (a deleted unit, a stale link) as All', () => {
		const views = previewViews(nodes, settings, list);
		expect(resolveView(views, 'unit:u2')).toBe('unit:u2');
		expect(resolveView(views, 'unit:gone')).toBe('all');
		expect(resolveView(views, 'unit:g')).toBe('all'); // a gauge isn't a land unit
		expect(resolveView(views, null)).toBe('all');
	});

	it('All is today’s table: every column, in order, without the raw lines', () => {
		expect(columnsForView('all', all, ctx)).toEqual(all);
		expect(all.some((c) => c.area?.line === 'stationRaw' || c.area?.line === 'chirpsRaw')).toBe(false);
	});

	it('a unit: station raw and adjusted, CHIRPS raw and bias-corrected, rain used and its source, then the other series stored at it', () => {
		const cols = columnsForView('unit:u1', all, ctx);
		expect(cols.map((c) => c.label)).toEqual([
			'Bergwater raw',
			'Bergwater adjusted to Upper unit (× 1.159)',
			'Upper unit CHIRPS raw',
			'Upper unit CHIRPS bias-corrected (f(m) against Bergwater)',
			'Upper unit rain used',
			'Upper unit rain used from',
			// The CHIRPS series is its raw line already; the gauge stored at it follows, with its m³/day.
			'Flow — observed gauge · Upper weir',
			'Flow — observed gauge · Upper weir (m³/day)'
		]);
		expect(cols.slice(0, 6).map((c) => c.id)).toEqual(['stationRaw', 'stationScaled', 'chirpsRaw', 'chirpsCorrected', 'rainUsed', 'source'].map((l) => `area:u1:${l}`));
		for (const c of cols) expect(helpFor(c.helpKey), c.helpKey).toBeTruthy();
	});

	it('a unit corrected against another station names it; one without CHIRPS has no CHIRPS lines', () => {
		const other = { nodeId: 'u1', name: 'Upper unit', lines: lines({ correctAgainst: 'kloof', chirpsRaw: null, chirpsCorrected: null }) };
		expect(areaViewColumns(other, (id) => (id === 'kloof' ? 'Kloof' : null)).map((c) => c.area!.line)).toEqual(['stationRaw', 'stationScaled', 'rainUsed', 'source']);
		const refused = { nodeId: 'u1', name: 'Upper unit', lines: lines({ correctAgainst: 'kloof', chirpsCorrected: null }) };
		expect(areaViewColumns(refused, (id) => (id === 'kloof' ? 'Kloof' : null)).map((c) => c.label)).toEqual([
			'Bergwater raw',
			'Bergwater adjusted to Upper unit (× 1.159)',
			'Upper unit CHIRPS raw',
			'Upper unit rain used',
			'Upper unit rain used from'
		]);
		const kloof = { nodeId: 'u1', name: 'Upper unit', lines: lines({ correctAgainst: 'kloof' }) };
		expect(areaViewColumns(kloof, (id) => (id === 'kloof' ? 'Kloof' : null))[3]!.label).toBe('Upper unit CHIRPS bias-corrected (f(m) against Kloof)');
	});

	it('a unit without lines (no station, or they failed) shows only the series stored at it, its CHIRPS included', () => {
		expect(columnsForView('unit:u2', all, ctx)).toEqual([]);
		const failed = { list, areas: [{ nodeId: 'u1', name: 'Upper unit', lines: null, error: 'unavailable' }] };
		expect(columnsForView('unit:u1', all, failed).map((c) => c.id)).toEqual([seriesColumnId('chu1'), seriesColumnId('gu1'), m3DayColumnId('gu1')]);
	});

	it('the groups: the stations; the average catchment rainfall’s lines and the catchment’s own rain; every flow record with its m³/day and the exclusions', () => {
		expect(columnsForView('stations', all, ctx).map((c) => c.id)).toEqual([seriesColumnId('berg'), seriesColumnId('kloof')]);
		expect(columnsForView('catchment', all, ctx).map((c) => c.label)).toEqual([
			'Bergwater raw',
			'Bergwater adjusted to the catchment (× 1.159)',
			'Catchment CHIRPS raw',
			'Catchment CHIRPS bias-corrected (f(m) against Bergwater)',
			'Catchment rain used',
			'Catchment rain used from'
		]);
		expect(columnsForView('flow', all, ctx).map((c) => c.id)).toEqual([seriesColumnId('gu1'), m3DayColumnId('gu1'), seriesColumnId('weir'), m3DayColumnId('weir'), 'excluded']);
	});

	it('reads the raw lines by date; the toggles look only at the series a view shows', () => {
		const l = lines();
		expect(areaCell(l, 'stationRaw', '2020-01-01')).toBe(3.45);
		expect(areaCell(l, 'chirpsRaw', '2020-01-02')).toBe(0);
		expect(areaCell(lines({ chirpsRaw: null }), 'chirpsRaw', '2020-01-01')).toBeNull();

		// The raw lines read their stored series (the station, the CHIRPS a run reads), so the toggles and the search
		// work on them; the column checkboxes hide columns inside the view, and the toggles read only what's left.
		const unitCols = columnsForView('unit:u1', all, ctx);
		expect(unitCols.filter((c) => c.area && c.seriesId).map((c) => [c.area!.line, c.seriesId])).toEqual([
			['stationRaw', 'berg'],
			['chirpsRaw', 'chu1']
		]);
		expect(shownSeriesIds(unitCols)).toEqual(['berg', 'chu1', 'gu1']);
		const visibleSeriesIds = shownSeriesIds(unitCols.filter((c) => c.id !== seriesColumnId('gu1')));
		expect(visibleSeriesIds).toEqual(['berg', 'chu1']);
		const cell = (value: number | null) => ({ value, flags: value === null ? (['missing'] as const) : [], m3Day: null }) as PreviewRow['series'][string];
		const rows: PreviewRow[] = [
			{ date: '2020-01-01', series: { berg: cell(3), chu1: cell(1), gu1: cell(null), weir: cell(1) }, derived: {} as PreviewRow['derived'] },
			{ date: '2020-01-02', series: { berg: cell(null), chu1: cell(24), gu1: cell(1), weir: cell(1) }, derived: {} as PreviewRow['derived'] }
		];
		expect(filterPreviewRows(rows, { query: '', missingOnly: true, flaggedOnly: false, visibleSeriesIds }).map((r) => r.date)).toEqual(['2020-01-02']);
		expect(filterPreviewRows(rows, { query: '> 20', missingOnly: false, flaggedOnly: false, visibleSeriesIds }).map((r) => r.date)).toEqual(['2020-01-02']);
		const flowIds = shownSeriesIds(columnsForView('flow', all, ctx));
		expect(filterPreviewRows(rows, { query: '', missingOnly: true, flaggedOnly: false, visibleSeriesIds: flowIds }).map((r) => r.date)).toEqual(['2020-01-01']);
	});
});
