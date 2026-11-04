import type { NetworkNode, ProjectSettings, SeriesMeta } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { boundaryFixes, feedShadows, feedShadowText, feedShadowWhy } from './feedShadow';

const s = (id: string, kind: string, name: string, from: string, to: string, feed: SeriesMeta['feed'] = null): SeriesMeta => ({
	id,
	kind,
	name,
	unit: 'mm',
	startDate: from,
	length: 1,
	lastValueDate: to,
	feed
});
const chirps = { source: 'chirps', days: 300 };

// Synthetic names only: a workbook's gap-filler sorts before the boundary feed's "(boundary)" series.
const gapFiller = s('g', 'rain_chirps_mm', 'Rainfall CHIRPS gap-filler', '2009-01-01', '2025-10-22');
const boundary = s('b', 'rain_chirps_mm', 'Rainfall CHIRPS gap-filler (boundary)', '1998-01-01', '2026-10-30', chirps);

describe('feedShadows', () => {
	it('finds a feed’s series that runs don’t read, stalled when the one read has no feed and ends first (issue #670)', () => {
		expect(feedShadows([boundary, gapFiller])).toEqual([{ fed: boundary, read: gapFiller, stalled: true }]);
	});

	it('is a plain note when the series read also grows: it reaches as far, or a feed writes it too', () => {
		const current = { ...gapFiller, lastValueDate: '2026-10-30' };
		expect(feedShadows([boundary, current])).toEqual([{ fed: boundary, read: current, stalled: false }]);
		const fed = { ...gapFiller, feed: chirps };
		expect(feedShadows([boundary, fed])).toEqual([{ fed: boundary, read: fed, stalled: false }]);
	});

	it('positive control: nothing when the feed writes the series runs read', () => {
		const read = { ...gapFiller, feed: chirps };
		const other = s('o', 'rain_chirps_mm', 'Zz uploaded', '2009-01-01', '2020-01-01');
		expect(feedShadows([read, other])).toEqual([]);
	});

	it('skips a feed with no days of its own left, a unit’s own rain and a gauge’s record', () => {
		expect(feedShadows([{ ...boundary, feed: { source: 'chirps', days: 0 } }, gapFiller])).toEqual([]);
		expect(feedShadows([{ ...boundary, siteNodeId: 'u1' }, gapFiller])).toEqual([]);
	});

	it('skips a kind no run reads, where nothing is read in its place', () => {
		const ref = s('r', 'flow_reference_m3s', 'B ref', '2000-01-01', '2026-01-01', { source: 'dws', days: 9 });
		const ref2 = s('r2', 'flow_reference_m3s', 'A ref', '2000-01-01', '2020-01-01');
		expect(feedShadows([ref, ref2])).toEqual([]);
	});

	it('catchment rain: a station assigned to an area is read; with a station for the catchment, that station is the one read', () => {
		const first = s('c1', 'rain_catchment_mm', 'A gauge', '2000-01-01', '2020-01-01');
		const fedRain = s('c2', 'rain_catchment_mm', 'B CHIRPS', '2000-01-01', '2026-01-01', chirps);
		expect(feedShadows([first, fedRain]).map((x) => [x.fed.id, x.read.id, x.stalled])).toEqual([['c2', 'c1', true]]);
		const nodes = [{ id: 'u1', kind: 'farm', name: 'Upper', areaKm2: 5 }] as unknown as NetworkNode[];
		const assigned = { rainStations: { units: { u1: { stationId: 'c2' } } } } as unknown as ProjectSettings;
		expect(feedShadows([first, fedRain], { settings: assigned, nodes })).toEqual([]);
		const station = s('c0', 'rain_catchment_mm', 'Z station', '2000-01-01', '2020-01-01');
		const byStation = { rainStations: { catchment: { stationId: 'c0' } } } as unknown as ProjectSettings;
		const fedFirst = { ...fedRain, name: '0 CHIRPS' };
		expect(feedShadows([station, fedFirst], { settings: byStation }).map((x) => [x.fed.id, x.read.id])).toEqual([['c2', 'c0']]);
	});

	it('lists stalled pairs first', () => {
		const et0read = s('e1', 'evap_et0_mm', 'A ET', '2000-01-01', '2026-10-30');
		const et0fed = s('e2', 'evap_et0_mm', 'B ET', '2000-01-01', '2026-10-30', { source: 'agera5_et0', days: 9 });
		expect(feedShadows([et0fed, et0read, boundary, gapFiller]).map((x) => x.fed.id)).toEqual(['b', 'e2']);
	});
});

describe('the words', () => {
	const [x] = feedShadows([boundary, gapFiller]);

	it('names both series, their spans and where the feed’s days stop reaching a run', () => {
		const t = feedShadowText(x);
		expect(t).toContain('Runs read “Rainfall CHIRPS gap-filler” (1 Jan 2009 to 22 Oct 2025) for Rainfall — CHIRPS, which no data feed writes');
		expect(t).toContain('a data feed writes “Rainfall CHIRPS gap-filler (boundary)” (1 Jan 1998 to 30 Oct 2026)');
		expect(t).toContain('the feed’s days after 22 Oct 2025 never reach a run');
		expect(feedShadowText({ ...x, stalled: false })).toMatch(/^A data feed writes “Rainfall CHIRPS gap-filler \(boundary\)”.*but runs read “Rainfall CHIRPS gap-filler”/);
	});

	it('offers the boundary’s Replace only for a stalled CHIRPS record', () => {
		expect(boundaryFixes(x)).toBe(true);
		expect(boundaryFixes({ ...x, stalled: false })).toBe(false);
		expect(boundaryFixes({ ...x, read: { ...x.read, kind: 'evap_et0_mm' } })).toBe(false);
	});

	it('explains both Data rows of a pair, and nothing on any other row', () => {
		expect(feedShadowWhy(boundary, [x])).toMatch(/^A data feed writes this series, but runs read “Rainfall CHIRPS gap-filler”.*Rename or remove/);
		expect(feedShadowWhy(gapFiller, [x])).toMatch(/^No data feed writes this series, so it ends 22 Oct 2025/);
		expect(feedShadowWhy(gapFiller, [{ ...x, stalled: false }])).toBeNull();
		expect(feedShadowWhy(s('z', 'rain_chirps_mm', 'Z', '2000-01-01', '2000-01-02'), [x])).toBeNull();
	});
});
