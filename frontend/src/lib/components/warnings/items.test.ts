import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkItemId, defaultProjectSettings, EXCLUSIONS_MAX, type ProjectSettings } from '@water-management/engine';
import {
	covers,
	decide,
	decisionsFor,
	filterCounts,
	filterItems,
	periodText,
	statusDetail,
	whatText,
	itemsNoun,
	itemStatus,
	mergeRanges,
	openCount,
	parseFilters,
	recordRole,
	reopen,
	subtractRanges,
	warningItems,
	type ItemSources,
	type WarningItem
} from './items';

// Rule 7: dates, so under a skewed TZ (UTC+14 would move a local-midnight date a day).
let tz: string | undefined;
beforeAll(() => {
	tz = process.env.TZ;
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	process.env.TZ = tz;
});

const RAIN = '00000000-0000-4000-8000-000000000001';
const STATION = '00000000-0000-4000-8000-000000000002';
const FLOW = '00000000-0000-4000-8000-000000000003';
const UNIT_GAUGE = '00000000-0000-4000-8000-000000000004';

// Synthetic: 120 days from 1 Oct 2021, rain every third day, with flat stretches the checks flag.
const START = '2021-10-01';
const rain = () => Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? 4 + (i % 7) : 0));
function withFlat(values: number[], from: number, days: number, v: number) {
	for (let i = from; i < from + days; i++) values[i] = v;
	return values;
}
const flow = () => Array.from({ length: 120 }, (_, i) => Math.round((0.05 + 0.3 * Math.exp(-(i % 9) / 3)) * 1000) / 1000);

function sources(settings: Partial<ProjectSettings> = {}, extra: Partial<ItemSources> = {}): ItemSources {
	const rainVals = withFlat(withFlat(rain(), 10, 6, 5.5), 16, 6, 7.5); // two flat stretches back to back: 11–16 Oct, 17–22 Oct
	const stationVals = rain();
	stationVals[40] = -9;
	const flowVals = withFlat(flow(), 50, 20, 0.2); // a non-zero flat of 20 days: suspect, open
	flowVals[80] = -1;
	return {
		series: [
			{ id: RAIN, kind: 'rain_catchment_mm', name: 'A gauge' },
			{ id: STATION, kind: 'rain_catchment_mm', name: 'B station' },
			{ id: UNIT_GAUGE, kind: 'rain_catchment_mm', name: 'C unit gauge', siteNodeId: 'n1' },
			{ id: FLOW, kind: 'flow_observed_m3s', name: '' }
		],
		values: {
			[RAIN]: { startDate: START, values: rainVals },
			[STATION]: { startDate: START, values: stationVals },
			[UNIT_GAUGE]: { startDate: START, values: withFlat(rain(), 30, 5, 3) },
			[FLOW]: { startDate: START, values: flowVals }
		},
		settings: { ...defaultProjectSettings(), ...settings } as ProjectSettings,
		nodeName: (id) => (id === 'n1' ? 'Upper farm' : null),
		...extra
	};
}

const find = (items: WarningItem[], check: string, seriesId: string) => items.filter((i) => i.check === check && i.seriesId === seriesId);

describe('ranges', () => {
	it('merges overlapping and touching ranges, subtracts and checks cover', () => {
		expect(mergeRanges([[5, 8], [1, 2], [3, 4], [10, 12]])).toEqual([[1, 8], [10, 12]]);
		expect(subtractRanges([[1, 10]], [[3, 4], [8, 20]])).toEqual([[1, 2], [5, 7]]);
		expect(covers([[1, 4], [5, 9]], [2, 8])).toBe(true);
		expect(covers([[1, 4], [6, 9]], [2, 8])).toBe(false);
	});
});

describe('warningItems', () => {
	it('lists one item per period, each record with its role and name, the defaults’ statuses', () => {
		const items = warningItems(sources());
		const flats = find(items, 'flatline', RAIN);
		expect(flats.map((i) => [i.start, i.end])).toEqual([
			['2021-10-11', '2021-10-16'],
			['2021-10-17', '2021-10-22']
		]);
		expect(flats.every((i) => i.role === 'catchmentRain' && i.record === 'A gauge' && i.status === 'open')).toBe(true);
		// A station no area is assigned to isn't read by the run (its negative would be read as missing): Keep only.
		const neg = find(items, 'negative', STATION)[0]!;
		expect(neg.role).toBe('unreadRain');
		expect(neg.status).toBe('handled');
		// A unit's own gauge is named with its unit.
		expect(find(items, 'flatline', UNIT_GAUGE)[0]!.record).toBe('C unit gauge (Upper farm)');
		// The flow's non-zero flat is suspect, left out of the fit only: open. Its negative is read as missing.
		const flat = find(items, 'flatline', FLOW)[0]!;
		expect([flat.role, flat.record, flat.status, flat.treatment]).toEqual(['flow', 'Flow — observed gauge', 'open', 'fitExcluded']);
		expect(find(items, 'negative', FLOW)[0]!.status).toBe('handled');
		expect(openCount(items)).toBe(items.filter((i) => i.status === 'open').length);
	});

	it('takes the run’s accumulation windows on the catchment gauge', () => {
		const run = {
			rainAccumulation: { windows: [{ start: '2021-11-01', end: '2021-11-05', status: 'spread', source: 'detected', totalMm: 40, readingMm: 40, runDays: 5 }] },
			plausibility: null,
			calibration: null
		} as unknown as ItemSources['run'];
		const acc = find(warningItems(sources({}, { run })), 'accumulation', RAIN);
		expect(acc).toHaveLength(1);
		expect(acc[0]!.status).toBe('handled');
		expect(decisionsFor(acc[0]!)).toEqual(['patch', 'keep']);
	});
});

describe('rain stations (settings.rainStations): only what the run reads takes a patch', () => {
	it('an unassigned station and a unit gauge whose unit has a station take Keep only, and say the run doesn’t read them', () => {
		const s = sources();
		const items = warningItems(s);
		// No stations at all: a second outlet rain series is read by nothing.
		expect(find(items, 'negative', STATION)[0]!.role).toBe('unreadRain');
		const withStations = sources({ rainStations: { units: { n1: { stationId: STATION } } } });
		const st = warningItems(withStations);
		// Assigned to a unit: read, so it takes a patch; that unit's own gauge isn't read any more.
		expect(find(st, 'negative', STATION)[0]!.role).toBe('rain');
		const unitGauge = find(st, 'flatline', UNIT_GAUGE)[0]!;
		expect(unitGauge.role).toBe('unreadRain');
		expect(decisionsFor(unitGauge)).toEqual(['keep']);
		expect(statusDetail(unitGauge)).toMatch(/^Not read by the run/);
		// A station no area is assigned to: not read.
		const other = sources({ rainStations: { units: { n2: { stationId: UNIT_GAUGE } } } });
		expect(find(warningItems(other), 'negative', STATION)[0]!.role).toBe('unreadRain');
		expect(decide(find(warningItems(other), 'negative', STATION), 'patch', other.settings)).toEqual({ ok: false, error: 'None of these can be patched.' });
	});

	it('under a catchment station the gauge is unread, unless it is that station, when its patch goes to its unreliable list', () => {
		const other = sources({ rainStations: { catchment: { stationId: STATION } } });
		const flat = find(warningItems(other), 'flatline', RAIN)[0]!;
		expect(flat.role).toBe('unreadRain');
		expect(decisionsFor(flat)).toEqual(['keep']);
		const self = sources({ rainStations: { catchment: { stationId: RAIN } } });
		const flats = find(warningItems(self), 'flatline', RAIN);
		expect(flats[0]!.role).toBe('rain');
		const r = decide(flats, 'patch', self.settings);
		expect(r.ok && r.patch.zeroRainRuns).toBeUndefined();
		expect(r.ok && r.patch.rainStations?.unreliable).toEqual({ [RAIN]: [['2021-10-11', '2021-10-22']] });
		expect(r.ok && r.patch.rainStations?.catchment).toEqual({ stationId: RAIN });
	});
});

describe('itemStatus', () => {
	const flat = () => find(warningItems(sources()), 'flatline', RAIN)[0]!;
	it('reads patched from the catchment gauge’s missing list, only when it covers every day', () => {
		const p = flat();
		expect(itemStatus(p, 'catchmentRain', { ...defaultProjectSettings(), zeroRainRuns: { ...defaultProjectSettings().zeroRainRuns, missing: [{ start: '2021-10-01', end: '2021-10-31', reason: 'x' }] } })).toBe('patched');
		expect(itemStatus(p, 'catchmentRain', { ...defaultProjectSettings(), zeroRainRuns: { ...defaultProjectSettings().zeroRainRuns, missing: [{ start: '2021-10-12', end: '2021-10-31', reason: 'x' }] } })).toBe('open');
		// A water year covers it too.
		expect(itemStatus(p, 'catchmentRain', { ...defaultProjectSettings(), zeroRainRuns: { ...defaultProjectSettings().zeroRainRuns, missing: [{ waterYear: 2021, reason: 'x' }] } })).toBe('patched');
	});
	it('reads kept from checksKept by the item’s id, and excluded from the flow record’s own list', () => {
		const p = flat();
		expect(itemStatus(p, 'catchmentRain', { ...defaultProjectSettings(), checksKept: [p.id] })).toBe('kept');
		const f = find(warningItems(sources()), 'flatline', FLOW)[0]!;
		expect(itemStatus(f, 'flow', { ...defaultProjectSettings(), flowMissing: { [FLOW]: [{ start: f.start, end: f.end, reason: 'x' }] } })).toBe('excluded');
		// Another record's list doesn't.
		expect(itemStatus(f, 'flow', { ...defaultProjectSettings(), flowMissing: { [RAIN]: [{ start: f.start, end: f.end, reason: 'x' }] } })).toBe('open');
	});
});

describe('decide', () => {
	it('patches the catchment gauge’s periods into one merged period, with the history’s reason', () => {
		const s = sources();
		const flats = find(warningItems(s), 'flatline', RAIN);
		const r = decide(flats, 'patch', s.settings);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.reason).toBe('Warnings: patched 2 flat stretches');
		expect(r.patch.zeroRainRuns!.missing).toEqual([{ start: '2021-10-11', end: '2021-10-22', reason: 'Warnings: flat stretch' }]);
		// The rest of the setting is kept whole.
		expect(r.patch.zeroRainRuns!.mode).toBe('missing');
		// Read back, both are patched.
		const after = { ...s.settings!, ...r.patch } as ProjectSettings;
		expect(warningItems({ ...s, settings: after }).filter((i) => i.check === 'flatline' && i.seriesId === RAIN).map((i) => i.status)).toEqual(['patched', 'patched']);
	});

	it('adds only the days a list doesn’t cover, and keeps the list’s own periods as they are', () => {
		const base = defaultProjectSettings();
		const settings = { ...base, zeroRainRuns: { ...base.zeroRainRuns, missing: [{ start: '2021-10-15', end: '2021-10-18', reason: 'Gauge cleaned' }] } } as ProjectSettings;
		const s = sources(settings);
		const r = decide(find(warningItems(s), 'flatline', RAIN), 'patch', settings);
		expect(r.ok && r.patch.zeroRainRuns!.missing).toEqual([
			{ start: '2021-10-15', end: '2021-10-18', reason: 'Gauge cleaned' },
			{ start: '2021-10-11', end: '2021-10-14', reason: 'Warnings: flat stretch' },
			{ start: '2021-10-19', end: '2021-10-22', reason: 'Warnings: flat stretch' }
		]);
	});

	it('patches another rain record into its unreliable periods, merged, and a bulk patch skips the flow items', () => {
		const s = sources();
		const items = warningItems(s);
		const r = decide([...find(items, 'flatline', UNIT_GAUGE), ...find(items, 'flatline', FLOW)], 'patch', s.settings);
		expect(r.ok && r.count).toBe(1);
		expect(r.ok && r.patch.rainStations?.unreliable).toEqual({ [UNIT_GAUGE]: [['2021-10-31', '2021-11-04']] });
		expect(r.ok && r.patch.flowMissing).toBeUndefined();
	});

	it('excludes a flow period for its record only, and keeps it by id', () => {
		const s = sources();
		const f = find(warningItems(s), 'flatline', FLOW);
		const ex = decide(f, 'exclude', s.settings);
		expect(ex.ok && ex.patch.flowMissing).toEqual({ [FLOW]: [{ start: f[0]!.start, end: f[0]!.end, reason: 'Warnings: flat stretch' }] });
		expect(ex.ok && ex.reason).toBe('Warnings: excluded from calibration 1 flat stretch');
		const keep = decide(f, 'keep', s.settings);
		expect(keep.ok && keep.patch.checksKept).toEqual([checkItemId('flatline', FLOW, f[0]!.start, f[0]!.end)]);
	});

	it('keeps a catchment zero run as dry and an accumulation’s reading day in keepReadings', () => {
		const run = {
			rainAccumulation: { windows: [{ start: '2021-11-01', end: '2021-11-05', status: 'spread', source: 'detected', totalMm: 40, readingMm: 40, runDays: 5 }] },
			plausibility: null,
			calibration: null
		} as unknown as ItemSources['run'];
		const s = sources({}, { run });
		const acc = find(warningItems(s), 'accumulation', RAIN);
		const r = decide(acc, 'keep', s.settings);
		expect(r.ok && r.patch.zeroRainRuns!.keepReadings).toEqual([{ start: '2021-11-05', end: '2021-11-05', reason: 'Warnings: accumulation' }]);
		const after = { ...s.settings!, ...(r.ok ? r.patch : {}) } as ProjectSettings;
		expect(find(warningItems({ ...s, settings: after }), 'accumulation', RAIN)[0]!.status).toBe('kept');
	});

	it('refuses past a list’s cap rather than cut it', () => {
		const base = defaultProjectSettings();
		const full = Array.from({ length: EXCLUSIONS_MAX }, (_, k) => ({ start: `2030-01-${String((k % 28) + 1).padStart(2, '0')}`, end: `2030-01-${String((k % 28) + 1).padStart(2, '0')}`, reason: `r${k}` }));
		const settings = { ...base, zeroRainRuns: { ...base.zeroRainRuns, missing: full } } as ProjectSettings;
		const s = sources(settings);
		const r = decide(find(warningItems(s), 'flatline', RAIN), 'patch', settings);
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error).toMatch(/^This would list 101 periods .* past the 100 the list keeps/);
		const kept = { ...base, checksKept: Array.from({ length: 300 }, (_, k) => checkItemId('flatline', FLOW, '2030-01-01', `2030-01-${String((k % 28) + 1).padStart(2, '0')}`) + k) } as ProjectSettings;
		const k = decide(find(warningItems(sources(kept)), 'flatline', FLOW), 'keep', kept);
		expect(!k.ok && k.error).toMatch(/past the 300/);
	});

	it('offers nothing on a decided item, and says so for an empty bulk', () => {
		expect(decisionsFor({ role: 'rain', status: 'patched' })).toEqual([]);
		expect(decisionsFor({ role: 'flow', status: 'handled' })).toEqual(['exclude', 'keep']);
		expect(decisionsFor({ role: 'other', status: 'open' })).toEqual(['keep']);
		const s = sources();
		expect(decide(find(warningItems(s), 'flatline', FLOW), 'patch', s.settings)).toEqual({ ok: false, error: 'None of these can be patched.' });
	});
});

describe('reopen', () => {
	it('cuts the item’s days out of the list that decided it, splitting a longer period', () => {
		const base = defaultProjectSettings();
		const settings = { ...base, zeroRainRuns: { ...base.zeroRainRuns, missing: [{ start: '2021-10-01', end: '2021-10-31', reason: 'Gauge broken' }] } } as ProjectSettings;
		const s = sources(settings);
		const p = find(warningItems(s), 'flatline', RAIN)[0]!;
		expect(p.status).toBe('patched');
		expect(reopen(p, settings)?.patch.zeroRainRuns!.missing).toEqual([
			{ start: '2021-10-01', end: '2021-10-10', reason: 'Gauge broken' },
			{ start: '2021-10-17', end: '2021-10-31', reason: 'Gauge broken' }
		]);
		const keptSettings = { ...base, checksKept: [p.id] } as ProjectSettings;
		const kept = find(warningItems(sources(keptSettings)), 'flatline', RAIN)[0]!;
		expect(reopen(kept, keptSettings)).toEqual({ patch: { checksKept: null }, reason: 'Warnings: reopened 1 flat stretch' });
	});
});

describe('filters', () => {
	it('reads the URL, defaulting to open, ignoring unknown values', () => {
		expect(parseFilters(new URLSearchParams('check=flatline&series=x&status=kept'))).toEqual({ check: 'flatline', series: 'x', status: 'kept' });
		expect(parseFilters(new URLSearchParams('check=nope&status=nope'))).toEqual({ check: null, series: null, status: 'open' });
	});
	it('counts each chip against the other two filters', () => {
		const items = warningItems(sources());
		const f = parseFilters(new URLSearchParams('check=flatline'));
		const c = filterCounts(items, f);
		expect(c.status.all).toBe(items.filter((i) => i.check === 'flatline').length);
		expect(c.status.open).toBe(filterItems(items, f).length);
		// The check chips ignore the check filter but not the status one.
		expect(c.checkAll).toBe(items.filter((i) => i.status === 'open').length);
		expect(c.records.map((r) => r.label)).toEqual(['A gauge', 'B station', 'C unit gauge (Upper farm)', 'Flow — observed gauge']);
	});
	it('says what each check saw, in the record’s unit, day first', () => {
		const items = warningItems(sources());
		const flat = find(items, 'flatline', RAIN)[0]!;
		expect(periodText(flat)).toBe('11 Oct 2021 – 16 Oct 2021');
		expect(whatText(flat)).toBe('5.5 mm on every day');
		expect(whatText(find(items, 'flatline', FLOW)[0]!)).toBe('0.2 m³/s on every day');
		expect(whatText(find(items, 'negative', STATION)[0]!)).toBe('Lowest \u22129 mm');
		expect(whatText({ check: 'doublemass', seriesKind: 'rain_catchment_mm', days: 300, end: '2020-09-30', severity: 'warning', params: { change: 0.35, afterWaterYear: 2018 } })).toBe(
			'The double-mass slope changes +35% after WY 2018/19'
		);
	});
	it('names a selection by its checks', () => {
		expect(itemsNoun([{ check: 'flatline' }])).toBe('1 flat stretch');
		expect(itemsNoun([{ check: 'flatline' }, { check: 'outlier' }])).toBe('2 periods');
	});
	it('reads roles', () => {
		expect(recordRole({ id: 'a', kind: 'rain_catchment_mm', name: '' }, 'a')).toBe('catchmentRain');
		expect(recordRole({ id: 'b', kind: 'rain_catchment_alt_mm', name: '' }, 'a')).toBe('rain');
		expect(recordRole({ id: 'c', kind: 'flow_logger_m3s', name: '' }, 'a')).toBe('flow');
		expect(recordRole({ id: 'd', kind: 'evap_apan_mm', name: '' }, 'a')).toBe('other');
	});
});
