// The gap-filling products beside CHIRPS (issue #604 R4-E): what the Data
// tab's panel and the per-day preview make of GET …/feeds/gap-rain. Synthetic
// values only.
import { defaultProjectSettings, ERA5L_SERIES_KEY, imergSeriesKey, type ProjectSettings, type SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { Daily } from './coverage';
import {
	feedOptionLabel,
	fillProblems,
	gapRainChoiceText,
	gapRainInputSeries,
	imergVersionOn,
	imergVersions,
	productChartCaption,
	productChartSeries,
	productDoubleMass,
	segmentVersionOn,
	viewCredits,
	type GapRainView
} from './gapRain';
import { buildPreviewRows } from './preview';

const view = (over: Partial<GapRainView> = {}): GapRainView => ({
	gapRain: { product: 'chirpsThenEra5l', imergLate: true },
	feeds: [
		{ id: 'f1', seriesId: 's-chirps', seriesName: 'CHIRPS', nodeId: null, nodeName: null, runsRead: true },
		{ id: 'f2', seriesId: 's-unit', seriesName: 'CHIRPS – Upper', nodeId: 'n1', nodeName: 'Upper unit', runsRead: false }
	],
	feed: 'f1',
	window: { start: '2026-01-01', end: '2026-01-10' },
	record: { start: '2026-01-01', end: '2026-01-10' },
	fill: { era5l: { status: 'ok', error: null, at: '2026-01-10T06:00:00Z' }, imergLate: { status: 'ok', error: null, at: '2026-01-10T06:00:00Z' } },
	era5l: { startDate: '2026-01-01', values: [1, 2, null, 4], held: 3 },
	imergLate: { startDate: '2026-01-05', values: [5, null, 7, 8], versions: ['V07', null, 'V07', 'V08'], held: 3 },
	...over
});

describe('gapRainInputSeries', () => {
	it('stands for the run input: ERA5-Land under its key, one series per IMERG version holding only its own days', () => {
		const s = gapRainInputSeries(view());
		expect(Object.keys(s).sort()).toEqual([ERA5L_SERIES_KEY, imergSeriesKey('V07'), imergSeriesKey('V08')].sort());
		expect(s[ERA5L_SERIES_KEY]).toEqual({ startDate: '2026-01-01', values: [1, 2, null, 4] });
		expect(s[imergSeriesKey('V07')]).toEqual({ startDate: '2026-01-05', values: [5, null, 7] });
		expect(s[imergSeriesKey('V08')]).toEqual({ startDate: '2026-01-08', values: [8] });
	});

	it('only what the settings read: none with CHIRPS alone, no ERA5-Land under CHIRPS + IMERG, no IMERG without it', () => {
		expect(gapRainInputSeries(view({ gapRain: null }))).toEqual({});
		expect(Object.keys(gapRainInputSeries(view(), { product: 'chirps', imergLate: true }))).not.toContain(ERA5L_SERIES_KEY);
		expect(Object.keys(gapRainInputSeries(view(), { product: 'era5l', imergLate: false }))).toEqual([ERA5L_SERIES_KEY]);
		expect(gapRainInputSeries(null)).toEqual({});
	});
});

describe('the panel’s helpers', () => {
	it('names the settings’ choice in words', () => {
		expect(gapRainChoiceText(null)).toBe('CHIRPS');
		expect(gapRainChoiceText({ product: 'era5l', imergLate: false })).toBe('ERA5-Land');
		expect(gapRainChoiceText({ product: 'chirpsThenEra5l', imergLate: true })).toBe('CHIRPS, then ERA5-Land where CHIRPS has none, and IMERG Late for the recent days');
	});

	it('draws CHIRPS, ERA5-Land and IMERG Late (with its versions), each only when it has days, IMERG as points', () => {
		const lines = productChartSeries({ startDate: '2026-01-01', values: [0, 1] }, view());
		expect(lines.map((l) => l.label)).toEqual(['CHIRPS', 'ERA5-Land', 'IMERG Late (V07, V08)']);
		expect(lines[2]!.style).toBe('points');
		expect(productChartSeries(null, view({ imergLate: null })).map((l) => l.label)).toEqual(['ERA5-Land']);
		// No two lines share a colour.
		expect(new Set(lines.map((l) => l.color)).size).toBe(3);
	});

	it('captions the chart with where, what it shows and what is held', () => {
		const v = view();
		expect(productChartCaption(v, v.feeds[1]!)).toBe('Daily rain in mm over the cells of Upper unit’s CHIRPS feed (CHIRPS – Upper), as each product reads it, before any bias correction. Held: ERA5-Land 3 days, IMERG Late 3 days.');
		expect(feedOptionLabel(v.feeds[0]!)).toBe('Outlet: CHIRPS');
		expect(feedOptionLabel(v.feeds[1]!)).toBe('Upper unit: CHIRPS – Upper');
	});

	it('reads a day’s IMERG version from the copy, and from a run’s segments', () => {
		expect(imergVersionOn(view(), '2026-01-08')).toBe('V08');
		expect(imergVersionOn(view(), '2026-01-06')).toBeNull();
		expect(imergVersionOn(view(), '2025-12-31')).toBeNull();
		expect(imergVersions(view())).toEqual(['V07', 'V08']);
		const segments = [{ from: '2026-01-05', to: '2026-01-07', product: 'imerg_late' as const, version: 'V07' }];
		expect(segmentVersionOn(segments, '2026-01-06')).toBe('V07');
		expect(segmentVersionOn(segments, '2026-01-08')).toBeNull();
	});

	it('credits what the view shows: ERA5-Land’s notice with this year, IMERG’s citation per version', () => {
		const c = viewCredits(view(), '2026-10-27');
		expect(c.map((x) => x.product)).toEqual(['era5l', 'imerg_late']);
		expect(c[0]!.lines[0]).toMatch(/^Contains modified Copernicus Climate Change Service information 2026\./);
		expect(c[1]!.lines).toHaveLength(2);
		expect(viewCredits(view({ era5l: null, imergLate: null }), '2026-10-27')).toEqual([]);
	});

	it('checks the double mass against a product with years of record, and leaves out one with none', () => {
		// Twelve water years of daily rain (the check needs ten): catchment = 2 × ERA5-Land every day.
		const days = 12 * 365;
		const era = Array.from({ length: days }, (_, i) => (i % 3 === 0 ? 6 : 0));
		const v = view({ era5l: { startDate: '2010-10-01', values: era, held: days } });
		const catchment = { startDate: '2010-10-01', values: era.map((x) => x * 2) };
		const dms = productDoubleMass(catchment, v);
		expect(dms.map((d) => d.label)).toEqual(['ERA5-Land']);
		expect(dms[0]!.dm.wholeSlope).toBeCloseTo(2, 6);
		expect(dms[0]!.dm.breaks).toEqual([]);
		expect(productDoubleMass(null, v)).toEqual([]);
	});
});

describe('the per-day preview with a gap-filling product (engine ≥ 1.101.0)', () => {
	const meta = (id: string, kind: SeriesMeta['kind'], length: number): SeriesMeta => ({ id, kind, name: '', unit: 'mm', startDate: '2026-01-01', length });
	const list = [meta('c', 'rain_catchment_mm', 10), meta('h', 'rain_chirps_mm', 6)];
	const values: Record<string, Daily> = {
		c: { startDate: '2026-01-01', values: [1, 0, 2, null, 3, 0, null, 1, null, null] },
		h: { startDate: '2026-01-01', values: [1, 0, 2, 4, 3, 0] }
	};

	it('fills a blank day as a run would: CHIRPS where it has a value, ERA5-Land where it has none, IMERG Late past the last reading, with its version', () => {
		const settings = { ...defaultProjectSettings(), gapRain: { product: 'chirpsThenEra5l', imergLate: true } } as ProjectSettings;
		const extra = {
			[ERA5L_SERIES_KEY]: { startDate: '2026-01-01', values: [1, 0, 2, 3, 3, 0, 5, 1] },
			[imergSeriesKey('V07')]: { startDate: '2026-01-09', values: [6, 7] }
		};
		const rows = buildPreviewRows(list, values, settings, extra);
		const by = (d: string) => rows.find((r) => r.date === d)!.derived;
		expect(by('2026-01-04').rainSource).toBe('chirps');
		expect(by('2026-01-07').rainSource).toBe('era5l');
		expect(by('2026-01-09')).toMatchObject({ rainSource: 'imergLate', rainSourceVersion: 'V07' });
		expect(by('2026-01-01').rainSource).toBe('catchment');
		// The same days without the products: nothing names them (positive control above).
		const plain = buildPreviewRows(list, values, defaultProjectSettings());
		expect(plain.map((r) => r.derived.rainSource)).not.toContain('era5l');
		expect(plain.map((r) => r.derived.rainSource)).not.toContain('imergLate');
	});
});

describe('fillProblems', () => {
	it('says a failed fill, in words from its code, instead of "nothing held yet"; nothing when every fill went through', () => {
		expect(fillProblems(view())).toEqual([]);
		const failed = view({ era5l: null, fill: { era5l: { status: 'failed', error: 'format', at: null }, imergLate: { status: 'not_ready', error: null, at: null } } });
		expect(fillProblems(failed)).toEqual([
			'Couldn’t fill ERA5-Land on the last fetch: the rain data copy’s files aren’t in the form the app reads. The next fetch tries again.',
			'The rain data copy holds no IMERG Late yet, so there is none to fill.'
		]);
		// A product the settings don't read is never mentioned, and CHIRPS alone has none.
		expect(fillProblems({ ...failed, gapRain: { product: 'era5l', imergLate: false } })).toHaveLength(1);
		expect(fillProblems({ ...failed, gapRain: null })).toEqual([]);
	});

	it('the chart caption names the span when the record is longer than the ten years read', () => {
		const long = view({ window: { start: '2016-01-11', end: '2026-01-10' }, record: { start: '1990-01-01', end: '2026-01-10' } });
		expect(productChartCaption(long, null)).toContain('Shown from 2016-01-11, the last ten years of a record from 1990-01-01.');
		expect(productChartCaption(view(), null)).not.toContain('Shown from');
	});
});
